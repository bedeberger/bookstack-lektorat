'use strict';
// CRUD für die Plot-Werkstatt (Beat-Board). Pro Buch + User skopiert; der
// Owner-/ACL-Check geschieht im Route-Handler.
//
// Datenmodell:
//   plot_acts        — Spalten des Boards (Akte/Phasen), geordnet via position.
//   plot_beats       — Karten (Handlungspunkte) in einem Akt, geordnet via sort_order.
//   plot_beat_figures — M:M Beat ↔ Figur (welche Figuren im Beat vorkommen).
//
// status eines Beats: 'geplant' | 'im_buch' — binäre Realisierungsachse („Idee vs.
// eingearbeitet"). verworfen (0/1) ist eine orthogonale Verwerfen-Achse (bleibt bei
// Status-Wechsel erhalten). chapter_id (SET NULL) verknüpft den Beat mit dem
// Kapitel, in dem er im Manuskript landet.
//
// archiviert (0/1) auf plot_acts ist die Akt-Ebene davon — und bewusst NICHT
// dasselbe wie verworfen: „verworfen" heisst ausgemustert (soll nicht ins Buch),
// „archiviert" heisst erledigt (ist im Buch, Akt abgeschlossen). Die Beats eines
// archivierten Akts bleiben darum in allen Kennzahlen; das Flag wirkt auf die
// Anzeige (Spalte hinter dem Archiv-Schalter) und auf den Konsistenz-Prompt (der
// Akt wird als abgeschlossen deklariert statt weiter beanstandet).

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');

// ── Akte ─────────────────────────────────────────────────────────────────────

// thread_id NULL = geteilter Akt (Default, flaches Board + Stränge ohne eigene
// Akte); thread_id = T = Akt gehört nur Strang T (Hybrid-Akte, Migration 193).
const _stmtListActs = db.prepare(`
  SELECT id, book_id, user_email, name, farbe, thread_id, archiviert, position, created_at, updated_at
    FROM plot_acts
   WHERE book_id = ? AND user_email = ?
   ORDER BY position, id
`);
const _stmtInsertAct = db.prepare(`
  INSERT INTO plot_acts (book_id, user_email, name, farbe, thread_id, archiviert, position, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL}, ${NOW_ISO_SQL})
`);
const _stmtGetAct = db.prepare('SELECT * FROM plot_acts WHERE id = ?');
const _stmtUpdateAct = db.prepare(`
  UPDATE plot_acts SET name = ?, farbe = ?, archiviert = ?, updated_at = ${NOW_ISO_SQL} WHERE id = ?
`);
const _stmtSetActPosition = db.prepare(`
  UPDATE plot_acts SET position = ?, updated_at = ${NOW_ISO_SQL} WHERE id = ? AND book_id = ? AND user_email = ?
`);
const _stmtDeleteAct = db.prepare('DELETE FROM plot_acts WHERE id = ?');
// position ist PRO SCOPE (thread_id IS ?) lückenlos: geteilte Akte und die Akte
// jedes Strangs bilden je eine eigene 0..n-Sequenz. thread_id IS ? ist NULL-safe.
const _stmtMaxActPos = db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM plot_acts WHERE book_id = ? AND user_email = ? AND thread_id IS ?');

function listActs(bookId, userEmail) {
  return _stmtListActs.all(parseInt(bookId), userEmail);
}

function getAct(id) {
  return _stmtGetAct.get(parseInt(id)) || null;
}

function createAct(bookId, userEmail, { name, farbe = null, threadId = null, archiviert = 0, position = null }) {
  const tid = threadId != null ? parseInt(threadId) : null;
  const pos = position != null ? parseInt(position) : (_stmtMaxActPos.get(parseInt(bookId), userEmail, tid).m + 1);
  const info = _stmtInsertAct.run(parseInt(bookId), userEmail, name, farbe, tid, archiviert ? 1 : 0, pos);
  return getAct(info.lastInsertRowid);
}

// archiviert wird wie name/farbe als Vollwert übergeben (der Route-Handler füllt
// nicht übergebene Felder aus dem geladenen Akt auf) — ein Teil-UPDATE mit
// dynamischem SET-Fragment lohnt bei drei Spalten nicht.
function updateAct(id, { name, farbe = null, archiviert = 0 }) {
  _stmtUpdateAct.run(name, farbe, archiviert ? 1 : 0, parseInt(id));
  return getAct(id);
}

function deleteAct(id) {
  // plot_beats hängen via ON DELETE CASCADE dran — sie verschwinden mit dem Akt.
  _stmtDeleteAct.run(parseInt(id));
}

// Akt-Reihenfolge neu setzen (Drag der Spalten). orderedIds = Akt-IDs in Zielreihenfolge.
const reorderActs = db.transaction((bookId, userEmail, orderedIds) => {
  orderedIds.forEach((actId, idx) => {
    _stmtSetActPosition.run(idx, parseInt(actId), parseInt(bookId), userEmail);
  });
});

// ── Handlungsstränge (Swimlanes) ───────────────────────────────────────────
// Zweite Ordnungsachse neben den Akten: das Board wird ein Raster Akte × Stränge,
// ein Beat sitzt in der Zelle (act_id, thread_id). Strang optional an eine
// Katalog-Figur (figure_id → figures.id, INTEGER-FK) ODER Werkstatt-Figur
// (draft_figure_id → draft_figures.id) gebunden. Nach aussen wird für die
// Katalog-Bindung die TEXT-fig_id exponiert (Frontend-Identität, vgl. Beats);
// die Werkstatt-Bindung ist bereits die INTEGER-id (keine Indirektion).
// chapter_id (SET NULL) bindet optional ein Zielkapitel an den Strang; die Beats
// der Lane erben es live (Anzeige + KI-Kontext, nie auf den Beat geschrieben).
// chapter_name via JOIN als Anzeige-Wert zur Lesezeit (kein Snapshot).
const _THREAD_SELECT = `
  SELECT t.id, t.book_id, t.user_email, t.name, t.farbe,
         t.figure_id, f.fig_id AS fig_id, t.draft_figure_id,
         t.chapter_id, c.chapter_name AS chapter_name,
         t.position, t.created_at, t.updated_at
    FROM plot_threads t
    LEFT JOIN figures f ON f.id = t.figure_id
    LEFT JOIN chapters c ON c.chapter_id = t.chapter_id
`;
const _stmtListThreads = db.prepare(`${_THREAD_SELECT} WHERE t.book_id = ? AND t.user_email = ? ORDER BY t.position, t.id`);
const _stmtGetThread = db.prepare(`${_THREAD_SELECT} WHERE t.id = ?`);
const _stmtInsertThread = db.prepare(`
  INSERT INTO plot_threads (book_id, user_email, name, farbe, figure_id, draft_figure_id, chapter_id, position, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL}, ${NOW_ISO_SQL})
`);
const _stmtUpdateThread = db.prepare(`
  UPDATE plot_threads SET name = ?, farbe = ?, figure_id = ?, draft_figure_id = ?, chapter_id = ?, updated_at = ${NOW_ISO_SQL} WHERE id = ?
`);
const _stmtSetThreadPosition = db.prepare(`
  UPDATE plot_threads SET position = ?, updated_at = ${NOW_ISO_SQL} WHERE id = ? AND book_id = ? AND user_email = ?
`);
const _stmtDeleteThread = db.prepare('DELETE FROM plot_threads WHERE id = ?');
const _stmtMaxThreadPos = db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM plot_threads WHERE book_id = ? AND user_email = ?');

