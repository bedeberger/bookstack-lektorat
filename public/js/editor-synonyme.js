import { fetchJson } from './utils.js';
import { rangeForWordAtClientPoint } from './editor-figur-lookup.js';
import { WORD_RE } from './editor-utils.js';
import { startPoll } from './cards/job-helpers.js';

// Synonym-Ermittler für den contenteditable-Editor.
// Rechtsklick auf ein markiertes Einzelwort → Custom-Menü → KI-Call →
// Picker mit Synonymvorschlägen → Klick ersetzt das Wort im DOM.
//
// Zweigeteilt:
//   - `synonymMethods`: Root-Trigger am contenteditable. Extrahiert Range +
//     Wort, dispatcht `editor:synonym:open {range, word, x, y}`. Enthält
//     Trampoline `closeSynonymMenu/Picker`, `requestSynonyms` für Legacy-
//     Aufrufer (app-view.resetPage, editor-edit.cancelEdit/saveEdit).
//   - `synonymCardMethods`: Menü/Picker-Display + Thesaurus/KI-Fetch in
//     Alpine.data('editorSynonymeCard').

export const synonymMethods = {
  _onEditContextMenu(e) {
    if (!this.editMode) return;
    // macOS: Ctrl+Klick feuert `contextmenu` statt `click`. Deshalb Figuren-
    // Lookup auch hier versuchen, sonst ginge Ctrl+Klick auf eine Figur auf
    // Mac nie.
    if ((e.ctrlKey || e.metaKey) && this._tryOpenFigurLookupAt?.(e)) return;

    // Mobile: natives Kontextmenü behalten, Synonym-Feature ist Desktop-only.
    if (window.innerWidth <= 768) return;
    const editEl = this._getEditEl?.();
    if (!editEl) return;
    const sel = window.getSelection();

    let range = null;
    let wort = '';
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
      const text = sel.toString().trim();
      if (!text || !WORD_RE.test(text)) return;
      const r = sel.getRangeAt(0);
      if (!editEl.contains(r.commonAncestorContainer)) return;
      range = r.cloneRange();
      wort  = text;
    } else {
      // Safari markiert beim Rechtsklick auf ein Wort die Auswahl nicht
      // automatisch — Wort unter Cursor selbst ermitteln.
      const hit = rangeForWordAtClientPoint(e.clientX, e.clientY);
      if (!hit) return;
      if (!editEl.contains(hit.range.commonAncestorContainer)) return;
      range = hit.range;
      wort  = hit.word;
      // Sichtbare Selektion setzen, damit der User weiss, auf welches Wort
      // sich das Menü bezieht.
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range.cloneRange());
      }
    }

    e.preventDefault();
    window.dispatchEvent(new CustomEvent('editor:synonym:open', {
      detail: { range, word: wort, clientX: e.clientX, clientY: e.clientY },
    }));
  },

  // Trampoline für Legacy-Aufrufer.
  closeSynonymMenu() {
    window.dispatchEvent(new CustomEvent('editor:synonym:close-menu'));
  },
  closeSynonymPicker() {
    window.dispatchEvent(new CustomEvent('editor:synonym:close-picker'));
  },
  // Wird vom Menü-Button im Partial aufgerufen (Root-Scope wegen Event-Bubble).
  requestSynonyms() {
    window.dispatchEvent(new CustomEvent('editor:synonym:request'));
  },
};

