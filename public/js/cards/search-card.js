// Alpine.data('searchCard') — Volltextsuche.
// Liest aus FTS5 ueber GET /search. Filter: Kind-Multiselect + Buch-Scope
// (aktuelles Buch oder alle sichtbaren). Treffer-Klick navigiert via Hash-
// Router (Seite/Kapitel) oder oeffnet die zugehoerige Karte (Figur/Ort).

import { setupCardLifecycle } from './card-lifecycle.js';
import { formatRelativeShort } from '../utils.js';

const DEBOUNCE_MS = 220;
const DEFAULT_KINDS = ['page', 'chapter'];
const ALL_KINDS = ['page', 'chapter', 'book', 'figure', 'location', 'scene', 'idea', 'research'];
// Semantische Suche kennt nur die indizierten Kinds (Embedding-Index).
const SEMANTIC_KINDS = ['page', 'scene', 'figure', 'research'];

export function registerSearchCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('searchCard', () => ({
    q: '',
    hits: [],
    fallback: false,
    loading: false,
    errorMessage: '',
    activeKinds: [...DEFAULT_KINDS],
    scopeMode: 'book', // 'book' | 'all'
    mode: 'fts', // 'fts' | 'semantic'
    likeEntity: null, // { kind, id, label } — „ähnliche Stellen zu dieser Entität"
    indexing: false,
    indexStatus: '',
    indexInfo: null, // { indexed, lastIndexedAt, staleCount, total, staleModelChunks } vom /semantic/status
    _indexPollTimer: null,
    _debounceTimer: null,
    _abortCtrl: null,
    _searchSeq: 0,
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        name: 'search',
        showFlag: 'showSearchCard',
        showNeedsBookId: false,
        onShow: async () => {
          // Scope aus dem Hash-Router-Spiegel wiederherstellen (Deep-Link/Reload):
          // #book/:id/suche → 'book', #search → 'all'.
          const s = Alpine.store('nav').searchScope;
          if (s === 'all' || s === 'book') this.scopeMode = s;
          await this.$nextTick();
          const input = this.$el?.querySelector('.search-q');
          if (input) input.focus();
          if (this.q && !this.hits.length) this.runSearch();
          if (this.semanticAvailable) this.loadIndexStatus();
        },
        onBookChanged: () => {
          if (this.scopeMode === 'book') this.runSearch();
          // Index-Status ist buch-skopiert: laufenden Poll des vorigen Buches
          // stoppen und die Build-Anzeige (indexing/indexStatus) zurücksetzen,
          // sonst bleibt der Status des alten Buches stehen bzw. der alte Job
          // schreibt sein Ergebnis dem neuen Buch zu.
          if (this._indexPollTimer) { clearTimeout(this._indexPollTimer); this._indexPollTimer = null; }
          this.indexing = false;
          this.indexStatus = '';
          this.indexInfo = null;
          if (this.semanticAvailable) this.loadIndexStatus();
        },
        onViewReset: () => this.resetSearch(),
        extraListeners: [{
          type: 'card:refresh',
          handler: (e) => { if (e?.detail?.name === 'search') this.runSearch(); },
        }, {
          // Root/Entity-Karten stossen „ähnliche Stellen zu X" an (findSimilar).
          type: 'search:similar',
          handler: (e) => {
            const d = e?.detail;
            if (d?.kind && d?.id) this.runSimilarToEntity(d.kind, d.id, d.label || '');
          },
        }],
      });

      // Effektiven Scope in den nav-Store spiegeln, damit der Hash-Router zwischen
      // #book/:id/suche und #search wählt. Semantik ist immer buch-skopiert.
      this.$watch(
        () => (this.mode === 'semantic' || this.scopeMode === 'book') ? 'book' : 'all',
        (v) => { Alpine.store('nav').searchScope = v; },
      );
    },

    destroy() {
      this._lifecycle?.destroy();
      if (this._debounceTimer) clearTimeout(this._debounceTimer);
      if (this._indexPollTimer) clearTimeout(this._indexPollTimer);
      this._abortCtrl?.abort();
    },

    resetSearch() {
      this.q = '';
      this.hits = [];
      this.fallback = false;
      this.errorMessage = '';
      this.loading = false;
      this.likeEntity = null;
    },

    // Semantik-Suche ist verfügbar, wenn das Backend konfiguriert ist UND ein Buch
    // gewählt ist (Vektoren leben pro Buch).
    get semanticAvailable() {
      return !!this.$store.config?.semanticSearchEnabled && !!Alpine.store('nav').selectedBookId;
    },

    setMode(m) {
      if (m === this.mode) return;
      if (m === 'semantic' && !this.semanticAvailable) return;
      this.mode = m;
      this.likeEntity = null;
      this.activeKinds = m === 'semantic' ? [...SEMANTIC_KINDS] : [...DEFAULT_KINDS];
      if (m === 'semantic') this.loadIndexStatus();
      this.runSearch();
    },

    // Index-Frische fürs aktuelle Buch laden (letzter Index-Lauf + wie viele
    // Einträge seither geändert). Reiner Lese-Status, kein Embedding-Call.
    async loadIndexStatus() {
      const bookId = Alpine.store('nav').selectedBookId;
      if (!bookId || !this.$store.config?.semanticSearchEnabled) return;
      try {
        const r = await fetch('/search/semantic/status?book_id=' + encodeURIComponent(bookId), { credentials: 'same-origin' });
        if (!r.ok) { this.indexInfo = null; return; }
        const j = await r.json();
        this.indexInfo = j.enabled ? j : null;
      } catch { this.indexInfo = null; }
    },

    // Dezenter Hinweis, welche Qualitäts-Stufen serverseitig aktiv sind (Hybrid-
    // Fusion / Reranking). Leer, wenn keine aktiv oder nicht im Semantik-Modus.
    get semanticEnhancedLabel() {
      if (this.mode !== 'semantic') return '';
      const c = Alpine.store('config');
      const t = window.__app?.t;
      const parts = [];
      if (c?.semanticHybrid) parts.push(t ? t('search.semantic.hybrid') : 'Hybrid');
      if (c?.semanticRerank) parts.push(t ? t('search.semantic.rerank') : 'Reranking');
      return parts.join(' · ');
    },

    // Formatierte „zuletzt aktualisiert vor …"-Angabe (TZ-aware via utils).
    get indexLastLabel() {
      if (!this.indexInfo?.lastIndexedAt) return '';
      return formatRelativeShort(this.indexInfo.lastIndexedAt, Alpine.store('shell').uiLocale);
    },

    kindOptions() {
      return this.mode === 'semantic' ? SEMANTIC_KINDS : ALL_KINDS;
    },

    isKindActive(k) {
      return this.activeKinds.includes(k);
    },

    toggleKind(k) {
      const i = this.activeKinds.indexOf(k);
      if (i >= 0) this.activeKinds.splice(i, 1);
      else this.activeKinds.push(k);
      if (!this.activeKinds.length) this.activeKinds = [...DEFAULT_KINDS];
      this.runSearch();
    },

    toggleScope() {
      this.scopeMode = this.scopeMode === 'book' ? 'all' : 'book';
      this.runSearch();
    },

    onInput() {
      if (this._debounceTimer) clearTimeout(this._debounceTimer);
      this._debounceTimer = setTimeout(() => this.runSearch(), DEBOUNCE_MS);
    },

    async runSearch() {
      if (this.mode === 'semantic') return this.likeEntity ? this.runSemantic({ like: this.likeEntity }) : this.runSemantic();
      const query = (this.q || '').trim();
      if (query.length < 2) {
        this.hits = [];
        this.fallback = false;
        this.errorMessage = '';
        this.loading = false;
        return;
      }
      this._searchSeq += 1;
      const seq = this._searchSeq;
      this._abortCtrl?.abort();
      const ctrl = new AbortController();
      this._abortCtrl = ctrl;
      this.loading = true;
      this.errorMessage = '';

      const params = new URLSearchParams({
        q: query,
        kind: this.activeKinds.join(','),
        limit: '50',
      });
      const bookId = Alpine.store('nav').selectedBookId;
      if (this.scopeMode === 'book' && bookId) params.set('book_id', String(bookId));

      try {
        const r = await fetch('/search?' + params.toString(), {
          credentials: 'same-origin',
          signal: ctrl.signal,
        });
        if (seq !== this._searchSeq) return; // raced
        if (!r.ok) {
          this.errorMessage = `${r.status}`;
          this.hits = [];
          this.fallback = false;
          return;
        }
        const data = await r.json();
        this.hits = Array.isArray(data.hits) ? data.hits : [];
        this.fallback = !!data.fallback;
      } catch (e) {
        if (e.name === 'AbortError') return;
        if (seq !== this._searchSeq) return;
        this.errorMessage = e.message || 'error';
        this.hits = [];
      } finally {
        if (seq === this._searchSeq) this.loading = false;
      }
    },

    // Semantische Suche (Embedding-basiert, immer buch-skopiert). Zwei Modi:
    // Freitext (q) oder „ähnliche Stellen zu Entität" (opts.like = {kind,id,label}).
    async runSemantic({ like = null } = {}) {
      const bookId = Alpine.store('nav').selectedBookId;
      if (!this.$store.config?.semanticSearchEnabled || !bookId) {
        this.hits = []; this.loading = false; return;
      }
      const query = (this.q || '').trim();
      if (!like && query.length < 2) {
        this.hits = []; this.errorMessage = ''; this.loading = false; return;
      }
      this._searchSeq += 1;
      const seq = this._searchSeq;
      this._abortCtrl?.abort();
      const ctrl = new AbortController();
      this._abortCtrl = ctrl;
      this.loading = true;
      this.errorMessage = '';

      const params = new URLSearchParams({ book_id: String(bookId), kind: this.activeKinds.join(','), limit: '30' });
      if (like) { params.set('like_kind', like.kind); params.set('like_id', String(like.id)); }
      else params.set('q', query);

      try {
        const r = await fetch('/search/semantic?' + params.toString(), { credentials: 'same-origin', signal: ctrl.signal });
        if (seq !== this._searchSeq) return;
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          this.errorMessage = j.error_code === 'EMBED_UNAVAILABLE'
            ? (window.__app?.t?.('search.semantic.unavailable') || 'Embedding-Endpunkt nicht erreichbar')
            : `${r.status}`;
          this.hits = []; return;
        }
        const data = await r.json();
        this.hits = Array.isArray(data.hits) ? data.hits : [];
        this.fallback = false;
      } catch (e) {
        if (e.name === 'AbortError') return;
        if (seq !== this._searchSeq) return;
        this.errorMessage = e.message || 'error';
        this.hits = [];
      } finally {
        if (seq === this._searchSeq) this.loading = false;
      }
    },

    // „Ähnliche Stellen zu dieser Figur/Szene/Seite" — von Entity-Karten via
    // window-Event 'search:similar' angestossen (Root öffnet vorher die Karte).
    runSimilarToEntity(kind, id, label) {
      if (!this.semanticAvailable) return;
      this.mode = 'semantic';
      this.q = '';
      this.activeKinds = [...SEMANTIC_KINDS];
      this.likeEntity = { kind, id, label: label || '' };
      this.runSemantic({ like: this.likeEntity });
    },

    clearLike() {
      this.likeEntity = null;
      this.hits = [];
    },

    // Embedding-Index für das aktuelle Buch (neu) aufbauen. Delta-Cache im Job
    // embeddet nur geänderte Chunks neu; Erstlauf kann dauern.
    async buildIndex() {
      const bookId = Alpine.store('nav').selectedBookId;
      if (!bookId || this.indexing) return;
      this.indexing = true;
      this.indexStatus = window.__app?.t?.('search.semantic.indexStarting') || '';
      try {
        const r = await fetch('/jobs/embed-index', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ book_id: bookId }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.jobId) {
          this.indexing = false;
          this.indexStatus = window.__app?.t?.('search.semantic.indexError') || 'Fehler';
          return;
        }
        this._pollIndex(j.jobId);
      } catch (e) {
        this.indexing = false;
        this.indexStatus = e.message || 'error';
      }
    },

    _pollIndex(jobId) {
      const tick = async () => {
        try {
          const r = await fetch('/jobs/' + encodeURIComponent(jobId), { credentials: 'same-origin' });
          const j = await r.json().catch(() => ({}));
          if (j.status === 'done') {
            this.indexing = false;
            this.indexStatus = j.detail || (window.__app?.t?.('search.semantic.indexDone') || 'Fertig');
            this.loadIndexStatus();
            return;
          }
          if (j.status === 'error' || j.status === 'cancelled') {
            this.indexing = false;
            this.indexStatus = window.__app?.t?.('search.semantic.indexError') || 'Fehler';
            return;
          }
          this.indexStatus = `${j.progress || 0}%`;
          this._indexPollTimer = setTimeout(tick, 1200);
        } catch {
          this._indexPollTimer = setTimeout(tick, 2000);
        }
      };
      tick();
    },

    hitKindLabel(kind) {
      const root = window.__app;
      return root?.t ? root.t('search.kind.' + kind) : kind;
    },

    // Treffer-Aktivierung: Hash-Router fuer page/chapter, Karten-Trigger fuer
    // figure/location/scene/idea. book → Buch wechseln + Overview.
    async activateHit(hit) {
      const root = window.__app;
      if (!root || !hit) return;
      try {
        switch (hit.kind) {
          case 'page':
            return root.gotoPageById?.(hit.entity_id);
          case 'chapter': {
            const tree = Alpine.store('nav').tree || [];
            const ch = tree.find(t => t.type === 'chapter' && String(t.id) === String(hit.entity_id));
            if (ch && typeof root.openKapitelReviewForChapter === 'function') {
              return root.openKapitelReviewForChapter(hit.entity_id);
            }
            if (ch?.pages?.[0]) return root.selectPage(ch.pages[0]);
            return;
          }
          case 'book': {
            // FTS5 liefert book_id als String, selectedBookId ist numerisch →
            // sonst greift der strikte Vergleich nie und reassignt bei jedem
            // Treffer einen String.
            const bid = Number(hit.book_id);
            if (Number.isFinite(bid) && Alpine.store('nav').selectedBookId !== bid) {
              Alpine.store('nav').selectedBookId = bid;
            }
            root.toggleBookOverviewCard?.();
            return;
          }
          // `nav_id`, nicht `entity_id`: Figuren/Schauplaetze werden ueber ihre
          // TEXT-ID adressiert (fig_id/loc_id), Index + Embedding-Chunks fuehren
          // den INTEGER-PK. Mit dem PK oeffnet die Karte zwar (und die URL sieht
          // richtig aus), die Zeile klappt aber nie auf.
          case 'figure':
            return root.openFigurById?.(hit.nav_id ?? hit.entity_id);
          case 'location':
            return root.openOrtById?.(hit.nav_id ?? hit.entity_id);
          case 'scene':
            return root.openSzeneById?.(hit.nav_id ?? hit.entity_id);
          case 'research': {
            // Deep-Link-Hash als SSoT (analog reference-card#openRechercheItem):
            // der Hash-Router oeffnet die Karte, setzt Exklusivitaet und
            // fokussiert das Item.
            const bid = Number(hit.book_id) || Alpine.store('nav').selectedBookId;
            if (!bid) return;
            location.hash = `#book/${bid}/recherche/${hit.entity_id}`;
            return;
          }
          case 'idea':
            // Ideen sind seitengebunden; oeffne die Seite.
            if (hit.book_id) {
              const idea = await this._loadIdeaPage(hit.entity_id);
              if (idea?.page_id) return root.gotoPageById?.(idea.page_id);
            }
            return;
        }
      } catch (e) {
        console.error('[search activate]', e);
      }
    },

    async _loadIdeaPage(ideaId) {
      try {
        const r = await fetch('/ideen/' + encodeURIComponent(ideaId), { credentials: 'same-origin' });
        if (!r.ok) return null;
        return await r.json();
      } catch { return null; }
    },
  }));
}
