'use strict';
// Phase 1: Vollextraktion (Single-/Multi-Pass) + additiver Completeness-/Gap-Pass.
const {
  saveCheckpoint, loadChapterExtractCache, saveChapterExtractCache, getBookSettings,
} = require('../../../../db/schema');
const {
  i18nError, settledAll, retryOnTransientAi, splitGroupsIntoChunks, updateJob, toSystemBlocks,
} = require('../../shared');
const {
  buildBookSystemBlockText, buildBookPagesSig, bookSettingsSigPart, extractField,
  sampleChapters, computeCoverageScore,
} = require('../utils');
const { mergeBeziehungenIntoFiguren, _normalizeName } = require('../figuren-merge');
const appSettings = require('../../../../lib/app-settings');
const { getContextConfigFor } = require('../../../../lib/ai');
const { komplettMaxTokens } = require('./tokens');

/** Teilt ein Array in Gruppen der Grösse `size` (≥1). */
function _chunkArray(arr, size) {
  const n = Math.max(1, size | 0);
  const out = [];
  for (let i = 0; i < (arr || []).length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function _phase1Concurrency() {
  return Math.max(1, parseInt(appSettings.get('ai.claude.phase1_concurrency'), 10) || 4);
}

/**
 * Additiver Completeness-/Gap-Pass (nur Claude Single-Pass): nach der Erst-Extraktion
 * erneut gegen den GECACHTEN Buchtext-Block + dasselbe System-Schema prompten und gezielt
 * die Entitäten nachziehen, die der Erst-Call ausgelassen hat (Long-Tail: Nebenfiguren,
 * einmal erwähnte Schauplätze). Die bereits gefundenen Namen werden mitgegeben, damit das
 * Modell sie NICHT erneut ausgibt. Loop-until-dry (Stop, sobald eine Runde nichts Neues
 * liefert) bis maxPasses. NON-FATAL: ein gescheiterter Gap-Call verwirft die teure
 * Haupt-Extraktion nicht — er wird geloggt und übersprungen. Gibt die NEU gefundenen Items
 * zurück (dedupliziert gegen bekannte + frühere Gap-Treffer per normalisiertem Namen);
 * der Caller vereinigt additiv.
 */
async function runCompletenessGap(ctx, {
  label, statusText, knownNames, buildPrompt, systemBlocks, schema, extractItems, claudeExtractCap, maxPasses,
  // keyOf/isValid/displayOf generalisieren den Helper über die name-tragenden Entitäten
  // (Figuren/Orte) hinaus auf Fakten (subjekt+fakt) und Szenen (titel+kapitel). Für die
  // Dedup-Konsistenz MUSS keyOf dieselbe Zeichenkette liefern, die als knownNames-Seed und
  // via displayOf in die Prompt-Liste fliesst (beide werden mit _normalizeName normalisiert).
  keyOf = (it) => it.name, isValid = (it) => it && it.name, displayOf = (it) => it.name,
}) {
  const { call, jobId, tok, log, extractTier } = ctx;
  const seen = new Set((knownNames || []).map(n => _normalizeName(n)).filter(Boolean));
  const display = (knownNames || []).filter(Boolean);
  const fresh = [];
  for (let round = 1; round <= maxPasses; round++) {
    updateJob(jobId, { statusText });
    let res;
    try {
      res = await retryOnTransientAi(() => call(jobId, tok,
        buildPrompt(display), systemBlocks, null, null, claudeExtractCap, 0.2, null, schema, extractTier,
      ), { log, label: `${label} (Gap ${round}/${maxPasses})` });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      log.warn(`${label} Gap-Pass ${round} fehlgeschlagen (${e.message}) – übersprungen.`);
      break;
    }
    const items = (extractItems(res) || []).filter(isValid);
    const newOnes = [];
    for (const it of items) {
      const key = _normalizeName(keyOf(it));
      if (!key || seen.has(key)) continue;
      seen.add(key);
      display.push(displayOf(it));
      newOnes.push(it);
    }
    fresh.push(...newOnes);
    log.info(`${label} Gap-Pass ${round}: ${items.length} zurück, +${newOnes.length} neu.`);
    if (newOnes.length === 0) break; // loop-until-dry
  }
  return fresh;
}

/**
 * Completeness-/Gap-Pässe (Long-Tail-Recall, nur Claude Single-Pass). Die vier Ströme
 * (Figuren/Orte/Fakten/Szenen) sind voneinander UNABHÄNGIG → bei Claude parallel (Cache warm
 * nach A1-Warmup, alle zahlen cache_read); jeder Strom intern loop-until-dry. settledAll cappt
 * auf phase1_concurrency (TPM-Schutz). Rein ADDITIV → gibt `{ stammFiguren, passB }` zurück.
 */
async function runSinglePassCompletenessGaps(ctx, { bookSystemBlock, claudeExtractCap, stammFiguren, passB, faktenFailed }) {
  const { bookName, prompts, sys, log } = ctx;
  const completenessPasses = ctx.completenessPasses || 0;
  // Known-Listen VOR dem Fan-out kapseln; die additiven Merges laufen danach sequenziell (pure JS).
  const knownOrte = passB.orte || [];
  const knownFakten = passB.fakten || [];
  const knownSzenen = passB.szenen || [];
  const faktKey = (f) => `${f.subjekt || ''}: ${f.fakt || ''}`;
  const szeneKey = (s) => `${s.titel || ''} (${s.kapitel || ''})`;
  const gapConcurrency = Math.max(1, parseInt(appSettings.get('ai.claude.phase1_concurrency'), 10) || 4);
  const noGap = () => [];
  const [figRes, orteRes, faktenRes, szenenRes] = await settledAll([
    stammFiguren.length > 0 ? () => runCompletenessGap(ctx, {
      label: 'Single-Pass Figuren', statusText: 'job.phase.completenessFiguren',
      knownNames: stammFiguren.flatMap(f => [f.name, f.kurzname]),
      buildPrompt: (known) => prompts.buildFigurenStammGapPrompt(bookName, known),
      systemBlocks: [bookSystemBlock, ...toSystemBlocks(sys.SYSTEM_KOMPLETT_FIGUREN_STAMM_BLOCKS, '1h')],
      schema: prompts.SCHEMA_KOMPLETT_FIGUREN_STAMM,
      extractItems: (r) => r?.figuren,
      claudeExtractCap, maxPasses: completenessPasses,
    }) : noGap,
    () => runCompletenessGap(ctx, {
      label: 'Single-Pass Orte', statusText: 'job.phase.completenessOrte',
      knownNames: knownOrte.map(o => o.name),
      buildPrompt: (known) => prompts.buildOrteGapPrompt(bookName, known),
      systemBlocks: [bookSystemBlock, ...toSystemBlocks(sys.SYSTEM_KOMPLETT_ORTE_PASS_BLOCKS, '1h')],
      schema: prompts.SCHEMA_KOMPLETT_ORTE_PASS,
      extractItems: (r) => r?.orte,
      claudeExtractCap, maxPasses: completenessPasses,
    }),
    // Fakten-Gap nur wenn der Erst-Fakten-Pass (C) erfolgreich war – sonst würde der
    // Gap-Pass die ausgefallene Faktenerfassung kaschieren, während faktenFailed den
    // Cache-Skip beibehält (Teilstand bliebe trotzdem nicht eingefroren).
    !faktenFailed ? () => runCompletenessGap(ctx, {
      label: 'Single-Pass Fakten', statusText: 'job.phase.completenessFakten',
      knownNames: knownFakten.map(faktKey),
      buildPrompt: (known) => prompts.buildFaktenGapPrompt(bookName, known),
      systemBlocks: [bookSystemBlock, ...toSystemBlocks(sys.SYSTEM_KOMPLETT_FAKTEN_PASS_BLOCKS, '1h')],
      schema: prompts.SCHEMA_KOMPLETT_FAKTEN_PASS,
      extractItems: (r) => r?.fakten,
      keyOf: faktKey, displayOf: faktKey, isValid: (f) => f && f.fakt,
      claudeExtractCap, maxPasses: completenessPasses,
    }) : noGap,
    () => runCompletenessGap(ctx, {
      label: 'Single-Pass Szenen', statusText: 'job.phase.completenessSzenen',
      knownNames: knownSzenen.map(szeneKey),
      buildPrompt: (known) => prompts.buildSzenenGapPrompt(bookName, known),
      systemBlocks: [bookSystemBlock, ...toSystemBlocks(sys.SYSTEM_KOMPLETT_ORTE_PASS_BLOCKS, '1h')],
      schema: prompts.SCHEMA_KOMPLETT_ORTE_PASS,
      extractItems: (r) => r?.szenen,
      keyOf: szeneKey, displayOf: szeneKey, isValid: (s) => s && s.titel,
      claudeExtractCap, maxPasses: completenessPasses,
    }),
  ], { concurrency: gapConcurrency });
  // runCompletenessGap fängt eigene Fehler ab (ausser AbortError, den settledAll
  // weiterreicht) → fulfilled mit (ggf. leerem) Array; .value-Fallback defensiv.
  const freshFig    = figRes.status    === 'fulfilled' ? (figRes.value    || []) : [];
  const freshOrte   = orteRes.status   === 'fulfilled' ? (orteRes.value   || []) : [];
  const freshFakten = faktenRes.status === 'fulfilled' ? (faktenRes.value || []) : [];
  const freshSzenen = szenenRes.status === 'fulfilled' ? (szenenRes.value || []) : [];

  if (freshFig.length) {
    // Frische, kollisionsfreie IDs (Gap-Output beginnt wieder bei fig_1).
    // Events/Assignments referenzieren Klarnamen → von der Neu-ID unberührt;
    // A2 unten bezieht die ergänzten Figuren über die vereinigte Liste ein.
    let maxIdx = 0;
    for (const f of stammFiguren) { const m = /^fig_(\d+)$/.exec(f.id || ''); if (m) maxIdx = Math.max(maxIdx, +m[1]); }
    for (const f of freshFig) f.id = 'fig_' + (++maxIdx);
    stammFiguren = stammFiguren.concat(freshFig);
    log.info(`Completeness: +${freshFig.length} Figuren ergänzt (gesamt ${stammFiguren.length}).`);
  }
  if (freshOrte.length) {
    // Frische, kollisionsfreie ort_ids (Gap-Output beginnt wieder bei ort_1 →
    // Kollision mit dem Erst-Pass; Phase 3 Single-Pass behält explizite ids bei →
    // sonst UNIQUE(book_id, loc_id, user_email)-Verletzung beim Speichern).
    let maxIdx = 0;
    for (const o of knownOrte) { const m = /^ort_(\d+)$/.exec(o.id || ''); if (m) maxIdx = Math.max(maxIdx, +m[1]); }
    for (const o of freshOrte) o.id = 'ort_' + (++maxIdx);
    passB.orte = knownOrte.concat(freshOrte);
    log.info(`Completeness: +${freshOrte.length} Orte ergänzt (gesamt ${passB.orte.length}).`);
  }
  if (freshFakten.length) {
    passB.fakten = knownFakten.concat(freshFakten);
    log.info(`Completeness: +${freshFakten.length} Fakten ergänzt (gesamt ${passB.fakten.length}).`);
  }
  if (freshSzenen.length) {
    passB.szenen = knownSzenen.concat(freshSzenen);
    log.info(`Completeness: +${freshSzenen.length} Szenen ergänzt (gesamt ${passB.szenen.length}).`);
  }
  return { stammFiguren, passB };
}

/**
 * E-Pass (Lebensereignisse) über die finale Figurenliste – bei grossen Casts in Batches
 * (ai.komplett.figure_batch_size) parallel, damit nicht ALLE Biografien in einem Output ums
 * max_tokens-Budget konkurrieren (grösster Truncation-Kandidat). ≤ batchSize → 1 Call
 * (heutiges Verhalten). Alle Batches lesen denselben gecachten Buchtext-Block. Non-fatal:
 * gescheiterte Batches → `failed=true` (Cache-Skip), erfolgreiche Batches werden trotzdem
 * angewendet (kein Totalverlust). Gibt `{ assignments, failed, batches }`.
 */
async function runEventsPassBatched(ctx, { bookSystemBlock, claudeExtractCap, stammFiguren }) {
  const { jobId, bookName, call, tok, log, prompts, sys, extractTier } = ctx;
  const batches = _chunkArray(stammFiguren, ctx.figureBatchSize || 20);
  const multi = batches.length > 1;
  const settled = await settledAll(batches.map((batch, bi) => () => retryOnTransientAi(() => call(jobId, tok,
    prompts.buildExtraktionEventsPassPrompt(bookName, batch, null),
    [bookSystemBlock, ...toSystemBlocks(sys.SYSTEM_KOMPLETT_EVENTS_PASS_BLOCKS, '1h')],
    null, null, claudeExtractCap, 0.2, null, prompts.SCHEMA_KOMPLETT_EVENTS, extractTier,
  ), { log, label: `Single-Pass Lebensereignisse (E)${multi ? ` Batch ${bi + 1}/${batches.length}` : ''}` })),
    (multi ? { concurrency: _phase1Concurrency() } : {}));
  const assignments = [];
  let failed = false;
  for (const r of settled) {
    if (r.status === 'fulfilled') assignments.push(...(Array.isArray(r.value?.assignments) ? r.value.assignments : []));
    else failed = true;
  }
  return { assignments, failed, batches: batches.length };
}

/**
 * A2-Pass (Beziehungen) über die finale Figurenliste. ≤ batchSize → 1 Call mit voller Liste
 * (heutiges Verhalten). Grössere Casts: per «von»-Scope batchen – jeder Call sieht die VOLLE
 * Figurenliste (damit «zu» auflösbar bleibt), gibt aber nur Beziehungen aus, deren «von» im
 * Batch liegt → kleinerer Output pro Call. Paar-Dedup übernimmt mergeBeziehungenIntoFiguren
 * (unabhängig von der Batch-Reihenfolge). Non-fatal (Cache-Skip bei Teilfehler). Gibt
 * `{ flatBz, failed, batches }`.
 */
async function runRelationsPassBatched(ctx, { bookSystemBlock, claudeExtractCap, stammFiguren }) {
  const { jobId, bookName, call, tok, log, prompts, sys } = ctx;
  const batchSize = Math.max(1, ctx.figureBatchSize || 20);
  const single = stammFiguren.length <= batchSize;
  const batches = single ? [stammFiguren] : _chunkArray(stammFiguren, batchSize);
  const settled = await settledAll(batches.map((batch, bi) => () => retryOnTransientAi(() => call(jobId, tok,
    prompts.buildFigurenBeziehungenExtraktionPrompt(
      bookName, single ? batch : stammFiguren, null, single ? null : batch.map(f => f.name).filter(Boolean)),
    [bookSystemBlock, ...toSystemBlocks(sys.SYSTEM_FIGUREN_BLOCKS, '1h')],
    null, null, claudeExtractCap, 0.2, null, prompts.SCHEMA_BEZIEHUNGEN,
  ), { log, label: `Single-Pass Beziehungen (A2)${single ? '' : ` Batch ${bi + 1}/${batches.length}`}` })),
    (batches.length > 1 ? { concurrency: _phase1Concurrency() } : {}));
  const flatBz = [];
  let failed = false;
  for (const r of settled) {
    if (r.status === 'fulfilled') flatBz.push(...(Array.isArray(r.value?.beziehungen) ? r.value.beziehungen : []));
    else failed = true;
  }
  return { flatBz, failed, batches: batches.length };
}

/**
 * Coverage-Feedback (nur Claude Single-Pass, gegated): der Vollständigkeits-Audit läuft VOR
 * E/A2 an einer Kapitel-Stichprobe und speist die namentlich als fehlend gemeldeten Figuren/
 * Schauplätze als gezielten Nachzieh-Pass ein — statt sie nur am Ende als Metrik zu zeigen.
 * Rein additiv, non-fatal. Mutiert nichts in place; gibt `{ stammFiguren, passB }` zurück.
 */
async function runCoverageFeedback(ctx, { bookSystemBlock, claudeExtractCap, stammFiguren, passB }) {
  const { jobId, bookName, call, tok, log, prompts, sys, groups, groupOrder, extractTier } = ctx;
  const n = ctx.coverageAuditChapters || 0;
  if (n <= 0) return { stammFiguren, passB };
  const samples = sampleChapters(groups, groupOrder, n);
  if (!samples.length) return { stammFiguren, passB };
  updateJob(jobId, { statusText: 'job.phase.coverageFeedback' });
  const figNames = stammFiguren.map(f => f.name).filter(Boolean);
  const orteNames = (passB.orte || []).map(o => o.name).filter(Boolean);
  const audit = await settledAll(samples.map(s => () => retryOnTransientAi(() => call(jobId, tok,
    prompts.buildCoverageAuditPrompt(bookName, s.name, s.chText, figNames, orteNames),
    toSystemBlocks(sys.SYSTEM_KOMPLETT_EXTRAKTION_BLOCKS), null, null, claudeExtractCap, 0.2, null,
    prompts.SCHEMA_COVERAGE_AUDIT, extractTier,
  ), { log, label: `Coverage-Feedback «${s.name}»` })), { concurrency: 3 });
  const ok = audit.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
  if (!ok.length) return { stammFiguren, passB };
  const cov = computeCoverageScore(ok);
  const knownFig = new Set(stammFiguren.map(f => _normalizeName(f.name)).filter(Boolean));
  const knownOrt = new Set((passB.orte || []).map(o => _normalizeName(o.name)).filter(Boolean));
  const missFig = [...new Set((cov.missingFiguren || []).filter(Boolean))].filter(nm => !knownFig.has(_normalizeName(nm)));
  const missOrt = [...new Set((cov.missingOrte || []).filter(Boolean))].filter(nm => !knownOrt.has(_normalizeName(nm)));
  if (!missFig.length && !missOrt.length) {
    log.info(`Coverage-Feedback: Score ${cov.score == null ? 'n/a' : cov.score}, keine fehlenden Namen für Nachzieh-Pass.`);
    return { stammFiguren, passB };
  }
  log.info(`Coverage-Feedback: Score ${cov.score == null ? 'n/a' : cov.score} – gezielter Nachzieh-Pass für ${missFig.length} Figur(en), ${missOrt.length} Ort(e).`);
  const [figRes, orteRes] = await settledAll([
    missFig.length ? () => retryOnTransientAi(() => call(jobId, tok,
      prompts.buildTargetedFigurenPrompt(bookName, missFig),
      [bookSystemBlock, ...toSystemBlocks(sys.SYSTEM_KOMPLETT_FIGUREN_STAMM_BLOCKS, '1h')],
      null, null, claudeExtractCap, 0.2, null, prompts.SCHEMA_KOMPLETT_FIGUREN_STAMM, extractTier,
    ), { log, label: 'Coverage-Feedback Figuren' }) : () => null,
    missOrt.length ? () => retryOnTransientAi(() => call(jobId, tok,
      prompts.buildTargetedOrtePrompt(bookName, missOrt),
      [bookSystemBlock, ...toSystemBlocks(sys.SYSTEM_KOMPLETT_ORTE_PASS_BLOCKS, '1h')],
      null, null, claudeExtractCap, 0.2, null, prompts.SCHEMA_KOMPLETT_ORTE_PASS, extractTier,
    ), { log, label: 'Coverage-Feedback Orte' }) : () => null,
  ], { concurrency: 2 });

  let outFig = stammFiguren, outB = passB;
  if (figRes.status === 'fulfilled' && Array.isArray(figRes.value?.figuren)) {
    const fresh = figRes.value.figuren.filter(f => f && f.name && !knownFig.has(_normalizeName(f.name)));
    if (fresh.length) {
      let maxIdx = 0;
      for (const f of stammFiguren) { const m = /^fig_(\d+)$/.exec(f.id || ''); if (m) maxIdx = Math.max(maxIdx, +m[1]); }
      for (const f of fresh) f.id = 'fig_' + (++maxIdx);
      outFig = stammFiguren.concat(fresh);
      log.info(`Coverage-Feedback: +${fresh.length} Figur(en) ergänzt (gesamt ${outFig.length}).`);
    }
  }
  if (orteRes.status === 'fulfilled' && Array.isArray(orteRes.value?.orte)) {
    const knownO = new Set((passB.orte || []).map(o => _normalizeName(o.name)).filter(Boolean));
    const fresh = orteRes.value.orte.filter(o => o && o.name && !knownO.has(_normalizeName(o.name)));
    if (fresh.length) {
      let maxIdx = 0;
      for (const o of (passB.orte || [])) { const m = /^ort_(\d+)$/.exec(o.id || ''); if (m) maxIdx = Math.max(maxIdx, +m[1]); }
      for (const o of fresh) o.id = 'ort_' + (++maxIdx);
      outB = { ...passB, orte: (passB.orte || []).concat(fresh) };
      log.info(`Coverage-Feedback: +${fresh.length} Ort(e) ergänzt (gesamt ${outB.orte.length}).`);
    }
  }
  return { stammFiguren: outFig, passB: outB };
}

/**
 * Szenen-Backfill (nur Claude Single-Pass, gegated): Kapitel mit substanziellem Text
 * (≥ ai.komplett.scene_backfill_min_chars), für die die Extraktion 0 Szenen lieferte, bekommen
 * einen gezielten Szenen-Nachzieh-Call. Deterministische Lückenerkennung (aus ctx.groups +
 * passB.szenen), nur der Fix braucht KI. Non-fatal; mutiert passB nicht in place. Gibt das
 * (ggf. ergänzte) passB zurück.
 */
async function runSceneBackfill(ctx, { bookSystemBlock, claudeExtractCap, passB }) {
  const { jobId, bookName, call, tok, log, prompts, sys, groups, groupOrder, extractTier } = ctx;
  const minChars = ctx.sceneBackfillMinChars || 3000;
  const sceneCountByChapter = new Map();
  for (const s of (passB.szenen || [])) {
    const k = (s.kapitel || '').trim();
    if (k) sceneCountByChapter.set(k, (sceneCountByChapter.get(k) || 0) + 1);
  }
  const targets = [];
  for (const key of (groupOrder || [])) {
    if (key === '__ungrouped__') continue; // keine echte Kapitel-Zuordnung
    const g = groups.get(key);
    if (!g) continue;
    const chars = (g.pages || []).reduce((sum, p) => sum + (p.text || '').length, 0);
    if (chars >= minChars && !(sceneCountByChapter.get((g.name || '').trim()) > 0)) targets.push(g.name);
  }
  if (!targets.length) return passB;
  updateJob(jobId, { statusText: 'job.phase.sceneBackfill' });
  log.info(`Szenen-Backfill: ${targets.length} Kapitel ohne Szene (≥${minChars} Zeichen) – gezielter Nachzieh-Pass.`);
  let res;
  try {
    res = await retryOnTransientAi(() => call(jobId, tok,
      prompts.buildTargetedSzenenPrompt(bookName, targets),
      [bookSystemBlock, ...toSystemBlocks(sys.SYSTEM_KOMPLETT_ORTE_PASS_BLOCKS, '1h')],
      null, null, claudeExtractCap, 0.2, null, prompts.SCHEMA_KOMPLETT_ORTE_PASS, extractTier,
    ), { log, label: 'Szenen-Backfill' });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    log.warn(`Szenen-Backfill fehlgeschlagen (${e.message}) – übersprungen.`);
    return passB;
  }
  const fresh = (Array.isArray(res?.szenen) ? res.szenen : []).filter(s => s && s.titel);
  if (!fresh.length) return passB;
  // Dedup gegen bestehende Szenen (titel+kapitel, normalisiert).
  const seen = new Set((passB.szenen || []).map(s => `${_normalizeName(s.titel)}|${_normalizeName(s.kapitel)}`));
  const add = [];
  for (const s of fresh) {
    const key = `${_normalizeName(s.titel)}|${_normalizeName(s.kapitel)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    add.push(s);
  }
  if (!add.length) return passB;
  log.info(`Szenen-Backfill: +${add.length} Szene(n) ergänzt.`);
  return { ...passB, szenen: (passB.szenen || []).concat(add) };
}

/**
 * Single-Pass Claude: A1 (Figuren-Stamm) + B (Orte/Szenen) + C (Fakten) parallel, dann
 * Completeness-Gaps, Coverage-Feedback + Szenen-Backfill, dann E (Events) + A2 (Beziehungen)
 * aus der finalen Figurenliste. Alle Calls teilen den 1h-Buchtext-Block (cache_read; Phase 8
 * trifft denselben Prefix); kleinere Schemas pro Call senken das Truncation-Risiko. Gibt
 * `{ passA, passB, failed }` zurück — der Caller bildet daraus partialFailure (Cache-/
 * Checkpoint-Skip-Gate).
 */
async function extractSinglePassClaude(ctx, { claudeExtractCap }) {
  const { jobId, bookName, call, tok, log, prompts, sys, pageContents, fullBookText, extractTier } = ctx;
  const failed = { relations: false, fakten: false, events: false };

  // Fakten als eigener Call (C): volle Modell-Aufmerksamkeit auf dichte Faktenerfassung
  // statt im 4-Array-Orte-Pass um Output-Budget zu konkurrieren.
  const bookSystemBlock = { text: buildBookSystemBlockText(bookName, pageContents.length, fullBookText), ttl: '1h' };
  const [stammRes, orteRes, faktenRes] = await settledAll([
    () => retryOnTransientAi(() => call(jobId, tok,
      prompts.buildExtraktionFigurenStammPrompt('Gesamtbuch', bookName, pageContents.length, null),
      [bookSystemBlock, ...toSystemBlocks(sys.SYSTEM_KOMPLETT_FIGUREN_STAMM_BLOCKS, '1h')],
      12, 20, claudeExtractCap, 0.2, null, prompts.SCHEMA_KOMPLETT_FIGUREN_STAMM, extractTier,
    ), { log, label: 'Single-Pass Figuren-Stamm (A1)' }),
    () => retryOnTransientAi(() => call(jobId, tok,
      prompts.buildExtraktionOrtePassPrompt('Gesamtbuch', bookName, pageContents.length, null),
      [bookSystemBlock, ...toSystemBlocks(sys.SYSTEM_KOMPLETT_ORTE_PASS_BLOCKS, '1h')],
      12, 20, claudeExtractCap, 0.2, null, prompts.SCHEMA_KOMPLETT_ORTE_PASS, extractTier,
    ), { log, label: 'Single-Pass Orte/Szenen (B)' }),
    () => retryOnTransientAi(() => call(jobId, tok,
      prompts.buildExtraktionFaktenPassPrompt('Gesamtbuch', bookName, pageContents.length, null),
      [bookSystemBlock, ...toSystemBlocks(sys.SYSTEM_KOMPLETT_FAKTEN_PASS_BLOCKS, '1h')],
      12, 20, claudeExtractCap, 0.2, null, prompts.SCHEMA_KOMPLETT_FAKTEN_PASS, extractTier,
    ), { log, label: 'Single-Pass Fakten (C)' }),
  // warmup: A1 seriell zuerst → schreibt den 1h-bookSystemBlock-Cache; B/C (und das
  // nachgelagerte A2/P8) lesen ihn statt ihn teuer neu zu erstellen (~1× cache_creation gespart).
  ], { warmup: true });
  if (stammRes.status === 'rejected') throw stammRes.reason;
  const stamm = stammRes.value || {};
  // Pflichtfeld-Check wie Phase 2 (figResult.figuren): eine schema-valide, aber
  // figuren-LOSE A1-Antwort darf NICHT still zu leerem Katalog werden und unter
  // '__singlepass__' eingefroren werden (Phantom-leerer-Katalog). A1 ist hart.
  // Legitim figurenloses Buch liefert figuren:[] (Array) → passiert den Guard.
  if (!Array.isArray(stamm.figuren)) throw i18nError('job.error.figurenMissing');
  // Orte/Szenen-Pass nicht still degradieren: ein durch Call-Fehler leerer
  // Katalog würde unter '__singlepass__' gecacht und bei jedem Folgelauf als
  // HIT geliefert (Phantom-Erfolg), bis eine Seitenedition die Signatur ändert.
  // Wie A1 hart werfen – transiente Fehler sind oben bereits geretryt. Ein
  // legitim ortloses Buch liefert fulfilled mit leerem Array und cached korrekt.
  if (orteRes.status === 'rejected') throw orteRes.reason;
  const passB = orteRes.value || {};
  // Fakten-Pass (C): nicht fatal – ein gescheiterter Fakten-Call soll die
  // teure Figuren-/Orte-Extraktion nicht verwerfen. Stattdessen leere Fakten +
  // Warnung; faktenFailed verhindert das Einfrieren des '__singlepass__'-Caches
  // (sonst Phantom-leere-Fakten bis zur nächsten Seitenedition).
  if (faktenRes.status === 'rejected') {
    failed.fakten = true;
    log.warn(`Single-Pass Fakten-Pass (C) fehlgeschlagen, Fakten leer: ${faktenRes.reason?.message}`);
    ctx.warnings?.push({ key: 'job.warn.faktenFailed' });
    passB.fakten = [];
  } else {
    passB.fakten = faktenRes.value?.fakten || [];
  }

  // ── Completeness-/Gap-Pässe (Long-Tail-Recall) ──
  // Läuft VOR A2, damit der Beziehungs-Pass die ergänzten Figuren mit abdeckt. Der geclampte
  // Wert kommt aus ctx (job.js) — er fliesst dort auch in die cacheVersion, damit ein
  // Setting-Wechsel die Single-/Multi-Pass-Caches + Checkpoint invalidiert.
  let stammFiguren = stamm.figuren || [];
  let workingB = passB;
  const completenessPasses = ctx.completenessPasses || 0;
  if (completenessPasses > 0) {
    ({ stammFiguren, passB: workingB } = await runSinglePassCompletenessGaps(ctx, {
      bookSystemBlock, claudeExtractCap, stammFiguren, passB, faktenFailed: failed.fakten,
    }));
  }

  // Coverage-Feedback (#2) + Szenen-Backfill (#3), beide gegated + non-fatal. VOR E/A2, damit
  // per Coverage-Feedback ergänzte Figuren gleich Events/Beziehungen bekommen. Beide mutieren
  // stammFiguren / workingB, die anschliessend gecacht werden (Enablement/Parameter stecken in
  // der cacheVersion → Toggle invalidiert den __singlepass__-Cache).
  if (ctx.coverageFeedbackEnabled) {
    ({ stammFiguren, passB: workingB } = await runCoverageFeedback(ctx, {
      bookSystemBlock, claudeExtractCap, stammFiguren, passB: workingB,
    }));
  }
  if (ctx.sceneBackfillEnabled) {
    workingB = await runSceneBackfill(ctx, { bookSystemBlock, claudeExtractCap, passB: workingB });
  }

  // E (Lebensereignisse) + A2 (Beziehungen): beide gegen den gecachten Buchtext-Block mit der
  // finalen Figurenliste (post-Completeness/-Coverage-Feedback). Grosse Casts werden pro Pass
  // in Batches (ai.komplett.figure_batch_size) parallelisiert (kleinere, robustere Outputs).
  // E und A2 laufen zueinander parallel (Promise.all); jeder Pass intern concurrency-gecappt.
  // Non-fatal: erfolgreiche (Teil-)Ergebnisse werden angewendet, ein Teilfehler setzt nur
  // events-/relationsFailed (Cache-Skip), verwirft aber nicht die teure Extraktion.
  let assignments = [];
  const runEvents = stammFiguren.length > 0;
  const runRelations = stammFiguren.length >= 2;
  if (runEvents || runRelations) {
    updateJob(jobId, { progress: 19, statusText: 'job.phase.extractingEvents' });
    const [evOut, bzOut] = await Promise.all([
      runEvents ? runEventsPassBatched(ctx, { bookSystemBlock, claudeExtractCap, stammFiguren })
        : Promise.resolve({ assignments: [], failed: false, batches: 0 }),
      runRelations ? runRelationsPassBatched(ctx, { bookSystemBlock, claudeExtractCap, stammFiguren })
        : Promise.resolve({ flatBz: [], failed: false, batches: 0 }),
    ]);
    if (runEvents) {
      assignments = evOut.assignments; // auch bei Teilfehler: was erfasst wurde, anwenden
      const nEv = assignments.reduce((s, a) => s + (a.lebensereignisse?.length || 0), 0);
      log.info(`Single-Pass Events-Pass (E) – ${nEv} Ereignisse für ${assignments.length} Figuren${evOut.batches > 1 ? ` (${evOut.batches} Batches)` : ''}.`);
      if (evOut.failed) {
        failed.events = true;
        log.warn('Single-Pass Events-Pass (E) (teilweise) fehlgeschlagen – Cache/Checkpoint übersprungen.');
        ctx.warnings?.push({ key: 'job.warn.eventsFailed' });
      }
    }
    if (runRelations) {
      stammFiguren = mergeBeziehungenIntoFiguren(stammFiguren, bzOut.flatBz);
      log.info(`Single-Pass Beziehungs-Pass (A2) – ${bzOut.flatBz.length} Beziehungen extrahiert${bzOut.batches > 1 ? ` (${bzOut.batches} Batches)` : ''}.`);
      if (bzOut.failed) {
        failed.relations = true;
        log.warn('Single-Pass Beziehungs-Pass (A2) (teilweise) fehlgeschlagen – Cache/Checkpoint übersprungen.');
        ctx.warnings?.push({ key: 'job.warn.relationsFailed' });
      }
    }
    updateJob(jobId, { progress: 28 });
  }
  return { passA: { figuren: stammFiguren, assignments }, passB: workingB, failed };
}

/**
 * Single-Pass lokaler Provider: kombinierter Call (kein 1h-Cache → Split wäre 3× voller Input).
 */
async function extractSinglePassLocal(ctx, { callExtract }) {
  const { bookName, prompts, sys, pageContents, fullBookText } = ctx;
  const r = await callExtract('Single-Pass Extraktion (lokal)',
    prompts.buildExtraktionKomplettChapterPrompt('Gesamtbuch', bookName, pageContents.length, fullBookText),
    sys.SYSTEM_KOMPLETT_EXTRAKTION_BLOCKS, 12, 28, 16000, prompts.SCHEMA_KOMPLETT_EXTRAKTION);
  return {
    passA: { figuren: r?.figuren, assignments: r?.assignments },
    passB: { orte: r?.orte, songs: r?.songs, fakten: r?.fakten, szenen: r?.szenen },
    failed: { relations: false, fakten: false, events: false },
  };
}

function assembleSinglePassChapters(passA, passB) {
  return {
    chapterFiguren:     [{ kapitel: 'Gesamtbuch', figuren:     passA.figuren     || [] }],
    chapterOrte:        [{ kapitel: 'Gesamtbuch', orte:        passB.orte        || [] }],
    chapterSongs:       [{ kapitel: 'Gesamtbuch', songs:       passB.songs       || [] }],
    chapterFakten:      [{ kapitel: 'Gesamtbuch', fakten:      passB.fakten      || [] }],
    chapterSzenen:      [{ kapitel: 'Gesamtbuch', szenen:      passB.szenen      || [] }],
    chapterAssignments: [{ kapitel: 'Gesamtbuch', assignments: passA.assignments || [] }],
  };
}

/**
 * Single-Pass für kleine Bücher. Persistenter Cache (chapter_key='__singlepass__' +
 * Gesamt-Seitensignatur): unveränderter Seitenstand → P1-Ergebnis wiederverwenden (überlebt
 * Job-Ende, anders als der 1h-Anthropic-Prompt-Cache). Gibt `{ chapters, partialFailure }`.
 */
async function extractSinglePass(ctx, { claudeExtractCap, callExtract }) {
  const { jobId, bookIdInt, email, log, effectiveProvider, cacheVersion, pageContents } = ctx;
  const bookPagesSig = buildBookPagesSig(pageContents, getBookSettings(bookIdInt, email), cacheVersion);
  const cached = loadChapterExtractCache(bookIdInt, email, '__singlepass__', bookPagesSig, effectiveProvider);
  // HIT auf Cache-Präsenz gaten, nicht auf Figuren-Count: Bücher ohne Figuren
  // (Sachbuch, Lyrik) sind legitim – sonst Cache-MISS bei jedem Run trotz
  // identischem Seitenstand.
  if (cached && Array.isArray(cached.chapterFiguren) && cached.chapterFiguren.length > 0) {
    log.info(`Phase 1 Single-Pass – Cache-HIT (pages_sig match) – spart den Extraktions-Call.`);
    updateJob(jobId, { progress: 28, statusText: 'job.phase.checkpointLoaded' });
    return {
      chapters: {
        chapterFiguren:     cached.chapterFiguren,
        chapterOrte:        cached.chapterOrte        || [{ kapitel: 'Gesamtbuch', orte: [] }],
        chapterSongs:       cached.chapterSongs       || [{ kapitel: 'Gesamtbuch', songs: [] }],
        chapterFakten:      cached.chapterFakten      || [{ kapitel: 'Gesamtbuch', fakten: [] }],
        chapterSzenen:      cached.chapterSzenen      || [{ kapitel: 'Gesamtbuch', szenen: [] }],
        chapterAssignments: cached.chapterAssignments || [{ kapitel: 'Gesamtbuch', assignments: [] }],
      },
      partialFailure: false,
    };
  }

  updateJob(jobId, { progress: 12, statusText: 'job.phase.extracting' });
  const { passA, passB, failed } = effectiveProvider === 'claude'
    ? await extractSinglePassClaude(ctx, { claudeExtractCap })
    : await extractSinglePassLocal(ctx, { callExtract });

  const chapters = assembleSinglePassChapters(passA, passB);
  const totalEvents = (passA.assignments || []).reduce((s, a) => s + (a.lebensereignisse?.length || 0), 0);
  log.info(`Single-Pass OK – fig=${chapters.chapterFiguren[0].figuren.length} orte=${chapters.chapterOrte[0].orte.length} songs=${chapters.chapterSongs[0].songs.length} fakten=${chapters.chapterFakten[0].fakten.length} sz=${chapters.chapterSzenen[0].szenen.length} (${totalEvents} Ereignisse)`);

  // A2/C/E-Teilfehler: den beziehungs-/fakten-/eventlosen Teilstand NICHT unter
  // '__singlepass__' einfrieren (sonst Phantom-Erfolg bei jedem Folgelauf bis zur
  // Seitenedition). Cache-Skip + Checkpoint-Skip (partialFailure fliesst nach oben).
  const partialFailure = failed.relations || failed.fakten || failed.events;
  if (partialFailure) {
    const which = [failed.relations && 'A2 (Beziehungen)', failed.fakten && 'C (Fakten)', failed.events && 'E (Events)']
      .filter(Boolean).join(', ');
    log.warn(`Single-Pass Cache + Checkpoint übersprungen – ${which} gescheitert, Teilstand wird nicht eingefroren.`);
  } else {
    saveChapterExtractCache(bookIdInt, email, '__singlepass__', bookPagesSig, chapters, effectiveProvider);
  }
  return { chapters, partialFailure };
}

/**
 * Multi-Pass Completeness-/Gap-Pass (nur Claude, grosse Bücher). Anders als der Single-Pass
 * bekommt hier jeder Chunk EINEN Basis-Extraktions-Durchlauf → der Long-Tail (Nebenfiguren,
 * einmal erwähnte Schauplätze/Fakten/Szenen) fällt pro Chunk systematisch durch. Dieser Pass
 * prompt't pro Chunk erneut (kombiniertes Gap-Schema), gesät mit dem GLOBAL bereits gefundenen
 * Katalog aller Chunks (Cross-Chunk-Dedup) → nur der genuine Long-Tail wird nachgezogen.
 * Loop-until-dry pro Chunk bis completenessPasses. Rein ADDITIV (mutiert `chapters` in place,
 * hängt fresh items an den jeweiligen Chunk-Eintrag). Eigener `:gap`-Cache pro Chunk → die
 * Basis-Chunk-Caches bleiben gültig. Läuft auf dem Extraktions-Tier (extractTier). NON-FATAL.
 */
async function runMultiPassCompletenessGaps(ctx, { chunkTexts, chapters, concurrency }) {
  const { jobId, bookIdInt, email, bookName, call, tok, log, effectiveProvider, prompts, sys, extractTier } = ctx;
  const completenessPasses = ctx.completenessPasses || 0;
  if (effectiveProvider !== 'claude' || completenessPasses <= 0 || !chunkTexts.length) return;

  const claudeExtractCap = getContextConfigFor(effectiveProvider).maxTokensOut;
  const faktKey = (f) => `${f.subjekt || ''}: ${f.fakt || ''}`;
  const szeneKey = (s) => `${s.titel || ''} (${s.kapitel || ''})`;
  const STREAMS = [
    { name: 'figuren', arr: chapters.chapterFiguren, field: 'figuren', keyOf: (f) => f.name,   isValid: (f) => f && f.name },
    { name: 'orte',    arr: chapters.chapterOrte,    field: 'orte',    keyOf: (o) => o.name,   isValid: (o) => o && o.name },
    { name: 'fakten',  arr: chapters.chapterFakten,  field: 'fakten',  keyOf: faktKey,          isValid: (f) => f && f.fakt },
    { name: 'szenen',  arr: chapters.chapterSzenen,  field: 'szenen',  keyOf: szeneKey,         isValid: (s) => s && s.titel },
  ];
  // Global-Known (über alle Chunks) als Anzeige-Liste + Normalisierungs-Set pro Strom.
  const knownSet = {}, knownDisp = {};
  for (const s of STREAMS) {
    knownSet[s.name] = new Set();
    knownDisp[s.name] = [];
    for (const c of (s.arr || [])) for (const it of (c[s.field] || [])) {
      const k = _normalizeName(s.keyOf(it));
      if (!k || knownSet[s.name].has(k)) continue;
      knownSet[s.name].add(k); knownDisp[s.name].push(s.keyOf(it));
    }
  }

  updateJob(jobId, { statusText: 'job.phase.completenessChunks', statusParams: { n: chunkTexts.length } });
  const perChunk = await settledAll(chunkTexts.map(({ chunk, key, pagesSig, chText }, chunkIdx) => async () => {
    const chunkLabel = `Gap-Chunk ${chunkIdx + 1}/${chunkTexts.length} «${chunk.name}»`;
    const gapCacheKey = `${key}:gap`;
    const cached = loadChapterExtractCache(bookIdInt, email, gapCacheKey, pagesSig, effectiveProvider);
    if (cached) { log.info(`${chunkLabel} – Cache-HIT.`); return cached; }

    // Chunk-lokale Akkumulatoren, gesät mit dem globalen Known-Katalog.
    const seen = {}, disp = {}, fresh = {};
    for (const s of STREAMS) { seen[s.name] = new Set(knownSet[s.name]); disp[s.name] = knownDisp[s.name].slice(); fresh[s.name] = []; }
    for (let round = 1; round <= completenessPasses; round++) {
      let res;
      try {
        res = await retryOnTransientAi(() => call(jobId, tok,
          prompts.buildChunkGapPrompt(chunk.name, bookName, chunk.pages.length, chText, {
            figuren: disp.figuren, orte: disp.orte, fakten: disp.fakten, szenen: disp.szenen,
          }),
          sys.SYSTEM_KOMPLETT_EXTRAKTION_BLOCKS, null, null, claudeExtractCap, 0.2, null, prompts.SCHEMA_KOMPLETT_EXTRAKTION, extractTier,
        ), { log, label: `${chunkLabel} (Gap ${round}/${completenessPasses})` });
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        log.warn(`${chunkLabel} Gap-Pass ${round} fehlgeschlagen (${e.message}) – übersprungen.`);
        break;
      }
      let anyNew = 0;
      for (const s of STREAMS) {
        for (const it of (res?.[s.field] || [])) {
          if (!s.isValid(it)) continue;
          const k = _normalizeName(s.keyOf(it));
          if (!k || seen[s.name].has(k)) continue;
          seen[s.name].add(k); disp[s.name].push(s.keyOf(it)); fresh[s.name].push(it); anyNew++;
        }
      }
      log.info(`${chunkLabel} Gap ${round}: +${anyNew} neu.`);
      if (anyNew === 0) break; // loop-until-dry
    }
    saveChapterExtractCache(bookIdInt, email, gapCacheKey, pagesSig, fresh, effectiveProvider);
    return fresh;
  }), (chunkTexts.length > concurrency ? { concurrency } : {}));

  // Additiv in die per-Chunk-Kapiteleinträge mergen (extractField hält Index-Alignment zu chunkTexts).
  const totals = { figuren: 0, orte: 0, fakten: 0, szenen: 0 };
  for (let i = 0; i < perChunk.length; i++) {
    if (perChunk[i].status !== 'fulfilled' || !perChunk[i].value) continue;
    const f = perChunk[i].value;
    for (const s of STREAMS) {
      const items = f[s.name];
      if (items?.length && s.arr[i]) { s.arr[i][s.field].push(...items); totals[s.name] += items.length; }
    }
  }
  if (totals.figuren || totals.orte || totals.fakten || totals.szenen)
    log.info(`Multi-Pass Completeness: +${totals.figuren} Figuren, +${totals.orte} Orte, +${totals.fakten} Fakten, +${totals.szenen} Szenen.`);
}

/**
 * Multi-Pass mit Delta-Cache (grosse Bücher / lokale Provider): Kapitel → Chunks, einzeln
 * extrahiert + pro Chunk gecacht. Gibt `{ chapters, partialFailure }` zurück — partialFailure
 * bei nicht-fataler Chunk-Truncation (Cache-Skip pro Chunk + Checkpoint-Skip).
 */
async function extractMultiPass(ctx, { chunks, chunkOrder, claudeExtractCap, callExtract }) {
  const { jobId, bookIdInt, bookName, email, call, tok, log, effectiveProvider, cacheVersion, prompts, sys } = ctx;
  let partialFailure = false;

  // Lokale Modelle: Kapitel über PER_CHUNK_LIMIT in Seiten-Untergruppen splitten, jeder Chunk
  // mit eigenem KI-Call + Delta-Cache-Eintrag. Claude: singlePassLimit als Grenze → kein Split.
  updateJob(jobId, { progress: 12, statusText: 'job.phase.extractingChunks', statusParams: { n: chunkOrder.length } });
  // Settings-Anteil identisch zum Single-Pass-Key (buildBookPagesSig): Buchtyp/
  // Kontext fliessen in den Extraktions-Prompt, also muss ihr Wechsel auch die
  // Per-Chunk-Caches invalidieren – sonst liefert der Multi-Pass-Cache stale
  // Extraktion mit den alten Autoren-Vorgaben.
  const settingsSig = bookSettingsSigPart(getBookSettings(bookIdInt, email));
  const chunkTexts = chunkOrder.map(chunkKey => {
    const chunk = chunks.get(chunkKey);
    return {
      chunk, key: chunkKey,
      // Kapitelname im Sig: er fliesst via buildExtraktionKomplettChapterPrompt(chunk.name)
      // in den Prompt, steht aber nicht in page_id:updated_at. Ohne ihn liefert eine reine
      // Kapitel-Umbenennung einen stale Cache-HIT mit altem Kapitelkontext. Rename → MISS.
      pagesSig: chunk.pages.map(p => `${p.id}:${p.updated_at}`).sort().join('|') + `||${settingsSig}||ch:${chunk.name || ''}||${cacheVersion || ''}`,
      chText: chunk.pages.map(p => `### ${p.title}\n${p.text}`).join('\n\n---\n\n'),
    };
  });
  // Claude-Warmup laeuft seriell (settledAll(..., {warmup:true})) und schreibt
  // den Prompt-Cache fuer die parallelen Folge-Chunks. Damit der serielle
  // Pass keine Verzoegerung kostet, faengt der kleinste Chunk an
  // (Seitenzahl als Proxy; bei Gleichstand stabile chunkOrder-Reihenfolge).
  if (effectiveProvider === 'claude' && chunkTexts.length > 1) {
    const minIdx = chunkTexts.reduce((best, ct, i, arr) =>
      ct.chunk.pages.length < arr[best].chunk.pages.length ? i : best, 0);
    if (minIdx > 0) {
      const [smallest] = chunkTexts.splice(minIdx, 1);
      chunkTexts.unshift(smallest);
    }
  }
  let cacheHits = 0;
  // Für lokale Modelle zweigeteilte Extraktion: Pass A (figuren+assignments) / Pass B
  // (orte+fakten+szenen), Cache-Keys `${key}:figuren` / `${key}:orte` (getrennt von alten
  // kombinierten Caches, damit die sauber neu entstehen statt fälschlich getroffen zu werden).
  const isSplit = effectiveProvider !== 'claude';
  // Claude-Multi-Pass: Anthropic-TPM-Burst dämpfen. warmup: Erst-Chunk seriell → schreibt
  // Prompt-Cache, Folge-Chunks hitten ihn (~10× günstiger + kürzere Reqs). concurrency-Cap:
  // max. ai.claude.phase1_concurrency (Default 4, belastbar gegen Tier-1/2 bei ~25k tok/Chunk).
  const claudeConcurrency = Math.max(1, parseInt(appSettings.get('ai.claude.phase1_concurrency'), 10) || 4);
  const settledOpts = (effectiveProvider === 'claude' && chunkTexts.length > claudeConcurrency)
    ? { concurrency: claudeConcurrency, warmup: true }
    : {};
  if (settledOpts.warmup) {
    log.info(`Phase 1 Multi-Pass – ${chunkTexts.length} Chunks, Warmup-Pass + Concurrency=${claudeConcurrency} (TPM-Schutz).`);
  }
  // Progress pro abgeschlossenem Chunk bumpen – nicht via aiCall-Stream: parallele Chunks
  // würden sonst alle in 12-28 ticken und der schnellste Stream die Bar früh ans Ende clampen.
  // Monotone Chunk-Completion-Updates = ehrlicher Verlauf.
  let chunksDone = 0;
  const bumpChunkProgress = () => {
    chunksDone++;
    updateJob(jobId, { progress: 12 + Math.round((chunksDone / chunkTexts.length) * 16) });
  };
  const settled = await settledAll(
    chunkTexts.map(({ chunk, key, pagesSig, chText }, chunkIdx) => async () => {
      const chunkLabel = `Chunk ${chunkIdx + 1}/${chunkTexts.length} «${chunk.name}»`;
      log.info(`${chunkLabel} – ${chunk.pages.length} Seiten${isSplit ? ' (Split-Pässe)' : ''}`);

      if (!isSplit) {
        const cachedChunk = loadChapterExtractCache(bookIdInt, email, key, pagesSig, effectiveProvider);
        if (cachedChunk) { cacheHits++; log.info(`${chunkLabel} – Cache-HIT.`); bumpChunkProgress(); return cachedChunk; }
        log.info(`${chunkLabel} – Cache-MISS, KI-Call…`);
        const result = await retryOnTransientAi(() => call(jobId, tok,
          prompts.buildExtraktionKomplettChapterPrompt(chunk.name, bookName, chunk.pages.length, chText),
          sys.SYSTEM_KOMPLETT_EXTRAKTION_BLOCKS, null, null, claudeExtractCap, 0.2, null, prompts.SCHEMA_KOMPLETT_EXTRAKTION,
        ), { log, label: chunkLabel });
        saveChapterExtractCache(bookIdInt, email, key, pagesSig, result, effectiveProvider);
        log.info(`${chunkLabel} – OK (fig=${result?.figuren?.length ?? 0} orte=${result?.orte?.length ?? 0} songs=${result?.songs?.length ?? 0} sz=${result?.szenen?.length ?? 0}).`);
        bumpChunkProgress();
        return result;
      }

      const figKey = `${key}:figuren`;
      const ortKey = `${key}:orte`;
      const cachedFig = loadChapterExtractCache(bookIdInt, email, figKey, pagesSig, effectiveProvider);
      const cachedOrt = loadChapterExtractCache(bookIdInt, email, ortKey, pagesSig, effectiveProvider);

      let passA = cachedFig;
      if (passA) { cacheHits++; log.info(`${chunkLabel} Pass A (Figuren) – Cache-HIT.`); }
      else {
        log.info(`${chunkLabel} Pass A (Figuren) – KI-Call…`);
        passA = await callExtract(`${chunkLabel} Pass A`,
          prompts.buildExtraktionFigurenPassPrompt(chunk.name, bookName, chunk.pages.length, chText),
          sys.SYSTEM_KOMPLETT_FIGUREN_PASS_BLOCKS, null, null, 8000, prompts.SCHEMA_KOMPLETT_FIGUREN_PASS);
        saveChapterExtractCache(bookIdInt, email, figKey, pagesSig, passA, effectiveProvider);
      }

      let passB = cachedOrt;
      if (passB) { cacheHits++; log.info(`${chunkLabel} Pass B (Orte/Szenen) – Cache-HIT.`); }
      else {
        log.info(`${chunkLabel} Pass B (Orte/Szenen) – KI-Call…`);
        passB = await callExtract(`${chunkLabel} Pass B`,
          prompts.buildExtraktionOrtePassPrompt(chunk.name, bookName, chunk.pages.length, chText),
          sys.SYSTEM_KOMPLETT_ORTE_PASS_BLOCKS, null, null, 6000, prompts.SCHEMA_KOMPLETT_ORTE_PASS);
        saveChapterExtractCache(bookIdInt, email, ortKey, pagesSig, passB, effectiveProvider);
      }

      const merged = {
        figuren:     passA?.figuren     || [],
        assignments: passA?.assignments || [],
        orte:        passB?.orte        || [],
        songs:       passB?.songs       || [],
        fakten:      passB?.fakten      || [],
        szenen:      passB?.szenen      || [],
      };
      log.info(`${chunkLabel} – Split-OK (fig=${merged.figuren.length} orte=${merged.orte.length} songs=${merged.songs.length} sz=${merged.szenen.length}).`);
      bumpChunkProgress();
      return merged;
    }),
    settledOpts,
  );

  for (let i = 0; i < settled.length; i++) {
    if (settled[i].status === 'rejected')
      log.warn(`Vollextraktion «${chunkTexts[i].chunk.name}» übersprungen: ${settled[i].reason?.message}`);
  }
  const chapters = {
    chapterFiguren:     extractField(settled, chunkTexts, 'figuren'),
    chapterOrte:        extractField(settled, chunkTexts, 'orte'),
    chapterSongs:       extractField(settled, chunkTexts, 'songs'),
    chapterFakten:      extractField(settled, chunkTexts, 'fakten'),
    chapterSzenen:      extractField(settled, chunkTexts, 'szenen'),
    chapterAssignments: extractField(settled, chunkTexts, 'assignments'),
  };

  const failedChunks = settled.filter(r => r.status === 'rejected');
  const cacheLookups = chunkTexts.length * (isSplit ? 2 : 1);
  log.info(`Phase 1 Multi-Pass – ${settled.length - failedChunks.length}/${settled.length} OK (${cacheHits}/${cacheLookups} Cache-Hits), fig=${chapters.chapterFiguren.reduce((s, c) => s + c.figuren.length, 0)} orte=${chapters.chapterOrte.reduce((s, c) => s + c.orte.length, 0)} songs=${chapters.chapterSongs.reduce((s, c) => s + (c.songs?.length || 0), 0)} sz=${chapters.chapterSzenen.reduce((s, c) => s + c.szenen.length, 0)}`);
  if (failedChunks.length > 0) {
    const failedInfo = chunkTexts
      .map((ct, i) => ({ ct, r: settled[i] }))
      .filter(({ r }) => r.status === 'rejected')
      .map(({ ct, r }) => ({ name: ct.chunk.name, message: r.reason?.message || 'unbekannt' }));
    const details = failedInfo.map(f => `${f.name}: ${f.message}`).join('; ');
    const onlyTruncation = failedInfo.every(f => f.message === 'job.error.aiTruncated');
    const someSucceeded = (settled.length - failedChunks.length) > 0;
    // Truncation einzelner Chunks ist nicht-fatal, SOLANGE mindestens ein Chunk
    // Daten lieferte: das lokale Modell dreht bei dichten Kapiteln in Wiederholungs-
    // schleifen (kein Cap fixt das — repeat_penalty mildert es). Betroffene
    // (Teil-)Chunks tragen dann nichts bei; wiederkehrende Figuren/Orte werden über
    // die übrigen Chunks meist trotzdem erfasst. Andere Fehlerarten (Provider down,
    // Parse-Fehler) ODER ein Totalausfall (0 OK) bleiben hart — dann hat Phase 1
    // keine verlässliche Basis und der Job bricht ehrlich ab, statt ein leeres
    // Ergebnis als „fertig" auszugeben.
    if (onlyTruncation && someSucceeded) {
      // Teilfehler: Checkpoint überspringen (wie der Cache-Skip oben). Sonst friert ein
      // Crash nach Phase 1 die truncierten/fehlenden Chunks ein; der Resume lädt den
      // lückenhaften Stand statt die nie gecachten Chunks erneut zu extrahieren.
      partialFailure = true;
      const skippedChapters = [...new Set(failedInfo.map(f => f.name))];
      log.warn(`Phase 1 – ${failedChunks.length} Chunk(s) durch Truncation übersprungen (nicht-fatal): ${details}`);
      ctx.warnings?.push({
        key: 'job.warn.chunksTruncated',
        params: { count: failedChunks.length, chapters: skippedChapters.join(', ') },
      });
    } else {
      throw i18nError('job.error.phase1Incomplete', { count: failedChunks.length, details });
    }
  }

  // Completeness-/Gap-Pass (nur Claude): pro Chunk den Long-Tail nachziehen, den der
  // eine Basis-Durchlauf ausgelassen hat. Additiv, non-fatal, eigener :gap-Cache.
  await runMultiPassCompletenessGaps(ctx, { chunkTexts, chapters, concurrency: claudeConcurrency });

  return { chapters, partialFailure };
}

