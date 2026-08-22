'use strict';
// Listing-/Lookup-Tools: Buch-Inventar (Kapitel, Figuren, Orte, Szenen,
// Ideen, Buch-Settings, Revisionen). Reines DB-Aggregat, kein BookStack-
// Roundtrip. Temporal-Tools (Kontinuitaet/Zeitstrahl) liegen in tools-timeline.js.

const { db, getBookSettings } = require('../../../db/schema');
const { inClause } = require('../../../lib/validate');
const { narrativeLabels } = require('../narrative-labels');
const pageRevisions = require('../../../db/page-revisions');
const { _truncateResult, _findFigure } = require('./shared');

// ── list_chapters ────────────────────────────────────────────────────────────

function tool_list_chapters(_input, ctx) {
  const chapterRows = db.prepare(`
    SELECT c.chapter_id, c.chapter_name,
           COUNT(p.page_id)            AS page_count,
           COALESCE(SUM(ps.words), 0)  AS words,
           COALESCE(SUM(ps.chars), 0)  AS chars
    FROM chapters c
    LEFT JOIN pages p      ON p.chapter_id = c.chapter_id AND p.book_id = c.book_id
    LEFT JOIN page_stats ps ON ps.page_id = p.page_id
    WHERE c.book_id = ?
    GROUP BY c.chapter_id, c.chapter_name
    ORDER BY c.position
  `).all(ctx.bookId);

  // Seiten mit ihren Kapitelzuordnungen laden – inkl. Seiten ohne Kapitel (chapter_id IS NULL)
  const pageRows = db.prepare(`
    SELECT p.page_id, p.page_name, p.chapter_id,
           COALESCE(ps.words, 0) AS words, COALESCE(ps.chars, 0) AS chars
    FROM pages p
    LEFT JOIN page_stats ps ON ps.page_id = p.page_id
    WHERE p.book_id = ?
    ORDER BY p.position, p.page_id
  `).all(ctx.bookId);

  const pagesByChapter = new Map();
  const orphanPages = [];
  let totalWords = 0, totalPages = 0, totalChars = 0;
  for (const p of pageRows) {
    totalPages++;
    totalWords += p.words;
    totalChars += p.chars;
    const entry = { page_id: p.page_id, page_name: p.page_name, words: p.words };
    if (p.chapter_id == null) orphanPages.push(entry);
    else {
      if (!pagesByChapter.has(p.chapter_id)) pagesByChapter.set(p.chapter_id, []);
      pagesByChapter.get(p.chapter_id).push(entry);
    }
  }

  const chapters = chapterRows.map(r => ({
    chapter_id:   r.chapter_id,
    chapter_name: r.chapter_name,
    page_count:   r.page_count,
    words:        r.words,
    pages:        pagesByChapter.get(r.chapter_id) || [],
  }));

  return _truncateResult({
    chapters,
    ...(orphanPages.length ? { pages_without_chapter: orphanPages } : {}),
    total_pages: totalPages,
    total_words: totalWords,
    hint: _listChaptersHint(totalChars, ctx.inputBudgetChars),
  });
}

// Lade-Hinweis abhängig davon, ob das ganze Buch in das Input-Budget passt.
// Schwelle 50 % des Budgets: lässt Platz für System-Prompt, Tool-Schemas und
// Chat-Historie. Ziel: bei semantischen Selektions-Aufgaben (lustigste/schönste
// Stellen, Ton, Stimmung) den Agenten zur Voll-Lektüre lenken statt zum seriellen
// search_passages-Stichwort-Raten. budget unbekannt → konservativer Wort-Fallback.
// Der Hinweis nennt die BEDINGUNG zuerst und die Erlaubnis danach: «passt in den Kontext»
// ist eine Aussage über Kapazität, kein Auftrag. Sonst liest der Agent Voll-Lektüre als
// Standardweg und lädt auch für eine einzelne Faktenfrage ganze Kapitel.
function _listChaptersHint(totalChars, inputBudgetChars) {
  const budget = Number(inputBudgetChars) || 0;
  const cheapFirst = 'Für eine einzelne Faktenfrage (Alter, Datum, Beruf, Ort, Beziehung) bleibst du '
    + 'beim Erst-Kontext bzw. search_similar/search_passages/get_figure_profile — Volltext nicht nötig.';
  if (budget > 0 && totalChars > 0 && totalChars < budget * 0.5) {
    return 'NUR falls die Frage den ganzen Text sichten muss (inhaltliche/semantische Selektion über '
      + 'das Buch — lustigste/schönste/spannendste Stellen, Ton, Stimmung): das ganze Buch passt in den '
      + 'Kontext, lade dann ganze Kapitel via get_chapter_text (mehrere gebündelt in EINER Runde) und '
      + `wähle aus eigener Lektüre aus, statt mit search_passages nach Stichwörtern zu raten. ${cheapFirst}`;
  }
  if (totalChars > 0 && totalChars < 60000) {
    return 'Eher kleines Buch – du kannst ganze Kapitel via get_chapter_text (gebündelt) oder '
      + `Seiten via get_pages laden, WENN die Frage Lektüre statt Stichwort-Suche verlangt. ${cheapFirst}`;
  }
  return undefined;
}

