// Plot-Werkstatt: Lifecycle (Board laden, Reset) + Memo-Helper.
// _memo lebt hier und wird in die Facade gespreadet — alle Sub-Module nutzen
// `this._memo` über den gemeinsamen `this._memos`-Speicher pro Card-Instanz.

import { fetchJson } from '../../utils.js';

export const lifecycleMethods = {
  // ── Memo-Helper (ein Helper pro Modul, Array-Deps shallow ===) ─────────────
  _memo(key, deps, fn) {
    const cache = (this._memos = this._memos || {});
    const prev = cache[key];
    if (prev && prev.deps.length === deps.length && prev.deps.every((d, i) => d === deps[i])) {
      return prev.val;
    }
    const val = fn();
    cache[key] = { deps, val };
    return val;
  },

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  async loadBoard() {
    const app = window.__app;
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) { this.acts = []; this.threads = []; this.beats = []; this.draftFiguren = []; this.motifsCatalog = []; this.themesCatalog = []; return; }
    this.loading = true;
    this._memos = {};
    // Jeder Reload kann fremde/serverseitige Änderungen mitbringen (Fork/Unfork,
    // Fehler-Rollback, zweites Gerät) — Undo-Records darauf wären inkonsistent.
    this._clearHistory();
    try {
      const data = await fetchJson(`/plot?book_id=${bookId}`);
      this.acts = Array.isArray(data.acts) ? data.acts : [];
      this.threads = Array.isArray(data.threads) ? data.threads : [];
      this.beats = Array.isArray(data.beats) ? data.beats : [];
      this.relations = Array.isArray(data.relations) ? data.relations : [];
      // Ist-Index-Staleness (Beats seit letztem Anchor-Lauf geändert) → Header
      // bietet „Verankerung aktualisieren" an.
      this.beatAnchorStale = !!(data.beatAnchor && data.beatAnchor.stale);
      this.errorMessage = '';
    } catch (e) {
      this.errorMessage = app.t('plot.error.load');
      this.acts = []; this.threads = []; this.beats = []; this.relations = [];
    } finally {
      this.loading = false;
    }
    // Werkstatt-Figuren separat laden — ein Fehler hier darf das Board nicht
    // leeren (Board ist die Primärdaten, Drafts nur Beilage fürs Picker/Badge).
    // draftFigurenById (Getter in plot-card.js) baut sich aus der neuen Referenz neu.
    try {
      const drafts = await fetchJson(`/draft-figures/${bookId}`);
      this.draftFiguren = Array.isArray(drafts) ? drafts : [];
    } catch (e) {
      this.draftFiguren = [];
    }
    // Motiv-Katalog + Themen fürs Beat-Motiv-Picker (best-effort, eigenständig vom
    // Board). `theme_id` bleibt am Motiv, damit das Picker nach Thema gruppieren
    // kann; `themesCatalog` (id + name, bereits in Position-Reihenfolge) liefert
    // Gruppen-Label + -Ordnung. Die Badge-Farbe liefert der Server pro Beat.
    try {
      const data = await fetchJson(`/motifs?book_id=${bookId}`);
      this.motifsCatalog = Array.isArray(data?.motifs)
        ? data.motifs.map(m => ({ id: m.id, name: m.name, theme_id: m.theme_id ?? null }))
        : [];
      this.themesCatalog = Array.isArray(data?.themes)
        ? data.themes.map(t => ({ id: t.id, name: t.name }))
        : [];
    } catch (e) {
      this.motifsCatalog = [];
      this.themesCatalog = [];
    }
    // Konsistenz- + Brainstorm-Historie laden (best-effort, eigenständig vom Board).
    this.loadConsistencyRuns();
    this.loadBrainstormRuns();
    // Deep-Link-Ziel (#book/X/plot/<beatId>) nach Board-Load anwenden.
    const pendingBeat = this._pendingFocusBeatId;
    this._pendingFocusBeatId = null;
    if (pendingBeat != null) this._focusBeatById(pendingBeat);
    // Beat-Zellen für SortableJS (neu) binden, sobald das Board gerendert ist.
    this._scheduleReattach?.();
  },

  resetPlot() {
    this._clearJobs();
    this._clearHistory();
    this.acts = [];
    this.threads = [];
    this.beats = [];
    this.relations = [];
    this.relDraftTyp = '';
    this.relDraftTarget = '';
    this.draftFiguren = [];
    this.motifsCatalog = [];
    this.themesCatalog = [];
    this._memos = {};
    this.editingBeatId = null;
    this.addingActId = null;
    this.addingCell = null;
    this.newBeatTitel = '';
    this.editingActId = null;
    this.actDraft = '';
    this.addingAct = false;
    this.addingActScope = false;
    this.newActName = '';
    this.editingThreadId = null;
    this.addingThread = false;
    this.newThreadName = '';
    this.threadColorPickerId = null;
    this.threadActionsOpenId = null;
    this._detachThreadMenuListeners?.();
    this.beatOccPopoverBeatId = null;
    this._detachOccPopoverListeners?.();
    this._dragBeatId = null;
    this.brainstormResult = null;
    this.brainstormActId = null;
    this.brainstormThreadId = null;
    this.consistencyResult = null;
    this.selectedKonfliktIdx = null;
    this.consistencyRuns = [];
    this.selectedRunId = null;
    this.brainstormRuns = [];
    this.selectedBrainstormRunId = null;
    this.beatAnchorStale = false;
    this.anchorProgress = 0;
    this._pendingFocusBeatId = null;
    if (window.Alpine) window.Alpine.store('nav').plotBeatId = null;
    this.plotFilters = { kapitel: '', figurId: '', draftFigurId: '', status: '', text: '' };
    this.tensionFocusFigur = '';
    this.verworfenOpen = {};
    this.actColorPickerId = null;
    this.errorMessage = '';
    this.busy = false;
  },
};
