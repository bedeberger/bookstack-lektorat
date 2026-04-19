'use strict';
// Metrik-Berechnung pro Seite für den Agentic Buch-Chat:
// Pronomen-Counts (narrativ vs. Dialog getrennt), Dialoganteil, Satzzahl,
// Figuren-Erwähnungen. Schreibt in page_stats + page_figure_mentions.

const crypto = require('crypto');
const { db } = require('../db/schema');

// Änderung dieser Zahl erzwingt Neuberechnung aller Seiten beim nächsten Sync
// (bei Algorithmus-Änderungen: Regex-Grenzen, neue Pronomen-Liste etc.).
// v2: Stil-Heatmap + Lesbarkeit (Füllwörter, Passiv, Adverbien, LIX, Flesch, Wiederholungen).
const METRICS_VERSION = 2;

// Pronomen-Gruppen: jede Gruppe ist eine Liste regulärer Wortformen.
// Der Index speichert pro Schlüssel (Gruppe) getrennt `narr` und `dlg`.
const PRONOUN_GROUPS = {
  ich:     ['ich', 'mich', 'mir', 'mein', 'meine', 'meiner', 'meines', 'meinem', 'meinen'],
  du:      ['du', 'dich', 'dir', 'dein', 'deine', 'deiner', 'deines', 'deinem', 'deinen'],
  er:      ['er', 'ihn', 'ihm', 'sein', 'seine', 'seiner', 'seines', 'seinem', 'seinen'],
  sie_sg:  ['sie', 'ihr', 'ihre', 'ihrer', 'ihres', 'ihrem', 'ihren'],
  wir:     ['wir', 'uns', 'unser', 'unsere', 'unserer', 'unseres', 'unserem', 'unseren'],
  ihr_pl:  ['ihr', 'euch', 'euer', 'eure', 'eurer', 'eures', 'eurem', 'euren'],
  man:     ['man'],
};

// Flache Liste aller Wortformen → Gruppe, zur schnellen Zuordnung beim Scan.
const _WORD_TO_GROUP = (() => {
  const m = new Map();
  for (const [grp, words] of Object.entries(PRONOUN_GROUPS)) {
    for (const w of words) {
      // sie/ihr sind mehrdeutig (sie_sg/sie_pl, ihr_sg/ihr_pl). Wir klassifizieren
      // sie bewusst als `sie_sg` bzw. `ihr_pl` — Disambiguierung pro Kontext wäre
      // unzuverlässig. Die Fragen „Ich-Erzähler", „Du-Erzähler" sind robust,
      // Er-/Sie-Fragen muss der Agent mit dem Hinweis auf diese Mehrdeutigkeit beantworten.
      if (!m.has(w)) m.set(w, grp);
    }
  }
  return m;
})();

// Regex: ein Wort (mit Umlauten). \b in JS-Regex kennt keine Umlaute,
// deshalb explizite Grenz-Klasse via Lookahead/Lookbehind.
const _WORD_RE = /(?<![A-Za-zÄÖÜäöüß])([A-Za-zÄÖÜäöüß]+)(?![A-Za-zÄÖÜäöüß])/g;

// Dialog-Marker: Paare (öffnend, schliessend). Max 500 Zeichen pro Dialog-Block
// gegen Catastrophic Backtracking und unbalancierte Paare (Textende im Dialog).
// Die Reihenfolge ist wichtig: «…» (CH), „…" (DE), "…" (generisch).
const DIALOG_PATTERNS = [
  /«([^»]{1,500})»/g,
  /„([^"]{1,500})"/g,
  /"([^"]{1,500})"/g,
];

/** Liefert die Zeichen-Ranges aller Dialog-Blöcke in `text`.
 *  Nicht-überlappend (erstes Match gewinnt pro Position). */
function _findDialogRanges(text) {
  const ranges = [];
  for (const re of DIALOG_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      ranges.push([m.index, m.index + m[0].length]);
    }
  }
  // Sortieren + mergen (Overlaps): bei unterschiedlichen Marker-Typen kann es Überschneidungen geben.
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return merged;
}

