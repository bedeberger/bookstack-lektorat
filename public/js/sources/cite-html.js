// Quellen-Marker („Chip") im Seiten-HTML — SSoT fuer Markup, Selektoren und das
// Auslesen. Jeder Pfad, der Quellenangaben erzeugt, findet oder zaehlt, geht hier durch:
// Einfuegen im Notebook-Editor, Mount ins contenteditable, Paste-Filter,
// serverseitige Indexierung (lib/cite-index.js) und spaeter die Renderer.
//
// Persistiertes Markup:
//   <span class="cite" data-src="7" data-loc="44">(Müller, 2020, S. 44)</span>
//
// `data-src` ist die WAHRHEIT (Zeiger auf sources.id), der Text ist ein
// CACHE des Kurzbelegs. Bei Stilwechsel oder Quellenkorrektur schreibt ein
// Regenerierungs-Pass die Texte neu; bis dahin steht dort ein veralteter, aber
// lesbarer Kurzbeleg. Deshalb darf keine Schicht den Text als Wahrheit behandeln.
//
// Bewusst NICHT im persistierten Markup: `contenteditable="false"`. Das setzt der
// Editor erst beim Mount (markCitesAtomic), und lib/html-clean.js strippt es beim
// Speichern wieder — sonst landet Editor-Kruscht im WordPress-Post.
//
// Modul ist DOM-agnostisch: `collectCites`/`markCitesAtomic` arbeiten gegen
// jedes Element, das childNodes/getAttribute/classList kennt (Browser-DOM wie
// linkedom auf dem Server). Darum genau eine Implementierung fuer beide Seiten.

import { escHtml } from '../utils/escape.js';

export const CITE_CLASS = 'cite';
export const CITE_ATTR_SRC = 'data-src';
export const CITE_ATTR_LOC = 'data-loc';

/** Selektor fuer Quellenangaben mit Zeiger. Ein `span.cite` OHNE `data-src` ist
 *  keine Quellenangabe, sondern Fremdmarkup — er wird nirgends als Fundstelle
 *  gezaehlt. */
export const CITE_SEL = `span.${CITE_CLASS}[${CITE_ATTR_SRC}]`;

/** Positive Ganzzahl aus einem Attributwert, sonst null. */
function _srcId(raw) {
  if (!/^\d+$/.test(String(raw ?? '').trim())) return null;
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Ist das Element ein gueltiger Quellen-Chip? */
export function isCiteEl(el) {
  if (!el || el.nodeType !== 1) return false;
  if (String(el.tagName || '').toUpperCase() !== 'SPAN') return false;
  const cls = String(el.getAttribute('class') || '').split(/\s+/);
  if (!cls.includes(CITE_CLASS)) return false;
  return _srcId(el.getAttribute(CITE_ATTR_SRC)) !== null;
}

/** Chip-Markup als String. Text und Stellenangabe werden escapet — beide
 *  stammen aus User-Eingaben (Quellenfelder bzw. Eingabefeld). */
export function buildCiteHtml({ id, loc = '', text = '' }) {
  const sid = _srcId(id);
  if (sid === null) return '';
  const locAttr = String(loc ?? '').trim();
  const attrs = [
    `class="${CITE_CLASS}"`,
    `${CITE_ATTR_SRC}="${sid}"`,
    locAttr ? `${CITE_ATTR_LOC}="${escHtml(locAttr)}"` : '',
  ].filter(Boolean).join(' ');
  return `<span ${attrs}>${escHtml(String(text ?? ''))}</span>`;
}

/** Alle Quellenangaben unter `root` in Dokumentordnung.
 *
 *  Liefert je Quellenangabe `{ id, loc, text, offset, el }`. `offset` ist die Position im
 *  Klartext des Containers — dieselbe Groesse wie `page_figure_mentions
 *  .first_offset`, damit „erste Fundstelle" ueber alle Index-Tabellen dasselbe
 *  bedeutet. Der Chip-Text zaehlt dabei mit, weil er auch im Seitentext steht
 *  (und in die Zeichenzahl eingeht — bei akademischen Zeichenvorgaben richtig).
 *
 *  In Chips wird NICHT abgestiegen: sie sind atomar, verschachtelte
 *  Quellenangaben gibt es nicht. */
export function collectCites(root) {
  const out = [];
  if (!root) return out;
  let offset = 0;

  const walk = (node) => {
    const kids = node.childNodes;
    if (!kids) return;
    for (const child of Array.from(kids)) {
      if (child.nodeType === 3) {
        offset += String(child.textContent || '').length;
        continue;
      }
      if (child.nodeType !== 1) continue;
      if (isCiteEl(child)) {
        const text = String(child.textContent || '');
        out.push({
          id: _srcId(child.getAttribute(CITE_ATTR_SRC)),
          loc: child.getAttribute(CITE_ATTR_LOC) || '',
          text,
          offset,
          el: child,
        });
        offset += text.length;
        continue;
      }
      walk(child);
    }
  };
  walk(root);
  return out;
}

/** Fundstellen je Quelle — die Form, die db/sources.js#replacePageCitations
 *  erwartet. Mehrfachnennungen derselben Quelle werden zusammengefasst, damit
 *  der Primaerschluessel (source_id, page_id) nicht kollidiert; `firstOffset`
 *  ist die fruehste Nennung. Chips ohne gueltigen Zeiger fallen weg. */
export function citationsFromCites(cites) {
  const byId = new Map();
  for (const c of cites || []) {
    if (!c || !c.id) continue;
    const cur = byId.get(c.id);
    if (cur) cur.count += 1;
    else byId.set(c.id, { sourceId: c.id, count: 1, firstOffset: c.offset });
  }
  return [...byId.values()];
}

/** Chips im contenteditable atomar machen: der Caret springt darueber statt
 *  hinein, Backspace loescht die ganze Quellenangabe statt sie halb zu zerlegen.
 *  Laeuft beim Mount (nicht in der Persistenz) — siehe Modulkopf. */
export function markCitesAtomic(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return 0;
  const els = root.querySelectorAll(CITE_SEL);
  let n = 0;
  for (const el of Array.from(els)) {
    if (!isCiteEl(el)) continue;
    el.setAttribute('contenteditable', 'false');
    n++;
  }
  return n;
}

/** Der Chip, in dem `node` liegt (oder null). Fuer Klick-/Caret-Handler. */
export function closestCiteEl(node, root = null) {
  let n = node;
  while (n && n !== root) {
    if (isCiteEl(n)) return n;
    n = n.parentNode;
  }
  return null;
}
