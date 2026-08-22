// Teil von appHashRouterMethods (siehe Facade app-hash-router.js).
// Schreib-Richtung: State → URL. Baut den Hash aus dem aktuellen State und
// schreibt ihn per push/replace in die History.
//
// - push vs. replace entscheidet `_hashCategory`: gleiche Kategorie → replace
//   (z.B. Figur↔Figur), Wechsel → push. `figur`/`figuren`, `ort`/`orte` gelten
//   als dieselbe Kategorie.
// - `_updateHash` buendelt mehrere synchrone Alpine-Watcher-Feuer per Microtask
//   zu EINEM History-Eintrag.
export const hashBuildMethods = {
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
    } else if (this.showEreignisseCard && this.$store.catalogUi.selectedEreignisId) {
      parts.push('ereignis', String(this.$store.catalogUi.selectedEreignisId));
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
    else if (this.showBuchlandkarteCard) parts.push('landkarte');
    else if (this.showWortschatzCard) parts.push('wortschatz');
    else if (this.showStrukturCard) parts.push('struktur');
    else if (this.showTitelwerkstattCard) parts.push('titel');
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
};
