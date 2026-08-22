// Teil von appHashRouterMethods (siehe Facade app-hash-router.js).
// Lese-Richtung: URL → State. Parst den Hash und stellt den beschriebenen
// Zustand her.
//
// `_applyHash` setzt `_inHashApply` + `_applyingHash`, damit waehrend der
// Anwendung getriggerte Watcher keinen Rueck-Schreibzyklus starten.
import { EVT } from '../../events.js';
import { EXCLUSIVE_CARDS } from '../../cards/feature-registry.js';

// Hash-Views, deren Anwendung mechanisch identisch ist: „Karte oeffnen, falls sie
// nicht offen ist". Nur die Zuordnung Hash-Name → Registry-Key steht hier; Flag und
// Toggle-Methode kommen aus EXCLUSIVE_CARDS (SSoT) — sie werden bewusst NICHT
// zusaetzlich aufgelistet, sonst driftet diese Datei gegen die Registry.
// Views mit Eigenlogik (Argument, Store-Spiegel, Event, Scroll-bei-offen) bleiben
// als eigener `case` im switch stehen.
const SIMPLE_HASH_VIEWS = {
  // 'ereignisse' fehlt hier bewusst: die Karte kennt seit dem Einzel-Permalink
  // (`ereignis/<id>`) einen Auswahl-Zustand und braucht darum denselben
  // Zwei-Fall-Zweig wie szenen/orte — Liste ohne Argument nullt die Auswahl.
  'kontinuitaet': 'kontinuitaet',
  'erzaehlprofil':'erzaehlprofil',
  'bewertung':    'bookReview',
  'chat':         'bookChat',
  'uebersicht':   'bookOverview',
  'stats':        'bookStats',
  'stil':         'stil',
  'fehler':       'fehlerHeatmap',
  'redundanz':    'redundanz',
  'landkarte':    'buchlandkarte',
  'wortschatz':   'wortschatz',
  'struktur':     'struktur',
  'titel':        'titelwerkstatt',
  'einstellungen':'bookSettings',
  'finetune':     'finetuneExport',
  'fassungen':    'snapshots',
  'export':       'export',
  'pdf':          'pdfExport',
  'epub':         'epubExport',
  'docx':         'docxExport',
  'organize':     'bookOrganizer',
  'bucheditor':   'bookEditor',
  'share':        'shareLinks',
};

