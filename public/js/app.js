import { fetchJson, configureTokenEstimate, escHtml } from './utils.js';
import { configurePrompts } from './prompts.js';

import { bookstackMethods } from './api-bookstack.js';
import { aiMethods } from './api-ai.js';
import { historyMethods } from './history.js';
import { treeMethods } from './tree.js';
import { bookstackSearchMethods } from './bookstack-search.js';
import { lektoratMethods } from './lektorat.js';
import { kapitelReviewMethods } from './kapitel-review.js';
import { registerBookReviewCard } from './cards/book-review-card.js';
import { registerKapitelReviewCard } from './cards/kapitel-review-card.js';
import { figurenMethods } from './figuren.js';
import { ereignisseMethods } from './ereignisse.js';
import { registerBookOverviewCard } from './cards/book-overview-card.js';
import { registerBookStatsCard } from './cards/book-stats-card.js';
import { writingTimeMethods } from './writing-time.js';
import { lektoratTimeMethods } from './lektorat-time.js';
import { registerCatalogStore } from './cards/catalog-store.js';
import { registerEreignisseCard } from './cards/ereignisse-card.js';
import { registerOrteCard } from './cards/orte-card.js';
import { registerSzenenCard } from './cards/szenen-card.js';
import { registerFigurenCard } from './cards/figuren-card.js';
import { registerStilCard } from './cards/stil-card.js';
import { registerFehlerHeatmapCard } from './cards/fehler-heatmap-card.js';
import { registerChatCard } from './cards/chat-card.js';
import { registerIdeenCard } from './cards/ideen-card.js';
import { registerBookChatCard } from './cards/book-chat-card.js';
import { szenenMethods } from './szenen.js';
import { orteMethods } from './orte.js';
import { registerKontinuitaetCard } from './cards/kontinuitaet-card.js';
import { registerBookSettingsCard } from './cards/book-settings-card.js';
import { registerUserSettingsCard } from './cards/user-settings-card.js';
import { registerFinetuneExportCard } from './cards/finetune-export-card.js';
import { registerExportCard } from './cards/export-card.js';
import { registerPdfExportCard } from './cards/pdf-export-card.js';
import { configureI18n, i18nMethods, getSupportedLocales } from './i18n.js';
import { pageViewMethods } from './page-view.js';
import { editorEditMethods } from './editor-edit.js';
import { registerEditorFindCard } from './cards/editor-find-card.js';
import { focusMethods } from './editor-focus.js';
import { synonymMethods } from './editor-synonyme.js';
import { registerEditorSynonymeCard } from './cards/editor-synonyme-card.js';
import { figurLookupMethods } from './editor-figur-lookup.js';
import { registerEditorFigurLookupCard } from './cards/editor-figur-lookup-card.js';
import { registerEditorToolbarCard } from './cards/editor-toolbar-card.js';
import { registerEditorFocusCard } from './cards/editor-focus-card.js';
import { registerLektoratFindingsCard } from './cards/lektorat-findings-card.js';
import { registerPageHistoryCard } from './cards/page-history-card.js';
import { registerPaletteCard } from './cards/palette-card.js';
import { shortcutsMethods } from './shortcuts.js';
import { featuresUsageMethods } from './features-usage.js';
import { initialLektoratState } from './app-state.js';
import { appUiMethods, applySzenenFilters } from './app-ui.js';
import { appChromeMethods } from './app-chrome.js';
import { appKomplettMethods } from './app-komplett.js';
import { appJobsCoreMethods } from './app-jobs-core.js';
import { appViewMethods } from './app-view.js';
import { appNavigationMethods } from './app-navigation.js';
import { appHashRouterMethods } from './app-hash-router.js';
import { offlineSyncMethods } from './offline-sync.js';

// Globaler fetch-Wrapper: fängt 401-Antworten ab und signalisiert Session-Ablauf
// via 'session-expired'-Event. Alpine zeigt daraufhin einen Banner. Kein Auto-
// Redirect – User soll ungespeicherte Änderungen (Editor, Chat) retten können.
// Sonderfall BOOKSTACK_UNAUTHED: der Google-Login ist gültig, nur der
// BookStack-Token ist abgelaufen/ungültig → eigenes Event 'bookstack-token-invalid'.
const __origFetch = window.fetch.bind(window);
window.fetch = async function(...args) {
  const res = await __origFetch(...args);
  if (res.status === 401) {
    let code = '';
    try { code = (await res.clone().json())?.error_code || ''; } catch (_) {}
    if (code === 'BOOKSTACK_UNAUTHED') {
      if (!window.__bookstackUnauthedNotified) {
        window.__bookstackUnauthedNotified = true;
        window.dispatchEvent(new CustomEvent('bookstack-token-invalid'));
      }
    } else if (!window.__sessionExpiredNotified) {
      window.__sessionExpiredNotified = true;
      window.dispatchEvent(new CustomEvent('session-expired'));
    }
  }
  return res;
};

