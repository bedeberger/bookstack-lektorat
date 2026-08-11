'use strict';
// Fehler-Heatmap + Fehlerdichte-Trend. Duenne HTTP-Schicht: die Zeilen liefert
// [db/lektorat-heatmap.js](../../db/lektorat-heatmap.js), die Verdichtung ist
// pure und liegt in [lib/fehler-heatmap.js](../../lib/fehler-heatmap.js).
//
// Beide Routen sind `:book_id`-Routen — Login + Buch-ACL (viewer+) erledigt der
// router.param-Guard der Facade, `req.bookId` ist gesetzt.

const { sessionEmail } = require('../../lib/acl');
const { loadHeatmapRows } = require('../../db/lektorat-heatmap');
const { buildFehlerHeatmap } = require('../../lib/fehler-heatmap');
const snapshots = require('../../db/book-snapshots');

function register(router) {
  // Fehler-Heatmap: aggregiert Fehler-Typen x Kapitel aus dem jeweils juengsten
  // page_check pro Seite. `mode` (open|applied|all) waehlt, was als Fehler zaehlt
  // — Bedeutung der Modi siehe lib/fehler-heatmap.js.
  router.get('/fehler-heatmap/:book_id', (req, res) => {
    const rows = loadHeatmapRows(req.bookId, sessionEmail(req));
    res.json(buildFehlerHeatmap({ ...rows, mode: req.query.mode }));
  });

  // Fehlerdichte-Trend über die Fassungen: pro book_snapshots-Zeile die verdichtete
  // Lektorat-Kennzahl (offen/angenommen/alle je Typ) + Wörter-Nenner, aufsteigend
  // nach seq. Die Fehler-Heatmap-Karte zeichnet daraus den Verlauf. Momentaufnahme-
  // Metrik pro Meilenstein — keine Live-Aggregation (die liefert /fehler-heatmap).
  router.get('/fehler-trend/:book_id', (req, res) => {
    const rows = snapshots.listLektoratTrend(req.bookId);
    const versions = rows.map((r) => {
      let metrics = null;
      if (r.lektorat_metrics) {
        try { metrics = JSON.parse(r.lektorat_metrics); } catch { metrics = null; }
      }
      return {
        seq: r.seq,
        label: r.label || null,
        words: r.words || 0,
        created_at: r.created_at,
        published: !!r.published_at,
        metrics, // { open, applied, all } je { total, byTyp } — oder null (keine Lektorat-Daten)
      };
    });
    res.json({ versions });
  });
}

module.exports = { register };