function _inRange(pos, ranges) {
  // Binärsuche — ranges ist sortiert und nicht-überlappend.
  let lo = 0, hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = ranges[mid];
    if (pos < a) hi = mid - 1;
    else if (pos >= b) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Berechnet Pronomen-Counts (getrennt narr/dlg) + Dialog-Zeichen. */
function computePronounsAndDialog(text) {
  const dialogRanges = _findDialogRanges(text);
  const dialogChars = dialogRanges.reduce((s, [a, b]) => s + (b - a), 0);

  const counts = {};
  for (const grp of Object.keys(PRONOUN_GROUPS)) {
    counts[grp] = { narr: 0, dlg: 0 };
  }

  _WORD_RE.lastIndex = 0;
  let m;
  while ((m = _WORD_RE.exec(text)) !== null) {
    const word = m[1].toLowerCase();
    const grp = _WORD_TO_GROUP.get(word);
    if (!grp) continue;
    const bucket = _inRange(m.index, dialogRanges) ? 'dlg' : 'narr';
    counts[grp][bucket]++;
  }
  return { pronoun_counts: counts, dialog_chars: dialogChars };
}

/** Robuste Satzzahl (identisch zu sync.js:computeStats, hier für Wiederverwendung). */
function countSentences(text) {
  if (!text || !text.trim()) return 0;
  return text.split(/[.!?]+/).filter(s => s.trim().length > 0).length;
}

// ── Stil-Statistiken (deterministisch, kein KI-Call) ──────────────────────────

// Kuratierte Füllwörter-Liste DE. Heuristisch: viele sind im Dialog legitim,
// im erzählenden Text aber oft tilgbar. Die Metrik zählt Vorkommen absolut;
// UI zeigt Dichte pro 1000 Wörter und macht sie vergleichbar (nicht absolut «schlecht»).
const FILLER_WORDS_DE = new Set([
  'eigentlich', 'halt', 'einfach', 'irgendwie', 'irgendwo', 'irgendwas', 'irgendwer',
  'quasi', 'sozusagen', 'praktisch', 'buchstäblich', 'regelrecht', 'schlichtweg',
  'gewissermaßen', 'gewissermassen', 'schließlich', 'schliesslich', 'letztendlich',
  'wirklich', 'sehr', 'total', 'ganz', 'ziemlich', 'eher', 'wohl', 'etwa',
  'vielleicht', 'bestimmt', 'natürlich', 'offensichtlich', 'offenbar', 'eventuell',
  'tatsächlich', 'durchaus', 'ohnehin', 'sowieso', 'anscheinend', 'vermutlich',
]);

// Häufige Stoppwörter DE – werden bei Wiederholungs-Analyse ignoriert.
const STOPWORDS_DE = new Set([
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einer', 'einen', 'einem', 'eines',
  'und', 'oder', 'aber', 'sondern', 'denn', 'doch', 'weil', 'dass', 'daß', 'wenn', 'als', 'ob',
  'ich', 'du', 'er', 'sie', 'es', 'wir', 'ihr', 'mich', 'dich', 'ihn', 'uns', 'euch', 'ihm',
  'ihr', 'mir', 'dir', 'mein', 'dein', 'sein', 'ihre', 'ihr', 'unser', 'euer',
  'in', 'im', 'an', 'am', 'auf', 'zu', 'zum', 'zur', 'bei', 'mit', 'nach', 'von', 'vom',
  'aus', 'über', 'unter', 'vor', 'hinter', 'neben', 'zwischen', 'durch', 'für', 'gegen', 'um',
  'ist', 'sind', 'war', 'waren', 'bin', 'bist', 'seid', 'sein', 'gewesen', 'hat', 'habe', 'hast',
  'hatten', 'hatte', 'haben', 'werden', 'wird', 'wurde', 'wurden', 'worden', 'wirst',
  'nicht', 'kein', 'keine', 'keiner', 'keinen', 'nichts', 'auch', 'noch', 'nur', 'schon',
  'so', 'wie', 'was', 'wer', 'wo', 'warum', 'weshalb', 'wann', 'woher', 'wohin',
  'dann', 'dort', 'hier', 'da', 'nun', 'jetzt', 'immer', 'nie', 'oft', 'manchmal',
  'ja', 'nein', 'mal', 'halt', 'eben', 'schon', 'zwar',
]);

// Adverbien – häufige feste Formen + Suffix-Heuristik in _isAdverbDe.
const ADVERB_WORDS_DE = new Set([
  'sehr', 'gern', 'gerne', 'oft', 'manchmal', 'immer', 'nie', 'niemals', 'selten',
  'hier', 'dort', 'dorthin', 'dahin', 'da', 'drüben', 'drinnen', 'draussen', 'draußen',
  'heute', 'gestern', 'morgen', 'jetzt', 'bald', 'gleich', 'soeben', 'damals', 'einst',
  'wirklich', 'tatsächlich', 'kaum', 'fast', 'beinahe', 'ungefähr', 'etwa',
  'plötzlich', 'langsam', 'schnell', 'sofort', 'allmählich', 'nachher', 'vorher',
  'ziemlich', 'durchaus', 'völlig', 'gänzlich', 'nahezu', 'überwiegend', 'vorwiegend',
]);

// Deutsches Vollverb-Passiv: Form von "werden" + Partizip II.
// Heuristik: Form von "werden" (ohne Wortgrenze nach Hilfsverb-Kontext zu prüfen).
// Passiv-Form: "wurde/wurden/wird/werden/worden". "werden" als Infinitiv/Futur wird mitgezählt – bewusst,
// um die Kennzahl robust zu halten; im UI wird sie als "werden-Konstruktionen" gelabelt, nicht als harter Passiv-Anteil.
const _PASSIVE_RE = /(?<![A-Za-zÄÖÜäöüß])(wurde|wurden|wird|werden|worden|ward)(?![A-Za-zÄÖÜäöüß])/gi;

// Diphthonge (zählen als 1 Silbe). Muss vor Vokalgruppen-Reduktion geprüft werden.
const _DIPHTHONGS = /[aeiouäöüy]{2,}/g;

// Endungs-Silben die oft falsch gezählt werden — stumme -e am Wortende bei einigen Mustern.
// Pragmatisch ignoriert; Amstad-Flesch reagiert vor allem auf langer Wörter/langer Sätze.
function _countSyllables(word) {
  const w = word.toLowerCase().replace(/[^a-zäöüß]/g, '');
  if (w.length === 0) return 0;
  if (w.length <= 2) return 1;
  const groups = w.match(/[aeiouäöüy]+/g);
  return groups ? groups.length : 1;
}

function _isAdverbDe(word) {
  const w = word.toLowerCase();
  if (ADVERB_WORDS_DE.has(w)) return true;
  // Typische Adverbial-Suffixe. Mindestlänge 5 verhindert Überzählen von kurzen Wörtern.
  if (w.length < 5) return false;
  if (w.endsWith('weise')) return true;
  if (w.endsWith('erweise')) return true;
  if (w.endsWith('mals')) return true;
  if (w.endsWith('wärts')) return true;
  if (w.endsWith('halber')) return true;
  return false;
}

function _percentile(sortedNums, p) {
  if (!sortedNums.length) return 0;
  const idx = Math.min(sortedNums.length - 1, Math.floor((sortedNums.length - 1) * p));
  return sortedNums[idx];
}

/** Berechnet deterministische Stil-Statistiken für eine Seite.
 *  Metriken sind absolute Zählungen + LIX/Flesch (Lesbarkeitsindizes). */
function computeStyleStats(text) {
  if (!text || !text.trim()) {
    return {
      filler_count: 0, passive_count: 0, adverb_count: 0,
      avg_sentence_len: null, sentence_len_p90: null,
      repetition_data: JSON.stringify({ top: [], score: 0 }),
      lix: null, flesch_de: null,
    };
  }

  // Sätze aufteilen und Wörter pro Satz ermitteln (für Histogramm & avg/p90).
  const sentenceStrs = text.split(/[.!?]+/).map(s => s.trim()).filter(Boolean);
  const sentenceLens = sentenceStrs.map(s => (s.match(/[A-Za-zÄÖÜäöüß]+/g) || []).length).filter(n => n > 0);
  const sortedLens = [...sentenceLens].sort((a, b) => a - b);
  const totalWords = sentenceLens.reduce((a, b) => a + b, 0);
  const totalSentences = sentenceLens.length;
  const avgSentenceLen = totalSentences > 0 ? Math.round((totalWords / totalSentences) * 10) / 10 : null;
  const p90 = sortedLens.length ? _percentile(sortedLens, 0.9) : null;

  // Einzel-Wort-Scan: Füllwörter, Adverbien, Silbenzählung für Flesch, Wiederholungs-Fenster.
  let fillerCount = 0;
  let adverbCount = 0;
  let syllableTotal = 0;
  let longWordCount = 0;
  const lowerWords = [];

  _WORD_RE.lastIndex = 0;
  let m;
  while ((m = _WORD_RE.exec(text)) !== null) {
    const raw = m[1];
    const w = raw.toLowerCase();
    lowerWords.push(w);
    if (FILLER_WORDS_DE.has(w)) fillerCount++;
    if (_isAdverbDe(w)) adverbCount++;
    syllableTotal += _countSyllables(w);
    if (raw.length > 6) longWordCount++;
  }

  const wordCountScan = lowerWords.length;

  // Passiv-Zählung (werden-Formen).
  _PASSIVE_RE.lastIndex = 0;
  let passiveCount = 0;
  while (_PASSIVE_RE.exec(text) !== null) passiveCount++;

  // Wiederholungs-Analyse: Top-Wörter ausserhalb Stoppwort-Liste, Mindestlänge 4.
  // Score = (Summe der Counts der Top-10 Wörter) / wordCount * 1000 → Dichte pro 1000 Wörter.
  const repCounts = new Map();
  for (const w of lowerWords) {
    if (w.length < 4) continue;
    if (STOPWORDS_DE.has(w)) continue;
    repCounts.set(w, (repCounts.get(w) || 0) + 1);
  }
  const topRepetitions = [...repCounts.entries()]
    .filter(([, c]) => c >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word, count]) => ({ word, count }));
  const repScore = wordCountScan > 0
    ? Math.round((topRepetitions.reduce((s, r) => s + r.count, 0) / wordCountScan) * 1000 * 10) / 10
    : 0;

  // LIX = A/B + (C·100)/A mit A=Wörter, B=Sätze, C=lange Wörter (>6 Zeichen).
  const lix = (totalWords > 0 && totalSentences > 0)
    ? Math.round(((totalWords / totalSentences) + (longWordCount * 100) / totalWords) * 10) / 10
    : null;

  // Flesch (Amstad, deutsche Adaption): 180 - ASL - 58.5·ASW.
  // ASL = Wörter/Sätze, ASW = Silben/Wörter. Höher = leichter.
  const flesch = (wordCountScan > 0 && totalSentences > 0)
    ? Math.round((180 - (wordCountScan / totalSentences) - (58.5 * (syllableTotal / wordCountScan))) * 10) / 10
    : null;

  return {
    filler_count: fillerCount,
    passive_count: passiveCount,
    adverb_count: adverbCount,
    avg_sentence_len: avgSentenceLen,
    sentence_len_p90: p90,
    repetition_data: JSON.stringify({ top: topRepetitions, score: repScore }),
    lix,
    flesch_de: flesch,
  };
}

