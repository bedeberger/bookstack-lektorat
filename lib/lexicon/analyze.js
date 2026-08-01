'use strict';
// Orchestrator der Wortschatz-Analyse: nimmt die Seiten eines Buchs in Lese-
// richtung, liefert alle Kennzahlen + Ranglisten. Ohne DB und ohne Netz — die
// Persistenz liegt in db/lexicon.js, das Einreihen in routes/jobs/lexicon-scan.js.
//
// Warum die Seiten und nicht `page_stats`: MATTR, MTLD und Heaps sind Fenster- bzw.
// Präfix-Masse über die TOKEN-SEQUENZ. Sie lassen sich nicht aus Pro-Seiten-Zahlen
// aufsummieren — ein Fenster von 1000 Token liegt regelmässig quer über eine
// Seitengrenze. Darum ein buchweiter Pass in Leserichtung (book_order), nicht ein
// Aggregat über bestehende Seitenwerte.

const { htmlToPlainText } = require('../html-text');
const { STOPWORDS_DE_BASE } = require('../stopwords-de');
const { tokenize, tokenizeSegments, frequencies, foldSharpS } = require('./tokenize');
const measures = require('./measures');
const ngrams = require('./ngrams');
const { keynessFor } = require('./keyness');

// Erhöhen, wenn sich Tokenisierung, Masse oder Auswahlregeln ändern — der Scan
// rechnet dann trotz unverändertem Text neu. Wird mit ins `content_sig` gehasht
// und im Lesepfad an das Frontend mitgeliefert (das Frontend hält KEINE Kopie
// dieser Zahl — genau daran driftet die Stil-Heatmap gegen page-index.js).
const LEXICON_VERSION = 2;

// Blockgrenzen aus dem Seiten-HTML. Nötig, weil eine Überschrift ohne Satzzeichen
// endet: ohne diesen Schritt klebt sie am folgenden Absatz und erzeugt eine
// Phantom-Wendung über die Grenze hinweg.
const BLOCK_END_RE = /<\/(?:p|h[1-6]|li|blockquote|pre|div|figcaption|td|th|tr|dd|dt)>|<br\s*\/?>|<hr\s*\/?>/gi;

// Mindestlänge eines Terms in der Lieblingswort-Liste. Gleiche Schwelle wie die
// Wiederholungs-Metrik in lib/page-index.js: kürzere Wörter sind im Deutschen fast
// ausschliesslich Funktionswörter, und die stehen ohnehin in der Stoppwortliste.
const MIN_TERM_LEN = 4;
// Ein Wort, das zweimal im ganzen Buch steht, ist kein Lieblingswort.
const MIN_TERM_COUNT = 3;
const TERM_LIMIT = 200;
// Zusätzliche Plätze, die NICHT über die Häufigkeit vergeben werden, sondern über
// die Auffälligkeit gegen die übrigen Bücher desselben Autors. Ohne sie verfehlt
// die Liste genau die Wörter, die dieses Buch von den anderen unterscheiden: ein
// Wort, das hier zwölfmal steht und sonst nie, kommt über die Häufigkeit nie in
// die Top 200 — es ist ja nicht häufig, sondern eigen.
const KEY_TERM_LIMIT = 100;
// Einmalwörter (Hapax legomena). Der Deckel ist nötig, weil rund die Hälfte aller
// Types eines Buchs genau einmal vorkommt — das sind Zehntausende Zeilen und kein
// Befund. Welche 300 gezeigt werden, entscheidet `_selectHapax`.
const HAPAX_LIMIT = 300;
const NGRAM_LIMIT_PER_N = 60;

const STOPWORDS = new Set(STOPWORDS_DE_BASE.map(w => foldSharpS(w.toLowerCase())));

function blockTextsFromHtml(html) {
  const out = [];
  for (const part of String(html == null ? '' : html).replace(BLOCK_END_RE, '\n').split('\n')) {
    const t = htmlToPlainText(part);
    if (t) out.push(t);
  }
  return out;
}

// Ein Token zählt als Inhaltswort (für die lexikalische Dichte), wenn es kein
// Funktionswort ist. Absichtlich OHNE Längenschwelle und ohne Namensfilter: für
// die Dichte ist ein Eigenname ein Inhaltswort.
function _isContentWord(t) {
  return !STOPWORDS.has(t);
}

// Kandidat für die Lieblingswort-Liste: Inhaltswort, lang genug, kein Eigenname.
// Eigennamen fliegen raus, weil die Figur, die auf jeder Seite vorkommt, sonst jede
// Rangliste anführt — sie ist kein Stilbefund. Gleiche Begründung wie
// `extraStopwords` in routes/sync.js.
function _isTermCandidate(t, nameStopwords) {
  if (t.length < MIN_TERM_LEN) return false;
  if (STOPWORDS.has(t)) return false;
  if (nameStopwords && nameStopwords.has(t)) return false;
  return true;
}