function listThreads(bookId, userEmail) {
  return _stmtListThreads.all(parseInt(bookId), userEmail);
}

function getThread(id) {
  return _stmtGetThread.get(parseInt(id)) || null;
}

// figureId/draftFigureId sind bereits INTEGER-IDs (in der Route via
// resolveFigureIds/resolveDraftFigureIds aufgelöst), oder null. chapterId ist
// bereits via _validChapterId aufs Buch validiert, oder null.
function createThread(bookId, userEmail, { name, farbe = null, figureId = null, draftFigureId = null, chapterId = null, position = null }) {
  const pos = position != null ? parseInt(position) : (_stmtMaxThreadPos.get(parseInt(bookId), userEmail).m + 1);
  const info = _stmtInsertThread.run(
    parseInt(bookId), userEmail, name, farbe,
    figureId != null ? parseInt(figureId) : null,
    draftFigureId != null ? parseInt(draftFigureId) : null,
    chapterId != null ? parseInt(chapterId) : null, pos
  );
  return getThread(info.lastInsertRowid);
}

function updateThread(id, { name, farbe = null, figureId = null, draftFigureId = null, chapterId = null }) {
  _stmtUpdateThread.run(
    name, farbe,
    figureId != null ? parseInt(figureId) : null,
    draftFigureId != null ? parseInt(draftFigureId) : null,
    chapterId != null ? parseInt(chapterId) : null, parseInt(id)
  );
  return getThread(id);
}

// Strang löschen. plot_beats.thread_id hängt via SET NULL — die Beats bleiben und
// fallen in die „ohne Strang"-Lane. ABER: hat der Strang eigene Akte (Hybrid),
// hingen diese via plot_acts.thread_id-CASCADE am Strang und würden ihre Beats
// mit-kaskadieren. Darum VOR dem Löschen die Beats eigener Akte auf geteilte Akte
// umhängen (oder die eigenen Akte zu geteilten befördern, falls keine geteilten
// existieren) — Invariante „Strang löschen ≠ Beats löschen".
const deleteThread = db.transaction((id) => {
  const t = _stmtGetThread.get(parseInt(id));
  if (t) _landThreadBeatsOnSharedActs(t.book_id, t.user_email, t.id);
  _stmtDeleteThread.run(parseInt(id));
});

// Strang-Reihenfolge neu setzen (Zeilen-Reorder). orderedIds in Zielreihenfolge.
const reorderThreads = db.transaction((bookId, userEmail, orderedIds) => {
  orderedIds.forEach((threadId, idx) => {
    _stmtSetThreadPosition.run(idx, parseInt(threadId), parseInt(bookId), userEmail);
  });
});

// threadId aufs (Buch, User)-Subset validieren; Fremd-/Unbekannt/leer → null.
// Verhindert, dass ein Beat einem fremden Strang zugeordnet wird.
function _validThreadId(bookId, userEmail, threadId) {
  if (!threadId) return null;
  const r = _stmtGetThread.get(parseInt(threadId));
  return (r && r.book_id === parseInt(bookId) && r.user_email === userEmail) ? r.id : null;
}

// ── Beats ──────────────────────────────────────────────────────────────────

const _BEAT_SELECT = `
  SELECT b.id, b.book_id, b.act_id, b.thread_id, b.user_email, b.titel, b.beschreibung,
         b.status, b.verworfen, b.chapter_id, c.chapter_name, b.intensitaet, b.sort_order,
         b.created_at, b.updated_at
    FROM plot_beats b
    LEFT JOIN chapters c ON c.chapter_id = b.chapter_id
`;
const _stmtListBeats = db.prepare(`
  ${_BEAT_SELECT}
   WHERE b.book_id = ? AND b.user_email = ?
   ORDER BY b.act_id, b.sort_order, b.id
`);
const _stmtGetBeat = db.prepare(`${_BEAT_SELECT} WHERE b.id = ?`);
const _stmtInsertBeat = db.prepare(`
  INSERT INTO plot_beats (book_id, act_id, thread_id, user_email, titel, beschreibung, status, verworfen, chapter_id, intensitaet, sort_order, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL}, ${NOW_ISO_SQL})
`);
const _stmtDeleteBeat = db.prepare('DELETE FROM plot_beats WHERE id = ?');
// sort_order ist pro ZELLE (act_id, thread_id) lückenlos. thread_id IS ? ist
// NULL-safe (gebundener NULL-Parameter → „ohne Strang"-Lane).
const _stmtMaxBeatOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM plot_beats WHERE act_id = ? AND thread_id IS ?');
const _stmtSetBeatSlot = db.prepare(`
  UPDATE plot_beats SET act_id = ?, thread_id = ?, sort_order = ?, updated_at = ${NOW_ISO_SQL}
   WHERE id = ? AND book_id = ? AND user_email = ?
`);

// Figuren-Links pro Beat. plot_beat_figures.figure_id ist INTEGER-FK auf
// figures.id; nach aussen wird aber die TEXT-fig_id exponiert bzw. erwartet —
// das ist die Figur-Identität, mit der das Frontend arbeitet ($app.figuren[].id
// === fig_id, vgl. routes/figures.js). resolveFigureIds übersetzt eingehende
// fig_ids → figures.id, die Lese-Aggregate liefern fig_id zurück.
const _stmtListFigsForBook = db.prepare(`
  SELECT pbf.beat_id, f.fig_id AS fig_id
    FROM plot_beat_figures pbf
    JOIN plot_beats b ON b.id = pbf.beat_id
    JOIN figures   f ON f.id = pbf.figure_id
   WHERE b.book_id = ? AND b.user_email = ?
`);
// Figuren EINES Beats (für _beatRow ohne vorgebaute Buch-Map — verhindert den
// buchweiten Link-Scan bei jeder Einzel-Beat-Mutation/-Lesung).
const _stmtFigsForBeat = db.prepare(`
  SELECT f.fig_id AS fig_id
    FROM plot_beat_figures pbf
    JOIN figures f ON f.id = pbf.figure_id
   WHERE pbf.beat_id = ?
`);
const _stmtDeleteFigsForBeat = db.prepare('DELETE FROM plot_beat_figures WHERE beat_id = ?');
const _stmtInsertFig = db.prepare('INSERT OR IGNORE INTO plot_beat_figures (beat_id, figure_id) VALUES (?, ?)');

