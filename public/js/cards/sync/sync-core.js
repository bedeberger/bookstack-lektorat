import { EVT } from '../../events.js';
// Sync-Core — gemeinsame Logik für externe Buch-Sync-Provider (WordPress-Blog,
// HubSpot-Blog, künftige Provider). `createSyncCard(spec)` liefert ein
// Alpine.data-Objekt mit Links-Loading, Per-Page-Status, Push-Job-Trigger,
// Progress-Polling. Provider-spezifische Erweiterungen (z.B. Konflikt-Diff bei
// WordPress) kommen über `spreadExt` als zusätzliche Methoden/State drauf.
//
// Endpoint-Konvention pro Provider:
//   GET  ${endpointBase}/${bookId}/links → { connected, links[], …providerMeta }
//   POST /jobs/${jobType.push}  { book_id, page_ids } → { jobId }
//
// Provider-Spec:
//   key           — kurzer Identifier ('blog', 'hubspot')
//   endpointBase  — '/blog' | '/hubspot'
//   jobTypes      — { push: 'blog-push', refresh: ['blog-import','blog-pull'],
//                     reconcile: 'blog-reconcile' }
//                   (refresh-Liste: nach diesen Jobs `loadPages()` triggern;
//                   nach push-/reconcile-Jobs reicht `loadLinks()`)
//   providerMetaKey — Key aus /links-Response, der provider-spezifische Meta
//                     trägt (z.B. 'baseUrl', 'blogId'). Wird auf `providerMeta`
//                     gemappt; legacy Felder bleiben als Top-Level für
//                     Backwards-Compat.
//   computeStatus(page, link) → Status-String oder null
//   statusLabels  — { status: 'i18n.key' }
//   canPushStatuses — Statuswerte, bei denen Push erlaubt ist
//   viewUrl(page, providerMeta, link) → URL-String oder '' (optional)
//   spreadExt     — Object mit zusätzlichen State-Feldern/Methoden, wird in
//                   das Alpine.data gespreaded (z.B. Konflikt-Handling)
//   onBookChange  — optional, wird in book:changed nach Core-Reset gerufen
//   pushErrorCode — Fallback-Error-Code-String
//   confirmPush(pageId) → boolean | Promise<boolean> (optional). Wird in `push()`
//                         vor dem Backend-Call aufgerufen; liefert `false` →
//                         Push abgebrochen (z.B. wenn ein UI-Dialog erst eine
//                         Bestätigung einholen muss).

