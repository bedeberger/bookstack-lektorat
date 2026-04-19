import { escHtml, escPreserveStrong, htmlToText, fmtTok, stripFocusArtefacts, fetchJson, fetchText } from './utils.js';
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

const FIGUR_TYP_ORDER = { hauptfigur: 0, antagonist: 1, mentor: 2, nebenfigur: 3, andere: 4 };

// Globaler fetch-Wrapper: fängt 401-Antworten ab und signalisiert Session-Ablauf
// via 'session-expired'-Event. Alpine zeigt daraufhin einen Banner. Kein Auto-
// Redirect – User soll ungespeicherte Änderungen (Editor, Chat) retten können.
const __origFetch = window.fetch.bind(window);
window.fetch = async function(...args) {
  const res = await __origFetch(...args);
  if (res.status === 401 && !window.__sessionExpiredNotified) {
    window.__sessionExpiredNotified = true;
    window.dispatchEvent(new CustomEvent('session-expired'));
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
      this.$el.innerHTML = `
        <button type="button" class="combobox-trigger" @click="toggle()">
          <span class="combobox-value" x-text="selectedLabel || placeholder"></span>
          <svg class="combobox-chevron" :class="{'combobox-chevron--open': open}" width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M1.5 3.5L5 7L8.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <div class="combobox-dropdown" x-show="open" x-cloak>
          <input type="text" class="combobox-search" x-model="query" x-ref="cbInput" placeholder="Suchen…">
          <ul class="combobox-list">
            <template x-for="(opt, i) in filtered" :key="opt.value">
              <li class="combobox-option"
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
    currentUser: null,
    devMode: false,
    sessionExpired: false,
    themePref: 'auto',
    uiLocale: '',
    bookstackUrl: '',
    promptConfig: {},
    showTokenSetup: false,
    tokenSetupId: '',
    tokenSetupPw: '',
    tokenSetupError: '',
    tokenSetupLoading: false,
    claudeModel: 'claude-sonnet-4-6',
    claudeMaxTokens: 64000,
    apiProvider: 'claude',
    ollamaModel: 'llama3.2',
    llamaModel:  'llama3.2',
    books: [],
    selectedBookId: '',
    pages: [],
    tree: [],
    _applyingHash: false,
    _hashInitialized: false,
    _hashUpdatePending: false,
    _navDepth: 0,
    _inHashApply: false,
    _chapterOrderMap: null,
    _pageOrderMap: null,
    _pageIdOrderMap: null,
    pageSearch: '',
    bookstackSearch: '',
    bookstackSearchResults: [],
    bookstackSearchLoading: false,
    bookstackSearchError: '',
    bookstackSearched: false,
    _bookstackSearchTimer: null,
    _bookstackSearchAbort: null,
    _bookstackSearchSeq: 0,
    currentPage: null,
    currentPageEmpty: false,
    renderedPageHtml: '',
    chapterFigures: [],
    showChapterFigures: false,
    originalHtml: null,
    correctedHtml: null,
    hasErrors: false,
    editMode: false,
    editDirty: false,
    editSaving: false,
    saveOffline: false,
    lastAutosaveAt: null,
    lastDraftSavedAt: null,
    _autosaveTimer: null,
    _draftTimer: null,
    _onlineHandler: null,
    showSynonymMenu: false,
    synonymMenuX: 0,
    synonymMenuY: 0,
    showSynonymPicker: false,
    synonymThesList: [],
    synonymThesLoading: false,
    synonymThesError: '',
    synonymThesDisabled: false,
    synonymKiList: [],
    synonymKiLoading: false,
    synonymKiError: '',
    _synonymRange: null,
    _synonymWord: '',
    _synonymPollTimer: null,
    _synonymScrollHandler: null,
    showFigurLookup: false,
    figurLookupX: 0,
    figurLookupY: 0,
    figurLookupData: null,
    _figurLookupScrollHandler: null,
    _figurLookupAnchor: null,
    _figurLookupIndex: null,
    showBookCard: false,
    showTreeCard: true,
    showEditorCard: false,
    showBookReviewCard: false,
    status: '',
    statusSpinner: false,
    _statusTimer: null,
    analysisOut: '',
    bookReviewOut: '',
    bookReviewStatus: '',
    lektoratFindings: [],
    selectedFindings: [],
    appliedOriginals: [],
    checkDone: false,
    checkLoading: false,
    checkProgress: 0,
    saveApplying: null,
    bookReviewLoading: false,
    bookReviewProgress: 0,
    batchLoading: false,
    batchProgress: 0,
    batchStatus: '',
    lastCheckId: null,
    pageHistory: [],
    activeHistoryEntryId: null,
    bookReviewHistory: [],
    selectedBookReviewId: null,
    // Kapitel-Review-State
    showKapitelReviewCard: false,
    kapitelReviewChapterId: '',
    kapitelReviewOut: '',
    kapitelReviewStatus: '',
    kapitelReviewLoading: false,
    kapitelReviewProgress: 0,
    kapitelReviewHistory: {},
    selectedKapitelReviewId: null,
    _kapitelReviewPollTimer: null,
    newPageTitle: '',
    newPageCreating: false,
    newPageError: '',
    tokEsts: {},
    _tokenEstGen: 0,
    pageLastChecked: {},
    showTokLegend: false,
    tokLegendPos: { x: 0, y: 0 },
    tokTooltipData: null,
    showPageStatusTip: false,
    pageStatusTipPos: { x: 0, y: 0 },
    pageStatusTipText: '',
    showFiguresCard: false,
    figuren: [],
    figurenUpdatedAt: null,
    figurenLoading: false,
    figurenProgress: 0,
    figurenStatus: '',
    selectedFigurId: null,
    figurenKapitelFilter: '',
    figurenSeitenFilter: '',
    figurenSuche: '',
    globalZeitstrahl: [],
    showGlobalZeitstrahl: false,
    zeitstrahlConsolidating: false,
    zeitstrahlProgress: 0,
    zeitstrahlStatus: '',
    showEreignisseCard: false,
    ereignisseLoading: false,
    ereignisseProgress: 0,
    ereignisseStatus: '',
    ereignisseFilterFigurId: '',
    ereignisseFilterKapitel: '',
    ereignisseFilterSeite: '',
    ereignisseSuche: '',
    showSzenenCard: false,
    szenen: [],
    szenenUpdatedAt: null,
    szenenLoading: false,
    szenenProgress: 0,
    szenenStatus: '',
    szenenFilterWertung: '',
    szenenFilterFigurId: '',
    szenenFilterKapitel: '',
    szenenFilterSeite: '',
    szenenFilterOrtId: '',
    szenenSuche: '',
    _consolidatePollTimer: null,
    _szenenPollTimer: null,
    _figurenNetwork: null,
    _figurenHash: null,
    _checkPollTimer: null,
    _reviewPollTimer: null,
    _figuresPollTimer: null,
    _ereignisseExtractPollTimer: null,
    showBookStatsCard: false,
    bookStatsData: [],
    bookStatsLoading: false,
    bookStatsSyncStatus: '',
    bookStatsMetric: 'words',
    bookStatsRange: 0,
    bookStatsCoverage: null,
    bookStatsDelta: null,
    _statsChart: null,
    showStilCard: false,
    stilData: null,
    stilLoading: false,
    stilSyncing: false,
    stilStatus: '',
    activeStilDetailKey: null,
    showFehlerHeatmapCard: false,
    fehlerHeatmapData: null,
    fehlerHeatmapLoading: false,
    fehlerHeatmapStatus: '',
    fehlerHeatmapMode: 'all',
    activeFehlerDetailKey: null,
    showChatCard: false,
    chatSessions: [],
    chatMessages: [],
    chatSessionId: null,
    chatInput: '',
    chatLoading: false,
    chatProgress: 0,
    chatStatus: '',
    _chatPollTimer: null,
    _chatPendingRefresh: false,
    showBookChatCard: false,
    bookChatSessions: [],
    bookChatMessages: [],
    bookChatSessionId: null,
    bookChatInput: '',
    bookChatLoading: false,
    bookChatProgress: 0,
    bookChatStatus: '',
    _bookChatPollTimer: null,
    showOrteCard: false,
    orte: [],
    orteUpdatedAt: null,
    orteLoading: false,
    orteProgress: 0,
    orteStatus: '',
    selectedOrtId: null,
    orteFilterFigurId: '',
    orteFilterKapitel: '',
    orteFilterSzeneId: '',
    orteSuche: '',
    _ortePollTimer: null,
    showKontinuitaetCard: false,
    kontinuitaetLoading: false,
    kontinuitaetProgress: 0,
    kontinuitaetStatus: '',
    kontinuitaetResult: null,
    kontinuitaetFilterFigurId: '',
    kontinuitaetFilterKapitel: '',
    _kontinuitaetPollTimer: null,
    jobQueueItems: [],
    _jobQueueTimer: null,
    showJobStats: false,
    jobStats: null,
    alleAktualisierenLoading: false,
    alleAktualisierenStatus: '',
    alleAktualisierenLastRun: null,
    alleAktualisierenProgress: 0,
    alleAktualisierenTokIn: 0,
    alleAktualisierenTokOut: 0,
    alleAktualisierenTps: null,
    showKomplettStatus: false,
    showBookSettingsCard: false,
    bookSettingsLanguage: 'de',
    bookSettingsRegion: 'CH',
    bookSettingsBuchtyp: '',
    bookSettingsBuchKontext: '',
    bookSettingsLoading: false,
    bookSettingsSaving: false,
    bookSettingsSaved: false,
    bookSettingsError: '',
    bookHistoryResetLoading: false,
    bookHistoryResetMessage: '',
    bookHistoryResetError: '',
    showUserSettingsCard: false,
    userSettingsProfile: null,
    userSettingsDefaultLanguage: '',
    userSettingsDefaultRegion: '',
    userSettingsDefaultBuchtyp: '',
    userSettingsDangerBookId: '',
    userSettingsLoading: false,
    userSettingsSaving: false,
    userSettingsSaved: false,
    userSettingsError: '',

    // ── Computed ─────────────────────────────────────────────────────────────
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
    szenenKapitelListe() {
      return this._sortByChapterOrder([...new Set(this.szenen.map(s => s.kapitel).filter(Boolean))]);
    },
    szenenSeitenListe() {
      if (!this.szenenFilterKapitel) return [];
      return this._sortByPageOrder([...new Set(this.szenen.filter(s => s.kapitel === this.szenenFilterKapitel && s.seite).map(s => s.seite))]);
    },
    orteKapitelListe() {
      const names = new Set();
      for (const o of this.orte) {
        for (const k of (o.kapitel || [])) { if (k.name) names.add(k.name); }
      }
      return this._sortByChapterOrder([...names]);
    },
    get orteFiltered() {
      const q = this.orteSuche ? this.orteSuche.toLowerCase() : '';
      return this.orte.filter(o =>
        (!q || (o.name || '').toLowerCase().includes(q)) &&
        (!this.orteFilterFigurId || (o.figuren || []).includes(this.orteFilterFigurId)) &&
        (!this.orteFilterKapitel || (o.kapitel || []).some(k => k.name === this.orteFilterKapitel)) &&
        (!this.orteFilterSzeneId || this.szenen.some(s => String(s.id) === String(this.orteFilterSzeneId) && (s.ort_ids || []).includes(o.id)))
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

    kontinuitaetKapitelListe() {
      const chapterById = new Map(
        (this.tree || []).filter(t => t.type === 'chapter').map(t => [t.id, t.name])
      );
      const chapterNames = new Set(chapterById.values());
      // Extract chapter name from stelle text like "Kapitel 3: Seite 45" → "Kapitel 3"
      const fromStelle = (s) => {
        if (!s) return null;
        const ci = s.indexOf(':');
        const c = ci > 0 ? s.substring(0, ci).trim() : s.trim();
        return chapterNames.has(c) ? c : null;
      };
      const names = new Set();
      for (const issue of (this.kontinuitaetResult?.issues || [])) {
        // Primary: chapter_ids – authoritative server-side mapping
        if (issue.chapter_ids?.length) {
          for (const id of issue.chapter_ids) { const n = chapterById.get(id); if (n) names.add(n); }
        }
        // Secondary: kapitel names validated against tree
        if (issue.kapitel?.length) {
          for (const k of issue.kapitel) if (k && chapterNames.has(k)) names.add(k);
        }
        // Tertiary: extract from stelle_a / stelle_b (covers empty-kapitel cases)
        const a = fromStelle(issue.stelle_a); if (a) names.add(a);
        const b = fromStelle(issue.stelle_b); if (b) names.add(b);
      }
      return this._sortByChapterOrder([...names]);
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
        if (this.kontinuitaetFilterFigurId) {
          if (issue.fig_ids?.length) {
            if (!issue.fig_ids.includes(this.kontinuitaetFilterFigurId)) return false;
          } else {
            const selectedName = this.figuren.find(f => f.id === this.kontinuitaetFilterFigurId)?.name || '';
            if (selectedName && !(issue.figuren || []).includes(selectedName)) return false;
          }
        }
        if (this.kontinuitaetFilterKapitel) {
          const f = this.kontinuitaetFilterKapitel;
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

    // ── Interne Navigation ───────────────────────────────────────────────────
    async openFigurById(figId) {
      this._beginNavigation();
      try {
        this.figurenKapitelFilter = '';
        this.figurenSeitenFilter = '';
        if (!this.showFiguresCard) {
          await this.toggleFiguresCard();
        }
        this.selectedFigurId = figId;
        await this.$nextTick();
        document.querySelector(`.figur-item[data-figid="${figId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } finally {
        this._endNavigation();
      }
    },

    async openOrtById(ortId) {
      this._beginNavigation();
      try {
        this.orteSuche = '';
        this.orteFilterFigurId = '';
        this.orteFilterKapitel = '';
        this.orteFilterSzeneId = '';
        if (!this.showOrteCard) {
          await this.toggleOrteCard();
        }
        this.selectedOrtId = ortId;
        await this.$nextTick();
        document.querySelector(`.ort-item[data-ortid="${ortId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } finally {
        this._endNavigation();
      }
    },

    async openEreignisseMitKapitel(kapitel) {
      this._beginNavigation();
      try {
        if (!this.showEreignisseCard) {
          await this.toggleEreignisseCard();
        }
        this.ereignisseFilterKapitel = kapitel;
      } finally {
        this._endNavigation();
      }
    },

    async openEreignisseMitFigur(figurId) {
      this._beginNavigation();
      try {
        if (!this.showEreignisseCard) {
          await this.toggleEreignisseCard();
        }
        this.ereignisseFilterFigurId = figurId;
        this.ereignisseFilterKapitel = '';
        this.ereignisseFilterSeite = '';
        this.ereignisseSuche = '';
      } finally {
        this._endNavigation();
      }
    },

    // Löst Kapitel+Seite (Namen) zu einem Page-Objekt auf. Mehrdeutigkeit in
    // dieser Reihenfolge: Kapitel exakt → exakte Seite → Teilstring-Seite →
    // erste Kapitelseite; ohne Kapitel: globaler Seiten-Fallback.
    _resolvePage(kapitel, seite) {
      const kName = Array.isArray(kapitel) ? kapitel[0] : kapitel;
      if (!kName && !seite) return null;
      const chapters = (this.tree || []).filter(t => t.type === 'chapter');
      const sLower = seite ? String(seite).toLowerCase() : '';
      if (!kName) {
        return this.pages.find(p => p.name === seite)
          || this.pages.find(p => p.name.toLowerCase() === sLower)
          || null;
      }
      const chapter = chapters.find(c => c.name === kName);
      const pages = chapter?.pages || [];
      if (!pages.length) return null;
      if (seite) {
        const exact = pages.find(p => p.name === seite)
          || pages.find(p => p.name.toLowerCase() === sLower);
        if (exact) return exact;
        const sub = pages.find(p => {
          const n = p.name.toLowerCase();
          return n && (n.includes(sLower) || sLower.includes(n));
        });
        if (sub) return sub;
      }
      return pages[0];
    },

    gotoStelle(kapitel, seite) {
      const page = this._resolvePage(kapitel, seite);
      if (page) this.selectPage(page);
    },

    gotoPageById(pageId) {
      if (!pageId) return;
      const page = this.pages.find(p => String(p.id) === String(pageId));
      if (page) this.selectPage(page);
    },

    // ── URL-Hash-Permalinks ─────────────────────────────────────────────────
    // Schema: #profil | #book/:bookId[/page/:pageId|/figur/:figId|/ort/:ortId|/kapitel[/:chapterId]|/<view>]
    // Views: figuren, orte, szenen, ereignisse, kontinuitaet, bewertung, kapitel, chat, stats, einstellungen
    _computeHash() {
      if (this.showUserSettingsCard) return '#profil';
      if (!this.selectedBookId) return '';
      const parts = ['book', this.selectedBookId];
      if (this.showEditorCard && this.currentPage?.id) {
        parts.push('page', String(this.currentPage.id));
      } else if (this.showFiguresCard && this.selectedFigurId) {
        parts.push('figur', String(this.selectedFigurId));
      } else if (this.showOrteCard && this.selectedOrtId) {
        parts.push('ort', String(this.selectedOrtId));
      } else if (this.showKapitelReviewCard && this.kapitelReviewChapterId) {
        parts.push('kapitel', String(this.kapitelReviewChapterId));
      } else if (this.showFiguresCard) parts.push('figuren');
      else if (this.showOrteCard) parts.push('orte');
      else if (this.showSzenenCard) parts.push('szenen');
      else if (this.showEreignisseCard) parts.push('ereignisse');
      else if (this.showKontinuitaetCard) parts.push('kontinuitaet');
      else if (this.showBookReviewCard) parts.push('bewertung');
      else if (this.showKapitelReviewCard) parts.push('kapitel');
      else if (this.showBookChatCard) parts.push('chat');
      else if (this.showBookStatsCard) parts.push('stats');
      else if (this.showStilCard) parts.push('stil');
      else if (this.showFehlerHeatmapCard) parts.push('fehler');
      else if (this.showBookSettingsCard) parts.push('einstellungen');
      return '#' + parts.join('/');
    },

    // Liefert die Navigations-Kategorie eines Hashes als "<bookId>:<kind>".
    // Dient zur Entscheidung push vs. replace: bleibt die Kategorie gleich
    // (Seite↔Seite, Figur↔Figur, Ort↔Ort), wird der History-Eintrag ersetzt
    // statt zusätzlich gepusht. `figur`/`figuren` und `ort`/`orte` gelten
    // jeweils als dieselbe Kategorie.
    _hashCategory(hash) {
      if (!hash) return null;
      const parts = hash.replace(/^#/, '').split('/').filter(Boolean);
      if (parts[0] === 'profil') return 'profil';
      if (parts[0] !== 'book' || !parts[1]) return null;
      const bookId = parts[1];
      const view = parts[2] || 'book';
      const kind = view === 'figur' ? 'figuren' : view === 'ort' ? 'orte' : view;
      return bookId + ':' + kind;
    },

    // Schreibt `newHash` in die URL. Wählt push vs. replace basierend auf
    // Kategorie-Wechsel. Bei erstem Aufruf immer replace (initialer Sync).
    _writeHash(newHash) {
      const cleanUrl = location.pathname + location.search;
      const firstWrite = !this._hashInitialized;
      this._hashInitialized = true;
      if (!newHash) {
        if (location.hash) history.replaceState(null, '', cleanUrl);
        return;
      }
      if (location.hash === newHash) return;
      if (firstWrite) { history.replaceState(null, '', newHash); return; }
      const oldCat = this._hashCategory(location.hash);
      const newCat = this._hashCategory(newHash);
      if (oldCat && oldCat === newCat) {
        history.replaceState(null, '', newHash);
      } else {
        history.pushState(null, '', newHash);
      }
    },

    // Zusammengesetzte Navigationen (z.B. openFigurById → toggleFiguresCard
    // → loadFiguren) erzeugen sonst mehrere History-Einträge. Mit diesem
    // Wrapper werden Zwischen-States unterdrückt, am Ende genau einmal gepusht.
    // Inside _applyHash: unterdrückt alles, URL wird nicht angefasst (Hash
    // hat bereits den Zielzustand vorgegeben).
    _beginNavigation() {
      this._navDepth += 1;
      this._applyingHash = true;
    },
    _endNavigation() {
      this._navDepth = Math.max(0, this._navDepth - 1);
      if (this._navDepth > 0) return;
      if (this._inHashApply) return;
      this._applyingHash = false;
      this._writeHash(this._computeHash());
    },

    // Synchroner URL-Sync ohne neuen History-Eintrag (initial + nach Hash-Apply).
    _syncUrlNow() {
      const newHash = this._computeHash();
      const cleanUrl = location.pathname + location.search;
      if (!newHash) {
        if (location.hash) history.replaceState(null, '', cleanUrl);
      } else if (location.hash !== newHash) {
        history.replaceState(null, '', newHash);
      }
      this._hashInitialized = true;
    },

    // Mehrere synchrone State-Änderungen werden per Microtask zu einem
    // einzigen URL-Update zusammengefasst.
    _updateHash() {
      if (this._applyingHash) return;
      if (this._hashUpdatePending) return;
      this._hashUpdatePending = true;
      queueMicrotask(() => {
        this._hashUpdatePending = false;
        if (this._applyingHash) return;
        this._writeHash(this._computeHash());
      });
    },

    async _applyHash() {
      const hash = (location.hash || '').replace(/^#/, '');
      if (!hash) return;
      const parts = hash.split('/').filter(Boolean);

      if (parts[0] === 'profil') {
        this._applyingHash = true;
        this._inHashApply = true;
        try {
          if (!this.showUserSettingsCard) await this.toggleUserSettingsCard();
        } finally {
          this._applyingHash = false;
          this._inHashApply = false;
        }
        return;
      }

      if (parts[0] !== 'book' || !parts[1]) return;
      const targetBookId = parts[1];
      if (!this.books.some(b => String(b.id) === targetBookId)) return;

      this._applyingHash = true;
      this._inHashApply = true;
      try {
        if (String(this.selectedBookId) !== targetBookId) {
          this.selectedBookId = targetBookId;
          this._resetBookScopedState();
          await this.loadPages();
        }

        const view = parts[2];
        const arg = parts[3];
        if (!view) {
          this._closeOtherMainCards('none');
          return;
        }

        switch (view) {
          case 'page':
            if (arg) {
              const page = this.pages.find(p => String(p.id) === arg);
              if (page) await this.selectPage(page);
            }
            break;
          case 'figur':
            if (arg) await this.openFigurById(arg);
            else {
              this.selectedFigurId = null;
              if (!this.showFiguresCard) await this.toggleFiguresCard();
              else this._closeOtherMainCards('figures');
            }
            break;
          case 'ort':
            if (arg) await this.openOrtById(arg);
            else {
              this.selectedOrtId = null;
              if (!this.showOrteCard) await this.toggleOrteCard();
              else this._closeOtherMainCards('orte');
            }
            break;
          case 'figuren':
            this.selectedFigurId = null;
            if (!this.showFiguresCard) await this.toggleFiguresCard();
            else this._closeOtherMainCards('figures');
            break;
          case 'orte':
            this.selectedOrtId = null;
            if (!this.showOrteCard) await this.toggleOrteCard();
            else this._closeOtherMainCards('orte');
            break;
          case 'szenen':
            if (!this.showSzenenCard) await this.toggleSzenenCard();
            break;
          case 'ereignisse':
            if (!this.showEreignisseCard) await this.toggleEreignisseCard();
            break;
          case 'kontinuitaet':
            if (!this.showKontinuitaetCard) await this.toggleKontinuitaetCard();
            break;
          case 'bewertung':
            if (!this.showBookReviewCard) await this.toggleBookReviewCard();
            break;
          case 'kapitel':
            if (!this.showKapitelReviewCard) await this.toggleKapitelReviewCard();
            if (arg) {
              // Nur übernehmen, wenn es ein qualifizierendes Kapitel ist (>1 Seite).
              const opts = this.kapitelReviewChapterOptions();
              if (opts.some(c => String(c.id) === String(arg))) {
                this.kapitelReviewChapterId = String(arg);
                this.kapitelReviewOut = '';
                this.setKapitelReviewStatus('');
              }
            }
            break;
          case 'chat':
            if (!this.showBookChatCard) await this.toggleBookChatCard();
            break;
          case 'stats':
            if (!this.showBookStatsCard) await this.toggleBookStatsCard();
            break;
          case 'stil':
            if (!this.showStilCard) await this.toggleStilCard();
            break;
          case 'fehler':
            if (!this.showFehlerHeatmapCard) await this.toggleFehlerHeatmapCard();
            break;
          case 'einstellungen':
            if (!this.showBookSettingsCard) await this.toggleBookSettingsCard();
            break;
        }
      } finally {
        this._applyingHash = false;
        this._inHashApply = false;
      }
    },

    _setupHashRouting() {
      const watchers = [
        'selectedBookId', 'currentPage', 'showEditorCard',
        'selectedFigurId', 'selectedOrtId',
        'showFiguresCard', 'showOrteCard', 'showSzenenCard', 'showEreignisseCard',
        'showKontinuitaetCard', 'showBookReviewCard', 'showBookChatCard',
        'showKapitelReviewCard', 'kapitelReviewChapterId',
        'showBookStatsCard', 'showStilCard', 'showFehlerHeatmapCard',
        'showBookSettingsCard', 'showUserSettingsCard',
      ];
      for (const prop of watchers) {
        this.$watch(prop, () => this._updateHash());
      }
      window.addEventListener('hashchange', () => this._applyHash());
    },

    // ── UI-Hilfsmethoden ─────────────────────────────────────────────────────
    setStatus(msg, spinner = false, duration = 0) {
      this.status = msg;
      this.statusSpinner = spinner;
      clearTimeout(this._statusTimer);
      if (duration > 0 && msg) {
        this._statusTimer = setTimeout(() => {
          this.status = '';
          this.statusSpinner = false;
        }, duration);
      }
    },

    // ── Sort helpers (use persistent order maps from loadPages) ─────────────
    _chapterIdx(name) { return this._chapterOrderMap?.get(name) ?? 9999; },
    _pageIdx(name) { return this._pageOrderMap?.get(name) ?? 9999; },
    _pageIdIdx(id) { return this._pageIdOrderMap?.get(id) ?? 9999; },
    _sortByChapterOrder(names) {
      return [...names].sort((a, b) => this._chapterIdx(a) - this._chapterIdx(b));
    },
    _sortByPageOrder(names) {
      return [...names].sort((a, b) => this._pageIdx(a) - this._pageIdx(b));
    },

    figurenKapitelListe() {
      const names = new Set();
      for (const f of (this.figuren || [])) {
        for (const k of (f.kapitel || [])) { if (k.name) names.add(k.name); }
      }
      return this._sortByChapterOrder([...names]);
    },

    figurenSeitenListe() {
      if (!this.figurenKapitelFilter) return [];
      const names = new Set();
      for (const f of this.figuren) {
        for (const s of (f.seiten || [])) {
          if (s.kapitel === this.figurenKapitelFilter && s.seite) names.add(s.seite);
        }
      }
      return this._sortByPageOrder([...names]);
    },

    filteredFiguren() {
      let result = this.figuren;
      if (this.figurenSuche) {
        const q = this.figurenSuche.toLowerCase();
        result = result.filter(f => f.name.toLowerCase().includes(q));
      }
      if (this.figurenKapitelFilter) {
        result = result.filter(f =>
          (f.kapitel || []).some(k => k.name === this.figurenKapitelFilter)
        );
      }
      if (this.figurenSeitenFilter) {
        result = result.filter(f =>
          (f.seiten || []).some(s => s.kapitel === this.figurenKapitelFilter && s.seite === this.figurenSeitenFilter)
        );
      }
      return [...result].sort((a, b) => {
        const aK = Math.min(...(a.kapitel || []).map(k => this._chapterIdx(k.name)), 9999);
        const bK = Math.min(...(b.kapitel || []).map(k => this._chapterIdx(k.name)), 9999);
        if (aK !== bK) return aK - bK;
        const aT = FIGUR_TYP_ORDER[a.typ] ?? 99;
        const bT = FIGUR_TYP_ORDER[b.typ] ?? 99;
        if (aT !== bT) return aT - bT;
        return (a.name || '').localeCompare(b.name || '', 'de');
      });
    },

    ereignisseKapitelListe() {
      const names = new Set();
      for (const ev of this.globalZeitstrahl) {
        if (Array.isArray(ev.kapitel)) { for (const k of ev.kapitel) if (k) names.add(k); }
        else if (ev.kapitel) names.add(ev.kapitel);
      }
      return this._sortByChapterOrder([...names]);
    },

    ereignisseSeitenListe() {
      if (!this.ereignisseFilterKapitel) return [];
      const names = new Set();
      for (const ev of this.globalZeitstrahl) {
        const kap = Array.isArray(ev.kapitel) ? ev.kapitel : (ev.kapitel ? [ev.kapitel] : []);
        if (!kap.includes(this.ereignisseFilterKapitel)) continue;
        const seiten = Array.isArray(ev.seiten) ? ev.seiten : (ev.seite ? [ev.seite] : []);
        for (const s of seiten) if (s) names.add(s);
      }
      return this._sortByPageOrder([...names]);
    },

    filteredEreignisse() {
      let result = this.globalZeitstrahl;
      if (this.ereignisseSuche) {
        const q = this.ereignisseSuche.toLowerCase();
        result = result.filter(ev => (ev.ereignis || '').toLowerCase().includes(q));
      }
      if (this.ereignisseFilterFigurId) {
        result = result.filter(ev => ev.figuren.some(f => f.id === this.ereignisseFilterFigurId));
      }
      if (this.ereignisseFilterKapitel) {
        result = result.filter(ev => {
          const kap = Array.isArray(ev.kapitel) ? ev.kapitel : (ev.kapitel ? [ev.kapitel] : []);
          return kap.includes(this.ereignisseFilterKapitel);
        });
      }
      if (this.ereignisseFilterSeite && this.ereignisseFilterKapitel) {
        result = result.filter(ev => {
          const seiten = Array.isArray(ev.seiten) ? ev.seiten : (ev.seite ? [ev.seite] : []);
          return seiten.includes(this.ereignisseFilterSeite);
        });
      }
      return result;
    },

    formatDate(iso) {
      if (!iso) return '';
      const tag = this.uiLocale === 'en' ? 'en-US' : 'de-CH';
      return new Date(iso).toLocaleString(tag, {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
    },

    escPreserveStrong,

    _saveStatus() {
      const server = Math.max(
        this.lastAutosaveAt || 0,
        this.currentPage?.updated_at ? new Date(this.currentPage.updated_at).getTime() : 0,
      );
      // Draft-Zeitstempel zählt nur im Fokusmodus und nur wenn er neuer als Server ist.
      const draft = (this.focusMode && this.lastDraftSavedAt && this.lastDraftSavedAt > server)
        ? this.lastDraftSavedAt : 0;
      if (draft) return { ts: draft, kind: 'draft' };
      if (server) return { ts: server, kind: 'saved' };
      return { ts: 0, kind: '' };
    },

    _formatSaveTs(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      const tag = this.uiLocale === 'en' ? 'en-US' : 'de-CH';
      const sameDay = d.toDateString() === new Date().toDateString();
      if (sameDay) {
        return d.toLocaleTimeString(tag, { hour: '2-digit', minute: '2-digit' });
      }
      return d.toLocaleString(tag, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    },

    lastSavedLabel() { return this._formatSaveTs(this._saveStatus().ts); },
    lastSavedKind() { return this._saveStatus().kind; },

    setReviewStatus(msg, spinner = false) {
      this.bookReviewStatus = spinner
        ? `<span class="spinner"></span>${msg}`
        : msg;
    },

    // Generischer Job-Poller.
    // config: { timerProp, jobId, lsKey?, progressProp?, onProgress, onNotFound, onError, onDone }
    _startPoll(config) {
      if (this[config.timerProp]) clearInterval(this[config.timerProp]);
      this[config.timerProp] = setInterval(async () => {
        try {
          const resp = await fetch('/jobs/' + config.jobId);
          if (resp.status === 404) {
            clearInterval(this[config.timerProp]);
            this[config.timerProp] = null;
            if (config.lsKey) localStorage.removeItem(config.lsKey);
            config.onNotFound?.();
            return;
          }
          if (!resp.ok) return;
          const job = await resp.json();
          if (config.progressProp) this[config.progressProp] = job.progress || 0;
          if (job.status === 'running' || job.status === 'queued') { config.onProgress?.(job); return; }
          clearInterval(this[config.timerProp]);
          this[config.timerProp] = null;
          if (config.lsKey) localStorage.removeItem(config.lsKey);
          if (job.status === 'cancelled') { await config.onError?.(job); return; }
          if (job.status === 'error') await config.onError?.(job);
          else await config.onDone?.(job);
        } catch (e) { console.error('[poll ' + config.timerProp + ']', e); }
      }, 2000);
    },

    async clearChapterCache() {
      if (!this.selectedBookId) return;
      if (!confirm(this.t('app.cacheClearConfirm'))) return;
      const { deleted } = await fetchJson(`/jobs/chapter-cache/${this.selectedBookId}`, { method: 'DELETE' });
      alert(this.t('app.cacheCleared', { n: deleted }));
    },

    async alleAktualisieren() {
      if (!this.selectedBookId || this.alleAktualisierenLoading) return;
      if (!confirm(this.t('komplett.confirm'))) return;
      this.alleAktualisierenLoading = true;
      this.alleAktualisierenProgress = 0;
      this.alleAktualisierenTokIn = 0;
      this.alleAktualisierenTokOut = 0;
      this.alleAktualisierenTps = null;
      this.showKomplettStatus = true;
      const bookId = this.selectedBookId;
      const bookName = this.selectedBookName;
      try {
        this.alleAktualisierenStatus = this.t('komplett.started');
        const { jobId } = await fetchJson('/jobs/komplett-analyse', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ book_id: parseInt(bookId), book_name: bookName }),
        });
        this._startKomplettPoll(jobId, bookId);
      } catch (e) {
        console.error('[alleAktualisieren]', e);
        this.alleAktualisierenStatus = `${this.t('common.errorColon')}${e.message}`;
        this.alleAktualisierenLoading = false;
      }
    },

    _startKomplettPoll(jobId, bookId) {
      this._startPoll({
        timerProp: '_komplettPollTimer',
        progressProp: 'alleAktualisierenProgress',
        jobId,
        lsKey: null,
        onProgress: (job) => {
          if (job.statusText) this.alleAktualisierenStatus = this.t(job.statusText, job.statusParams);
          if (job.tokensIn != null) this.alleAktualisierenTokIn = job.tokensIn;
          if (job.tokensOut != null) this.alleAktualisierenTokOut = job.tokensOut;
          if (job.tokensPerSec != null) this.alleAktualisierenTps = job.tokensPerSec;
        },
        onNotFound: () => {
          this.alleAktualisierenLoading = false;
          this.alleAktualisierenStatus = this.t('komplett.interrupted');
        },
        onError: (job) => {
          this.alleAktualisierenLoading = false;
          this.alleAktualisierenStatus = `${this.t('common.errorColon')}${job.error ? this.t(job.error, job.errorParams) : this.t('app.jobFailed')}`;
        },
        onDone: async () => {
          await Promise.all([
            this.loadFiguren(bookId),
            this.loadOrte(bookId),
            this.loadSzenen(bookId),
            this._loadKontinuitaetHistory(),
            this.loadLastKomplettRun(bookId),
            this._reloadZeitstrahl(),
          ]);
          this.alleAktualisierenLoading = false;
          const doneMsg = this.t('common.finished');
          this.alleAktualisierenStatus = doneMsg;
          setTimeout(() => { if (this.alleAktualisierenStatus === doneMsg) this.alleAktualisierenStatus = ''; }, 4000);
        },
      });
    },

    async loadLastKomplettRun(bookId) {
      if (!bookId) return;
      try {
        const { lastRunFmt } = await fetchJson(`/jobs/last-run?type=komplett-analyse&book_id=${bookId}`);
        this.alleAktualisierenLastRun = lastRunFmt || null;
      } catch { this.alleAktualisierenLastRun = null; }
    },

    _fmtTok(n) { return fmtTok(n || 0); },

    _komplettPhasen() {
      const p = this.alleAktualisierenProgress;
      const phases = [
        { key: 'phase.loadPages',          threshold: 12  },
        { key: 'phase.extract',            threshold: 30  },
        { key: 'phase.figurenConsolidate', threshold: 43  },
        { key: 'phase.orteConsolidate',    threshold: 56  },
        { key: 'phase.chapterRelations',   threshold: 58  },
        { key: 'phase.szenenEvents',       threshold: 83  },
        { key: 'phase.timeline',           threshold: 89  },
        { key: 'phase.continuity',         threshold: 97  },
      ];
      return phases.map((ph, i) => {
        const done = p >= ph.threshold;
        const prevThreshold = i === 0 ? 0 : phases[i - 1].threshold;
        const active = !done && p >= prevThreshold;
        return { label: this.t(ph.key), done, active };
      });
    },

    // Generiertes Status-HTML für laufende Jobs: Spinner + statusText + Token-Info.
    // Wird von review.js, figuren.js und lektorat.js (batchCheck) verwendet.
    _runningJobStatus(statusText, tokIn, tokOut, maxTokOut, progress, tokPerSec, statusParams) {
      let tokInfo = '';
      if ((tokIn || 0) + (tokOut || 0) > 0) {
        const pctPart = (progress > 0 && progress < 100) ? ` ~${progress}%` : '';
        const tpsPart = tokPerSec ? ` · ${Math.round(tokPerSec)} tok/s` : '';
        const inPart = (tokIn || 0) > 0 ? `↑${fmtTok(tokIn)} ` : '';
        tokInfo = ` · ${inPart}↓${fmtTok(tokOut || 0)} Tokens${pctPart}${tpsPart}`;
      }
      // statusText kann ein i18n-Key sein (z.B. 'job.phase.extracting') oder freier Text.
      // tRaw gibt unbekannte Keys 1:1 zurück, damit Legacy-Text pass-through funktioniert.
      const label = statusText ? this.t(statusText, statusParams) : '…';
      return `<span class="spinner"></span>${escHtml(label)}${tokInfo}`;
    },

    // ── Partials laden ───────────────────────────────────────────────────────
    // DOM-Auto-Discovery: jeder `<div id="partial-$name">` bekommt seinen
    // Inhalt aus `/partials/$name.html`. Partials dürfen weitere
    // `partial-*`-Container enthalten – die Schleife iteriert, bis nichts
    // Neues mehr auftaucht (Schutzlimit gegen zirkuläre Referenzen).
    async _loadPartials() {
      const loadPass = async () => {
        const empty = [...document.querySelectorAll('[id^="partial-"]')]
          .filter(el => el.childElementCount === 0);
        if (empty.length === 0) return 0;
        await Promise.all(empty.map(async el => {
          const name = el.id.replace(/^partial-/, '');
          const html = await fetchText(`/partials/${name}.html`);
          el.innerHTML = html;
          Alpine.initTree(el);
        }));
        return empty.length;
      };
      let safety = 5;
      while (safety-- > 0 && await loadPass() > 0) { /* weiter */ }
    },

    // ── Theme (Hell/Dunkel/Auto) ─────────────────────────────────────────────
    _applyTheme() {
      const resolved = this.themePref === 'auto'
        ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : this.themePref;
      document.documentElement.setAttribute('data-theme', resolved);
    },
    cycleTheme() {
      const order = ['auto', 'light', 'dark'];
      this.themePref = order[(order.indexOf(this.themePref) + 1) % order.length];
      try { localStorage.setItem('theme', this.themePref); } catch (e) {}
      this._applyTheme();
      fetch('/me/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: this.themePref }),
      }).catch(e => console.error('[theme] Persist fehlgeschlagen:', e));
    },
    _themeLabel() {
      return this.t({ auto: 'theme.auto', light: 'theme.light', dark: 'theme.dark' }[this.themePref] || 'theme.auto');
    },

    // ── Initialisierung ──────────────────────────────────────────────────────
    async init() {
      this.themePref = window.__themePref || 'auto';
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (this.themePref === 'auto') this._applyTheme();
      });
      window.addEventListener('session-expired', () => { this.sessionExpired = true; });
      window.addEventListener('beforeunload', (e) => {
        if (this.editMode && this.editDirty) { e.preventDefault(); e.returnValue = ''; }
      });
      try {
        const cfg = await fetchJson('/config');
        const browserLoc = (navigator.language || 'de').slice(0, 2);
        const preferred  = cfg.userSettings?.locale || browserLoc || 'de';
        const supported  = getSupportedLocales();
        const locale = supported.includes(preferred) ? preferred : 'de';
        await configureI18n(locale);
        this.uiLocale = locale;
        document.documentElement.setAttribute('lang', locale);
        await this._loadPartials();
        this._installToolbarListeners();
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
      } catch {
        this.setStatus(this.t('app.configLoadError'));
      }
    },

    async toggleJobStats() {
      this.showJobStats = !this.showJobStats;
      if (this.showJobStats) {
        try {
          this.jobStats = await fetchJson('/jobs/stats');
        } catch {
          this.jobStats = [];
        }
      }
    },

    _startJobQueuePoll() {
      if (this._jobQueueTimer) clearInterval(this._jobQueueTimer);
      const poll = async () => {
        try {
          this.jobQueueItems = await fetchJson('/jobs/queue');
        } catch { /* ignorieren */ }
      };
      poll();
      this._jobQueueTimer = setInterval(poll, 5000);
    },

    async cancelJob(jobId) {
      try {
        await fetch('/jobs/' + jobId, { method: 'DELETE' });
        this.jobQueueItems = this.jobQueueItems.filter(j => j.id !== jobId);
      } catch { /* ignorieren */ }
    },

    navigateToJob(job) {
      const map = {
        'review':           'toggleBookReviewCard',
        'komplett-analyse': 'toggleFiguresCard',
        'kontinuitaet':     'toggleKontinuitaetCard',
        'batch-check':      'toggleTreeCard',
        'book-chat':        'toggleBookChatCard',
      };
      if (job.type === 'check') {
        const page = this.pages.find(p => String(p.id) === String(job.bookId));
        if (page) this.selectPage(page);
        return;
      }
      const method = map[job.type];
      if (method && this[method]) this[method]();
    },

    // ── Seitenauswahl & View-Reset ───────────────────────────────────────────
    async selectPage(p) {
      if (this.currentPage && this.currentPage.id === p.id) {
        this.resetPage();
        return;
      }
      if (this.editMode && this.editDirty) {
        if (!confirm(this.t('app.switchPageConfirm'))) return;
      }
      // Buchkarten schliessen – nur eine Ebene (Buch oder Seite) aktiv
      this.showBookReviewCard = false;
      this.showKapitelReviewCard = false;
      this.showFiguresCard = false;
      this.showBookStatsCard = false;
      this.showStilCard = false;
      this.showFehlerHeatmapCard = false;
      this.showBookChatCard = false;
      this.showEreignisseCard = false;
      this.showSzenenCard = false;
      this.showOrteCard = false;
      this.showBookSettingsCard = false;
      this.showKontinuitaetCard = false;
      this.showUserSettingsCard = false;

      this.resetPage();
      this.currentPage = p;
      this.showEditorCard = true;

      // Prüfen ob ein Lektorat-Check-Job für diese Seite läuft (Server-seitig oder aus früherer Session)
      try {
        const { jobId: activeJobId } = await fetchJson(`/jobs/active?type=check&page_id=${p.id}`);
        if (activeJobId) {
          localStorage.setItem('lektorat_check_job_' + p.id, activeJobId);
          this.checkLoading = true;
          this.checkProgress = 0;
          this.analysisOut = '';
          this.setStatus(this.t('app.lektoratRunning'), true);
          this.startCheckPoll(activeJobId);
          await this.loadPageHistory(p.id);
          return;
        }
        // Kein aktiver Job → stale localStorage-Eintrag bereinigen
        localStorage.removeItem('lektorat_check_job_' + p.id);
      } catch (e) { console.error('[selectPage active-job check]', e); }

      // Seiteninhalt laden und als formatiertes HTML rendern
      try {
        const pd = await this.bsGet('pages/' + p.id);
        const html = stripFocusArtefacts(pd.html || '');
        this.originalHtml = html;
        this.renderedPageHtml = html;
        this._updatePageViewHeight();
        // Listing-Cache kann stale sein (bsPut aktualisiert ihn nicht).
        if (pd.updated_at) p.updated_at = pd.updated_at;
        this.currentPageEmpty = !htmlToText(html).trim();
        this.analysisOut = '';
      } catch (e) {
        console.error('[selectPage load-page]', e);
        this.setStatus(this.t('chat.pageLoadFailed'));
      }

      // Figurenkontext für dieses Kapitel laden (parallel zur History)
      this.loadChapterFigures();
      await this.loadPageHistory(p.id);
    },

    // Prüft ob ein gespeicherter Job noch läuft und reconnected ggf.
    // onRunning(job, jobId) wird aufgerufen wenn der Job aktiv ist.
    async _reconnectJob(lsKey, onRunning) {
      const jobId = localStorage.getItem(lsKey);
      if (!jobId) return;
      try {
        const resp = await fetch('/jobs/' + jobId);
        if (resp.ok) {
          const job = await resp.json();
          if (job.status === 'running') { onRunning(job, jobId); return; }
        }
      } catch { /* ignore */ }
      localStorage.removeItem(lsKey);
    },

    // Prüft beim Laden eines Buchs ob noch ein Job aus einer früheren Session läuft
    // (z.B. Tab versehentlich geschlossen während Analyse lief).
    async checkPendingJobs(bookId) {
      await this._reconnectJob('lektorat_review_job_' + bookId, (job, jobId) => {
        this.bookReviewLoading = true;
        this.bookReviewProgress = job.progress || 0;
        this.showBookReviewCard = true;
        this.bookReviewOut = '';
        this.setReviewStatus(job.statusText ? this.t(job.statusText, job.statusParams) : this.t('common.analysisRunning'), true);
        this.startReviewPoll(jobId);
      });

      // Kapitel-Review: nur einen laufenden Job pro Buch reconnecten – erste
      // Fundstelle gewinnt (Dedup läuft pro Kapitel, gleichzeitige Läufe sind rar).
      for (const item of (this.tree || [])) {
        if (item.type !== 'chapter') continue;
        const lsKey = `lektorat_chapter_review_job_${bookId}_${item.id}`;
        const jobIdLs = localStorage.getItem(lsKey);
        if (!jobIdLs) continue;
        await this._reconnectJob(lsKey, (job, jobId) => {
          this.kapitelReviewLoading = true;
          this.kapitelReviewProgress = job.progress || 0;
          this.kapitelReviewChapterId = String(item.id);
          this.showKapitelReviewCard = true;
          this.kapitelReviewOut = '';
          this.setKapitelReviewStatus(job.statusText ? this.t(job.statusText, job.statusParams) : this.t('common.analysisRunning'), true);
          this.startKapitelReviewPoll(jobId, item.id);
        });
        if (this._kapitelReviewPollTimer) break;
      }

      await this._reconnectJob('lektorat_figures_job_' + bookId, (job, jobId) => {
        this.figurenLoading = true;
        this.figurenProgress = job.progress || 0;
        this.showFiguresCard = true;
        this.figurenStatus = job.statusText ? this.t(job.statusText, job.statusParams) : this.t('common.analysisRunning');
        this.startFiguresPoll(jobId);
      });

      await this._reconnectJob('lektorat_batchcheck_job_' + bookId, (job, jobId) => {
        this.batchLoading = true;
        this.batchProgress = job.progress || 0;
        this.batchStatus = this._runningJobStatus(job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut, job.progress, job.tokensPerSec, job.statusParams);
        this.startBatchPoll(jobId);
      });

      // Prüfen ob ein komplett-analyse Job vom Server noch läuft (z.B. Tab geschlossen)
      if (!this.alleAktualisierenLoading) {
        try {
          const { jobId, status, progress, statusText, statusParams } = await fetchJson(
            `/jobs/active?type=komplett-analyse&book_id=${bookId}`
          );
          if (jobId && (status === 'running' || status === 'queued')) {
            this.alleAktualisierenLoading = true;
            this.alleAktualisierenProgress = progress || 0;
            this.alleAktualisierenTokIn = 0;
            this.alleAktualisierenTokOut = 0;
            this.alleAktualisierenTps = null;
            this.alleAktualisierenStatus = statusText ? this.t(statusText, statusParams) : this.t('komplett.running');
            this.showKomplettStatus = true;
            this._startKomplettPoll(jobId, bookId);
          }
        } catch (e) { console.error('[checkPendingJobs komplett-active]', e); }
      }
    },

    // Schliesst die anderen Hauptkarten (nicht Tree – der bleibt immer aktiv).
    // Bewertung, Figuren, Entwicklung und Buch-Chat sind exklusiv.
    // Beim Öffnen einer Buchkarte wird auch die offene Seite geschlossen.
    _closeOtherMainCards(keep) {
      if (keep !== 'bookReview') this.showBookReviewCard = false;
      if (keep !== 'kapitelReview') this.showKapitelReviewCard = false;
      if (keep !== 'figures') this.showFiguresCard = false;
      if (keep !== 'szenen') this.showSzenenCard = false;
      if (keep !== 'ereignisse') this.showEreignisseCard = false;
      if (keep !== 'bookStats') this.showBookStatsCard = false;
      if (keep !== 'stil') this.showStilCard = false;
      if (keep !== 'fehlerHeatmap') this.showFehlerHeatmapCard = false;
      if (keep !== 'bookChat') this.showBookChatCard = false;
      if (keep !== 'orte') this.showOrteCard = false;
      if (keep !== 'kontinuitaet') this.showKontinuitaetCard = false;
      if (keep !== 'bookSettings') this.showBookSettingsCard = false;
      if (keep !== 'userSettings') this.showUserSettingsCard = false;
      this.resetPage();
    },

    async toggleTreeCard() {
      if (this.showTreeCard) { this.showTreeCard = false; this.resetPage(); return; }
      this._closeOtherMainCards('tree');
      this.showTreeCard = true;
      if (!this.pages.length) await this.loadPages();
      // Prüfen ob bereits ein Batch-Check-Job für dieses Buch läuft
      if (!this._batchPollTimer && !this.batchLoading && this.selectedBookId) {
        try {
          const { jobId } = await fetchJson(`/jobs/active?type=batch-check&book_id=${this.selectedBookId}`);
          if (jobId) {
            this.batchLoading = true;
            this.batchProgress = 0;
            this.batchStatus = this._runningJobStatus(this.t('common.analysisAlreadyRunning'), 0, 0);
            this.startBatchPoll(jobId);
          }
        } catch (e) {
          console.error('[toggleTreeCard] active-job check:', e);
        }
      }
    },

    // Setzt allen Seiten-Level-State zurück (Editor, Lektorat, Chat, History).
    resetPage() {
      if (this._checkPollTimer) { clearInterval(this._checkPollTimer); this._checkPollTimer = null; }
      if (this._synonymPollTimer) { clearInterval(this._synonymPollTimer); this._synonymPollTimer = null; }
      this.showSynonymMenu = false;
      this.showSynonymPicker = false;
      this.closeFigurLookup?.();
      if (this.focusMode) this.exitFocusMode();
      this._stopAutosave?.();
      this._uninstallOnlineRetry?.();
      this.resetChat();
      this.currentPage = null;
      this.currentPageEmpty = false;
      this.renderedPageHtml = '';
      this.chapterFigures = [];
      this.showChapterFigures = false;
      this.originalHtml = null;
      this.correctedHtml = null;
      this.hasErrors = false;
      this.editMode = false;
      this.editDirty = false;
      this.editSaving = false;
      this.lastAutosaveAt = null;
      this.lastDraftSavedAt = null;
      this.showEditorCard = false;
      this.analysisOut = '';
      this.status = '';
      this.statusSpinner = false;
      this.lastCheckId = null;
      this.pageHistory = [];
      this.activeHistoryEntryId = null;
      this.lektoratFindings = [];
      this.selectedFindings = [];
      this.appliedOriginals = [];
      this.checkDone = false;
      this.checkLoading = false;
      this.checkProgress = 0;
    },

    // Setzt allen buchbezogenen State zurück. Wird bei Buchwechsel (Combobox,
    // Hash, programmatisch) aufgerufen, bevor `loadPages()` das neue Buch lädt.
    // Karten bleiben sichtbar — `_reloadVisibleBookCards()` füllt sie danach neu.
    _resetBookScopedState() {
      // Datenarrays
      this.figuren = [];
      this.orte = [];
      this.szenen = [];
      this.bookStatsData = [];
      this.bookStatsCoverage = null;
      this.bookStatsDelta = null;
      this.globalZeitstrahl = [];
      this.bookReviewHistory = [];
      this.kapitelReviewHistory = {};
      this.kapitelReviewOut = '';
      this.kapitelReviewStatus = '';
      this.kapitelReviewProgress = 0;
      this.kapitelReviewLoading = false;
      this.kapitelReviewChapterId = '';
      this.selectedKapitelReviewId = null;
      this.newPageTitle = '';
      this.newPageCreating = false;
      this.newPageError = '';
      this.chatSessions = [];
      this.chatMessages = [];
      this.chatSessionId = null;
      this.bookChatSessions = [];
      this.bookChatMessages = [];
      this.bookChatSessionId = null;
      this.kontinuitaetResult = null;
      this.chapterFigures = [];
      this.pageHistory = [];
      this.activeHistoryEntryId = null;
      this.tokEsts = {};
      this._tokenEstGen++;

      // Selektionen
      this.selectedFigurId = null;
      this.selectedOrtId = null;
      this.selectedBookReviewId = null;
      this.lastCheckId = null;

      // Timestamps
      this.figurenUpdatedAt = null;
      this.szenenUpdatedAt = null;
      this.orteUpdatedAt = null;

      // Buch-scoped Pollers stoppen (zielen sonst auf altes Buch)
      const timers = [
        '_figuresPollTimer', '_ortePollTimer', '_szenenPollTimer',
        '_consolidatePollTimer', '_kontinuitaetPollTimer',
        '_ereignisseExtractPollTimer', '_chatPollTimer',
        '_bookChatPollTimer', '_reviewPollTimer', '_kapitelReviewPollTimer', '_komplettPollTimer',
      ];
      for (const t of timers) {
        if (this[t]) { clearInterval(this[t]); this[t] = null; }
      }

      // Komplett-Analyse-UI zurücksetzen, damit ein neues Buch eine eigene
      // Komplett-Analyse queuen kann. Der Server-Job des alten Buchs läuft weiter;
      // checkPendingJobs(bookId) reconnectet beim Zurückwechseln automatisch.
      this.alleAktualisierenLoading = false;
      this.alleAktualisierenStatus = '';
      this.alleAktualisierenProgress = 0;
      this.alleAktualisierenTokIn = 0;
      this.alleAktualisierenTokOut = 0;
      this.alleAktualisierenTps = null;
      this.showKomplettStatus = false;

      // Visualisierungen zerstören (bauen Graph/Chart sonst mit altem Buch-Daten auf)
      if (this._figurenNetwork) { this._figurenNetwork.destroy(); this._figurenNetwork = null; }
      this._figurenHash = null;
    },

    async _reloadVisibleBookCards() {
      const bookId = this.selectedBookId;
      if (!bookId) return;
      const jobs = [];
      // `loadPages()` lädt figuren + bookReviewHistory selbst — hier nur die übrigen.
      if (this.showOrteCard)       jobs.push(this.loadOrte(bookId));
      if (this.showSzenenCard)     jobs.push(this.loadSzenen(bookId));
      if (this.showBookStatsCard)  jobs.push(this.loadBookStats(bookId));
      if (this.showStilCard)       jobs.push(this.loadStilStats(bookId));
      if (this.showFehlerHeatmapCard) jobs.push(this.loadFehlerHeatmap());
      if (this.showBookSettingsCard && typeof this.loadBookSettings === 'function') {
        jobs.push(this.loadBookSettings());
      }
      if (this.showEreignisseCard && typeof this._reloadZeitstrahl === 'function') {
        jobs.push(this._reloadZeitstrahl());
      }
      await Promise.all(jobs);
    },

    // Setzt alles zurück: Seiten-Level (via resetPage) + Buch-Level.
    resetView() {
      this.resetPage();
      this.clearBookstackSearch();
      // Kapitel in der Sidebar bleiben geöffnet (kein c.open = false)
      this.showTreeCard = true;
      this.showBookReviewCard = false;
      this.bookReviewOut = '';
      this.bookReviewStatus = '';
      this.bookReviewHistory = [];
      this.selectedBookReviewId = null;
      this.showKapitelReviewCard = false;
      this.kapitelReviewOut = '';
      this.kapitelReviewStatus = '';
      this.selectedKapitelReviewId = null;
      if (this._batchPollTimer) { clearInterval(this._batchPollTimer); this._batchPollTimer = null; }
      this.batchLoading = false;
      this.batchProgress = 0;
      this.batchStatus = '';
      this.showFiguresCard = false;
      this.figurenStatus = '';
      this.figurenProgress = 0;
      this.figurenUpdatedAt = null;
      this.selectedFigurId = null;
      this.figurenKapitelFilter = '';
      this.figurenSeitenFilter = '';
      this.globalZeitstrahl = [];
      this.showGlobalZeitstrahl = false;
      this.zeitstrahlConsolidating = false;
      this.zeitstrahlProgress = 0;
      this.zeitstrahlStatus = '';
      this.showEreignisseCard = false;
      this.ereignisseLoading = false;
      this.ereignisseProgress = 0;
      this.ereignisseStatus = '';
      this.ereignisseFilterFigurId = '';
      this.ereignisseFilterKapitel = '';
      this.ereignisseFilterSeite = '';
      if (this._ereignisseExtractPollTimer) { clearInterval(this._ereignisseExtractPollTimer); this._ereignisseExtractPollTimer = null; }
      this.showSzenenCard = false;
      this.szenen = [];
      this.szenenUpdatedAt = null;
      this.szenenStatus = '';
      this.szenenProgress = 0;
      this.szenenLoading = false;
      this.szenenFilterWertung = '';
      this.szenenFilterFigurId = '';
      this.szenenFilterKapitel = '';
      this.szenenFilterSeite = '';
      this.szenenFilterOrtId = '';
      if (this._consolidatePollTimer) { clearInterval(this._consolidatePollTimer); this._consolidatePollTimer = null; }
      if (this._szenenPollTimer) { clearInterval(this._szenenPollTimer); this._szenenPollTimer = null; }
      if (this._figurenNetwork) { this._figurenNetwork.destroy(); this._figurenNetwork = null; }
      this.showBookStatsCard = false;
      this.bookStatsData = [];
      this.bookStatsSyncStatus = '';
      if (this._statsChart) { this._statsChart.destroy(); this._statsChart = null; }
      this.showStilCard = false;
      this.stilData = null;
      this.stilStatus = '';
      this.stilLoading = false;
      this.stilSyncing = false;
      this.activeStilDetailKey = null;
      this.showFehlerHeatmapCard = false;
      this.fehlerHeatmapData = null;
      this.fehlerHeatmapStatus = '';
      this.fehlerHeatmapLoading = false;
      this.activeFehlerDetailKey = null;
      this.showOrteCard = false;
      this.orte = [];
      this.orteStatus = '';
      this.orteProgress = 0;
      this.orteLoading = false;
      this.orteFilterFigurId = '';
      this.orteFilterKapitel = '';
      this.orteFilterSzeneId = '';
      if (this._ortePollTimer) { clearInterval(this._ortePollTimer); this._ortePollTimer = null; }
      this.showKontinuitaetCard = false;
      this.kontinuitaetResult = null;
      this.kontinuitaetStatus = '';
      this.kontinuitaetProgress = 0;
      this.kontinuitaetLoading = false;
      this.kontinuitaetFilterFigurId = '';
      this.kontinuitaetFilterKapitel = '';
      if (this._kontinuitaetPollTimer) { clearInterval(this._kontinuitaetPollTimer); this._kontinuitaetPollTimer = null; }
      if (this._komplettPollTimer) { clearInterval(this._komplettPollTimer); this._komplettPollTimer = null; }
      this.showBookSettingsCard = false;
      this.bookSettingsSaved = false;
      this.bookSettingsError = '';
      this.showUserSettingsCard = false;
      this.userSettingsSaved = false;
      this.userSettingsError = '';
      this.alleAktualisierenLastRun = null;
      this.alleAktualisierenProgress = 0;
      this.alleAktualisierenTokIn = 0;
      this.alleAktualisierenTokOut = 0;
      this.alleAktualisierenTps = null;
      this.showKomplettStatus = false;
      this.resetBookChat();
    },

    // ── BookStack Token Setup ────────────────────────────────────────────────
    async saveBookstackToken() {
      this.tokenSetupError = '';
      if (!this.tokenSetupId.trim() || !this.tokenSetupPw.trim()) {
        this.tokenSetupError = this.t('app.tokenRequired');
        return;
      }
      this.tokenSetupLoading = true;
      try {
        const r = await fetch('/auth/token', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tokenId: this.tokenSetupId.trim(), tokenPw: this.tokenSetupPw.trim() }),
        });
        if (!r.ok) throw new Error(this.tError(await r.json()));
        this.showTokenSetup = false;
        this.tokenSetupId = '';
        this.tokenSetupPw = '';
        await this.loadBooks();
      } catch (e) {
        this.tokenSetupError = e.message;
      } finally {
        this.tokenSetupLoading = false;
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
  }));
});
