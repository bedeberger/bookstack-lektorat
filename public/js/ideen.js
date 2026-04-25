// Methoden für die Ideen-Karte (Sub-Komponente). Verwaltet User-Notizen
// pro Seite. Offene Ideen werden im Seiten-Chat als Kontext eingespielt
// (Backend-seitig via getOpenIdeen — kein Datentransfer aus dieser Karte).

import { fetchJson } from './utils.js';

export const ideenMethods = {
  // ── Lifecycle ────────────────────────────────────────────────────────────
  async loadIdeen() {
    const app = window.__app;
    const pageId = app?.currentPage?.id;
    if (!pageId) { this.ideen = []; return; }
    this.loading = true;
    try {
      const rows = await fetchJson(`/ideen?page_id=${pageId}`);
      this.ideen = Array.isArray(rows) ? rows : [];
      this.errorMessage = '';
    } catch (e) {
      this.errorMessage = app.t('ideen.error.load');
      this.ideen = [];
    } finally {
      this.loading = false;
    }
  },

  resetIdeen() {
    this.ideen = [];
    this.newContent = '';
    this.editingId = null;
    this.editingDraft = '';
    this.errorMessage = '';
    this.busy = false;
  },

  // ── CRUD ─────────────────────────────────────────────────────────────────
  async addIdee() {
    const app = window.__app;
    const content = (this.newContent || '').trim();
    if (!content) { this.errorMessage = app.t('ideen.error.contentRequired'); return; }
    if (content.length > 4000) { this.errorMessage = app.t('ideen.error.contentTooLong'); return; }
    const page = app.currentPage;
    const bookId = app.selectedBookId;
    if (!page?.id || !bookId) return;

    this.busy = true;
    try {
      const row = await fetchJson('/ideen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          book_id: bookId,
          page_id: page.id,
          page_name: page.name || null,
          content,
        }),
      });
      // Neueste offene Idee nach oben (Liste ist nach erledigt ASC, created_at DESC sortiert)
      this.ideen = [row, ...this.ideen];
      this.newContent = '';
      this.errorMessage = '';
    } catch (e) {
      this.errorMessage = app.t('ideen.error.save');
    } finally {
      this.busy = false;
    }
  },

  startEditIdee(idee) {
    this.editingId = idee.id;
    this.editingDraft = idee.content || '';
  },

  cancelEditIdee() {
    this.editingId = null;
    this.editingDraft = '';
  },

  async saveEditIdee(idee) {
    const app = window.__app;
    const content = (this.editingDraft || '').trim();
    if (!content) { this.errorMessage = app.t('ideen.error.contentRequired'); return; }
    if (content.length > 4000) { this.errorMessage = app.t('ideen.error.contentTooLong'); return; }
    if (content === idee.content) { this.cancelEditIdee(); return; }

    this.busy = true;
    try {
      const row = await fetchJson(`/ideen/${idee.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      this._replaceIdee(row);
      this.editingId = null;
      this.editingDraft = '';
      this.errorMessage = '';
    } catch (e) {
      this.errorMessage = app.t('ideen.error.save');
    } finally {
      this.busy = false;
    }
  },

  async toggleErledigtIdee(idee) {
    const app = window.__app;
    this.busy = true;
    try {
      const row = await fetchJson(`/ideen/${idee.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ erledigt: !idee.erledigt }),
      });
      this._replaceIdee(row);
      // Sort halten: offene oben, erledigte unten — innerhalb je nach created_at DESC
      this.ideen = this._sortIdeen(this.ideen);
      this.errorMessage = '';
    } catch (e) {
      this.errorMessage = app.t('ideen.error.save');
    } finally {
      this.busy = false;
    }
  },

  async deleteIdee(idee) {
    const app = window.__app;
    if (!confirm(app.t('ideen.confirmDelete'))) return;
    this.busy = true;
    try {
      await fetchJson(`/ideen/${idee.id}`, { method: 'DELETE' });
      this.ideen = this.ideen.filter(i => i.id !== idee.id);
      this.errorMessage = '';
    } catch (e) {
      this.errorMessage = app.t('ideen.error.delete');
    } finally {
      this.busy = false;
    }
  },

  // ── Helpers ──────────────────────────────────────────────────────────────
  _replaceIdee(row) {
    this.ideen = this.ideen.map(i => (i.id === row.id ? row : i));
  },

  _sortIdeen(arr) {
    return [...arr].sort((a, b) => {
      if (a.erledigt !== b.erledigt) return a.erledigt - b.erledigt;
      // created_at DESC
      return (b.created_at || '').localeCompare(a.created_at || '');
    });
  },

  get offeneIdeen() {
    return this.ideen.filter(i => !i.erledigt);
  },
  get erledigteIdeen() {
    return this.ideen.filter(i => !!i.erledigt);
  },
};
