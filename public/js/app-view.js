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
  _resetBookScopedState() {
    // Datenarrays
    this.figuren = [];
    this.orte = [];
    this.szenen = [];
    this.bookStatsData = [];
    this.bookStatsCoverage = null;
    this.bookStatsDelta = null;
    this.globalZeitstrahl = [];
    this.bookReviewHistory = [];
    this.kapitelReviewHistory = {};
    this.kapitelReviewOut = '';
    this.kapitelReviewStatus = '';
    this.kapitelReviewProgress = 0;
    this.kapitelReviewLoading = false;
    this.kapitelReviewChapterId = '';
    this._kapitelReviewRunningChapterId = '';
    this.selectedKapitelReviewId = null;
    this.newPageTitle = '';
    this.newPageCreating = false;
    this.newPageError = '';
    this.chatSessions = [];
    this.chatMessages = [];
    this.chatSessionId = null;
    this.bookChatSessions = [];
    this.bookChatMessages = [];
    this.bookChatSessionId = null;
    this.kontinuitaetResult = null;
    this.chapterFigures = [];
    this.pageHistory = [];
    this.activeHistoryEntryId = null;
    this.tokEsts = {};
    this._tokenEstGen++;

    // Selektionen
    this.selectedFigurId = null;
    this.selectedOrtId = null;
    this.selectedBookReviewId = null;
    this.lastCheckId = null;

    // Timestamps
    this.figurenUpdatedAt = null;
    this.szenenUpdatedAt = null;
    this.orteUpdatedAt = null;

    // Buch-scoped Pollers stoppen (zielen sonst auf altes Buch)
    const timers = [
      '_figuresPollTimer', '_ortePollTimer', '_szenenPollTimer',
      '_consolidatePollTimer', '_kontinuitaetPollTimer',
      '_ereignisseExtractPollTimer', '_chatPollTimer',
      '_bookChatPollTimer', '_reviewPollTimer', '_kapitelReviewPollTimer', '_komplettPollTimer',
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

    // Visualisierungen zerstören (bauen Graph/Chart sonst mit altem Buch-Daten auf)
    if (this._figurenNetwork) { this._figurenNetwork.destroy(); this._figurenNetwork = null; }
    this._figurenHash = null;
  },

  async _reloadVisibleBookCards() {
    const bookId = this.selectedBookId;
    if (!bookId) return;
    const jobs = [];
    // `loadPages()` lädt figuren + bookReviewHistory selbst — hier nur die übrigen.
    if (this.showOrteCard)       jobs.push(this.loadOrte(bookId));
    if (this.showSzenenCard)     jobs.push(this.loadSzenen(bookId));
    if (this.showBookStatsCard)  jobs.push(this.loadBookStats(bookId));
    if (this.showStilCard)       jobs.push(this.loadStilStats(bookId));
    if (this.showFehlerHeatmapCard) jobs.push(this.loadFehlerHeatmap());
    if (this.showBookSettingsCard && typeof this.loadBookSettings === 'function') {
      jobs.push(this.loadBookSettings());
    }
    if (this.showEreignisseCard && typeof this._reloadZeitstrahl === 'function') {
      jobs.push(this._reloadZeitstrahl());
    }
    await Promise.all(jobs);
  },

  // Setzt alles zurück: Seiten-Level (via resetPage) + Buch-Level.
  resetView() {
    this.resetPage();
    this.clearBookstackSearch();
    // Kapitel in der Sidebar bleiben geöffnet (kein c.open = false)
    this.showTreeCard = true;
    this.showBookReviewCard = false;
    this.bookReviewOut = '';
    this.bookReviewStatus = '';
    this.bookReviewHistory = [];
    this.selectedBookReviewId = null;
    this.showKapitelReviewCard = false;
    this.kapitelReviewOut = '';
    this.kapitelReviewStatus = '';
    this.selectedKapitelReviewId = null;
    if (this._batchPollTimer) { clearInterval(this._batchPollTimer); this._batchPollTimer = null; }
    this.batchLoading = false;
    this.batchProgress = 0;
    this.batchStatus = '';
    this.showFiguresCard = false;
    this.figurenStatus = '';
    this.figurenProgress = 0;
    this.figurenUpdatedAt = null;
    this.selectedFigurId = null;
    this.figurenKapitelFilter = '';
    this.figurenSeitenFilter = '';
    this.globalZeitstrahl = [];
    this.showGlobalZeitstrahl = false;
    this.zeitstrahlConsolidating = false;
    this.zeitstrahlProgress = 0;
    this.zeitstrahlStatus = '';
    this.showEreignisseCard = false;
    this.ereignisseLoading = false;
    this.ereignisseProgress = 0;
    this.ereignisseStatus = '';
    this.ereignisseFilterFigurId = '';
    this.ereignisseFilterKapitel = '';
    this.ereignisseFilterSeite = '';
    if (this._ereignisseExtractPollTimer) { clearInterval(this._ereignisseExtractPollTimer); this._ereignisseExtractPollTimer = null; }
    this.showSzenenCard = false;
    this.szenen = [];
    this.szenenUpdatedAt = null;
    this.szenenStatus = '';
    this.szenenProgress = 0;
    this.szenenLoading = false;
    this.szenenFilterWertung = '';
    this.szenenFilterFigurId = '';
    this.szenenFilterKapitel = '';
    this.szenenFilterSeite = '';
    this.szenenFilterOrtId = '';
    if (this._consolidatePollTimer) { clearInterval(this._consolidatePollTimer); this._consolidatePollTimer = null; }
    if (this._szenenPollTimer) { clearInterval(this._szenenPollTimer); this._szenenPollTimer = null; }
    if (this._figurenNetwork) { this._figurenNetwork.destroy(); this._figurenNetwork = null; }
    this.showBookStatsCard = false;
    this.bookStatsData = [];
    this.bookStatsSyncStatus = '';
    if (this._statsChart) { this._statsChart.destroy(); this._statsChart = null; }
    this.showStilCard = false;
    this.stilData = null;
    this.stilStatus = '';
    this.stilLoading = false;
    this.stilSyncing = false;
    this.activeStilDetailKey = null;
    this.showFehlerHeatmapCard = false;
    this.fehlerHeatmapData = null;
    this.fehlerHeatmapStatus = '';
    this.fehlerHeatmapLoading = false;
    this.activeFehlerDetailKey = null;
    this.showOrteCard = false;
    this.orte = [];
    this.orteStatus = '';
    this.orteProgress = 0;
    this.orteLoading = false;
    this.orteFilterFigurId = '';
    this.orteFilterKapitel = '';
    this.orteFilterSzeneId = '';
    if (this._ortePollTimer) { clearInterval(this._ortePollTimer); this._ortePollTimer = null; }
    this.showKontinuitaetCard = false;
    this.kontinuitaetResult = null;
    this.kontinuitaetStatus = '';
    this.kontinuitaetProgress = 0;
    this.kontinuitaetLoading = false;
    this.kontinuitaetFilterFigurId = '';
    this.kontinuitaetFilterKapitel = '';
    if (this._kontinuitaetPollTimer) { clearInterval(this._kontinuitaetPollTimer); this._kontinuitaetPollTimer = null; }
    if (this._komplettPollTimer) { clearInterval(this._komplettPollTimer); this._komplettPollTimer = null; }
    this.showBookSettingsCard = false;
    this.bookSettingsSaved = false;
    this.bookSettingsError = '';
    this.showUserSettingsCard = false;
    this.userSettingsSaved = false;
    this.userSettingsError = '';
    this.alleAktualisierenLastRun = null;
    this.alleAktualisierenProgress = 0;
    this.alleAktualisierenTokIn = 0;
    this.alleAktualisierenTokOut = 0;
    this.alleAktualisierenTps = null;
    this.showKomplettStatus = false;
    this.resetBookChat();
  },
};
