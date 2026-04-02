import { htmlToText } from './utils.js';
import { SYSTEM_LEKTORAT, buildLektoratPrompt } from './prompts.js';

// Buch-/Seiten-Lade-Methoden (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.

export const treeMethods = {
  async loadBooks() {
    try {
      this.setStatus('Verbinde mit BookStack…', true);
      this.books = await this.bsGetAll('books');
      this.selectedBookId = String(this.books[0]?.id || '');
      this.showBookCard = true;
      this.setStatus(this.books.length + ' Buch/Bücher gefunden.', false, 4000);
      if (this.books.length === 1) await this.loadPages();
    } catch (e) {
      console.error('[loadBooks]', e);
      this.setStatus('Fehler: ' + e.message);
    }
  },

  async loadPages() {
    const bookId = this.selectedBookId;
    try {
      this.setStatus('Lade Seiten…', true);
      this.pageSearch = '';
      this.tokEsts = {};
      this._tokenEstGen++;
      const [chapters, pages] = await Promise.all([
        this.bsGetAll('chapters?book_id=' + bookId),
        this.bsGetAll('pages?book_id=' + bookId),
      ]);

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
          chapterName: p.chapter_id ? (chMap[p.chapter_id] || 'Kapitel') : null,
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

      this.setStatus('');
      await Promise.all([
        this.loadBookReviewHistory(bookId),
        this.loadFiguren(bookId),
      ]);
      this.loadTokenEstimates(this._tokenEstGen); // Hintergrund, kein await
    } catch (e) {
      console.error('[loadPages]', e);
      this.setStatus('Fehler: ' + e.message);
    }
  },

  async loadTokenEstimates(gen) {
    const BATCH = 5;
    const pages = [...this.pages];
    for (let i = 0; i < pages.length; i += BATCH) {
      if (this._tokenEstGen !== gen) return;
      const batch = pages.slice(i, i + BATCH);
      await Promise.allSettled(batch.map(async p => {
        try {
          const pd = await this.bsGet('pages/' + p.id);
          const html = pd.html || '';
          const text = htmlToText(html);
          // Volles Input: Systemprompt + gefüllter Prompt (Text + HTML)
          const fullInput = SYSTEM_LEKTORAT + buildLektoratPrompt(text, html);
          const words = text.trim() === '' ? 0 : text.trim().split(/\s+/).length;
          this.tokEsts[p.id] = {
            tok: Math.round(fullInput.length / 4),
            words,
            chars: text.length,
          };
        } catch { /* ignore */ }
      }));
    }
  },
};
