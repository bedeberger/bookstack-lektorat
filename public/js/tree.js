import { htmlToText, CHARS_PER_TOKEN } from './utils.js';
import { buildLektoratPrompt } from './prompts.js';

// Buch-/Seiten-Lade-Methoden (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.

export const treeMethods = {
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

      // Gecachte Stats + Vorschautexte aus DB laden und sofort anzeigen
      try {
        const [statsCache, previewCache] = await Promise.all([
          fetch('/history/page-stats/' + bookId).then(r => r.json()),
          fetch('/sync/pages/' + bookId).then(r => r.json()),
        ]);
        for (const p of this.pages) {
          const c = statsCache[p.id];
          if (c && c.updated_at === p.updated_at) {
            this.tokEsts[p.id] = { tok: c.tok, words: c.words, chars: c.chars };
          }
          const pc = previewCache[p.id];
          if (pc?.preview_text && pc.updated_at === p.updated_at) {
            p.previewText = pc.preview_text;
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
