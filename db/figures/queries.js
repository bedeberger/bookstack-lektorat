const { db } = require('../connection');
const { figIdMaps, _cleanRefName } = require('./refs');
require('../migrations');

/** Figuren eines Kapitels laden — gleiche Quelle wie die Figurenliste
 *  ([routes/figures.js] `/:book_id`): `figure_appearances` (KI-Auftritte im Kapitel).
 *  Die KI unterscheidet die Figur von gleichnamigen, nur erwähnten realen Personen;
 *  reine Namensnennungen (page_figure_mentions) zählen bewusst nicht mit.
 *  Sortierung: Häufigkeit DESC. Fallback: alle Buchfiguren, wenn keine Kapitel-
 *  zuordnung existiert (z.B. vor der ersten Komplettanalyse).
 *  Gibt kompakte Objekte zurück: { name, kurzname, geschlecht, beruf, wohnadresse, beschreibung, typ } */
function getChapterFigures(bookId, chapterId, userEmail) {
  if (!bookId) return [];
  const cols = 'f.id, f.name, f.kurzname, f.geschlecht, f.beruf, f.wohnadresse, f.beschreibung, f.typ, f.geburtstag';
  if (chapterId) {
    const rows = db.prepare(`
      SELECT ${cols} FROM figures f
      JOIN (
        SELECT figure_id AS fid, SUM(haeufigkeit) AS h
        FROM figure_appearances
        WHERE chapter_id = ?
        GROUP BY figure_id
      ) a ON a.fid = f.id
      WHERE f.book_id = ? AND f.user_email IS ?
      ORDER BY a.h DESC, f.sort_order, f.id
    `).all(chapterId, bookId, userEmail || null);
    if (rows.length > 0) return rows;
  }
  return db.prepare(`
    SELECT ${cols} FROM figures f
    WHERE f.book_id = ? AND f.user_email IS ?
    ORDER BY f.sort_order, f.id
  `).all(bookId, userEmail || null);
}

/** Baut `figure_appearances` für die Figuren EINES Laufs neu auf — Full-Replace an einem
 *  Chokepoint, wie bei den übrigen abgeleiteten Indexen des Projekts. Drei Quellen:
 *    1. das selbstgemeldete `kapitel`-Feld der Figur (Phase 2, mit KI-Häufigkeit),
 *    2. Szenen (scene_figures → figure_scenes.chapter_id, nur `stale = 0`),
 *    3. Lebensereignisse (figure_events.chapter_id).
 *  2+3 schliessen die Recall-Lücke: die KI meldet pro Figur nicht jedes Kapitel, und aus
 *  Szenen nachgetragene Figuren haben überhaupt kein `kapitel`-Feld.
 *  **Why hier und nicht in `saveFigurenToDb`:** dort (Phase 2) liegen 2+3 noch nicht vor.
 *  Ein Lauf, der zwischen Figuren- und Szenen-Speichern abbricht (User-Abbruch,
 *  Provider-Fehler, Timeout), hinterliesse einen geleerten Index — die Figur verliert
 *  ihre Kapitel-Plaketten dauerhaft, bis wieder ein Lauf vollständig durchkommt.
 *  **Rangfolge der Häufigkeit:** die KI-Angabe gewinnt (Quelle 1 läuft zuerst, die beiden
 *  SELECTs sind `INSERT OR IGNORE`), sonst der abgeleitete Zähler. Bewusst festgelegt,
 *  nicht Nebenwirkung der Insert-Reihenfolge.
 *  **Löschumfang:** nur die Figuren dieses Laufs — nicht wiedergefundene (`stale = 1`)
 *  behalten ihre Kapitel, sonst sähen sie kapitellos aus statt ausgemustert.
 *  Reiner SQL-Schritt aus persistierten Daten, kein KI-Call. `figuren` ist die
 *  konsolidierte Lauf-Liste (TEXT-`id` = fig_id); ohne `idMaps.chNameToId` bleibt
 *  Quelle 1 leer. Rückgabe: `{ figuren, paare }`. */
