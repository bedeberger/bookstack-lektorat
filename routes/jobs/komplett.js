'use strict';
const express = require('express');
const logger = require('../../logger');
const {
  db,
  saveFigurenToDb, addFigurenBeziehungen, updateFigurenEvents, updateFigurenSoziogramm,
  saveZeitstrahlEvents, saveOrteToDb,
  saveCheckpoint, loadCheckpoint, deleteCheckpoint,
  loadChapterExtractCache, saveChapterExtractCache, deleteChapterExtractCache,
  getAllUserTokens,
} = require('../../db/schema');
const {
  makeJobLogger, updateJob, completeJob, failJob,
  aiCall, getPrompts, getBookPrompts,
  loadPageContents, groupByChapter, buildSinglePassBookText, splitGroupsIntoChunks,
  bsGetAll, SINGLE_PASS_LIMIT, PER_CHUNK_LIMIT, BATCH_SIZE, jobAbortControllers,
  _modelName, fmtTok, tps, settledAll,
  jobs, runningJobs, createJob, enqueueJob, jobKey,
  jsonBody,
} = require('./shared');

const komplettRouter = express.Router();

// ── Hilfsfunktionen ──────────────────────────────────────────────────────────

/** Extrahiert ein Feld aus settledAll-Ergebnissen in das Kapitel-Array-Format. */
function extractField(settled, chunkTexts, field) {
  return settled.map((r, i) => ({
    kapitel: chunkTexts[i].chunk.name,
    [field]: r.status === 'fulfilled' ? (r.value?.[field] || []) : [],
  }));
}

/** Führt eine nicht-kritische Phase aus – Fehler werden geloggt, nicht geworfen. */
async function runNonCritical(label, fn, log, jobId) {
  try {
    return await fn();
  } catch (e) {
    log.warn(`Job ${jobId}: ${label} fehlgeschlagen (ignoriert): ${e.message}`);
    return null;
  }
}

/**
 * Baut Name→ID Lookup-Maps für konsolidierte Figuren.
 * Enthält kanonischen Namen, Kurznamen und Token-Fallback für Phase-1-Namen.
 * Wenn das Modell in Phase 1 einen anderen Namen verwendet als Phase 2
 * (z.B. nur Nachname, Titel+Name), wird per Token-Matching die eindeutig
 * passende Phase-2-Figur gesucht. Nur bei eindeutigem Match.
 */
function buildFigNameLookup(figuren, chapterFiguren, chapterAssignments, log, jobId) {
  const nameToId = {};
  for (const f of figuren) {
    nameToId[f.name] = f.id;
    if (f.kurzname && f.kurzname !== f.name) nameToId[f.kurzname] = f.id;
  }
  const nameToIdLower = Object.fromEntries(
    Object.entries(nameToId).map(([k, v]) => [k.toLowerCase(), v])
  );

  function tryTokenFallback(name) {
    if (!name || nameToId[name] || nameToIdLower[name.toLowerCase()]) return;
    const tokens = new Set(name.toLowerCase().split(/[\s\-\.]+/).filter(t => t.length > 2));
    if (!tokens.size) return;
    const seen = new Set();
    const matches = [];
    for (const [canon, fid] of Object.entries(nameToId)) {
      if (seen.has(fid)) continue;
      const overlap = canon.toLowerCase().split(/[\s\-\.]+/)
        .filter(t => t.length > 2 && tokens.has(t)).length;
      if (overlap > 0) { seen.add(fid); matches.push(fid); }
    }
    if (matches.length === 1) {
      nameToId[name] = matches[0];
      nameToIdLower[name.toLowerCase()] = matches[0];
      log.info(`Job ${jobId}: Phase-1-Name «${name}» → ${matches[0]} (Token-Fallback)`);
    }
  }

  for (const { figuren: chFigs } of (chapterFiguren || []))
    for (const f1 of (chFigs || [])) tryTokenFallback(f1.name);
  for (const { assignments: chAss } of (chapterAssignments || []))
    for (const a of (chAss || [])) tryTokenFallback(a?.figur_name);

  return { figNameToId: nameToId, figNameToIdLower: nameToIdLower };
}

/** Mergt duplizierte Figuren anhand des normalisierten Namens (case-insensitive).
 *  Fängt Fälle ab, in denen kleine Modelle (Ollama/llama) die Dedup-Regel in
 *  Phase 2 nicht befolgen. Verschmilzt Kapitel, Eigenschaften und Beziehungen.
 *  Remappt beziehungen.figur_id auf die kanonische ID und entfernt Selbst-Referenzen. */
