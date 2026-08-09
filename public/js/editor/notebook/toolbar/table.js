// Tabellen-Dialog des Notebook-Editors: ein Gitter aus Zellenfeldern plus
// Beschriftung und Spaltenausrichtung.
//
// Warum ein Dialog und keine bearbeitbare Tabelle im Manuskript: Chromium baeckt
// beim Verschmelzen von Zellen die berechneten CSS-Werte als Inline-`style` ein
// (dieselbe Ursache wie bei den Blockgrenzen von figure/blockquote/pre, siehe
// harte Regel „Loeschen an Blockgrenzen"), und `style` darf nach der Regel
// „Styles nur in public/css" nicht in die Persistenz. Dazu kaeme die
// Zell-Selektion, das Loeschen ueber Zellgrenzen und ein eigener Undo-Pfad. Der
// persistierte Block ist deshalb atomar (`contenteditable="false"`,
// markTablesAtomic) und wird ausschliesslich hier bearbeitet.
//
// Der Dialog gehoert zum Karten-Scope (editorToolbarCard), also `x-ref` +
// showModal() statt des `modal()`-Primitivs, und `@close` ist der EINZIGE
// Aufraeumpunkt — ESC, Backdrop und Abbrechen laufen alle durch `dlg.close()`.
//
// EINGABE IST NOTEBOOK-ONLY (wie beim Diagramm). Focus-Editor und Bucheditor
// stellen Tabellen nur dar.

import { getEditEl } from '../../utils.js';
import { htmlToElement } from './caret-panel.js';
import {
  buildTableHtml, tableModel, emptyTableModel,
  TABLE_ALIGNS, TABLE_MAX_COLS, TABLE_MAX_ROWS,
} from '../../../table/table-html.js';

// Startgroesse einer neuen Tabelle. Drei Spalten, weil zwei nach Liste aussehen
// und vier auf dem Handy nicht mehr lesbar sind; zwei Datenzeilen, damit die
// Kopfzeile als solche erkennbar ist.
const NEW_COLS = 3;
const NEW_ROWS = 2;

