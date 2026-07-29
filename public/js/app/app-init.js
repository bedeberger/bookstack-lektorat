// Root-Lifecycle der `lektorat`-Komponente: init() (Bootstrap-Sequenz) +
// destroy() (Teardown). Als Methoden-Modul in die Root gespreadet (app.js);
// `this` ist zur Laufzeit die fertige Root-Komponente, daher greifen alle
// gespreadeten Methoden/Getter/State-Felder ganz normal.
import { fetchJson, configureTokenEstimate, configureAppTimezone } from '../utils.js';
import { configurePrompts } from '../prompts.js';
import { setFilters } from '../local-prefs.js';
import { configureI18n, getSupportedLocales } from '../i18n.js';
import { setupSpellcheckDispatch } from '../cards/editor-spellcheck/dispatch.js';
import { FILTER_SCOPES } from './app-view.js';
import { EVT } from '../events.js';

export const appInitMethods = {
  // AbortController `_abortCtrl` (initialisiert via app-state.js) hält alle
  // globalen Listener dieser Komponente. `destroy()` (Alpine-Hook) ruft abort()
  // → alle Listener werden automatisch entfernt. Schützt vor doppelter
  // Registrierung bei Re-Init.
  destroy() {
    this._abortCtrl?.abort();
    if (this.$store.jobs._jobQueueTimer) clearInterval(this.$store.jobs._jobQueueTimer);
    if (this._statusTimer) clearTimeout(this._statusTimer);
    if (typeof this._teardownStatsObserver === 'function') this._teardownStatsObserver();
  },

  // ── Initialisierung ──────────────────────────────────────────────────────
  async init() {
    // Referenz für $app-Magic (siehe register-cards.js).
    window.__app = this;
    // Boot erfolgreich → Watchdog-Flag (failsafe-reveal.js) zurücksetzen,
    // damit ein künftiger echter Boot-Fehler wieder einmalig reloaden darf
    // und späte Lazy-Load-Fehler keinen Reload mehr auslösen.
    try { sessionStorage.removeItem('bootReloadDone'); } catch (_) {}
    this._abortCtrl?.abort();
    this._abortCtrl = new AbortController();
    const signal = this._abortCtrl.signal;
    // Tracking-Watcher früh registrieren, damit auch Karten-Öffnungen
    // während der initialen Hash-Anwendung erfasst werden.
    this.setupFeatureUsageWatchers();
    setupSpellcheckDispatch(this);
    // Plattform-Detect für Tasten-Hints (⌘ vs. Ctrl).
    const ua = navigator.userAgent || '';
    const plat = navigator.platform || '';
    this.$store.shell.isMac = /Mac|iPhone|iPad|iPod/.test(plat) || /Mac OS X/.test(ua);
    this.$store.shell.themePref = window.__themePref || 'auto';
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (this.$store.shell.themePref === 'auto') this._applyTheme();
    }, { signal });
    window.addEventListener(EVT.SESSION_EXPIRED, () => { this.$store.session.sessionExpired = true; }, { signal });
    // Browser-Offline-Zustand an den Session-Store koppeln → speist den
    // Offline-Banner (index.html, gegated gegen sessionExpired/serverOffline).
    // Rein informativ: navigator.onLine liefert zwar False-Positives (VPN-/
    // Interface-Flap), gated aber keinen Save-Pfad — der `online`-Event holt
    // den Banner zuverlaessig zurueck. Initialwert sofort setzen, damit ein
    // Boot ohne Netz den Banner nicht erst beim naechsten Toggle zeigt.
    this.$store.session.isOffline = (navigator.onLine === false);
    window.addEventListener('offline', () => { this.$store.session.isOffline = true; }, { signal });
    window.addEventListener('online', () => { this.$store.session.isOffline = false; }, { signal });
    // Reconnect-Outbox: flusht ALLE offline gesicherten Notebook-Drafts (nicht
    // nur die offene Seite) beim Wiederverbinden + speist den Pending-Zähler.
    this._installOutbox(signal);
    window.addEventListener(EVT.JOB_FINISHED, (e) => this._onJobFinished(e.detail), { signal });
    this._initSttDictation?.(signal);
    this._initTtsProof?.(signal);
    // Sleep/Wake-Recovery: bei längerer Hide-Phase (>30 s) Daten neu laden,
    // sonst bleiben Listen leer (in-flight Fetches sterben mit TCP-Socket).
    let _hiddenAt = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') { _hiddenAt = Date.now(); return; }
      if (!_hiddenAt) return;
      const delta = Date.now() - _hiddenAt;
      _hiddenAt = 0;
      if (delta < 30_000) return;
      this._refreshAfterWake();
    }, { signal });
    window.addEventListener('beforeunload', (e) => {
      if (this.editMode && this.editDirty) { e.preventDefault(); e.returnValue = ''; }
      // Best-Effort: eigenen Soft-Lock + Presence-Eintrag freigeben, damit
      // andere User nicht 30 Min auf einen verwaisten „X editiert"-Hinweis
      // schauen. fetch + keepalive:true ueberlebt den Unload.
      if (this.editMode && this.currentPage?.id) {
        this._beaconReleaseEditLock?.(this.currentPage.id);
        this._sendPresenceLeave?.(this.currentPage.id);
      }
      // Buch-Level-Geraete-Ping freigeben, damit das eigene Zweit-Geraet nicht
      // 90s lang einen verwaisten „auch hier offen"-Hinweis sieht.
      const bdpb = this.$store.collab._bookDevicePingBookId;
      if (bdpb) this._sendBookDeviceLeave?.(bdpb);
    }, { signal });
    // Kapitel-Stats werden bei jeder tokEsts-Reassignment neu berechnet.
    // Mutationen via Index-Assign (this.tokEsts[id] = …) feuern den Watcher
    // nicht — solche Pfade müssen _refreshChapterStats() selbst aufrufen.
    // Kein $watch('tree') — refresh mutiert item.stats und würde sich rekursiv
    // selbst triggern (Alpine-Deep-Reactivity → Browser-Freeze).
    this.$watch('tokEsts', () => this._refreshChapterStats());
    // Seitenwechsel → page-scoped Presence neu melden (welche Seite dieses
    // Geraet jetzt offen hat). Steuert, ob der teure Collab-Poll laeuft.
    this.$watch(() => this.currentPage?.id, () => this._pingDevicePresenceNow?.());
    // Sidebar-Suche: bei jedem (debounced) pageSearch-Write Index auf
    // ersten Treffer und kbd-aktive Page-ID neu setzen.
    this.$watch('pageSearch', () => {
      this.pageSearchActiveIndex = 0;
      this._recomputePageSearchActiveId();
    });
    // Shell zuerst aufbauen: i18n + Partials brauchen nur statische Assets
    // (Service Worker cacht sie). /config kann danach scheitern, ohne dass
    // das UI leer bleibt – Offline-Banner erscheint stattdessen.
    //
    // Reveal-Gate: `html[data-app-loading]` versteckt Body bis kompletter
    // Boot durch. Attribut wird ausschliesslich im finally entfernt — egal
    // ob i18n scheitert, /config offline ist oder Bootstrap durchläuft.
    // Ergebnis: ein einziger Reveal-Frame, kein Pop-In zwischen
    // i18n-Ready → currentUser-Ready → Books-Ready.
    const browserLoc = (navigator.language || 'de').slice(0, 2);
    const supported  = getSupportedLocales();
    const fallbackLocale = supported.includes(browserLoc) ? browserLoc : 'de';
    try {
    try {
      await configureI18n(fallbackLocale);
      this.$store.shell.uiLocale = fallbackLocale;
      this.contentLocale = fallbackLocale;
      document.documentElement.setAttribute('lang', fallbackLocale);
      await this._loadEssentialPartials();
      this._initSidebarResize();
      this._initSidebarScrollFade();
    } catch (e) {
      console.error('[init:shell]', e);
    }

    let cfg = null;
    try {
      cfg = await fetchJson('/config');
    } catch (e) {
      console.error('[init:config]', e);
      this.$store.session.serverOffline = true;
      return;
    }

    try {
      const preferred = cfg.userSettings?.locale || browserLoc || 'de';
      const locale = supported.includes(preferred) ? preferred : 'de';
      const region = cfg.userSettings?.default_region || (locale === 'en' ? 'US' : 'CH');
      this.$store.shell.defaultRegion = region;
      if (locale !== this.$store.shell.uiLocale) {
        await configureI18n(locale);
        this.$store.shell.uiLocale = locale;
      }
      this.contentLocale = locale;
      document.documentElement.setAttribute('lang', `${locale}-${region}`);
      if (cfg.claudeModel) this.$store.config.claudeModel = cfg.claudeModel;
      if (cfg.claudeMaxTokens) this.$store.config.claudeMaxTokens = cfg.claudeMaxTokens;
      if (cfg.apiProvider) this.$store.config.apiProvider = cfg.apiProvider;
      if (cfg.effectiveProvider) this.$store.config.effectiveProvider = cfg.effectiveProvider;
      if (cfg.ollamaModel) this.$store.config.ollamaModel = cfg.ollamaModel;
      if (cfg.openaiCompatModel) this.$store.config.openaiCompatModel = cfg.openaiCompatModel;
      this.$store.session.currentUser = cfg.user || null;
      // First-Login-Willkommens-Banner („Erste Schritte"): non-blocking laden,
      // sobald ein User da ist. Serverseitig gemerkt (welcomeDismissed).
      if (cfg.user) this._loadOnboardingWelcome?.();
      this.$store.session.devMode = !!cfg.devMode;
      this.$store.shell.promptConfig = cfg.promptConfig || {};
      if (cfg.userSettings?.theme && cfg.userSettings.theme !== this.$store.shell.themePref) {
        this.$store.shell.themePref = cfg.userSettings.theme;
        try { localStorage.setItem('theme', this.$store.shell.themePref); } catch (e) {}
        this._applyTheme();
      }
      const fg = cfg.userSettings?.focus_granularity;
      if (fg === 'paragraph' || fg === 'sentence' || fg === 'window-3' || fg === 'typewriter-only') {
        this.focusGranularity = fg;
      }
      configurePrompts(cfg.promptConfig, cfg.apiProvider || 'claude');
      configureTokenEstimate(cfg.charsPerToken);
      configureAppTimezone(cfg.appTimezone);
      if (cfg.appTimezone) this.$store.shell.appTimezone = cfg.appTimezone;
      if (cfg.appName) {
        this.$store.shell.appName = cfg.appName;
        document.title = cfg.appName;
        const meta = document.querySelector('meta[name="apple-mobile-web-app-title"]');
        if (meta) meta.setAttribute('content', cfg.appName);
      }
      if (cfg.appVersion) this.$store.shell.appVersion = cfg.appVersion;
      // Build-Guard: window.__SHELL_BUILD ist der Build, mit dem DIESE Shell
      // ausgeliefert wurde (aus dem gecachten /sw-manifest.js); cfg.shellBuild
      // ist der aktuelle Server-Build. Weichen sie ab, ist eine neue Generation
      // deployt, während die SPA-Shell noch die alte ist (SWR liefert sie
      // 0-Latenz) → in eine kohärente Generation reloaden, statt auf den
      // 60-s-Update-Timer zu warten. Greift nur online + ausserhalb Editier-/
      // Fokusmodus (requestCoherentReload entscheidet).
      if (cfg.shellBuild && window.__SHELL_BUILD && cfg.shellBuild !== window.__SHELL_BUILD) {
        window.__requestCoherentReload?.();
      } else if (cfg.shellBuild && window.__SHELL_BUILD) {
        // Generation stimmt → Loop-Breaker-Zähler des Update-Banners zurücksetzen.
        try { sessionStorage.removeItem('sw-update-attempts'); } catch {}
      }
      this.$store.config.languagetoolEnabled = !!cfg.languagetool?.enabled;
      if (Number.isFinite(cfg.languagetool?.debounceMs)) {
        this.$store.config.languagetoolDebounceMs = cfg.languagetool.debounceMs;
      }
      this.$store.stt.enabled = !!cfg.stt?.enabled;
      if (cfg.stt?.vad) {
        this.$store.stt.vad = {
          silenceMs:   Number(cfg.stt.vad.silenceMs)   || this.$store.stt.vad.silenceMs,
          threshold:   Number(cfg.stt.vad.threshold)   || this.$store.stt.vad.threshold,
          maxSegmentS: Number(cfg.stt.vad.maxSegmentS) || this.$store.stt.vad.maxSegmentS,
        };
      }
      this.$store.tts.enabled = !!cfg.tts?.enabled;
      this.$store.config.researchChatEnabled = !!cfg.researchChat?.enabled;
      this.$store.config.semanticSearchEnabled = !!cfg.semanticSearch?.enabled;
      this.$store.config.semanticHybrid = !!cfg.semanticSearch?.hybrid;
      this.$store.config.semanticRerank = !!cfg.semanticSearch?.rerank;
      if (cfg.redundancy) {
        const d = this.$store.config.redundancyThresholds;
        this.$store.config.redundancyThresholds = {
          strict: Number(cfg.redundancy.thresholdStrict) || d.strict,
          medium: Number(cfg.redundancy.thresholdMedium) || d.medium,
          loose:  Number(cfg.redundancy.thresholdLoose)  || d.loose,
        };
      }
      this.$store.config.factcheckEnabled = !!cfg.komplett?.factcheck;
      if (cfg.tts?.pause) {
        const frag = Number(cfg.tts.pause.fragmentMs);
        const para = Number(cfg.tts.pause.paragraphMs);
        this.$store.tts.pause = {
          fragmentMs:  Number.isFinite(frag) ? frag : this.$store.tts.pause.fragmentMs,
          paragraphMs: Number.isFinite(para) ? para : this.$store.tts.pause.paragraphMs,
        };
      }
      if (cfg.mapTiles?.url) {
        this.$store.config.mapTiles = {
          url: cfg.mapTiles.url,
          attribution: cfg.mapTiles.attribution || '',
        };
      }

      // Hash vorab auswerten, damit loadBooks das gewünschte Buch wählt.
      // _applyingHash unterdrückt Watcher/URL-Writes während der Initialisierung.
      this._applyingHash = true;
      const hashParts = (location.hash || '').replace(/^#/, '').split('/').filter(Boolean);
      if (hashParts[0] === 'book' && hashParts[1]) {
        this.$store.nav.selectedBookId = hashParts[1];
      }
      // Admin-only-View überspringt Buch-Bootstrap: keine Sidebar, keine
      // Buchwahl, Landing sind die Admin-Tiles (admin-home-Partial).
      if (this.isAdminOnly) {
        await this._ensurePartial('admin-home');
      } else {
        await this.loadBooks();
        // Top-3 Recency-Features für Quick-Pills laden (best-effort).
        this.loadRecentFeatures();
        if (this.$store.nav.selectedBookId) this.loadRecentPages(this.$store.nav.selectedBookId);
        if (this.$store.nav.selectedBookId) this.loadDailyProgress(this.$store.nav.selectedBookId);
        // Gespeicherte Filter pro Buch anwenden, bevor Hash-Router das
        // initiale View setzt (Filter-Restore + Hash-getriebene Argumente
        // koexistieren so deterministisch).
        if (this.$store.nav.selectedBookId) this._restoreBookPrefs(this.$store.nav.selectedBookId);
      }
      await this._applyHash();
      if (!this.isAdminOnly && this.$store.nav.selectedBookId) this._loadBookRole(this.$store.nav.selectedBookId);
      if (!this.isAdminOnly && this.$store.nav.selectedBookId) this._loadBookFlagsForCurrentBook(this.$store.nav.selectedBookId);
      if (!this.isAdminOnly) await this._maybeOpenBookOverview();
      this._syncUrlNow();
      this._applyingHash = false;
      if (this.$store.nav.selectedBookId) {
        try {
          localStorage.setItem(`sw:lastBookId:${this.$store.session.currentUser?.email || ''}`, String(this.$store.nav.selectedBookId));
        } catch (_) {}
      }
      this._setupHashRouting();
      // Buchwechsel (Combobox, Hash-Nav oder programmatisch) → Seiten/Tree neu laden.
      // _applyingHash unterdrückt Doppelladen während Hash-Anwendung.
      // _resetBookScopedState() räumt buchspezifische Daten/Caches ab, damit
      // keine Figuren/Orte/Chats/Stats des alten Buchs im UI stehenbleiben.
      // Filter-Persistenz: deep-watch jeden Filter-Scope, schreibt bei
      // jeder Mutation in localStorage. Restore beim Buchwechsel passiert
      // in `_resetBookScopedState`/`_restoreBookPrefs`; initialer Restore
      // im Hash-Router (isInitialApply-Branch), bevor View-Argumente Filter
      // setzen.
      for (const [key] of FILTER_SCOPES) {
        // Filter leben in Alpine.store('catalogUi') → Getter-Watch statt
        // String-Pfad. Alpine.watch JSON.stringifyt den Getter-Wert → deep,
        // also feuert es auch bei verschachtelten Filter-Mutationen.
        this.$watch(() => this.$store.catalogUi[key], (val) => {
          if (!this.$store.nav.selectedBookId) return;
          setFilters(this.$store.session.currentUser?.email, this.$store.nav.selectedBookId, key, val);
        });
      }

      this.$watch('entityPanelOpen', (val) => {
        try { localStorage.setItem('sw:entityPanelOpen', val ? '1' : '0'); } catch (_) {}
      });
      this.$watch(() => this.$store.nav.selectedBookId, async (newVal, oldVal) => {
        if (this._applyingHash) return;
        if (!newVal) return;
        // Alpine kann den Watcher mit identischem Wert feuern (z.B. bei
        // Combobox-Re-Selection oder String/Number-Coercion). Doppelter
        // _resetBookScopedState löscht User-Eingaben (Filter, offene Karten),
        // also überspringen.
        if (String(newVal) === String(oldVal)) return;
        try {
          localStorage.setItem(`sw:lastBookId:${this.$store.session.currentUser?.email || ''}`, String(newVal));
        } catch (_) {}
        this._resetBookScopedState();
        this._loadBookRole(newVal);
        this._loadBookFlagsForCurrentBook(newVal);
        await this.loadPages({ source: 'bookSwitch' });
        await this._reloadVisibleBookCards();
        this._maybeOpenBookOverview();
        this._startCollabPoll(newVal);
      });
      this._startJobQueuePoll();
      if (this.$store.nav.selectedBookId) this._startCollabPoll(this.$store.nav.selectedBookId);
      this._setupWritingTime();
      this._setupLektoratTime();
      this._setupSttTime();
      // _setupNotebookRestore lebt jetzt in editor-notebook-card.js#init.
    } catch (e) {
      console.error('[init]', e);
      this.setStatus(this.t('app.configLoadError'));
    }
    } finally {
      document.documentElement.removeAttribute('data-app-loading');
      this.$store.shell.appReady = true;
    }
  },
};
