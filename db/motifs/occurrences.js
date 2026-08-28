'use strict';
// Motiv-Werkstatt — Ist-Index (`motif_occurrences`): wo die Motiverkennung ein
// Motiv real im Text gefunden hat. Full-Replace pro Motiv je Scan; abgeleitet,
// nie von Hand gepflegt. Dazu die passiven Soll-Motive einer Seite (Lektorat).

const { db } = require('../connection');
// Migrationen vor den prepare()-Aufrufen erzwingen (wie db/schema.js & Co.): das
// Modul bereitet seine Statements beim Laden vor — ohne die Kette fehlt auf einer
// noch nicht migrierten DB die Tabelle und der Require wirft.
require('../migrations');
const { NOW_ISO_SQL } = require('../now');
const { parseTerms } = require('./terms');

// ── Ist-Index (motif_occurrences) ──────────────────────────────────────────

const _stmtDeleteOccForMotif = db.prepare('DELETE FROM motif_occurrences WHERE motif_id = ?');
const _stmtInsertOcc = db.prepare(`
  INSERT INTO motif_occurrences (motif_id, book_id, kind, page_id, scene_id, score, snippet, source, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL})
`);

// Full-Replace der Fundstellen eines Motivs (ein Scan-Ergebnis). rows:
// [{ kind:'page'|'scene', pageId?, sceneId?, score, snippet, source }].
const replaceOccurrences = db.transaction((motifId, bookId, rows) => {
  _stmtDeleteOccForMotif.run(parseInt(motifId));
  for (const r of rows || []) {
    const isPage = r.kind === 'page';
    _stmtInsertOcc.run(
      parseInt(motifId), parseInt(bookId), r.kind,
      isPage ? parseInt(r.pageId) : null,
      isPage ? null : parseInt(r.sceneId),
      r.score != null ? Number(r.score) : null,
      r.snippet != null ? String(r.snippet).slice(0, 500) : null,
      r.source,
    );
  }
});

// Fundstellen-Zahl pro Motiv fürs Graph-Rendering (Ist-Dichte). Optionaler Score-
// Floor blendet schwache semantische Treffer aus (Ist-Dichte + Geist-Erkennung
// respektieren die Schwelle live); wörtliche Trigger-Treffer (score=null) zählen immer.
// avg_score = mittlere Übereinstimmung der Fundstellen (Cosinus 0..1); wörtliche
// Trigger-Treffer (score=null) sind exakte Matches → als 1.0 (100%) gewertet.
// Beides fliesst in die Graph-Knotengrösse (Dichte × Übereinstimmung).
const _stmtOccCounts = db.prepare(`
  SELECT o.motif_id, COUNT(*) AS n, AVG(COALESCE(o.score, 1.0)) AS avg_score
    FROM motif_occurrences o
    JOIN motifs m ON m.id = o.motif_id
   WHERE m.book_id = ? AND m.user_email = ?
   GROUP BY o.motif_id
`);
const _stmtOccCountsFloor = db.prepare(`
  SELECT o.motif_id, COUNT(*) AS n, AVG(COALESCE(o.score, 1.0)) AS avg_score
    FROM motif_occurrences o
    JOIN motifs m ON m.id = o.motif_id
   WHERE m.book_id = ? AND m.user_email = ?
     AND (o.score IS NULL OR o.score >= ?)
   GROUP BY o.motif_id
`);
// Ist-Fundstellen pro (Motiv, Kapitel) fürs Präsenz-Raster der Buch-Übersicht
// (Kapitel × Motiv, analog zum kapitel-Breakdown von /locations). page-Treffer
// mappen über pages.chapter_id, scene-Treffer über figure_scenes.page_id →
// pages.chapter_id. Fundstellen ohne auflösbares Kapitel (chapter_id NULL) fallen
// im getGraph raus. Score-Floor wie bei den Gesamt-Counts (wörtliche Trigger immer).
const _stmtOccChapters = db.prepare(`
  SELECT o.motif_id, COALESCE(pp.chapter_id, sp.chapter_id) AS chapter_id, COUNT(*) AS n
    FROM motif_occurrences o
    JOIN motifs m ON m.id = o.motif_id
    LEFT JOIN pages pp ON pp.page_id = o.page_id
    LEFT JOIN figure_scenes s ON s.id = o.scene_id
    LEFT JOIN pages sp ON sp.page_id = s.page_id
   WHERE m.book_id = ? AND m.user_email = ?
   GROUP BY o.motif_id, COALESCE(pp.chapter_id, sp.chapter_id)
`);
const _stmtOccChaptersFloor = db.prepare(`
  SELECT o.motif_id, COALESCE(pp.chapter_id, sp.chapter_id) AS chapter_id, COUNT(*) AS n
    FROM motif_occurrences o
    JOIN motifs m ON m.id = o.motif_id
    LEFT JOIN pages pp ON pp.page_id = o.page_id
    LEFT JOIN figure_scenes s ON s.id = o.scene_id
    LEFT JOIN pages sp ON sp.page_id = s.page_id
   WHERE m.book_id = ? AND m.user_email = ?
     AND (o.score IS NULL OR o.score >= ?)
   GROUP BY o.motif_id, COALESCE(pp.chapter_id, sp.chapter_id)
`);
// Fundstellen-Detail eines Motivs (Seiten- + Szenen-Kontext via JOIN, kein Snapshot).
const _stmtOccDetail = db.prepare(`
  SELECT o.id, o.kind, o.page_id, o.scene_id, o.score, o.snippet, o.source,
         p.page_name, p.chapter_id, c.chapter_name,
         s.titel AS scene_titel, s.page_id AS scene_page_id
    FROM motif_occurrences o
    LEFT JOIN pages p    ON p.page_id = o.page_id
    LEFT JOIN chapters c ON c.chapter_id = p.chapter_id
    LEFT JOIN figure_scenes s ON s.id = o.scene_id
   WHERE o.motif_id = ?
   ORDER BY o.score DESC, o.id
`);