// ── list_ideen ────────────────────────────────────────────────────────────────

const IDEEN_DEFAULT_LIMIT = 50;
const IDEEN_CONTENT_CHARS = 400;

function tool_list_ideen(input, ctx) {
  const userEmail = ctx.userEmail || '';
  const erledigtFilter = typeof input?.erledigt === 'boolean' ? (input.erledigt ? 1 : 0) : null;
  const pageFilter    = Number.isInteger(input?.page_id)    ? input.page_id    : null;
  const chapterFilter = Number.isInteger(input?.chapter_id) ? input.chapter_id : null;
  const limit = Math.min(200, Math.max(1, Number.isInteger(input?.limit) ? input.limit : IDEEN_DEFAULT_LIMIT));

  // Ideen können entweder an einer Seite oder an einem Kapitel hängen (XOR).
  // `effective_chapter_id` deckt beide Quellen ab: direkt-am-Kapitel-Idee
  // (i.chapter_id) ODER an einer Seite, die zum Kapitel gehört (p.chapter_id).
  let sql = `
    SELECT i.id, i.content, i.erledigt, i.erledigt_at, i.created_at, i.updated_at,
           i.page_id, p.page_name,
           COALESCE(i.chapter_id, p.chapter_id) AS effective_chapter_id,
           COALESCE(cc.chapter_name, cp.chapter_name) AS chapter_name,
           CASE WHEN i.page_id IS NOT NULL THEN 'page' ELSE 'chapter' END AS scope
    FROM ideen i
    LEFT JOIN pages    p  ON p.page_id    = i.page_id
    LEFT JOIN chapters cc ON cc.chapter_id = i.chapter_id AND cc.book_id = i.book_id
    LEFT JOIN chapters cp ON cp.chapter_id = p.chapter_id AND cp.book_id = i.book_id
    WHERE i.book_id = ? AND i.user_email = ?
  `;
  const params = [ctx.bookId, userEmail];
  if (erledigtFilter !== null) { sql += ' AND i.erledigt = ?'; params.push(erledigtFilter); }
  if (pageFilter    !== null) { sql += ' AND i.page_id = ?'; params.push(pageFilter); }
  if (chapterFilter !== null) {
    sql += ' AND COALESCE(i.chapter_id, p.chapter_id) = ?';
    params.push(chapterFilter);
  }
  sql += ' ORDER BY i.erledigt ASC, i.updated_at DESC, i.id DESC';

  const rows = db.prepare(sql).all(...params);
  if (!rows.length) return { ideen: [], total: 0 };

  const total = rows.length;
  const limited = rows.slice(0, limit).map(r => ({
    id: r.id,
    scope: r.scope,
    content: r.content && r.content.length > IDEEN_CONTENT_CHARS
      ? r.content.slice(0, IDEEN_CONTENT_CHARS) + '…'
      : (r.content || ''),
    erledigt: !!r.erledigt,
    erledigt_at: r.erledigt_at || null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    page_id: r.page_id,
    page_name: r.page_name || null,
    chapter_id: r.effective_chapter_id ?? null,
    chapter_name: r.chapter_name || null,
  }));

  const offen = rows.filter(r => !r.erledigt).length;
  return _truncateResult({
    ideen: limited,
    total,
    offen,
    erledigt: total - offen,
    ...(limited.length < total ? { truncated: true, shown: limited.length } : {}),
  });
}

// ── list_locations ────────────────────────────────────────────────────────────

