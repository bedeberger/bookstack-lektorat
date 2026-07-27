// Teil von notebookEditMethods (siehe Facade edit.js).
import { EVT, ZOOM_MAX, ZOOM_MIN, editorHost, findBlock, runQuoteNormalize, writeEditorPrefs } from './_shared.js';

export const viewMethods = {

  // Alle Layout-Prefs am Stück persistieren. SSoT für die vier Toggles/Zoom-
  // Aktionen: würde jeder Aufrufer das Objekt selbst zusammenbauen, löscht eine
  // vergessene Property die anderen Prefs still (JSON wird komplett ersetzt).
  _persistEditorPrefs() {
    const app = editorHost();
    if (!app) return;
    writeEditorPrefs({
      fullscreen: app.pageEditorFullscreen,
      fitWidth: app.pageEditorFitWidth,
      showMarks: app.pageEditorShowMarks,
      zoom: app.pageEditorZoom,
    });
  },


  togglePageEditorFullscreen() {
    const app = editorHost();
    if (!app) return;
    app.pageEditorFullscreen = !app.pageEditorFullscreen;
    this._persistEditorPrefs();
  },


  // Fit-Width ist Pure-CSS (Container-Query in page-view.css). Toggle ändert
  // nur die Klasse; Font-Scaling übernimmt cqi-Calc. Manueller Zoom (--editor-zoom)
  // multipliziert sich orthogonal — beim Toggle hier nicht angefasst.
  togglePageEditorFitWidth() {
    const app = editorHost();
    if (!app) return;
    app.pageEditorFitWidth = !app.pageEditorFitWidth;
    this._persistEditorPrefs();
  },


  // Steuerzeichen-Anzeige (Absatzmarken ¶ + Soft-Break ↵). Reiner Klassen-
  // Toggle auf dem contenteditable — die Marken sind CSS-Pseudo-Elemente
  // (page-view.css), kein Markup im gespeicherten HTML, kein Caret-Slot.
  togglePageEditorShowMarks() {
    const app = editorHost();
    if (!app) return;
    app.pageEditorShowMarks = !app.pageEditorShowMarks;
    this._persistEditorPrefs();
    if (app.pageEditorShowMarks) this._installFormatMarks();
    else this._uninstallFormatMarks();
  },


  // Zoom-Stufen. Persistiert wie die übrigen Layout-Prefs — der Editor soll
  // beim nächsten Eintritt in der gewählten Schriftgrösse öffnen.
  _setPageEditorZoom(value) {
    const app = editorHost();
    if (!app) return;
    app.pageEditorZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value * 100) / 100));
    this._persistEditorPrefs();
    this._scheduleFormatMarks?.();
  },


  pageEditorZoomIn() { this._setPageEditorZoom((editorHost()?.pageEditorZoom ?? 1) + 0.1); },


  pageEditorZoomOut() { this._setPageEditorZoom((editorHost()?.pageEditorZoom ?? 1) - 0.1); },


  pageEditorZoomReset() { this._setPageEditorZoom(1); },


  async normalizeQuotes() {
    const app = editorHost();
    if (!Alpine.store('nav').selectedBookId) return;
    const editEl = this._getEditEl();
    if (!editEl) return;
    const { ok, count } = await runQuoteNormalize({
      bookId: Alpine.store('nav').selectedBookId,
      rootEl: editEl,
    });
    if (!ok) return;
    if (count > 0) {
      app._markEditDirty?.();
      editEl.dispatchEvent(new Event('input', { bubbles: true }));
    }
    app.quotesNormalizedFlash = { count };
    if (app._quotesFlashTimer) clearTimeout(app._quotesFlashTimer);
    app._quotesFlashTimer = setTimeout(() => {
      app.quotesNormalizedFlash = null;
      app._quotesFlashTimer = null;
    }, 1800);
    window.dispatchEvent(new CustomEvent(EVT.LANGUAGETOOL_RECHECK));
  },


  // Trennlinie (<hr>) am Caret einfügen + Folge-Absatz für Weiterschreiben.
  // Verhalten: leerer Block → ersetzen; sonst → nach Block einfügen.
  // Trigger: Toolbar-Button + Cmd/Ctrl+Shift+H (siehe editor/toolbar.js).
  insertHorizontalRule() {
    const editEl = this._getEditEl();
    if (!editEl) return;
    editEl.focus();
    const sel = document.getSelection();
    // Block-Lookup über shared/dom-block.js — gleiche Definition wie der
    // Keydown-Dispatcher der Toolbar (vorher zwei Selektor-Kopien).
    const block = (sel && sel.rangeCount)
      ? findBlock(sel.getRangeAt(0).startContainer, editEl)
      : null;
    const hr = document.createElement('hr');
    const next = document.createElement('p');
    next.appendChild(document.createElement('br'));
    if (!block) {
      editEl.appendChild(hr);
      editEl.appendChild(next);
    } else if ((block.textContent || '').trim() === '') {
      block.parentNode.replaceChild(hr, block);
      hr.insertAdjacentElement('afterend', next);
    } else {
      block.insertAdjacentElement('afterend', hr);
      hr.insertAdjacentElement('afterend', next);
    }
    const range = document.createRange();
    range.setStart(next, 0);
    range.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(range);
    this._markEditDirty?.();
  },
};
