import { EVT } from '../events.js';
// URL-Hash-Permalinks + History-Management.
// Schema: #profil | #admin/<users|settings|usage[/<tab>]> | #book/:bookId[/page/:pageId|/figur/:figId|/ort/:ortId|/werkstatt[/:draftId]|/kapitel[/:chapterId]|/<view>]
// Views: figuren, werkstatt, orte, szenen, ereignisse, kontinuitaet, bewertung, kapitel, chat, stats, stil, fehler, suche, einstellungen, finetune, export
// Admin-Usage-Tabs: users (default, weggelassen) | jobs | chat | summary | features | time
//
// Entwurfsentscheidungen:
// - push vs. replace entscheidet `_hashCategory`: gleiche Kategorie → replace
//   (z.B. Figur↔Figur), Wechsel → push. `figur`/`figuren`, `ort`/`orte` gelten
//   als dieselbe Kategorie.
// - `_updateHash` bündelt mehrere synchrone Alpine-Watcher-Feuer per Microtask
//   zu EINEM History-Eintrag.
// - `_applyHash` setzt `_inHashApply` + `_applyingHash`, damit während der
//   Anwendung getriggerte Watcher keinen Rück-Schreibzyklus starten.
export const appHashRouterMethods = {
  _computeHash() {
    if (this.showUserSettingsCard) return '#profil';
    if (this.showMyStatsCard) return '#meine-statistik';
    if (this.showHelpCard) return '#hilfe';
    if (this.showOnboardingCard) return '#erste-schritte';
    // Volltextsuche: buch-skopiert (#book/:id/suche) wenn ein Buch gewählt ist
    // und der effektive Scope 'book' ist; sonst buchübergreifend (#search).
    if (this.showSearchCard) {
      const bid = this.$store.nav.selectedBookId;
      if (bid && this.$store.nav.searchScope === 'book') return '#book/' + bid + '/suche';
      return '#search';
    }
    // Folder-Import ist book-unabhaengig (new-book oder merge).
    if (this.showFolderImportCard) return '#import';
    if (this.showAdminUsersCard) return '#admin/users';
    if (this.showAdminSettingsCard) return '#admin/settings';
    if (this.showAdminUsageCard) {
      const tab = this.adminUsageTab;
      return '#admin/usage' + (tab && tab !== 'users' ? '/' + tab : '');
    }
    if (this.showAdminCategoriesCard) return '#admin/categories';
    if (this.showAdminBooksCard) return '#admin/books';
    if (this.showAdminLogsCard) return '#admin/logs';
    if (this.showAdminParseFailsCard) return '#admin/parse-fails';
    if (this.showAdminJsErrorsCard) return '#admin/js-errors';
    if (this.showAdminDevicesCard) return '#admin/devices';
    if (this.showAdminBackupCard) return '#admin/backup';
    if (!this.$store.nav.selectedBookId) return '';
    const parts = ['book', this.$store.nav.selectedBookId];
    if (this.showEditorCard && this.currentPage?.id) {
      parts.push('page', String(this.currentPage.id));
    } else if (this.showFiguresCard && this.$store.catalogUi.selectedFigurId) {
      parts.push('figur', String(this.$store.catalogUi.selectedFigurId));
    } else if (this.showOrteCard && this.$store.catalogUi.selectedOrtId) {
      parts.push('ort', String(this.$store.catalogUi.selectedOrtId));
    } else if (this.showSongsCard && this.$store.catalogUi.selectedSongId) {
      parts.push('song', String(this.$store.catalogUi.selectedSongId));
    } else if (this.showSzenenCard && this.$store.catalogUi.selectedSzeneId) {
      parts.push('szene', String(this.$store.catalogUi.selectedSzeneId));
    } else if (this.showKapitelReviewCard && this.kapitelReviewChapterId) {
      parts.push('kapitel', String(this.kapitelReviewChapterId));
    } else if (this.showFigurWerkstattCard && this.$store.nav.werkstattDraftId) {
      parts.push('werkstatt', String(this.$store.nav.werkstattDraftId));
    } else if (this.showTagebuchRueckblickCard && this.$store.nav.rueckblickEntryId) {
      parts.push('rueckblick', String(this.$store.nav.rueckblickEntryId));
    } else if (this.showPlotCard && this.$store.nav.plotBeatId) {
      parts.push('plot', String(this.$store.nav.plotBeatId));
    } else if (this.showRechercheCard && this.$store.nav.rechercheItemId) {
      parts.push('recherche', String(this.$store.nav.rechercheItemId));
    } else if (this.showFiguresCard) parts.push('figuren');
    else if (this.showFigurWerkstattCard) parts.push('werkstatt');
    else if (this.showOrteCard) parts.push('orte');
    else if (this.showSongsCard) parts.push('songs');
    else if (this.showSzenenCard) parts.push('szenen');
    else if (this.showEreignisseCard) parts.push('ereignisse');
    else if (this.showPlotCard) parts.push('plot');
    else if (this.showMotivCard) parts.push('motiv');
    else if (this.showWorldFactsCard) parts.push('fakten');
    else if (this.showRechercheCard) parts.push('recherche');
    else if (this.showSourcesCard) parts.push('quellen');
    else if (this.showKontinuitaetCard) parts.push('kontinuitaet');
    else if (this.showErzaehlprofilCard) parts.push('erzaehlprofil');
    else if (this.showTagebuchRueckblickCard) parts.push('rueckblick');
    else if (this.showBookReviewCard) parts.push('bewertung');
    else if (this.showKapitelReviewCard) parts.push('kapitel');
    else if (this.showBookChatCard) parts.push('chat');
    else if (this.showBookOverviewCard) parts.push('uebersicht');
    else if (this.showBookStatsCard) parts.push('stats');
    else if (this.showStilCard) parts.push('stil');
    else if (this.showFehlerHeatmapCard) parts.push('fehler');
    else if (this.showRedundanzCard) parts.push('redundanz');
    else if (this.showBookSettingsCard) parts.push('einstellungen');
    else if (this.showFinetuneExportCard) parts.push('finetune');
    else if (this.showSnapshotsCard) parts.push('fassungen');
    else if (this.showExportCard) parts.push('export');
    else if (this.showPdfExportCard) parts.push('pdf');
    else if (this.showEpubExportCard) parts.push('epub');
    else if (this.showDocxExportCard) parts.push('docx');
    else if (this.showBookOrganizerCard) parts.push('organize');
    else if (this.showBookEditorCard) parts.push('bucheditor');
    else if (this.showShareLinksCard) parts.push('share');
    return '#' + parts.join('/');
  },

  _hashCategory(hash) {
    if (!hash) return null;
    const parts = hash.replace(/^#/, '').split('/').filter(Boolean);
    if (parts[0] === 'profil') return 'profil';
    if (parts[0] === 'meine-statistik') return 'meine-statistik';
    if (parts[0] === 'hilfe') return 'hilfe';
    if (parts[0] === 'erste-schritte') return 'erste-schritte';
    if (parts[0] === 'search') return 'search';
    if (parts[0] === 'admin') return 'admin:' + (parts[1] || '');
    if (parts[0] !== 'book' || !parts[1]) return null;
    const bookId = parts[1];
    const view = parts[2] || 'book';
    const kind = view === 'figur' ? 'figuren'
      : view === 'ort' ? 'orte'
      : view === 'song' ? 'songs'
      : view === 'szene' ? 'szenen'
      : view;
    // Tagebuch-Rückblick: jeder Eintrag ist eine eigene History-Kategorie
    // (id im Category-Key), damit der Browser-Zurück-Button schrittweise zwischen
    // Einträgen und zurück zur Kalender-Übersicht navigiert. Bewusste Abweichung
    // von der Figur/Ort/Seite-Konvention (dort id-Wechsel = replace).
    if (view === 'rueckblick' && parts[3]) return bookId + ':rueckblick:' + parts[3];
    return bookId + ':' + kind;
  },

  _writeHash(newHash) {
    const cleanUrl = location.pathname + location.search;
    const firstWrite = !this._hashInitialized;
    this._hashInitialized = true;
    if (!newHash) {
      if (location.hash) history.replaceState(null, '', cleanUrl);
      return;
    }
    if (location.hash === newHash) return;
    if (firstWrite) { history.replaceState(null, '', newHash); return; }
    const oldCat = this._hashCategory(location.hash);
    const newCat = this._hashCategory(newHash);
    if (oldCat && oldCat === newCat) {
      history.replaceState(null, '', newHash);
    } else {
      history.pushState(null, '', newHash);
    }
    // pushState/replaceState feuern kein hashchange → Plausible manuell triggern.
    try { window.plausible?.('pageview'); } catch { /* noop */ }
  },

  // Synchroner URL-Sync ohne neuen History-Eintrag (initial + nach Hash-Apply).
  _syncUrlNow() {
    const newHash = this._computeHash();
    const cleanUrl = location.pathname + location.search;
    if (!newHash) {
      if (location.hash) history.replaceState(null, '', cleanUrl);
    } else if (location.hash !== newHash) {
      history.replaceState(null, '', newHash);
    }
    this._hashInitialized = true;
  },

  // Mehrere synchrone State-Änderungen werden per Microtask zu einem
  // einzigen URL-Update zusammengefasst.
  _updateHash() {
    if (this._applyingHash) return;
    if (this._hashUpdatePending) return;
    this._hashUpdatePending = true;
    queueMicrotask(() => {
      this._hashUpdatePending = false;
      if (this._applyingHash) return;
      this._writeHash(this._computeHash());
    });
  },

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
        case 'ereignisse':
          if (!this.showEreignisseCard) await this.toggleEreignisseCard();
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
        case 'kontinuitaet':
          if (!this.showKontinuitaetCard) await this.toggleKontinuitaetCard();
          break;
        case 'erzaehlprofil':
          if (!this.showErzaehlprofilCard) await this.toggleErzaehlprofilCard();
          break;
        case 'rueckblick':
          // Optionaler History-Eintrag-Permalink (#…/rueckblick/<entryId>). Root-
          // SSoT vor Toggle setzen; die Sub-Card öffnet den Eintrag im onOpen-Hook
          // bzw. via $watch auf Alpine.store('nav').rueckblickEntryId.
          this.$store.nav.rueckblickEntryId = arg ? String(arg) : null;
          if (!this.showTagebuchRueckblickCard) await this.toggleTagebuchRueckblickCard();
          else this._scrollToCardByKey('tagebuchRueckblick');
          break;
        case 'bewertung':
          if (!this.showBookReviewCard) await this.toggleBookReviewCard();
          break;
        case 'kapitel':
          // Root-SSoT vor Toggle setzen — `_openKapitelReview` validiert nach
          // dem Partial-Load via `stillValid`. Ein Event wäre race-anfällig:
          // bei Deep-Link ist die Sub-Komponente erst nach `_ensurePartial`
          // gemountet, ein vorher dispatchtes Event ginge verloren.
          if (arg) this.kapitelReviewChapterId = String(arg);
          if (!this.showKapitelReviewCard) await this.toggleKapitelReviewCard();
          break;
        case 'chat':
          if (!this.showBookChatCard) await this.toggleBookChatCard();
          break;
        case 'uebersicht':
          if (!this.showBookOverviewCard) await this.toggleBookOverviewCard();
          break;
        case 'stats':
          if (!this.showBookStatsCard) await this.toggleBookStatsCard();
          break;
        case 'stil':
          if (!this.showStilCard) await this.toggleStilCard();
          break;
        case 'fehler':
          if (!this.showFehlerHeatmapCard) await this.toggleFehlerHeatmapCard();
          break;
        case 'redundanz':
          if (!this.showRedundanzCard) await this.toggleRedundanzCard();
          break;
        case 'suche':
          // Buch-skopierte Volltextsuche. Scope-Spiegel auf 'book' setzen, bevor
          // die Karte öffnet (onShow liest ihn), sonst bliebe der zuletzt genutzte
          // Scope stehen und die URL kippte auf #search.
          this.$store.nav.searchScope = 'book';
          if (!this.showSearchCard) await this.toggleSearchCard();
          else { this._closeOtherMainCards('search'); this._scrollToCardByKey('search'); }
          break;
        case 'einstellungen':
          if (!this.showBookSettingsCard) await this.toggleBookSettingsCard();
          break;
        case 'finetune':
          if (!this.showFinetuneExportCard) await this.toggleFinetuneExportCard();
          break;
        case 'fassungen':
          if (!this.showSnapshotsCard) await this.toggleSnapshotsCard();
          break;
        case 'export':
          if (!this.showExportCard) await this.toggleExportCard();
          break;
        case 'pdf':
          if (!this.showPdfExportCard) await this.togglePdfExportCard();
          break;
        case 'epub':
          if (!this.showEpubExportCard) await this.toggleEpubExportCard();
          break;
        case 'docx':
          if (!this.showDocxExportCard) await this.toggleDocxExportCard();
          break;
        case 'organize':
          if (!this.showBookOrganizerCard) await this.toggleBookOrganizerCard();
          break;
        case 'bucheditor':
          if (!this.showBookEditorCard) await this.toggleBookEditorCard();
          break;
        case 'share':
          if (!this.showShareLinksCard) await this.toggleShareLinksCard();
          break;
      }
    } finally {
      this._applyingHash = false;
      this._inHashApply = false;
    }
  },

  _setupHashRouting() {
    // Re-init sammelt sonst mehrfache $watch — bei jedem Property-Change feuern
    // dann doppelte URL-Writes mit doppeltem History-Eintrag. Existierende
    // Teardowns vorab abräumen.
    this._teardownHashRouting();
    const watchers = [
      'currentPage', 'showEditorCard',
      'showFiguresCard', 'showFigurWerkstattCard', 'showOrteCard', 'showSongsCard', 'showSzenenCard', 'showEreignisseCard', 'showPlotCard', 'showMotivCard', 'showWorldFactsCard',
      'showRechercheCard',
      'showSourcesCard',
      'showKontinuitaetCard', 'showErzaehlprofilCard', 'showTagebuchRueckblickCard', 'showBookReviewCard', 'showBookChatCard',
      'showKapitelReviewCard', 'kapitelReviewChapterId',
      'showBookStatsCard', 'showStilCard', 'showFehlerHeatmapCard', 'showRedundanzCard',
      'showBookSettingsCard', 'showUserSettingsCard', 'showMyStatsCard', 'showHelpCard', 'showOnboardingCard',
      'showAdminUsersCard', 'showAdminSettingsCard', 'showAdminUsageCard', 'adminUsageTab',
      'showAdminCategoriesCard', 'showAdminBooksCard', 'showAdminLogsCard', 'showAdminParseFailsCard',
      'showAdminJsErrorsCard', 'showAdminDevicesCard', 'showAdminBackupCard',
      'showFinetuneExportCard',
      'showSnapshotsCard',
      'showExportCard',
      'showPdfExportCard',
      'showEpubExportCard',
      'showDocxExportCard',
      'showBookOrganizerCard',
      'showBookEditorCard',
      'showBookOverviewCard',
      'showSearchCard',
      'showFolderImportCard',
      'showShareLinksCard',
    ];
    this._hashWatcherTeardowns = [];
    for (const prop of watchers) {
      const off = this.$watch(prop, () => this._updateHash());
      if (typeof off === 'function') this._hashWatcherTeardowns.push(off);
    }
    // selectedBookId + selectedXxxId leben in Stores (nav / catalogUi, keine
    // Root-Properties mehr) → Getter-Watch statt String-Pfad, sonst feuert der
    // Hash-Update nie.
    const storeWatched = [
      () => this.$store.nav.selectedBookId,
      () => this.$store.catalogUi.selectedFigurId,
      () => this.$store.catalogUi.selectedOrtId,
      () => this.$store.catalogUi.selectedSongId,
      () => this.$store.catalogUi.selectedSzeneId,
      // Beat-Permalink: Edit öffnen setzt plotBeatId → #…/plot/<beatId> (replace,
      // gleiche Kategorie), Schliessen/Esc/Verwerfen nullt ihn → zurück auf #…/plot.
      () => this.$store.nav.plotBeatId,
      // Recherche-Item-Permalink: Öffnen/Fokussieren setzt rechercheItemId →
      // #…/recherche/<itemId> (replace, gleiche Kategorie), Schliessen nullt ihn.
      () => this.$store.nav.rechercheItemId,
      () => this.$store.nav.searchScope,
    ];
    for (const getter of storeWatched) {
      const off = this.$watch(getter, () => this._updateHash());
      if (typeof off === 'function') this._hashWatcherTeardowns.push(off);
    }
    window.addEventListener('hashchange', () => this._applyHash(), { signal: this._abortCtrl?.signal });
  },

  _teardownHashRouting() {
    if (Array.isArray(this._hashWatcherTeardowns)) {
      for (const off of this._hashWatcherTeardowns) {
        try { off(); } catch { /* noop */ }
      }
    }
    this._hashWatcherTeardowns = [];
  },
};
