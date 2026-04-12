import { escHtml, htmlToText, fmtTok } from './utils.js';
import { configurePrompts } from './prompts.js';

const PREVIEW_MAX_CHARS = 600;
import { bookstackMethods } from './api-bookstack.js';
import { aiMethods } from './api-ai.js';
import { historyMethods } from './history.js';
import { treeMethods } from './tree.js';
import { lektoratMethods } from './lektorat.js';
import { reviewMethods } from './review.js';
import { figurenMethods } from './figuren.js';
import { ereignisseMethods } from './ereignisse.js';
import { graphMethods } from './graph.js';
import { bookstatsMethods } from './bookstats.js';
import { chatMethods } from './chat.js';
import { bookChatMethods } from './book-chat.js';
import { szenenMethods } from './szenen.js';
import { orteMethods } from './orte.js';
import { kontinuitaetMethods } from './kontinuitaet.js';
import { bookSettingsMethods } from './book-settings.js';

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
    bookstackUrl: '',
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
    pageSearch: '',
    currentPage: null,
    currentPageEmpty: false,
    currentPageUpdatedAt: null,
    originalHtml: null,
    correctedHtml: null,
    hasErrors: false,
    showDiff: false,
    diffHtml: '',
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
    lektoratErrors: [],
    lektoratStyles: [],
    selectedErrors: [],
    selectedStyles: [],
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
    selectedHistoryId: null,
    historySelections: {},
    historyApplying: {},
    bookReviewHistory: [],
    selectedBookReviewId: null,
    tokEsts: {},
    _tokenEstGen: 0,
    showTokLegend: false,
    tokLegendPos: { x: 0, y: 0 },
    tokTooltipData: null,
    showFiguresCard: false,
    figuren: [],
    figurenUpdatedAt: null,
    figurenLoading: false,
    figurenProgress: 0,
    figurenStatus: '',
    soziogrammLoading: false,
    soziogrammProgress: 0,
    soziogrammStatus: '',
    selectedFigurId: null,
    figurenKapitelFilter: '',
    figurenSeitenFilter: '',
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
    showChatCard: false,
    chatSessions: [],
    chatMessages: [],
    chatSessionId: null,
    chatInput: '',
    chatLoading: false,
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
    bookSettingsLoading: false,
    bookSettingsSaving: false,
    bookSettingsSaved: false,
    bookSettingsError: '',

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
      return [...map.entries()].map(([name, c]) => ({ name, ...c }));
    },
    get szenenNachSeite() {
      const map = new Map();
      for (const s of this.szenen) {
        if (!s.seite) continue;
        if (!map.has(s.seite)) map.set(s.seite, { total: 0, kapitel: s.kapitel });
        map.get(s.seite).total++;
      }
      return [...map.entries()].map(([name, d]) => ({ name, total: d.total, kapitel: d.kapitel }));
    },
    szenenKapitelListe() {
      return [...new Set(this.szenen.map(s => s.kapitel).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
    },
    szenenSeitenListe() {
      if (!this.szenenFilterKapitel) return [];
      return [...new Set(this.szenen.filter(s => s.kapitel === this.szenenFilterKapitel && s.seite).map(s => s.seite))].sort((a, b) => a.localeCompare(b, 'de'));
    },
    orteKapitelListe() {
      const names = new Set();
      for (const o of this.orte) {
        for (const k of (o.kapitel || [])) { if (k.name) names.add(k.name); }
      }
      return [...names].sort((a, b) => a.localeCompare(b, 'de'));
    },
    get orteFiltered() {
      return this.orte.filter(o =>
        (!this.orteFilterFigurId || (o.figuren || []).includes(this.orteFilterFigurId)) &&
        (!this.orteFilterKapitel || (o.kapitel || []).some(k => k.name === this.orteFilterKapitel)) &&
        (!this.orteFilterSzeneId || this.szenen.some(s => String(s.id) === String(this.orteFilterSzeneId) && (s.ort_ids || []).includes(o.id)))
      );
    },
    get szenenFiltered() {
      return this.szenen.filter(s =>
        (!this.szenenFilterWertung || s.wertung === this.szenenFilterWertung) &&
        (!this.szenenFilterFigurId || (s.fig_ids || []).includes(this.szenenFilterFigurId)) &&
        (!this.szenenFilterKapitel || s.kapitel === this.szenenFilterKapitel) &&
        (!this.szenenFilterSeite || s.seite === this.szenenFilterSeite) &&
        (!this.szenenFilterOrtId || (s.ort_ids || []).includes(this.szenenFilterOrtId))
      );
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
      return [...names].sort((a, b) => a.localeCompare(b, 'de'));
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
      this.figurenKapitelFilter = '';
      this.figurenSeitenFilter = '';
      if (!this.showFiguresCard) {
        await this.toggleFiguresCard();
      }
      this.selectedFigurId = figId;
      await this.$nextTick();
      document.querySelector(`.figur-item[data-figid="${figId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    },

    async openEreignisseMitKapitel(kapitel) {
      if (!this.showEreignisseCard) {
        await this.toggleEreignisseCard();
      }
      this.ereignisseFilterKapitel = kapitel;
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

    figurenKapitelListe() {
      const names = new Set();
      for (const f of (this.figuren || [])) {
        for (const k of (f.kapitel || [])) { if (k.name) names.add(k.name); }
      }
      return [...names].sort();
    },

    figurenSeitenListe() {
      if (!this.figurenKapitelFilter) return [];
      const names = new Set();
      for (const f of this.figuren) {
        for (const s of (f.seiten || [])) {
          if (s.kapitel === this.figurenKapitelFilter && s.seite) names.add(s.seite);
        }
      }
      return [...names].sort();
    },

    filteredFiguren() {
      let result = this.figuren;
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
      return result;
    },

    ereignisseKapitelListe() {
      const names = new Set();
      for (const ev of this.globalZeitstrahl) {
        if (Array.isArray(ev.kapitel)) { for (const k of ev.kapitel) if (k) names.add(k); }
        else if (ev.kapitel) names.add(ev.kapitel);
      }
      return [...names].sort();
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
      return [...names].sort();
    },

    filteredEreignisse() {
      let result = this.globalZeitstrahl;
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
      return new Date(iso).toLocaleString('de-CH', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
    },

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

    _waitForJob(jobId) {
      return new Promise((resolve) => {
        const timer = setInterval(async () => {
          try {
            const resp = await fetch('/jobs/' + jobId);
            if (!resp.ok) return;
            const job = await resp.json();
            if (job.status === 'running' || job.status === 'queued') return;
            clearInterval(timer);
            resolve(job);
          } catch (e) {
            console.error('[_waitForJob]', e);
          }
        }, 2000);
      });
    },

    async clearChapterCache() {
      if (!this.selectedBookId) return;
      if (!confirm('Delta-Cache für dieses Buch leeren?\n\nDie nächste Komplettanalyse extrahiert alle Kapitel neu – auch unveränderte. Das erhöht die KI-Kosten und Laufzeit.')) return;
      const res = await fetch(`/jobs/chapter-cache/${this.selectedBookId}`, { method: 'DELETE' });
      const { deleted } = await res.json();
      alert(`Cache geleert: ${deleted} Kapitel-Einträge entfernt.`);
    },

    async alleAktualisieren() {
      if (!this.selectedBookId || this.alleAktualisierenLoading) return;
      if (!confirm('Komplettanalyse starten?\n\nFiguren, Soziogramm, Schauplätze, Szenen, Ereignisse und Zeitstrahl werden neu ermittelt. Bei grossen Büchern kann das mehrere Minuten dauern.')) return;
      this.alleAktualisierenLoading = true;
      this.alleAktualisierenProgress = 0;
      this.alleAktualisierenTokIn = 0;
      this.alleAktualisierenTokOut = 0;
      this.alleAktualisierenTps = null;
      this.showKomplettStatus = true;
      const bookId = this.selectedBookId;
      const bookName = this.selectedBookName;
      try {
        this.alleAktualisierenStatus = 'Komplettanalyse gestartet…';
        const { jobId } = await fetch('/jobs/komplett-analyse', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ book_id: parseInt(bookId), book_name: bookName }),
        }).then(r => r.json());
        await this._pollKomplettJob(jobId, bookId);
      } catch (e) {
        console.error('[alleAktualisieren]', e);
        this.alleAktualisierenStatus = `Fehler: ${e.message}`;
      } finally {
        this.alleAktualisierenLoading = false;
      }
    },

    // Verbindet sich mit einem laufenden komplett-analyse Job und aktualisiert
    // den Status bis der Job abgeschlossen ist. Wirft bei Fehler/Abbruch.
    async _pollKomplettJob(jobId, bookId) {
      await new Promise((resolve, reject) => {
        const timer = setInterval(async () => {
          try {
            const resp = await fetch('/jobs/' + jobId);
            if (!resp.ok) return;
            const job = await resp.json();
            if (job.statusText) this.alleAktualisierenStatus = job.statusText;
            if (job.progress != null) this.alleAktualisierenProgress = job.progress;
            if (job.tokensIn != null) this.alleAktualisierenTokIn = job.tokensIn;
            if (job.tokensOut != null) this.alleAktualisierenTokOut = job.tokensOut;
            if (job.tokensPerSec != null) this.alleAktualisierenTps = job.tokensPerSec;
            if (job.status === 'done') { clearInterval(timer); resolve(job); }
            else if (job.status === 'error' || job.status === 'cancelled') {
              clearInterval(timer);
              reject(new Error(job.error || 'Job fehlgeschlagen'));
            }
          } catch (e) { console.error('[_pollKomplettJob]', e); }
        }, 2000);
      });
      // UI nach Abschluss aktualisieren
      await Promise.all([
        this.loadFiguren(bookId),
        this.loadOrte(bookId),
        this.loadSzenen(bookId),
        this._loadKontinuitaetHistory(),
        this.loadLastKomplettRun(bookId),
        this._reloadZeitstrahl(),
      ]);
      this.alleAktualisierenStatus = 'Fertig.';
      setTimeout(() => { if (this.alleAktualisierenStatus === 'Fertig.') this.alleAktualisierenStatus = ''; }, 4000);
    },

    async loadLastKomplettRun(bookId) {
      if (!bookId) return;
      try {
        const { lastRunFmt } = await fetch(`/jobs/last-run?type=komplett-analyse&book_id=${bookId}`).then(r => r.json());
        this.alleAktualisierenLastRun = lastRunFmt || null;
      } catch { this.alleAktualisierenLastRun = null; }
    },

    _fmtTok(n) { return fmtTok(n || 0); },

    _komplettPhasen() {
      const p = this.alleAktualisierenProgress;
      const phases = [
        { label: 'Seiten laden',          threshold: 12  },
        { label: 'Vollextraktion',        threshold: 30  },
        { label: 'Figuren konsolidieren', threshold: 45  },
        { label: 'Orte konsolidieren',    threshold: 56  },
        { label: 'Kap. Beziehungen',      threshold: 58  },
        { label: 'Szenen + Ereignisse',   threshold: 83  },
        { label: 'Zeitstrahl',            threshold: 89  },
        { label: 'Kontinuität',           threshold: 100 },
      ];
      return phases.map((ph, i) => {
        const done = p >= ph.threshold;
        const prevThreshold = i === 0 ? 0 : phases[i - 1].threshold;
        const active = !done && p >= prevThreshold;
        return { label: ph.label, done, active };
      });
    },

    // Generiertes Status-HTML für laufende Jobs: Spinner + statusText + Token-Info.
    // Wird von review.js, figuren.js und lektorat.js (batchCheck) verwendet.
    _runningJobStatus(statusText, tokIn, tokOut, maxTokOut, progress, tokPerSec) {
      let tokInfo = '';
      if ((tokIn || 0) + (tokOut || 0) > 0) {
        const pctPart = (progress > 0 && progress < 100) ? ` ~${progress}%` : '';
        const maxPart = maxTokOut ? ` (max. ${fmtTok(maxTokOut)})` : '';
        const tpsPart = tokPerSec ? ` · ${Math.round(tokPerSec)} tok/s` : '';
        tokInfo = ` · ↑${fmtTok(tokIn || 0)} ↓${fmtTok(tokOut || 0)} Tokens${pctPart}${maxPart}${tpsPart}`;
      }
      return `<span class="spinner"></span>${escHtml(statusText || '…')}${tokInfo}`;
    },

    // ── Partials laden ───────────────────────────────────────────────────────
    async _loadPartials() {
      const names = [
        'buchreview', 'figuren', 'szenen', 'ereignisse', 'orte',
        'kontinuitaet', 'bookstats', 'editor', 'chat', 'book-chat', 'book-settings',
      ];
      await Promise.all(names.map(async name => {
        const html = await fetch(`/partials/${name}.html`).then(r => r.text());
        const el = document.getElementById(`partial-${name}`);
        if (el) { el.innerHTML = html; Alpine.initTree(el); }
      }));
    },

    // ── Initialisierung ──────────────────────────────────────────────────────
    async init() {
      await this._loadPartials();
      try {
        const cfg = await fetch('/config').then(r => r.json());
        this.bookstackUrl = cfg.bookstackUrl || '';
        if (cfg.claudeModel) this.claudeModel = cfg.claudeModel;
        if (cfg.claudeMaxTokens) this.claudeMaxTokens = cfg.claudeMaxTokens;
        if (cfg.apiProvider) this.apiProvider = cfg.apiProvider;
        if (cfg.ollamaModel) this.ollamaModel = cfg.ollamaModel;
        if (cfg.llamaModel)  this.llamaModel  = cfg.llamaModel;
        this.currentUser = cfg.user || null;
        this.devMode = !!cfg.devMode;
        configurePrompts(cfg.promptConfig);
        if (!cfg.bookstackTokenOk) {
          this.showTokenSetup = true;
          return;
        }
        await this.loadBooks();
        this._startJobQueuePoll();
      } catch {
        this.setStatus('Fehler beim Laden der Konfiguration.');
      }
    },

    async toggleJobStats() {
      this.showJobStats = !this.showJobStats;
      if (this.showJobStats) {
        try {
          this.jobStats = await fetch('/jobs/stats').then(r => r.json());
        } catch {
          this.jobStats = [];
        }
      }
    },

    _startJobQueuePoll() {
      if (this._jobQueueTimer) clearInterval(this._jobQueueTimer);
      const poll = async () => {
        try {
          this.jobQueueItems = await fetch('/jobs/queue').then(r => r.json());
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

    // ── Seitenauswahl & View-Reset ───────────────────────────────────────────
    async selectPage(p) {
      if (this.currentPage && this.currentPage.id === p.id) {
        this.resetPage();
        return;
      }
      // Buchkarten schliessen – nur eine Ebene (Buch oder Seite) aktiv
      this.showBookReviewCard = false;
      this.showFiguresCard = false;
      this.showBookStatsCard = false;
      this.showBookChatCard = false;
      this.showEreignisseCard = false;
      this.showSzenenCard = false;
      this.showOrteCard = false;
      this.showBookSettingsCard = false;
      this.showKontinuitaetCard = false;
      // Laufenden Poll stoppen – Seite wechselt, laufender Check gehört zur alten Seite
      if (this._checkPollTimer) { clearInterval(this._checkPollTimer); this._checkPollTimer = null; }
      this.resetChat();
      this.currentPage = p;
      this.currentPageEmpty = false;
      this.originalHtml = null;
      this.correctedHtml = null;
      this.hasErrors = false;
      this.showDiff = false;
      this.diffHtml = '';
      this.lastCheckId = null;
      this.pageHistory = [];
      this.selectedHistoryId = null;
      this.historySelections = {};
      this.historyApplying = {};
      this.lektoratErrors = [];
      this.lektoratStyles = [];
      this.selectedErrors = [];
      this.selectedStyles = [];
      this.checkDone = false;
      this.checkLoading = false;
      this.checkProgress = 0;
      this.analysisOut = '';
      this.setStatus('');
      this.showEditorCard = true;

      // Prüfen ob ein Lektorat-Check-Job für diese Seite läuft (Server-seitig oder aus früherer Session)
      try {
        const { jobId: activeJobId } = await fetch(`/jobs/active?type=check&page_id=${p.id}`).then(r => r.json());
        if (activeJobId) {
          localStorage.setItem('lektorat_check_job_' + p.id, activeJobId);
          this.checkLoading = true;
          this.checkProgress = 0;
          this.analysisOut = '';
          this.setStatus('Lektorat läuft…', true);
          this.startCheckPoll(activeJobId);
          await this.loadPageHistory(p.id);
          return;
        }
        // Kein aktiver Job → stale localStorage-Eintrag bereinigen
        localStorage.removeItem('lektorat_check_job_' + p.id);
      } catch (e) { console.error('[selectPage active-job check]', e); }

      let rawPreview = p.previewText;
      if (!rawPreview) {
        try {
          const pd = await this.bsGet('pages/' + p.id);
          rawPreview = htmlToText(pd.html || '').trim() || null;
          p.previewText = rawPreview;
        } catch (e) { console.error('[selectPage live-preview]', e); }
      }
      if (rawPreview) {
        const preview = rawPreview.length > PREVIEW_MAX_CHARS ? rawPreview.slice(0, PREVIEW_MAX_CHARS) + ' …' : rawPreview;
        this.currentPageEmpty = !preview;
        this.analysisOut = preview
          ? `<div class="preview-text">${escHtml(preview)}</div>`
          : '<span class="muted-msg">Seite ist leer.</span>';
      }
      await this.loadPageHistory(p.id);
    },

    // Prüft beim Laden eines Buchs ob noch ein Job aus einer früheren Session läuft
    // (z.B. Tab versehentlich geschlossen während Analyse lief).
    async checkPendingJobs(bookId) {
      const reviewJobId = localStorage.getItem('lektorat_review_job_' + bookId);
      if (reviewJobId) {
        try {
          const resp = await fetch('/jobs/' + reviewJobId);
          if (resp.ok) {
            const job = await resp.json();
            if (job.status === 'running') {
              this.bookReviewLoading = true;
              this.bookReviewProgress = job.progress || 0;
              this.showBookReviewCard = true;
              this.bookReviewOut = '';
              this.setReviewStatus(job.statusText || 'Analyse läuft…', true);
              this.startReviewPoll(reviewJobId);
            } else {
              localStorage.removeItem('lektorat_review_job_' + bookId);
            }
          } else {
            localStorage.removeItem('lektorat_review_job_' + bookId);
          }
        } catch { localStorage.removeItem('lektorat_review_job_' + bookId); }
      }

      const figuresJobId = localStorage.getItem('lektorat_figures_job_' + bookId);
      if (figuresJobId) {
        try {
          const resp = await fetch('/jobs/' + figuresJobId);
          if (resp.ok) {
            const job = await resp.json();
            if (job.status === 'running') {
              this.figurenLoading = true;
              this.figurenProgress = job.progress || 0;
              this.showFiguresCard = true;
              this.figurenStatus = job.statusText || 'Analyse läuft…';
              this.startFiguresPoll(figuresJobId);
            } else {
              localStorage.removeItem('lektorat_figures_job_' + bookId);
            }
          } else {
            localStorage.removeItem('lektorat_figures_job_' + bookId);
          }
        } catch { localStorage.removeItem('lektorat_figures_job_' + bookId); }
      }

      const batchJobId = localStorage.getItem('lektorat_batchcheck_job_' + bookId);
      if (batchJobId) {
        try {
          const resp = await fetch('/jobs/' + batchJobId);
          if (resp.ok) {
            const job = await resp.json();
            if (job.status === 'running') {
              this.batchLoading = true;
              this.batchProgress = job.progress || 0;
              this.batchStatus = this._runningJobStatus(job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut, job.progress, job.tokensPerSec);
              this.startBatchPoll(batchJobId);
            } else {
              localStorage.removeItem('lektorat_batchcheck_job_' + bookId);
            }
          } else {
            localStorage.removeItem('lektorat_batchcheck_job_' + bookId);
          }
        } catch { localStorage.removeItem('lektorat_batchcheck_job_' + bookId); }
      }

      // Prüfen ob ein komplett-analyse Job vom Server noch läuft (z.B. Tab geschlossen)
      if (!this.alleAktualisierenLoading) {
        try {
          const { jobId, status, progress, statusText } = await fetch(
            `/jobs/active?type=komplett-analyse&book_id=${bookId}`
          ).then(r => r.json());
          if (jobId && (status === 'running' || status === 'queued')) {
            this.alleAktualisierenLoading = true;
            this.alleAktualisierenProgress = progress || 0;
            this.alleAktualisierenTokIn = 0;
            this.alleAktualisierenTokOut = 0;
            this.alleAktualisierenTps = null;
            this.alleAktualisierenStatus = statusText || 'Komplettanalyse läuft…';
            this.showKomplettStatus = true;
            this._pollKomplettJob(jobId, bookId)
              .catch(e => {
                console.error('[checkPendingJobs komplett]', e);
                this.alleAktualisierenStatus = `Fehler: ${e.message}`;
              })
              .finally(() => { this.alleAktualisierenLoading = false; });
          }
        } catch (e) { console.error('[checkPendingJobs komplett-active]', e); }
      }
    },

    // Schliesst die anderen Hauptkarten (nicht Tree – der bleibt immer aktiv).
    // Bewertung, Figuren, Entwicklung und Buch-Chat sind exklusiv.
    // Beim Öffnen einer Buchkarte wird auch die offene Seite geschlossen.
    _closeOtherMainCards(keep) {
      if (keep !== 'bookReview') this.showBookReviewCard = false;
      if (keep !== 'figures') this.showFiguresCard = false;
      if (keep !== 'szenen') this.showSzenenCard = false;
      if (keep !== 'ereignisse') this.showEreignisseCard = false;
      if (keep !== 'bookStats') this.showBookStatsCard = false;
      if (keep !== 'bookChat') this.showBookChatCard = false;
      if (keep !== 'orte') this.showOrteCard = false;
      if (keep !== 'kontinuitaet') this.showKontinuitaetCard = false;
      if (keep !== 'bookSettings') this.showBookSettingsCard = false;
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
          const { jobId } = await fetch(`/jobs/active?type=batch-check&book_id=${this.selectedBookId}`).then(r => r.json());
          if (jobId) {
            this.batchLoading = true;
            this.batchProgress = 0;
            this.batchStatus = this._runningJobStatus('Analyse läuft bereits…', 0, 0);
            this.startBatchPoll(jobId);
          }
        } catch (e) {
          console.error('[toggleTreeCard] active-job check:', e);
        }
      }
    },

    resetPage() {
      if (this._checkPollTimer) { clearInterval(this._checkPollTimer); this._checkPollTimer = null; }
      this.resetChat();
      this.currentPage = null;
      this.currentPageUpdatedAt = null;
      this.originalHtml = null;
      this.correctedHtml = null;
      this.hasErrors = false;
      this.showDiff = false;
      this.diffHtml = '';
      this.showEditorCard = false;
      this.analysisOut = '';
      this.status = '';
      this.statusSpinner = false;
      this.lastCheckId = null;
      this.pageHistory = [];
      this.selectedHistoryId = null;
      this.historySelections = {};
      this.historyApplying = {};
      this.lektoratErrors = [];
      this.lektoratStyles = [];
      this.selectedErrors = [];
      this.selectedStyles = [];
      this.checkDone = false;
      this.checkProgress = 0;
    },

    resetView() {
      this.currentPage = null;
      this.originalHtml = null;
      this.correctedHtml = null;
      this.hasErrors = false;
      this.showDiff = false;
      this.diffHtml = '';
      this.showEditorCard = false;
      this.showBookReviewCard = false;
      this.analysisOut = '';
      this.bookReviewOut = '';
      this.status = '';
      this.statusSpinner = false;
      this.bookReviewStatus = '';
      this.lastCheckId = null;
      this.pageHistory = [];
      this.selectedHistoryId = null;
      this.historySelections = {};
      this.historyApplying = {};
      // Kapitel in der Sidebar bleiben geöffnet (kein c.open = false)
      this.lektoratErrors = [];
      this.lektoratStyles = [];
      this.selectedErrors = [];
      this.selectedStyles = [];
      this.checkDone = false;
      this.checkProgress = 0;
      this.showTreeCard = true;
      if (this._checkPollTimer) { clearInterval(this._checkPollTimer); this._checkPollTimer = null; }
      if (this._batchPollTimer) { clearInterval(this._batchPollTimer); this._batchPollTimer = null; }
      this.batchLoading = false;
      this.batchProgress = 0;
      this.batchStatus = '';
      this.showFiguresCard = false;
      this.figurenStatus = '';
      this.figurenProgress = 0;
      this.figurenUpdatedAt = null;
      this.soziogrammLoading = false;
      this.soziogrammProgress = 0;
      this.soziogrammStatus = '';
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
      this.showBookSettingsCard = false;
      this.bookSettingsSaved = false;
      this.bookSettingsError = '';
      this.alleAktualisierenLastRun = null;
      this.alleAktualisierenProgress = 0;
      this.alleAktualisierenTokIn = 0;
      this.alleAktualisierenTokOut = 0;
      this.alleAktualisierenTps = null;
      this.showKomplettStatus = false;
      this.resetChat();
      this.resetBookChat();
    },

    // ── BookStack Token Setup ────────────────────────────────────────────────
    async saveBookstackToken() {
      this.tokenSetupError = '';
      if (!this.tokenSetupId.trim() || !this.tokenSetupPw.trim()) {
        this.tokenSetupError = 'Bitte Token ID und Token Secret eingeben.';
        return;
      }
      this.tokenSetupLoading = true;
      try {
        const r = await fetch('/auth/token', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tokenId: this.tokenSetupId.trim(), tokenPw: this.tokenSetupPw.trim() }),
        });
        if (!r.ok) throw new Error((await r.json()).error || 'Fehler beim Speichern');
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
    ...lektoratMethods,
    ...reviewMethods,
    ...figurenMethods,
    ...ereignisseMethods,
    ...graphMethods,
    ...bookstatsMethods,
    ...chatMethods,
    ...bookChatMethods,
    ...szenenMethods,
    ...orteMethods,
    ...kontinuitaetMethods,
    ...bookSettingsMethods,
  }));
});
