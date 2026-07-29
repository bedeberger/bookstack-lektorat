// Quellen-Marker („Chip") im Seiten-HTML — SSoT fuer Markup, Selektoren und das
// Auslesen. Jeder Pfad, der Quellenangaben erzeugt, findet oder zaehlt, geht hier durch:
// Einfuegen im Notebook-Editor, Mount ins contenteditable, Paste-Filter,
// serverseitige Indexierung (lib/cite-index.js) und spaeter die Renderer.
//
// Persistiertes Markup:
//   <span class="cite" data-src="7" data-loc="44">(Müller, 2020, S. 44)</span>
//   <span class="cite" data-src="7" data-loc="44" data-mode="paraphrase">(vgl. …)</span>
//   <blockquote data-src="7"> … woertliches Blockzitat … </blockquote>
//
// `data-src` ist die WAHRHEIT (Zeiger auf sources.id), der Text ist ein
// CACHE des Kurzbelegs. Jeder Ausgabeweg setzt ihn beim Rendern frisch
// (lib/bibliography.js#resolveCitesInHtml, im Anmerkungsmodus lib/endnotes.js) —
// im Export steht damit immer die aktuelle Form, egal was gespeichert ist.
// IN DER APP bleibt der gespeicherte Text stehen: nach einem Stilwechsel oder
// einer Quellenkorrektur zeigt der Editor bis zum naechsten Einfuegen die alte
// Form. Bewusst so — es gibt keinen Pass, der Seiten hinter dem Ruecken des
// Autors umschreibt. Deshalb darf keine Schicht den Text als Wahrheit behandeln.
//
// DREI ZITAT-KATEGORIEN, ZWEI MARKUP-TRAEGER
//
// Wissenschaftliches Schreiben unterscheidet Kurzzitat (woertlich, im laufenden
// Text in Anfuehrungszeichen), Blockzitat (woertlich, ab ~3 Zeilen eingerueckt und
// kleiner, OHNE Anfuehrungszeichen) und Paraphrase („vgl."). Getragen wird das von
// genau zwei Attributen:
//
//   `data-mode` am Chip   — Art des NACHWEISES. Nur `paraphrase` wird
//                           persistiert; die Abwesenheit bedeutet `quote`
//                           (woertlich/Belegstelle, kein Praefix). Daraus folgt:
//                           Alt-Inhalte sind ohne Migration gueltig, und
//                           formatShort setzt das „vgl."/„cf."-Praefix.
//   `data-src` am blockquote — Art des ABSATZES: dieses Blockzitat ist woertlich
//                           aus Quelle N uebernommen. Treibt die Zitat-Typografie
//                           in den Renderern (aufrecht + kleiner + kein
//                           Anfuehrungszeichen) und die Kennzahl „Zitat-Anteil".
//
// Bewusst KEIN `data-loc` am blockquote: die Stellenangabe gehoert zum sichtbaren
// Kurzbeleg, und der steht im Chip am Ende des Blockzitats. Zwei Traeger fuer
// dieselbe Angabe wuerden auseinanderdriften.
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
export const CITE_ATTR_MODE = 'data-mode';

/** Selektor fuer Quellenangaben mit Zeiger. Ein `span.cite` OHNE `data-src` ist
 *  keine Quellenangabe, sondern Fremdmarkup — er wird nirgends als Fundstelle
 *  gezaehlt. */
export const CITE_SEL = `span.${CITE_CLASS}[${CITE_ATTR_SRC}]`;

/** Art des Nachweises. `quote` ist der Default und steht NICHT im Markup (siehe
 *  Modulkopf) — nur `paraphrase` wird persistiert. Neue Werte hier ergaenzen,
 *  nicht in Konsumenten hart hinschreiben. */
export const CITE_MODES = ['quote', 'paraphrase'];
export const CITE_MODE_DEFAULT = 'quote';

/** Belegtes Blockzitat: ein `<blockquote>` mit Zeiger auf seine Quelle.
 *
 *  Heisst bewusst NICHT `QUOTE_BLOCK_SEL` — der Name ist in
 *  editor/shared/dom-block.js schon fuer die Anfuehrungszeichen-Normalisierung
 *  belegt und meint dort etwas voellig anderes (siehe harte Regel
 *  „Blockselektoren komponieren aus TEXT_BLOCK_TAGS": gleicher Name suggeriert
 *  Gleichheit und fuehrt zum Griff in die falsche Familie). */
