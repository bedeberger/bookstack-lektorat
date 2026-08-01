'use strict';
// Persistenz der Wortschatz-Analyse. Alle drei Tabellen sind ABGELEITETE Indexe:
// sie werden nie inkrementell fortgeschrieben, sondern pro Scan als Ganzes
// ersetzt (`replaceBookLexicon`, eine Transaktion). Warum kein Delta: die
// Ranglisten sind gedeckelt (Top-N) — ein Term, der aus den Top-200 fällt, müsste
// beim Delta-Schreiben aktiv gelöscht werden, und genau das vergisst man. Ein
// Full-Replace kann diesen Zustand nicht erzeugen.
//
// Buch-skopiert, nicht user-skopiert: der Wortschatz ist eine Eigenschaft des
// Textes, nicht des Betrachters. Der Zugriffsschutz liegt in der Buch-ACL
// (routes/lexicon.js), nicht in einer `user_email`-Spalte.

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');

const _stmtDelStats = db.prepare('DELETE FROM book_lexicon WHERE book_id = ?');
const _stmtDelTerms = db.prepare('DELETE FROM lexicon_terms WHERE book_id = ?');
const _stmtDelNgrams = db.prepare('DELETE FROM lexicon_ngrams WHERE book_id = ?');

const _stmtInsertStats = db.prepare(`
  INSERT INTO book_lexicon (
    book_id, scanned_at, lexicon_version, content_sig,
    pages, segments, tokens, types, lemma_types, hapax, hapax_listed, dislegomena, hapax_ratio,
    mattr, mattr_window, mattr_windows, mtld, yule_k, heaps_beta, heaps_k, lex_density,
    freq_json
  ) VALUES (
    @book_id, ${NOW_ISO_SQL}, @lexicon_version, @content_sig,
    @pages, @segments, @tokens, @types, @lemma_types, @hapax, @hapax_listed, @dislegomena, @hapax_ratio,
    @mattr, @mattr_window, @mattr_windows, @mtld, @yule_k, @heaps_beta, @heaps_k, @lex_density,
    @freq_json
  )
`);

const _stmtInsertTerm = db.prepare(`
  INSERT INTO lexicon_terms (book_id, term, kind, count, chapter_spread, keyness, first_page_id)
  VALUES (@book_id, @term, @kind, @count, @chapter_spread, @keyness, @first_page_id)
`);

const _stmtInsertNgram = db.prepare(`
  INSERT INTO lexicon_ngrams (book_id, phrase, n, count, chapter_spread, log_dice, first_page_id)
  VALUES (@book_id, @phrase, @n, @count, @chapter_spread, @log_dice, @first_page_id)
`);

// Seiten-IDs, die es wirklich gibt — `first_page_id` ist ein FK, und der Scan
// kann eine Seite gesehen haben, die zwischen Analyse und Schreiben gelöscht wurde
// (der Scan läuft über Minuten). Ein FK-Verstoss würde die ganze Transaktion
// verwerfen und damit die komplette Analyse; ein fehlendes Sprungziel kostet nur
// den Klick.
const _stmtPageExists = db.prepare('SELECT 1 FROM pages WHERE page_id = ?');
function _safePageId(id) {
  if (id == null) return null;
  return _stmtPageExists.get(id) ? id : null;
}

// Full-Replace in einer Transaktion: erst die drei Tabellen für das Buch leeren,
// dann neu füllen. Reihenfolge innerhalb der Transaktion ist unkritisch (keine
// Abhängigkeit untereinander), die Atomarität ist es nicht: ein Abbruch nach dem
// DELETE würde das Buch sonst ohne Analyse dastehen lassen, obwohl es eine hatte.
const _replace = db.transaction((bookId, { stats, terms, phrases }) => {
  _stmtDelTerms.run(bookId);
  _stmtDelNgrams.run(bookId);
  _stmtDelStats.run(bookId);

  _stmtInsertStats.run({
    book_id: bookId,
    lexicon_version: stats.version ?? 0,
    content_sig: stats.content_sig ?? null,
    pages: stats.pages ?? null,
    segments: stats.segments ?? null,
    tokens: stats.tokens ?? null,
    types: stats.types ?? null,
    lemma_types: stats.lemma_types ?? null,
    hapax: stats.hapax ?? null,
    hapax_listed: stats.hapax_listed ?? null,
    dislegomena: stats.dislegomena ?? null,
    hapax_ratio: stats.hapax_ratio ?? null,
    mattr: stats.mattr ?? null,
    mattr_window: stats.mattr_window ?? null,
    mattr_windows: stats.mattr_windows ?? null,
    mtld: stats.mtld ?? null,
    yule_k: stats.yule_k ?? null,
    heaps_beta: stats.heaps_beta ?? null,
    heaps_k: stats.heaps_k ?? null,
    lex_density: stats.lex_density ?? null,
    freq_json: stats.freq_json ?? null,
  });

  for (const t of terms || []) {
    _stmtInsertTerm.run({
      book_id: bookId,
      term: t.term,
      // Ohne `kind` gaebe es keinen Weg, die drei Zeilensorten wieder zu trennen —
      // ein Einmalwort ist nicht „ein Lieblingswort mit count 1".
      kind: t.kind || 'freq',
      count: t.count,
      chapter_spread: t.chapter_spread ?? 0,
      keyness: t.keyness ?? null,
      first_page_id: _safePageId(t.first_page_id),
    });
  }
  for (const p of phrases || []) {
    _stmtInsertNgram.run({
      book_id: bookId,
      phrase: p.phrase,
      n: p.n,
      count: p.count,
      chapter_spread: p.chapter_spread ?? 0,
      log_dice: p.log_dice ?? null,
      first_page_id: _safePageId(p.first_page_id),
    });
  }
});

