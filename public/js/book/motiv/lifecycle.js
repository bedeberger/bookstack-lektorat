// Motiv-Werkstatt — Lifecycle + abgeleitete Werte. Lädt den Graph-Payload
// (Themen + Motive mit Soll-Links & Ist-Count + Beziehungen) und hält die
// abgeleiteten Aggregate memoized. Rein rückwärtsgewandt/planend.

import { fetchJson } from '../../utils.js';

export const lifecycleMethods = {
  // Ein Memo-Helper pro Modul (Array-Deps, shallow ===). Reset über this._memos = {}.
  _memo(key, deps, fn) {
    const prev = this._memos[key];
    if (prev && prev.deps.length === deps.length && prev.deps.every((d, i) => d === deps[i])) return prev.val;
    const val = fn();
    this._memos[key] = { deps, val };
    return val;
  },

  async loadBoard() {
    const bookId = this.$store.nav.selectedBookId;
    if (!bookId) return;
    this.loading = true;
    this.errorMessage = '';
    try {
      const data = await fetchJson(`/motifs?book_id=${bookId}`);
      this.themes = data.themes || [];
      this.motifs = data.motifs || [];
      this.relations = data.relations || [];
      this.embedIndexStale = !!data.embedIndex?.stale;
      this._savedPositions = data.layout || {};
      this._memos = {};
      // Persistierte KI-Brainstorm-Läufe (Historie) mitladen.
      this.loadBrainstormRuns();
      // Konsistenz-Befunde mitziehen (deterministisch + billig, kein KI-Lauf) —
      // so trägt der Reiter seine Zahl, ohne dass man ihn erst öffnen muss.
      this.loadMotifChecks();
      // Persistierte KI-Prüfungs-Läufe (Historie) mitladen.
      this.loadConsistencyRuns();
      // Figuren fürs Figuren-Layer + Verknüpfungs-Combobox bereitstellen.
      if (!this.$store.catalog.figuren?.length) window.__app.loadFiguren(bookId);
      this.$nextTick(() => this.renderMotivGraph());
      // Geparkter Cross-Card-Sprung (motiv:select vor dem Board-Load) → jetzt auswählen.
      if (this._pendingMotifId) {
        const pid = this._pendingMotifId;
        this._pendingMotifId = null;
        if (this.motifById(pid)) this.selectMotif(pid);
      }
    } catch (e) {
      this.errorMessage = window.__app.t('motiv.error.load');
    } finally {
      this.loading = false;
    }
  },

  resetMotiv() {
    this._destroyGraph();
    this.themes = [];
    this.motifs = [];
    this.relations = [];
    this.selectedMotifId = null;
    this.selectedThemeId = null;
    this.motivView = 'graph';
    this.checks = [];
    this.checksScanned = true;
    this.selectedCheckIdx = null;
    this.consistencyResult = null;
    this.consistencyRuns = [];
    this.selectedConsistencyRunId = null;
    this.selectedKonfliktIdx = null;
    this.occurrences = [];
    this.editThemeName = '';
    this.editThemeBeschreibung = '';
    this.editThemeId = '';
    this.editName = '';
    this.editBeschreibung = '';
    this.editTriggers = '';
    this.editFigures = [];
    this.editDraftFigures = [];
    this.editBeats = [];
    this.editChapters = [];
    this.editPages = [];
    this.allBeats = [];
    this.allActs = [];
    this._beatsLoaded = false;
    this.allDraftFiguren = [];
    this._draftFigurenLoaded = false;
    this.errorMessage = '';
    this.embedIndexStale = false;
    this.suggestions = [];
    this.brainstormRuns = [];
    this.selectedBrainstormRunId = null;
    this._savedPositions = null;
    this._pendingMotifId = null;
    this._memos = {};
  },

  // ── Abgeleitete Werte ─────────────────────────────────────────────────────

  motifById(id) {
    return this.motifs.find(m => m.id === id) || null;
  },

  selectedMotif() {
    return this.selectedMotifId ? this.motifById(this.selectedMotifId) : null;
  },

  themeById(id) {
    return this.themes.find(t => t.id === id) || null;
  },

  selectedTheme() {
    return this.selectedThemeId ? this.themeById(this.selectedThemeId) : null;
  },

  // Ein Motiv gilt als „geplant, aber fehlt" (Geist), wenn es Soll-Verknüpfungen
  // hat, aber die KI-Erkennung 0 Fundstellen fand.
  isGhost(m) {
    const linked = (m.figures?.length || 0) + (m.beats?.length || 0) + (m.chapters?.length || 0) + (m.pages?.length || 0);
    return linked > 0 && (m.occurrenceCount || 0) === 0;
  },

  motivStats() {
    return this._memo('stats', [this.motifs, this.themes], () => {
      const withOcc = this.motifs.filter(m => (m.occurrenceCount || 0) > 0).length;
      const ghosts = this.motifs.filter(m => this.isGhost(m)).length;
      return { motifs: this.motifs.length, themes: this.themes.length, withOcc, ghosts };
    });
  },

  // Themen-Optionen fürs Combobox (leere Option = „ohne Thema").
  themeOptions() {
    return this._memo('themeOptions', [this.themes], () =>
      this.themes.map(t => ({ value: String(t.id), label: t.name })));
  },
};