export const CITED_QUOTE_SEL = `blockquote[${CITE_ATTR_SRC}]`;

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

/** Art des Nachweises eines Chips. Fehlender oder unbekannter Wert →
 *  `CITE_MODE_DEFAULT`; ein verschriebenes `data-mode` darf den Kurzbeleg nicht
 *  kaputtmachen. */
export function citeModeOf(el) {
  const raw = String(el?.getAttribute?.(CITE_ATTR_MODE) || '').trim().toLowerCase();
  return CITE_MODES.includes(raw) ? raw : CITE_MODE_DEFAULT;
}

/** Ist das Element ein Blockzitat mit Quellen-Zeiger? */
export function isQuoteBlockEl(el) {
  if (!el || el.nodeType !== 1) return false;
  if (String(el.tagName || '').toUpperCase() !== 'BLOCKQUOTE') return false;
  return _srcId(el.getAttribute(CITE_ATTR_SRC)) !== null;
}

/** Chip-Markup als String. Text und Stellenangabe werden escapet — beide
 *  stammen aus User-Eingaben (Quellenfelder bzw. Eingabefeld). `mode` landet nur
 *  im Markup, wenn es vom Default abweicht (siehe Modulkopf). */
export function buildCiteHtml({ id, loc = '', text = '', mode = CITE_MODE_DEFAULT }) {
  const sid = _srcId(id);
  if (sid === null) return '';
  const locAttr = String(loc ?? '').trim();
  const md = CITE_MODES.includes(mode) ? mode : CITE_MODE_DEFAULT;
  const attrs = [
    `class="${CITE_CLASS}"`,
    `${CITE_ATTR_SRC}="${sid}"`,
    locAttr ? `${CITE_ATTR_LOC}="${escHtml(locAttr)}"` : '',
    md === CITE_MODE_DEFAULT ? '' : `${CITE_ATTR_MODE}="${md}"`,
  ].filter(Boolean).join(' ');
  return `<span ${attrs}>${escHtml(String(text ?? ''))}</span>`;
}

/** Quellenangaben UND belegte Blockzitate unter `root`, in Dokumentordnung und in
 *  EINEM Durchlauf — beide Listen brauchen denselben Offset-Zaehler, zwei Walks
 *  waeren zwei Koordinatensysteme.
 *
 *  `cites`: je Chip `{ id, loc, mode, text, offset, el }`. `offset` ist die
 *  Position im Klartext des Containers — dieselbe Groesse wie
 *  `page_figure_mentions.first_offset`, damit „erste Fundstelle" ueber alle
 *  Index-Tabellen dasselbe bedeutet. Der Chip-Text zaehlt dabei mit, weil er auch
 *  im Seitentext steht (und in die Zeichenzahl eingeht — bei akademischen
 *  Zeichenvorgaben richtig).
 *
 *  `quotes`: je belegtes Blockzitat `{ id, offset, chars, citeIds, el }`. `chars`
 *  ist die Laenge des woertlich uebernommenen Textes OHNE die Chip-Texte darin —
 *  der Kurzbeleg ist der Nachweis, nicht das Zitat, und darf den Zitat-Anteil
 *  nicht aufblasen. `citeIds` sind die Quellen, die im Block per Chip belegt sind;
 *  daran haengt die Fundstellen-Zaehlung (siehe citationsFromCites).
 *
 *  In Chips wird NICHT abgestiegen: sie sind atomar, verschachtelte
 *  Quellenangaben gibt es nicht. Ein belegtes Blockzitat INNERHALB eines belegten
 *  Blockzitats wird nicht als zweiter Eintrag gefuehrt — sein Text zaehlt zum
 *  aeusseren, sonst waere derselbe Text zweimal Zitat. */
