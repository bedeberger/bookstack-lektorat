// Motiv-Werkstatt — Kapitel-Verlaufsband (zweite Ansicht neben Konstellation und
// Konsistenz-Befunden; die Ansichts-Umschaltung selbst liegt hier).
// Motiv × Kapitel als Heatmap: jede Zeile ein Motiv, jede Spalte ein Kapitel in
// Lesereihenfolge, Zell-Intensität = Ist-Dichte (Fundstellen aus motif_occurrences,
// bereits im Graph-Payload als m.occChapters aggregiert). Zeigt, wo über den
// Buchbogen ein Motiv trägt und wo es verschwindet — die Konstellation zeigt nur
// OB, nicht WO. Rein rückwärtsgewandt/überwachend, nie generativ im Text.
//
// Kein eigener Datenpfad: occChapters [{ chapterId, n }] kommt aus GET /motifs
// (getGraph), die Kapitel-Reihenfolge + Namen aus dem geladenen Sidebar-Tree.

import { fetchJson } from '../../utils.js';

export const bandMethods = {
  // Ansicht umschalten (Konstellation ↔ Verlaufsband). Zurück auf den Graph muss
  // neu gezeichnet + eingepasst werden (Canvas war ausgeblendet → 0-Grösse).
  setMotivView(mode) {
    const next = (mode === 'band' || mode === 'checks') ? mode : 'graph';
    if (this.motivView === next) return;
    this.motivView = next;
    // Zell-Detail gehört zum Band; es beim Verlassen offen zu lassen, hiesse beim
    // Zurückkommen eine Aufklappung ohne den Klick zu zeigen, der sie erzeugt hat.
    this.activeBandDetailKey = null;
    if (next === 'graph') this.$nextTick(() => { this.renderMotivGraph(); this.fitGraph(); });
  },

  // Kapitel in Lesereihenfolge (depth-first) aus dem Sidebar-Tree — nur echte
  // Kapitel (keine Solo-Seiten-Pseudo-Kapitel; occChapters kennt nur echte
  // chapter_ids, Top-Level-Seiten fallen server-seitig raus).
  bandChapters() {
    return this._memo('bandChapters', [this.$store.nav.tree], () =>
      (this.$store.nav.tree || [])
        .filter(t => t.type === 'chapter' && !t.solo)
        .map(t => ({ id: t.id, name: t.name, depth: t.depth || 1 })));
  },

  // Motive fürs Band: nur solche mit ≥1 Fundstelle (all-leere Zeilen wären Rauschen;
  // Geist-/nie-gefundene Motive fehlen bewusst). Nach Thema-Position, dann Motiv-
  // Position sortiert, damit thematisch verwandte Zeilen beieinanderstehen.
  bandMotifs() {
    return this._memo('bandMotifs', [this.motifs, this.themes], () => {
      const themePos = new Map(this.themes.map((t, i) => [t.id, i]));
      return this.motifs
        .filter(m => (m.occurrenceCount || 0) > 0)
        .slice()
        .sort((a, b) => {
          const ta = a.theme_id != null ? (themePos.get(a.theme_id) ?? 1e9) : 1e9;
          const tb = b.theme_id != null ? (themePos.get(b.theme_id) ?? 1e9) : 1e9;
          if (ta !== tb) return ta - tb;
          return (a.position || 0) - (b.position || 0);
        });
    });
  },

  // Fundstellen-Index: motifId → Map(chapterId → n). Memoized über die Motive.
  _bandIndex() {
    return this._memo('bandIndex', [this.motifs], () => {
      const idx = new Map();
      for (const m of this.motifs) {
        const byCh = new Map();
        for (const oc of (m.occChapters || [])) byCh.set(oc.chapterId, oc.n);
        idx.set(m.id, byCh);
      }
      return idx;
    });
  },

  bandCount(motifId, chapterId) {
    return this._bandIndex().get(motifId)?.get(chapterId) || 0;
  },

  // Grösste Zellen-Zahl über alle sichtbaren Zeilen — Normierungs-Basis der Intensität.
  bandMax() {
    return this._memo('bandMax', [this.motifs], () => {
      let max = 0;
      for (const byCh of this._bandIndex().values()) {
        for (const n of byCh.values()) if (n > max) max = n;
      }
      return max;
    });
  },

  // Zeilensummen (Fundstellen je Motiv über alle Kapitel) für die Summenspalte.
  // Als EINE memoisierte Karte statt einer Summe pro Aufruf: motiv.html liest den
  // Wert pro Motivzeile, und jede Summe lief über alle Kapitel des Motivs.
  _bandRowTotals() {
    return this._memo('bandRowTotals', [this.motifs], () => {
      const totals = new Map();
      for (const [motifId, byCh] of this._bandIndex()) {
        let sum = 0;
        for (const n of byCh.values()) sum += n;
        totals.set(motifId, sum);
      }
      return totals;
    });
  },

  bandRowTotal(motifId) {
    return this._bandRowTotals().get(motifId) || 0;
  },

  // Zell-Klasse: leer (schraffiert, kein Klick) vs. getönt (Intensität via --heatmap-t).
  bandCellClass(n) {
    return n > 0 ? 'heatmap-cell--primary' : 'heatmap-cell--empty';
  },
  // Intensität als CSS-Custom-Prop. √-gedämpft, damit auch dünne Vorkommen sichtbar
  // sind; Boden bei 14 %, sonst verschwinden 1er-Zellen optisch ganz.
  bandCellVars(n) {
    const max = this.bandMax();
    if (n <= 0 || max <= 0) return {};
    const t = Math.max(14, Math.round(Math.sqrt(n / max) * 100));
    return { '--heatmap-t': t + '%' };
  },

  // Rowhead-Klick: Motiv wählen und in die Konstellation wechseln (Detail-Panel +
  // Knoten-Highlight leben dort). Das Band ist die Übersicht, der Graph das Detail.
  bandSelectMotif(motifId) {
    this.selectMotif(motifId);
    this.setMotivView('graph');
  },

  // Farb-Swatch der Motiv-Zeile (Thema-Farbe, deckungsgleich mit dem Graph).
  bandMotifColor(m) {
    if (m.theme_id == null) return 'var(--color-muted)';
    const theme = this.themeById(m.theme_id);
    if (!theme) return 'var(--color-muted)';
    return `var(--palette-${this.themeSwatchKey(theme)})`;
  },

  // ── Zell-Detail: die Fundstellen HINTER einer Färbung ──────────────────────
  // Die Zelle nennt eine Zahl; ohne Auflösung bleibt sie eine Behauptung. Klick
  // klappt darum die Fundstellen dieses (Motiv × Kapitel) auf — dieselben Zeilen
  // wie im Panel, inklusive Sprung an die Textstelle. Muster + geteilte Klassen
  // wie die Fehler-Heatmap (`heatmap-cell--clickable`/`--active` + `heatmap-detail`).

  // Eine leere Zelle hat nichts aufzulösen und darf weder Klick-Cursor noch
  // Tab-Stopp anbieten (SSoT für :class-Bindung UND Handler, damit die Optik
  // nicht mehr verspricht, als der Klick einlöst).
  bandCellClickable(motifId, chapterId) {
    return this.bandCount(motifId, chapterId) > 0;
  },

  bandDetailKey(motifId, chapterId) { return `${motifId}:${chapterId}`; },

  async toggleBandDetail(motifId, chapterId) {
    if (!this.bandCellClickable(motifId, chapterId)) return;
    const key = this.bandDetailKey(motifId, chapterId);
    if (this.activeBandDetailKey === key) { this.activeBandDetailKey = null; return; }
    this.activeBandDetailKey = key;
    await this._ensureBandOccurrences(motifId);
  },

  // Fundstellen eines Motivs holen und pro Motiv merken: eine Band-Zeile hat so
  // viele Zellen wie das Buch Kapitel, und jede Zelle fragt dieselbe Route.
  // Der Cache lebt nur bis zum nächsten loadBoard() (Scan-Lauf → frische Zahlen).
  async _ensureBandOccurrences(motifId) {
    if (this.bandOccCache[motifId]) return;
    this.bandDetailLoading = true;
    try {
      const data = await fetchJson(`/motifs/${motifId}/occurrences`);
      // NEUES Objekt statt Mutation: bandActiveDetail() memoisiert über die
      // Cache-Referenz — eine In-Place-Ergänzung verschiebt sie nicht und das
      // Detail bliebe nach dem Laden leer.
      this.bandOccCache = { ...this.bandOccCache, [motifId]: data.occurrences || [] };
    } catch (e) {
      // Fundstellen sind optional (wie im Panel): kein harter Fehler. NICHT als
      // leere Liste cachen — sonst gilt ein Netz-Aussetzer bis zum nächsten
      // loadBoard() als „Kapitel ohne Fundstellen"; ein zweiter Klick darf es
      // erneut versuchen.
    } finally { this.bandDetailLoading = false; }
  },

  // Aktives Zell-Detail: Motiv, Kapitel und die Fundstellen GENAU dieses Kapitels.
  // Gefiltert wird auf `chapter_id` — dieselbe Auflösung, aus der die Zellzahl
  // stammt (Szenen-Funde mappen server-seitig über ihre Ankerseite).
  // Memoized: das Detail-Panel liest den Wert mehrfach pro Render (Titel, Liste,
  // beide x-show), und jeder Aufruf filtert sonst die Fundstellenliste erneut.
  bandActiveDetail() {
    return this._memo('bandActiveDetail',
      [this.activeBandDetailKey, this.bandOccCache, this.motifs, this.$store.nav.tree],
      () => this._computeBandActiveDetail());
  },

  _computeBandActiveDetail() {
    const key = this.activeBandDetailKey;
    if (!key) return null;
    const [motifIdStr, chapterIdStr] = key.split(':');
    const motifId = parseInt(motifIdStr, 10);
    const chapterId = parseInt(chapterIdStr, 10);
    const motif = this.motifById(motifId);
    const chapter = this.bandChapters().find(c => c.id === chapterId);
    if (!motif || !chapter) return null;
    const loaded = this.bandOccCache[motifId];
    return {
      key,
      motifId,
      chapterId,
      motifName: motif.name,
      chapterName: chapter.name,
      count: this.bandCount(motifId, chapterId),
      occurrences: loaded ? loaded.filter(o => o.chapter_id === chapterId) : [],
    };
  },
};