export const hashApplyMethods = {
  async _applyHash() {
    const hash = (location.hash || '').replace(/^#/, '');
    if (!hash) {
      // Leerer Hash = Admin-Landing (Tile-Grid hat keinen eigenen Hash). Beim
      // Zurück-Navigieren aus einer Admin-Karte schliessen, sonst bleibt die
      // Karte trotz URL-Wechsel offen und der Browser-Zurück-Button wirkt tot.
      if (this.isAdminOnly) {
        this._applyingHash = true;
        this._inHashApply = true;
        try { this._closeOtherMainCards('none'); }
        finally { this._applyingHash = false; this._inHashApply = false; }
      }
      return;
    }
    const parts = hash.split('/').filter(Boolean);

    if (parts[0] === 'profil') {
      this._applyingHash = true;
      this._inHashApply = true;
      try {
        if (!this.showUserSettingsCard) await this.toggleUserSettingsCard();
      } finally {
        this._applyingHash = false;
        this._inHashApply = false;
      }
      return;
    }

    if (parts[0] === 'meine-statistik') {
      this._applyingHash = true;
      this._inHashApply = true;
      try {
        if (!this.showMyStatsCard) await this.toggleMyStatsCard();
      } finally {
        this._applyingHash = false;
        this._inHashApply = false;
      }
      return;
    }

    if (parts[0] === 'hilfe') {
      this._applyingHash = true;
      this._inHashApply = true;
      try {
        if (!this.showHelpCard) await this.toggleHelpCard();
      } finally {
        this._applyingHash = false;
        this._inHashApply = false;
      }
      return;
    }

    if (parts[0] === 'search') {
      this._applyingHash = true;
      this._inHashApply = true;
      try {
        // #search = buchübergreifend: Scope-Spiegel auf 'all' setzen, bevor die
        // Karte öffnet (onShow liest ihn), sonst kippt der Default 'book' die URL
        // sofort auf #book/:id/suche zurück.
        this.$store.nav.searchScope = 'all';
        if (!this.showSearchCard) await this.toggleSearchCard();
      } finally {
        this._applyingHash = false;
        this._inHashApply = false;
      }
      return;
    }

    if (parts[0] === 'erste-schritte') {
      this._applyingHash = true;
      this._inHashApply = true;
      try {
        if (!this.showOnboardingCard) await this.toggleOnboardingCard();
      } finally {
        this._applyingHash = false;
        this._inHashApply = false;
      }
      return;
    }

    if (parts[0] === 'import') {
      this._applyingHash = true;
      this._inHashApply = true;
      try {
        if (!this.showFolderImportCard) await this.toggleFolderImportCard();
      } finally {
        this._applyingHash = false;
        this._inHashApply = false;
      }
      return;
    }

    if (parts[0] === 'admin') {
      this._applyingHash = true;
      this._inHashApply = true;
      try {
        const sub = parts[1] || 'users';
        if (sub === 'users') {
          if (!this.showAdminUsersCard) await this.toggleAdminUsersCard();
        } else if (sub === 'settings') {
          if (!this.showAdminSettingsCard) await this.toggleAdminSettingsCard();
        } else if (sub === 'usage') {
          if (!this.showAdminUsageCard) await this.toggleAdminUsageCard();
          const tab = parts[2];
          const valid = ['users', 'jobs', 'chat', 'summary', 'features', 'time'];
          if (tab && valid.includes(tab)) this.adminUsageTab = tab;
          else if (!tab) this.adminUsageTab = 'users';
        } else if (sub === 'categories') {
          if (!this.showAdminCategoriesCard) await this.toggleAdminCategoriesCard();
        } else if (sub === 'books') {
          if (!this.showAdminBooksCard) await this.toggleAdminBooksCard();
        } else if (sub === 'logs') {
          if (!this.showAdminLogsCard) await this.toggleAdminLogsCard();
        } else if (sub === 'parse-fails') {
          if (!this.showAdminParseFailsCard) await this.toggleAdminParseFailsCard();
        } else if (sub === 'js-errors') {
          if (!this.showAdminJsErrorsCard) await this.toggleAdminJsErrorsCard();
        } else if (sub === 'devices') {
          if (!this.showAdminDevicesCard) await this.toggleAdminDevicesCard();
        } else if (sub === 'backup') {
          if (!this.showAdminBackupCard) await this.toggleAdminBackupCard();
        }
      } finally {
        this._applyingHash = false;
        this._inHashApply = false;
      }
      return;
    }

    if (parts[0] !== 'book' || !parts[1]) return;
    const targetBookId = parts[1];
    if (!this.$store.nav.books.some(b => String(b.id) === targetBookId)) return;

    this._applyingHash = true;
    this._inHashApply = true;
    try {
      // Beim ersten _applyHash (Deep-Link / Reload) ist selectedBookId in init()
      // bereits aus dem Hash gesetzt und `loadBooks()` hat `loadPages()` schon
      // ausgeführt – nur `book:changed` dispatchen, damit Sub-Karten sich
      // synchronisieren. Kein _resetBookScopedState (würde tokEsts/_tokenEstGen
      // killen → Page-Stats blieben leer) und kein zweites loadPages (Flicker).
      const isInitialApply = !this._initialApplyDone;
      this._initialApplyDone = true;
      if (String(this.$store.nav.selectedBookId) !== targetBookId) {
        this.$store.nav.selectedBookId = targetBookId;
        this._resetBookScopedState();
        await this.loadPages({ source: 'bookSwitch' });
      } else if (isInitialApply) {
        window.dispatchEvent(new CustomEvent(EVT.BOOK_CHANGED, {
          detail: { bookId: this.$store.nav.selectedBookId },
        }));
        // Initialer Bootstrap: _resetBookScopedState wird hier nicht gerufen,
        // also Filter-Restore explizit. View-Argumente (Figur-Kapitel etc.)
        // überschreiben Filter danach gezielt — Reihenfolge wichtig.
        this._restoreBookPrefs?.(this.$store.nav.selectedBookId);
      }

      const view = parts[2];
      const arg = parts[3];
      if (!view) {
        this._closeOtherMainCards('none');
        this._maybeOpenBookOverview();
        return;
      }

      const simpleKey = SIMPLE_HASH_VIEWS[view];
      if (simpleKey) {
        const entry = EXCLUSIVE_CARDS.find(c => c.key === simpleKey);
        if (entry && !this[entry.flag]) await this[entry.toggle]();
        return;
      }
      switch (view) {
        case 'page':
          if (arg) {
            const page = this.$store.nav.pages.find(p => String(p.id) === arg);
            if (page) await this.selectPage(page);
          }
          break;
        case 'figur':
          if (arg) await this.openFigurById(arg);
          else {
            this.$store.catalogUi.selectedFigurId = null;
            if (!this.showFiguresCard) await this.toggleFiguresCard();
            else { this._closeOtherMainCards('figures'); this._scrollToCardByKey('figures'); }
          }
          break;
        case 'ort':
          if (arg) await this.openOrtById(arg);
          else {
            this.$store.catalogUi.selectedOrtId = null;
            if (!this.showOrteCard) await this.toggleOrteCard();
            else { this._closeOtherMainCards('orte'); this._scrollToCardByKey('orte'); }
          }
          break;
        case 'song':
          if (arg) await this.openSongById(arg);
          else {
            this.$store.catalogUi.selectedSongId = null;
            if (!this.showSongsCard) await this.toggleSongsCard();
            else { this._closeOtherMainCards('songs'); this._scrollToCardByKey('songs'); }
          }
          break;
        case 'songs':
          this.$store.catalogUi.selectedSongId = null;
          if (!this.showSongsCard) await this.toggleSongsCard();
          else { this._closeOtherMainCards('songs'); this._scrollToCardByKey('songs'); }
          break;
        case 'figuren':
          this.$store.catalogUi.selectedFigurId = null;
          if (!this.showFiguresCard) await this.toggleFiguresCard();
          else { this._closeOtherMainCards('figures'); this._scrollToCardByKey('figures'); }
          break;
        case 'werkstatt':
          if (!this.showFigurWerkstattCard) await this.toggleFigurWerkstattCard();
          if (arg) {
            // Sub übernimmt Draft-Wechsel via `figur-werkstatt:select`-Event.
            // Bei Deep-Link `#book/X/werkstatt/Y` ist die Sub evtl. noch nicht
            // gemountet — Event wird dann nach loadDrafts via _pendingDraftId
            // verarbeitet.
            window.dispatchEvent(new CustomEvent(EVT.FIGUR_WERKSTATT_SELECT, { detail: { draftId: parseInt(arg) } }));
          } else {
            this.$store.nav.werkstattDraftId = null;
          }
          break;
        case 'orte':
          this.$store.catalogUi.selectedOrtId = null;
          if (!this.showOrteCard) await this.toggleOrteCard();
          else { this._closeOtherMainCards('orte'); this._scrollToCardByKey('orte'); }
          break;
        case 'szene':
          if (arg) await this.openSzeneById(arg);
          else {
            this.$store.catalogUi.selectedSzeneId = null;
            if (!this.showSzenenCard) await this.toggleSzenenCard();
            else { this._closeOtherMainCards('szenen'); this._scrollToCardByKey('szenen'); }
          }
          break;
        case 'szenen':
          this.$store.catalogUi.selectedSzeneId = null;
          if (!this.showSzenenCard) await this.toggleSzenenCard();
          else { this._closeOtherMainCards('szenen'); this._scrollToCardByKey('szenen'); }
          break;
        case 'ereignis':
          if (arg) await this.openEreignisById(arg);
          else {
            this.$store.catalogUi.selectedEreignisId = null;
            if (!this.showEreignisseCard) await this.toggleEreignisseCard();
            else { this._closeOtherMainCards('ereignisse'); this._scrollToCardByKey('ereignisse'); }
          }
          break;
        case 'ereignisse':
          this.$store.catalogUi.selectedEreignisId = null;
          if (!this.showEreignisseCard) await this.toggleEreignisseCard();
          else { this._closeOtherMainCards('ereignisse'); this._scrollToCardByKey('ereignisse'); }
          break;
        case 'plot':
          // Optionaler Beat-Permalink (#…/plot/<beatId>). Root-SSoT vor dem Toggle
          // setzen; die plotCard fokussiert den Beat nach dem Board-Load (bzw.
          // sofort, falls schon geladen) via `plot:focus-beat` + _pendingFocusBeatId.
          this.$store.nav.plotBeatId = arg ? String(arg) : null;
          if (!this.showPlotCard) await this.togglePlotCard();
          else { this._closeOtherMainCards('plot'); this._scrollToCardByKey('plot'); }
          if (arg) window.dispatchEvent(new CustomEvent(EVT.PLOT_FOCUS_BEAT, { detail: { beatId: arg } }));
          break;
        case 'motiv':
          if (!this.showMotivCard) await this.toggleMotivCard();
          else { this._closeOtherMainCards('motiv'); this._scrollToCardByKey('motiv'); }
          break;
        case 'fakten':
          if (!this.showWorldFactsCard) await this.toggleWorldFactsCard();
          else { this._closeOtherMainCards('weltfakten'); this._scrollToCardByKey('weltfakten'); }
          break;
        case 'recherche':
          // Optionaler Item-Permalink (#…/recherche/<itemId>). Root-SSoT vor dem
          // Toggle setzen; die rechercheCard fokussiert das Item nach dem Board-
          // Load (bzw. sofort, falls schon geladen) via `recherche:focus-item` +
          // _pendingFocusItemId.
          this.$store.nav.rechercheItemId = arg ? String(arg) : null;
          if (!this.showRechercheCard) await this.toggleRechercheCard();
          else { this._closeOtherMainCards('recherche'); this._scrollToCardByKey('recherche'); }
          if (arg) window.dispatchEvent(new CustomEvent(EVT.RECHERCHE_FOCUS_ITEM, { detail: { itemId: arg } }));
          break;
        case 'quellen':
          // Optionaler Quellen-Permalink (#…/quellen/<sourceId>, Sprung aus dem
          // Referenz-Slot). Kein Store-Spiegel: der Fokus ist ein einmaliger Zeiger
          // auf eine Zeile, kein Kartenzustand — `_updateHash` normalisiert zurück.
          if (!this.showSourcesCard) await this.toggleSourcesCard();
          else { this._closeOtherMainCards('sources'); this._scrollToCardByKey('sources'); }
          if (arg) window.dispatchEvent(new CustomEvent(EVT.SOURCES_FOCUS_SOURCE, { detail: { sourceId: arg } }));
          break;
        case 'rueckblick':
          // Optionaler History-Eintrag-Permalink (#…/rueckblick/<entryId>). Root-
          // SSoT vor Toggle setzen; die Sub-Card öffnet den Eintrag im onOpen-Hook
          // bzw. via $watch auf Alpine.store('nav').rueckblickEntryId.
          this.$store.nav.rueckblickEntryId = arg ? String(arg) : null;
          if (!this.showTagebuchRueckblickCard) await this.toggleTagebuchRueckblickCard();
          else this._scrollToCardByKey('tagebuchRueckblick');
          break;
        case 'kapitel':
          // Root-SSoT vor Toggle setzen — `_openKapitelReview` validiert nach
          // dem Partial-Load via `stillValid`. Ein Event wäre race-anfällig:
          // bei Deep-Link ist die Sub-Komponente erst nach `_ensurePartial`
          // gemountet, ein vorher dispatchtes Event ginge verloren.
          if (arg) this.kapitelReviewChapterId = String(arg);
          if (!this.showKapitelReviewCard) await this.toggleKapitelReviewCard();
          break;
        case 'suche':
          // Buch-skopierte Volltextsuche. Scope-Spiegel auf 'book' setzen, bevor
          // die Karte öffnet (onShow liest ihn), sonst bliebe der zuletzt genutzte
          // Scope stehen und die URL kippte auf #search.
          this.$store.nav.searchScope = 'book';
          if (!this.showSearchCard) await this.toggleSearchCard();
          else { this._closeOtherMainCards('search'); this._scrollToCardByKey('search'); }
          break;
      }
    } finally {
      this._applyingHash = false;
      this._inHashApply = false;
    }
  },
};
