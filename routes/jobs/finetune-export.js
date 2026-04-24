'use strict';
const express = require('express');
const { createHash } = require('crypto');
const { db, getTokenForRequest, getBookSettings } = require('../../db/schema');
const {
  makeJobLogger, updateJob, completeJob, failJob,
  bsGetAll, loadPageContents,
  jobs, runningJobs, createJob, enqueueJob, jobKey,
  jobAbortControllers, BATCH_SIZE,
  jsonBody,
} = require('./shared');

const finetuneExportRouter = express.Router();

// JSONL-Nutzdaten liegen NICHT in job.result, weil der generische Status-GET
// (/jobs/:id) die gesamte result-Struktur serialisiert — bei einem grossen Buch
// wären das Megabytes pro Poll. Stattdessen: eigener Store, TTL analog zur
// Job-Cleanup (2 h nach Abschluss, siehe shared.js:_scheduleJobCleanup).
const JSONL_TTL_MS = 2 * 60 * 60 * 1000;
const finetuneResultStore = new Map();
function storeFinetuneResult(jobId, payload) {
  finetuneResultStore.set(jobId, payload);
  const t = setTimeout(() => finetuneResultStore.delete(jobId), JSONL_TTL_MS);
  t.unref?.();
}

function hashSplit(id, seed) {
  const h = createHash('sha1').update(String(seed || 0) + '|' + id).digest();
  return ((h[0] << 8) | h[1]) / 0xffff;
}

function splitParagraphs(text) {
  return text.split(/\n\s*\n+/).map(p => p.trim()).filter(Boolean);
}