function mergeDuplicateFiguren(figuren) {
  const normalize = s => (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
  const groups = new Map();
  for (const f of figuren) {
    const key = normalize(f.name);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }

  const idRemap = {};
  const merged = [];
  for (const group of groups.values()) {
    if (group.length === 1) { merged.push(group[0]); continue; }
    group.sort((a, b) => (b.beschreibung?.length || 0) - (a.beschreibung?.length || 0));
    const canon = { ...group[0] };
    const kapByName = new Map();
    for (const k of (canon.kapitel || [])) kapByName.set(k.name, k.haeufigkeit || 1);
    const eigSet = new Set(canon.eigenschaften || []);
    const bzByFig = new Map();
    for (const b of (canon.beziehungen || [])) bzByFig.set(b.figur_id, b);

    for (const other of group.slice(1)) {
      idRemap[other.id] = canon.id;
      for (const field of ['kurzname', 'typ', 'geburtstag', 'geschlecht', 'beruf', 'sozialschicht']) {
        if (!canon[field] && other[field]) canon[field] = other[field];
      }
      for (const k of (other.kapitel || [])) {
        kapByName.set(k.name, (kapByName.get(k.name) || 0) + (k.haeufigkeit || 1));
      }
      for (const t of (other.eigenschaften || [])) eigSet.add(t);
      for (const b of (other.beziehungen || [])) {
        if (!bzByFig.has(b.figur_id)) bzByFig.set(b.figur_id, b);
      }
    }
    canon.kapitel = [...kapByName.entries()].map(([name, haeufigkeit]) => ({ name, haeufigkeit }));
    canon.eigenschaften = [...eigSet];
    canon.beziehungen = [...bzByFig.values()];
    merged.push(canon);
  }

  const validIds = new Set(merged.map(f => f.id));
  for (const f of merged) {
    const seen = new Map();
    for (const b of (f.beziehungen || [])) {
      const mappedId = idRemap[b.figur_id] || b.figur_id;
      if (mappedId === f.id || !validIds.has(mappedId)) continue;
      if (!seen.has(mappedId)) seen.set(mappedId, { ...b, figur_id: mappedId });
    }
    f.beziehungen = [...seen.values()];
  }

  return { figuren: merged, mergedCount: figuren.length - merged.length };
}

/** Sanity-Check für Beziehungs-Beschreibungen (nur Lokal-KI).
 *  Lokale Modelle verrutschen oft Beschreibungen zwischen Beziehungen (z.B.
 *  «Sebastian ist Roberts Freund» auf der Relation Robert→Herr Koch). Heuristik:
 *  Beschreibung muss den Namen oder Kurznamen der Zielfigur enthalten – sonst
 *  wird nur die Beschreibung geleert (typ + Paar bleiben erhalten).
 *  Gibt die Anzahl entfernter Beschreibungen zurück. */
function validateBeziehungenDescriptions(figuren) {
  const idToNames = Object.fromEntries(
    figuren.map(f => [f.id, [f.name, f.kurzname].filter(Boolean).map(s => s.toLowerCase())])
  );
  let cleared = 0;
  for (const f of figuren) {
    for (const bz of (f.beziehungen || [])) {
      if (!bz.beschreibung) continue;
      const names = idToNames[bz.figur_id] || [];
      if (!names.length) continue;
      const text = bz.beschreibung.toLowerCase();
      if (!names.some(n => text.includes(n))) { bz.beschreibung = null; cleared++; }
    }
  }
  return cleared;
}

/** Mappt Szenen-Klarnamen (aus Phase 1) auf konsolidierte Figuren-/Ort-IDs. */
function remapSzenen(chSzenen, figNameToId, figNameToIdLower, ortNameToId, ortNameToIdLower, chNameToId) {
  const szenen = [];
  for (const { kapitel, szenen: chSz } of (chSzenen || [])) {
    for (const s of (chSz || [])) {
      szenen.push({
        kapitel: (s.kapitel && chNameToId[s.kapitel] != null) ? s.kapitel : kapitel,
        seite: s.seite || null,
        titel: s.titel || '(unbekannt)',
        wertung: s.wertung || null,
        kommentar: s.kommentar || null,
        fig_ids: (s.figuren_namen || []).map(n =>
          figNameToId[n] || figNameToIdLower[n?.toLowerCase()] || null
        ).filter(Boolean),
        ort_ids: (s.orte_namen || []).map(n =>
          ortNameToId[n] || ortNameToIdLower[n?.toLowerCase()] || null
        ).filter(Boolean),
        sort_order: szenen.length,
      });
    }
  }
  return szenen;
}

/** Mappt Assignments auf konsolidierte Figuren-IDs, dedupliziert und sortiert. */
function remapAssignments(chAssignments, figNameToId, figNameToIdLower, chNameToId, log, jobId) {
  const mergedEvtMap = new Map();
  let dropped = 0;

  for (const { kapitel, assignments: chAss } of (chAssignments || [])) {
    for (const assignment of (chAss || [])) {
      const figId = figNameToId[assignment.figur_name]
        || figNameToIdLower[assignment.figur_name?.toLowerCase()] || null;
      if (!figId) {
        dropped++;
        log.warn(`Job ${jobId}: Assignment «${assignment.figur_name}» (${assignment.lebensereignisse?.length || 0} Ereignisse) – keine Figuren-ID.`);
        continue;
      }
      if (!mergedEvtMap.has(figId)) mergedEvtMap.set(figId, []);
      for (const ev of (assignment.lebensereignisse || [])) {
        mergedEvtMap.get(figId).push({
          ...ev,
          kapitel: (ev.kapitel && chNameToId[ev.kapitel] != null) ? ev.kapitel : kapitel,
        });
      }
    }
  }
  if (dropped > 0) log.warn(`Job ${jobId}: ${dropped} Assignments ohne Figuren-ID ignoriert.`);

  const allAssignments = [];
  for (const [fig_id, events] of mergedEvtMap) {
    const seen = new Set();
    const deduped = [];
    for (const ev of events) {
      const key = (ev.datum || '') + '||' + (ev.ereignis || '').trim().toLowerCase();
      if (!seen.has(key)) { seen.add(key); deduped.push(ev); }
    }
    deduped.sort((a, b) => (parseInt(a.datum) || 0) - (parseInt(b.datum) || 0));
    allAssignments.push({ fig_id, lebensereignisse: deduped });
  }
  return allAssignments;
}

/** Speichert Szenen und Figuren-Events in die DB. Gibt { szenenCount, eventsCount } zurück. */
function saveSzenenAndEvents(bookIdInt, email, szenen, assignments, locIdToDbId, idMaps, log, jobId) {
  db.transaction(() => {
    db.prepare('DELETE FROM figure_scenes WHERE book_id = ? AND user_email = ?').run(bookIdInt, email);
    const now = new Date().toISOString();
    const ins = db.prepare(`INSERT INTO figure_scenes
      (book_id, user_email, kapitel, seite, titel, wertung, kommentar, chapter_id, page_id, sort_order, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insSf = db.prepare('INSERT INTO scene_figures (scene_id, fig_id) VALUES (?, ?)');
    const insSl = db.prepare('INSERT OR IGNORE INTO scene_locations (scene_id, location_id) VALUES (?, ?)');
    for (const s of szenen) {
      const { lastInsertRowid: sceneId } = ins.run(
        bookIdInt, email,
        s.kapitel, s.seite, s.titel, s.wertung, s.kommentar,
        idMaps.chNameToId[s.kapitel] ?? null,
        s.seite ? (idMaps.pageNameToId[s.seite] ?? null) : null,
        s.sort_order, now,
      );
      for (const fid of s.fig_ids) insSf.run(sceneId, fid);
      for (const locIdStr of s.ort_ids) {
        const dbLocId = locIdToDbId[locIdStr];
        if (dbLocId) insSl.run(sceneId, dbLocId);
      }
    }
  })();

  const eventsCount = assignments.reduce((s, a) => s + (a.lebensereignisse?.length || 0), 0);
  if (eventsCount > 0) {
    saveZeitstrahlEvents(bookIdInt, email, []);
    updateFigurenEvents(bookIdInt, assignments, email, idMaps);
  }
  log.info(`Job ${jobId}: ${szenen.length} Szenen, ${eventsCount} Ereignisse gespeichert.`);
  return { szenenCount: szenen.length, eventsCount };
}

/** Speichert Kontinuitätsprüfung in die DB. Gibt normalizedProbleme zurück, oder null bei ungültiger Antwort. */
function saveKontinuitaetResult(bookIdInt, email, kontResult, figNameToId, chNameToId, effectiveProvider, log, jobId) {
  if (typeof kontResult?.zusammenfassung === 'undefined') return null;
  const normalizedProbleme = (kontResult.probleme || []).map(issue => ({
    ...issue,
    fig_ids: (issue.figuren || []).map(n => figNameToId[n]).filter(Boolean),
    chapter_ids: (issue.kapitel || []).map(n => chNameToId[n]).filter(Boolean),
  }));
  db.prepare(`INSERT INTO continuity_checks (book_id, user_email, checked_at, issues_json, summary, model)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(bookIdInt, email, new Date().toISOString(),
      JSON.stringify(normalizedProbleme), kontResult.zusammenfassung || '', _modelName(effectiveProvider));
  log.info(`Job ${jobId}: Kontinuitätsprüfung gespeichert (${normalizedProbleme.length} Probleme).`);
  return normalizedProbleme;
}

/** Invalidiert Delta-Cache-Einträge für umbenannte Kapitel. */
function invalidateRenamedChapterCaches(bookIdInt, chaptersData, log, jobId) {
  const stored = db.prepare('SELECT chapter_id, chapter_name FROM chapters WHERE book_id = ?').all(bookIdInt);
  const storedChMap = Object.fromEntries(stored.map(r => [r.chapter_id, r.chapter_name]));
  const delCacheByKey = db.prepare('DELETE FROM chapter_extract_cache WHERE book_id = ? AND chapter_key = ?');
  for (const c of chaptersData) {
    if (storedChMap[c.id] !== undefined && storedChMap[c.id] !== c.name) {
      log.info(`Job ${jobId}: Kapitel ${c.id} umbenannt («${storedChMap[c.id]}» → «${c.name}») – Cache invalidiert.`);
      delCacheByKey.run(bookIdInt, String(c.id));
    }
  }
}

/** Lädt und validiert einen Komplett-Analyse-Checkpoint. Gibt null zurück wenn ungültig. */
function loadAndValidateCheckpoint(bookIdInt, email, log, jobId) {
  let cp = loadCheckpoint('komplett-analyse', bookIdInt, email);
  if (!cp) return null;
  log.info(`Job ${jobId}: Checkpoint gefunden (Phase: ${cp.phase}).`);
  if (cp.phase !== 'p1_full_done') {
    log.info(`Job ${jobId}: Checkpoint Phase «${cp.phase}» ignoriert (altes Format) – Neustart.`);
    deleteCheckpoint('komplett-analyse', bookIdInt, email);
    return null;
  }
  const hasFiguren = Array.isArray(cp.chapterFiguren) && cp.chapterFiguren.length > 0
    && cp.chapterFiguren.some(c => Array.isArray(c.figuren) && c.figuren.length > 0);
  if (!hasFiguren) {
    log.warn(`Job ${jobId}: Checkpoint ohne Figuren-Daten – Neustart.`);
    deleteCheckpoint('komplett-analyse', bookIdInt, email);
    return null;
  }
  return cp;
}

/** Stellt Phase-1-Ergebnisse aus einem validen Checkpoint wieder her. */
function restorePhase1FromCheckpoint(cp, tok, log, jobId) {
  const { chapterFiguren, chapterOrte, chapterFakten, chapterSzenen, chapterAssignments } = cp;
  if (cp.tokIn != null) { tok.in = cp.tokIn; tok.out = cp.tokOut || 0; tok.ms = cp.tokMs || 0; }
  const figTotal = (chapterFiguren || []).reduce((s, c) => s + (c.figuren?.length || 0), 0);
  const orteTotal = (chapterOrte || []).reduce((s, c) => s + (c.orte?.length || 0), 0);
  const szTotal = (chapterSzenen || []).reduce((s, c) => s + (c.szenen?.length || 0), 0);
  log.info(`Job ${jobId}: Phase 1 aus Checkpoint – ${chapterFiguren.length} Kapitel, fig=${figTotal} orte=${orteTotal} sz=${szTotal} (${fmtTok(tok.in)}↑ ${fmtTok(tok.out)}↓)`);
  updateJob(jobId, { progress: 28, statusText: 'Phase 1 aus Checkpoint geladen…', tokensIn: tok.in, tokensOut: tok.out });
  return { chapterFiguren, chapterOrte, chapterFakten, chapterSzenen, chapterAssignments };
}

// ── Phase-Funktionen ─────────────────────────────────────────────────────────

/**
 * Phase 1: Vollextraktion (Figuren+Orte+Fakten+Szenen+Events).
 * Single-Pass für kleine Bücher, Multi-Pass mit Delta-Cache für grosse.
 * Schema und Regeln im System-Prompt (SYSTEM_KOMPLETT_EXTRAKTION) → gecacht über alle Kapitel.
 * Szenen/Assignments verwenden Klarnamen statt IDs; Remapping nach P2/P3-Konsolidierung.
 */
async function runPhase1(ctx) {
  const { jobId, bookIdInt, bookName, email, call, tok, log,
    effectiveProvider, singlePassLimit,
    prompts, sys, pageContents, groups, groupOrder, totalChars, fullBookText } = ctx;

  const perChunkLimit = effectiveProvider === 'claude' ? singlePassLimit : PER_CHUNK_LIMIT;
  const { chunkOrder, chunks } = splitGroupsIntoChunks(groups, groupOrder, perChunkLimit);

  log.info(`Job ${jobId}: Phase 1 – ${totalChars} Zeichen, ${effectiveProvider} → ${totalChars <= singlePassLimit ? 'Single-Pass' : `Multi-Pass (${groupOrder.length} Kapitel → ${chunkOrder.length} Chunks)`}`);

  let chapterFiguren, chapterOrte, chapterFakten, chapterSzenen, chapterAssignments;

  if (totalChars <= singlePassLimit) {
    // ── Single-Pass ──
    updateJob(jobId, { progress: 12, statusText: 'KI extrahiert Figuren, Schauplätze, Fakten, Szenen…' });
    const r = await call(jobId, tok,
      prompts.buildExtraktionKomplettChapterPrompt('Gesamtbuch', bookName, pageContents.length, fullBookText),
      sys.SYSTEM_KOMPLETT_EXTRAKTION, 12, 28, 16000, 0.2, null, prompts.SCHEMA_KOMPLETT_EXTRAKTION,
    );
    chapterFiguren     = [{ kapitel: 'Gesamtbuch', figuren:     r?.figuren     || [] }];
    chapterOrte        = [{ kapitel: 'Gesamtbuch', orte:        r?.orte        || [] }];
    chapterFakten      = [{ kapitel: 'Gesamtbuch', fakten:      r?.fakten      || [] }];
    chapterSzenen      = [{ kapitel: 'Gesamtbuch', szenen:      r?.szenen      || [] }];
    chapterAssignments = [{ kapitel: 'Gesamtbuch', assignments: r?.assignments || [] }];
    const totalEvents = (r?.assignments || []).reduce((s, a) => s + (a.lebensereignisse?.length || 0), 0);
    log.info(`Job ${jobId}: Single-Pass OK – fig=${chapterFiguren[0].figuren.length} orte=${chapterOrte[0].orte.length} sz=${chapterSzenen[0].szenen.length} (${totalEvents} Ereignisse)`);
  } else {
    // ── Multi-Pass mit Delta-Cache ──
    // Für lokale Modelle: Kapitel die PER_CHUNK_LIMIT überschreiten, werden in Seiten-Untergruppen
    // aufgeteilt. Jeder Chunk bekommt einen eigenen KI-Call mit eigenem Delta-Cache-Eintrag.
    // Claude nutzt singlePassLimit (250K) als Chunk-Grenze → kein Splitting in der Praxis.
    updateJob(jobId, { progress: 12, statusText: `Vollextraktion in ${chunkOrder.length} Chunks…` });
    const chunkTexts = chunkOrder.map(chunkKey => {
      const chunk = chunks.get(chunkKey);
      return {
        chunk, key: chunkKey,
        pagesSig: chunk.pages.map(p => `${p.id}:${p.updated_at}`).sort().join('|'),
        chText: chunk.pages.map(p => `### ${p.title}\n${p.text}`).join('\n\n---\n\n'),
      };
    });
    let cacheHits = 0;
    const settled = await settledAll(
      chunkTexts.map(({ chunk, key, pagesSig, chText }, chunkIdx) => async () => {
        const chunkLabel = `Chunk ${chunkIdx + 1}/${chunkTexts.length} «${chunk.name}»`;
        log.info(`Job ${jobId}: ${chunkLabel} – ${chunk.pages.length} Seiten`);
        const cached = loadChapterExtractCache(bookIdInt, email, key, pagesSig);
        if (cached) {
          cacheHits++;
          log.info(`Job ${jobId}: ${chunkLabel} – Cache-HIT.`);
          return cached;
        }
        log.info(`Job ${jobId}: ${chunkLabel} – Cache-MISS, KI-Call…`);
        const result = await call(jobId, tok,
          prompts.buildExtraktionKomplettChapterPrompt(chunk.name, bookName, chunk.pages.length, chText),
          sys.SYSTEM_KOMPLETT_EXTRAKTION, 12, 28, 14000, 0.2, null, prompts.SCHEMA_KOMPLETT_EXTRAKTION,
        );
        saveChapterExtractCache(bookIdInt, email, key, pagesSig, result);
        log.info(`Job ${jobId}: ${chunkLabel} – OK (fig=${result?.figuren?.length ?? 0} orte=${result?.orte?.length ?? 0} sz=${result?.szenen?.length ?? 0}).`);
        return result;
      })
    );

    // Fehlgeschlagene Chunks loggen (einmal pro Chunk, nicht pro Feld)
    for (let i = 0; i < settled.length; i++) {
      if (settled[i].status === 'rejected')
        log.warn(`Job ${jobId}: Vollextraktion «${chunkTexts[i].chunk.name}» übersprungen: ${settled[i].reason?.message}`);
    }
    chapterFiguren     = extractField(settled, chunkTexts, 'figuren');
    chapterOrte        = extractField(settled, chunkTexts, 'orte');
    chapterFakten      = extractField(settled, chunkTexts, 'fakten');
    chapterSzenen      = extractField(settled, chunkTexts, 'szenen');
    chapterAssignments = extractField(settled, chunkTexts, 'assignments');

    const failedChunks = settled.filter(r => r.status === 'rejected');
    log.info(`Job ${jobId}: Phase 1 Multi-Pass – ${settled.length - failedChunks.length}/${settled.length} OK (${cacheHits} Cache-Hits), fig=${chapterFiguren.reduce((s, c) => s + c.figuren.length, 0)} orte=${chapterOrte.reduce((s, c) => s + c.orte.length, 0)} sz=${chapterSzenen.reduce((s, c) => s + c.szenen.length, 0)}`);
    if (failedChunks.length > 0) {
      // Chunk fehlgeschlagen → kein Checkpoint speichern; Delta-Cache schützt erfolgreiche Chunks.
      // Beim Retry versucht Phase 1 die fehlgeschlagenen Chunks erneut.
      const failedDetails = chunkTexts
        .map((ct, i) => ({ ct, r: settled[i] }))
        .filter(({ r }) => r.status === 'rejected')
        .map(({ ct, r }) => `${ct.chunk.name}: ${r.reason?.message || 'unbekannt'}`);
      throw new Error(`Phase 1 unvollständig: ${failedChunks.length} Chunks fehlgeschlagen (${failedDetails.join('; ')})`);
    }
  }

  saveCheckpoint('komplett-analyse', bookIdInt, email, {
    phase: 'p1_full_done',
    chapterFiguren, chapterOrte, chapterFakten, chapterSzenen, chapterAssignments,
    tokIn: tok.in, tokOut: tok.out, tokMs: tok.ms,
  });
  return { chapterFiguren, chapterOrte, chapterFakten, chapterSzenen, chapterAssignments };
}

/** Phase 2: Figuren konsolidieren + Soziogramm + Name→ID Lookup. */
async function runPhase2(ctx, chapterFiguren, chapterAssignments) {
  const { jobId, bookIdInt, bookName, email, call, tok, log, prompts, sys, idMaps, effectiveProvider } = ctx;

  updateJob(jobId, { progress: 30, statusText: 'KI konsolidiert Figuren…' });
  const figResult = await call(jobId, tok,
    prompts.buildFiguresBasisConsolidationPrompt(bookName, chapterFiguren, sys.BUCH_KONTEXT || ''),
    sys.SYSTEM_FIGUREN, 30, 43, 8000, 0.2, null, prompts.SCHEMA_FIGUREN_KONSOL,
  );
  if (!Array.isArray(figResult?.figuren)) throw new Error('Figuren-Konsolidierung ungültig: figuren-Array fehlt');
  let figuren = figResult.figuren.map((f, i) => ({ ...f, id: f.id || ('fig_' + (i + 1)) }));
  const { figuren: mergedFiguren, mergedCount } = mergeDuplicateFiguren(figuren);
  if (mergedCount > 0) log.info(`Job ${jobId}: ${mergedCount} Figuren-Duplikate nach Namen zusammengeführt.`);
  figuren = mergedFiguren;
  if (effectiveProvider && effectiveProvider !== 'claude') {
    const cleaned = validateBeziehungenDescriptions(figuren);
    if (cleaned > 0) log.info(`Job ${jobId}: ${cleaned} Beziehungs-Beschreibungen entfernt (Lokal-KI: Zielfigur nicht erwähnt).`);
  }
  saveFigurenToDb(bookIdInt, figuren, email, idMaps);
  log.info(`Job ${jobId}: ${figuren.length} Figuren gespeichert.`);

  // Soziogramm aus P2-Ergebnis (kein separater API-Call)
  if (figuren.length >= 4) {
    const sozFiguren = figuren.map(f => ({ fig_id: f.id, sozialschicht: f.sozialschicht || 'andere' }));
    const sozBeziehungen = figuren.flatMap(f =>
      (f.beziehungen || [])
        .filter(bz => bz.machtverhaltnis && bz.figur_id)
        .map(bz => ({ from_fig_id: f.id, to_fig_id: bz.figur_id, machtverhaltnis: bz.machtverhaltnis }))
    );
    updateFigurenSoziogramm(bookIdInt, sozFiguren, sozBeziehungen, email);
    log.info(`Job ${jobId}: Soziogramm: ${sozFiguren.length} Figuren, ${sozBeziehungen.length} Machtbeziehungen.`);
  }

  const figurenKompakt = figuren.map(f => ({ id: f.id, name: f.name, typ: f.typ || 'andere' }));
  const { figNameToId, figNameToIdLower } = buildFigNameLookup(figuren, chapterFiguren, chapterAssignments, log, jobId);

  return { figuren, figNameToId, figNameToIdLower, figurenKompakt };
}

/** Phase 3: Orte konsolidieren + Name→ID Lookup. */
async function runPhase3(ctx, chapterOrte, figurenKompakt) {
  const { jobId, bookIdInt, bookName, email, call, tok, log, prompts, sys, idMaps } = ctx;

  updateJob(jobId, { progress: 43, statusText: 'Schauplätze konsolidieren…' });
  const orteResultRaw = await call(jobId, tok,
    prompts.buildLocationsConsolidationPrompt(bookName, chapterOrte, figurenKompakt),
    sys.SYSTEM_ORTE, 43, 55, 6000, 0.2, null, prompts.SCHEMA_ORTE_KONSOL,
  );
  if (!Array.isArray(orteResultRaw?.orte)) throw new Error('Orte-Konsolidierung ungültig: orte-Array fehlt');
  const orte = orteResultRaw.orte.map((o, i) => ({ ...o, id: o.id || ('ort_' + (i + 1)) }));
  saveOrteToDb(bookIdInt, orte, email, idMaps.chNameToId);
  log.info(`Job ${jobId}: ${orte.length} Schauplätze gespeichert.`);

  const ortNameToId = {}, ortNameToIdLower = {};
  for (const o of orte) {
    ortNameToId[o.name] = o.id;
    ortNameToIdLower[o.name.toLowerCase()] = o.id;
  }
  return { orte, ortNameToId, ortNameToIdLower };
}

/**
 * Phase 3b: Kapitelübergreifende Beziehungen (nur Multi-Pass).
 * Single-Pass: Phase 1 hat den vollständigen Text gesehen → Beziehungen bereits erfasst.
 * Multi-Pass: Kapitel wurden isoliert analysiert → Beziehungen zwischen Figuren
 * verschiedener Kapitel hier nachträglich identifiziert.
 */
async function runPhase3b(ctx, figuren) {
  const { jobId, bookIdInt, email, call, tok, log, prompts, sys, singlePassLimit, bookName, fullBookText } = ctx;

  updateJob(jobId, { progress: 55, statusText: 'Kapitelübergreifende Beziehungen suchen…' });
  const textForPrompt = fullBookText.length <= singlePassLimit
    ? fullBookText
    : fullBookText.slice(0, singlePassLimit);
  const bzResult = await call(jobId, tok,
    prompts.buildKapiteluebergreifendeBeziehungenPrompt(bookName, figuren, textForPrompt),
    sys.SYSTEM_FIGUREN, 55, 58, 2000, 0.2, null, prompts.SCHEMA_BEZIEHUNGEN,
  );
  const newBz = Array.isArray(bzResult?.beziehungen) ? bzResult.beziehungen : [];
  if (newBz.length > 0) addFigurenBeziehungen(bookIdInt, newBz, email);
  log.info(`Job ${jobId}: Phase 3b – ${newBz.length} kapitelübergreifende Beziehungen.`);
}

/** P6: Zeitstrahl aus gespeicherten Events konsolidieren. */
async function runZeitstrahl(ctx) {
  const { jobId, bookIdInt, email, call, tok, log, prompts, sys, idMaps } = ctx;

  updateJob(jobId, { progress: 83, statusText: 'Zeitstrahl konsolidieren…' });
  const rawEvtRows = db.prepare(`
    SELECT f.fig_id, f.name AS fig_name, f.typ AS fig_typ,
           fe.datum, fe.ereignis, fe.typ AS evt_typ, fe.bedeutung, fe.kapitel, fe.seite
    FROM figure_events fe
    JOIN figures f ON f.id = fe.figure_id
    WHERE f.book_id = ? AND f.user_email IS ?
    ORDER BY fe.datum, f.sort_order
  `).all(bookIdInt, email);
  if (!rawEvtRows.length) return;

  const evtGroupMap = new Map();
  for (const row of rawEvtRows) {
    const key = `${row.datum}||${(row.ereignis || '').trim().toLowerCase()}`;
    if (!evtGroupMap.has(key)) {
      evtGroupMap.set(key, {
        datum: row.datum, ereignis: row.ereignis, typ: row.evt_typ,
        bedeutung: row.bedeutung || '',
        kapitel: row.kapitel ? [row.kapitel] : [],
        seiten:  row.seite   ? [row.seite]   : [],
        figuren: [],
      });
    }
    const ev = evtGroupMap.get(key);
    if (!ev.figuren.some(f => f.id === row.fig_id))
      ev.figuren.push({ id: row.fig_id, name: row.fig_name, typ: row.fig_typ || 'andere' });
    if (row.kapitel && !ev.kapitel.includes(row.kapitel)) ev.kapitel.push(row.kapitel);
    if (row.seite   && !ev.seiten.includes(row.seite))   ev.seiten.push(row.seite);
  }

  const zeitstrahlEvents = [...evtGroupMap.values()].sort((a, b) => parseInt(a.datum) - parseInt(b.datum));
  const ztResult = await call(jobId, tok,
    prompts.buildZeitstrahlConsolidationPrompt(zeitstrahlEvents),
    sys.SYSTEM_ZEITSTRAHL, 83, 89, 3000, 0.2, null, prompts.SCHEMA_ZEITSTRAHL,
  );
  if (Array.isArray(ztResult?.ereignisse)) {
    saveZeitstrahlEvents(bookIdInt, email, ztResult.ereignisse, idMaps.chNameToId);
    log.info(`Job ${jobId}: ${ztResult.ereignisse.length} Zeitstrahl-Ereignisse gespeichert.`);
  }
  // Sicherstellen dass Zeitstrahl-Threshold (89) zuverlässig erreicht wird
  updateJob(jobId, { progress: 89 });
}

// ── Job: Komplettanalyse ─────────────────────────────────────────────────────
// Pipeline (token-optimiert):
//   P1 (Vollextraktion: Figuren+Orte+Fakten+Szenen+Events, parallel/Kapitel, SYSTEM_KOMPLETT_EXTRAKTION)
//      → Schema im System-Prompt gecacht; Szenen/Events mit Klarnamen (kein ID-Lookup nötig)
//   P2 (Figuren konsolidieren + Soziogramm) → figNameToId aufbauen
//   P3 (Orte konsolidieren) → ortNameToId aufbauen
//   P3b (Kapitelübergreifende Beziehungen, nur Multi-Pass, non-critical)
//   Block 2 [parallel]: P5 Szenen remappen + P6 Zeitstrahl | P8 Kontinuität
async function runKomplettAnalyseJob(jobId, bookId, bookName, userEmail, userToken, provider = undefined) {
  const bookIdInt = parseInt(bookId);
  const email = userEmail || null;
  const log = makeJobLogger(jobId);
  // call akzeptiert optional ein JSON-Schema als letztes Argument (11. Position in aiCall).
  // Schemas werden nur von lokalen Providern (ollama/llama) verwendet – Claude ignoriert sie.
  const call = (jobId_, tok_, prompt_, system_, fromPct, toPct, expectedChars, outputRatio, maxTokens, schema) =>
    aiCall(jobId_, tok_, prompt_, system_, fromPct, toPct, expectedChars, outputRatio, maxTokens, provider, schema);
  const effectiveProvider = provider || process.env.API_PROVIDER || 'claude';
  // Claude hat 200K Token Kontextfenster (~600K deutsche Zeichen) – Single-Pass für fast alle Bücher.
  // ollama / llama: bewusst 60K Limit → Multi-Pass mit Delta-Cache.
  const singlePassLimit = effectiveProvider === 'claude' ? 250_000 : SINGLE_PASS_LIMIT;
  const prompts = await getPrompts();
  const sys = await getBookPrompts(bookId);
  const tok = { in: 0, out: 0, ms: 0, inflight: new Map() };

  try {
    const cp = loadAndValidateCheckpoint(bookIdInt, email, log, jobId);

    // ── Seiten laden ──────────────────────────────────────────────────────────
    updateJob(jobId, { statusText: 'Lade Seiten…', progress: 0 });
    const [chaptersData, pages] = await Promise.all([
      bsGetAll('chapters?book_id=' + bookId, userToken),
      bsGetAll('pages?book_id=' + bookId, userToken),
    ]);
    if (!pages.length) { completeJob(jobId, { empty: true }); return; }

    const chMap = Object.fromEntries(chaptersData.map(c => [c.id, c.name]));
    const pageContents = await loadPageContents(pages, chMap, 30, (i, total) => {
      updateJob(jobId, {
        progress: Math.round((i / total) * 12),
        statusText: `Lese ${i + 1}–${Math.min(i + BATCH_SIZE, total)} von ${total} Seiten…`,
      });
    }, userToken, jobAbortControllers.get(jobId)?.signal);

    const idMaps = {
      chNameToId:   Object.fromEntries(chaptersData.map(c => [c.name, c.id])),
      pageNameToId: Object.fromEntries(pages.map(p => [p.name, p.id])),
    };
    invalidateRenamedChapterCaches(bookIdInt, chaptersData, log, jobId);

    const totalChars = pageContents.reduce((s, p) => s + p.text.length, 0);
    const { groupOrder, groups } = groupByChapter(pageContents);
    // Einmal bauen, wiederverwenden (Phase 1 Single-Pass, Phase 3b, P8 Kontinuität)
    const fullBookText = buildSinglePassBookText(groups, groupOrder);

    const ctx = {
      jobId, bookIdInt, bookName, email, call, tok, log,
      effectiveProvider, singlePassLimit, prompts, sys,
      idMaps, pageContents, groups, groupOrder, totalChars, fullBookText,
    };

    // ── Phase 1: Vollextraktion ───────────────────────────────────────────────
    const p1 = cp?.phase === 'p1_full_done'
      ? restorePhase1FromCheckpoint(cp, tok, log, jobId)
      : await runPhase1(ctx);
    const { chapterFiguren, chapterOrte, chapterFakten, chapterSzenen, chapterAssignments } = p1;

    // ── Phase 2: Figuren konsolidieren ────────────────────────────────────────
    const { figuren, figNameToId, figNameToIdLower, figurenKompakt } =
      await runPhase2(ctx, chapterFiguren, chapterAssignments);

    // ── Phase 3: Orte konsolidieren ───────────────────────────────────────────
    const { orte, ortNameToId, ortNameToIdLower } =
      await runPhase3(ctx, chapterOrte, figurenKompakt);

    // ── Phase 3b: Kapitelübergreifende Beziehungen (non-critical, nur Multi-Pass) ──
    if (chapterFiguren.length > 1 && figuren.length >= 2) {
      await runNonCritical('Phase 3b kapitelübergreifende Beziehungen',
        () => runPhase3b(ctx, figuren), log, jobId);
    }

    // ── Block 2: Szenen/Zeitstrahl + Kontinuität parallel ─────────────────────
    updateJob(jobId, { progress: 58, statusText: 'Szenen verarbeiten und Kontinuität prüfen…' });

    const [szenenResult] = await Promise.all([

      // P5+P6: Szenen aus P1 remappen + Zeitstrahl konsolidieren
      (async () => {
        updateJob(jobId, { progress: 63, statusText: 'Szenen aus Extraktion verarbeiten…' });
        const locRows = db.prepare(
          'SELECT id, loc_id FROM locations WHERE book_id = ? AND user_email = ? ORDER BY sort_order'
        ).all(bookIdInt, email);
        const locIdToDbId = Object.fromEntries(locRows.map(r => [r.loc_id, r.id]));

        const szenen = remapSzenen(chapterSzenen, figNameToId, figNameToIdLower, ortNameToId, ortNameToIdLower, idMaps.chNameToId);
        const assignments = remapAssignments(chapterAssignments, figNameToId, figNameToIdLower, idMaps.chNameToId, log, jobId);
        updateJob(jobId, { progress: 81, statusText: 'Szenen speichern…' });
        const result = saveSzenenAndEvents(bookIdInt, email, szenen, assignments, locIdToDbId, idMaps, log, jobId);
        await runZeitstrahl(ctx);
        return result;
      })(),

      // P8: Kontinuitätsprüfung
      // P8 läuft parallel zu P5+P6. Segment 89→97: übernimmt die Bar nahtlos nach P6 (Zeitstrahl endet bei 89).
      // Claude: Single-Pass für kleine Bücher (voller Buchtext).
      // Llama/Ollama: immer facts-basiert – voller Buchtext wäre ein zweiter langer KI-Call.
      (async () => {
        const figKompakt = figuren.map(f => ({ name: f.name, typ: f.typ || 'andere', beschreibung: f.beschreibung || '' }));
        const ortRows = db.prepare(
          'SELECT name, typ, beschreibung FROM locations WHERE book_id = ? AND user_email = ? ORDER BY sort_order'
        ).all(bookIdInt, email);
        const orteKompakt = ortRows.map(o => ({ name: o.name, typ: o.typ, beschreibung: o.beschreibung || '' }));

        let kontResult;
        if (totalChars <= singlePassLimit && effectiveProvider === 'claude') {
          log.info(`Job ${jobId}: Kontinuität Single-Pass: ${fullBookText.length} Zeichen, ${figKompakt.length} Figuren, ${orteKompakt.length} Orte`);
          kontResult = await call(jobId, tok,
            prompts.buildKontinuitaetSinglePassPrompt(bookName, fullBookText, figKompakt, orteKompakt),
            sys.SYSTEM_KONTINUITAET, 89, 97, 5000, 0.2, null, prompts.SCHEMA_KONTINUITAET_PROBLEME,
          );
        } else {
          log.info(`Job ${jobId}: Kontinuität facts-basiert: ${chapterFakten.length} Kapitel, ${figKompakt.length} Figuren`);
          kontResult = await call(jobId, tok,
            prompts.buildKontinuitaetCheckPrompt(bookName, chapterFakten, figKompakt, orteKompakt),
            sys.SYSTEM_KONTINUITAET, 89, 97, effectiveProvider === 'claude' ? 5000 : 2500, 0.2, null, prompts.SCHEMA_KONTINUITAET_PROBLEME,
          );
        }
        saveKontinuitaetResult(bookIdInt, email, kontResult, figNameToId, idMaps.chNameToId, effectiveProvider, log, jobId);
      })(),

    ]); // Ende Block 2

    deleteCheckpoint('komplett-analyse', bookIdInt, email);
    completeJob(jobId, {
      figCount:    figuren.length,
      orteCount:   orte.length,
      szenenCount: szenenResult.szenenCount,
      tokensIn: tok.in, tokensOut: tok.out,
    }, tps(tok));
    log.info(`Job ${jobId}: Komplettanalyse Buch ${bookIdInt} abgeschlossen (${fmtTok(tok.in)}↑ ${fmtTok(tok.out)}↓).`);
  } catch (e) {
    if (e.name !== 'AbortError') {
      const cause = e.cause?.message || e.cause?.code || '';
      log.error(`Job ${jobId}: Komplettanalyse Fehler: ${e.message}${cause ? ' (cause: ' + cause + ')' : ''}`);
    }
    failJob(jobId, e);
  }
}

// ── Job: Kontinuitätsprüfung (eigenständig) ──────────────────────────────────
async function runKontinuitaetJob(jobId, bookId, bookName, userEmail, userToken, provider = undefined) {
  const bookIdInt = parseInt(bookId);
  const email = userEmail || null;
  const log = makeJobLogger(jobId);
  const call = (jobId_, tok_, prompt_, system_, fromPct, toPct, expectedChars, outputRatio, maxTokens, schema) =>
    aiCall(jobId_, tok_, prompt_, system_, fromPct, toPct, expectedChars, outputRatio, maxTokens, provider, schema);
  const effectiveProvider = provider || process.env.API_PROVIDER || 'claude';
  const singlePassLimit = effectiveProvider === 'claude' ? 250_000 : SINGLE_PASS_LIMIT;
  const prompts = await getPrompts();
  const sys = await getBookPrompts(bookId);

  try {
    const cp = loadCheckpoint('kontinuitaet', bookIdInt, email);
    if (cp) log.info(`Job ${jobId}: Checkpoint gefunden (${cp.nextGi} Kapitel fertig).`);

    updateJob(jobId, { statusText: 'Lade Seiten…', progress: 0 });
    const [chaptersData, pages] = await Promise.all([
      bsGetAll('chapters?book_id=' + bookId, userToken),
      bsGetAll('pages?book_id=' + bookId, userToken),
    ]);
    if (!pages.length) { completeJob(jobId, { empty: true }); return; }

    const chMap = Object.fromEntries(chaptersData.map(c => [c.id, c.name]));
    const chNameToId = Object.fromEntries(chaptersData.map(c => [c.name, c.id]));
    const tok = { in: 0, out: 0, ms: 0 };

    // Bekannte Figuren + Orte aus DB laden
    const figRows = db.prepare(`
      SELECT f.fig_id, f.name, f.typ, f.beschreibung FROM figures f
      WHERE f.book_id = ? AND f.user_email = ? ORDER BY f.sort_order
    `).all(bookIdInt, email);
    const figurenKompakt = figRows.map(f => ({ name: f.name, typ: f.typ || 'andere', beschreibung: f.beschreibung || '' }));
    const figNameToId = Object.fromEntries(figRows.map(r => [r.name, r.fig_id]));

    const ortRows = db.prepare(
      'SELECT name, typ, beschreibung FROM locations WHERE book_id = ? AND user_email = ? ORDER BY sort_order'
    ).all(bookIdInt, email);
    const orteKompakt = ortRows.map(o => ({ name: o.name, typ: o.typ, beschreibung: o.beschreibung || '' }));

    const pageContents = await loadPageContents(pages, chMap, 30, (i, total) => {
      updateJob(jobId, {
        progress: Math.round((i / total) * 50),
        statusText: `Lese ${i + 1}–${Math.min(i + BATCH_SIZE, total)} von ${total} Seiten…`,
      });
    }, userToken, jobAbortControllers.get(jobId)?.signal);

    const totalChars = pageContents.reduce((s, p) => s + p.text.length, 0);
    const { groupOrder, groups } = groupByChapter(pageContents);
    let result;

    if (totalChars <= singlePassLimit) {
      updateJob(jobId, { progress: 60, statusText: 'KI prüft Kontinuität…' });
      const bookText = buildSinglePassBookText(groups, groupOrder);
      result = await call(jobId, tok,
        prompts.buildKontinuitaetSinglePassPrompt(bookName, bookText, figurenKompakt, orteKompakt),
        sys.SYSTEM_KONTINUITAET, 60, 97, 5000, 0.2, null, prompts.SCHEMA_KONTINUITAET_PROBLEME,
      );
    } else {
      // Multi-Pass: Fakten pro Kapitel extrahieren – ggf. aus Checkpoint fortsetzen
      let chapterFacts = cp?.chapterFacts ?? [];
      const startGi = cp?.nextGi ?? 0;
      if (startGi > 0) {
        updateJob(jobId, {
          progress: 50 + Math.round((startGi / groupOrder.length) * 35),
          statusText: `Setze Fakten-Extraktion fort (${startGi}/${groupOrder.length})…`,
        });
      }
      for (let gi = startGi; gi < groupOrder.length; gi++) {
        const group = groups.get(groupOrder[gi]);
        const fromPct = 50 + Math.round((gi / groupOrder.length) * 35);
        const toPct   = 50 + Math.round(((gi + 1) / groupOrder.length) * 35);
        updateJob(jobId, { progress: fromPct, statusText: `Fakten in «${group.name}» (${gi + 1}/${groupOrder.length})…` });
        const chText = group.pages.map(p => `### ${p.title}\n${p.text}`).join('\n\n---\n\n');
        try {
          const chResult = await call(jobId, tok,
            prompts.buildKontinuitaetChapterFactsPrompt(group.name, chText),
            sys.SYSTEM_KONTINUITAET, fromPct, toPct, 1500, 0.2, null, prompts.SCHEMA_KONTINUITAET_FAKTEN,
          );
          chapterFacts.push({ kapitel: group.name, fakten: chResult.fakten || [] });
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          log.warn(`Job ${jobId}: Fakten «${group.name}» übersprungen: ${e.message}`);
        }
        saveCheckpoint('kontinuitaet', bookIdInt, email, { chapterFacts, nextGi: gi + 1 });
      }

      updateJob(jobId, { progress: 88, statusText: 'KI prüft Widersprüche…' });
      result = await call(jobId, tok,
        prompts.buildKontinuitaetCheckPrompt(bookName, chapterFacts, figurenKompakt, orteKompakt),
        sys.SYSTEM_KONTINUITAET, 88, 97, 5000, 0.2, null, prompts.SCHEMA_KONTINUITAET_PROBLEME,
      );
    }

    if (typeof result?.zusammenfassung === 'undefined') throw new Error('KI-Antwort ungültig: zusammenfassung fehlt');
    const normalizedProbleme = saveKontinuitaetResult(bookIdInt, email, result, figNameToId, chNameToId, effectiveProvider, log, jobId);
    deleteCheckpoint('kontinuitaet', bookIdInt, email);
    completeJob(jobId, {
      count: normalizedProbleme.length,
      issues: normalizedProbleme,
      zusammenfassung: result.zusammenfassung,
      tokensIn: tok.in, tokensOut: tok.out,
    }, tps(tok));
    log.info(`Job ${jobId}: Kontinuitätsprüfung abgeschlossen (${normalizedProbleme.length} Probleme, ${fmtTok(tok.in)}↑ ${fmtTok(tok.out)}↓).`);
  } catch (e) {
    if (e.name !== 'AbortError') log.error(`Job ${jobId}: Kontinuitätsprüfung Fehler: ${e.message}`);
    failJob(jobId, e);
  }
}

// ── Nacht-Cron: Komplettanalyse für alle Bücher × alle User ──────────────────
async function runKomplettAnalyseAll() {
  const cronProvider = process.env.API_PROVIDER || 'llama';
  const cronHostOk = cronProvider === 'llama'  ? !!process.env.LLAMA_HOST
                   : cronProvider === 'ollama' ? !!process.env.OLLAMA_HOST
                   : true; // claude braucht keinen lokalen Host
  if (!cronHostOk) {
    logger.info(`Nacht-Analyse übersprungen: ${cronProvider.toUpperCase()}_HOST nicht konfiguriert.`);
    return;
  }

  const users = getAllUserTokens();
  if (!users.length) {
    logger.warn('Nacht-Analyse übersprungen: kein BookStack-Token in der Datenbank.');
    return;
  }

  // Bücherliste mit erstem verfügbaren Token holen
  let books;
  for (const u of users) {
    try {
      books = await bsGetAll('books', { id: u.token_id, pw: u.token_pw });
      break;
    } catch (e) {
      logger.warn(`Nacht-Analyse: Bücherliste mit Token von ${u.email} fehlgeschlagen – nächsten versuchen.`);
    }
  }
  if (!books) {
    logger.error('Nacht-Analyse abgebrochen: kein gültiger Token für Bücherliste gefunden.');
    return;
  }

  logger.info(`Nacht-Analyse: ${books.length} Buch/Bücher × ${users.length} User`);
  let queued = 0;
  for (const book of books) {
    for (const u of users) {
      const key = jobKey('komplett-analyse', book.id, u.email);
      if (runningJobs.has(key)) {
        logger.info(`Nacht-Analyse: Buch ${book.id} / ${u.email} läuft bereits – überspringe.`);
        continue;
      }
      const label = `Nacht · ${book.name}`;
      const userToken = { id: u.token_id, pw: u.token_pw };
      const jobId = createJob('komplett-analyse', book.id, u.email, label);
      enqueueJob(jobId, () => runKomplettAnalyseJob(jobId, book.id, book.name, u.email, userToken, cronProvider));
      queued++;
    }
  }
  logger.info(`Nacht-Analyse: ${queued} Job(s) in Warteschlange eingereiht.`);
}

// ── Routen ────────────────────────────────────────────────────────────────────
komplettRouter.post('/komplett-analyse', jsonBody, (req, res) => {
  const { book_id, book_name } = req.body;
  if (!book_id) return res.status(400).json({ error: 'book_id fehlt' });
  const userEmail = req.session?.user?.email || null;
  const userToken = req.session?.bookstackToken ? { id: req.session.bookstackToken.id, pw: req.session.bookstackToken.pw } : null;
  const existing = runningJobs.get(jobKey('komplett-analyse', book_id, userEmail));
  if (existing && jobs.has(existing)) return res.json({ jobId: existing, existing: true });
  const label = book_name ? `Komplettanalyse · ${book_name}` : 'Komplettanalyse';
  const jobId = createJob('komplett-analyse', book_id, userEmail, label);
  enqueueJob(jobId, () => runKomplettAnalyseJob(jobId, book_id, book_name || '', userEmail, userToken));
  res.json({ jobId });
});

komplettRouter.post('/kontinuitaet', jsonBody, (req, res) => {
  const { book_id, book_name } = req.body;
  if (!book_id) return res.status(400).json({ error: 'book_id fehlt' });
  const userEmail = req.session?.user?.email || null;
  const userToken = req.session?.bookstackToken ? { id: req.session.bookstackToken.id, pw: req.session.bookstackToken.pw } : null;
  const existing = runningJobs.get(jobKey('kontinuitaet', book_id, userEmail));
  if (existing && jobs.has(existing)) return res.json({ jobId: existing, existing: true });
  const label = book_name ? `Kontinuität · ${book_name}` : `Kontinuität`;
  const jobId = createJob('kontinuitaet', book_id, userEmail, label);
  enqueueJob(jobId, () => runKontinuitaetJob(jobId, book_id, book_name || '', userEmail, userToken));
  res.json({ jobId });
});

komplettRouter.get('/kontinuitaet/:book_id', (req, res) => {
  const bookId = parseInt(req.params.book_id);
  const userEmail = req.session?.user?.email || null;
  const row = db.prepare(`
    SELECT id, checked_at, issues_json, summary, model
    FROM continuity_checks
    WHERE book_id = ? AND user_email = ?
    ORDER BY checked_at DESC LIMIT 1
  `).get(bookId, userEmail);
  if (!row) return res.json(null);
  let issues = [];
  try { issues = JSON.parse(row.issues_json); } catch { /* ignore */ }
  res.json({ id: row.id, checked_at: row.checked_at, issues, summary: row.summary, model: row.model });
});

komplettRouter.delete('/chapter-cache/:book_id', (req, res) => {
  const bookId = req.params.book_id;
  const userEmail = req.session?.user?.email || '';
  const deleted = deleteChapterExtractCache(bookId, userEmail);
  res.json({ ok: true, deleted });
});

module.exports = { komplettRouter, runKomplettAnalyseAll };
