const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');
const { mergeFigures } = require('./entity-merge');
const { matchFiguren } = require('../lib/entity-match');
require('./migrations');

// Gerichtete Beziehungstypen und ihre Inverse. A→B elternteil ≡ B→A kind,
// A→B mentor ≡ B→A schuetzling. Für Dedup-Zwecke als identisch betrachtet.
const RELATION_INVERSES = { elternteil: 'kind', kind: 'elternteil', mentor: 'schuetzling', schuetzling: 'mentor', vorgesetzter: 'untergebener', untergebener: 'vorgesetzter' };

/** Dedupliziert Relations pro ungeordnetem Paar (A,B). Erste gewinnt.
 *  Eliminiert damit auch widersprüchliche typs (z.B. elternteil + kind auf dem
 *  gleichen Paar) sowie inverse Dubletten (A elternteil B + B kind A). */
function dedupRelations(relations, validIds) {
  const seen = new Set();
  const result = [];
  for (const r of relations) {
    if (!r.from || !r.to || r.from === r.to) continue;
    if (validIds && (!validIds.has(r.from) || !validIds.has(r.to))) continue;
    const [a, b] = r.from < r.to ? [r.from, r.to] : [r.to, r.from];
    const key = `${a}|${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(r);
  }
  return result;
}

/** SSoT für die fig_id→id-Übersetzung im Write-Path. `figures.fig_id` (TEXT,
 *  KI-stabil) ist nur pro (book_id, user_email) eindeutig; die FK-Targets in
 *  figure_relations/figure_events/location_figures/zeitstrahl_event_figures sind
 *  INTEGER `figures.id`. Jede Stelle, die fig_id-basierten KI-Output in diese
 *  INTEGER-FKs schreibt, MUSS diesen Helper nutzen statt selbst
 *  `SELECT id, fig_id … + Object.fromEntries` zu wiederholen — sonst landet bei
 *  einer neuen Write-Stelle still eine TEXT-fig_id in einer INTEGER-Spalte.
 *  Liefert `rows` (inkl. name/kurzname für Namens-Lookups) + `byFigId`.
 *  Ausnahme: saveFigurenToDb baut die Map beim INSERT aus lastInsertRowid, weil
 *  die Figuren dort noch nicht in der DB stehen. */
function figIdMaps(bookId, userEmail) {
  const rows = db.prepare(
    'SELECT id, fig_id, name, kurzname FROM figures WHERE book_id = ? AND user_email IS ?'
  ).all(bookId, userEmail || null);
  const byFigId = Object.fromEntries(rows.map(r => [r.fig_id, r.id]));
  return { rows, byFigId };
}

// KI liefert Kapitel-/Seitennamen gelegentlich mit Markdown-Header-Präfix
// (##/###, wörtlich aus dem Prompt-Text kopiert) oder als Schema-Platzhalter-Echo
// («## Kapitel-Header», «### Seiten-Header»). Beides strippen/nullen, damit der
// Namens-Lookup auf chNameToId/pageNameToIdByChapter trifft und die UI keinen
// rohen Header anzeigt. Synchron mit dem ^#{1,6}-Strip in komplett/remap.js.
function _cleanRefName(v) {
  if (v == null) return null;
  const s = String(v).replace(/^#{1,6}\s+/, '').trim();
  if (!s || /Kapitel-Header|Seiten-Header/i.test(s)) return null;
  return s;
}

// Auflösung der ersten Erwähnung einer Figur auf eine konkrete page_id:
// 1. Versuche die Pages innerhalb der figure_appearances-Kapitel
//    (kapitel-scoped, gegen Namenskollisionen gleichnamiger Seiten).
// 2. Fallback: Unambiguous-Match über alle Kapitel (nur wenn der Seitenname
//    genau einmal vorkommt).
function resolveErstePageId(ersteErwaehnung, appearances, idMaps) {
  if (!ersteErwaehnung || !idMaps?.pageNameToIdByChapter) return null;
  for (const app of (appearances || [])) {
    const chapId = idMaps.chNameToId?.[_cleanRefName(app.name)];
    if (chapId != null) {
      const pid = idMaps.pageNameToIdByChapter[chapId]?.[ersteErwaehnung];
      if (pid) return pid;
    }
  }
  const candidates = [];
  for (const m of Object.values(idMaps.pageNameToIdByChapter)) {
    if (m[ersteErwaehnung]) candidates.push(m[ersteErwaehnung]);
  }
  return candidates.length === 1 ? candidates[0] : null;
}

// Reichert einen Beziehungs-Beleg ({kapitel, seite}) um chapter_id / page_id an,
// damit das Frontend Klick-Links ohne erneuten Namens-Match bauen kann.
// LLM-Halluzination (seite === kapitel) wird wie bei Szenen genullt.
function enrichBelegWithIds(beleg, idMaps) {
  const chMap = idMaps?.chNameToId || {};
  const a = _cleanRefName(beleg.kapitel);
  const b = _cleanRefName(beleg.seite);
  // Kapitel bestimmen: bevorzugt das kapitel-Feld; sonst das seite-Feld, falls
  // die KI dort einen echten Kapitelnamen abgelegt hat (häufige Feld-Verwechslung
  // im A2-Beziehungs-Call). So bleibt der Beleg klickbar statt als toter Name zu enden.
  let kapitel = (a && chMap[a] != null) ? a : null;
  let seite = b;
  if (!kapitel && b && chMap[b] != null) {
    kapitel = b;   // «seite» war in Wahrheit der Kapitelname
    seite = null;
  } else if (!kapitel) {
    kapitel = a;   // unauflösbar – bereinigter Rohname dient nur der Anzeige
  }
  const chId = (kapitel && chMap[kapitel]) ?? null;
  const effSeite = (seite && seite !== kapitel && seite !== 'Sonstige Seiten')
    ? seite : null;
  const pId = effSeite
    ? (idMaps?.pageNameToIdByChapter?.[chId ?? 0]?.[effSeite] ?? null)
    : null;
  return {
    kapitel: kapitel || null,
    seite: effSeite,
    chapter_id: chId,
    page_id: pId,
  };
}

// Flacht den strukturierten Arc ({typ, anfang, wendepunkte[], ende}) zu einem
// Anzeige-String – Fallback für Leser, die nur das alte `entwicklung`-Feld kennen
// (Figur-Werkstatt-bogen, Buch-Chat-Tool, Alt-Daten ohne arc-Spalte).
function _arcToFlat(arc) {
  if (!arc || typeof arc !== 'object') return null;
  const parts = [arc.anfang, ...(Array.isArray(arc.wendepunkte) ? arc.wendepunkte : []), arc.ende].filter(Boolean);
  if (!parts.length) return arc.typ || null;
  return parts.join(' → ');
}

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

// Schreibt Tags + Kapitel-Vorkommen einer Figur (Caller löscht vorab bei Re-Write).
function _writeFigChildren(insTag, insApp, fid, f, idMaps) {
  for (const tag of (f.eigenschaften || [])) insTag.run(fid, tag);
  for (const app of (f.kapitel || [])) {
    const chapId = idMaps?.chNameToId?.[_cleanRefName(app.name)] ?? null;
    if (chapId != null) insApp.run(fid, chapId, app.haeufigkeit || 1);
  }
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
    const insApp = db.prepare('INSERT OR IGNORE INTO figure_appearances (figure_id, chapter_id, haeufigkeit) VALUES (?, ?, ?)');
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
      _writeFigChildren(insTag, insApp, fid, f, idMaps);
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
    const delApp = db.prepare('DELETE FROM figure_appearances WHERE figure_id = ?');
    const insTag = db.prepare('INSERT OR IGNORE INTO figure_tags (figure_id, tag) VALUES (?, ?)');
    const insApp = db.prepare('INSERT OR IGNORE INTO figure_appearances (figure_id, chapter_id, haeufigkeit) VALUES (?, ?, ?)');
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
        // Analyse-Kinder neu schreiben (CASCADE-Kinder ohne externe Refs). Kapitel-
        // Vorkommen nur clearen, wenn wir sie auch neu auflösen können (idMaps.chNameToId);
        // im Manual-Edit-Pfad ohne idMaps bleiben die bestehenden appearances erhalten,
        // statt die Kapitel-Badges still zu verlieren.
        delTag.run(fid);
        if (idMaps?.chNameToId) delApp.run(fid);
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
      _writeFigChildren(insTag, insApp, fid, f, idMaps);
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

// Ersetzt alle Lebensereignisse für ein Buch/User anhand von fig_id-basierten Assignments.
// assignments: [{ fig_id: "fig_1", lebensereignisse: [...] }]
// Strukturierte Datumsfelder (datum_year/month/day/ende/story_tag/datum_label/subtyp)
// werden vom AI-Pass mitgeliefert; structuredDatum normalisiert sie und zieht
// parseDatum als Fallback bei. manually_edited=1 schützt vor Re-Run-Overwrite.
function updateFigurenEvents(bookId, assignments, userEmail, idMaps) {
  const { structuredDatum } = require('./event-datum');
  db.transaction(() => {
    const { rows: figRows, byFigId: figIdToRowId } = figIdMaps(bookId, userEmail);
    if (!figRows.length) return;

    const delEvt = db.prepare('DELETE FROM figure_events WHERE figure_id = ? AND manually_edited = 0');
    for (const row of figRows) delEvt.run(row.id);

    const insEvt = db.prepare(`INSERT INTO figure_events
      (figure_id, datum, datum_label,
       datum_year, datum_month, datum_day,
       datum_ende_year, datum_ende_month, datum_ende_day,
       story_tag, datum_unsicher, ereignis, bedeutung, typ, subtyp, chapter_id, page_id, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const assignment of assignments) {
      const rowId = figIdToRowId[assignment.fig_id];
      if (!rowId) continue;
      for (let j = 0; j < (assignment.lebensereignisse || []).length; j++) {
        const ev = assignment.lebensereignisse[j];
        const evKapitel = _cleanRefName(ev.kapitel);
        const evSeite = _cleanRefName(ev.seite);
        const chId = (evKapitel && idMaps?.chNameToId?.[evKapitel]) ?? null;
        // LLM-Halluzination: seite === kapitel (Kapitelname statt Seitentitel)
        // oder chMap-Fallback «Sonstige Seiten» → seite nullen.
        const effSeite = (evSeite && evSeite !== evKapitel && evSeite !== 'Sonstige Seiten')
          ? evSeite : null;
        const pageId = effSeite
          ? (idMaps?.pageNameToIdByChapter?.[chId ?? 0]?.[effSeite] ?? null)
          : null;
        const sd = structuredDatum(ev);
        insEvt.run(
          rowId, ev.datum || sd.datum_label || '',
          sd.datum_label,
          sd.datum_year, sd.datum_month, sd.datum_day,
          sd.datum_ende_year, sd.datum_ende_month, sd.datum_ende_day,
          sd.story_tag, sd.datum_unsicher,
          ev.ereignis || '', ev.bedeutung || null,
          ev.typ || 'persoenlich', sd.subtyp, chId, pageId, j,
        );
      }
    }
  })();
}

