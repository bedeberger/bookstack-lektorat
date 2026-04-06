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
import { graphMethods } from './graph.js';
import { bookstatsMethods } from './bookstats.js';
import { chatMethods } from './chat.js';
import { bookChatMethods } from './book-chat.js';
import { synonymeMethods } from './synonyme.js';

document.addEventListener('alpine:init', () => {
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
    showTreeCard: false,
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
    bookReviewLoading: false,
    bookReviewProgress: 0,
    batchLoading: false,
    batchProgress: 0,
    batchStatus: '',
    lastCheckId: null,
    pageHistory: [],
    selectedHistoryId: null,
    historySelections: {},
    bookReviewHistory: [],
    selectedBookReviewId: null,
    tokEsts: {},
    _tokenEstGen: 0,
    showTokLegend: false,
    tokLegendPos: { x: 0, y: 0 },
    showFiguresCard: false,
    figuren: [],
    figurenUpdatedAt: null,
    figurenLoading: false,
    figurenProgress: 0,
    figurenStatus: '',
    selectedFigurId: null,
    _figurenNetwork: null,
    _figurenHash: null,
    _checkPollTimer: null,
    _reviewPollTimer: null,
    _figuresPollTimer: null,
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
    showBookChatCard: false,
    bookChatSessions: [],
    bookChatMessages: [],
    bookChatSessionId: null,
    bookChatInput: '',
    bookChatLoading: false,
    bookChatProgress: 0,
    bookChatStatus: '',
    _bookChatPollTimer: null,
    showSynonymeCard: false,
    synonymeLoading: false,
    synonymeProgress: 0,
    synonymeResult: null,
    synonymeStatus: '',
    synonymeHtml: null,
    _synonymePollTimer: null,

    // ── Computed ─────────────────────────────────────────────────────────────
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
          if (job.status === 'error') await config.onError?.(job);
          else await config.onDone?.(job);
        } catch (e) { console.error('[poll ' + config.timerProp + ']', e); }
      }, 2000);
    },

    // Generiertes Status-HTML für laufende Jobs: Spinner + statusText + Token-Info.
    // Wird von review.js, figuren.js und lektorat.js (batchCheck) verwendet.
    _runningJobStatus(statusText, tokIn, tokOut, maxTokOut, progress) {
      let tokInfo = '';
      if ((tokIn || 0) + (tokOut || 0) > 0) {
        const pctPart = (progress > 0 && progress < 100) ? ` ~${progress}%` : '';
        const maxPart = maxTokOut ? ` (max. ${fmtTok(maxTokOut)})` : '';
        tokInfo = ` · ↑${fmtTok(tokIn || 0)} ↓${fmtTok(tokOut || 0)} Tokens${pctPart}${maxPart}`;
      }
      return `<span class="spinner"></span>${escHtml(statusText || '…')}${tokInfo}`;
    },

    cutAtSentence(text, maxLen) {
      if (text.length <= maxLen) return text;
      const sub = text.slice(0, maxLen);
      const m = sub.match(/^([\s\S]*[.!?])\s/);
      if (m) return m[1] + ' […]';
      const wi = sub.lastIndexOf(' ');
      return (wi > 0 ? sub.slice(0, wi) : sub) + ' […]';
    },

    // ── Initialisierung ──────────────────────────────────────────────────────
    async init() {
      try {
        const cfg = await fetch('/config').then(r => r.json());
        this.bookstackUrl = cfg.bookstackUrl || '';
        if (cfg.claudeModel) this.claudeModel = cfg.claudeModel;
        if (cfg.claudeMaxTokens) this.claudeMaxTokens = cfg.claudeMaxTokens;
        if (cfg.apiProvider) this.apiProvider = cfg.apiProvider;
        if (cfg.ollamaModel) this.ollamaModel = cfg.ollamaModel;
        this.currentUser = cfg.user || null;
        this.devMode = !!cfg.devMode;
        configurePrompts(cfg.promptConfig);
        if (!cfg.bookstackTokenOk) {
          this.showTokenSetup = true;
          return;
        }
        await this.loadBooks();
      } catch {
        this.setStatus('Fehler beim Laden der Konfiguration.');
      }
    },

    // ── Seitenauswahl & View-Reset ───────────────────────────────────────────
    async selectPage(p) {
      if (this.currentPage && this.currentPage.id === p.id) {
        this.resetPage();
        return;
      }
      // Laufenden Poll stoppen – Seite wechselt, laufender Check gehört zur alten Seite
      if (this._checkPollTimer) { clearInterval(this._checkPollTimer); this._checkPollTimer = null; }
      this.resetSynonymeCard();
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
      this.lektoratErrors = [];
      this.lektoratStyles = [];
      this.selectedErrors = [];
      this.selectedStyles = [];
      this.checkDone = false;
      this.checkLoading = false;
      this.checkProgress = 0;
      this.showEditorCard = true;
      this.$nextTick(() => document.getElementById('editor-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));

      // Prüfen ob ein Lektorat-Check-Job für diese Seite läuft (Server-seitig oder aus früherer Session)
      try {
        const { jobId: activeJobId } = await fetch(`/jobs/active?type=check&book_id=${p.id}`).then(r => r.json());
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

      this.analysisOut = '<span class="muted-msg"><span class="spinner"></span>Vorschau lädt…</span>';
      this.setStatus('');
      try {
        const pageData = await this.bsGet('pages/' + p.id);
        const text = htmlToText(pageData.html).trim();
        const preview = text.length > PREVIEW_MAX_CHARS ? text.slice(0, PREVIEW_MAX_CHARS) + ' …' : text;
        this.currentPageEmpty = !preview;
        this.analysisOut = preview
          ? `<div class="preview-text">${escHtml(preview)}</div><div class="preview-hint">Vorschau · «Prüfen» starten für Lektorat</div>`
          : '<span class="muted-msg">Seite ist leer.</span>';
      } catch (e) {
        console.error('[selectPage preview]', e);
        this.analysisOut = '<span class="muted-msg">Seite ausgewählt. «Prüfen» starten.</span>';
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
              this.batchStatus = this._runningJobStatus(job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut, job.progress);
              this.startBatchPoll(batchJobId);
            } else {
              localStorage.removeItem('lektorat_batchcheck_job_' + bookId);
            }
          } else {
            localStorage.removeItem('lektorat_batchcheck_job_' + bookId);
          }
        } catch { localStorage.removeItem('lektorat_batchcheck_job_' + bookId); }
      }
    },

    // Schliesst alle vier Hauptkarten ausser der angegebenen.
    // Beim Schliessen des Trees wird resetPage() aufgerufen.
    _closeOtherMainCards(keep) {
      if (keep !== 'tree' && this.showTreeCard) { this.showTreeCard = false; this.resetPage(); }
      if (keep !== 'bookReview') this.showBookReviewCard = false;
      if (keep !== 'figures') this.showFiguresCard = false;
      if (keep !== 'bookStats') this.showBookStatsCard = false;
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
      this.resetSynonymeCard();
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
      this.tree.forEach(c => { if (c.type === 'chapter') c.open = false; });
      this.lektoratErrors = [];
      this.lektoratStyles = [];
      this.selectedErrors = [];
      this.selectedStyles = [];
      this.checkDone = false;
      this.checkProgress = 0;
      this.showTreeCard = false;
      if (this._checkPollTimer) { clearInterval(this._checkPollTimer); this._checkPollTimer = null; }
      if (this._batchPollTimer) { clearInterval(this._batchPollTimer); this._batchPollTimer = null; }
      this.batchLoading = false;
      this.batchProgress = 0;
      this.batchStatus = '';
      this.showFiguresCard = false;
      this.figurenStatus = '';
      this.figurenProgress = 0;
      this.figurenUpdatedAt = null;
      this.selectedFigurId = null;
      if (this._figurenNetwork) { this._figurenNetwork.destroy(); this._figurenNetwork = null; }
      this.showBookStatsCard = false;
      this.bookStatsData = [];
      this.bookStatsSyncStatus = '';
      if (this._statsChart) { this._statsChart.destroy(); this._statsChart = null; }
      this.resetChat();
      this.resetBookChat();
      this.resetSynonymeCard();
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
    ...graphMethods,
    ...bookstatsMethods,
    ...chatMethods,
    ...bookChatMethods,
    ...synonymeMethods,
  }));
});