// minScore: Cosinus-Floor (0 = aus) — blendet schwache semantische Treffer aus.
// Wörtliche Trigger-Treffer (score=null) sind nie vom Floor betroffen (Exakt-Match).
function listOccurrences(motifId, minScore = 0) {
  const rows = _stmtOccDetail.all(parseInt(motifId));
  const floor = Number(minScore) || 0;
  if (floor <= 0) return rows;
  return rows.filter(r => r.score == null || r.score >= floor);
}

// Gibt es im Buch ueberhaupt eine Fundstelle? Trennt „nie gescannt" von „gescannt,
// nichts gefunden" NICHT — das kann der Index nicht wissen (kein Scan-Lauf-Journal).
// Genau darum ist die konservative Lesart Pflicht: ein leerer Index heisst
// ungeprueft, nicht abwesend (siehe lib/motif-consistency.js). Ohne Score-Floor:
// die Frage ist, ob der Scan lief, nicht wie stark seine Treffer sind.
const _stmtHasOcc = db.prepare(`
  SELECT 1
    FROM motif_occurrences o
    JOIN motifs m ON m.id = o.motif_id
   WHERE m.book_id = ? AND m.user_email = ?
   LIMIT 1
`);
function hasOccurrences(bookId, userEmail) {
  return !!_stmtHasOcc.get(parseInt(bookId), userEmail);
}

// ── Soll-Motive einer Seite (passiver Lektorat-Kontext) ─────────────────────
// Motive, deren Soll-Brücke auf DIESE Seite (motif_pages) oder auf DEREN Kapitel
// (motif_chapters) zeigt. Reiner Hintergrundkontext für den Stil-Pass des
// Lektorats: motivtragende Formulierungen (wiederkehrende Bilder, Trigger-Terme)
// sollen NICHT als Wiederholung/Klischee/Stilfehler wegkorrigiert werden. Kein
// Ist-Index, kein Drift-Urteil — nur das geplante Soll. Pro Buch + User skopiert.
const _stmtPageMotifs = db.prepare(`
  SELECT DISTINCT m.id, m.name, m.beschreibung, m.trigger_terms, m.position, t.name AS theme_name
    FROM motifs m
    LEFT JOIN themes t ON t.id = m.theme_id
   WHERE m.book_id = ? AND m.user_email = ?
     AND (
       m.id IN (SELECT motif_id FROM motif_pages    WHERE page_id = ?)
       OR m.id IN (SELECT motif_id FROM motif_chapters WHERE chapter_id = ?)
     )
   ORDER BY m.position, m.id
`);
function getPageMotifs(bookId, chapterId, pageId, userEmail) {
  if (!bookId || !pageId || !userEmail) return [];
  const rows = _stmtPageMotifs.all(
    parseInt(bookId), userEmail, parseInt(pageId),
    chapterId ? parseInt(chapterId) : null,
  );
  return rows.map(r => ({
    name: r.name,
    beschreibung: r.beschreibung,
    theme_name: r.theme_name,
    trigger_terms: parseTerms(r.trigger_terms),
  }));
}

// Aggregate für den Graph-Payload: Fundstellen-Zahl (+ ⌀ Übereinstimmung) je
// Motiv und ihre Kapitel-Aufschlüsselung. Der Score-Floor wirkt am Lese-
// Chokepoint — dieselbe Schwelle für Knotengrösse, Geist-Erkennung und Verlaufsband.
function occCounts(bookId, userEmail, floor = 0) {
  const bid = parseInt(bookId);
  return floor > 0 ? _stmtOccCountsFloor.all(bid, userEmail, floor) : _stmtOccCounts.all(bid, userEmail);
}
function occChapters(bookId, userEmail, floor = 0) {
  const bid = parseInt(bookId);
  return floor > 0 ? _stmtOccChaptersFloor.all(bid, userEmail, floor) : _stmtOccChapters.all(bid, userEmail);
}

module.exports = {
  replaceOccurrences, listOccurrences, hasOccurrences, getPageMotifs,
  occCounts, occChapters,
};
