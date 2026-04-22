import { fetchJson } from './utils.js';
import { configurePrompts } from './prompts.js';

import { bookstackMethods } from './api-bookstack.js';
import { aiMethods } from './api-ai.js';
import { historyMethods } from './history.js';
import { treeMethods } from './tree.js';
import { bookstackSearchMethods } from './bookstack-search.js';
import { lektoratMethods } from './lektorat.js';
import { reviewMethods } from './review.js';
import { kapitelReviewMethods } from './kapitel-review.js';
import { figurenMethods } from './figuren.js';
import { ereignisseMethods } from './ereignisse.js';
import { graphMethods } from './graph.js';
import { bookstatsMethods } from './bookstats.js';
import { writingTimeMethods } from './writing-time.js';
import { stilMethods } from './stil-heatmap.js';
import { fehlerHeatmapMethods } from './fehler-heatmap.js';
import { chatMethods } from './chat.js';
import { bookChatMethods } from './book-chat.js';
import { szenenMethods } from './szenen.js';
import { orteMethods } from './orte.js';
import { kontinuitaetMethods } from './kontinuitaet.js';
import { bookSettingsMethods } from './book-settings.js';
import { userSettingsMethods } from './user-settings.js';
import { configureI18n, i18nMethods, getSupportedLocales } from './i18n.js';
import { pageViewMethods } from './page-view.js';
import { editorEditMethods } from './editor-edit.js';
import { editorFindMethods } from './editor-find.js';
import { focusMethods } from './editor-focus.js';
import { synonymMethods } from './editor-synonyme.js';
import { figurLookupMethods } from './editor-figur-lookup.js';
import { toolbarMethods } from './editor-toolbar.js';
import { shortcutsMethods } from './shortcuts.js';
import { initialLektoratState } from './app-state.js';
import { appUiMethods } from './app-ui.js';
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
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
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
    for (const n of m.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (n.classList?.contains('internal-link')) {
        if (!n.hasAttribute('role')) n.setAttribute('role', 'button');
        if (!n.hasAttribute('tabindex')) n.setAttribute('tabindex', '0');
      }
      decorateInternalLinks(n);
    }
  }
}).observe(document.documentElement, { childList: true, subtree: true });
document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (!t?.classList?.contains?.('internal-link')) return;
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    t.click();
  }
});

