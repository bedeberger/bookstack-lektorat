// Registriert alle Alpine-Magics, Stores und Sub-Komponenten-Karten.
// Wird einmalig aus dem `alpine:init`-Handler in app.js aufgerufen, bevor die
// `lektorat`-Root-Komponente via Alpine.data definiert wird.
import { registerBookReviewCard } from '../cards/book-review-card.js';
import { registerKapitelReviewCard } from '../cards/kapitel-review-card.js';
import { registerBookOverviewCard } from '../cards/book-overview-card.js';
import { registerBookStatsCard } from '../cards/book-stats-card.js';
import { registerCatalogStore } from '../cards/catalog-store.js';
import { registerCatalogUiStore } from '../cards/catalog-ui-store.js';
import { registerNavStore } from '../cards/nav-store.js';
import { registerSessionStore } from '../cards/session-store.js';
import { registerShellStore } from '../cards/shell-store.js';
import { registerTtsStore } from '../cards/tts-store.js';
import { registerSttStore } from '../cards/stt-store.js';
import { registerConfigStore } from '../cards/config-store.js';
import { registerCollabStore } from '../cards/collab-store.js';
import { registerJobsStore } from '../cards/jobs-store.js';
import { registerBadgesStore } from '../cards/badges-store.js';
import { registerProgressStore } from '../cards/progress-store.js';
import { registerEreignisseCard } from '../cards/ereignisse-card.js';
import { registerOrteCard } from '../cards/orte-card.js';
import { registerSongsCard } from '../cards/songs-card.js';
import { registerSzenenCard } from '../cards/szenen-card.js';
import { registerPlotCard } from '../cards/plot-card.js';
import { registerMotivCard } from '../cards/motiv-card.js';
import { registerWorldFactsCard } from '../cards/world-facts-card.js';
import { registerFigurenCard } from '../cards/figuren-card.js';
import { registerFigurWerkstattCard } from '../cards/figur-werkstatt-card.js';
import { registerStilCard } from '../cards/stil-card.js';
import { registerFehlerHeatmapCard } from '../cards/fehler-heatmap-card.js';
import { registerRedundanzCard } from '../cards/redundanz-card.js';
import { registerBuchlandkarteCard } from '../cards/buchlandkarte-card.js';
import { registerWortschatzCard } from '../cards/wortschatz-card.js';
import { registerStrukturCard } from '../cards/struktur-card.js';
import { registerTitelwerkstattCard } from '../cards/titelwerkstatt-card.js';
import { registerChatCard } from '../cards/chat-card.js';
import { registerIdeenCard } from '../cards/ideen-card.js';
import { registerReferenceCard } from '../cards/reference-card.js';
import { registerRechercheCard } from '../cards/recherche-card.js';
import { registerSourcesCard } from '../cards/sources-card.js';
import { registerBookChatCard } from '../cards/book-chat-card.js';
import { registerKontinuitaetCard } from '../cards/kontinuitaet-card.js';
import { registerErzaehlprofilCard } from '../cards/erzaehlprofil-card.js';
import { registerTagebuchRueckblickCard } from '../cards/tagebuch-rueckblick-card.js';
import { registerBookSettingsCard } from '../cards/book-settings-card.js';
import { registerUserSettingsCard } from '../cards/user-settings-card.js';
import { registerMyStatsCard } from '../cards/my-stats-card.js';
import { registerHelpCard } from '../cards/help-card.js';
import { registerOnboardingCard } from '../cards/onboarding-card.js';
import { registerAdminUsersCard } from '../cards/admin-users-card.js';
import { registerAdminSettingsCard } from '../cards/admin-settings-card.js';
import { registerAdminUsageCard } from '../cards/admin-usage-card.js';
import { registerAdminCategoriesCard } from '../cards/admin-categories-card.js';
import { registerAdminBooksCard } from '../cards/admin-books-card.js';
import { registerAdminLogsCard } from '../cards/admin-logs-card.js';
import { registerAdminParseFailsCard } from '../cards/admin-parse-fails-card.js';
import { registerAdminJsErrorsCard } from '../cards/admin-js-errors-card.js';
import { registerAdminDevicesCard } from '../cards/admin-devices-card.js';
import { registerAdminBackupCard } from '../cards/admin-backup-card.js';
import { registerFinetuneExportCard } from '../cards/finetune-export-card.js';
import { registerExportCard } from '../cards/export-card.js';
import { registerPdfExportCard } from '../cards/pdf-export-card.js';
import { registerEpubExportCard } from '../cards/epub-export-card.js';
import { registerDocxExportCard } from '../cards/docx-export-card.js';
import { registerBookOrganizerCard } from '../cards/book-organizer-card.js';
import { registerBookEditorCard } from '../cards/book-editor-card.js';
import { registerSearchCard } from '../cards/search-card.js';
import { registerFolderImportCard } from '../cards/folder-import-card.js';
import { registerShareLinksCard } from '../cards/share-links-card.js';
import { registerEditorFindCard } from '../cards/editor-find-card.js';
import { registerEditorSynonymeCard } from '../cards/editor-synonyme-card.js';
import { registerEditorFigurLookupCard } from '../cards/editor-figur-lookup-card.js';
import { registerEditorToolbarCard } from '../cards/editor-toolbar-card.js';
import { registerEditorFocusCard } from '../cards/editor-focus-card.js';
import { registerEditorNotebookCard } from '../cards/editor-notebook-card.js';
import { registerEditorEntitiesCard } from '../cards/editor-entities-card.js';
import { registerEditorPageHeadCard } from '../cards/editor-page-head-card.js';
import { registerEditorSpellcheckCard } from '../cards/editor-spellcheck-card.js';
import { registerLektoratFindingsCard } from '../cards/lektorat-findings-card.js';
import { registerEditorCommentsCard } from '../cards/editor-comments-card.js';
import { registerPageHistoryCard } from '../cards/page-history-card.js';
import { registerPageRevisionsCard } from '../cards/page-revisions-card.js';
import { registerSnapshotsCard } from '../cards/snapshots-card.js';
import { registerPaletteCard } from '../cards/palette-card.js';
import { registerBlogSyncCard } from '../cards/blog-sync-card.js';
import { registerBookCreateCard } from '../cards/book-create-card.js';
import { registerHubspotSyncCard } from '../cards/hubspot-sync-card.js';
import { registerNumInput } from '../num-input.js';
import { registerCombobox } from '../combobox.js';
import { registerCopyButton } from '../copy-button.js';
import { registerFileDrop } from '../file-drop.js';
import { registerRadioGroup } from '../radio-group.js';
import { registerSortableTable } from '../sortable-table.js';
import { registerCatalogFilter } from '../catalog-filter.js';
import { registerEntityPicker } from '../cards/entity-picker.js';
import { registerCollapsible } from '../collapsible.js';
import { registerTabs } from '../tabs.js';
import { registerToggleSwitch } from '../toggle-switch.js';
import { registerSettingField } from '../setting-field.js';
import { registerMenu } from '../menu.js';
import { registerModal } from '../modal.js';

