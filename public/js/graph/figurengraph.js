import { DEFAULT_FONT, TIER_COLOR } from './constants.js';
import { computeSwimlaneLayout, importanceBorderWidth, ROW_H } from './layout.js';
import { parseColor } from '../graph-kit.js';

// Figurengraph: Kapitel-Swimlane (deterministisch).
// Layout-Idee (Berechnung in [layout.js](layout.js), hier nur das Zeichnen):
//   X = narrative Kapitel-Achse (Kapitel 1 links, letztes Kapitel rechts);
//       jede Figur landet auf dem gewichteten Mittel ihrer Kapitel-Indizes.
//   Y = Figurentyp-Tier (Hauptfigur oben → Andere unten); innerhalb des Tiers
//       wird per Slot-Allokation eine vertikale Unterreihe gewählt, sobald
//       zwei Figuren am selben x dicht beieinanderliegen.
//   Presence-Bar unter jeder Figur zeigt Kapitel-für-Kapitel die Auftrittsdichte.
//   Keine Physics, keine Zufälligkeit – jede Position ist aus den Daten ableitbar.
export const figurengraphMethods = {
  _renderFigurengraph(container) {
    const figuren = this._graphFiguren();
    const chapterOrder = this.figurenKapitelListe();
    const N = chapterOrder.length;
    const theme = this._theme();

    const { COL_W, info, tiersUsed, layoutPerTier, tierY: TIER_Y, nodePositions, lastTierY } =
      computeSwimlaneLayout(figuren, chapterOrder, container.offsetWidth);

    // Startpositionen deterministisch; Physics bleibt aus, damit Nodes ohne
    // Rückzug dort bleiben, wohin der Nutzer sie zieht.
    this._figurenNodes = new vis.DataSet(nodePositions.map(({ f, x, y }) => ({
      ...this._baseNode(f),
      borderWidth: importanceBorderWidth(info[f.id].importance),
      x, y,
    })));
    const nodes = this._figurenNodes;

    const { edgeList } = this._buildEdges(/* soziogrammModus */ false);
    this._figurenEdges = new vis.DataSet(edgeList);
    const edges = this._figurenEdges;

    this._figurenNetwork = new vis.Network(container, { nodes, edges }, {
      physics: false,
      layout: { improvedLayout: false },
      interaction: { hover: true, tooltipDelay: 100, dragNodes: true },
      edges: { smooth: { type: 'curvedCW', roundness: 0.15 } },
    });
    const network = this._figurenNetwork;

    // Vertikale Ausdehnung für Kapitel-Spalten (genug Luft über/unter den Tier-Bändern)
    const PAD_Y      = 200;
    const Y_TOP      = -PAD_Y;
    const Y_BOT      = lastTierY + PAD_Y;

    network.on('beforeDrawing', ctx => {
      // 1) Kapitel-Spalten (Netzwerk-Koordinaten → skalieren mit Zoom)
      if (N > 0) {
        ctx.save();
        for (let i = 0; i < N; i++) {
          const cx = i * COL_W;
          ctx.fillStyle = (i % 2 === 0) ? theme.stripe : 'rgba(0,0,0,0)';
          ctx.fillRect(cx - COL_W / 2, Y_TOP, COL_W, Y_BOT - Y_TOP);
          ctx.strokeStyle = theme.gridLine;
          ctx.lineWidth   = 0.5;
          ctx.beginPath();
          ctx.moveTo(cx - COL_W / 2, Y_TOP);
          ctx.lineTo(cx - COL_W / 2, Y_BOT);
          ctx.stroke();
        }
        const edgeX = (N - 1) * COL_W + COL_W / 2;
        ctx.beginPath();
        ctx.moveTo(edgeX, Y_TOP); ctx.lineTo(edgeX, Y_BOT); ctx.stroke();
        ctx.restore();
      }

      const dpr = window.devicePixelRatio || 1;
      // Adaptive Schriftgrösse: bei kleinem Container (600 px) bleiben 11/10 px,
      // im Fullscreen (Canvas wächst auf >1000 px Höhe) skalieren Header/Tier
      // proportional bis 18/15 — sonst sind die Kapitel im Vollbild unlesbar.
      const cHeightCss  = ctx.canvas.height / dpr;
      const cWidthCss   = ctx.canvas.width / dpr;
      const headerFs    = Math.max(11, Math.min(18, cHeightCss / 55));
      const tierFs      = Math.max(10, Math.min(15, cHeightCss / 65));
      const lblMaxChars = cHeightCss > 700 ? 60 : 34;

      // 2) Kapitel-Header oben (Screen-Koordinaten → feste Lesegrösse, folgen dem Pan).
      // Header-Stride hängt vom aktuellen Zoom ab: bei dichten Spalten (viele Kapitel
      // oder rausgezoomt) wird nur jeder n-te Header gezeichnet, sonst überlappen die
      // Labels. Letzte Spalte immer gezeichnet (Orientierung).
      if (N > 0) {
        const scale    = network.getScale();
        const pxPerCol = COL_W * scale;
        const step     = Math.max(1, Math.ceil(70 / Math.max(1, pxPerCol)));
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.font = `600 ${headerFs * dpr}px ${DEFAULT_FONT.face}`;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle    = theme.headerText;
        for (let i = 0; i < N; i++) {
          if (i % step !== 0 && i !== N - 1) continue;
          const dom = network.canvasToDOM({ x: i * COL_W, y: Y_TOP });
          if (dom.x < -120 || dom.x > cWidthCss + 120) continue;
          const raw = `${i + 1}. ${chapterOrder[i]}`;
          const lbl = raw.length > lblMaxChars ? raw.slice(0, lblMaxChars - 2) + '…' : raw;
          ctx.fillText(lbl, dom.x * dpr, 8 * dpr);
        }
        ctx.restore();
      }

      // 3) Tier-Labels links am Canvas-Rand (Screen-Koordinaten)
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.font = `600 ${tierFs * dpr}px ${DEFAULT_FONT.face}`;
      ctx.textBaseline = 'middle';
      ctx.textAlign    = 'left';
      const padY = (tierFs * 0.9) * dpr;
      const pillH = (tierFs * 1.6) * dpr;
      for (const t of tiersUsed) {
        const midY = TIER_Y[t] + ((layoutPerTier[t].maxRows - 1) * ROW_H) / 2;
        const dom = network.canvasToDOM({ x: 0, y: midY });
        if (dom.y < -16 || dom.y > cHeightCss + 16) continue;
        const label = window.__app.t('figuren.type.' + t);
        const tw    = ctx.measureText(label).width;
        const px = 6 * dpr, py = dom.y * dpr - padY, pw = tw + 12 * dpr, pr = 4 * dpr;
        ctx.fillStyle = theme.pillBg;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(px, py, pw, pillH, pr);
        else ctx.rect(px, py, pw, pillH);
        ctx.fill();
        ctx.fillStyle = theme.ink(TIER_COLOR[t] || theme.muted);
        ctx.fillText(label, 12 * dpr, dom.y * dpr);
      }
      ctx.restore();
    });

    // 4) Presence-Bar unter jeder Node (Netzwerk-Koordinaten, skaliert mit Zoom).
    // Bei vielen Kapiteln (N=37) wären 70 px / Segmentbreite ~1.9 px → unsichtbar;
    // Min-Breite skaliert mit N (min 3 px pro Segment), Cap bei 220 px gegen Overlap.
    if (N > 0) {
      const minBarW = Math.min(220, Math.max(70, N * 3));
      // Konstante Presence-Daten je Figur einmal vorberechnen — afterDrawing feuert
      // bei jedem Pan/Zoom/Redraw; nur die Bounding-Box ist pro Frame variabel (Drag),
      // kapsByName + RGB-Parse sind es nicht.
      const presenceData = figuren.map(f => {
        const kapsByName = {};
        for (const k of (f.kapitel || [])) kapsByName[k.name] = k.haeufigkeit || 1;
        // Tier-Farbe für den aktuellen Grund lesbar gemacht, dann als RGB-Tripel —
        // die Segment-Alpha wird pro Kapitel darübergelegt.
        const rgb = parseColor(theme.ink(TIER_COLOR[info[f.id].tier])) || [45, 106, 159];
        return { id: f.id, kapsByName, rgb };
      });
      network.on('afterDrawing', ctx => {
        ctx.save();
        for (const { id, kapsByName, rgb: [r, g, b] } of presenceData) {
          const bb = network.getBoundingBox(id);
          if (!bb) continue;
          const barW    = Math.max(bb.right - bb.left, minBarW);
          const barLeft = (bb.left + bb.right) / 2 - barW / 2;
          const barY    = bb.bottom + 4;
          const barH    = 4;
          const segW    = barW / N;
          // Hintergrund
          ctx.fillStyle = theme.trackBg;
          ctx.fillRect(barLeft, barY, barW, barH);
          // Gefüllte Segmente pro Kapitel mit Auftritt
          for (let i = 0; i < N; i++) {
            const h = kapsByName[chapterOrder[i]];
            if (!h) continue;
            const alpha = Math.min(1, 0.35 + h / 5);
            ctx.fillStyle = `rgba(${r},${g},${b},${alpha.toFixed(2)})`;
            ctx.fillRect(barLeft + i * segW + 0.5, barY, Math.max(0.5, segW - 1), barH);
          }
        }
        ctx.restore();
      });
    }

    // Klick auf Kapitel-Header → Filter setzen
    network.on('click', ({ pointer, event }) => {
      if (N === 0) return;
      // pointer.canvas = Netzwerk-Koordinaten; Header-Band liegt über Y_TOP.
      if (pointer.canvas.y > Y_TOP + 60) return;
      const idx = Math.round(pointer.canvas.x / COL_W);
      if (idx < 0 || idx >= N) return;
      const ch = chapterOrder[idx];
      this._figurenGraphSetKapitel(this.figurenGraphKapitel === ch ? null : ch);
      event?.preventDefault?.();
    });

    // Sofort fitten (keine Stabilisierung nötig, Physics ist aus).
    // fit() auf Node-IDs statt Canvas: leere Kapitel-Spalten würden sonst die
    // Bounding-Box aufblähen → Nodes mikroskopisch im Viewport.
    // Kapitel-Filter wird zentral aus core.js#renderFigurGraph angewandt (alle Modi),
    // hier nur fitten.
    const fitIds = figuren.map(f => f.id);
    requestAnimationFrame(() => {
      network.fit({ nodes: fitIds, animation: { duration: 250, easingFunction: 'easeInOutQuad' } });
    });

    this._attachTooltip(container);
  },
};