// Werkstatt-Figuren (draft_figures) pro Beat. Anders als bei plot_beat_figures
// IST die draft_figures.id (INTEGER) bereits die Frontend-Identität — keine
// TEXT-fig_id-Indirektion. Lese-Aggregat liefert die INTEGER-id direkt zurück.
const _stmtListDraftFigsForBook = db.prepare(`
  SELECT pbdf.beat_id, pbdf.draft_figure_id AS draft_id
    FROM plot_beat_draft_figures pbdf
    JOIN plot_beats b ON b.id = pbdf.beat_id
   WHERE b.book_id = ? AND b.user_email = ?
`);
// Werkstatt-Figuren EINES Beats (Pendant zu _stmtFigsForBeat).
const _stmtDraftFigsForBeat = db.prepare(`
  SELECT pbdf.draft_figure_id AS draft_id
    FROM plot_beat_draft_figures pbdf
   WHERE pbdf.beat_id = ?
`);
const _stmtDeleteDraftFigsForBeat = db.prepare('DELETE FROM plot_beat_draft_figures WHERE beat_id = ?');
const _stmtInsertDraftFig = db.prepare('INSERT OR IGNORE INTO plot_beat_draft_figures (beat_id, draft_figure_id) VALUES (?, ?)');

// Motiv-Soll-Verknüpfungen pro Beat — read-only Anzeige im Plot. `motif_beats` ist
// eine der M:M-Soll-Brücken der Motiv-Werkstatt; kuratiert wird sie dort, der Plot
// zeigt sie nur als Badge (Klick → Motiv-Werkstatt). Effektive Farbe = eigene
// Motiv-Farbe, sonst die des zugeordneten Themas (wie im Konstellations-Graph);
// beides ist ein Palette-Schlüssel, die Whitelist gegen CSS-Injection liegt im
// Frontend (motifAccent). Scoping über den Beat (Buch + User); die verknüpften
// Motive tragen denselben Scope (Motiv-Werkstatt ist pro Buch + User isoliert).
const _stmtListMotifsForBook = db.prepare(`
  SELECT mb.beat_id, m.id AS motif_id, m.name, COALESCE(m.farbe, t.farbe) AS farbe
    FROM motif_beats mb
    JOIN plot_beats b ON b.id = mb.beat_id
    JOIN motifs     m ON m.id = mb.motif_id
    LEFT JOIN themes t ON t.id = m.theme_id
   WHERE b.book_id = ? AND b.user_email = ?
   ORDER BY m.position, m.id
`);
// Motive EINES Beats (Pendant zu _stmtFigsForBeat — Einzel-Beat-Pfad ohne Buch-Map).
const _stmtMotifsForBeat = db.prepare(`
  SELECT m.id AS motif_id, m.name, COALESCE(m.farbe, t.farbe) AS farbe
    FROM motif_beats mb
    JOIN motifs m ON m.id = mb.motif_id
    LEFT JOIN themes t ON t.id = m.theme_id
   WHERE mb.beat_id = ?
   ORDER BY m.position, m.id
`);
// Schreibpfad Beat → Motiv (dieselbe motif_beats-Brücke, andere Achse): Full-Replace
// pro Beat. Berührt nur Zeilen WHERE beat_id = ? — kollidiert nicht mit dem
// Motiv-seitigen Full-Replace (setMotifBeats, WHERE motif_id = ?). So kuratiert
// der Plot dieselbe Verknüpfung von der Beat-Seite, ohne die Motiv-Werkstatt zu stören.
const _stmtDeleteMotifsForBeat = db.prepare('DELETE FROM motif_beats WHERE beat_id = ?');
const _stmtInsertBeatMotif = db.prepare('INSERT OR IGNORE INTO motif_beats (motif_id, beat_id) VALUES (?, ?)');

// TEXT-fig_id (Frontend-Identität) → INTEGER figures.id (FK-Target), gefiltert
// aufs Subset, das wirklich zu (Buch, User) gehört. Unbekannte/Fremd-fig_ids
// fallen still raus (kein Cross-Buch-Leak in die M:M-Tabelle).
function resolveFigureIds(bookId, userEmail, figIds) {
  if (!Array.isArray(figIds) || !figIds.length) return [];
  const wanted = figIds.map(x => String(x).trim()).filter(Boolean);
  if (!wanted.length) return [];
  const placeholders = wanted.map(() => '?').join(',');
  return db.prepare(
    `SELECT id FROM figures WHERE book_id = ? AND user_email = ? AND fig_id IN (${placeholders})`
  ).all(parseInt(bookId), userEmail, ...wanted).map(r => r.id);
}

// Werkstatt-Figur-IDs (INTEGER draft_figures.id) aufs Subset filtern, das wirklich
// zu (Buch, User) gehört. Unbekannte/Fremd-IDs fallen still raus (kein Cross-Buch-
// Leak in die M:M-Tabelle). Eingang sind bereits INTEGER-IDs (Frontend-Identität).
function resolveDraftFigureIds(bookId, userEmail, draftIds) {
  if (!Array.isArray(draftIds) || !draftIds.length) return [];
  const wanted = draftIds.map(x => parseInt(x)).filter(n => Number.isInteger(n) && n > 0);
  if (!wanted.length) return [];
  const placeholders = wanted.map(() => '?').join(',');
  return db.prepare(
    `SELECT id FROM draft_figures WHERE book_id = ? AND user_email = ? AND id IN (${placeholders})`
  ).all(parseInt(bookId), userEmail, ...wanted).map(r => r.id);
}

// Motiv-IDs (INTEGER motifs.id) aufs (Buch, User)-Subset filtern — kein Cross-Buch-
// Leak in die motif_beats-Brücke. Motive gehören zur Motiv-Werkstatt (pro Buch + User).
function resolveMotifIds(bookId, userEmail, motifIds) {
  if (!Array.isArray(motifIds) || !motifIds.length) return [];
  const wanted = motifIds.map(x => parseInt(x)).filter(n => Number.isInteger(n) && n > 0);
  if (!wanted.length) return [];
  const placeholders = wanted.map(() => '?').join(',');
  return db.prepare(
    `SELECT id FROM motifs WHERE book_id = ? AND user_email = ? AND id IN (${placeholders})`
  ).all(parseInt(bookId), userEmail, ...wanted).map(r => r.id);
}

function _figMapForBook(bookId, userEmail) {
  const map = {};
  for (const r of _stmtListFigsForBook.all(parseInt(bookId), userEmail)) {
    (map[r.beat_id] = map[r.beat_id] || []).push(r.fig_id);
  }
  return map;
}

function _draftFigMapForBook(bookId, userEmail) {
  const map = {};
  for (const r of _stmtListDraftFigsForBook.all(parseInt(bookId), userEmail)) {
    (map[r.beat_id] = map[r.beat_id] || []).push(r.draft_id);
  }
  return map;
}

function _motifMapForBook(bookId, userEmail) {
  const map = {};
  for (const r of _stmtListMotifsForBook.all(parseInt(bookId), userEmail)) {
    (map[r.beat_id] = map[r.beat_id] || []).push({ id: r.motif_id, name: r.name, farbe: r.farbe });
  }
  return map;
}

