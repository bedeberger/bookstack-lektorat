import { htmlToText, stripFocusArtefacts, fetchJson } from './utils.js';

// View-Steuerung: Exklusivität zwischen Buch-/Seiten-Karten, Seitenauswahl,
// Reset-Logik beim Buch-/Seitenwechsel. Buchebenen-Features und Editor sind
// gegenseitig exklusiv (siehe CLAUDE.md-Regel "Feature-Toggle").
export const appViewMethods = {
  async selectPage(p) {
    if (this.currentPage && this.currentPage.id === p.id) {
      this.resetPage();
      return;
    }
    if (this.editMode && this.editDirty) {
      if (!confirm(this.t('app.switchPageConfirm'))) return;
    }
    // Buchkarten schliessen – nur eine Ebene (Buch oder Seite) aktiv
    this.showBookReviewCard = false;
    this.showKapitelReviewCard = false;
    this.showFiguresCard = false;
    this.showBookStatsCard = false;
    this.showStilCard = false;
    this.showFehlerHeatmapCard = false;
    this.showBookChatCard = false;
    this.showEreignisseCard = false;
    this.showSzenenCard = false;
    this.showOrteCard = false;
    this.showBookSettingsCard = false;
    this.showKontinuitaetCard = false;
    this.showUserSettingsCard = false;

    this.resetPage();
    this.currentPage = p;
    this.showEditorCard = true;

    // Prüfen ob ein Lektorat-Check-Job für diese Seite läuft (Server-seitig oder aus früherer Session)
    try {
      const { jobId: activeJobId } = await fetchJson(`/jobs/active?type=check&page_id=${p.id}`);
      if (activeJobId) {
        localStorage.setItem('lektorat_check_job_' + p.id, activeJobId);
        this.checkLoading = true;
        this.checkProgress = 0;
        this.analysisOut = '';
        this.setStatus(this.t('app.lektoratRunning'), true);
        this.startCheckPoll(activeJobId);
        await this.loadPageHistory(p.id);
        return;
      }
      // Kein aktiver Job → stale localStorage-Eintrag bereinigen
      localStorage.removeItem('lektorat_check_job_' + p.id);
    } catch (e) { console.error('[selectPage active-job check]', e); }

    // Seiteninhalt laden und als formatiertes HTML rendern
    try {
      const pd = await this.bsGet('pages/' + p.id);
      const html = stripFocusArtefacts(pd.html || '');
      this.originalHtml = html;
      this.renderedPageHtml = html;
      this._updatePageViewHeight();
      // Listing-Cache kann stale sein (bsPut aktualisiert ihn nicht).
      if (pd.updated_at) p.updated_at = pd.updated_at;
      this.currentPageEmpty = !htmlToText(html).trim();
      this.analysisOut = '';
    } catch (e) {
      console.error('[selectPage load-page]', e);
      this.setStatus(this.t('chat.pageLoadFailed'));
    }

    // Figurenkontext für dieses Kapitel laden (parallel zur History)
    this.loadChapterFigures();
    await this.loadPageHistory(p.id);
  },

  // Schliesst die anderen Hauptkarten (nicht Tree – der bleibt immer aktiv).
  // Bewertung, Figuren, Entwicklung und Buch-Chat sind exklusiv.
  // Beim Öffnen einer Buchkarte wird auch die offene Seite geschlossen.
  _closeOtherMainCards(keep) {
    if (keep !== 'bookReview') this.showBookReviewCard = false;
    if (keep !== 'kapitelReview') this.showKapitelReviewCard = false;
    if (keep !== 'figures') this.showFiguresCard = false;
    if (keep !== 'szenen') this.showSzenenCard = false;
    if (keep !== 'ereignisse') this.showEreignisseCard = false;
    if (keep !== 'bookStats') this.showBookStatsCard = false;
    if (keep !== 'stil') this.showStilCard = false;
    if (keep !== 'fehlerHeatmap') this.showFehlerHeatmapCard = false;
    if (keep !== 'bookChat') this.showBookChatCard = false;
    if (keep !== 'orte') this.showOrteCard = false;
    if (keep !== 'kontinuitaet') this.showKontinuitaetCard = false;
    if (keep !== 'bookSettings') this.showBookSettingsCard = false;
    if (keep !== 'userSettings') this.showUserSettingsCard = false;
    this.resetPage();
  },

  // Karten-Toggles für migrierte Alpine.data-Sub-Komponenten: Root hält die
  // `showXxxCard`-Flags (Single Source of Truth für Hash-Router + Exklusivität);
  // die Sub-Komponente reagiert per $watch und lädt ihre Daten selbst.
  toggleStilCard() {
    if (this.showStilCard) { this.showStilCard = false; return; }
    this._closeOtherMainCards('stil');
    this.showStilCard = true;
  },
  toggleFehlerHeatmapCard() {
    if (this.showFehlerHeatmapCard) { this.showFehlerHeatmapCard = false; return; }
    this._closeOtherMainCards('fehlerHeatmap');
    this.showFehlerHeatmapCard = true;
  },
  toggleBookStatsCard() {
    if (this.showBookStatsCard) { this.showBookStatsCard = false; return; }
    this._closeOtherMainCards('bookStats');
    this.showBookStatsCard = true;
  },
  toggleBookSettingsCard() {
    if (this.showBookSettingsCard) { this.showBookSettingsCard = false; return; }
    this._closeOtherMainCards('bookSettings');
    this.showBookSettingsCard = true;
  },
  toggleUserSettingsCard() {
    if (this.showUserSettingsCard) { this.showUserSettingsCard = false; return; }
    this._closeOtherMainCards('userSettings');
    this.showUserSettingsCard = true;
  },
  // Abweichend von den anderen Toggles: erneuter Klick schliesst NICHT, sondern
  // refresht die History (bildet das alte onOpenWhenOpen-Verhalten nach, das
  // bei createJobFeature-basierten Karten aktiv war). Sub-Komponente lauscht
  // auf `card:refresh` mit name='kontinuitaet'.
  toggleKontinuitaetCard() {
    if (this.showKontinuitaetCard) {
      window.dispatchEvent(new CustomEvent('card:refresh', { detail: { name: 'kontinuitaet' } }));
      return;
    }
    this._closeOtherMainCards('kontinuitaet');
    this.showKontinuitaetCard = true;
  },
  // Erneuter Klick refresht statt zu schliessen (siehe kontinuitaetCard-Muster).
  async toggleEreignisseCard() {
    if (this.showEreignisseCard) {
      window.dispatchEvent(new CustomEvent('card:refresh', { detail: { name: 'ereignisse' } }));
      return;
    }
    this._closeOtherMainCards('ereignisse');
    this.showEreignisseCard = true;
    // Figuren werden für den Figur-Filter gebraucht — noch nicht in Sub-Komponente;
    // Fallback-Load bleibt vorerst im Root.
    if (!this.figuren.length) {
      await this.loadFiguren(this.selectedBookId);
    }
  },
  async toggleOrteCard() {
    if (this.showOrteCard) {
      window.dispatchEvent(new CustomEvent('card:refresh', { detail: { name: 'orte' } }));
      return;
    }
    this._closeOtherMainCards('orte');
    this.showOrteCard = true;
    if (!this.figuren.length) await this.loadFiguren(this.selectedBookId);
  },
  async toggleSzenenCard() {
    if (this.showSzenenCard) {
      window.dispatchEvent(new CustomEvent('card:refresh', { detail: { name: 'szenen' } }));
      return;
    }
    this._closeOtherMainCards('szenen');
    this.showSzenenCard = true;
    if (!this.figuren.length) await this.loadFiguren(this.selectedBookId);
    if (!this.orte.length) await this.loadOrte(this.selectedBookId);
  },
  // Erneuter Klick refresht statt zu schliessen (bildet das alte
  // createJobFeature-Verhalten nach).
  toggleFiguresCard() {
    if (this.showFiguresCard) {
      window.dispatchEvent(new CustomEvent('card:refresh', { detail: { name: 'figuren' } }));
      return;
    }
    this._closeOtherMainCards('figures');
    this.showFiguresCard = true;
  },
  // Seiten-Chat: lebt neben dem Editor, schließt NICHT den Editor. Toggle
  // merkt sich checkDone-Snapshot (Chat soll Findings temporär verbergen).
  toggleChatCard() {
    if (this.showChatCard) {
      this.showChatCard = false;
      // lektoratFindings bleiben in der Sub — hier nur Flags am Root:
      if (this._checkDoneBeforeChat && this.lektoratFindings?.length > 0) {
        this.checkDone = true;
        this._checkDoneBeforeChat = false;
      }
      return;
    }
    if (!this.currentPage) return;
    // Seiten-Chat schliesst NICHT die anderen Karten — er läuft neben dem Editor.
    this.showChatCard = true;
    // checkDoneBeforeChat wird in chat-base beim onVisible gesetzt.
  },
  // Buch-Chat: exklusive Hauptkarte wie alle anderen.
  toggleBookChatCard() {
    if (this.showBookChatCard) {
      window.dispatchEvent(new CustomEvent('card:refresh', { detail: { name: 'bookChat' } }));
      return;
    }
    if (!this.selectedBookId) return;
    this._closeOtherMainCards('bookChat');
    this.showBookChatCard = true;
  },
  // Seitenwechsel: Seiten-Chat resetten (Chat ist pro Seite). Wird von
  // resetPage() aufgerufen — dispatched an die Sub-Komponente.
  resetChat() {
    window.dispatchEvent(new CustomEvent('chat:reset'));
  },
  resetBookChat() {
    window.dispatchEvent(new CustomEvent('book-chat:reset'));
  },

  async toggleTreeCard() {
    if (this.showTreeCard) { this.showTreeCard = false; this.resetPage(); return; }
    this._closeOtherMainCards('tree');
    this.showTreeCard = true;
    if (!this.pages.length) await this.loadPages();
    // Prüfen ob bereits ein Batch-Check-Job für dieses Buch läuft
    if (!this._batchPollTimer && !this.batchLoading && this.selectedBookId) {
      try {
        const { jobId } = await fetchJson(`/jobs/active?type=batch-check&book_id=${this.selectedBookId}`);
        if (jobId) {
          this.batchLoading = true;
          this.batchProgress = 0;
          this.batchStatus = this._runningJobStatus(this.t('common.analysisAlreadyRunning'), 0, 0);
          this.startBatchPoll(jobId);
        }
      } catch (e) {
        console.error('[toggleTreeCard] active-job check:', e);
      }
    }
  },

  // Setzt allen Seiten-Level-State zurück (Editor, Lektorat, Chat, History).
  resetPage() {
    if (this._checkPollTimer) { clearInterval(this._checkPollTimer); this._checkPollTimer = null; }
    if (this._synonymPollTimer) { clearInterval(this._synonymPollTimer); this._synonymPollTimer = null; }
    this.showSynonymMenu = false;
    this.showSynonymPicker = false;
    this.closeFigurLookup?.();
    if (this.focusMode) this.exitFocusMode();
    this._stopAutosave?.();
    this._uninstallOnlineRetry?.();
    this.resetChat();
    this.currentPage = null;
    this.currentPageEmpty = false;
    this.renderedPageHtml = '';
    this.chapterFigures = [];
    this.showChapterFigures = false;
    this.originalHtml = null;
    this.correctedHtml = null;
    this.hasErrors = false;
    this.editMode = false;
    this.editDirty = false;
    this.editSaving = false;
    this.lastAutosaveAt = null;
    this.lastDraftSavedAt = null;
    this.showEditorCard = false;
    this.analysisOut = '';
    this.status = '';
    this.statusSpinner = false;
    this.lastCheckId = null;
    this.pageHistory = [];
    this.activeHistoryEntryId = null;
    this.lektoratFindings = [];
    this.selectedFindings = [];
    this.appliedOriginals = [];
    this.checkDone = false;
    this.checkLoading = false;
    this.checkProgress = 0;
  },

  // Setzt allen buchbezogenen State zurück. Wird bei Buchwechsel (Combobox,
  // Hash, programmatisch) aufgerufen, bevor `loadPages()` das neue Buch lädt.
  // Karten bleiben sichtbar — `_reloadVisibleBookCards()` füllt sie danach neu.
  // Migrierte Alpine.data-Sub-Komponenten (z.B. stilCard) hören auf das
  // `book:changed`-Event und resetten ihren eigenen State selbst.
  _resetBookScopedState() {
    window.dispatchEvent(new CustomEvent('book:changed', {
      detail: { bookId: this.selectedBookId },
    }));
    // Datenarrays
    this.figuren = [];
    this.orte = [];
    this.szenen = [];
    // bookStatsCard (bookStatsData, bookStatsCoverage, bookStatsDelta,
    // writingTimeData): Sub-Komponente hört auf `book:changed` und lädt neu.
    this.globalZeitstrahl = [];
    this.bookReviewHistory = [];
    // kapitelReviewCard: Sub-Komponente hört auf `book:changed` und resetet eigenen State.
    this.newPageTitle = '';
    this.newPageCreating = false;
    this.newPageError = '';
    // chatCard + bookChatCard: Sub-Komponenten hören auf `book:changed` und resetten sich.
    // kontinuitaetCard: Sub-Komponente hört auf `book:changed` und resetet.
    this.chapterFigures = [];
    this.pageHistory = [];
    this.activeHistoryEntryId = null;
    this.tokEsts = {};
    this._tokenEstGen++;

    // Selektionen
    this.selectedFigurId = null;
    this.selectedOrtId = null;
    // bookReviewCard: Sub-Komponente resetet selectedBookReviewId via book:changed.
    this.lastCheckId = null;

    // Timestamps (figurenUpdatedAt lebt jetzt in figurenCard)
    this.szenenUpdatedAt = null;
    this.orteUpdatedAt = null;

    // Buch-scoped Pollers stoppen (zielen sonst auf altes Buch).
    // Migrierte Karten (kontinuitaet/ereignisse/orte/szenen) stoppen eigene
    // Timer via book:changed-Handler in der Sub-Komponente.
    const timers = [
      '_figuresPollTimer',
      '_komplettPollTimer',
    ];
    for (const t of timers) {
      if (this[t]) { clearInterval(this[t]); this[t] = null; }
    }

    // Komplett-Analyse-UI zurücksetzen, damit ein neues Buch eine eigene
    // Komplett-Analyse queuen kann. Der Server-Job des alten Buchs läuft weiter;
    // checkPendingJobs(bookId) reconnectet beim Zurückwechseln automatisch.
    this.alleAktualisierenLoading = false;
    this.alleAktualisierenStatus = '';
    this.alleAktualisierenProgress = 0;
    this.alleAktualisierenTokIn = 0;
    this.alleAktualisierenTokOut = 0;
    this.alleAktualisierenTps = null;
    this.showKomplettStatus = false;

    // Graph- und Chart-Zerstörung passiert in den Sub-Komponenten
    // (figurenCard, bookStatsCard) via book:changed-Handler.
  },

  async _reloadVisibleBookCards() {
    // Alle migrierten Sub-Komponenten (orte/szenen/ereignisse/kontinuitaet/
    // bookStats/stil/fehlerHeatmap/bookSettings) laden selbst per book:changed-
    // Event neu. `loadPages()` übernimmt den Rest (figuren + bookReviewHistory).
  },

  // Setzt alles zurück: Seiten-Level (via resetPage) + Buch-Level.
  // Migrierte Alpine.data-Sub-Komponenten hören auf `view:reset` und resetten
  // ihren eigenen State selbst; der Root setzt nur noch die `showXxxCard`-Flags.
  resetView() {
    window.dispatchEvent(new CustomEvent('view:reset'));
    this.resetPage();
    this.clearBookstackSearch();
    // Kapitel in der Sidebar bleiben geöffnet (kein c.open = false)
    this.showTreeCard = true;
    this.showBookReviewCard = false;
    this.bookReviewHistory = [];
    this.showKapitelReviewCard = false;
    // bookReviewCard + kapitelReviewCard: Sub-Komponenten hören auf `view:reset`
    // und resetten Loading/Progress/Status/Out + Selektionen selbst.
    if (this._batchPollTimer) { clearInterval(this._batchPollTimer); this._batchPollTimer = null; }
    this.batchLoading = false;
    this.batchProgress = 0;
    this.batchStatus = '';
    this.showFiguresCard = false;
    this.figurenStatus = '';
    this.figurenProgress = 0;
    this.selectedFigurId = null;
    this.figurenFilters.kapitel = '';
    this.figurenFilters.seite = '';
    // figurenCard: figurenUpdatedAt + Graph-Internals reseted die Sub-Komponente via `view:reset`.
    this.globalZeitstrahl = [];
    this.showGlobalZeitstrahl = false;
    this.showEreignisseCard = false;
    this.ereignisseFilters.figurId = '';
    this.ereignisseFilters.kapitel = '';
    this.ereignisseFilters.seite = '';
    // ereignisseCard: Sub-Komponente hört auf `view:reset` und resetet eigenen
    // State (Loading/Progress/Status, PollTimer).
    this.showSzenenCard = false;
    this.szenen = [];
    this.szenenUpdatedAt = null;
    this.szenenFilters.wertung = '';
    this.szenenFilters.figurId = '';
    this.szenenFilters.kapitel = '';
    this.szenenFilters.seite = '';
    this.szenenFilters.ortId = '';
    // szenenCard: Sub-Komponente hört auf `view:reset` (Loading/Progress/Status/Timer).
    if (this._figurenNetwork) { this._figurenNetwork.destroy(); this._figurenNetwork = null; }
    this.showBookStatsCard = false;
    // bookStatsCard: Sub-Komponente hört auf `view:reset` und resetet eigenen
    // State (inkl. Chart.destroy + Theme-Observer.disconnect).
    this.showStilCard = false;
    // stilCard: Sub-Komponente hört auf `view:reset` und resetet eigenen State.
    this.showFehlerHeatmapCard = false;
    // fehlerHeatmapCard: Sub-Komponente hört auf `view:reset` und resetet eigenen State.
    this.showOrteCard = false;
    this.orte = [];
    this.orteFilters.figurId = '';
    this.orteFilters.kapitel = '';
    this.orteFilters.szeneId = '';
    // orteCard: Sub-Komponente hört auf `view:reset` (Loading/Progress/Status/Timer).
    this.showKontinuitaetCard = false;
    // kontinuitaetCard: Sub-Komponente hört auf `view:reset` und resetet
    // eigenen State (inkl. Poll-Timer-Stop).
    if (this._komplettPollTimer) { clearInterval(this._komplettPollTimer); this._komplettPollTimer = null; }
    this.showBookSettingsCard = false;
    this.showUserSettingsCard = false;
    // bookSettingsCard + userSettingsCard: Sub-Komponenten hören auf
    // `view:reset` und resetten ihren eigenen State (Saved-/Error-Flags).
    this.alleAktualisierenLastRun = null;
    this.alleAktualisierenProgress = 0;
    this.alleAktualisierenTokIn = 0;
    this.alleAktualisierenTokOut = 0;
    this.alleAktualisierenTps = null;
    this.showKomplettStatus = false;
    this.resetBookChat();
  },
};
