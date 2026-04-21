import { htmlToText, stripFocusArtefacts, cleanContentArtefacts, stripTrailingEmptyBlocks } from './utils.js';
import { sortByPosition, buildHighlightedHtml } from './page-view.js';

const AUTOSAVE_INTERVAL_MS = 30000;
const DRAFT_DEBOUNCE_MS = 500;
const DRAFT_KEY = (pageId) => `editor_draft_${pageId}`;

// Entfernt jegliche Korrekturvorschlags-Markup, das buildHighlightedHtml
// erzeugen kann, bevor der Editor-Inhalt nach BookStack gespeichert wird:
//   - .lektorat-mark / .chat-mark → unwrap (Originaltext behalten)
//   - .lektorat-ins / .chat-mark-ins → komplett entfernen (nur Vorschlagstext)
// Defensiv: greift auch, falls Vorschlags-Markup auf unerwartetem Weg
// (Re-Render, Paste, künftige Refactors) in das contenteditable gerät.
function stripLektoratMarks(html) {
  let out = html;
  const hasMark = out && (out.indexOf('lektorat-mark') !== -1 || out.indexOf('chat-mark') !== -1);
  const hasIns = out && (out.indexOf('lektorat-ins') !== -1 || out.indexOf('chat-mark-ins') !== -1);
  if (hasMark || hasIns) {
    const tmp = document.createElement('div');
    tmp.innerHTML = out;
    tmp.querySelectorAll('.lektorat-ins, .chat-mark-ins').forEach(ins => {
      ins.parentNode?.removeChild(ins);
    });
    tmp.querySelectorAll('.lektorat-mark, .chat-mark').forEach(mark => {
      const parent = mark.parentNode;
      if (!parent) return;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
    });
    out = tmp.innerHTML;
  }
  return stripTrailingEmptyBlocks(cleanContentArtefacts(stripFocusArtefacts(out)));
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

function formatDraftTime(ts, locale) {
  const d = new Date(ts);
  const tag = locale === 'en' ? 'en-US' : 'de-DE';
  return d.toLocaleString(tag, { dateStyle: 'short', timeStyle: 'short' });
}

// Legacy-BookStack-Seiten enthalten teilweise bare Text-Nodes und Inline-
// Elemente direkt unterhalb des Editor-Roots (ohne <p>-Wrapper). Der
// Fokusmodus erkennt solche Runs nicht als Block → keine Absatz-
// Hervorhebung, CSS-Dim-Regeln (`.page-content-view p:not(...)` etc.) greifen
// ebenfalls nicht. Fix: orphan text/inline-Runs zwischen echten Block-
// Elementen in <p> verpacken, einmal beim Edit-Start. Die normalisierte
// Fassung wird beim nächsten Save nach BookStack zurückgeschrieben.
const ROOT_BLOCK_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'LI', 'PRE', 'UL', 'OL', 'TABLE',
  'FIGURE', 'HR', 'DIV', 'DL', 'SECTION', 'ARTICLE',
  'ASIDE', 'HEADER', 'FOOTER', 'NAV', 'MAIN', 'FORM',
]);

function normalizeEditorBlocks(el) {
  if (!el) return;
  let group = [];
  const flushBefore = (target) => {
    if (!group.length) return;
    const hasContent = group.some(n =>
      (n.nodeType === 3 && n.textContent.replace(/\u00A0/g, ' ').trim()) ||
      (n.nodeType === 1)
    );
    if (!hasContent) { group = []; return; }
    const p = document.createElement('p');
    for (const n of group) p.appendChild(n);
    if (target) el.insertBefore(p, target);
    else el.appendChild(p);
    group = [];
  };
  const children = Array.from(el.childNodes);
  for (const child of children) {
    if (child.nodeType === 1 && ROOT_BLOCK_TAGS.has(child.tagName)) {
      flushBefore(child);
    } else {
      group.push(child);
    }
  }
  flushBefore(null);
}

