'use strict';
// Persistenz der Alters-Analyse (Job `figur-alter`).
//
// ALLE DREI TABELLEN SIND ABGELEITETE INDEXE: `replaceFigureAges` ersetzt den
// Stand eines Buchs als Ganzes (eine Transaktion). Kein Delta — eine Figur, die
// im neuen Lauf keine Altersangabe mehr hat (Satz umgeschrieben, Angabe
// gestrichen), muesste sonst aktiv geloescht werden, und genau das vergisst man.
//
// `figures` bleibt unberuehrt: `figures.geburtstag` gehoert dem Autor. Das
// Analyse-Ergebnis steht daneben, damit ein Widerspruch sichtbar bleibt statt
// stillschweigend gewinnen zu koennen.

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');

const _stmtDelAges = db.prepare('DELETE FROM figure_ages WHERE book_id = ?');
const _stmtDelBelege = db.prepare('DELETE FROM figure_age_belege WHERE book_id = ?');

const _stmtInsAge = db.prepare(`
  INSERT INTO figure_ages (
    figure_id, book_id, alter_von, alter_bis, bezugsjahr_von, bezugsjahr_bis,
    geburtsjahr, gerechnet, geburtsjahr_quelle, quelle, konfidenz, widerspruch_json,
    begruendung, scanned_at
  ) VALUES (
    @figure_id, @book_id, @alter_von, @alter_bis, @bezugsjahr_von, @bezugsjahr_bis,
    @geburtsjahr, @gerechnet, @geburtsjahr_quelle, @quelle, @konfidenz, @widerspruch_json,
    @begruendung, ${NOW_ISO_SQL}
  )
`);

const _stmtInsBeleg = db.prepare(`
  INSERT INTO figure_age_belege (
    figure_id, book_id, art, wert, bezugsjahr, zitat, page_id, chapter_id,
    unsicher, begruendung, sort_order
  ) VALUES (
    @figure_id, @book_id, @art, @wert, @bezugsjahr, @zitat, @page_id, @chapter_id,
    @unsicher, @begruendung, @sort_order
  )
`);

const _stmtUpsertScan = db.prepare(`
  INSERT INTO figure_age_scans (
    book_id, user_email, scanned_at, content_sig, age_version, model,
    figuren_total, mit_alter, belege_total, embed_used
  ) VALUES (
    @book_id, @user_email, ${NOW_ISO_SQL}, @content_sig, @age_version, @model,
    @figuren_total, @mit_alter, @belege_total, @embed_used
  )
  ON CONFLICT(book_id, user_email) DO UPDATE SET
    scanned_at    = excluded.scanned_at,
    content_sig   = excluded.content_sig,
    age_version   = excluded.age_version,
    model         = excluded.model,
    figuren_total = excluded.figuren_total,
    mit_alter     = excluded.mit_alter,
    belege_total  = excluded.belege_total,
    embed_used    = excluded.embed_used
`);

// Ein Beleg zeigt auf eine Seite, und der Scan laeuft ueber Minuten — die Seite
// kann in der Zwischenzeit geloescht worden sein. Ein FK-Verstoss wuerde die
// ganze Transaktion und damit die komplette Analyse verwerfen; ein fehlendes
// Sprungziel kostet nur den Klick. Gleiche Haltung wie db/lexicon.js.
const _stmtPageExists = db.prepare('SELECT 1 FROM pages WHERE page_id = ?');
const _stmtChapterExists = db.prepare('SELECT 1 FROM chapters WHERE chapter_id = ?');
function _safePageId(id) { return id != null && _stmtPageExists.get(id) ? id : null; }
function _safeChapterId(id) { return id != null && _stmtChapterExists.get(id) ? id : null; }
// Dieselbe Ursache eine Ebene hoeher: eine Figur, die waehrend des Laufs
// verschwindet (Komplettanalyse-Reconcile, manuelles Loeschen), darf den Lauf
// nicht verwerfen — ihre Zeile faellt einfach weg.
const _stmtFigureExists = db.prepare('SELECT 1 FROM figures WHERE id = ? AND book_id = ?');

const _num = v => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null));

/**
 * Full-Replace des Alters-Index eines Buchs.
 * @param {number} bookId
 * @param {string} userEmail
 * @param {object} payload  { rows: [{ figure_id, …, belege: [] }], scan: {…} }
 */
