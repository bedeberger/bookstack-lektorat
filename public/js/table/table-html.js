// Tabellen-Block im Seiten-HTML — SSoT fuer Markup, Selektoren, das Auslesen und
// das Zurueckschreiben. Jeder Pfad, der Tabellen erzeugt, findet, zaehlt oder
// rendert, geht hier durch: der Gitter-Dialog im Notebook-Editor, der Mount ins
// contenteditable, die Leseansichten, der Share-Reader, die serverseitige
// Anker-Indexierung und alle Exportwege (HTML/EPUB/Markdown/TXT/PDF/DOCX/WP).
//
// Persistiertes Markup:
//
//   <table data-bid="a1b2c3d4">
//     <caption>Umsatz nach Jahr</caption>
//     <thead><tr><th scope="col">Jahr</th><th scope="col" data-align="right">Umsatz</th></tr></thead>
//     <tbody><tr><td>2023</td><td data-align="right">1.2 Mio</td></tr></tbody>
//   </table>
//
// KEIN MARKER-KLASSENNAME. Jedes `<table>` ist eine Tabelle — anders als beim
// Diagramm (`pre.mermaid`), das sich von einem gewoehnlichen Codeblock
// unterscheiden muss. Tabellen liegen ausserdem schon im Bestand: der
// DOCX-Import behaelt sie (lib/import-parsers/docx.js, mammoth), der ODT-Import
// baut sie (lib/import-parsers/odt.js). Ein Marker haette daraus Buerger zweiter
// Klasse gemacht, die weiterhin still zu Fliesstext plattgedrueckt werden.
//
// DIE NUMMER GEHOERT NICHT IN DIE BESCHRIFTUNG. In `<caption>` steht der Text
// des Autors, nie „Tab. 3.2:". Die Nummer ist eine Eigenschaft des Ausgabewegs
// (kapitelweise, Kapitel-Scope-Export zaehlt ab 1, Profil ohne Kapitelnummern
// zaehlt buchweit) und entsteht bei jedem Export neu — lib/xref-render.js setzt
// sie, genau wie bei der Abbildungslegende. Waere sie persistiert, truege das
// Manuskript die Zaehlung vom Einfuegetag bis in alle Ewigkeit.
//
// AUSRICHTUNG HAT EINEN TRAEGER: `data-align` an der Zelle, und die Kopfzelle
// ist fuer ihre Spalte autoritativ. Die Alternative (`data-align="l,r,r"` an der
// Tabelle) waere kompakter, aber CSS kann `text-align` nicht aus einer
// Spaltenangabe ableiten — es braucht die Zelle. Zwei Traeger waeren eine
// Drift-Quelle, `style` ist per harter Regel ausgeschlossen.
//
// ZELLEN TRAGEN NUR INLINE-INHALT (Auszeichnung, Quellen-Chip, Querverweis).
// Keine Bloecke, keine verschachtelten Tabellen, kein colspan/rowspan. Der
// Gitter-Dialog erzwingt das ohnehin; fuer den PDF-Messer ist es die Grenze
// zwischen „Spaltenbreiten berechnen" und „Textsatz-Projekt".
//
// Modul ist DOM-agnostisch (Browser-DOM wie linkedom auf dem Server) — darum
// genau eine Implementierung fuer beide Seiten, serverseitig per dynamic
// import() ueber lib/esm-bridge.js geladen (Muster wie cite-html.js).

import { escHtml } from '../utils/escape.js';

export const TABLE_SEL = 'table';

// Ausrichtungen, die eine Spalte tragen kann. `left` ist die Vorgabe und wird
// nicht ins Markup geschrieben.
export const TABLE_ALIGNS = ['left', 'center', 'right'];

// Deckel gegen ein versehentlich eingefuegtes Datenblatt. Der PDF-Messer laeuft
// pro Zelle durch die Umbruchmaschinerie; eine Tabelle mit 20 000 Zellen
// blockiert den Renderer, und im Manuskript hat sie ohnehin nichts verloren.
export const TABLE_MAX_COLS = 24;
export const TABLE_MAX_ROWS = 400;

