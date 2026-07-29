// Querverweis-Marker („siehe Kapitel 3", „vgl. Abb. 3.2") im Seiten-HTML — SSoT
// fuer Markup, Selektoren und das Auslesen. Jeder Pfad, der Querverweise erzeugt,
// findet oder zaehlt, geht hier durch: Einfuegen im Notebook-Editor, Mount ins
// contenteditable, Paste-Filter, serverseitige Indexierung (lib/xref-index.js)
// und die Renderer (lib/xref-render.js).
//
// Persistiertes Markup:
//   <span class="xref" data-xref="chapter" data-xref-id="42">Kapitel 3</span>
//   <span class="xref" data-xref="figure"  data-xref-id="a1b2c3d4e5f6a7b8">Abb. 3.2</span>
//
// `data-xref` + `data-xref-id` sind die WAHRHEIT, der Text ist ein CACHE der
// zuletzt bekannten Nummer. Das ist derselbe Vertrag wie beim Quellen-Chip
// (public/js/sources/cite-html.js) — und aus demselben Grund noch strenger noetig:
//
//   NUMMERN FOLGEN DER GERENDERTEN EINHEIT. „Kapitel 3" ist keine Eigenschaft des
//   Ziels, sondern des Ausgabewegs. Dasselbe Kapitel heisst im PDF-Profil mit
//   roemischer Nummerierung „Kapitel III", bei `numbering: 'none'` gar nicht (dann
//   faellt der Verweis auf den Kapiteltitel zurueck), und im Kapitel-Scope-Export
//   zaehlt es ab 1. Darum ruft JEDER Ausgabeweg `resolveXrefsInHtml` auf, bevor
//   sein Walker laeuft — genau wie bei den Quellen-Chips.
//
// Schiebt der Autor Kapitel 2 vor Kapitel 3, aendert sich am Marker nichts; nur
// die aufgeloeste Zahl. Das ist der ganze Zweck des Features.
//
// Bewusst NICHT im persistierten Markup: `contenteditable="false"`. Das setzt der
// Editor erst beim Mount (markXrefsAtomic), und lib/html-clean.js strippt es beim
// Speichern wieder — sonst landet Editor-Kruscht im WordPress-Post.
//
// Modul ist DOM-agnostisch: `collectXrefs`/`markXrefsAtomic` arbeiten gegen jedes
// Element, das childNodes/getAttribute/classList kennt (Browser-DOM wie linkedom
// auf dem Server). Darum genau eine Implementierung fuer beide Seiten.

import { escHtml } from '../utils/escape.js';

export const XREF_CLASS = 'xref';
export const XREF_ATTR_KIND = 'data-xref';
export const XREF_ATTR_ID = 'data-xref-id';
export const XREF_ATTR_FMT = 'data-xref-fmt';

/** Ziel-Typen. `page` (gedruckte Seitenzahl) ist bewusst schon hier verankert,
 *  obwohl noch kein Einfuegepfad existiert: der Typ braucht spaeter einen
 *  Zwei-Pass-Render (Pass 1 lernt, auf welcher Druckseite das Ziel landet), aber
 *  KEINE Migration und keine Markup-Aenderung. Wer ihn nachruestet, ergaenzt den
 *  Resolver — nicht das Format. */
export const XREF_KINDS = ['chapter', 'figure', 'page'];

/** Anzeigeformen eines Verweises:
 *    label  — „Kapitel 3" / „Abb. 3.2"   (Default)
 *    number — „3" / „3.2"                (fuer „vgl. 3.2" oder eigene Vorsilbe)
 *    title  — „Kapitel 3: Die Verwandlung"
 *  Faellt eine Form mangels Nummer aus (Profil ohne Kapitel-Nummerierung), liefert
 *  der Resolver den Titel — siehe lib/xref-render.js. */
export const XREF_FORMATS = ['label', 'number', 'title'];

/** Selektor fuer Querverweise mit Zeiger. Ein `span.xref` OHNE `data-xref-id` ist
 *  kein Querverweis, sondern Fremdmarkup — er wird nirgends gezaehlt und nie
 *  ueberschrieben. */
export const XREF_SEL = `span.${XREF_CLASS}[${XREF_ATTR_ID}]`;

/** Ziel-ID normalisieren. Kapitel/Seite zeigen auf eine positive Ganzzahl
 *  (chapter_id/page_id), Abbildungen auf ein `data-bid` (8-Byte-Hex aus
 *  lib/html-clean.js#ensureBlockIds). Alles andere ist kein gueltiger Zeiger. */
