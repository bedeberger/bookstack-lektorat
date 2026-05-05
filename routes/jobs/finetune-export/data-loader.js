'use strict';

const { db } = require('../../../db/schema');

// Lädt alle DB-Tabellen für den Finetune-Export und baut die Maps
// (Lookups, Reverse-Indizes), die alle Sample-Module verwenden.
//
// Erwartet bereits geladene `pageContents` aus dem Orchestrator (kommt aus
// loadPageContents — wird vor Phase „loadMetadata" gestartet, weil das
// Page-Loading dominanten Zeitanteil hat und die Metadaten-Loads ohne
// pageContents nicht sinnvoll sind).
//
// Returnt ein flaches Objekt mit allen Datenstrukturen, das später in den
// ctx-Object gemerged wird.
function loadFinetuneData({ bookIdInt, userEmail, pageContents, langIsEn }) {
  const figRows = db.prepare(`
    SELECT f.fig_id, f.id AS pk, f.name, f.kurzname, f.typ, f.beschreibung, f.beruf, f.geschlecht, f.sozialschicht,
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
    SELECT lc.location_id, c.chapter_name, lc.haeufigkeit
    FROM location_chapters lc
    JOIN locations l ON l.id = lc.location_id
    LEFT JOIN chapters c ON c.chapter_id = lc.chapter_id
    WHERE l.book_id = ? AND (l.user_email = ? OR (? IS NULL AND l.user_email IS NULL))
    ORDER BY lc.haeufigkeit DESC, c.chapter_name
  `).all(bookIdInt, userEmail, userEmail);
  const chaptersByLocPk = new Map();
  for (const r of locChaptersRows) {
    if (!chaptersByLocPk.has(r.location_id)) chaptersByLocPk.set(r.location_id, []);
    chaptersByLocPk.get(r.location_id).push(r.chapter_name);
  }
  const locFigRows = db.prepare(`
    SELECT lf.location_id, f.fig_id
    FROM location_figures lf
    JOIN figures f ON f.id = lf.figure_id
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
    SELECT fa.figure_id, c.chapter_name, fa.haeufigkeit
    FROM figure_appearances fa
    JOIN figures f ON f.id = fa.figure_id
    LEFT JOIN chapters c ON c.chapter_id = fa.chapter_id
    WHERE f.book_id = ? AND f.user_email = ?
    ORDER BY fa.haeufigkeit DESC, c.chapter_name
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
    SELECT ff.fig_id AS from_fig_id, ft.fig_id AS to_fig_id,
           r.typ, r.beschreibung
    FROM figure_relations r
    JOIN figures ff ON ff.id = r.from_fig_id
    JOIN figures ft ON ft.id = r.to_fig_id
    WHERE r.book_id = ? AND r.user_email = ?
  `).all(bookIdInt, userEmail);

  // Kapitel-Extract-Cache (Mig 75): chapter-level (chapter_extract_cache) + book-level
  // (book_extract_cache, single-pass). Fakten-Array ist die grösste bisher ungenutzte
  // Quelle feiner Buchwelt-Behauptungen (pro Kapitel bis 50 Einträge mit subjekt/fakt/seite).
  const extractCacheRows = [
    ...db.prepare(`
      SELECT extract_json FROM chapter_extract_cache
      WHERE book_id = ? AND user_email = ?
    `).all(bookIdInt, userEmail || ''),
    ...db.prepare(`
      SELECT extract_json FROM book_extract_cache
      WHERE book_id = ? AND user_email = ?
    `).all(bookIdInt, userEmail || ''),
  ];

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
    SELECT fs.id, c.chapter_name AS kapitel, p.page_name AS seite,
           fs.titel, fs.wertung, fs.kommentar, fs.chapter_id, fs.page_id
    FROM figure_scenes fs
    LEFT JOIN chapters c ON c.chapter_id = fs.chapter_id
    LEFT JOIN pages    p ON p.page_id    = fs.page_id
    WHERE fs.book_id = ? AND fs.user_email = ?
    ORDER BY fs.sort_order
  `).all(bookIdInt, userEmail);
  const sceneFigRows = db.prepare(`
    SELECT sf.scene_id, f.fig_id
    FROM scene_figures sf
    JOIN figures f ON f.id = sf.figure_id
    JOIN figure_scenes fs ON fs.id = sf.scene_id
    WHERE fs.book_id = ? AND fs.user_email = ?
  `).all(bookIdInt, userEmail);
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

  return {
    figRows, figById, figNamesSorted,
    locRows, locById, locPkByLocId,
    chaptersByLocPk, figsByLocPk, scenesByLocPk, sceneLocRows,
    appearancesByFigPk, eventsByFigPk,
    figRelRows,
    extractCacheRows,
    dialogsByFigure,
    pageByTitle,
    chapterKeys, pagesByChapter, chapterFullTextByKey, chapterNameByKey,
    sceneRows, figsByScene, locsByScene,
    pageTextById, pageChapterById,
  };
}

module.exports = { loadFinetuneData };