function tool_list_locations(input, ctx) {
  const userEmail = ctx.userEmail || null;
  const chapterFilter = Number.isInteger(input?.chapter_id) ? input.chapter_id : null;

  let sql = `
    SELECT l.id, l.loc_id, l.name, l.typ, l.beschreibung, l.stimmung,
           l.erste_erwaehnung, l.erste_erwaehnung_page_id, p.page_name AS erste_erwaehnung_page_name
    FROM locations l
    LEFT JOIN pages p ON p.page_id = l.erste_erwaehnung_page_id
    WHERE l.book_id = ? AND l.user_email IS ?
  `;
  const params = [ctx.bookId, userEmail];
  if (chapterFilter !== null) {
    sql = `
      SELECT DISTINCT l.id, l.loc_id, l.name, l.typ, l.beschreibung, l.stimmung,
             l.erste_erwaehnung, l.erste_erwaehnung_page_id, p.page_name AS erste_erwaehnung_page_name
      FROM locations l
      LEFT JOIN pages p ON p.page_id = l.erste_erwaehnung_page_id
      JOIN location_chapters lc ON lc.location_id = l.id
      WHERE l.book_id = ? AND l.user_email IS ? AND lc.chapter_id = ?
    `;
    params.push(chapterFilter);
  }
  sql += ' ORDER BY l.sort_order, l.id';

  const rows = db.prepare(sql).all(...params);
  if (!rows.length) {
    return { locations: [], hint: 'Keine Orte vorhanden. Komplettanalyse ausführen.' };
  }

  const locIds = rows.map(r => r.id);
  const { sql: idSql, values: idVals } = inClause(locIds);

  const chRows = db.prepare(`
    SELECT lc.location_id, lc.chapter_id, c.chapter_name, lc.haeufigkeit
    FROM location_chapters lc
    LEFT JOIN chapters c ON c.chapter_id = lc.chapter_id
    WHERE lc.location_id IN ${idSql}
    ORDER BY lc.location_id, c.position
  `).all(...idVals);
  const fgRows = db.prepare(`
    SELECT lf.location_id, f.fig_id, f.name
    FROM location_figures lf
    JOIN figures f ON f.id = lf.figure_id AND f.book_id = ? AND f.user_email IS ?
    WHERE lf.location_id IN ${idSql}
  `).all(ctx.bookId, userEmail, ...idVals);

  const chByLoc = new Map();
  for (const r of chRows) {
    if (!chByLoc.has(r.location_id)) chByLoc.set(r.location_id, []);
    chByLoc.get(r.location_id).push({ chapter_id: r.chapter_id, chapter_name: r.chapter_name || null, haeufigkeit: r.haeufigkeit });
  }
  const fgByLoc = new Map();
  for (const r of fgRows) {
    if (!fgByLoc.has(r.location_id)) fgByLoc.set(r.location_id, []);
    fgByLoc.get(r.location_id).push({ fig_id: r.fig_id, name: r.name || null });
  }

  return _truncateResult({
    locations: rows.map(r => {
      const kap = chByLoc.get(r.id) || [];
      return {
        loc_id: r.loc_id,
        name: r.name,
        typ: r.typ || null,
        beschreibung: r.beschreibung || null,
        stimmung: r.stimmung || null,
        erste_erwaehnung: r.erste_erwaehnung || null,
        erste_erwaehnung_page_id: r.erste_erwaehnung_page_id || null,
        erste_erwaehnung_page_name: r.erste_erwaehnung_page_name || null,
        kapitel: kap,
        last_chapter: kap.length ? kap[kap.length - 1] : null,
        figuren: fgByLoc.get(r.id) || [],
      };
    }),
    total: rows.length,
  });
}

// ── list_songs ──────────────────────────────────────────────────────────────

const SONGS_DEFAULT_LIMIT = 50;
const SONGS_MAX_LIMIT     = 200;

