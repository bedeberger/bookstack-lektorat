import { htmlToText, CHARS_PER_TOKEN, fetchJson } from './utils.js';
import { buildLektoratPrompt } from './prompts.js';

// Buch-/Seiten-Lade-Methoden (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.

const STALE_THRESHOLD_DAYS = 30;

// Tag-Differenz auf Basis lokaler Mitternacht – analog zu fmtLastRun in
// routes/jobs/shared.js. Verhindert Off-by-one bei Checks <24h, die aber
// bereits am Vortag stattfanden.
function _diffDays(then, now = new Date()) {
  const a = new Date(then.getFullYear(), then.getMonth(), then.getDate());
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((b - a) / 86400000);
}

function _localeTag(locale) { return locale === 'en' ? 'en-US' : 'de-CH'; }
function _fmtTime(d, locale) {
  return d.toLocaleTimeString(_localeTag(locale), { hour: '2-digit', minute: '2-digit' });
}
function _fmtDateShort(d, locale) {
  return d.toLocaleDateString(_localeTag(locale), { day: '2-digit', month: '2-digit' });
}

export const treeMethods = {
  pageStatus(page) {
    const rec = this.pageLastChecked?.[page.id];
    if (!rec) return 'none';
    const checkedAt = new Date(rec.at);
    const updatedMs = page.updated_at ? new Date(page.updated_at).getTime() : 0;
    if (updatedMs > checkedAt.getTime()) return 'warn';
    if (_diffDays(checkedAt) >= STALE_THRESHOLD_DAYS) return 'warn';
    if (rec.pending) return 'pending';
    return 'ok';
  },

  // Erwartete Keys: `${prefix}Today|Yesterday|DaysAgo|On` mit Platzhaltern
  // {time}, {days}, {date}.
  _fmtRelativeLine(d, prefix) {
    const diff = _diffDays(d);
    const time = _fmtTime(d, this.uiLocale);
    if (diff <= 0)  return this.t(`${prefix}Today`,     { time });
    if (diff === 1) return this.t(`${prefix}Yesterday`, { time });
    if (diff < 7)   return this.t(`${prefix}DaysAgo`,   { days: diff, time });
    return this.t(`${prefix}On`, { date: _fmtDateShort(d, this.uiLocale), time });
  },

  pageStatusTooltip(page) {
    const rec = this.pageLastChecked?.[page.id];
    const updatedAt = page.updated_at ? new Date(page.updated_at) : null;
    const pageLine = updatedAt ? this._fmtRelativeLine(updatedAt, 'sidebar.status.pageUpdated') : '';
    if (!rec) {
      const lines = [this.t('sidebar.status.noLektorat')];
      if (pageLine) lines.push(pageLine);
      return lines;
    }
    const checkedAt = new Date(rec.at);
    const lektLine = this._fmtRelativeLine(checkedAt, 'sidebar.status.lektorat');
    const editedSince = updatedAt && updatedAt.getTime() > checkedAt.getTime();
    const lines = [];
    if (editedSince) lines.push(this.t('sidebar.status.editedSince'));
    else if (rec.pending) lines.push(this.t('sidebar.status.pending'));
    lines.push(lektLine);
    if (pageLine) lines.push(pageLine);
    return lines;
  },

  markPageChecked(pageId, { pending = false } = {}) {
    if (pageId == null) return;
    this.pageLastChecked = {
      ...this.pageLastChecked,
      [pageId]: { at: new Date().toISOString(), pending: !!pending },
    };
  },

  // Nach einem Page-Save tokEsts neu berechnen, damit der Baum den
  // "leer"-Badge sofort verliert und die Zeichenzahl stimmt. Persistiert
  // den frischen Stat-Eintrag auch in der History-DB.
  _syncPageStatsAfterSave(page, html) {
    if (!page?.id) return;
    const text = htmlToText(html || '');
    const userPrompt = buildLektoratPrompt(text);
    const words = text.trim() === '' ? 0 : text.trim().split(/\s+/).length;
    const stat = {
      tok: Math.round(userPrompt.length / CHARS_PER_TOKEN),
      words,
      chars: text.length,
    };
    this.tokEsts = { ...this.tokEsts, [page.id]: stat };
    if (!this.selectedBookId) return;
    fetch('/history/page-stats/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{
        page_id: page.id,
        book_id: parseInt(this.selectedBookId),
        tok: stat.tok,
        words: stat.words,
        chars: stat.chars,
        updated_at: page.updated_at || null,
      }]),
    }).catch(() => {});
  },

  async refreshPageAges() {
    const bookId = this.selectedBookId;
    if (!bookId) return;
    try {
      const map = await fetchJson('/history/page-ages/' + bookId);
      if (this.selectedBookId === bookId) this.pageLastChecked = map || {};
    } catch { /* ignore */ }
  },

  // Setzt `item.stats` für jedes Kapitel der aktuellen Tree-Struktur.
  // Aufruf: nach Tree-Build (loadPages) und nach jeder tokEsts-Reassignment
  // (loadTokenEstimates / _syncPageStatsAfterSave). Mutiert direkt die
  // Kapitel-Items — Alpine-Reaktivität trägt das Update an die Sidebar.
  _refreshChapterStats() {
    const ts = this.tokEsts || {};
    for (const item of this.tree || []) {
      if (item.type !== 'chapter') continue;
      let words = 0, chars = 0, tok = 0, count = 0;
      for (const p of item.pages) {
        const e = ts[p.id];
        if (e) { words += e.words; chars += e.chars; tok += e.tok; count++; }
      }
      item.stats = count
        ? {
            words, chars, tok,
            normseiten: Math.round((chars / 1500) * 10) / 10,
            badge: chars >= 1000 ? '~' + Math.round(chars / 1000) + 'k Z' : chars + ' Z',
          }
        : null;
    }
  },

  _onChapterHeaderActivate(item) {
    if (this.pageSearch || item.pages.length === 0) return;
    if (this._bookQualifiesForChapterReview()) this.openKapitelReviewForChapter(item.id);
    else item.open = !item.open;
  },

  // Sidebar-Tooltip-Helper (Token-Badge + Page-Status). Halten Layout-Code
  // aus dem Template fern; die im Root liegenden Show-Flags + Pos werden
  // direkt mutiert.
  _showTokTip(el, data, opts = {}) {
    if (!el || !data) return;
    const r = el.getBoundingClientRect();
    this.tokLegendPos = { x: r.left, y: r.top };
    this.tokTooltipData = { ...data, ...opts };
    this.showTokLegend = true;
  },
  _hideTokTip() {
    this.showTokLegend = false;
    this.tokTooltipData = null;
  },
  _showStatusTip(el, page) {
    if (!el || !page) return;
    const r = el.getBoundingClientRect();
    this.pageStatusTipPos = { x: r.left, y: r.top };
    this.pageStatusTipLines = this.pageStatusTooltip(page);
    this.showPageStatusTip = true;
  },
  _hideStatusTip() {
    this.showPageStatusTip = false;
  },

  async loadBooks() {
    try {
      this.setStatus(this.t('tree.connecting'), true);
      this.books = await this.bsGetAll('books');
      if (!this.selectedBookId || !this.books.some(b => String(b.id) === String(this.selectedBookId))) {
        this.selectedBookId = String(this.books[0]?.id || '');
      }
      this.showBookCard = true;
      this.setStatus(this.t('tree.booksFound', { n: this.books.length }), false, 4000);
      await this.loadPages();
    } catch (e) {
      console.error('[loadBooks]', e);
      this.setStatus(this.t('common.errorColon') + e.message);
    }
  },

  async loadPages(opts = {}) {
    const bookId = this.selectedBookId;
    if (!bookId) return;
    // Laufenden Figuren-Job-Poll abbrechen (Buch könnte gewechselt haben).
    // checkPendingJobs am Ende reconnectet korrekt für das neue Buch.
    if (this._figuresPollTimer) { clearInterval(this._figuresPollTimer); this._figuresPollTimer = null; }
    this.figurenLoading = false;
    this.figurenProgress = 0;
    this.figurenStatus = '';
    try {
      this.setStatus(this.t('tree.loadingPages'), true);
      this.pageSearch = '';
      this.tokEsts = {};
      this.pageLastChecked = {};
      this.ideenCounts = {};
      this.tree = [];
      this.pages = [];
      this._tokenEstGen++;
      const [chapters, pages] = await Promise.all([
        this.bsGetAll('chapters?filter[book_id]=' + bookId),
        this.bsGetAll('pages?filter[book_id]=' + bookId),
      ]);

      // Buch wurde gewechselt während die Anfrage lief → veraltete Daten verwerfen.
      if (this.selectedBookId !== bookId) return;

      // pages-Cache im Hintergrund aktualisieren (fire-and-forget)
      const qs = opts.source ? `?source=${encodeURIComponent(opts.source)}` : '';
      fetch('/sync/pages/' + bookId + qs, { method: 'POST' }).catch(() => {});

      const sortedChapters = [...chapters].sort((a, b) => a.priority - b.priority);
      const chMap = Object.fromEntries(sortedChapters.map(c => [c.id, c.name]));
      const chapterOrder = Object.fromEntries(sortedChapters.map((c, i) => [c.id, i]));

      this.pages = [...pages]
        .sort((a, b) => {
          const aO = a.chapter_id ? (chapterOrder[a.chapter_id] ?? 999) : -1;
          const bO = b.chapter_id ? (chapterOrder[b.chapter_id] ?? 999) : -1;
          if (aO !== bO) return aO - bO;
          return a.priority - b.priority;
        })
        .map(p => ({
          ...p,
          chapterName: p.chapter_id ? (chMap[p.chapter_id] || this.t('tree.chapterFallback')) : null,
          url: this.bookstackUrl && p.book_slug && p.slug
            ? `${this.bookstackUrl}/books/${p.book_slug}/page/${p.slug}`
            : null,
        }));

      this.tree = [
        ...sortedChapters.map(c => ({
          type: 'chapter',
          id: c.id,
          name: c.name,
          priority: c.priority,
          open: true,
          solo: false,
          url: this.bookstackUrl && c.book_slug && c.slug
            ? `${this.bookstackUrl}/books/${c.book_slug}/chapter/${c.slug}`
            : null,
          pages: this.pages.filter(p => p.chapter_id === c.id),
        })),
        ...this.pages.filter(p => !p.chapter_id).map(p => ({
          type: 'chapter',
          id: 'solo-' + p.id,
          name: p.name,
          priority: p.priority,
          open: true,
          solo: true,
          url: null,
          pages: [p],
        })),
      ].sort((a, b) => a.priority - b.priority);

      // Persistent sort maps – built once per book load, used by all filter sorting
      this._chapterOrderMap = new Map();
      let chIdx = 0;
      for (const item of this.tree) {
        if (item.type === 'chapter' && !item.solo) this._chapterOrderMap.set(item.name, chIdx++);
      }
      this._pageOrderMap = new Map();
      this._pageIdOrderMap = new Map();
      for (let i = 0; i < this.pages.length; i++) {
        const p = this.pages[i];
        if (!this._pageOrderMap.has(p.name)) this._pageOrderMap.set(p.name, i);
        this._pageIdOrderMap.set(p.id, i);
      }
      this._refreshChapterStats();

      // Gecachte Stats + Page-Ages + Ideen-Counts aus DB laden
      try {
        const [statsCache, ageMap, ideenMap] = await Promise.all([
          fetchJson('/history/page-stats/' + bookId),
          fetchJson('/history/page-ages/' + bookId),
          fetchJson('/ideen/counts?book_id=' + bookId).catch(() => ({})),
        ]);
        this.pageLastChecked = ageMap || {};
        this.ideenCounts = ideenMap || {};
        // Cache-Hits in einem Rutsch zuweisen (statt Index-Assign in der Loop),
        // damit der tokEsts-$watch in app.js#init feuert und die Kapitel-Stats
        // synchron mit dem ersten Tree-Render aktualisiert.
        const initialTokEsts = {};
        for (const p of this.pages) {
          const c = statsCache[p.id];
          if (c && c.updated_at === p.updated_at) {
            initialTokEsts[p.id] = { tok: c.tok, words: c.words, chars: c.chars };
          }
        }
        if (Object.keys(initialTokEsts).length) this.tokEsts = initialTokEsts;
      } catch { /* Cache-Fehler ignorieren, Fallback auf Live-Berechnung */ }

      this.showTreeCard = true;
      this.setStatus('');
      // Geöffnete Seite frisch nachziehen (User klickt "Neuladen" → erwartet
      // auch im Editor den aktuellen Server-Stand). Aktive Edits nicht
      // überschreiben — gleiche Regel wie beim Re-Klick auf offene Seite.
      if (this.currentPage
          && String(this.currentPage.book_id) === String(bookId)
          && !this.editMode && !this.editDirty) {
        this._refetchCurrentPage();
      }
      await Promise.all([
        this.loadBookReviewHistory(bookId),
        // loadKapitelReviewHistory lebt jetzt in Alpine.data('kapitelReviewCard')
        // und wird beim Öffnen der Karte (bzw. book:changed-Event) geladen.
        this.loadFiguren(bookId),
        this.loadLastKomplettRun(bookId),
      ]);
      this.checkPendingJobs(bookId); // Reconnect nach Tab-Schliessen, kein await
      this.loadTokenEstimates(this._tokenEstGen); // Hintergrund, kein await
    } catch (e) {
      console.error('[loadPages]', e);
      this.setStatus(this.t('common.errorColon') + e.message);
    }
  },

  // Token-Estimates befüllen die Sidebar-Badges + Σ-Totals. Strategie:
  //   1) Server-Backfill (`POST /sync/page-stats/:bookId`) — ein einzelner
  //      Request, Server holt fehlende Stats parallel von BookStack und
  //      persistiert sie in `page_stats`. Erspart 429 Browser-Roundtrips bei
  //      einem grossen Buch.
  //   2) IntersectionObserver auf den Sidebar-Items — fehlende Stats für
  //      sichtbare Seiten werden bevorzugt nachgereicht (ids-Lazy-Pfad
  //      derselben Route), damit Badges ohne Warten auf den Vollabgleich
  //      erscheinen, sobald der User scrollt.
  // Beide Pfade sind idempotent; der Generations-Counter `_tokenEstGen`
  // verwirft Resultate aus alten Buch-Läufen.
  async loadTokenEstimates(gen) {
    if (this._tokenEstGen !== gen) return;
    const bookId = this.selectedBookId;
    if (!bookId || !this.pages.length) return;
    const missing = this.pages.some(p => !this.tokEsts[p.id]);
    if (!missing) return;

    this._setupStatsObserver(bookId, gen);

    try {
      const r = await fetch('/sync/page-stats/' + bookId, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!r.ok) return;
      const data = await r.json();
      if (this._tokenEstGen !== gen) return;
      if (data && data.stats) this.tokEsts = { ...this.tokEsts, ...data.stats };
    } catch { /* Observer-Pfad übernimmt sukzessive */ }
  },

  _setupStatsObserver(bookId, gen) {
    this._teardownStatsObserver();
    if (typeof IntersectionObserver === 'undefined' || typeof MutationObserver === 'undefined') return;

    const state = { queue: new Set(), flushTimer: null };

    const flush = async () => {
      state.flushTimer = null;
      if (this._tokenEstGen !== gen) return;
      if (!state.queue.size) return;
      const ids = [...state.queue];
      state.queue.clear();
      try {
        const r = await fetch('/sync/page-stats/' + bookId, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids }),
        });
        if (!r.ok) return;
        const data = await r.json();
        if (this._tokenEstGen !== gen) return;
        if (data && data.stats) this.tokEsts = { ...this.tokEsts, ...data.stats };
      } catch { /* einzelner Batch-Fail ist nicht kritisch */ }
    };

    const io = new IntersectionObserver((entries) => {
      if (this._tokenEstGen !== gen) return;
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const id = parseInt(e.target.dataset.pageId, 10);
        if (!id || this.tokEsts[id]) { io.unobserve(e.target); continue; }
        state.queue.add(id);
        io.unobserve(e.target);
      }
      if (state.queue.size && !state.flushTimer) state.flushTimer = setTimeout(flush, 200);
    }, { rootMargin: '200px 0px' });

    const observe = (node) => {
      if (!(node instanceof Element)) return;
      if (node.matches?.('.page-item[data-page-id]')) io.observe(node);
      node.querySelectorAll?.('.page-item[data-page-id]').forEach(n => io.observe(n));
    };
    // Auf `#partial-sidebar` einengen, damit der MutationObserver nicht auf
    // Editor-/Karten-Renderings reagiert. Fallback document.body falls Mount
    // (noch) nicht existiert.
    const root = document.getElementById('partial-sidebar') || document.body;
    observe(root);

    const mo = new MutationObserver(muts => {
      for (const m of muts) for (const node of m.addedNodes) observe(node);
    });
    mo.observe(root, { childList: true, subtree: true });

    this._statsObserver = io;
    this._statsObserverMutation = mo;
    this._statsObserverState = state;
  },

  _teardownStatsObserver() {
    if (this._statsObserver) { this._statsObserver.disconnect(); this._statsObserver = null; }
    if (this._statsObserverMutation) { this._statsObserverMutation.disconnect(); this._statsObserverMutation = null; }
    if (this._statsObserverState?.flushTimer) clearTimeout(this._statsObserverState.flushTimer);
    this._statsObserverState = null;
  },
};
