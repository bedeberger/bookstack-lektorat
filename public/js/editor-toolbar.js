// Edit-Modus-Toolbar: Bubble (Inline-Formate auf Selektion) + Slash-Menü
// (Block-Transforms). Beides als teleportierte Templates in
// editor-toolbar.html; die Methoden hier werden in die Alpine-Root gespread.
//
// Tabu im Fokus-Modus: alle Aktionen und Trigger-Handler sind über
// `!this.focusMode` gegated – die Partial-Instanz lebt weiter, reagiert
// aber nicht mehr.

// Blocktyp-Definitionen für Slash-Transform. `tag` ist das Zielelement;
// `className` optional (aktuell nur für .poem). `list: true` wrappt den
// Inhalt in ein <li>.
const SLASH_ITEMS = [
  { key: 'paragraph',  tag: 'p' },
  { key: 'h2',         tag: 'h2' },
  { key: 'h3',         tag: 'h3' },
  { key: 'blockquote', tag: 'blockquote', wrapP: true },
  { key: 'poem',       tag: 'div', className: 'poem', wrapP: true },
  { key: 'list',       tag: 'ul', list: true },
  { key: 'hr',         tag: 'hr' },
];

const BLOCK_SEL = 'p, h1, h2, h3, h4, h5, h6, blockquote, pre, li, div.poem';

function getEditEl() {
  return document.querySelector('#editor-card .page-content-view--editing');
}

function findBlock(node, root) {
  let cur = node && node.nodeType === 3 ? node.parentNode : node;
  while (cur && cur !== root) {
    if (cur.nodeType === 1 && cur.matches?.(BLOCK_SEL)) return cur;
    cur = cur.parentNode;
  }
  return null;
}

