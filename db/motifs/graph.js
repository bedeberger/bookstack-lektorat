'use strict';
// Motiv-Werkstatt — Graph-Payload + Knoten-Layout. Ein Aufruf liefert alles fürs
// Konstellations-Rendering; die Einzelteile kommen aus den Nachbarmodulen.

const { db } = require('../connection');
// Migrationen vor den prepare()-Aufrufen erzwingen (wie db/schema.js & Co.): das
// Modul bereitet seine Statements beim Laden vor — ohne die Kette fehlt auf einer
// noch nicht migrierten DB die Tabelle und der Require wirft.
require('../migrations');
const { NOW_ISO_SQL } = require('../now');

const { listThemes, listMotifs } = require('./catalog');
const { listRelations } = require('./relations');
const { bridgeRows } = require('./links');
const { occCounts, occChapters } = require('./occurrences');

// ── Graph-Layout (manuelle Knoten-Positionen, View-Präferenz pro Buch + User) ──
// Ein JSON-Blob node_id → {x,y}. node_id ist ein Render-Token ("m12"/"t3"/…), kein
// FK-fähiges Ziel; die gezogene Anordnung ist reine Ansicht (kein Snapshot von Daten).

const _stmtGetLayout = db.prepare('SELECT positions_json FROM motif_graph_layout WHERE book_id = ? AND user_email = ?');
const _stmtUpsertLayout = db.prepare(`
  INSERT INTO motif_graph_layout (book_id, user_email, positions_json, updated_at)
  VALUES (?, ?, ?, ${NOW_ISO_SQL})
  ON CONFLICT (book_id, user_email) DO UPDATE SET positions_json = excluded.positions_json, updated_at = ${NOW_ISO_SQL}
`);

function getLayout(bookId, userEmail) {
  const row = _stmtGetLayout.get(parseInt(bookId), userEmail);
  if (!row?.positions_json) return {};
  try { const v = JSON.parse(row.positions_json); return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}; }
  catch { return {}; }
}
function saveLayout(bookId, userEmail, positions) {
  _stmtUpsertLayout.run(parseInt(bookId), userEmail, JSON.stringify(positions || {}));
}

// ── Graph-Payload ───────────────────────────────────────────────────────────
// Ein Aufruf liefert alles fürs Konstellations-Rendering: Themen, Motive (jeweils
// mit Soll-Links + Ist-Count), Beziehungen, plus das persistierte Knoten-Layout.
// minScore: Cosinus-Floor (0 = aus) — schwache semantische Treffer fallen aus Ist-
// Dichte (Knotengrösse), Geist-Erkennung und Peek-Popover. Wörtliche Trigger-Treffer
// (score=null) bleiben immer. Gefiltert am Lese-Chokepoint → wirkt ohne Scan-Neulauf.
function getGraph(bookId, userEmail, minScore = 0) {
  const bid = parseInt(bookId);
  const floor = Number(minScore) || 0;
  const themes = listThemes(bid, userEmail);
  const motifs = listMotifs(bid, userEmail);
  const relations = listRelations(bid, userEmail);

  const byMotif = new Map(motifs.map(m => [m.id, {
    ...m, figures: [], draftFigures: [], beats: [], chapters: [], pages: [], occurrenceCount: 0, occAvgScore: 0, occChapters: [],
  }]));
  const bridges = bridgeRows(bid, userEmail);
  for (const r of bridges.figures) byMotif.get(r.motif_id)?.figures.push({ figId: r.fig_id, name: r.name });
  for (const r of bridges.draftFigures) byMotif.get(r.motif_id)?.draftFigures.push({ id: r.draft_figure_id, name: r.name });
  for (const r of bridges.beats) byMotif.get(r.motif_id)?.beats.push({ id: r.beat_id, titel: r.titel });
  for (const r of bridges.chapters) byMotif.get(r.motif_id)?.chapters.push({ id: r.chapter_id, name: r.chapter_name });
  for (const r of bridges.pages) byMotif.get(r.motif_id)?.pages.push({ id: r.page_id, name: r.page_name });
  for (const r of occCounts(bid, userEmail, floor)) { const m = byMotif.get(r.motif_id); if (m) { m.occurrenceCount = r.n; m.occAvgScore = r.avg_score || 0; } }
  // Kapitel-Aufschlüsselung der Ist-Fundstellen (Präsenz-Raster der Buch-Übersicht).
  // Treffer ohne auflösbares Kapitel (chapter_id NULL) übergehen.
  const occCh = occChapters(bid, userEmail, floor);
  for (const r of occCh) {
    if (r.chapter_id == null) continue;
    byMotif.get(r.motif_id)?.occChapters.push({ chapterId: r.chapter_id, n: r.n });
  }

  return { themes, motifs: [...byMotif.values()], relations, layout: getLayout(bid, userEmail) };
}

module.exports = { getLayout, saveLayout, getGraph };
