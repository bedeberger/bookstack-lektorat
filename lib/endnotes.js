'use strict';
// Anmerkungsapparat: Belegstellen aus dem Seitentext in nummerierte Noten
// ueberfuehren. Pendant zu lib/bibliography.js — dieselbe Rolle im Render-Pfad,
// aber ein anderes Ausgabemodell.
//
//   Verzeichnis (bibliography.js)  listet WERKE, einmal, hinten im Buch.
//   Apparat (dieses Modul)         listet BELEGSTELLEN, in Textreihenfolge,
//                                  pro Kapitel neu ab 1.
//
// Die beiden schliessen sich nicht aus: ein Fachbuch hat ueblicherweise BEIDES —
// Anmerkungen pro Kapitel und ein Gesamtverzeichnis am Ende.
//
// WAS AUS DEM CHIP WIRD: Im Anmerkungsmodus traegt der Chip nicht mehr den
// Kurzbeleg, sondern die Notenziffer. `resolveCitesInHtml` (der Inline-Pfad)
// laeuft dann NICHT — die beiden Transformationen sind Alternativen, nie
// hintereinander. Was hier passiert, weicht bewusst von Invariante B in
// bibliography.js ab: dort wird nur der Textknoten ersetzt, hier der ganze
// Chip-Inhalt (`<sup>`-Marker statt Text). Die Attribute (`data-src`/`data-loc`)
// bleiben auch hier unberuehrt — `data-src` ist und bleibt die Wahrheit.
//
// BELEGTE BLOCKZITATE OHNE EIGENEN CHIP bekommen ihre Note ans Ende des Zitats
// gehaengt. Sonst waere `<blockquote data-src>` die einzige Zitat-Kategorie ohne
// sichtbaren Nachweis (siehe public/js/sources/cite-html.js, „drei
// Zitat-Kategorien").
//
// NUMMERIERUNG PRO KAPITEL, nicht pro Seite und nicht pro Buch: Endnoten stehen
// am Kapitelende, und ein Apparat, der bei 340 anfaengt, ist unlesbar. Ein
// Kapitel, das durch Unterkapitel in mehrere Gruppen zerfaellt, zaehlt trotzdem
// durch — Bezug ist das Kapitel, nicht der Gruppenlauf.

const path = require('path');
const { pathToFileURL } = require('url');
const { parseHTML } = require('linkedom');
// Nur der Quellen-Map-Zugriff (SSoT, damit ein handgebauter Kontext mit
// `sources`-Array hier nicht still leer laeuft). Die Gegenrichtung
// (bibliography.js → CITATION_NOTES_MODES) ist ein LAZY require innerhalb einer
// Funktion, darum tragen die beiden Module keinen Lade-Zyklus.
const { sourcesByIdFrom } = require('./bibliography');

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

/** Modi der Belegdarstellung. `inline` ist der Default und das bisherige
 *  Verhalten (Kurzbeleg in Klammern im Fliesstext). SSoT fuer die Enum-Deckung
 *  gegen db/schema.js#VALID_CITATION_NOTES. */
const CITATION_NOTES_MODES = ['inline', 'endnotes'];
const DEFAULT_NOTES_MODE = 'inline';

/** Gruppenschluessel fuer die Kapitel-Zaehlung. Kapitellose Solo-Seiten zaehlen
 *  je Gruppe fuer sich — sie haben kein Kapitel, an das sich ein gemeinsamer
 *  Apparat haengen liesse. */
function _chapterKey(g, gi) {
  const id = g?.chapter?.id ?? g?.chapterId;
  return id == null ? `__solo_${gi}` : `ch_${id}`;
}

/** Belegstellen einer Seite in Textreihenfolge.
 *
 *  Chips und belegte Blockzitate laufen in EINEM Offset-Raum (collectCiteIndex),
 *  darum sind sie hier vergleichbar. Ein Blockzitat mit eigenem Chip liefert
 *  keinen zweiten Eintrag — der Chip IST sein Nachweis; ohne Chip bekommt es
 *  einen eigenen, und zwar am ENDE des Zitats (dort steht der Nachweis
 *  typografisch), darum `offset + chars` als Sortierposition. */