export function createSyncCard(spec) {
  const refreshTypes = new Set([
    ...(spec.jobTypes?.refresh || []),
  ]);
  const pushType = spec.jobTypes?.push || `${spec.key}-push`;
  const reconcileType = spec.jobTypes?.reconcile || null;
  const linkRefreshTypes = new Set([pushType, ...(reconcileType ? [reconcileType] : [])]);
  const globalWindowKey = `__${spec.key}Card`;
  const extRaw = spec.spreadExt || {};
  const extInit = extRaw.init;
  const extDestroy = extRaw.destroy;
  const ext = { ...extRaw };
  delete ext.init;
  delete ext.destroy;

  return () => {
    const base = {
      connected: false,
      providerMeta: {},
      linksMap: {},
      pushBusy: {},
      pushProgress: {},
      _pushTimers: {},

      init() {
        window[globalWindowKey] = this;
        this._onPagesLoaded = () => this.loadLinks();
        this._onBookChanged = () => {
          for (const t of Object.values(this._pushTimers)) clearInterval(t);
          this._pushTimers = {};
          this.connected = false;
          this.providerMeta = {};
          this.linksMap = {};
          this.pushBusy = {};
          this.pushProgress = {};
          if (typeof spec.onBookChange === 'function') spec.onBookChange.call(this);
        };
        this._onJobFinished = (ev) => {
          const t = ev?.detail?.type;
          if (linkRefreshTypes.has(t)) {
            this._applyPushRenames(ev?.detail?.job);
            this.loadLinks();
          }
          // source:'job' → frischer Tree-Read: Import-/Pull-Jobs legen die Seiten
          // SERVERSEITIG an, im Browser lief also kein Cache-Bust.
          else if (refreshTypes.has(t)) window.__app?.loadPages?.({ source: 'job' });
        };
        window.addEventListener(EVT.PAGES_LOADED, this._onPagesLoaded);
        window.addEventListener(EVT.BOOK_CHANGED, this._onBookChanged);
        window.addEventListener(EVT.JOB_FINISHED, this._onJobFinished);
        if (typeof extInit === 'function') extInit.call(this);
      },

      destroy() {
        for (const t of Object.values(this._pushTimers)) clearInterval(t);
        this._pushTimers = {};
        window.removeEventListener(EVT.PAGES_LOADED, this._onPagesLoaded);
        window.removeEventListener(EVT.BOOK_CHANGED, this._onBookChanged);
        window.removeEventListener(EVT.JOB_FINISHED, this._onJobFinished);
        if (window[globalWindowKey] === this) window[globalWindowKey] = null;
        if (typeof extDestroy === 'function') extDestroy.call(this);
      },

      // Endpoint /links liefert `connected: false`, wenn Buchtyp != 'blog' oder
      // keine Connection gespeichert ist — kein zusätzlicher Client-Gate nötig.
      async loadLinks() {
        const bookId = Alpine.store('nav').selectedBookId;
        if (!bookId) {
          this.connected = false;
          this.providerMeta = {};
          this.linksMap = {};
          return;
        }
        try {
          const res = await fetch(`${spec.endpointBase}/${bookId}/links`);
          if (!res.ok) {
            this.connected = false;
            this.providerMeta = {};
            this.linksMap = {};
            return;
          }
          const data = await res.json();
          this.connected = !!data.connected;
          this.providerMeta = data;
          const map = {};
          for (const link of (data.links || [])) map[link.page_id] = link;
          this.linksMap = map;
        } catch (e) {
          console.error(`[sync:${spec.key}] Links laden fehlgeschlagen:`, e);
        }
      },

      statusFor(page) {
        if (!this.connected || !page) return null;
        return spec.computeStatus(page, this.linksMap[page.id] || null);
      },

      statusLabel(status) {
        if (!status) return '';
        const key = spec.statusLabels?.[status];
        return key ? (window.__app?.t(key) || '') : '';
      },

      canPush(page) {
        const s = this.statusFor(page);
        return !!s && spec.canPushStatuses.includes(s);
      },

      viewUrl(page) {
        if (!page || typeof spec.viewUrl !== 'function') return '';
        return spec.viewUrl(page, this.providerMeta, this.linksMap[page.id] || null);
      },

      async push(pageId) {
        const bookId = Alpine.store('nav').selectedBookId;
        if (!bookId) return;
        if (this.pushBusy[pageId]) return;
        if (typeof spec.confirmPush === 'function') {
          const ok = await spec.confirmPush.call(this, pageId);
          if (!ok) return;
        }
        this.pushBusy = { ...this.pushBusy, [pageId]: true };
        this.pushProgress = { ...this.pushProgress, [pageId]: 0 };
        try {
          const res = await fetch(`/jobs/${pushType}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ book_id: bookId, page_ids: [pageId] }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error_code || spec.pushErrorCode || `${spec.key.toUpperCase()}_PUSH_FAILED`);
          if (data.jobId) {
            window.dispatchEvent(new CustomEvent(EVT.JOB_ENQUEUED, { detail: { type: pushType, jobId: data.jobId } }));
            this._pollPush(pageId, data.jobId);
          }
        } catch (e) {
          console.error(`[sync:${spec.key}] Push fehlgeschlagen:`, e);
          this._clearPushBusy(pageId);
        }
      },

      _pollPush(pageId, jobId) {
        const tick = async () => {
          try {
            const resp = await fetch('/jobs/' + jobId);
            if (resp.status === 404) { this._clearPushBusy(pageId); return; }
            if (!resp.ok) return;
            const job = await resp.json();
            this.pushProgress = { ...this.pushProgress, [pageId]: job.progress || 0 };
            if (job.status === 'running' || job.status === 'queued') return;
            this._clearPushBusy(pageId);
            if (job.status !== 'error' && job.status !== 'cancelled') {
              this._applyPushRenames(job);
              this.loadLinks();
            }
          } catch (e) { /* swallow; nächster Tick versucht erneut */ }
        };
        if (this._pushTimers[pageId]) clearInterval(this._pushTimers[pageId]);
        this._pushTimers = { ...this._pushTimers, [pageId]: setInterval(tick, 1000) };
        tick();
      },

      // Push-Create kann den lokalen page_name prägen (z.B. WordPress-Datum-
      // Prefix, app-intern). Das Backend liefert `result.renamed: [{ pageId,
      // name }]`. `loadLinks()` deckt nur die Badges — Sidebar-Tree und offener
      // Editor-Titel zeigen sonst weiter den alten Namen. Tree via loadPages()
      // neu aufbauen; den offenen Editor-Titel (`currentPage.name`) direkt
      // nachziehen (loadPages refetcht nur den Page-Body, nicht den Namen).
      // No-op, wenn der Job nichts umbenannt hat (z.B. reiner Update-Push).
      _applyPushRenames(job) {
        const renamed = job?.result?.renamed;
        if (!Array.isArray(renamed) || !renamed.length) return;
        const app = window.__app;
        if (!app) return;
        for (const r of renamed) {
          if (app.currentPage && String(app.currentPage.id) === String(r.pageId)) {
            app.currentPage.name = r.name;
          }
        }
        app.loadPages?.({ source: 'job' });
      },

      _clearPushBusy(pageId) {
        if (this._pushTimers[pageId]) {
          clearInterval(this._pushTimers[pageId]);
          const t = { ...this._pushTimers }; delete t[pageId]; this._pushTimers = t;
        }
        const b = { ...this.pushBusy }; delete b[pageId]; this.pushBusy = b;
        const p = { ...this.pushProgress }; delete p[pageId]; this.pushProgress = p;
      },
    };

    return Object.assign(base, ext);
  };
}