function _targetId(kind, raw) {
  const v = String(raw ?? '').trim();
  if (kind === 'figure') return /^[0-9a-f]{8,32}$/i.test(v) ? v.toLowerCase() : null;
  if (!/^\d+$/.test(v)) return null;
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? String(n) : null;
}

function _kind(raw) {
  const k = String(raw ?? '').trim().toLowerCase();
  return XREF_KINDS.includes(k) ? k : null;
}

function _fmt(raw) {
  const f = String(raw ?? '').trim().toLowerCase();
  return XREF_FORMATS.includes(f) ? f : 'label';
}

/** Ist das Element ein gueltiger Querverweis? */
export function isXrefEl(el) {
  if (!el || el.nodeType !== 1) return false;
  if (String(el.tagName || '').toUpperCase() !== 'SPAN') return false;
  const cls = String(el.getAttribute('class') || '').split(/\s+/);
  if (!cls.includes(XREF_CLASS)) return false;
  const kind = _kind(el.getAttribute(XREF_ATTR_KIND));
  if (!kind) return false;
  return _targetId(kind, el.getAttribute(XREF_ATTR_ID)) !== null;
}

/** Verweis-Markup als String. Der Text wird escapet — er stammt aus der
 *  Nummern-Map bzw. aus Zieltiteln, also aus User-Eingaben. */
export function buildXrefHtml({ kind, target, fmt = 'label', text = '' }) {
  const k = _kind(kind);
  if (!k) return '';
  const id = _targetId(k, target);
  if (id === null) return '';
  const form = _fmt(fmt);
  const attrs = [
    `class="${XREF_CLASS}"`,
    `${XREF_ATTR_KIND}="${k}"`,
    `${XREF_ATTR_ID}="${escHtml(id)}"`,
    form === 'label' ? '' : `${XREF_ATTR_FMT}="${form}"`,
  ].filter(Boolean).join(' ');
  return `<span ${attrs}>${escHtml(String(text ?? ''))}</span>`;
}

/** Alle Querverweise unter `root` in Dokumentordnung.
 *
 *  Liefert je Verweis `{ kind, target, fmt, text, offset, el }`. `offset` ist die
 *  Position im Klartext des Containers — dieselbe Groesse wie
 *  `source_citations.first_offset` und `page_figure_mentions.first_offset`, damit
 *  „erste Fundstelle" ueber alle Index-Tabellen dasselbe bedeutet. Der
 *  Verweistext zaehlt mit, weil er auch im Seitentext steht.
 *
 *  In Verweise wird NICHT abgestiegen: sie sind atomar, verschachtelte
 *  Querverweise gibt es nicht. */
export function collectXrefs(root) {
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
      if (isXrefEl(child)) {
        const text = String(child.textContent || '');
        const kind = _kind(child.getAttribute(XREF_ATTR_KIND));
        out.push({
          kind,
          target: _targetId(kind, child.getAttribute(XREF_ATTR_ID)),
          fmt: _fmt(child.getAttribute(XREF_ATTR_FMT)),
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

/** Verweise je Ziel — die Form, die db/xrefs.js#replacePageXrefs erwartet.
 *  Mehrfachnennungen desselben Ziels werden zusammengefasst, damit der
 *  Unique-Index (page_id, kind, target) nicht kollidiert; `firstOffset` ist die
 *  fruehste Nennung. Verweise ohne gueltigen Zeiger fallen weg. */
export function xrefsByTarget(xrefs) {
  const byKey = new Map();
  for (const x of xrefs || []) {
    if (!x || !x.kind || !x.target) continue;
    const key = `${x.kind}:${x.target}`;
    const cur = byKey.get(key);
    if (cur) cur.count += 1;
    else byKey.set(key, { kind: x.kind, target: x.target, count: 1, firstOffset: x.offset });
  }
  return [...byKey.values()];
}

/** Verweise im contenteditable atomar machen: der Caret springt darueber statt
 *  hinein, Backspace loescht den ganzen Verweis statt ihn halb zu zerlegen.
 *  Laeuft beim Mount (nicht in der Persistenz) — siehe Modulkopf. */
export function markXrefsAtomic(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return 0;
  const els = root.querySelectorAll(XREF_SEL);
  let n = 0;
  for (const el of Array.from(els)) {
    if (!isXrefEl(el)) continue;
    el.setAttribute('contenteditable', 'false');
    n++;
  }
  return n;
}

/** Der Verweis, in dem `node` liegt (oder null). Fuer Klick-/Caret-Handler. */
export function closestXrefEl(node, root = null) {
  let n = node;
  while (n && n !== root) {
    if (isXrefEl(n)) return n;
    n = n.parentNode;
  }
  return null;
}
