import { htmlToText, CHARS_PER_TOKEN } from './utils.js';
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
    const iso = this.pageLastChecked?.[page.id];
    if (!iso) return 'none';
    const checkedAt = new Date(iso);
    const updatedMs = page.updated_at ? new Date(page.updated_at).getTime() : 0;
    if (updatedMs > checkedAt.getTime()) return 'warn';
    if (_diffDays(checkedAt) >= STALE_THRESHOLD_DAYS) return 'warn';
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
    const iso = this.pageLastChecked?.[page.id];
    const updatedAt = page.updated_at ? new Date(page.updated_at) : null;
    const pageLine = updatedAt ? this._fmtRelativeLine(updatedAt, 'sidebar.status.pageUpdated') : '';
    if (!iso) {
      const first = this.t('sidebar.status.noLektorat');
      return pageLine ? `${first} · ${pageLine}` : first;
    }
    const checkedAt = new Date(iso);
    const lektLine = this._fmtRelativeLine(checkedAt, 'sidebar.status.lektorat');
    const editedSince = updatedAt && updatedAt.getTime() > checkedAt.getTime();
    const prefix = editedSince ? this.t('sidebar.status.editedSince') + ' · ' : '';
    return `${prefix}${lektLine}${pageLine ? ' · ' + pageLine : ''}`;
  },

  markPageChecked(pageId) {
    if (pageId == null) return;
    this.pageLastChecked = { ...this.pageLastChecked, [pageId]: new Date().toISOString() };
  },

  async refreshPageAges() {
    const bookId = this.selectedBookId;
    if (!bookId) return;
    try {
      const map = await fetch('/history/page-ages/' + bookId).then(r => r.json());
      if (this.selectedBookId === bookId) this.pageLastChecked = map || {};
    } catch { /* ignore */ }
  },

  chapterStats(item) {
    let words = 0, chars = 0, tok = 0, count = 0;
    for (const p of item.pages) {
      const e = this.tokEsts[p.id];
      if (e) { words += e.words; chars += e.chars; tok += e.tok; count++; }
    }
    return count ? { words, chars, tok } : null;
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

  async loadPages() {
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
      fetch('/sync/pages/' + bookId, { method: 'POST' }).catch(() => {});

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
          pages: this.pages.filter(p => p.chapter_id === c.id),
        })),
        ...this.pages.filter(p => !p.chapter_id).map(p => ({
          type: 'page',
          id: p.id,
          name: p.name,
          priority: p.priority,
          page: p,
        })),
      ].sort((a, b) => a.priority - b.priority);

      // Persistent sort maps – built once per book load, used by all filter sorting
      this._chapterOrderMap = new Map();
      let chIdx = 0;
      for (const item of this.tree) {
        if (item.type === 'chapter') this._chapterOrderMap.set(item.name, chIdx++);
      }
      this._pageOrderMap = new Map();
      this._pageIdOrderMap = new Map();
      for (let i = 0; i < this.pages.length; i++) {
        const p = this.pages[i];
        if (!this._pageOrderMap.has(p.name)) this._pageOrderMap.set(p.name, i);
        this._pageIdOrderMap.set(p.id, i);
      }

      // Gecachte Stats + Page-Ages aus DB laden
      try {
        const [statsCache, ageMap] = await Promise.all([
          fetch('/history/page-stats/' + bookId).then(r => r.json()),
          fetch('/history/page-ages/' + bookId).then(r => r.json()),
        ]);
        this.pageLastChecked = ageMap || {};
        for (const p of this.pages) {
          const c = statsCache[p.id];
          if (c && c.updated_at === p.updated_at) {
            this.tokEsts[p.id] = { tok: c.tok, words: c.words, chars: c.chars };
          }
        }
      } catch { /* Cache-Fehler ignorieren, Fallback auf Live-Berechnung */ }

      this.showTreeCard = true;
      this.setStatus('');
      await Promise.all([
        this.loadBookReviewHistory(bookId),
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

  onBookstackSearchInput() {
    if (this._bookstackSearchTimer) clearTimeout(this._bookstackSearchTimer);
    const term = (this.bookstackSearch || '').trim();
    if (term.length < 2) {
      this.bookstackSearchResults = [];
      this.bookstackSearchError = '';
      this.bookstackSearchLoading = false;
      if (this._bookstackSearchAbort) { this._bookstackSearchAbort.abort(); this._bookstackSearchAbort = null; }
      return;
    }
    this._bookstackSearchTimer = setTimeout(() => this.runBookstackSearch(), 300);
  },

  async runBookstackSearch() {
    const bookId = this.selectedBookId;
    const term = (this.bookstackSearch || '').trim();
    if (!bookId || term.length < 2) return;

    if (this._bookstackSearchAbort) this._bookstackSearchAbort.abort();
    const ctrl = new AbortController();
    this._bookstackSearchAbort = ctrl;
    const seq = ++this._bookstackSearchSeq;

    this.bookstackSearchLoading = true;
    this.bookstackSearchError = '';

    const query = `${term} {type:page} {in_book:${bookId}}`;
    try {
      const r = await fetch('/api/search?query=' + encodeURIComponent(query) + '&count=20', { signal: ctrl.signal });
      if (r.status === 401) { location.href = '/auth/login'; return; }
      if (!r.ok) throw new Error(this.t('bs.apiError', { status: r.status }));
      const data = await r.json();
      if (seq !== this._bookstackSearchSeq) return;
      const bookIdNum = parseInt(bookId);
      this.bookstackSearchResults = (data.data || [])
        .filter(h => h.type === 'page' && h.book_id === bookIdNum);
    } catch (e) {
      if (e.name === 'AbortError') return;
      if (seq !== this._bookstackSearchSeq) return;
      console.error('[bookstackSearch]', e);
      this.bookstackSearchError = this.t('book.search.error');
      this.bookstackSearchResults = [];
    } finally {
      if (seq === this._bookstackSearchSeq) this.bookstackSearchLoading = false;
    }
  },

  clearBookstackSearch() {
    if (this._bookstackSearchTimer) { clearTimeout(this._bookstackSearchTimer); this._bookstackSearchTimer = null; }
    if (this._bookstackSearchAbort) { this._bookstackSearchAbort.abort(); this._bookstackSearchAbort = null; }
    this._bookstackSearchSeq++;
    this.bookstackSearch = '';
    this.bookstackSearchResults = [];
    this.bookstackSearchError = '';
    this.bookstackSearchLoading = false;
  },

  selectPageFromBookstackSearch(hit) {
    const page = this.pages.find(p => p.id === hit.id) || { id: hit.id, name: hit.name };
    this.clearBookstackSearch();
    this.selectPage(page);
  },

  async loadTokenEstimates(gen) {
    const BATCH = 5;
    const pages = this.pages;
    if (!pages.length) return;

    const newStats = [];
    for (let i = 0; i < pages.length; i += BATCH) {
      if (this._tokenEstGen !== gen) return;
      const batch = pages.slice(i, i + BATCH);
      await Promise.allSettled(batch.map(async p => {
        try {
          const pd = await this.bsGet('pages/' + p.id);
          const html = pd.html || '';
          const text = htmlToText(html);
          const userPrompt = buildLektoratPrompt(text);
          const words = text.trim() === '' ? 0 : text.trim().split(/\s+/).length;
          this.tokEsts[p.id] = {
            tok: Math.round(userPrompt.length / CHARS_PER_TOKEN),
            words,
            chars: text.length,
          };
          newStats.push({
            page_id: p.id,
            book_id: parseInt(this.selectedBookId),
            tok: this.tokEsts[p.id].tok,
            words,
            chars: text.length,
            updated_at: p.updated_at || null,
          });
        } catch { /* ignore */ }
      }));

      // Neu berechnete Stats in DB persistieren
      if (newStats.length && this._tokenEstGen === gen) {
        fetch('/history/page-stats/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(newStats.splice(0)),
        }).catch(() => {});
      }
    }
  },
};
