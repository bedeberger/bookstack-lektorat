// Plot-Werkstatt — abgeleitete Reads (Teil 3): Verworfen-Collapse, Konsistenz-
// Befunde ↔ Beats, Kapitel-/Figuren-Coverage (lokale Aggregate, kein KI-Job),
// Volltext-/Kapitel-/Figur-Filter.

import { normTitle } from '../constants.js';

// Schwere-Rangfolge (höher = gravierender) für die Badge-Farbwahl am Beat.
const SEV_RANK = { kritisch: 5, stark: 4, mittel: 3, schwach: 2, niedrig: 1 };

export const coverageMethods = {
  // ── Verworfen-Collapse (pro Akt) ────────────────────────────────────────────
  // Verworfene Beats werden eingeklappt, damit sie die Spalte nicht aufblähen;
  // ein „+N verworfen"-Toggle blendet sie ein. Drag/Reorder bleibt unberührt
  // (operiert weiter auf beatsForAct/filteredBeatsForAct mit allen Beats).
  visibleBeatsForAct(actId) {
    const base = this.filteredBeatsForAct(actId);
    if (this.verworfenOpen[actId]) return base;
    return this._memo(`vbeats:${actId}`, [base], () => base.filter(b => !b.verworfen));
  },

  // Memoisiert auf die (ihrerseits memoisierte) Akt-Liste: plot-board-flat.html
  // liest die Zahl zweimal pro Akt-Spalte (Sichtbarkeit + Label).
  verworfenCountForAct(actId) {
    const base = this.filteredBeatsForAct(actId);
    return this._memo(`vcount:${actId}`, [base], () => base.filter(b => b.verworfen).length);
  },

  toggleVerworfen(actId) {
    this.verworfenOpen = { ...this.verworfenOpen, [actId]: !this.verworfenOpen[actId] };
  },

  // ── Konsistenz-Befunde ↔ Beats (aktiver Lauf) ──────────────────────────────
  // Index der Befunde des gerade angezeigten Laufs, zwei Achsen:
  //   byId    — Befunde mit stabiler beat_id (überleben Umbenennungen)
  //   byTitle — Befunde ohne beat_id (Alt-Läufe / Modelle ohne [#…]-Echo) per Titel
  // Übergreifende Befunde ("—", kein Beat-Ziel) fallen raus. Memoisiert auf das
  // Result-Objekt — es wird bei jedem Lauf/Öffnen neu zugewiesen, sodass der
  // Referenz-Vergleich greift.
  _konfliktIndex() {
    return this._memo('konfliktIdx', [this.consistencyResult], () => {
      const byId = new Map();
      const byTitle = new Map();
      const ks = this.consistencyResult?.konflikte || [];
      ks.forEach((k, idx) => {
        const entry = { ...k, idx };
        if (k.beat_id != null) {
          if (!byId.has(k.beat_id)) byId.set(k.beat_id, []);
          byId.get(k.beat_id).push(entry);
          return;
        }
        const key = normTitle(k.beat);
        if (!key || key === '—') return;
        if (!byTitle.has(key)) byTitle.set(key, []);
        byTitle.get(key).push(entry);
      });
      return { byId, byTitle };
    });
  },

  // Befunde, die genau diesen Beat betreffen — per stabiler ID plus (für Befunde
  // ohne beat_id) per Titel. Leer, wenn kein Lauf angezeigt wird oder der Beat
  // sauber ist.
  beatKonflikte(beat) {
    if (!this.consistencyResult || !beat) return [];
    const idx = this._konfliktIndex();
    return [
      ...(idx.byId.get(beat.id) || []),
      ...(idx.byTitle.get(normTitle(beat.titel)) || []),
    ];
  },

  // Höchste Schwere unter den Befunden eines Beats (steuert die Badge-Farbe).
  beatTopSeverity(beat) {
    let top = 'mittel', rank = 0;
    for (const k of this.beatKonflikte(beat)) {
      const r = SEV_RANK[k.schwere] || 0;
      if (r > rank) { rank = r; top = k.schwere; }
    }
    return top;
  },

  // Tooltip am Warn-Badge: alle Probleme dieses Beats untereinander.
  beatKonflikteTip(beat) {
    return this.beatKonflikte(beat).map(k => k.problem).filter(Boolean).join('\n');
  },

  // ── Kapitel-Coverage (lokales Aggregat, kein KI-Job) ────────────────────────
  // Welche Buch-Kapitel haben (noch) keinen Beat, und wie viele nicht-verworfenen
  // Beats hängen an keinem Kapitel. Match über das effektive Kapitel (eigenes oder
  // vom Strang geerbt), Quelle sind die $app.tree-Kapitel. Deps inkl. threads, weil
  // das geerbte Kapitel an der Strang-Bindung hängt.
  plotCoverage() {
    const tree = Alpine.store('nav').tree || [];
    return this._memo('coverage', [this.beats, this.threads, tree], () => {
      const chapters = tree.filter(it => it.type === 'chapter');
      const covered = new Set((this.beats || []).map(b => this.effectiveChapterNameForBeat(b)).filter(Boolean));
      const uncovered = chapters.filter(c => !covered.has(c.name)).map(c => c.name);
      const beatsNoChapter = (this.beats || []).filter(b => !this.effectiveChapterNameForBeat(b) && !b.verworfen).length;
      return { uncovered, beatsNoChapter, totalChapters: chapters.length };
    });
  },

  // Lohnt die Coverage-Sektion? Nur wenn Kapitel existieren und es etwas zu
  // melden gibt (offene Kapitel oder kapitellose Beats).
  plotCoverageRelevant() {
    const c = this.plotCoverage();
    return c.totalChapters > 0 && (c.uncovered.length > 0 || c.beatsNoChapter > 0);
  },

  // ── Figuren-Coverage (Cross-Feature: Plot ↔ Figuren-Werkstatt) ──────────────
  // Hat eine Werkstatt-Figur einen ausgearbeiteten Bogen/Subtext (≥1 Kind unter
  // bogen/want/need/wound/lie)? Client-Pendant zu lib/draft-mindmap-extract.js;
  // die stabilen Default-Container-IDs überleben Import + Anlage.
  _draftHasArc(d) {
    const data = d?.mindmap?.data;
    if (!data) return false;
    const find = (n, id) => {
      if (!n) return null;
      if (n.id === id) return n;
      for (const c of n.children || []) { const f = find(c, id); if (f) return f; }
      return null;
    };
    const kids = (id) => (find(data, id)?.children || []).length;
    return (kids('bogen') + kids('want') + kids('need') + kids('wound') + kids('lie')) > 0;
  },

  // Kommt die Werkstatt-Figur im Plot vor — explizit an einem Beat verlinkt ODER
  // als Hauptfigur an einen Strang gebunden (Live-Vererbung)?
  _draftInPlot(d) {
    const inBeat = (this.beats || []).some(b => (b.draft_fig_ids || []).map(String).includes(String(d.id)));
    const inThread = (this.threads || []).some(t => String(t.draft_figure_id) === String(d.id));
    return inBeat || inThread;
  },

  // Cross-Feature-Lücken (lokales Aggregat, kein KI-Job): geplante Tiefe ↔ geplante
  // Handlung. „developedNoPlot" = ausgearbeitete Figur ohne jeden Plot-Beat (Tiefe
  // ohne Handlung); „inPlotNoArc" = im Plot beteiligte Figur ohne ausgearbeiteten
  // Bogen/Subtext (Handlung ohne Tiefe). Beide → Klick öffnet die Werkstatt-Figur.
  figureCoverage() {
    return this._memo('figcov', [this.beats, this.threads, this.draftFiguren], () => {
      const drafts = this.draftFiguren || [];
      const developedNoPlot = [];
      const inPlotNoArc = [];
      for (const d of drafts) {
        const arc = this._draftHasArc(d);
        const inPlot = this._draftInPlot(d);
        if (arc && !inPlot) developedNoPlot.push({ id: d.id, name: d.name });
        else if (!arc && inPlot) inPlotNoArc.push({ id: d.id, name: d.name });
      }
      return { developedNoPlot, inPlotNoArc, total: drafts.length };
    });
  },

  // Lohnt die Figuren-Coverage-Sektion? Nur wenn es Werkstatt-Figuren gibt und
  // mindestens eine Lücke gemeldet werden kann.
  figureCoverageRelevant() {
    const c = this.figureCoverage();
    return c.total > 0 && (c.developedNoPlot.length > 0 || c.inPlotNoArc.length > 0);
  },

  // ── Filter (Volltext / Kapitel / Figur / Status) ────────────────────────────
  // Zwei Achsen mit unterschiedlicher Reichweite: plotFilters ist die Auswahl
  // FÜR DIESES BUCH (pro Buch im localStorage, PLOT_FILTER_SCOPES in
  // plot-card.js; applyDraftFigureFilter weist sie komplett neu zu),
  // plotHideImBuch die Arbeitsgewohnheit ÜBER ALLE BÜCHER (sw:userpref:).
  // Kapitel-Optionen aus den Beats ableiten (buchgeordnet via Root-Helper),
  // damit nur Kapitel angeboten werden, die im Board überhaupt vorkommen.
  plotKapitelListe() {
    return window.__app._deriveKapitel(this.beats, b => this.effectiveChapterNameForBeat(b));
  },

  plotFilterActive() {
    const f = this.plotFilters;
    return !!(f.kapitel || f.figurId || f.draftFigurId || f.status || this.plotHideImBuch || (f.text || '').trim());
  },

  // Beteiligt ein Beat die Katalog-Figur figId — explizit verlinkt ODER implizit
  // über die Strang-Hauptfigur (Live-Vererbung, gleiches Modell wie die Badges)?
  _beatInvolvesCatalog(b, figId) {
    if ((b.fig_ids || []).includes(figId)) return true;
    const t = b.thread_id != null ? this._threadById(b.thread_id) : null;
    return !!(t && String(t.fig_id) === String(figId));
  },

  // Pendant für Werkstatt-Figuren (draft_fig_ids explizit ODER Strang-Bindung).
  _beatInvolvesDraft(b, draftId) {
    if ((b.draft_fig_ids || []).map(String).includes(String(draftId))) return true;
    const t = b.thread_id != null ? this._threadById(b.thread_id) : null;
    return !!(t && String(t.draft_figure_id) === String(draftId));
  },

  _beatMatchesFilter(b) {
    const f = this.plotFilters;
    const txt = (f.text || '').trim().toLowerCase();
    // Figur-Filter beziehen die Strang-Vererbung ein (Beat erbt die Hauptfigur des
    // Strangs), damit der Filter dieselbe Beat-Menge trifft wie das Plot-Badge.
    return (!txt || (b.titel || '').toLowerCase().includes(txt) || (b.beschreibung || '').toLowerCase().includes(txt)) &&
           (!f.kapitel || this.effectiveChapterNameForBeat(b) === f.kapitel) &&
           (!this.plotHideImBuch || b.status !== 'im_buch') &&
           (!f.status || b.status === f.status) &&
           (!f.figurId || this._beatInvolvesCatalog(b, f.figurId)) &&
           (!f.draftFigurId || this._beatInvolvesDraft(b, f.draftFigurId));
  },

  // Cross-Feature: Navigation Werkstatt → Plot (plot:filter-draft-figure). Setzt den
  // Werkstatt-Figur-Filter auf draftId und räumt die übrigen Filter ab, damit der
  // User direkt nur die Beats dieser Figur sieht. Robust gegen den Board-Lade-Race:
  // plotFilters überlebt loadBoard (nur resetPlot leert sie).
  applyDraftFigureFilter(draftId) {
    if (draftId == null) return;
    this.plotFilters = { kapitel: '', figurId: '', draftFigurId: draftId, status: '', text: '' };
  },

  // Gefilterte Beats pro Akt — nur fürs Rendering. Ohne aktiven Filter wird der
  // (bereits memoisierte) ungefilterte beatsForAct-Array unverändert durchgereicht.
  filteredBeatsForAct(actId) {
    const f = this.plotFilters;
    const base = this.beatsForAct(actId);
    if (!this.plotFilterActive()) return base;
    return this._memo(`fbeats:${actId}`, [base, this.threads, f.kapitel, f.figurId, f.draftFigurId, f.status, f.text, this.plotHideImBuch], () =>
      base.filter(b => this._beatMatchesFilter(b)));
  },

  filteredBeatCount() {
    const f = this.plotFilters;
    return this._memo('fcount', [this.beats, this.threads, f.kapitel, f.figurId, f.draftFigurId, f.status, f.text, this.plotHideImBuch], () =>
      (this.beats || []).filter(b => this._beatMatchesFilter(b)).length);
  },

  // Gefilterte Beats einer Grid-Zelle — Pendant zu filteredBeatsForAct. Anders als
  // der flache Akt-Pfad gibt es im Grid keinen Verworfen-Collapse (Zellen sind klein,
  // verworfene Beats bleiben sichtbar/durchgestrichen).
  filteredBeatsForCell(actId, threadId) {
    const f = this.plotFilters;
    const base = this.beatsForCell(actId, threadId);
    if (!this.plotFilterActive()) return base;
    const tid = threadId == null ? null : threadId;
    return this._memo(`fcell:${actId}:${tid}`, [base, this.threads, f.kapitel, f.figurId, f.draftFigurId, f.status, f.text, this.plotHideImBuch], () =>
      base.filter(b => this._beatMatchesFilter(b)));
  },
};
