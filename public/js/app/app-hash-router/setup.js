// Teil von appHashRouterMethods (siehe Facade app-hash-router.js).
// Lifecycle: haengt die Watcher auf, die den Hash schreiben, und raeumt sie ab.
export const hashSetupMethods = {
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
      'showBookStatsCard', 'showStilCard', 'showFehlerHeatmapCard', 'showRedundanzCard', 'showBuchlandkarteCard', 'showWortschatzCard', 'showStrukturCard', 'showTitelwerkstattCard',
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
      () => this.$store.catalogUi.selectedEreignisId,
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
