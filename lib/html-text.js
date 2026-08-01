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

function htmlToPlainText(html) {
  return _decodeEntities(stripDiagramBlocks(html).replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { htmlToPlainText, stripDiagramBlocks };
