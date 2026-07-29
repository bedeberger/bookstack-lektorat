import { EVT } from '../../events.js';

// ACL-Rolle + editor-relevante book_settings-Spiegel pro Buch + abgeleitete
// Rechte-Getter (canEdit/canReview/isViewer) + Buchtyp-Helfer.
// `this` = die Alpine-Komponente.

// Defaults der Zitier-Spiegel — muessen zu CITATION_DEFAULTS in db/schema.js
// passen, damit ein Buch ohne book_settings-Zeile im Editor nicht anders
// formatiert als eines mit.
const CITE_FALLBACK = { style: 'apa7', lang: 'de' };

export const treePermissionsMethods = {
  // Editor-relevante book_settings in den Root spiegeln: Entity-Linking-Toggle
  // sowie Zitierstil + Buchsprache (fuer den Beleg-Chip). Ein Fetch fuer alle
  // drei — beim Buchwechsel. Den Entity-Toggle pflegt die Toolbar danach selbst
  // (optimistisch + PUT). Failsafe: bei Netz-/Permission-Fehler Defaults.
  async _loadBookFlagsForCurrentBook(bookId) {
    const id = bookId ? String(bookId) : '';
    const reset = () => {
      this.entitiesEnabledForCurrentBook = false;
      this.citationStyleForCurrentBook = CITE_FALLBACK.style;
      this.citationLangForCurrentBook = CITE_FALLBACK.lang;
    };
    if (!id) { reset(); return; }
    try {
      const res = await fetch('/booksettings/' + encodeURIComponent(id), {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) { reset(); return; }
      const data = await res.json();
      // Buch kann waehrend des Fetch gewechselt haben → nur uebernehmen, wenn
      // die Antwort noch zum ausgewaehlten Buch gehoert.
      if (String(this.$store.nav.selectedBookId) === id) {
        this.entitiesEnabledForCurrentBook = !!data.entities_enabled;
        this.citationStyleForCurrentBook = data.citation_style || CITE_FALLBACK.style;
        this.citationLangForCurrentBook = data.language || CITE_FALLBACK.lang;
      }
    } catch (_) {
      reset();
    }
  },

  // Toolbar-Toggle aus dem Notebook-Editor — PUTtet nur entities_enabled,
  // dispatcht book:settings:updated damit die Entities-Sub neu rechnet.
  async toggleEntitiesEnabledForCurrentBook() {
    const id = this.$store.nav.selectedBookId;
    if (!id) return;
    if (this._entitiesBusy) return;
    this._entitiesBusy = true;
    const next = !this.entitiesEnabledForCurrentBook;
    this.entitiesEnabledForCurrentBook = next;
    try {
      const res = await fetch('/booksettings/' + encodeURIComponent(id) + '/entities-enabled', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next ? 1 : 0 }),
      });
      if (!res.ok) {
        this.entitiesEnabledForCurrentBook = !next;
        throw new Error('HTTP ' + res.status);
      }
      window.dispatchEvent(new CustomEvent(EVT.BOOK_SETTINGS_UPDATED, { detail: {
        bookId: id, entities_enabled: next ? 1 : 0,
      }}));
    } catch (e) {
      this.entitiesEnabledForCurrentBook = !next;
      console.error('[entities] Toggle fehlgeschlagen:', e);
    } finally {
      this._entitiesBusy = false;
    }
  },

  // ACL-Rolle aus /books/:id/access laden + cachen. Getter
  // `canEdit`/`canReview`/`isViewer` lesen ausschliesslich `currentBookRole`.
  async _loadBookRole(bookId) {
    const id = bookId ? String(bookId) : '';
    if (!id) { this.currentBookRole = null; return; }
    if (Object.prototype.hasOwnProperty.call(this.bookRoles, id)) {
      if (String(this.$store.nav.selectedBookId) === id) this.currentBookRole = this.bookRoles[id];
      return;
    }
    let role = null;
    let shared = false;
    try {
      const res = await fetch('/books/' + encodeURIComponent(id) + '/access', {
        headers: { Accept: 'application/json' },
      });
      if (res.ok) {
        const data = await res.json();
        role = data?.my_role || null;
        shared = Array.isArray(data?.access) && data.access.length > 1;
      }
    } catch (e) {
      // Netzwerk-Fehler → role bleibt null (Legacy-Fallback: canEdit=true)
    }
    this.bookRoles[id] = role;
    this.bookSharedFlags[id] = shared;
    if (String(this.$store.nav.selectedBookId) === id) {
      this.currentBookRole = role;
      // Shared-Flag steht jetzt fest → vollen Poll ggf. starten, ohne den schon
      // laufenden leichten Geraete-Ping (aus _startCollabPoll) abzureissen.
      this._reconcileFullCollabPoll?.(id);
    }
  },

  // Edit-Recht (Page-HTML schreiben): editor + owner. lektor + viewer nein.
  // null = unbekannt → Legacy-Fallback erlaubt Edit (4b enforced serverseitig
  // ohnehin; Frontend-Check ist nur UX, kein Sicherheitsanker).
  canEdit() {
    const r = this.currentBookRole;
    return r === null || r === 'editor' || r === 'owner';
  },
  // Review-Recht (Lektorat-Check, Page-Chat): lektor + editor + owner.
  canReview() {
    const r = this.currentBookRole;
    return r === null || r === 'lektor' || r === 'editor' || r === 'owner';
  },
  isViewer() {
    return this.currentBookRole === 'viewer';
  },

  currentBuchtyp() {
    const id = String(this.$store.nav.selectedBookId || '');
    if (!id) return null;
    const book = (this.$store.nav.books || []).find(b => String(b.id) === id);
    return book?.buchtyp || null;
  },
  isTagebuch() {
    return this.currentBuchtyp?.() === 'tagebuch';
  },
};