// Sozialschicht + Machtverhältnis für bestehende Figuren/Beziehungen nachträglich setzen.
// figurenSoziogramm: [{ fig_id, sozialschicht }]
// beziehungenMacht:  [{ from_fig_id, to_fig_id, machtverhaltnis }]
function updateFigurenSoziogramm(bookId, figurenSoziogramm, beziehungenMacht, userEmail) {
  db.transaction(() => {
    const updFig = db.prepare(
      'UPDATE figures SET sozialschicht = ? WHERE book_id = ? AND fig_id = ? AND user_email IS ?'
    );
    for (const f of (figurenSoziogramm || [])) {
      updFig.run(f.sozialschicht || null, bookId, f.fig_id, userEmail || null);
    }
    // figure_relations.from_fig_id/to_fig_id sind INTEGER (figures.id) — Lookup TEXT → INTEGER.
    const { byFigId: figIdToRowId } = figIdMaps(bookId, userEmail);
    const updRel = db.prepare(
      'UPDATE figure_relations SET machtverhaltnis = ? WHERE book_id = ? AND from_fig_id = ? AND to_fig_id = ? AND user_email IS ?'
    );
    for (const bz of (beziehungenMacht || [])) {
      const fromId = figIdToRowId[bz.from_fig_id];
      const toId   = figIdToRowId[bz.to_fig_id];
      if (fromId == null || toId == null) continue;
      updRel.run(bz.machtverhaltnis ?? null, bookId, fromId, toId, userEmail || null);
    }
  })();
}

