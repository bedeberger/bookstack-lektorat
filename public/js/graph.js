import { escHtml } from './utils.js';

// Graph-Render-Methoden (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.

// ── Sozialschicht-Palette ────────────────────────────────────────────────────
const SCHICHT_COLOR = {
  adel:            { background: '#FFF3CC', border: '#A07800', highlight: { background: '#FFE566', border: '#7A5A00' } },
  klerus:          { background: '#EDE0F8', border: '#7B3FA0', highlight: { background: '#DBC3F5', border: '#5A1F80' } },
  grossbuergertum: { background: '#D4E8FF', border: '#2d6a9f', highlight: { background: '#BDD8FF', border: '#1d4b73' } },
  buergertum:      { background: '#E8F4E8', border: '#3a7a3a', highlight: { background: '#D0EBD0', border: '#275927' } },
  kleinbuergertum: { background: '#F0F0F0', border: '#666',    highlight: { background: '#E4E4E4', border: '#444'    } },
  arbeiterklasse:  { background: '#F5EAD4', border: '#8B5E26', highlight: { background: '#EDD9A8', border: '#6B3F0D' } },
  unterwelt:       { background: '#3A3A3A', border: '#111',    highlight: { background: '#505050', border: '#000'    },
                     font: { color: '#fff', size: 13, face: 'system-ui, -apple-system, sans-serif' } },
  andere:          { background: '#FFF5DC', border: '#c4a55a', highlight: { background: '#FFEEBB', border: '#8a6a20' } },
};

// Vertikale Ebene pro Schicht (0 = oben)
const SCHICHT_LEVEL = {
  adel:            0,
  klerus:          1,
  grossbuergertum: 2,
  buergertum:      3,
  kleinbuergertum: 4,
  arbeiterklasse:  5,
  unterwelt:       6,
  andere:          3,
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

  renderFigurGraph() {
    const container = document.getElementById('figuren-graph');
    if (!container) return;

    // Caching: Graph nur neu aufbauen wenn sich Figuren oder Modus geändert haben
    const hash = this.figuren.map(f => f.id).join(',') + '|' + this.figurenGraphModus;
    if (this._figurenNetwork && this._figurenHash === hash) return;
    this._figurenHash = hash;

    if (this._figurenNetwork) {
      this._figurenNetwork.destroy();
      this._figurenNetwork = null;
    }
    if (!this.figuren.length) {
      container.innerHTML = '<span class="muted-msg" style="display:block;padding:20px;text-align:center;">Noch keine Figuren – «Figuren ermitteln» starten.</span>';
      return;
    }
    if (typeof vis === 'undefined') {
      container.innerHTML = '<span class="muted-msg" style="display:block;padding:20px;text-align:center;">vis-network wird geladen…</span>';
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
    const nodes = new vis.DataSet(this.figuren.map(f => ({
      id: f.id,
      label: (f.kurzname || f.name) + (f.geburtstag ? '\n* ' + f.geburtstag : ''),
      color: this._figTypColor(f.typ),
      font: { size: 13, face: 'system-ui, -apple-system, sans-serif' },
      shape: 'box',
      margin: 10,
      widthConstraint: { maximum: 160 },
    })));

    const { edgeList } = this._buildEdges(/* soziogrammModus */ false);
    const edges = new vis.DataSet(edgeList);

    const hasFamilyEdges = edgeList.some(e => ['elternteil', 'kind'].includes(e.label));
    const options = {
      physics: hasFamilyEdges
        ? { solver: 'hierarchicalRepulsion', hierarchicalRepulsion: { nodeDistance: 140 } }
        : { solver: 'repulsion', repulsion: { nodeDistance: 160 } },
      layout: hasFamilyEdges
        ? { hierarchical: { direction: 'UD', sortMethod: 'directed', nodeSpacing: 160, levelSeparation: 120 } }
        : { randomSeed: 42 },
      interaction: { hover: true, tooltipDelay: 100 },
      edges: { smooth: { type: 'cubicBezier' } },
    };

    this._figurenNetwork = new vis.Network(container, { nodes, edges }, options);
    this._attachTooltip(container);
  },

  // ── Soziogramm (nach Sozialschicht gefärbt, Schicht-Rows, Machtpfeile) ──────
  _renderSoziogramm(container) {
    const LEVEL_Y_GAP = 190;
    const NODE_X_GAP  = 210;

    // Knoten nach Schicht-Ebene gruppieren (für X-Positionierung)
    const levelGroups = {};
    for (const f of this.figuren) {
      const lev = SCHICHT_LEVEL[f.sozialschicht] ?? SCHICHT_LEVEL.andere;
      (levelGroups[lev] ??= []).push(f);
    }
    const levelCounters = {};

    const nodes = new vis.DataSet(this.figuren.map(f => {
      const lev = SCHICHT_LEVEL[f.sozialschicht] ?? SCHICHT_LEVEL.andere;
      const cnt = levelGroups[lev].length;
      levelCounters[lev] = (levelCounters[lev] ?? 0);
      const idx = levelCounters[lev]++;
      const x = (idx - (cnt - 1) / 2) * NODE_X_GAP;
      const y = lev * LEVEL_Y_GAP;

      const schichtStyle = SCHICHT_COLOR[f.sozialschicht] || SCHICHT_COLOR.andere;
      return {
        id: f.id,
        label: (f.kurzname || f.name) + (f.geburtstag ? '\n* ' + f.geburtstag : ''),
        color: { background: schichtStyle.background, border: schichtStyle.border, highlight: schichtStyle.highlight },
        font: schichtStyle.font || { size: 13, face: 'system-ui, -apple-system, sans-serif' },
        shape: 'box',
        margin: 10,
        widthConstraint: { maximum: 160 },
        x, y,
        fixed: { x: false, y: true },
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
    this._attachTooltip(container);
  },

  // ── Gemeinsame Kanten-Baulogik ───────────────────────────────────────────────
  _buildEdges(soziogrammModus) {
    const edgeList = [];
    const addedPairs = new Set();

    for (const f of this.figuren) {
      for (const bz of (f.beziehungen || [])) {
        if (!this.figuren.find(x => x.id === bz.figur_id)) continue;

        // Deduplizierung: gerichtete Typen per [from, to, typ]; undirektionale per sortiertem Paar
        const dedupeKey = DIRECTED_TYPES.includes(bz.typ)
          ? [f.id, bz.figur_id, bz.typ].join('|')
          : [[f.id, bz.figur_id].sort().join('-'), bz.typ].join('|');
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
            from: f.id, to: bz.figur_id,
            label: bz.typ,
            title: bz.beschreibung || bz.typ,
            font: { size: 10, color },
            color: { color, highlight: color },
            arrows,
            dashes: false,
            width,
          });
        } else {
          // Figurengraph: klassisches Styling
          const s = BZ[bz.typ] || BZ.andere;
          edgeList.push({
            from: f.id, to: bz.figur_id,
            label: bz.typ,
            title: bz.beschreibung || bz.typ,
            font: { size: 10, color: s.color },
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
      const schichtLabel = {
        adel: 'Adel', klerus: 'Klerus', grossbuergertum: 'Großbürgertum',
        buergertum: 'Bürgertum', kleinbuergertum: 'Kleinbürgertum',
        arbeiterklasse: 'Arbeiterklasse', unterwelt: 'Unterwelt',
      }[f.sozialschicht] || '';
      tip.innerHTML = `<strong>${escHtml(f.name)}</strong>`
        + `<em>${escHtml(f.typ)}${schichtLabel ? ' · ' + escHtml(schichtLabel) : ''}</em>`
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