/** SHA1 über den reinen Textinhalt — identifiziert inhaltliche Änderungen
 *  unabhängig von BookStacks `updated_at` (das auch bei Metadaten-Updates flippt). */
function computeContentSig(text) {
  return crypto.createHash('sha1').update(text, 'utf8').digest('hex');
}

/** Berechnet den kompletten Index für eine Seite (ohne Figuren-Mentions).
 *  Liefert die UPSERT-Felder für page_stats. */
function computePageIndex(text) {
  const { pronoun_counts, dialog_chars } = computePronounsAndDialog(text);
  const sentences = countSentences(text);
  const style = computeStyleStats(text);
  return {
    pronoun_counts: JSON.stringify(pronoun_counts),
    dialog_chars,
    sentences,
    content_sig: computeContentSig(text),
    metrics_version: METRICS_VERSION,
    ...style,
  };
}

// ── Figuren-Matching ─────────────────────────────────────────────────────────

// Häufige deutsche Tokens, die als einzelner Namensbestandteil zu viele
// False-Positives erzeugen (Anrede, Adelstitel etc.) — werden beim
// Token-Level-Matching übersprungen.
const FIGURE_TOKEN_BLOCKLIST = new Set([
  'herr', 'frau', 'fräulein', 'dame', 'dr', 'prof', 'professor', 'doktor',
  'von', 'zu', 'van', 'der', 'die', 'das', 'den', 'dem',
  'mr', 'mrs', 'ms', 'lord', 'lady',
]);

