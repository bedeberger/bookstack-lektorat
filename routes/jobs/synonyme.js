'use strict';
const crypto = require('crypto');
const express = require('express');
const {
  getBookSettings,
  loadSynonymCache, saveSynonymCache,
} = require('../../db/schema');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  aiCall, getPrompts, getBookPrompts,
  _modelName, tps,
  jobs, runningJobs, createJob, enqueueJob, jobKey, findActiveJobId,
  jsonBody,
} = require('./shared');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');
const appSettings = require('../../lib/app-settings');
const { resolveProvider } = require('../../lib/ai');
const { sessionEmail } = require('../../lib/acl');

const synonymeRouter = express.Router();

function _synonymKeyHash(wort, satz, bookSettings, cacheVersion) {
  const buchtyp = bookSettings?.buchtyp || '';
  const locale = `${bookSettings?.language || 'de'}-${bookSettings?.region || 'CH'}`;
  const buchKontext = bookSettings?.buch_kontext || '';
  const stilprofil = bookSettings?.stilprofil || '';
  const raw = `${wort.trim().toLowerCase()}|${satz.trim().toLowerCase()}|${buchtyp}|${locale}|${buchKontext}|${stilprofil}|${cacheVersion}`;
  return crypto.createHash('sha1').update(raw).digest('hex');
}

async function runSynonymJob(jobId, wort, satz, bookId, userEmail, pageId) {
  const logger = makeJobLogger(jobId);
  const pageTag = pageId ? ` page=${pageId}` : '';
  const prompts = await getPrompts(userEmail);
  const { buildSynonymPrompt, SCHEMA_SYNONYM, PROMPTS_VERSION } = prompts;
  const { SYSTEM_SYNONYM } = await getBookPrompts(bookId, userEmail);
  const bookSettings = bookId ? getBookSettings(bookId, userEmail) : null;
  const effectiveProvider = resolveProvider({ userEmail });
  const cacheVersion = `${_modelName(effectiveProvider)}:${PROMPTS_VERSION || ''}`;
  const keyHash = _synonymKeyHash(wort, satz, bookSettings, cacheVersion);
  try {
    logger.info(`Start: «${wort}»${pageTag}`);
    updateJob(jobId, { statusText: 'job.phase.searchingSynonyms', progress: 10 });

    const cached = loadSynonymCache(userEmail, keyHash, effectiveProvider);
    if (cached) {
      logger.info(`«${wort}»${pageTag} – Cache-HIT, spart Synonym-Call.`);
      completeJob(jobId, { synonyme: cached, tokensIn: 0, tokensOut: 0, cached: true },
        null, `«${wort}» Cache-HIT ${cached.length} Vorschläge`);
      return;
    }

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

    saveSynonymCache(userEmail, keyHash, synonyme, effectiveProvider);

    completeJob(jobId, { synonyme, tokensIn: tok.in, tokensOut: tok.out },
      tps(tok), `«${wort}» ${synonyme.length} Vorschläge`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Fehler «${wort}»${pageTag}: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

synonymeRouter.post('/synonym', jsonBody, (req, res) => {
  const { wort, satz } = req.body || {};
  const book_id = toIntId(req.body?.book_id);
  const page_id = toIntId(req.body?.page_id);
  if (!wort || typeof wort !== 'string' || !wort.trim()) return res.status(400).json({ error_code: 'WORT_REQUIRED' });
  if (!satz || typeof satz !== 'string' || !satz.trim()) return res.status(400).json({ error_code: 'SATZ_REQUIRED' });
  if (book_id) setContext({ book: book_id });
  if (book_id) {
    const { requireBookAccess, sendACLError } = require('../../lib/acl');
    try { requireBookAccess(req, book_id, 'lektor'); }
    catch (e) { if (sendACLError(res, e)) return; throw e; }
  }
  const userEmail = sessionEmail(req);
  const entityKey = `${book_id || 0}|${wort.trim().toLowerCase()}|${satz.trim().slice(0, 60)}`;
  const existing = findActiveJobId('synonym', entityKey, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const label = 'job.label.synonymWord';
  const labelParams = { word: wort.trim() };
  const jobId = createJob('synonym', book_id || 0, userEmail, label, labelParams, entityKey);
  enqueueJob(jobId, () => runSynonymJob(jobId, wort.trim(), satz.trim(), book_id || null, userEmail, page_id || null));
  res.json({ jobId });
});

module.exports = { synonymeRouter, runSynonymJob };
