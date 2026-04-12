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
  loadPageContents, groupByChapter, buildSinglePassBookText,
  bsGetAll, SINGLE_PASS_LIMIT, BATCH_SIZE, jobAbortControllers,
  _modelName, fmtTok, tps, settledAll,
  jobs, runningJobs, createJob, enqueueJob, jobKey,
  jsonBody,
} = require('./shared');

const komplettRouter = express.Router();

// ── Job: Komplettanalyse ───────────────────────────────────────────────────────
// Pipeline (token-optimiert):
//   P1 (Vollextraktion: Figuren+Orte+Fakten+Szenen+Events, parallel/Kapitel, SYSTEM_KOMPLETT_EXTRAKTION)
//      → Schema im System-Prompt gecacht; Szenen/Events mit Klarnamen (kein ID-Lookup nötig)
//   P2 (Figuren konsolidieren) → figNameToId aufbauen
//   Block 1 [P3 Orte · P4 Soziogramm≥4 Figuren] parallel → ortNameToId aufbauen
//   Block 2 [P5 Szenen remappen (kein API-Call) + P6 Zeitstrahl · P8 Kontinuität] parallel
async function runKomplettAnalyseJob(jobId, bookId, bookName, userEmail, userToken, provider = undefined) {
  const logger = makeJobLogger(jobId);
  const call = (...args) => aiCall(...args, provider);
  const effectiveProvider = provider || process.env.API_PROVIDER || 'claude';
  // Claude hat 200K Token Kontextfenster (~600K deutsche Zeichen) – Single-Pass für fast alle Bücher.
  // Llama/Ollama: ctx-size 131072 (~390K deutsche Zeichen bei ~3 Zeichen/Token).
  // Single-Pass-Budget: 150K Zeichen Input (~50K Tokens) + ~4K System-Prompt + 16K Output ≈ 70K Tokens → sicher unter 131K.
  // Für grössere Bücher (>150K Zeichen) greift automatisch der Multi-Pass-Pfad.
  const singlePassLimit = effectiveProvider === 'claude' ? 250_000
    : (effectiveProvider === 'ollama' ? SINGLE_PASS_LIMIT : 150_000);
  const {
    buildExtraktionKomplettChapterPrompt,
    buildFiguresBasisConsolidationPrompt,
    buildKapiteluebergreifendeBeziehungenPrompt,
    buildLocationsConsolidationPrompt,
    buildZeitstrahlConsolidationPrompt,
    buildKontinuitaetSinglePassPrompt,
    buildKontinuitaetCheckPrompt,
  } = await getPrompts();
  const {
    SYSTEM_FIGUREN, SYSTEM_ORTE, SYSTEM_KONTINUITAET,
    SYSTEM_ZEITSTRAHL, SYSTEM_KOMPLETT_EXTRAKTION,
  } = await getBookPrompts(bookId);

  try {
    let cp = loadCheckpoint('komplett-analyse', bookId, userEmail);
    if (cp) logger.info(`Job ${jobId}: Komplettanalyse Buch ${bookId} – Checkpoint (Phase: ${cp.phase}), setze fort.`);

    // Checkpoint-Validierung: p1_full_done ohne tatsächliche Figuren-Daten verwirft den Checkpoint.
    // Alte Checkpoints mit Phase 'p1_done' (ohne chapterSzenen/chapterAssignments) werden ignoriert
    // und lösen eine vollständige Neuausführung aus.
    if (cp && cp.phase !== 'p1_full_done') {
      logger.info(`Job ${jobId}: Checkpoint Phase «${cp.phase}» wird ignoriert (altes Format) – Neustart.`);
      deleteCheckpoint('komplett-analyse', bookId, userEmail);
      cp = null;
    }
    if (cp?.phase === 'p1_full_done') {
      const hasFiguren = Array.isArray(cp.chapterFiguren) && cp.chapterFiguren.length > 0
        && cp.chapterFiguren.some(c => Array.isArray(c.figuren) && c.figuren.length > 0);
      if (!hasFiguren) {
        logger.warn(`Job ${jobId}: Checkpoint p1_full_done enthält keine Figuren-Daten – Phase 1 wird neu ausgeführt.`);
        deleteCheckpoint('komplett-analyse', bookId, userEmail);
        cp = null;
      }
    }

    // ── Seiten laden ──────────────────────────────────────────────────────────
    updateJob(jobId, { statusText: 'Lade Seiten…', progress: 0 });
    const [chaptersData, pages] = await Promise.all([
      bsGetAll('chapters?book_id=' + bookId, userToken),
      bsGetAll('pages?book_id=' + bookId, userToken),
    ]);
    if (!pages.length) { completeJob(jobId, { empty: true }); return; }

    const chMap = Object.fromEntries(chaptersData.map(c => [c.id, c.name]));
    const tok = { in: 0, out: 0, ms: 0, inflight: new Map() };

    // Cache-Signatur pro Kapitel: sortierter String aus "page_id:updated_at"-Paaren.
    // Ändert sich eine Seite, ändert sich die Signatur → Cache-Miss → Neu-Extraktion.
    const chapterPagesSig = {};
    for (const p of pages) {
      const key = p.chapter_id != null ? String(p.chapter_id) : '__ungrouped__';
      if (!chapterPagesSig[key]) chapterPagesSig[key] = [];
      chapterPagesSig[key].push(`${p.id}:${p.updated_at || ''}`);
    }
    for (const key of Object.keys(chapterPagesSig)) {
      chapterPagesSig[key] = chapterPagesSig[key].sort().join('|');
    }

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
    const totalChars = pageContents.reduce((s, p) => s + p.text.length, 0);
    const { groupOrder, groups } = groupByChapter(pageContents);

    // ── Phase 1: Vollextraktion kombiniert (P1+P5 merged, parallel pro Kapitel) ──
    // Ein einziger Call pro Kapitel extrahiert: Figuren + Orte + Fakten + Szenen + Lebensereignisse.
    // Schema und Regeln im System-Prompt (SYSTEM_KOMPLETT_EXTRAKTION) → gecacht über alle Kapitel.
    // Szenen/Assignments verwenden Klarnamen statt IDs; Remapping nach P2/P3-Konsolidierung.
    let chapterFiguren, chapterOrte, chapterFakten, chapterSzenen, chapterAssignments;

    if (cp?.phase === 'p1_full_done') {
      ({ chapterFiguren, chapterOrte, chapterFakten, chapterSzenen, chapterAssignments } = cp);
      if (cp.tokIn != null) { tok.in = cp.tokIn; tok.out = cp.tokOut || 0; tok.ms = cp.tokMs || 0; }
      updateJob(jobId, { progress: 28, statusText: 'Phase 1 aus Checkpoint geladen…', tokensIn: tok.in, tokensOut: tok.out });
    } else {
      updateJob(jobId, {
        progress: 12,
        statusText: totalChars <= singlePassLimit
          ? 'KI extrahiert Figuren, Schauplätze, Fakten, Szenen…'
          : `Vollextraktion in ${groupOrder.length} Kapiteln…`,
      });

      logger.info(`Job ${jobId}: Phase 1 – ${totalChars} Zeichen, ${effectiveProvider}, Limit ${singlePassLimit} → ${totalChars <= singlePassLimit ? 'Single-Pass' : `Multi-Pass (${groupOrder.length} Kapitel)`}`);
      if (totalChars <= singlePassLimit) {
        const bookText = buildSinglePassBookText(groups, groupOrder);
        const r = await call(jobId, tok,
          buildExtraktionKomplettChapterPrompt('Gesamtbuch', bookName, pageContents.length, bookText),
          SYSTEM_KOMPLETT_EXTRAKTION, 12, 28, 16000,
        );
        chapterFiguren     = [{ kapitel: 'Gesamtbuch', figuren:     r?.figuren     || [] }];
        chapterOrte        = [{ kapitel: 'Gesamtbuch', orte:        r?.orte        || [] }];
        chapterFakten      = [{ kapitel: 'Gesamtbuch', fakten:      r?.fakten      || [] }];
        chapterSzenen      = [{ kapitel: 'Gesamtbuch', szenen:      r?.szenen      || [] }];
        chapterAssignments = [{ kapitel: 'Gesamtbuch', assignments: r?.assignments || [] }];
        const totalEvents1 = (r?.assignments || []).reduce((s, a) => s + (a.lebensereignisse?.length || 0), 0);
        logger.info(`Job ${jobId}: Phase 1 Single-Pass OK – figuren=${chapterFiguren[0].figuren.length}, orte=${chapterOrte[0].orte.length}, fakten=${chapterFakten[0].fakten.length}, szenen=${chapterSzenen[0].szenen.length}, assignments=${chapterAssignments[0].assignments.length} (${totalEvents1} Ereignisse). Kapitel: [${groupOrder.map(k => groups.get(k).name).join(', ')}]`);
      } else {
        const chapterTexts = groupOrder.map(key => {
          const group = groups.get(key);
          return {
            group, key,
            pagesSig: chapterPagesSig[key] || '',
            chText: group.pages.map(p => `### ${p.title}\n${p.text}`).join('\n\n---\n\n'),
          };
        });
        let cacheHits = 0;
        const settled = await settledAll(
          chapterTexts.map(({ group, key, pagesSig, chText }) => async () => {
            // Delta-Cache: Cache-Hit → kein KI-Call nötig
            const cached = loadChapterExtractCache(bookId, userEmail, key, pagesSig);
            if (cached) { cacheHits++; return cached; }
            const result = await call(jobId, tok,
              buildExtraktionKomplettChapterPrompt(group.name, bookName, group.pages.length, chText),
              SYSTEM_KOMPLETT_EXTRAKTION, 12, 28, 14000,
            );
            saveChapterExtractCache(bookId, userEmail, key, pagesSig, result);
            return result;
          })
        );
        chapterFiguren = settled.map((r, gi) => ({
          kapitel: chapterTexts[gi].group.name,
          figuren: r.status === 'fulfilled' ? (r.value?.figuren || []) : [],
          ...(r.status === 'rejected' && logger.warn(`Job ${jobId}: Vollextraktion «${chapterTexts[gi].group.name}» übersprungen: ${r.reason?.message}`) && {}),
        }));
        chapterOrte = settled.map((r, gi) => ({
          kapitel: chapterTexts[gi].group.name,
          orte: r.status === 'fulfilled' ? (r.value?.orte || []) : [],
        }));
        chapterFakten = settled.map((r, gi) => ({
          kapitel: chapterTexts[gi].group.name,
          fakten: r.status === 'fulfilled' ? (r.value?.fakten || []) : [],
        }));
        chapterSzenen = settled.map((r, gi) => ({
          kapitel: chapterTexts[gi].group.name,
          szenen: r.status === 'fulfilled' ? (r.value?.szenen || []) : [],
        }));
        chapterAssignments = settled.map((r, gi) => ({
          kapitel: chapterTexts[gi].group.name,
          assignments: r.status === 'fulfilled' ? (r.value?.assignments || []) : [],
        }));
        const totalEvents1mp = chapterAssignments.reduce((s, c) => s + c.assignments.reduce((ss, a) => ss + (a.lebensereignisse?.length || 0), 0), 0);
        const kapDetail = chapterTexts.map((ct, gi) => {
          const r = settled[gi];
          const ok = r.status === 'fulfilled';
          return `${ct.group.name}: fig=${ok ? (r.value?.figuren?.length ?? 0) : 'ERR'} orte=${ok ? (r.value?.orte?.length ?? 0) : 'ERR'} sz=${ok ? (r.value?.szenen?.length ?? 0) : 'ERR'} ass=${ok ? (r.value?.assignments?.length ?? 0) : 'ERR'}`;
        });
        logger.info(`Job ${jobId}: Phase 1 Multi-Pass – ${settled.filter(r => r.status === 'fulfilled').length}/${settled.length} Kapitel OK (${cacheHits} Cache-Hits), total: figuren=${chapterFiguren.reduce((s,c)=>s+c.figuren.length,0)}, orte=${chapterOrte.reduce((s,c)=>s+c.orte.length,0)}, szenen=${chapterSzenen.reduce((s,c)=>s+c.szenen.length,0)}, assignments=${chapterAssignments.reduce((s,c)=>s+c.assignments.length,0)} (${totalEvents1mp} Ereignisse)`);
        for (const line of kapDetail) logger.info(`Job ${jobId}:   ${line}`);
      }
      saveCheckpoint('komplett-analyse', bookId, userEmail, {
        phase: 'p1_full_done',
        chapterFiguren, chapterOrte, chapterFakten, chapterSzenen, chapterAssignments,
        tokIn: tok.in, tokOut: tok.out, tokMs: tok.ms,
      });
    }

    // ── Phase 2: Figuren konsolidieren ────────────────────────────────────────
    updateJob(jobId, { progress: 30, statusText: 'KI konsolidiert Figuren…' });
    const figResult = await call(jobId, tok,
      buildFiguresBasisConsolidationPrompt(bookName, chapterFiguren),
      SYSTEM_FIGUREN, 30, 43, 8000,
    );
    logger.info(`Job ${jobId}: figResult Keys: [${Object.keys(figResult || {}).join(', ')}] – figuren: ${figResult?.figuren?.length ?? 'FEHLT'}`);
    if (!Array.isArray(figResult?.figuren)) throw new Error('Figuren-Konsolidierung ungültig: figuren-Array fehlt');
    const figuren = figResult.figuren.map((f, i) => ({ ...f, id: f.id || ('fig_' + (i + 1)) }));
    logger.info(`Job ${jobId}: Speichere ${figuren.length} Figuren…`);
    saveFigurenToDb(parseInt(bookId), figuren, userEmail || null, idMaps);
    logger.info(`Job ${jobId}: ${figuren.length} Figuren gespeichert.`);

    // figurenKompakt: nur Name+Typ (für Orte-Konsolidierung P3).
    const figurenKompakt = figuren.map(f => ({ id: f.id, name: f.name, typ: f.typ || 'andere' }));

    // figNameToId: Klarnamen → konsolidierte ID (für Szenen/Events-Remapping nach P3).
    // Enthält kanonischen Name UND kurzname wenn vorhanden.
    const figNameToId = {};
    for (const f of figuren) {
      figNameToId[f.name] = f.id;
      if (f.kurzname && f.kurzname !== f.name) figNameToId[f.kurzname] = f.id;
    }
    const figNameToIdLower = Object.fromEntries(
      Object.entries(figNameToId).map(([k, v]) => [k.toLowerCase(), v])
    );

    // Fallback: Phase-1-Namen (aus figuren + assignments) auf konsolidierte IDs mappen.
    // Wenn das Modell in assignments figur_name != Phase-2-Kanonname verwendet (z.B. nur Nachname,
    // Titel+Name, Zweitname), wird per Token-Matching die eindeutig passende Phase-2-Figur gesucht.
    // Auch Namen die nur in assignments vorkommen (nicht in chapterFiguren) werden abgedeckt.
    // Nur eingetragen wenn die Zuordnung eindeutig ist (genau eine Phase-2-Figur trifft zu).
    function tokenFallback(name) {
      if (!name) return;
      if (figNameToId[name] || figNameToIdLower[name.toLowerCase()]) return;
      const tokens = new Set(name.toLowerCase().split(/[\s\-\.]+/).filter(t => t.length > 2));
      if (!tokens.size) return;
      const seen = new Set();
      const matches = [];
      for (const [canon, fid] of Object.entries(figNameToId)) {
        if (seen.has(fid)) continue;
        const overlap = canon.toLowerCase().split(/[\s\-\.]+/)
          .filter(t => t.length > 2 && tokens.has(t)).length;
        if (overlap > 0) { seen.add(fid); matches.push(fid); }
      }
      if (matches.length === 1) {
        figNameToId[name] = matches[0];
        figNameToIdLower[name.toLowerCase()] = matches[0];
        logger.info(`Job ${jobId}: Phase-1-Name «${name}» → ${matches[0]} (Token-Fallback)`);
      }
    }
    for (const { figuren: chFigs } of (chapterFiguren || []))
      for (const f1 of (chFigs || [])) tokenFallback(f1.name);
    for (const { assignments: chAss } of (chapterAssignments || []))
      for (const a of (chAss || [])) tokenFallback(a?.figur_name);

    // Soziogramm aus P2-Ergebnis übernehmen – kein separater API-Call.
    // FIGUREN_BASIS_SCHEMA enthält bereits sozialschicht und beziehungen[].machtverhaltnis.
    if (figuren.length >= 4) {
      const sozFiguren = figuren.map(f => ({ fig_id: f.id, sozialschicht: f.sozialschicht || 'andere' }));
      const sozBeziehungen = figuren.flatMap(f =>
        (f.beziehungen || [])
          .filter(bz => bz.machtverhaltnis && bz.figur_id)
          .map(bz => ({ from_fig_id: f.id, to_fig_id: bz.figur_id, machtverhaltnis: bz.machtverhaltnis }))
      );
      updateFigurenSoziogramm(parseInt(bookId), sozFiguren, sozBeziehungen, userEmail || null);
      logger.info(`Job ${jobId}: Soziogramm aus P2: ${sozFiguren.length} Figuren, ${sozBeziehungen.length} Machtbeziehungen.`);
    }

    // ── Phase 3: Orte konsolidieren ───────────────────────────────────────────
    updateJob(jobId, { progress: 43, statusText: 'Schauplätze konsolidieren…' });
    const orteResultRaw = await call(jobId, tok,
      buildLocationsConsolidationPrompt(bookName, chapterOrte, figurenKompakt),
      SYSTEM_ORTE, 43, 55, 6000,
    );

    logger.info(`Job ${jobId}: orteResult Keys: [${Object.keys(orteResultRaw || {}).join(', ')}] – orte: ${orteResultRaw?.orte?.length ?? 'FEHLT'}`);
    if (!Array.isArray(orteResultRaw?.orte)) throw new Error('Orte-Konsolidierung ungültig: orte-Array fehlt');
    const orte = orteResultRaw.orte.map((o, i) => ({ ...o, id: o.id || ('ort_' + (i + 1)) }));
    logger.info(`Job ${jobId}: Speichere ${orte.length} Schauplätze…`);
    saveOrteToDb(parseInt(bookId), orte, userEmail || null);
    logger.info(`Job ${jobId}: ${orte.length} Schauplätze gespeichert.`);

    // ortNameToId: Klarnamen → konsolidierte ID (für Szenen-Remapping in Block 2).
    const ortNameToId = {};
    const ortNameToIdLower = {};
    for (const o of orte) {
      ortNameToId[o.name] = o.id;
      ortNameToIdLower[o.name.toLowerCase()] = o.id;
    }

    // ── Phase 3b: Kapitelübergreifende Beziehungen (nur Multi-Pass) ───────────
    // Single-Pass: Phase 1 hat den vollständigen Text gesehen → Beziehungen bereits erfasst.
    // Multi-Pass: Kapitel wurden isoliert analysiert → Beziehungen zwischen Figuren
    // verschiedener Kapitel wurden in Phase 1 nicht erkannt. Hier werden sie nachträglich
    // aus dem Volltext identifiziert und zu figure_relations hinzugefügt.
    if (chapterFiguren.length > 1 && figuren.length >= 2) {
      updateJob(jobId, { progress: 55, statusText: 'Kapitelübergreifende Beziehungen suchen…' });
      try {
        const fullText = buildSinglePassBookText(groups, groupOrder);
        // Text ggf. kürzen – singlePassLimit gilt auch hier als Kontextbudget
        const textForPrompt = fullText.length <= singlePassLimit
          ? fullText
          : fullText.slice(0, singlePassLimit);
        const bzResult = await call(jobId, tok,
          buildKapiteluebergreifendeBeziehungenPrompt(bookName, figuren, textForPrompt),
          SYSTEM_FIGUREN, 55, 58, 2000,
        );
        const newBz = Array.isArray(bzResult?.beziehungen) ? bzResult.beziehungen : [];
        if (newBz.length > 0) {
          addFigurenBeziehungen(parseInt(bookId), newBz, userEmail || null);
          logger.info(`Job ${jobId}: Phase 3b – ${newBz.length} kapitelübergreifende Beziehungen gespeichert.`);
        } else {
          logger.info(`Job ${jobId}: Phase 3b – keine kapitelübergreifenden Beziehungen gefunden.`);
        }
      } catch (e) {
        // Nicht-kritisch: Job läuft weiter, nur diese Phase schlägt fehl
        logger.warn(`Job ${jobId}: Phase 3b kapitelübergreifende Beziehungen fehlgeschlagen (ignoriert): ${e.message}`);
      }
    }

    // ── Parallel-Block 2: Szenen/Zeitstrahl + Kontinuität ──
    // Szenen + Events stammen aus Phase 1 (kein separater P5-Call mehr).
    // P8 nutzt chapterFakten aus Phase 1 – kein separater Extraktions-Call.
    let allSzenen = [];
    updateJob(jobId, { progress: 58, statusText: 'Szenen verarbeiten und Kontinuität prüfen…' });

    // Hilfsfunktion: Szenen + Events aus P1-Checkpoint (namensbasiert) speichern.
    // figNameToId / figNameToIdLower: kanonischer Name → fig_id (inkl. Kurzname).
    // ortNameToId: Schauplatzname → ort_id.
    // locIdToDbId: ort_id ('ort_1') → DB-Rowid der locations-Tabelle.
    async function processSzenenEreignisseFromMerged(chSzenen, chAssignments, locIdToDbId) {
      const mergedEvtMap = new Map();

      for (const { kapitel, szenen: chSz } of (chSzenen || [])) {
        for (const s of (chSz || [])) {
          const fig_ids = (s.figuren_namen || []).map(n =>
            figNameToId[n] || figNameToIdLower[n?.toLowerCase()] || null
          ).filter(Boolean);
          const ort_ids = (s.orte_namen || []).map(n =>
            ortNameToId[n] || ortNameToIdLower[n?.toLowerCase()] || null
          ).filter(Boolean);
          allSzenen.push({
            kapitel: s.kapitel || kapitel,
            seite:      s.seite     || null,
            titel:      s.titel     || '(unbekannt)',
            wertung:    s.wertung   || null,
            kommentar:  s.kommentar || null,
            fig_ids,
            ort_ids,
            sort_order: allSzenen.length,
          });
        }
      }

      let droppedAssignments = 0;
      for (const { kapitel, assignments: chAss } of (chAssignments || [])) {
        for (const assignment of (chAss || [])) {
          const figId = figNameToId[assignment.figur_name]
            || figNameToIdLower[assignment.figur_name?.toLowerCase()]
            || null;
          if (!figId) { droppedAssignments++; logger.warn(`Job ${jobId}: Assignment «${assignment.figur_name}» (${assignment.lebensereignisse?.length || 0} Ereignisse) – keine Figuren-ID gefunden, wird ignoriert.`); continue; }
          if (!mergedEvtMap.has(figId)) mergedEvtMap.set(figId, []);
          for (const ev of (assignment.lebensereignisse || [])) {
            mergedEvtMap.get(figId).push({ ...ev, kapitel: ev.kapitel || kapitel });
          }
        }
      }

      if (droppedAssignments > 0) logger.warn(`Job ${jobId}: ${droppedAssignments} Assignments ohne Figuren-ID ignoriert (Namens-Mismatch zwischen Phase 1 und Phase 2).`);
      logger.info(`Job ${jobId}: Speichere ${allSzenen.length} Szenen (${mergedEvtMap.size} Figuren mit Ereignissen)…`);
      updateJob(jobId, { progress: 81, statusText: 'Szenen speichern…' });
      db.transaction(() => {
        db.prepare('DELETE FROM figure_scenes WHERE book_id = ? AND user_email = ?').run(parseInt(bookId), userEmail || null);
        const now = new Date().toISOString();
        const ins = db.prepare(`INSERT INTO figure_scenes
          (book_id, user_email, kapitel, seite, titel, wertung, kommentar, chapter_id, page_id, sort_order, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        const insSf = db.prepare('INSERT INTO scene_figures (scene_id, fig_id) VALUES (?, ?)');
        const insSl = db.prepare('INSERT OR IGNORE INTO scene_locations (scene_id, location_id) VALUES (?, ?)');
        for (const s of allSzenen) {
          const { lastInsertRowid: sceneId } = ins.run(
            parseInt(bookId), userEmail || null,
            s.kapitel, s.seite, s.titel, s.wertung, s.kommentar,
            idMaps.chNameToId[s.kapitel]  ?? null,
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
      const totalEvents = allAssignments.reduce((s, a) => s + (a.lebensereignisse?.length || 0), 0);
      logger.info(`Job ${jobId}: Speichere ${allAssignments.length} Figur-Ereignis-Sets (${totalEvents} Ereignisse)…`);
      if (totalEvents > 0) {
        saveZeitstrahlEvents(parseInt(bookId), userEmail || null, []);
        updateFigurenEvents(parseInt(bookId), allAssignments, userEmail || null, idMaps);
        logger.info(`Job ${jobId}: ${allSzenen.length} Szenen und ${totalEvents} Ereignisse gespeichert.`);
      } else {
        logger.info(`Job ${jobId}: ${allSzenen.length} Szenen gespeichert – keine Ereignisse gefunden.`);
      }
    }

    // Hilfsfunktion: P6 Zeitstrahl konsolidieren (identisch für beide Pfade).
    async function runZeitstrahlKonsolidierung() {
      updateJob(jobId, { progress: 83, statusText: 'Zeitstrahl konsolidieren…' });
      const rawEvtRows = db.prepare(`
        SELECT f.fig_id, f.name AS fig_name, f.typ AS fig_typ,
               fe.datum, fe.ereignis, fe.typ AS evt_typ, fe.bedeutung, fe.kapitel, fe.seite
        FROM figure_events fe
        JOIN figures f ON f.id = fe.figure_id
        WHERE f.book_id = ? AND f.user_email IS ?
        ORDER BY fe.datum, f.sort_order
      `).all(parseInt(bookId), userEmail || null);
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
        buildZeitstrahlConsolidationPrompt(zeitstrahlEvents),
        SYSTEM_ZEITSTRAHL, 83, 89, 3000, 0.2, null,
      );
      logger.info(`Job ${jobId}: ztResult Keys: [${Object.keys(ztResult || {}).join(', ')}] – ereignisse: ${ztResult?.ereignisse?.length ?? 'FEHLT'}`);
      if (Array.isArray(ztResult?.ereignisse)) {
        logger.info(`Job ${jobId}: Speichere ${ztResult.ereignisse.length} Zeitstrahl-Ereignisse…`);
        saveZeitstrahlEvents(parseInt(bookId), userEmail || null, ztResult.ereignisse);
        logger.info(`Job ${jobId}: ${ztResult.ereignisse.length} Zeitstrahl-Ereignisse gespeichert.`);
      }
    }

    await Promise.all([

      // ── P5+P6: Szenen aus P1 übernehmen + Zeitstrahl konsolidieren ──────────
      // Kein separater API-Call: chapterSzenen und chapterAssignments kommen aus Phase 1.
      (async () => {
        updateJob(jobId, { progress: 63, statusText: 'Szenen aus Extraktion verarbeiten…' });
        const locRows = db.prepare(
          'SELECT id, loc_id FROM locations WHERE book_id = ? AND user_email = ? ORDER BY sort_order'
        ).all(parseInt(bookId), userEmail || null);
        const locIdToDbId = Object.fromEntries(locRows.map(r => [r.loc_id, r.id]));
        await processSzenenEreignisseFromMerged(chapterSzenen, chapterAssignments, locIdToDbId);
        await runZeitstrahlKonsolidierung();
      })(),

      // ── P8: Kontinuitätsprüfung ───────────────────────────────────────────
      // Multi-Pass: chapterFakten aus Phase 1 – kein separater Extraktions-Call.
      // Single-Pass: Buchtext direkt (besserer Kontext für kleine Bücher).
      // Fallback: alter Checkpoint ohne chapterFakten → Extraktion nachholen.
      (async () => {
        const figKompaktForKont  = figuren.map(f => ({ name: f.name, typ: f.typ || 'andere', beschreibung: f.beschreibung || '' }));
        const ortRowsForKont     = db.prepare(
          'SELECT name, typ, beschreibung FROM locations WHERE book_id = ? AND user_email = ? ORDER BY sort_order'
        ).all(parseInt(bookId), userEmail || null);
        const orteKompaktForKont = ortRowsForKont.map(o => ({ name: o.name, typ: o.typ, beschreibung: o.beschreibung || '' }));

        let kontResult;
        // Claude: Single-Pass für kleine Bücher (voller Buchtext, besserer Kontext).
        // Llama/Ollama: immer facts-basiert (chapterFakten aus Phase 1) – voller Buchtext
        // wäre ein zweiter 50K-Token-Call der auf langsamer Hardware Stunden dauert.
        if (totalChars <= singlePassLimit && effectiveProvider === 'claude') {
          updateJob(jobId, { progress: 97, statusText: 'Kontinuität prüfen…' });
          const bookText = buildSinglePassBookText(groups, groupOrder);
          logger.info(`Job ${jobId}: Kontinuität Single-Pass: ${bookText.length} Zeichen Buchtext, ${figKompaktForKont.length} Figuren, ${orteKompaktForKont.length} Orte`);
          kontResult = await call(jobId, tok,
            buildKontinuitaetSinglePassPrompt(bookName, bookText, figKompaktForKont, orteKompaktForKont),
            SYSTEM_KONTINUITAET, 97, 99, 5000,
          );
        } else {
          // Facts-basiert: chapterFakten aus Phase 1 – immer verfügbar (single- und multi-pass).
          updateJob(jobId, { progress: 98, statusText: 'KI prüft Widersprüche…' });
          const totalFaktenChars = chapterFakten.reduce((s, c) => s + JSON.stringify(c.fakten).length, 0);
          logger.info(`Job ${jobId}: Kontinuität facts-basiert: ${chapterFakten.length} Kapitel, ~${totalFaktenChars} Zeichen Fakten, ${figKompaktForKont.length} Figuren`);
          kontResult = await call(jobId, tok,
            buildKontinuitaetCheckPrompt(bookName, chapterFakten, figKompaktForKont, orteKompaktForKont),
            SYSTEM_KONTINUITAET, 98, 99, effectiveProvider === 'claude' ? 5000 : 2500,
          );
        }

        logger.info(`Job ${jobId}: kontResult Keys: [${Object.keys(kontResult || {}).join(', ')}] – probleme: ${kontResult?.probleme?.length ?? '?'}, zusammenfassung: ${kontResult?.zusammenfassung?.length ?? '?'} Zeichen`);
        if (typeof kontResult?.zusammenfassung !== 'undefined') {
          const normalizedProbleme = (kontResult.probleme || []).map(issue => ({
            ...issue,
            fig_ids:     (issue.figuren  || []).map(n => figNameToId[n]).filter(Boolean),
            chapter_ids: (issue.kapitel  || []).map(n => idMaps.chNameToId[n]).filter(Boolean),
          }));
          const model = _modelName(effectiveProvider);
          logger.info(`Job ${jobId}: Speichere Kontinuitätsprüfung (${normalizedProbleme.length} Probleme)…`);
          db.prepare(`INSERT INTO continuity_checks (book_id, user_email, checked_at, issues_json, summary, model)
            VALUES (?, ?, ?, ?, ?, ?)`)
            .run(parseInt(bookId), userEmail || null, new Date().toISOString(),
              JSON.stringify(normalizedProbleme), kontResult.zusammenfassung || '', model);
          logger.info(`Job ${jobId}: Kontinuitätsprüfung abgeschlossen (${normalizedProbleme.length} Probleme).`);
        }
      })(),

    ]); // Ende Parallel-Block 2

    deleteCheckpoint('komplett-analyse', bookId, userEmail);
    completeJob(jobId, {
      figCount:   figuren.length,
      orteCount:  orte.length,
      szenenCount: allSzenen.length,
      tokensIn: tok.in, tokensOut: tok.out,
    }, tps(tok));
    logger.info(`Job ${jobId}: Komplettanalyse Buch ${bookId} abgeschlossen (${fmtTok(tok.in)}↑ ${fmtTok(tok.out)}↓ Tokens).`);
  } catch (e) {
    logger.error(`Job ${jobId}: Komplettanalyse Fehler: ${e.message}`);
    failJob(jobId, e);
  }
}

// ── Job: Kontinuitätsprüfung ──────────────────────────────────────────────────
async function runKontinuitaetJob(jobId, bookId, bookName, userEmail, userToken, provider = undefined) {
  const logger = makeJobLogger(jobId);
  const call = (...args) => aiCall(...args, provider);
  const effectiveProvider = provider || process.env.API_PROVIDER || 'claude';
  const singlePassLimit = effectiveProvider === 'claude' ? 250_000
    : (effectiveProvider === 'ollama' ? SINGLE_PASS_LIMIT : 150_000);
  const { buildKontinuitaetSinglePassPrompt, buildKontinuitaetChapterFactsPrompt, buildKontinuitaetCheckPrompt } = await getPrompts();
  const { SYSTEM_KONTINUITAET } = await getBookPrompts(bookId);

  try {
    const cp = loadCheckpoint('kontinuitaet', bookId, userEmail);
    if (cp) logger.info(`Job ${jobId}: Kontinuitätsprüfung Buch ${bookId} – Checkpoint gefunden (${cp.nextGi} Kapitel bereits fertig), setze fort.`);

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
    `).all(parseInt(bookId), userEmail || null);
    const figurenKompakt = figRows.map(f => ({ name: f.name, typ: f.typ || 'andere', beschreibung: f.beschreibung || '' }));
    const figNameToId = Object.fromEntries(figRows.map(r => [r.name, r.fig_id]));

    const ortRows = db.prepare(
      'SELECT name, typ, beschreibung FROM locations WHERE book_id = ? AND user_email = ? ORDER BY sort_order'
    ).all(parseInt(bookId), userEmail || null);
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
        buildKontinuitaetSinglePassPrompt(bookName, bookText, figurenKompakt, orteKompakt),
        SYSTEM_KONTINUITAET,
        60, 97, 5000,
      );
    } else {
      // Multi-Pass: Fakten pro Kapitel extrahieren – ggf. aus Checkpoint fortsetzen

      let chapterFacts = cp?.chapterFacts ?? [];
      const startGi = cp?.nextGi ?? 0;

      if (startGi > 0) {
        updateJob(jobId, {
          progress: 50 + Math.round((startGi / groupOrder.length) * 35),
          statusText: `Setze Fakten-Extraktion fort (${startGi}/${groupOrder.length} Kapitel bereits fertig)…`,
        });
      }

      for (let gi = startGi; gi < groupOrder.length; gi++) {
        const group = groups.get(groupOrder[gi]);
        const fromPct = 50 + Math.round((gi / groupOrder.length) * 35);
        const toPct   = 50 + Math.round(((gi + 1) / groupOrder.length) * 35);
        updateJob(jobId, {
          progress: fromPct,
          statusText: `Fakten in «${group.name}» (${gi + 1}/${groupOrder.length})…`,
        });
        const chText = group.pages.map(p => `### ${p.title}\n${p.text}`).join('\n\n---\n\n');
        let chResult;
        try {
          chResult = await call(jobId, tok,
            buildKontinuitaetChapterFactsPrompt(group.name, chText),
            SYSTEM_KONTINUITAET,
            fromPct, toPct, 1500,
          );
          chapterFacts.push({ kapitel: group.name, fakten: chResult.fakten || [] });
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          logger.warn(`Job ${jobId}: Fakten-Extraktion Kapitel «${group.name}» übersprungen: ${e.message}`);
        }
        saveCheckpoint('kontinuitaet', bookId, userEmail, { chapterFacts, nextGi: gi + 1 });
      }

      updateJob(jobId, {
        progress: 88,
        statusText: `KI prüft Widersprüche…`,
      });
      result = await call(jobId, tok,
        buildKontinuitaetCheckPrompt(bookName, chapterFacts, figurenKompakt, orteKompakt),
        SYSTEM_KONTINUITAET,
        88, 97, 5000,
      );
    }

    if (typeof result?.zusammenfassung === 'undefined') throw new Error('KI-Antwort ungültig: zusammenfassung fehlt');

    const normalizedProbleme = (result.probleme || []).map(issue => ({
      ...issue,
      fig_ids:     (issue.figuren || []).map(n => figNameToId[n]).filter(Boolean),
      chapter_ids: (issue.kapitel || []).map(n => chNameToId[n]).filter(Boolean),
    }));

    const model = _modelName(effectiveProvider);

    db.prepare(`INSERT INTO continuity_checks (book_id, user_email, checked_at, issues_json, summary, model)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(parseInt(bookId), userEmail || null, new Date().toISOString(),
        JSON.stringify(normalizedProbleme), result.zusammenfassung || '', model);

    deleteCheckpoint('kontinuitaet', bookId, userEmail);
    completeJob(jobId, {
      count: normalizedProbleme.length,
      issues: normalizedProbleme,
      zusammenfassung: result.zusammenfassung,
      tokensIn: tok.in, tokensOut: tok.out,
    }, tps(tok));
    logger.info(`Job ${jobId}: Kontinuitätsprüfung Buch ${bookId} abgeschlossen (${(result.probleme || []).length} Probleme, ${fmtTok(tok.in)}↑ ${fmtTok(tok.out)}↓ Tokens).`);
  } catch (e) {
    logger.error(`Job ${jobId}: Kontinuitätsprüfung Fehler: ${e.message}`);
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
