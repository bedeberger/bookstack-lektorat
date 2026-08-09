import { SCHICHT_COLOR, SCHICHT_LEVEL, DEFAULT_FONT } from './constants.js';
import { graphPlaceholder, parseColor, rgba } from '../graph-kit.js';

// Soziogramm: nach Sozialschicht gefärbt, Schicht-Rows, Machtpfeile.
export const soziogrammMethods = {
  _renderSoziogramm(container) {
    const figuren = this._graphFiguren();
    const theme = this._theme();
    // Guard: noch keine Sozialschichten vorhanden → Placeholder statt leerem Graph
    const hasSchicht = figuren.some(f => f.sozialschicht && f.sozialschicht !== 'andere');
    if (!hasSchicht) {
      if (this._figurenNetwork) { this._figurenNetwork.destroy(); this._figurenNetwork = null; }
      graphPlaceholder(container, window.__app.t('graph.empty.sozialschicht'), 'muted-msg soziogramm-placeholder');
      return;
    }

    const LEVEL_Y_GAP = 190;
    const NODE_X_GAP  = 210;
    const BAND_H_INNER = LEVEL_Y_GAP * 0.60; // Nutzbare Höhe innerhalb eines Schicht-Bands für Machtstaffelung

    // Machtscore pro Figur: `machtverhaltnis > 0` bedeutet das Gegenüber dominiert,
    // also zählt der negierte Wert als Macht der Figur selbst.
    const powerScore = f => {
      const bz = Array.isArray(f.beziehungen) ? f.beziehungen : [];
      return bz.reduce((s, b) => s - (Number(b.machtverhaltnis) || 0), 0);
    };

    // Knoten nach Schicht-Ebene gruppieren, innerhalb jeder Gruppe nach Macht sortieren (absteigend).
    const levelGroups = {};
    for (const f of figuren) {
      const lev = SCHICHT_LEVEL[f.sozialschicht] ?? SCHICHT_LEVEL.andere;
      (levelGroups[lev] ??= []).push(f);
    }
    for (const group of Object.values(levelGroups)) {
      group.sort((a, b) => powerScore(b) - powerScore(a));
    }

    // Pro Figur x/y-Position bestimmen (Rang innerhalb der Schicht → vertikaler Offset im Band).
    const posById = new Map();
    for (const [levStr, group] of Object.entries(levelGroups)) {
      const lev = Number(levStr);
      const cnt = group.length;
      const dy = cnt > 1 ? Math.max(12, Math.min(34, BAND_H_INNER / (cnt - 1))) : 0;
      group.forEach((f, idx) => {
        const x = (idx - (cnt - 1) / 2) * NODE_X_GAP;
        const yOffset = (idx - (cnt - 1) / 2) * dy; // idx 0 = mächtigste → negativer Offset → weiter oben
        posById.set(f.id, { x, y: lev * LEVEL_Y_GAP + yOffset });
      });
    }

    const nodes = new vis.DataSet(figuren.map(f => {
      const { x, y } = posById.get(f.id);
      return {
        ...this._baseNode(f),
        color: this._schichtNodeColor(f.sozialschicht),
        font: this._schichtNodeFont(f.sozialschicht),
        x, y,
        fixed: { x: false, y: true }, // Schicht-Zeile fixieren; horizontal löst Physics Überlappungen
      };
    }));

    const { edgeList } = this._buildEdges(/* soziogrammModus */ true);
    const edges = new vis.DataSet(edgeList);
    this._figurenNodes = nodes;
    this._figurenEdges = edges;

    const options = {
      physics: { solver: 'repulsion', repulsion: { nodeDistance: 140 }, stabilization: { iterations: 150 } },
      layout: { randomSeed: 7 },
      interaction: { hover: true, tooltipDelay: 100 },
      edges: { smooth: { type: 'curvedCW', roundness: 0.15 } },
    };

    this._figurenNetwork = new vis.Network(container, { nodes, edges }, options);
    this._figurenNetwork.once('stabilizationIterationsDone', () => {
      this._figurenNetwork.setOptions({ physics: false });
    });

    // Welche Schichten sind wirklich belegt? level → schicht
    const levelToSchicht = {};
    for (const f of figuren) {
      const lev = SCHICHT_LEVEL[f.sozialschicht] ?? SCHICHT_LEVEL.andere;
      if (!levelToSchicht[lev]) levelToSchicht[lev] = f.sozialschicht || 'andere';
    }

    const BAND_H      = LEVEL_Y_GAP * 0.90;
    const BAND_HALF   = BAND_H / 2;
    const BAND_EXTENT = 9000;
    const network     = this._figurenNetwork;

    // Band-Streifen: die Palette hält den hellen Wasch für hellen Grund. Auf dunklem
    // Grund wäre er ein Leuchtbalken — dort stattdessen die gesättigte Schicht-Border
    // schwach eingeblendet (gleiche Farbfamilie, passende Richtung).
    const bandFill = (schicht) => {
      const style = SCHICHT_COLOR[schicht] || SCHICHT_COLOR.andere;
      if (!theme.dark) return style.band;
      const rgb = parseColor(style.border);
      return rgb ? rgba(rgb, 0.18) : style.band;
    };

    network.on('beforeDrawing', (ctx) => {
      // 1) Farbige Streifen + Trennlinien in Netzwerk-Koordinaten
      ctx.save();
      for (const [levStr, schicht] of Object.entries(levelToSchicht)) {
        const y = Number(levStr) * LEVEL_Y_GAP;
        ctx.fillStyle = bandFill(schicht);
        ctx.fillRect(-BAND_EXTENT, y - BAND_HALF, BAND_EXTENT * 2, BAND_H);
        // Trennlinie unten
        ctx.strokeStyle = theme.bandLine;
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(-BAND_EXTENT, y + BAND_HALF);
        ctx.lineTo( BAND_EXTENT, y + BAND_HALF);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.restore();

      // 2) Schicht-Labels: linke Kante des Canvas, in Bildschirm-Koordinaten
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const dpr = window.devicePixelRatio || 1;
      const cHeightCss = ctx.canvas.height / dpr;
      const schichtFs  = Math.max(10, Math.min(15, cHeightCss / 65));
      ctx.font = `bold ${schichtFs * dpr}px ${DEFAULT_FONT.face}`;
      ctx.textBaseline = 'middle';
      const padY  = (schichtFs * 0.9) * dpr;
      const pillH = (schichtFs * 1.6) * dpr;
      for (const [levStr, schicht] of Object.entries(levelToSchicht)) {
        const domY = network.canvasToDOM({ x: 0, y: Number(levStr) * LEVEL_Y_GAP }).y;
        if (domY < -16 || domY > cHeightCss + 16) continue;
        // Hintergrund-Pill (rounded rect, compat-safe) – Koordinaten in Canvas-Pixeln (× dpr)
        const label = window.__app.t('figuren.schicht.' + schicht);
        const tw    = ctx.measureText(label).width;
        const cY = domY * dpr;
        const px = 6 * dpr, py = cY - padY, pw = tw + 12 * dpr, ph = pillH, pr = 4 * dpr;
        ctx.fillStyle = theme.pillBg;
        ctx.beginPath();
        if (ctx.roundRect) {
          ctx.roundRect(px, py, pw, ph, pr);
        } else {
          ctx.moveTo(px + pr, py);
          ctx.lineTo(px + pw - pr, py);     ctx.arcTo(px+pw, py,    px+pw, py+pr,    pr);
          ctx.lineTo(px + pw, py+ph-pr);    ctx.arcTo(px+pw, py+ph, px+pw-pr, py+ph, pr);
          ctx.lineTo(px + pr, py+ph);       ctx.arcTo(px,    py+ph, px,      py+ph-pr,pr);
          ctx.lineTo(px, py+pr);            ctx.arcTo(px,    py,    px+pr,   py,      pr);
          ctx.closePath();
        }
        ctx.fill();
        ctx.fillStyle = theme.ink((SCHICHT_COLOR[schicht] || SCHICHT_COLOR.andere).label);
        ctx.fillText(label, 12 * dpr, cY);
      }
      ctx.restore();
    });

    this._attachTooltip(container);
  },
};
