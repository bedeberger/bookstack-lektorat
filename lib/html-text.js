'use strict';

// HTML→Plain-Text Normalisierung fuer page_stats / search / page_revisions.
// SSoT fuer Server-Pfade; Frontend-Pendant in public/js/html-text.js MUSS
// dieselbe Logik tragen (siehe CLAUDE.md „HTML→Text-Normalisierung fuer Stats:
// Frontend MUSS Server matchen").
//
// Reihenfolge: Tags zu Single-Space → HTML-Entities dekodieren → \s+ collapsen
// → trim. Entity-Decode ist Pflicht, sonst zaehlt z.B. `&#160;` (trailing NBSP
// aus Editor-Cursor-Anker) als 6 Zeichen rein, waehrend DOMParser-basierte
// Konsumenten (Revision-Diff) 1 NBSP → kollabiertes Whitespace sehen → Stats
// driften gegen sichtbaren Text.

const _NAMED = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
});

function _decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, code) => {
    if (code[0] === '#') {
      const isHex = code[1] === 'x' || code[1] === 'X';
      const n = isHex ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      if (!Number.isFinite(n) || n < 0 || n > 0x10FFFF) return m;
      try { return String.fromCodePoint(n); } catch { return m; }
    }
    const named = _NAMED[code];
    return named !== undefined ? named : m;
  });
}

// Diagramm-Bloecke fallen VOR dem Tag-Strip komplett raus. Ihr Inhalt ist
// Quelltext einer Diagrammsprache, kein Prosatext: `flowchart TD` und
// `A[Ausgangslage] --> B` wuerden sonst als Woerter zaehlen, in die Satzlaengen
// der Stil-Metriken eingehen, im Wortschatz als Lieblingswoerter auftauchen und
// im Volltextindex Treffer erzeugen. Die Aussage des Diagramms steht im Bild,
// nicht in seiner Notation.
//
// Regex statt DOM-Parse, weil dieses Modul bewusst parserfrei ist (es laeuft im
// Browser wie im Server, ohne linkedom). Selektor-Aequivalent zu
// public/js/diagram/mermaid-html.js#DIAGRAM_SEL, gegated durch
// tests/unit/mermaid-drift.test.mjs.
const _DIAGRAM_BLOCK_RE = /<pre\b[^>]*\bclass\s*=\s*("[^"]*\bmermaid\b[^"]*"|'[^']*\bmermaid\b[^']*')[^>]*>[\s\S]*?<\/pre>/gi;

/** Diagramm-Bloecke aus HTML entfernen (Block → ein Space).
 *
 *  Eigener Export, weil es einen zweiten HTML→Text-Pfad gibt, der NICHT dieser
 *  Normalisierung folgen kann: die Prompt-Variante in
 *  routes/jobs/shared/ai.js#htmlToTextForPrompt haelt Absatzgrenzen als `\n\n`
 *  (Dialogformat-Regel). Sie braucht denselben Ausschnitt, aber nicht denselben
 *  Rest — darum liegt der Ausschnitt hier als Einzelschritt und nicht nur
 *  eingebacken in htmlToPlainText. */
function stripDiagramBlocks(html) {
  return String(html || '').replace(_DIAGRAM_BLOCK_RE, ' ');
}

// Tabellen-Bloecke. ANDERS ALS DIAGRAMME sind sie NICHT generell ausgeschnitten
// — ihr Inhalt ist Text des Autors und zaehlt in `page_stats.chars/words`, steht
// im Volltextindex und im Revisions-Diff. Wer eine Tabelle schreibt, hat
// geschrieben.
//
// Ausgeschnitten wird nur fuer die Masse, die ueber SAETZE definiert sind:
//   - Wortschatz-Analyse (lib/lexicon/analyze.js): MATTR, MTLD, Yule K und die
//     Lieblingswoerter. Eine Spalte mit 40 Jahreszahlen ist kein Vokabular; sie
//     treibt die Hapax-Quote und liefert „2023" als Lieblingswort.
//   - Stil-Metriken (lib/page-index.js via routes/sync.js): Satzlaengen,
//     Satzanfaenge, Flesch/LIX. Eine Zelle ist kein Satz — „1.2 Mio" waere ein
//     Satz aus zwei Woertern ohne Verb und zieht den Rhythmus-Befund nach unten.
//
// Selektor-Aequivalent zu public/js/table/table-html.js#TABLE_SEL, gegated durch
// tests/unit/table-drift.test.mjs. Verschachtelte Tabellen gibt es nicht (der
// Markup-Vertrag erlaubt in einer Zelle nur Inline-Inhalt), darum genuegt der
// nicht-greedy Match.
const _TABLE_BLOCK_RE = /<table\b[^>]*>[\s\S]*?<\/table\s*>/gi;

/** Tabellen aus HTML entfernen (Block → ein Space). Parity-Pendant zu
 *  public/js/html-text.js#stripTableBlocks. */
function stripTableBlocks(html) {
  return String(html || '').replace(_TABLE_BLOCK_RE, ' ');
}

// Zeilen/Spalten und Kopfzeile einer Tabelle aus ihrem Markup — parserfrei, wie
// der Rest des Moduls.
function _tableShape(tableHtml) {
  const rows = tableHtml.match(/<tr\b[^>]*>[\s\S]*?<\/tr\s*>/gi) || [];
  let cols = 0;
  for (const r of rows) cols = Math.max(cols, (r.match(/<t[dh]\b/gi) || []).length);
  const headRow = rows.find(r => /<th\b/i.test(r)) || '';
  const head = (headRow.match(/<th\b[^>]*>([\s\S]*?)<\/th\s*>/gi) || [])
    .map(c => _decodeEntities(c.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return { rows: rows.length, cols, head };
}

/** Tabellen fuer den KI-Prompt zu einer Kurzform verdichten.
 *
 *  Warum nicht der Volltext: eine Datentabelle kostet Prompt-Tokens in einer
 *  Groessenordnung, zu der das Lektorat nichts zu sagen hat — es prueft Prosa,
 *  und eine Zahlenkolonne hat keinen Stil, keine Wiederholung und kein
 *  Show-vs-Tell. Warum nicht ganz weg (wie beim Diagramm): das Modell soll
 *  wissen, DASS hier eine Tabelle steht — sonst meldet es den Absatz davor als
 *  abgebrochen und den Bezug „wie die folgende Tabelle zeigt" als unbelegt.
 *
 *  Der Kopf bleibt drin: er ist die Aussage der Tabelle in einer Zeile und
 *  taugt fuer Begriffskonsistenz-Befunde. */
function summarizeTableBlocks(html, { label = 'Tabelle' } = {}) {
  return String(html || '').replace(_TABLE_BLOCK_RE, (m) => {
    const { rows, cols, head } = _tableShape(m);
    const dims = cols > 0 && rows > 0 ? `${rows}×${cols}` : '';
    const cap = (m.match(/<caption\b[^>]*>([\s\S]*?)<\/caption\s*>/i) || [])[1];
    const capText = cap ? _decodeEntities(cap.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() : '';
    const bits = [label, dims].filter(Boolean).join(' ');
    const tail = [capText, head.length ? `Kopf: ${head.join(' | ')}` : ''].filter(Boolean).join(' — ');
    return `\n\n[${tail ? `${bits}: ${tail}` : bits}]\n\n`;
  });
}

function htmlToPlainText(html) {
  return _decodeEntities(stripDiagramBlocks(html).replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { htmlToPlainText, stripDiagramBlocks, stripTableBlocks, summarizeTableBlocks };
