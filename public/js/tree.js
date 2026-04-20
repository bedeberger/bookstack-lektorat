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
      const first = this.t('sidebar.status.noLektorat');
      return pageLine ? `${first} · ${pageLine}` : first;
    }
    const checkedAt = new Date(rec.at);
    const lektLine = this._fmtRelativeLine(checkedAt, 'sidebar.status.lektorat');
    const editedSince = updatedAt && updatedAt.getTime() > checkedAt.getTime();
    const prefixParts = [];
    if (editedSince) prefixParts.push(this.t('sidebar.status.editedSince'));
    else if (rec.pending) prefixParts.push(this.t('sidebar.status.pending'));
    const prefix = prefixParts.length ? prefixParts.join(' · ') + ' · ' : '';
    return `${prefix}${lektLine}${pageLine ? ' · ' + pageLine : ''}`;
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
          fetchJson('/history/page-stats/' + bookId),
          fetchJson('/history/page-ages/' + bookId),
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
        this.loadKapitelReviewHistory(bookId),
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
