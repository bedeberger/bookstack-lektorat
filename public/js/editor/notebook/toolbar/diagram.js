// Diagramm-Dialog des Notebook-Editors: Quelltext links, Live-Vorschau rechts.
//
// Warum ein Dialog und kein Inline-Block wie Gedicht oder Blockzitat:
// Diagramm-Code ist mehrzeilig und einrueckungsempfindlich. Chromium erzeugt in
// einem `<pre>` im contenteditable pro Enter eine `<div>`-Zeile und baeckt beim
// Verschmelzen von Bloecken berechnete CSS-Werte als Inline-`style` ein (siehe
// harte Regel „Loeschen an Blockgrenzen") — der Code waere nach wenigen
// Handgriffen kaputt. Der persistierte Block ist deshalb atomar
// (`contenteditable="false"`, markDiagramsAtomic) und wird ausschliesslich hier
// bearbeitet.
//
// Der Dialog gehoert zum Karten-Scope (editorToolbarCard), also `x-ref` +
// showModal() statt des `modal()`-Primitivs, und `@close` ist der EINZIGE
// Aufraeumpunkt — ESC, Backdrop und Abbrechen laufen alle durch `dlg.close()`.

import { getEditEl } from '../../utils.js';
import { htmlToElement } from './caret-panel.js';
import { buildDiagramHtml, diagramCode, DIAGRAM_MAX_CHARS } from '../../../diagram/mermaid-html.js';
import { renderDiagramSvg } from '../../../diagram/mermaid-view.js';

// Vorschau erst, wenn der Nutzer kurz innehaelt. Jeder Tastendruck durch den
// mermaid-Parser zu jagen laesst die Eingabe haken, und ein halbfertiger Graph
// ist ohnehin meistens ungueltig.
const PREVIEW_DEBOUNCE_MS = 450;

// Startvorlagen. Ein leeres Feld vor einer Diagrammsprache ist eine Sackgasse —
// die vier decken ab, was in Sachbuch und Manuskript tatsaechlich vorkommt.
// Bewusst kurz: sie sollen als Beispiel gelesen und ueberschrieben werden.
export const DIAGRAM_TEMPLATES = [
  { key: 'flow', code: 'flowchart TD\n  A[Ausgangslage] --> B{Entscheidung}\n  B -->|ja| C[Folge A]\n  B -->|nein| D[Folge B]' },
  { key: 'sequence', code: 'sequenceDiagram\n  Anna->>Berta: Frage\n  Berta-->>Anna: Antwort' },
  { key: 'timeline', code: 'timeline\n  title Ablauf\n  1904 : Erste Station\n  1912 : Zweite Station' },
  { key: 'mindmap', code: 'mindmap\n  root((Thema))\n    Ast eins\n    Ast zwei' },
];