function tool_list_songs(input, ctx) {
  const userEmail = ctx.userEmail || null;
  const chapterFilter = Number.isInteger(input?.chapter_id) ? input.chapter_id : null;
  const sceneFilter   = Number.isInteger(input?.scene_id)   ? input.scene_id   : null;
  const limit = Math.min(SONGS_MAX_LIMIT, Math.max(1, Number.isInteger(input?.limit) ? input.limit : SONGS_DEFAULT_LIMIT));

  let figFilterId = null;
  if (input?.figur_id || input?.figur_name) {
    const figRow = _findFigure(input, ctx);
    if (!figRow) return { error: 'Figur nicht gefunden' };
    figFilterId = figRow.id;
  }

  let sql = `
    SELECT s.id, s.song_uid, s.titel, s.interpret, s.genre, s.kontext_typ,
           s.beschreibung, s.stimmung, s.erste_erwaehnung,
           s.erste_erwaehnung_page_id, p.page_name AS erste_erwaehnung_page_name
    FROM songs s
    LEFT JOIN pages p ON p.page_id = s.erste_erwaehnung_page_id
    WHERE s.book_id = ? AND s.user_email = ?
  `;
  const params = [ctx.bookId, userEmail];
  if (chapterFilter !== null) {
    sql += ' AND s.id IN (SELECT song_id FROM song_chapters WHERE chapter_id = ?)';
    params.push(chapterFilter);
  }
  if (figFilterId !== null) {
    sql += ' AND s.id IN (SELECT song_id FROM song_figures WHERE figure_id = ?)';
    params.push(figFilterId);
  }
  if (sceneFilter !== null) {
    sql += ' AND s.id IN (SELECT song_id FROM song_scenes WHERE scene_id = ?)';
    params.push(sceneFilter);
  }
  sql += ' ORDER BY s.sort_order, s.id';

  const rows = db.prepare(sql).all(...params);
  if (!rows.length) {
    return { songs: [], total: 0, hint: 'Keine Songs für diesen Filter. Songs werden in der Musikbibliothek bzw. via Komplettanalyse erfasst.' };
  }

  const songIds = rows.map(r => r.id);
  const { sql: idSql, values: idVals } = inClause(songIds);

  const chRows = db.prepare(`
    SELECT sc.song_id, sc.chapter_id, c.chapter_name, sc.haeufigkeit
    FROM song_chapters sc
    LEFT JOIN chapters c ON c.chapter_id = sc.chapter_id
    WHERE sc.song_id IN ${idSql}
    ORDER BY sc.haeufigkeit DESC, c.position
  `).all(...idVals);
  const fgRows = db.prepare(`
    SELECT sf.song_id, f.fig_id, f.name, sf.kontext_typ
    FROM song_figures sf
    JOIN figures f ON f.id = sf.figure_id
    WHERE sf.song_id IN ${idSql}
  `).all(...idVals);
  const scRows = db.prepare(`
    SELECT ss.song_id, fs.id AS scene_id, fs.titel
    FROM song_scenes ss
    JOIN figure_scenes fs ON fs.id = ss.scene_id
    WHERE ss.song_id IN ${idSql}
  `).all(...idVals);

  const chBy = new Map();
  for (const r of chRows) {
    if (!chBy.has(r.song_id)) chBy.set(r.song_id, []);
    chBy.get(r.song_id).push({ chapter_id: r.chapter_id, chapter_name: r.chapter_name || null, haeufigkeit: r.haeufigkeit });
  }
  const fgBy = new Map();
  for (const r of fgRows) {
    if (!fgBy.has(r.song_id)) fgBy.set(r.song_id, []);
    fgBy.get(r.song_id).push({ fig_id: r.fig_id, name: r.name || null, kontext_typ: r.kontext_typ || null });
  }
  const scBy = new Map();
  for (const r of scRows) {
    if (!scBy.has(r.song_id)) scBy.set(r.song_id, []);
    scBy.get(r.song_id).push({ scene_id: r.scene_id, titel: r.titel || null });
  }

  const total = rows.length;
  const limited = rows.slice(0, limit).map(r => ({
    song_id:                    r.song_uid,
    titel:                      r.titel,
    interpret:                  r.interpret || null,
    genre:                      r.genre || null,
    kontext_typ:                r.kontext_typ || null,
    beschreibung:               r.beschreibung || null,
    stimmung:                   r.stimmung || null,
    erste_erwaehnung:           r.erste_erwaehnung || null,
    erste_erwaehnung_page_id:   r.erste_erwaehnung_page_id || null,
    erste_erwaehnung_page_name: r.erste_erwaehnung_page_name || null,
    kapitel:                    chBy.get(r.id) || [],
    figuren:                    fgBy.get(r.id) || [],
    szenen:                     scBy.get(r.id) || [],
  }));

  return _truncateResult({
    songs: limited,
    total,
    ...(limited.length < total ? { truncated: true, shown: limited.length } : {}),
  });
}

