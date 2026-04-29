// Tastenkürzel-Overlay: globaler `?`-Hotkey + Modal.
// Liste der Shortcuts kommt aus i18n (shortcuts.item.*), Bindings selbst leben
// dort, wo sie gebraucht werden (index.html, editor-focus.js etc.) – das
// Overlay dokumentiert nur.

export const shortcutsMethods = {
  showShortcutsOverlay: false,

  toggleShortcutsOverlay() {
    this.showShortcutsOverlay = !this.showShortcutsOverlay;
  },
  closeShortcutsOverlay() {
    this.showShortcutsOverlay = false;
  },

  // `?` in Text-Inputs/-Textareas/contenteditable-Feldern nicht abfangen –
  // sonst kann der User das Zeichen nicht tippen.
  _shortcutHotkeyAllowed(event) {
    const el = event.target;
    if (!el) return true;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return false;
    if (el.isContentEditable) return false;
    return true;
  },

  handleShortcutsHotkey(event) {
    if (event.key !== '?') return;
    if (!this._shortcutHotkeyAllowed(event)) return;
    event.preventDefault();
    this.toggleShortcutsOverlay();
  },

  _focusInputEl(el) {
    if (!el) return false;
    el.focus();
    if (typeof el.select === 'function') el.select();
    return true;
  },

  focusTreeSearch() {
    return this._focusInputEl(document.querySelector('.page-search'));
  },

  focusBookSearch() {
    return this._focusInputEl(document.querySelector('.bookstack-search-input'));
  },

  // Pages aus filteredTree als flache, navigierbare Liste – Reihenfolge wie
  // sichtbar (Kapitel → Pages, dann Stand-alone Pages).
  _pageSearchFlatPages() {
    const out = [];
    for (const item of this.filteredTree || []) {
      if (item.type === 'chapter') {
        for (const p of item.pages) out.push(p);
      } else if (item.page) {
        out.push(item.page);
      }
    }
    return out;
  },

  // ID des aktuell tastatur-aktiven Treffers; null wenn keine Suche aktiv.
  // Methode statt Getter, weil shortcutsMethods via `...` ins Alpine.data
  // gespreaded wird (Spread würde den Getter zur Build-Zeit evaluieren).
  _pageSearchActivePageId() {
    if (!this.pageSearch) return null;
    const flat = this._pageSearchFlatPages();
    if (!flat.length) return null;
    const idx = Math.max(0, Math.min(this.pageSearchActiveIndex, flat.length - 1));
    return flat[idx].id;
  },

  onPageSearchInput() {
    // Jede Tipp-Änderung setzt die Auswahl auf den ersten Treffer zurück.
    this.pageSearchActiveIndex = 0;
  },

  // ArrowDown/Up navigiert Treffer, Enter wechselt zur Seite, Escape leert
  // Suche (oder blurrt das Input, wenn schon leer).
  onPageSearchKeydown(event) {
    const k = event.key;
    if (k === 'Escape') {
      if (this.pageSearch) {
        this.pageSearch = '';
        this.pageSearchActiveIndex = 0;
        event.preventDefault();
      } else {
        event.target.blur();
      }
      return;
    }
    if (k !== 'ArrowDown' && k !== 'ArrowUp' && k !== 'Enter') return;
    const flat = this._pageSearchFlatPages();
    if (!flat.length) return;
    const len = flat.length;
    if (k === 'Enter') {
      event.preventDefault();
      const idx = Math.max(0, Math.min(this.pageSearchActiveIndex, len - 1));
      const page = flat[idx];
      if (page) {
        this.selectPage(page);
        this.pageSearch = '';
        this.pageSearchActiveIndex = 0;
        event.target.blur();
      }
      return;
    }
    event.preventDefault();
    if (k === 'ArrowDown') this.pageSearchActiveIndex = (this.pageSearchActiveIndex + 1) % len;
    else this.pageSearchActiveIndex = (this.pageSearchActiveIndex - 1 + len) % len;
    this.$nextTick(() => {
      const id = flat[this.pageSearchActiveIndex]?.id;
      if (id == null) return;
      const el = document.querySelector(`.page-item[data-page-id="${id}"]`);
      if (el) el.scrollIntoView({ block: 'nearest' });
    });
  },

  // Cmd/Ctrl+P → Seitenbaum-Filter, Cmd/Ctrl+K → Volltextsuche.
  // Greift auch in Inputs/Editor – preventDefault ist Pflicht (sonst Browser-Print).
  handleNavHotkey(event) {
    if (!(event.ctrlKey || event.metaKey)) return;
    if (event.altKey || event.shiftKey) return;
    const key = (event.key || '').toLowerCase();
    if (key === 'p') {
      if (!this.focusTreeSearch()) return;
      event.preventDefault();
    } else if (key === 'k') {
      if (!this.focusBookSearch()) return;
      event.preventDefault();
    }
  },
};
