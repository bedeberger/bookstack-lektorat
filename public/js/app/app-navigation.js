import { EVT } from '../events.js';

// Figuren/Orte/Szenen-IDs sind INTEGER-PKs; aus Volltext-Treffern (FTS5
// liefert entity_id als String) und aus Deep-Link-Hashes kommen sie als
// String. Der Listen-Expand vergleicht strikt (`selectedFigurId === f.id`,
// f.id = Number), darum hier auf Number normalisieren — sonst scrollt die
// Liste zwar (data-attr ist String), klappt das Element aber nie auf.
function _coerceId(id) {
  return (typeof id === 'string' && /^\d+$/.test(id)) ? Number(id) : id;
}

// Wartet, bis das Ziel-Element im DOM ist, und scrollt es zentriert ins Bild.
// Cold-Open: toggleXxxCard öffnet die Karte, deren Lifecycle-Load aber async
// läuft und vom Toggle nicht awaited wird → bei $nextTick fehlt die erst nach
// dem Fetch gerenderte Listenzeile noch.
function _scrollToWhenReady(selector, tries = 60) {
  const el = document.querySelector(selector);
  if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
  if (tries <= 0) return;
  requestAnimationFrame(() => _scrollToWhenReady(selector, tries - 1));
}

// Interne Navigation zwischen Buch-Views. `_beginNavigation/_endNavigation`
// klammern zusammengesetzte Karten-Öffnungen (z.B. openFigurById →
// toggleFiguresCard → scrollIntoView), damit der Hash-Router nur EINEN
// History-Eintrag pro logischer Navigation schreibt statt pro Zwischenschritt.
export const appNavigationMethods = {
  async openFigurById(figId) {
    this._beginNavigation();
    try {
      const fid = _coerceId(figId);
      this.$store.catalogUi.figurenFilters.kapitel = '';
      this.$store.catalogUi.figurenFilters.seite = '';
      if (!this.showFiguresCard) {
        await this.toggleFiguresCard();
      }
      this.$store.catalogUi.selectedFigurId = fid;
      await this.$nextTick();
      _scrollToWhenReady(`.figur-item[data-figid="${fid}"]`);
    } finally {
      this._endNavigation();
    }
  },

  async openFigurMitKapitel(figId, kapitelName) {
    this._beginNavigation();
    try {
      const fid = _coerceId(figId);
      this.$store.catalogUi.figurenFilters.kapitel = kapitelName || '';
      this.$store.catalogUi.figurenFilters.seite = '';
      if (!this.showFiguresCard) {
        await this.toggleFiguresCard();
      }
      this.$store.catalogUi.selectedFigurId = fid;
      await this.$nextTick();
      _scrollToWhenReady(`.figur-item[data-figid="${fid}"]`);
    } finally {
      this._endNavigation();
    }
  },

  async openOrtById(ortId) {
    this._beginNavigation();
    try {
      const oid = _coerceId(ortId);
      this.$store.catalogUi.orteFilters.suche = '';
      this.$store.catalogUi.orteFilters.figurId = '';
      this.$store.catalogUi.orteFilters.kapitel = '';
      this.$store.catalogUi.orteFilters.szeneId = '';
      if (!this.showOrteCard) {
        await this.toggleOrteCard();
      }
      this.$store.catalogUi.selectedOrtId = oid;
      await this.$nextTick();
      _scrollToWhenReady(`[data-ortid="${oid}"]`);
    } finally {
      this._endNavigation();
    }
  },

  async openOrtMitKapitel(ortId, kapitelName) {
    this._beginNavigation();
    try {
      const oid = _coerceId(ortId);
      this.$store.catalogUi.orteFilters.suche = '';
      this.$store.catalogUi.orteFilters.figurId = '';
      this.$store.catalogUi.orteFilters.kapitel = kapitelName || '';
      this.$store.catalogUi.orteFilters.szeneId = '';
      if (!this.showOrteCard) {
        await this.toggleOrteCard();
      }
      this.$store.catalogUi.selectedOrtId = oid;
      await this.$nextTick();
      _scrollToWhenReady(`[data-ortid="${oid}"]`);
    } finally {
      this._endNavigation();
    }
  },

  async openWerkstattDraftById(draftId) {
    this._beginNavigation();
    try {
      if (!this.showFigurWerkstattCard) {
        await this.toggleFigurWerkstattCard();
      }
      // Sub übernimmt Draft-Wechsel via figur-werkstatt:select. Drafts evtl.
      // noch nicht geladen → Sub parkt _pendingDraftId und löst nach loadDrafts.
      window.dispatchEvent(new CustomEvent(EVT.FIGUR_WERKSTATT_SELECT, {
        detail: { draftId },
      }));
      this.$store.nav.werkstattDraftId = draftId;
    } finally {
      this._endNavigation();
    }
  },

  // Cross-Feature: aus dem Plot-Board (Beat-Motiv-Badge) in die Motiv-Werkstatt
  // springen und dort das Motiv auswählen. Die Motiv-Karte hört `motiv:select`
  // und parkt die ID, falls das Board noch nicht geladen ist.
  async openMotifById(motifId) {
    this._beginNavigation();
    try {
      const mid = _coerceId(motifId);
      if (!this.showMotivCard) {
        await this.toggleMotivCard();
      }
      window.dispatchEvent(new CustomEvent(EVT.MOTIV_SELECT, {
        detail: { motifId: mid },
      }));
    } finally {
      this._endNavigation();
    }
  },

  // Cross-Feature: aus der Figuren-Werkstatt ins Plot-Board springen, gefiltert auf
  // die Beats dieser Werkstatt-Figur. Die Plot-Karte hört `plot:filter-draft-figure`
  // und parkt das Ziel, falls das Board noch nicht geladen ist.
  async openPlotForDraftFigure(draftId) {
    this._beginNavigation();
    try {
      if (!this.showPlotCard) {
        await this.togglePlotCard();
      }
      window.dispatchEvent(new CustomEvent(EVT.PLOT_FILTER_DRAFT_FIGURE, {
        detail: { draftId },
      }));
    } finally {
      this._endNavigation();
    }
  },

  async openSzeneById(szeneId) {
    this._beginNavigation();
    try {
      const sid = _coerceId(szeneId);
      this.$store.catalogUi.szenenFilters.suche = '';
      this.$store.catalogUi.szenenFilters.wertung = '';
      this.$store.catalogUi.szenenFilters.figurId = '';
      this.$store.catalogUi.szenenFilters.kapitel = '';
      this.$store.catalogUi.szenenFilters.ortId = '';
      if (!this.showSzenenCard) {
        await this.toggleSzenenCard();
      }
      this.$store.catalogUi.selectedSzeneId = sid;
      await this.$nextTick();
      _scrollToWhenReady(`[data-szeneid="${sid}"]`);
    } finally {
      this._endNavigation();
    }
  },

  // Einzelnes Ereignis oeffnen (Palette-Treffer, Deep-Link `#…/ereignis/<id>`).
  // Filter zuruecksetzen wie bei Figur/Ort/Szene: ein stehender Filter wuerde
  // das Ziel sonst aus der Liste schneiden und der Sprung liefe ins Leere.
  async openEreignisById(ereignisId) {
    this._beginNavigation();
    try {
      const eid = _coerceId(ereignisId);
      const f = this.$store.catalogUi.ereignisseFilters;
      f.figurId = ''; f.kapitel = ''; f.seite = ''; f.subtyp = ''; f.suche = '';
      if (!this.showEreignisseCard) {
        await this.toggleEreignisseCard();
      }
      this.$store.catalogUi.selectedEreignisId = eid;
      await this.$nextTick();
      _scrollToWhenReady(`[data-evid="${eid}"]`);
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
      this.$store.catalogUi.ereignisseFilters.kapitel = kapitel;
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
      this.$store.catalogUi.ereignisseFilters.figurId = figurId;
      this.$store.catalogUi.ereignisseFilters.kapitel = '';
      this.$store.catalogUi.ereignisseFilters.seite = '';
      this.$store.catalogUi.ereignisseFilters.suche = '';
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
    const chapters = (this.$store.nav.tree || []).filter(t => t.type === 'chapter' && !t.solo);
    const sLower = seite ? String(seite).toLowerCase() : '';
    if (!kName) {
      return this.$store.nav.pages.find(p => p.name === seite)
        || this.$store.nav.pages.find(p => p.name.toLowerCase() === sLower)
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
    const page = this.$store.nav.pages.find(p => String(p.id) === String(pageId));
    if (page) this.selectPage(page);
  },

  gotoChapterById(chapterId) {
    if (!chapterId) return;
    const chapter = (this.$store.nav.tree || []).find(t => t.type === 'chapter' && String(t.id) === String(chapterId));
    const first = chapter?.pages?.[0];
    if (first) this.selectPage(first);
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