function replaceBookLexicon(bookId, result) {
  _replace(bookId, result);
}

// Spalten explizit, NICHT `SELECT *`: `freq_json` ist die Referenz-Frequenztabelle
// (bis ~5000 Terme) und hat im Lesepfad der Karte nichts zu suchen — sie würde bei
// jedem Kartenaufruf mitgeschleppt.
const _stmtGetStats = db.prepare(`
  SELECT book_id, scanned_at, lexicon_version, content_sig,
         pages, segments, tokens, types, lemma_types, hapax, hapax_listed, dislegomena, hapax_ratio,
         mattr, mattr_window, mattr_windows, mtld, yule_k, heaps_beta, heaps_k, lex_density
    FROM book_lexicon WHERE book_id = ?
`);

// Ranglisten kommen mit dem Seitennamen des Sprungziels, damit die Karte kein
// zweites Roundtrip pro Zeile braucht. Snapshot-Spalten wären hier verboten
// (siehe „Snapshot-Spalten verboten" in CLAUDE.md) — der Name kommt per JOIN.
// Wortliste ohne die Einmalwörter: das ist eine eigene Rangliste mit eigener
// Auswahlregel und eigenem Reiter, und sie ist um ein Vielfaches länger — in
// derselben Tabelle gemischt würde sie die Lieblingswörter erschlagen.
const _stmtListTerms = db.prepare(`
  SELECT lt.term, lt.kind, lt.count, lt.chapter_spread, lt.keyness, lt.first_page_id,
         p.page_name AS first_page_name
    FROM lexicon_terms lt
    LEFT JOIN pages p ON p.page_id = lt.first_page_id
   WHERE lt.book_id = ? AND lt.kind != 'hapax'
   ORDER BY lt.count DESC, lt.term
`);

// Einmalwörter. Sortierung wie die Auswahl in lib/lexicon/analyze.js (lang zuerst)
// — sonst zeigt die erste Tabellenseite eine andere Auswahl als die, die der Scan
// getroffen hat.
const _stmtListHapax = db.prepare(`
  SELECT lt.term, lt.first_page_id, p.page_name AS first_page_name
    FROM lexicon_terms lt
    LEFT JOIN pages p ON p.page_id = lt.first_page_id
   WHERE lt.book_id = ? AND lt.kind = 'hapax'
   ORDER BY length(lt.term) DESC, lt.term
`);

const _stmtListNgrams = db.prepare(`
  SELECT ln.phrase, ln.n, ln.count, ln.chapter_spread, ln.log_dice, ln.first_page_id,
         p.page_name AS first_page_name
    FROM lexicon_ngrams ln
    LEFT JOIN pages p ON p.page_id = ln.first_page_id
   WHERE ln.book_id = ?
   ORDER BY ln.count DESC, ln.n, ln.phrase
`);

function getBookLexicon(bookId) {
  return _stmtGetStats.get(bookId) || null;
}

function listLexiconTerms(bookId) {
  return _stmtListTerms.all(bookId);
}

function listLexiconHapax(bookId) {
  return _stmtListHapax.all(bookId);
}

function listLexiconNgrams(bookId) {
  return _stmtListNgrams.all(bookId);
}

// Für den Delta-Skip im Job: nur die Signatur, ohne die ganze Zeile zu laden.
const _stmtGetSig = db.prepare('SELECT content_sig, lexicon_version FROM book_lexicon WHERE book_id = ?');
function getLexiconSignature(bookId) {
  return _stmtGetSig.get(bookId) || null;
}

