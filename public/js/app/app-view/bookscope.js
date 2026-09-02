// Teil von appViewMethods (siehe Facade app-view.js).
import { EVT, EXCLUSIVE_CARDS, FILTER_SCOPES, computeTodayRing, computeWeekBars, computeWritingStreak, fetchJson, fetchJsonRetry, resetFilterScopes, restoreFilterScopes } from './_shared.js';
import { setLastBookId } from '../../local-prefs.js';

// In-Flight-Handle von `loadDailyProgress`. Modul-Scope statt Store: ein
// Promise im reaktiven Alpine-Proxy wird beim `await` mit dem Proxy als `this`
// aufgerufen und wirft. Kurzlebiger Re-Entry-Guard, kein fachlicher State.
let _dailyProgressInflight = { bookId: null, promise: null };

// Drosselung von `_touchBookOpened`. Modul-Scope, weil es kein fachlicher State
// ist, sondern die Erinnerung „das habe ich gerade gemeldet". Pro Buch: ein
// Wechsel zu einem ANDEREN Buch muss immer durch, sonst waere die Reihenfolge
// zweier abwechselnd benutzter Tabs nicht mehr messbar.
const TOUCH_THROTTLE_MS = 60_000;
let _lastTouch = { bookId: null, ts: 0 };

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


  // „Ich habe dieses Buch gerade vor mir." Schreibt den Server-Zeitstempel
  // (`PUT /me/books/:id/opened` → `book_shelf.last_opened_at`) und den lokalen
  // Rückfall-Merker. Aus dem grössten dieser Zeitstempel wählt der nächste Boot
  // sein Startbuch (`pickStartBook` in book/tree/load.js).
  //
  // Aufrufer sind die Momente, in denen „offen gehabt" wahr wird:
  //   • Buchwechsel (Combobox, Job-Sprung) — immer, `force`
  //   • Seite öffnen (selectPage) — das stärkste Arbeits-Signal
  //   • Tab wird sichtbar bzw. Fenster bekommt den Fokus — der Moment, der die
  //     Konkurrenz mehrerer offener Tabs auflöst (zwei Fenster nebeneinander
  //     bleiben beide sichtbar, dort feuert nur `focus`)
  //
  // Beim Boot NUR aus einem sichtbaren Tab: nach einem Deploy laden alle Tabs
  // neu (controllerchange → reload), und ein verstecktes Neuladen darf sein Buch
  // nicht als „zuletzt offen" stempeln — genau daran hing das Zufalls-Verhalten.
  //
  // Best-Effort: kein `await` beim Aufrufer, Fehler werden geschluckt. Offline
  // bleibt der lokale Merker die Antwort, und der nächste sichtbare Boot meldet
  // den Stand nach.
  _touchBookOpened(bookId, { force = false } = {}) {
    const id = String(bookId || '');
    if (!id) return;
    if (this.$store.session.sessionExpired) return;
    const now = Date.now();
    if (!force && _lastTouch.bookId === id && now - _lastTouch.ts < TOUCH_THROTTLE_MS) return;
    _lastTouch = { bookId: id, ts: now };
    setLastBookId(this.$store.session.currentUser?.email, id);
    try {
      fetch(`/me/books/${encodeURIComponent(id)}/opened`, {
        method: 'PUT',
        credentials: 'same-origin',
      }).catch(() => {});
    } catch { /* Best-Effort */ }
  },


  // Welches Buch hatte der User zuletzt vor sich (`book_shelf.last_opened_at`,
  // groesster Zeitstempel gewinnt). Antwort auf die Frage, mit welchem Buch die
  // App beim Aufruf der Stamm-URL startet — `pickStartBook` in
  // book/tree/load.js verarbeitet sie weiter.
  //
  // Eigener, ungecachter Endpunkt: `/content/books` liefert der Service Worker
  // als Stale-While-Revalidate, und aus der alten Kopie gelesen waere der
  // Zeitstempel der Stand des letzten Besuchs — also wieder das falsche Buch.
  //
  // Fehlschlag ist kein Fehler, sondern die Offline-Lage: dann entscheidet der
  // lokale Rueckfall-Merker.
  async _serverLastOpenedBookId() {
    try {
      const r = await fetchJson('/me/books/last-opened');
      return r?.book_id ? String(r.book_id) : '';
    } catch { return ''; }
  },


  // Setzt jeden Filter-Scope zuerst auf Defaults zurück, dann überlagert
  // gespeicherte Werte aus localStorage. Wird bei Buchwechsel und beim
  // initialen Bootstrap aufgerufen.
  _restoreBookPrefs(bookId) {
    restoreFilterScopes(this.$store.catalogUi, FILTER_SCOPES, this.$store.session.currentUser?.email, bookId);
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
      // `__fresh=1` ist Pflicht: aus dem SW-Cache beantwortet, kaeme hier eine
      // gecachte 200 an und der 401-Check dieser Zeile koennte nie ausloesen.
      try { await fetch('/config?__fresh=1', { credentials: 'same-origin' }); }
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
    resetFilterScopes(this.$store.catalogUi, FILTER_SCOPES);
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


  // Geteilter Loader fuer `/history/book-stats/:id` + `/booksettings/:id`.
  // Zwei Oberflaechen brauchen genau diese zwei Antworten: der Header-Donut
  // (deshalb ein eigener Loader statt Book-Overview-Card-State zu spiegeln —
  // der Donut muss auch ohne je geoeffnete Uebersicht stehen) und die
  // Buch-Uebersicht. Sie holen sie nicht mehr getrennt: das waren vier
  // Requests pro Buchwechsel und zwei Kopien derselben Zeitreihe, von denen
  // der Auto-Sync der Uebersicht nur eine auffrischte.
  //
  // `reuse: true` gibt einen bereits geladenen Stand desselben Buchs zurueck,
  // ohne neu zu holen — dafuer ruft die Uebersicht beim Oeffnen. Ein
  // ausdruecklicher Refresh (Knopf, Re-Klick auf die Karte) laesst es weg und
  // holt frisch. Laeuft schon ein Load fuers selbe Buch, haengen sich beide
  // Aufrufer an DESSEN Promise (der Boolean-Guard allein liess den zweiten
  // Aufrufer auf leeren State laufen).
  //
  // Rueckgabe: { stats, settings, failed } — `failed` traegt die Schluessel der
  // Endpoints, die auch nach dem Retry nicht kamen. Der Header ignoriert das
  // (kein Donut ist dort die richtige Antwort), die Uebersicht zeigt daraus
  // ihren Hinweis, damit eine leere Kachel nicht als „keine Daten" gilt.
  async loadDailyProgress(bookId, { reuse = false } = {}) {
    if (!bookId) return null;
    const progress = this.$store.progress;
    if (_dailyProgressInflight.bookId === bookId && _dailyProgressInflight.promise) {
      return _dailyProgressInflight.promise;
    }
    // `dailyProgressSettings` ist zugleich das Gueltigkeits-Flag: das
    // Einstellungs-Formular setzt es beim Speichern auf null, damit der
    // naechste reuse-Leser den geaenderten Buchtyp/das neue Ziel sieht.
    if (reuse && progress.dailyProgressBookId === bookId && progress.dailyProgressSettings) {
      return {
        stats: progress.dailyProgressStats,
        settings: progress.dailyProgressSettings,
        failed: [...progress.dailyProgressFailed],
      };
    }
    const run = (async () => {
      const failed = [];
      const guard = (key, fallback) => (e) => {
        failed.push(key);
        console.warn(`[dailyProgress] ${key} fehlgeschlagen`, e);
        return fallback;
      };
      const [stats, settings] = await Promise.all([
        fetchJsonRetry(`/history/book-stats/${bookId}`, undefined, 'dailyProgress').catch(guard('stats', [])),
        fetchJsonRetry(`/booksettings/${bookId}`, undefined, 'dailyProgress').catch(guard('settings', null)),
      ]);
      const result = { stats: Array.isArray(stats) ? stats : [], settings: settings || null, failed };
      // Stale-Gate: Buch waehrend des Loads gewechselt → Store nicht anfassen.
      // Das Ergebnis geht trotzdem an den Aufrufer zurueck; dessen eigener
      // Buch-Guard entscheidet, ob er es noch braucht.
      if (this.$store.nav.selectedBookId == bookId) {
        progress.dailyProgressStats = result.stats;
        progress.dailyProgressSettings = result.settings;
        progress.dailyProgressIsFinished = !!settings?.is_finished;
        progress.dailyProgressDailyGoalChars = settings?.daily_goal_chars != null ? Number(settings.daily_goal_chars) : null;
        progress.dailyProgressFailed = failed;
        progress.dailyProgressBookId = bookId;
      }
      return result;
    })();
    // In-Flight-Handle bewusst im Modul-Scope, nicht im Store: ein Promise im
    // reaktiven Alpine-Proxy wird beim `await` mit dem Proxy als `this`
    // aufgerufen und wirft.
    _dailyProgressInflight = { bookId, promise: run };
    try { return await run; }
    finally {
      if (_dailyProgressInflight.bookId === bookId) _dailyProgressInflight = { bookId: null, promise: null };
    }
  },

  // Frisch gesyncte Zeitreihe in den geteilten Store nachziehen. Ruft die
  // Buch-Uebersicht nach ihrem Hintergrund-Sync — ohne das zeigte der
  // Header-Donut weiter den Stand von vor dem Sync.
  publishDailyProgressStats(bookId, stats) {
    const progress = this.$store.progress;
    if (!Array.isArray(stats)) return;
    if (progress.dailyProgressBookId !== bookId) return;
    progress.dailyProgressStats = stats;
  },

  // Geteilten `/booksettings`-Rohstand verwerfen. Jeder Schreibpfad auf
  // `/booksettings/:id*` ruft das — sonst servierte der naechste `reuse`-Leser
  // (Buch-Uebersicht, Editor-Flags) die eben geaenderten Werte von vorher.
  // Nur den Rohstand, nicht den ganzen Store: der Snapshot-Verlauf des Donuts
  // aendert sich durch eine Einstellung nicht.
  invalidateBookSettingsCache() {
    this.$store.progress.dailyProgressSettings = null;
  },

  resetDailyProgress() {
    const progress = this.$store.progress;
    progress.dailyProgressStats = [];
    progress.dailyProgressSettings = null;
    progress.dailyProgressIsFinished = false;
    progress.dailyProgressDailyGoalChars = null;
    progress.dailyProgressFailed = [];
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
