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
      this._publishIdeenCount();
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
    this.movingId = null;
    this.moveTargetId = '';
    this.menuOpenId = null;
    this._detachMenuListeners?.();
    this.errorMessage = '';
    this.busy = false;
  },

  // ── Meatball-Menu (Popover) ───────────────────────────────────────────────
  openMenu(ev, idee) {
    if (this.menuOpenId === idee.id) { this.closeMenu(); return; }
    const r = ev.currentTarget.getBoundingClientRect();
    const PW = 200;
    const PH = 200;
    const left = Math.max(8, Math.min(window.innerWidth - PW - 8, r.right - PW));
    const top  = (r.bottom + PH + 8 > window.innerHeight)
      ? Math.max(8, r.top - PH - 4)
      : r.bottom + 4;
    this.menuPos = { top, left };
    this.menuOpenId = idee.id;
    this._attachMenuListeners();
  },

  closeMenu() {
    this.menuOpenId = null;
    this._detachMenuListeners();
  },

  // Plain Methode statt Getter — siehe Hinweis bei offeneIdeen().
  menuOpenIdee() {
    if (this.menuOpenId == null) return null;
    return (this.ideen || []).find(i => i.id === this.menuOpenId) || null;
  },

  _attachMenuListeners() {
    if (this._menuCloseHandler) return;
    this._menuCloseHandler = () => this.closeMenu();
    window.addEventListener('scroll', this._menuCloseHandler, true);
    window.addEventListener('resize', this._menuCloseHandler);
  },

  _detachMenuListeners() {
    if (!this._menuCloseHandler) return;
    window.removeEventListener('scroll', this._menuCloseHandler, true);
    window.removeEventListener('resize', this._menuCloseHandler);
    this._menuCloseHandler = null;
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
      this._publishIdeenCount();
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
      this._publishIdeenCount();
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
      this._publishIdeenCount();
    } catch (e) {
      this.errorMessage = app.t('ideen.error.save');
    } finally {
      this.busy = false;
    }
  },

  // ── Move ─────────────────────────────────────────────────────────────────
  startMoveIdee(idee) {
    this.movingId = idee.id;
    this.moveTargetId = '';
  },

  cancelMoveIdee() {
    this.movingId = null;
    this.moveTargetId = '';
  },

  // Aus zentralem Picker — Idee wird aus this.movingId geholt.
  async confirmMoveCurrentIdee() {
    const idee = (this.ideen || []).find(i => i.id === this.movingId);
    if (!idee) return;
    return this.confirmMoveIdee(idee);
  },

  async confirmMoveIdee(idee) {
    const app = window.__app;
    const targetId = parseInt(this.moveTargetId, 10);
    if (!targetId) return;
    const target = (app.pages || []).find(p => p.id === targetId);
    if (!target) return;

    this.busy = true;
    try {
      await fetchJson(`/ideen/${idee.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page_id: targetId, page_name: target.name || null }),
      });
      this.ideen = this.ideen.filter(i => i.id !== idee.id);
      this.movingId = null;
      this.moveTargetId = '';
      this.errorMessage = '';
      this._publishIdeenCount();
    } catch (e) {
      this.errorMessage = app.t('ideen.error.move');
    } finally {
      this.busy = false;
    }
  },

  async deleteIdee(idee) {
    const app = window.__app;
    if (!await app.appConfirm({
      message: app.t('ideen.confirmDelete'),
      confirmLabel: app.t('common.delete'),
      danger: true,
    })) return;
    this.busy = true;
    try {
      await fetchJson(`/ideen/${idee.id}`, { method: 'DELETE' });
      this.ideen = this.ideen.filter(i => i.id !== idee.id);
      this.errorMessage = '';
      this._publishIdeenCount();
    } catch (e) {
      this.errorMessage = app.t('ideen.error.delete');
    } finally {
      this.busy = false;
    }
  },

  // ── Helpers ──────────────────────────────────────────────────────────────
  _publishIdeenCount() {
    const app = window.__app;
    const pageId = app?.currentPage?.id;
    if (!pageId) return;
    const count = (this.ideen || []).filter(i => !i.erledigt).length;
    if (app.currentPage?.id === pageId) app.currentPageIdeenOpenCount = count;
  },

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

  // Hinweis: Keine getter — `...ideenMethods`-Spread im Alpine.data-Factory ruft
  // getters sofort auf, mit `this === ideenMethods` (kein `ideen`-Feld) → Crash.
  // Plain Methoden funktionieren identisch im Template via `offeneIdeen()`.
  offeneIdeen() {
    return (this.ideen || []).filter(i => !i.erledigt);
  },
  erledigteIdeen() {
    return (this.ideen || []).filter(i => !!i.erledigt);
  },
};
