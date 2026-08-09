const { db } = require('../connection');
const { NOW_ISO_SQL } = require('../now');
const { matchFiguren } = require('../../lib/entity-match');
const { dedupRelations, _cleanRefName, resolveErstePageId, enrichBelegWithIds, _arcToFlat } = require('./refs');
require('../migrations');

// Cross-Run-Matching (Bestand ↔ neue Analyse-Figuren) liegt in
// lib/entity-match.js#matchFiguren — dieselbe Verdikt-Schicht (gleich / unsicher /
// verschieden), die auch Orte und Szenen benutzen, inkl. Indizien-Score
// (figureEvidence) und Ambiguitaets-Guard. Hier bleibt nur die Adaption der
// DB-/Analyse-Formen auf die Match-Kandidaten-Form.
//
// `unsure`-Paare werden hier NICHT gemergt: eine DB-Schreibfunktion darf keinen
// KI-Call machen (harte Regel). Der Job beurteilt sie vorab und reicht das Ergebnis
// als `opts.matchHint` herein (siehe routes/jobs/komplett/entity-reconcile.js).

// Bestands-Row → Match-Kandidat. `chapters` kommt als Set von Kapitelnamen.
function _figMatchCandidateFromRow(ex) {
  return {
    id: ex.id, name: ex.name, kurzname: ex.kurzname, beruf: ex.beruf,
    geburtstag: ex.geburtstag, geschlecht: ex.geschlecht, typ: ex.typ,
    chapters: ex.chapters,
  };
}

// Neue Analyse-Figur → Match-Kandidat. Kapitel liegen als [{ name, haeufigkeit }] vor
// und brauchen dieselbe Namensreinigung wie beim Schreiben (Markdown-Header-Praefixe).
function _figMatchCandidateFromIncoming(f) {
  return {
    id: f.id, name: f.name, kurzname: f.kurzname, beruf: f.beruf,
    geburtstag: f.geburtstag, geschlecht: f.geschlecht, typ: f.typ,
    chapters: (f.kapitel || []).map(k => _cleanRefName(typeof k === 'object' && k ? k.name : k)).filter(Boolean),
  };
}

// Match-Planung Figuren (NUR LESEND) — SSoT fuer beide Seiten: `_reconcileFiguren`
// ruft sie selbst, und der Job ruft sie VOR dem Speichern, um die unsicheren Paare vom
// KI-Judge beurteilen zu lassen (eine DB-Schreibfunktion darf keinen KI-Call machen).
// `hint` = Map(fig_id → figures.id) der bestaetigten Paare.
function planFigurenMatch(bookId, figuren, userEmail, hint = null) {
  const em = userEmail || null;
  const existingRows = db.prepare(
    'SELECT id, fig_id, name, kurzname, beruf, geburtstag, geschlecht, typ FROM figures WHERE book_id = ? AND user_email IS ?'
  ).all(bookId, em);
  const chapRows = db.prepare(`
    SELECT fa.figure_id AS fid, c.chapter_name AS cname
    FROM figure_appearances fa
    JOIN figures f ON f.id = fa.figure_id
    JOIN chapters c ON c.chapter_id = fa.chapter_id
    WHERE f.book_id = ? AND f.user_email IS ?`).all(bookId, em);
  const chaptersByFig = new Map();
  for (const r of chapRows) {
    if (!chaptersByFig.has(r.fid)) chaptersByFig.set(r.fid, new Set());
    chaptersByFig.get(r.fid).add(r.cname);
  }
  for (const ex of existingRows) ex.chapters = chaptersByFig.get(ex.id) || new Set();
  const plan = matchFiguren(
    existingRows.map(_figMatchCandidateFromRow),
    figuren.map(_figMatchCandidateFromIncoming),
    { hint },
  );
  return { ...plan, existing: existingRows };
}

// Pure-Compute der persistierbaren Figur-Felder (geteilt zwischen INSERT/UPDATE).
function _figFields(f, idMaps) {
  const zitate = Array.isArray(f.schluesselzitate) && f.schluesselzitate.length
    ? JSON.stringify(f.schluesselzitate.filter(Boolean).slice(0, 5))
    : null;
  // erste_erwaehnung ist Freitext (kann Kapitel- ODER Seitenname sein).
  // Auflösen: zuerst in den Kapiteln der Figur (figure_appearances) suchen,
  // dann globaler Unambiguous-Match. Kein Name → null.
  const ersteErwaehnung = _cleanRefName(f.erste_erwaehnung);
  const erstPageId = resolveErstePageId(ersteErwaehnung, f.kapitel, idMaps);
  const arcJson = (f.arc && typeof f.arc === 'object') ? JSON.stringify(f.arc)
    : (typeof f.arc === 'string' && f.arc ? f.arc : null);
  const entwicklungFlat = f.entwicklung || _arcToFlat(f.arc) || null;
  return { zitate, ersteErwaehnung, erstPageId, arcJson, entwicklungFlat };
}