document.addEventListener('alpine:init', () => {
  Alpine.data('combobox', (placeholder = 'Auswählen…', emptyLabel = null) => ({
    open: false,
    query: '',
    value: null,
    options: [],
    _disabled: false,
    placeholder,
    emptyLabel,
    highlighted: -1,

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
      this.$nextTick(() => this.$refs.cbInput?.focus());
    },
    close() {
      this.open = false;
      this.query = '';
      this.highlighted = -1;
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
      this.$el.innerHTML = `
        <button type="button" class="combobox-trigger" @click="toggle()"
                :aria-expanded="open ? 'true' : 'false'"
                :aria-label="selectedLabel || placeholder">
          <span class="combobox-value" x-text="selectedLabel || placeholder"></span>
          <svg class="combobox-chevron" :class="{'combobox-chevron--open': open}" width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M1.5 3.5L5 7L8.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <div class="combobox-dropdown" x-show="open" x-cloak>
          <input type="text" class="combobox-search" x-model="query" x-ref="cbInput"
                 placeholder="Suchen…" role="searchbox" aria-label="Suchen">
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
            <li class="combobox-empty" x-show="filtered.length === 0">Keine Treffer</li>
          </ul>
        </div>
      `;
    },
  }));

  Alpine.data('lektorat', () => ({
    // ── State ────────────────────────────────────────────────────────────────
    ...initialLektoratState(),

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
        (!this.orteFilters.kapitel || (o.kapitel || []).some(k => k.name === this.orteFilters.kapitel)) &&
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
      const q = this.szenenSuche ? this.szenenSuche.toLowerCase() : '';
      return this.szenen.filter(s =>
        (!q || (s.titel || '').toLowerCase().includes(q)) &&
        (!this.szenenFilterWertung || s.wertung === this.szenenFilterWertung) &&
        (!this.szenenFilterFigurId || (s.fig_ids || []).includes(this.szenenFilterFigurId)) &&
        (!this.szenenFilterKapitel || s.kapitel === this.szenenFilterKapitel) &&
        (!this.szenenFilterSeite || s.seite === this.szenenFilterSeite) &&
        (!this.szenenFilterOrtId || (s.ort_ids || []).includes(this.szenenFilterOrtId))
      ).sort((a, b) => {
        const c = this._chapterIdx(a.kapitel) - this._chapterIdx(b.kapitel);
        if (c !== 0) return c;
        const p = this._pageIdx(a.seite) - this._pageIdx(b.seite);
        if (p !== 0) return p;
        return (a.titel || '').localeCompare(b.titel || '', 'de');
      });
    },

    get kontinuitaetIssuesFiltered() {
      const chapters = (this.tree || []).filter(t => t.type === 'chapter');
      const chapterNames = new Set(chapters.map(t => t.name));
      const fromStelle = (s) => {
        if (!s) return null;
        const ci = s.indexOf(':');
        const c = ci > 0 ? s.substring(0, ci).trim() : s.trim();
        return chapterNames.has(c) ? c : null;
      };
      return (this.kontinuitaetResult?.issues || []).filter(issue => {
        if (this.kontinuitaetFilters.figurId) {
          if (issue.fig_ids?.length) {
            if (!issue.fig_ids.includes(this.kontinuitaetFilters.figurId)) return false;
          } else {
            const selectedName = this.figuren.find(f => f.id === this.kontinuitaetFilters.figurId)?.name || '';
            if (selectedName && !(issue.figuren || []).includes(selectedName)) return false;
          }
        }
        if (this.kontinuitaetFilters.kapitel) {
          const f = this.kontinuitaetFilters.kapitel;
          const selectedId = chapters.find(t => t.name === f)?.id;
          const idMatch    = selectedId !== undefined && issue.chapter_ids?.includes(selectedId);
          const nameMatch  = (issue.kapitel || []).includes(f);
          const stelleMatch = fromStelle(issue.stelle_a) === f || fromStelle(issue.stelle_b) === f;
          if (!idMatch && !nameMatch && !stelleMatch) return false;
        }
        return true;
      });
    },

    get statusHtml() {
      if (!this.status) return '';
      return this.statusSpinner
        ? `<span class="spinner"></span>${this.status}`
        : this.status;
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

    // Hash-Router: _computeHash, _hashCategory, _writeHash, _syncUrlNow,
    // _updateHash, _applyHash, _setupHashRouting — siehe app-hash-router.js.

    // AbortController `_abortCtrl` (initialisiert via app-state.js) hält alle
    // globalen Listener dieser Komponente. `destroy()` (Alpine-Hook) ruft abort()
    // → alle Listener werden automatisch entfernt. In der Praxis lebt die
    // Root-Komponente so lange wie die Seite, aber der Controller schützt vor
    // doppelter Registrierung bei Re-Init.
    destroy() {
      this._abortCtrl?.abort();
      if (this._jobQueueTimer) clearInterval(this._jobQueueTimer);
      if (this._statusTimer) clearTimeout(this._statusTimer);
    },

    // ── Initialisierung ──────────────────────────────────────────────────────
    async init() {
      this._abortCtrl?.abort();
      this._abortCtrl = new AbortController();
      const signal = this._abortCtrl.signal;
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
        this._installToolbarListeners();
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
        configurePrompts(cfg.promptConfig, cfg.apiProvider || 'claude');
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
        await this._applyHash();
        this._syncUrlNow();
        this._applyingHash = false;
        this._setupHashRouting();
        // Buchwechsel (Combobox, Hash-Nav oder programmatisch) → Seiten/Tree neu laden.
        // _applyingHash unterdrückt Doppelladen während Hash-Anwendung.
        // _resetBookScopedState() räumt buchspezifische Daten/Caches ab, damit
        // keine Figuren/Orte/Chats/Stats des alten Buchs im UI stehenbleiben.
        this.$watch('selectedBookId', async (newVal) => {
          if (this._applyingHash) return;
          if (!newVal) return;
          this._resetBookScopedState();
          await this.loadPages();
          await this._reloadVisibleBookCards();
        });
        // Figurengraph/Soziogramm enthalten übersetzte Labels (Schicht, Beziehung, Figurentyp).
        // Bei Sprachwechsel neu rendern – der Hash in renderFigurGraph() berücksichtigt uiLocale.
        this.$watch('uiLocale', () => {
          if (this.showFiguresCard && this.figuren?.length) this.renderFigurGraph();
        });
        this._startJobQueuePoll();
        this._setupWritingTime();
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
    ...reviewMethods,
    ...kapitelReviewMethods,
    ...figurenMethods,
    ...ereignisseMethods,
    ...graphMethods,
    ...bookstatsMethods,
    ...writingTimeMethods,
    ...stilMethods,
    ...fehlerHeatmapMethods,
    ...chatMethods,
    ...bookChatMethods,
    ...szenenMethods,
    ...orteMethods,
    ...kontinuitaetMethods,
    ...bookSettingsMethods,
    ...userSettingsMethods,
    ...i18nMethods,
    ...pageViewMethods,
    ...editorEditMethods,
    ...editorFindMethods,
    ...focusMethods,
    ...synonymMethods,
    ...figurLookupMethods,
    ...toolbarMethods,
    ...shortcutsMethods,
    ...appUiMethods,
    ...appChromeMethods,
    ...appKomplettMethods,
    ...appJobsCoreMethods,
    ...appViewMethods,
    ...appNavigationMethods,
    ...appHashRouterMethods,
    ...offlineSyncMethods,
  }));
});