/**
 * Checkpoint NUR bei vollständiger Phase 1 schreiben — symmetrisch zum Delta-Cache-Skip.
 * Bei Teilfehler (A2/C/E gescheitert bzw. truncierte Chunks) würde ein gespeicherter
 * Checkpoint den degradierten Stand einfrieren und der Resume Phase 1 überspringen, ohne
 * die fehlenden Pässe je nachzuholen (Phantom-Erfolg über den zweiten Resume-Mechanismus).
 */
function writePhase1Checkpoint(ctx, chapters, partialFailure) {
  const { log, bookIdInt, email, tok } = ctx;
  if (partialFailure) {
    log.warn('Checkpoint übersprungen – Phase-1-Teilfehler; ein Resume re-extrahiert Phase 1 vollständig (gecachte Chunks per HIT).');
    return;
  }
  saveCheckpoint('komplett-analyse', bookIdInt, email, {
    phase: 'p1_full_done',
    bookPagesSig: ctx.bookPagesSig,
    ...chapters,
    tokIn: tok.in, tokOut: tok.out, tokMs: tok.ms,
  });
}

/**
 * Phase 1: Vollextraktion (Figuren+Orte+Fakten+Szenen+Events).
 * Single-Pass für kleine Bücher, Multi-Pass mit Delta-Cache für grosse.
 * Schema und Regeln im System-Prompt (SYSTEM_KOMPLETT_EXTRAKTION) → gecacht über alle Kapitel.
 * Szenen/Assignments verwenden Klarnamen statt IDs; Remapping nach P2/P3-Konsolidierung.
 */
