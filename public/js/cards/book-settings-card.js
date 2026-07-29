// Alpine.data('bookSettingsCard') — Sub-Komponente der Buch-Einstellungen.
// Fachlicher State lebt hier, `showBookSettingsCard` + `toggleBookSettingsCard`
// im Root. Daten werden beim Öffnen / Buchwechsel nachgeladen.

import { bookSettingsMethods } from '../book/book-settings.js';
import { CITATION_DEFAULTS } from '../book/book-settings/citation.js';
import { setupCardLifecycle } from './card-lifecycle.js';
import { EVT } from '../events.js';

// Vollständiges Default-Meta (alle book_publication-Felder). Der /publication-PUT
// ist Full-Replace — ein unvollständiges Objekt setzt fehlende Felder serverseitig
// auf Default zurück. Deckungsgleich mit defaultMeta() in lib/publication-meta.js
// + den UI-Flags (has_cover/has_author_image).
const _EMPTY_PUB_META = () => ({
  author_name: '', author_file_as: '', co_authors: [], extra_sections: [],
  isbn: '', subtitle: '', year: '', dedication: '', imprint: '',
  copyright: '', frontmatter: '', author_bio: '', epub_css_style: 'serif', epub_toc_title: '',
  description: '', publisher: '', series: '', series_index: '', keywords: '',
  epub_font_size: 'normal', epub_line_height: 'normal', epub_paragraph_style: 'indent',
  epub_indent_size: 'medium', epub_scene_separator: 'line', epub_titlepage_mode: 'generated',
  epub_chapter_numbering: 'none', epub_chapter_numbering_mode: 'nested', epub_unnumbered_chapter_ids: [],
  epub_rights: '', epub_pubdate: '', epub_translator: '', epub_illustrator: '',
  epub_editor_name: '', epub_uuid: '', epub_justify: true, epub_hyphenation: false,
  epub_chapter_pagebreak: true, epub_drop_caps: false, epub_nest_pages_in_toc: true,
  // Pendants zu PDF-Profil-Optionen (Migration 179).
  epub_imprint_position: 'front', epub_chapter_title_style: 'centered-large',
  epub_heading_font: 'match', epub_heading_scale: 'normal', epub_cover_fit: 'contain',
  epub_numerals: 'default', epub_toc_depth: 2,
  epub_subchapter_pagebreak: false, epub_chapter_rule: false, epub_page_rule: false,
  epub_toc_enabled: true,
  has_cover: false, has_author_image: false,
});