/** Fügt kapitelübergreifende Beziehungen zur figure_relations-Tabelle hinzu,
 *  ohne bestehende zu löschen. Strenge Dedup: pro ungeordnetem Paar (A,B)
 *  höchstens EINE Beziehung – wenn zwischen bz.von und bz.zu schon irgendeine
 *  Relation existiert, wird die neue verworfen. Zusätzlich: beide fig_ids
 *  müssen in figures existieren. */
function addFigurenBeziehungen(bookId, beziehungen, userEmail, idMaps) {
  const em = userEmail || null;
  // Lookup TEXT-fig_id → INTEGER figures.id (FK-Target seit Mig 72).
  const { byFigId: figIdToRowId } = figIdMaps(bookId, em);
  const pairExists = db.prepare(
    'SELECT COUNT(*) as cnt FROM figure_relations WHERE book_id = ? AND ((from_fig_id = ? AND to_fig_id = ?) OR (from_fig_id = ? AND to_fig_id = ?)) AND user_email IS ?'
  );
  const ins = db.prepare(
    'INSERT INTO figure_relations (book_id, from_fig_id, to_fig_id, typ, beschreibung, machtverhaltnis, belege, user_email) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  db.transaction(() => {
    const seenInBatch = new Set();
    for (const bz of beziehungen) {
      if (!bz.von || !bz.zu || !bz.typ || bz.von === bz.zu) continue;
      const fromId = figIdToRowId[bz.von];
      const toId   = figIdToRowId[bz.zu];
      if (fromId == null || toId == null) continue;
      const [a, b] = bz.von < bz.zu ? [bz.von, bz.zu] : [bz.zu, bz.von];
      const key = `${a}|${b}`;
      if (seenInBatch.has(key)) continue;
      if (pairExists.get(bookId, fromId, toId, toId, fromId, em)?.cnt > 0) continue;
      const belegeArr = Array.isArray(bz.belege)
        ? bz.belege.filter(x => x && (x.kapitel || x.seite))
            .slice(0, 5)
            .map(x => enrichBelegWithIds(x, idMaps))
        : [];
      const belege = belegeArr.length ? JSON.stringify(belegeArr) : null;
      ins.run(bookId, fromId, toId, bz.typ, bz.beschreibung || null, bz.machtverhaltnis ?? null, belege, em);
      seenInBatch.add(key);
    }
  })();
}

