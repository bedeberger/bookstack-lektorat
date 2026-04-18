'use strict';
// Metrik-Berechnung pro Seite für den Agentic Buch-Chat:
// Pronomen-Counts (narrativ vs. Dialog getrennt), Dialoganteil, Satzzahl,
// Figuren-Erwähnungen. Schreibt in page_stats + page_figure_mentions.

const crypto = require('crypto');
const { db } = require('../db/schema');

// Änderung dieser Zahl erzwingt Neuberechnung aller Seiten beim nächsten Sync
// (bei Algorithmus-Änderungen: Regex-Grenzen, neue Pronomen-Liste etc.).
const METRICS_VERSION = 1;

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
  return {
    pronoun_counts: JSON.stringify(pronoun_counts),
    dialog_chars,
    sentences,
    content_sig: computeContentSig(text),
    metrics_version: METRICS_VERSION,
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
         metrics_version = @metrics_version
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
  computeFigureMentions,
  writePageIndex,
  writeFigureMentions,
  writeFigureMentionsForPageAllUsers,
  recomputeBookFigureMentions,
};
