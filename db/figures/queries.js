const { db } = require('../connection');
const { figIdMaps, _cleanRefName } = require('./refs');
const { computeFigureYears } = require('../../lib/figure-years');
require('../migrations');

/** Figuren eines Kapitels laden — gleiche Quelle wie die Figurenliste
 *  ([routes/figures.js] `/:book_id`): `figure_appearances` (KI-Auftritte im Kapitel).
 *  Die KI unterscheidet die Figur von gleichnamigen, nur erwähnten realen Personen;
 *  reine Namensnennungen (page_figure_mentions) zählen bewusst nicht mit.
 *  Sortierung: Häufigkeit DESC. Fallback: alle Buchfiguren, wenn keine Kapitel-
 *  zuordnung existiert (z.B. vor der ersten Komplettanalyse).
 *  Gibt kompakte Objekte zurück: { id, name, kurzname, geschlecht, beruf, wohnadresse, beschreibung, typ }.
 *  **`id` ist die TEXT-`fig_id`, nicht die INTEGER-Zeilen-ID** — dieselbe Achse,
 *  die `listFigurenWithDetails` als `id` ausliefert. Beide Listen treffen im
 *  Frontend aufeinander (Referenz-Slot vereinigt Katalog + Kapitel-Index); mit
 *  zwei Identitätsachsen findet dort kein Vergleich ein Gegenstück, und jede
 *  Kapitel-Figur erscheint ein zweites Mal als angeblich unbekannte Zeile. */