// ── get_location_profile ──────────────────────────────────────────────────────

function tool_get_location_profile(input, ctx) {
  const userEmail = ctx.userEmail || null;
  let locRow = null;
  if (input?.loc_id) {
    locRow = db.prepare(`
      SELECT l.id, l.loc_id, l.name, l.typ, l.beschreibung, l.stimmung,
             l.erste_erwaehnung, l.erste_erwaehnung_page_id, p.page_name AS erste_erwaehnung_page_name
      FROM locations l
      LEFT JOIN pages p ON p.page_id = l.erste_erwaehnung_page_id
      WHERE l.book_id = ? AND l.loc_id = ? AND l.user_email IS ?
    `).get(ctx.bookId, input.loc_id, userEmail);
  }
  if (!locRow && input?.name) {
    const q = `%${input.name}%`;
    locRow = db.prepare(`
      SELECT l.id, l.loc_id, l.name, l.typ, l.beschreibung, l.stimmung,
             l.erste_erwaehnung, l.erste_erwaehnung_page_id, p.page_name AS erste_erwaehnung_page_name
      FROM locations l
      LEFT JOIN pages p ON p.page_id = l.erste_erwaehnung_page_id
      WHERE l.book_id = ? AND l.user_email IS ? AND l.name LIKE ?
      ORDER BY CASE WHEN l.name = ? THEN 0 ELSE 1 END, l.sort_order, l.id
      LIMIT 1
    `).get(ctx.bookId, userEmail, q, input.name);
  }
  if (!locRow) return { error: 'Ort nicht gefunden. Erst list_locations rufen, um loc_id/Name zu ermitteln.' };

  const kapitel = db.prepare(`
    SELECT lc.chapter_id, c.chapter_name, lc.haeufigkeit
    FROM location_chapters lc
    LEFT JOIN chapters c ON c.chapter_id = lc.chapter_id
    WHERE lc.location_id = ?
    ORDER BY c.position
  `).all(locRow.id).map(r => ({ chapter_id: r.chapter_id, chapter_name: r.chapter_name || null, haeufigkeit: r.haeufigkeit }));

  const figuren = db.prepare(`
    SELECT f.fig_id, f.name
    FROM location_figures lf
    JOIN figures f ON f.id = lf.figure_id AND f.book_id = ? AND f.user_email IS ?
    WHERE lf.location_id = ?
  `).all(ctx.bookId, userEmail, locRow.id).map(r => ({ fig_id: r.fig_id, name: r.name || null }));

  const szenen = db.prepare(`
    SELECT fs.id AS scene_id, fs.titel, fs.wertung,
           fs.chapter_id, c.chapter_name, fs.page_id, p.page_name
    FROM scene_locations sl
    JOIN figure_scenes fs ON fs.id = sl.scene_id
    LEFT JOIN chapters c ON c.chapter_id = fs.chapter_id
    LEFT JOIN pages    p ON p.page_id    = fs.page_id
    WHERE sl.location_id = ? AND fs.book_id = ? AND fs.user_email IS ?
    ORDER BY fs.sort_order, fs.id
  `).all(locRow.id, ctx.bookId, userEmail).map(r => ({
    scene_id: r.scene_id, titel: r.titel, wertung: r.wertung || null,
    chapter_id: r.chapter_id, chapter_name: r.chapter_name || null,
    page_id: r.page_id, page_name: r.page_name || null,
  }));

  return _truncateResult({
    loc_id:                     locRow.loc_id,
    name:                       locRow.name,
    typ:                        locRow.typ || null,
    beschreibung:               locRow.beschreibung || null,
    stimmung:                   locRow.stimmung || null,
    erste_erwaehnung:           locRow.erste_erwaehnung || null,
    erste_erwaehnung_page_id:   locRow.erste_erwaehnung_page_id || null,
    erste_erwaehnung_page_name: locRow.erste_erwaehnung_page_name || null,
    kapitel,
    last_chapter: kapitel.length ? kapitel[kapitel.length - 1] : null,
    figuren,
    szenen,
    total_kapitel: kapitel.length,
    total_figuren: figuren.length,
    total_szenen: szenen.length,
  });
}

// ── list_scenes ───────────────────────────────────────────────────────────────

const SCENES_DEFAULT_LIMIT = 50;