// Setzt den Cursor in ein frisch transformiertes (leeres) Blockelement.
// Bei einem <p><br></p>-Muster erwartet der Browser die Position auf dem
// Elternelement mit Offset 0 – dort erscheint der Cursor sichtbar.
function placeCaretIn(el) {
  const sel = document.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.setStart(el, 0);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

export const toolbarMethods = {
  // Bubble-State (teleport in editor-toolbar.html)
  bubbleShow: false,
  bubbleX: 0,
  bubbleY: 0,

  // Slash-State
  slashShow: false,
  slashX: 0,
  slashY: 0,
  slashIdx: 0,
  _slashBlock: null,

  _toolbarListenersInstalled: false,

  _installToolbarListeners() {
    if (this._toolbarListenersInstalled) return;
    this._toolbarListenersInstalled = true;
    document.addEventListener('selectionchange', () => this._updateBubble());
    // Capture-Phase, damit wir auch Scroll-Events in internen Containern
    // (editor-preview-wrap) mitbekommen. Beide Menüs folgen beim Scrollen
    // ihrem Anker – NIE schliessen, sonst flackert das Slash-Menü bei
    // jedem Auto-Scroll des Editors (z.B. durch Keydown).
    window.addEventListener('scroll', () => {
      if (this.bubbleShow) this._updateBubble();
      if (this.slashShow) this._updateSlashPosition();
    }, true);
  },

  _updateSlashPosition() {
    if (!this.slashShow || !this._slashBlock || !this._slashBlock.isConnected) return;
    const rect = this._slashBlock.getBoundingClientRect();
    // Block komplett ausserhalb des Viewports → schliessen.
    if (rect.bottom < 0 || rect.top > window.innerHeight) {
      this._closeSlash();
      return;
    }
    this.slashX = rect.left;
    this.slashY = rect.bottom + 4;
  },

  _updateBubble() {
    if (!this.editMode || this.focusMode) { this.bubbleShow = false; return; }
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      this.bubbleShow = false;
      return;
    }
    const editEl = getEditEl();
    if (!editEl) { this.bubbleShow = false; return; }
    const range = sel.getRangeAt(0);
    if (!editEl.contains(range.commonAncestorContainer)
        && editEl !== range.commonAncestorContainer) {
      this.bubbleShow = false;
      return;
    }
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      this.bubbleShow = false;
      return;
    }
    this.bubbleX = rect.left + rect.width / 2;
    this.bubbleY = rect.top;
    this.bubbleShow = true;
  },

  _applyInline(command) {
    const editEl = getEditEl();
    if (!editEl) return;
    editEl.focus();
    document.execCommand(command, false);
    this._markEditDirty?.();
    this.$nextTick(() => this._updateBubble());
  },

  toolbarBold()   { this._applyInline('bold'); },
  toolbarItalic() { this._applyInline('italic'); },

  // ── Slash-Menü ────────────────────────────────────────────────────────
  // Reaktive Labels: jedes Mal frisch aus i18n (günstig). Kein Getter –
  // der Spread in der Alpine-data-Fabrik würde sonst sofort `this.t`
  // aufrufen (auf toolbarMethods selbst), bevor die Komponente steht, und
  // die gesamte Initialisierung scheitern lassen.
  slashItems() {
    return SLASH_ITEMS.map(it => ({
      key: it.key,
      label: this.t('editor.slash.' + it.key),
    }));
  },

  _onEditInput() {
    // Reserviert – aktuell keine zusätzliche Logik.
  },

  _onEditKeydown(e) {
    // Shift+Enter = weicher Zeilenumbruch (<br>). In Safari/WebKit splittet
    // die Default-Aktion stattdessen den Absatz in zwei <p> – was in Gedichten
    // und Dialogen der falsche Umbruch ist. execCommand('insertLineBreak')
    // setzt das <br> cross-browser konsistent (WebKit + Chromium getestet).
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      document.execCommand('insertLineBreak');
      this._markEditDirty?.();
      return;
    }

    // Im Fokus-Mode bleibt U (Underline) tabu – die Plättung versteckt
    // das Ergebnis und der User würde unsichtbar formatieren. B/I sind
    // explizit erlaubt: die Auszeichnung landet im HTML und wird beim
    // Verlassen des Fokus sichtbar.
    if (this.focusMode) {
      if ((e.metaKey || e.ctrlKey) && /^[uU]$/.test(e.key)) {
        e.preventDefault();
      }
      return;
    }

    // Slash-Menü-Navigation, wenn geöffnet
    if (this.slashShow) {
      if (e.key === 'Escape')    { e.preventDefault(); this._closeSlash(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); this.slashIdx = (this.slashIdx + 1) % SLASH_ITEMS.length; return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); this.slashIdx = (this.slashIdx - 1 + SLASH_ITEMS.length) % SLASH_ITEMS.length; return; }
      if (e.key === 'Enter')     { e.preventDefault(); this._applySlashItem(SLASH_ITEMS[this.slashIdx]); return; }
      // Jede andere (Zeichen-)Taste schliesst das Menü.
      if (e.key.length === 1) { this._closeSlash(); /* Zeichen läuft weiter durch */ }
      return;
    }

    // Slash-Trigger: nur in einem leeren Block
    if (e.key === '/') {
      const editEl = getEditEl();
      if (!editEl) return;
      const sel = document.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      if (!editEl.contains(range.startContainer)) return;
      const block = findBlock(range.startContainer, editEl);
      if (!block) return;
      if ((block.textContent || '').trim() !== '') return;
      e.preventDefault();
      this._openSlashAt(block);
    }
  },

  _openSlashAt(block) {
    this._slashBlock = block;
    this.slashIdx = 0;
    const rect = block.getBoundingClientRect();
    this.slashX = rect.left;
    this.slashY = rect.bottom + 4;
    this.slashShow = true;
  },

  _closeSlash() {
    this.slashShow = false;
    this._slashBlock = null;
    getEditEl()?.focus();
  },

  _applySlashByKey(key) {
    const item = SLASH_ITEMS.find(i => i.key === key);
    if (item) this._applySlashItem(item);
  },

  _applySlashItem(item) {
    const editEl = getEditEl();
    const block = this._slashBlock;
    if (!editEl || !block || !block.parentNode) { this._closeSlash(); return; }

    let replacement;
    let caretTarget;

    if (item.tag === 'hr') {
      replacement = document.createElement('hr');
      block.parentNode.replaceChild(replacement, block);
      // hr ist void – einen folgenden leeren Absatz anhängen, damit der
      // User weiterschreiben kann.
      const next = document.createElement('p');
      next.innerHTML = '<br>';
      replacement.insertAdjacentElement('afterend', next);
      caretTarget = next;
    } else if (item.list) {
      replacement = document.createElement(item.tag);
      const li = document.createElement('li');
      li.innerHTML = '<br>';
      replacement.appendChild(li);
      block.parentNode.replaceChild(replacement, block);
      caretTarget = li;
    } else if (item.wrapP) {
      // blockquote / .poem → enthält ein <p> als Schreibfläche.
      replacement = document.createElement(item.tag);
      if (item.className) replacement.className = item.className;
      const p = document.createElement('p');
      p.innerHTML = '<br>';
      replacement.appendChild(p);
      block.parentNode.replaceChild(replacement, block);
      caretTarget = p;
    } else {
      // Einfacher Tag-Swap (p, h2, h3).
      replacement = document.createElement(item.tag);
      replacement.innerHTML = '<br>';
      block.parentNode.replaceChild(replacement, block);
      caretTarget = replacement;
    }

    placeCaretIn(caretTarget);
    this._markEditDirty?.();
    this._closeSlash();
  },
};
