'use strict';
// Quellenverzeichnis fuer die Render-Pfade (Custom-PDF, Custom-DOCX, spaeter
// Blog/EPUB/HTML/MD). Zwei Aufgaben, die jeder Exporter braucht:
//
//   buildBibliography()   — die Verzeichnis-Daten der GERENDERTEN EINHEIT
//   resolveCitesInHtml()  — den Kurzbeleg-Text der Quellen-Chips frisch setzen
//
// HARTE INVARIANTEN
//
//   A) Das Verzeichnis wird NIE in pages.content persistiert. Es ist ein
//      Render-Artefakt und entsteht bei jedem Export neu. Kein Aufrufer schreibt
//      etwas aus diesem Modul zurueck in den Content-Store.
//
//   B) Kein Chip verliert seine Attribute. `resolveCitesInHtml` ersetzt
//      ausschliesslich den Textknoten eines Chips (`data-src`/`data-loc`/`class`
//      bleiben unberuehrt) und gibt bei unveraendertem Ergebnis den EINGABE-String
//      zurueck, statt neu zu serialisieren.
//
// WARUM DER TEXT NEU GESETZT WIRD: `data-src` ist die Wahrheit, der Chip-Text ist
// ein Cache vom Einfuege-Zeitpunkt (siehe public/js/sources/cite-html.js). Im
// numerischen Stil steht dort zwangslaeufig noch die Autor-Jahr-Form, weil die
// Nummer erst beim Rendern feststeht — sie haengt an der Erstzitat-Reihenfolge
// der gerenderten Einheit, nicht an der Quelle. Darum ruft JEDER Exporter
// `resolveCitesInHtml`/`resolveCitesInGroups` auf dem Seiten-HTML auf, bevor sein
// Walker laeuft.
//
// NUMMERN FOLGEN DER GERENDERTEN EINHEIT: Buch-Export → Buch-Leserichtung
// (listBookCitations); Seiten-Scope (ein Blog-Post, ein Kapitel-PDF) → nur die
// Fundstellen dieser Seiten, beginnend bei 1. So stimmen Chip-Text und
// Verzeichnisnummer in jedem Fall zusammen.
//
// Formatiert wird ausschliesslich ueber public/js/sources/format.js (pures ESM,
// SSoT fuer alle drei Zitierstile), geladen per dynamic import() aus dem
// CJS-Kontext — Muster lib/prompts-loader.js, wie schon lib/cite-index.js. Daraus
// folgt: die beiden Resolve-Funktionen sind `async`. Das DOM kommt von linkedom
// (wie lib/html-clean.js), die Chip-Selektoren von cite-html.js.
//
// Die DB-Zugriffe stecken bewusst in einem Lazy-`require` INNERHALB von
// buildBibliography: so bleibt das Modul aus lib/pdf-render/ und
// lib/export-builders/ heraus require-bar, ohne die DB in den Renderer zu ziehen.

const path = require('path');
const { pathToFileURL } = require('url');
const { parseHTML } = require('linkedom');

function _esm(...segments) {
  return import(pathToFileURL(path.resolve(__dirname, '..', ...segments)).href);
}

let _fmtPromise = null;
function _formatModule() {
  if (!_fmtPromise) _fmtPromise = _esm('public', 'js', 'sources', 'format.js');
  return _fmtPromise;
}

let _citePromise = null;
function _citeModule() {
  if (!_citePromise) _citePromise = _esm('public', 'js', 'sources', 'cite-html.js');
  return _citePromise;
}

// ── Kontext-Helfer ───────────────────────────────────────────────────────────
// `ctx` ist im Normalfall genau das Rueckgabeobjekt von buildBibliography. Die
// Lookups sind trotzdem tolerant (Map oder Array/Objekt), damit ein Aufrufer die
// Quellen auch von Hand zusammenstellen kann (Tests, Vorschau).

function _sourcesById(ctx) {
  const s = ctx?.sourcesById || ctx?.sources;
  if (s instanceof Map) return s;
  if (Array.isArray(s)) return new Map(s.filter(x => x && x.id != null).map(x => [x.id, x]));
  return new Map();
}

function _numberOf(ctx, id) {
  const n = ctx?.numbers;
  const v = n instanceof Map ? n.get(id) : (n ? n[id] : undefined);
  return Number.isInteger(v) ? v : null;
}

// ── Kurzbeleg-Chips im Seiten-HTML aktualisieren ─────────────────────────────