function _escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Zerlegt einen Vollnamen in matching-taugliche Tokens.
 *  Vollname ist immer ein Muster (Gewicht 1.0). Einzel-Tokens ab 3 Zeichen
 *  und nicht in der Blocklist werden zusätzlich mit Gewicht 0.5 gematcht. */
function _buildNamePatterns(fullName, kurzname) {
  const patterns = [];
  const seen = new Set();
  const add = (s, weight) => {
    const t = (s || '').trim();
    if (!t || seen.has(t.toLowerCase())) return;
    seen.add(t.toLowerCase());
    patterns.push({ text: t, weight });
  };

  add(fullName, 1.0);
  add(kurzname, 1.0);
  for (const raw of [fullName, kurzname]) {
    if (!raw) continue;
    const tokens = raw.split(/\s+/);
    if (tokens.length < 2) continue;
    for (const tok of tokens) {
      if (tok.length < 3) continue;
      if (FIGURE_TOKEN_BLOCKLIST.has(tok.toLowerCase())) continue;
      add(tok, 0.5);
    }
  }
  return patterns;
}

/** Zählt Erwähnungen aller Figuren in `text`.
 *  figures: [{ id (DB-PK), name, kurzname }]
 *  Rückgabe: [{ figure_id, count, first_offset }] — nur Figuren mit count > 0. */
