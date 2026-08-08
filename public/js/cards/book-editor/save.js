// Teil von bookEditorCard (Facade cards/book-editor-card.js): Save-Queue,
// Konflikt-Auflösung und die daraus abgeleitete Status-Anzeige. Methoden in
// den Card-Scope gespreadet (gemeinsames `this`).
//
// Erwartet aus der Card: `blocks`, `saveQueue`, `saveAll*`, `_blockById`,
// `_autosave` (createAutosaveTimers) und `_savedFlash` (createTimerBag) —
// beide werden in deren `init()` gebaut und in `destroy()` abgeräumt.
//
// Queue-Vertrag: Concurrency 1. Parallele Saves würden gegen den Stale-Schutz
// laufen — der zweite Save wüsste nicht, dass der erste `updated_at` bereits
// bewegt hat.

import { htmlToText } from '../../utils.js';
import { readConflictBody, savePage } from '../../editor/shared/page-api.js';
import { checkPageConflict } from '../../editor/shared/page-conflict.js';
import { conflictText } from '../../editor/shared/conflict-text.js';
import { stripLektoratMarks } from '../../editor/shared/html-clean.js';
import { isNoChange } from '../../editor/shared/save-pipeline.js';

// Wie lange der „gespeichert"-Status am Block/Outline-Punkt stehen bleibt.
// Danach wird `savedAt` aktiv genullt — ein `Date.now()`-Vergleich im Template
// wäre nicht reaktiv und der Status bliebe bis zum nächsten Re-Render hängen.
const SAVED_FLASH_MS = 4000;

// Konflikt-Wortlaut (Gerät vs. User): shared/conflict-text.js. Die drei
// Auftritte hier (saveError-Hinweis, Statuszeile, Block-Banner) unterscheiden
// sich nur in der Variante.
const CONFLICT_VARIANT = { hint: 'bookHint', banner: 'bookBanner', status: 'bookStatus' };

// Übernimmt ein erfolgreiches Save-Ergebnis auf den Block. Pure (ausser
// Date.now) und darum unit-testbar.
//
// `snapshot` ist der `block.html`-Stand, mit dem der Save losgelaufen ist. Ist
// `block.html` inzwischen weitergewandert, hat der User während des laufenden
// PUT weitergetippt: das Dirty-Flag MUSS dann stehen bleiben — sonst lehnt
// `_enqueueSave` den nachlaufenden Autosave ab (`!block.dirty`), der Block-
// Wechsel speichert ebenfalls nicht, und die getippten Zeichen gehen still
// verloren. Liefert true, wenn der Block dirty bleibt.
export function applySaveOutcome(block, { snapshot, savedHtml, savedUpdatedAt = null }) {
  block.originalHtml = savedHtml;
  if (savedUpdatedAt) block.originalUpdatedAt = savedUpdatedAt;
  block.conflict = null;
  block.saveError = '';
  block.savedAt = Date.now();
  block.dirty = block.html !== snapshot;
  return block.dirty;
}

