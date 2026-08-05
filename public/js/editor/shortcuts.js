import { EVT } from '../events.js';
// Tastenkürzel-Overlay: globaler `?`-Hotkey + Modal (natives <dialog>).
// Liste der Shortcuts kommt aus i18n (shortcuts.item.*), Bindings selbst leben
// dort, wo sie gebraucht werden (index.html, editor/focus.js etc.) – das
// Overlay dokumentiert nur.
//
// Dieses Modul liefert ausserdem:
//  - Findings-Sprung Alt+J/K im Editor.
//  - Tree-Pfeilnavigation für die Sidebar (auch ohne aktive Suche).
//  - `trapFocus(event, rootEl)`-Helper für die Editor-Find-Leiste.
//
// WARUM hier ein eigener Tab-Zyklus und nicht `x-trap` (@alpinejs/focus):
// Die Find-Leiste liegt ÜBER dem Editor, blockiert ihn aber nicht — man klickt
// aus ihr heraus in den Text, um die gefundene Stelle direkt zu korrigieren.
// focus-trap holt den Fokus in seinem `focusin`-Handler bedingungslos zurück
// (`allowOutsideClick` erlaubt nur den Klick, nicht den Fokuswechsel), der
// Cursor käme also nie im Manuskript an. `x-trap` gehört deshalb nur auf die
// wirklich blockierenden Overlays (Palette, Konflikt-Modal, Fassungs-Reader);
// hier bleibt es beim reinen Tab-Zyklus, der Klicks nach draussen zulässt.

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'textarea:not([disabled])',
  'input:not([disabled]):not([type="hidden"])', 'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])', '[contenteditable="true"]',
].join(',');

const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));

export const shortcutsMethods = {
  // Overlay-Steuerung: nur Flag flippen. Das native <dialog> hängt via
  // Alpine.data('modal') (x-model="shortcutsOpen") an diesem Boolean —
  // showModal()/close(), ESC, Backdrop und Fokus-Restore macht das Primitiv.
  toggleShortcutsOverlay() {
    this.shortcutsOpen = !this.shortcutsOpen;
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

  // `?` in Inputs/Textareas/CE nicht abfangen.
  _shortcutHotkeyAllowed(event) {
    const el = event.target;
    if (!el) return true;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return false;
    if (el.isContentEditable) return false;
    return true;
  },

  handleShortcutsHotkey(event) {
    if (!this._shortcutHotkeyAllowed(event)) return;
    if (event.key === '?') {
      event.preventDefault();
      this.toggleShortcutsOverlay();
      return;
    }
    // `/` öffnet die Command-Palette (Slack/GitHub-Pattern). Nur ausserhalb
    // von Inputs/Editor — _shortcutHotkeyAllowed hat das bereits gefiltert.
    if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      window.dispatchEvent(new CustomEvent(EVT.PALETTE_OPEN));
    }
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
  // Wert lebt in `_pageSearchActiveId` (state-Feld), nicht als Getter — sonst
  // wird per Page-Row aufgerufen → triggert filteredTree-Compute pro Item (N²).
  _recomputePageSearchActiveId() {
    if (!this.pageSearch) { this._pageSearchActiveId = null; return; }
    const flat = this._pageSearchFlatPages();
    if (!flat.length) { this._pageSearchActiveId = null; return; }
    const idx = Math.max(0, Math.min(this.pageSearchActiveIndex, flat.length - 1));
    this._pageSearchActiveId = flat[idx].id;
  },

  // ArrowDown/Up navigiert Treffer, Enter wechselt zur Seite, Escape leert
  // Suche (oder blurrt das Input, wenn schon leer).
  onPageSearchKeydown(event) {
    const k = event.key;
    if (k === 'Escape') {
      if (this.pageSearch) {
        this.pageSearch = '';
        this.pageSearchActiveIndex = 0;
        this._pageSearchActiveId = null;
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
        this._pageSearchActiveId = null;
        event.target.blur();
      }
      return;
    }
    event.preventDefault();
    if (k === 'ArrowDown') this.pageSearchActiveIndex = (this.pageSearchActiveIndex + 1) % len;
    else this.pageSearchActiveIndex = (this.pageSearchActiveIndex - 1 + len) % len;
    this._pageSearchActiveId = flat[this.pageSearchActiveIndex]?.id ?? null;
    this.$nextTick(() => {
      const id = flat[this.pageSearchActiveIndex]?.id;
      if (id == null) return;
      const el = document.querySelector(`.page-item[data-page-id="${id}"]`);
      if (el) el.scrollIntoView({ block: 'nearest' });
    });
  },

  // Cmd/Ctrl+E → Notebook-Edit-Modus ein-/ausschalten (nur im Notebook, nicht im Focus)
  // Cmd/Ctrl+P → Seitenbaum-Filter
  // Cmd/Ctrl+K → Command-Palette
  // Greift auch in Inputs/Editor – preventDefault ist Pflicht (sonst Browser-Print/Find).
  handleNavHotkey(event) {
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = (event.key || '').toLowerCase();
    if (event.altKey) return;
    if (key === 'e') {
      if (event.shiftKey) return;
      // Ctrl+Shift+E ist belegt (Focus-Toggle), plain Ctrl+E → Notebook-Edit
      if (!this.currentPage) return;
      if (this.editMode) {
        this.quickSave?.();
      } else {
        this.startEdit?.();
      }
      event.preventDefault();
      return;
    }
    if (event.shiftKey) return;
    if (key === 'p') {
      if (!this.focusTreeSearch()) return;
      event.preventDefault();
    } else if (key === 'k') {
      event.preventDefault();
      window.dispatchEvent(new CustomEvent(EVT.PALETTE_OPEN));
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
    const code = event.code;
    if (code !== 'KeyJ' && code !== 'KeyK') return;
    if (!this.checkDone || !this.lektoratFindings?.length) return;
    const items = this._findingItems();
    if (!items.length) return;
    event.preventDefault();
    const cur = items.indexOf(document.activeElement);
    const dir = (code === 'KeyJ') ? 1 : -1;
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

  // ── Chef-Taste (Boss-Key) ──────────────────────────────────────────────
  // F9 im Seiten-Editor (Notebook-Edit-Modus oder Fokus-Modus) schwärzt sofort
  // den ganzen Bildschirm. Ist der Vorhang an, blendet jede beliebige Taste
  // ihn wieder aus — der Tastendruck wird dabei geschluckt (kein Tippen ins
  // Dokument, kein Auslösen anderer Hotkeys). Läuft als Capture-Listener
  // (siehe index.html `@keydown.capture.window`), damit es vor der regulären
  // Hotkey-Kette greift und sie via stopImmediatePropagation abklemmen kann.
  handleBossKey(event) {
    if (this.$store.shell.bossScreenActive) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.$store.shell.bossScreenActive = false;
      return;
    }
    const plainF9 = event.key === 'F9'
      && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
    if (!plainF9) return;
    // Nur im Seiten-Editor: editMode deckt Notebook-Edit ab; im Fokus-Modus ist
    // editMode ebenfalls true (Focus läuft auf der Notebook-Save-Pipeline).
    if (!this.editMode) return;
    event.preventDefault();
    this.$store.shell.bossScreenActive = true;
  },
};