/** Post-Hoc-Cleanup für bereits gespeicherte Figuren-Daten eines Buchs/Users.
 *  1. Namens-Duplikate zusammenführen (case-insensitive, normalisiert). Das
 *     Umhängen aller Referenzen + Löschen der Dublette macht `mergeFigures`
 *     ([db/entity-merge.js](entity-merge.js)) — dieselbe Funktion, die auch der
 *     manuelle Merge aus den Bucheinstellungen nutzt. **Why:** eine zweite,
 *     lokale Merge-Implementierung hier deckte nur sechs Brücken ab und liess
 *     plot_beat_figures/research_item_links/song_figures/motif_figures per CASCADE
 *     wegfallen; die Tabellenliste gehört an genau eine Stelle.
 *  2. figure_relations dedupliziert (pro ungeordnetem Paar max 1), Relations mit
 *     nicht-existierenden fig_ids oder Selbst-Referenz entfernt.
 *  3. Beziehungs-Beschreibungen geleert, die den Namen der Zielfigur nicht enthalten
 *     (häufiger Verrutscher bei Lokal-KI).
 *
 *  Performance: Statt einer einzigen umfassenden `db.transaction` läuft der
 *  Cleanup in vielen kleinen Transaktionen (eine pro Duplikat-Gruppe + je eine
 *  für Relations-Dedup und Description-Rescue). better-sqlite3 ist synchron;
 *  ein einziger grosser Transaction-Block würde den WAL-Writer-Lock minutenlang
 *  halten und konkurrierende Requests blockieren. Per-Gruppe-Transaktionen
 *  geben den Lock zwischendurch frei. `onProgress(done, total)` (optional) liefert
 *  Fortschritt für UI-Polling. */
