// Teil von bookSettingsMethods (siehe Facade book-settings.js).
import { EVT, contentRepo, fetchJson } from './_shared.js';

export const adminMethods = {

  async loadBookJobStats() {
    if (!Alpine.store('nav').selectedBookId) {
      this.bookJobStats = null;
      return;
    }
    this.bookJobStatsLoading = true;
    try {
      this.bookJobStats = await fetchJson(`/jobs/stats?book_id=${encodeURIComponent(Alpine.store('nav').selectedBookId)}`);
    } catch (e) {
      console.error('[book-settings] Job-Statistiken laden fehlgeschlagen:', e);
      this.bookJobStats = [];
    } finally {
      this.bookJobStatsLoading = false;
    }
  },

  // Zeilen fuer die sortierbare Job-Statistik-Tabelle. Der Server liefert
  // `typeLabel` als i18n-Key und die Zahlenspalten zusaetzlich vorformatiert;
  // sortiert werden muss aber nach dem, was der User SIEHT (uebersetztes Label)
  // bzw. nach dem Rohwert (Dauer/Tokens), nicht nach dem Formatstring.
  bookJobStatsRows() {
    return (this.bookJobStats || []).map(r => ({
      ...r,
      typeName:  window.__app.t(r.typeLabel),
      avgTokens: r.avgTokensIn != null ? (r.avgTokensIn || 0) + (r.avgTokensOut || 0) : null,
    }));
  },


  async resetBookHistory() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) return;
    const book = Alpine.store('nav').books.find(b => String(b.id) === String(bookId));
    const name = book?.name || '';
    if (!await window.__app.appConfirm({
      message: window.__app.t('userSettings.resetConfirm', { name }),
      confirmLabel: window.__app.t('common.delete'),
      danger: true,
    })) return;

    this.bookHistoryResetLoading = true;
    this.bookHistoryResetMessage = '';
    this.bookHistoryResetError   = '';
    try {
      const r = await fetch(`/history/book/${bookId}`, { method: 'DELETE' });
      if (!r.ok) {
        let errData = null;
        try { errData = await r.json(); } catch (_) {}
        throw new Error(errData ? window.__app.tError(errData) : `HTTP ${r.status}`);
      }
      const data = await r.json();
      const d = data.deleted || {};
      this.bookHistoryResetMessage = window.__app.t('userSettings.resetSummary', {
        lektorate: d.page_checks || 0,
        reviews:   d.book_reviews || 0,
        chats:     d.chat_sessions || 0,
      });
      if (String(Alpine.store('nav').selectedBookId) === String(bookId)) {
        window.__app.pageHistory       = [];
        window.__app.bookReviewHistory = [];
        window.dispatchEvent(new CustomEvent(EVT.CHAT_RESET));
      }
      if (this._resetMsgTimer) clearTimeout(this._resetMsgTimer);
      this._resetMsgTimer = setTimeout(() => { this.bookHistoryResetMessage = ''; this._resetMsgTimer = null; }, 6000);
    } catch (e) {
      this.bookHistoryResetError = e.message;
    } finally {
      this.bookHistoryResetLoading = false;
    }
  },


  // Bulk-Cleanup der vom Komplettanalyse-Reconcile aufgelaufenen stale-Altlasten
  // (Figuren/Szenen/Schauplätze, die nicht mehr im Text vorkommen). Räumt nur stale=1,
  // aktive Einträge bleiben unberührt. Je ein Endpunkt pro Entitätstyp (parallel).
  async deleteStaleEntities() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) return;
    if (!await window.__app.appConfirm({
      message: window.__app.t('book.settings.staleCleanupConfirm'),
      confirmLabel: window.__app.t('common.delete'),
      danger: true,
    })) return;

    this.staleCleanupLoading = true;
    this.staleCleanupMessage = '';
    this.staleCleanupError   = '';
    try {
      const [figRes, sceneRes, locRes] = await Promise.all([
        fetch(`/figures/${bookId}/stale`, { method: 'DELETE' }),
        fetch(`/figures/scenes/${bookId}/stale`, { method: 'DELETE' }),
        fetch(`/locations/${bookId}/stale`, { method: 'DELETE' }),
      ]);
      for (const r of [figRes, sceneRes, locRes]) {
        if (!r.ok) {
          let errData = null;
          try { errData = await r.json(); } catch (_) {}
          throw new Error(errData ? window.__app.tError(errData) : `HTTP ${r.status}`);
        }
      }
      const fig   = (await figRes.json()).deleted   || {};
      const scene = (await sceneRes.json()).deleted || {};
      const loc   = (await locRes.json()).deleted   || {};
      this.staleCleanupMessage = window.__app.t('book.settings.staleCleanupSummary', {
        figuren:      fig.figures    || 0,
        szenen:       scene.scenes   || 0,
        schauplaetze: loc.locations  || 0,
      });
      // Buchweite Kataloge neu laden, damit die entfernten Zeilen aus offenen Karten verschwinden.
      if (String(Alpine.store('nav').selectedBookId) === String(bookId)) {
        window.__app.loadFiguren?.(bookId);
        window.__app.loadOrte?.(bookId);
        window.__app.loadSzenen?.(bookId);
      }
      if (this._staleMsgTimer) clearTimeout(this._staleMsgTimer);
      this._staleMsgTimer = setTimeout(() => { this.staleCleanupMessage = ''; this._staleMsgTimer = null; }, 6000);
    } catch (e) {
      this.staleCleanupError = e.message;
    } finally {
      this.staleCleanupLoading = false;
    }
  },


  async deleteBook() {
    const app = window.__app;
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) return;
    const book = Alpine.store('nav').books.find(b => String(b.id) === String(bookId));
    const name = book?.name || '';
    if (!await app.appConfirm({
      message: app.t('book.settings.deleteBookConfirm', { name }),
      confirmLabel: app.t('common.delete'),
      danger: true,
    })) return;

    this.bookDeleteLoading = true;
    this.bookDeleteError = '';
    try {
      await contentRepo.deleteBook(bookId);
      app.showBookSettingsCard = false;
      Alpine.store('nav').selectedBookId = '';
      app.resetView();
      await app.loadBooks();
      app.setStatus(app.t('book.settings.deleteBookSummary', { name }), false, 5000);
    } catch (e) {
      this.bookDeleteError = app.t('book.settings.deleteBookFailed', { msg: e.message });
    } finally {
      this.bookDeleteLoading = false;
    }
  },


  // Drill-Down: Typ-Zeile aufklappen → letzte N Runs nachladen.
  // Cache pro Typ in bookJobRuns; Re-Toggle schliesst nur, lädt nicht neu.
  async toggleJobRuns(type) {
    if (this.expandedJobType === type) {
      this.expandedJobType = null;
      return;
    }
    this.expandedJobType = type;
    if (this.bookJobRuns[type]) return;
    this.bookJobRunsLoading = true;
    try {
      const bookId = Alpine.store('nav').selectedBookId;
      const runs = await fetchJson(`/jobs/runs?book_id=${encodeURIComponent(bookId)}&type=${encodeURIComponent(type)}&limit=20`);
      this.bookJobRuns[type] = runs;
    } catch (e) {
      console.error('[book-settings] Job-Runs laden fehlgeschlagen:', e);
      this.bookJobRuns[type] = [];
    } finally {
      this.bookJobRunsLoading = false;
    }
  },
};