function tool_list_scenes(input, ctx) {
  const userEmail = ctx.userEmail || null;
  const chapterFilter = Number.isInteger(input?.chapter_id) ? input.chapter_id : null;
  const pageFilter    = Number.isInteger(input?.page_id)    ? input.page_id    : null;
  const limit = Math.min(200, Math.max(1, Number.isInteger(input?.limit) ? input.limit : SCENES_DEFAULT_LIMIT));

  let figFilterId = null;
  if (input?.figur_id || input?.figur_name) {
    const figRow = _findFigure(input, ctx);
    if (!figRow) return { error: 'Figur nicht gefunden' };
    figFilterId = figRow.id;
  }
  let locFilterId = null;
  if (input?.loc_id) {
    const locRow = db.prepare(
      'SELECT id FROM locations WHERE book_id = ? AND loc_id = ? AND user_email IS ?'
    ).get(ctx.bookId, input.loc_id, userEmail);
    if (!locRow) return { error: 'Ort nicht gefunden' };
    locFilterId = locRow.id;
  }

  let sql = `
    SELECT fs.id, fs.titel, fs.wertung, fs.kommentar, fs.sort_order,
           fs.chapter_id, c.chapter_name,
           fs.page_id, p.page_name
    FROM figure_scenes fs
    LEFT JOIN chapters c ON c.chapter_id = fs.chapter_id
    LEFT JOIN pages    p ON p.page_id    = fs.page_id
    WHERE fs.book_id = ? AND fs.user_email IS ?
  `;
  const params = [ctx.bookId, userEmail];
  if (chapterFilter !== null) { sql += ' AND fs.chapter_id = ?'; params.push(chapterFilter); }
  if (pageFilter    !== null) { sql += ' AND fs.page_id = ?';    params.push(pageFilter); }
  if (figFilterId   !== null) {
    sql += ' AND fs.id IN (SELECT scene_id FROM scene_figures WHERE figure_id = ?)';
    params.push(figFilterId);
  }
  if (locFilterId !== null) {
    sql += ' AND fs.id IN (SELECT scene_id FROM scene_locations WHERE location_id = ?)';
    params.push(locFilterId);
  }
  sql += ' ORDER BY fs.sort_order, fs.id';

  const rows = db.prepare(sql).all(...params);
  if (!rows.length) return { scenes: [], total: 0, hint: 'Keine Szenen für diesen Filter.' };

  const sceneIds = rows.map(r => r.id);
  const { sql: idSql, values: idVals } = inClause(sceneIds);

  const sfRows = db.prepare(`
    SELECT sf.scene_id, f.fig_id, f.name
    FROM scene_figures sf
    JOIN figures f ON f.id = sf.figure_id
    WHERE sf.scene_id IN ${idSql}
  `).all(...idVals);
  const slRows = db.prepare(`
    SELECT sl.scene_id, l.loc_id, l.name
    FROM scene_locations sl
    JOIN locations l ON l.id = sl.location_id
    WHERE sl.scene_id IN ${idSql}
  `).all(...idVals);

  const sfBy = new Map();
  for (const r of sfRows) {
    if (!sfBy.has(r.scene_id)) sfBy.set(r.scene_id, []);
    sfBy.get(r.scene_id).push({ fig_id: r.fig_id, name: r.name });
  }
  const slBy = new Map();
  for (const r of slRows) {
    if (!slBy.has(r.scene_id)) slBy.set(r.scene_id, []);
    slBy.get(r.scene_id).push({ loc_id: r.loc_id, name: r.name });
  }

  const total = rows.length;
  const limited = rows.slice(0, limit).map(r => ({
    scene_id: r.id,
    titel: r.titel,
    wertung: r.wertung || null,
    kommentar: r.kommentar || null,
    chapter_id: r.chapter_id, chapter_name: r.chapter_name || null,
    page_id: r.page_id, page_name: r.page_name || null,
    figuren: sfBy.get(r.id) || [],
    orte:    slBy.get(r.id) || [],
  }));

  return _truncateResult({
    scenes: limited,
    total,
    ...(limited.length < total ? { truncated: true, shown: limited.length } : {}),
  });
}

// ── get_book_settings ─────────────────────────────────────────────────────────

