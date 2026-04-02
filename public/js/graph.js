import { escHtml } from './utils.js';

// Graph-Render-Methoden (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.

export const graphMethods = {
  _figTypColor(typ) {
    const colors = {
      hauptfigur: { background: '#D4E8FF', border: '#4A90D9', highlight: { background: '#BDD8FF', border: '#2B6CB0' } },
      nebenfigur:  { background: '#F0F0F0', border: '#888',    highlight: { background: '#E4E4E4', border: '#555' } },
      antagonist:  { background: '#FFE0E0', border: '#E24B4A', highlight: { background: '#FFC7C7', border: '#B03030' } },
      mentor:      { background: '#EAF3DE', border: '#639922', highlight: { background: '#D5EBBD', border: '#3B6D11' } },
      andere:      { background: '#FFF5DC', border: '#C4941A', highlight: { background: '#FFEEBB', border: '#8A6800' } },
    };
    return colors[typ] || colors.andere;
  },

  renderFigurGraph() {
    const container = document.getElementById('figuren-graph');
    if (!container) return;
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

    const nodes = new vis.DataSet(this.figuren.map(f => ({
      id: f.id,
      label: (f.kurzname || f.name) + (f.geburtstag ? '\n* ' + f.geburtstag : ''),
      title: `<b>${escHtml(f.name)}</b><br>${escHtml(f.typ)}<br>${escHtml(f.beschreibung || '')}`,
      color: this._figTypColor(f.typ),
      font: { size: 13, face: 'system-ui, -apple-system, sans-serif' },
      shape: 'box',
      margin: 10,
      widthConstraint: { maximum: 160 },
    })));

    const BZ = {
      elternteil:      { color: '#888',    highlight: '#555',    arrows: 'to',   dashes: false },
      kind:            { color: '#888',    highlight: '#555',    arrows: 'from', dashes: false },
      geschwister:     { color: '#4A90D9', highlight: '#2B6CB0', arrows: '',     dashes: [5,5] },
      freund:          { color: '#639922', highlight: '#3B6D11', arrows: '',     dashes: [4,3] },
      feind:           { color: '#E24B4A', highlight: '#B03030', arrows: '',     dashes: [4,3] },
      kollege:         { color: '#C4941A', highlight: '#8A6800', arrows: '',     dashes: [4,3] },
      bekannt:         { color: '#999',    highlight: '#555',    arrows: '',     dashes: [4,3] },
      liebesbeziehung: { color: '#D46EA0', highlight: '#A0446E', arrows: '',     dashes: [4,3] },
      rivale:          { color: '#9B4B00', highlight: '#6B3000', arrows: '',     dashes: [4,3] },
      mentor:          { color: '#4A90D9', highlight: '#2B6CB0', arrows: 'to',   dashes: [4,3] },
      schuetzling:     { color: '#4A90D9', highlight: '#2B6CB0', arrows: 'from', dashes: [4,3] },
      andere:          { color: '#bbb',    highlight: '#888',    arrows: '',     dashes: [4,3] },
    };

    const edgeList = [];
    const addedPairs = new Set();

    for (const f of this.figuren) {
      for (const bz of (f.beziehungen || [])) {
        if (!this.figuren.find(x => x.id === bz.figur_id)) continue;
        // Deduplizieren: geschwister + undirektionale Typen per sort-Key
        const directed = ['elternteil', 'kind', 'mentor', 'schuetzling'];
        const dedupeKey = directed.includes(bz.typ)
          ? [f.id, bz.figur_id, bz.typ].join('|')
          : [[f.id, bz.figur_id].sort().join('-'), bz.typ].join('|');
        if (addedPairs.has(dedupeKey)) continue;
        addedPairs.add(dedupeKey);

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
  },
};