/** Den Text jedes Quellen-Chips durch den frisch formatierten Kurzbeleg
 *  ersetzen. Attribute bleiben unangetastet (Invariante B).
 *
 *  Ein Chip ohne gueltiges `data-src` ist kein Quellennachweis und bleibt
 *  unberuehrt; zeigt `data-src` auf eine Quelle, die es nicht (mehr) gibt oder
 *  die zu einem anderen Buch gehoert, bleibt der Cache-Text stehen — er ist dann
 *  das einzige Lesbare, das noch da ist.
 *
 *  @returns {Promise<string>} HTML (identischer String, wenn nichts zu tun war) */
async function resolveCitesInHtml(html, ctx = {}) {
  if (typeof html !== 'string' || !html) return html;

  const { CITE_SEL, CITE_ATTR_SRC, CITE_ATTR_LOC, isCiteEl } = await _citeModule();
  // Billiger Vorab-Test, bevor ein DOM gebaut wird: Seiten ohne Quellenangabe
  // kosten so nichts — bei Manuskripten im Millionen-Zeichen-Bereich der
  // Unterschied zwischen „kein Effekt" und „zweiter HTML-Parse pro Seite".
  // Das Literal kommt aus der SSoT, nicht aus einer Kopie.
  if (html.indexOf(CITE_ATTR_SRC) === -1) return html;

  const byId = _sourcesById(ctx);
  if (!byId.size) return html;

  const { formatShort } = await _formatModule();
  const style = ctx.style;
  const lang = ctx.lang;

  const { document } = parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body></html>`);
  const root = document.getElementById('r');
  if (!root) return html;

  let changed = 0;
  for (const el of Array.from(root.querySelectorAll(CITE_SEL))) {
    if (!isCiteEl(el)) continue;
    const id = parseInt(el.getAttribute(CITE_ATTR_SRC), 10);
    const src = byId.get(id);
    if (!src) continue;
    const next = formatShort(src, {
      style, lang,
      loc: el.getAttribute(CITE_ATTR_LOC) || '',
      num: _numberOf(ctx, id),
    });
    if (!next || next === el.textContent) continue;
    // Nur der Textknoten — kein Re-Build des Elements, keine Attribut-Kopie.
    el.textContent = next;
    changed++;
  }
  return changed ? root.innerHTML : html;
}

/** `resolveCitesInHtml` ueber eine ganze `groups`-Liste (Output von
 *  lib/load-contents). Liefert eine neue Liste; die Eingabe wird nicht mutiert,
 *  und Seiten ohne Aenderung behalten ihr Original-Objekt. */
async function resolveCitesInGroups(groups, ctx = {}) {
  if (!Array.isArray(groups) || !groups.length) return groups;
  const out = [];
  for (const g of groups) {
    const pages = [];
    for (const x of g.pages || []) {
      const html = x?.pd?.html;
      const next = await resolveCitesInHtml(html, ctx);
      pages.push(next === html ? x : { ...x, pd: { ...x.pd, html: next } });
    }
    out.push({ ...g, pages });
  }
  return out;
}

/** Seiten-IDs einer `groups`-Liste in Leserichtung — die `pageIds` fuer
 *  buildBibliography, wenn die gerenderte Einheit nicht das ganze Buch ist. */
function pageIdsFromGroups(groups) {
  const out = [];
  for (const g of Array.isArray(groups) ? groups : []) {
    for (const x of g.pages || []) {
      const id = parseInt(x?.p?.id, 10);
      if (Number.isInteger(id)) out.push(id);
    }
  }
  return out;
}

// ── Verzeichnis bauen ────────────────────────────────────────────────────────

/** Verzeichnis-Daten der gerenderten Einheit.
 *
 *  @param {object}        args
 *  @param {number}        args.bookId
 *  @param {number[]|null} [args.pageIds]   null → Buch-Scope; Array → nur diese
 *                                          Seiten (ein Blog-Post, ein Kapitel).
 *  @param {string|null}   [args.userEmail] fuer den User-Default-Fallback der
 *                                          Buchsprache in getBookSettings.
 *  @returns {Promise<{enabled:boolean, inBlog:boolean, title:string,
 *                     style:string, lang:string, scope:string,
 *                     numbers:Map<number,number>, sourcesById:Map<number,object>,
 *                     entries:Array<{id:number, num:number|null, text:string,
 *                                    html:string, runs:Array}>}>}
 *
 *  `numbers` und `sourcesById` werden IMMER gefuellt, auch bei abgeschaltetem
 *  Verzeichnis: die Chips im Text brauchen ihren Kurzbeleg (im numerischen Stil
 *  also ihre Nummer) unabhaengig davon, ob hinten ein Verzeichnis steht. Nur
 *  `entries` bleibt dann leer. Das Rueckgabeobjekt ist direkt als `ctx` fuer
 *  resolveCitesInHtml verwendbar. */
async function buildBibliography({ bookId, pageIds = null, userEmail = null } = {}) {
  const { getBookSettings } = require('../db/schema');
  const { listSources, listBookCitations, listPageCitations } = require('../db/sources');
  const {
    CITATION_STYLES, DEFAULT_STYLE, labelsFor,
    formatFull, formatFullHtml, formatFullRuns, sortEntries, assignNumbers,
  } = await _formatModule();

  const bid = parseInt(bookId, 10);
  const ok = Number.isInteger(bid) && bid > 0;
  const settings = (ok ? getBookSettings(bid, userEmail) : null) || {};

  const lang = settings.language === 'en' ? 'en' : 'de';
  const style = CITATION_STYLES.includes(settings.citation_style) ? settings.citation_style : DEFAULT_STYLE;
  const scope = settings.bibliography_scope === 'all' ? 'all' : 'cited';
  const enabled = !!settings.bibliography_enabled;
  const inBlog = !!settings.bibliography_in_blog;
  // Leerer/fehlender Titel → Sprach-Default aus der Label-SSoT (Dokument-String,
  // folgt der Sprache des BUCHS, nicht der UI-Locale des Betrachters).
  const title = String(settings.bibliography_title || '').trim() || labelsFor(lang).bibliographyTitle;

  // Fundstellen der gerenderten Einheit in Leserichtung.
  let citations = [];
  if (ok) {
    if (pageIds == null) {
      citations = listBookCitations(bid);
    } else {
      const seen = new Set();
      for (const raw of Array.isArray(pageIds) ? pageIds : [pageIds]) {
        const pid = parseInt(raw, 10);
        if (!Number.isInteger(pid) || seen.has(pid)) continue;
        seen.add(pid);
        citations.push(...listPageCitations(pid));
      }
    }
  }
  const numbers = assignNumbers(citations);
  const cited = new Set(citations.map(c => c.source_id));

  // Archivierte Quellen kommen mit: ein Chip im Text darf nicht ins Leere
  // zeigen, nur weil die Quelle aus der Arbeitsliste geraeumt wurde. Ins
  // Verzeichnis kommt sie dann aber nur, wenn sie auch zitiert ist.
  const all = ok ? listSources(bid, { includeArchived: true }) : [];
  const sourcesById = new Map(all.map(s => [s.id, s]));

  let entries = [];
  if (enabled) {
    const chosen = all.filter(s => cited.has(s.id) || (scope === 'all' && !s.archived));
    entries = sortEntries(chosen, { style, lang, numbers }).map(s => ({
      id: s.id,
      num: numbers.has(s.id) ? numbers.get(s.id) : null,
      text: formatFull(s, { style, lang }),
      html: formatFullHtml(s, { style, lang }),
      runs: formatFullRuns(s, { style, lang }),
    }));
  }

  return { enabled, inBlog, title, style, lang, scope, numbers, sourcesById, entries };
}

/** Verzeichnis-Eintraege als Seiten-HTML — ein `<p>` pro Eintrag, in
 *  Verzeichnis-Reihenfolge. Geteilte SSoT fuer alle Exporter, die ihr Layout
 *  ueber den HTML-Walker bauen (Custom-PDF und Custom-DOCX teilen ihn), damit die
 *  Nummern-Spalte des numerischen Stils nicht in jedem Renderer neu entsteht.
 *
 *  Die Nummer steht bewusst NICHT im Eintrag selbst (siehe
 *  public/js/sources/format/styles.js) — sie gehoert der gerenderten Einheit und
 *  wird hier vorangestellt. Der haengende Einzug der Renderer setzt sie damit in
 *  eine eigene Spalte. */
function bibliographyItemHtml(bib) {
  const numeric = bib?.style === 'numeric';
  return (bib?.entries || []).map((e) => {
    const prefix = numeric && Number.isInteger(e.num) ? `[${e.num}] ` : '';
    return `<p>${prefix}${e.html}</p>`;
  }).join('\n');
}

module.exports = {
  buildBibliography,
  bibliographyItemHtml,
  resolveCitesInHtml,
  resolveCitesInGroups,
  pageIdsFromGroups,
};