const replaceFigureAges = db.transaction((bookId, userEmail, { rows = [], scan = {} } = {}) => {
  _stmtDelBelege.run(bookId);
  _stmtDelAges.run(bookId);

  let belegeTotal = 0, mitAlter = 0;
  for (const r of rows) {
    const figureId = _num(r.figure_id);
    if (figureId == null || !_stmtFigureExists.get(figureId, bookId)) continue;
    _stmtInsAge.run({
      figure_id: figureId,
      book_id: bookId,
      alter_von: _num(r.alter_von),
      alter_bis: _num(r.alter_bis),
      bezugsjahr_von: _num(r.bezugsjahr_von),
      bezugsjahr_bis: _num(r.bezugsjahr_bis),
      geburtsjahr: _num(r.geburtsjahr),
      gerechnet: _num(r.gerechnet),
      geburtsjahr_quelle: r.geburtsjahr_quelle || null,
      quelle: r.quelle || null,
      konfidenz: Number.isFinite(Number(r.konfidenz)) ? Number(r.konfidenz) : 0,
      widerspruch_json: r.widerspruch ? JSON.stringify(r.widerspruch) : null,
      begruendung: r.begruendung || null,
    });
    if (_num(r.alter_von) != null) mitAlter++;
    let i = 0;
    for (const b of (r.belege || [])) {
      const wert = _num(b.wert);
      const zitat = typeof b.zitat === 'string' ? b.zitat.trim() : '';
      if (wert == null || !zitat) continue;
      if (!['alter', 'geburtsjahr', 'todesjahr'].includes(b.art)) continue;
      _stmtInsBeleg.run({
        figure_id: figureId,
        book_id: bookId,
        art: b.art,
        wert,
        bezugsjahr: _num(b.bezugsjahr),
        zitat: zitat.slice(0, 400),
        page_id: _safePageId(_num(b.page_id)),
        chapter_id: _safeChapterId(_num(b.chapter_id)),
        unsicher: b.unsicher ? 1 : 0,
        begruendung: b.begruendung ? String(b.begruendung).slice(0, 400) : null,
        sort_order: i++,
      });
      belegeTotal++;
    }
  }

  _stmtUpsertScan.run({
    book_id: bookId,
    user_email: userEmail || '',
    content_sig: scan.content_sig || null,
    age_version: _num(scan.age_version) ?? 0,
    model: scan.model || null,
    figuren_total: _num(scan.figuren_total) ?? 0,
    mit_alter: mitAlter,
    belege_total: belegeTotal,
    embed_used: scan.embed_used ? 1 : 0,
  });
  return { rows: rows.length, mitAlter, belegeTotal };
});

/** Der Lauf-Kopf („Stand vom", Delta-Skip-Signatur). null, wenn noch nie gescannt. */
function getFigureAgeScan(bookId, userEmail) {
  return db.prepare(
    'SELECT * FROM figure_age_scans WHERE book_id = ? AND user_email = ?'
  ).get(bookId, userEmail || '') || null;
}

/** Alters-Zeilen eines Buchs, nach `figures.fig_id` geschluesselt — das ist die
 *  Kennung, die GET /figures/:book_id nach vorne gibt (`id`), und damit die
 *  einzige, an der das Frontend die Tabelle an den Katalog haengen kann. */
function listFigureAges(bookId, userEmail) {
  const rows = db.prepare(`
    SELECT fa.*, f.fig_id, f.name
    FROM figure_ages fa
    JOIN figures f ON f.id = fa.figure_id
    WHERE fa.book_id = ? AND f.user_email = ?
  `).all(bookId, userEmail || '');
  const belege = db.prepare(`
    SELECT b.figure_id, b.art, b.wert, b.bezugsjahr, b.zitat, b.page_id, b.chapter_id,
           b.unsicher, b.begruendung, p.page_name, c.chapter_name
    FROM figure_age_belege b
    JOIN figures f ON f.id = b.figure_id
    LEFT JOIN pages p    ON p.page_id = b.page_id
    LEFT JOIN chapters c ON c.chapter_id = b.chapter_id
    WHERE b.book_id = ? AND f.user_email = ?
    ORDER BY b.figure_id, b.sort_order
  `).all(bookId, userEmail || '');
  const byFig = new Map();
  for (const b of belege) {
    if (!byFig.has(b.figure_id)) byFig.set(b.figure_id, []);
    byFig.get(b.figure_id).push({
      art: b.art, wert: b.wert, bezugsjahr: b.bezugsjahr, zitat: b.zitat,
      page_id: b.page_id, page_name: b.page_name || null,
      chapter_id: b.chapter_id, chapter_name: b.chapter_name || null,
      unsicher: !!b.unsicher, begruendung: b.begruendung || null,
    });
  }
  return rows.map(r => ({
    fig_id: r.fig_id,
    name: r.name,
    alter_von: r.alter_von,
    alter_bis: r.alter_bis,
    bezugsjahr_von: r.bezugsjahr_von,
    bezugsjahr_bis: r.bezugsjahr_bis,
    geburtsjahr: r.geburtsjahr,
    gerechnet: r.gerechnet,
    geburtsjahr_quelle: r.geburtsjahr_quelle,
    quelle: r.quelle,
    konfidenz: r.konfidenz,
    widerspruch: r.widerspruch_json ? (() => { try { return JSON.parse(r.widerspruch_json); } catch { return null; } })() : null,
    begruendung: r.begruendung,
    scanned_at: r.scanned_at,
    belege: byFig.get(r.figure_id) || [],
  }));
}

module.exports = { replaceFigureAges, getFigureAgeScan, listFigureAges };
