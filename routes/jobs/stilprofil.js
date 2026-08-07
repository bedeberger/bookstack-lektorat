'use strict';
const express = require('express');
const { setBookStilprofil } = require('../../db/schema');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  aiCall, getPrompts, getBookPrompts,
  tps,
  createJob, enqueueJob, findActiveJobId,
  jsonBody,
  loadOrderedBookContents, loadPageContents, groupByChapter, buildSinglePassBookText,
  contentHttpError, chunkLimitsFor,
} = require('./shared');
const { BATCH_SIZE } = require('./shared/loader');
const { resolveProvider } = require('../../lib/ai');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');

const stilprofilRouter = express.Router();

// Leseprobe gleichmässig über das ganze Buch streuen, bis das Single-Pass-Budget
// (Zeichen) gefüllt ist. Stil braucht Querschnitt, nicht Volltext — so deckt die
// Probe Anfang/Mitte/Ende ab, ohne den Token-Cap zu sprengen.
function sampleForStyle(pageContents, budget) {
  const total = pageContents.reduce((s, p) => s + p.text.length, 0);
  if (total <= budget) return { pages: pageContents, total, sampled: false };
  const ratio = budget / total;
  const selected = [];
  let carry = 0, acc = 0;
  for (const p of pageContents) {
    carry += ratio;
    if (carry >= 1) { selected.push(p); carry -= 1; acc += p.text.length; }
    if (acc >= budget) break;
  }
  if (!selected.length) selected.push(pageContents[0]);
  return { pages: selected, total, sampled: true };
}

async function runStilprofilJob(jobId, bookId, userEmail, userToken) {
  const logger = makeJobLogger(jobId);
  const prompts = await getPrompts();
  const { buildStilprofilPrompt, SCHEMA_STILPROFIL } = prompts;
  const { SYSTEM_STILPROFIL } = await getBookPrompts(bookId, userEmail);
  // Leseproben-Budget aus dem Kontextfenster des EFFEKTIVEN Providers, nicht aus der
  // boot-eingefrorenen Claude-Konstante: bei einem lokalen 90K-Modell laege die
  // Claude-Ableitung (200K − 64K) ueber dem gesamten Fenster und der Slice unten
  // wuerde einen Prompt bauen, den der Server gar nicht annehmen kann.
  const singlePassLimit = chunkLimitsFor(resolveProvider({ userEmail })).singlePass;
  try {
    logger.info(`Start: Stilprofil Buch #${bookId}`);
    updateJob(jobId, { statusText: 'job.phase.loadingPages', progress: 0 });

    const { chMap, pages } = await loadOrderedBookContents(bookId, userToken)
      .catch(e => { throw contentHttpError(e); });
    if (!pages.length) { completeJob(jobId, { empty: true }); return; }

    const pageContents = await loadPageContents(pages, chMap, 50, (i, total) => {
      updateJob(jobId, {
        progress: Math.round((i / total) * 55),
        statusText: 'job.phase.readingPages',
        statusParams: { from: i + 1, to: Math.min(i + BATCH_SIZE, total), total },
      });
    }, userToken);
    if (!pageContents.length) { completeJob(jobId, { empty: true }); return; }

    const { pages: sampledPages, total, sampled } = sampleForStyle(pageContents, singlePassLimit);
    if (sampled) {
      logger.info(`Leseprobe gesampelt: ${sampledPages.length}/${pageContents.length} Seiten (Buch ${total} Zeichen > Budget ${singlePassLimit}).`);
    }
    const { groupOrder, groups } = groupByChapter(sampledPages);
    let bookText = buildSinglePassBookText(groups, groupOrder);
    if (bookText.length > singlePassLimit) bookText = bookText.slice(0, singlePassLimit);

    updateJob(jobId, { progress: 60, statusText: 'job.phase.distillingStyle' });
    const tok = { in: 0, out: 0, ms: 0 };
    const result = await aiCall(jobId, tok,
      buildStilprofilPrompt(bookText),
      SYSTEM_STILPROFIL,
      60, 97, 2000, 0.3, null, undefined, SCHEMA_STILPROFIL,
    );

    const stilprofil = (result?.stilprofil || '').trim();
    if (!stilprofil) throw i18nError('job.error.stilprofilMissing');

    setBookStilprofil(bookId, stilprofil);
    completeJob(jobId, { stilprofil, tokensIn: tok.in, tokensOut: tok.out },
      tps(tok), `Stilprofil erstellt (${stilprofil.length} Zeichen)`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Fehler Stilprofil Buch #${bookId}: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

stilprofilRouter.post('/stilprofil', jsonBody, (req, res) => {
  const book_id = toIntId(req.body?.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: book_id });
  const { requireBookAccess, sendACLError } = require('../../lib/acl');
  try { requireBookAccess(req, book_id, 'editor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }
  const userEmail = req.session?.user?.email || null;
  const userToken = null;
  const existing = findActiveJobId('stilprofil', String(book_id), userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const jobId = createJob('stilprofil', book_id, userEmail, 'job.label.stilprofil', {}, String(book_id));
  enqueueJob(jobId, () => runStilprofilJob(jobId, book_id, userEmail, userToken));
  res.json({ jobId });
});

module.exports = { stilprofilRouter, runStilprofilJob };
