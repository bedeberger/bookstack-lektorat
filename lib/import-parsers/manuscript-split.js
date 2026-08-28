'use strict';

// Manuskript-Split: zerlegt EIN importiertes Dokument (Word/ODT/…) anhand
// seiner Ueberschriften-Ebenen in Kapitel, Unterkapitel und Seiten.
//
// Reine Funktion ohne DB/IO — der Job (routes/jobs/manuscript-import.js) legt
// den zurueckgelieferten Baum ueber die Content-Store-Facade an, die Vorschau
// rendert denselben Baum ohne zu schreiben. Genau darum liegt die Logik hier
// und nicht im Job: Vorschau und Import muessen dasselbe Ergebnis liefern.
//
// Zuordnung: pro Ueberschriften-Ebene (h1..h6) eine Rolle.
//   chapter        → Kapitel (Ebene 1)
//   subchapter     → Unterkapitel (Ebene 2)
//   subsubchapter  → Unter-Unterkapitel (Ebene 3, tiefste erlaubte)
//   page           → neue Seite im aktuellen Kapitel
//   content        → keine Struktur, bleibt als Ueberschrift im Seitentext
//
// Die drei Kapitel-Rollen decken MAX_CHAPTER_DEPTH = 3 ab (siehe
// docs/chapter-hierarchy.md). Eine Rolle, deren Elternebene im Dokument fehlt
// (h2=subchapter ohne vorangehendes h1), wird auf die naechstmoegliche Tiefe
// hochgezogen statt verworfen — Warnung `DEPTH_CLAMPED`.

const { parseHTML } = require('linkedom');

const HEADING_LEVELS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
const HEADING_ROLES = ['chapter', 'subchapter', 'subsubchapter', 'page', 'content'];
const CHAPTER_DEPTH = { chapter: 1, subchapter: 2, subsubchapter: 3 };

// Word-Standardfall: h1 = Kapitel, h2 = Seite, alles Tiefere bleibt Fliesstext.
const DEFAULT_HEADING_MAP = Object.freeze({
  h1: 'chapter', h2: 'page', h3: 'content', h4: 'content', h5: 'content', h6: 'content',
});

// Reissleine gegen entartete Dokumente (jede Zeile eine Ueberschrift).
const MAX_NODES = 5000;

function normalizeHeadingMap(src) {
  const out = {};
  for (const lvl of HEADING_LEVELS) {
    const raw = src && typeof src === 'object' ? String(src[lvl] || '').trim() : '';
    out[lvl] = HEADING_ROLES.includes(raw) ? raw : DEFAULT_HEADING_MAP[lvl];
  }
  return out;
}

// Kompakte Serialisierung fuer Query-Param + Job-Result: "chapter,page,content,…"
function serializeHeadingMap(map) {
  const m = normalizeHeadingMap(map);
  return HEADING_LEVELS.map(l => m[l]).join(',');
}

function parseHeadingMap(str) {
  const parts = String(str || '').split(',').map(s => s.trim());
  const out = {};
  HEADING_LEVELS.forEach((lvl, i) => { out[lvl] = parts[i]; });
  return normalizeHeadingMap(out);
}