export const tableMethods = {
  /** Einfuegen: `block` ist der (leere) Trigger-Block aus dem Slash-Menue, der
   *  beim Bestaetigen ersetzt wird. */
  openTableDialog(block) {
    this._tableBlock = block || null;
    this._tableEditEl = null;
    this.tableEditing = false;
    this.tableLossy = false;
    this.tableModelState = emptyTableModel(NEW_COLS, NEW_ROWS);
    this._openTableDlg();
  },

  /** Bearbeiten: `el` ist eine bestehende `<table>` im Manuskript. */
  openTableForEl(el) {
    if (!el) return;
    this._tableBlock = null;
    this._tableEditEl = el;
    this.tableEditing = true;
    const m = tableModel(el);
    // Eine Tabelle ohne Kopfzeile (Import-Markup) bekommt im Dialog keine
    // aufgezwungen — sonst wuerde die erste Datenzeile zur Ueberschrift.
    this.tableModelState = m.rows.length ? m : emptyTableModel(NEW_COLS, NEW_ROWS);
    // Verlustbehaftete Faelle (verbundene Zellen, Blockinhalt) VOR dem
    // Speichern ansagen. Der Dialog kann sie nicht darstellen; wer hier
    // uebernimmt, planiert sie. Das soll eine Entscheidung sein, keine
    // Ueberraschung.
    this.tableLossy = !!m.lossy;
    this._openTableDlg();
  },

  _openTableDlg() {
    const dlg = this.$refs?.tableDlg;
    if (!dlg) return;
    if (!dlg.open) dlg.showModal();
    queueMicrotask(() => this.$refs?.tableCaptionInput?.focus());
  },

  closeTableDialog() {
    this.$refs?.tableDlg?.close();
  },

  /** Einziger Aufraeumpunkt (siehe Modulkopf). */
  onTableDialogClose() {
    this._tableBlock = null;
    this._tableEditEl = null;
    this.tableEditing = false;
    this.tableLossy = false;
    this.tableModelState = emptyTableModel(NEW_COLS, NEW_ROWS);
    getEditEl()?.focus();
  },

  // ── Gitter-Struktur ───────────────────────────────────────────────────────

  tableCols() {
    return this.tableModelState?.align?.length || 0;
  },

  tableCanAddCol() { return this.tableCols() < TABLE_MAX_COLS; },
  tableCanAddRow() { return (this.tableModelState?.rows?.length || 0) < TABLE_MAX_ROWS; },
  tableCanRemoveCol() { return this.tableCols() > 1; },
  tableCanRemoveRow() { return (this.tableModelState?.rows?.length || 0) > 1; },

  _blankCell() {
    return { html: '', text: '', align: null, rich: false };
  },

  tableAddCol() {
    const m = this.tableModelState;
    if (!m || !this.tableCanAddCol()) return;
    m.align.push('left');
    if (m.header) m.header.push(this._blankCell());
    for (const r of m.rows) r.push(this._blankCell());
  },

  tableRemoveCol(i) {
    const m = this.tableModelState;
    if (!m || !this.tableCanRemoveCol()) return;
    m.align.splice(i, 1);
    if (m.header) m.header.splice(i, 1);
    for (const r of m.rows) r.splice(i, 1);
  },

  tableAddRow() {
    const m = this.tableModelState;
    if (!m || !this.tableCanAddRow()) return;
    m.rows.push(Array.from({ length: this.tableCols() }, () => this._blankCell()));
  },

  tableRemoveRow(i) {
    const m = this.tableModelState;
    if (!m || !this.tableCanRemoveRow()) return;
    m.rows.splice(i, 1);
  },

  /** Kopfzeile an-/abschalten. Beim Abschalten wandert sie NICHT in die Daten —
   *  wer den Kopf entfernt, will ihn weg; ihn als Datenzeile weiterzuschleppen
   *  waere eine Ueberraschung. */
  tableToggleHeader() {
    const m = this.tableModelState;
    if (!m) return;
    m.header = m.header ? null : Array.from({ length: this.tableCols() }, () => this._blankCell());
  },

  tableHasHeader() {
    return !!this.tableModelState?.header;
  },

  // ── Zellen + Ausrichtung ──────────────────────────────────────────────────

  /** Zelltext setzen. `rich` faellt dabei auf false: wer den Text aendert,
   *  ersetzt die Auszeichnung der Zelle (SSoT-Regel in table-html.js). Eine
   *  unangetastete Zelle behaelt ihr `html`. */
  tableSetCell(cell, value) {
    if (!cell) return;
    const next = String(value ?? '');
    if (next === cell.text) return;
    cell.text = next;
    cell.rich = false;
    cell.html = '';
  },

  tableSetAlign(i, align) {
    const m = this.tableModelState;
    if (!m || !TABLE_ALIGNS.includes(align)) return;
    m.align[i] = align;
  },

  tableAlignOptions() {
    const app = window.__app;
    return TABLE_ALIGNS.map(a => ({ value: a, label: app?.t?.('editor.table.align.' + a) || a }));
  },

  /** Ist die Tabelle leer? Beschriftung allein zaehlt nicht — eine Beschriftung
   *  ohne Tabelle ist keine Tabelle. */
  tableIsEmpty() {
    const m = this.tableModelState;
    if (!m) return true;
    const cells = [...(m.header || []), ...m.rows.flat()];
    return !cells.some(c => String(c?.text || '').trim() || (c?.rich && c?.html));
  },

  // ── Uebernehmen / Entfernen ───────────────────────────────────────────────

  /** Uebernehmen. Eine leere Tabelle wird verworfen statt eingefuegt — sie
   *  waere im Manuskript ein Rahmen ohne Inhalt, und der Weg zurueck fuehrt
   *  wieder durch diesen Dialog. */
  applyTable() {
    if (this.tableIsEmpty()) { this.closeTableDialog(); return; }

    const editEl = getEditEl();
    if (!editEl) { this.closeTableDialog(); return; }

    const node = htmlToElement(buildTableHtml(this.tableModelState));
    if (!node) { this.closeTableDialog(); return; }
    node.setAttribute('contenteditable', 'false');

    const target = this._tableEditEl || this._tableBlock;
    if (target && target.isConnected && target.parentNode && editEl.contains(target)) {
      target.parentNode.replaceChild(node, target);
    } else {
      editEl.appendChild(node);
    }
    // Ein atomarer Block am Dokumentende liesse keinen Caret-Anker uebrig —
    // dieselbe Lage wie bei `<hr>`, `<figure>` und dem Diagramm.
    if (!node.nextElementSibling) {
      const p = document.createElement('p');
      p.appendChild(document.createElement('br'));
      node.insertAdjacentElement('afterend', p);
    }
    window.__app?._markEditDirty?.();
    this.closeTableDialog();
  },

  /** Tabelle loeschen (nur im Bearbeiten-Modus sichtbar). Der Block ist atomar,
   *  ohne diesen Weg gaebe es keinen verlaesslichen. */
  removeTable() {
    const el = this._tableEditEl;
    if (el?.isConnected) {
      el.remove();
      window.__app?._markEditDirty?.();
    }
    this.closeTableDialog();
  },
};
