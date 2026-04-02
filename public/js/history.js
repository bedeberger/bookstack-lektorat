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

  async loadBookReviewHistory(bookId) {
    try {
      this.bookReviewHistory = await fetch('/history/review/' + bookId).then(r => r.json());
    } catch (e) {
      console.error('[loadBookReviewHistory]', e);
    }
  },
};
