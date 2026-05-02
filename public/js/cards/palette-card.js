// Alpine.data('paletteCard') — Command-Palette (Cmd/Ctrl+K).
// Modal mit Such-Input + gefilterter Feature-Liste, gruppiert nach
// Bewertung / Welt & Plot / Werkzeug. Oben optional „Zuletzt"-Block.
//
// Trigger:
//  - Hero-Bar Klick → CustomEvent('palette:open')
//  - Globaler Shortcut Cmd/Ctrl+K (shortcuts.js) → CustomEvent('palette:open')
//  - Quick-Pill ⌘K-Hint → CustomEvent('palette:open')
//
// Activate:
//  - Klick auf Item oder Enter mit aktiver Idx → activateFeature(key)
//  - Schliesst Palette und ruft Root-Toggle-Methode

import { FEATURES, FEATURE_GROUPS, GROUP_LABEL_KEY, featureByKey, isFeatureAvailable } from './feature-registry.js';

export function registerPaletteCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('paletteCard', () => ({
    paletteOpen: false,
    paletteQuery: '',
    paletteIdx: 0,
    _paletteAbort: null,

    init() {
      const abort = new AbortController();
      this._paletteAbort = abort;
      const signal = abort.signal;

      window.addEventListener('palette:open', () => this.openPalette(), { signal });
      window.addEventListener('palette:close', () => this.closePalette(), { signal });
    },

    destroy() {
      this._paletteAbort?.abort();
    },

    openPalette() {
      this.paletteOpen = true;
      this.paletteQuery = '';
      this.paletteIdx = 0;
      this.$nextTick(() => {
        const input = document.querySelector('.palette-input');
        if (input) input.focus();
      });
    },

    closePalette() {
      this.paletteOpen = false;
      this.paletteQuery = '';
      this.paletteIdx = 0;
    },

    onPaletteInput() {
      this.paletteIdx = 0;
    },

    onPaletteKeydown(event) {
      const k = event.key;
      if (k === 'Escape') {
        event.preventDefault();
        this.closePalette();
        return;
      }
      const flat = this._paletteFlatItems();
      if (!flat.length) return;
      if (k === 'ArrowDown') {
        event.preventDefault();
        this.paletteIdx = (this.paletteIdx + 1) % flat.length;
        this._scrollActiveIntoView();
      } else if (k === 'ArrowUp') {
        event.preventDefault();
        this.paletteIdx = (this.paletteIdx - 1 + flat.length) % flat.length;
        this._scrollActiveIntoView();
      } else if (k === 'Enter') {
        event.preventDefault();
        const item = flat[this.paletteIdx];
        if (item) this.activateFeature(item.key);
      }
    },

    _scrollActiveIntoView() {
      this.$nextTick(() => {
        const el = document.querySelector('.palette-item--active');
        if (el) el.scrollIntoView({ block: 'nearest' });
      });
    },

    _ctx() {
      const root = window.__app || {};
      return {
        selectedBookId: root.selectedBookId,
        pages: root.pages,
      };
    },

    _matches(feature, q) {
      if (!q) return true;
      const t = (key) => (window.__app?.t?.(key) || '').toLowerCase();
      const groupLabel = t(GROUP_LABEL_KEY[feature.group]);
      const label = t(feature.labelKey);
      const desc = t(feature.descKey);
      const needle = q.toLowerCase();
      return label.includes(needle) || desc.includes(needle) || groupLabel.includes(needle);
    },

    // Sektionen für die Render-Struktur; jede Section enthält gefilterte Features.
    paletteSections() {
      const q = this.paletteQuery.trim();
      const ctx = this._ctx();
      const sections = [];

      // „Zuletzt"-Block nur ohne Suche und mit vorhandenen Recent-Keys.
      if (!q) {
        const recent = (window.__app?.recentFeatureKeys || [])
          .map(k => featureByKey(k))
          .filter(Boolean);
        if (recent.length) {
          sections.push({
            key: 'recent',
            labelKey: 'palette.recent',
            items: recent.map(f => ({ key: f.key, feature: f, available: isFeatureAvailable(f, ctx) })),
          });
        }
      }

      for (const groupKey of FEATURE_GROUPS) {
        const items = FEATURES
          .filter(f => f.group === groupKey)
          .filter(f => this._matches(f, q))
          .map(f => ({ key: f.key, feature: f, available: isFeatureAvailable(f, ctx) }));
        if (items.length) {
          sections.push({ key: groupKey, labelKey: GROUP_LABEL_KEY[groupKey], items });
        }
      }
      return sections;
    },

    // Flach-Liste für Tastatur-Navigation. Index entspricht visueller Reihenfolge.
    _paletteFlatItems() {
      const out = [];
      for (const sec of this.paletteSections()) {
        for (const it of sec.items) out.push(it);
      }
      return out;
    },

    paletteIsActive(idx) {
      return idx === this.paletteIdx;
    },

    paletteItemIndex(sectionKey, itemKey) {
      const flat = this._paletteFlatItems();
      return flat.findIndex(it => it.key === itemKey && this._sectionForFlatIdx(flat, sectionKey, itemKey));
    },

    // Hilfs-Lookup: globaler Index eines Items innerhalb der flachen Liste.
    // Bei Recent + Group-Section kann derselbe key zweimal vorkommen — wir
    // matchen über Reihenfolge in paletteSections().
    paletteGlobalIdx(sectionKey, itemKey) {
      let idx = 0;
      for (const sec of this.paletteSections()) {
        for (const it of sec.items) {
          if (sec.key === sectionKey && it.key === itemKey) return idx;
          idx++;
        }
      }
      return -1;
    },

    activateFeature(key) {
      const feature = featureByKey(key);
      if (!feature) return;
      const ctx = this._ctx();
      if (!isFeatureAvailable(feature, ctx)) return;
      const root = window.__app;
      if (!root) return;
      const fn = root[feature.toggle];
      if (typeof fn !== 'function') return;
      this.closePalette();
      fn.call(root);
    },

    onOverlayClick(event) {
      // Nur schliessen wenn Klick auf Overlay selbst, nicht auf Panel.
      if (event.target === event.currentTarget) this.closePalette();
    },

    _sectionForFlatIdx() { return true; }, // unbenutzt, Reservation
  }));
}
