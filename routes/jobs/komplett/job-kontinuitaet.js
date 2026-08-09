'use strict';
// Standalone-Kontinuitätscheck (eigenständiger Job, ohne die volle Extraktions-
// Pipeline): Single-Pass bei kleinem Buch, sonst Fakten-Multi-Pass mit Checkpoint,
// danach Verify-Stufe (False-Positive-Filter, Claude). Verify/Anachronismus/
// Overrides in ./job-shared.
const {
  db,
  saveCheckpoint, loadCheckpoint, deleteCheckpoint,
  getBookSettings,
} = require('../../../db/schema');
const { narrativeLabels } = require('../narrative-labels');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError, contentHttpError,
  aiCall, getPrompts, getBookPrompts,
  loadOrderedBookContents, loadPageContents, groupByChapter, buildSinglePassBookText, cleanPageTextForAi,
  chunkLimitsFor, BATCH_SIZE, jobAbortControllers,
  tps, retryOnTransientAi,
} = require('../shared');
const appSettings = require('../../../lib/app-settings');
const { providerClass } = require('../../../lib/ai');
const { setContext } = require('../../../lib/log-context');
const { makePhaseTimer } = require('./utils');
const { saveKontinuitaetResult } = require('./remap');
const { komplettMaxTokens } = require('./phases');
const { buildAnachronismusData, verifyKontinuitaetProbleme, _komplettAiOverrides } = require('./job-shared');

