'use strict';
const express = require('express');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  aiCall, getPrompts, getBookPrompts,
  fmtTok, tps,
  jobs, runningJobs, createJob, enqueueJob, jobKey,
  jsonBody,
} = require('./shared');

const synonymeRouter = express.Router();

async function runSynonymJob(jobId, wort, satz, bookId, userEmail) {
  const logger = makeJobLogger(jobId);
  const { buildSynonymPrompt, SCHEMA_SYNONYM } = await getPrompts();
  const { SYSTEM_SYNONYM } = await getBookPrompts(bookId, userEmail);
  try {
    logger.info(`Start: Synonym für «${wort}» (book=${bookId || '-'})`);
    updateJob(jobId, { statusText: 'job.phase.searchingSynonyms', progress: 10 });

    const tok = { in: 0, out: 0, ms: 0 };
    const result = await aiCall(jobId, tok,
      buildSynonymPrompt(wort, satz),
      SYSTEM_SYNONYM,
      10, 95, 800, 0.3, 2000, undefined, SCHEMA_SYNONYM,
    );

    if (!Array.isArray(result?.synonyme)) throw i18nError('job.error.synonymeArrayMissing');
    const normWort = wort.trim().toLowerCase();
    const seen = new Set();
    const synonyme = result.synonyme
      .filter(s => s && typeof s.wort === 'string' && s.wort.trim())
      .filter(s => s.wort.trim().toLowerCase() !== normWort)
      .map(s => ({ wort: s.wort.trim(), hinweis: (s.hinweis || '').trim() }))
      .filter(s => {
        const key = s.wort.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

    completeJob(jobId, { synonyme, tokensIn: tok.in, tokensOut: tok.out }, tps(tok));
    logger.info(`Synonym «${wort}» fertig (${synonyme.length} Vorschläge, ${fmtTok(tok.in)}↑ ${fmtTok(tok.out)}↓ Tokens)`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Fehler Synonym «${wort}»: ${e.message}`);
    failJob(jobId, e);
  }
}

synonymeRouter.post('/synonym', jsonBody, (req, res) => {
  const { wort, satz, book_id } = req.body || {};
  if (!wort || typeof wort !== 'string' || !wort.trim()) return res.status(400).json({ error_code: 'WORT_REQUIRED' });
  if (!satz || typeof satz !== 'string' || !satz.trim()) return res.status(400).json({ error_code: 'SATZ_REQUIRED' });
  const userEmail = req.session?.user?.email || null;
  const entityKey = `${wort.trim().toLowerCase()}|${satz.trim().slice(0, 60)}`;
  const existing = runningJobs.get(jobKey('synonym', entityKey, userEmail));
  if (existing && jobs.has(existing)) return res.json({ jobId: existing, existing: true });
  const label = 'job.label.synonymWord';
  const labelParams = { word: wort.trim() };
  const jobId = createJob('synonym', entityKey, userEmail, label, labelParams);
  enqueueJob(jobId, () => runSynonymJob(jobId, wort.trim(), satz.trim(), book_id || null, userEmail));
  res.json({ jobId });
});

module.exports = { synonymeRouter };