// Schreibt die Tags einer Figur (Caller löscht vorab bei Re-Write).
// Kapitel-Vorkommen gehören NICHT hierher: `figure_appearances` ist ein abgeleiteter
// Index aus drei Quellen und wird von rebuildFigureAppearances geschrieben, sobald alle
// drei vorliegen (Begründung dort).
function _writeFigTags(insTag, fid, f) {
  for (const tag of (f.eigenschaften || [])) insTag.run(fid, tag);
}

// Sammelt die Beziehungen einer Figur als {from, to, typ, ...}-Liste (fig_id-basiert).
function _collectRelations(f, idMaps, out) {
  for (const bz of (f.beziehungen || [])) {
    const belegeArr = Array.isArray(bz.belege)
      ? bz.belege.filter(b => b && (b.kapitel || b.seite))
          .slice(0, 5)
          .map(b => enrichBelegWithIds(b, idMaps))
          .filter(b => b.kapitel || b.seite)
      : [];
    out.push({
      from: f.id, to: bz.figur_id, typ: bz.typ,
      beschreibung: bz.beschreibung || null,
      machtverhaltnis: bz.machtverhaltnis ?? null,
      belege: belegeArr.length ? JSON.stringify(belegeArr) : null,
    });
  }
}

/** Persistiert Figuren eines Buchs/Users. Gemeinsames Ziel aller Reconcile-Modi:
 *  `figures.id` über Schreibvorgänge stabil halten, damit FK-Referenzen
 *  (`plot_beat_figures`, `research_item_links`, manually_edited `figure_events` …)
 *  erhalten bleiben — ein DELETE+INSERT kaskadiert sie weg.
 *  Modi:
 *   - **Reconcile identity** (`{ reconcile: true }`; Komplettanalyse): matcht per
 *     Name/Indizien, weil die `fig_id` pro Analyse-Lauf frisch vergeben und NICHT
 *     identitätsstabil ist. Matched → `stale=0` (re-detektiert). Verschwundene →
 *     `stale=1` statt Löschen (`onMissing: 'stale'`).
 *   - **Reconcile figId** (`{ reconcile: true, matchBy: 'figId', onMissing: 'delete' }`;
 *     Manual-Edit-CRUD `PUT /figures/:book_id`): matcht per exakter `fig_id` (round-trippt
 *     stabil durch GET→PUT), behaltene Figuren behalten `id` + ihren stale-Stand;
 *     im Katalog entfernte werden gelöscht (User autoritativ).
 *   - **Legacy Full-Replace** (Default, kein `reconcile`; Buch-Import): löscht alle
 *     Figuren + Beziehungen und legt sie neu an. Korrekt für frische Bücher, wo es
 *     nichts zu reconcilen gibt. */
function saveFigurenToDb(bookId, figuren, userEmail, idMaps, opts = {}) {
  const em = userEmail || null;
  if (opts.reconcile === true) {
    return _reconcileFiguren(bookId, figuren, em, idMaps, opts);
  }
  db.transaction(() => {
    if (userEmail) {
      db.prepare('DELETE FROM figures WHERE book_id = ? AND user_email = ?').run(bookId, userEmail);
      db.prepare('DELETE FROM figure_relations WHERE book_id = ? AND user_email = ?').run(bookId, userEmail);
    } else {
      db.prepare('DELETE FROM figures WHERE book_id = ? AND user_email IS NULL').run(bookId);
      db.prepare('DELETE FROM figure_relations WHERE book_id = ? AND user_email IS NULL').run(bookId);
    }

    const insFig = db.prepare(`
      INSERT INTO figures
        (book_id, fig_id, name, kurzname, typ, geburtstag, geschlecht, beruf, wohnadresse, aeusseres, stimme, hintergrund,
         beschreibung, sozialschicht, praesenz, rolle, motivation, konflikt, entwicklung, arc,
         erste_erwaehnung, erste_erwaehnung_page_id, schluesselzitate, sort_order, user_email, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL})`);
    const insTag = db.prepare('INSERT OR IGNORE INTO figure_tags (figure_id, tag) VALUES (?, ?)');
    const insRel = db.prepare('INSERT INTO figure_relations (book_id, from_fig_id, to_fig_id, typ, beschreibung, machtverhaltnis, belege, user_email) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');

    const validIds = new Set(figuren.map(f => f.id));
    const allRelations = [];
    const figIdToRowId = {}; // TEXT-fig_id → INTEGER figures.id (für FK auf figure_relations)

    for (let i = 0; i < figuren.length; i++) {
      const f = figuren[i];
      const v = _figFields(f, idMaps);
      const { lastInsertRowid: fid } = insFig.run(
        bookId, f.id, f.name, f.kurzname || null, f.typ || null,
        f.geburtstag || null, f.geschlecht || null, f.beruf || null,
        f.wohnadresse || null, f.aeusseres || null, f.stimme || null, f.hintergrund || null,
        f.beschreibung || null, f.sozialschicht || null,
        f.praesenz || null, f.rolle || null, f.motivation || null, f.konflikt || null,
        v.entwicklungFlat, v.arcJson, v.ersteErwaehnung, v.erstPageId, v.zitate,
        i, em
      );
      figIdToRowId[f.id] = fid;
      _writeFigTags(insTag, fid, f);
      _collectRelations(f, idMaps, allRelations);
    }
    for (const r of dedupRelations(allRelations, validIds)) {
      const fromId = figIdToRowId[r.from];
      const toId   = figIdToRowId[r.to];
      if (fromId == null || toId == null) continue;
      insRel.run(bookId, fromId, toId, r.typ, r.beschreibung, r.machtverhaltnis, r.belege, em);
    }
  })();
}