// figureIds = INTEGER figures.id (bereits via resolveFigureIds aufgelöst).
function _setBeatFigures(beatId, figureIds) {
  _stmtDeleteFigsForBeat.run(parseInt(beatId));
  for (const fid of (figureIds || [])) {
    if (Number.isInteger(fid) || /^\d+$/.test(String(fid))) _stmtInsertFig.run(parseInt(beatId), parseInt(fid));
  }
}

// draftFigureIds = INTEGER draft_figures.id (bereits via resolveDraftFigureIds aufgelöst).
function _setBeatDraftFigures(beatId, draftFigureIds) {
  _stmtDeleteDraftFigsForBeat.run(parseInt(beatId));
  for (const fid of (draftFigureIds || [])) {
    if (Number.isInteger(fid) || /^\d+$/.test(String(fid))) _stmtInsertDraftFig.run(parseInt(beatId), parseInt(fid));
  }
}

// motifIds = INTEGER motifs.id (bereits via resolveMotifIds aufgelöst). Full-Replace
// pro Beat: alle Motiv-Links dieses Beats löschen, die gewählten neu setzen.
function _setBeatMotifs(beatId, motifIds) {
  _stmtDeleteMotifsForBeat.run(parseInt(beatId));
  for (const mid of (motifIds || [])) {
    if (Number.isInteger(mid) || /^\d+$/.test(String(mid))) _stmtInsertBeatMotif.run(parseInt(mid), parseInt(beatId));
  }
}

function _beatRow(beatId, figMap = null, draftFigMap = null, motifMap = null) {
  const r = _stmtGetBeat.get(parseInt(beatId));
  if (!r) return null;
  // Ohne vorgebaute Buch-Map (Einzel-Beat-Pfad) gezielt nur die Links DIESES
  // Beats laden — kein buchweiter Scan pro Mutation/Lesung.
  const figs = figMap ? (figMap[r.id] || []) : _stmtFigsForBeat.all(r.id).map(x => x.fig_id);
  const draftFigs = draftFigMap ? (draftFigMap[r.id] || []) : _stmtDraftFigsForBeat.all(r.id).map(x => x.draft_id);
  const motifs = motifMap ? (motifMap[r.id] || []) : _stmtMotifsForBeat.all(r.id).map(x => ({ id: x.motif_id, name: x.name, farbe: x.farbe }));
  return { ...r, fig_ids: figs, draft_fig_ids: draftFigs, motifs };
}

function listBeats(bookId, userEmail) {
  const figMap = _figMapForBook(bookId, userEmail);
  const draftFigMap = _draftFigMapForBook(bookId, userEmail);
  const motifMap = _motifMapForBook(bookId, userEmail);
  return _stmtListBeats.all(parseInt(bookId), userEmail)
    .map(r => ({ ...r, fig_ids: figMap[r.id] || [], draft_fig_ids: draftFigMap[r.id] || [], motifs: motifMap[r.id] || [] }));
}

const createBeat = db.transaction((bookId, actId, userEmail, { titel, beschreibung = null, status = 'geplant', verworfen = 0, chapterId = null, intensitaet = null, threadId = null, figureIds = [], draftFigureIds = [], motifIds = [], sortOrder = null }) => {
  const tid = threadId != null ? parseInt(threadId) : null;
  const pos = sortOrder != null ? parseInt(sortOrder) : (_stmtMaxBeatOrder.get(parseInt(actId), tid).m + 1);
  const info = _stmtInsertBeat.run(
    parseInt(bookId), parseInt(actId), tid, userEmail, titel, beschreibung, status, verworfen ? 1 : 0,
    chapterId != null ? parseInt(chapterId) : null,
    intensitaet != null ? parseInt(intensitaet) : null, pos
  );
  _setBeatFigures(info.lastInsertRowid, figureIds);
  _setBeatDraftFigures(info.lastInsertRowid, draftFigureIds);
  _setBeatMotifs(info.lastInsertRowid, motifIds);
  return _beatRow(info.lastInsertRowid);
});

