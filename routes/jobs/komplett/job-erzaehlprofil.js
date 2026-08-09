'use strict';
// Standalone-Erzählprofil-Job: rechnet nur die Phase «Erzählprofil» neu, ohne die
// volle Extraktions-Pipeline (P1–P8). Baut denselben Kontext wie job-komplett auf
// und ruft die geteilte Phase runErzaehlprofil auf. Der figNameToId-Lookup kommt aus
// dem bereits vorhandenen Figuren-Katalog (die Phase mappt nur Erzähler → figure_id,
// sie erzeugt keine Figuren). Als eigenständiger Job ist ein Fehler hier terminal.
const { db } = require('../../../db/schema');
const {
  makeJobLogger, updateJob, completeJob, failJob, contentHttpError,
  aiCall, getPrompts, getBookPrompts,
  loadOrderedBookContents, loadPageContents, groupByChapter, buildSinglePassBookText, cleanPageTextForAi,
  chunkLimitsFor, BATCH_SIZE, jobAbortControllers, tps,
} = require('../shared');
const appSettings = require('../../../lib/app-settings');
const { setContext } = require('../../../lib/log-context');
const { makePhaseTimer } = require('./utils');
const { runErzaehlprofil } = require('./phases');
const { _komplettAiOverrides } = require('./job-shared');
const { providerClass } = require('../../../lib/ai');

async function runErzaehlprofilJob(jobId, bookId, bookName, userEmail, userToken, provider = undefined) {
  const bookIdInt = parseInt(bookId);
  const email = userEmail || null;
  const log = makeJobLogger(jobId);
  const pt = makePhaseTimer(log);
  // Effektiven Provider binden (siehe runKomplettAnalyseJob) — sonst kappt aiCall das
  // Output-Ceiling fälschlich auf den Claude-Default.
  const effectiveProvider = provider || appSettings.get('ai.provider') || 'claude';
  const overrides = _komplettAiOverrides(effectiveProvider);
  if (overrides) {
    setContext(overrides);
    log.info(`Erzählprofil-Override (${effectiveProvider}): ${JSON.stringify(overrides.aiJob)} (global model=${appSettings.get(`ai.${effectiveProvider}.model`)}).`);
  }
  const call = (jobId_, tok_, prompt_, system_, fromPct, toPct, expectedChars, outputRatio, maxTokens, schema) =>
    aiCall(jobId_, tok_, prompt_, system_, fromPct, toPct, expectedChars, outputRatio, maxTokens, effectiveProvider, schema);
  const { singlePass: singlePassLimit } = chunkLimitsFor(effectiveProvider);
  const prompts = await getPrompts(userEmail);
  const sys = await getBookPrompts(bookId, email);
  const tok = { in: 0, out: 0, ms: 0, inflight: new Map() };

  try {
    updateJob(jobId, { statusText: 'job.phase.loadingPages', progress: 0 });
    const { chMap, chNameToId, pages } = await loadOrderedBookContents(bookId, userToken)
      .catch(e => { throw contentHttpError(e); });
    if (!pages.length) { completeJob(jobId, { empty: true }); return; }

    // Bekannte Figuren (Name → TEXT-fig_id) für den Erzähler-/Fokusfigur-Lookup.
    // saveChapterNarrativeProfiles übersetzt fig_id anschliessend nach figures.id.
    const figRows = db.prepare(
      'SELECT fig_id, name FROM figures WHERE book_id = ? AND user_email IS ? ORDER BY sort_order'
    ).all(bookIdInt, email);
    const figNameToId = Object.fromEntries(figRows.map(r => [r.name, r.fig_id]));

    const pageContents = await loadPageContents(pages, chMap, 30, (i, total) => {
      updateJob(jobId, {
        progress: Math.round((i / total) * 50),
        statusText: 'job.phase.readingPages',
        statusParams: { from: i + 1, to: Math.min(i + BATCH_SIZE, total), total },
      });
    }, userToken, jobAbortControllers.get(jobId)?.signal);

    // Buchtext-Preprocessing nur Cloud-Klasse (identisch zu job-komplett/-kontinuitaet).
    if (providerClass(effectiveProvider) === 'cloud') {
      let savedChars = 0;
      for (const p of pageContents) {
        const before = p.text.length;
        p.text = cleanPageTextForAi(p.text);
        savedChars += before - p.text.length;
      }
      if (savedChars > 0) log.info(`Buchtext-Preprocessing ${savedChars} Zeichen entfernt.`);
    }

    const totalChars = pageContents.reduce((s, p) => s + p.text.length, 0);
    const { groupOrder, groups } = groupByChapter(pageContents);
    const fullBookText = buildSinglePassBookText(groups, groupOrder);
    pt.mark('Laden');

    const ctx = {
      jobId, bookIdInt, bookName, email, call, tok, log, effectiveProvider,
      singlePassLimit, totalChars, fullBookText, pageContents, groups, groupOrder,
      idMaps: { chNameToId }, prompts, sys,
    };
    const saved = await runErzaehlprofil(ctx, { figNameToId, fromPct: 55, toPct: 98 });
    pt.mark('Erzählprofil');
    log.info(`Phasen-Timing: ${pt.summary()}`);
    if (!saved) { completeJob(jobId, { empty: true }, tps(tok), 'keine Kapitel'); return; }
    completeJob(jobId, { count: saved, tokensIn: tok.in, tokensOut: tok.out }, tps(tok), `${saved} Kapitel`);
  } catch (e) {
    if (e.name !== 'AbortError') log.error(`Fehler: ${e.message}`);
    failJob(jobId, e);
  }
}

module.exports = { runErzaehlprofilJob };
