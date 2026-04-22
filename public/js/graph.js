import { escHtml } from './utils.js';

// Graph-Render-Methoden (werden in Alpine.data('figurenCard') gespreadet).
// Root-Zugriffe via window.__app. vis-network-Instanz (_figurenNetwork) +
// Graph-Modus-State leben in der Card; destroy() räumt beides auf.

// Gemeinsamer Font für alle vis-Nodes.
const DEFAULT_FONT = { size: 13, face: 'system-ui, -apple-system, sans-serif' };

// Node-Label aus einer Figur: Kurzname + optionales Geburtsdatum in zweiter Zeile.
const nodeLabel = f => (f.kurzname || f.name) + (f.geburtstag ? '\n* ' + f.geburtstag : '');

// ── Sozialschicht-Palette (Schweiz, Mittelland, 1990er–2010er) ───────────────
const SCHICHT_COLOR = {
  wirtschaftselite:    { background: '#FFF3CC', border: '#A07800', highlight: { background: '#FFE566', border: '#7A5A00' } },
  gehobenes_buergertum:{ background: '#D4E8FF', border: '#2d6a9f', highlight: { background: '#BDD8FF', border: '#1d4b73' } },
  mittelschicht:       { background: '#E8F4E8', border: '#3a7a3a', highlight: { background: '#D0EBD0', border: '#275927' } },
  arbeiterschicht:     { background: '#F5EAD4', border: '#8B5E26', highlight: { background: '#EDD9A8', border: '#6B3F0D' } },
  migrantenmilieu:     { background: '#FDEBD0', border: '#C0602A', highlight: { background: '#FAD5A8', border: '#9A4010' } },
  prekariat:           { background: '#F5EDED', border: '#8B3A3A', highlight: { background: '#EDD5D5', border: '#6B1A1A' } },
  unterwelt:           { background: '#3A3A3A', border: '#111',    highlight: { background: '#505050', border: '#000' },
                         font: { ...DEFAULT_FONT, color: '#fff' } },
  andere:              { background: '#FFF5DC', border: '#c4a55a', highlight: { background: '#FFEEBB', border: '#8a6a20' } },
};

// Vertikale Ebene pro Schicht (0 = oben)
const SCHICHT_LEVEL = {
  wirtschaftselite:    0,
  gehobenes_buergertum:1,
  mittelschicht:       2,
  arbeiterschicht:     3,
  migrantenmilieu:     4,
  prekariat:           5,
  unterwelt:           6,
  andere:              2,
};

// ── Beziehungstyp-Styling (Figurengraph) ─────────────────────────────────────
const BZ = {
  elternteil:      { color: '#888',    highlight: '#555',    arrows: 'to',   dashes: false },
  kind:            { color: '#888',    highlight: '#555',    arrows: 'from', dashes: false },
  geschwister:     { color: '#2d6a9f', highlight: '#1d4b73', arrows: '',     dashes: [5,5] },
  freund:          { color: '#639922', highlight: '#3B6D11', arrows: '',     dashes: [4,3] },
  feind:           { color: '#E24B4A', highlight: '#B03030', arrows: '',     dashes: [4,3] },
  kollege:         { color: '#c4a55a', highlight: '#8a6a20', arrows: '',     dashes: [4,3] },
  bekannt:         { color: '#999',    highlight: '#555',    arrows: '',     dashes: [4,3] },
  liebesbeziehung: { color: '#D46EA0', highlight: '#A0446E', arrows: '',     dashes: [4,3] },
  rivale:          { color: '#9B4B00', highlight: '#6B3000', arrows: '',     dashes: [4,3] },
  mentor:          { color: '#2d6a9f', highlight: '#1d4b73', arrows: 'to',   dashes: [4,3] },
  schuetzling:     { color: '#2d6a9f', highlight: '#1d4b73', arrows: 'from', dashes: [4,3] },
  patronage:       { color: '#7B3FA0', highlight: '#5A1F80', arrows: 'to',   dashes: false },
  geschaeft:       { color: '#B8860B', highlight: '#7A5A00', arrows: '',     dashes: [6,3] },
  andere:          { color: '#bbb',    highlight: '#888',    arrows: '',     dashes: [4,3] },
};