// fig_id-basiertes Matching (Manual-Edit-CRUD): die `fig_id` round-trippt stabil
// durch GET→PUT, ist hier also die autoritative Identität. Greedy, jede Bestands-
// Figur höchstens einmal. Gibt Map(incomingIndex → existingId) zurück.
function _matchFigurenByFigId(existingRows, incoming) {
  const byFigId = new Map(existingRows.map(ex => [ex.fig_id, ex.id]));
  const matchOf = new Map();
  const used = new Set();
  for (let i = 0; i < incoming.length; i++) {
    const exId = byFigId.get(incoming[i].id);
    if (exId != null && !used.has(exId)) { matchOf.set(i, exId); used.add(exId); }
  }
  return matchOf;
}

// Reconcile-Pfad: siehe saveFigurenToDb-Doku.
//   matchBy 'identity' (Default, Komplettanalyse): Name/Indizien-Match; matched →
//     stale=0 (re-detektiert = aktiv); fig_id wird auf den frischen Lauf-Wert gesetzt.
//   matchBy 'figId' (Manual-Edit): exakter fig_id-Match; matched behält seinen
//     stale-Stand (User kuratiert, kein Re-Detektions-Signal).
function _reconcileFiguren(bookId, figuren, em, idMaps, opts) {
  const onMissing = opts.onMissing === 'stale' ? 'stale' : 'delete';
  const matchBy = opts.matchBy === 'figId' ? 'figId' : 'identity';
  const keepStale = matchBy === 'figId';
  db.transaction(() => {
    // 1./2. Bestand + Match: auch stale-Figuren sind Match-Kandidaten — eine
    //    wiederaufgetauchte Figur soll revived werden.
    // 2. Bestand laden + Match neue → bestehende. Der identity-Pfad geht durch
    //    planFigurenMatch (dieselbe Funktion, die der Job vor dem Judge ruft).
    let existingRows;
    let matchOf;
    if (matchBy === 'figId') {
      existingRows = db.prepare(
        'SELECT id, fig_id, name, kurzname, beruf, geburtstag, geschlecht, typ FROM figures WHERE book_id = ? AND user_email IS ?'
      ).all(bookId, em);
      matchOf = _matchFigurenByFigId(existingRows, figuren);
    } else {
      const plan = planFigurenMatch(bookId, figuren, em, opts.matchHint || null);
      existingRows = plan.existing;
      matchOf = plan.matchOf;
    }
    const matchedExisting = new Set([...matchOf.values()]);

    // 3. Verschwundene (nicht wiedergefundene) Bestands-Figuren behandeln.
    const missing = existingRows.filter(ex => !matchedExisting.has(ex.id));
    if (onMissing === 'stale') {
      // Markieren + fig_id aus dem 'fig_N'-Namespace ziehen (kollisionsfrei mit
      // den frisch vergebenen Lauf-IDs). 'orphan_<id>' ist stabil & eindeutig.
      const markStale = db.prepare("UPDATE figures SET stale = 1, fig_id = 'orphan_' || id WHERE id = ?");
      for (const ex of missing) markStale.run(ex.id);
    } else {
      const delFig = db.prepare('DELETE FROM figures WHERE id = ?');
      for (const ex of missing) delFig.run(ex.id);
    }

    // 4. Matched-Figuren transient auf 'tmp_<id>' umbenennen, damit das finale
    //    Umnummerieren auf die Lauf-fig_ids nicht in UNIQUE(book_id,fig_id,user_email)
    //    läuft (zwei Figuren tauschen ihre fig_ids).
    const tmpRename = db.prepare("UPDATE figures SET fig_id = 'tmp_' || id WHERE id = ?");
    for (const exId of matchedExisting) tmpRename.run(exId);

    // 5. Reine Analyse-Beziehungen komplett neu aufbauen (keine externen FKs darauf).
    db.prepare('DELETE FROM figure_relations WHERE book_id = ? AND user_email IS ?').run(bookId, em);

    const insFig = db.prepare(`
      INSERT INTO figures
        (book_id, fig_id, name, kurzname, typ, geburtstag, geschlecht, beruf, wohnadresse, aeusseres, stimme, hintergrund,
         beschreibung, sozialschicht, praesenz, rolle, motivation, konflikt, entwicklung, arc,
         erste_erwaehnung, erste_erwaehnung_page_id, schluesselzitate, sort_order, user_email, stale, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ${NOW_ISO_SQL})`);
    // Zwei UPDATE-Varianten: identity-Match setzt stale=0 (re-detektiert), figId-Match
    // lässt stale unangetastet (User kuratiert; eine orphan-Figur bleibt orphan).
    const _updCols = `
        fig_id = ?, name = ?, kurzname = ?, typ = ?, geburtstag = ?, geschlecht = ?, beruf = ?,
        wohnadresse = ?, aeusseres = ?, stimme = ?, hintergrund = ?, beschreibung = ?, sozialschicht = ?,
        praesenz = ?, rolle = ?, motivation = ?, konflikt = ?, entwicklung = ?, arc = ?,
        erste_erwaehnung = ?, erste_erwaehnung_page_id = ?, schluesselzitate = ?, sort_order = ?`;
    const updFigResetStale = db.prepare(`UPDATE figures SET ${_updCols}, stale = 0, updated_at = ${NOW_ISO_SQL} WHERE id = ?`);
    const updFigKeepStale  = db.prepare(`UPDATE figures SET ${_updCols}, updated_at = ${NOW_ISO_SQL} WHERE id = ?`);
    const updFig = keepStale ? updFigKeepStale : updFigResetStale;
    const delTag = db.prepare('DELETE FROM figure_tags WHERE figure_id = ?');
    const insTag = db.prepare('INSERT OR IGNORE INTO figure_tags (figure_id, tag) VALUES (?, ?)');
    const insRel = db.prepare('INSERT INTO figure_relations (book_id, from_fig_id, to_fig_id, typ, beschreibung, machtverhaltnis, belege, user_email) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');

    const validIds = new Set(figuren.map(f => f.id));
    const allRelations = [];
    const figIdToRowId = {};

    for (let i = 0; i < figuren.length; i++) {
      const f = figuren[i];
      const v = _figFields(f, idMaps);
      const existingId = matchOf.get(i);
      let fid;
      if (existingId != null) {
        updFig.run(
          f.id, f.name, f.kurzname || null, f.typ || null,
          f.geburtstag || null, f.geschlecht || null, f.beruf || null,
          f.wohnadresse || null, f.aeusseres || null, f.stimme || null, f.hintergrund || null,
          f.beschreibung || null, f.sozialschicht || null,
          f.praesenz || null, f.rolle || null, f.motivation || null, f.konflikt || null,
          v.entwicklungFlat, v.arcJson, v.ersteErwaehnung, v.erstPageId, v.zitate,
          i, existingId
        );
        fid = existingId;
        // Analyse-Kinder neu schreiben (CASCADE-Kinder ohne externe Refs). Die Kapitel-
        // Vorkommen bleiben hier unangetastet — sie sind ein abgeleiteter Index, den
        // rebuildFigureAppearances am Ende des Laufs komplett neu baut.
        delTag.run(fid);
      } else {
        const r = insFig.run(
          bookId, f.id, f.name, f.kurzname || null, f.typ || null,
          f.geburtstag || null, f.geschlecht || null, f.beruf || null,
          f.wohnadresse || null, f.aeusseres || null, f.stimme || null, f.hintergrund || null,
          f.beschreibung || null, f.sozialschicht || null,
          f.praesenz || null, f.rolle || null, f.motivation || null, f.konflikt || null,
          v.entwicklungFlat, v.arcJson, v.ersteErwaehnung, v.erstPageId, v.zitate,
          i, em
        );
        fid = r.lastInsertRowid;
      }
      figIdToRowId[f.id] = fid;
      _writeFigTags(insTag, fid, f);
      _collectRelations(f, idMaps, allRelations);
    }
    for (const r of dedupRelations(allRelations, validIds)) {
      const fromId = figIdToRowId[r.from];
      const toId   = figIdToRowId[r.to];
      if (fromId == null || toId == null) continue;
      insRel.run(bookId, fromId, toId, r.typ, r.beschreibung, r.machtverhaltnis, r.belege, em);
    }
  })();
}

module.exports = { planFigurenMatch, saveFigurenToDb };
