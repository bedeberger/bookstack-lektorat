import { ensureVis, graphPlaceholder, graphTheme } from '../graph-kit.js';
import { toggleWrapFullscreen } from '../fullscreen.js';

// Entry-Points: Mode-Switch, Fullscreen, Render-Dispatcher.
export const coreMethods = {
  setFigurenGraphModus(mode) {
    if (mode === this.figurenGraphModus) return;
    this.figurenGraphModus = mode;
    this._figurenHash = null;
    this.$nextTick(() => this.renderFigurGraph());
  },

  figurenHasFamilyEdges() {
    for (const f of this._graphFiguren()) {
      for (const bz of (f.beziehungen || [])) {
        if (['elternteil', 'kind', 'geschwister'].includes(bz.typ)) return true;
      }
    }
    return false;
  },

  async toggleFigurenGraphFullscreen() {
    const wrap = document.getElementById('figuren-graph')?.closest('.figuren-graph-wrap');
    if (!wrap) return;
    try {
      await toggleWrapFullscreen(wrap);
    } catch {
      this.figurenGraphFullscreen = !this.figurenGraphFullscreen;
      this.$nextTick(() => {
        window.dispatchEvent(new Event('resize'));
        if (this.figurenGraphFullscreen && this._figurenNetwork) {
          this._figurenNetwork.fit({ animation: { duration: 200, easingFunction: 'easeInOutQuad' } });
        }
      });
    }
  },

  async renderFigurGraph() {
    // Präsenz- und Alters-Tab sind reine DOM-Ansichten (Heatmap bzw. Tabelle, kein
    // vis-network) → nichts rendern, vis-Bundle nicht lazy-laden. Beide Blöcke
    // leben separat in ihren Partials.
    if (this.figurenGraphModus === 'praesenz' || this.figurenGraphModus === 'alter') return;
    const container = document.getElementById('figuren-graph');
    if (!container) return;
    const figuren = this._graphFiguren();

    if (!await ensureVis(container)) return;

    // Canvas löst keine CSS-Custom-Properties auf → Chrome-Farben (Spalten, Header,
    // Pills, Dim-Zustand) einmal pro Render aus dem DOM auflösen. Die Overlays und
    // der Kapitel-Filter lesen dieselbe Auflösung über this._graphTheme.
    this._graphTheme = graphTheme(container);

    // Render-Signatur deckt ALLE layout-/edge-relevanten Felder ab: typ (Tier),
    // sozialschicht (Soziogramm-Band), Kapitel (X-Achse + Presence) und Beziehungen
    // inkl. Machtverhältnis (Edges + Macht-Sortierung). Nur Kapitel zu prüfen würde
    // nach einem Beziehungs-/Typ-/Schicht-Edit den alten Stand zeigen (Hash matcht
    // trotz Datenänderung → No-op).
    const sig = figuren.map(f => {
      const kap = (f.kapitel || []).map(k => k.name + k.haeufigkeit).join(',');
      const bz  = (f.beziehungen || []).map(b => b.figur_id + b.typ + (b.machtverhaltnis ?? '')).join(',');
      return [f.id, f.typ || '', f.sozialschicht || '', kap, bz].join('::');
    }).join('|');
    // Theme im Key: die Canvas-Farben hängen am aufgelösten Hell/Dunkel-Stand,
    // ohne diesen Anteil bliebe nach einem Theme-Wechsel das alte Bild stehen.
    const hash = [sig, this.figurenGraphModus, Alpine.store('shell').uiLocale,
      this._graphTheme.dark ? 'dark' : 'light'].join('|');
    if (this._figurenNetwork && this._figurenHash === hash) return;
    this._figurenHash = hash;

    if (this._figurenNetwork) {
      this._figurenNetwork.destroy();
      this._figurenNetwork = null;
    }
    if (!figuren.length) {
      graphPlaceholder(container, window.__app.t('graph.empty.figuren'));
      return;
    }
    if (this.figurenGraphModus === 'soziogramm')      this._renderSoziogramm(container);
    else if (this.figurenGraphModus === 'familie')    this._renderFamiliengraph(container);
    else                                              this._renderFigurengraph(container);

    if (this.figurenGraphKapitel && this._figurenNodes && this._figurenEdges) {
      requestAnimationFrame(() => this._figurenGraphSetKapitel(this.figurenGraphKapitel));
    }
  },
};