const BUCHTYP_LABELS_DE = {
  roman: 'Roman',
  kurzgeschichten: 'Kurzgeschichten',
  gesellschaft: 'Gesellschaftsroman',
  krimi: 'Krimi / Thriller',
  historisch: 'Historischer Roman',
  fantasy_scifi: 'Fantasy / Science-Fiction',
  erotik: 'Erotik',
  jugend: 'Jugendbuch / Kinderbuch',
  autobiografie: 'Autobiografie / Memoir',
  tagebuch: 'Tagebuch',
  sachbuch: 'Sachbuch',
  lyrik: 'Lyrik',
  essay: 'Essay',
  blog: 'Blog',
  satire: 'Satire',
  andere: 'Andere',
};

function tool_get_book_settings(_input, ctx) {
  const userEmail = ctx.userEmail || null;
  const settings = getBookSettings(ctx.bookId, userEmail);
  const bookRow = db.prepare('SELECT name FROM books WHERE book_id = ?').get(ctx.bookId);
  const labels = narrativeLabels(settings);
  return {
    book_id:                  ctx.bookId,
    book_name:                bookRow?.name || null,
    language:                 settings.language,
    region:                   settings.region,
    locale:                   `${settings.language}-${settings.region}`,
    buchtyp:                  settings.buchtyp || null,
    buchtyp_label:            settings.buchtyp ? (BUCHTYP_LABELS_DE[settings.buchtyp] || settings.buchtyp) : null,
    erzaehlperspektive:       settings.erzaehlperspektive || null,
    erzaehlperspektive_label: labels.erzaehlperspektive,
    erzaehlzeit:              settings.erzaehlzeit || null,
    erzaehlzeit_label:        labels.erzaehlzeit,
    buch_kontext:             settings.buch_kontext || null,
    is_finished:              settings.is_finished ? 1 : 0,
    daily_goal_chars:         settings.daily_goal_chars || null,
  };
}

// ── list_figures ──────────────────────────────────────────────────────────────

const LIST_FIGURES_DEFAULT_LIMIT = 50;
const LIST_FIGURES_MAX_LIMIT     = 200;

function tool_list_figures(input, ctx) {
  const userEmail = ctx.userEmail || null;
  const limit = Math.min(Math.max(1, input?.limit || LIST_FIGURES_DEFAULT_LIMIT), LIST_FIGURES_MAX_LIMIT);
  const sort = ['mentions_desc', 'name', 'presence_desc'].includes(input?.sort) ? input.sort : 'mentions_desc';

  const rows = db.prepare(`
    SELECT f.id, f.fig_id, f.name, f.kurzname, f.typ, f.rolle, f.praesenz,
           COALESCE(SUM(pfm.count), 0) AS mentions
    FROM figures f
    LEFT JOIN page_figure_mentions pfm ON pfm.figure_id = f.id
    LEFT JOIN pages p ON p.page_id = pfm.page_id AND p.book_id = f.book_id
    WHERE f.book_id = ? AND f.user_email IS ?
    GROUP BY f.id
    ORDER BY f.sort_order, f.id
  `).all(ctx.bookId, userEmail);

  const PRES_ORDER = { 'haupt': 0, 'protagonist': 0, 'haupt-': 0, 'wichtig': 1, 'neben': 2, 'rand': 3, 'statist': 4 };
  const presKey = (p) => {
    if (!p) return 99;
    const k = String(p).toLowerCase();
    for (const key of Object.keys(PRES_ORDER)) if (k.includes(key)) return PRES_ORDER[key];
    return 50;
  };

  const sorted = [...rows];
  if (sort === 'mentions_desc') sorted.sort((a, b) => b.mentions - a.mentions || a.id - b.id);
  else if (sort === 'name')      sorted.sort((a, b) => a.name.localeCompare(b.name));
  else if (sort === 'presence_desc') sorted.sort((a, b) => presKey(a.praesenz) - presKey(b.praesenz) || b.mentions - a.mentions);

  const sliced = sorted.slice(0, limit);
  return _truncateResult({
    total: rows.length,
    results: sliced.map(r => ({
      fig_id:   r.fig_id,
      name:     r.name,
      kurzname: r.kurzname || null,
      typ:      r.typ || null,
      rolle:    r.rolle || null,
      praesenz: r.praesenz || null,
      mentions: r.mentions,
    })),
    ...(sliced.length < rows.length ? { truncated: true, total_results: rows.length } : {}),
  });
}

// ── list_revisions ────────────────────────────────────────────────────────────

