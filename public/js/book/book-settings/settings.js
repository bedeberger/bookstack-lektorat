// Teil von bookSettingsMethods (siehe Facade book-settings.js).
import { EVT, contentRepo, countryOptions, fetchJson } from './_shared.js';

export const settingsMethods = {
  async loadBookSettings() {
    if (!Alpine.store('nav').selectedBookId) return;
    this.bookSettingsLoading = true;
    try {
      const data = await fetchJson(`/booksettings/${Alpine.store('nav').selectedBookId}`);
      const book = Alpine.store('nav').books.find(b => String(b.id) === String(Alpine.store('nav').selectedBookId));
      this.bookSettingsName       = book?.name || '';
      this.bookSettingsLanguage  = data.language    || 'de';
      this.bookSettingsRegion    = data.region      || 'CH';
      this.bookSettingsBuchtyp   = data.buchtyp     || '';
      this.bookSettingsBuchKontext = data.buch_kontext || '';
      this.bookSettingsStilprofil = data.stilprofil || '';
      this.bookSettingsErzaehlperspektive = data.erzaehlperspektive || '';
      this.bookSettingsErzaehlzeit        = data.erzaehlzeit        || '';
      this.bookSettingsIsFinished         = !!data.is_finished;
      this.bookSettingsAllowLektorBookChat = !!data.allow_lektor_book_chat;
      this.bookSettingsDailyGoalChars     = data.daily_goal_chars != null ? Number(data.daily_goal_chars) : 1500;
      this.bookSettingsGoalTargetChars    = data.goal_target_chars != null ? Number(data.goal_target_chars) : 0;
      this.bookSettingsGoalDeadline       = data.goal_deadline || '';
      this.bookSettingsOrteReal           = !!data.orte_real;
      this.bookSettingsSchauplatzLand     = data.schauplatz_land || '';
      this.bookSettingsZeitlinieReal      = !!data.zeitlinie_real;
      this.bookSettingsWeltfaktenRealPruefen = !!data.weltfakten_real_pruefen;
      this.bookSettingsExcludeFromStats   = !!data.exclude_from_stats;
      // Quellen-Tab: derselbe Response traegt Zitierstil + Verzeichnis-Optionen
      // (kein zweiter Fetch), gespeichert wird sie aber ueber den eigenen
      // /citation-Endpunkt — siehe book-settings/citation.js.
      this._applyCitationSettings(data);
    } catch (e) {
      console.error('[book-settings] Laden fehlgeschlagen:', e);
    } finally {
      this.bookSettingsLoading = false;
    }
  },


  // Stilprofil aus dem Buch destillieren (KI-Job). Ergebnis wird serverseitig in
  // book_settings.stilprofil persistiert; bei job:finished (Handler in der Karte)
  // wird nur das Stilprofil-Feld aus dem Job-Result übernommen — der Rest des
  // Formulars (ggf. ungespeicherte Edits) bleibt unangetastet.
  async generateStilprofil() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || this.stilprofilGenerating) return;
    this.stilprofilGenerating = true;
    this.stilprofilError = '';
    try {
      const res = await fetch('/jobs/stilprofil', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: Number(bookId) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(window.__app.tError(data) || `HTTP ${res.status}`);
      this.stilprofilJobId = data.jobId;
      window.dispatchEvent(new CustomEvent(EVT.JOB_ENQUEUED, { detail: { type: 'stilprofil', jobId: data.jobId } }));
    } catch (e) {
      this.stilprofilGenerating = false;
      this.stilprofilError = e.message;
    }
  },


  // Kategorie. Pool global; pro Buch eine Kategorie (optional).
  async loadBookCategory() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) return;
    try {
      const [pool, categoryRes] = await Promise.all([
        fetchJson('/local/categories'),
        fetchJson(`/books/${bookId}/category`),
      ]);
      this.categoryPool = pool.categories || [];
      this.bookCategoryId = categoryRes.category?.id || '';
    } catch (e) {
      console.error('[book-settings] Kategorie laden fehlgeschlagen:', e);
    }
  },


  bookCategoryOptions() {
    return (this.categoryPool || []).map(c => ({ value: String(c.id), label: c.name }));
  },


  async saveBookCategory(value) {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) return;
    // value aus combobox-change-Event-Detail; x-modelable-Sync zu bookCategoryId
    // ist beim Dispatch noch nicht propagiert (stale read).
    const raw = value !== undefined ? value : this.bookCategoryId;
    const cid = raw === '' || raw === null || raw === undefined ? null : parseInt(raw, 10);
    try {
      const r = await fetch(`/books/${bookId}/category`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category_id: cid }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(window.__app.tError(data) || `HTTP ${r.status}`);
      }
      await window.__app.loadBooks({ skipPages: true });
    } catch (e) {
      this.bookSettingsError = e.message;
    }
  },


  // Ein Header-Save-Button schreibt ALLE Stores der Karte: book_settings
  // (/booksettings), book_publication (/publication) und die Quellenverzeichnis-
  // Felder (/booksettings/:id/citation). Drei unabhängige Writes auf getrennte
  // Spalten/Tabellen — ein Klick persistiert alles, egal in welchem
  // Tab editiert wurde (Titelei/Klappentext im Publikation-Tab, Zitierstil im
  // Quellen-Tab, Sprache/Kontext/Tagesziel in den anderen). Alle laufen
  // parallel; die Header-Status-
  // Getter aggregieren über beide. Methoden (keine Getter) — bookSettingsMethods
  // wird gespreadet, Getter würden beim Spread eval't statt durchgereicht.
  // Pflichtfelder beim Speichern: Buchtyp immer (alle KI-Jobs ziehen den Genre-
  // Kontext via getBookPrompts), Kategorie nur wenn der globale Pool nicht leer
  // ist (sonst gäbe es nichts auszuwählen → Save-Blockade). Liefert den i18n-Key
  // des ersten verletzten Felds oder null.
  _taxonomyError() {
    if (!this.bookSettingsBuchtyp) return 'book.settings.buchtypRequired';
    if ((this.categoryPool || []).length > 0 && !this.bookCategoryId) return 'book.category.required';
    return null;
  },


  async saveActiveTab() {
    const taxErr = this._taxonomyError();
    if (taxErr) { this.bookSettingsError = window.__app.t(taxErr); return; }
    await Promise.all([this.saveBookSettings(), this.savePublication(), this.saveCitationSettings()]);
  },

  headerSaving()   { return this.bookSettingsSaving || this.pubSaving || this.citationSaving; },

  headerError()    { return this.bookSettingsError || this.pubError || this.citationError; },

  headerSaved()    { return (this.bookSettingsSaved || this.pubSaved || this.citationSaved) && !this.headerError(); },

  headerDisabled() { return this.bookSettingsSaving || this.pubSaving || this.citationSaving || this.bookSettingsLoading; },


  async saveBookSettings() {
    if (!Alpine.store('nav').selectedBookId) return;
    this.bookSettingsSaving = true;
    this.bookSettingsSaved  = false;
    this.bookSettingsError  = '';
    try {
      const bookId = Alpine.store('nav').selectedBookId;
      const currentBook = Alpine.store('nav').books.find(b => String(b.id) === String(bookId));
      const newName = (this.bookSettingsName || '').trim();
      if (!newName) throw new Error(window.__app.t('book.create.errorEmpty'));
      if (newName !== (currentBook?.name || '')) {
        await contentRepo.updateBook(bookId, { name: newName });
      }
      const r = await fetch(`/booksettings/${Alpine.store('nav').selectedBookId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          language:          this.bookSettingsLanguage,
          region:            this.bookSettingsRegion,
          buchtyp:           this.bookSettingsBuchtyp              || null,
          buch_kontext:      this.bookSettingsBuchKontext          || null,
          stilprofil:        this.bookSettingsStilprofil           || null,
          erzaehlperspektive: this.bookSettingsErzaehlperspektive  || null,
          erzaehlzeit:       this.bookSettingsErzaehlzeit          || null,
          is_finished:       this.bookSettingsIsFinished ? 1 : 0,
          allow_lektor_book_chat: this.bookSettingsAllowLektorBookChat ? 1 : 0,
          daily_goal_chars:  Number.isFinite(Number(this.bookSettingsDailyGoalChars)) ? Number(this.bookSettingsDailyGoalChars) : null,
          // Ziel < 1000 (inkl. 0/leer) = kein Ziel → null. Deadline leer → null.
          goal_target_chars: Number(this.bookSettingsGoalTargetChars) >= 1000 ? Math.round(Number(this.bookSettingsGoalTargetChars)) : null,
          goal_deadline:     this.bookSettingsGoalDeadline || null,
          orte_real:         this.bookSettingsOrteReal ? 1 : 0,
          schauplatz_land:   this.bookSettingsSchauplatzLand || null,
          zeitlinie_real:    this.bookSettingsZeitlinieReal ? 1 : 0,
          weltfakten_real_pruefen: this.bookSettingsWeltfaktenRealPruefen ? 1 : 0,
          exclude_from_stats: this.bookSettingsExcludeFromStats ? 1 : 0,
        }),
      });
      if (!r.ok) {
        let data = null;
        try { data = await r.json(); } catch (_) {}
        throw new Error(data ? window.__app.tError(data) : `HTTP ${r.status}`);
      }
      this.bookSettingsSaved = true;
      const newBuchtyp = this.bookSettingsBuchtyp || null;
      const buchtypChanged = (currentBook?.buchtyp ?? null) !== newBuchtyp;
      if (newName !== (currentBook?.name || '') || buchtypChanged) {
        // Buchtyp-Wechsel MUSS den Pagetree neu laden (skipPages: false), weil
        // nur loadPages den sidebarMode (Tagebuch → Kalender, sonst Tree) aus
        // isTagebuch() ableitet. Reiner Rename bleibt metadaten-only (skipPages),
        // damit der Pagetree nicht unnötig flackert.
        await window.__app.loadBooks?.({ skipPages: !buchtypChanged, fresh: true });
      }
      // Header-Donut konsumiert dailyProgressIsFinished + dailyProgressDailyGoalChars
      // aus Alpine.store('progress') — direkt spiegeln, damit Toggle Buch-Abschluss
      // und neues Tagesziel ohne Reload greifen.
      if (window.Alpine) {
        const progress = window.Alpine.store('progress');
        progress.dailyProgressIsFinished = !!this.bookSettingsIsFinished;
        progress.dailyProgressDailyGoalChars = Number.isFinite(Number(this.bookSettingsDailyGoalChars))
          ? Number(this.bookSettingsDailyGoalChars) : null;
      }
      if (this._savedAtTimer) clearTimeout(this._savedAtTimer);
      this._savedAtTimer = setTimeout(() => { this.bookSettingsSaved = false; this._savedAtTimer = null; }, 2500);
    } catch (e) {
      this.bookSettingsError = e.message;
    } finally {
      this.bookSettingsSaving = false;
    }
  },


  // ── Publikation (book_publication: Cover/Titelei/Bio, geteilt mit PDF+EPUB) ──
  async loadPublication() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) return;
    try {
      this.bookPublication = await fetchJson(`/publication/${bookId}`);
      this.bookPublicationLoaded = true;
    } catch (e) {
      console.error('[book-settings] Publikation laden fehlgeschlagen:', e);
    }
  },


  async savePublication() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) return;
    // Nicht speichern, bevor die volle Meta geladen ist — der strikte Full-
    // Replace-Upsert würde den DB-Stand sonst mit leeren Defaults überschreiben.
    // saveActiveTab ruft uns auf jedem Save-Klick auf, auch ohne Publikations-Edit.
    if (!this.bookPublicationLoaded) return;
    this.pubSaving = true; this.pubSaved = false; this.pubError = '';
    try {
      // Volle geladene Meta zurueckschreiben — der strikte Upsert setzt jedes
      // NICHT gesendete Feld auf Default. Spread statt Hand-Liste: validateMeta
      // whitelistet serverseitig (Extra-Keys wie has_cover ignoriert), so dass
      // auch die EPUB-Card-eigenen Felder (Typografie/OPF) erhalten bleiben.
      const p = this.bookPublication || {};
      const r = await fetch(`/publication/${bookId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...p }),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(window.__app.tError(d) || `HTTP ${r.status}`); }
      this.bookPublication = await r.json();
      this.pubSaved = true;
      if (this._pubSavedTimer) clearTimeout(this._pubSavedTimer);
      this._pubSavedTimer = setTimeout(() => { this.pubSaved = false; this._pubSavedTimer = null; }, 2500);
    } catch (e) {
      this.pubError = e.message;
    } finally {
      this.pubSaving = false;
    }
  },


  // Co-Autoren (Schreib-Duos) + freie Vor-/Nachsatz-Seiten: rein lokale Array-
  // Mutation der geladenen Meta. Persistiert wie alles andere ueber savePublication
  // (Full-Replace-Spread → der Server validiert/serialisiert via validateMeta).
  addCoAuthor() {
    if (!this.bookPublication) return;
    if (!Array.isArray(this.bookPublication.co_authors)) this.bookPublication.co_authors = [];
    this.bookPublication.co_authors.push({ name: '', file_as: '' });
  },

  removeCoAuthor(i) {
    this.bookPublication?.co_authors?.splice(i, 1);
  },

  addExtraSection() {
    if (!this.bookPublication) return;
    if (!Array.isArray(this.bookPublication.extra_sections)) this.bookPublication.extra_sections = [];
    this.bookPublication.extra_sections.push({ placement: 'back', title: '', body: '', link_url: '', link_label: '', toc: true });
  },

  removeExtraSection(i) {
    this.bookPublication?.extra_sections?.splice(i, 1);
  },


  async uploadPublicationCover(file) {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!file || !bookId) return;
    this.pubCoverUploading = true; this.pubCoverError = '';
    try {
      const r = await fetch(`/publication/${bookId}/cover`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
      if (!r.ok) { const d = await r.json().catch(() => ({})); this.pubCoverError = window.__app.tError(d) || window.__app.t('publication.imageInvalid'); return; }
      this.pubPreviewVersion++;
      await this.loadPublication();
    } finally {
      this.pubCoverUploading = false;
    }
  },


  async removePublicationCover() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) return;
    const r = await fetch(`/publication/${bookId}/cover`, { method: 'DELETE' });
    if (!r.ok) return;
    this.pubPreviewVersion++;
    await this.loadPublication();
  },


  publicationCoverUrl() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!this.bookPublication?.has_cover || !bookId) return '';
    return `/publication/${bookId}/cover?v=${this.pubPreviewVersion}`;
  },


  async uploadPublicationAuthorImage(file) {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!file || !bookId) return;
    this.pubAuthorUploading = true; this.pubAuthorError = '';
    try {
      const r = await fetch(`/publication/${bookId}/author-image`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
      if (!r.ok) { const d = await r.json().catch(() => ({})); this.pubAuthorError = window.__app.tError(d) || window.__app.t('publication.imageInvalid'); return; }
      this.pubPreviewVersion++;
      await this.loadPublication();
    } finally {
      this.pubAuthorUploading = false;
    }
  },


  async removePublicationAuthorImage() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) return;
    const r = await fetch(`/publication/${bookId}/author-image`, { method: 'DELETE' });
    if (!r.ok) return;
    this.pubPreviewVersion++;
    await this.loadPublication();
  },


  publicationAuthorImageUrl() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!this.bookPublication?.has_author_image || !bookId) return '';
    return `/publication/${bookId}/author-image?v=${this.pubPreviewVersion}`;
  },


  bookSettingsLocaleDisplay() {
    const map = {
      'de-CH': 'Deutsch (Schweiz)',
      'de-DE': 'Deutsch (Deutschland)',
      'en-US': 'English (USA)',
      'en-GB': 'English (UK)',
    };
    return map[`${this.bookSettingsLanguage}-${this.bookSettingsRegion}`] || `${this.bookSettingsLanguage}-${this.bookSettingsRegion}`;
  },


  /** Gibt die Buchtyp-Liste für die aktuelle Sprache zurück (aus promptConfig). */
  bookSettingsBuchtypen() {
    const lang = this.bookSettingsLanguage || 'de';
    const typen = Alpine.store('shell').promptConfig?.buchtypen?.[lang] || {};
    return Object.entries(typen).map(([key, val]) => ({ key, label: val.label }));
  },


  bookSettingsBuchtypOptions() {
    return this.bookSettingsBuchtypen().map(t => ({ value: t.key, label: t.label }));
  },


  // Gate für die Blog-/HubSpot-Sync-Sections: liest den im Formular gewählten
  // Buchtyp (nicht den gespeicherten Nav-Wert), damit die Sections live auf die
  // Combobox-Auswahl reagieren. SSoT für das 'blog'-Literal im Settings-Scope.
  bookSettingsIsBlog() {
    return this.bookSettingsBuchtyp === 'blog';
  },


  bookSettingsLangOptions() {
    const app = window.__app;
    return [
      { value: 'de', label: app.t('lang.de') },
      { value: 'en', label: app.t('lang.en') },
    ];
  },

  // Region-Optionen werden inline im x-effect gebaut (reaktiv auf
  // bookSettingsLanguage) — Method-Indirection trackt das nicht zuverlässig,
  // siehe DESIGN.md „Reaktivität bei Datenquelle aus Karten-Scope".

  bookSettingsPovOptions() {
    const app = window.__app;
    return [
      { value: 'ich',                label: app.t('book.settings.pov.ich') },
      { value: 'er_sie_personal',    label: app.t('book.settings.pov.er_personal') },
      { value: 'er_sie_auktorial',   label: app.t('book.settings.pov.er_auktorial') },
      { value: 'du',                 label: app.t('book.settings.pov.du') },
      { value: 'wir',                label: app.t('book.settings.pov.wir') },
      { value: 'gemischt',           label: app.t('book.settings.pov.gemischt') },
    ];
  },


  // Haupt-Schauplatzland: ISO-3166-1-alpha-2-Liste, lokalisierte Labels.
  // emptyLabel-Option ('') = „nicht festgelegt", via Combobox-emptyLabel ergänzt.
  bookSettingsLandOptions() {
    const lang = this.bookSettingsLanguage || 'de';
    return countryOptions(lang);
  },


  bookSettingsTempusOptions() {
    const app = window.__app;
    return [
      { value: 'praeteritum', label: app.t('book.settings.tempus.praeteritum') },
      { value: 'praesens',    label: app.t('book.settings.tempus.praesens') },
      { value: 'gemischt',    label: app.t('book.settings.tempus.gemischt') },
    ];
  },
};