function _cleanName(text, max = 160) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function _isBlank(html) {
  return !String(html || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim();
}

/**
 * @param {string} html            HTML aus dem Import-Parser (mammoth/odt/…)
 * @param {object} [opts]
 * @param {object} [opts.headingMap]      { h1: 'chapter', … }
 * @param {boolean} [opts.keepHeadings]   Ueberschrift zusaetzlich im Seitentext lassen
 * @param {string} [opts.untitledPage]    Name fuer Seiten ohne eigene Ueberschrift
 * @param {string} [opts.untitledChapter] Name fuer Kapitel ohne Ueberschriftstext
 * @returns {{ nodes: Array, headingMap: object, chapterCount: number,
 *             pageCount: number, headingCounts: object, warnings: Array }}
 */
function splitManuscript(html, opts = {}) {
  const headingMap = normalizeHeadingMap(opts.headingMap);
  const keepHeadings = opts.keepHeadings === true;
  const untitledPage = _cleanName(opts.untitledPage) || 'Seite';
  const untitledChapter = _cleanName(opts.untitledChapter) || 'Kapitel';

  const warnings = [];
  const headingCounts = { h1: 0, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 };
  const nodes = [];
  const chapterStack = [];
  let pendingPrefix = [];   // Kapitel-Ueberschriften, die auf ihre Seite warten
  let currentPage = null;
  let chapterCount = 0;
  let pageCount = 0;
  let nodeBudgetHit = false;

  const container = () => (chapterStack.length ? chapterStack[chapterStack.length - 1].children : nodes);
  const budgetLeft = () => (chapterCount + pageCount) < MAX_NODES;

  function flushPage() {
    if (!currentPage) return;
    const body = currentPage.parts.join('\n');
    if (!currentPage.explicit && _isBlank(body)) { currentPage = null; return; }
    currentPage.target.push({ type: 'page', name: currentPage.name, html: body });
    pageCount += 1;
    currentPage = null;
  }

  function openPage(name, explicit) {
    flushPage();
    if (!budgetLeft()) { nodeBudgetHit = true; return; }
    currentPage = {
      name: name || `${untitledPage} ${pageCount + 1}`,
      parts: pendingPrefix,
      explicit,
      target: container(),
    };
    pendingPrefix = [];
  }

  function openChapter(depth, name, headingHtml) {
    flushPage();
    if (!budgetLeft()) { nodeBudgetHit = true; return; }
    const parentDepth = Math.min(depth - 1, chapterStack.length);
    if (parentDepth < depth - 1) warnings.push({ code: 'DEPTH_CLAMPED', name, wanted: depth, used: parentDepth + 1 });
    chapterStack.length = parentDepth;
    const node = { type: 'chapter', name: name || `${untitledChapter} ${chapterCount + 1}`, children: [] };
    container().push(node);
    chapterStack.push(node);
    chapterCount += 1;
    // Offene Kapitel-Ueberschrift wandert in die naechste Seite dieses Kapitels,
    // damit keine Seite entsteht, die nur aus der Ueberschrift besteht.
    if (keepHeadings && headingHtml) pendingPrefix.push(headingHtml);
  }

  function appendContent(fragment) {
    if (_isBlank(fragment)) {
      if (currentPage) currentPage.parts.push(fragment);
      return;
    }
    if (!currentPage) {
      const chapterName = chapterStack.length ? chapterStack[chapterStack.length - 1].name : '';
      openPage(chapterName || `${untitledPage} ${pageCount + 1}`, false);
      if (!currentPage) return; // Budget erschoepft
    }
    currentPage.parts.push(fragment);
  }

  const { document } = parseHTML(`<!doctype html><html><body>${html || ''}</body></html>`);
  for (const child of Array.from(document.body.childNodes)) {
    if (nodeBudgetHit) break;
    if (child.nodeType === 3) {
      const text = child.textContent || '';
      if (text.trim()) appendContent(`<p>${text.trim()}</p>`);
      continue;
    }
    if (child.nodeType !== 1) continue;
    const tag = String(child.tagName || '').toLowerCase();
    const outer = child.outerHTML || '';
    if (!HEADING_LEVELS.includes(tag)) { appendContent(outer); continue; }

    headingCounts[tag] += 1;
    const role = headingMap[tag];
    if (role === 'content') { appendContent(outer); continue; }
    const name = _cleanName(child.textContent);
    if (role === 'page') { openPage(name, true); if (keepHeadings) currentPage?.parts.push(outer); continue; }
    openChapter(CHAPTER_DEPTH[role], name, outer);
  }

  // Kapitel-Ueberschrift ohne nachfolgenden Inhalt: eigene Seite, damit der
  // Text nicht verschwindet.
  if (pendingPrefix.length && !_isBlank(pendingPrefix.join(''))) {
    const chapterName = chapterStack.length ? chapterStack[chapterStack.length - 1].name : untitledPage;
    openPage(chapterName, true);
  }
  flushPage();

  if (nodeBudgetHit) warnings.push({ code: 'TOO_MANY_NODES', limit: MAX_NODES });
  if (!nodes.length) warnings.push({ code: 'EMPTY_DOCUMENT' });

  return { nodes, headingMap, chapterCount, pageCount, headingCounts, warnings };
}

// Zaehlt nur die Ueberschriften-Ebenen — fuer die Vorschau-Zeile "im Dokument
// gefunden: 12x H1, 340x H2", damit der User seine Zuordnung an der Realitaet
// des Dokuments ausrichten kann statt zu raten.
function countHeadings(html) {
  const counts = { h1: 0, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 };
  const { document } = parseHTML(`<!doctype html><html><body>${html || ''}</body></html>`);
  for (const lvl of HEADING_LEVELS) {
    counts[lvl] = document.getElementsByTagName(lvl).length;
  }
  return counts;
}

module.exports = {
  splitManuscript,
  countHeadings,
  normalizeHeadingMap,
  serializeHeadingMap,
  parseHeadingMap,
  HEADING_LEVELS,
  HEADING_ROLES,
  DEFAULT_HEADING_MAP,
  MAX_NODES,
};
