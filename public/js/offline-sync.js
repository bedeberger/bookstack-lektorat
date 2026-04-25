// Globaler Offline-/Reconnect-Sync.
// Zweck: Nutzer kann Buch lesen und Seiten im Editor bearbeiten, auch wenn das
// Client-Gerät offline ist (Zug/Café). Der Service Worker liefert Shell und
// BookStack-GETs aus dem Cache (siehe public/sw.js), der Editor schreibt
// Drafts in localStorage. Dieses Modul sammelt alle offenen Drafts ein und
// pusht sie beim Wiederverbinden zurück an BookStack — auch für Seiten, die
// der Nutzer inzwischen geschlossen hat. Konflikt (Server hat sich seit dem
// Draft verändert) → Draft liegen lassen, editor-edit fragt beim nächsten
// Öffnen nach.

const DRAFT_PREFIX = 'editor_draft_';

function readDraft(pageId) {
  try {
    const raw = localStorage.getItem(DRAFT_PREFIX + pageId);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function listDraftPageIds() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(DRAFT_PREFIX)) continue;
      const id = Number(k.slice(DRAFT_PREFIX.length));
      if (id) out.push(id);
    }
  } catch {}
  return out;
}

export const offlineSyncMethods = {
  _setupOfflineSync() {
    if (this._offlineSyncInstalled) return;
    this._offlineSyncInstalled = true;
    this.isOffline = !navigator.onLine;
    const onOnline = () => {
      this.isOffline = false;
      this._pushAllDrafts();
    };
    const onOffline = () => { this.isOffline = true; };
    const signal = this._abortCtrl?.signal;
    window.addEventListener('online', onOnline, signal ? { signal } : false);
    window.addEventListener('offline', onOffline, signal ? { signal } : false);
    // Beim Start einmal pushen, falls Drafts aus vorheriger Offline-Session liegen.
    if (!this.isOffline) this._pushAllDrafts();
  },

  // Enumeriert alle localStorage-Drafts und versucht sie nach BookStack zu
  // pushen. Aktive Editor-Seite wird übersprungen — dafür ist
  // editor-edit._installOnlineRetry zuständig (synchronisiert den
  // Editor-State). Konflikt (Server-HTML ≠ draft.originalHtml ODER
  // Server-updated_at ≠ draft.originalUpdatedAt) → Draft bleibt liegen,
  // damit editor-edit beim Öffnen nachfragen kann.
  //
  // WICHTIG: Page-Read MUSS am Service-Worker-Cache vorbei (`__fresh=1`),
  // sonst matcht stale `page.html` mit veraltetem `draft.originalHtml`
  // und wir überschreiben den Server-Stand mit altem Inhalt.
  async _pushAllDrafts() {
    if (this._draftPushRunning) return;
    this._draftPushRunning = true;
    let pushed = 0, conflicts = 0, failed = 0;
    try {
      const ids = listDraftPageIds();
      for (const pageId of ids) {
        if (!navigator.onLine) break;
        if (this.editMode && this.currentPage?.id === pageId) continue;
        const draft = readDraft(pageId);
        if (!draft?.html) continue;
        try {
          const r = await fetch('/api/pages/' + pageId + '?__fresh=1');
          if (!r.ok) { failed++; continue; }
          const page = await r.json();
          if (draft.originalHtml && page.html !== draft.originalHtml) {
            conflicts++;
            continue;
          }
          if (draft.originalUpdatedAt && page.updated_at && page.updated_at !== draft.originalUpdatedAt) {
            conflicts++;
            continue;
          }
          const saved = await this.bsPut('pages/' + pageId, {
            html: draft.html,
            name: page.name,
          });
          try { localStorage.removeItem(DRAFT_PREFIX + pageId); } catch {}
          pushed++;
          const idx = this.pages?.findIndex(p => p.id === pageId);
          if (idx != null && idx >= 0 && saved?.updated_at) {
            this.pages[idx] = { ...this.pages[idx], updated_at: saved.updated_at };
          }
        } catch {
          failed++;
        }
      }
    } finally {
      this._draftPushRunning = false;
    }
    if (pushed > 0) {
      this.setStatus(this.t('offline.syncDone', { n: pushed }), false, 4000);
    } else if (conflicts > 0 && failed === 0) {
      this.setStatus(this.t('offline.syncConflicts', { n: conflicts }), false, 6000);
    }
  },
};