// Inline-Auszeichnung, die eine Zelle behalten darf. Alles andere fliegt beim
// Auslesen raus — nicht als Sicherheitsschicht (das ist stripActiveContent am
// Schreib-Chokepoint), sondern damit ein aus Word importierter `<font>`-Wald
// nicht durch den Dialog wieder in die Persistenz wandert.
const INLINE_KEEP = new Set(['STRONG', 'B', 'EM', 'I', 'U', 'A', 'BR', 'CODE', 'SUB', 'SUP', 'SPAN']);

/** Ist `el` eine Tabelle? */
export function isTableEl(el) {
  return !!el && el.tagName === 'TABLE';
}

/** Naechste Tabelle ab `node` aufwaerts (Textknoten erlaubt). */
export function closestTableEl(node, root = null) {
  const el = node && node.nodeType === 3 ? node.parentNode : node;
  const hit = el?.closest?.(TABLE_SEL);
  if (!hit) return null;
  if (root && !root.contains(hit)) return null;
  return hit;
}

// ── Auslesen ────────────────────────────────────────────────────────────────

function _normText(s) {
  return String(s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

/** Inline-HTML einer Zelle auf die erlaubte Auszeichnung reduzieren.
 *  Rekursiv: ein nicht erlaubtes Element verschwindet, sein Inhalt bleibt. */
function _inlineHtml(node) {
  let out = '';
  for (const child of Array.from(node.childNodes || [])) {
    if (child.nodeType === 3) {
      out += escHtml(String(child.textContent || '').replace(/ /g, ' '));
      continue;
    }
    if (child.nodeType !== 1) continue;
    const tag = child.tagName;
    if (!INLINE_KEEP.has(tag)) { out += _inlineHtml(child); continue; }
    if (tag === 'BR') { out += '<br>'; continue; }
    // Ein `<span>` ohne Quellen-/Verweis-Marker ist Import-Kruscht und traegt
    // nichts — sein Inhalt bleibt, die Huelle fliegt.
    const cls = String(child.getAttribute?.('class') || '');
    if (tag === 'SPAN' && !/\b(cite|xref)\b/.test(cls)) { out += _inlineHtml(child); continue; }
    const attrs = [];
    if (cls) attrs.push(`class="${escHtml(cls)}"`);
    for (const name of ['href', 'data-src', 'data-loc', 'data-mode', 'data-xref', 'data-xref-id']) {
      const v = child.getAttribute?.(name);
      if (v != null && v !== '') attrs.push(`${name}="${escHtml(String(v))}"`);
    }
    const open = attrs.length ? `<${tag.toLowerCase()} ${attrs.join(' ')}>` : `<${tag.toLowerCase()}>`;
    out += `${open}${_inlineHtml(child)}</${tag.toLowerCase()}>`;
  }
  return out;
}

/** Eine Zelle als Modell: `html` ist die erlaubte Auszeichnung, `text` die
 *  Klartextform fuer den Dialog und fuer die Spaltenbreiten-Schaetzung. */
function _cellModel(td) {
  const html = _inlineHtml(td);
  const text = _normText(td.textContent);
  const align = String(td.getAttribute?.('data-align') || '').toLowerCase();
  return {
    html,
    text,
    align: TABLE_ALIGNS.includes(align) ? align : null,
    // Nur wahr, wenn die Zelle mehr traegt als ihren Klartext. Der Dialog
    // bindet `text`; eine unangetastete Zelle behaelt darum ihr `html`.
    rich: html !== escHtml(text),
  };
}

function _rowCells(tr) {
  return Array.from(tr.children || []).filter(c => c.tagName === 'TD' || c.tagName === 'TH');
}

function _isHeaderRow(tr) {
  const cells = _rowCells(tr);
  return cells.length > 0 && cells.every(c => c.tagName === 'TH');
}

/** Tabelle als Modell lesen. Gegenstueck zu `buildTableHtml` — der Round-Trip
 *  Modell → HTML → Modell ist stabil (gegated in tests/unit/table-html.test.mjs).
 *
 *  Toleriert Import-Markup: fehlendes `<thead>` (erste Ganz-`<th>`-Zeile gilt
 *  als Kopf), fehlendes `<tbody>`, unterschiedlich lange Zeilen (werden auf die
 *  breiteste aufgefuellt).
 *
 *  VERLUSTBEHAFTETE FAELLE werden gemeldet, nicht stillschweigend geschluckt:
 *  `lossy` ist wahr, wenn colspan/rowspan oder Blockinhalt in einer Zelle
 *  wegfallen. Der Dialog warnt damit VOR dem Speichern — eine aus Word
 *  importierte Tabelle mit verbundenen Zellen soll man nicht versehentlich
 *  planieren.
 *
 *  @returns {{ caption: string, align: string[], header: object[]|null,
 *              rows: object[][], lossy: boolean }}
 */
export function tableModel(el) {
  const empty = { caption: '', align: [], header: null, rows: [], lossy: false };
  if (!isTableEl(el)) return empty;

  const capEl = el.querySelector?.('caption');
  const caption = capEl ? _normText(capEl.textContent) : '';

  const trs = Array.from(el.querySelectorAll?.('tr') || []);
  if (!trs.length) return { ...empty, caption };

  let lossy = false;
  const rowsRaw = [];
  for (const tr of trs) {
    const cells = _rowCells(tr);
    for (const c of cells) {
      const cs = parseInt(c.getAttribute?.('colspan') || '1', 10);
      const rs = parseInt(c.getAttribute?.('rowspan') || '1', 10);
      if (cs > 1 || rs > 1) lossy = true;
      if (c.querySelector?.('p,div,ul,ol,table,blockquote,pre,figure')) lossy = true;
    }
    rowsRaw.push({ header: _isHeaderRow(tr), cells: cells.map(_cellModel) });
  }

  // Kopfzeile: die erste Zeile, wenn sie aus `<th>` besteht — egal ob in
  // `<thead>` oder direkt in `<tbody>` (Import-Markup hat oft kein thead).
  let header = null;
  let body = rowsRaw;
  if (rowsRaw[0]?.header) {
    header = rowsRaw[0].cells;
    body = rowsRaw.slice(1);
  }

  const cols = Math.min(TABLE_MAX_COLS, Math.max(
    header ? header.length : 0,
    ...body.map(r => r.cells.length), 1,
  ));
  const rows = body.slice(0, TABLE_MAX_ROWS);
  if (body.length > TABLE_MAX_ROWS) lossy = true;

  const pad = (cells) => {
    const out = cells.slice(0, cols);
    while (out.length < cols) out.push({ html: '', text: '', align: null, rich: false });
    return out;
  };

  // Ausrichtung pro Spalte: die Kopfzelle ist autoritativ. Ohne Kopfzeile
  // gewinnt die erste Zelle der Spalte, die eine Angabe traegt.
  const headerCells = header ? pad(header) : null;
  const bodyRows = rows.map(r => pad(r.cells));
  const align = [];
  for (let c = 0; c < cols; c++) {
    let a = headerCells?.[c]?.align || null;
    if (!a) for (const r of bodyRows) { if (r[c]?.align) { a = r[c].align; break; } }
    align.push(a || 'left');
  }

  return { caption, align, header: headerCells, rows: bodyRows, lossy };
}

/** Alle Tabellen unter `root` in Dokumentreihenfolge, je mit Modell. */
export function collectTables(root) {
  if (!root?.querySelectorAll) return [];
  return Array.from(root.querySelectorAll(TABLE_SEL)).map(el => ({ el, model: tableModel(el) }));
}

/** Zeilen/Spalten einer Tabelle — fuer Plakette und Kurzform im Prompt. */
export function tableSize(el) {
  const m = tableModel(el);
  return { cols: m.align.length, rows: m.rows.length + (m.header ? 1 : 0) };
}

// ── Erzeugen ────────────────────────────────────────────────────────────────

// Letzte Reissleine gegen aktive Inhalte in durchgereichtem Zell-HTML. Die
// tragende Schicht ist stripActiveContent am Schreib-Chokepoint
// (lib/html-clean.js) — hier steht sie, weil `buildTableHtml` auch im Browser
// laeuft und der Dialog `html` aus dem DOM uebernimmt.
function _stripDanger(html) {
  return String(html || '')
    .replace(/<\s*\/?\s*script[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(javascript|vbscript)\s*:/gi, '');
}

/** Zellinhalt einer Modell-Zelle zu HTML.
 *  Eine Zelle darf ein String sein (→ escaped) oder ein Objekt aus
 *  `tableModel`. Bei einem Objekt entscheidet `rich`: unangetastete
 *  Auszeichnung bleibt, sonst gilt der Klartext. */
function _cellHtml(cell) {
  if (cell == null) return '';
  if (typeof cell === 'string') return escHtml(cell);
  if (cell.rich && cell.html) return _stripDanger(cell.html);
  if (typeof cell.text === 'string') return escHtml(cell.text);
  return cell.html ? _stripDanger(cell.html) : '';
}

function _alignAttr(align) {
  const a = String(align || '').toLowerCase();
  return a && a !== 'left' && TABLE_ALIGNS.includes(a) ? ` data-align="${a}"` : '';
}

/** Markup fuer eine Tabelle. Einziger Erzeuger — kein Konsument baut das
 *  `<table>`-Markup selbst zusammen.
 *
 *  `model`: { caption?, align?: string[], header?: cells|null, rows: cells[][] }
 *  Eine Zelle ist ein String oder ein Objekt aus `tableModel`.
 *
 *  `scope="col"` an den Kopfzellen ist Pflicht und kein Detail: es ist die
 *  Angabe, aus der ein Screenreader die Spaltenzuordnung liest, und es traegt
 *  die Barrierefreiheits-Metadaten des EPUB (lib/export-builders/epub.js).
 */
export function buildTableHtml(model) {
  const m = model || {};
  const rows = Array.isArray(m.rows) ? m.rows.slice(0, TABLE_MAX_ROWS) : [];
  const header = Array.isArray(m.header) && m.header.length ? m.header : null;
  const cols = Math.min(TABLE_MAX_COLS, Math.max(
    header ? header.length : 0,
    ...rows.map(r => (Array.isArray(r) ? r.length : 0)), 1,
  ));
  const align = Array.isArray(m.align) ? m.align : [];

  const cell = (tag, c, i) => {
    const attrs = (tag === 'th' ? ' scope="col"' : '') + _alignAttr(align[i]);
    return `<${tag}${attrs}>${_cellHtml(c)}</${tag}>`;
  };
  const row = (cells, tag) => {
    const list = Array.isArray(cells) ? cells.slice(0, cols) : [];
    while (list.length < cols) list.push('');
    return `<tr>${list.map((c, i) => cell(tag, c, i)).join('')}</tr>`;
  };

  const caption = _normText(m.caption);
  const parts = ['<table>'];
  if (caption) parts.push(`<caption>${escHtml(caption)}</caption>`);
  if (header) parts.push(`<thead>${row(header, 'th')}</thead>`);
  parts.push(`<tbody>${rows.map(r => row(r, 'td')).join('')}</tbody>`);
  parts.push('</table>');
  return parts.join('');
}

/** Leeres Modell fuer den Dialog: Kopfzeile plus `rows` Datenzeilen. */
export function emptyTableModel(cols = 3, rows = 2) {
  const c = Math.max(1, Math.min(TABLE_MAX_COLS, parseInt(cols, 10) || 3));
  const r = Math.max(1, Math.min(TABLE_MAX_ROWS, parseInt(rows, 10) || 2));
  const blank = () => ({ html: '', text: '', align: null, rich: false });
  return {
    caption: '',
    align: Array.from({ length: c }, () => 'left'),
    header: Array.from({ length: c }, blank),
    rows: Array.from({ length: r }, () => Array.from({ length: c }, blank)),
    lossy: false,
  };
}

// ── Editor-Laufzeit ─────────────────────────────────────────────────────────

/** Tabellen im contenteditable atomar machen: der Caret springt darueber,
 *  Backspace loescht den Block als Ganzes, bearbeitet wird ausschliesslich im
 *  Gitter-Dialog. Freies Tippen in einer contenteditable-Tabelle laesst
 *  Chromium beim Zell-Merge die berechneten CSS-Werte als Inline-`style`
 *  einbacken — und `style` darf nach der harten Regel „Styles nur in
 *  public/css" nicht in die Persistenz.
 *
 *  Setzt nur Laufzeit-Attribute; `contenteditable` wird beim Speichern von
 *  lib/html-clean.js gestrippt und ist nie persistiert. */
export function markTablesAtomic(root) {
  if (!root?.querySelectorAll) return;
  for (const el of root.querySelectorAll(TABLE_SEL)) {
    el.setAttribute('contenteditable', 'false');
  }
}
