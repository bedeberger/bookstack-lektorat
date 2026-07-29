// Fachmodul der Quellen-Karte (Quellenverzeichnis): Laden, Filtern, CRUD,
// Fundstellen-Panel. Wird in Alpine.data('sourcesCard') gespreadet
// (public/js/cards/sources-card.js); Root-Zugriffe laufen ueber window.__app.
//
// Rein kuratierend: die Karte verwaltet die Quelle, nie den Buchtext. Wo eine
// Quelle belegt wird, entscheidet allein der Quellen-Marker im Seiten-HTML —
// `source_citations` ist dessen Ableitung und hier nur Lesestoff („n× zitiert").
//
// Nach JEDER Mutation geht `EVT.SOURCES_CHANGED` raus: der Beleg-Picker im
// Notebook-Editor cacht die Quellenliste je Buch und verwirft sie darauf
// (editor/notebook/toolbar/cite.js#invalidateSourceCache). Ohne das Event zeigt
// er die alte Liste bis zum Buchwechsel.

import { fetchJson } from '../utils.js';
import { EVT } from '../events.js';
import { formatFull } from './format.js';
import {
  SOURCE_TYPES, DEFAULT_SOURCE_TYPE,
  fieldsForType, draftFromSource, draftToPayload, draftHasIdentity,
  primaryPersonLabel,
} from './fields.js';

const SAVED_FLASH_MS = 2500;

function _bookId() {
  return window.Alpine?.store('nav')?.selectedBookId || null;
}

async function _send(url, method, payload) {
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  if (!r.ok) {
    // Roh-Fetch statt fetchJson, weil nur so der `error_code` erhalten bleibt —
    // CITEKEY_TAKEN und SOURCE_IDENTITY_REQ brauchen eine eigene Meldung.
    const data = await r.json().catch(() => ({}));
    throw new Error(window.__app.tError(data) || `HTTP ${r.status}`);
  }
  return r.json().catch(() => ({}));
}