// Referenzkorpus für die Keyness: die Häufigkeitstabellen ALLER ÜBRIGEN Bücher
// desselben Besitzers, zu einer Tabelle verschmolzen. Bücher ohne abgeschlossenen
// Scan (kein `freq_json`) tragen nichts bei — beim ersten Nacht-Lauf einer neuen
// Installation ist die Referenz darum noch dünn und füllt sich mit jedem Buch.
//
// Rückgabe: { freq: Map<term,count>, total: number, books: number, floor: number }
// oder null, wenn es kein anderes gescanntes Buch gibt (dann bleibt die
// Keyness-Spalte leer — siehe lib/lexicon/keyness.js).
//
// `floor` ist die Kappungsgrenze: die gespeicherten Frequenztabellen sind gedeckelt,
// ein dort fehlender Term kommt im jeweiligen Buch also höchstens so oft vor wie
// dessen seltenster aufgenommener Term. Das Maximum über die Bücher ist die
// Schranke für die Auswahl nach Auffälligkeit (lib/lexicon/analyze.js) — ohne sie
// stünden bevorzugt Wörter in der Liste, deren Auffälligkeit nur daher rührt, dass
// die Referenztabelle sie nicht kennt. Sie stellt sich selbst nach: enthält ein
// Buch seine Frequenzen vollständig bis zur Mindesthäufigkeit, ist der Wert klein.
const _stmtRefRows = db.prepare(`
  SELECT bl.tokens, bl.freq_json
    FROM book_lexicon bl
    JOIN books b ON b.book_id = bl.book_id
   WHERE bl.book_id != ?
     AND bl.freq_json IS NOT NULL
     AND b.owner_email IS NOT NULL
     AND b.owner_email = (SELECT owner_email FROM books WHERE book_id = ?)
`);
function loadReferenceCorpus(bookId) {
  const rows = _stmtRefRows.all(bookId, bookId);
  if (!rows.length) return null;
  const freq = new Map();
  let total = 0;
  let floor = 0;
  for (const r of rows) {
    total += r.tokens || 0;
    let obj;
    try { obj = JSON.parse(r.freq_json); } catch { continue; }
    let bookMin = Infinity;
    for (const [term, count] of Object.entries(obj || {})) {
      freq.set(term, (freq.get(term) || 0) + count);
      if (count < bookMin) bookMin = count;
    }
    if (Number.isFinite(bookMin)) floor = Math.max(floor, bookMin);
  }
  if (!total) return null;
  return { freq, total, books: rows.length, floor };
}

// Vergleichswerte aus den übrigen Büchern desselben Besitzers (Median je Kennzahl).
// Warum: eine nackte Zahl wie „MTLD 78" sagt niemandem etwas — erst „78, dein
// Median ist 71" ist eine Aussage. Median statt Mittelwert, weil ein einzelnes
// kurzes Buch mit Ausreisserwerten den Mittelwert kippt.
//
// Nur Bücher mit MTLD-Wert zählen für den MTLD-Median usw. — sonst würde ein zu
// kurzes Buch (dort ist der Wert bewusst NULL) als 0 in den Vergleich eingehen.
const _stmtPeerRows = db.prepare(`
  SELECT bl.mattr, bl.mattr_window, bl.mtld, bl.hapax_ratio, bl.yule_k,
         bl.heaps_beta, bl.lex_density
    FROM book_lexicon bl
    JOIN books b ON b.book_id = bl.book_id
   WHERE bl.book_id != ?
     AND b.owner_email IS NOT NULL
     AND b.owner_email = (SELECT owner_email FROM books WHERE book_id = ?)
`);
const PEER_KEYS = ['mattr', 'mtld', 'hapax_ratio', 'yule_k', 'heaps_beta', 'lex_density'];
function _median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function loadPeerStats(bookId) {
  const rows = _stmtPeerRows.all(bookId, bookId);
  if (!rows.length) return null;
  const out = { books: rows.length };
  for (const key of PEER_KEYS) {
    // MATTR nur aus Büchern, die lang genug für ein echtes Fenster waren —
    // ein Kurzbuch liefert dort die einfache TTR und ist nicht vergleichbar.
    const vals = rows
      .filter(r => (key !== 'mattr' || (r.mattr_window || 0) >= 1000))
      .map(r => r[key])
      .filter(v => typeof v === 'number' && Number.isFinite(v));
    out[key] = _median(vals);
  }
  return out;
}

// Alle Bücher mit mindestens einer Seite — Scope des Nacht-Crons. Bücher ohne
// Seiten würden nur eine Nullzeile erzeugen.
const _stmtScanScopes = db.prepare(`
  SELECT b.book_id
    FROM books b
   WHERE EXISTS (SELECT 1 FROM pages p WHERE p.book_id = b.book_id)
   ORDER BY b.book_id
`);
function listScanScopes() {
  return _stmtScanScopes.all().map(r => r.book_id);
}

module.exports = {
  replaceBookLexicon, getBookLexicon, listLexiconTerms, listLexiconHapax, listLexiconNgrams,
  getLexiconSignature, loadReferenceCorpus, loadPeerStats, listScanScopes,
};