export const bookEditorSaveMethods = {
  _markBlockDirty(block) {
    block.dirty = true;
    this._autosave.schedule(block.pageId);
  },

  // ── Queue ───────────────────────────────────────────────────────────────
  _enqueueSave(pageId) {
    const block = this._blockById(pageId);
    if (!block || !block.dirty || block.saving) return;
    if (!this.saveQueue.includes(pageId)) this.saveQueue.push(pageId);
    this._processQueue();
  },

  // Liefert das Promise des laufenden Durchlaufs (oder startet einen). Damit
  // kann Save-All den Abschluss awaiten, statt die Queue zu pollen.
  _processQueue() {
    if (!this._queueRun) {
      this._queueRun = this._drainQueue().finally(() => { this._queueRun = null; });
    }
    return this._queueRun;
  },

  async _drainQueue() {
    while (this.saveQueue.length > 0) {
      const block = this._blockById(this.saveQueue.shift());
      if (!block || !block.dirty) continue;
      await this._saveBlock(block);
    }
  },

  async _saveBlock(block) {
    const app = window.__app;
    if (!app) return;
    this._autosave.clear(block.pageId);

    // Stand, mit dem dieser Save losläuft — Referenz für „hat der User während
    // des laufenden PUT weitergetippt?" (siehe applySaveOutcome).
    const snapshot = block.html;
    // stripLektoratMarks ist der geteilte Save-Cleaner (Lektorat-/Chat-Marks,
    // LanguageTool-UI, leere Trailing-Blöcke). Der Bucheditor rendert selbst
    // keine Marks — defensiv gegen HTML aus History-/Chat-Apply.
    const newHtml = stripLektoratMarks(snapshot);
    if (isNoChange(newHtml, block.originalHtml)) {
      block.dirty = false;
      return;
    }
    // Leer-Block-Schutz: ein versehentlich geleerter Block darf die Seite beim
    // Verlassen nicht überschreiben. Dirty bleibt stehen.
    if (!htmlToText(newHtml).trim()) {
      block.saveError = app.t('bookEditor.emptyAbort');
      return;
    }
    block.saving = true;
    block.saveError = '';
    try {
      const conflict = await checkPageConflict(block.pageId, block.originalUpdatedAt);
      if (conflict) {
        block.conflict = {
          remoteUserName: conflict.remoteUserName,
          remoteUpdatedAt: conflict.remoteUpdatedAt,
          remoteIsSelf: conflict.remoteIsSelf,
          remoteDevice: conflict.remoteDevice,
          remoteHtml: conflict.remoteHtml,
        };
        block.saveError = this._conflictText(block.conflict, 'hint');
        return;
      }
      const saved = await savePage(block.pageId, {
        html: newHtml,
        pageName: block.name,
        source: 'book',
        expectedUpdatedAt: block.originalUpdatedAt || null,
      });
      const stillDirty = applySaveOutcome(block, {
        snapshot,
        savedHtml: newHtml,
        savedUpdatedAt: saved?.updated_at,
      });
      if (stillDirty) this._autosave.schedule(block.pageId);
      this._savedFlash.set(block.pageId, () => { block.savedAt = null; }, SAVED_FLASH_MS);
      app._syncPageStatsAfterSave?.({ id: block.pageId, updated_at: block.originalUpdatedAt }, newHtml);
    } catch (e) {
      // 409 = Race nach dem Pre-Check; identische Banner-Branch.
      if (e?.status === 409 && e?.code === 'PAGE_CONFLICT') {
        block.conflict = { ...readConflictBody(e), remoteHtml: null };
        block.saveError = this._conflictText(block.conflict, 'hint');
      } else {
        block.saveError = e.message || app.t('bookEditor.saveFailed');
      }
    } finally {
      block.saving = false;
    }
  },

  async saveAllDirty() {
    if (this.saveAllRunning) return;
    const dirty = this.blocks.filter(b => b.kind === 'page' && b.dirty);
    if (dirty.length === 0) return;
    this.saveAllRunning = true;
    this.saveAllIds = dirty.map(b => b.pageId);
    for (const b of dirty) {
      if (!this.saveQueue.includes(b.pageId)) this.saveQueue.push(b.pageId);
    }
    try {
      await this._processQueue();
    } finally {
      this.saveAllRunning = false;
      this.saveAllIds = [];
    }
  },

  // ── Konflikt-Auflösung ──────────────────────────────────────────────────
  resolveConflictOverwrite(block) {
    if (!block.conflict) return;
    block.originalUpdatedAt = block.conflict.remoteUpdatedAt;
    block.conflict = null;
    block.saveError = '';
    block.dirty = true;
    this._enqueueSave(block.pageId);
  },

  resolveConflictTakeRemote(block) {
    if (!block.conflict) return;
    block.html = block.conflict.remoteHtml || '';
    block.originalHtml = block.html;
    block.originalUpdatedAt = block.conflict.remoteUpdatedAt;
    block.dirty = false;
    block.conflict = null;
    block.saveError = '';
    block._rev++;   // externe Mutation → _maybeRehydrate schreibt den Block neu
  },

  // ── Status ──────────────────────────────────────────────────────────────
  // EINE Zustandsmaschine für Block-Badge, Statuszeile und Outline-Punkt (die
  // Outline faltet conflict/error zusammen, siehe outlinePageStatus).
  blockStatus(block) {
    if (!block) return '';
    if (block.saving) return 'saving';
    if (block.conflict) return 'conflict';
    if (block.saveError) return 'error';
    if (block.dirty) return 'dirty';
    if (block.savedAt) return 'saved';
    return '';
  },

  _conflictText(conflict, variant) {
    const app = window.__app;
    if (!app) return '';
    return conflictText(app.t.bind(app), conflict, CONFLICT_VARIANT[variant]);
  },

  conflictBanner(conflict) {
    return this._conflictText(conflict, 'banner');
  },

  // Reiner Text (Template bindet x-text) — kein HTML, kein Escape nötig.
  blockStatusLine(block) {
    const app = window.__app;
    if (!app) return '';
    switch (this.blockStatus(block)) {
      case 'saving': return app.t('bookEditor.status.saving');
      case 'conflict': return this._conflictText(block.conflict, 'status');
      case 'error': return block.saveError;
      case 'dirty': return app.t('bookEditor.status.dirty');
      case 'saved': return app.t('bookEditor.status.saved');
      default: return '';
    }
  },
};