// Magics, die Sub-Komponenten/Partials den Zugriff auf Root + Sync-Provider geben.
export function registerAppMagics() {
  const Alpine = window.Alpine;
  // Magic `$app` — verweist auf die `lektorat`-Root-Komponente am body. In
  // Alpine ist `$root` das nächste x-data-Element (bei Sub-Komponenten also die
  // Sub selbst), nicht die Top-Level-Komponente. Sub-Komponenten und Partials
  // greifen über $app auf Root-Methoden und geteilten State zu. Die Referenz
  // wird in Root.init() auf window.__app gesetzt (garantiert reactive proxy) —
  // Alpine.$data(document.body) liefert bei manchen Getter-Evaluationen undefined.
  Alpine.magic('app', () => window.__app || Alpine.$data(document.body));
  // Magic `$blog` — verweist auf den blogSyncCard-Anker (display-contents
  // <div x-data="blogSyncCard"> in index.html). Setzt sich in Card.init()
  // selbst auf window.__blogCard.
  Alpine.magic('blog', () => window.__blogCard);
  // Magic `$hubspot` — analog zu $blog, verweist auf den hubspotSyncCard-Anker.
  Alpine.magic('hubspot', () => window.__hubspotCard);
  // Magic `$syncProviders` — Liste aller verbundenen Sync-Provider, sortiert
  // nach Registrierungsreihenfolge (blog, hubspot, …). Templates iterieren
  // hierüber statt copy-paste pro Provider; jeder Eintrag hat `{ key, card }`.
  // Reaktiv via `.connected`-Lesen am Card-Proxy.
  Alpine.magic('syncProviders', () => {
    const candidates = [
      { key: 'blog', card: window.__blogCard },
      { key: 'hubspot', card: window.__hubspotCard },
    ];
    return candidates.filter(p => p.card && p.card.connected);
  });
}

