// Tastenkürzel-Overlay: globaler `?`-Hotkey + Modal.
// Liste der Shortcuts kommt aus i18n (shortcuts.item.*), Bindings selbst leben
// dort, wo sie gebraucht werden (index.html, editor-focus.js etc.) – das
// Overlay dokumentiert nur.
//
// Dieses Modul liefert ausserdem:
//  - Chord-Hotkeys (`g f`, `g o` …) für Kartenwechsel.
//  - Findings-Sprung Alt+J/K im Editor.
//  - Tree-Pfeilnavigation für die Sidebar (auch ohne aktive Suche).
//  - `trapFocus(event, rootEl)`-Helper für Modal-Inline-Nutzung.

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'textarea:not([disabled])',
  'input:not([disabled]):not([type="hidden"])', 'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])', '[contenteditable="true"]',
].join(',');

const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));

// Chord-Buffer: erste Taste (z.B. `g`) öffnet ein Zeitfenster, in dem die
// nächste Taste die Aktion auswählt. Konflikt mit normalem Tippen: nur ausser-
// halb von Inputs/Editor aktiv (siehe _shortcutHotkeyAllowed).
const CHORD_LEAD = 'g';
const CHORD_TIMEOUT_MS = 1500;

const CHORD_MAP = {
  // Buchanalyse
  r: 'toggleBookReviewCard',
  f: 'toggleFiguresCard',
  s: 'toggleSzenenCard',
  e: 'toggleEreignisseCard',
  o: 'toggleOrteCard',
  k: 'toggleKontinuitaetCard',
  t: 'toggleStilCard',          // sTil
  h: 'toggleFehlerHeatmapCard', // Heatmap
  b: 'toggleBookStatsCard',     // Buchstats
  c: '_chordChat',              // Seiten-Chat wenn Editor offen, sonst Buch-Chat
  i: 'toggleIdeenCard',         // nur im Seitenkontext
  // Settings (Komma-Konvention für Settings)
  ',': 'toggleUserSettingsCard',
  ';': 'toggleBookSettingsCard',
  x: 'toggleFinetuneExportCard',
};

export const shortcutsMethods = {
  showShortcutsOverlay: false,

  // Chord-State (kein init nötig — Reactive nicht erforderlich, Buffer ist
  // ephemer).
  _chordPrefix: null,
  _chordTimer: null,

  toggleShortcutsOverlay() {
    this.showShortcutsOverlay = !this.showShortcutsOverlay;
  },
  closeShortcutsOverlay() {
    this.showShortcutsOverlay = false;
  },

  // Focus-Trap-Helper für Modal-Inline-Nutzung: in `<div @keydown="trapFocus($event, $el)">`
  // aufrufen. Tab/Shift+Tab zyklisch innerhalb des Roots halten.
  trapFocus(event, rootEl) {
    if (event.key !== 'Tab' || !rootEl) return;
    const items = Array.from(rootEl.querySelectorAll(FOCUSABLE)).filter(visible);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !rootEl.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  },

  // `?` und `g`-Chord in Inputs/Textareas/CE nicht abfangen.
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

  // ── Chord-Hotkeys (g X) für Kartenwechsel ──────────────────────────────
  _resetChord() {
    this._chordPrefix = null;
    if (this._chordTimer) { clearTimeout(this._chordTimer); this._chordTimer = null; }
  },

  _chordChat() {
    // `g c` öffnet Seiten-Chat, wenn Editor aktiv; sonst Buch-Chat.
    if (this.showEditorCard && this.currentPage) this.toggleChatCard();
    else this.toggleBookChatCard();
  },

  handleChordHotkey(event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (!this._shortcutHotkeyAllowed(event)) return;
    const k = (event.key || '').toLowerCase();
    if (this._chordPrefix === CHORD_LEAD) {
      const action = CHORD_MAP[k];
      this._resetChord();
      if (!action) return;
      event.preventDefault();
      if (typeof this[action] === 'function') this[action]();
      return;
    }
    if (k === CHORD_LEAD) {
      event.preventDefault();
      this._chordPrefix = CHORD_LEAD;
      this._chordTimer = setTimeout(() => this._resetChord(), CHORD_TIMEOUT_MS);
    }
  },

  // ── Findings-Navigation (Alt+J/K) ──────────────────────────────────────
  // Springt zum nächsten/vorigen Finding und scrollt es in den View. Nutzt
  // existierendes pointer-Highlight (handleFindingPointer), simuliert es per
  // dispatchEvent('pointerenter').
  _findingItems() {
    return Array.from(document.querySelectorAll('.lektorat-split-findings .finding[data-finding-idx]'));
  },
  _activateFinding(el) {
    if (!el) return;
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    el.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
    // Visuell hervorheben: kurz fokussieren, falls möglich (Label hat keinen
    // tabindex von Haus aus; als interaktives Element bekommt es eins).
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    el.focus({ preventScroll: true });
  },
  handleFindingsHotkey(event) {
    if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const k = (event.key || '').toLowerCase();
    if (k !== 'j' && k !== 'k') return;
    if (!this.checkDone || !this.lektoratFindings?.length) return;
    const items = this._findingItems();
    if (!items.length) return;
    event.preventDefault();
    const cur = items.indexOf(document.activeElement);
    const dir = (k === 'j') ? 1 : -1;
    const idx = cur < 0 ? (dir > 0 ? 0 : items.length - 1)
                        : (cur + dir + items.length) % items.length;
    this._activateFinding(items[idx]);
  },

  // ── Tree-Sidebar Pfeil-Navigation ──────────────────────────────────────
  // Pfeil-up/down zwischen .page-item, Enter selektiert. Greift nur, wenn
  // Fokus bereits auf einem Tree-Page-Item liegt. Pfeil-rechts/links auf
  // Kapitel-Header klappt auf/zu.
  _treePageItems() {
    return Array.from(document.querySelectorAll('.layout-sidebar .page-item[data-page-id]'));
  },
  handleTreeKeydown(event) {
    const target = event.target;
    if (!target?.classList) return;
    if (target.classList.contains('page-item')) {
      const items = this._treePageItems();
      const cur = items.indexOf(target);
      if (cur < 0) return;
      const k = event.key;
      if (k === 'ArrowDown' || k === 'ArrowUp') {
        event.preventDefault();
        const next = items[(cur + (k === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
        items.forEach(el => { el.tabIndex = -1; });
        next.tabIndex = 0;
        next.focus();
        next.scrollIntoView({ block: 'nearest' });
      } else if (k === 'Home' || k === 'End') {
        event.preventDefault();
        const next = k === 'Home' ? items[0] : items[items.length - 1];
        items.forEach(el => { el.tabIndex = -1; });
        next.tabIndex = 0;
        next.focus();
        next.scrollIntoView({ block: 'nearest' });
      } else if (k === 'Enter' || k === ' ') {
        event.preventDefault();
        target.click();
      }
    }
  },
};
