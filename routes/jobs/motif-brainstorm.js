'use strict';
// Motiv-Werkstatt: Brainstorm-Job. Die KI liest den Buchtext und schlägt
// wiederkehrende Motive + übergeordnete Themen vor, die noch NICHT katalogisiert
// sind. Rein planend/rückwärtsgewandt — findet Bestehendes im Text, schreibt NIE
// Prosa. Der Autor bestätigt Vorschläge im Frontend (→ POST /motifs[/themes]).

const express = require('express');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  createJob, enqueueJob, findActiveJobId, jsonBody, jobAbortControllers,
  aiCall, getPrompts, getBookPrompts,
  loadOrderedBookContents, loadPageContents,
  groupByChapter, splitGroupsIntoChunks, buildSinglePassBookText,
  chunkLimitsFor, tps, _modelName,
} = require('./shared');
const motifsDb = require('../../db/motifs');
const { getBookSettings } = require('../../db/schema');
const { resolveProvider } = require('../../lib/ai');
const { bookSettingsSigPart, buildBookPagesSig } = require('./komplett/utils');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');
const { requireBookAccess, sendACLError } = require('../../lib/acl');

const VALID_TYP = new Set(['thema', 'motiv']);

// Ein KI-Vorschlag → Katalog-Eintrag normalisieren (Feld-Trim + Typ-Whitelist).
function _normalizeSuggestion(v) {
  return {
    typ: VALID_TYP.has(v.typ) ? v.typ : 'motiv',
    name: v.name.trim().slice(0, 200),
    beschreibung: typeof v.beschreibung === 'string' ? v.beschreibung.trim().slice(0, 2000) : '',
    trigger_terms: Array.isArray(v.trigger_terms)
      ? v.trigger_terms.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim().slice(0, 80)).slice(0, 12)
      : [],
  };
}

