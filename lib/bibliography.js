'use strict';
// Quellenverzeichnis fuer die Render-Pfade (Custom-PDF, Custom-DOCX, EPUB, HTML,
// Markdown, Plaintext, Substack). Zwei Aufgaben, die jeder Exporter braucht:
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

const { parseHTML } = require('linkedom');
// Zitierstile, Quellen-Markup und Escaping sind SSoT im Browser-Bundle; der
// Server laedt sie ueber lib/esm-bridge.js (memoisiert, ein Promise pro Modul).
const {
  sourceFormat: _formatModule,
  citeHtml: _citeModule,
  escapeUtil: _escapeModule,
} = require('./esm-bridge');

// ── Marker des angehaengten Verzeichnisses ───────────────────────────────────

/** Klasse, mit der ein in einen Blog-Post GESCHRIEBENES Verzeichnis markiert
 *  wird — der Anker, an dem der Pull es wieder heraussschneidet.
 *
 *  WARUM ES DEN MARKER BRAUCHT: der WordPress-Sync ist bidirektional mit
 *  Last-Write-Wins (docs/blog-sync.md). Ein Push haengt das Verzeichnis an den
 *  Post; ohne Marker liest der naechste Pull es als Seitentext zurueck und der
 *  Push danach haengt ein zweites an — es akkumuliert bei jedem Zyklus. Der
 *  Marker ist damit keine Kosmetik, sondern die Bedingung dafuer, dass das
 *  Verzeichnis ein Render-Artefakt bleibt (Invariante A im Modulkopf).
 *
 *  Gegenstueck: lib/wp-html.js (Anhaengen beim Push, Entfernen beim Pull).
 *  HubSpot braucht ihn nicht — dort gibt es keinen Rueckweg. */
const BIBLIOGRAPHY_MARKER_CLASS = 'sw-bibliography';
const BIBLIOGRAPHY_MARKER_SEL = `div.${BIBLIOGRAPHY_MARKER_CLASS}`;

// ── Kontext-Helfer ───────────────────────────────────────────────────────────
// `ctx` ist im Normalfall genau das Rueckgabeobjekt von buildBibliography. Die
// Lookups sind trotzdem tolerant (Map oder Array/Objekt), damit ein Aufrufer die
// Quellen auch von Hand zusammenstellen kann (Tests, Vorschau).

/** Quellen-Map aus einem Kontext. Toleriert Map UND Array, damit ein
 *  handgebauter Kontext (Tests, Vorschau) nicht still leer laeuft — genau das
 *  passiert sonst: `buildEndnotes` lieferte bei einem Array unveraendert
 *  `total: 0` zurueck und der Apparat fehlte ohne Fehlermeldung. */
function sourcesByIdFrom(ctx) {
  const s = ctx?.sourcesById || ctx?.sources;
  if (s instanceof Map) return s;
  if (Array.isArray(s)) return new Map(s.filter(x => x && x.id != null).map(x => [x.id, x]));
  return new Map();
}
const _sourcesById = sourcesByIdFrom;

function _numberOf(ctx, id) {
  const n = ctx?.numbers;
  const v = n instanceof Map ? n.get(id) : (n ? n[id] : undefined);
  return Number.isInteger(v) ? v : null;
}