// Auswahl unter den Einmalwörtern. Alle haben dieselbe Häufigkeit (1), die
// Rangfolge muss also von etwas anderem kommen — und sie muss deterministisch
// sein, sonst zeigt derselbe Text nach jedem Scan eine andere Liste.
//
// Erstes Kriterium: das Wort kommt in den übrigen Büchern desselben Autors nicht
// vor. „Einmal hier UND sonst nie" ist die eigentliche Frage; ein Wort, das der
// Autor anderswo regelmässig benutzt, ist hier nur zufällig selten. Die Referenz
// ist gedeckelt, kennt also nur die häufigeren Wörter der anderen Bücher — genau
// die will man aussortieren, für das Kriterium reicht das.
// Zweites Kriterium: Länge. Im Deutschen sind das die Zusammensetzungen und
// Eigenprägungen, also die Wörter, wegen denen man diese Liste öffnet.
function _selectHapax(candidates, reference, limit = HAPAX_LIMIT) {
  const refFreq = reference ? reference.freq : null;
  const rows = candidates.map(term => ({
    term,
    novel: refFreq && refFreq.has(term) ? 0 : 1,
  }));
  rows.sort((a, b) => b.novel - a.novel
    || b.term.length - a.term.length
    || a.term.localeCompare(b.term));
  return rows.slice(0, limit).map(r => r.term);
}

async function _noYield() {}

