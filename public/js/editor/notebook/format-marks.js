// Steuerzeichen-Overlay für den Notebook-Editor: zeichnet Soft-Break-Pfeile (↵)
// über jedes <br> sowie Absatzmarken (¶) für Blöcke mit direktem <br>. Reine
// Read-only-Dekoration in einer separaten Overlay-Schicht
// (.page-editor-marks-layer) — editierbarer DOM und gespeichertes HTML bleiben
// unberührt (gleiche Philosophie wie die Entity-Highlights). Die ¶ der übrigen
// Blöcke macht CSS allein (page-view.css). Begründung des JS-Pfads: ein <br>
// lässt sich von keinem Browser per CSS/Pseudo-Element dekorieren (kein
// Box-Modell), und die ¶-::after-Marke rutscht in einem Block mit <br> hinter
// den Umbruch auf eine Phantom-Zweitzeile → gemessene Platzierung nötig.
//
// Aktiv nur wenn editMode && !focusActive && pageEditorShowMarks. Recompute via
// rAF-Coalesce bei: Tippen (input), internem Scroll und Grössenänderung
// (ResizeObserver deckt Resize/Fit-Width/Vollbild und Fokus-Ein-/Austritt ab,
// da der Notebook-Editor im Fokus per x-show ausgeblendet wird). Reiner
// Font-Size-Zoom (--editor-zoom) ändert die Editor-Box nicht → die
// pageEditorZoom*-Methoden rufen _scheduleFormatMarks explizit.

import { editorHost } from '../shared/editor-host.js';
import { NORMAL_SELECTOR } from '../shared/active-editor.js';

// Container-Selektor kommt aus shared/active-editor.js (SSoT) — eine zweite
// String-Kopie hier wäre genau die Drift, gegen die der Export dort existiert.
// Bewusst NICHT `getActiveEditorContainer()`: das Marks-Overlay ist
// notebook-only und darf nie auf den Focus-Container umschalten.
const NOTEBOOK_EDIT_SEL = NORMAL_SELECTOR;
const MARKS_LAYER_SEL = '.page-editor-marks-layer';

// Overlay-Layer des Notebook-Editors. Über den Editor-Wrapper gesucht, nicht
// global — sonst träfe ein zweiter Layer (z.B. künftig im Bucheditor) zuerst.
function marksLayer() {
  const editEl = document.querySelector(NOTEBOOK_EDIT_SEL);
  return editEl?.parentElement?.querySelector(MARKS_LAYER_SEL) || null;
}

// White-space-Modi, in denen ein `\n` im Text ein echter Zeilenumbruch ist.
const PRESERVING_WS = /^(pre|pre-wrap|pre-line|break-spaces)$/;
// Blöcke, die Newlines als Zeichen tragen statt als <br> (Gedichte, Code).
// Vorfilter für den Textknoten-Walk: ohne ihn liefe getComputedStyle pro
// Textknoten der ganzen Seite — bei jedem Tastendruck.
const PRESERVING_BLOCK_SEL = 'div.poem, pre';

// Auto-Slot-<br> als einziges Kind eines leeren Text-Blocks ist strukturell
// (Caret-Slot, vgl. ensureTrailingParagraph) — kein echter Zeilenumbruch, keine
// Marke.
function isCaretFiller(br) {
  const p = br.parentElement;
  return !!p && p.childNodes.length === 1 && /^(P|H[1-6]|LI)$/.test(p.tagName);
}

// Nachgestelltes <br> als letztes (sichtbares) Kind eines Text-Blocks: der
// Browser rendert es inert — keine sichtbare Folgezeile, das Rect kollabiert ans
// Zeilenende. Kein ↵; die ¶ des Blocks (Schritt 3) markiert dort bereits das
// Absatzende. Ohne dieses Skip lägen ↵ und ¶ übereinander (ein einziges,
// verschmolzenes Glyph). Mitten im Block (<p>…<br>…</p>) bleibt das <br> ein
// echter Umbruch und behält sein ↵.
function isTrailingBr(br) {
  for (let n = br.nextSibling; n; n = n.nextSibling) {
    if (n.nodeType === 3 && !n.nodeValue.trim()) continue; // nur Whitespace folgt
    return false;
  }
  const p = br.parentElement;
  return !!p && /^(P|H[1-6]|LI|PRE)$/.test(p.tagName);
}