async function runKontinuitaetJob(jobId, bookId, bookName, userEmail, userToken, provider = undefined) {
  const bookIdInt = parseInt(bookId);
  const email = userEmail || null;
  const log = makeJobLogger(jobId);
  const pt = makePhaseTimer(log);
  // Effektiven Provider binden (siehe runKomplettAnalyseJob) – sonst kappt aiCall das
  // Output-Ceiling fälschlich auf den Claude-Default, wenn der Job ohne expliziten Provider läuft.
  const effectiveProvider = provider || appSettings.get('ai.provider') || 'claude';
  const overrides = _komplettAiOverrides(effectiveProvider);
  if (overrides) {
    setContext(overrides);
    log.info(`Kontinuität-Override (${effectiveProvider}): ${JSON.stringify(overrides.aiJob)} (global model=${appSettings.get(`ai.${effectiveProvider}.model`)}).`);
  }
  const call = (jobId_, tok_, prompt_, system_, fromPct, toPct, expectedChars, outputRatio, maxTokens, schema) =>
    aiCall(jobId_, tok_, prompt_, system_, fromPct, toPct, expectedChars, outputRatio, maxTokens, effectiveProvider, schema);
  const { singlePass: singlePassLimit } = chunkLimitsFor(effectiveProvider);
  const prompts = await getPrompts(userEmail);
  const sys = await getBookPrompts(bookId, email);

  try {
    const cp = loadCheckpoint('kontinuitaet', bookIdInt, email);
    if (cp) log.info(`Checkpoint gefunden (${cp.nextGi} Kapitel fertig).`);

    updateJob(jobId, { statusText: 'job.phase.loadingPages', progress: 0 });
    const { chMap, chNameToId, pages } = await loadOrderedBookContents(bookId, userToken)
      .catch(e => { throw contentHttpError(e); });
    if (!pages.length) { completeJob(jobId, { empty: true }); return; }

    // inflight wie in runKomplettAnalyseJob: parallele Verify-Calls (Promise/settledAll)
    // streamen Token gleichzeitig — ohne die inflight-Map überschreiben sich die
    // Zwischenstände in der Live-Anzeige (Endsumme bleibt korrekt, Anzeige unterzählt).
    const tok = { in: 0, out: 0, ms: 0, inflight: new Map() };
    // Sammelt non-critical-Degradierungen (übersprungene Fakten-Kapitel) → ins Job-Result,
    // analog runKomplettAnalyseJob. Ohne dies bliebe eine Faktenlücke dem User verborgen.
    const warnings = [];

    // Bekannte Figuren + Orte aus DB laden
    const figRows = db.prepare(`
      SELECT f.fig_id, f.name, f.typ, f.beschreibung FROM figures f
      WHERE f.book_id = ? AND f.user_email = ? ORDER BY f.sort_order
    `).all(bookIdInt, email);
    const figurenKompakt = figRows.map(f => ({ name: f.name, typ: f.typ || 'andere', beschreibung: f.beschreibung || '' }));
    const figNameToId = Object.fromEntries(figRows.map(r => [r.name, r.fig_id]));

    const ortRows = db.prepare(
      'SELECT name, typ, beschreibung FROM locations WHERE book_id = ? AND user_email = ? AND stale = 0 ORDER BY sort_order'
    ).all(bookIdInt, email);
    const orteKompakt = ortRows.map(o => ({ name: o.name, typ: o.typ, beschreibung: o.beschreibung || '' }));
    // Anachronismus-Kontext (nur bei echter Zeitlinie) aus dem zuletzt gespeicherten Katalog.
    const anachronismus = buildAnachronismusData(bookIdInt, email);

    const pageContents = await loadPageContents(pages, chMap, 30, (i, total) => {
      updateJob(jobId, {
        progress: Math.round((i / total) * 50),
        statusText: 'job.phase.readingPages',
        statusParams: { from: i + 1, to: Math.min(i + BATCH_SIZE, total), total },
      });
    }, userToken, jobAbortControllers.get(jobId)?.signal);

    // Buchtext-Preprocessing nur Cloud-Klasse (siehe runKomplettAnalyseJob).
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
    let result;
    // Single-Pass-Buchtext für die Beleg-Prüfung in saveKontinuitaetResult (gilt für
    // ALLE Provider hier – auch lokale, die im Single-Pass den Volltext sehen).
    let kontFullText = null;
    pt.mark('Laden');

    if (totalChars <= singlePassLimit) {
      updateJob(jobId, { progress: 60, statusText: 'job.phase.checkContinuity' });
      const bookText = buildSinglePassBookText(groups, groupOrder);
      kontFullText = bookText;
      result = await retryOnTransientAi(() => call(jobId, tok,
        prompts.buildKontinuitaetSinglePassPrompt(bookName, bookText, figurenKompakt, orteKompakt, narrativeLabels(getBookSettings(bookIdInt, email)), anachronismus),
        sys.SYSTEM_KONTINUITAET_BLOCKS, 60, 97, komplettMaxTokens(effectiveProvider), 0.2, null, prompts.SCHEMA_KONTINUITAET_PROBLEME,
      ), { log, label: 'Kontinuität Single-Pass' });
      pt.mark('Single-Pass Check');
    } else {
      // Multi-Pass: Fakten pro Kapitel extrahieren – ggf. aus Checkpoint fortsetzen
      let chapterFacts = cp?.chapterFacts ?? [];
      // Übersprungene Kapitel persistent merken: der Checkpoint rückt nextGi vor (sonst
      // Endlosschleife bei deterministischem Fehler), aber failedGis hält die Lücke fest,
      // damit ein Resume sie im Retry-Pass unten gezielt nachholt statt sie zu zementieren.
      let failedGis = Array.isArray(cp?.failedGis) ? [...cp.failedGis] : [];
      const startGi = cp?.nextGi ?? 0;
      if (startGi > 0) {
        updateJob(jobId, {
          progress: 50 + Math.round((startGi / groupOrder.length) * 35),
          statusText: 'job.phase.resumeFacts',
          statusParams: { current: startGi, total: groupOrder.length },
        });
      }
      for (let gi = startGi; gi < groupOrder.length; gi++) {
        const group = groups.get(groupOrder[gi]);
        const fromPct = 50 + Math.round((gi / groupOrder.length) * 35);
        const toPct   = 50 + Math.round(((gi + 1) / groupOrder.length) * 35);
        updateJob(jobId, { progress: fromPct, statusText: 'job.phase.factsInGroup', statusParams: { name: group.name, current: gi + 1, total: groupOrder.length } });
        const chText = group.pages.map(p => `### ${p.title}\n${p.text}`).join('\n\n---\n\n');
        try {
          // Retry vor dem graceful-skip: der Checkpoint rückt nach gi+1 vor, ein
          // übersprungenes Kapitel wird auch beim Resume NIE nachgeholt – ein
          // transienter Blip würde sonst dauerhaft Fakten verlieren.
          const chResult = await retryOnTransientAi(() => call(jobId, tok,
            prompts.buildKontinuitaetChapterFactsPrompt(group.name, chText),
            sys.SYSTEM_KONTINUITAET_BLOCKS, fromPct, toPct, komplettMaxTokens(effectiveProvider), 0.2, null, prompts.SCHEMA_KONTINUITAET_FAKTEN,
          ), { log, label: `Fakten «${group.name}»` });
          chapterFacts.push({ kapitel: group.name, fakten: chResult.fakten || [] });
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          log.warn(`Fakten «${group.name}» übersprungen (Retry folgt): ${e.message}`);
          if (!failedGis.includes(gi)) failedGis.push(gi);
        }
        saveCheckpoint('kontinuitaet', bookIdInt, email, { chapterFacts, nextGi: gi + 1, failedGis });
      }
      // Übersprungene Kapitel gezielt nachholen — ein (transienter) Ausfall darf nicht
      // dauerhaft Fakten verlieren, auch nicht über einen Resume hinweg. Bleibt es bei einem
      // deterministischen Fehler, wird die Lücke als Warnung user-sichtbar (statt still).
      if (failedGis.length) {
        const stillFailed = [];
        for (const gi of failedGis) {
          const group = groups.get(groupOrder[gi]);
          if (!group) continue;
          const chText = group.pages.map(p => `### ${p.title}\n${p.text}`).join('\n\n---\n\n');
          try {
            const chResult = await retryOnTransientAi(() => call(jobId, tok,
              prompts.buildKontinuitaetChapterFactsPrompt(group.name, chText),
              sys.SYSTEM_KONTINUITAET_BLOCKS, 86, 88, komplettMaxTokens(effectiveProvider), 0.2, null, prompts.SCHEMA_KONTINUITAET_FAKTEN,
            ), { log, label: `Fakten-Retry «${group.name}»` });
            chapterFacts.push({ kapitel: group.name, fakten: chResult.fakten || [] });
          } catch (e) {
            if (e.name === 'AbortError') throw e;
            stillFailed.push(group.name);
            log.warn(`Fakten «${group.name}» auch im Retry fehlgeschlagen: ${e.message}`);
          }
        }
        failedGis = [];
        saveCheckpoint('kontinuitaet', bookIdInt, email, { chapterFacts, nextGi: groupOrder.length, failedGis });
        if (stillFailed.length) {
          warnings.push({ key: 'job.warn.factsChapterSkipped', params: { chapters: stillFailed.join(', ') } });
        }
      }
      pt.mark('Fakten-Extraktion');

      updateJob(jobId, { progress: 88, statusText: 'job.phase.checkContradictions' });
      result = await retryOnTransientAi(() => call(jobId, tok,
        prompts.buildKontinuitaetCheckPrompt(bookName, chapterFacts, figurenKompakt, orteKompakt, anachronismus),
        sys.SYSTEM_KONTINUITAET_BLOCKS, 88, 95, komplettMaxTokens(effectiveProvider), 0.2, null, prompts.SCHEMA_KONTINUITAET_PROBLEME,
      ), { log, label: 'Kontinuität Check (Multi-Pass)' });
      // Fakten-basierte Befunde gegen den Originaltext verifizieren (False-Positive-Filter).
      // Klassen-, nicht Namensfrage: der Verify-Pass braucht ein faehiges Modell, keine
      // Anthropic-API-Faehigkeit (SSoT lib/ai/config.js#providerClass).
      if (providerClass(effectiveProvider) === 'cloud') {
        result = await verifyKontinuitaetProbleme(
          { call, prompts, sys, jobId, tok, bookName, groups, groupOrder, log, bookIdInt }, result, 95, 97);
      }
      pt.mark('Check+Verify');
    }

    if (typeof result?.zusammenfassung === 'undefined') throw i18nError('job.error.zusammenfassungMissing');
    const normalizedProbleme = saveKontinuitaetResult(bookIdInt, email, result, figNameToId, chNameToId, effectiveProvider, log,
      { fullBookText: kontFullText, requireQuoteEvidence: kontFullText != null });
    deleteCheckpoint('kontinuitaet', bookIdInt, email);
    log.info(`Phasen-Timing: ${pt.summary()}`);
    completeJob(jobId, {
      count: normalizedProbleme.length,
      issues: normalizedProbleme,
      zusammenfassung: result.zusammenfassung,
      warnings,
      tokensIn: tok.in, tokensOut: tok.out,
    }, tps(tok), `${normalizedProbleme.length} Probleme${warnings.length ? ` warn=${warnings.length}` : ''}`);
  } catch (e) {
    if (e.name !== 'AbortError') log.error(`Fehler: ${e.message}`);
    failJob(jobId, e);
  }
}

module.exports = { runKontinuitaetJob };
