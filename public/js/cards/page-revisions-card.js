// Alpine.data('pageRevisionsCard') — App-eigene Revisionsliste pro Seite.
// Lebt unter dem Editor parallel zur
// Lektorat-Verlaufsleiste (pageHistoryCard). Read aus
// GET /content/pages/:id/revisions, Voll-Body aus .../:rev_id, Restore via
// POST .../restore. Viewer ist natives <dialog>: Tabs "Inhalt | Vergleich",
// Diff-Lib lazy.

import { fetchJson } from '../utils.js';
import { contentRepo } from '../repo/content.js';
import { loadDiff } from '../lazy-libs.js';
import { renderSideBySide } from '../page-revision-diff.js';
import { EVT } from '../events.js';

export function registerPageRevisionsCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('pageRevisionsCard', () => ({
    revisions: [],
    // `total` = Gesamtzahl auf dem Server, `revisions` nur das geladene Fenster.
    // Beides auseinanderzuhalten ist der Kern dieser Karte: das `raw`-Bucket der
    // Retention haelt jeden Autosave der letzten 24 h, ein Schreibtag fuellt das
    // erste Fenster also allein — die getierte Historie dahinter kommt erst per
    // `loadMore()`.
    total: 0,
    hasMore: false,
    loadingMore: false,
    open: false,
    loading: false,
    restoringId: null,
    _pageId: null,

    // Viewer-State (Inhalt-/Vergleichs-Modal).
    viewerOpen: false,
    viewerRev: null,
    viewerBody: '',
    viewerMode: 'content',     // 'content' | 'diff'
    viewerLoading: false,
    viewerError: '',
    viewerDiffHtml: '',
    viewerDiffUnchanged: false,
    viewerDiffLoading: false,

    init() {
      const app = window.__app;
      const cur = app?.currentPage?.id || null;
      if (cur) this.loadRevisions(cur);

      this.$watch(() => window.__app?.currentPage?.id, (pid) => {
        if (!pid) { this.reset(); return; }
        this.loadRevisions(pid);
      });

      this._onRevisionsChanged = (e) => {
        const pid = e?.detail?.pageId;
        if (!pid || pid !== this._pageId) return;
        // `keepDepth`: ein Autosave darf ein nachgeladenes Fenster nicht wieder
        // auf die jueng­sten 100 zusammenfallen lassen — der Autosave feuert im
        // Minutentakt, das Blaettern waere sonst nicht haltbar.
        this.loadRevisions(pid, { keepDepth: true });
      };
      window.addEventListener(EVT.PAGE_REVISIONS_CHANGED, this._onRevisionsChanged);
    },

    destroy() {
      if (this._onRevisionsChanged) {
        window.removeEventListener(EVT.PAGE_REVISIONS_CHANGED, this._onRevisionsChanged);
      }
    },

    reset() {
      this.revisions = [];
      this.total = 0;
      this.hasMore = false;
      this.loadingMore = false;
      this.open = false;
      this.loading = false;
      this.restoringId = null;
      this._pageId = null;
      this.closeViewer();
    },

    // `keepDepth` haelt die bereits nachgeladene Tiefe: statt des Default-Fensters
    // wird so viel angefordert, wie geladen war. Server-Deckel ist 500 — bei mehr
    // Tiefe faellt die Liste bewusst auf 500 zurueck (der Rest ist einen Klick
    // entfernt) statt eine unbegrenzte Antwort zu verlangen.
    //
    // Kein `__fresh=1`: die Frische dieses Pfades garantiert der Service Worker
    // (CONTENT_VOLATILE_REGEX in public/sw.js liefert die Revisionsliste
    // Netz-zuerst). `__fresh` wuerde den SW-Cache umgehen, ihn aber auch nicht
    // fuellen — die Liste waere dann offline gar nicht lesbar.
    async loadRevisions(pageId, { keepDepth = false } = {}) {
      if (!pageId) return;
      const depth = keepDepth && pageId === this._pageId
        ? Math.min(500, this.revisions.length)
        : 0;
      this._pageId = pageId;
      this.loading = true;
      try {
        const qs = [];
        if (depth > 100) qs.push(`limit=${depth}`);
        const url = `/content/pages/${pageId}/revisions${qs.length ? '?' + qs.join('&') : ''}`;
        const data = await fetchJson(url);
        this.revisions = Array.isArray(data?.revisions) ? data.revisions : [];
        this.hasMore = !!data?.has_more;
        this.total = Number.isFinite(data?.total) ? data.total : this.revisions.length;
      } catch (e) {
        console.error('[pageRevisions:load]', e);
        this.revisions = [];
        this.hasMore = false;
        this.total = 0;
      } finally {
        this.loading = false;
      }
    },

    // Naechstes Fenster anhaengen. Cursor ist die aelteste bereits geladene
    // Revision (Keyset), nicht ein Offset — waehrend der User liest, schreibt
    // der Autosave vorne weiter.
    async loadMore() {
      const pageId = this._pageId;
      if (!pageId || this.loadingMore || !this.hasMore) return;
      const last = this.revisions[this.revisions.length - 1];
      if (!last?.created_at || !last?.id) return;
      this.loadingMore = true;
      try {
        const url = `/content/pages/${pageId}/revisions`
          + `?before=${encodeURIComponent(last.created_at)}&before_id=${last.id}`;
        const data = await fetchJson(url);
        const more = Array.isArray(data?.revisions) ? data.revisions : [];
        // Dedup gegen bereits geladene IDs: ein Restore waehrend des Blaetterns
        // laedt die Liste neu, die Antwort hier kann dann ueberlappen.
        const seen = new Set(this.revisions.map(r => r.id));
        this.revisions = this.revisions.concat(more.filter(r => !seen.has(r.id)));
        this.hasMore = !!data?.has_more;
        if (Number.isFinite(data?.total)) this.total = data.total;
      } catch (e) {
        console.error('[pageRevisions:loadMore]', e);
        window.__app?.setStatus?.(window.__app.t('editor.revisions.loadMoreFailed'), true, 5000);
      } finally {
        this.loadingMore = false;
      }
    },

    isOwnRevision(rev) {
      if (!rev?.user_email) return false;
      const me = Alpine.store('session').currentUser?.email;
      return !!me && String(me).toLowerCase() === String(rev.user_email).toLowerCase();
    },

    sourceLabel(src) {
      const app = window.__app;
      const key = `editor.revisions.source.${src}`;
      const out = app?.t?.(key);
      return out && out !== key ? out : src;
    },

    // Nummer gegen `total`, nicht gegen die Fenstergroesse: die Liste ist DESC
    // und beginnt immer bei der juengsten Revision, Index 0 ist also Nummer
    // `total`. Gegen `revisions.length` gerechnet wuerde dieselbe Revision nach
    // jedem `loadMore()` eine andere Nummer tragen.
    revisionNumber(rev) {
      if (!rev?.id) return null;
      const idx = this.revisions.findIndex(r => r.id === rev.id);
      if (idx < 0) return null;
      return Math.max(this.total, this.revisions.length) - idx;
    },

    formatChars(n) {
      const app = window.__app;
      const locale = Alpine.store('shell').uiLocale === 'en' ? 'en-US' : 'de-CH';
      return Number(n || 0).toLocaleString(locale);
    },

    // Liste DESC sortiert (juengste zuerst). Vorgaengerin = revisions[idx+1].
    // Aelteste Revision hat keine Vorgaengerin → null (kein Delta-Tag).
    charsDelta(idx) {
      const cur = this.revisions[idx];
      const prev = this.revisions[idx + 1];
      if (!cur || !prev) return null;
      const a = Number(cur.chars || 0);
      const b = Number(prev.chars || 0);
      return a - b;
    },

    formatDelta(d) {
      if (d == null) return '';
      const app = window.__app;
      const locale = Alpine.store('shell').uiLocale === 'en' ? 'en-US' : 'de-CH';
      return Number(d).toLocaleString(locale, { signDisplay: 'exceptZero' });
    },

    // ── Viewer ───────────────────────────────────────────────────────────────
    async openViewer(rev, { keepMode = false } = {}) {
      if (!rev?.id) return;
      const app = window.__app;
      const pageId = app?.currentPage?.id;
      if (!pageId) return;

      const firstOpen = !this.viewerOpen;
      // Bei Prev/Next-Navigation den aktiven Tab beibehalten; beim Frischoeffnen
      // immer mit 'content' starten.
      const mode = keepMode && this.viewerMode === 'diff' ? 'diff' : 'content';
      this.viewerOpen = true;
      this.viewerRev = rev;
      this.viewerMode = mode;
      this.viewerBody = '';
      this.viewerError = '';
      this.viewerDiffHtml = '';
      this.viewerDiffUnchanged = false;
      this.viewerLoading = true;

      if (firstOpen) {
        this.$nextTick(() => {
          const dlg = this.$refs?.viewerDialog;
          if (dlg && typeof dlg.showModal === 'function' && !dlg.open) dlg.showModal();
        });
      }

      try {
        const data = await fetchJson(`/content/pages/${pageId}/revisions/${rev.id}`);
        const rev2 = data?.revision || null;
        if (!rev2) throw new Error('REVISION_NOT_FOUND');
        this.viewerBody = String(rev2.body_html || '');
      } catch (e) {
        console.error('[pageRevisions:viewer:load]', e);
        this.viewerError = e.message || 'load failed';
      } finally {
        this.viewerLoading = false;
      }

      // Vergleichs-Tab beibehalten → Diff fuer die neu geladene Revision ziehen.
      if (this.viewerMode === 'diff' && !this.viewerError) await this._ensureDiff();
    },

    // Liste DESC sortiert (juengste zuerst). 'prev' = aelter = idx+1.
    // 'next' = neuer = idx-1.
    _siblingRev(direction) {
      if (!this.viewerRev?.id) return null;
      const idx = this.revisions.findIndex(r => r.id === this.viewerRev.id);
      if (idx < 0) return null;
      const target = direction === 'prev' ? idx + 1 : idx - 1;
      return this.revisions[target] || null;
    },
    hasPrevRev() { return !!this._siblingRev('prev'); },
    hasNextRev() { return !!this._siblingRev('next'); },
    gotoRev(direction) {
      const target = this._siblingRev(direction);
      if (target) this.openViewer(target, { keepMode: true });
    },

    closeViewer() {
      this.viewerOpen = false;
      this.viewerRev = null;
      this.viewerBody = '';
      this.viewerMode = 'content';
      this.viewerError = '';
      this.viewerDiffHtml = '';
      this.viewerDiffUnchanged = false;
      const dlg = this.$refs?.viewerDialog;
      if (dlg && dlg.open) dlg.close();
    },

    async setViewerMode(mode) {
      if (mode !== 'content' && mode !== 'diff') return;
      this.viewerMode = mode;
      if (mode === 'diff' && !this.viewerDiffHtml && !this.viewerError) {
        await this._ensureDiff();
      }
    },

    // Diff vergleicht aktuelle Revision (rechte Spalte = juenger) gegen
    // Vorgaenger-Revision (linke Spalte = aelter). Aelteste Revision: kein
    // Vorgaenger → leerer String, alles wird als "added" gerendert.
    async _ensureDiff() {
      const app = window.__app;
      if (!this.viewerBody || !this.viewerRev?.id) return;
      this.viewerDiffLoading = true;
      try {
        const diffLib = await loadDiff();
        const prevHtml = await this._loadPrevRevisionBody();
        const skipLabel = (n) => app?.t?.('editor.revisions.viewer.diffSkip', { n }) || `… ${n} …`;
        const out = renderSideBySide(prevHtml, this.viewerBody, diffLib, { skipLabel });
        this.viewerDiffHtml = out.html;
        this.viewerDiffUnchanged = out.unchanged;
      } catch (e) {
        console.error('[pageRevisions:viewer:diff]', e);
        this.viewerError = e.message || 'diff failed';
      } finally {
        this.viewerDiffLoading = false;
      }
    },

    // Liste ist DESC sortiert (juengste zuerst). Vorgaenger der geklickten
    // Revision ist also der NEXT-Index. Keine Vorgaengerin → leerer String.
    async _loadPrevRevisionBody() {
      const idx = this.revisions.findIndex(r => r.id === this.viewerRev?.id);
      if (idx < 0) return '';
      const prev = this.revisions[idx + 1];
      if (!prev?.id) return '';
      const app = window.__app;
      const pageId = app?.currentPage?.id;
      if (!pageId) return '';
      try {
        const data = await fetchJson(`/content/pages/${pageId}/revisions/${prev.id}`);
        return String(data?.revision?.body_html || '');
      } catch (e) {
        console.error('[pageRevisions:viewer:prev]', e);
        return '';
      }
    },

    async restoreFromViewer() {
      if (this.viewerRev) await this.restore(this.viewerRev);
    },

    // Vorgaengerin einer beliebigen Listen-Revision. Liste DESC sortiert
    // (juengste zuerst) → der "Stand davor" ist der naechstaeltere = idx+1.
    _prevRevFor(rev) {
      if (!rev?.id) return null;
      const idx = this.revisions.findIndex(r => r.id === rev.id);
      if (idx < 0) return null;
      return this.revisions[idx + 1] || null;
    },
    hasPrevRevFor(rev) { return !!this._prevRevFor(rev); },

    // "Stand davor wiederherstellen": schreibt die Vorgaenger-Revision zurueck —
    // also den Inhalt, der unmittelbar vor diesem Save existierte. Jede Revision
    // ist der Stand NACH ihrem Save, daher ist Revision N+1 (aelter) bytegenau
    // der Vor-Save-Stand von Revision N.
    async restorePrevious(rev) {
      const prev = this._prevRevFor(rev);
      if (prev) await this.restore(prev);
    },

    async restorePreviousFromViewer() {
      const prev = this._siblingRev('prev');
      if (prev) await this.restore(prev);
    },

    async restore(rev) {
      if (!rev?.id || this.restoringId) return;
      const app = window.__app;
      const pageId = app?.currentPage?.id;
      if (!pageId) return;
      const when = app.formatDate ? app.formatDate(rev.created_at) : rev.created_at;
      if (!confirm(app.t('editor.revisions.restoreConfirm', { when }))) return;
      this.restoringId = rev.id;
      try {
        // Ueber contentRepo statt per rohem fetch: der Restore ist ein Body-Write
        // und muss den SW-Cache von Seite UND Revisionsliste busten. Das Repo
        // dispatcht danach `page-revisions:changed` — die Liste laedt darum ueber
        // den Listener nachgeladene Tiefe erhaltend neu, ohne zweiten Aufruf hier.
        await contentRepo.restoreRevision(pageId, rev.id);
        if (typeof app._refetchCurrentPage === 'function') {
          await app._refetchCurrentPage();
        }
        app.setStatus?.(app.t('editor.revisions.restored'), false, 4000);
        this.closeViewer();
      } catch (e) {
        console.error('[pageRevisions:restore]', e);
        const why = e?.code || e?.message || '';
        app.setStatus?.(app.t('editor.revisions.restoreFailed') + ' ' + why, true, 6000);
      } finally {
        this.restoringId = null;
      }
    },
  }));
}