export const editorEditMethods = {
  _getEditEl() {
    return document.querySelector('#editor-card .page-content-view--editing');
  },

  // Nach jedem erfolgreichen Save: Findings, deren `original`-Text nicht mehr
  // im neuen HTML vorkommt, gelten als behoben und fliegen raus. Gilt sowohl
  // für saveEdit (expliziter Save) als auch quickSave (Ctrl+S/Autosave) –
  // damit das Prüf-Panel auch nach Fokus-Editor-Edits aktuell bleibt.
  _filterFindingsAfterSave(newHtml) {
    if (!this.lektoratFindings || this.lektoratFindings.length === 0) return;
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
  },

  startEdit() {
    if (!this.currentPage || !this.originalHtml) return;
    if (this.checkLoading || this.saveApplying != null) return;
    this.editMode = true;
    this.editDirty = false;
    this.editSaving = false;
    this.saveOffline = false;

    // Chromium/Safari-Default ist 'div' → Enter an bare Text oder am
    // Editor-Root erzeugt <div> statt <p>, damit fehlt der Absatz-Abstand
    // und der Fokus-Mode erkennt den Block nicht (BLOCK_TAGS ohne DIV).
    // Einmal pro Edit-Session genügt, der Flag ist dokumentweit.
    try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch {}

    let initialHtml = this.originalHtml;

    // Draft-Wiederherstellung: lokalen Entwurf prüfen, wenn vorhanden und abweichend.
    const draft = readDraft(this.currentPage.id);
    if (draft && draft.html && draft.html !== this.originalHtml) {
      const when = formatDraftTime(draft.savedAt || Date.now(), this.uiLocale);
      const serverChanged = draft.originalHtml && draft.originalHtml !== this.originalHtml;
      const msg = serverChanged
        ? this.t('edit.draftConfirmServerChanged', { when })
        : this.t('edit.draftConfirm', { when });
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
      // Pre-Normalize-Snapshot: weicht die Fassung nach normalizeEditorBlocks
      // davon ab, hat der Normalizer Legacy-HTML repariert (orphan Text-/
      // Inline-Nodes direkt unter dem Editor-Root). Ohne Persistenz kehrt
      // der Defekt nach jedem Reload zurück und bricht Focus-Mode-Absatz-
      // Hervorhebung erneut. `editDirty=true` sorgt dafür, dass der nächste
      // Auto- oder Manual-Save die bereinigte Fassung nach BookStack schreibt.
      const beforeNormalize = el.innerHTML;
      normalizeEditorBlocks(el);
      if (el.innerHTML !== beforeNormalize) {
        this.editDirty = true;
        this._scheduleDraftSave();
      }
    }
    setTimeout(() => this._getEditEl()?.focus(), 0);

    this._startAutosave();
    this._installOnlineRetry();
  },

  cancelEdit() {
    if (this.editDirty && !confirm(this.t('edit.cancelConfirm'))) return;
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
    this.closeFigurLookup?.();
    this.updatePageView();
    if (this.focusMode) this.exitFocusMode();
  },

  async saveEdit() {
    if (!this.currentPage) return;
    const el = this._getEditEl();
    if (!el) return;
    const newHtml = stripLektoratMarks(el.innerHTML);
    if (newHtml === this.originalHtml) {
      // Im Fokusmodus nicht aus Edit-/Fokusmodus herausfallen, wenn
      // der User ein zweites Mal Speichern klickt (nichts geändert).
      if (this.focusMode) {
        this.setStatus(this.t('edit.changesSaved'), false, 2000);
        return;
      }
      this.cancelEdit();
      return;
    }

    const newText = htmlToText(newHtml).trim();
    if (!newText) {
      this.setStatus(this.t('edit.emptyTextAbort'), false, 5000);
      return;
    }
    const origText = htmlToText(this.originalHtml || '').trim();
    if (origText.length > 50 && newText.length < origText.length * 0.2) {
      if (!confirm(this.t('edit.shorterConfirm', { newLen: newText.length, oldLen: origText.length }))) return;
    }

    this.editSaving = true;
    this.setStatus(this.t('edit.saving'), true);
    try {
      const saved = await this.bsPut('pages/' + this.currentPage.id, {
        html: newHtml,
        name: this.currentPage.name,
      });
      if (saved?.updated_at) this.currentPage.updated_at = saved.updated_at;

      this.originalHtml = newHtml;
      this.currentPageEmpty = !htmlToText(newHtml).trim();

      this._filterFindingsAfterSave(newHtml);
      this._syncPageStatsAfterSave?.(this.currentPage, newHtml);

      clearDraft(this.currentPage.id);
      this.lastAutosaveAt = Date.now();
      this.lastDraftSavedAt = null;
      this.editDirty = false;
      this.saveOffline = false;
      this.updatePageView();
      if (this.focusMode) {
        this.setStatus(this.t('edit.changesSaved'), false, 3000);
      } else {
        this._stopAutosave();
        this._uninstallOnlineRetry();
        this.editMode = false;
        this.closeSynonymMenu?.();
        this.closeSynonymPicker?.();
        this.setStatus(this.t('edit.changesSaved'), false, 5000);
      }
    } catch (e) {
      console.error('[saveEdit]', e);
      // Netzwerkfehler → Draft behalten, Offline-Modus aktivieren, Auto-Retry.
      writeDraft(this.currentPage.id, newHtml, this.originalHtml);
      this.lastDraftSavedAt = Date.now();
      this.saveOffline = true;
      if (!navigator.onLine) {
        this.setStatus(this.t('edit.offlineSaved'), false, 8000);
      } else {
        this.setStatus(this.t('edit.saveFailed', { msg: e.message }), false, 8000);
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

    const localeTag = (this.uiLocale === 'en') ? 'en-US' : 'de-DE';

    if (!navigator.onLine) {
      this.saveOffline = true;
      this.setStatus(this.t('edit.offlineSavedAt', { time: new Date().toLocaleTimeString(localeTag) }), false, 3000);
      return;
    }

    try {
      const saved = await this.bsPut('pages/' + this.currentPage.id, {
        html: newHtml,
        name: this.currentPage.name,
      });
      if (saved?.updated_at) this.currentPage.updated_at = saved.updated_at;
      this.originalHtml = newHtml;
      this.editDirty = false;
      this.saveOffline = false;
      this.lastAutosaveAt = Date.now();
      this.lastDraftSavedAt = null;
      clearDraft(this.currentPage.id);
      this.currentPageEmpty = !htmlToText(newHtml).trim();
      this._filterFindingsAfterSave(newHtml);
      this._syncPageStatsAfterSave?.(this.currentPage, newHtml);
      this.updatePageView();
      this.setStatus(this.t('edit.savedAt', { time: new Date().toLocaleTimeString(localeTag) }), false, 2500);
    } catch (e) {
      console.error('[quickSave]', e);
      this.saveOffline = true;
      this.setStatus(this.t('edit.saveFailedRetry'), false, 6000);
    }
  },

  // Paste-Handler: Browser injiziert beim Paste (besonders aus anderen
  // BookStack-Seiten / Websites mit Lato) Computed-Styles inline auf jeden
  // Block. Ohne Sanitisierung landen `<p style="font-family:Lato;color:..."`-
  // Hüllen in der DB und überschreiben dort .poem & Co. Wir parsen das
  // Clipboard-HTML, kleinen es durch den gleichen Cleaner wie der Save-Pfad
  // und fügen sauber via execCommand ein.
  _onEditPaste(e) {
    const cd = e.clipboardData;
    if (!cd) return;
    e.preventDefault();

    const html = cd.getData('text/html');
    if (html) {
      document.execCommand('insertHTML', false, cleanContentArtefacts(html));
    } else {
      const text = cd.getData('text/plain') || '';
      if (text) document.execCommand('insertText', false, text);
    }
    this._markEditDirty();
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
      this._flushDraftSaveNow();
    }, DRAFT_DEBOUNCE_MS);
  },

  // Schreibt den aktuellen Editor-Inhalt sofort als Draft – unabhängig vom
  // Debounce-Timer. Aufruf vor jedem Zustandsübergang, der den Editor-Inhalt
  // nicht mehr einfängt (Focus-Mode-Entry) oder ihn riskieren könnte zu
  // verlieren. Beim Aufruf nach Debounce-Fire ist _draftTimer bereits null
  // (ungefährlicher No-op).
  _flushDraftSaveNow() {
    if (this._draftTimer) { clearTimeout(this._draftTimer); this._draftTimer = null; }
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