export const sourcesMethods = {
  // ── Laden ──────────────────────────────────────────────────────────────────
  async loadSources() {
    const bookId = _bookId();
    if (!bookId) return;
    const first = this.sources.length === 0;
    if (first) this.sourcesLoading = true;
    else this.sourcesRefreshing = true;
    this.sourcesError = '';
    this._memos = {};
    try {
      // Archivierte kommen immer mit; das Ausblenden passiert clientseitig, damit
      // der Archiv-Schalter kein Roundtrip ist und die Zaehler stimmen.
      const list = await fetchJson(`/sources?book_id=${encodeURIComponent(bookId)}&archived=1`);
      this.sources = Array.isArray(list) ? list : [];
      this._memos = {};
    } catch (e) {
      this.sourcesError = window.__app.t('sources.loadError');
      console.error('[sources] Laden fehlgeschlagen:', e);
    } finally {
      this.sourcesLoading = false;
      this.sourcesRefreshing = false;
    }
    // Kennzahlen hinterher und ohne await auf den Listenpfad: sie sind ein
    // Nebenwert, ihr Fehlschlag darf die Tabelle nicht blockieren.
    this.loadQuoteStats();
  },

  /** Zitat-Kennzahlen des Buchs (Zitat-Anteil + woertlich/Paraphrase).
   *  Fehler bleiben still — die Zahlen sind Zusatzinformation, kein Inhalt. */
  async loadQuoteStats() {
    const bookId = _bookId();
    if (!bookId) { this.quoteStats = null; return; }
    try {
      const s = await fetchJson(`/sources/stats?book_id=${encodeURIComponent(bookId)}`);
      this.quoteStats = s && typeof s === 'object' ? s : null;
    } catch (e) {
      this.quoteStats = null;
      console.error('[sources] Zitat-Kennzahlen fehlgeschlagen:', e);
    }
  },

  /** Zitat-Anteil als Prozent-String, oder '' wenn er nicht aussagekräftig ist.
   *
   *  Der Nenner kommt aus `page_stats`; ist noch keine Seite synchronisiert
   *  (`stat_pages === 0`), gäbe es einen Anteil ohne Grundgesamtheit — dann lieber
   *  nichts anzeigen als eine erfundene Quote. */
  quoteSharePercent() {
    const s = this.quoteStats;
    if (!s || !s.stat_pages || s.quote_share == null) return '';
    const pct = s.quote_share * 100;
    const locale = this._uiLocale() === 'en' ? 'en-US' : 'de-CH';
    return `${pct.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;
  },

  resetSources() {
    this.sources = [];
    this.sourcesError = '';
    this.quoteStats = null;
    this._memos = {};
    this.cancelSourceEdit();
    this.closeSourceCitations();
  },

  // ── Filter + Tabelle ───────────────────────────────────────────────────────
  // Cache hit nur, wenn alle Deps identisch sind. `sources` steht drin, damit
  // ein Reload neu rechnet, die drei Filterwerte, weil sie das Ergebnis formen,
  // und die UI-Locale, weil die Zeilen lokalisierte Typ-Labels backen.
  _memo(key, deps, compute) {
    const memos = this._memos;
    const hit = memos[key];
    if (hit && hit.deps.length === deps.length
        && hit.deps.every((d, i) => d === deps[i])) {
      return hit.value;
    }
    const value = compute();
    memos[key] = { deps: [...deps], value };
    return value;
  },

  _uiLocale() {
    return window.Alpine?.store('shell')?.uiLocale || 'de';
  },

  /** Tabellenzeilen: die Quelle plus die abgeleiteten Sortier-/Anzeigewerte.
   *  `_author` und `_typeLabel` muessen flache Strings auf der Zeile sein —
   *  sortableTable sortiert ueber Row-Properties, nicht ueber Methodenaufrufe. */
  _computeSourceRows(list) {
    return list.map(s => ({
      ...s,
      _author: primaryPersonLabel(s),
      _typeLabel: this.sourceTypeLabel(s.csl_type),
    }));
  },

  sourceRows() {
    // `_uiLocale()` in den Deps, weil die Zeilen ein lokalisiertes Typ-Label
    // backen — ohne den Dep bleibt es nach einem Sprachwechsel stehen.
    return this._memo('rows', [
      this.sources, this.srcFilterText, this.srcFilterType,
      this.srcShowArchived, this._uiLocale(),
    ], () => {
      const q = (this.srcFilterText || '').trim().toLowerCase();
      const type = this.srcFilterType || '';
      let list = this.sources;
      if (!this.srcShowArchived) list = list.filter(s => !s.archived);
      if (type) list = list.filter(s => s.csl_type === type);
      if (q) list = list.filter(s => this._sourceHaystack(s).includes(q));
      return this._computeSourceRows(list);
    });
  },

  _sourceHaystack(s) {
    const persons = [...(s.authors || []), ...(s.editors || [])]
      .map(p => `${p.family || ''} ${p.given || ''} ${p.literal || ''}`).join(' ');
    return [s.title, s.container_title, s.publisher, s.place, s.year, s.citekey, persons]
      .filter(Boolean).join(' ').toLowerCase();
  },

  /** Sichtbare Gesamtzahl fuer die Filter-Bar (ohne Filter, aber mit
   *  Archiv-Schalter — sonst zeigt „3 / 12" mehr an, als die Liste je zeigt). */
  sourcesVisibleTotal() {
    return this.srcShowArchived
      ? this.sources.length
      : this.sources.filter(s => !s.archived).length;
  },

  sourceTypeLabel(cslType) {
    const t = SOURCE_TYPES.includes(cslType) ? cslType : DEFAULT_SOURCE_TYPE;
    return window.__app.t(`sources.type.${t}`);
  },

  sourceTypeOptions() {
    return SOURCE_TYPES.map(t => ({ value: t, label: this.sourceTypeLabel(t) }));
  },

  /** Badge-Text der Zitier-Spalte. `cite_count` ist die Summe der Belege,
   *  `cite_pages` die Zahl der Seiten — die Karte zeigt die Belege, weil das die
   *  Zahl ist, die beim Loeschen weh tut. */
  sourceCiteLabel(s) {
    const n = s?.cite_count || 0;
    return n > 0
      ? window.__app.t('sources.citedN', { n })
      : window.__app.t('sources.notCited');
  },

  // ── Formular ───────────────────────────────────────────────────────────────
  startCreateSource() {
    this.srcEditingId = 'new';
    this.srcDraft = draftFromSource(null);
    this.srcFormError = '';
    this.closeSourceCitations();
  },

  startEditSource(s) {
    if (!s?.id) return;
    this.srcEditingId = s.id;
    this.srcDraft = draftFromSource(s);
    this.srcFormError = '';
  },

  cancelSourceEdit() {
    this.srcEditingId = null;
    this.srcDraft = draftFromSource(null);
    this.srcFormError = '';
  },

  /** Sichtbare Felder des gewaehlten Typs. Memoized, weil das Template die
   *  Liste im x-for liest und der Typ sich nur per Combobox aendert. */
  srcVisibleFields() {
    return this._memo('fields', [this.srcDraft.csl_type, this._uiLocale()],
      () => fieldsForType(this.srcDraft.csl_type));
  },

  srcCanSave() {
    return !this.sourcesBusy && draftHasIdentity(this.srcDraft);
  },

  /** Live-Vorschau des Verzeichniseintrags im Buch-Zitierstil. Klartext (kein
   *  x-html): der Formatter liefert zwar escapetes HTML, aber ein `x-html`-Sink
   *  fuer User-Eingaben braucht es hier nicht — die Kursivierung ist in der
   *  Vorschau verzichtbar. */
  srcPreview() {
    const app = window.__app;
    return formatFull(draftToPayload(this.srcDraft), {
      style: app?.citationStyleForCurrentBook || 'apa7',
      lang: app?.citationLangForCurrentBook || 'de',
    });
  },

  addSourcePerson(kind) {
    const rows = this.srcDraft[kind];
    if (Array.isArray(rows)) rows.push({ family: '', given: '', literal: '' });
  },

  removeSourcePerson(kind, i) {
    this.srcDraft[kind]?.splice(i, 1);
  },

  async saveSource() {
    const bookId = _bookId();
    if (!bookId || !this.srcCanSave()) return;
    this.sourcesBusy = true;
    this.srcFormError = '';
    try {
      const payload = draftToPayload(this.srcDraft);
      if (this.srcEditingId === 'new') {
        await _send('/sources', 'POST', { book_id: Number(bookId), ...payload });
      } else {
        await _send(`/sources/${this.srcEditingId}`, 'PUT', payload);
      }
      this.cancelSourceEdit();
      await this.loadSources();
      this._sourcesChanged();
      this._flashSourcesSaved();
    } catch (e) {
      this.srcFormError = e.message;
    } finally {
      this.sourcesBusy = false;
    }
  },

  /** Archivieren statt Loeschen: der Verzeichniseintrag verschwindet aus der
   *  Liste und aus dem Beleg-Picker, bestehende Quellenangaben im Text behalten aber
   *  ihr Ziel. Der richtige Weg fuer „brauche ich nicht mehr". */
  async toggleSourceArchived(s) {
    if (!s?.id || this.sourcesBusy) return;
    this.sourcesBusy = true;
    this.sourcesError = '';
    try {
      await _send(`/sources/${s.id}`, 'PUT', { archived: s.archived ? 0 : 1 });
      await this.loadSources();
      this._sourcesChanged();
    } catch (e) {
      this.sourcesError = e.message;
    } finally {
      this.sourcesBusy = false;
    }
  },

  // ── Bibliothek (Pool) ──────────────────────────────────────────────────────
  // Die Quelle gehoert dem User, nicht dem Buch. Der Picker zeigt darum, was in
  // der eigenen Bibliothek liegt und diesem Buch noch NICHT zugeordnet ist —
  // eine Zeile, deren Auswahl nichts bewirkt, gehoert nicht in die Liste.

  async toggleSourcePicker() {
    if (this.srcPickerOpen) { this.closeSourcePicker(); return; }
    this.cancelSourceEdit();
    this.closeSourceCitations();
    this.srcPickerOpen = true;
    await this.loadSourcePool();
  },

  closeSourcePicker() {
    this.srcPickerOpen = false;
    this.srcPool = [];
    this.srcPoolFilter = '';
    this.srcPoolError = '';
    this._memos = {};
  },

  async loadSourcePool() {
    const bookId = _bookId();
    if (!bookId) return;
    this.srcPoolLoading = true;
    this.srcPoolError = '';
    try {
      const list = await fetchJson(
        `/sources/pool?exclude_book_id=${encodeURIComponent(bookId)}`
      );
      this.srcPool = Array.isArray(list) ? list : [];
      this._memos = {};
    } catch (e) {
      this.srcPoolError = window.__app.t('sources.picker.loadError');
      console.error('[sources] Bibliothek laden fehlgeschlagen:', e);
    } finally {
      this.srcPoolLoading = false;
    }
  },

  srcPoolRows() {
    return this._memo('pool', [this.srcPool, this.srcPoolFilter, this._uiLocale()], () => {
      const q = (this.srcPoolFilter || '').trim().toLowerCase();
      const list = q ? this.srcPool.filter(s => this._sourceHaystack(s).includes(q)) : this.srcPool;
      return this._computeSourceRows(list);
    });
  },

  /** Quelle aus der Bibliothek diesem Buch zuordnen. Kein Kopieren: beide
   *  Arbeiten zeigen danach auf denselben Eintrag, eine Korrektur wirkt in
   *  beiden. */
  async addSourceFromLibrary(s) {
    const bookId = _bookId();
    if (!s?.id || !bookId || this.sourcesBusy) return;
    this.sourcesBusy = true;
    this.srcPoolError = '';
    try {
      await _send(`/sources/${s.id}/link`, 'POST', { book_id: Number(bookId) });
      this.srcPool = this.srcPool.filter(p => p.id !== s.id);
      this._memos = {};
      await this.loadSources();
      this._sourcesChanged();
      this.sourcesNotice = window.__app.t('sources.picker.added', {
        title: s.title || window.__app.t('sources.untitled'),
      });
      this._flashSourcesNotice();
    } catch (e) {
      this.srcPoolError = e.message;
    } finally {
      this.sourcesBusy = false;
    }
  },

  /** Aus DIESER Arbeit entfernen — der Bibliothekseintrag bleibt und ist ueber
   *  den Picker jederzeit wieder zuordenbar. Der Gegenpol zu deleteSource, das
   *  in allen Arbeiten wirkt. */
  async unlinkSourceFromBook(s) {
    const bookId = _bookId();
    if (!s?.id || !bookId || this.sourcesBusy) return;
    const app = window.__app;
    const n = s.cite_count || 0;
    const title = s.title || app.t('sources.untitled');
    const ok = await app.appConfirm({
      message: n > 0
        ? app.t('sources.remove.confirmCited', { n, title })
        : app.t('sources.remove.confirm', { title }),
      confirmLabel: app.t('sources.remove.action'),
      danger: n > 0,
    });
    if (!ok) return;

    this.sourcesBusy = true;
    this.sourcesError = '';
    try {
      const res = await _send(`/sources/${s.id}/link?book_id=${encodeURIComponent(bookId)}`, 'DELETE');
      if (this.srcEditingId === s.id) this.cancelSourceEdit();
      if (this.srcCitationsId === s.id) this.closeSourceCitations();
      await this.loadSources();
      if (this.srcPickerOpen) await this.loadSourcePool();
      this._sourcesChanged();
      const orphaned = res?.orphaned_citations || 0;
      this.sourcesNotice = orphaned > 0
        ? app.t('sources.removedOrphaned', { n: orphaned })
        : app.t('sources.removed');
      this._flashSourcesNotice();
    } catch (e) {
      this.sourcesError = e.message;
    } finally {
      this.sourcesBusy = false;
    }
  },

  /** Nur der Besitzer darf den Bibliothekseintrag aendern oder loeschen — er
   *  liegt in dessen anderen Arbeiten mit drin. Ein Co-Autor nimmt die Quelle
   *  stattdessen aus dem Buch (unlinkSourceFromBook) oder legt eine eigene an;
   *  der Server setzt dieselbe Grenze (403 NOT_SOURCE_OWNER). */
  srcIsOwner(s) {
    const me = window.Alpine?.store('session')?.currentUser?.email || '';
    return !!me && s?.owner_email === me;
  },

  /** Aus der Bibliothek loeschen — wirkt in ALLEN Arbeiten. Die Fundstellen
   *  verschwinden per FK-CASCADE, die Quellen-Marker im Seiten-HTML bleiben
   *  stehen und werden zu Quellenangaben ohne Ziel. Der Dialog warnt darum mit
   *  der Zahl der Belege UND, wenn die Quelle in mehreren Arbeiten liegt, mit
   *  deren Anzahl — sonst loescht man aus Buch A und merkt in Buch B nichts. */
  async deleteSource(s) {
    if (!s?.id || this.sourcesBusy) return;
    const app = window.__app;
    const n = s.cite_count || 0;
    const title = s.title || app.t('sources.untitled');

    // Die Buchliste kennt nur der Besitzer (Server-403 fuer alle anderen) — sie
    // ist Zusatzinfo, keine Vorbedingung fuer den Dialog.
    let books = 0;
    try {
      const rows = await fetchJson(`/sources/${s.id}/books`);
      books = Array.isArray(rows) ? rows.length : 0;
    } catch { /* ohne die Zahl fragt der Dialog eben nur nach den Belegen */ }

    const message = books > 1
      ? app.t('sources.delete.confirmBooks', { n: books, title })
      : (n > 0
        ? app.t('sources.delete.confirmCited', { n, title })
        : app.t('sources.delete.confirm', { title }));
    const ok = await app.appConfirm({
      message,
      confirmLabel: app.t('common.delete'),
      danger: true,
    });
    if (!ok) return;

    this.sourcesBusy = true;
    this.sourcesError = '';
    try {
      const res = await _send(`/sources/${s.id}`, 'DELETE');
      if (this.srcEditingId === s.id) this.cancelSourceEdit();
      if (this.srcCitationsId === s.id) this.closeSourceCitations();
      await this.loadSources();
      this._sourcesChanged();
      const orphaned = res?.orphaned_citations || 0;
      this.sourcesNotice = orphaned > 0
        ? app.t('sources.deletedOrphaned', { n: orphaned })
        : app.t('sources.deleted');
      this._flashSourcesNotice();
    } catch (e) {
      this.sourcesError = e.message;
    } finally {
      this.sourcesBusy = false;
    }
  },

  // ── Fundstellen ────────────────────────────────────────────────────────────
  async openSourceCitations(s) {
    if (!s?.id) return;
    if (this.srcCitationsId === s.id) { this.closeSourceCitations(); return; }
    this.srcCitationsId = s.id;
    this.srcCitations = [];
    this.srcCitationsError = '';
    this.srcCitationsLoading = true;
    try {
      const rows = await fetchJson(`/sources/${s.id}/citations`);
      // Nach dem await gegenpruefen: der User kann in der Zwischenzeit eine
      // andere Zeile aufgeklappt haben.
      if (this.srcCitationsId !== s.id) return;
      this.srcCitations = Array.isArray(rows) ? rows : [];
    } catch (e) {
      if (this.srcCitationsId !== s.id) return;
      this.srcCitationsError = window.__app.t('sources.citations.loadError');
      console.error('[sources] Fundstellen laden fehlgeschlagen:', e);
    } finally {
      if (this.srcCitationsId === s.id) this.srcCitationsLoading = false;
    }
  },

  /** Quelle, deren Fundstellen offen sind — fuer die Panel-Ueberschrift. */
  srcCitationsSource() {
    if (this.srcCitationsId == null) return null;
    return this.sources.find(s => s.id === this.srcCitationsId) || null;
  },

  closeSourceCitations() {
    this.srcCitationsId = null;
    this.srcCitations = [];
    this.srcCitationsError = '';
    this.srcCitationsLoading = false;
  },

  /** Sprung zur Fundstelle. Die Karte ist exklusiv — `gotoPageById` schliesst
   *  sie und oeffnet den Notebook-Editor auf der Seite. */
  gotoSourceCitation(c) {
    if (c?.page_id == null) return;
    window.__app.gotoPageById(c.page_id);
  },

  // ── Intern ─────────────────────────────────────────────────────────────────
  _sourcesChanged() {
    const bookId = _bookId();
    window.dispatchEvent(new CustomEvent(EVT.SOURCES_CHANGED, { detail: { bookId } }));
  },

  _flashSourcesSaved() {
    this.sourcesSaved = true;
    if (this._sourcesSavedTimer) clearTimeout(this._sourcesSavedTimer);
    this._sourcesSavedTimer = setTimeout(() => {
      this.sourcesSaved = false;
      this._sourcesSavedTimer = null;
    }, SAVED_FLASH_MS);
  },

  _flashSourcesNotice() {
    if (this._sourcesNoticeTimer) clearTimeout(this._sourcesNoticeTimer);
    this._sourcesNoticeTimer = setTimeout(() => {
      this.sourcesNotice = '';
      this._sourcesNoticeTimer = null;
    }, SAVED_FLASH_MS * 2);
  },
};
