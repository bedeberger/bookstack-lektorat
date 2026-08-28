// Alpine.data('myBooksCard') — Sub-Komponente „Meine Buecher": das persoenliche
// Buecherregal. Ueber ALLE fuer den User sichtbaren Buecher (nicht nur eigene),
// mit Kennzahlen pro Buch und den drei Schaltern Anheften / Archivieren /
// Fertig. User-bound, nicht buch-bound — `showMyBooksCard` +
// `toggleMyBooksCard` leben im Root (generiert aus EXCLUSIVE_CARDS).
//
// Drei Schreibwege, bewusst getrennt:
//   • Pin + Archiv → `PUT /me/books/:id` (persoenlich, ab Rolle `viewer`).
//   • Fertig       → `PUT /booksettings/:id/finished` (buchweit, ab `editor`).
//     `is_finished` geht in die Prompts und in den Publikations-Meilenstein
//     (Auto-Fassung) — es bleibt EIN Schalter, hier nur eine zweite Bedienung.
//   • Umbenennen/Loeschen → gibt es hier NICHT. Das ist der Buchorganizer bzw.
//     die Buch-Einstellungen; ein zweiter Loeschpfad neben dem mit Bestaetigung
//     waere die gefaehrlichste Kopie im Haus.
//
// Buchnamen kommen aus `$store.nav.books` (Content-Store-Regel), Kennzahlen aus
// `/me/books` — zusammengefuehrt in my-books-compute.js.

import { EVT } from '../events.js';
import { tzOpts } from '../utils.js';
import {
  SHELF_TABS, mergeShelfRows, filterShelfRows, pinnedFirst, shelfTotals, mayToggleFinished,
} from './my-books-compute.js';

