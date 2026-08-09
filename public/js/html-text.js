// HTML→Plain-Text Normalisierung. Frontend-Pendant zu lib/html-text.js.
// Pflicht-Parity (CLAUDE.md „HTML→Text-Normalisierung: Frontend MUSS Server
// matchen"). Konsumenten: book/tree.js (_syncPageStatsAfterSave),
// page-revision-diff.js (Plain-Text-Fallback).

const _NAMED = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
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

/** Diagramm-Bloecke aus HTML entfernen (Block → ein Space). Parity-Pendant zu
 *  lib/html-text.js#stripDiagramBlocks; dort steht, warum das ein eigener
 *  Schritt ist. */
export function stripDiagramBlocks(html) {
  return String(html || '').replace(_DIAGRAM_BLOCK_RE, ' ');
}

// Tabellen. ANDERS ALS DIAGRAMME nicht generell ausgeschnitten — Zellinhalt ist
// Text des Autors und zaehlt in `page_stats.chars/words`. Nur die satzbasierten
// Masse (Wortschatz, Stil-Rhythmus) schneiden sie weg; das passiert
// serverseitig. Der Export steht hier fuer die Parity mit
// lib/html-text.js#stripTableBlocks — dort steht die Begruendung.
const _TABLE_BLOCK_RE = /<table\b[^>]*>[\s\S]*?<\/table\s*>/gi;

/** Tabellen aus HTML entfernen (Block → ein Space). */
export function stripTableBlocks(html) {
  return String(html || '').replace(_TABLE_BLOCK_RE, ' ');
}

export function htmlToPlainText(html) {
  return _decodeEntities(stripDiagramBlocks(html).replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}