// Zerlegt Fliesstext in Sätze. Heuristik: Satzende = [.!?…], optional gefolgt
// von schliessender Anführungszeichen, dann Whitespace oder EOT. Hängt den
// Schlussrest (ohne Satzzeichen-Ende) als eigenen Satz an. Für deutsche und
// englische Prosa ausreichend zuverlässig; keine Abkürzungs-Erkennung.
function splitSentences(text) {
  const out = [];
  const re = /([.!?…]+[”"«»„"']?)(\s+|$)/g;
  let lastEnd = 0, m;
  while ((m = re.exec(text)) !== null) {
    const sentence = text.slice(lastEnd, m.index + m[1].length).trim();
    if (sentence) out.push(sentence);
    lastEnd = m.index + m[0].length;
  }
  const tail = text.slice(lastEnd).trim();
  if (tail) out.push(tail);
  return out;
}

// Splittet `text` nahe `ratio` (0–1) an einer Satzgrenze. Sucht zuerst rückwärts
// vom Zielindex nach dem letzten Satzende, fällt dann vorwärts zurück.
function splitAtSentence(text, ratio) {
  const target = Math.max(1, Math.min(text.length - 1, Math.floor(text.length * ratio)));
  const head = text.slice(0, target);
  const tail = text.slice(target);
  const lastStop = head.search(/[.!?…][”"«»„"']?\s+[A-ZÄÖÜ"„«][^.!?…]*$/);
  if (lastStop !== -1) {
    const after = head.slice(lastStop).search(/\s/);
    if (after !== -1) {
      const idx = lastStop + after + 1;
      return [text.slice(0, idx).trim(), text.slice(idx).trim()];
    }
  }
  const nextStop = tail.search(/[.!?…][”"«»„"']?\s+[A-ZÄÖÜ"„«]/);
  if (nextStop !== -1) {
    const idx = target + nextStop + 1;
    return [text.slice(0, idx + 1).trim(), text.slice(idx + 1).trim()];
  }
  return [head.trim(), tail.trim()];
}
const splitHalfAtSentence = (text) => splitAtSentence(text, 0.5);

// Dialog-Zitate (DE + EN-Typografie + ASCII). Bewusst konservativ — matched nur
// Zitate innerhalb eines Absatzes (keine Zeilenumbrüche), damit keine
// mehrseitigen False-Positives entstehen.
function extractDialogs(text) {
  const results = [];
  const patterns = [
    /„([^"\n]{10,400})"/g,
    /"([^"\n]{10,400})"/g,     // U+201C/U+201D
    /«\s?([^»\n]{10,400})\s?»/g,
    /"([^"\n]{10,400})"/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      results.push({ quote: m[1].trim(), start: m.index, end: m.index + m[0].length });
    }
  }
  results.sort((a, b) => a.start - b.start);
  return results;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function findSpeaker(text, quoteStart, quoteEnd, figureNames) {
  const ctx = text.slice(Math.max(0, quoteStart - 120), quoteStart)
    + ' ' + text.slice(quoteEnd, quoteEnd + 120);
  for (const name of figureNames) {
    const re = new RegExp('\\b' + escapeRe(name) + '\\b', 'i');
    if (re.test(ctx)) return name;
  }
  return null;
}

async function runFinetuneExportJob(jobId, bookId, bookName, userEmail, userToken, opts) {
  const logger = makeJobLogger(jobId);
  try {
    logger.info(`Start Finetune-Export «${bookName}» (book=${bookId}, types=${Object.entries(opts.types).filter(([,v]) => v).map(([k]) => k).join(',')})`);
    updateJob(jobId, { statusText: 'job.phase.loadingPages', progress: 0 });
    const [chaptersData, pages] = await Promise.all([
      bsGetAll('chapters?filter[book_id]=' + bookId, userToken),
      bsGetAll('pages?filter[book_id]=' + bookId, userToken),
    ]);
    if (!pages.length) { completeJob(jobId, { empty: true }); return; }

    const chMap = Object.fromEntries(chaptersData.map(c => [c.id, c.name]));
    const pageContents = await loadPageContents(pages, chMap, 30, (i, total) => {
      updateJob(jobId, {
        progress: Math.round((i / total) * 40),
        statusText: 'job.phase.readingPages',
        statusParams: { from: i + 1, to: Math.min(i + BATCH_SIZE, total), total },
      });
    }, userToken, jobAbortControllers.get(jobId)?.signal);

    updateJob(jobId, { progress: 45, statusText: 'finetune.phase.loadMetadata' });

    const bookIdInt = parseInt(bookId);
    const settings = getBookSettings(bookIdInt, userEmail);
    const langIsEn = (settings.language || 'de') === 'en';

    const figRows = db.prepare(`
      SELECT f.fig_id, f.id AS pk, f.name, f.kurzname, f.typ, f.beschreibung, f.beruf, f.geschlecht,
             GROUP_CONCAT(DISTINCT ft.tag) AS tags_csv
      FROM figures f
      LEFT JOIN figure_tags ft ON ft.figure_id = f.id
      WHERE f.book_id = ? AND f.user_email = ?
      GROUP BY f.id
      ORDER BY f.sort_order
    `).all(bookIdInt, userEmail);
    const figById = new Map(figRows.map(f => [f.fig_id, f]));
    const figNamesSorted = [...new Set(
      figRows.flatMap(f => [f.name, f.kurzname].filter(n => n && String(n).trim().length >= 2))
    )].sort((a, b) => b.length - a.length);

    const locRows = db.prepare(`
      SELECT id AS pk, loc_id, name, typ, beschreibung, erste_erwaehnung, stimmung
      FROM locations
      WHERE book_id = ? AND (user_email = ? OR (? IS NULL AND user_email IS NULL))
      ORDER BY sort_order
    `).all(bookIdInt, userEmail, userEmail);
    const locById = new Map(locRows.map(l => [l.loc_id, l]));

    // ── Relationen zwischen Figuren/Orten/Kapiteln/Szenen ─────────────────
    // Alle als Maps für O(1)-Lookup. Werden im authorChat- und scene-Block
    // verwendet, um reiche, kontextualisierte Antworten aufzubauen.
    const locChaptersRows = db.prepare(`
      SELECT lc.location_id, lc.chapter_name, lc.haeufigkeit
      FROM location_chapters lc
      JOIN locations l ON l.id = lc.location_id
      WHERE l.book_id = ? AND (l.user_email = ? OR (? IS NULL AND l.user_email IS NULL))
      ORDER BY lc.haeufigkeit DESC, lc.chapter_name
    `).all(bookIdInt, userEmail, userEmail);
    const chaptersByLocPk = new Map();
    for (const r of locChaptersRows) {
      if (!chaptersByLocPk.has(r.location_id)) chaptersByLocPk.set(r.location_id, []);
      chaptersByLocPk.get(r.location_id).push(r.chapter_name);
    }
    const locFigRows = db.prepare(`
      SELECT lf.location_id, lf.fig_id
      FROM location_figures lf
      JOIN locations l ON l.id = lf.location_id
      WHERE l.book_id = ? AND (l.user_email = ? OR (? IS NULL AND l.user_email IS NULL))
    `).all(bookIdInt, userEmail, userEmail);
    const figsByLocPk = new Map();
    for (const r of locFigRows) {
      if (!figsByLocPk.has(r.location_id)) figsByLocPk.set(r.location_id, []);
      figsByLocPk.get(r.location_id).push(r.fig_id);
    }
    const locPkByLocId = new Map(locRows.map(l => [l.loc_id, l.pk]));
    const sceneLocRows = db.prepare(
      'SELECT sl.scene_id, l.loc_id FROM scene_locations sl JOIN locations l ON l.id = sl.location_id JOIN figure_scenes fs ON fs.id = sl.scene_id WHERE fs.book_id = ? AND fs.user_email = ?'
    ).all(bookIdInt, userEmail);
    const scenesByLocPk = new Map();
    for (const r of sceneLocRows) {
      const locPk = locPkByLocId.get(r.loc_id);
      if (locPk == null) continue;
      if (!scenesByLocPk.has(locPk)) scenesByLocPk.set(locPk, []);
      scenesByLocPk.get(locPk).push(r.scene_id);
    }

    // Figuren-Auftritte (Kapitel-Liste pro Figur)
    const figAppRows = db.prepare(`
      SELECT fa.figure_id, fa.chapter_name, fa.haeufigkeit
      FROM figure_appearances fa
      JOIN figures f ON f.id = fa.figure_id
      WHERE f.book_id = ? AND f.user_email = ?
      ORDER BY fa.haeufigkeit DESC, fa.chapter_name
    `).all(bookIdInt, userEmail);
    const appearancesByFigPk = new Map();
    for (const r of figAppRows) {
      if (!appearancesByFigPk.has(r.figure_id)) appearancesByFigPk.set(r.figure_id, []);
      appearancesByFigPk.get(r.figure_id).push(r.chapter_name);
    }

    // Figuren-Lebensereignisse
    const figEvtRows = db.prepare(`
      SELECT fe.figure_id, fe.datum, fe.ereignis, fe.bedeutung, fe.typ
      FROM figure_events fe
      JOIN figures f ON f.id = fe.figure_id
      WHERE f.book_id = ? AND f.user_email = ?
      ORDER BY fe.sort_order
    `).all(bookIdInt, userEmail);
    const eventsByFigPk = new Map();
    for (const r of figEvtRows) {
      if (!eventsByFigPk.has(r.figure_id)) eventsByFigPk.set(r.figure_id, []);
      eventsByFigPk.get(r.figure_id).push({ datum: r.datum, ereignis: r.ereignis, bedeutung: r.bedeutung, typ: r.typ });
    }

    // Figur-Beziehungen (beide Richtungen abrufen, Paare per Smaller-First dedupen)
    const figRelRows = db.prepare(`
      SELECT from_fig_id, to_fig_id, typ, beschreibung
      FROM figure_relations
      WHERE book_id = ? AND user_email = ?
    `).all(bookIdInt, userEmail);

    // Kapitel-Extract-Cache: pro Kapitel liegen Fakten, Figuren, Orte, Szenen.
    // Fakten-Array ist die grösste bisher ungenutzte Quelle feiner Buchwelt-
    // Behauptungen (pro Kapitel bis 50 Einträge mit subjekt/fakt/seite).
    const extractCacheRows = db.prepare(`
      SELECT chapter_key, extract_json
      FROM chapter_extract_cache
      WHERE book_id = ? AND user_email = ?
    `).all(bookIdInt, userEmail || '');

    // Dialog-Sammlung pro Figur (wird im dialog-Block gefüllt; hier als
    // Vorbelegung, damit der authorChat-Block die Ergebnisse wiederverwenden
    // kann, auch wenn dialog selbst nicht aktiviert ist). Strukturierte
    // Einträge { quote, chapter, page } für Reverse-Lookup-Samples.
    const dialogsByFigure = new Map(); // name (lowercase) → [{quote,chapter,page}]

    // Seiten-Index nach Titel (für grounded Samples + Fakten-Auflösung).
    const pageByTitle = new Map();
    for (const p of pageContents) pageByTitle.set(p.title, p);

    // ── Kapitel-Strukturen (Ordering + Aggregat-Text) ─────────────────────
    // Kapitel-Reihenfolge bestimmt sich aus der Dokument-Reihenfolge (erste
    // Seite des Kapitels in pageContents = Kapitel-Index). Für Bücher ohne
    // ungruppierte Seiten praktisch immer korrekt.
    const chapterFirstPageIdx = new Map();
    pageContents.forEach((p, i) => {
      const k = p.chapter_id ?? 0;
      if (!chapterFirstPageIdx.has(k)) chapterFirstPageIdx.set(k, i);
    });
    const chapterOrder = [...chapterFirstPageIdx.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([k]) => k);
    const chapterKeys = chapterOrder; // 0 = ungrouped
    const pagesByChapter = new Map();
    for (const p of pageContents) {
      const k = p.chapter_id ?? 0;
      if (!pagesByChapter.has(k)) pagesByChapter.set(k, []);
      pagesByChapter.get(k).push(p);
    }
    const chapterFullTextByKey = new Map();
    const chapterNameByKey = new Map();
    for (const k of chapterKeys) {
      const pages = pagesByChapter.get(k) || [];
      chapterFullTextByKey.set(k, pages.map(p => p.text).join('\n\n'));
      chapterNameByKey.set(k, pages[0]?.chapter || (k === 0 ? (langIsEn ? 'Unassigned pages' : 'Sonstige Seiten') : `Kapitel ${k}`));
    }

    const sceneRows = db.prepare(`
      SELECT id, kapitel, seite, titel, wertung, kommentar, chapter_id, page_id
      FROM figure_scenes WHERE book_id = ? AND user_email = ?
      ORDER BY sort_order
    `).all(bookIdInt, userEmail);
    const sceneFigRows = db.prepare(
      'SELECT sf.scene_id, sf.fig_id FROM scene_figures sf JOIN figure_scenes fs ON fs.id = sf.scene_id WHERE fs.book_id = ? AND fs.user_email = ?'
    ).all(bookIdInt, userEmail);
    const figsByScene = new Map();
    for (const r of sceneFigRows) {
      if (!figsByScene.has(r.scene_id)) figsByScene.set(r.scene_id, []);
      figsByScene.get(r.scene_id).push(r.fig_id);
    }
    const locsByScene = new Map();
    for (const r of sceneLocRows) {
      if (!locsByScene.has(r.scene_id)) locsByScene.set(r.scene_id, []);
      locsByScene.get(r.scene_id).push(r.loc_id);
    }
    const pageTextById = new Map(pageContents.map(p => [p.id, p.text]));
    const pageChapterById = new Map(pageContents.map(p => [p.id, p.chapter || '']));

    const minChars = Math.max(80, opts.minChars | 0);
    const maxChars = Math.max(minChars + 100, opts.maxChars | 0);
    const valSplit = Math.max(0, Math.min(0.5, Number.isFinite(opts.valSplit) ? opts.valSplit : 0.1));
    const seed = Number.isFinite(opts.valSeed) ? opts.valSeed : 0;

    const samples = [];
    let styleCount = 0, sceneCount = 0, dialogCount = 0, authorChatCount = 0, correctionCount = 0;

    if (opts.types.style) {
      updateJob(jobId, { progress: 55, statusText: 'finetune.phase.style' });
      const sys = langIsEn
        ? "You are a literary assistant writing in the author's style."
        : 'Du bist ein literarischer Assistent und schreibst im Stil des Autors.';
      const prefix = langIsEn
        ? "Continue the following passage in the author's style:\n\n"
        : 'Setze den folgenden Abschnitt im Stil des Autors fort:\n\n';
      const contextPrefix = langIsEn
        ? "Given this passage, continue in the author's style. Write only the next paragraph:\n\n"
        : 'Setze den folgenden Abschnitt fort. Schreibe nur den nächsten Absatz im Stil des Autors:\n\n';

      // Split-Ratios pro Absatz: 50/50 ist das stärkste Signal (Haupt-Sample),
      // 25/75 und 75/25 ergänzen als augmentierte Varianten (Training-Volumen
      // ×3 bei gleichem Ausgangsmaterial). Verhindert dass das Modell nur
      // „halbierte" Prompt-Länge als Stil-Fortsetzung kennt.
      const splitRatios = [0.50, 0.25, 0.75];

      for (const p of pageContents) {
        const paragraphs = splitParagraphs(p.text);

        // ── Intra-Absatz-Splits (Sliding-Windows) ─────────────────────────
        for (let pi = 0; pi < paragraphs.length; pi++) {
          const para = paragraphs[pi];
          if (para.length < minChars) continue;
          const clipped = para.length > maxChars ? para.slice(0, maxChars) : para;
          for (let ri = 0; ri < splitRatios.length; ri++) {
            const [first, second] = splitAtSentence(clipped, splitRatios[ri]);
            if (first.length < 60 || second.length < 60) continue;
            samples.push({
              id: 'style|' + p.id + '|' + pi + '|r' + ri,
              type: 'style',
              messages: [
                { role: 'system', content: sys },
                { role: 'user', content: prefix + first },
                { role: 'assistant', content: second },
              ],
            });
            styleCount++;
          }
        }

        // ── Multi-Absatz-Kontext (Langstrecken-Kohärenz) ──────────────────
        // Prompt = vorhergehende 1–3 Absätze, Completion = nächster Absatz.
        // Teaches long-range coherence so dass Fortsetzungen über Absätze
        // hinweg klingen wie der Autor. Überspringt Einträge, wenn der
        // Prompt-Kontext zu kurz oder zu lang ist.
        const CTX_MAX_PROMPT = Math.floor(maxChars * 2);
        for (let i = 1; i < paragraphs.length; i++) {
          const next = paragraphs[i];
          if (next.length < minChars) continue;
          const ctxStart = Math.max(0, i - 3);
          const context = paragraphs.slice(ctxStart, i).join('\n\n');
          if (context.length < 200) continue;
          const ctxClipped = context.length > CTX_MAX_PROMPT
            ? context.slice(context.length - CTX_MAX_PROMPT)
            : context;
          const completion = next.length > maxChars ? next.slice(0, maxChars) : next;
          if (completion.length < 80) continue;
          samples.push({
            id: 'styleCtx|' + p.id + '|' + i,
            type: 'style',
            messages: [
              { role: 'system', content: sys },
              { role: 'user', content: contextPrefix + ctxClipped },
              { role: 'assistant', content: completion },
            ],
          });
          styleCount++;
        }

        // ── Satz-Level-Fortsetzung (#1) ───────────────────────────────────
        // Feinstes Kontinuitäts-Signal: pro Satz Kontext (1–2 vorherige Sätze)
        // → nächster Satz. Limit pro Seite, damit einzelne lange Seiten nicht
        // den Trainings-Pool dominieren. Nur Sätze 40–300 Zeichen (Rauschen raus).
        const SENT_CAP_PER_PAGE = 40;
        const sentSys = langIsEn
          ? "You continue the author's prose sentence by sentence."
          : 'Du setzt die Prosa des Autors Satz für Satz fort.';
        const sentPrefix = langIsEn ? 'Next sentence after:\n\n' : 'Nächster Satz nach:\n\n';
        const pageSentences = paragraphs.flatMap(splitSentences);
        let sentEmit = 0;
        for (let i = 1; i < pageSentences.length && sentEmit < SENT_CAP_PER_PAGE; i++) {
          const cur = pageSentences[i];
          if (cur.length < 40 || cur.length > 300) continue;
          const prev = pageSentences.slice(Math.max(0, i - 2), i).join(' ');
          if (prev.length < 30) continue;
          samples.push({
            id: 'styleSent|' + p.id + '|' + i,
            type: 'style',
            messages: [
              { role: 'system', content: sentSys },
              { role: 'user',   content: sentPrefix + prev },
              { role: 'assistant', content: cur },
            ],
          });
          styleCount++;
          sentEmit++;
        }
      }

      // ── Kapitel-Transitions (#2) ────────────────────────────────────────
      // Ende Kapitel N → Anfang Kapitel N+1. Zentrales Signal für das „wie
      // beginne ich ein neues Kapitel"-Gefühl — genau das, was fürs
      // Fortsetzungs-Schreiben gebraucht wird.
      const transSys = langIsEn
        ? "You continue the book across chapter boundaries in the author's voice."
        : 'Du setzt das Buch über Kapitel-Grenzen hinweg im Stil des Autors fort.';
      for (let i = 0; i + 1 < chapterKeys.length; i++) {
        const kA = chapterKeys[i];
        const kB = chapterKeys[i + 1];
        const textA = chapterFullTextByKey.get(kA) || '';
        const textB = chapterFullTextByKey.get(kB) || '';
        if (textA.length < 400 || textB.length < 400) continue;
        const tailA = splitAtSentence(textA.slice(-Math.min(textA.length, 1200)), 0.2)[1] || textA.slice(-600);
        const headB = splitAtSentence(textB.slice(0, Math.min(textB.length, 1200)), 0.8)[0] || textB.slice(0, 600);
        if (tailA.length < 120 || headB.length < 120) continue;
        const nameA = chapterNameByKey.get(kA);
        const nameB = chapterNameByKey.get(kB);
        const prompt = (langIsEn
          ? `End of chapter «${nameA}»:\n\n`
          : `Ende von Kapitel «${nameA}»:\n\n`)
          + tailA
          + (langIsEn
            ? `\n\nNow begin chapter «${nameB}» in the same voice:`
            : `\n\nBeginne nun Kapitel «${nameB}» im selben Ton:`);
        samples.push({
          id: 'chapTrans|' + kA + '|' + kB,
          type: 'style',
          messages: [
            { role: 'system', content: transSys },
            { role: 'user',   content: prompt },
            { role: 'assistant', content: headB.length > maxChars ? headB.slice(0, maxChars) : headB },
          ],
        });
        styleCount++;
      }

      // ── Szenen-Transitions (#3) ────────────────────────────────────────
      // Ende einer Szene → Anfang der nächsten. Nutzt sceneRows-Reihenfolge
      // pro Kapitel; beide Szenen müssen einen page_id-Mapping haben, sonst
      // kein Text zum Anknüpfen.
      const scnTransSys = langIsEn
        ? "You transition from one scene to the next in the author's voice."
        : 'Du gehst von einer Szene zur nächsten im Stil des Autors über.';
      const sceneByChapterKey = new Map();
      for (const s of sceneRows) {
        if (!s.page_id) continue;
        const k = s.chapter_id ?? 0;
        if (!sceneByChapterKey.has(k)) sceneByChapterKey.set(k, []);
        sceneByChapterKey.get(k).push(s);
      }
      for (const [, scenesInCh] of sceneByChapterKey) {
        for (let i = 0; i + 1 < scenesInCh.length; i++) {
          const sA = scenesInCh[i], sB = scenesInCh[i + 1];
          const txtA = pageTextById.get(sA.page_id) || '';
          const txtB = pageTextById.get(sB.page_id) || '';
          if (txtA.length < 200 || txtB.length < 200) continue;
          if (sA.page_id === sB.page_id) continue;
          const tailA = txtA.slice(-Math.min(txtA.length, 800));
          const headB = txtB.slice(0, Math.min(txtB.length, 800));
          const prompt = (langIsEn
            ? `End of scene «${sA.titel || ''}»:\n\n${tailA}\n\nContinue with scene «${sB.titel || ''}»:`
            : `Ende der Szene «${sA.titel || ''}»:\n\n${tailA}\n\nFahre fort mit der Szene «${sB.titel || ''}»:`);
          samples.push({
            id: 'scnTrans|' + sA.id + '|' + sB.id,
            type: 'style',
            messages: [
              { role: 'system', content: scnTransSys },
              { role: 'user',   content: prompt },
              { role: 'assistant', content: headB },
            ],
          });
          styleCount++;
        }
      }

      // ── Kapitel-Level-Sliding-Windows (#5) ──────────────────────────────
      // Alle Absätze eines Kapitels als durchgängiger Stream — Sliding mit
      // Fenster 3 (Kontext) → 1 (Completion). Verbindet sich über Seitengrenzen
      // hinweg, anders als der page-lokale Multi-Absatz-Kontext oben.
      const chapWinSys = sys;
      const chapWinPrefix = contextPrefix;
      for (const k of chapterKeys) {
        const pages = pagesByChapter.get(k) || [];
        if (pages.length < 2) continue;
        const allParas = pages.flatMap(pp => splitParagraphs(pp.text));
        if (allParas.length < 4) continue;
        const WIN = 3;
        const STRIDE = 2; // jedes zweite Absatz-Target: reduziert Duplikation mit dem page-lokalen Block
        for (let i = WIN; i < allParas.length; i += STRIDE) {
          const next = allParas[i];
          if (next.length < minChars) continue;
          const context = allParas.slice(i - WIN, i).join('\n\n');
          if (context.length < 300) continue;
          const ctxClipped = context.length > Math.floor(maxChars * 2)
            ? context.slice(context.length - Math.floor(maxChars * 2))
            : context;
          const completion = next.length > maxChars ? next.slice(0, maxChars) : next;
          if (completion.length < 80) continue;
          samples.push({
            id: 'chapWin|' + k + '|' + i,
            type: 'style',
            messages: [
              { role: 'system', content: chapWinSys },
              { role: 'user',   content: chapWinPrefix + ctxClipped },
              { role: 'assistant', content: completion },
            ],
          });
          styleCount++;
        }
      }
    }

    if (opts.types.scene) {
      updateJob(jobId, { progress: 70, statusText: 'finetune.phase.scene' });
      const scenesByPageId = new Map();
      for (const s of sceneRows) {
        if (!s.page_id) continue;
        if (!scenesByPageId.has(s.page_id)) scenesByPageId.set(s.page_id, []);
        scenesByPageId.get(s.page_id).push(s);
      }
      const sys = langIsEn
        ? "You write literary scenes matching the given metadata in the author's style."
        : 'Du schreibst literarische Szenen im Stil des Autors, passend zu den angegebenen Metadaten.';
      for (const [pageId, scenes] of scenesByPageId) {
        const txt = pageTextById.get(pageId);
        if (!txt || txt.length < minChars) continue;
        const completion = txt.length > maxChars ? txt.slice(0, maxChars) : txt;
        const meta = [];
        const titel = [...new Set(scenes.map(s => s.titel).filter(Boolean))].join(' / ');
        if (titel) meta.push((langIsEn ? 'Title: ' : 'Titel: ') + titel);
        const kapitel = scenes[0].kapitel || pageChapterById.get(pageId);
        if (kapitel) meta.push((langIsEn ? 'Chapter: ' : 'Kapitel: ') + kapitel);
        const figIds = [...new Set(scenes.flatMap(s => figsByScene.get(s.id) || []))];
        const figNames = figIds.map(id => figById.get(id)?.name).filter(Boolean);
        if (figNames.length) meta.push((langIsEn ? 'Characters: ' : 'Figuren: ') + figNames.join(', '));
        const locIds = [...new Set(scenes.flatMap(s => locsByScene.get(s.id) || []))];
        const locNames = locIds.map(id => locById.get(id)?.name).filter(Boolean);
        if (locNames.length) meta.push((langIsEn ? 'Location: ' : 'Schauplatz: ') + locNames.join(', '));
        const comments = [...new Set(scenes.map(s => s.kommentar).filter(Boolean))].join(' ');
        if (comments) meta.push((langIsEn ? 'Notes: ' : 'Notiz: ') + comments);
        if (meta.length === 0) continue;
        const instr = (langIsEn
          ? 'Write a scene with the following parameters:\n'
          : 'Schreibe eine Szene mit folgenden Vorgaben:\n') + meta.join('\n');
        samples.push({
          id: 'scene|' + pageId,
          type: 'scene',
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content: instr },
            { role: 'assistant', content: completion },
          ],
        });
        sceneCount++;
      }

      // ── Alle Seiten als Meta→Text (unabhängig vom Scene-Mapping) ─────────
      // Der User will den gesamten Buchinhalt internalisiert — jede Seite
      // erhält ein Sample „Seite «X», Kapitel «Y»: schreibe den Inhalt" →
      // Seitentext. Das doppelt sich bewusst mit dem Szenen-Block (dort
      // metadaten-reicher), hier einfacher und vollständig deckend.
      const pageSys = langIsEn
        ? "You reproduce pages from this book accurately and in the author's style."
        : 'Du gibst Seiten aus diesem Buch akkurat und im Stil des Autors wieder.';
      const pageSysCont = langIsEn
        ? "You continue the book from the given starting point in the author's style."
        : 'Du setzt das Buch ab der angegebenen Stelle im Stil des Autors fort.';
      for (const p of pageContents) {
        if (!p.text || p.text.length < minChars) continue;
        const completion = p.text.length > maxChars ? p.text.slice(0, maxChars) : p.text;
        const metaParts = [];
        if (bookName) metaParts.push(langIsEn ? `Book: «${bookName}»` : `Buch: «${bookName}»`);
        if (p.chapter) metaParts.push(langIsEn ? `Chapter: «${p.chapter}»` : `Kapitel: «${p.chapter}»`);
        if (p.title)   metaParts.push(langIsEn ? `Page: «${p.title}»` : `Seite: «${p.title}»`);
        const instr = (langIsEn
          ? 'Write the content of this page:\n'
          : 'Schreibe den Inhalt dieser Seite:\n') + metaParts.join('\n');
        samples.push({
          id: 'page|' + p.id,
          type: 'scene',
          messages: [
            { role: 'system', content: pageSys },
            { role: 'user', content: instr },
            { role: 'assistant', content: completion },
          ],
        });
        sceneCount++;

        // ── Page-Fortsetzung: erste 15% als Prompt → Rest als Completion.
        // Lehrt das Modell, von einer Anfangsszene aus weiterzuschreiben,
        // was für die Fortsetzungs-Fähigkeit des fertigen Modells zentral ist.
        if (p.text.length >= minChars * 2) {
          const [opening, rest] = splitAtSentence(completion, 0.15);
          if (opening.length >= 80 && rest.length >= 120) {
            const prefix = metaParts.length
              ? metaParts.join(' · ') + '\n\n'
              : '';
            samples.push({
              id: 'pageCont|' + p.id,
              type: 'scene',
              messages: [
                { role: 'system', content: pageSysCont },
                { role: 'user', content: (langIsEn
                  ? 'Continue this passage:\n\n'
                  : 'Setze diese Passage fort:\n\n') + prefix + opening },
                { role: 'assistant', content: rest },
              ],
            });
            sceneCount++;
          }
        }
      }

      // ── Kapitel-Anfänge mit vollem Metadaten-Kontext (#4) ────────────────
      // Pro Kapitel: Prompt kombiniert Kapitelname + Figuren (aus
      // figure_appearances), Orte (aus location_chapters), Kurz-Zusammenfassung
      // (aus chapter_reviews) + Vorgänger-Ausklang → Completion = erste
      // 3000 Zeichen des Kapitels. Lehrt, wie Kapitel in genau diesem Buch
      // begonnen werden, mit welcher Besetzung und Stimmung.
      const chapterReviewMap = new Map();
      try {
        const crRows = db.prepare(`
          SELECT cr1.chapter_name, cr1.review_json
          FROM chapter_reviews cr1
          WHERE cr1.book_id = ? AND cr1.user_email = ?
            AND cr1.reviewed_at = (
              SELECT MAX(cr2.reviewed_at) FROM chapter_reviews cr2
              WHERE cr2.book_id = cr1.book_id AND cr2.chapter_id = cr1.chapter_id AND cr2.user_email = cr1.user_email
            )
        `).all(bookIdInt, userEmail);
        for (const r of crRows) {
          if (!r.chapter_name || !r.review_json) continue;
          try {
            const cr = JSON.parse(r.review_json);
            if (cr?.zusammenfassung) chapterReviewMap.set(r.chapter_name, cr.zusammenfassung);
          } catch { /* ignore */ }
        }
      } catch { /* chapter_reviews optional */ }

      // figures per chapter via figure_appearances.chapter_name
      const figsByChName = new Map();
      for (const f of figRows) {
        for (const ch of (appearancesByFigPk.get(f.pk) || [])) {
          if (!figsByChName.has(ch)) figsByChName.set(ch, []);
          figsByChName.get(ch).push(f.name);
        }
      }
      // locations per chapter via location_chapters
      const locsByChName = new Map();
      for (const l of locRows) {
        for (const ch of (chaptersByLocPk.get(l.pk) || [])) {
          if (!locsByChName.has(ch)) locsByChName.set(ch, []);
          locsByChName.get(ch).push(l.name);
        }
      }

      const chapOpenSys = langIsEn
        ? "You begin a chapter of this book in the author's voice, matching the given cast and setting."
        : 'Du beginnst ein Kapitel dieses Buchs im Stil des Autors, passend zur angegebenen Besetzung und Szenerie.';
      for (let ci = 0; ci < chapterKeys.length; ci++) {
        const k = chapterKeys[ci];
        const text = chapterFullTextByKey.get(k) || '';
        if (text.length < 400) continue;
        const name = chapterNameByKey.get(k);
        const opening = text.slice(0, Math.min(3000, maxChars, text.length));
        if (opening.length < 200) continue;
        const metaLines = [];
        if (bookName) metaLines.push(langIsEn ? `Book: «${bookName}»` : `Buch: «${bookName}»`);
        metaLines.push(langIsEn ? `Chapter: «${name}»` : `Kapitel: «${name}»`);
        const chFigs = (figsByChName.get(name) || []).slice(0, 10);
        if (chFigs.length) metaLines.push(langIsEn ? `Cast: ${chFigs.join(', ')}` : `Figuren: ${chFigs.join(', ')}`);
        const chLocs = (locsByChName.get(name) || []).slice(0, 6);
        if (chLocs.length) metaLines.push(langIsEn ? `Settings: ${chLocs.join(', ')}` : `Schauplätze: ${chLocs.join(', ')}`);
        const summary = chapterReviewMap.get(name);
        if (summary) metaLines.push(langIsEn ? `Summary: ${summary}` : `Inhalt: ${summary}`);
        // Vorgänger-Ausklang: letzte 400 Zeichen des vorherigen Kapitels
        if (ci > 0) {
          const prevText = chapterFullTextByKey.get(chapterKeys[ci - 1]) || '';
          if (prevText.length > 200) {
            const prevTail = prevText.slice(-400).trim();
            metaLines.push((langIsEn
              ? `Previous chapter ended with: `
              : `Vorheriges Kapitel endete mit: `) + prevTail);
          }
        }
        const instr = (langIsEn
          ? 'Begin this chapter in the author\'s style:\n'
          : 'Beginne dieses Kapitel im Stil des Autors:\n') + metaLines.join('\n');
        samples.push({
          id: 'chapOpen|' + k,
          type: 'scene',
          messages: [
            { role: 'system', content: chapOpenSys },
            { role: 'user',   content: instr },
            { role: 'assistant', content: opening },
          ],
        });
        sceneCount++;
      }
    }

    // Dialog-Sammlung läuft immer, wenn Figuren bekannt sind — `dialogsByFigure`
    // füttert auch den authorChat-Block (Zitatsammlung pro Figur). Der eigentliche
    // dialog-Typ ist davon unabhängig per Checkbox steuerbar.
    if (figNamesSorted.length) {
      if (opts.types.dialog) {
        updateJob(jobId, { progress: 85, statusText: 'finetune.phase.dialog' });
      }
      const sys = langIsEn
        ? "You write dialogue lines for the given character in the author's voice."
        : 'Du schreibst Dialogzeilen für die jeweilige Figur im Ton des Autors.';
      for (const p of pageContents) {
        const dlgs = extractDialogs(p.text);
        for (const d of dlgs) {
          if (d.quote.length < 10 || d.quote.length > 400) continue;
          const speaker = findSpeaker(p.text, d.start, d.end, figNamesSorted);
          if (!speaker) continue;
          const spkKey = speaker.toLowerCase();
          if (!dialogsByFigure.has(spkKey)) dialogsByFigure.set(spkKey, []);
          dialogsByFigure.get(spkKey).push({ quote: d.quote, chapter: p.chapter, page: p.title });
          if (!opts.types.dialog) continue;
          const ctxBefore = p.text.slice(Math.max(0, d.start - 160), d.start).replace(/\s+/g, ' ').trim();
          const ctx = (ctxBefore.slice(-140) || p.chapter || bookName).trim();
          const userPart = langIsEn
            ? `Write a dialogue line for ${speaker}. Context: ${ctx}`
            : `Schreibe eine Dialogzeile für ${speaker}. Kontext: ${ctx}`;
          samples.push({
            id: 'dialog|' + p.id + '|' + d.start,
            type: 'dialog',
            messages: [
              { role: 'system', content: sys },
              { role: 'user', content: userPart },
              { role: 'assistant', content: d.quote },
            ],
          });
          dialogCount++;
        }
      }

      // ── Reverse Dialog: «Welche Figur sagt ...?» (#6) ────────────────────
      // Sobald Dialog-Extraktion gelaufen ist, existieren eindeutig
      // speaker-zugeordnete Zitate in dialogsByFigure. Reverse-Sample erzeugt
      // Speaker-Lookup-Fähigkeit: gegeben ein Zitat → Figur zurückgeben. Pro
      // Figur cap bei 12 Zitaten, damit stark sprechende Figuren nicht das
      // Training dominieren.
      if (opts.types.dialog) {
        const reverseSys = langIsEn
          ? "You identify which character in this book says a given line."
          : 'Du erkennst, welche Figur in diesem Buch einen gegebenen Satz sagt.';
        const REV_CAP_PER_FIG = 12;
        for (const f of figRows) {
          const entries = dialogsByFigure.get(f.name.toLowerCase()) || [];
          const altEntries = (f.kurzname && f.kurzname !== f.name)
            ? (dialogsByFigure.get(f.kurzname.toLowerCase()) || [])
            : [];
          const seenQ = new Set();
          let emitted = 0;
          for (const e of [...entries, ...altEntries]) {
            if (emitted >= REV_CAP_PER_FIG) break;
            if (seenQ.has(e.quote)) continue;
            seenQ.add(e.quote);
            if (e.quote.length < 20 || e.quote.length > 260) continue;
            const ctxTag = e.chapter
              ? (langIsEn ? ` (in «${e.chapter}»)` : ` (in «${e.chapter}»)`)
              : '';
            samples.push({
              id: 'dialogRev|' + f.fig_id + '|' + emitted,
              type: 'dialog',
              messages: [
                { role: 'system', content: reverseSys },
                { role: 'user',   content: (langIsEn
                  ? `Who says this: "${e.quote}"?`
                  : `Wer sagt das: „${e.quote}"?`) },
                { role: 'assistant', content: f.name + ctxTag + '.' },
              ],
            });
            dialogCount++;
            emitted++;
          }
        }
      }
    }

    if (opts.types.correction) {
      updateJob(jobId, { progress: 88, statusText: 'finetune.phase.correction' });
      const sys = langIsEn
        ? "You are an editor. Rewrite the given sentence in the author's voice — concise, precise, stylistically refined. Return only the improved version."
        : 'Du bist Lektor. Formuliere den Satz im Stil des Autors um — knapp, präzise, stilistisch geschliffen. Gib nur die verbesserte Fassung zurück.';
      const userPrefix    = langIsEn ? 'Improve: ' : 'Verbessere: ';
      const reasonedSys   = langIsEn
        ? "You are an editor. Rewrite the given sentence in the author's voice, then explain the change in one sentence."
        : 'Du bist Lektor. Formuliere den Satz im Stil des Autors um und erkläre die Änderung in einem Satz.';
      const reasonedUser  = langIsEn ? 'Improve and explain: ' : 'Verbessere und begründe: ';
      const reasonLabel   = langIsEn ? 'Reason: ' : 'Grund: ';

      // Neueste-First, damit bei mehrfach geprüften Seiten die aktuellste Korrektur
      // den Dedupe-Slot gewinnt (gleich-hashende Paare später ignoriert).
      const checkRows = db.prepare(`
        SELECT errors_json FROM page_checks
        WHERE book_id = ? AND user_email = ? AND errors_json IS NOT NULL AND error_count > 0
        ORDER BY checked_at DESC
      `).all(bookIdInt, userEmail);
      const seen = new Set();
      for (const row of checkRows) {
        let errs = null;
        try { errs = JSON.parse(row.errors_json); } catch { continue; }
        if (!Array.isArray(errs)) continue;
        for (const e of errs) {
          const orig = (e.original || '').trim();
          const korr = (e.korrektur || '').trim();
          if (orig.length < 8 || korr.length < 5) continue;
          if (orig.toLowerCase() === korr.toLowerCase()) continue;
          if (orig.length > maxChars || korr.length > maxChars) continue;
          const key = orig + '→' + korr;
          if (seen.has(key)) continue;
          seen.add(key);
          const idx = seen.size;
          // Base-Variante: nur verbesserter Satz als Antwort.
          samples.push({
            id: 'correction|a|' + idx,
            type: 'correction',
            messages: [
              { role: 'system', content: sys },
              { role: 'user',   content: userPrefix + orig },
              { role: 'assistant', content: korr },
            ],
          });
          correctionCount++;
          // Reasoned-Variante (nur wenn Begründung vorhanden): verbesserter Satz
          // + kurze Begründung. Trainiert ein Warum-Signal mit, ohne Basis-Antworten
          // mit Reasoning zu verwässern.
          const erkl = (e.erklaerung || '').trim();
          if (erkl.length >= 15 && erkl.length <= 400) {
            samples.push({
              id: 'correction|b|' + idx,
              type: 'correction',
              messages: [
                { role: 'system', content: reasonedSys },
                { role: 'user',   content: reasonedUser + orig },
                { role: 'assistant', content: korr + '\n\n' + reasonLabel + erkl },
              ],
            });
            correctionCount++;
          }
        }
      }
    }

    if (opts.types.authorChat) {
      updateJob(jobId, { progress: 90, statusText: 'finetune.phase.authorChat' });
      const displayName = bookName || (langIsEn ? 'this book' : 'diesem Buch');
      const sys = langIsEn
        ? `You are the author's voice for «${displayName}» answering a reader in conversation. Respond concisely, accurately, and in the spirit of the book.`
        : `Du bist die Stimme des Autors von «${displayName}» und antwortest einer Leserin im Gespräch. Antworte knapp, präzise und im Geist des Buchs.`;

      // Deterministische Auswahl einer Paraphrase pro Entity — bei gleichem Seed
      // reproduzierbar. `pickVariants` liefert `count` Indizes ohne Dubletten.
      const pickVariants = (id, variants, count) => {
        if (variants.length <= count) return variants.map((_, i) => i);
        const seen = new Set();
        const out = [];
        for (let i = 0; i < count * 4 && out.length < count; i++) {
          const v = Math.floor(hashSplit(id + '|' + i, seed) * variants.length);
          if (seen.has(v)) continue;
          seen.add(v);
          out.push(v);
        }
        return out;
      };

      // Mehr Fragevarianten = Modell lernt dieselbe Buchfakten über viele
      // Formulierungen hinweg assoziieren → schnellere Memorisierung der Welt.
      const figQuestions = langIsEn
        ? ['Who is {name}?', 'Tell me about {name}.', 'How would you describe {name}?',
           'What do I need to know about {name}?', 'What is {name} like?',
           "What's {name}'s story?", 'Give me a portrait of {name}.']
        : ['Wer ist {name}?', 'Erzähl mir von {name}.', 'Wie würdest du {name} beschreiben?',
           'Was sollte ich über {name} wissen?', 'Was für ein Mensch ist {name}?',
           'Was ist {name} für eine Figur?', 'Zeichne mir ein Bild von {name}.']
      ;
      const ortQuestions = langIsEn
        ? ['What is {name}?', 'Describe {name}.', 'What kind of place is {name}?',
           'How does {name} feel?', 'Tell me about {name}.',
           'What should I imagine when I hear {name}?']
        : ['Was ist {name}?', 'Beschreibe {name}.', 'Was für ein Ort ist {name}?',
           'Wie wirkt {name}?', 'Erzähl mir von {name}.',
           'Was soll ich mir unter {name} vorstellen?']
      ;
      const sceneQuestions = langIsEn
        ? ['What happens in «{titel}»?', 'Can you summarize the scene «{titel}»?',
           'What is «{titel}» about?', 'Tell me about the scene «{titel}».',
           "What's going on in «{titel}»?"]
        : ['Was passiert in «{titel}»?', 'Worum geht es in «{titel}»?',
           'Fasse die Szene «{titel}» zusammen.', 'Erzähl mir von der Szene «{titel}».',
           'Was spielt sich in «{titel}» ab?']
      ;
      const eventQuestions = langIsEn
        ? ['What happens around {ereignis}?', 'What is the significance of {ereignis}?',
           'Tell me about {ereignis}.', 'How does {ereignis} matter?']
        : ['Was weisst du über {ereignis}?', 'Welche Bedeutung hat {ereignis}?',
           'Erzähl mir von {ereignis}.', 'Warum ist {ereignis} wichtig?']
      ;
      const chapterQuestions = langIsEn
        ? ['What happens in «{kapitel}»?', 'Summarize «{kapitel}» for me.',
           'Walk me through «{kapitel}».', 'What is «{kapitel}» about?']
        : ['Was passiert in «{kapitel}»?', 'Fasse «{kapitel}» zusammen.',
           'Was geschieht im Kapitel «{kapitel}»?', 'Worum geht es in «{kapitel}»?']
      ;

      const pushQA = (id, q, a) => {
        const qq = (q || '').trim();
        const aa = (a || '').trim();
        if (qq.length < 4 || aa.length < 20) return;
        samples.push({
          id,
          type: 'authorChat',
          messages: [
            { role: 'system', content: sys },
            { role: 'user',   content: qq },
            { role: 'assistant', content: aa },
          ],
        });
        authorChatCount++;
      };

      // ── Figuren-Q&A ────────────────────────────────────────────────────────
      // Composite answer: beschreibung als Rückgrat + ein angehängter Satz zu
      // Beruf/Geschlecht/Tags (so die Antwort wie Prosa klingt und nicht wie CSV).
      for (const f of figRows) {
        const desc = (f.beschreibung || '').trim();
        if (!desc) continue;
        const extras = [];
        if (f.beruf) extras.push(langIsEn ? `Occupation: ${f.beruf}.` : `Beruf: ${f.beruf}.`);
        if (f.tags_csv) {
          const tags = f.tags_csv.split(',').map(t => t.trim()).filter(Boolean).slice(0, 4).join(', ');
          if (tags) extras.push(langIsEn ? `Traits: ${tags}.` : `Eigenschaften: ${tags}.`);
        }
        const answer = [desc, ...extras].join(' ');
        // 3 Paraphrasen pro Figur → gleiche Fakten mehrmals sehen → bessere
        // Memorisierung der Buchwelt (Ziel: Figur als «Realität» akzeptieren).
        const idxs = pickVariants('fig|' + f.fig_id, figQuestions, 3);
        for (const idx of idxs) {
          const q = figQuestions[idx].replace('{name}', f.name);
          pushQA('authorChat|fig|' + f.fig_id + '|' + idx, q, answer);
        }
        // Zusatz-Frage mit Kurzname als Zielnamen (wenn vorhanden), damit das
        // Modell beide Namen-Varianten kennt.
        if (f.kurzname && f.kurzname !== f.name && f.kurzname.trim().length >= 2) {
          const altIdx = Math.floor(hashSplit('figAlt|' + f.fig_id, seed) * figQuestions.length);
          const q = figQuestions[altIdx].replace('{name}', f.kurzname);
          pushQA('authorChat|figAlt|' + f.fig_id, q, answer);
        }
      }

      // ── Orte-Q&A (angereichert) ───────────────────────────────────────────
      // Der User hat Orte explizit als zentral markiert — wir produzieren pro
      // Ort mehrere Antwort-Framings (Gesamtbeschreibung, Kapitel-Mapping,
      // Figurenbesetzung, Szenen-Überblick, erste Erwähnung). Ziel: das Modell
      // soll jeden Ort aus vielen Blickwinkeln gelernt haben.
      const sceneTitleById = new Map(sceneRows.map(s => [s.id, s.titel]));
      for (const l of locRows) {
        const kapitel    = chaptersByLocPk.get(l.pk) || [];
        const figsHere   = (figsByLocPk.get(l.pk) || []).map(id => figById.get(id)?.name).filter(Boolean);
        const szenenHere = (scenesByLocPk.get(l.pk) || []).map(id => sceneTitleById.get(id)).filter(Boolean);
        const desc       = (l.beschreibung || '').trim();

        // Komplette Antwort mit allen verfügbaren Facetten. Wird als Haupt-Antwort
        // auf generelle „Wer/was ist {ort}?"-Fragen verwendet.
        const parts = [];
        if (desc) parts.push(desc);
        if (l.typ)      parts.push(langIsEn ? `Type: ${l.typ}.` : `Art des Ortes: ${l.typ}.`);
        if (l.stimmung) parts.push(langIsEn ? `The atmosphere: ${l.stimmung}.` : `Die Stimmung: ${l.stimmung}.`);
        if (kapitel.length) {
          parts.push(langIsEn
            ? `Appears in: ${kapitel.slice(0, 10).join(', ')}.`
            : `Kommt vor in: ${kapitel.slice(0, 10).join(', ')}.`);
        }
        if (figsHere.length) {
          parts.push(langIsEn
            ? `Characters present: ${figsHere.slice(0, 12).join(', ')}.`
            : `Figuren an diesem Ort: ${figsHere.slice(0, 12).join(', ')}.`);
        }
        if (szenenHere.length) {
          parts.push(langIsEn
            ? `Scenes here: ${szenenHere.slice(0, 6).map(t => `«${t}»`).join(', ')}.`
            : `Szenen an diesem Ort: ${szenenHere.slice(0, 6).map(t => `«${t}»`).join(', ')}.`);
        }
        if (l.erste_erwaehnung) {
          parts.push(langIsEn
            ? `First mentioned on «${l.erste_erwaehnung}».`
            : `Erste Erwähnung auf «${l.erste_erwaehnung}».`);
        }
        const fullAnswer = parts.join(' ');
        if (!fullAnswer) continue;

        // Haupt-Q&A: 3 Paraphrasen mit voller Antwort
        const idxs = pickVariants('ort|' + l.loc_id, ortQuestions, 3);
        for (const idx of idxs) {
          const q = ortQuestions[idx].replace('{name}', l.name);
          pushQA('authorChat|ort|' + l.loc_id + '|' + idx, q, fullAnswer);
        }

        // Spezifische Q&A für jede Facette, damit das Modell gezielt abrufbar lernt.
        if (kapitel.length) {
          const answer = kapitel.slice(0, 15).join(', ');
          pushQA('authorChat|ort-ch|' + l.loc_id,
            langIsEn ? `In which chapters does ${l.name} appear?` : `In welchen Kapiteln kommt ${l.name} vor?`,
            langIsEn ? `${l.name} appears in: ${answer}.` : `${l.name} kommt vor in: ${answer}.`);
        }
        if (figsHere.length) {
          const answer = figsHere.slice(0, 15).join(', ');
          pushQA('authorChat|ort-fig|' + l.loc_id,
            langIsEn ? `Which characters are at ${l.name}?` : `Welche Figuren sind an ${l.name}?`,
            langIsEn ? `At ${l.name}: ${answer}.` : `An ${l.name}: ${answer}.`);
        }
        if (szenenHere.length) {
          const answer = szenenHere.slice(0, 10).map(t => `«${t}»`).join(', ');
          pushQA('authorChat|ort-sz|' + l.loc_id,
            langIsEn ? `What scenes take place at ${l.name}?` : `Welche Szenen spielen an ${l.name}?`,
            langIsEn ? `Scenes at ${l.name}: ${answer}.` : `Szenen an ${l.name}: ${answer}.`);
        }
        if (l.stimmung) {
          pushQA('authorChat|ort-stimmung|' + l.loc_id,
            langIsEn ? `What's the mood of ${l.name}?` : `Welche Stimmung hat ${l.name}?`,
            l.stimmung);
        }
        if (l.erste_erwaehnung) {
          pushQA('authorChat|ort-first|' + l.loc_id,
            langIsEn ? `When is ${l.name} first mentioned?` : `Wann wird ${l.name} zum ersten Mal erwähnt?`,
            langIsEn
              ? `${l.name} is first introduced on the page «${l.erste_erwaehnung}».`
              : `${l.name} wird zum ersten Mal auf der Seite «${l.erste_erwaehnung}» erwähnt.`);
        }
      }

      // ── Szenen-Q&A ────────────────────────────────────────────────────────
      for (const s of sceneRows) {
        const komm = (s.kommentar || '').trim();
        if (!s.titel || !komm) continue;
        const parts = [komm];
        const figIds = figsByScene.get(s.id) || [];
        const figNames = figIds.map(id => figById.get(id)?.name).filter(Boolean);
        if (figNames.length) parts.push(langIsEn ? `Characters: ${figNames.join(', ')}.` : `Figuren: ${figNames.join(', ')}.`);
        const locIds = locsByScene.get(s.id) || [];
        const locNames = locIds.map(id => locById.get(id)?.name).filter(Boolean);
        if (locNames.length) parts.push(langIsEn ? `Setting: ${locNames.join(', ')}.` : `Schauplatz: ${locNames.join(', ')}.`);
        if (s.kapitel) parts.push(langIsEn ? `Chapter: ${s.kapitel}.` : `Kapitel: ${s.kapitel}.`);
        const answer = parts.join(' ');
        const idxs = pickVariants('scene|' + s.id, sceneQuestions, 2);
        for (const idx of idxs) {
          const q = sceneQuestions[idx].replace('{titel}', s.titel);
          pushQA('authorChat|scene|' + s.id + '|' + idx, q, answer);
        }
      }

      // ── Zeitstrahl-Q&A (angereichert) ─────────────────────────────────────
      // Ereignisse als zweite zentrale Säule der Buchwelt — alle verfügbaren
      // Felder (typ, figuren, kapitel, seiten) einfliessen lassen und pro
      // Ereignis mehrere spezialisierte Fragen stellen.
      const evtRows = db.prepare(
        'SELECT ereignis, datum, typ, bedeutung, kapitel, seiten, figuren FROM zeitstrahl_events WHERE book_id = ? AND user_email = ? ORDER BY sort_order'
      ).all(bookIdInt, userEmail || '');
      for (let i = 0; i < evtRows.length; i++) {
        const ev = evtRows[i];
        const ereignis = (ev.ereignis || '').trim();
        if (!ereignis) continue;
        // JSON-Felder defensiv parsen.
        const parseList = (v) => {
          if (!v) return [];
          if (Array.isArray(v)) return v;
          try { const r = JSON.parse(v); return Array.isArray(r) ? r : []; } catch { return []; }
        };
        const kapitelArr = parseList(ev.kapitel);
        const seitenArr  = parseList(ev.seiten);
        const figArr     = parseList(ev.figuren);
        // Figuren-Array enthält Namen oder IDs — beides zulassen, IDs auflösen.
        const figNames = figArr.map(f => {
          if (typeof f === 'string' && figById.has(f)) return figById.get(f).name;
          return String(f);
        }).filter(Boolean);

        const parts = [ereignis + '.'];
        if (ev.datum)     parts.push(langIsEn ? `When: ${ev.datum}.` : `Zeitpunkt: ${ev.datum}.`);
        if (ev.typ)       parts.push(langIsEn ? `Type: ${ev.typ}.` : `Art: ${ev.typ}.`);
        if (figNames.length) {
          parts.push(langIsEn
            ? `Characters involved: ${figNames.slice(0, 8).join(', ')}.`
            : `Beteiligte Figuren: ${figNames.slice(0, 8).join(', ')}.`);
        }
        if (kapitelArr.length) {
          parts.push(langIsEn
            ? `In chapter(s): ${kapitelArr.slice(0, 5).join(', ')}.`
            : `In Kapitel: ${kapitelArr.slice(0, 5).join(', ')}.`);
        }
        if (seitenArr.length) {
          parts.push(langIsEn
            ? `On page(s): ${seitenArr.slice(0, 5).join(', ')}.`
            : `Auf Seite(n): ${seitenArr.slice(0, 5).join(', ')}.`);
        }
        if (ev.bedeutung) parts.push((langIsEn ? 'Why it matters: ' : 'Bedeutung: ') + ev.bedeutung);
        const fullAnswer = parts.join(' ');

        // Haupt-Q&A: mehrere Paraphrasen mit voller Antwort
        const idxs = pickVariants('evt|' + i, eventQuestions, 3);
        for (const idx of idxs) {
          const q = eventQuestions[idx].replace('{ereignis}', ereignis);
          pushQA('authorChat|evt|' + i + '|' + idx, q, fullAnswer);
        }

        // Gezielte Sub-Fragen pro Facette
        if (figNames.length) {
          pushQA('authorChat|evt-fig|' + i,
            langIsEn ? `Who is involved in «${ereignis}»?` : `Wer ist bei «${ereignis}» dabei?`,
            figNames.join(', '));
        }
        if (kapitelArr.length) {
          pushQA('authorChat|evt-ch|' + i,
            langIsEn ? `In which chapter does «${ereignis}» happen?` : `In welchem Kapitel passiert «${ereignis}»?`,
            kapitelArr.join(', '));
        }
        if (ev.datum) {
          pushQA('authorChat|evt-when|' + i,
            langIsEn ? `When does «${ereignis}» happen?` : `Wann passiert «${ereignis}»?`,
            ev.datum);
        }
        if (ev.bedeutung) {
          pushQA('authorChat|evt-sig|' + i,
            langIsEn ? `What's the significance of «${ereignis}»?` : `Welche Bedeutung hat «${ereignis}»?`,
            ev.bedeutung);
        }
        if (ev.typ) {
          pushQA('authorChat|evt-typ|' + i,
            langIsEn ? `What type of event is «${ereignis}»?` : `Was für eine Art Ereignis ist «${ereignis}»?`,
            ev.typ);
        }
      }

      // ── Figuren-Beziehungen ──────────────────────────────────────────────
      // Pro Beziehung Q&A „Wie steht A zu B?" + Rückrichtung. Paare werden
      // einmalig (A→B UND B→A) eingefügt, damit das Modell beide Fragerichtungen
      // kennt.
      for (const rel of figRelRows) {
        const a = figById.get(rel.from_fig_id)?.name;
        const b = figById.get(rel.to_fig_id)?.name;
        if (!a || !b) continue;
        const typ = (rel.typ || '').trim();
        const besch = (rel.beschreibung || '').trim();
        if (!typ && !besch) continue;
        const answer = besch
          ? (typ ? `${typ.charAt(0).toUpperCase() + typ.slice(1)}: ${besch}` : besch)
          : typ;
        pushQA('authorChat|rel|' + rel.from_fig_id + '|' + rel.to_fig_id,
          langIsEn ? `How does ${a} relate to ${b}?` : `Wie steht ${a} zu ${b}?`,
          answer);
        pushQA('authorChat|rel2|' + rel.from_fig_id + '|' + rel.to_fig_id,
          langIsEn ? `What is the relationship between ${a} and ${b}?` : `Welche Beziehung haben ${a} und ${b}?`,
          answer);
      }

      // ── Figuren-Lebensereignisse ─────────────────────────────────────────
      // Pro figure_events-Eintrag ein gezielter Fakt + eine aggregierte Antwort
      // für „Was erlebt X im Buch?"
      for (const f of figRows) {
        const evts = eventsByFigPk.get(f.pk) || [];
        if (!evts.length) continue;
        for (let j = 0; j < evts.length; j++) {
          const e = evts[j];
          const parts = [e.ereignis];
          if (e.datum)     parts.push(langIsEn ? `(${e.datum})` : `(${e.datum})`);
          if (e.bedeutung) parts.push('— ' + e.bedeutung);
          const answer = parts.join(' ');
          pushQA('authorChat|figEvt|' + f.fig_id + '|' + j,
            langIsEn
              ? `What happens to ${f.name} ${e.datum ? `around ${e.datum}` : `during the story`}?`
              : `Was passiert mit ${f.name}${e.datum ? ` (${e.datum})` : ' im Verlauf der Geschichte'}?`,
            answer);
        }
        const allEvtsList = evts.slice(0, 8)
          .map(e => `${e.datum ? e.datum + ': ' : ''}${e.ereignis}${e.bedeutung ? ' (' + e.bedeutung + ')' : ''}`)
          .join(' · ');
        pushQA('authorChat|figAllEvt|' + f.fig_id,
          langIsEn ? `What are the key moments in ${f.name}'s story?` : `Welche Schlüsselmomente erlebt ${f.name}?`,
          allEvtsList);
      }

      // ── Figuren-Auftritte (Kapitel-Liste) ────────────────────────────────
      for (const f of figRows) {
        const chs = appearancesByFigPk.get(f.pk) || [];
        if (!chs.length) continue;
        const answer = chs.slice(0, 20).join(', ');
        pushQA('authorChat|figApp|' + f.fig_id,
          langIsEn ? `In which chapters does ${f.name} appear?` : `In welchen Kapiteln taucht ${f.name} auf?`,
          langIsEn ? `${f.name} appears in: ${answer}.` : `${f.name} kommt vor in: ${answer}.`);
      }

      // ── Figuren-Dialogstil: wie spricht X? ───────────────────────────────
      // Wenn wir Zitate einer Figur gesammelt haben, aggregieren wir die
      // prägnantesten als Sprach-Portrait. Nimmt die mittleren Längen (nicht
      // zu kurz, nicht zu lang) — die eigentlichen Stimm-Träger.
      for (const f of figRows) {
        const entries = dialogsByFigure.get(f.name.toLowerCase()) || [];
        const altEntries = (f.kurzname && f.kurzname !== f.name)
          ? (dialogsByFigure.get(f.kurzname.toLowerCase()) || [])
          : [];
        const seenQ = new Set();
        const combined = [];
        for (const e of [...entries, ...altEntries]) {
          if (seenQ.has(e.quote)) continue;
          if (e.quote.length < 20 || e.quote.length > 220) continue;
          seenQ.add(e.quote);
          combined.push(e);
        }
        if (combined.length < 2) continue;
        const sample = combined.slice(0, 6).map(e => `„${e.quote}"`).join(' · ');
        pushQA('authorChat|figVoice|' + f.fig_id,
          langIsEn ? `How does ${f.name} speak? Show me a few lines.` : `Wie spricht ${f.name}? Zeig mir ein paar Sätze.`,
          sample);
      }

      // ── Fakten aus chapter_extract_cache ─────────────────────────────────
      // Pro Kapitel liefert die Komplettanalyse typischerweise 20–50 präzise
      // Ein-Satz-Fakten (kategorie=figur|ort|objekt|zeit|ereignis|…). Diese
      // sind die dichteste Quelle atomarer Buchwelt-Behauptungen. Pro Fakt
      // ein Q&A + gruppiert pro Subjekt eine Sammel-Antwort.
      const factsBySubject = new Map(); // subjekt lower → [{kategorie,fakt,seite}]
      let factCounter = 0;
      for (const row of extractCacheRows) {
        let data = null;
        try { data = JSON.parse(row.extract_json); } catch { continue; }
        const facts = Array.isArray(data?.fakten) ? data.fakten : [];
        for (const fk of facts) {
          const subjekt = (fk.subjekt || '').trim();
          const fakt    = (fk.fakt    || '').trim();
          if (!subjekt || fakt.length < 10) continue;
          const kategorie = (fk.kategorie || '').trim();
          const seite     = (fk.seite     || '').trim();
          // Einzel-Fakt-Q&A
          const answer = seite
            ? (langIsEn ? `${fakt} (from «${seite}»)` : `${fakt} (aus «${seite}»)`)
            : fakt;
          factCounter++;
          pushQA('authorChat|fact|' + factCounter,
            langIsEn
              ? `Tell me a fact about ${subjekt}${kategorie ? ` (${kategorie})` : ''}.`
              : `Nenn mir einen Fakt zu ${subjekt}${kategorie ? ` (${kategorie})` : ''}.`,
            answer);
          // Für Gruppierung
          const key = subjekt.toLowerCase();
          if (!factsBySubject.has(key)) factsBySubject.set(key, { subjekt, items: [] });
          factsBySubject.get(key).items.push({ kategorie, fakt, seite });
        }
      }
      // Gruppierte Antworten pro Subjekt — wenn viele Fakten zu X gesammelt,
      // entsteht eine reichhaltige „Erzähl mir alles über X"-Antwort.
      for (const [key, group] of factsBySubject) {
        if (group.items.length < 2) continue;
        const joined = group.items.slice(0, 15).map(it => it.fakt).join(' ');
        pushQA('authorChat|factAll|' + key,
          langIsEn ? `What do we know about ${group.subjekt}?` : `Was wissen wir über ${group.subjekt}?`,
          joined);
      }

      // ── Text-geerdete Samples (Figur-Passagen) ───────────────────────────
      // Für jede Figur suchen wir ein paar konkrete Textausschnitte, in denen
      // der Name vorkommt. Prompt: „Zeig mir eine Passage mit X" → Absatz aus
      // dem Buch. Groundet Figurwissen direkt im Quelltext.
      const PASSAGE_MAX_PER_FIG = 5;
      for (const f of figRows) {
        const names = [f.name, f.kurzname].filter(n => n && String(n).trim().length >= 2);
        if (!names.length) continue;
        const longestFirst = [...names].sort((a, b) => b.length - a.length);
        const found = [];
        for (const p of pageContents) {
          if (found.length >= PASSAGE_MAX_PER_FIG) break;
          const paragraphs = splitParagraphs(p.text);
          for (const para of paragraphs) {
            if (found.length >= PASSAGE_MAX_PER_FIG) break;
            if (para.length < 120 || para.length > maxChars) continue;
            const hits = longestFirst.some(n => new RegExp('\\b' + escapeRe(n) + '\\b', 'i').test(para));
            if (!hits) continue;
            found.push({ para, page: p });
          }
        }
        for (let j = 0; j < found.length; j++) {
          const { para, page } = found[j];
          pushQA('authorChat|figPass|' + f.fig_id + '|' + j,
            langIsEn
              ? `Show me a passage where ${f.name} appears.`
              : `Zeig mir eine Passage mit ${f.name}.`,
            para);
          // Variante mit Kapitel-Kontext als weitere Formulierung
          if (page.chapter && j === 0) {
            pushQA('authorChat|figPassCh|' + f.fig_id,
              langIsEn
                ? `How does ${f.name} appear in «${page.chapter}»?`
                : `Wie tritt ${f.name} in «${page.chapter}» auf?`,
              para);
          }
        }
      }

      // ── Text-geerdete Samples (Ort-Passagen) ─────────────────────────────
      const PASSAGE_MAX_PER_LOC = 4;
      for (const l of locRows) {
        if (!l.name || l.name.length < 3) continue;
        const nameRe = new RegExp('\\b' + escapeRe(l.name) + '\\b', 'i');
        const found = [];
        for (const p of pageContents) {
          if (found.length >= PASSAGE_MAX_PER_LOC) break;
          const paragraphs = splitParagraphs(p.text);
          for (const para of paragraphs) {
            if (found.length >= PASSAGE_MAX_PER_LOC) break;
            if (para.length < 120 || para.length > maxChars) continue;
            if (!nameRe.test(para)) continue;
            found.push({ para, page: p });
          }
        }
        for (let j = 0; j < found.length; j++) {
          pushQA('authorChat|ortPass|' + l.loc_id + '|' + j,
            langIsEn
              ? `Show me a passage set at ${l.name}.`
              : `Zeig mir eine Passage an ${l.name}.`,
            found[j].para);
        }
      }

      // ── Reverse Lookups (#7): Satz → Seite/Kapitel ───────────────────────
      // Distinktive Sätze (mittellang, mindestens ein Grossbuchstabe
      // mittelstellig als Indikator für Eigennamen) pro Seite sammeln und
      // als Reverse-Samples emittieren: „Auf welcher Seite steht …?" und
      // „Welches Kapitel enthält …?". Cap pro Seite, damit Gleichgewicht.
      const REV_PER_PAGE = 3;
      const looksDistinctive = (sent) => {
        if (sent.length < 80 || sent.length > 260) return false;
        // Enthält mindestens einen Grossbuchstaben nach dem ersten Wort
        const inner = sent.slice(4);
        return /[A-ZÄÖÜ]/.test(inner);
      };
      for (const p of pageContents) {
        const sents = splitSentences(p.text);
        let emitted = 0;
        for (let i = 0; i < sents.length && emitted < REV_PER_PAGE; i++) {
          const s = sents[i];
          if (!looksDistinctive(s)) continue;
          pushQA('authorChat|revPage|' + p.id + '|' + i,
            langIsEn ? `On which page does this sentence appear: "${s}"` : `Auf welcher Seite steht dieser Satz: „${s}"`,
            langIsEn
              ? `This sentence is on the page «${p.title}»${p.chapter ? ` in chapter «${p.chapter}»` : ''}.`
              : `Dieser Satz steht auf der Seite «${p.title}»${p.chapter ? ` im Kapitel «${p.chapter}»` : ''}.`);
          if (p.chapter) {
            pushQA('authorChat|revChap|' + p.id + '|' + i,
              langIsEn ? `Which chapter contains: "${s}"` : `Welches Kapitel enthält: „${s}"`,
              langIsEn ? `Chapter «${p.chapter}».` : `Kapitel «${p.chapter}».`);
          }
          emitted++;
        }
      }

      // ── Buch-Architektur-Meta (#8) ──────────────────────────────────────
      // Strukturwissen: Kapitel-Liste, Nachbarschaften, Buch-Anfang/-Ende,
      // Anzahl. Gibt dem Modell ein mentales Inhaltsverzeichnis.
      const chapterNamesOrdered = chapterKeys
        .filter(k => k !== 0 || (pagesByChapter.get(k) || []).length > 0)
        .map(k => chapterNameByKey.get(k))
        .filter(Boolean);
      if (chapterNamesOrdered.length >= 2) {
        const joined = chapterNamesOrdered.map((n, i) => `${i + 1}. ${n}`).join('\n');
        pushQA('authorChat|archStructure',
          langIsEn ? `How is «${displayName}» structured?` : `Wie ist «${displayName}» aufgebaut?`,
          langIsEn
            ? `«${displayName}» consists of ${chapterNamesOrdered.length} chapters:\n${joined}`
            : `«${displayName}» besteht aus ${chapterNamesOrdered.length} Kapiteln:\n${joined}`);
        pushQA('authorChat|archList',
          langIsEn ? `List all chapters of «${displayName}».` : `Nenn mir alle Kapitel von «${displayName}».`,
          joined);
        pushQA('authorChat|archCount',
          langIsEn ? `How many chapters does «${displayName}» have?` : `Wie viele Kapitel hat «${displayName}»?`,
          langIsEn ? `${chapterNamesOrdered.length} chapters.` : `${chapterNamesOrdered.length} Kapitel.`);
        // Nachbarschaften: Vorgänger / Nachfolger
        for (let i = 0; i < chapterNamesOrdered.length; i++) {
          const name = chapterNamesOrdered[i];
          if (i + 1 < chapterNamesOrdered.length) {
            pushQA('authorChat|archNext|' + i,
              langIsEn ? `Which chapter follows «${name}»?` : `Welches Kapitel folgt auf «${name}»?`,
              langIsEn ? `The next chapter is «${chapterNamesOrdered[i + 1]}».` : `Das nächste Kapitel ist «${chapterNamesOrdered[i + 1]}».`);
          }
          if (i > 0) {
            pushQA('authorChat|archPrev|' + i,
              langIsEn ? `Which chapter comes before «${name}»?` : `Welches Kapitel kommt vor «${name}»?`,
              langIsEn ? `The previous chapter is «${chapterNamesOrdered[i - 1]}».` : `Das vorherige Kapitel ist «${chapterNamesOrdered[i - 1]}».`);
          }
        }
        // Erste / letzte Kapitel
        pushQA('authorChat|archFirst',
          langIsEn ? `What's the first chapter of «${displayName}»?` : `Welches ist das erste Kapitel von «${displayName}»?`,
          chapterNamesOrdered[0]);
        pushQA('authorChat|archLast',
          langIsEn ? `What's the last chapter of «${displayName}»?` : `Welches ist das letzte Kapitel von «${displayName}»?`,
          chapterNamesOrdered[chapterNamesOrdered.length - 1]);
      }

      // Buch-Anfang / -Ende: erste ~500 Zeichen der ersten Seite, letzte ~500
      // der letzten Seite. Verankert „Wie beginnt/endet das Buch?".
      if (pageContents.length > 0) {
        const firstPage = pageContents[0];
        const lastPage  = pageContents[pageContents.length - 1];
        if (firstPage?.text) {
          const head = firstPage.text.slice(0, Math.min(600, firstPage.text.length));
          pushQA('authorChat|archBegin',
            langIsEn ? `How does «${displayName}» begin?` : `Wie beginnt «${displayName}»?`,
            head);
        }
        if (lastPage?.text) {
          const tail = lastPage.text.slice(-Math.min(600, lastPage.text.length));
          pushQA('authorChat|archEnd',
            langIsEn ? `How does «${displayName}» end?` : `Wie endet «${displayName}»?`,
            tail);
        }
      }

      // ── Review-basierte Q&A ───────────────────────────────────────────────
      // Nutzt die zuletzt gespeicherte book_reviews.review_json. Feste Fragen
      // pro Feld, weil die Review-Felder bereits in klaren Sätzen vorliegen.
      const reviewRow = db.prepare(
        'SELECT review_json FROM book_reviews WHERE book_id = ? AND user_email = ? ORDER BY reviewed_at DESC LIMIT 1'
      ).get(bookIdInt, userEmail);
      if (reviewRow?.review_json) {
        let r = null;
        try { r = JSON.parse(reviewRow.review_json); } catch { /* ignore */ }
        if (r && typeof r === 'object') {
          const qaFromReview = (suffix, q, a) => pushQA('authorChat|review|' + suffix, q, a);
          if (r.zusammenfassung) {
            qaFromReview('summary',
              langIsEn ? `What is «${displayName}» about?` : `Worum geht es in «${displayName}»?`,
              r.zusammenfassung);
          }
          if (r.themen) {
            qaFromReview('themen',
              langIsEn ? 'What are the main themes?' : 'Was sind die Hauptthemen?',
              typeof r.themen === 'string' ? r.themen : (Array.isArray(r.themen) ? r.themen.join(', ') : ''));
          }
          if (Array.isArray(r.staerken) && r.staerken.length) {
            qaFromReview('staerken',
              langIsEn ? 'What are the strengths of the book?' : 'Was sind die Stärken des Buchs?',
              r.staerken.join(' · '));
          }
          if (Array.isArray(r.schwaechen) && r.schwaechen.length) {
            qaFromReview('schwaechen',
              langIsEn ? 'What would you criticize about the book?' : 'Was würdest du am Buch kritisieren?',
              r.schwaechen.join(' · '));
          }
          if (r.gesamtnote != null && r.gesamtnote_begruendung) {
            qaFromReview('note',
              langIsEn ? 'How would you rate the book overall?' : 'Wie bewertest du das Buch gesamt?',
              `${r.gesamtnote}/6 — ${r.gesamtnote_begruendung}`);
          }
        }
      }

      // ── Kapitel-Reviews ───────────────────────────────────────────────────
      // Neueste pro Kapitel (user+book). Pro Review mehrere Q&A: Zusammenfassung,
      // Fazit, Stärken, Schwächen, Dramaturgie, Pacing, Figuren.
      const chapterReviewRows = db.prepare(`
        SELECT cr1.chapter_name, cr1.review_json
        FROM chapter_reviews cr1
        WHERE cr1.book_id = ? AND cr1.user_email = ?
          AND cr1.reviewed_at = (
            SELECT MAX(cr2.reviewed_at) FROM chapter_reviews cr2
            WHERE cr2.book_id = cr1.book_id AND cr2.chapter_id = cr1.chapter_id AND cr2.user_email = cr1.user_email
          )
      `).all(bookIdInt, userEmail);
      for (const row of chapterReviewRows) {
        const chName = (row.chapter_name || '').trim();
        if (!chName || !row.review_json) continue;
        let cr = null;
        try { cr = JSON.parse(row.review_json); } catch { continue; }
        if (!cr || typeof cr !== 'object') continue;
        // Zusammenfassung als Hauptantwort auf „Was passiert in Kapitel X?"
        if (cr.zusammenfassung) {
          const idxs = pickVariants('chap|' + chName, chapterQuestions, 2);
          for (const idx of idxs) {
            const q = chapterQuestions[idx].replace('{kapitel}', chName);
            pushQA('authorChat|chap|' + chName + '|' + idx, q, cr.zusammenfassung);
          }
        }
        if (cr.fazit) {
          pushQA('authorChat|chap-fazit|' + chName,
            langIsEn ? `What's the takeaway of «${chName}»?` : `Was ist das Fazit zu Kapitel «${chName}»?`,
            cr.fazit);
        }
        if (cr.dramaturgie) {
          pushQA('authorChat|chap-drama|' + chName,
            langIsEn ? `How does «${chName}» build tension?` : `Wie ist «${chName}» dramaturgisch aufgebaut?`,
            cr.dramaturgie);
        }
        if (cr.pacing) {
          pushQA('authorChat|chap-pacing|' + chName,
            langIsEn ? `How is the pacing of «${chName}»?` : `Wie ist das Tempo in «${chName}»?`,
            cr.pacing);
        }
        if (cr.figuren) {
          pushQA('authorChat|chap-fig|' + chName,
            langIsEn ? `Who carries «${chName}»?` : `Welche Figuren tragen «${chName}»?`,
            cr.figuren);
        }
        if (Array.isArray(cr.staerken) && cr.staerken.length) {
          pushQA('authorChat|chap-str|' + chName,
            langIsEn ? `What makes «${chName}» strong?` : `Was macht «${chName}» stark?`,
            cr.staerken.join(' · '));
        }
      }

      // ── Echte Buch-Chat-Messages ──────────────────────────────────────────
      // Consecutive (user, assistant)-Paare aus book-chat-Sessions (page_name
      // = '__book__') direkt übernehmen. Das ist die authentischste Q&A-Quelle.
      const chatRows = db.prepare(`
        SELECT cs.id AS sid, cm.role, cm.content, cm.created_at, cm.id AS mid
        FROM chat_messages cm
        JOIN chat_sessions cs ON cs.id = cm.session_id
        WHERE cs.book_id = ? AND cs.user_email = ? AND cs.page_name = '__book__'
        ORDER BY cs.id, cm.created_at, cm.id
      `).all(bookIdInt, userEmail);
      for (let i = 0; i + 1 < chatRows.length; i++) {
        const a = chatRows[i];
        const b = chatRows[i + 1];
        if (a.sid !== b.sid) continue;
        if (a.role !== 'user' || b.role !== 'assistant') continue;
        const q = (a.content || '').trim();
        const ans = (b.content || '').trim();
        if (q.length < 4 || ans.length < 30) continue;
        pushQA('authorChat|chat|' + a.sid + '|' + a.mid, q, ans);
      }
    }

    updateJob(jobId, { progress: 95, statusText: 'finetune.phase.building' });
    const trainArr = [];
    const valArr = [];
    for (const s of samples) {
      if (valSplit > 0 && hashSplit(s.id, seed) < valSplit) valArr.push(s);
      else trainArr.push(s);
    }
    const toJsonl = (arr) => arr.length
      ? arr.map(s => JSON.stringify({ messages: s.messages })).join('\n') + '\n'
      : '';

    const trainJsonl = toJsonl(trainArr);
    const valJsonl   = toJsonl(valArr);
    const stats = {
      total: samples.length,
      train: trainArr.length,
      val: valArr.length,
      styleCount, sceneCount, dialogCount, authorChatCount, correctionCount,
      trainBytes: Buffer.byteLength(trainJsonl, 'utf8'),
      valBytes:   Buffer.byteLength(valJsonl,   'utf8'),
    };

    storeFinetuneResult(jobId, { trainJsonl, valJsonl });
    completeJob(jobId, { stats });
    logger.info(`Finetune-Export fertig: ${stats.total} Samples (${styleCount} style / ${sceneCount} scene / ${dialogCount} dialog / ${authorChatCount} authorChat / ${correctionCount} correction) → ${trainArr.length} train, ${valArr.length} val.`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Fehler Finetune-Export (book=${bookId}): ${e.message}`);
    failJob(jobId, e);
  }
}

finetuneExportRouter.post('/finetune-export', jsonBody, (req, res) => {
  const { book_id, book_name, types, min_chars, max_chars, val_split, val_seed } = req.body || {};
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  const opts = {
    types: {
      style:      !!(types && types.style),
      scene:      !!(types && types.scene),
      dialog:     !!(types && types.dialog),
      authorChat: !!(types && types.authorChat),
      correction: !!(types && types.correction),
    },
    minChars: Number(min_chars) || 200,
    maxChars: Number(max_chars) || 4000,
    valSplit: Number.isFinite(Number(val_split)) ? Number(val_split) : 0.1,
    valSeed:  Number(val_seed)  || 0,
  };
  if (!Object.values(opts.types).some(v => v)) {
    return res.status(400).json({ error_code: 'FINETUNE_NO_TYPES' });
  }
  const userEmail = req.session?.user?.email || null;
  const userToken = getTokenForRequest(req);
  const existing = runningJobs.get(jobKey('finetune-export', book_id, userEmail));
  if (existing && jobs.has(existing)) return res.json({ jobId: existing, existing: true });
  const label = book_name ? 'job.label.finetuneExportBook' : 'job.label.finetuneExport';
  const labelParams = book_name ? { name: book_name } : null;
  const jobId = createJob('finetune-export', book_id, userEmail, label, labelParams);
  enqueueJob(jobId, () => runFinetuneExportJob(jobId, book_id, book_name || '', userEmail, userToken, opts));
  res.json({ jobId });
});

finetuneExportRouter.get('/finetune-export/:id/:kind.jsonl', (req, res) => {
  const userEmail = req.session?.user?.email || null;
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error_code: 'JOB_NOT_FOUND' });
  if (job.userEmail !== userEmail) return res.status(403).json({ error_code: 'FORBIDDEN' });
  if (job.type !== 'finetune-export') return res.status(400).json({ error_code: 'JOB_TYPE_MISMATCH' });
  if (job.status !== 'done') return res.status(409).json({ error_code: 'JOB_NOT_DONE' });
  const kind = req.params.kind;
  if (kind !== 'train' && kind !== 'val') return res.status(400).json({ error_code: 'INVALID_KIND' });
  const payload = finetuneResultStore.get(req.params.id);
  if (!payload) return res.status(410).json({ error_code: 'JSONL_EXPIRED' });
  const content = kind === 'train' ? payload.trainJsonl : payload.valJsonl;
  if (!content) return res.status(404).json({ error_code: 'JSONL_EMPTY' });
  const filename = `finetune-${kind}-book${job.bookId}.jsonl`;
  res.setHeader('Content-Type', 'application/jsonl; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(content);
});

module.exports = { finetuneExportRouter };