export function registerBookSettingsCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('bookSettingsCard', () => ({
    bookSettingsTab: 'book',
    bookSettingsName: '',
    bookSettingsLanguage: 'de',
    bookSettingsRegion: 'CH',
    bookSettingsBuchtyp: '',
    bookSettingsBuchKontext: '',
    bookSettingsStilprofil: '',
    stilprofilGenerating: false,
    stilprofilJobId: null,
    stilprofilError: '',
    bookSettingsErzaehlperspektive: '',
    bookSettingsErzaehlzeit: '',
    bookSettingsIsFinished: false,
    bookSettingsAllowLektorBookChat: false,
    bookSettingsDailyGoalChars: 1500,
    bookSettingsGoalTargetChars: 0,
    bookSettingsGoalDeadline: '',
    bookSettingsOrteReal: false,
    bookSettingsSchauplatzLand: '',
    bookSettingsZeitlinieReal: false,
    bookSettingsWeltfaktenRealPruefen: false,
    bookSettingsExcludeFromStats: false,
    // Quellen-Tab (Zitierstil + Quellenverzeichnis). Eigener Schreibpfad
    // /booksettings/:id/citation — siehe book/book-settings/citation.js.
    bookCitation: { ...CITATION_DEFAULTS },
    bookCitationLoaded: false,
    citationSaving: false,
    citationSaved: false,
    citationError: '',
    _citationSavedTimer: null,
    // Sharing: Access-Liste + Invite-Form.
    bookAccessList: [],
    bookAccessLoading: false,
    bookAccessError: '',
    shareEmail: '',
    shareRole: 'viewer',
    shareBusy: false,
    shareInviteMessage: '',
    // Kategorie.
    categoryPool: [],
    bookCategoryId: '',
    bookSettingsLoading: false,
    bookSettingsSaving: false,
    bookSettingsSaved: false,
    bookSettingsError: '',
    bookJobStats: null,
    bookJobStatsLoading: false,
    expandedJobType: null,
    bookJobRuns: {},
    bookJobRunsLoading: false,
    bookHistoryResetLoading: false,
    bookHistoryResetMessage: '',
    bookHistoryResetError: '',
    bookDeleteLoading: false,
    bookDeleteError: '',
    staleCleanupLoading: false,
    staleCleanupMessage: '',
    staleCleanupError: '',
    // Blog-Sync (WordPress).
    blogSectionOpen: false,
    blogConnection: null,
    blogForm: { baseUrl: '', username: '', password: '', defaultStatus: 'draft' },
    blogBusy: false,
    blogAction: null,
    blogMessage: '',
    blogError: '',
    blogImportJobId: null,
    blogPullJobId: null,
    blogReconcileJobId: null,
    // HubSpot-Sync (Initial-Import + Create-Draft-Push).
    hubspotSectionOpen: false,
    hubspotConnection: null,
    hubspotForm: { token: '', blogId: '', authorId: '' },
    hubspotBlogs: [],
    hubspotAuthors: [],
    hubspotBusy: false,
    hubspotAction: null,
    hubspotMessage: '',
    hubspotError: '',
    hubspotImportJobId: null,
    hubspotReconcileJobId: null,
    // Publikation (book_publication: Cover/Titelei/Bio, geteilt mit PDF+EPUB).
    bookPublication: _EMPTY_PUB_META(),
    bookPublicationLoaded: false,
    pubSaving: false,
    pubSaved: false,
    pubError: '',
    pubCoverUploading: false,
    pubCoverError: '',
    pubAuthorUploading: false,
    pubAuthorError: '',
    pubPreviewVersion: 0,
    _pubSavedTimer: null,
    _savedAtTimer: null,
    _resetMsgTimer: null,
    _staleMsgTimer: null,
    _shareInviteMsgTimer: null,
    _lifecycle: null,
    _onBlogJobFinished: null,
    _onHubspotJobFinished: null,
    _onStilprofilJobFinished: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        showFlag: 'showBookSettingsCard',
        onShow: () => Promise.all([this.loadBookSettings(), this.loadBookJobStats(), this.loadBookAccess(), this.loadBookCategory(), this.loadBlogStatus(), this.loadHubspotStatus(), this.loadPublication()]),
        load: () => Promise.all([this.loadBookSettings(), this.loadBookJobStats(), this.loadBookAccess(), this.loadBookCategory(), this.loadBlogStatus(), this.loadHubspotStatus(), this.loadPublication()]),
        // Factory, nicht Objekt-Literal: der Reset enthält Objekte, die danach
        // per x-model in-place mutiert werden (blogForm, hubspotForm,
        // bookPublication, bookCitation). Ein einmalig gebautes Literal würde
        // seine Referenzen mit dem Live-State teilen und beim nächsten
        // Buchwechsel die Eingaben des letzten Buchs wieder einschleppen.
        resetState: () => ({
          bookSettingsTab: 'book',
          bookSettingsStilprofil: '',
          stilprofilGenerating: false,
          stilprofilJobId: null,
          expandedJobType: null,
          bookJobRuns: {},
          bookHistoryResetMessage: '',
          bookHistoryResetError: '',
          bookDeleteError: '',
          staleCleanupMessage: '',
          staleCleanupError: '',
          bookAccessList: [],
          bookAccessError: '',
          shareEmail: '',
          shareRole: 'viewer',
          shareInviteMessage: '',
          bookCategoryId: '',
          blogSectionOpen: false,
          blogConnection: null,
          blogForm: { baseUrl: '', username: '', password: '', defaultStatus: 'draft' },
          blogBusy: false,
          blogMessage: '',
          blogError: '',
          blogImportJobId: null,
          blogPullJobId: null,
          blogReconcileJobId: null,
          hubspotSectionOpen: false,
          hubspotConnection: null,
          hubspotForm: { token: '', blogId: '', authorId: '' },
          hubspotBlogs: [],
          hubspotAuthors: [],
          hubspotBusy: false,
          hubspotMessage: '',
          hubspotError: '',
          hubspotImportJobId: null,
          hubspotReconcileJobId: null,
          bookPublication: _EMPTY_PUB_META(),
          bookPublicationLoaded: false,
          pubError: '',
          pubCoverError: '',
          pubAuthorError: '',
          bookCitation: { ...CITATION_DEFAULTS },
          bookCitationLoaded: false,
          citationError: '',
        }),
        resetStateView: {
          bookSettingsSaved: false,
          bookSettingsError: '',
          stilprofilError: '',
          bookHistoryResetMessage: '',
          bookHistoryResetError: '',
          bookDeleteError: '',
          staleCleanupMessage: '',
          staleCleanupError: '',
          bookAccessError: '',
          shareInviteMessage: '',
          blogMessage: '',
          blogError: '',
          hubspotMessage: '',
          hubspotError: '',
          citationError: '',
        },
      });

      // Blog-Sync: bei Job-Ende Status nachladen, lokale Job-IDs nullen.
      // Filter lose: jeder blog-* Job-Done räumt beide Spinner-Flags und
      // triggert root.loadPages, weil Import/Pull neue Pages + Chapters
      // anlegen und der Sidebar-Tree sonst veraltet ist.
      this._onBlogJobFinished = (ev) => {
        const t = ev?.detail?.type;
        if (t !== 'blog-import' && t !== 'blog-pull' && t !== 'blog-push' && t !== 'blog-reconcile') return;
        this.blogImportJobId = null;
        this.blogPullJobId = null;
        this.blogReconcileJobId = null;
        this.loadBlogStatus();
        if (t === 'blog-import' || t === 'blog-pull') {
          window.__app.loadPages?.();
        }
      };
      window.addEventListener(EVT.JOB_FINISHED, this._onBlogJobFinished);

      // HubSpot-Jobs: bei Import-/Push-Done Status nachladen, Sidebar-Tree
      // refreshen (Import legt Pages/Chapters an).
      this._onHubspotJobFinished = (ev) => {
        const t = ev?.detail?.type;
        if (t !== 'hubspot-import' && t !== 'hubspot-push' && t !== 'hubspot-reconcile') return;
        this.hubspotImportJobId = null;
        this.hubspotReconcileJobId = null;
        this.loadHubspotStatus();
        if (t === 'hubspot-import') {
          window.__app.loadPages?.();
        }
      };
      window.addEventListener(EVT.JOB_FINISHED, this._onHubspotJobFinished);

      // Stilprofil-Job: bei Done nur das Stilprofil-Feld aus dem Job-Result
      // übernehmen (nicht das ganze Formular neu laden → keine ungespeicherten
      // Edits verlieren). Das Profil ist serverseitig bereits persistiert.
      this._onStilprofilJobFinished = (ev) => {
        if (ev?.detail?.type !== 'stilprofil') return;
        this.stilprofilGenerating = false;
        this.stilprofilJobId = null;
        const job = ev.detail.job;
        if (job?.status === 'done' && job.result?.stilprofil) {
          this.bookSettingsStilprofil = job.result.stilprofil;
        } else if (job?.status === 'error') {
          this.stilprofilError = window.__app.t('book.settings.stilprofil.genError');
        }
      };
      window.addEventListener(EVT.JOB_FINISHED, this._onStilprofilJobFinished);
    },

    destroy() {
      if (this._savedAtTimer) { clearTimeout(this._savedAtTimer); this._savedAtTimer = null; }
      if (this._resetMsgTimer) { clearTimeout(this._resetMsgTimer); this._resetMsgTimer = null; }
      if (this._staleMsgTimer) { clearTimeout(this._staleMsgTimer); this._staleMsgTimer = null; }
      if (this._shareInviteMsgTimer) { clearTimeout(this._shareInviteMsgTimer); this._shareInviteMsgTimer = null; }
      if (this._pubSavedTimer) { clearTimeout(this._pubSavedTimer); this._pubSavedTimer = null; }
      if (this._citationSavedTimer) { clearTimeout(this._citationSavedTimer); this._citationSavedTimer = null; }
      if (this._onBlogJobFinished) {
        window.removeEventListener(EVT.JOB_FINISHED, this._onBlogJobFinished);
        this._onBlogJobFinished = null;
      }
      if (this._onHubspotJobFinished) {
        window.removeEventListener(EVT.JOB_FINISHED, this._onHubspotJobFinished);
        this._onHubspotJobFinished = null;
      }
      if (this._onStilprofilJobFinished) {
        window.removeEventListener(EVT.JOB_FINISHED, this._onStilprofilJobFinished);
        this._onStilprofilJobFinished = null;
      }
      this._lifecycle?.destroy();
    },

    ...bookSettingsMethods,
  }));
}
