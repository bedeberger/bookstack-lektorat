// Teil von bookSettingsMethods (siehe Facade book-settings.js).
// Quellen-Tab der Bucheinstellungen: Zitierstil, Quellenverzeichnis und
// Abbildungs-Nummerierung (Grundlage der Querverweise auf Abbildungen).
//
// Eigener Schreibpfad `PUT /booksettings/:book_id/citation` (PATCH-artig) statt
// weiterer Felder im Haupt-Body: der Zitierstil gilt buchweit fuer ALLE
// Ausgabewege (PDF, DOCX, EPUB, WordPress, HubSpot) und gehoert damit weder in
// ein Exportprofil noch in die 18-stellige Positionsliste von saveBookSettings.
//
// Der Header-Speichern-Button der Karte schreibt diesen Store mit (siehe
// saveActiveTab in settings.js) — ein Klick persistiert alle Tabs.

import { EVT } from './_shared.js';
import { CITATION_STYLES, DEFAULT_STYLE, formatFull } from '../../sources/format.js';

// Beispielquelle der Live-Vorschau. Bewusst ein bekanntes Werk mit allen
// relevanten Feldern (Urheber, Jahr, Titel, Ort, Verlag) — so unterscheiden sich
// die drei Stile in der Vorschau sichtbar voneinander.
const PREVIEW_SOURCE = Object.freeze({
  csl_type: 'book',
  authors: [{ family: 'Kafka', given: 'Franz' }],
  editors: [],
  title: 'Die Verwandlung',
  year: '1915',
  place: 'Leipzig',
  publisher: 'Kurt Wolff',
});

export const XREF_DEFAULTS = Object.freeze({
  figure_numbering: 0,
});

export const CITATION_DEFAULTS = Object.freeze({
  citation_style: DEFAULT_STYLE,
  bibliography_enabled: 0,
  bibliography_title: '',
  bibliography_scope: 'cited',
  bibliography_in_blog: 0,
});

export const citationMethods = {
  /** Aus dem Settings-Response uebernehmen. Kein eigener Fetch — loadBookSettings
   *  laedt `/booksettings/:id` bereits und der Response enthaelt die
   *  Quellenfelder. */
  _applyCitationSettings(data) {
    this.bookCitation = {
      citation_style: CITATION_STYLES.includes(data?.citation_style)
        ? data.citation_style : DEFAULT_STYLE,
      bibliography_enabled: data?.bibliography_enabled ? 1 : 0,
      bibliography_title: data?.bibliography_title || '',
      bibliography_scope: data?.bibliography_scope === 'all' ? 'all' : 'cited',
      bibliography_in_blog: data?.bibliography_in_blog ? 1 : 0,
    };
    this.bookXref = { figure_numbering: data?.figure_numbering ? 1 : 0 };
    this.bookCitationLoaded = true;
  },

  /** Abbildungs-Nummerierung. Eigener Endpunkt (`PUT /booksettings/:id/xrefs`),
   *  weil es keine Zitier-Einstellung ist — es steht nur im selben Tab, weil
   *  beides zur Fachtext-Ausstattung gehoert und buchweit fuer alle Ausgabewege
   *  gilt. `saveActiveTab` ruft beide Speicherpfade nebeneinander auf. */
  async saveXrefSettings() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || !this.bookCitationLoaded) return;
    try {
      const r = await fetch(`/booksettings/${bookId}/xrefs`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ figure_numbering: this.bookXref?.figure_numbering ? 1 : 0 }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(window.__app.tError(d) || `HTTP ${r.status}`);
      }
      const data = await r.json();
      this.bookXref = { figure_numbering: data?.figure_numbering ? 1 : 0 };
      // Der Ziel-Picker im Editor cacht die Abbildungen samt Vorschau-Nummer;
      // ohne Nummerierung zeigt er den Legendentext. Cache verwerfen.
      window.dispatchEvent(new CustomEvent(EVT.XREFS_CHANGED, { detail: { bookId } }));
    } catch (e) {
      this.citationError = e.message;
    }
  },

  async saveCitationSettings() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) return;
    // Nicht speichern, bevor der Stand geladen ist: der Endpunkt ist zwar
    // PATCH-artig, wir senden aber alle fuenf Felder — ein ungeladener Default
    // wuerde den DB-Stand ueberschreiben. saveActiveTab ruft uns bei JEDEM
    // Speichern-Klick auf, auch ohne Quellen-Edit.
    if (!this.bookCitationLoaded) return;
    this.citationSaving = true;
    this.citationSaved = false;
    this.citationError = '';
    try {
      const c = this.bookCitation;
      const r = await fetch(`/booksettings/${bookId}/citation`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          citation_style: c.citation_style,
          bibliography_enabled: c.bibliography_enabled ? 1 : 0,
          bibliography_title: (c.bibliography_title || '').trim() || null,
          bibliography_scope: c.bibliography_scope,
          bibliography_in_blog: c.bibliography_in_blog ? 1 : 0,
        }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(window.__app.tError(d) || `HTTP ${r.status}`);
      }
      this._applyCitationSettings(await r.json());
      this.citationSaved = true;
      // Der Kurzbeleg-Chip im Editor formatiert nach `citationStyleForCurrentBook`
      // (Root-State, gesetzt beim Buchwechsel). Nach einem Stilwechsel sofort
      // spiegeln, sonst schreibt der naechste eingefuegte Chip noch im alten Stil.
      window.__app.citationStyleForCurrentBook = this.bookCitation.citation_style;
      // Der Beleg-Picker cacht die Quellenliste je Buch; sein Label haengt am
      // Stil. Cache verwerfen, damit die Trefferliste neu formatiert.
      window.dispatchEvent(new CustomEvent(EVT.SOURCES_CHANGED, { detail: { bookId } }));
      if (this._citationSavedTimer) clearTimeout(this._citationSavedTimer);
      this._citationSavedTimer = setTimeout(() => {
        this.citationSaved = false;
        this._citationSavedTimer = null;
      }, 2500);
    } catch (e) {
      this.citationError = e.message;
    } finally {
      this.citationSaving = false;
    }
  },

  citationStyleOptions() {
    const app = window.__app;
    return CITATION_STYLES.map(s => ({ value: s, label: app.t(`sources.style.${s}`) }));
  },

  citationScopeOptions() {
    const app = window.__app;
    return [
      { value: 'cited', label: app.t('book.settings.cite.scope.cited') },
      { value: 'all',   label: app.t('book.settings.cite.scope.all') },
    ];
  },

  /** Live-Vorschau eines Verzeichniseintrags im gewaehlten Stil, in der Sprache
   *  des BUCHS (nicht der UI-Locale) — genau so landet er spaeter im Export. */
  citationPreview() {
    return formatFull(PREVIEW_SOURCE, {
      style: this.bookCitation?.citation_style || DEFAULT_STYLE,
      lang: this.bookSettingsLanguage || 'de',
    });
  },

  /** Sprung in die Quellen-Karte („Quellen verwalten"). Die Karten sind
   *  exklusiv — der Toggle schliesst die Bucheinstellungen. */
  openSourcesCard() {
    window.__app.toggleSourcesCard();
  },
};
