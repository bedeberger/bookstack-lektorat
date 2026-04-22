// Interne Navigation zwischen Buch-Views. `_beginNavigation/_endNavigation`
// klammern zusammengesetzte Karten-Öffnungen (z.B. openFigurById →
// toggleFiguresCard → scrollIntoView), damit der Hash-Router nur EINEN
// History-Eintrag pro logischer Navigation schreibt statt pro Zwischenschritt.
export const appNavigationMethods = {
  async openFigurById(figId) {
    this._beginNavigation();
    try {
      this.figurenFilters.kapitel = '';
      this.figurenFilters.seite = '';
      if (!this.showFiguresCard) {
        await this.toggleFiguresCard();
      }
      this.selectedFigurId = figId;
      await this.$nextTick();
      document.querySelector(`.figur-item[data-figid="${figId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } finally {
      this._endNavigation();
    }
  },

  async openOrtById(ortId) {
    this._beginNavigation();
    try {
      this.orteFilters.suche = '';
      this.orteFilters.figurId = '';
      this.orteFilters.kapitel = '';
      this.orteFilters.szeneId = '';
      if (!this.showOrteCard) {
        await this.toggleOrteCard();
      }
      this.selectedOrtId = ortId;
      await this.$nextTick();
      document.querySelector(`.ort-item[data-ortid="${ortId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } finally {
      this._endNavigation();
    }
  },

  async openEreignisseMitKapitel(kapitel) {
    this._beginNavigation();
    try {
      if (!this.showEreignisseCard) {
        await this.toggleEreignisseCard();
      }
      this.ereignisseFilterKapitel = kapitel;
    } finally {
      this._endNavigation();
    }
  },

  async openEreignisseMitFigur(figurId) {
    this._beginNavigation();
    try {
      if (!this.showEreignisseCard) {
        await this.toggleEreignisseCard();
      }
      this.ereignisseFilterFigurId = figurId;
      this.ereignisseFilterKapitel = '';
      this.ereignisseFilterSeite = '';
      this.ereignisseSuche = '';
    } finally {
      this._endNavigation();
    }
  },

  // Löst Kapitel+Seite (Namen) zu einem Page-Objekt auf. Mehrdeutigkeit in
  // dieser Reihenfolge: Kapitel exakt → exakte Seite → Teilstring-Seite →
  // erste Kapitelseite; ohne Kapitel: globaler Seiten-Fallback.
  _resolvePage(kapitel, seite) {
    const kName = Array.isArray(kapitel) ? kapitel[0] : kapitel;
    if (!kName && !seite) return null;
    const chapters = (this.tree || []).filter(t => t.type === 'chapter');
    const sLower = seite ? String(seite).toLowerCase() : '';
    if (!kName) {
      return this.pages.find(p => p.name === seite)
        || this.pages.find(p => p.name.toLowerCase() === sLower)
        || null;
    }
    const chapter = chapters.find(c => c.name === kName);
    const pages = chapter?.pages || [];
    if (!pages.length) return null;
    if (seite) {
      const exact = pages.find(p => p.name === seite)
        || pages.find(p => p.name.toLowerCase() === sLower);
      if (exact) return exact;
      const sub = pages.find(p => {
        const n = p.name.toLowerCase();
        return n && (n.includes(sLower) || sLower.includes(n));
      });
      if (sub) return sub;
    }
    return pages[0];
  },

  gotoStelle(kapitel, seite) {
    const page = this._resolvePage(kapitel, seite);
    if (page) this.selectPage(page);
  },

  gotoPageById(pageId) {
    if (!pageId) return;
    const page = this.pages.find(p => String(p.id) === String(pageId));
    if (page) this.selectPage(page);
  },

  // Zusammengesetzte Navigationen (z.B. openFigurById → toggleFiguresCard
  // → loadFiguren) erzeugen sonst mehrere History-Einträge. Mit diesem
  // Wrapper werden Zwischen-States unterdrückt, am Ende genau einmal gepusht.
  // Inside _applyHash: unterdrückt alles, URL wird nicht angefasst (Hash
  // hat bereits den Zielzustand vorgegeben).
  _beginNavigation() {
    this._navDepth += 1;
    this._applyingHash = true;
  },
  _endNavigation() {
    this._navDepth = Math.max(0, this._navDepth - 1);
    if (this._navDepth > 0) return;
    if (this._inHashApply) return;
    this._applyingHash = false;
    this._writeHash(this._computeHash());
  },
};
