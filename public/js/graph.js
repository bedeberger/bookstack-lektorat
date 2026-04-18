import { escHtml } from './utils.js';

// Graph-Render-Methoden (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.

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
  // Reaktiver Modus-State (spread in Alpine-Data)
  figurenGraphModus: 'figur',
  figurenGraphKapitel: null,   // aktiver Kapitel-Filter (null = alle)
  figurenGraphFullscreen: false,

  _figTypColor(typ) {
    const colors = {
      hauptfigur: { background: '#D4E8FF', border: '#2d6a9f', highlight: { background: '#BDD8FF', border: '#1d4b73' } },
      nebenfigur:  { background: '#F0F0F0', border: '#888',    highlight: { background: '#E4E4E4', border: '#555' } },
      antagonist:  { background: '#FFE0E0', border: '#E24B4A', highlight: { background: '#FFC7C7', border: '#B03030' } },
      mentor:      { background: '#EAF3DE', border: '#639922', highlight: { background: '#D5EBBD', border: '#3B6D11' } },
      andere:      { background: '#FFF5DC', border: '#c4a55a', highlight: { background: '#FFEEBB', border: '#8a6a20' } },
    };
    return colors[typ] || colors.andere;
  },

  toggleFigurenGraphModus() {
    this.figurenGraphModus = this.figurenGraphModus === 'figur' ? 'soziogramm' : 'figur';
    this._figurenHash = null; // Cache ungültig machen → erzwingt Neurender
    this.$nextTick(() => this.renderFigurGraph());
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

    // Caching: Graph nur neu aufbauen wenn sich Figuren, Modus oder Sprache geändert haben
    const hash = this.figuren.map(f => f.id).join(',') + '|' + this.figurenGraphModus + '|' + this.uiLocale;
    if (this._figurenNetwork && this._figurenHash === hash) return;
    this._figurenHash = hash;

    if (this._figurenNetwork) {
      this._figurenNetwork.destroy();
      this._figurenNetwork = null;
    }
    if (!this.figuren.length) {
      container.innerHTML = `<span class="muted-msg" style="display:block;padding:20px;text-align:center;">${escHtml(this.t('graph.empty.figuren'))}</span>`;
      return;
    }
    if (typeof vis === 'undefined') {
      container.innerHTML = `<span class="muted-msg" style="display:block;padding:20px;text-align:center;">${escHtml(this.t('graph.empty.visLoading'))}</span>`;
      return;
    }

    if (this.figurenGraphModus === 'soziogramm') {
      this._renderSoziogramm(container);
    } else {
      this._renderFigurengraph(container);
    }
  },

  // ── Figurengraph (nach Figurentyp gefärbt) ──────────────────────────────────
  _renderFigurengraph(container) {
    // Tableau-10-Palette für Kapitel-Cluster
    const CHAP_PALETTE = [
      [78,121,167],[242,142,43],[225,87,89],[118,183,178],[89,161,79],
      [237,201,72],[176,122,161],[255,157,167],[156,117,95],[186,176,172],
    ];

    // Kapitel-Clustering: Startposition jeder Figur = gewichtetes Mittel
    // der Kapitel-Positionen. Figuren die in denselben Kapiteln vorkommen,
    // starten nahe beieinander.
    const allChapters = [...new Set(
      this.figuren.flatMap(f => (f.kapitel || []).map(k => k.name))
    )];
    const N = allChapters.length;

    // Cluster- und Ring-Radius aus tatsächlicher Figurenzahl ableiten, damit
    // jeder Kreis seine Figuren auch wirklich aufnehmen kann. Ohne diese
    // Skalierung überlappen Ringe bei >3 Figuren/Kapitel und der Post-Pass
    // drückt Figuren nach aussen, weg von ihrem Kreis.
    const NODE_SPACING = 120;
    const figurenPerChapter = {};
    for (const f of this.figuren) for (const k of (f.kapitel || [])) {
      figurenPerChapter[k.name] = (figurenPerChapter[k.name] || 0) + 1;
    }
    const maxFigs = Math.max(1, ...Object.values(figurenPerChapter));
    // Packungsformel: clusterR ≈ 0.65 · spacing · √(m) reicht für m Figuren pro Disk
    const clusterR = N <= 1
      ? Math.max(280, 0.65 * NODE_SPACING * Math.sqrt(maxFigs))
      : Math.max(140, 0.65 * NODE_SPACING * Math.sqrt(maxFigs));
    // Ring so gross, dass benachbarte Cluster-Disks mit 10% Puffer nicht überlappen
    const R = N <= 1 ? 0 : Math.max(180, clusterR / Math.sin(Math.PI / N) * 1.1);
    console.debug('[graph] allChapters:', N, 'maxFigs:', maxFigs, 'R:', Math.round(R), 'clusterR:', Math.round(clusterR));

    const chapPos = {};
    allChapters.forEach((ch, i) => {
      const angle = (2 * Math.PI * i / N) - Math.PI / 2;
      chapPos[ch] = { x: R * Math.cos(angle), y: R * Math.sin(angle) };
    });

    this._figurenNodes = new vis.DataSet(this.figuren.map((f, figIdx) => {
      let x = 0, y = 0;
      const kaps = (f.kapitel || []).filter(k => chapPos[k.name]);
      // Gewichtete Kapitel-Position nur wenn N > 1: bei N <= 1 liegen alle
      // chapPos auf (0,0) (R=0), was zu identischen Startpositionen und damit
      // zur Linien-Degeneration des barnesHut-Physics führt.
      // Häufigkeit hoch 1.5 gewichten, damit Figuren mit klarem Hauptkapitel
      // dort angesiedelt werden statt zwischen mehreren Kapiteln im Zentrum
      // zu landen.
      if (kaps.length && N > 1) {
        const weight = k => Math.pow(k.haeufigkeit || 1, 1.5);
        const total = kaps.reduce((s, k) => s + weight(k), 0);
        for (const k of kaps) {
          const w = weight(k) / total;
          x += chapPos[k.name].x * w;
          y += chapPos[k.name].y * w;
        }
      }
      // Fallback: (0,0) als Startposition führt bei barnesHut zur Linien-Degeneration.
      // Tritt auf wenn: kein Kapitel, N<=1, oder Figur erscheint gleichmässig in allen
      // Kapiteln (Schwerpunkt eines symmetrischen Kreises = Zentrum).
      if (Math.abs(x) < 1 && Math.abs(y) < 1) {
        const startR = Math.max(200, this.figuren.length * 28);
        const angle  = (2 * Math.PI * figIdx / Math.max(1, this.figuren.length)) - Math.PI / 2;
        x = startR * Math.cos(angle);
        y = startR * Math.sin(angle);
      }
      return {
        id: f.id,
        label: nodeLabel(f),
        color: this._figTypColor(f.typ),
        font: DEFAULT_FONT,
        shape: 'box',
        margin: 10,
        widthConstraint: { maximum: 160 },
        x, y,
      };
    }));
    const nodes = this._figurenNodes;

    const { edgeList } = this._buildEdges(/* soziogrammModus */ false);
    this._figurenEdges = new vis.DataSet(edgeList);
    const edges = this._figurenEdges;

    const hasFamilyEdges = edgeList.some(e => ['elternteil', 'kind'].includes(e.typ));
    console.debug('[graph] hasFamilyEdges:', hasFamilyEdges, '→ circles:', !hasFamilyEdges && N > 0);
    const options = {
      physics: hasFamilyEdges
        ? { solver: 'hierarchicalRepulsion', hierarchicalRepulsion: { nodeDistance: 140 } }
        : { solver: 'barnesHut', barnesHut: { gravitationalConstant: -1500, centralGravity: 0, springLength: 80, springConstant: 0.08, damping: 0.2, avoidOverlap: 1.0 }, stabilization: { iterations: 250 } },
      layout: hasFamilyEdges
        ? { hierarchical: { direction: 'UD', sortMethod: 'directed', nodeSpacing: 160, levelSeparation: 120 } }
        : { improvedLayout: false },
      interaction: { hover: true, tooltipDelay: 100 },
      // dynamic: vis-network setzt virtuelle Stützpunkte auf jede Edge, die an der
      // Physics teilnehmen → Kanten biegen sich natürlich um Nodes herum.
      // cubicBezier bleibt für hierarchisches Layout (Familienbaum), da dynamic
      // dort mit dem hierarchical-Solver interferiert.
      edges: { smooth: hasFamilyEdges ? { type: 'cubicBezier' } : { type: 'dynamic', roundness: 0.5 } },
    };

    this._figurenNetwork = new vis.Network(container, { nodes, edges }, options);

    // Kapitel-Cluster-Kreise + Labels im Hintergrund zeichnen
    if (!hasFamilyEdges && N > 0) {
      const network = this._figurenNetwork;
      network.on('beforeDrawing', ctx => {
        const dpr = window.devicePixelRatio || 1;

        // 1) Kreise in Netzwerk-Koordinaten (skalieren mit Zoom/Pan)
        ctx.save();
        allChapters.forEach((ch, i) => {
          const [r, g, b] = CHAP_PALETTE[i % CHAP_PALETTE.length];
          const { x, y } = chapPos[ch];
          ctx.beginPath();
          ctx.arc(x, y, clusterR, 0, 2 * Math.PI);
          ctx.fillStyle = `rgba(${r},${g},${b},0.12)`;
          ctx.fill();
          ctx.strokeStyle = `rgba(${r},${g},${b},0.50)`;
          ctx.lineWidth = 2;
          ctx.setLineDash([8, 6]);
          ctx.stroke();
          ctx.setLineDash([]);
        });
        ctx.restore();

        // 2) Labels in Screen-Koordinaten (feste Lesegrösse unabhängig vom Zoom)
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.font = `bold ${11 * dpr}px system-ui,-apple-system,sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        allChapters.forEach((ch, i) => {
          const [r, g, b] = CHAP_PALETTE[i % CHAP_PALETTE.length];
          const { x, y } = chapPos[ch];
          // Unterkante des Kreises → DOM-Koordinaten → Canvas-Pixel
          const domBot = network.canvasToDOM({ x, y: y + clusterR });
          if (domBot.y < -20 || domBot.y > ctx.canvas.height / dpr + 20) return;
          const cX = domBot.x * dpr;
          const cY = domBot.y * dpr + 5 * dpr;
          ctx.fillStyle = `rgba(${r},${g},${b},0.85)`;
          ctx.fillText(ch, cX, cY);
        });
        ctx.restore();
      });
    }

    this._figurenNetwork.once('stabilizationIterationsDone', () => {
      // Positionen einfrieren bevor Physics/hierarchisches Layout deaktiviert wird –
      // sonst zieht vis-network beim Drag den ganzen Teilbaum mit.
      const positions = this._figurenNetwork.getPositions();
      nodes.update(Object.entries(positions).map(([id, { x, y }]) => ({ id, x, y })));
      this._figurenNetwork.setOptions({ physics: false, layout: { hierarchical: { enabled: false } } });
      // Chapter-Attract: Nodes Richtung ihres Kapitel-Zentroids ziehen, damit die
      // Cluster-Struktur nach der Spring-Simulation erkennbar wird. Nur im
      // barnesHut-Modus (kein Familienbaum) und wenn es ≥ 2 Kapitel gibt.
      if (!hasFamilyEdges && N > 1) this._chapterAttractPostPass(chapPos, nodes);
      // Aktiven Filter nach Neurender wiederherstellen
      if (this.figurenGraphKapitel) this._figurenGraphSetKapitel(this.figurenGraphKapitel);
    });
    this._attachTooltip(container);
  },

  // ── Chapter-Attract Post-Pass (Variante 2) ───────────────────────────────────
  // Zieht jede Figur anteilig in den gewichteten Mittelpunkt ihrer Kapitel und
  // löst Überlappungen per einfacher pairwise-Repulsion auf. Läuft geometrisch
  // (kein vis-Physics), damit die Edges nicht direkt zurückziehen.
  _chapterAttractPostPass(chapPos, nodes) {
    const ALPHA = 0.6;      // Anteil Richtung Zentroid pro Pass (1.0 = hart snappen)
    const MIN_DIST = 120;   // Ziel-Mindestabstand zwischen Node-Mittelpunkten
    const REPULSION_ITER = 25;

    const pos = this._figurenNetwork.getPositions();
    const next = {};
    // Gleiche Gewichtung wie Startposition: Hauptkapitel (höchste Häufigkeit)
    // dominiert deutlich, damit Mehrfach-Kapitel-Figuren nicht im Zentrum landen.
    const weight = k => Math.pow(k.haeufigkeit || 1, 1.5);

    for (const f of this.figuren) {
      const cur = pos[f.id];
      if (!cur) continue;
      const kaps = (f.kapitel || []).filter(k => chapPos[k.name]);
      if (!kaps.length) { next[f.id] = { x: cur.x, y: cur.y }; continue; }
      const total = kaps.reduce((s, k) => s + weight(k), 0);
      let tx = 0, ty = 0;
      for (const k of kaps) {
        const w = weight(k) / total;
        tx += chapPos[k.name].x * w;
        ty += chapPos[k.name].y * w;
      }
      next[f.id] = {
        x: cur.x + ALPHA * (tx - cur.x),
        y: cur.y + ALPHA * (ty - cur.y),
      };
    }

    // Pairwise-Repulsion: schiebt sich überlappende Nodes auseinander, ohne die
    // Cluster-Zugehörigkeit zu zerstören (Aufwand O(N² · iter), N typ. < 50).
    const ids = Object.keys(next);
    for (let iter = 0; iter < REPULSION_ITER; iter++) {
      let moved = false;
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = next[ids[i]], b = next[ids[j]];
          const dx = b.x - a.x, dy = b.y - a.y;
          const d = Math.hypot(dx, dy);
          if (d < MIN_DIST && d > 0.01) {
            const push = (MIN_DIST - d) / 2;
            const nx = dx / d, ny = dy / d;
            a.x -= nx * push; a.y -= ny * push;
            b.x += nx * push; b.y += ny * push;
            moved = true;
          } else if (d <= 0.01) {
            // exakt gleiche Position → minimal auseinanderstossen
            a.x -= 1; b.x += 1;
            moved = true;
          }
        }
      }
      if (!moved) break;
    }

    nodes.update(ids.map(id => ({ id, x: next[id].x, y: next[id].y })));
  },

  // ── Kapitel-Filter im Figurengraph ──────────────────────────────────────────
  _figurenGraphSetKapitel(ch) {
    this.figurenGraphKapitel = ch;
    if (!this._figurenNodes || !this._figurenEdges) return;

    const activeIds = new Set(
      ch ? this.figuren.filter(f => (f.kapitel || []).some(k => k.name === ch)).map(f => f.id)
         : this.figuren.map(f => f.id)
    );

    // Nodes: aktive = Originalfarbe, inaktive = ausgegraut
    this._figurenNodes.update(this.figuren.map(f => {
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
    // Guard: noch keine Sozialschichten vorhanden → Placeholder statt leerem Graph
    const hasSchicht = this.figuren.some(f => f.sozialschicht && f.sozialschicht !== 'andere');
    if (!hasSchicht) {
      if (this._figurenNetwork) { this._figurenNetwork.destroy(); this._figurenNetwork = null; }
      container.innerHTML = `<span class="muted-msg soziogramm-placeholder">${this.t('graph.empty.sozialschicht')}</span>`;
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
    for (const f of this.figuren) {
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

    const nodes = new vis.DataSet(this.figuren.map(f => {
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
    for (const f of this.figuren) {
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
        const label = this.t('figuren.schicht.' + schicht);
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
    const edgeList = [];
    const addedPairs = new Set();

    for (const f of this.figuren) {
      for (const bz of (f.beziehungen || [])) {
        const targetFigur = this.figuren.find(x => x.id == bz.figur_id);
        if (!targetFigur) continue;
        const toId = targetFigur.id;

        // Deduplizierung: gerichtete Typen per [from, to, typ]; undirektionale per sortiertem Paar
        const dedupeKey = DIRECTED_TYPES.includes(bz.typ)
          ? [f.id, toId, bz.typ].join('|')
          : [[f.id, toId].sort().join('-'), bz.typ].join('|');
        if (addedPairs.has(dedupeKey)) continue;
        addedPairs.add(dedupeKey);

        const typLabel = this.t('figuren.bz.' + bz.typ);
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
            title: bz.beschreibung || typLabel,
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
            title: bz.beschreibung || typLabel,
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
    this._figurenNetwork.on('hoverNode', ({ node, event }) => {
      const f = this.figuren.find(x => x.id === node);
      if (!f || !tip) return;
      // „Weitere" im Tooltip unterdrücken – der Tooltip blendet die Schichtzeile
      // nur ein, wenn es eine echte Zuordnung gibt.
      const schichtLabel = f.sozialschicht && f.sozialschicht !== 'andere'
        ? this.t('figuren.schicht.' + f.sozialschicht) : '';
      const typLabel = f.typ ? this.t('figuren.type.' + f.typ) : '';
      tip.innerHTML = `<strong>${escHtml(f.name)}</strong>`
        + `<em>${escHtml(typLabel)}${schichtLabel ? ' · ' + escHtml(schichtLabel) : ''}</em>`
        + (f.beschreibung ? `<p>${escHtml(f.beschreibung)}</p>` : '');
      tip.style.left = '0px';
      tip.style.top  = '0px';
      tip.classList.add('visible');
      const rect = container.getBoundingClientRect();
      const tipW = tip.offsetWidth;
      const tipH = tip.offsetHeight;
      const cW   = container.offsetWidth;
      const cH   = container.offsetHeight;
      const cx   = event.clientX - rect.left;
      const cy   = event.clientY - rect.top;
      let left = cx + 14;
      let top  = cy + 14;
      if (left + tipW > cW) left = Math.max(0, cx - tipW - 14);
      if (top  + tipH > cH) top  = Math.max(0, cy - tipH - 14);
      if (left < 0) left = 0;
      if (top  < 0) top  = 0;
      tip.style.left = left + 'px';
      tip.style.top  = top  + 'px';
    });
    this._figurenNetwork.on('blurNode', () => {
      if (tip) tip.classList.remove('visible');
    });
  },
};
