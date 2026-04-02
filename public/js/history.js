// History-Methoden (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.

export const historyMethods = {
  async loadPageHistory(pageId) {
    try {
      this.pageHistory = await fetch('/history/page/' + pageId).then(r => r.json());
    } catch (e) {
      console.error('[loadPageHistory]', e);
    }
  },

  async toggleHistoryEntrySaved(entry) {
    const newSaved = !entry.saved;
    try {
      await fetch('/history/check/' + entry.id + '/saved', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ saved: newSaved }),
      });
      entry.saved = newSaved;
      entry.saved_at = newSaved ? new Date().toISOString() : null;
    } catch (e) {
      console.error('[toggleHistoryEntrySaved]', e);
    }
  },

  async deletePageCheck(id) {
    try {
      await fetch('/history/check/' + id, { method: 'DELETE' });
      this.pageHistory = this.pageHistory.filter(e => e.id !== id);
      if (this.selectedHistoryId === id) this.selectedHistoryId = null;
    } catch (e) {
      console.error('[deletePageCheck]', e);
    }
  },

  async loadBookReviewHistory(bookId) {
    try {
      this.bookReviewHistory = await fetch('/history/review/' + bookId).then(r => r.json());
    } catch (e) {
      console.error('[loadBookReviewHistory]', e);
    }
  },
};