// ── Beziehungskategorie-Farben (Soziogramm) ───────────────────────────────────
const BZ_SOZIO_COLOR = {
  familie:  '#888',
  macht:    '#7B3FA0',
  konflikt: '#E24B4A',
  geschaeft:'#B8860B',
  liebe:    '#D46EA0',
  sozial:   '#639922',
};
const BZ_SOZIO_CAT = {
  elternteil: 'familie', kind: 'familie', geschwister: 'familie',
  patronage: 'macht',  mentor: 'macht', schuetzling: 'macht',
  feind: 'konflikt', rivale: 'konflikt',
  geschaeft: 'geschaeft', kollege: 'geschaeft',
  liebesbeziehung: 'liebe',
  freund: 'sozial', bekannt: 'sozial', andere: 'sozial',
};

// Typen mit fester Pfeilrichtung im Standardgraph
const DIRECTED_TYPES = ['elternteil', 'kind', 'mentor', 'schuetzling', 'patronage'];

export const graphMethods = {
  _figTypColor(typ) {
    const colors = {
      hauptfigur: { background: '#D4E8FF', border: '#2d6a9f', highlight: { background: '#BDD8FF', border: '#1d4b73' } },
      nebenfigur:  { background: '#F0F0F0', border: '#888',    highlight: { background: '#E4E4E4', border: '#555' } },
      antagonist:  { background: '#FFE0E0', border: '#E24B4A', highlight: { background: '#FFC7C7', border: '#B03030' } },
      mentor:      { background: '#EAF3DE', border: '#639922', highlight: { background: '#D5EBBD', border: '#3B6D11' } },
      randfigur:   { background: '#F7F7F7', border: '#BBB',    highlight: { background: '#EDEDED', border: '#999' } },
      andere:      { background: '#FFF5DC', border: '#c4a55a', highlight: { background: '#FFEEBB', border: '#8a6a20' } },
    };
    return colors[typ] || colors.andere;
  },

  setFigurenGraphModus(mode) {
    if (mode === this.figurenGraphModus) return;
    this.figurenGraphModus = mode;
    this._figurenHash = null; // Cache ungültig machen → erzwingt Neurender
    this.$nextTick(() => this.renderFigurGraph());
  },

  figurenHasFamilyEdges() {
    for (const f of (window.__app.figuren || [])) {
      for (const bz of (f.beziehungen || [])) {
        if (['elternteil', 'kind', 'geschwister'].includes(bz.typ)) return true;
      }
    }
    return false;
  },

  toggleFigurenGraphFullscreen() {
    this.figurenGraphFullscreen = !this.figurenGraphFullscreen;
    const net = this._figurenNetwork;
    if (!net) return;
    this.$nextTick(() => {
      // vis-network reagiert auf window.resize und passt Canvas an neue Container-Grösse an.
      window.dispatchEvent(new Event('resize'));
      if (this.figurenGraphFullscreen) {
        net.fit({ animation: { duration: 200, easingFunction: 'easeInOutQuad' } });
      }
    });
  },

  renderFigurGraph() {
    const container = document.getElementById('figuren-graph');
    if (!container) return;
    const figuren = window.__app.figuren;

    // Cache-Hash: Figuren-IDs + Kapitelsignatur + Modus + Sprache. Kapitelsignatur sorgt
    // dafür, dass Häufigkeitsänderungen einer Figur einen Re-Render auslösen, selbst wenn
    // die ID-Liste gleich bleibt.
    const kapSig = figuren.map(f =>
      f.id + ':' + (f.kapitel || []).map(k => k.name + k.haeufigkeit).join(',')
    ).join('|');
    const hash = kapSig + '|' + this.figurenGraphModus + '|' + window.__app.uiLocale;
    if (this._figurenNetwork && this._figurenHash === hash) return;
    this._figurenHash = hash;

    if (this._figurenNetwork) {
      this._figurenNetwork.destroy();
      this._figurenNetwork = null;
    }
    if (!figuren.length) {
      container.innerHTML = `<span class="muted-msg muted-msg--block">${escHtml(window.__app.t('graph.empty.figuren'))}</span>`;
      return;
    }
    if (typeof vis === 'undefined') {
      container.innerHTML = `<span class="muted-msg muted-msg--block">${escHtml(window.__app.t('graph.empty.visLoading'))}</span>`;
      return;
    }

    if (this.figurenGraphModus === 'soziogramm')      this._renderSoziogramm(container);
    else if (this.figurenGraphModus === 'familie')    this._renderFamiliengraph(container);
    else                                              this._renderFigurengraph(container);
  },

  // ── Figurengraph: Kapitel-Swimlane (deterministisch) ────────────────────────
  // Layout-Idee:
  //   X = narrative Kapitel-Achse (Kapitel 1 links, letztes Kapitel rechts);
  //       jede Figur landet auf dem gewichteten Mittel ihrer Kapitel-Indizes.
  //   Y = Figurentyp-Tier (Hauptfigur oben → Andere unten); innerhalb des Tiers
  //       wird per Slot-Allokation eine vertikale Unterreihe gewählt, sobald
  //       zwei Figuren am selben x dicht beieinanderliegen.
  //   Presence-Bar unter jeder Figur zeigt Kapitel-für-Kapitel die Auftrittsdichte.
  //   Keine Physics, keine Zufälligkeit – jede Position ist aus den Daten ableitbar.
  _renderFigurengraph(container) {
    const figuren = window.__app.figuren;
    const chapterOrder = this.figurenKapitelListe();
    const N = chapterOrder.length;
    const chapIdx = {};
    chapterOrder.forEach((c, i) => { chapIdx[c] = i; });

    const COL_W           = 440;  // Breite einer Kapitel-Spalte (Hintergrund-Raster + xIdx-Skalierung)
    const ROW_H           = 50;   // Vertikaler Abstand zwischen zwei Stapelzeilen innerhalb eines Tiers
    const TIER_BASE_GAP   = 80;   // Zusatz-Luft zwischen zwei Tiers
    const MIN_DX          = 130;  // Minimaler horizontaler Abstand zwischen zwei Figuren derselben Zeile
    const TIER_ORDER      = ['hauptfigur', 'antagonist', 'mentor', 'nebenfigur', 'randfigur', 'andere'];
    const TIER_COLOR = {
      hauptfigur: '#2d6a9f', antagonist: '#E24B4A',
      mentor:     '#639922', nebenfigur: '#666',    randfigur: '#999', andere: '#c4a55a',
    };
    const tierOf = f => TIER_ORDER.includes(f.typ) ? f.typ : 'andere';

    // Pro Figur: gewichteter x-Index, Ersterscheinung, Tier, Wichtigkeit
    const weight = k => Math.pow(k.haeufigkeit || 1, 1.5);
    const info = {};
    for (const f of figuren) {
      const kaps = (f.kapitel || []).filter(k => chapIdx[k.name] !== undefined);
      let xIdx = N > 1 ? (N - 1) / 2 : 0;
      let firstCh = Number.POSITIVE_INFINITY;
      if (kaps.length) {
        const total = kaps.reduce((s, k) => s + weight(k), 0);
        let sum = 0;
        for (const k of kaps) {
          sum += chapIdx[k.name] * (weight(k) / total);
          if (chapIdx[k.name] < firstCh) firstCh = chapIdx[k.name];
        }
        xIdx = sum;
      }
      const importance = (f.kapitel || []).reduce((s, k) => s + (k.haeufigkeit || 0), 0);
      info[f.id] = { xIdx, firstCh, tier: tierOf(f), importance };
    }

    // Tier-Buckets in fester Reihenfolge; nur belegte Tiers werden gerendert.
    const byTier = {};
    for (const t of TIER_ORDER) byTier[t] = [];
    for (const f of figuren) byTier[info[f.id].tier].push(f);
    const tiersUsed = TIER_ORDER.filter(t => byTier[t].length > 0);

    // Layout pro Tier: Figuren sitzen an ihrem tatsächlichen narrativen Schwerpunkt
    // (xIdx * COL_W). Greedy-Stapelung: jede Figur kommt in die oberste Zeile, in
    // der sie zur zuletzt platzierten Figur dieser Zeile mindestens MIN_DX Abstand
    // hat. So gibt es kein Binning mehr → keine Clumps an Kapitelrändern.
    const sortFigs = arr => arr.slice().sort((a, b) => {
      const ax = info[a.id].xIdx, bx = info[b.id].xIdx;
      if (ax !== bx) return ax - bx;
      const af = info[a.id].firstCh, bf = info[b.id].firstCh;
      if (af !== bf) return af - bf;
      return (a.name || '').localeCompare(b.name || '');
    });
    const layoutPerTier = {};
    for (const t of tiersUsed) {
      const rowLastX = []; // row → x der zuletzt platzierten Figur
      const items = [];
      for (const f of sortFigs(byTier[t])) {
        const x = info[f.id].xIdx * COL_W;
        let row = 0;
        while (row < rowLastX.length && x - rowLastX[row] < MIN_DX) row++;
        rowLastX[row] = x;
        items.push({ f, x, row });
      }
      layoutPerTier[t] = { items, maxRows: Math.max(1, rowLastX.length) };
    }

    // Y-Koordinaten kumulativ: jedes Tier nimmt so viel Platz, wie es Stapelzeilen
    // gibt. Damit ragen Nebenfiguren-Stapel nicht ins nächste Tier.
    const TIER_Y = {};
    let yCursor = 0;
    for (const t of tiersUsed) {
      TIER_Y[t] = yCursor;
      yCursor += (layoutPerTier[t].maxRows - 1) * ROW_H + TIER_BASE_GAP;
    }

    const nodePositions = [];
    for (const t of tiersUsed) {
      for (const { f, x, row } of layoutPerTier[t].items) {
        nodePositions.push({ f, x, y: TIER_Y[t] + row * ROW_H });
      }
    }

    // Startpositionen deterministisch; Physics bleibt aus, damit Nodes ohne
    // Rückzug dort bleiben, wohin der Nutzer sie zieht.
    this._figurenNodes = new vis.DataSet(nodePositions.map(({ f, x, y }) => {
      const borderWidth = Math.min(4, 1 + Math.round(Math.log2(Math.max(1, info[f.id].importance))));
      return {
        id: f.id,
        label: nodeLabel(f),
        color: this._figTypColor(f.typ),
        font: DEFAULT_FONT,
        shape: 'box',
        margin: 10,
        widthConstraint: { maximum: 160 },
        borderWidth,
        x, y,
      };
    }));
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
    const lastTier   = tiersUsed[tiersUsed.length - 1];
    const lastTierY  = lastTier
      ? TIER_Y[lastTier] + (layoutPerTier[lastTier].maxRows - 1) * ROW_H
      : 0;
    const PAD_Y      = 200;
    const Y_TOP      = -PAD_Y;
    const Y_BOT      = lastTierY + PAD_Y;

    network.on('beforeDrawing', ctx => {
      // 1) Kapitel-Spalten (Netzwerk-Koordinaten → skalieren mit Zoom)
      if (N > 0) {
        ctx.save();
        for (let i = 0; i < N; i++) {
          const cx = i * COL_W;
          ctx.fillStyle = (i % 2 === 0) ? 'rgba(0,0,0,0.028)' : 'rgba(0,0,0,0)';
          ctx.fillRect(cx - COL_W / 2, Y_TOP, COL_W, Y_BOT - Y_TOP);
          ctx.strokeStyle = 'rgba(0,0,0,0.06)';
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

      // 2) Kapitel-Header oben (Screen-Koordinaten → feste Lesegrösse, folgen dem Pan)
      if (N > 0) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.font = `600 ${11 * dpr}px system-ui,-apple-system,sans-serif`;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle    = '#555';
        const cWidth = ctx.canvas.width / dpr;
        for (let i = 0; i < N; i++) {
          const dom = network.canvasToDOM({ x: i * COL_W, y: Y_TOP });
          if (dom.x < -120 || dom.x > cWidth + 120) continue;
          const raw = `${i + 1}. ${chapterOrder[i]}`;
          const lbl = raw.length > 34 ? raw.slice(0, 32) + '…' : raw;
          ctx.fillText(lbl, dom.x * dpr, 8 * dpr);
        }
        ctx.restore();
      }

      // 3) Tier-Labels links am Canvas-Rand (Screen-Koordinaten)
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.font = `600 ${10 * dpr}px system-ui,-apple-system,sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.textAlign    = 'left';
      const cHeight = ctx.canvas.height / dpr;
      for (const t of tiersUsed) {
        const midY = TIER_Y[t] + ((layoutPerTier[t].maxRows - 1) * ROW_H) / 2;
        const dom = network.canvasToDOM({ x: 0, y: midY });
        if (dom.y < -16 || dom.y > cHeight + 16) continue;
        const label = window.__app.t('figuren.type.' + t);
        const tw    = ctx.measureText(label).width;
        const px = 6 * dpr, py = dom.y * dpr - 9 * dpr, pw = tw + 12 * dpr, ph = 18 * dpr, pr = 4 * dpr;
        ctx.fillStyle = 'rgba(255,255,255,0.88)';
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(px, py, pw, ph, pr);
        else ctx.rect(px, py, pw, ph);
        ctx.fill();
        ctx.fillStyle = TIER_COLOR[t] || '#555';
        ctx.fillText(label, 12 * dpr, dom.y * dpr);
      }
      ctx.restore();
    });

    // 4) Presence-Bar unter jeder Node (Netzwerk-Koordinaten, skaliert mit Zoom)
    if (N > 0) {
      network.on('afterDrawing', ctx => {
        ctx.save();
        for (const f of figuren) {
          const bb = network.getBoundingBox(f.id);
          if (!bb) continue;
          const barW    = Math.max(bb.right - bb.left, 70);
          const barLeft = (bb.left + bb.right) / 2 - barW / 2;
          const barY    = bb.bottom + 4;
          const barH    = 4;
          const segW    = barW / N;
          const kapsByName = {};
          for (const k of (f.kapitel || [])) kapsByName[k.name] = k.haeufigkeit || 1;
          // Hintergrund
          ctx.fillStyle = 'rgba(0,0,0,0.07)';
          ctx.fillRect(barLeft, barY, barW, barH);
          // Gefüllte Segmente pro Kapitel mit Auftritt
          const tier = info[f.id].tier;
          const col  = TIER_COLOR[tier] || '#2d6a9f';
          const [r, g, b] = col.startsWith('#') ? [parseInt(col.slice(1,3),16), parseInt(col.slice(3,5),16), parseInt(col.slice(5,7),16)] : [45,106,159];
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

    // Sofort fitten (keine Stabilisierung nötig, Physics ist aus)
    requestAnimationFrame(() => {
      network.fit({ animation: { duration: 250, easingFunction: 'easeInOutQuad' } });
      if (this.figurenGraphKapitel) this._figurenGraphSetKapitel(this.figurenGraphKapitel);
    });

    this._attachTooltip(container);
  },

  // ── Familienbaum (hierarchisches Layout, nur Familien-Edges) ────────────────
  _renderFamiliengraph(container) {
    const figuren = window.__app.figuren;
    const { edgeList } = this._buildEdges(/* soziogrammModus */ false);
    const familyEdges = edgeList.filter(e => ['elternteil', 'kind', 'geschwister'].includes(e.typ));
    if (!familyEdges.length) {
      container.innerHTML = `<span class="muted-msg muted-msg--block">${escHtml(window.__app.t('graph.empty.familie'))}</span>`;
      return;
    }
    const familyIds = new Set();
    for (const e of familyEdges) { familyIds.add(e.from); familyIds.add(e.to); }

    const nodes = new vis.DataSet(figuren.filter(f => familyIds.has(f.id)).map(f => ({
      id: f.id,
      label: nodeLabel(f),
      color: this._figTypColor(f.typ),
      font: DEFAULT_FONT,
      shape: 'box',
      margin: 10,
      widthConstraint: { maximum: 160 },
    })));
    const edges = new vis.DataSet(familyEdges);
    this._figurenNodes = nodes;
    this._figurenEdges = edges;

    this._figurenNetwork = new vis.Network(container, { nodes, edges }, {
      physics: { solver: 'hierarchicalRepulsion', hierarchicalRepulsion: { nodeDistance: 140 } },
      layout: { hierarchical: { direction: 'UD', sortMethod: 'directed', nodeSpacing: 160, levelSeparation: 120 } },
      interaction: { hover: true, tooltipDelay: 100 },
      edges: { smooth: { type: 'cubicBezier' } },
    });
    this._figurenNetwork.once('stabilizationIterationsDone', () => {
      const positions = this._figurenNetwork.getPositions();
      nodes.update(Object.entries(positions).map(([id, { x, y }]) => ({ id, x, y })));
      this._figurenNetwork.setOptions({ physics: false, layout: { hierarchical: { enabled: false } } });
    });
    this._attachTooltip(container);
  },

  // ── Kapitel-Filter im Figurengraph ──────────────────────────────────────────
  _figurenGraphSetKapitel(ch) {
    this.figurenGraphKapitel = ch;
    if (!this._figurenNodes || !this._figurenEdges) return;
    // Filter greift nur im Figurengraph-Modus. In Familie/Soziogramm enthalten die
    // DataSets nicht alle Figuren-IDs → ein update() würde Geister-Nodes erzeugen.
    if (this.figurenGraphModus !== 'figur') return;

    const figuren = window.__app.figuren;
    const existingIds = new Set(this._figurenNodes.getIds());
    const activeIds = new Set(
      ch ? figuren.filter(f => (f.kapitel || []).some(k => k.name === ch)).map(f => f.id)
         : figuren.map(f => f.id)
    );

    // Nodes: aktive = Originalfarbe, inaktive = ausgegraut
    this._figurenNodes.update(figuren.filter(f => existingIds.has(f.id)).map(f => {
      if (!ch || activeIds.has(f.id)) {
        return {
          id: f.id,
          color: this._figTypColor(f.typ),
          font: { ...DEFAULT_FONT, color: '#333' },
        };
      }
      return {
        id: f.id,
        color: { background: '#efefef', border: '#ccc', highlight: { background: '#efefef', border: '#ccc' } },
        font: { ...DEFAULT_FONT, color: '#bbb' },
      };
    }));

    // Edges: sichtbar wenn mind. ein Endpoint aktiv, sonst ausgegraut
    this._figurenEdges.update(this._figurenEdges.get().map(e => {
      if (!ch || activeIds.has(e.from) || activeIds.has(e.to)) {
        const s = BZ[e.typ] || BZ.andere;
        return { id: e.id, color: { color: s.color, highlight: s.highlight } };
      }
      return { id: e.id, color: { color: '#ddd', highlight: '#ddd' } };
    }));
  },

  // ── Soziogramm (nach Sozialschicht gefärbt, Schicht-Rows, Machtpfeile) ──────
  _renderSoziogramm(container) {
    const figuren = window.__app.figuren;
    // Guard: noch keine Sozialschichten vorhanden → Placeholder statt leerem Graph
    const hasSchicht = figuren.some(f => f.sozialschicht && f.sozialschicht !== 'andere');
    if (!hasSchicht) {
      if (this._figurenNetwork) { this._figurenNetwork.destroy(); this._figurenNetwork = null; }
      container.innerHTML = `<span class="muted-msg soziogramm-placeholder">${window.__app.t('graph.empty.sozialschicht')}</span>`;
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
      const schichtStyle = SCHICHT_COLOR[f.sozialschicht] || SCHICHT_COLOR.andere;
      return {
        id: f.id,
        label: nodeLabel(f),
        color: { background: schichtStyle.background, border: schichtStyle.border, highlight: schichtStyle.highlight },
        font: schichtStyle.font || DEFAULT_FONT,
        shape: 'box',
        margin: 10,
        widthConstraint: { maximum: 160 },
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

    const SCHICHT_BAND_COLOR = {
      wirtschaftselite:    'rgba(255,243,204,0.40)',
      gehobenes_buergertum:'rgba(212,232,255,0.35)',
      mittelschicht:       'rgba(232,244,232,0.35)',
      arbeiterschicht:     'rgba(245,234,212,0.38)',
      migrantenmilieu:     'rgba(253,235,208,0.40)',
      prekariat:           'rgba(245,237,237,0.40)',
      unterwelt:           'rgba(40,40,40,0.22)',
      andere:              'rgba(255,245,220,0.25)',
    };
    const SCHICHT_LABEL_COLOR = {
      wirtschaftselite:    '#8B6A00',
      gehobenes_buergertum:'#1d4b73',
      mittelschicht:       '#275927',
      arbeiterschicht:     '#6B3F0D',
      migrantenmilieu:     '#9A4010',
      prekariat:           '#6B1A1A',
      unterwelt:           '#ccc',
      andere:              '#888',
    };
    const BAND_H      = LEVEL_Y_GAP * 0.90;
    const BAND_HALF   = BAND_H / 2;
    const BAND_EXTENT = 9000;
    const network     = this._figurenNetwork;

    network.on('beforeDrawing', (ctx) => {
      // 1) Farbige Streifen + Trennlinien in Netzwerk-Koordinaten
      ctx.save();
      for (const [levStr, schicht] of Object.entries(levelToSchicht)) {
        const y = Number(levStr) * LEVEL_Y_GAP;
        ctx.fillStyle = SCHICHT_BAND_COLOR[schicht] || 'rgba(200,200,200,0.18)';
        ctx.fillRect(-BAND_EXTENT, y - BAND_HALF, BAND_EXTENT * 2, BAND_H);
        // Trennlinie unten
        ctx.strokeStyle = 'rgba(0,0,0,0.07)';
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
      ctx.font = `bold ${10 * dpr}px system-ui, -apple-system, sans-serif`;
      ctx.textBaseline = 'middle';
      for (const [levStr, schicht] of Object.entries(levelToSchicht)) {
        const domY = network.canvasToDOM({ x: 0, y: Number(levStr) * LEVEL_Y_GAP }).y;
        if (domY < -16 || domY > ctx.canvas.height / dpr + 16) continue;
        // Hintergrund-Pill (rounded rect, compat-safe) – Koordinaten in Canvas-Pixeln (× dpr)
        const label = window.__app.t('figuren.schicht.' + schicht);
        const tw    = ctx.measureText(label).width;
        const cY = domY * dpr;
        const px = 6 * dpr, py = cY - 9 * dpr, pw = tw + 12 * dpr, ph = 18 * dpr, pr = 4 * dpr;
        ctx.fillStyle = 'rgba(255,255,255,0.80)';
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
        ctx.fillStyle = SCHICHT_LABEL_COLOR[schicht] || '#666';
        ctx.fillText(label, 12 * dpr, cY);
      }
      ctx.restore();
    });

    this._attachTooltip(container);
  },

  // ── Gemeinsame Kanten-Baulogik ───────────────────────────────────────────────
  _buildEdges(soziogrammModus) {
    const figuren = window.__app.figuren;
    const edgeList = [];
    const addedPairs = new Set();

    for (const f of figuren) {
      for (const bz of (f.beziehungen || [])) {
        const targetFigur = figuren.find(x => x.id == bz.figur_id);
        if (!targetFigur) continue;
        const toId = targetFigur.id;

        // Deduplizierung: gerichtete Typen per [from, to, typ]; undirektionale per sortiertem Paar
        const dedupeKey = DIRECTED_TYPES.includes(bz.typ)
          ? [f.id, toId, bz.typ].join('|')
          : [[f.id, toId].sort().join('-'), bz.typ].join('|');
        if (addedPairs.has(dedupeKey)) continue;
        addedPairs.add(dedupeKey);

        if (soziogrammModus) {
          // Soziogramm: Farbe nach Kategorie, Breite nach Machtasymmetrie, Pfeil nach machtverhaltnis
          const cat    = BZ_SOZIO_CAT[bz.typ] || 'sozial';
          const color  = BZ_SOZIO_COLOR[cat];
          const macht  = bz.machtverhaltnis ?? 0;
          const width  = 1 + Math.abs(macht) * 1.5;
          let arrows = '';
          if (macht > 0)       arrows = 'to';
          else if (macht < 0)  arrows = 'from';
          else if (DIRECTED_TYPES.includes(bz.typ)) arrows = BZ[bz.typ]?.arrows || '';

          edgeList.push({
            from: f.id, to: toId,
            // Label bewusst leer: Beziehungstyp nur im Hover-Tooltip, um dichte Graphen lesbar zu halten
            label: '',
            typ: bz.typ,
            beschreibung: bz.beschreibung || '',
            color: { color, highlight: color },
            arrows,
            dashes: false,
            width,
          });
        } else {
          // Figurengraph: klassisches Styling
          const s = BZ[bz.typ] || BZ.andere;
          edgeList.push({
            from: f.id, to: toId,
            label: '',
            typ: bz.typ,
            beschreibung: bz.beschreibung || '',
            color: { color: s.color, highlight: s.highlight },
            arrows: s.arrows,
            dashes: s.dashes,
          });
        }
      }
    }
    return { edgeList };
  },

  // ── Tooltip-Logik (shared) ───────────────────────────────────────────────────
  _attachTooltip(container) {
    const tip = document.getElementById('figur-tooltip');
    if (!tip) return;

    const showTipAt = (html, clientX, clientY) => {
      tip.innerHTML = html;
      tip.style.left = '0px';
      tip.style.top  = '0px';
      tip.classList.add('visible');
      const rect = container.getBoundingClientRect();
      const tipW = tip.offsetWidth;
      const tipH = tip.offsetHeight;
      const cW   = container.offsetWidth;
      const cH   = container.offsetHeight;
      const cx   = clientX - rect.left;
      const cy   = clientY - rect.top;
      let left = cx + 14;
      let top  = cy + 14;
      if (left + tipW > cW) left = Math.max(0, cx - tipW - 14);
      if (top  + tipH > cH) top  = Math.max(0, cy - tipH - 14);
      if (left < 0) left = 0;
      if (top  < 0) top  = 0;
      tip.style.left = left + 'px';
      tip.style.top  = top  + 'px';
    };
    const hideTip = () => tip.classList.remove('visible');

    this._figurenNetwork.on('hoverNode', ({ node, event }) => {
      const f = window.__app.figuren.find(x => x.id === node);
      if (!f) return;
      // „Weitere" im Tooltip unterdrücken – der Tooltip blendet die Schichtzeile
      // nur ein, wenn es eine echte Zuordnung gibt.
      const schichtLabel = f.sozialschicht && f.sozialschicht !== 'andere'
        ? window.__app.t('figuren.schicht.' + f.sozialschicht) : '';
      const typLabel = f.typ ? window.__app.t('figuren.type.' + f.typ) : '';
      const html = `<strong>${escHtml(f.name)}</strong>`
        + `<em>${escHtml(typLabel)}${schichtLabel ? ' · ' + escHtml(schichtLabel) : ''}</em>`
        + (f.beschreibung ? `<p>${escHtml(f.beschreibung)}</p>` : '');
      showTipAt(html, event.clientX, event.clientY);
    });
    this._figurenNetwork.on('blurNode', hideTip);

    this._figurenNetwork.on('hoverEdge', ({ edge, event }) => {
      const e = this._figurenEdges?.get(edge);
      if (!e) return;
      const fromF = window.__app.figuren.find(x => x.id === e.from);
      const toF   = window.__app.figuren.find(x => x.id === e.to);
      const typLabel = window.__app.t('figuren.bz.' + e.typ);
      const arrow = e.arrows === 'to' ? '→' : e.arrows === 'from' ? '←' : '↔';
      const pair = fromF && toF
        ? `${escHtml(fromF.kurzname || fromF.name)} ${arrow} ${escHtml(toF.kurzname || toF.name)}`
        : '';
      const html = `<strong>${escHtml(typLabel)}</strong>`
        + (pair ? `<em>${pair}</em>` : '')
        + (e.beschreibung ? `<p>${escHtml(e.beschreibung)}</p>` : '');
      showTipAt(html, event.clientX, event.clientY);
    });
    this._figurenNetwork.on('blurEdge', hideTip);
  },
};