const LIST_REVISIONS_DEFAULT_LIMIT = 20;
const LIST_REVISIONS_MAX_LIMIT     = 100;

function tool_list_revisions(input, ctx) {
  const pageId = input?.page_id;
  if (!Number.isInteger(pageId)) return { error: 'page_id fehlt' };

  const pageRow = db.prepare(`
    SELECT p.page_id, p.page_name, p.chapter_id, c.chapter_name, p.book_id
    FROM pages p
    LEFT JOIN chapters c ON c.chapter_id = p.chapter_id AND c.book_id = p.book_id
    WHERE p.page_id = ?
  `).get(pageId);
  if (!pageRow || pageRow.book_id !== ctx.bookId) {
    return { error: 'Seite nicht im aktuellen Buch.' };
  }

  const limit = Math.min(Math.max(1, input?.limit || LIST_REVISIONS_DEFAULT_LIMIT), LIST_REVISIONS_MAX_LIMIT);
  const total = pageRevisions.countForPage(pageId);
  const revs  = pageRevisions.listForPage(pageId, limit);

  return _truncateResult({
    page_id:      pageId,
    page_name:    pageRow.page_name,
    chapter_id:   pageRow.chapter_id || null,
    chapter_name: pageRow.chapter_name || null,
    total_revisions: total,
    results: revs.map(r => ({
      rev_id:     r.id,
      created_at: r.created_at,
      source:     r.source,
      user_email: r.user_email || null,
      chars:      r.chars,
      words:      r.words,
      summary:    r.summary || null,
    })),
    ...(revs.length < total ? { truncated: true, total_results: total } : {}),
  });
}

// ── list_world_facts ────────────────────────────────────────────────────────
// Deklaratives Buch-Wissen (Weltregeln/Fakten) aus der Komplettanalyse.
// Optionale Filter: kategorie (exakt), subjekt (Teilstring). Kapitelname per JOIN
// zur Lesezeit (kein Snapshot).
function tool_list_world_facts(input, ctx) {
  const userEmail = ctx.userEmail || null;
  const kategorie = typeof input?.kategorie === 'string' && input.kategorie.trim() ? input.kategorie.trim().toLowerCase() : null;
  const subjekt   = typeof input?.subjekt === 'string' && input.subjekt.trim() ? input.subjekt.trim() : null;

  let sql = `
    SELECT wf.id, wf.kategorie, wf.subjekt, wf.fakt, wf.seite_label
    FROM world_facts wf
    WHERE wf.book_id = ? AND wf.user_email IS ?`;
  const params = [ctx.bookId, userEmail];
  if (kategorie !== null) { sql += ' AND wf.kategorie = ?'; params.push(kategorie); }
  if (subjekt !== null)   { sql += ' AND wf.subjekt LIKE ?'; params.push(`%${subjekt}%`); }
  sql += ' ORDER BY wf.sort_order, wf.id';

  const rows = db.prepare(sql).all(...params);
  if (!rows.length) {
    return { fakten: [], hint: 'Keine Welt-Fakten vorhanden. Komplettanalyse ausführen.' };
  }

  const factIds = rows.map(r => r.id);
  const { sql: idSql, values: idVals } = inClause(factIds);
  const chRows = db.prepare(`
    SELECT wfc.fact_id, c.chapter_name
    FROM world_fact_chapters wfc
    LEFT JOIN chapters c ON c.chapter_id = wfc.chapter_id
    WHERE wfc.fact_id IN ${idSql}
    ORDER BY wfc.fact_id, c.position
  `).all(...idVals);
  const chByFact = new Map();
  for (const r of chRows) {
    if (!chByFact.has(r.fact_id)) chByFact.set(r.fact_id, []);
    if (r.chapter_name) chByFact.get(r.fact_id).push(r.chapter_name);
  }

  return _truncateResult({
    fakten: rows.map(r => ({
      kategorie:    r.kategorie || null,
      subjekt:      r.subjekt || null,
      fakt:         r.fakt,
      seite:        r.seite_label || null,
      kapitel:      chByFact.get(r.id) || [],
    })),
    total: rows.length,
  });
}

module.exports = {
  tool_list_chapters,
  tool_list_ideen,
  tool_list_locations,
  tool_get_location_profile,
  tool_list_scenes,
  tool_list_songs,
  tool_get_book_settings,
  tool_list_figures,
  tool_list_revisions,
  tool_list_world_facts,
};