function computeFigureMentions(text, figures) {
  const results = [];
  for (const fig of figures) {
    const patterns = _buildNamePatterns(fig.name, fig.kurzname);
    if (!patterns.length) continue;
    let total = 0;
    let firstOffset = null;
    for (const { text: p, weight } of patterns) {
      // Lookbehind/Lookahead gegen Wortgrenzen (umlaut-sicher).
      // 'i'-Flag — Namen matchen auch bei abweichender Gross-/Kleinschreibung.
      const re = new RegExp(
        `(?<![A-Za-zÄÖÜäöüß])${_escapeRegex(p)}(?![A-Za-zÄÖÜäöüß])`,
        'gi'
      );
      let m;
      while ((m = re.exec(text)) !== null) {
        total += weight;
        if (firstOffset === null || m.index < firstOffset) firstOffset = m.index;
      }
    }
    const count = Math.round(total);
    if (count > 0) {
      results.push({ figure_id: fig.id, count, first_offset: firstOffset });
    }
  }
  return results;
}

// ── DB-Writer ─────────────────────────────────────────────────────────────────

const _upsertPageIndex = db.prepare(`
  UPDATE page_stats
     SET sentences = @sentences,
         dialog_chars = @dialog_chars,
         pronoun_counts = @pronoun_counts,
         content_sig = @content_sig,
         metrics_version = @metrics_version,
         filler_count = @filler_count,
         passive_count = @passive_count,
         adverb_count = @adverb_count,
         avg_sentence_len = @avg_sentence_len,
         sentence_len_p90 = @sentence_len_p90,
         repetition_data = @repetition_data,
         lix = @lix,
         flesch_de = @flesch_de
   WHERE page_id = @page_id
`);