async function runPhase1(ctx) {
  const { jobId, call, tok, log, effectiveProvider, singlePassLimit, perChunkLimit: ctxPerChunkLimit,
    prompts, groups, groupOrder, totalChars, extractTier } = ctx;

  // EXTRAKTIONS-Schwelle (ai.komplett.extract_single_pass_cap, entkoppelt von der
  // Kontinuitäts-Schwelle singlePassLimit): entscheidet Single- vs. Multi-Pass UND – bei Claude –
  // die Chunk-Obergrenze. So kann die Extraktion kapitelweise laufen (besserer Long-Tail-Recall),
  // während Kontinuität/Erzählprofil weiter das ganze Buch sehen (singlePassLimit).
  const extractLimit = ctx.extractSinglePassLimit || singlePassLimit;

  // Claude packt alles in einen Chunk (extractLimit als obere Schranke), lokale
  // Provider chunken nach `ai.<provider>.context_window` (siehe ctx.perChunkLimit aus chunkLimitsFor).
  const perChunkLimit = effectiveProvider === 'claude' ? extractLimit : ctxPerChunkLimit;
  const { chunkOrder, chunks } = splitGroupsIntoChunks(groups, groupOrder, perChunkLimit);

  // Output-Cap für lokale Extraktions-Calls (Single-Pass-lokal + Multi-Pass Split A/B):
  // ai.komplett.extract_max_tokens, gedeckelt aufs Provider-Ceiling (komplettMaxTokens).
  // KEIN Eskalations-Retry: lokale Modelle, die hier trunkieren, tun das wegen
  // Wiederholungsschleifen — ein höherer Cap generiert nur länger, bevor er ebenso
  // reisst (verdoppelt die Wartezeit). Gegen die Schleifen wirkt repeat_penalty
  // (ai.<provider>.repeat_penalty, lib/ai.js); echte Truncation einzelner Chunks wird
  // in der Multi-Pass-Auswertung als nicht-fatal behandelt (Teilabdeckung + Warnung).
  // Claude rechnet nur generierte Tokens ab — reserviertes max_tokens ist gratis —,
  // darum die Claude-Extraktions-Calls direkt grosszügig aufs Provider-Ceiling deckeln.
  const claudeExtractCap = getContextConfigFor(effectiveProvider).maxTokensOut;
  const callExtract = (label, prompt, system, fromPct, toPct, expectedChars, schema) =>
    retryOnTransientAi(() => call(jobId, tok, prompt, system, fromPct, toPct, expectedChars, 0.2, komplettMaxTokens(effectiveProvider), schema, extractTier),
      { log, label });

  log.info(`Phase 1 – ${totalChars} Zeichen, ${effectiveProvider} → ${totalChars <= extractLimit ? 'Single-Pass' : `Multi-Pass (${groupOrder.length} Kapitel → ${chunkOrder.length} Chunks)`}`);

  let result;
  if (totalChars <= extractLimit) {
    try {
      result = await extractSinglePass(ctx, { claudeExtractCap, callExtract });
    } catch (e) {
      // #6 Truncation-Fallback: Reisst A1/B im Single-Pass am Output-Cap (dichtes Buch,
      // 128K-Ceiling inkl. adaptive-Thinking-Tokens), verwirft das nicht den Job – wir weichen
      // auf Multi-Pass aus (kapitelweise/geteilte Chunks). Nur Claude + echte Truncation; ein
      // eigener, kleinerer perChunkLimit erzwingt auch bei einem einzelnen grossen Kapitel einen
      // Split. AbortError + andere Fehler bleiben fatal.
      if (e?.message === 'job.error.aiTruncated' && effectiveProvider === 'claude') {
        const fbPerChunk = Math.max(10000, Math.floor(extractLimit / 2));
        const { chunkOrder: fbOrder, chunks: fbChunks } = splitGroupsIntoChunks(groups, groupOrder, fbPerChunk);
        if (fbOrder.length > 1) {
          log.warn(`Single-Pass-Extraktion truncated – Fallback auf Multi-Pass (${fbOrder.length} Chunks à ≤${fbPerChunk} Zeichen).`);
          result = await extractMultiPass(ctx, { chunks: fbChunks, chunkOrder: fbOrder, claudeExtractCap, callExtract });
        } else {
          throw e; // ein einziges, nicht weiter teilbares Kapitel – kein Fallback möglich
        }
      } else {
        throw e;
      }
    }
  } else {
    result = await extractMultiPass(ctx, { chunks, chunkOrder, claudeExtractCap, callExtract });
  }

  const { chapters, partialFailure } = result;
  writePhase1Checkpoint(ctx, chapters, partialFailure);
  return chapters;
}

module.exports = { runPhase1 };