// Service Worker: cached SPA-Shell für Offline/Zug-Modus. Nur über HTTPS bzw.
// localhost registrierbar. Fehler schlucken – SW ist Progressive Enhancement.
// Dev/Localhost: SW deaktiviert (Cache-Artefakte beim Entwickeln eklig).
// Override pro Browser via `localStorage.setItem('sw', '1')` (an) bzw. `'0'` (aus).
if ('serviceWorker' in navigator) {
  const swPref = localStorage.getItem('sw');
  const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const swEnabled = swPref === '1'
    || (swPref !== '0' && location.protocol === 'https:' && !isLocal);

  if (swEnabled) {
    window.addEventListener('load', async () => {
      try {
        const reg = await navigator.serviceWorker.register('/sw.js');
        // Periodisch nach Updates fragen — ohne aktiven update()-Call wartet
        // der Browser u.U. Stunden bis Tage, bis er einen neuen SW
        // einspielt; v.a. auf Mobile (Tab im Hintergrund / SW gekillt) sieht
        // der User Frontend-Updates dann nie. 60s ist günstig: minimale
        // Bandbreite (nur sw.js wird revalidiert), schnelle Sichtbarkeit.
        setInterval(() => { reg.update().catch(() => {}); }, 60_000);
        const notify = (worker) => {
          if (!worker || !navigator.serviceWorker.controller) return;
          window.__pendingWorker = worker;
          window.dispatchEvent(new CustomEvent('app:update-available'));
        };
        if (reg.waiting) notify(reg.waiting);
        reg.addEventListener('updatefound', () => {
          const nw = reg.installing;
          nw?.addEventListener('statechange', () => {
            if (nw.state === 'installed') notify(nw);
          });
        });
        // Controllerchange feuert, sobald der neue SW (skipWaiting in sw.js)
        // die Seite übernimmt. Auto-Reload nur, wenn der Editor nicht dirty ist
        // — sonst Banner zeigen, damit der User erst speichern kann. Die neue
        // SW-Version bedient zwar schon Assets, aber alte JS-Module laufen
        // noch; Reload räumt das mit dem nächsten User-Klick auf.
        let reloaded = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (reloaded) return;
          reloaded = true;
          const app = window.__app;
          if (app?.editMode && app?.editDirty) {
            app.updateAvailable = true;
            return;
          }
          location.reload();
        });
      } catch {}
    });
  } else {
    navigator.serviceWorker.getRegistrations()
      .then(regs => regs.forEach(r => r.unregister()))
      .catch(() => {});
    if (window.caches) {
      caches.keys()
        .then(keys => Promise.all(keys.map(k => caches.delete(k))))
        .catch(() => {});
    }
  }
}

// `.internal-link`-Spans verhalten sich wie Buttons (z.B. Kapitel-Sprünge,
// Figuren-Öffnen). Per Delegation und MutationObserver machen wir sie
// tastatur-erreichbar (Tab/Enter/Space), ohne in jedem Partial role/tabindex
// setzen zu müssen. `:focus-visible`-Stil kommt aus style.css.
const decorateInternalLinks = (root) => {
  root.querySelectorAll?.('.internal-link').forEach(el => {
    if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
  });
};
new MutationObserver(muts => {
  for (const m of muts) {
    if (m.type === 'attributes') {
      // `:class="…internal-link…"`-Toggles auf bereits gemounteten Elementen
      // tauchen nicht in addedNodes auf; ohne attributeFilter würde A11y dort
      // nie greifen (Tab/Enter würde den Klick nicht auslösen).
      const t = m.target;
      if (t?.nodeType === 1 && t.classList?.contains('internal-link')) {
        if (!t.hasAttribute('role')) t.setAttribute('role', 'button');
        if (!t.hasAttribute('tabindex')) t.setAttribute('tabindex', '0');
      }
      continue;
    }
    for (const n of m.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (n.classList?.contains('internal-link')) {
        if (!n.hasAttribute('role')) n.setAttribute('role', 'button');
        if (!n.hasAttribute('tabindex')) n.setAttribute('tabindex', '0');
      }
      decorateInternalLinks(n);
    }
  }
}).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (!t?.classList?.contains?.('internal-link')) return;
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    t.click();
  }
});

