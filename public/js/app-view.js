import { htmlToText, stripFocusArtefacts, fetchJson, escHtml } from './utils.js';

// View-Steuerung: Exklusivität zwischen Buch-/Seiten-Karten, Seitenauswahl,
// Reset-Logik beim Buch-/Seitenwechsel. Buchebenen-Features und Editor sind
// gegenseitig exklusiv (siehe CLAUDE.md-Regel "Feature-Toggle").
export const appViewMethods = {
  async selectPage(p) {
    if (this.currentPage && this.currentPage.id === p.id) {
      // Re-Klick auf bereits offene Seite: SW-Cache umgehen und frischen
      // Server-Stand laden. Aktive Edits nicht überschreiben.
      if (this.editMode || this.editDirty) return;
      this._scrollToEditorCard();
      await this._refetchCurrentPage();
      return;
    }
    if (this.editMode && this.editDirty) {
      if (!confirm(this.t('app.switchPageConfirm'))) return;
    }
    // Buchkarten schliessen – nur eine Ebene (Buch oder Seite) aktiv
    this.showBookOverviewCard = false;
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
    this.showFinetuneExportCard = false;
    this.showExportCard = false;
    this.showPdfExportCard = false;
    this.resetPage();
    this.currentPage = p;
    this.showEditorCard = true;
    this.$nextTick(() => this._scrollToEditorCard());

    if (typeof this._trackPageUsage === 'function' && this.selectedBookId) {
      this._trackPageUsage(p.id, this.selectedBookId);
    }

    this._loadPageBadgeCounts(p.id);

    // Seiteninhalt laden und als formatiertes HTML rendern
    try {
      let pd = await this.bsGet('pages/' + p.id);
      // Stale-Check: Wenn der Tree-Eintrag (`p.updated_at`, kann selbst aus
      // SW-Cache stammen) jünger ist als die Detail-Antwort, hat der SW eine
      // veraltete Version geliefert → einmalig mit __fresh nachziehen.
      if (p.updated_at && pd.updated_at && new Date(pd.updated_at) < new Date(p.updated_at)) {
        pd = await this.bsGet('pages/' + p.id, { fresh: true });
      }
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

    // Prüfen ob ein Lektorat-Check-Job für diese Seite läuft (Server-seitig oder aus früherer Session)
    try {
      const { jobId: activeJobId } = await fetchJson(`/jobs/active?type=check&page_id=${p.id}`);
      if (activeJobId) {
        localStorage.setItem('lektorat_check_job_' + p.id, activeJobId);
        this.checkLoading = true;
        this.checkProgress = 0;
        this.analysisOut = '';
        this.checkStatus = `<span class="spinner"></span>${escHtml(this.t('app.lektoratRunning'))}`;
        this.startCheckPoll(activeJobId);
      } else {
        // Kein aktiver Job → stale localStorage-Eintrag bereinigen
        localStorage.removeItem('lektorat_check_job_' + p.id);
      }
    } catch (e) { console.error('[selectPage active-job check]', e); }

    // Figurenkontext für dieses Kapitel laden (parallel zur History)
    this.loadChapterFigures();
    await this.loadPageHistory(p.id);
  },

  // Scroll-Ziel beim Seitenwechsel: Mobile (<960px, einspaltig) → Editor-Card
  // ins Viewport, sonst sieht User den Tree statt der frisch geöffneten Seite.
  // Desktop (>=960px, zweispaltig) → Window-Top, da Editor in eigener Spalte.
  _scrollToEditorCard() {
    const isMobile = window.matchMedia('(max-width: 959.98px)').matches;
    if (isMobile) {
      const el = document.getElementById('editor-card');
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  },

  // Lädt die aktuell offene Seite neu vom Server (SW-Cache umgangen). Wird
  // beim Re-Klick auf die offene Sidebar-Seite verwendet, damit nach externer
  // Änderung in BookStack kein veralteter Stand stehenbleibt.
  async _refetchCurrentPage() {
    if (!this.currentPage) return;
    const pageId = this.currentPage.id;
    try {
      const pd = await this.bsGet('pages/' + pageId, { fresh: true });
      if (this.currentPage?.id !== pageId) return;
      const html = stripFocusArtefacts(pd.html || '');
      this.originalHtml = html;
      this.renderedPageHtml = html;
      this._updatePageViewHeight();
      if (pd.updated_at) this.currentPage.updated_at = pd.updated_at;
      this.currentPageEmpty = !htmlToText(html).trim();
    } catch (e) {
      console.error('[refetchCurrentPage]', e);
      this.setStatus(this.t('chat.pageLoadFailed'));
    }
  },

  // Schliesst die anderen Hauptkarten (nicht Tree – der bleibt immer aktiv).
  // Bewertung, Figuren, Entwicklung und Buch-Chat sind exklusiv.
  // Beim Öffnen einer Buchkarte wird auch die offene Seite geschlossen.
  _closeOtherMainCards(keep) {
    if (keep !== 'bookOverview') this.showBookOverviewCard = false;
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
    if (keep !== 'finetuneExport') this.showFinetuneExportCard = false;
    if (keep !== 'export') this.showExportCard = false;
    if (keep !== 'pdfExport') this.showPdfExportCard = false;
    this.resetPage();
  },

  // Lädt Badge-Counts (offene Ideen, Chat-Sessions) für die geöffnete Seite.
  // Race-safe: prüft pageId gegen aktuelle Seite vor Set, falls User schnell wechselt.
  async _loadPageBadgeCounts(pageId) {
    try {
      const [ideen, sessions] = await Promise.all([
        fetchJson(`/ideen?page_id=${pageId}`).catch(() => []),
        fetchJson(`/chat/sessions/${pageId}`).catch(() => []),
      ]);
      if (this.currentPage?.id !== pageId) return;
      const openCount = (Array.isArray(ideen) ? ideen : []).filter(i => !i.erledigt).length;
      this.currentPageIdeenOpenCount = openCount;
      this.currentPageChatSessionCount = (Array.isArray(sessions) ? sessions : []).length;
      // Tree-Indikator mit frischer Wahrheit syncen (z.B. bei Cross-Tab-Edits).
      const next = { ...(this.ideenCounts || {}) };
      if (openCount > 0) next[pageId] = openCount;
      else delete next[pageId];
      this.ideenCounts = next;
    } catch (e) {
      console.error('[loadPageBadgeCounts]', e);
    }
  },

  // Karten-Toggles: Root hält die `showXxxCard`-Flags (Single Source of Truth
  // für Hash-Router + Exklusivität); die Sub-Komponente reagiert per $watch
  // und lädt ihre Daten selbst.
  toggleBookOverviewCard() {
    if (this.showBookOverviewCard) {
      window.dispatchEvent(new CustomEvent('card:refresh', { detail: { name: 'bookOverview' } }));
      return;
    }
    if (!this.selectedBookId) return;
    this._closeOtherMainCards('bookOverview');
    this.showBookOverviewCard = true;
  },
  // Default-Landing: öffnet Übersicht, wenn Buch gewählt ist und keine andere
  // Hauptkarte/Editor aktiv. Wird beim Buchwechsel + bei `#book/:id`-Deeplink
  // ohne View aufgerufen.
  _maybeOpenBookOverview() {
    if (!this.selectedBookId) return;
    if (this.showEditorCard) return;
    const anyOpen = this.showBookOverviewCard
      || this.showBookReviewCard || this.showKapitelReviewCard
      || this.showFiguresCard || this.showSzenenCard || this.showOrteCard
      || this.showEreignisseCard || this.showKontinuitaetCard
      || this.showBookStatsCard || this.showStilCard || this.showFehlerHeatmapCard
      || this.showBookChatCard || this.showBookSettingsCard
      || this.showUserSettingsCard || this.showFinetuneExportCard
      || this.showExportCard || this.showPdfExportCard;
    if (anyOpen) return;
    this.showBookOverviewCard = true;
  },
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
  toggleFinetuneExportCard() {
    if (this.showFinetuneExportCard) { this.showFinetuneExportCard = false; return; }
    this._closeOtherMainCards('finetuneExport');
    this.showFinetuneExportCard = true;
  },
  toggleExportCard() {
    if (this.showExportCard) { this.showExportCard = false; return; }
    this._closeOtherMainCards('export');
    this.showExportCard = true;
  },
  togglePdfExportCard() {
    if (this.showPdfExportCard) { this.showPdfExportCard = false; return; }
    this._closeOtherMainCards('pdfExport');
    this.showPdfExportCard = true;
  },
  // Abweichend von den anderen Toggles: erneuter Klick schliesst NICHT, sondern
  // refresht die History. Sub-Komponente lauscht auf `card:refresh`
  // mit name='kontinuitaet'.
  toggleKontinuitaetCard() {
    if (this.showKontinuitaetCard) {
      window.dispatchEvent(new CustomEvent('card:refresh', { detail: { name: 'kontinuitaet' } }));
      return;
    }
    this._closeOtherMainCards('kontinuitaet');
    this.showKontinuitaetCard = true;
  },
  async toggleEreignisseCard() {
    if (this.showEreignisseCard) {
      window.dispatchEvent(new CustomEvent('card:refresh', { detail: { name: 'ereignisse' } }));
      return;
    }
    this._closeOtherMainCards('ereignisse');
    this.showEreignisseCard = true;
    // Figuren werden für den Figur-Filter gebraucht.
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
    const tasks = [];
    if (!this.figuren.length) tasks.push(this.loadFiguren(this.selectedBookId));
    if (!this.orte.length) tasks.push(this.loadOrte(this.selectedBookId));
    if (tasks.length) await Promise.all(tasks);
  },
  toggleFiguresCard() {
    if (this.showFiguresCard) {
      window.dispatchEvent(new CustomEvent('card:refresh', { detail: { name: 'figuren' } }));
      return;
    }
    this._closeOtherMainCards('figures');
    this.showFiguresCard = true;
  },
  toggleBookReviewCard() {
    if (this.showBookReviewCard) {
      window.dispatchEvent(new CustomEvent('card:refresh', { detail: { name: 'bookReview' } }));
      return;
    }
    this._closeOtherMainCards('bookReview');
    this.showBookReviewCard = true;
  },
  // Seiten-Ideen: lebt parallel zum Editor wie Seiten-Chat. Mutually exclusive
  // mit Chat — nur eines kann gleichzeitig aktiv sein (gleicher Slot).
  toggleIdeenCard() {
    if (this.showIdeenCard) { this.showIdeenCard = false; return; }
    if (!this.currentPage) return;
    if (this.showChatCard) {
      this.showChatCard = false;
      if (this._checkDoneBeforeChat && this.lektoratFindings?.length > 0) {
        this.checkDone = true;
        this._checkDoneBeforeChat = false;
      }
    }
    this.showIdeenCard = true;
  },
  // Seiten-Chat: lebt neben dem Editor, schließt NICHT den Editor. Toggle
  // merkt sich checkDone-Snapshot (Chat soll Findings temporär verbergen).
  // checkDoneBeforeChat wird in chat-base beim onVisible gesetzt.
  // Mutually exclusive mit Ideen — gleicher Slot neben Editor.
  toggleChatCard() {
    if (this.showChatCard) {
      this.showChatCard = false;
      if (this._checkDoneBeforeChat && this.lektoratFindings?.length > 0) {
        this.checkDone = true;
        this._checkDoneBeforeChat = false;
      }
      return;
    }
    if (!this.currentPage) return;
    if (this.showIdeenCard) this.showIdeenCard = false;
    this.showChatCard = true;
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
  // Seitenwechsel: Seiten-Chat resetten (Chat ist pro Seite).
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
    this.closeSynonymMenu?.();
    this.closeSynonymPicker?.();
    this.closeFigurLookup?.();
    if (this.focusMode) this.exitFocusMode();
    this._stopAutosave?.();
    this._uninstallOnlineRetry?.();
    this.resetChat();
    this.showChatCard = false;
    this.showIdeenCard = false;
    this._checkDoneBeforeChat = false;
    this.currentPage = null;
    this.currentPageEmpty = false;
    this.currentPageIdeenOpenCount = 0;
    this.currentPageChatSessionCount = 0;
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
    this.appliedHistoricCorrections = [];
    this.checkDone = false;
    this.checkLoading = false;
    this.checkProgress = 0;
    this.checkStatus = '';
  },

  // Setzt allen buchbezogenen State zurück. Wird bei Buchwechsel (Combobox,
  // Hash, programmatisch) aufgerufen, bevor `loadPages()` das neue Buch lädt.
  // Karten bleiben sichtbar — `_reloadVisibleBookCards()` füllt sie danach neu.
  // Sub-Komponenten hören auf das `book:changed`-Event und resetten/laden selbst.
  _resetBookScopedState() {
    window.dispatchEvent(new CustomEvent('book:changed', {
      detail: { bookId: this.selectedBookId },
    }));
    this.figuren = [];
    this.orte = [];
    this.szenen = [];
    this.globalZeitstrahl = [];
    this.bookReviewHistory = [];
    this.newPageTitle = '';
    this.newPageCreating = false;
    this.newPageError = '';
    this.chapterFigures = [];
    this.pageHistory = [];
    this.activeHistoryEntryId = null;
    this.tokEsts = {};
    this.ideenCounts = {};
    this._tokenEstGen++;
    if (typeof this._teardownStatsObserver === 'function') this._teardownStatsObserver();

    this.selectedFigurId = null;
    this.selectedOrtId = null;
    this.selectedSzeneId = null;
    this.lastCheckId = null;

    this.szenenUpdatedAt = null;
    this.orteUpdatedAt = null;

    this.recentPageIds = [];
    if (typeof this.loadRecentPages === 'function' && this.selectedBookId) {
      this.loadRecentPages(this.selectedBookId);
    }

    // Root-gehaltene Pollers stoppen (zielen sonst auf altes Buch).
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
  },

  async _reloadVisibleBookCards() {
    // Sub-Komponenten laden selbst per book:changed-Event.
    // `loadPages()` übernimmt den Rest (figuren + bookReviewHistory).
  },

  // Setzt alles zurück: Seiten-Level (via resetPage) + Buch-Level.
  // Sub-Komponenten hören auf `view:reset` und resetten eigenen State.
  resetView() {
    window.dispatchEvent(new CustomEvent('view:reset'));
    this.resetPage();
    this.clearBookstackSearch();
    // Kapitel in der Sidebar bleiben geöffnet (kein c.open = false)
    this.showTreeCard = true;
    this.showBookOverviewCard = false;
    this.showBookReviewCard = false;
    this.bookReviewHistory = [];
    this.showKapitelReviewCard = false;
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
    this.globalZeitstrahl = [];
    this.showGlobalZeitstrahl = false;
    this.showEreignisseCard = false;
    this.ereignisseFilters.figurId = '';
    this.ereignisseFilters.kapitel = '';
    this.ereignisseFilters.seite = '';
    this.showSzenenCard = false;
    this.szenen = [];
    this.szenenUpdatedAt = null;
    this.selectedSzeneId = null;
    this.szenenFilters.wertung = '';
    this.szenenFilters.figurId = '';
    this.szenenFilters.kapitel = '';
    this.szenenFilters.ortId = '';
    this.showBookStatsCard = false;
    this.showStilCard = false;
    this.showFehlerHeatmapCard = false;
    this.showOrteCard = false;
    this.orte = [];
    this.orteFilters.figurId = '';
    this.orteFilters.kapitel = '';
    this.orteFilters.szeneId = '';
    this.showKontinuitaetCard = false;
    if (this._komplettPollTimer) { clearInterval(this._komplettPollTimer); this._komplettPollTimer = null; }
    this.showBookChatCard = false;
    this.showBookSettingsCard = false;
    this.showUserSettingsCard = false;
    this.showFinetuneExportCard = false;
    this.showExportCard = false;
    this.showPdfExportCard = false;
    this.alleAktualisierenLastRun = null;
    this.alleAktualisierenProgress = 0;
    this.alleAktualisierenTokIn = 0;
    this.alleAktualisierenTokOut = 0;
    this.alleAktualisierenTps = null;
    this.showKomplettStatus = false;
    this.resetBookChat();
    // Default-Home: nach komplettem Reset Übersicht öffnen, falls Buch gewählt.
    this._maybeOpenBookOverview();
  },
};