// pages: [{ page_id, chapter_id, html }] in Leserichtung.
// nameStopwords: Set<string> (gefaltet/lowercased) — Figuren-, Orts-, Szenennamen.
// reference: { freq: Map<term,count>, total: number, floor?: number } | null —
//            Referenzkorpus für die Keyness (Phase 1: die übrigen Bücher desselben
//            Autors). `floor` ist die Kappungsgrenze der gespeicherten Frequenz-
//            tabellen: ein dort fehlender Term kommt in der Referenz höchstens so
//            oft vor. Wird nur für die Auswahl gebraucht, nicht für die Anzeige.
// onYield: optionaler async Hook, um zwischen den Phasen an den Event-Loop
//          zurückzugeben (der Nacht-Cron läuft im selben Prozess wie die App).
async function analyzeBook(pages, opts = {}) {
  const nameStopwords = opts.nameStopwords || null;
  const reference = opts.reference || null;
  const onYield = opts.onYield || _noYield;

  // --- Phase 1: Segmentierung + Token-Sequenz ----------------------------------
  const segments = [];   // Token-Gruppen (Satz/Block) in Leserichtung
  const segPage = [];    // parallel: page_id des Segments
  const segChapter = []; // parallel: chapter_id (oder null)
  const tokens = [];
  let pageCount = 0;

  for (const p of pages || []) {
    for (const blockText of blockTextsFromHtml(p.html)) {
      for (const seg of tokenizeSegments(blockText)) {
        segments.push(seg);
        segPage.push(p.page_id);
        segChapter.push(p.chapter_id == null ? null : p.chapter_id);
        for (const t of seg) tokens.push(t);
      }
    }
    pageCount++;
    if (pageCount % 25 === 0) await onYield();
  }

  const freq = frequencies(tokens);
  const tokenCount = tokens.length;

  // --- Phase 2: Kennzahlen ------------------------------------------------------
  await onYield();
  const hx = measures.hapaxStats(freq);
  const mattrRes = measures.mattr(tokens);
  const heapsRes = measures.heaps(tokens);
  const stats = {
    version: LEXICON_VERSION,
    pages: pageCount,
    segments: segments.length,
    tokens: tokenCount,
    types: hx.types,
    hapax: hx.hapax,
    dislegomena: hx.dislegomena,
    hapax_ratio: hx.hapax_ratio,
    mattr: mattrRes.value,
    mattr_window: mattrRes.window,
    mattr_windows: mattrRes.windows,
    mtld: measures.mtld(tokens),
    yule_k: measures.yuleK(freq, tokenCount),
    heaps_beta: heapsRes.beta,
    heaps_k: heapsRes.k,
    lex_density: measures.lexicalDensity(tokens, _isContentWord),
  };

  // --- Phase 3: Wortlisten (Häufigkeit, Auffälligkeit, Einmalwörter) ------------
  // Drei Sorten Zeile, eine Tabelle — `kind` trennt sie:
  //   'freq'  Lieblingswörter, ausgewählt über die Häufigkeit
  //   'key'   auffällige Wörter, ausgewählt über die Keyness gegen die anderen Bücher
  //   'hapax' Einmalwörter (genau ein Vorkommen im ganzen Buch)
  await onYield();
  const candidates = [];
  const hapaxCandidates = [];
  for (const [term, count] of freq) {
    if (!_isTermCandidate(term, nameStopwords)) continue;
    if (count === 1) { hapaxCandidates.push(term); continue; }
    if (count < MIN_TERM_COUNT) continue;
    candidates.push({ term, count });
  }
  candidates.sort((a, b) => b.count - a.count || a.term.localeCompare(b.term));

  const picked = candidates.slice(0, TERM_LIMIT).map(r => ({ ...r, kind: 'freq' }));
  const taken = new Set(picked.map(r => r.term));

  // Zweite Auswahlachse: Auffälligkeit. Gemessen wird hier mit der VORSICHTIGEN
  // Keyness (`refFloor`) — die Referenztabelle ist gedeckelt, und ohne diese
  // Schranke stünden bevorzugt Wörter in der Liste, deren hoher Wert allein daher
  // rührt, dass die Referenz sie nicht kennt. Angezeigt wird weiter unten
  // trotzdem der schlichte Wert; das Vorsichtsmass entscheidet nur, wer reinkommt.
  if (reference) {
    const gate = keynessFor(
      candidates.map(r => r.term), freq, reference.freq, tokenCount, reference.total,
      { refFloor: reference.floor || 0 },
    );
    const keyPicks = candidates
      .filter(r => !taken.has(r.term) && (gate.get(r.term) || 0) > 0)
      .sort((a, b) => gate.get(b.term) - gate.get(a.term)
        || b.count - a.count
        || a.term.localeCompare(b.term))
      .slice(0, KEY_TERM_LIMIT);
    for (const r of keyPicks) { picked.push({ ...r, kind: 'key' }); taken.add(r.term); }
  }

  // Wie viele Einmalwörter es INSGESAMT gibt (nach denselben Filtern wie die
  // Liste), damit die Karte den Deckel offenlegen kann. `stats.hapax` ist eine
  // andere Zahl: dort zählen Stoppwörter, Eigennamen und kurze Wörter mit.
  stats.hapax_listed = hapaxCandidates.length;
  const terms = picked.concat(
    _selectHapax(hapaxCandidates, reference).map(term => ({ term, count: 1, kind: 'hapax' })),
  );

  // Streuung + erste Fundstelle in einem Durchlauf über die Segmente.
  const wantedTerms = new Map(terms.map(t => [t.term, t]));
  const termChapters = new Map();
  for (const t of terms) termChapters.set(t.term, new Set());
  for (let si = 0; si < segments.length; si++) {
    for (const tok of segments[si]) {
      const row = wantedTerms.get(tok);
      if (!row) continue;
      if (row.first_page_id == null) row.first_page_id = segPage[si];
      termChapters.get(tok).add(segChapter[si]);
    }
  }
  for (const t of terms) {
    t.chapter_spread = termChapters.get(t.term).size;
    if (t.first_page_id === undefined) t.first_page_id = null;
  }

  // Angezeigte Keyness: schlichte Variante ohne `refFloor`. Einmalwörter bekommen
  // dabei von selbst `null` — bei einem einzigen Vorkommen schlägt Log-Likelihood
  // schon bei Zufallsschwankungen an, darum die Mindesthäufigkeit in keyness.js.
  const keyMap = reference
    ? keynessFor(terms.map(t => t.term), freq, reference.freq, tokenCount, reference.total)
    : null;
  for (const t of terms) t.keyness = keyMap ? (keyMap.get(t.term) ?? null) : null;

  // --- Phase 4: Wendungen -------------------------------------------------------
  await onYield();
  const counted = ngrams.countNgrams(segments, { maxN: ngrams.DEFAULT_MAX_N });
  await onYield();
  const selected = ngrams.selectTop(counted, { limitPerN: NGRAM_LIMIT_PER_N });
  const hits = ngrams.locate(segments, selected.map(r => r.phrase), { maxN: ngrams.DEFAULT_MAX_N });
  const phrases = selected.map(r => {
    const segIdx = hits.get(r.phrase) || [];
    const chapters = new Set();
    for (const si of segIdx) chapters.add(segChapter[si]);
    return {
      phrase: r.phrase,
      n: r.n,
      count: r.count,
      log_dice: r.log_dice,
      chapter_spread: chapters.size,
      first_page_id: segIdx.length ? segPage[segIdx[0]] : null,
    };
  });
  phrases.sort((a, b) => b.count - a.count || a.n - b.n || a.phrase.localeCompare(b.phrase));

  return { stats, terms, phrases, freq };
}

module.exports = {
  LEXICON_VERSION, MIN_TERM_LEN, MIN_TERM_COUNT, TERM_LIMIT, KEY_TERM_LIMIT,
  HAPAX_LIMIT, NGRAM_LIMIT_PER_N,
  BLOCK_END_RE, blockTextsFromHtml, analyzeBook,
  _isContentWord, _isTermCandidate, _selectHapax,
};