document.addEventListener('alpine:init', () => {
  // Magic `$app` — verweist auf die `lektorat`-Root-Komponente am body. In
  // Alpine ist `$root` das nächste x-data-Element (bei Sub-Komponenten also die
  // Sub selbst), nicht die Top-Level-Komponente. Sub-Komponenten und Partials
  // greifen über $app auf Root-Methoden und geteilten State zu. Die Referenz
  // wird in Root.init() auf window.__app gesetzt (garantiert reactive proxy) —
  // Alpine.$data(document.body) liefert bei manchen Getter-Evaluationen undefined.
  Alpine.magic('app', () => window.__app || Alpine.$data(document.body));

  registerCatalogStore();
  registerStilCard();
  registerFehlerHeatmapCard();
  registerBookOverviewCard();
  registerBookStatsCard();
  registerBookSettingsCard();
  registerUserSettingsCard();
  registerFinetuneExportCard();
  registerExportCard();
  registerPdfExportCard();
  registerKontinuitaetCard();
  registerEreignisseCard();
  registerOrteCard();
  registerSzenenCard();
  registerFigurenCard();
  registerBookReviewCard();
  registerKapitelReviewCard();
  registerChatCard();
  registerIdeenCard();
  registerBookChatCard();
  registerEditorFindCard();
  registerEditorFigurLookupCard();
  registerEditorSynonymeCard();
  registerEditorToolbarCard();
  registerEditorFocusCard();
  registerLektoratFindingsCard();
  registerPageHistoryCard();
  registerPaletteCard();

  Alpine.data('combobox', (placeholder = null, emptyLabel = null) => ({
    open: false,
    query: '',
    value: null,
    options: [],
    _disabled: false,
    _placeholder: placeholder,
    _emptyLabel: emptyLabel,
    highlighted: -1,
    openUp: false,

    get placeholder() {
      return this._placeholder ?? window.__app?.t?.('common.choose') ?? 'Auswählen…';
    },
    get emptyLabel() {
      return this._emptyLabel;
    },
    get _allOptions() {
      return this.emptyLabel
        ? [{ value: '', label: this.emptyLabel }, ...this.options]
        : this.options;
    },
    get filtered() {
      if (!this.query) return this._allOptions;
      const q = this.query.toLowerCase();
      return this._allOptions.filter(o => String(o.label).toLowerCase().includes(q));
    },
    get selectedLabel() {
      if (this.value === '' || this.value === null || this.value === undefined) return this.emptyLabel || '';
      const opt = this._allOptions.find(o => String(o.value) === String(this.value));
      return opt ? opt.label : '';
    },

    toggle() {
      if (this._disabled) return;
      if (this.open) { this.close(); return; }
      this.open = true;
      this.query = '';
      this.highlighted = this._allOptions.findIndex(o => String(o.value) === String(this.value));
      this.$nextTick(() => {
        this._decideOpenDirection();
        this.$refs.cbInput?.focus();
      });
    },
    _decideOpenDirection() {
      const trigger = this.$el.querySelector('.combobox-trigger');
      const dropdown = this.$el.querySelector('.combobox-dropdown');
      if (!trigger || !dropdown) { this.openUp = false; return; }
      const triggerRect = trigger.getBoundingClientRect();
      const dropdownH = dropdown.getBoundingClientRect().height || 250;
      const spaceBelow = window.innerHeight - triggerRect.bottom;
      const spaceAbove = triggerRect.top;
      this.openUp = spaceBelow < dropdownH && spaceAbove > spaceBelow;
    },
    close() {
      this.open = false;
      this.query = '';
      this.highlighted = -1;
      this.openUp = false;
    },
    select(val) {
      this.value = val;
      this.close();
      this.$dispatch('combobox-change', val);
    },
    onKeydown(e) {
      if (!this.open) {
        if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); this.toggle(); }
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.highlighted = Math.min(this.highlighted + 1, this.filtered.length - 1);
        this._scrollHl();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.highlighted = Math.max(this.highlighted - 1, 0);
        this._scrollHl();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (this.highlighted >= 0 && this.filtered[this.highlighted]) this.select(this.filtered[this.highlighted].value);
      } else if (e.key === 'Escape') {
        e.preventDefault(); this.close();
      }
    },
    _scrollHl() {
      this.$nextTick(() => {
        const list = this.$el.querySelector('.combobox-list');
        const item = list?.children[this.highlighted];
        item?.scrollIntoView({ block: 'nearest' });
      });
    },
    init() {
      // ARIA: das gesamte Widget verhält sich wie ein Combobox mit Listbox-Popup.
      // aria-expanded gibt Screenreadern den Öffnungszustand, aria-activedescendant
      // verweist auf die aktuell via Tastatur markierte Option.
      this.$el.setAttribute('role', 'combobox');
      this.$el.setAttribute('aria-haspopup', 'listbox');
      // Bei Query-Änderung Highlight an Filter-Liste angleichen, sonst zeigt der
      // alte Index ins gefilterte Array hinein und Enter selektiert undefined.
      this.$watch('query', () => {
        this.highlighted = this.filtered.length > 0 ? 0 : -1;
      });
      this.$el.innerHTML = `
        <button type="button" class="combobox-trigger" @click="toggle()"
                :aria-expanded="open ? 'true' : 'false'"
                :aria-label="selectedLabel || placeholder">
          <span class="combobox-value" x-text="selectedLabel || placeholder"></span>
          <svg class="combobox-chevron" :class="{'combobox-chevron--open': open}" width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M1.5 3.5L5 7L8.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <div class="combobox-dropdown" :class="{'combobox-dropdown--up': openUp}" x-show="open" x-cloak>
          <input type="text" class="combobox-search" x-model="query" x-ref="cbInput"
                 :placeholder="$app.t('common.searchShort')" role="searchbox" :aria-label="$app.t('common.searchShort')">
          <ul class="combobox-list" role="listbox"
              :aria-activedescendant="highlighted >= 0 ? ($id('cb-opt') + '-' + highlighted) : null">
            <template x-for="(opt, i) in filtered" :key="opt.value">
              <li class="combobox-option"
                  role="option"
                  :id="$id('cb-opt') + '-' + i"
                  :aria-selected="String(opt.value) === String(value) ? 'true' : 'false'"
                  :class="{'combobox-option--selected': String(opt.value) === String(value), 'combobox-option--hl': i === highlighted}"
                  @click="select(opt.value)" @mouseenter="highlighted = i"
                  x-text="opt.label"></li>
            </template>
            <li class="combobox-empty" x-show="filtered.length === 0" x-text="$app.t('find.noMatches')"></li>
          </ul>
        </div>
      `;
    },
  }));

  Alpine.data('lektorat', () => ({
    // ── State ────────────────────────────────────────────────────────────────
    ...initialLektoratState(),

    // ── Catalog-Proxy ────────────────────────────────────────────────────────
    // Figuren, Orte, Szenen, globalZeitstrahl leben in Alpine.store('catalog').
    // Root exponiert sie als direkt adressierbare Properties, damit this.figuren=
    // / this.orte.push weiter funktionieren. Karten können auch direkt via
    // $store.catalog zugreifen.
    get figuren() { return Alpine.store('catalog').figuren; },
    set figuren(v) { Alpine.store('catalog').figuren = v; },
    get orte() { return Alpine.store('catalog').orte; },
    set orte(v) { Alpine.store('catalog').orte = v; },
    get szenen() { return Alpine.store('catalog').szenen; },
    set szenen(v) { Alpine.store('catalog').szenen = v; },
    get globalZeitstrahl() { return Alpine.store('catalog').globalZeitstrahl; },
    set globalZeitstrahl(v) { Alpine.store('catalog').globalZeitstrahl = v; },

    // ── Computed ─────────────────────────────────────────────────────────────
    // O(1)-Lookup-Maps für Figuren/Orte. Rebuild nur bei Referenz-Wechsel
    // (loadFiguren/loadOrte reassignen, pushen nie). In Render-Loops
    // (figuren.html, orte.html, szenen.html) ersetzen diese ein vielfaches
    // `.find(x => x.id === id)` pro Zeile durch einen Map-Lookup.
    get figurenById() {
      if (this._figMapRef !== this.figuren) {
        this._figMapRef = this.figuren;
        this._figMap = new Map((this.figuren || []).map(f => [f.id, f]));
      }
      return this._figMap;
    },
    get orteById() {
      if (this._ortMapRef !== this.orte) {
        this._ortMapRef = this.orte;
        this._ortMap = new Map((this.orte || []).map(o => [o.id, o]));
      }
      return this._ortMap;
    },
    get szenenById() {
      if (this._szeneMapRef !== this.szenen) {
        this._szeneMapRef = this.szenen;
        this._szeneMap = new Map((this.szenen || []).map(s => [s.id, s]));
      }
      return this._szeneMap;
    },

    get szenenNachKapitel() {
      const map = new Map();
      for (const s of this.szenen) {
        if (!map.has(s.kapitel)) map.set(s.kapitel, { total: 0, stark: 0, mittel: 0, schwach: 0 });
        const e = map.get(s.kapitel);
        e.total++;
        if (s.wertung === 'stark')        e.stark++;
        else if (s.wertung === 'mittel')  e.mittel++;
        else if (s.wertung === 'schwach') e.schwach++;
      }
      return [...map.entries()].map(([name, c]) => ({ name, ...c }))
        .sort((a, b) => this._chapterIdx(a.name) - this._chapterIdx(b.name));
    },
    get szenenNachSeite() {
      const map = new Map();
      for (const s of this.szenen) {
        if (!s.seite) continue;
        if (!map.has(s.seite)) map.set(s.seite, { total: 0, kapitel: s.kapitel });
        map.get(s.seite).total++;
      }
      return [...map.entries()].map(([name, d]) => ({ name, total: d.total, kapitel: d.kapitel }))
        .sort((a, b) => {
          const c = this._chapterIdx(a.kapitel) - this._chapterIdx(b.kapitel);
          return c !== 0 ? c : this._pageIdx(a.name) - this._pageIdx(b.name);
        });
    },
    get orteFiltered() {
      const q = this.orteFilters.suche ? this.orteFilters.suche.toLowerCase() : '';
      return this.orte.filter(o =>
        (!q || (o.name || '').toLowerCase().includes(q)) &&
        (!this.orteFilters.figurId || (o.figuren || []).includes(this.orteFilters.figurId)) &&
        (!this.orteFilters.kapitel || (o.kapitel || []).some(k => k.name === this.orteFilters.kapitel || String(k.chapter_id) === String(this.orteFilters.kapitel))) &&
        (!this.orteFilters.szeneId || this.szenen.some(s => String(s.id) === String(this.orteFilters.szeneId) && (s.ort_ids || []).includes(o.id)))
      ).sort((a, b) => {
        const aK = Math.min(...(a.kapitel || []).map(k => this._chapterIdx(k.name)), 9999);
        const bK = Math.min(...(b.kapitel || []).map(k => this._chapterIdx(k.name)), 9999);
        if (aK !== bK) return aK - bK;
        const aP = this._pageIdIdx(a.erste_erwaehnung_page_id);
        const bP = this._pageIdIdx(b.erste_erwaehnung_page_id);
        if (aP !== bP) return aP - bP;
        return (a.name || '').localeCompare(b.name || '', 'de');
      });
    },
    get szenenFiltered() {
      return applySzenenFilters(this.szenen, this.szenenFilters).sort((a, b) => {
        const c = this._chapterIdx(a.kapitel) - this._chapterIdx(b.kapitel);
        if (c !== 0) return c;
        const p = this._pageIdx(a.seite) - this._pageIdx(b.seite);
        if (p !== 0) return p;
        return (a.titel || '').localeCompare(b.titel || '', 'de');
      });
    },

    get statusHtml() {
      if (!this.status) return '';
      const safe = escHtml(this.status);
      return this.statusSpinner
        ? `<span class="spinner"></span>${safe}`
        : safe;
    },

    // Zielseiten für Ideen-Verschieben-Combobox: Seiten gleichen Kapitels,
    // aktuelle Seite ausgeschlossen. Liegt am Root, weil x-effect der
    // Combobox-Sub-x-data nur $app/Magics, nicht Karten-Methoden sieht.
    ideenMovePickerOptions() {
      const cur = this.currentPage;
      if (!cur?.id) return [];
      const tree = this.tree || [];
      const pages = cur.chapter_id
        ? (tree.find(it => it.type === 'chapter' && it.id === cur.chapter_id)?.pages || [])
            .filter(p => p.id !== cur.id)
        : tree.filter(it => it.type === 'page' && it.id !== cur.id && it.page).map(it => it.page);
      return pages.map(p => ({ value: p.id, label: p.name }));
    },

    get selectedBookName() {
      const book = this.books.find(b => String(b.id) === String(this.selectedBookId));
      return book?.name || '';
    },

    get selectedBookUrl() {
      const book = this.books.find(b => String(b.id) === String(this.selectedBookId));
      return book?.slug && this.bookstackUrl
        ? `${this.bookstackUrl}/books/${book.slug}`
        : null;
    },

    get filteredTree() {
      if (!this.pageSearch) return this.tree;
      const q = this.pageSearch.toLowerCase();
      return this.tree.map(item => {
        if (item.type === 'chapter') {
          const pages = item.pages.filter(p => p.name.toLowerCase().includes(q));
          if (!pages.length) return null;
          return { ...item, pages, open: true };
        }
        return item.page?.name.toLowerCase().includes(q) ? item : null;
      }).filter(Boolean);
    },

    // AbortController `_abortCtrl` (initialisiert via app-state.js) hält alle
    // globalen Listener dieser Komponente. `destroy()` (Alpine-Hook) ruft abort()
    // → alle Listener werden automatisch entfernt. Schützt vor doppelter
    // Registrierung bei Re-Init.
    destroy() {
      this._abortCtrl?.abort();
      if (this._jobQueueTimer) clearInterval(this._jobQueueTimer);
      if (this._statusTimer) clearTimeout(this._statusTimer);
      if (typeof this._teardownStatsObserver === 'function') this._teardownStatsObserver();
    },

    // ── Initialisierung ──────────────────────────────────────────────────────
    async init() {
      // Referenz für $app-Magic (siehe oben).
      window.__app = this;
      this._abortCtrl?.abort();
      this._abortCtrl = new AbortController();
      const signal = this._abortCtrl.signal;
      // Tracking-Watcher früh registrieren, damit auch Karten-Öffnungen
      // während der initialen Hash-Anwendung erfasst werden.
      this.setupFeatureUsageWatchers();
      // Plattform-Detect für Tasten-Hints (⌘ vs. Ctrl).
      const ua = navigator.userAgent || '';
      const plat = navigator.platform || '';
      this.isMac = /Mac|iPhone|iPad|iPod/.test(plat) || /Mac OS X/.test(ua);
      this.themePref = window.__themePref || 'auto';
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (this.themePref === 'auto') this._applyTheme();
      }, { signal });
      window.addEventListener('session-expired', () => { this.sessionExpired = true; }, { signal });
      window.addEventListener('bookstack-token-invalid', () => { this.bookstackTokenInvalid = true; }, { signal });
      window.addEventListener('beforeunload', (e) => {
        if (this.editMode && this.editDirty) { e.preventDefault(); e.returnValue = ''; }
      }, { signal });
      this._setupOfflineSync();
      // Shell zuerst aufbauen: i18n + Partials brauchen nur statische Assets
      // (Service Worker cacht sie). /config kann danach scheitern, ohne dass
      // das UI leer bleibt – Offline-Banner erscheint stattdessen.
      const browserLoc = (navigator.language || 'de').slice(0, 2);
      const supported  = getSupportedLocales();
      const fallbackLocale = supported.includes(browserLoc) ? browserLoc : 'de';
      try {
        await configureI18n(fallbackLocale);
        this.uiLocale = fallbackLocale;
        document.documentElement.setAttribute('lang', fallbackLocale);
        await this._loadPartials();
        this._initSidebarResize();
      } catch (e) {
        console.error('[init:shell]', e);
      }

      let cfg = null;
      try {
        cfg = await fetchJson('/config');
      } catch (e) {
        console.error('[init:config]', e);
        this.serverOffline = true;
        return;
      }

      try {
        const preferred = cfg.userSettings?.locale || browserLoc || 'de';
        const locale = supported.includes(preferred) ? preferred : 'de';
        if (locale !== this.uiLocale) {
          await configureI18n(locale);
          this.uiLocale = locale;
          document.documentElement.setAttribute('lang', locale);
        }
        this.bookstackUrl = cfg.bookstackUrl || '';
        if (cfg.claudeModel) this.claudeModel = cfg.claudeModel;
        if (cfg.claudeMaxTokens) this.claudeMaxTokens = cfg.claudeMaxTokens;
        if (cfg.apiProvider) this.apiProvider = cfg.apiProvider;
        if (cfg.ollamaModel) this.ollamaModel = cfg.ollamaModel;
        if (cfg.llamaModel)  this.llamaModel  = cfg.llamaModel;
        this.currentUser = cfg.user || null;
        this.devMode = !!cfg.devMode;
        this.promptConfig = cfg.promptConfig || {};
        if (cfg.userSettings?.theme && cfg.userSettings.theme !== this.themePref) {
          this.themePref = cfg.userSettings.theme;
          try { localStorage.setItem('theme', this.themePref); } catch (e) {}
          this._applyTheme();
        }
        const fg = cfg.userSettings?.focus_granularity;
        if (fg === 'paragraph' || fg === 'sentence' || fg === 'window-3' || fg === 'typewriter-only') {
          this.focusGranularity = fg;
        }
        configurePrompts(cfg.promptConfig, cfg.apiProvider || 'claude');
        configureTokenEstimate(cfg.charsPerToken);
        if (!cfg.bookstackTokenOk) {
          this.showTokenSetup = true;
          return;
        }

        // Hash vorab auswerten, damit loadBooks das gewünschte Buch wählt.
        // _applyingHash unterdrückt Watcher/URL-Writes während der Initialisierung.
        this._applyingHash = true;
        const hashParts = (location.hash || '').replace(/^#/, '').split('/').filter(Boolean);
        if (hashParts[0] === 'book' && hashParts[1]) {
          this.selectedBookId = hashParts[1];
        }
        await this.loadBooks();
        // Top-3 Recency-Features für Quick-Pills laden (best-effort).
        this.loadRecentFeatures();
        if (this.selectedBookId) this.loadRecentPages(this.selectedBookId);
        await this._applyHash();
        this._maybeOpenBookOverview();
        this._syncUrlNow();
        this._applyingHash = false;
        this._setupHashRouting();
        // Buchwechsel (Combobox, Hash-Nav oder programmatisch) → Seiten/Tree neu laden.
        // _applyingHash unterdrückt Doppelladen während Hash-Anwendung.
        // _resetBookScopedState() räumt buchspezifische Daten/Caches ab, damit
        // keine Figuren/Orte/Chats/Stats des alten Buchs im UI stehenbleiben.
        this.$watch('selectedBookId', async (newVal, oldVal) => {
          if (this._applyingHash) return;
          if (!newVal) return;
          // Alpine kann den Watcher mit identischem Wert feuern (z.B. bei
          // Combobox-Re-Selection oder String/Number-Coercion). Doppelter
          // _resetBookScopedState löscht User-Eingaben (Filter, offene Karten),
          // also überspringen.
          if (String(newVal) === String(oldVal)) return;
          this._resetBookScopedState();
          await this.loadPages();
          await this._reloadVisibleBookCards();
          this._maybeOpenBookOverview();
        });
        this._startJobQueuePoll();
        this._setupWritingTime();
        this._setupLektoratTime();
      } catch (e) {
        console.error('[init]', e);
        this.setStatus(this.t('app.configLoadError'));
      }
    },

    // ── Methoden aus Modulen ─────────────────────────────────────────────────
    ...bookstackMethods,
    ...aiMethods,
    ...historyMethods,
    ...treeMethods,
    ...bookstackSearchMethods,
    ...lektoratMethods,
    ...kapitelReviewMethods,
    ...figurenMethods,
    ...ereignisseMethods,
    // writingTimeMethods bleiben im Root: Schreibzeit-Heartbeat lauscht auf
    // editMode/focusMode, läuft unabhängig von der bookStatsCard-Sichtbarkeit.
    ...writingTimeMethods,
    // lektoratTimeMethods analog: lauscht auf checkDone (Prüfmodus) +
    // currentPage.id + selectedBookId; bucht Sekunden pro (User, Buch, Seite, Tag).
    ...lektoratTimeMethods,
    ...szenenMethods,
    ...orteMethods,
    ...i18nMethods,
    ...pageViewMethods,
    ...editorEditMethods,
    ...focusMethods,
    ...synonymMethods,
    ...figurLookupMethods,
    ...shortcutsMethods,
    ...appUiMethods,
    ...appChromeMethods,
    ...appKomplettMethods,
    ...appJobsCoreMethods,
    ...appViewMethods,
    ...appNavigationMethods,
    ...appHashRouterMethods,
    ...offlineSyncMethods,
    ...featuresUsageMethods,
  }));
});