/** Schreibt das Index-Resultat in page_stats. Setzt voraus, dass
 *  der page_stats-Row bereits via upsertPageStats existiert. */
function writePageIndex(pageId, index) {
  _upsertPageIndex.run({ page_id: pageId, ...index });
}

const _delMentionsForPage = db.prepare('DELETE FROM page_figure_mentions WHERE page_id = ?');
const _insMention = db.prepare(
  'INSERT INTO page_figure_mentions (page_id, figure_id, count, first_offset) VALUES (?, ?, ?, ?)'
);

/** Ersetzt alle Figuren-Mentions einer Seite (atomar). */
const writeFigureMentions = db.transaction((pageId, mentions) => {
  _delMentionsForPage.run(pageId);
  for (const m of mentions) {
    _insMention.run(pageId, m.figure_id, m.count, m.first_offset);
  }
});

/** Berechnet Figuren-Mentions für alle Seiten eines Buchs neu und schreibt sie.
 *  Wird nach Komplettanalyse (saveFigurenToDb) aufgerufen, damit die Mentions
 *  mit dem aktuellen Figuren-Bestand übereinstimmen.
 *  Liest Seitentexte aus pages.preview_text (gecacht, ~800 Zeichen) —
 *  approximativ. Der nächste syncBook-Lauf verfeinert die Mentions mit Volltext. */
function recomputeBookFigureMentions(bookId, userEmail) {
  const figures = db.prepare(
    'SELECT id, name, kurzname FROM figures WHERE book_id = ? AND user_email IS ?'
  ).all(bookId, userEmail || null);
  if (!figures.length) {
    return { figures: 0, pagesProcessed: 0 };
  }
  const pages = db.prepare(
    'SELECT page_id, preview_text FROM pages WHERE book_id = ? AND preview_text IS NOT NULL'
  ).all(bookId);
  let processed = 0;
  db.transaction(() => {
    for (const p of pages) {
      const mentions = computeFigureMentions(p.preview_text, figures);
      _delMentionsForPage.run(p.page_id);
      for (const m of mentions) _insMention.run(p.page_id, m.figure_id, m.count, m.first_offset);
      processed++;
    }
  })();
  return { figures: figures.length, pagesProcessed: processed };
}

/** Berechnet Figuren-Mentions für eine Seite über alle User, die Figuren für das Buch haben.
 *  Wird von syncBook() mit dem Volltext aufgerufen (präziser als Preview-Text).
 *  Atomic pro Seite: löscht vorhandene Mentions aller User und schreibt neu.
 *  Gibt Anzahl geschriebener Mentions zurück. */
function writeFigureMentionsForPageAllUsers(pageId, bookId, fullText) {
  const figures = db.prepare(
    'SELECT id, name, kurzname FROM figures WHERE book_id = ?'
  ).all(bookId);
  if (!figures.length) return 0;
  const mentions = computeFigureMentions(fullText, figures);
  db.transaction(() => {
    _delMentionsForPage.run(pageId);
    for (const m of mentions) _insMention.run(pageId, m.figure_id, m.count, m.first_offset);
  })();
  return mentions.length;
}

module.exports = {
  METRICS_VERSION,
  PRONOUN_GROUPS,
  computePageIndex,
  computePronounsAndDialog,
  computeContentSig,
  computeStyleStats,
  computeFigureMentions,
  writePageIndex,
  writeFigureMentions,
  writeFigureMentionsForPageAllUsers,
  recomputeBookFigureMentions,
};
