// Kapitel-Review-Root-Methods. Der Job-Flow, Render, State und History leben
// in Alpine.data('kapitelReviewCard') — siehe cards/kapitel-review-card.js.
// Hier bleiben nur Root-seitige Einstiegspunkte, die von Sidebar und
// Hash-Router am Root erwartet werden.

export const kapitelReviewMethods = {
  // Flag-Toggle für die Karte. Die Sub reagiert via $watch auf showKapitelReviewCard.
  async toggleKapitelReviewCard() {
    if (this.showKapitelReviewCard) { this.showKapitelReviewCard = false; return; }
    this._closeOtherMainCards('kapitelReview');
    this.showKapitelReviewCard = true;
  },

  // Aus der Sidebar: Kapitel wählen + Karte öffnen. Dispatcht
  // `kapitel-review:select` an die Sub, die die eigentliche Logik umsetzt.
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

  // Liste der Kapitel, die fürs Kapitel-Review anklickbar sind — genutzt von
  // sidebar.html, app-hash-router.js und von der Sub-Komponente (dort eine
  // eigene Kopie, damit der Scope nicht auf $root angewiesen ist).
  kapitelReviewChapterOptions() {
    if (!this._bookQualifiesForChapterReview()) return [];
    return (this.tree || [])
      .filter(i => i.type === 'chapter' && i.pages.length > 0)
      .map(c => ({ id: c.id, name: c.name, pageCount: c.pages.length }));
  },
};
