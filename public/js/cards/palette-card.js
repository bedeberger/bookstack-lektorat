// Alpine.data('paletteCard') — Command-Palette (Cmd/Ctrl+K bzw. /).
// Modal mit Such-Input + Sektionen aus Karten + globalen Aktionen + Such-Providern.
// Prefix-Modi: `>` Befehle, `#` Seiten, `!` Kapitel, `@` Figuren, `$` Orte,
// `%` Szenen. Ohne Prefix: alles fuzzy gemixt.
//
// Trigger:
//  - Hero-Bar Klick → CustomEvent('palette:open')
//  - Globaler Shortcut Cmd/Ctrl+K bzw. `/` (shortcuts.js) → CustomEvent('palette:open')
//
// Activate:
//  - Klick auf Item oder Enter mit aktiver Idx → activateItem(item)
//  - Schliesst Palette und ruft passende Aktion (Toggle/Action/Provider-Run).

import {
  FEATURES, ACTIONS, FEATURE_GROUPS, GROUP_LABEL_KEY,
  DEFAULT_RECENT_KEYS,
  featureByKey, isFeatureAvailable, unavailabilityReasonKey,
  featuresVisibleFor,
  hiddenForBuchtyp, matchesRequiredBuchtyp,
} from './feature-registry.js';
import { fuzzyMatch, highlight } from './palette-fuzzy.js';
import { PROVIDERS, parseQuery } from './palette-providers.js';
import { EVT } from '../events.js';
import { mountInTopLayer } from '../fullscreen.js';

// Score-Budget pro Query-Char für Provider-Treffer im Mix-Modus.
// Höhere Query-Länge = grössere absolute fuzzyMatch-Scores (Gap-Penalty
// + length-Faktor), Limit muss mit-skalieren damit überhaupt Treffer durchkommen.
// Kleiner = strenger, grösser = mehr (auch schwächere) Provider-Treffer.
const FUZZY_SCORE_BUDGET_PER_CHAR = 6;
const RECENT_TARGET_COUNT = 3;