function getChapterFigures(bookId, chapterId, userEmail) {
  if (!bookId) return [];
  const cols = 'f.fig_id AS id, f.name, f.kurzname, f.geschlecht, f.beruf, f.wohnadresse, f.beschreibung, f.typ, f.geburtstag';
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

/** Der vollstaendige Figuren-Katalog eines Buchs, so wie ihn die Figurenkarte
 *  liest (`GET /figures/:book_id`): Stammdaten plus Eigenschaften, Kapitel-
 *  Auftritte, Szenen-Seiten, Lebensereignisse, Beziehungen und die abgeleiteten
 *  Jahres-/Altersfelder.
 *
 *  **Why hier und nicht im Route-Handler:** die Aufloesung braucht Kapitel- und
 *  Seitennamen (`chapters.chapter_name`, `pages.page_name`). Ein solcher
 *  Namens-JOIN gehoert nach CLAUDE.md („Content-Store-Facade als einziger
 *  Eintrittspunkt") in das `db/`-Modul der abgeleiteten Tabelle, nicht in den
 *  Handler — Muster wie `db/sources/citations.js#listSourceCitations`.
 *
 *  Rueckgabe `{ figuren, updated_at }`. `updated_at` ist der JUENGSTE Stempel des
 *  Katalogs (nicht der irgendeiner einzelnen Zeile), damit er als „Stand" taugt.
 *  Ohne Figuren: `{ figuren: [], updated_at: null }` — die leere Liste ist eine
 *  Antwort, kein Sonderfall, den jeder Aufrufer eigens abfangen muss. */
function listFigurenWithDetails(bookId, userEmail) {
  const em = userEmail || null;
  const figs = db.prepare(`
    SELECT * FROM figures
    WHERE book_id = ? AND user_email IS ?
    ORDER BY sort_order, id
  `).all(bookId, em);
  if (!figs.length) return { figuren: [], updated_at: null };

  const tags = db.prepare(`
    SELECT ft.figure_id, ft.tag FROM figure_tags ft
    JOIN figures f ON f.id = ft.figure_id
    WHERE f.book_id = ? AND f.user_email IS ?`).all(bookId, em);
  const apps = db.prepare(`
    SELECT fa.figure_id, fa.chapter_id, c.chapter_name, fa.haeufigkeit
    FROM figure_appearances fa
    JOIN figures f ON f.id = fa.figure_id
    LEFT JOIN chapters c ON c.chapter_id = fa.chapter_id
    WHERE f.book_id = ? AND f.user_email IS ?`).all(bookId, em);
  const evts = db.prepare(`
    SELECT fe.figure_id, fe.datum, fe.datum_label, fe.ereignis, fe.bedeutung, fe.typ, fe.subtyp,
           fe.datum_year, fe.datum_month, fe.datum_day,
           fe.datum_ende_year, fe.datum_ende_month, fe.datum_ende_day,
           fe.story_tag, fe.datum_unsicher,
           fe.chapter_id, fe.page_id,
           c.chapter_name AS kapitel, p.page_name AS seite
    FROM figure_events fe
    JOIN figures f ON f.id = fe.figure_id
    LEFT JOIN chapters c ON c.chapter_id = fe.chapter_id
    LEFT JOIN pages    p ON p.page_id    = fe.page_id
    WHERE f.book_id = ? AND f.user_email IS ?
    ORDER BY fe.figure_id, fe.sort_order`).all(bookId, em);
  const rels = db.prepare(`
    SELECT ff.fig_id AS from_fig_id, ft.fig_id AS to_fig_id,
           r.typ, r.beschreibung, r.machtverhaltnis, r.belege
    FROM figure_relations r
    JOIN figures ff ON ff.id = r.from_fig_id
    JOIN figures ft ON ft.id = r.to_fig_id
    WHERE r.book_id = ? AND r.user_email IS ?
  `).all(bookId, em);
  const sceneFigRows = db.prepare(`
    SELECT c.chapter_name AS kapitel, p.page_name AS seite, f.fig_id
    FROM figure_scenes fs
    JOIN scene_figures sf ON sf.scene_id = fs.id
    JOIN figures f ON f.id = sf.figure_id
    LEFT JOIN chapters c ON c.chapter_id = fs.chapter_id
    LEFT JOIN pages    p ON p.page_id    = fs.page_id
    WHERE fs.book_id = ? AND fs.user_email IS ?
  `).all(bookId, em);

  const tagMap = {};
  for (const t of tags) (tagMap[t.figure_id] ??= []).push(t.tag);

  // Kapitel-Auftritte: alleinige Quelle figure_appearances (KI). Die KI erkennt die
  // Figur im Kontext und unterscheidet sie von gleichnamigen, im Text nur erwähnten
  // realen Personen (z.B. Figur „Pamela" vs. „Pamela Anderson"). Reine Namensnennungen
  // (page_figure_mentions) zählen hier bewusst nicht mit. Sortierung: Häufigkeit DESC.
  // Erst nach einer Komplettanalyse befüllt.
  const kapMap = {};
  for (const a of apps) {
    if (a.chapter_id == null) continue;
    (kapMap[a.figure_id] ??= new Map()).set(a.chapter_id, {
      chapter_id: a.chapter_id, name: a.chapter_name, haeufigkeit: a.haeufigkeit || 1,
    });
  }
  const kapitelFor = (figId) => {
    const m = kapMap[figId];
    if (!m) return [];
    return [...m.values()].sort((a, b) =>
      (b.haeufigkeit || 0) - (a.haeufigkeit || 0) || a.chapter_id - b.chapter_id);
  };

  // Die strukturierten Datumsspalten gehoeren in die Antwort: sie sind die SSoT
  // der Datums-Anzeige (formatEventDate) und der Jahres-Achse. Ohne sie muesste
  // jeder Konsument das Jahr wieder aus dem Freitext `datum` fischen — und ein
  // Ereignis, dessen Datum NUR strukturiert vorliegt (leeres Label, z.B. aus
  // einem Kalenderdatum im Text), waere fuer Zeitstrahl-Fallback und Lebenslauf
  // datumslos.
  const evtMap = {};
  for (const e of evts) (evtMap[e.figure_id] ??= []).push({
    datum: e.datum, datum_label: e.datum_label || e.datum || '',
    ereignis: e.ereignis, bedeutung: e.bedeutung,
    typ: e.typ || 'persoenlich', subtyp: e.subtyp || 'sonstiges',
    datum_year: e.datum_year, datum_month: e.datum_month, datum_day: e.datum_day,
    datum_ende_year: e.datum_ende_year, datum_ende_month: e.datum_ende_month,
    datum_ende_day: e.datum_ende_day,
    story_tag: e.story_tag, datum_unsicher: !!e.datum_unsicher,
    chapter_id: e.chapter_id ?? null, page_id: e.page_id ?? null,
    kapitel: e.kapitel || null, seite: e.seite || null,
  });

  const relMap = {};
  for (const r of rels) {
    (relMap[r.from_fig_id] ??= []).push({
      figur_id: r.to_fig_id,
      typ: r.typ,
      beschreibung: r.beschreibung,
      machtverhaltnis: r.machtverhaltnis ?? null,
      belege: _parseJsonArray(r.belege),
    });
  }

  const seitenMap = {};
  for (const sc of sceneFigRows) {
    if (!seitenMap[sc.fig_id]) seitenMap[sc.fig_id] = [];
    const key = sc.kapitel + '::' + (sc.seite || '');
    if (!seitenMap[sc.fig_id].some(x => x.kapitel + '::' + x.seite === key)) {
      seitenMap[sc.fig_id].push({ kapitel: sc.kapitel, seite: sc.seite || '' });
    }
  }

  const yearMap = computeFigureYears(bookId, em);

  const figuren = figs.map(f => {
    const fy = yearMap?.get(f.id) || null;
    return {
      id: f.fig_id,
      stale: !!f.stale,
      name: f.name,
      kurzname: f.kurzname,
      typ: f.typ,
      geburtstag: f.geburtstag,
      geschlecht: f.geschlecht,
      beruf: f.beruf,
      wohnadresse: f.wohnadresse || null,
      aeusseres: f.aeusseres || null,
      stimme: f.stimme || null,
      hintergrund: f.hintergrund || null,
      beschreibung: f.beschreibung,
      sozialschicht: f.sozialschicht || null,
      praesenz: f.praesenz || null,
      rolle: f.rolle || null,
      motivation: f.motivation || null,
      konflikt: f.konflikt || null,
      entwicklung: f.entwicklung || null,
      arc: _parseArc(f.arc),
      erste_erwaehnung: f.erste_erwaehnung || null,
      erste_erwaehnung_page_id: f.erste_erwaehnung_page_id || null,
      schluesselzitate: _parseJsonArray(f.schluesselzitate),
      eigenschaften: tagMap[f.id] || [],
      kapitel: kapitelFor(f.id),
      seiten: seitenMap[f.fig_id] || [],
      lebensereignisse: evtMap[f.id] || [],
      beziehungen: relMap[f.fig_id] || [],
      jahr_im_roman:   fy ? fy.jahr_im_roman   : null,
      geburtsjahr:     fy ? fy.geburtsjahr     : null,
      alter_im_roman:  fy ? fy.alter_im_roman  : null,
      anchor_ereignis: fy ? fy.anchor_ereignis : null,
      anchor_kapitel:  fy ? fy.anchor_kapitel  : null,
    };
  });

  let updatedAt = null;
  for (const f of figs) if (f.updated_at && (!updatedAt || f.updated_at > updatedAt)) updatedAt = f.updated_at;
  return { figuren, updated_at: updatedAt };
}

/** JSON-Spalte, die ein Array halten soll. Kaputtes JSON ist kein Grund, die
 *  ganze Figur fallenzulassen — es fehlt dann eben die Liste. */
function _parseJsonArray(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

/** Entwicklungsbogen aus der `arc`-Spalte. Alt-Daten hielten dort einen flachen
 *  String statt JSON — der wird als „Ende" gelesen, statt verloren zu gehen.
 *  Ein Bogen ohne jeden Inhalt ist `null`, damit die Karte auf das flache
 *  `entwicklung`-Feld zurueckfaellt. */
function _parseArc(raw) {
  if (!raw) return null;
  let arc = null;
  try { arc = JSON.parse(raw); } catch { arc = null; }
  if (arc === null && typeof raw === 'string') arc = { typ: '', anfang: '', wendepunkte: [], ende: raw };
  const hatInhalt = arc && (arc.anfang || arc.ende || arc.typ
    || (Array.isArray(arc.wendepunkte) && arc.wendepunkte.length));
  return hatInhalt ? arc : null;
}

module.exports = {
  listFigurenWithDetails,
  getChapterFigures,
  rebuildFigureAppearances,
  getChapterFigureRelations,
  getFigureWithDetails,
};