function _suffixOf(ctx, id) {
  const s = ctx?.suffixes;
  const v = s instanceof Map ? s.get(id) : (s ? s[id] : undefined);
  return typeof v === 'string' ? v : '';
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

  const { CITE_SEL, CITE_ATTR_SRC, CITE_ATTR_LOC, isCiteEl, citeModeOf } = await _citeModule();
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
      // Jahres-Buchstabe bei mehrdeutigem Autor-Jahr-Beleg („Müller, 2020a").
      // Muss zwingend derselbe sein wie im Verzeichniseintrag — beide lesen
      // dieselbe Map aus buildBibliography.
      suffix: _suffixOf(ctx, id),
      // Paraphrase-Praefix („vgl."/„cf.") haengt am Chip, nicht an der Quelle —
      // dieselbe Quelle steht im Text mal woertlich, mal paraphrasiert.
      mode: citeModeOf(el),
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

/** Fundstellen direkt aus dem HTML einer `groups`-Liste, in Leserichtung — die
 *  `citations` fuer buildBibliography, wenn der Fund-Index nicht zur gerenderten
 *  Einheit passt.
 *
 *  DER NORMALFALL IST DAS NICHT: fuer Live-Exporte ist `source_citations` die
 *  billigere und gleichwertige Quelle (der Index wird am Schreib-Chokepoint
 *  gepflegt, siehe lib/cite-index.js). Gebraucht wird dieser Weg dort, wo das
 *  gerenderte HTML NICHT der aktuelle Seitenstand ist — beim Fassungs-Export:
 *  die Seiten-IDs eines Snapshots zeigen auf Seiten, deren heutiger Text ganz
 *  andere Chips tragen kann. Die Nummern muessen aber dem folgen, was im Export
 *  wirklich steht.
 *
 *  Liefert dieselbe Zeilenform wie db/sources.js#listBookCitations
 *  (`source_id`/`page_id`), damit assignNumbers beide Wege gleich behandelt.
 *  Buch-Guard gibt es hier keinen: buildBibliography verwirft unbekannte IDs
 *  ohnehin beim Lookup gegen `sourcesById`. */
async function citationsFromGroups(groups) {
  const out = [];
  if (!Array.isArray(groups) || !groups.length) return out;

  const { CITE_ATTR_SRC } = await _citeModule();
  let mod = null; // erst laden, wenn die erste Seite ueberhaupt Chips traegt

  for (const g of groups) {
    for (const x of g.pages || []) {
      const html = x?.pd?.html;
      if (typeof html !== 'string' || html.indexOf(CITE_ATTR_SRC) === -1) continue;
      if (!mod) mod = await _citeModule();
      const { document } = parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body></html>`);
      const root = document.getElementById('r');
      if (!root) continue;
      const { cites, quotes } = mod.collectCiteIndex(root);
      const pageId = parseInt(x?.p?.id, 10);
      // Innerhalb einer Seite nach Textposition — assignNumbers vergibt die
      // Nummern in genau dieser Reihenfolge.
      const rows = mod.citationsFromCites(cites, quotes)
        .sort((a, b) => (a.firstOffset ?? 0) - (b.firstOffset ?? 0));
      for (const r of rows) {
        out.push({
          source_id: r.sourceId,
          page_id: Number.isInteger(pageId) ? pageId : null,
          count: r.count,
          first_offset: r.firstOffset ?? 0,
        });
      }
    }
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
 *  @param {Array|null}    [args.citations] Fundstellen in Leserichtung, fertig
 *                                          (aus citationsFromGroups). Hat Vorrang
 *                                          vor `pageIds`; fuer Exporte, deren HTML
 *                                          nicht der aktuelle Seitenstand ist.
 *  @param {string|null}   [args.userEmail] fuer den User-Default-Fallback der
 *                                          Buchsprache in getBookSettings.
 *  @returns {Promise<{enabled:boolean, inBlog:boolean, title:string,
 *                     style:string, lang:string, scope:string,
 *                     numbers:Map<number,number>, suffixes:Map<number,string>,
 *                     sourcesById:Map<number,object>,
 *                     entries:Array<{id:number, num:number|null, text:string,
 *                                    html:string, runs:Array}>}>}
 *
 *  `numbers`, `suffixes` und `sourcesById` werden IMMER gefuellt, auch bei
 *  abgeschaltetem Verzeichnis: die Chips im Text brauchen ihren Kurzbeleg (im
 *  numerischen Stil also ihre Nummer, in den Autor-Jahr-Stilen ggf. ihren
 *  Jahres-Buchstaben) unabhaengig davon, ob hinten ein Verzeichnis steht. Nur
 *  `entries` bleibt dann leer. Das Rueckgabeobjekt ist direkt als `ctx` fuer
 *  resolveCitesInHtml verwendbar. */
async function buildBibliography({ bookId, pageIds = null, citations: citationsIn = null, userEmail = null } = {}) {
  const { getBookSettings } = require('../db/schema');
  const { listSources, listBookCitations, listPageCitations } = require('../db/sources');
  const {
    CITATION_STYLES, DEFAULT_STYLE, labelsFor,
    formatFull, formatFullHtml, formatFullRuns, sortEntries, assignNumbers, assignYearSuffixes,
  } = await _formatModule();

  const bid = parseInt(bookId, 10);
  const ok = Number.isInteger(bid) && bid > 0;
  const settings = (ok ? getBookSettings(bid, userEmail) : null) || {};

  const lang = settings.language === 'en' ? 'en' : 'de';
  const style = CITATION_STYLES.includes(settings.citation_style) ? settings.citation_style : DEFAULT_STYLE;
  const scope = settings.bibliography_scope === 'all' ? 'all' : 'cited';
  // Belegdarstellung: Kurzbeleg im Fliesstext oder Anmerkungsapparat. Steht hier
  // und nicht beim Aufrufer, damit JEDER Ausgabeweg denselben Modus sieht — die
  // Entscheidung gehoert dem Werk, nicht dem Export (siehe Migration 256).
  const { CITATION_NOTES_MODES, DEFAULT_NOTES_MODE } = require('./endnotes');
  const notesMode = CITATION_NOTES_MODES.includes(settings.citation_notes)
    ? settings.citation_notes : DEFAULT_NOTES_MODE;
  const enabled = !!settings.bibliography_enabled;
  const inBlog = !!settings.bibliography_in_blog;
  // Leerer/fehlender Titel → Sprach-Default aus der Label-SSoT (Dokument-String,
  // folgt der Sprache des BUCHS, nicht der UI-Locale des Betrachters).
  const title = String(settings.bibliography_title || '').trim() || labelsFor(lang).bibliographyTitle;
  // Der Titel ist User-Eingabe und landet in HTML-Senken (Blog-Post, EPUB-XHTML,
  // HTML-Export). Einmal hier escapen, statt in jedem Ausgabeweg eine eigene
  // Escape-Kopie zu halten — `entries[].html` ist ueber runsToHtml schon escapet.
  const { escHtml } = await _escapeModule();

  // Fundstellen der gerenderten Einheit in Leserichtung.
  let citations = [];
  if (Array.isArray(citationsIn)) {
    citations = citationsIn;
  } else if (ok) {
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

  // Jahres-Buchstaben ueber ALLE Quellen des Buchs, nicht nur die zitierten oder
  // die der gerenderten Einheit: „Müller 2020a" muss im Kapitel-PDF dasselbe Werk
  // meinen wie im Buch-PDF (siehe format/sort.js#assignYearSuffixes). Wuerde die
  // Menge mit dem Scope wandern, verschoebe sich der Buchstabe je Export.
  const suffixes = assignYearSuffixes(all, { lang });
  const suffixOf = s => (suffixes.has(s.id) ? suffixes.get(s.id) : '');

  let entries = [];
  if (enabled) {
    const chosen = all.filter(s => cited.has(s.id) || (scope === 'all' && !s.archived));
    entries = sortEntries(chosen, { style, lang, numbers }).map(s => ({
      id: s.id,
      num: numbers.has(s.id) ? numbers.get(s.id) : null,
      suffix: suffixOf(s),
      text: formatFull(s, { style, lang, suffix: suffixOf(s) }),
      html: formatFullHtml(s, { style, lang, suffix: suffixOf(s) }),
      runs: formatFullRuns(s, { style, lang, suffix: suffixOf(s) }),
    }));
  }

  return {
    enabled, inBlog, title, titleHtml: escHtml(title), style, lang, scope,
    // Ueberschrift des Anmerkungsapparats — Dokument-String aus der Label-SSoT,
    // damit die Renderer keine eigene Sprach-Map halten muessen.
    notesMode, notesTitle: labelsFor(lang).notesTitle,
    numbers, suffixes, sourcesById, entries,
  };
}

// ── Verzeichnis ausgeben ─────────────────────────────────────────────────────

/** Soll ueberhaupt ein Verzeichnis gerendert werden? `enabled` allein reicht
 *  nicht: bei `scope='cited'` und einer Seite/Einheit ohne Fundstellen bleibt
 *  `entries` leer, und eine Ueberschrift ohne Eintraege ist keine gute Ausgabe. */
function bibliographyVisible(bib) {
  return !!(bib && bib.enabled && Array.isArray(bib.entries) && bib.entries.length);
}

/** `[n] `-Praefix des numerischen Stils, sonst ''. Die Nummer gehoert der
 *  GERENDERTEN EINHEIT und steht darum bewusst nicht im Eintrag selbst (siehe
 *  public/js/sources/format/styles.js) — jeder Ausgabeweg holt sie hier. */
function bibliographyNumPrefix(bib, entry) {
  return (bib?.style === 'numeric' && Number.isInteger(entry?.num)) ? `[${entry.num}] ` : '';
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
  return (bib?.entries || [])
    .map(e => `<p>${bibliographyNumPrefix(bib, e)}${e.html}</p>`)
    .join('\n');
}

/** Eintraege als Klartext-Zeilen (TXT-Export, Vorschau, Tests). Reihenfolge und
 *  Nummern-Praefix wie in allen anderen Ausgabewegen. */
function bibliographyItemLines(bib) {
  return (bib?.entries || []).map(e => `${bibliographyNumPrefix(bib, e)}${e.text}`);
}

/** Verzeichnis als fertiger HTML-Abschnitt: Ueberschrift + Eintraege. Geteilte
 *  SSoT fuer alle Ausgabewege, die HTML sprechen (Blog-Push, EPUB, HTML-Export,
 *  Substack). Leerer String, wenn nichts zu zeigen ist.
 *
 *  @param {object}  bib
 *  @param {object}  [opts]
 *  @param {boolean} [opts.marker]  In den Marker-Wrapper legen. Pflicht fuer
 *      alles, was in einen bidirektional gesyncten Blog-Post geschrieben wird
 *      (siehe BIBLIOGRAPHY_MARKER_CLASS); fuer Dateiexporte unnoetig.
 *  @param {boolean} [opts.list]  Autor-Jahr-Stile als `<ul>` statt als Absaetze.
 *      Der numerische Stil bleibt IMMER bei Absaetzen: sein `[n]`-Praefix ist
 *      selbst schon das Label, ein Listenpunkt daneben doppelt es — und eine
 *      auto-numerierte `<ol>` numerierte bei `scope='all'` sogar falsch, weil
 *      unzitierte Quellen ohne Nummer hinten anhaengen (siehe sortEntries). */
function bibliographySectionHtml(bib, { marker = false, list = false } = {}) {
  if (!bibliographyVisible(bib)) return '';
  const numeric = bib.style === 'numeric';
  const body = (list && !numeric)
    ? `<ul>${bib.entries.map(e => `<li>${e.html}</li>`).join('')}</ul>`
    : bibliographyItemHtml(bib);
  const inner = `<h2>${bib.titleHtml || ''}</h2>\n${body}`;
  return marker ? `<div class="${BIBLIOGRAPHY_MARKER_CLASS}">\n${inner}\n</div>` : inner;
}

module.exports = {
  sourcesByIdFrom,
  BIBLIOGRAPHY_MARKER_CLASS,
  BIBLIOGRAPHY_MARKER_SEL,
  buildBibliography,
  bibliographyVisible,
  bibliographyNumPrefix,
  bibliographyItemHtml,
  bibliographyItemLines,
  bibliographySectionHtml,
  resolveCitesInHtml,
  resolveCitesInGroups,
  citationsFromGroups,
  pageIdsFromGroups,
};