// Partielles Update: nur übergebene Felder ändern. `fields` enthält bereits
// validierte Werte; `figureIds`/`draftFigureIds` (falls Array) ersetzen die
// jeweiligen Figuren-Links komplett.
const updateBeat = db.transaction((id, fields, figureIds, draftFigureIds, motifIds) => {
  const sets = [];
  const vals = [];
  for (const [col, val] of Object.entries(fields)) {
    sets.push(`${col} = ?`);
    vals.push(val);
  }
  if (sets.length) {
    sets.push(`updated_at = ${NOW_ISO_SQL}`);
    vals.push(parseInt(id));
    db.prepare(`UPDATE plot_beats SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  if (Array.isArray(figureIds)) _setBeatFigures(id, figureIds);
  if (Array.isArray(draftFigureIds)) _setBeatDraftFigures(id, draftFigureIds);
  if (Array.isArray(motifIds)) _setBeatMotifs(id, motifIds);
  return _beatRow(id);
});

function getBeat(id) {
  return _beatRow(id);
}

// Leichtgewichtiger Beat-Stamm (ohne Figuren-Arrays) für Owner-/Scope-Checks in
// den Routen. Trägt book_id/user_email/act_id/thread_id — alles, was die
// PATCH/DELETE-Handler zur Autorisierung + Hybrid-Akt-Prüfung brauchen, ohne den
// (per Beat sonst günstigen, aber unnötigen) Figuren-Aufbau von getBeat.
function getBeatMeta(id) {
  return _stmtGetBeat.get(parseInt(id)) || null;
}

// Map page_id → Anzahl nicht-verworfener Beats, die mit dem Kapitel der Seite
// verknüpft sind. Beats hängen über chapter_id am Kapitel (kein page_id), darum
// wird der Kapitel-Count auf jede Seite des Kapitels projiziert. Speist den
// Plot-Verknüpfungs-Indikator im Notebook-Editor (analog /research/page-counts).
function pageBeatCounts(bookId, userEmail) {
  const rows = db.prepare(`
    SELECT p.page_id AS page_id, COUNT(*) AS n
      FROM plot_beats b
      JOIN pages p ON p.chapter_id = b.chapter_id
     WHERE b.book_id = ? AND b.user_email = ? AND b.verworfen = 0
       AND b.chapter_id IS NOT NULL
     GROUP BY p.page_id
  `).all(parseInt(bookId), userEmail);
  const map = {};
  for (const r of rows) map[r.page_id] = r.n;
  return map;
}

// Map chapter_id → Anzahl nicht-verworfener Beats im Kapitel. Speist den
// Plot-Verknüpfungs-Indikator in der Kapitelansicht (analog zur Page-Variante,
// aber ohne Projektion — Beats hängen direkt am Kapitel).
function chapterBeatCounts(bookId, userEmail) {
  const rows = db.prepare(`
    SELECT chapter_id, COUNT(*) AS n
      FROM plot_beats
     WHERE book_id = ? AND user_email = ? AND verworfen = 0
       AND chapter_id IS NOT NULL
     GROUP BY chapter_id
  `).all(parseInt(bookId), userEmail);
  const map = {};
  for (const r of rows) map[r.chapter_id] = r.n;
  return map;
}

function deleteBeat(id) {
  _stmtDeleteBeat.run(parseInt(id));
}

// ── Cross-Feature: Plot-Beteiligung einer (Werkstatt-)Figur ──────────────────
// Welche Beats involvieren eine bestimmte Figur und an welche Stränge ist sie als
// Hauptfigur gebunden? Drei Quellen, dedupliziert:
//   a) direkt verknüpfte Werkstatt-Figur (plot_beat_draft_figures.draft_figure_id)
//   b) direkt verknüpfte Katalog-Figur (plot_beat_figures.figure_id = sourceFigureId)
//   c) implizit über einen Strang, an den die Figur gebunden ist (Live-Vererbung:
//      die Strang-Hauptfigur gilt in ALLEN Beats der Lane als beteiligt)
// Speist den Cross-Feature-Kontext der Figuren-Werkstatt-Jobs (Consistency/
// Brainstorm) und das „in N Beats geplant"-Badge (Navigation Werkstatt → Plot).
// Beats namensbasiert + lesefertig angereichert (Akt, Strang, effektives Kapitel,
// Status, Intensität), in Board-Lesereihenfolge.
function figurePlotUsage(bookId, userEmail, { draftFigureId = null, sourceFigureId = null } = {}) {
  const bid = parseInt(bookId);
  const dId = draftFigureId != null ? parseInt(draftFigureId) : null;
  const sId = sourceFigureId != null ? parseInt(sourceFigureId) : null;

  // (c) Gebundene Stränge: Katalog via figure_id, Werkstatt via draft_figure_id.
  const threads = db.prepare(`
    SELECT id, name FROM plot_threads
     WHERE book_id = ? AND user_email = ?
       AND ((? IS NOT NULL AND draft_figure_id = ?) OR (? IS NOT NULL AND figure_id = ?))
     ORDER BY position, id
  `).all(bid, userEmail, dId, dId, sId, sId);
  const threadIds = threads.map(t => t.id);

  const ids = new Set();
  if (dId != null) {
    for (const r of db.prepare(`
      SELECT pbdf.beat_id AS id FROM plot_beat_draft_figures pbdf
        JOIN plot_beats b ON b.id = pbdf.beat_id
       WHERE b.book_id = ? AND b.user_email = ? AND pbdf.draft_figure_id = ?
    `).all(bid, userEmail, dId)) ids.add(r.id);
  }
  if (sId != null) {
    for (const r of db.prepare(`
      SELECT pbf.beat_id AS id FROM plot_beat_figures pbf
        JOIN plot_beats b ON b.id = pbf.beat_id
       WHERE b.book_id = ? AND b.user_email = ? AND pbf.figure_id = ?
    `).all(bid, userEmail, sId)) ids.add(r.id);
  }
  if (threadIds.length) {
    const ph = threadIds.map(() => '?').join(',');
    for (const r of db.prepare(`
      SELECT id FROM plot_beats
       WHERE book_id = ? AND user_email = ? AND thread_id IN (${ph})
    `).all(bid, userEmail, ...threadIds)) ids.add(r.id);
  }
  if (!ids.size) return { beats: [], threads };

  const idList = [...ids];
  const ph = idList.map(() => '?').join(',');
  const beats = db.prepare(`
    SELECT b.titel, b.beschreibung, b.status, b.verworfen, b.intensitaet,
           b.sort_order, a.name AS act_name, a.position AS act_position,
           t.name AS thread_name,
           c.chapter_name AS beat_chapter_name, tc.chapter_name AS thread_chapter_name
      FROM plot_beats b
      JOIN plot_acts a ON a.id = b.act_id
      LEFT JOIN plot_threads t ON t.id = b.thread_id
      LEFT JOIN chapters c ON c.chapter_id = b.chapter_id
      LEFT JOIN chapters tc ON tc.chapter_id = t.chapter_id
     WHERE b.id IN (${ph})
     ORDER BY a.position, b.sort_order, b.id
  `).all(...idList).map(b => ({
    titel: b.titel,
    beschreibung: b.beschreibung || null,
    status: b.status,
    verworfen: !!b.verworfen,
    intensitaet: b.intensitaet || null,
    akt: b.act_name || null,
    strang: b.thread_name || null,
    // Effektives Kapitel: eigenes hat Vorrang, sonst vom Strang geerbt (Live-Vererbung).
    kapitel: b.beat_chapter_name || b.thread_chapter_name || null,
  }));
  return { beats, threads };
}

// Beats neu einsortieren (Drag zwischen/innerhalb Zellen). order = [{ actId,
// threadId, beatIds: [...] }] — pro Zelle (Akt × Strang) die Beat-IDs in
// Zielreihenfolge. Setzt act_id + thread_id + sort_order in einem Rutsch.
// threadId fehlt/null → „ohne Strang"-Lane (Abwärtskompat zum flachen Board).
const reorderBeats = db.transaction((bookId, userEmail, order) => {
  for (const grp of order) {
    const actId = parseInt(grp.actId);
    const threadId = grp.threadId != null ? parseInt(grp.threadId) : null;
    (grp.beatIds || []).forEach((beatId, idx) => {
      _stmtSetBeatSlot.run(actId, threadId, idx, parseInt(beatId), parseInt(bookId), userEmail);
    });
  }
});

// ── Hybrid-Akte: eigene Aktstruktur pro Strang ──────────────────────────────
// Ein Strang nutzt standardmässig die geteilten Akte (thread_id IS NULL). Er kann
// optional eine EIGENE Aktstruktur bekommen (Klon der geteilten Akte, thread_id = T)
// und später wieder auf die geteilten zurückfallen. „Eigene Akte" wird allein aus
// der Existenz strang-eigener Akte abgeleitet (kein Flag).
const _stmtSharedActsFull = db.prepare(`
  SELECT id, name, farbe, archiviert, position FROM plot_acts
   WHERE book_id = ? AND user_email = ? AND thread_id IS NULL ORDER BY position, id
`);
const _stmtThreadActs = db.prepare(`
  SELECT id, position FROM plot_acts
   WHERE book_id = ? AND user_email = ? AND thread_id = ? ORDER BY position, id
`);
// Beats eines Strangs, die auf einem bestimmten Akt sitzen, auf einen anderen Akt
// umhängen. thread_id IS ? ist NULL-safe (für Fork/Unfork ist T nie NULL).
const _stmtRemapBeatAct = db.prepare(`
  UPDATE plot_beats SET act_id = ?, updated_at = ${NOW_ISO_SQL}
   WHERE book_id = ? AND user_email = ? AND thread_id IS ? AND act_id = ?
`);
const _stmtPromoteThreadActs = db.prepare(`
  UPDATE plot_acts SET thread_id = NULL, updated_at = ${NOW_ISO_SQL}
   WHERE book_id = ? AND user_email = ? AND thread_id = ?
`);
const _stmtDeleteThreadActs = db.prepare(`
  DELETE FROM plot_acts WHERE book_id = ? AND user_email = ? AND thread_id = ?
`);
const _stmtBeatsInCell = db.prepare(`
  SELECT id FROM plot_beats
   WHERE book_id = ? AND user_email = ? AND act_id = ? AND thread_id IS ? ORDER BY sort_order, id
`);
const _stmtSetBeatSortOnly = db.prepare(`
  UPDATE plot_beats SET sort_order = ?, updated_at = ${NOW_ISO_SQL} WHERE id = ?
`);

function threadHasOwnActs(bookId, userEmail, threadId) {
  return _stmtThreadActs.all(parseInt(bookId), userEmail, parseInt(threadId)).length > 0;
}

// Beats eines Strangs von seinen EIGENEN Akten zurück auf die GETEILTEN Akte
// umhängen (positionsweise; Überzahl → letzte geteilte Spalte, dann neu nummeriert)
// und die eigenen Akte löschen. Gibt es keine geteilten Akte, werden die eigenen
// stattdessen zu geteilten befördert (Beats bleiben dran). Plain Function (kein
// eigenes Transaction-Wrapping) — läuft innerhalb der aufrufenden Transaktion.
function _landThreadBeatsOnSharedActs(bookId, userEmail, threadId) {
  const bid = parseInt(bookId);
  const tid = parseInt(threadId);
  const ownActs = _stmtThreadActs.all(bid, userEmail, tid);
  if (!ownActs.length) return; // Strang nutzt bereits geteilte Akte — nichts zu tun.
  const shared = _stmtSharedActsFull.all(bid, userEmail);
  if (!shared.length) {
    // Keine geteilten Akte: eigene Akte zu geteilten befördern (Beats bleiben).
    _stmtPromoteThreadActs.run(bid, userEmail, tid);
    return;
  }
  const targets = new Set();
  ownActs.forEach((own, idx) => {
    const target = shared[Math.min(idx, shared.length - 1)];
    _stmtRemapBeatAct.run(target.id, bid, userEmail, tid, own.id);
    targets.add(target.id);
  });
  // Ziel-Zellen (geteilter Akt × Strang) neu durchnummerieren — mehrere eigene
  // Akte können in dieselbe geteilte Spalte zusammenfallen (sort_order-Kollision).
  for (const targetActId of targets) {
    _stmtBeatsInCell.all(bid, userEmail, targetActId, tid)
      .forEach((b, i) => _stmtSetBeatSortOnly.run(i, b.id));
  }
  _stmtDeleteThreadActs.run(bid, userEmail, tid); // eigene Akte sind jetzt beat-frei.
}

// Strang T bekommt eine eigene Aktstruktur: die geteilten Akte 1:1 klonen
// (thread_id = T) und Ts Beats von den geteilten auf die geklonten Akte umhängen.
// Idempotent (hat T schon eigene Akte → no-op). Wirft NO_SHARED_ACTS, wenn es
// keine geteilten Akte zu klonen gibt (Route deckelt zusätzlich).
const forkThreadActs = db.transaction((bookId, userEmail, threadId) => {
  const bid = parseInt(bookId);
  const tid = parseInt(threadId);
  if (_stmtThreadActs.all(bid, userEmail, tid).length) return; // schon geforkt.
  const shared = _stmtSharedActsFull.all(bid, userEmail);
  if (!shared.length) { const e = new Error('NO_SHARED_ACTS'); e.code = 'NO_SHARED_ACTS'; throw e; }
  for (const a of shared) {
    // Der Klon erbt archiviert — sonst tauchte ein abgeschlossener Akt beim
    // Fork im Strang wieder als offene Spalte auf.
    const info = _stmtInsertAct.run(bid, userEmail, a.name, a.farbe, tid, a.archiviert ? 1 : 0, a.position);
    _stmtRemapBeatAct.run(info.lastInsertRowid, bid, userEmail, tid, a.id);
  }
});

// Strang T zurück auf die geteilten Akte (eigene Aktstruktur auflösen).
const unforkThreadActs = db.transaction((bookId, userEmail, threadId) => {
  _landThreadBeatsOnSharedActs(bookId, userEmail, threadId);
});

// ── Konsistenz-Prüfungs-Historie ────────────────────────────────────────────
// Persistierte Plot-Consistency-Läufe pro (Buch, User). Insert beim Job-Complete
// in routes/jobs/plot.js; List/Get/Delete via /plot/consistency-runs Routes. Die
// Liste kommt ohne result_json (Spaltensparsamkeit bei vielen Einträgen) —
// konflikt_count ist denormalisiert fürs Listen-Rendering; Detail liefert vollen JSON.

const _stmtInsertConsistencyRun = db.prepare(`
  INSERT INTO plot_consistency_runs (book_id, user_email, created_at, konflikt_count, result_json, model)
  VALUES (?, ?, ${NOW_ISO_SQL}, ?, ?, ?)
`);
const _stmtListConsistencyRuns = db.prepare(`
  SELECT id, book_id, created_at, konflikt_count, model
    FROM plot_consistency_runs
   WHERE book_id = ? AND user_email = ?
   ORDER BY created_at DESC, id DESC
`);
const _stmtGetConsistencyRun = db.prepare(`
  SELECT id, book_id, user_email, created_at, konflikt_count, result_json, model
    FROM plot_consistency_runs
   WHERE id = ?
`);
const _stmtDeleteConsistencyRun = db.prepare('DELETE FROM plot_consistency_runs WHERE id = ? AND user_email = ?');

function insertPlotConsistencyRun({ bookId, userEmail, konfliktCount = 0, result, model = null }) {
  const info = _stmtInsertConsistencyRun.run(
    parseInt(bookId), userEmail, parseInt(konfliktCount) || 0, JSON.stringify(result), model
  );
  return info.lastInsertRowid;
}

function listPlotConsistencyRuns(bookId, userEmail) {
  return _stmtListConsistencyRuns.all(parseInt(bookId), userEmail);
}

function getPlotConsistencyRun(id) {
  const r = _stmtGetConsistencyRun.get(parseInt(id));
  if (!r) return null;
  let result = null;
  try { result = JSON.parse(r.result_json); } catch { result = null; }
  return {
    id: r.id, book_id: r.book_id, user_email: r.user_email,
    created_at: r.created_at, konflikt_count: r.konflikt_count,
    result, model: r.model,
  };
}

function deletePlotConsistencyRun(id, userEmail) {
  return _stmtDeleteConsistencyRun.run(parseInt(id), userEmail).changes;
}

// ── Brainstorm-Lauf-Historie ─────────────────────────────────────────────────
// Persistierte Plot-Brainstorm-Läufe pro (Buch, User), zusätzlich pro Akt/Strang.
// Insert beim Job-Complete in routes/jobs/plot.js; List/Get/Delete via
// /plot/brainstorm-runs Routes. act_name/thread_name kommen via JOIN zur Lesezeit
// (kein Snapshot) — ein gelöschter Akt/Strang macht act_id/thread_id NULL, der
// Name fällt dann auf null (Frontend zeigt einen generischen Fallback). Die Liste
// kommt ohne result_json (Spaltensparsamkeit); Detail liefert die Vorschläge.

const _stmtInsertBrainstormRun = db.prepare(`
  INSERT INTO plot_brainstorm_runs (book_id, user_email, act_id, thread_id, created_at, vorschlag_count, result_json, model)
  VALUES (?, ?, ?, ?, ${NOW_ISO_SQL}, ?, ?, ?)
`);
const _stmtListBrainstormRuns = db.prepare(`
  SELECT r.id, r.book_id, r.act_id, r.thread_id, r.created_at, r.vorschlag_count, r.model,
         a.name AS act_name, t.name AS thread_name
    FROM plot_brainstorm_runs r
    LEFT JOIN plot_acts    a ON a.id = r.act_id
    LEFT JOIN plot_threads t ON t.id = r.thread_id
   WHERE r.book_id = ? AND r.user_email = ?
   ORDER BY r.created_at DESC, r.id DESC
`);
const _stmtGetBrainstormRun = db.prepare(`
  SELECT r.id, r.book_id, r.user_email, r.act_id, r.thread_id, r.created_at, r.vorschlag_count, r.result_json, r.model,
         a.name AS act_name, t.name AS thread_name
    FROM plot_brainstorm_runs r
    LEFT JOIN plot_acts    a ON a.id = r.act_id
    LEFT JOIN plot_threads t ON t.id = r.thread_id
   WHERE r.id = ?
`);
const _stmtDeleteBrainstormRun = db.prepare('DELETE FROM plot_brainstorm_runs WHERE id = ? AND user_email = ?');

function insertPlotBrainstormRun({ bookId, userEmail, actId = null, threadId = null, vorschlagCount = 0, result, model = null }) {
  const info = _stmtInsertBrainstormRun.run(
    parseInt(bookId), userEmail,
    actId != null ? parseInt(actId) : null,
    threadId != null ? parseInt(threadId) : null,
    parseInt(vorschlagCount) || 0, JSON.stringify(result), model
  );
  return info.lastInsertRowid;
}

function listPlotBrainstormRuns(bookId, userEmail) {
  return _stmtListBrainstormRuns.all(parseInt(bookId), userEmail);
}

function getPlotBrainstormRun(id) {
  const r = _stmtGetBrainstormRun.get(parseInt(id));
  if (!r) return null;
  let result = null;
  try { result = JSON.parse(r.result_json); } catch { result = null; }
  return {
    id: r.id, book_id: r.book_id, user_email: r.user_email,
    act_id: r.act_id, thread_id: r.thread_id, act_name: r.act_name, thread_name: r.thread_name,
    created_at: r.created_at, vorschlag_count: r.vorschlag_count,
    result, model: r.model,
  };
}

function deletePlotBrainstormRun(id, userEmail) {
  return _stmtDeleteBrainstormRun.run(parseInt(id), userEmail).changes;
}

// ── Ist-Index (plot_beat_occurrences) ───────────────────────────────────────
// Abgeleitete Beat-Verankerung: wo ein geplanter Beat semantisch/wörtlich im
// Buchtext auftaucht (Job beat-anchor). Full-Replace pro Beat je Lauf — kein
// Handpflegen, kein content_hash. Pendant zu motifs#replaceOccurrences.

// Lean-Liste für den Anchor-Job: nur die Felder, die als Query dienen + der
// Status für die spätere Drift-Klassifikation. Kein Figuren-/Motiv-Scan.
const _stmtListBeatsForAnchor = db.prepare(`
  SELECT id, titel, beschreibung, status, verworfen
    FROM plot_beats
   WHERE book_id = ? AND user_email = ?
`);
function listBeatsForAnchor(bookId, userEmail) {
  return _stmtListBeatsForAnchor.all(parseInt(bookId), userEmail);
}

const _stmtDeleteOccForBeat = db.prepare('DELETE FROM plot_beat_occurrences WHERE beat_id = ?');
const _stmtInsertBeatOcc = db.prepare(`
  INSERT INTO plot_beat_occurrences (beat_id, book_id, kind, page_id, scene_id, score, snippet, source, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL})
`);

// Full-Replace der Fundstellen eines Beats (ein Anchor-Ergebnis). rows:
// [{ kind:'page'|'scene', pageId?, sceneId?, score, snippet, source }].
const replaceBeatOccurrences = db.transaction((beatId, bookId, rows) => {
  _stmtDeleteOccForBeat.run(parseInt(beatId));
  for (const r of rows || []) {
    const isPage = r.kind === 'page';
    _stmtInsertBeatOcc.run(
      parseInt(beatId), parseInt(bookId), r.kind,
      isPage ? parseInt(r.pageId) : null,
      isPage ? null : parseInt(r.sceneId),
      r.score != null ? Number(r.score) : null,
      r.snippet != null ? String(r.snippet).slice(0, 500) : null,
      r.source,
    );
  }
});

// Alle Fundstellen der Beats eines Buchs am Stück (Seiten-/Szenen-Kontext via
// JOIN, kein Snapshot) → Map beat_id → { count, top[] }. Der Board-Payload hängt
// count + die Top-Treffer (nach Score) an jeden Beat fürs Drift-Badge. Szenen
// erben ihre Seite (figure_scenes.page_id) fürs Anspringen.
const _stmtBeatOccForBook = db.prepare(`
  SELECT o.beat_id, o.kind, o.score, o.snippet, o.source,
         COALESCE(o.page_id, s.page_id) AS page_id,
         COALESCE(p.page_name, sp.page_name) AS page_name,
         s.titel AS scene_titel
    FROM plot_beat_occurrences o
    JOIN plot_beats b ON b.id = o.beat_id
    LEFT JOIN pages p         ON p.page_id = o.page_id
    LEFT JOIN figure_scenes s ON s.id = o.scene_id
    LEFT JOIN pages sp        ON sp.page_id = s.page_id
   WHERE b.book_id = ? AND b.user_email = ?
   ORDER BY o.score DESC, o.id
`);
const BEAT_OCC_TOP_N = 8;
// opts.minScore: Score-Floor (0 = aus) — blendet schwache semantische Treffer aus
// count UND top aus, damit Drift-Badge-Zahl und Popover-Liste konsistent bleiben.
// FTS-/Trigger-Treffer haben score=null (wörtlicher Match) → nie vom Floor betroffen.
// opts.navigableOnly: nicht anspringbare Fundstellen (Szene ohne verknüpfte Seite,
// page_id null) überspringen — ein Ziel ohne Seite kann man nicht öffnen.
function beatOccurrenceMap(bookId, userEmail, opts = {}) {
  const minScore = Number(opts.minScore) || 0;
  const navigableOnly = !!opts.navigableOnly;
  const map = new Map();
  for (const r of _stmtBeatOccForBook.all(parseInt(bookId), userEmail)) {
    if (navigableOnly && !r.page_id) continue;
    if (minScore > 0 && r.score != null && r.score < minScore) continue;
    let e = map.get(r.beat_id);
    if (!e) { e = { count: 0, top: [] }; map.set(r.beat_id, e); }
    e.count += 1;
    if (e.top.length < BEAT_OCC_TOP_N) {
      e.top.push({
        kind: r.kind, page_id: r.page_id, page_name: r.page_name,
        scene_titel: r.scene_titel, snippet: r.snippet, score: r.score, source: r.source,
      });
    }
  }
  return map;
}

// Stale-Heuristik fürs „Verankerung aktualisieren"-Angebot: gibt es zu verankernde
// Beats, die nach dem jüngsten Occurrence-Lauf geändert wurden (oder nie verankert)?
// `statuses` = die Status, die verankert werden (siehe beat-anchor.js): immer
// `im_buch`; zusätzlich `geplant`, wenn die Promotion-Erkennung aktiv ist
// (plot.anchor.promote_min_score > 0 — der Aufrufer entscheidet, damit die reine
// DB-Schicht die App-Setting nicht lesen muss). Verworfene Beats zählen nie. Billige
// updated_at-Heuristik analog zur Motiv-Werkstatt (semanticChunks.indexStatus).
const _STALE_ALLOWED_STATUS = new Set(['im_buch', 'geplant']);
function beatAnchorStale(bookId, userEmail, statuses = ['im_buch']) {
  const bid = parseInt(bookId);
  const allowed = statuses.filter(s => _STALE_ALLOWED_STATUS.has(s));
  if (!allowed.length) return false;
  const ph = allowed.map(() => '?').join(',');
  const r = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM plot_beats WHERE book_id = ? AND user_email = ? AND verworfen = 0 AND status IN (${ph})) AS beats,
      (SELECT MAX(updated_at) FROM plot_beats WHERE book_id = ? AND user_email = ? AND verworfen = 0 AND status IN (${ph})) AS beat_max,
      (SELECT MAX(o.created_at) FROM plot_beat_occurrences o
         JOIN plot_beats b ON b.id = o.beat_id
        WHERE b.book_id = ? AND b.user_email = ?) AS occ_max
  `).get(bid, userEmail, ...allowed, bid, userEmail, ...allowed, bid, userEmail);
  if (!r || !r.beats) return false;          // nichts zu verankern → nicht stale
  if (!r.occ_max) return true;               // noch nie gelaufen
  return !!(r.beat_max && r.beat_max > r.occ_max); // Beat seit letztem Lauf geändert
}

// ── Beat-zu-Beat-Beziehungen (Kausalitaet + Setup/Payoff) ────────────────────
// Gerichtete Kante from_beat --typ--> to_beat. `typ` ist Freitext (kuratierte
// Vorschlaege im Frontend, analog figure_relations). Pro Buch + User skopiert.
// Read-Aggregat liefert die Beat-Titel via JOIN (kein Snapshot).
const _REL_SELECT = `
  SELECT r.id, r.book_id, r.user_email, r.from_beat_id, r.to_beat_id, r.typ,
         fb.titel AS from_titel, tb.titel AS to_titel,
         r.created_at, r.updated_at
    FROM plot_beat_relations r
    JOIN plot_beats fb ON fb.id = r.from_beat_id
    JOIN plot_beats tb ON tb.id = r.to_beat_id
`;
const _stmtListBeatRelations = db.prepare(`${_REL_SELECT} WHERE r.book_id = ? AND r.user_email = ? ORDER BY r.from_beat_id, r.id`);
const _stmtGetBeatRelation = db.prepare(`${_REL_SELECT} WHERE r.id = ?`);
const _stmtInsertBeatRelation = db.prepare(`
  INSERT OR IGNORE INTO plot_beat_relations (book_id, user_email, from_beat_id, to_beat_id, typ, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ${NOW_ISO_SQL}, ${NOW_ISO_SQL})
`);
const _stmtFindBeatRelation = db.prepare('SELECT id FROM plot_beat_relations WHERE from_beat_id = ? AND to_beat_id = ? AND typ = ?');
const _stmtDeleteBeatRelation = db.prepare('DELETE FROM plot_beat_relations WHERE id = ? AND user_email = ?');

function listBeatRelations(bookId, userEmail) {
  return _stmtListBeatRelations.all(parseInt(bookId), userEmail);
}

function getBeatRelation(id) {
  return _stmtGetBeatRelation.get(parseInt(id)) || null;
}

// Prueft, ob ein Beat wirklich zu (Buch, User) gehoert (Fremd-Verweis-Schutz).
function _beatBelongs(bookId, userEmail, beatId) {
  const b = _stmtGetBeat.get(parseInt(beatId));
  return !!(b && b.book_id === parseInt(bookId) && b.user_email === userEmail);
}

// Kante anlegen. Beide Beats muessen zu (Buch, User) gehoeren; keine Selbst-Kante.
// Bei bestehender identischer Kante (UNIQUE) wird die vorhandene zurueckgegeben
// (idempotent). Wirft mit .code fuer die Route.
function createBeatRelation(bookId, userEmail, { fromBeatId, toBeatId, typ }) {
  const fid = parseInt(fromBeatId);
  const tid = parseInt(toBeatId);
  if (!Number.isInteger(fid) || !Number.isInteger(tid)) { const e = new Error('BEAT_REQUIRED'); e.code = 'BEAT_REQUIRED'; throw e; }
  if (fid === tid) { const e = new Error('SELF_RELATION'); e.code = 'SELF_RELATION'; throw e; }
  if (!_beatBelongs(bookId, userEmail, fid) || !_beatBelongs(bookId, userEmail, tid)) {
    const e = new Error('BEAT_MISMATCH'); e.code = 'BEAT_MISMATCH'; throw e;
  }
  const cleanTyp = String(typ || '').trim().slice(0, 40);
  if (!cleanTyp) { const e = new Error('TYP_REQUIRED'); e.code = 'TYP_REQUIRED'; throw e; }
  const info = _stmtInsertBeatRelation.run(parseInt(bookId), userEmail, fid, tid, cleanTyp);
  const id = info.changes ? info.lastInsertRowid : _stmtFindBeatRelation.get(fid, tid, cleanTyp)?.id;
  return id ? getBeatRelation(id) : null;
}

function deleteBeatRelation(id, userEmail) {
  return _stmtDeleteBeatRelation.run(parseInt(id), userEmail).changes;
}

module.exports = {
  listActs, getAct, createAct, updateAct, deleteAct, reorderActs,
  threadHasOwnActs, forkThreadActs, unforkThreadActs,
  listThreads, getThread, createThread, updateThread, deleteThread, reorderThreads, _validThreadId,
  listBeats, getBeat, getBeatMeta, createBeat, updateBeat, deleteBeat, reorderBeats, pageBeatCounts, chapterBeatCounts,
  listBeatRelations, getBeatRelation, createBeatRelation, deleteBeatRelation,
  figurePlotUsage,
  resolveFigureIds, resolveDraftFigureIds, resolveMotifIds,
  insertPlotConsistencyRun, listPlotConsistencyRuns, getPlotConsistencyRun, deletePlotConsistencyRun,
  insertPlotBrainstormRun, listPlotBrainstormRuns, getPlotBrainstormRun, deletePlotBrainstormRun,
  listBeatsForAnchor, replaceBeatOccurrences, beatOccurrenceMap, beatAnchorStale,
};