export function registerPaletteCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('paletteCard', () => ({
    paletteOpen: false,
    paletteQuery: '',
    paletteIdx: 0,
    paletteToast: '',
    _paletteAbort: null,
    _toastTimer: null,
    _sectionsCache: null,
    _sectionsCacheKey: '',
    _flatCache: null,
    _flatCacheKey: '',
    _modeCache: null,
    _modeCacheQuery: null,
    _returnFocusEl: null,

    init() {
      const abort = new AbortController();
      this._paletteAbort = abort;
      const signal = abort.signal;

      window.addEventListener(EVT.PALETTE_OPEN, () => this.openPalette(), { signal });
      window.addEventListener(EVT.PALETTE_CLOSE, () => this.closePalette(), { signal });
      // Async-Provider (Fulltext) signalisiert via 'palette:rerender'
      // dass sich der Cache geaendert hat — Sections-Cache nullen, damit
      // paletteSections() neu rechnet.
      window.addEventListener(EVT.PALETTE_RERENDER, () => {
        this._sectionsCache = null;
        this._sectionsCacheKey = '';
        this._flatCache = null;
        this._flatCacheKey = '';
      }, { signal });
    },

    destroy() {
      this._paletteAbort?.abort();
      if (this._toastTimer) clearTimeout(this._toastTimer);
      document.body.classList.remove('palette-open');
    },

    openPalette() {
      const active = document.activeElement;
      this._returnFocusEl = (active && active !== document.body) ? active : null;
      // Ist gerade eine Karte im Native-Vollbild (Plot/Motiv/Recherche/Bucheditor),
      // muss das Overlay in deren Top-Layer — als <body>-Kind laege es hinter dem
      // ::backdrop und Cmd+K wuerde scheinbar nichts tun. Bewusst umhaengen statt
      // das Vollbild zu beenden: die Palette wird oft mit Esc wieder verworfen, und
      // wer dafuer aus dem Vollbild-Board faellt, verliert seinen Kontext fuer
      // nichts. Waehlt man wirklich ein Ziel, endet das Vollbild ohnehin von selbst
      // (_closeOtherMainCards setzt die Karte auf display:none).
      this._remountPaletteOverlay();
      this.paletteOpen = true;
      this.paletteQuery = '';
      this.paletteIdx = 0;
      this.paletteToast = '';
      document.body.classList.add('palette-open');
      this.$nextTick(() => {
        const input = document.querySelector('.palette-input');
        if (input) input.focus();
      });
    },

    // Overlay in den aktuell obersten Layer haengen (Fullscreen-Element, sonst
    // <body>). Ebenen-Wahl in fullscreen.js#topLayerHost; hier ohne `target`,
    // weil die Palette global ist und nicht an einem Trigger haengt.
    _remountPaletteOverlay() {
      mountInTopLayer(document.querySelector('.palette-overlay'));
    },

    closePalette() {
      this.paletteOpen = false;
      this.paletteQuery = '';
      this.paletteIdx = 0;
      this.paletteToast = '';
      document.body.classList.remove('palette-open');
      // Zurueck an <body>, solange kein Vollbild aktiv ist: sonst haengt das
      // Overlay in einer Karte, die spaeter geschlossen (display:none) wird und
      // es mit sich unsichtbar macht.
      this._remountPaletteOverlay();
      const el = this._returnFocusEl;
      this._returnFocusEl = null;
      if (el && typeof el.focus === 'function' && document.contains(el)) {
        try { el.focus(); } catch {}
      }
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
      const flat = this._flatItems();
      if (!flat.length) {
        if (k === 'Tab') event.preventDefault();
        return;
      }
      if (k === 'ArrowDown' || (k === 'Tab' && !event.shiftKey)) {
        event.preventDefault();
        this.paletteIdx = (this.paletteIdx + 1) % flat.length;
        this._scrollActiveIntoView();
      } else if (k === 'ArrowUp' || (k === 'Tab' && event.shiftKey)) {
        event.preventDefault();
        this.paletteIdx = (this.paletteIdx - 1 + flat.length) % flat.length;
        this._scrollActiveIntoView();
      } else if (k === 'Enter') {
        event.preventDefault();
        const item = flat[this.paletteIdx];
        if (item) this.activateItem(item);
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
        selectedBookId: Alpine.store('nav').selectedBookId,
        pages: Alpine.store('nav').pages,
        bookRole: root.currentBookRole || null,
        buchtyp: (typeof root.currentBuchtyp === 'function' ? root.currentBuchtyp() : null) || null,
        cloudModelEffective: (Alpine.store('config')?.effectiveProviderClass || 'cloud') === 'cloud',
      };
    },

    // ── Sektionen-Aufbau ──────────────────────────────────────────────────
    // Wird pro Render mehrfach gelesen. Cache via stringifiziertem Key (query
    // + book-id + Längen der Daten-Quellen) damit Fuzzy nicht 20×/keystroke läuft.
    paletteSections() {
      const root = window.__app || {};
      const ctx = this._ctx();
      const cacheKey = [
        this.paletteQuery,
        ctx.selectedBookId || '',
        ctx.bookRole || '',
        ctx.buchtyp || '',
        ctx.backend || '',
        (ctx.pages || []).length,
        (root.$store.catalog.figuren || []).length,
        (root.$store.catalog.orte || []).length,
        (root.$store.catalog.szenen || []).length,
        (Alpine.store('nav').tree || []).length,
        (root.recentFeatureKeys || []).join(','),
        (root.recentPageIds || []).join(','),
        root.$store.shell.uiLocale || '',
      ].join('|');
      if (this._sectionsCache && this._sectionsCacheKey === cacheKey) {
        return this._sectionsCache;
      }
      const sections = this._buildSections(root, ctx);
      this._sectionsCacheKey = cacheKey;
      this._sectionsCache = sections;
      return sections;
    },

    _buildSections(root, ctx) {
      const parsed = parseQuery(this.paletteQuery);
      const t = (k, p) => (root.t ? root.t(k, p) : k);
      // minRole-Filter: bei aktivem Buch nur Cards anbieten, die der
      // aktuellen Buch-Rolle entsprechen. Ohne Buch (Quick-Pills Home-Screen)
      // FEATURES unverändert lassen — Cards mit `requiresBook` sind dann eh
      // disabled.
      const visibleFeatures = ctx.bookRole
        ? featuresVisibleFor(FEATURES, ctx.bookRole, ctx.buchtyp, ctx.cloudModelEffective)
        : FEATURES.filter(f => matchesRequiredBuchtyp(f, ctx.buchtyp)
            && !hiddenForBuchtyp(f, ctx.buchtyp)
            && (!f.requiresCloudModel || ctx.cloudModelEffective));

      // Provider-Modus: nur dieser eine Provider.
      if (parsed.mode === 'provider') {
        if (typeof parsed.provider.prepare === 'function') {
          // Lazy-Load anstossen, falls Datenquelle (orte/szenen) noch leer ist.
          // Ergebnis kommt asynchron, Alpine re-rendered sobald root-State sich ändert
          // (cacheKey enthält Längen der Listen).
          parsed.provider.prepare(root);
        }
        const items = parsed.provider.search(root, parsed.q, t);
        if (!items.length) return [];
        return [{ key: parsed.provider.key, labelKey: parsed.provider.sectionKey, items }];
      }

      const availableActions = root.$store.session.devMode ? ACTIONS.filter(a => a.key !== 'action.logout') : ACTIONS;

      // Befehls-Modus: nur Aktionen.
      if (parsed.mode === 'commands') {
        const items = this._matchActions(availableActions, parsed.q, ctx, t);
        if (!items.length) return [];
        return [{ key: 'commands', labelKey: 'palette.section.commands', items }];
      }

      // Mix-Modus: Karten + Aktionen + (bei aktiver Query) Top-Treffer aus Providern.
      const q = parsed.q;
      const sections = [];

      // „Zuletzt"-Block nur ohne Suche.
      if (!q) {
        // Recents aus Tracking; bei Erstnutzern (oder < 3 Einträge) mit
        // DEFAULT_RECENT_KEYS auffüllen — sonst wäre das Panel leer.
        const tracked = (root.recentFeatureKeys || []).filter(Boolean);
        const seen = new Set(tracked);
        const filled = tracked.slice();
        for (const k of DEFAULT_RECENT_KEYS) {
          if (filled.length >= RECENT_TARGET_COUNT) break;
          if (seen.has(k)) continue;
          filled.push(k);
          seen.add(k);
        }
        // Recents gegen das sichtbare Subset filtern — sonst tauchen Cards
        // auf, die für den aktuellen Buchtyp/Rolle gar nicht verfügbar sind
        // (z.B. Tagebuch-Rückblick nach Wechsel auf Gesellschaftsroman).
        const visibleKeys = new Set(visibleFeatures.map(f => f.key));
        const recent = filled
          .map(k => featureByKey(k))
          .filter(f => f && visibleKeys.has(f.key));
        if (recent.length) {
          sections.push({
            key: 'recent',
            labelKey: 'palette.recent',
            items: recent.map(f => this._toggleItem(f, ctx)),
          });
        }
        // Zuletzt besuchte Seiten (max. 5) — Lookup gegen ctx.pages.
        const pageById = new Map((ctx.pages || []).map(p => [p.id, p]));
        const recentPages = (root.recentPageIds || [])
          .map(id => pageById.get(id))
          .filter(Boolean);
        if (recentPages.length) {
          sections.push({
            key: 'recentPages',
            labelKey: 'palette.section.recentPages',
            items: recentPages.map(p => ({
              key: 'page:' + p.id,
              providerKey: 'pages',
              kind: 'page',
              label: p.name || '',
              sub: p.chapterName || '',
              score: 0,
              indices: [],
              available: true,
              run: (r) => r.gotoPageById(p.id),
            })),
          });
        }
      }

      // Ohne Query: Karten gruppiert nach FEATURE_GROUPS, App-Aktionen separat.
      // Mit Query: alle Karten + Aktionen in eine einzige sortierte Treffer-Sektion,
      // damit ein Top-Match (z.B. "eins" → "Einstellungen") nicht hinter einer
      // Gruppe mit schwächerem Treffer (z.B. "Ereignisse") versteckt wird.
      if (!q) {
        for (const groupKey of FEATURE_GROUPS) {
          if (groupKey === 'app') continue;
          const items = this._matchFeatures(visibleFeatures.filter(f => f.group === groupKey), q, ctx, t);
          if (items.length) {
            sections.push({ key: groupKey, labelKey: GROUP_LABEL_KEY[groupKey], items });
          }
        }
        const actionItems = this._matchActions(availableActions, q, ctx, t);
        if (actionItems.length) {
          sections.push({ key: 'app', labelKey: GROUP_LABEL_KEY.app, items: actionItems });
        }
      } else {
        const matched = [];
        for (const f of visibleFeatures) {
          const m = this._matchFeatureFuzzy(f, q, t);
          if (!m) continue;
          const item = this._toggleItem(f, ctx);
          item.score = m.score;
          item.indices = m.indices;
          matched.push(item);
        }
        for (const a of availableActions) {
          const m = this._matchFeatureFuzzy(a, q, t);
          if (!m) continue;
          const item = this._actionItem(a, ctx);
          item.score = m.score;
          item.indices = m.indices;
          matched.push(item);
        }
        matched.sort((x, y) => x.score - y.score);
        if (matched.length) {
          sections.push({ key: 'matches', labelKey: 'palette.section.matches', items: matched });
        }
      }

      // Such-Provider (nur bei aktiver Query): Pages/Chapters/Figuren/Orte/Szenen
      // mit Top-Treffern, sofern Score gut genug.
      if (q && q.length >= 2) {
        const limit = Math.max(3, Math.ceil(q.length * FUZZY_SCORE_BUDGET_PER_CHAR));
        for (const provider of PROVIDERS) {
          const items = provider.search(root, q, t).filter(it => it.score < limit);
          if (items.length) {
            sections.push({ key: provider.key, labelKey: provider.sectionKey, items });
          }
        }
      }
      return sections;
    },

    _matchFeatures(features, q, ctx, t) {
      const out = [];
      for (const f of features) {
        const item = this._toggleItem(f, ctx);
        if (!q) { out.push(item); continue; }
        const m = this._matchFeatureFuzzy(f, q, t);
        if (!m) continue;
        item.score = m.score;
        item.indices = m.indices;
        out.push(item);
      }
      if (q) out.sort((a, b) => a.score - b.score);
      return out;
    },

    _matchActions(actions, q, ctx, t) {
      const out = [];
      for (const a of actions) {
        const item = this._actionItem(a, ctx);
        if (!q) { out.push(item); continue; }
        const m = this._matchFeatureFuzzy(a, q, t);
        if (!m) continue;
        item.score = m.score;
        item.indices = m.indices;
        out.push(item);
      }
      if (q) out.sort((a, b) => a.score - b.score);
      return out;
    },

    // Fuzzy gegen Label, Desc, Group-Label und Aliases. Bestes Ergebnis gewinnt.
    // Indices kommen nur aus Label-Treffern (für Highlight).
    _matchFeatureFuzzy(feature, q, t) {
      const label = (feature.labelKey ? t(feature.labelKey) : '') || '';
      const desc  = (feature.descKey  ? t(feature.descKey)  : '') || '';
      const groupLabel = feature.group ? (t(GROUP_LABEL_KEY[feature.group]) || '') : '';
      const labelMatch = fuzzyMatch(q, label);
      let best = labelMatch ? { score: labelMatch.score, indices: labelMatch.indices } : null;
      const others = [desc, groupLabel, ...(feature.aliases || [])];
      for (const o of others) {
        const m = fuzzyMatch(q, o);
        if (!m) continue;
        const score = m.score + 4; // Label-Treffer bevorzugen
        if (!best || score < best.score) best = { score, indices: labelMatch?.indices || [] };
      }
      return best;
    },

    _toggleItem(feature, ctx) {
      const available = isFeatureAvailable(feature, ctx);
      return {
        key: feature.key,
        kind: 'toggle',
        feature,
        labelKey: feature.labelKey,
        descKey: feature.descKey,
        available,
        dependsOnKomplett: !!feature.dependsOnKomplett,
        reasonKey: available ? null : unavailabilityReasonKey(feature, ctx),
        score: 0,
        indices: [],
      };
    },

    _actionItem(action, ctx) {
      const available = isFeatureAvailable(action, ctx);
      return {
        key: action.key,
        kind: 'action',
        feature: action,
        labelKey: action.labelKey,
        descKey: action.descKey,
        available,
        reasonKey: available ? null : unavailabilityReasonKey(action, ctx),
        score: 0,
        indices: [],
      };
    },

    // ── Flach-Liste für Tastatur-Navigation ──────────────────────────────
    // Cache an _sectionsCacheKey gekoppelt — sobald Sections-Cache hit, ist
    // auch Flat stabil (rein deterministisch aus sections). Spart O(N) Spread
    // pro paletteIsActive-Aufruf bei vollen Listen.
    _flatItems() {
      const sections = this.paletteSections();
      if (this._flatCache && this._flatCacheKey === this._sectionsCacheKey) {
        return this._flatCache;
      }
      const out = [];
      for (const sec of sections) {
        for (const it of sec.items) out.push({ ...it, sectionKey: sec.key });
      }
      this._flatCacheKey = this._sectionsCacheKey;
      this._flatCache = out;
      return out;
    },

    // ── Render-Helfer für Template ────────────────────────────────────────
    paletteItemId(sectionKey, itemKey) {
      return 'palette-opt-' + sectionKey + '-' + String(itemKey).replace(/[^\w-]/g, '_');
    },

    paletteIsActive(sectionKey, itemKey) {
      const flat = this._flatItems();
      const cur = flat[this.paletteIdx];
      return !!cur && cur.sectionKey === sectionKey && cur.key === itemKey;
    },

    activeItemDomId() {
      const flat = this._flatItems();
      const cur = flat[this.paletteIdx];
      if (!cur) return '';
      return this.paletteItemId(cur.sectionKey, cur.key);
    },

    // Aktueller Modus für Mode-Pill (nur wenn Prefix erkannt).
    // Cache pro paletteQuery — Template ruft die Funktion 3× pro Render.
    paletteCurrentMode() {
      if (this._modeCacheQuery === this.paletteQuery) return this._modeCache;
      const parsed = parseQuery(this.paletteQuery);
      let result = null;
      if (parsed.mode === 'commands') result = { key: 'commands', labelKey: 'palette.mode.commands', prefix: '>' };
      else if (parsed.mode === 'provider') result = { key: parsed.provider.key, labelKey: parsed.provider.sectionKey, prefix: parsed.provider.prefix };
      this._modeCacheQuery = this.paletteQuery;
      this._modeCache = result;
      return result;
    },

    // Statische Legende der Prefix-Modi (für Empty-State).
    paletteLegendItems() {
      return [
        { prefix: '>', labelKey: 'palette.legend.commands' },
        { prefix: '#', labelKey: 'palette.legend.pages' },
        { prefix: '!', labelKey: 'palette.legend.chapters' },
        { prefix: '@', labelKey: 'palette.legend.figuren' },
        { prefix: '$', labelKey: 'palette.legend.orte' },
        { prefix: '%', labelKey: 'palette.legend.szenen' },
        { prefix: '&', labelKey: 'palette.legend.ereignisse' },
        { prefix: '?', labelKey: 'palette.legend.fulltext' },
      ];
    },

    onItemHover(sectionKey, itemKey) {
      const flat = this._flatItems();
      const idx = flat.findIndex(it => it.sectionKey === sectionKey && it.key === itemKey);
      if (idx >= 0) this.paletteIdx = idx;
    },

    // t() darf nicht aus dem Root extrahiert werden — i18n.t liest `this.$store.shell.uiLocale`,
    // ein unbound-Aufruf wirft TypeError und kappt das gesamte Alpine-Rendering.
    _t(key, params) {
      const root = window.__app;
      if (root && typeof root.t === 'function') return root.t(key, params);
      return key;
    },

    renderLabelHtml(item) {
      if (item.labelKey) return highlight(this._t(item.labelKey), item.indices || []);
      return highlight(item.label || '', item.indices || []);
    },

    renderSubText(item) {
      if (item.kind === 'toggle' || item.kind === 'action') {
        return item.descKey ? this._t(item.descKey) : '';
      }
      return item.sub || '';
    },

    // ── Aktion ausführen ──────────────────────────────────────────────────
    activateItem(item) {
      if (!item) return;
      if (!item.available) {
        if (item.reasonKey) this._showToast(item.reasonKey);
        return;
      }
      const root = window.__app;
      if (!root) return;

      // Karten-Toggle
      // Palette-Semantik = "zur Karte gehen", nie zumachen. Manche
      // toggleXxxCard-Methoden schliessen beim 2. Klick (stil, fehlerHeatmap,
      // bookStats, bookSettings, userSettings, finetuneExport, export); bei
      // bereits offener Karte daher Toggle überspringen, sonst landet User
      // im Leeren.
      if (item.kind === 'toggle') {
        const fn = root[item.feature.toggle];
        if (typeof fn !== 'function') return;
        this._trackPaletteUsage(item.feature.key);
        const alreadyOpen = !!root[item.feature.flag];
        this.closePalette();
        if (!alreadyOpen) fn.call(root);
        return;
      }
      // Globale Aktion
      if (item.kind === 'action') {
        if (typeof item.feature.run !== 'function') return;
        this.closePalette();
        try { item.feature.run(root); } catch (e) { console.error('[palette action]', e); }
        return;
      }
      // Provider-Item
      if (typeof item.run === 'function') {
        this.closePalette();
        try { item.run(root); } catch (e) { console.error('[palette provider]', e); }
      }
    },

    // Legacy-API: per Klick aus Template bisher activateFeature(key) — bleibt.
    activateFeature(key) {
      const flat = this._flatItems();
      const item = flat.find(it => it.key === key);
      if (item) this.activateItem(item);
    },

    onOverlayClick(event) {
      if (event.target === event.currentTarget) this.closePalette();
    },

    // ── Disabled-Toast ───────────────────────────────────────────────────
    _showToast(key) {
      this.paletteToast = this._t(key);
      if (this._toastTimer) clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => { this.paletteToast = ''; }, 2200);
    },

    // ── Tracking-Quelle markieren ────────────────────────────────────────
    // Karten-Öffnungen werden via $watch in features-usage.js ohnehin getrackt.
    // Zusätzlich melden wir die Quelle 'palette' an /usage/track — Server kann
    // den Source-Tag in Logs auswerten (kein DB-Schema-Change nötig).
    _trackPaletteUsage(key) {
      try {
        fetch('/usage/track', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, source: 'palette', book_id: Alpine.store('nav').selectedBookId || null }),
          credentials: 'same-origin',
        }).catch(() => {});
      } catch {}
    },
  }));
}
