// Teil von appViewMethods (siehe Facade app-view.js).
import { EVT, EXCLUSIVE_CARDS, FILTER_SCOPES, computeTodayRing, computeWeekBars, computeWritingStreak, fetchJson, getFilters } from './_shared.js';

export const bookscopeMethods = {

  // Setzt allen buchbezogenen State zurück. Wird bei Buchwechsel (Combobox,
  // Hash, programmatisch) aufgerufen, bevor `loadPages()` das neue Buch lädt.
  // Karten bleiben sichtbar — `_reloadVisibleBookCards()` füllt sie danach neu.
  // Sub-Komponenten hören auf das `book:changed`-Event und resetten/laden selbst.
  _resetBookScopedState() {
    // Buchwechsel: laufenden bookTree/Stats-/Sub-Load des vorigen Buches
    // sofort abbrechen — bei sehr grossen Büchern hängt der bookTree-Request
    // sonst bis zum 30s-Timeout am Netz und blockiert Browser-Slots, während
    // das neue Buch parallel lädt.
    this._bookLoadAbort?.abort(new DOMException('book switch', 'AbortError'));
    this._bookLoadAbort = null;
    window.dispatchEvent(new CustomEvent(EVT.BOOK_CHANGED, {
      detail: { bookId: this.$store.nav.selectedBookId },
    }));
    this._stopCollabPoll?.();
    this.$store.catalog.figuren = [];
    this.$store.catalog.orte = [];
    this.$store.catalog.songs = [];
    this.$store.catalog.szenen = [];
    this.$store.catalog.globalZeitstrahl = [];
    this.$store.catalog.zeitstrahlChronology = null;
    this.$store.catalog.zeitstrahlServerLoaded = false;
    this.$store.nav.werkstattDrafts = [];
    this.$store.nav.werkstattDraftId = null;
    this.bookReviewHistory = [];
    this.newPageTitle = '';
    this.newPageCreating = false;
    this.newPageError = '';
    this.chapterFigures = [];
    this.entitiesEnabledForCurrentBook = false;
    this.pageHistory = [];
    this.activeHistoryEntryId = null;
    this.tokEsts = {};
    const badges = this.$store.badges;
    badges.ideenCounts = {};
    badges.chapterIdeenCounts = {};
    badges.rechercheCounts = {};
    badges.chapterRechercheCounts = {};
    badges.plotBeatCounts = {};
    badges.chapterPlotBeatCounts = {};
    badges.shareCommentCounts = {};
    badges.shareLinkCounts = {};
    this.currentPageRechercheCount = 0;
    this.currentPagePlotBeatCount = 0;
    this.currentPageShareCommentCount = 0;
    this.currentPageShareLinkCount = 0;
    this.currentChapterIdeenOpenCount = 0;
    // Chapter-Ideen-Scope verwerfen beim Buchwechsel.
    if (this.ideenScope === 'chapter') {
      this.showIdeenCard = false;
      this.ideenChapterId = null;
      this.ideenScope = 'page';
    }
    this._tokenEstGen++;
    if (typeof this._teardownStatsObserver === 'function') this._teardownStatsObserver();

    this.$store.catalogUi.selectedFigurId = null;
    this.$store.catalogUi.selectedOrtId = null;
    this.$store.catalogUi.selectedSongId = null;
    this.$store.catalogUi.selectedSzeneId = null;
    this.$store.catalogUi.selectedEreignisId = null;
    this.lastCheckId = null;

    this.$store.catalogUi.szenenUpdatedAt = null;
    this.$store.catalogUi.orteUpdatedAt = null;
    this.$store.catalogUi.songsUpdatedAt = null;

    this.recentPageIds = [];
    if (typeof this.loadRecentPages === 'function' && this.$store.nav.selectedBookId) {
      this.loadRecentPages(this.$store.nav.selectedBookId);
    }
    this._restoreBookPrefs(this.$store.nav.selectedBookId);

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
    this.$store.jobs.alleAktualisierenLoading = false;
    this.$store.jobs.alleAktualisierenStatus = '';
    this.$store.jobs.alleAktualisierenProgress = 0;
    this.$store.jobs.alleAktualisierenTokIn = 0;
    this.$store.jobs.alleAktualisierenTokOut = 0;
    this.$store.jobs.alleAktualisierenTps = null;
    // Run-transiente Felder (Warnungen/Coverage/PassMode/Last-Run) gehören zum
    // alten Buch — sonst zeigt das Status-Panel des neuen Buchs dessen Werte.
    // Last-Run lädt loadPages()→loadLastKomplettRun() gleich für das neue Buch.
    this.$store.jobs.alleAktualisierenWarnings = [];
    this.$store.jobs.alleAktualisierenCoverage = null;
    this.$store.jobs.alleAktualisierenCost = null;
    this.$store.jobs.alleAktualisierenPassMode = null;
    this.$store.jobs.alleAktualisierenLastRun = null;
    this.showKomplettStatus = false;
    this.resetDailyProgress();
    if (this.$store.nav.selectedBookId) this.loadDailyProgress(this.$store.nav.selectedBookId);
  },


  // Setzt jeden Filter-Scope zuerst auf Defaults zurück, dann überlagert
  // gespeicherte Werte aus localStorage. Wird bei Buchwechsel und beim
  // initialen Bootstrap aufgerufen.
  _restoreBookPrefs(bookId) {
    const email = this.$store.session.currentUser?.email;
    for (const [stateKey, defaults] of FILTER_SCOPES) {
      const target = this.$store.catalogUi[stateKey];
      if (!target) continue;
      const saved = bookId ? getFilters(email, bookId, stateKey) : null;
      for (const k of Object.keys(defaults)) {
        target[k] = (saved && Object.prototype.hasOwnProperty.call(saved, k))
          ? saved[k]
          : defaults[k];
      }
    }
  },


  async _reloadVisibleBookCards() {
    // Sub-Komponenten laden selbst per book:changed-Event.
    // `loadPages()` übernimmt den Rest (figuren + bookReviewHistory).
  },


  // Nach Sleep/Wake: in-flight Fetches sind tot, Listen können leer hängen
  // (Tab überlebt im Memory, aber TCP-Sockets sind weg). `/config` triggert
  // 401-Check über globalen Wrapper; Editor-Sessions bleiben unberührt.
  // Bei Netzfehler (DNS noch nicht zurück, TCP timeout) wird via `online`-Event
  // + setTimeout-Backoff ein Retry geplant — sonst bleibt Tree stale, wenn der
  // POST direkt vor dem Disconnect schon serverseitig committed war.
  async _refreshAfterWake() {
    if (this._wakeRefreshInflight) return;
    this._wakeRefreshInflight = true;
    let needsRetry = false;
    const isNetErr = (e) => e && (e.name === 'TypeError' || /Failed to fetch|NetworkError|ERR_/.test(String(e?.message || e)));
    try {
      try { await fetch('/config', { credentials: 'same-origin' }); }
      catch (e) { if (isNetErr(e)) needsRetry = true; }
      if (this.$store.session.sessionExpired) return;
      if (this.isAdminOnly) return;
      if (this.editMode || this.editDirty) return;
      try {
        if (!this.$store.nav.selectedBookId) {
          await this.loadBooks();
        } else {
          await this.loadBooks({ source: 'wake' });
          await this.loadPages({ source: 'wake' });
        }
      } catch (e) {
        if (isNetErr(e)) needsRetry = true;
      }
      if (!needsRetry) {
        for (const c of EXCLUSIVE_CARDS) {
          if (this[c.flag]) {
            window.dispatchEvent(new CustomEvent(EVT.CARD_REFRESH, { detail: { name: c.key } }));
          }
        }
      }
    } finally {
      this._wakeRefreshInflight = false;
    }
    if (needsRetry) this._scheduleWakeRetry();
  },


  _scheduleWakeRetry() {
    if (this._wakeRetryArmed) return;
    this._wakeRetryArmed = true;
    const fire = () => {
      if (!this._wakeRetryArmed) return;
      this._wakeRetryArmed = false;
      window.removeEventListener('online', fire);
      if (this._wakeRetryTimer) { clearTimeout(this._wakeRetryTimer); this._wakeRetryTimer = null; }
      this._refreshAfterWake();
    };
    window.addEventListener('online', fire, { once: true });
    this._wakeRetryTimer = setTimeout(fire, 8000);
  },


  // Setzt alles zurück: Seiten-Level (via resetPage) + Buch-Level.
  // Sub-Komponenten hören auf `view:reset` und resetten eigenen State.
  async resetView() {
    window.dispatchEvent(new CustomEvent(EVT.VIEW_RESET));
    this.resetPage();
    // Kapitel in der Sidebar bleiben geöffnet (kein c.open = false)
    this.showTreeCard = true;
    // Alle Hauptkarten schliessen (Single-Source aus feature-registry).
    for (const c of EXCLUSIVE_CARDS) this[c.flag] = false;
    this.bookReviewHistory = [];
    if (this._batchPollTimer) { clearInterval(this._batchPollTimer); this._batchPollTimer = null; }
    this.batchLoading = false;
    this.batchProgress = 0;
    this.batchStatus = '';
    this.$store.catalogUi.figurenStatus = '';
    this.$store.catalogUi.figurenProgress = 0;
    this.$store.catalogUi.selectedFigurId = null;
    this.$store.catalog.globalZeitstrahl = [];
    this.$store.catalog.zeitstrahlChronology = null;
    this.$store.catalog.zeitstrahlServerLoaded = false;
    this.$store.catalogUi.selectedEreignisId = null;
    this.showGlobalZeitstrahl = false;
    this.$store.catalog.szenen = [];
    this.$store.catalogUi.szenenUpdatedAt = null;
    this.$store.catalogUi.selectedSzeneId = null;
    this.$store.catalog.orte = [];
    this.$store.catalog.songs = [];
    this.$store.catalogUi.selectedSongId = null;
    // Filter-Reset einheitlich über FILTER_SCOPES — deckt auch `suche`-Keys
    // ab, die früher nur teilweise gesetzt wurden (drift-freie SSoT).
    for (const [stateKey, defaults] of FILTER_SCOPES) {
      const target = this.$store.catalogUi[stateKey];
      if (!target) continue;
      for (const k of Object.keys(defaults)) target[k] = defaults[k];
    }
    // Einen aktiv laufenden Komplett-Job NICHT abwürgen: Poller + Live-Progress
    // stehen lassen, sonst friert der Fortschrittsring bei 0 % ein und das
    // Job-Ende wird oben rechts nie sichtbar (nur der globale Queue-Poll bliebe
    // aktuell). Nur den Ruhezustand zurücksetzen.
    if (!this.$store.jobs.alleAktualisierenLoading) {
      if (this._komplettPollTimer) { clearInterval(this._komplettPollTimer); this._komplettPollTimer = null; }
      // Last-Run-Stempel gehört zum Buch, nicht zur View — Buch bleibt bei
      // Home-Klick gewählt, also für das aktuelle Buch neu laden statt nullen.
      if (this.$store.nav.selectedBookId && typeof this.loadLastKomplettRun === 'function') this.loadLastKomplettRun(this.$store.nav.selectedBookId);
      else this.$store.jobs.alleAktualisierenLastRun = null;
      this.$store.jobs.alleAktualisierenProgress = 0;
      this.$store.jobs.alleAktualisierenTokIn = 0;
      this.$store.jobs.alleAktualisierenTokOut = 0;
      this.$store.jobs.alleAktualisierenTps = null;
      this.showKomplettStatus = false;
    }
    this.resetBookChat();
    // Default-Home: nach komplettem Reset Übersicht öffnen, falls Buch gewählt.
    // Kein lastPage-Restore — Home-Klick ist expliziter Wunsch nach Overview.
    await this._maybeOpenBookOverview({ restoreLastPage: false });
  },


  // Tages-Schreibziel-Donut im Header. Eigener Loader (statt Book-Overview-
  // Card-State zu spiegeln), damit der Donut auch sichtbar ist, wenn die
  // Overview-Karte nie geoeffnet wurde. Faecht stats + booksettings parallel —
  // is_finished gated die Sichtbarkeit (kein Donut auf abgeschlossenen Buechern,
  // analog zur Book-Overview-Karte). Dedupe via _dailyProgressLoadingBookId;
  // stale Responses (Buch waehrend des Loads gewechselt) werden verworfen.
  async loadDailyProgress(bookId) {
    if (!bookId) return;
    const progress = this.$store.progress;
    if (progress._dailyProgressLoadingBookId === bookId) return;
    progress._dailyProgressLoadingBookId = bookId;
    try {
      const [stats, settings] = await Promise.all([
        fetchJson(`/history/book-stats/${bookId}`).catch(() => []),
        fetchJson(`/booksettings/${bookId}`).catch(() => null),
      ]);
      if (this.$store.nav.selectedBookId != bookId) return;
      progress.dailyProgressStats = Array.isArray(stats) ? stats : [];
      progress.dailyProgressIsFinished = !!settings?.is_finished;
      progress.dailyProgressDailyGoalChars = settings?.daily_goal_chars != null ? Number(settings.daily_goal_chars) : null;
      progress.dailyProgressBookId = bookId;
    } finally {
      if (progress._dailyProgressLoadingBookId === bookId) progress._dailyProgressLoadingBookId = null;
    }
  },


  resetDailyProgress() {
    const progress = this.$store.progress;
    progress.dailyProgressStats = [];
    progress.dailyProgressIsFinished = false;
    progress.dailyProgressDailyGoalChars = null;
    progress.dailyProgressBookId = null;
  },


  // Header-Today-Ring: kleiner Donut (r=14). Shared Math mit Overview-Tile in
  // [public/js/today-ring.js] — beide Donuts driften nie auseinander.
  headerTodayRing() {
    const progress = this.$store.progress;
    return computeTodayRing({
      stats: progress.dailyProgressStats,
      tokEsts: this.tokEsts,
      goalChars: progress.dailyProgressDailyGoalChars || 1500,
      r: 14,
    });
  },

  // Mini-Popover des Header-Rings: 7-Tage-Balken (Live-Delta für heute) +
  // aktuelle Schreib-Serie. Gleiche Datenquelle wie der Donut → kein Drift.
  headerWeekBars() {
    const progress = this.$store.progress;
    return computeWeekBars({
      stats: progress.dailyProgressStats,
      tokEsts: this.tokEsts,
      goalChars: progress.dailyProgressDailyGoalChars || 1500,
    });
  },

  headerStreak() {
    const progress = this.$store.progress;
    return computeWritingStreak({
      stats: progress.dailyProgressStats,
      tokEsts: this.tokEsts,
    });
  },

  // Grösserer Fokus-Donut fürs Ring-Popover (r=26, viewBox 60×60) — gleiche
  // Math wie der Header-Ring, nur mehr Fläche für die %-Zahl in der Mitte.
  headerRingDetail() {
    const progress = this.$store.progress;
    return computeTodayRing({
      stats: progress.dailyProgressStats,
      tokEsts: this.tokEsts,
      goalChars: progress.dailyProgressDailyGoalChars || 1500,
      r: 26,
    });
  },

  // Narrow-Wochentag (M/D/M…) für die Balken-Beschriftung. UTC-Mittag-Anker +
  // timeZone:'UTC' → der Wochentag folgt exakt dem Kalendertag der iso, ohne
  // dass die Browser-Zeitzone ihn um einen Tag verschiebt.
  headerWeekBarLabel(iso) {
    const locale = this.$store.shell.uiLocale === 'de' ? 'de-CH' : 'en-US';
    try {
      return new Date(iso + 'T12:00:00Z').toLocaleDateString(locale, { weekday: 'narrow', timeZone: 'UTC' });
    } catch { return ''; }
  },
};