function rebuildFigureAppearances(bookId, userEmail, figuren, idMaps) {
  if (!bookId || !Array.isArray(figuren) || !figuren.length) return { figuren: 0, paare: 0 };
  const em = userEmail || null;
  const { byFigId } = figIdMaps(bookId, em);
  // Row-IDs kommen aus der DB; Number-Coercion + Integer-Filter halten die
  // IN-Liste unten garantiert numerisch (sie wird interpoliert, nicht gebunden —
  // eine variabel lange Platzhalter-Liste brächte hier keinen Gewinn).
  const rowIds = figuren
    .map(f => Number(byFigId[f.id]))
    .filter(id => Number.isInteger(id));
  if (!rowIds.length) return { figuren: 0, paare: 0 };
  const idList = rowIds.join(',');
  let paare = 0;
  db.transaction(() => {
    db.prepare(`DELETE FROM figure_appearances WHERE figure_id IN (${idList})`).run();
    // Quelle 1: KI-gemeldete Kapitel (autoritative Häufigkeit).
    const insApp = db.prepare(
      'INSERT OR IGNORE INTO figure_appearances (figure_id, chapter_id, haeufigkeit) VALUES (?, ?, ?)'
    );
    for (const f of figuren) {
      const fid = Number(byFigId[f.id]);
      if (!Number.isInteger(fid)) continue;
      for (const app of (f.kapitel || [])) {
        const chapId = idMaps?.chNameToId?.[_cleanRefName(app.name)] ?? null;
        if (chapId != null) paare += insApp.run(fid, chapId, app.haeufigkeit || 1).changes;
      }
    }
    // Quelle 2: Szenen.
    paare += db.prepare(`
      INSERT OR IGNORE INTO figure_appearances (figure_id, chapter_id, haeufigkeit)
      SELECT sf.figure_id, fs.chapter_id, COUNT(*)
      FROM scene_figures sf
      JOIN figure_scenes fs ON fs.id = sf.scene_id
      WHERE fs.book_id = ? AND fs.user_email IS ? AND fs.chapter_id IS NOT NULL AND fs.stale = 0
        AND sf.figure_id IN (${idList})
      GROUP BY sf.figure_id, fs.chapter_id
    `).run(bookId, em).changes;
    // Quelle 3: Lebensereignisse (die IN-Liste skopiert bereits auf Buch + User).
    paare += db.prepare(`
      INSERT OR IGNORE INTO figure_appearances (figure_id, chapter_id, haeufigkeit)
      SELECT fe.figure_id, fe.chapter_id, COUNT(*)
      FROM figure_events fe
      WHERE fe.chapter_id IS NOT NULL AND fe.figure_id IN (${idList})
      GROUP BY fe.figure_id, fe.chapter_id
    `).run().changes;
  })();
  return { figuren: rowIds.length, paare };
}

/** Beziehungen zwischen Figuren, die im gegebenen Kapitel gemeinsam auftreten.
 *  Liefert: [{ von, zu, typ, beschreibung }] mit Namen (nicht fig_ids).
 *  Ohne chapterId: alle Beziehungen des Buchs. */
function getChapterFigureRelations(bookId, chapterId, userEmail) {
  if (!bookId) return [];
  const em = userEmail || null;
  let rows;
  if (chapterId) {
    rows = db.prepare(`
      SELECT ff.name AS von, ft.name AS zu, r.typ, r.beschreibung
      FROM figure_relations r
      JOIN figures ff ON ff.id = r.from_fig_id
      JOIN figures ft ON ft.id = r.to_fig_id
      WHERE r.book_id = ? AND r.user_email IS ?
        AND EXISTS (SELECT 1 FROM figure_appearances fa WHERE fa.figure_id = ff.id AND fa.chapter_id = ?)
        AND EXISTS (SELECT 1 FROM figure_appearances fa WHERE fa.figure_id = ft.id AND fa.chapter_id = ?)
      ORDER BY ff.sort_order, ft.sort_order
    `).all(bookId, em, chapterId, chapterId);
    if (rows.length > 0) return rows;
  }
  return db.prepare(`
    SELECT ff.name AS von, ft.name AS zu, r.typ, r.beschreibung
    FROM figure_relations r
    JOIN figures ff ON ff.id = r.from_fig_id
    JOIN figures ft ON ft.id = r.to_fig_id
    WHERE r.book_id = ? AND r.user_email IS ?
    ORDER BY ff.sort_order, ft.sort_order
  `).all(bookId, em);
}

/** Liefert eine Figur per figures.id inkl. Tags + ausgehender + eingehender
 *  Beziehungen mit Zielnamen. Owner-Check auf book_id + user_email obliegt
 *  dem Aufrufer. Genutzt vom Werkstatt-Import: alle figures-Felder werden auf
 *  Mindmap-Knoten gemappt. */
function getFigureWithDetails(figureId) {
  const fig = db.prepare(`
    SELECT id, book_id, fig_id, user_email, name, kurzname, typ, geburtstag, geschlecht,
           beruf, wohnadresse, aeusseres, stimme, hintergrund, beschreibung, sozialschicht,
           praesenz, rolle, motivation, konflikt, entwicklung, arc
      FROM figures WHERE id = ?
  `).get(parseInt(figureId));
  if (!fig) return null;

  const tags = db.prepare(
    'SELECT tag FROM figure_tags WHERE figure_id = ? ORDER BY tag'
  ).all(fig.id).map(r => r.tag);

  // Ausgehende und eingehende Beziehungen jeweils mit Name des Pendants.
  const relationsOut = db.prepare(`
    SELECT r.typ, r.beschreibung, ft.name AS partner_name
      FROM figure_relations r
      JOIN figures ft ON ft.id = r.to_fig_id
     WHERE r.from_fig_id = ?
     ORDER BY ft.sort_order, ft.id
  `).all(fig.id);

  const relationsIn = db.prepare(`
    SELECT r.typ, r.beschreibung, ff.name AS partner_name
      FROM figure_relations r
      JOIN figures ff ON ff.id = r.from_fig_id
     WHERE r.to_fig_id = ?
     ORDER BY ff.sort_order, ff.id
  `).all(fig.id);

  return { ...fig, tags, relationsOut, relationsIn };
}

module.exports = {
  getChapterFigures,
  rebuildFigureAppearances,
  getChapterFigureRelations,
  getFigureWithDetails,
};