// Stores + alle Sub-Komponenten-Karten + generischen Alpine-Daten-Helfer.
export function registerAllCards() {
  registerCatalogStore();
  registerCatalogUiStore();
  registerNavStore();
  registerSessionStore();
  registerShellStore();
  registerTtsStore();
  registerSttStore();
  registerConfigStore();
  registerCollabStore();
  registerJobsStore();
  registerBadgesStore();
  registerProgressStore();
  registerStilCard();
  registerFehlerHeatmapCard();
  registerRedundanzCard();
  registerBuchlandkarteCard();
  registerWortschatzCard();
  registerStrukturCard();
  registerTitelwerkstattCard();
  registerBookOverviewCard();
  registerBookStatsCard();
  registerBookSettingsCard();
  registerUserSettingsCard();
  registerMyStatsCard();
  registerHelpCard();
  registerOnboardingCard();
  registerAdminUsersCard();
  registerAdminSettingsCard();
  registerAdminUsageCard();
  registerAdminCategoriesCard();
  registerAdminBooksCard();
  registerAdminLogsCard();
  registerAdminParseFailsCard();
  registerAdminJsErrorsCard();
  registerAdminDevicesCard();
  registerAdminBackupCard();
  registerFinetuneExportCard();
  registerSnapshotsCard();
  registerExportCard();
  registerPdfExportCard();
  registerEpubExportCard();
  registerDocxExportCard();
  registerBookOrganizerCard();
  registerBookEditorCard();
  registerSearchCard();
  registerFolderImportCard();
  registerShareLinksCard();
  registerKontinuitaetCard();
  registerErzaehlprofilCard();
  registerTagebuchRueckblickCard();
  registerEreignisseCard();
  registerOrteCard();
  registerSongsCard();
  registerSzenenCard();
  registerPlotCard();
  registerMotivCard();
  registerWorldFactsCard();
  registerFigurenCard();
  registerFigurWerkstattCard();
  registerBookReviewCard();
  registerKapitelReviewCard();
  registerChatCard();
  registerIdeenCard();
  registerReferenceCard();
  registerRechercheCard();
  registerSourcesCard();
  registerBookChatCard();
  registerEditorFindCard();
  registerEditorFigurLookupCard();
  registerEditorSynonymeCard();
  registerEditorToolbarCard();
  registerEditorFocusCard();
  registerEditorNotebookCard();
  registerEditorEntitiesCard();
  registerEditorPageHeadCard();
  registerEditorSpellcheckCard();
  registerLektoratFindingsCard();
  registerEditorCommentsCard();
  registerPageHistoryCard();
  registerPageRevisionsCard();
  registerPaletteCard();
  registerBlogSyncCard();
  registerHubspotSyncCard();
  registerBookCreateCard();
  registerNumInput();
  registerCombobox();
  registerCopyButton();
  registerFileDrop();
  registerRadioGroup();
  registerSortableTable();
  registerCatalogFilter();
  registerEntityPicker();
  registerCollapsible();
  registerTabs();
  registerToggleSwitch();
  registerSettingField();
  registerMenu();
  registerModal();
}