async function runMotifBrainstormJob(jobId, bookId, userEmail, { force = false } = {}) {
  const logger = makeJobLogger(jobId);
  const prompts = await getPrompts(userEmail);
  const { buildMotivSystemPrompt, buildMotivBrainstormPrompt, SCHEMA_MOTIV_BRAINSTORM } = prompts;
  try {
    const signal = () => jobAbortControllers.get(jobId)?.signal;
    const provider = resolveProvider({ userEmail });
    // Chunk-Grenzen aus dem Kontextfenster dieses Providers — die boot-eingefrorenen
    // Konstanten rechnen mit ai.claude.context_window und sprengen lokale Fenster.
    const { singlePass: SINGLE_PASS_LIMIT, perChunk: PER_CHUNK_LIMIT } = chunkLimitsFor(provider);

    // Force-Refresh (Neu einlesen): den ganzen Buch-Cache verwerfen, sodass auch
    // unveränderte Kapitel neu gebrainstormt werden (frische kreative Vorschläge).
    if (force) motifsDb.deleteBrainstormCache(bookId, userEmail);

    updateJob(jobId, { statusText: 'job.phase.motivBrainstormCollect', progress: 8 });
    const { chMap, pages } = await loadOrderedBookContents(bookId, null);
    const pageContents = await loadPageContents(pages, chMap, 1, null, null, signal());
    if (!pageContents.some(p => p.text)) throw i18nError('job.error.motivNoText');

    const { BUCH_KONTEXT } = await getBookPrompts(bookId, userEmail);
    // Bereits katalogisierte Namen + fortlaufend die schon vorgeschlagenen — sowohl
    // für die Dedup als auch als „NICHT wiederholen"-Kontext an die KI (chunk-übergreifend).
    const existingThemes = motifsDb.listThemes(bookId, userEmail).map(t => t.name);
    const existingMotifs = motifsDb.listMotifs(bookId, userEmail).map(m => m.name);
    const seen = new Set([...existingThemes, ...existingMotifs].map(n => n.toLowerCase()));

    // Cache-Signatur pro Chunk: Modell + Prompt-Schema-Version. Buchtyp/-Kontext
    // fliessen über bookSettingsSigPart in die pages_sig (wie die Komplettanalyse) —
    // ändert sich einer, invalidiert der Chunk. Provider steckt im Cache-PK.
    // Der Katalog (existingThemes/Motifs) ist BEWUSST NICHT Teil der Signatur:
    // sonst würde jedes übernommene Motiv den ganzen Cache busten (Sinn verfehlt).
    // Er fliesst nur als „NICHT wiederholen"-Kontext in den Prompt; die harte
    // Dedup gegen den aktuellen Katalog passiert ohnehin in consumeRaw().
    const cacheVersion = `${_modelName(provider)}:${prompts.PROMPTS_VERSION || ''}`;
    const bookSettings = getBookSettings(bookId, userEmail);
    const settingsSig = bookSettingsSigPart(bookSettings);

    const systemPrompt = buildMotivSystemPrompt();
    const tok = { in: 0, out: 0, ms: 0 };
    let hits = 0, misses = 0;
    const vorschlaege = [];

    // Rohen Chunk-Output holen: erst Cache (pages_sig-Match), sonst AI-Call und
    // das ROHE Modell-Array cachen (VOR der seen-Dedup). Die Dedup läuft danach
    // jeden Lauf frisch über alle Chunks — so bleibt sie korrekt, egal welche
    // Chunks HIT waren (ein geänderter früher Chunk darf einen gecachten späteren
    // nicht falsch dedupliziert lassen).
    async function chunkRawSuggestions(chunkKey, pagesSig, text, progFrom, progTo) {
      const cached = motifsDb.loadBrainstormCache(bookId, userEmail, chunkKey, pagesSig, provider);
      if (Array.isArray(cached?.vorschlaege)) {
        hits++;
        updateJob(jobId, { progress: progTo });
        return cached.vorschlaege;
      }
      misses++;
      const result = await aiCall(jobId, tok,
        buildMotivBrainstormPrompt(text, [...existingThemes], [...existingMotifs], BUCH_KONTEXT),
        systemPrompt, progFrom, progTo, 3000, 0.3, 2000, undefined, SCHEMA_MOTIV_BRAINSTORM,
      );
      if (!Array.isArray(result?.vorschlaege)) throw i18nError('job.error.motivVorschlaegeMissing');
      motifsDb.saveBrainstormCache(bookId, userEmail, chunkKey, pagesSig, { vorschlaege: result.vorschlaege }, provider);
      return result.vorschlaege;
    }

    // Rohes Chunk-Array in `vorschlaege` einspeisen: normalisieren, gegen `seen`
    // (Katalog + bereits vorgeschlagen) deduplizieren, neue Namen zurückspeisen.
    function consumeRaw(raw) {
      for (const item of raw) {
        if (!item || typeof item.name !== 'string' || !item.name.trim()) continue;
        const v = _normalizeSuggestion(item);
        const key = v.name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        (v.typ === 'thema' ? existingThemes : existingMotifs).push(v.name);
        vorschlaege.push(v);
      }
    }

    // Kurze Bücher: ein Durchlauf. Lange: Kapitel-Chunks (wie die Komplettanalyse),
    // damit auch Motive in späteren Kapiteln erkannt werden statt beim Head-Slice zu entgehen.
    const totalChars = pageContents.reduce((s, p) => s + (p.text ? p.text.length : 0), 0);
    const { groupOrder, groups } = groupByChapter(pageContents);

    if (totalChars <= SINGLE_PASS_LIMIT) {
      logger.info(`Motiv-Brainstorm Single-Pass: book=${bookId} text=${totalChars} Zeichen, Katalog=${seen.size}`);
      updateJob(jobId, { statusText: 'job.phase.motivBrainstorm', progress: 15 });
      const pagesSig = buildBookPagesSig(pageContents, bookSettings, cacheVersion);
      consumeRaw(await chunkRawSuggestions('__singlepass__', pagesSig,
        buildSinglePassBookText(groups, groupOrder), 15, 95));
    } else {
      const { chunkOrder, chunks } = splitGroupsIntoChunks(groups, groupOrder, PER_CHUNK_LIMIT);
      logger.info(`Motiv-Brainstorm Multi-Pass: book=${bookId} text=${totalChars} Zeichen, ${chunkOrder.length} Chunks, Katalog=${seen.size}`);
      for (let i = 0; i < chunkOrder.length; i++) {
        if (signal()?.aborted) break;
        const chunkKey = chunkOrder[i];
        const group = chunks.get(chunkKey);
        const from = 15 + Math.floor((i / chunkOrder.length) * 80);
        const to = 15 + Math.floor(((i + 1) / chunkOrder.length) * 80);
        updateJob(jobId, {
          statusText: 'job.phase.motivBrainstormChunk',
          statusParams: { done: i + 1, total: chunkOrder.length },
          progress: from,
        });
        // pages_sig identisch aufgebaut wie im chapter_extract_cache der Komplett-
        // analyse (page_id:updated_at | settings | ch:<name> | cacheVersion).
        const pagesSig = group.pages.map(p => `${p.id}:${p.updated_at}`).sort().join('|')
          + `||${settingsSig}||ch:${group.name || ''}||${cacheVersion}`;
        consumeRaw(await chunkRawSuggestions(chunkKey, pagesSig,
          buildSinglePassBookText(new Map([[chunkKey, group]]), [chunkKey]), from, to));
      }
    }
    logger.info(`Motiv-Brainstorm Cache: book=${bookId} ${hits} HIT / ${misses} MISS${force ? ' (force)' : ''}`);

    // Lauf historisieren (best-effort — ein DB-Fehler darf das Ergebnis nicht
    // verschlucken). Nur echte Vorschläge persistieren; leere Läufe sind nicht
    // zum Wiederöffnen wert. runId geht in den Job-Payload → das Frontend markiert
    // den frischen Lauf sofort als ausgewählt, ohne Round-Trip.
    let runId = null;
    if (vorschlaege.length) {
      try {
        runId = motifsDb.insertBrainstormRun({
          bookId, userEmail, vorschlagCount: vorschlaege.length,
          result: { vorschlaege }, model: _modelName(provider),
        });
      } catch (e) { logger.warn(`Motiv-Brainstorm-Run-Insert fehlgeschlagen book=${bookId}: ${e.message}`); }
    }

    completeJob(jobId, { vorschlaege, runId, tokensIn: tok.in, tokensOut: tok.out },
      tps(tok), `${vorschlaege.length} Vorschläge`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Motiv-Brainstorm Fehler book=${bookId}: ${e.message}`, { stack: e.cause?.stack || e.stack });
    failJob(jobId, e);
  }
}

const motifBrainstormRouter = express.Router();

motifBrainstormRouter.post('/motif-brainstorm', jsonBody, (req, res) => {
  const book_id = toIntId(req.body?.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: book_id });
  try { requireBookAccess(req, book_id, 'lektor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }
  const userEmail = req.session?.user?.email || null;
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const existing = findActiveJobId('motif-brainstorm', book_id, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const force = req.body?.force === true;
  const jobId = createJob('motif-brainstorm', book_id, userEmail, 'job.label.motivBrainstorm', null, book_id);
  enqueueJob(jobId, () => runMotifBrainstormJob(jobId, book_id, userEmail, { force }));
  res.json({ jobId });
});

module.exports = { motifBrainstormRouter, runMotifBrainstormJob };
