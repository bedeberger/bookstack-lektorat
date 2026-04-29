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