export const diagramMethods = {
  /** Einfuegen: `block` ist der (leere) Trigger-Block aus dem Slash-Menue, der
   *  beim Bestaetigen ersetzt wird. */
  openDiagramDialog(block) {
    this._diagramBlock = block || null;
    this._diagramEditEl = null;
    this.diagramEditing = false;
    this.diagramSource = '';
    this.diagramError = '';
    this._openDiagramDlg();
  },

  /** Bearbeiten: `el` ist ein bestehender `pre.mermaid`. */
  openDiagramForEl(el) {
    if (!el) return;
    this._diagramBlock = null;
    this._diagramEditEl = el;
    this.diagramEditing = true;
    this.diagramSource = diagramCode(el);
    this.diagramError = '';
    this._openDiagramDlg();
    this._schedDiagramPreview(0);
  },

  _openDiagramDlg() {
    const dlg = this.$refs?.diagramDlg;
    if (!dlg) return;
    if (!dlg.open) dlg.showModal();
    // Fokus in den Quelltext, nicht auf den ersten Button — der Nutzer will
    // tippen, nicht klicken.
    queueMicrotask(() => this.$refs?.diagramInput?.focus());
  },

  closeDiagramDialog() {
    this.$refs?.diagramDlg?.close();
  },

  /** Einziger Aufraeumpunkt (siehe Modulkopf). */
  onDiagramDialogClose() {
    if (this._diagramPreviewTimer) {
      clearTimeout(this._diagramPreviewTimer);
      this._diagramPreviewTimer = null;
    }
    this._diagramBlock = null;
    this._diagramEditEl = null;
    this.diagramEditing = false;
    this.diagramSource = '';
    this.diagramError = '';
    this.diagramPreviewing = false;
    const host = this.$refs?.diagramPreview;
    if (host) host.replaceChildren();
    getEditEl()?.focus();
  },

  diagramApplyTemplate(key) {
    const tpl = DIAGRAM_TEMPLATES.find(t => t.key === key);
    if (!tpl) return;
    this.diagramSource = tpl.code;
    this._schedDiagramPreview(0);
    this.$refs?.diagramInput?.focus();
  },

  diagramTemplateList() {
    const app = window.__app;
    return DIAGRAM_TEMPLATES.map(t => ({
      key: t.key,
      label: app?.t?.('editor.diagram.tpl.' + t.key) || t.key,
    }));
  },

  onDiagramInput() {
    this._schedDiagramPreview(PREVIEW_DEBOUNCE_MS);
  },

  _schedDiagramPreview(delay) {
    if (this._diagramPreviewTimer) clearTimeout(this._diagramPreviewTimer);
    this._diagramPreviewTimer = setTimeout(() => {
      this._diagramPreviewTimer = null;
      this._renderDiagramPreview();
    }, delay);
  },

  async _renderDiagramPreview() {
    const host = this.$refs?.diagramPreview;
    if (!host) return;
    const code = (this.diagramSource || '').trim();
    if (!code) {
      host.replaceChildren();
      this.diagramError = '';
      return;
    }
    if (code.length > DIAGRAM_MAX_CHARS) {
      host.replaceChildren();
      this.diagramError = window.__app?.t?.('editor.diagram.tooLong', { max: DIAGRAM_MAX_CHARS }) || '';
      return;
    }
    this.diagramPreviewing = true;
    // Jeder Lauf bekommt eine Nummer — tippt der Nutzer weiter, waehrend ein
    // Render laeuft, darf dessen spaeter eintreffendes Ergebnis die neuere
    // Vorschau nicht ueberschreiben.
    const run = (this._diagramPreviewRun = (this._diagramPreviewRun || 0) + 1);
    try {
      const svg = await renderDiagramSvg(code, 'mmd-preview-' + run);
      if (run !== this._diagramPreviewRun) return;
      // mermaid liefert im securityLevel 'strict' bereits bereinigtes SVG.
      host.innerHTML = svg;
      this.diagramError = '';
    } catch (err) {
      if (run !== this._diagramPreviewRun) return;
      host.replaceChildren();
      // Die Meldung von mermaid nennt Zeile und Zeichen — genau das, was beim
      // Korrigieren hilft. Als textContent, nicht als HTML: sie enthaelt Teile
      // des Quelltexts.
      this.diagramError = String(err?.message || '').split('\n')[0]
        || window.__app?.t?.('editor.diagram.invalid') || '';
    } finally {
      if (run === this._diagramPreviewRun) this.diagramPreviewing = false;
    }
  },

  /** Uebernehmen. Ein ungueltiges Diagramm wird bewusst NICHT abgelehnt: der
   *  Quelltext ist die Wahrheit, und ein halbfertiger Graph, den man morgen
   *  weiterschreibt, darf im Manuskript stehen. Er zeigt dann eben seinen Code
   *  statt eines Bildes. Verhindert wird nur das Leere und das Uferlose. */
  applyDiagram() {
    const code = (this.diagramSource || '').trim();
    if (!code) { this.closeDiagramDialog(); return; }
    if (code.length > DIAGRAM_MAX_CHARS) return;

    const editEl = getEditEl();
    if (!editEl) { this.closeDiagramDialog(); return; }

    const node = htmlToElement(buildDiagramHtml(code));
    if (!node) { this.closeDiagramDialog(); return; }
    node.setAttribute('contenteditable', 'false');

    const target = this._diagramEditEl || this._diagramBlock;
    if (target && target.isConnected && target.parentNode && editEl.contains(target)) {
      target.parentNode.replaceChild(node, target);
    } else {
      editEl.appendChild(node);
    }
    // Ein atomarer Block am Dokumentende liesse keinen Caret-Anker uebrig —
    // dieselbe Lage wie bei `<hr>` und `<figure>`.
    if (!node.nextElementSibling) {
      const p = document.createElement('p');
      p.appendChild(document.createElement('br'));
      node.insertAdjacentElement('afterend', p);
    }
    window.__app?._markEditDirty?.();
    this.closeDiagramDialog();
  },

  /** Diagramm loeschen (nur im Bearbeiten-Modus sichtbar). Der Block ist atomar,
   *  ohne diesen Weg gaebe es keinen — Backspace davor loescht ihn zwar, setzt
   *  aber voraus, dass man den Caret ueberhaupt dorthin bekommt. */
  removeDiagram() {
    const el = this._diagramEditEl;
    if (el?.isConnected) {
      el.remove();
      window.__app?._markEditDirty?.();
    }
    this.closeDiagramDialog();
  },
};
