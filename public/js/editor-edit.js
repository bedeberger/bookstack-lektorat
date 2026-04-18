import { htmlToText } from './utils.js';
import { sortByPosition, buildHighlightedHtml } from './page-view.js';

const AUTOSAVE_INTERVAL_MS = 30000;
const DRAFT_DEBOUNCE_MS = 500;
const DRAFT_KEY = (pageId) => `editor_draft_${pageId}`;

function stripLektoratMarks(html) {
  if (!html || html.indexOf('lektorat-mark') === -1) return html;
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  tmp.querySelectorAll('.lektorat-mark').forEach(mark => {
    const parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
  });
  return tmp.innerHTML;
}

function readDraft(pageId) {
  try {
    const raw = localStorage.getItem(DRAFT_KEY(pageId));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function writeDraft(pageId, html, originalHtml) {
  try {
    localStorage.setItem(DRAFT_KEY(pageId), JSON.stringify({
      html, originalHtml, savedAt: Date.now(),
    }));
  } catch { /* quota – ignoriert */ }
}

function clearDraft(pageId) {
  try { localStorage.removeItem(DRAFT_KEY(pageId)); } catch {}
}

function formatDraftTime(ts) {
  const d = new Date(ts);
  return d.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
}

export const editorEditMethods = {
  _getEditEl() {
    return document.querySelector('#editor-card .page-content-view--editing');
  },

  startEdit() {
    if (!this.currentPage || !this.originalHtml) return;
    if (this.checkLoading || this.saveApplying != null) return;
    this.editMode = true;
    this.editDirty = false;
    this.editSaving = false;
    this.saveOffline = false;

    let initialHtml = this.originalHtml;

    // Draft-Wiederherstellung: lokalen Entwurf prüfen, wenn vorhanden und abweichend.
    const draft = readDraft(this.currentPage.id);
    if (draft && draft.html && draft.html !== this.originalHtml) {
      const when = formatDraftTime(draft.savedAt || Date.now());
      const serverChanged = draft.originalHtml && draft.originalHtml !== this.originalHtml;
      const msg = serverChanged
        ? `Nicht gespeicherter Entwurf vom ${when} gefunden.\n\nACHTUNG: Die Seite wurde seitdem serverseitig geändert. Entwurf trotzdem wiederherstellen (überschreibt Server-Änderungen beim Speichern)?`
        : `Nicht gespeicherter Entwurf vom ${when} gefunden. Wiederherstellen?`;
      if (confirm(msg)) {
        initialHtml = draft.html;
        this.editDirty = true;
        this.lastDraftSavedAt = draft.savedAt || Date.now();
      } else {
        clearDraft(this.currentPage.id);
        this.lastDraftSavedAt = null;
      }
    }

    const el = this._getEditEl();
    if (el) {
      const findings = this.lektoratFindings || [];
      if (findings.length > 0 && initialHtml === this.originalHtml) {
        el.innerHTML = buildHighlightedHtml(this.originalHtml, findings, findings.map(() => false), []);
      } else {
        el.innerHTML = initialHtml;
      }
    }
    setTimeout(() => this._getEditEl()?.focus(), 0);

    this._startAutosave();
    this._installOnlineRetry();
  },

  cancelEdit() {
    if (this.editDirty && !confirm('Ungespeicherte Bearbeitung verwerfen? Der lokale Entwurf wird gelöscht.')) return;
    if (this.currentPage) clearDraft(this.currentPage.id);
    this._stopAutosave();
    this._uninstallOnlineRetry();
    this.lastDraftSavedAt = null;
    this.editMode = false;
    this.editDirty = false;
    this.editSaving = false;
    this.saveOffline = false;
    this.closeSynonymMenu?.();
    this.closeSynonymPicker?.();
    if (this.focusMode) this.exitFocusMode();
  },

  async saveEdit() {
    if (!this.currentPage) return;
    const el = this._getEditEl();
    if (!el) return;
    const newHtml = stripLektoratMarks(el.innerHTML);
    if (newHtml === this.originalHtml) { this.cancelEdit(); return; }

    const newText = htmlToText(newHtml).trim();
    if (!newText) {
      this.setStatus('Leerer Text – Speichern abgebrochen.', false, 5000);
      return;
    }
    const origText = htmlToText(this.originalHtml || '').trim();
    if (origText.length > 50 && newText.length < origText.length * 0.2) {
      if (!confirm(`Der neue Text ist deutlich kürzer (${newText.length} statt ${origText.length} Zeichen). Trotzdem speichern?`)) return;
    }

    this.editSaving = true;
    this.setStatus('Speichere Bearbeitung…', true);
    try {
      await this.bsPut('pages/' + this.currentPage.id, {
        html: newHtml,
        name: this.currentPage.name,
      });

      this.originalHtml = newHtml;
      const rawPreview = htmlToText(newHtml).trim() || null;
      if (this.currentPage) this.currentPage.previewText = rawPreview;
      this.currentPageEmpty = !rawPreview;

      if (this.lektoratFindings.length > 0) {
        const survivors = [];
        const prevSelected = new Map();
        for (let i = 0; i < this.lektoratFindings.length; i++) {
          const f = this.lektoratFindings[i];
          if (f.original && newHtml.indexOf(f.original) !== -1) {
            survivors.push(f);
            prevSelected.set(f, !!this.selectedFindings[i]);
          }
        }
        this.lektoratFindings = sortByPosition(newHtml, survivors);
        this.selectedFindings = this.lektoratFindings.map(f => prevSelected.get(f) ?? false);
        this.appliedOriginals = this.appliedOriginals.filter(o => newHtml.indexOf(o) !== -1);
        if (this.lektoratFindings.length === 0) {
          this.checkDone = false;
          this.correctedHtml = null;
          this.hasErrors = false;
        } else {
          this._recomputeCorrectedHtml();
        }
      }

      clearDraft(this.currentPage.id);
      this.lastAutosaveAt = Date.now();
      this.lastDraftSavedAt = null;
      this.editDirty = false;
      this.saveOffline = false;
      if (this.focusMode) {
        this.setStatus('✓ Änderungen gespeichert.', false, 3000);
      } else {
        this._stopAutosave();
        this._uninstallOnlineRetry();
        this.editMode = false;
        this.closeSynonymMenu?.();
        this.closeSynonymPicker?.();
        this.updatePageView();
        this.setStatus('✓ Änderungen gespeichert.', false, 5000);
      }
    } catch (e) {
      console.error('[saveEdit]', e);
      // Netzwerkfehler → Draft behalten, Offline-Modus aktivieren, Auto-Retry.
      writeDraft(this.currentPage.id, newHtml, this.originalHtml);
      this.lastDraftSavedAt = Date.now();
      this.saveOffline = true;
      if (!navigator.onLine) {
        this.setStatus('Offline – Entwurf lokal gesichert. Speichern bei Verbindung automatisch.', false, 8000);
      } else {
        this.setStatus('Speichern fehlgeschlagen – Entwurf lokal gesichert. Fehler: ' + e.message, false, 8000);
      }
    } finally {
      this.editSaving = false;
    }
  },

  // Stilles Speichern (Ctrl+S / Auto-Save): bleibt im Editor.
  async quickSave() {
    if (!this.editMode || !this.currentPage || this.editSaving) return;
    const el = this._getEditEl();
    if (!el) return;
    const newHtml = stripLektoratMarks(el.innerHTML);
    if (newHtml === this.originalHtml) {
      this.editDirty = false;
      clearDraft(this.currentPage.id);
      this.lastDraftSavedAt = null;
      return;
    }
    const newText = htmlToText(newHtml).trim();
    if (!newText) return;

    // Immer zuerst lokal sichern, dann erst Netzwerkversuch.
    writeDraft(this.currentPage.id, newHtml, this.originalHtml);
    this.lastDraftSavedAt = Date.now();

    if (!navigator.onLine) {
      this.saveOffline = true;
      this.setStatus('Offline – lokal gesichert (' + new Date().toLocaleTimeString('de-DE') + ')', false, 3000);
      return;
    }

    try {
      await this.bsPut('pages/' + this.currentPage.id, {
        html: newHtml,
        name: this.currentPage.name,
      });
      this.originalHtml = newHtml;
      this.editDirty = false;
      this.saveOffline = false;
      this.lastAutosaveAt = Date.now();
      this.lastDraftSavedAt = null;
      clearDraft(this.currentPage.id);
      const rawPreview = htmlToText(newHtml).trim() || null;
      if (this.currentPage) this.currentPage.previewText = rawPreview;
      this.currentPageEmpty = !rawPreview;
      this.setStatus('✓ gespeichert ' + new Date().toLocaleTimeString('de-DE'), false, 2500);
    } catch (e) {
      console.error('[quickSave]', e);
      this.saveOffline = true;
      this.setStatus('Speichern fehlgeschlagen – Entwurf lokal gesichert. Retry bei nächster Verbindung.', false, 6000);
    }
  },

  _markEditDirty() {
    if (!this.editMode) return;
    this.editDirty = true;
    this._scheduleDraftSave();
  },

  _scheduleDraftSave() {
    if (this._draftTimer) clearTimeout(this._draftTimer);
    this._draftTimer = setTimeout(() => {
      this._draftTimer = null;
      if (!this.editMode || !this.currentPage) return;
      const el = this._getEditEl();
      if (!el) return;
      const html = stripLektoratMarks(el.innerHTML);
      if (html === this.originalHtml) {
        clearDraft(this.currentPage.id);
        this.lastDraftSavedAt = null;
        return;
      }
      writeDraft(this.currentPage.id, html, this.originalHtml);
      this.lastDraftSavedAt = Date.now();
    }, DRAFT_DEBOUNCE_MS);
  },

  _startAutosave() {
    this._stopAutosave();
    this._autosaveTimer = setInterval(() => {
      if (this.editMode && this.editDirty && !this.editSaving) {
        this.quickSave();
      }
    }, AUTOSAVE_INTERVAL_MS);
  },

  _stopAutosave() {
    if (this._autosaveTimer) { clearInterval(this._autosaveTimer); this._autosaveTimer = null; }
    if (this._draftTimer) { clearTimeout(this._draftTimer); this._draftTimer = null; }
  },

  _installOnlineRetry() {
    if (this._onlineHandler) return;
    this._onlineHandler = () => {
      if (this.editMode && this.editDirty && this.saveOffline) {
        this.quickSave();
      }
    };
    window.addEventListener('online', this._onlineHandler);
  },

  _uninstallOnlineRetry() {
    if (!this._onlineHandler) return;
    window.removeEventListener('online', this._onlineHandler);
    this._onlineHandler = null;
  },
};
