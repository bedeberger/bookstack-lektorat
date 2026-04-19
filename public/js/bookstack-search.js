// BookStack-Seitensuche in der Sidebar.
// `this` zeigt auf die Alpine-Komponente.

export const bookstackSearchMethods = {
  onBookstackSearchInput() {
    if (this._bookstackSearchTimer) clearTimeout(this._bookstackSearchTimer);
    const term = (this.bookstackSearch || '').trim();
    if (term.length < 2) {
      this.bookstackSearchResults = [];
      this.bookstackSearchError = '';
      this.bookstackSearchLoading = false;
      this.bookstackSearched = false;
      if (this._bookstackSearchAbort) { this._bookstackSearchAbort.abort(); this._bookstackSearchAbort = null; }
      return;
    }
    this.bookstackSearchLoading = true;
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
      if (!r.ok) throw new Error(this.t('bs.apiError', { status: r.status }));
      const data = await r.json();
      if (seq !== this._bookstackSearchSeq) return;
      const bookIdNum = parseInt(bookId);
      this.bookstackSearchResults = (data.data || [])
        .filter(h => h.type === 'page' && h.book_id === bookIdNum);
      this.bookstackSearched = true;
    } catch (e) {
      if (e.name === 'AbortError') return;
      if (seq !== this._bookstackSearchSeq) return;
      console.error('[bookstackSearch]', e);
      this.bookstackSearchError = this.t('book.search.error');
      this.bookstackSearchResults = [];
      this.bookstackSearched = true;
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
    this.bookstackSearched = false;
  },

  selectPageFromBookstackSearch(hit) {
    if (this.currentPage && this.currentPage.id === hit.id) return;
    const page = this.pages.find(p => p.id === hit.id) || { id: hit.id, name: hit.name };
    this.clearBookstackSearch();
    this.selectPage(page);
  },
};