export function collectCiteIndex(root) {
  const cites = [];
  const quotes = [];
  if (!root) return { cites, quotes };
  let offset = 0;

  const walk = (node, quote) => {
    const kids = node.childNodes;
    if (!kids) return;
    for (const child of Array.from(kids)) {
      if (child.nodeType === 3) {
        const len = String(child.textContent || '').length;
        offset += len;
        if (quote) quote.chars += len;
        continue;
      }
      if (child.nodeType !== 1) continue;
      if (isCiteEl(child)) {
        const text = String(child.textContent || '');
        const id = _srcId(child.getAttribute(CITE_ATTR_SRC));
        cites.push({
          id,
          loc: child.getAttribute(CITE_ATTR_LOC) || '',
          mode: citeModeOf(child),
          text,
          offset,
          el: child,
        });
        if (quote && id !== null) quote.citeIds.add(id);
        offset += text.length;
        continue;
      }
      if (!quote && isQuoteBlockEl(child)) {
        const q = {
          id: _srcId(child.getAttribute(CITE_ATTR_SRC)),
          offset,
          chars: 0,
          citeIds: new Set(),
          el: child,
        };
        quotes.push(q);
        walk(child, q);
        continue;
      }
      walk(child, quote);
    }
  };
  walk(root, null);
  return { cites, quotes };
}

/** Nur die Chips (Rueckwaerts-kompatible Sicht auf collectCiteIndex). */
export function collectCites(root) {
  return collectCiteIndex(root).cites;
}

/** Nur die belegten Blockzitate. */
export function collectQuoteBlocks(root) {
  return collectCiteIndex(root).quotes;
}

/** Fundstellen je Quelle — die Form, die db/sources.js#replacePageCitations
 *  erwartet. Mehrfachnennungen derselben Quelle werden zusammengefasst, damit
 *  der Primaerschluessel (source_id, page_id) nicht kollidiert; `firstOffset`
 *  ist die fruehste Nennung. Chips ohne gueltigen Zeiger fallen weg.
 *
 *  `quoteChars` und `paraphraseCount` sind die Kennzahl-Seite: wie viel woertlich
 *  uebernommener Text haengt an dieser Quelle, und wie viele der Nachweise sind
 *  Paraphrasen. Ein belegtes Blockzitat OHNE eigenen Chip zaehlt selbst als
 *  Fundstelle — dann ist das `data-src` am Absatz der einzige Nachweis. Traegt es
 *  einen Chip auf dieselbe Quelle, zaehlt nur der Chip (sonst doppelt). */
export function citationsFromCites(cites, quoteBlocks = []) {
  const byId = new Map();
  const ensure = (id, offset) => {
    let cur = byId.get(id);
    if (!cur) {
      cur = { sourceId: id, count: 0, firstOffset: offset, quoteChars: 0, paraphraseCount: 0 };
      byId.set(id, cur);
      return cur;
    }
    if (offset != null && (cur.firstOffset == null || offset < cur.firstOffset)) cur.firstOffset = offset;
    return cur;
  };

  for (const c of cites || []) {
    if (!c || !c.id) continue;
    const cur = ensure(c.id, c.offset);
    cur.count += 1;
    if (c.mode === 'paraphrase') cur.paraphraseCount += 1;
  }
  for (const q of quoteBlocks || []) {
    if (!q || !q.id) continue;
    const cur = ensure(q.id, q.offset);
    cur.quoteChars += Math.max(0, q.chars || 0);
    if (!q.citeIds || !q.citeIds.has(q.id)) cur.count += 1;
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

/** Das `<blockquote>`, in dem `node` liegt (oder null) — mit oder ohne Zeiger.
 *  Der Einfuegepfad des Editors braucht beides: ein bereits belegtes Blockzitat
 *  bekommt einen neuen Zeiger, ein unbelegtes wird belegt. Steht hier statt als
 *  `closest('blockquote')` im Editor, damit das Tag-Literal des Zitat-Traegers
 *  nur an dieser einen Stelle existiert. */
export function closestQuoteBlock(node, root = null) {
  let n = node;
  while (n && n !== root) {
    if (n.nodeType === 1 && String(n.tagName || '').toUpperCase() === 'BLOCKQUOTE') return n;
    n = n.parentNode;
  }
  return null;
}

/** `node` als belegtes Blockzitat markieren. Setzt ausschliesslich den Zeiger —
 *  kein `data-loc` (siehe Modulkopf). `null`/0 entfernt den Zeiger wieder. */
export function setQuoteBlockSource(el, id) {
  if (!el || el.nodeType !== 1) return false;
  const sid = _srcId(id);
  if (sid === null) {
    el.removeAttribute(CITE_ATTR_SRC);
    return false;
  }
  el.setAttribute(CITE_ATTR_SRC, String(sid));
  return true;
}