// ── Sub-Komponenten-Methoden ──────────────────────────────────────────────
// `this` zeigt auf die Alpine.data('editorSynonymeCard')-Instanz.
export const synonymCardMethods = {
  _openSynonymMenu({ range, word, clientX, clientY }) {
    if (!range || !word) return;
    this._synonymRange = range;
    this._synonymWord  = word;
    this.showSynonymPicker = false;
    this.synonymThesList = [];
    this.synonymThesError = '';
    this.synonymThesDisabled = false;
    this.synonymKiList = [];
    this.synonymKiError = '';
    this.showSynonymMenu = true;
    this._syncOpenFlag();
    this._attachSynonymScroll();
    this.$nextTick(() => this._positionSynonymUI(clientX, clientY));
    this._positionSynonymUI(clientX, clientY);
  },

  // Spiegelt den Sichtbarkeits-Zustand an den Root, damit focus-onKey
  // (Escape) weiss, ob ein Menü/Picker offen ist, ohne in die Sub zu greifen.
  _syncOpenFlag() {
    const app = window.__app;
    if (app) {
      app._synonymMenuOpen   = this.showSynonymMenu;
      app._synonymPickerOpen = this.showSynonymPicker;
    }
  },

  // Neupositionierung anhand der aktuellen Range. Wird initial und bei jedem
  // Scroll/Resize aufgerufen. Flippt nach oben, wenn unten kein Platz ist.
  _positionSynonymUI() {
    const range = this._synonymRange;
    if (!range) return;
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      // Range ungültig geworden (z.B. DOM-Änderung)
      this.closeSynonymMenu();
      this.closeSynonymPicker();
      return;
    }
    const isPicker = this.showSynonymPicker;
    const el = document.querySelector(isPicker ? '.synonym-picker' : '.synonym-menu');
    const h = el?.offsetHeight || (isPicker ? 360 : 44);
    const w = el?.offsetWidth  || (isPicker ? 300 : 220);
    const spaceBelow = window.innerHeight - rect.bottom;
    const placeBelow = spaceBelow >= h + 8;
    this.synonymMenuX = Math.max(8, Math.min(Math.round(rect.left), window.innerWidth - w - 8));
    this.synonymMenuY = placeBelow
      ? Math.round(rect.bottom + 4)
      : Math.max(8, Math.round(rect.top - h - 4));
  },

  _attachSynonymScroll() {
    if (this._synonymScrollHandler) return;
    const handler = () => this._positionSynonymUI();
    // Capture-Phase, damit auch Scrolls in inneren Containern (edit area) erfasst werden
    window.addEventListener('scroll', handler, true);
    window.addEventListener('resize', handler);
    this._synonymScrollHandler = handler;
  },

  _detachSynonymScroll() {
    if (!this._synonymScrollHandler) return;
    window.removeEventListener('scroll', this._synonymScrollHandler, true);
    window.removeEventListener('resize', this._synonymScrollHandler);
    this._synonymScrollHandler = null;
  },

  closeSynonymMenu() {
    this.showSynonymMenu = false;
    this._syncOpenFlag();
    // User schliesst das Kontextmenü, bevor er Synonyme requested → Picker
    // läuft nicht. Falls aber ein Polling-Timer aus früherer Session noch
    // aktiv ist (race), hier ebenfalls räumen — sonst pollt er bis Timeout/
    // Job-NotFound zombie weiter.
    if (this._synonymPollTimer) { clearInterval(this._synonymPollTimer); this._synonymPollTimer = null; }
    if (!this.showSynonymPicker) this._detachSynonymScroll();
  },

  closeSynonymPicker() {
    this.showSynonymPicker = false;
    this._syncOpenFlag();
    const wasLoading = this.synonymKiLoading;
    const jobId = this._synonymJobId;
    this.synonymThesList = [];
    this.synonymThesError = '';
    this.synonymThesDisabled = false;
    this.synonymKiList = [];
    this.synonymKiError = '';
    this.synonymKiLoading = false;
    if (this._synonymPollTimer) { clearInterval(this._synonymPollTimer); this._synonymPollTimer = null; }
    this._synonymJobId = null;
    if (wasLoading && jobId) {
      fetch('/jobs/' + jobId, { method: 'DELETE' }).catch(() => {});
    }
    if (!this.showSynonymMenu) this._detachSynonymScroll();
  },

  // Extrahiert den Satz um das gewählte Wort. Nimmt den Textinhalt des
  // umschliessenden Block-Elements (P/LI/DIV/…) und schneidet den Satz um den Wort-Offset.
  _extractSentence(range, wort) {
    let node = range.startContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    const block = node?.closest?.('p, li, blockquote, h1, h2, h3, h4, h5, h6, div') || node;
    const full = (block?.textContent || '').replace(/\s+/g, ' ').trim();
    if (!full) return wort;

    // Offset des Wortes: über pre-range vom Block-Anfang bis zur Selection-Start-Position
    let offset = -1;
    try {
      const pre = document.createRange();
      pre.selectNodeContents(block);
      pre.setEnd(range.startContainer, range.startOffset);
      offset = pre.toString().replace(/\s+/g, ' ').length;
    } catch { /* Fallback via indexOf */ }
    if (offset < 0 || offset > full.length) offset = full.indexOf(wort);
    if (offset < 0) return full.length <= 400 ? full : wort;

    // Satzgrenzen: letztes Satzzeichen vor dem Wort, nächstes danach.
    const before = full.slice(0, offset);
    const after  = full.slice(offset);
    const startMatch = before.match(/[.!?…][\s"»)]*(?=[^.!?…]*$)/);
    const start = startMatch ? startMatch.index + startMatch[0].length : 0;
    const endMatch = after.match(/[.!?…]/);
    const end = endMatch ? offset + endMatch.index + 1 : full.length;
    const sentence = full.slice(start, end).trim();
    return sentence || full;
  },

  async requestSynonyms() {
    if (!this._synonymRange || !this._synonymWord) return;
    const app = window.__app;
    const wort = this._synonymWord;
    const satz = this._extractSentence(this._synonymRange, wort);
    const bookId = app?.currentPage?.book_id || null;
    this.showSynonymMenu = false;
    this.synonymThesLoading = true;
    this.synonymThesError = '';
    this.synonymThesDisabled = false;
    this.synonymThesList = [];
    this.synonymKiLoading = true;
    this.synonymKiError = '';
    this.synonymKiList = [];
    this.showSynonymPicker = true;
    this._syncOpenFlag();
    this._attachSynonymScroll();
    this.$nextTick(() => this._positionSynonymUI());

    // OpenThesaurus: paralleler Sync-Call, keine Job-Queue
    const thesUrl = `/openthesaurus/synonyms?word=${encodeURIComponent(wort)}` + (bookId ? `&book_id=${bookId}` : '');
    fetchJson(thesUrl)
      .then(d => {
        this.synonymThesDisabled = !!d.disabled;
        this.synonymThesList = Array.isArray(d.synonyme) ? d.synonyme : [];
        if (!this.synonymThesDisabled && this.synonymThesList.length === 0) {
          this.synonymThesError = app?.t('synonym.noMatches') || '';
        }
      })
      .catch(e => { this.synonymThesError = e.message || (app?.t('synonym.error') || ''); })
      .finally(() => {
        this.synonymThesLoading = false;
        this.$nextTick(() => this._positionSynonymUI());
      });

    // KI via Job-Queue (bestehend)
    try {
      const { jobId, error } = await fetchJson('/jobs/synonym', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wort, satz, book_id: bookId }),
      });
      if (!jobId) throw new Error(error || app?.t('synonym.jobFailed'));
      this._synonymJobId = jobId;
      this._startSynonymPoll(jobId);
    } catch (e) {
      this.synonymKiLoading = false;
      this.synonymKiError = e.message;
    }
  },

  _startSynonymPoll(jobId) {
    const app = window.__app;
    startPoll(this, {
      timerProp: '_synonymPollTimer',
      jobId,
      lsKey: null,
      onProgress: () => { /* keine Progress-Anzeige, kurzer Call */ },
      onNotFound: () => {
        this.synonymKiLoading = false;
        this.synonymKiError = app?.t('synonym.jobUnavailable') || '';
        this._synonymJobId = null;
      },
      onError: (job) => {
        this.synonymKiLoading = false;
        this.synonymKiError = job.error ? app.t(job.error, job.errorParams) : app.t('synonym.kiFailed');
        this._synonymJobId = null;
      },
      onDone: (job) => {
        this.synonymKiLoading = false;
        this._synonymJobId = null;
        this.synonymKiList = Array.isArray(job.result?.synonyme) ? job.result.synonyme : [];
        if (this.synonymKiList.length === 0) {
          this.synonymKiError = app?.t('synonym.noneFound') || '';
        }
        this.$nextTick(() => this._positionSynonymUI());
      },
    });
  },

  applySynonym(entry) {
    const range = this._synonymRange;
    const app = window.__app;
    if (!range || !entry?.wort) { this.closeSynonymPicker(); return; }
    const editEl = app?._getEditEl?.();
    if (!editEl || !editEl.contains(range.startContainer)) { this.closeSynonymPicker(); return; }
    try {
      range.deleteContents();
      range.insertNode(document.createTextNode(entry.wort));
      // Ersatzwort nach Einfügung selektieren, damit der User sieht, was passiert ist
      const sel = window.getSelection();
      sel.removeAllRanges();
      app?._markEditDirty?.();
    } catch (e) {
      console.error('[applySynonym]', e);
    }
    this.closeSynonymPicker();
  },
};
