// editorToolbarCard: Bubble-Toolbar (Inline-Formate auf Selektion) + Link-Bar.
// `this` = Sub-Komponente (editorToolbarCard), Root-Zugriffe via window.__app.
// Im Fokus-Modus deaktiviert (Guards + `!$app.focusActive` im Template).

import { getEditEl, WORD_RE, _normalizeLinkUrl, _applyLinkAtRange, caretRangeIn, findAnchor } from './_shared.js';
import { panelAnchorFor } from './caret-panel.js';

export const bubbleMethods = {
  _updateBubble() {
    const app = window.__app;
    if (!app?.editMode || app.focusActive) { this.bubbleShow = false; return; }
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      this.bubbleShow = false;
      return;
    }
    const range = caretRangeIn(getEditEl());
    if (!range) { this.bubbleShow = false; return; }
    // Bewusst OHNE `panelAnchorFor`: dessen Block-Fallback ist für kollabierte
    // Ranges gedacht. Die Bubble hängt an einer echten Selektion — hat die kein
    // Rechteck, gibt es nichts zu betonen und sie bleibt aus.
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      this.bubbleShow = false;
      return;
    }
    this.bubbleX = rect.left + rect.width / 2;
    this.bubbleY = rect.top;
    this.bubbleShow = true;
    const text = sel.toString().trim();
    this.bubbleSingleWord = !!text && WORD_RE.test(text);
  },

  _applyInline(command) {
    const editEl = getEditEl();
    if (!editEl) return;
    editEl.focus();
    document.execCommand(command, false);
    window.__app?._markEditDirty?.();
    this.$nextTick(() => this._updateBubble());
  },

  toolbarBold()   { this._applyInline('bold'); },
  toolbarItalic() { this._applyInline('italic'); },

  // ── Link-Bar ─────────────────────────────────────────────────────────
  // Cmd/Ctrl+Shift+K oder Bubble-Link-Button öffnet teleportierten Input
  // an Selektion/Caret. Range wird beim Öffnen geclont, weil das Fokussieren
  // des Inputs die Editor-Selection verliert. Sitzt der Caret/die Selektion in
  // einem bestehenden <a>, wird dessen href vorbefüllt, die Range auf den ganzen
  // Link expandiert (damit Commit/Entfernen ihn trifft) und der Entfernen-Button
  // gezeigt.
  openLinkInput() {
    const app = window.__app;
    if (!app?.editMode || app.focusActive) return;
    const editEl = getEditEl();
    if (!editEl) return;
    const range = caretRangeIn(editEl);
    if (!range) return;
    const sel = document.getSelection();

    const anchor = findAnchor(range.startContainer, editEl)
      || (!range.collapsed ? findAnchor(range.endContainer, editEl) : null);
    if (anchor) {
      const aRange = document.createRange();
      aRange.selectNode(anchor);
      this._linkRange = aRange;
      this.linkUrl = anchor.getAttribute('href') || '';
      this.linkCanRemove = true;
    } else {
      this._linkRange = range.cloneRange();
      const selText = sel.toString().trim();
      this.linkUrl = /^(https?:|mailto:)/i.test(selText) ? selText : '';
      this.linkCanRemove = false;
    }

    const { x, y } = panelAnchorFor(this._linkRange, editEl);
    this.linkX = x;
    this.linkY = y;

    this.bubbleShow = false;
    this.linkShow = true;
    this.$nextTick(() => {
      const inp = this.$refs?.linkInput;
      if (inp) { inp.focus(); inp.select(); }
    });
  },

  _commitLink() {
    const editEl = getEditEl();
    const range = this._linkRange;
    const raw = (this.linkUrl || '').trim();
    if (!editEl || !range || !raw) { this._closeLink(); return; }
    const url = _normalizeLinkUrl(raw);
    if (!url) { this._closeLink(); return; }

    editEl.focus();
    const sel = document.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
    _applyLinkAtRange(range, url);
    window.__app?._markEditDirty?.();
    this._closeLink();
  },

  // Bestehenden Link entfernen: Selektion auf die (beim Öffnen expandierte)
  // Anchor-Range setzen, execCommand('unlink') strippt das <a>, Text bleibt.
  _removeLink() {
    const editEl = getEditEl();
    const range = this._linkRange;
    if (!editEl || !range) { this._closeLink(); return; }
    editEl.focus();
    const sel = document.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
    document.execCommand('unlink', false);
    window.__app?._markEditDirty?.();
    this._closeLink();
  },

  _closeLink() {
    this.linkShow = false;
    this.linkUrl = '';
    this.linkCanRemove = false;
    this._linkRange = null;
    getEditEl()?.focus();
  },

  // Bewusst NICHT `onPickerKeydown` aus caret-panel.js: die Link-Bar hat keine
  // Trefferliste, sondern ein freies URL-Feld. Der Picker-Vertrag fängt ↑/↓ ab
  // und nähme dem User damit die Cursor-Navigation in der eigenen Eingabe.
  _onLinkKeydown(e) {
    if (e.key === 'Enter') { e.preventDefault(); this._commitLink(); return; }
    if (e.key === 'Escape') { e.preventDefault(); this._closeLink(); return; }
  },
};
