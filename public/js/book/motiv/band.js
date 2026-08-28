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

export const bandMethods = {
  // Ansicht umschalten (Konstellation ↔ Verlaufsband). Zurück auf den Graph muss
  // neu gezeichnet + eingepasst werden (Canvas war ausgeblendet → 0-Grösse).
  setMotivView(mode) {
    const next = (mode === 'band' || mode === 'checks') ? mode : 'graph';
    if (this.motivView === next) return;
    this.motivView = next;
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

  // Zeilensumme (Fundstellen des Motivs über alle Kapitel) für die Summenspalte.
  bandRowTotal(motifId) {
    let sum = 0;
    for (const n of (this._bandIndex().get(motifId)?.values() || [])) sum += n;
    return sum;
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
};
