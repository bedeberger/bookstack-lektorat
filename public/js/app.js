import { escHtml, htmlToText } from './utils.js';

const PREVIEW_MAX_CHARS = 600;
import { bookstackMethods } from './api-bookstack.js';
import { claudeMethods } from './api-claude.js';
import { historyMethods } from './history.js';
import { treeMethods } from './tree.js';
import { lektoratMethods } from './lektorat.js';
import { reviewMethods } from './review.js';
import { figurenMethods } from './figuren.js';
import { graphMethods } from './graph.js';

document.addEventListener('alpine:init', () => {
  Alpine.data('lektorat', () => ({
    // ── State ────────────────────────────────────────────────────────────────
    authToken: '',
    bookstackUrl: '',
    claudeModel: 'claude-sonnet-4-6',
    claudeMaxTokens: 64000,
    books: [],
    selectedBookId: '',
    pages: [],
    tree: [],
    pageSearch: '',
    currentPage: null,
    currentPageEmpty: false,
    originalHtml: null,
    correctedHtml: null,
    hasErrors: false,
    showDiff: false,
    diffHtml: '',
    showBookCard: false,
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
    bookReviewLoading: false,
    bookReviewProgress: 0,
    batchLoading: false,
    batchProgress: 0,
    batchStatus: '',
    lastCheckId: null,
    pageHistory: [],
    selectedHistoryId: null,
    bookReviewHistory: [],
    selectedBookReviewId: null,
    tokEsts: {},
    _tokenEstGen: 0,
    showTokLegend: false,
    tokLegendPos: { x: 0, y: 0 },
    showFiguresCard: false,
    figuren: [],
    figurenLoading: false,
    figurenProgress: 0,
    figurenStatus: '',
    selectedFigurId: null,
    _figurenNetwork: null,
    _figurenHash: null,

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
        if (cfg.tokenId && cfg.tokenPw) {
          this.authToken = 'Token ' + cfg.tokenId + ':' + cfg.tokenPw;
          this.bookstackUrl = cfg.bookstackUrl || '';
          if (cfg.claudeModel) this.claudeModel = cfg.claudeModel;
          if (cfg.claudeMaxTokens) this.claudeMaxTokens = cfg.claudeMaxTokens;
          await this.loadBooks();
        } else {
          this.setStatus('Keine Zugangsdaten in .env konfiguriert.');
        }
      } catch {
        this.setStatus('Fehler beim Laden der Konfiguration.');
      }
    },

    // ── Seitenauswahl & View-Reset ───────────────────────────────────────────
    async selectPage(p) {
      if (this.currentPage && this.currentPage.id === p.id && !!this.currentPage._isChapter === !!p._isChapter) {
        this.resetPage();
        return;
      }
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
      this.lektoratErrors = [];
      this.lektoratStyles = [];
      this.selectedErrors = [];
      this.selectedStyles = [];
      this.checkDone = false;
      this.showEditorCard = true;
      this.analysisOut = '<span class="muted-msg"><span class="spinner"></span>Vorschau lädt…</span>';
      this.setStatus('');
      try {
        let html;
        if (p._isChapter) {
          const chData = await this.bsGet('chapters/' + p.id);
          html = chData.description_html || '';
        } else {
          const pageData = await this.bsGet('pages/' + p.id);
          html = pageData.html;
        }
        const text = htmlToText(html).trim();
        const preview = text.length > PREVIEW_MAX_CHARS ? text.slice(0, PREVIEW_MAX_CHARS) + ' …' : text;
        this.currentPageEmpty = !preview;
        this.analysisOut = preview
          ? `<div class="preview-text">${escHtml(preview)}</div><div class="preview-hint">Vorschau · «Prüfen» starten für Lektorat</div>`
          : '<span class="muted-msg">Kapitel hat keinen Beschreibungstext.</span>';
      } catch (e) {
        console.error('[selectPage preview]', e);
        this.analysisOut = '<span class="muted-msg">Ausgewählt. «Prüfen» starten.</span>';
      }
      const historyId = p._isChapter ? -p.id : p.id;
      await this.loadPageHistory(historyId);
    },

    resetPage() {
      this.currentPage = null;
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
      this.lektoratErrors = [];
      this.lektoratStyles = [];
      this.selectedErrors = [];
      this.selectedStyles = [];
      this.checkDone = false;
    },

    async openBookReviewCard() {
      this.showBookReviewCard = true;
      this.bookReviewOut = '';
      this.bookReviewStatus = '';
      await this.loadBookReviewHistory(this.selectedBookId);
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
      this.tree.forEach(c => { if (c.type === 'chapter') c.open = false; });
      this.lektoratErrors = [];
      this.lektoratStyles = [];
      this.selectedErrors = [];
      this.selectedStyles = [];
      this.checkDone = false;
      this.showFiguresCard = false;
      this.figurenStatus = '';
      this.figurenProgress = 0;
      this.selectedFigurId = null;
      if (this._figurenNetwork) { this._figurenNetwork.destroy(); this._figurenNetwork = null; }
    },

    // ── Methoden aus Modulen ─────────────────────────────────────────────────
    ...bookstackMethods,
    ...claudeMethods,
    ...historyMethods,
    ...treeMethods,
    ...lektoratMethods,
    ...reviewMethods,
    ...figurenMethods,
    ...graphMethods,
  }));
});