function cleanupDuplicateFiguren(bookId, userEmail, onProgress = null) {
  const em = userEmail || null;
  const stats = { figurenMerged: 0, relationsRemoved: 0, descriptionsCleared: 0, descriptionsMoved: 0 };
  const normalize = s => (s || '').toLowerCase().trim().replace(/\s+/g, ' ');

  const figs = db.prepare(
    'SELECT id, fig_id, name, kurzname, typ, geburtstag, geschlecht, beruf, wohnadresse, beschreibung, sozialschicht FROM figures WHERE book_id = ? AND user_email IS ? ORDER BY sort_order, id'
  ).all(bookId, em);

  const groups = new Map();
  for (const f of figs) {
    const key = normalize(f.name);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }

  // Phase 1: Duplikat-Gruppen mergen — eine Transaktion pro Gruppe, damit der
  // WAL-Lock zwischen Gruppen freigegeben wird (vorher: ein einziger Block über
  // alle Gruppen, der den Server für die Dauer aller Merges blockierte).
  // Die Referenz-Arbeit pro Paar macht mergeFigures (geteilter Merge-Kern);
  // hier bleibt nur die Gruppenbildung + die Wahl der kanonischen Figur.
  const groupArr = [...groups.values()].filter(g => g.length >= 2);
  const totalSteps = groupArr.length + 2; // +1 für Relations-Dedup, +1 für Description-Rescue
  let stepDone = 0;
  for (const group of groupArr) {
    // Reichste Beschreibung gewinnt; die übrigen werden in sie hineingemergt
    // (mergeFigures füllt leere Felder der kanonischen Figur aus der Dublette).
    group.sort((a, b) => (b.beschreibung?.length || 0) - (a.beschreibung?.length || 0));
    const canon = group[0];
    db.transaction(() => {
      for (const dup of group.slice(1)) {
        mergeFigures(bookId, em, dup.id, canon.id);
        stats.figurenMerged++;
      }
    })();
    stepDone++;
    if (onProgress) onProgress(stepDone, totalSteps);
  }

  // Phase 2: Relations-Dedup (eine Transaktion). FK CASCADE faengt orphans
  // ohnehin ab — verbleibender Check ist Self-Ref + Pair-Dedup.
  db.transaction(() => {
    const rels = db.prepare(
      'SELECT rowid, from_fig_id, to_fig_id FROM figure_relations WHERE book_id = ? AND user_email IS ?'
    ).all(bookId, em);
    const seenPair = new Set();
    const toDelete = [];
    for (const r of rels) {
      if (r.from_fig_id === r.to_fig_id) { toDelete.push(r.rowid); continue; }
      const [a, b] = r.from_fig_id < r.to_fig_id ? [r.from_fig_id, r.to_fig_id] : [r.to_fig_id, r.from_fig_id];
      const key = `${a}|${b}`;
      if (seenPair.has(key)) toDelete.push(r.rowid);
      else seenPair.add(key);
    }
    if (toDelete.length) {
      const delRel = db.prepare('DELETE FROM figure_relations WHERE rowid = ?');
      for (const rid of toDelete) delRel.run(rid);
    }
    stats.relationsRemoved = toDelete.length;
  })();
  stepDone++;
  if (onProgress) onProgress(stepDone, totalSteps);

  // Phase 3: Description-Rescue (eine Transaktion).
  db.transaction(() => {
    // figLookup: integer figures.id (=DB-PK) als Schluessel — figure_relations.from/to_fig_id
    // sind seit Mig 72 INTEGER auf figures.id.
    const figByIdForRescue = db.prepare(
      'SELECT id, name, kurzname FROM figures WHERE book_id = ? AND user_email IS ?'
    ).all(bookId, em);
    const figLookup = figByIdForRescue.map(f => ({
      id: f.id,
      names: [f.name, f.kurzname].filter(Boolean).map(s => s.toLowerCase()),
    }));

    const relsWithNames = db.prepare(`
      SELECT r.rowid, r.from_fig_id, r.to_fig_id, r.typ, r.machtverhaltnis, r.beschreibung,
             f2.name AS to_name, f2.kurzname AS to_kurz
      FROM figure_relations r
      LEFT JOIN figures f2 ON f2.id = r.to_fig_id
      WHERE r.book_id = ? AND r.user_email IS ? AND r.beschreibung IS NOT NULL AND r.beschreibung != ''
    `).all(bookId, em);
    const clearDesc = db.prepare('UPDATE figure_relations SET beschreibung = NULL WHERE rowid = ?');
    const getRel = db.prepare(
      'SELECT rowid, beschreibung FROM figure_relations WHERE book_id = ? AND user_email IS ? AND from_fig_id = ? AND to_fig_id = ?'
    );
    const setDesc = db.prepare('UPDATE figure_relations SET beschreibung = ? WHERE rowid = ?');
    const insRel = db.prepare(
      'INSERT INTO figure_relations (book_id, from_fig_id, to_fig_id, typ, beschreibung, machtverhaltnis, user_email) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );

    for (const r of relsWithNames) {
      const targets = [r.to_name, r.to_kurz].filter(Boolean).map(s => s.toLowerCase());
      if (!targets.length) continue;
      const text = r.beschreibung.toLowerCase();
      if (targets.some(n => text.includes(n))) continue;

      const candidates = figLookup.filter(c =>
        c.id !== r.from_fig_id && c.id !== r.to_fig_id && c.names.some(n => text.includes(n))
      );
      if (candidates.length === 1) {
        const target = candidates[0];
        const existing = getRel.get(bookId, em, r.from_fig_id, target.id);
        if (existing && !existing.beschreibung) {
          setDesc.run(r.beschreibung, existing.rowid);
          clearDesc.run(r.rowid);
          stats.descriptionsMoved++;
          continue;
        }
        if (!existing) {
          insRel.run(bookId, r.from_fig_id, target.id, r.typ, r.beschreibung, r.machtverhaltnis ?? null, em);
          clearDesc.run(r.rowid);
          stats.descriptionsMoved++;
          continue;
        }
      }
      clearDesc.run(r.rowid);
      stats.descriptionsCleared++;
    }
  })();
  stepDone++;
  if (onProgress) onProgress(stepDone, totalSteps);

  return stats;
}

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

/** Ergänzt figure_appearances um Kapitel-Auftritte, die aus den übrigen KI-Signalen
 *  der Komplettanalyse ableitbar sind, im selbstgemeldeten `kapitel`-Feld der Figur
 *  aber fehlen: Szenen (scene_figures → figure_scenes.chapter_id) und Lebensereignisse
 *  (figure_events.chapter_id). Schliesst die Single-Pass-Recall-Lücke (KI meldet pro
 *  Figur nicht jedes Kapitel) und füllt Backfill-Figuren ohne `kapitel`.
 *  INSERT OR IGNORE: bestehende Paare behalten ihre KI-Häufigkeit, nur fehlende
 *  Kapitel kommen mit einer aus Szenen/Events abgeleiteten Häufigkeit hinzu. Reiner
 *  SQL-Schritt aus bereits berechneten Daten, kein KI-Call. Läuft nach
 *  saveSzenenAndEvents, sobald Szenen + Events persistiert sind.
 *  Rückgabe: Anzahl neu ergänzter (figure, chapter)-Paare. */
function backfillAppearancesFromScenesEvents(bookId, userEmail) {
  if (!bookId) return 0;
  const em = userEmail || null;
  let added = 0;
  db.transaction(() => {
    added += db.prepare(`
      INSERT OR IGNORE INTO figure_appearances (figure_id, chapter_id, haeufigkeit)
      SELECT sf.figure_id, fs.chapter_id, COUNT(*)
      FROM scene_figures sf
      JOIN figure_scenes fs ON fs.id = sf.scene_id
      WHERE fs.book_id = ? AND fs.user_email IS ? AND fs.chapter_id IS NOT NULL AND fs.stale = 0
      GROUP BY sf.figure_id, fs.chapter_id
    `).run(bookId, em).changes;
    added += db.prepare(`
      INSERT OR IGNORE INTO figure_appearances (figure_id, chapter_id, haeufigkeit)
      SELECT fe.figure_id, fe.chapter_id, COUNT(*)
      FROM figure_events fe
      JOIN figures f ON f.id = fe.figure_id
      WHERE f.book_id = ? AND f.user_email IS ? AND fe.chapter_id IS NOT NULL
      GROUP BY fe.figure_id, fe.chapter_id
    `).run(bookId, em).changes;
  })();
  return added;
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
  planFigurenMatch,
  RELATION_INVERSES,
  dedupRelations,
  figIdMaps,
  saveFigurenToDb,
  updateFigurenEvents,
  updateFigurenSoziogramm,
  addFigurenBeziehungen,
  cleanupDuplicateFiguren,
  getChapterFigures,
  getChapterFigureRelations,
  getFigureWithDetails,
  backfillAppearancesFromScenesEvents,
};