function _occurrences(root, mod) {
  const { cites, quotes } = mod.collectCiteIndex(root);
  const out = [];
  for (const c of cites) {
    if (!c.id) continue;
    out.push({ kind: 'cite', el: c.el, id: c.id, loc: c.loc || '', mode: c.mode, at: c.offset });
  }
  for (const q of quotes) {
    if (!q.id || (q.citeIds && q.citeIds.has(q.id))) continue;
    out.push({ kind: 'quote', el: q.el, id: q.id, loc: '', mode: 'quote', at: q.offset + (q.chars || 0) });
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

/** Notenziffer als Markup. `<sup>` statt Unicode-Hochzahlen (¹²³): die gibt es
 *  nur fuer wenige Ziffern zuverlassig in jeder Schrift, und eine fehlende Glyphe
 *  wird im PDF zur Leerstelle. Der Marker traegt keine Klasse — die Renderer
 *  erkennen ihn am Tag, und `class` wuerde beim Substack-Paste ohnehin fallen. */
function _markerHtml(n) {
  return `<sup>${n}</sup>`;
}

/** Anmerkungsapparat fuer eine `groups`-Liste bauen.
 *
 *  @param {Array}  groups  Output von lib/load-contents (wird nicht mutiert)
 *  @param {object} bib     Rueckgabeobjekt von buildBibliography (Quellen, Stil,
 *                          Sprache, Jahres-Buchstaben)
 *  @returns {Promise<{groups:Array, total:number}>} — jede Gruppe traegt
 *           zusaetzlich `notes: [{ n, runs, html, text }]`; nur die LETZTE Gruppe
 *           eines Kapitels bekommt dessen Apparat, die uebrigen eine leere Liste.
 *
 *  Ohne Quellen im Kontext oder ohne Belegstelle im Text kommt die Eingabe
 *  unveraendert zurueck (`total === 0`) — der Aufrufer braucht keinen Sonderpfad. */
async function buildEndnotes(groups, bib = {}) {
  if (!Array.isArray(groups) || !groups.length) return { groups, total: 0 };

  const { CITE_ATTR_SRC } = await _citeModule();
  const sources = sourcesByIdFrom(bib);
  if (!sources.size) return { groups, total: 0 };

  const mod = await _citeModule();
  const {
    labelsFor, formatFullRuns, noteForm, noteRuns, runsToText, runsToHtml,
  } = await _formatModule();

  const style = bib.style || 'apa7';
  const lang = bib.lang === 'en' ? 'en' : 'de';
  const labels = labelsFor(lang);
  const suffixOf = id => (bib.suffixes instanceof Map && bib.suffixes.has(id) ? bib.suffixes.get(id) : '');

  // Zustand je Kapitel: laufende Nummer, bereits belegte Quellen, letzte Note.
  const state = new Map();
  const stateFor = (key) => {
    if (!state.has(key)) state.set(key, { n: 0, seen: new Set(), prev: null, notes: [] });
    return state.get(key);
  };
  // Letzte Gruppe je Kapitel — dort haengt der Apparat.
  const lastGroupOf = new Map();
  groups.forEach((g, gi) => lastGroupOf.set(_chapterKey(g, gi), gi));

  const outGroups = [];
  let total = 0;

  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    const st = stateFor(_chapterKey(g, gi));
    const pages = [];

    for (const x of g.pages || []) {
      const html = x?.pd?.html;
      if (typeof html !== 'string' || html.indexOf(CITE_ATTR_SRC) === -1) { pages.push(x); continue; }

      const { document } = parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body></html>`);
      const root = document.getElementById('r');
      if (!root) { pages.push(x); continue; }

      let changed = 0;
      for (const occ of _occurrences(root, mod)) {
        const src = sources.get(occ.id);
        // Quelle geloescht oder buchfremd: der Beleg bekommt keine Note und
        // behaelt seinen Text — er ist dann das einzige Lesbare, das noch da ist
        // (gleiche Entscheidung wie in bibliography.js).
        if (!src) continue;

        const cur = { sourceId: occ.id, loc: occ.loc };
        const form = noteForm(cur, st.prev, st.seen);
        const runs = noteRuns({
          form,
          fullRuns: form === 'full' ? formatFullRuns(src, { style, lang, suffix: suffixOf(occ.id) }) : [],
          source: src,
          loc: occ.loc,
          prevLoc: st.prev ? st.prev.loc : '',
          style,
          labels,
        });

        const n = ++st.n;
        st.seen.add(occ.id);
        st.prev = cur;
        st.notes.push({ n, sourceId: occ.id, form, runs, html: runsToHtml(runs), text: runsToText(runs) });
        total++;

        if (occ.kind === 'cite') {
          // Chip-Inhalt wird zur Ziffer; Attribute bleiben.
          occ.el.innerHTML = _markerHtml(n);
        } else {
          // Blockzitat ohne eigenen Chip: Marker ans Ende haengen. In den
          // letzten Absatz, nicht hinter das Zitat — sonst steht die Ziffer im
          // Blockquote-Rand statt am Satzende.
          const host = _lastTextHost(occ.el) || occ.el;
          host.insertAdjacentHTML('beforeend', `<span class="cite" ${CITE_ATTR_SRC}="${occ.id}">${_markerHtml(n)}</span>`);
        }
        changed++;
      }

      pages.push(changed ? { ...x, pd: { ...x.pd, html: root.innerHTML } } : x);
    }

    const isLastOfChapter = lastGroupOf.get(_chapterKey(g, gi)) === gi;
    outGroups.push({ ...g, pages, notes: isLastOfChapter ? st.notes : [] });
  }

  return { groups: outGroups, total };
}

// Letzter Absatz-artiger Nachfahre eines Blockzitats (oder null). Der Marker
// gehoert ans Ende des letzten Satzes, nicht in den Zitat-Container.
function _lastTextHost(el) {
  const kids = Array.from(el.children || []).filter(c => /^(p|div|li)$/i.test(c.tagName || ''));
  return kids.length ? kids[kids.length - 1] : null;
}

/** Notenliste als Seiten-HTML — ein `<p>` pro Note mit vorangestellter Ziffer.
 *  Geteilte SSoT fuer alle Ausgabewege, die ihr Layout ueber den HTML-Walker
 *  bauen (Pendant zu bibliography.js#bibliographyItemHtml). */
function endnoteItemHtml(notes) {
  return (notes || []).map(nt => `<p>${nt.n}. ${nt.html}</p>`).join('\n');
}

module.exports = {
  buildEndnotes,
  endnoteItemHtml,
  CITATION_NOTES_MODES,
  DEFAULT_NOTES_MODE,
};
