import { escHtml } from './utils.js';

// Synonym-Ermittler für den contenteditable-Editor.
// Rechtsklick auf ein markiertes Einzelwort → Custom-Menü → KI-Call →
// Picker mit Synonymvorschlägen → Klick ersetzt das Wort im DOM.

// Ein "Einzelwort" ist eine zusammenhängende Sequenz aus Buchstaben/Ziffern.
// Bindestriche und Apostrophe zählen mit, damit «auf-/abwärts» oder «wir's» erfasst werden.
const WORD_RE = /^[\p{L}\p{N}][\p{L}\p{N}\-']*$/u;

export const synonymMethods = {
  // ── State (wird in der Alpine-Komponente via Spread ergänzt) ─────────────
  // showSynonymMenu, synonymMenuX, synonymMenuY, showSynonymPicker
  // synonymThesList / synonymThesLoading / synonymThesError / synonymThesDisabled
  // synonymKiList / synonymKiLoading / synonymKiError
  // _synonymRange, _synonymWord, _synonymPollTimer

  _onEditContextMenu(e) {
    if (!this.editMode) return;
    // Mobile: natives Kontextmenü behalten, Synonym-Feature ist Desktop-only.
    if (window.innerWidth <= 768) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const text = sel.toString();
    if (!text || !WORD_RE.test(text.trim())) return;

    // Selection muss innerhalb des Edit-Containers liegen
    const editEl = this._getEditEl?.();
    if (!editEl) return;
    const range = sel.getRangeAt(0);
    if (!editEl.contains(range.commonAncestorContainer)) return;

    e.preventDefault();
    this._synonymRange = range.cloneRange();
    this._synonymWord  = text.trim();
    this.showSynonymPicker = false;
    this.synonymThesList = [];
    this.synonymThesError = '';
    this.synonymThesDisabled = false;
    this.synonymKiList = [];
    this.synonymKiError = '';
    this.showSynonymMenu = true;
    this._attachSynonymScroll();
    this.$nextTick(() => this._positionSynonymUI());
    // Erstpositionierung bereits vor nextTick, damit kein Flash oben links
    this._positionSynonymUI();
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
    if (!this.showSynonymPicker) this._detachSynonymScroll();
  },

  closeSynonymPicker() {
    this.showSynonymPicker = false;
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
    const wort = this._synonymWord;
    const satz = this._extractSentence(this._synonymRange, wort);
    const bookId = this.currentPage?.book_id || null;
    this.showSynonymMenu = false;
    this.synonymThesLoading = true;
    this.synonymThesError = '';
    this.synonymThesDisabled = false;
    this.synonymThesList = [];
    this.synonymKiLoading = true;
    this.synonymKiError = '';
    this.synonymKiList = [];
    this.showSynonymPicker = true;
    this._attachSynonymScroll();
    this.$nextTick(() => this._positionSynonymUI());

    // OpenThesaurus: paralleler Sync-Call, keine Job-Queue
    const thesUrl = `/openthesaurus/synonyms?word=${encodeURIComponent(wort)}` + (bookId ? `&book_id=${bookId}` : '');
    fetch(thesUrl)
      .then(r => r.json())
      .then(d => {
        this.synonymThesDisabled = !!d.disabled;
        this.synonymThesList = Array.isArray(d.synonyme) ? d.synonyme : [];
        if (!this.synonymThesDisabled && this.synonymThesList.length === 0) {
          this.synonymThesError = this.t('synonym.noMatches');
        }
      })
      .catch(e => { this.synonymThesError = e.message || this.t('synonym.error'); })
      .finally(() => {
        this.synonymThesLoading = false;
        this.$nextTick(() => this._positionSynonymUI());
      });

    // KI via Job-Queue (bestehend)
    try {
      const { jobId, error } = await fetch('/jobs/synonym', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wort, satz, book_id: bookId }),
      }).then(r => r.json());
      if (!jobId) throw new Error(error || this.t('synonym.jobFailed'));
      this._synonymJobId = jobId;
      this._startSynonymPoll(jobId);
    } catch (e) {
      this.synonymKiLoading = false;
      this.synonymKiError = e.message;
    }
  },

  _startSynonymPoll(jobId) {
    this._startPoll({
      timerProp: '_synonymPollTimer',
      jobId,
      lsKey: null,
      onProgress: () => { /* keine Progress-Anzeige, kurzer Call */ },
      onNotFound: () => {
        this.synonymKiLoading = false;
        this.synonymKiError = this.t('synonym.jobUnavailable');
        this._synonymJobId = null;
      },
      onError: (job) => {
        this.synonymKiLoading = false;
        this.synonymKiError = job.error || this.t('synonym.kiFailed');
        this._synonymJobId = null;
      },
      onDone: (job) => {
        this.synonymKiLoading = false;
        this._synonymJobId = null;
        this.synonymKiList = Array.isArray(job.result?.synonyme) ? job.result.synonyme : [];
        if (this.synonymKiList.length === 0) {
          this.synonymKiError = this.t('synonym.noneFound');
        }
        this.$nextTick(() => this._positionSynonymUI());
      },
    });
  },

  applySynonym(entry) {
    const range = this._synonymRange;
    if (!range || !entry?.wort) { this.closeSynonymPicker(); return; }
    const editEl = this._getEditEl?.();
    if (!editEl || !editEl.contains(range.startContainer)) { this.closeSynonymPicker(); return; }
    try {
      range.deleteContents();
      range.insertNode(document.createTextNode(entry.wort));
      // Ersatzwort nach Einfügung selektieren, damit der User sieht, was passiert ist
      const sel = window.getSelection();
      sel.removeAllRanges();
      this._markEditDirty?.();
    } catch (e) {
      console.error('[applySynonym]', e);
    }
    this.closeSynonymPicker();
  },
};
