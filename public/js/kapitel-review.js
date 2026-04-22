// Root-seitige Einstiegspunkte für die Kapitel-Bewertung (Sidebar + Hash-Router).
// Job-Flow, Render, State + History leben in Alpine.data('kapitelReviewCard').

export const kapitelReviewMethods = {
  async toggleKapitelReviewCard() {
    if (this.showKapitelReviewCard) { this.showKapitelReviewCard = false; return; }
    this._closeOtherMainCards('kapitelReview');
    this.showKapitelReviewCard = true;
  },

  async openKapitelReviewForChapter(chapterId) {
    if (!chapterId) return;
    const opts = this.kapitelReviewChapterOptions();
    if (!opts.some(c => String(c.id) === String(chapterId))) return;
    window.dispatchEvent(new CustomEvent('kapitel-review:select', {
      detail: { chapterId },
    }));
    if (!this.showKapitelReviewCard) {
      await this.toggleKapitelReviewCard();
    }
  },

  // Sobald ein Buch als „strukturiert" erkennbar ist (≥2 Kapitel, mind. eines
  // mit mehreren Seiten), lohnt sich das Kapitel-Review. Reine Flachbücher
  // deckt das Seiten-Lektorat ab.
  _bookQualifiesForChapterReview() {
    const chapters = (this.tree || []).filter(i => i.type === 'chapter');
    return chapters.length >= 2 && chapters.some(c => c.pages.length > 1);
  },

  kapitelReviewChapterOptions() {
    if (!this._bookQualifiesForChapterReview()) return [];
    return (this.tree || [])
      .filter(i => i.type === 'chapter' && i.pages.length > 0)
      .map(c => ({ id: c.id, name: c.name, pageCount: c.pages.length }));
  },
};