export const formatMarksMethods = {
  _renderFormatMarks() {
    const app = editorHost();
    const editEl = document.querySelector(NOTEBOOK_EDIT_SEL);
    if (!editEl) return;
    const layer = editEl.parentElement?.querySelector(MARKS_LAYER_SEL);
    if (!layer) return;

    const active = !!(app?.pageEditorShowMarks && app?.editMode && !app?.focusActive);
    if (!active) { layer.replaceChildren(); layer.hidden = true; return; }

    const editRect = editEl.getBoundingClientRect();
    // Overlay exakt über die Border-Box des Editors legen (offsetParent =
    // .page-editor-wrap, position:relative). overflow:hidden clippt Pfeile, die
    // durch den internen Scroll aus dem Sichtfenster laufen.
    layer.style.left = editEl.offsetLeft + 'px';
    layer.style.top = editEl.offsetTop + 'px';
    layer.style.width = editEl.offsetWidth + 'px';
    layer.style.height = editEl.offsetHeight + 'px';
    layer.style.fontSize = getComputedStyle(editEl).fontSize;
    layer.hidden = false;

    const range = document.createRange();
    const frag = document.createDocumentFragment();
    // Marke an einer gemessenen Position platzieren. height = Zeilenhöhe, damit
    // die CSS-Mittelzentrierung (.format-mark) das Glyph vertikal auf Textmitte
    // legt statt an den oberen Rand der Zeile.
    const mark = (cls, char, left, top, height) => {
      const m = document.createElement('span');
      m.className = 'format-mark ' + cls;
      m.textContent = char;
      m.style.left = (left - editRect.left) + 'px';
      m.style.top = (top - editRect.top) + 'px';
      m.style.height = height + 'px';
      frag.appendChild(m);
    };
    const place = (r) => {
      if (!r || !r.height) return; // degenerierte Messung überspringen
      mark('format-mark--br', '↵', r.left, r.top, r.height);
    };

    // 1) Echte <br>-Elemente (Soft-Break via Shift+Enter).
    editEl.querySelectorAll('br').forEach((br) => {
      if (isCaretFiller(br) || isTrailingBr(br)) return;
      range.selectNode(br);
      place(range.getBoundingClientRect());
    });

    // 2) \n-Zeilenumbrüche in Blöcken, die Newlines erhalten (white-space:
    //    pre-line/pre/pre-wrap) — Gedichte (div.poem) und <pre> haben kein
    //    <br>, der Umbruch steckt als Zeichen im Text. Nur diese Blöcke werden
    //    durchlaufen (statt aller Textknoten des Editors), und getComputedStyle
    //    läuft einmal pro Block statt einmal pro Textknoten.
    editEl.querySelectorAll(PRESERVING_BLOCK_SEL).forEach((blk) => {
      if (!PRESERVING_WS.test(getComputedStyle(blk).whiteSpace)) return;
      const walker = document.createTreeWalker(blk, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.nodeValue;
        if (!text || text.indexOf('\n') === -1) continue;
        for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          place(range.getClientRects()[0]);
        }
      }
    });

    // 3) Absatzmarken (¶) für Blöcke mit direktem <br>. CSS lässt die bewusst
    //    aus (`:not(:has(> br))`), weil ::after hinter dem <br> auf eine
    //    Phantom-Zweitzeile rutscht → verdoppelt die Blockhöhe und entkoppelt
    //    die sichtbare Marke vom Caret-Slot. Hier gemessen platziert: leerer
    //    Caret-Slot-Block (<p><br></p>) → ¶ auf der Slot-Zeile am Block-Anfang;
    //    Soft-Break-Absatz (<p>…<br>…</p>) → ¶ am Ende der letzten Zeile.
    editEl.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, pre').forEach((b) => {
      let hasDirectBr = false;
      for (const c of b.children) { if (c.tagName === 'BR') { hasDirectBr = true; break; } }
      if (!hasDirectBr) return; // Rest macht CSS ::after
      let r;
      let atEnd = true;
      if (b.childNodes.length === 1) {
        // Leerer Caret-Slot-Block: ¶ am Slot (Zeilenanfang), einzeilig.
        range.selectNode(b.firstChild);
        r = range.getBoundingClientRect();
        atEnd = false;
      } else {
        range.selectNodeContents(b);
        const rects = range.getClientRects();
        r = rects[rects.length - 1];
      }
      if (!r || !r.height) return;
      // Kleiner Abstand wie das CSS-`margin-inline-start: 0.15em` am Zeilenende;
      // am leeren Slot direkt auf die Caret-Position (kein Versatz).
      mark('format-mark--pilcrow', '¶', (atEnd ? r.right + 2 : r.left), r.top, r.height);
    });

    layer.replaceChildren(frag);
  },

  _scheduleFormatMarks() {
    if (this._formatMarksRaf) return;
    this._formatMarksRaf = requestAnimationFrame(() => {
      this._formatMarksRaf = null;
      this._renderFormatMarks();
    });
  },

  _installFormatMarks() {
    const editEl = document.querySelector(NOTEBOOK_EDIT_SEL);
    if (!editEl) return;
    this._uninstallFormatMarks();
    const abort = new AbortController();
    this._formatMarksAbort = abort;
    const onChange = () => this._scheduleFormatMarks();
    editEl.addEventListener('input', onChange, { signal: abort.signal });
    editEl.addEventListener('scroll', onChange, { signal: abort.signal, passive: true });
    try {
      this._formatMarksRO = new ResizeObserver(() => this._scheduleFormatMarks());
      this._formatMarksRO.observe(editEl);
    } catch { this._formatMarksRO = null; }
    this._scheduleFormatMarks();
  },

  _uninstallFormatMarks() {
    if (this._formatMarksRaf) { cancelAnimationFrame(this._formatMarksRaf); this._formatMarksRaf = null; }
    this._formatMarksRO?.disconnect?.();
    this._formatMarksRO = null;
    this._formatMarksAbort?.abort?.();
    this._formatMarksAbort = null;
    const layer = marksLayer();
    if (layer) { layer.replaceChildren(); layer.hidden = true; }
  },
};