export function registerMyBooksCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('myBooksCard', () => ({
    myBooksRows: [],
    myBooksTab: 'aktiv',
    myBooksQuery: '',
    myBooksLoading: false,
    myBooksError: '',
    myBooksBusyId: null, // Buch, dessen Schalter gerade schreibt (Doppelklick-Guard)
    myBooksTabs: SHELF_TABS,

    init() {
      this.$watch(() => window.__app.showMyBooksCard, (visible) => {
        if (visible) this.loadMyBooks();
      });
      this._onRefresh = (ev) => {
        if (ev?.detail?.name === 'myBooks') this.loadMyBooks();
      };
      window.addEventListener(EVT.CARD_REFRESH, this._onRefresh);
    },

    destroy() {
      if (this._onRefresh) window.removeEventListener(EVT.CARD_REFRESH, this._onRefresh);
    },

    async loadMyBooks() {
      this.myBooksLoading = true;
      this.myBooksError = '';
      try {
        const r = await fetch('/me/books', { credentials: 'same-origin' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const data = await r.json();
        this.myBooksRows = mergeShelfRows(
          data.books || [],
          window.__app.$store.nav.books || [],
          this._categoryNames(),
        );
      } catch (e) {
        this.myBooksError = window.__app.t('common.errorColon') + e.message;
        this.myBooksRows = [];
      } finally {
        this.myBooksLoading = false;
      }
    },

    _categoryNames() {
      const pool = window.__app.bookFilterCategoryPool || [];
      return new Map(pool.map(c => [String(c.id), c.name]));
    },

    // ── Ableitungen fuers Template ─────────────────────────────────────────
    myBooksFiltered() {
      return filterShelfRows(this.myBooksRows, { tab: this.myBooksTab, query: this.myBooksQuery });
    },

    // Angeheftete bleiben oben, auch wenn die Tabelle nach einer Spalte sortiert.
    myBooksOrdered(sortedRows) {
      return pinnedFirst(sortedRows);
    },

    myBooksTotals() {
      return shelfTotals(this.myBooksFiltered());
    },

    myBooksTabCount(tab) {
      return filterShelfRows(this.myBooksRows, { tab, query: this.myBooksQuery }).length;
    },

    get myBooksIsEmpty() {
      return !this.myBooksLoading && !this.myBooksError && this.myBooksRows.length === 0;
    },

    myBooksMayFinish(row) {
      return mayToggleFinished(row?.role);
    },

    // ── Schalter ───────────────────────────────────────────────────────────
    async myBooksTogglePin(row) {
      await this._patchShelf(row, { pinned: !row.pinned });
    },

    async myBooksToggleArchive(row) {
      await this._patchShelf(row, { archived: !row.archived });
    },

    async _patchShelf(row, patch) {
      if (this.myBooksBusyId) return;
      this.myBooksBusyId = row.book_id;
      try {
        const r = await fetch('/me/books/' + row.book_id, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(patch),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const next = await r.json();
        row.pinned = !!next.pinned;
        row.archived = !!next.archived;
        row.pinned_at = next.pinned_at || null;
        row.archived_at = next.archived_at || null;
        // Buchwahl-Combobox liest `pinned`/`archived` aus der Buchliste — ohne
        // Mitschreiben zeigt sie bis zum naechsten Reload die alte Ordnung.
        this._mirrorToNavBooks(row);
      } catch (e) {
        this.myBooksError = window.__app.t('common.errorColon') + e.message;
      } finally {
        this.myBooksBusyId = null;
      }
    },

    async myBooksToggleFinished(row) {
      if (this.myBooksBusyId || !this.myBooksMayFinish(row)) return;
      this.myBooksBusyId = row.book_id;
      try {
        const r = await fetch('/booksettings/' + row.book_id + '/finished', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ is_finished: !row.is_finished }),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const next = await r.json();
        row.is_finished = !!next.is_finished;
        // Der 0→1-Uebergang haelt serverseitig eine Fassung fest; die Zahl in
        // der Spalte stimmt danach nicht mehr. Ehrlicher als eine geschaetzte
        // Erhoehung: einmal frisch laden.
        if (row.is_finished) this.loadMyBooks();
      } catch (e) {
        this.myBooksError = window.__app.t('common.errorColon') + e.message;
      } finally {
        this.myBooksBusyId = null;
      }
    },

    _mirrorToNavBooks(row) {
      const books = window.__app.$store.nav.books || [];
      const b = books.find(x => String(x.id) === String(row.book_id));
      if (b) { b.pinned = row.pinned; b.archived = row.archived; }
    },

    // ── Navigation ─────────────────────────────────────────────────────────
    // Buch oeffnen = auswaehlen + Uebersicht zeigen. Genau der Weg, den die
    // Buchwahl-Combobox nimmt (resetView danach), damit kein zweiter
    // Buchwechsel-Pfad entsteht.
    myBooksOpen(row) {
      const root = window.__app;
      root.showMyBooksCard = false;
      root.$store.nav.selectedBookId = String(row.book_id);
      root.resetView();
    },

    // ── Formatierung ───────────────────────────────────────────────────────
    _myBooksFmt(n) {
      const loc = window.Alpine.store('shell').uiLocale === 'de' ? 'de-CH' : 'en-US';
      return Number(n || 0).toLocaleString(loc);
    },

    myBooksNormpages(chars) {
      return this._myBooksFmt(Math.round((chars || 0) / 1500));
    },

    myBooksDuration(seconds) {
      const total = Math.max(0, Math.round((seconds || 0) / 60));
      const h = Math.floor(total / 60);
      const m = total % 60;
      const t = window.__app.t;
      return h > 0 ? t('mystats.hm', { h: this._myBooksFmt(h), m }) : t('mystats.m', { m });
    },

    // Datum ohne Uhrzeit: die Quelle ist teils tagesgenau (Zeit-Tracker liefert
    // `date`), teils ein Zeitstempel — eine Uhrzeit waere bei der Haelfte der
    // Zeilen erfunden.
    myBooksDate(value) {
      if (!value) return '–';
      const d = new Date(value.length === 10 ? value + 'T12:00:00Z' : value);
      if (Number.isNaN(d.getTime())) return '–';
      const loc = window.Alpine.store('shell').uiLocale === 'de' ? 'de-CH' : 'en-US';
      return d.toLocaleDateString(loc, tzOpts({ year: 'numeric', month: '2-digit', day: '2-digit' }));
    },
  }));
}
