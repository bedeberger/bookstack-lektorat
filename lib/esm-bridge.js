'use strict';
// Brücke vom CommonJS-Server zu den puren ESM-Modulen unter public/js/.
//
// Mehrere Sachlogiken sind bewusst SSoT im Browser-Bundle und werden vom Server
// mitbenutzt statt kopiert — das Quellen-Markup (sources/cite-html.js), die
// Zitierstile (sources/format.js), die Querverweise (xrefs/xref-html.js), die
// Diagramm-Notation (diagram/mermaid-html.js). Der Server lädt sie per dynamic
// `import()`; das Ergebnis ist pro Pfad genau EIN Promise, das offen liegen
// bleibt (Node cached den Modulgraphen ohnehin, aber ohne diesen Memo entsteht
// pro Aufruf eine neue Promise-Kette).
//
// Vorher stand dieses Muster in acht Modulen einzeln — jedes mit eigener
// `let _xPromise = null`-Variable und eigener Pfadauflösung. Das ist kein
// Fachwissen, sondern Mechanik, und gehört an eine Stelle.
//
// Das Gegenstück für die Prompts ist lib/prompts-loader.js: der braucht
// ZWEI isolierte Instanzen (Provider-Klassen) und darf hier NICHT mitfahren.

const path = require('path');
const { pathToFileURL } = require('url');

const REPO_ROOT = path.resolve(__dirname, '..');

const _cache = new Map();

/** Modul unter einem repo-relativen Pfad laden (memoisiert).
 *  `esm('public/js/sources/format.js')` → Promise des Modul-Namespace. */
function esm(relPath) {
  const key = String(relPath);
  let p = _cache.get(key);
  if (!p) {
    p = import(pathToFileURL(path.resolve(REPO_ROOT, key)).href);
    _cache.set(key, p);
  }
  return p;
}

// Die vom Server geteilten Browser-Module als benannte Zugänge: so steht der
// Pfad einmal im Repo und nicht in jedem Konsumenten.
const citeHtml     = () => esm('public/js/sources/cite-html.js');
const sourceFormat = () => esm('public/js/sources/format.js');
const sourceSearch = () => esm('public/js/sources/search.js');
const mermaidHtml  = () => esm('public/js/diagram/mermaid-html.js');
const escapeUtil   = () => esm('public/js/utils/escape.js');

/** Querverweis-Module zu EINEM Namespace verschmolzen. Die Aufrufer brauchen
 *  unterschiedliche Teilmengen (der Index nur Markup + Anker, der Renderer
 *  zusätzlich Nummerierung + Formatierung) — die Vereinigung ist billiger als
 *  zwei Varianten, weil `esm()` jedes Modul ohnehin nur einmal lädt. */
function xrefModules({ withRender = true } = {}) {
  const files = ['public/js/xrefs/xref-html.js', 'public/js/xrefs/xref-anchor.js'];
  if (withRender) files.push('public/js/xrefs/xref-number.js', 'public/js/xrefs/xref-format.js');
  return Promise.all(files.map(esm)).then(mods => Object.assign({}, ...mods));
}

module.exports = {
  esm,
  citeHtml,
  sourceFormat,
  sourceSearch,
  mermaidHtml,
  escapeUtil,
  xrefModules,
};
