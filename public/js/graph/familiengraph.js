import { graphPlaceholder } from '../graph-kit.js';

// Familienbaum: hierarchisches Layout, nur Familien-Edges.
export const familiengraphMethods = {
  _renderFamiliengraph(container) {
    const figuren = this._graphFiguren();
    const { edgeList } = this._buildEdges(/* soziogrammModus */ false);
    const familyEdges = edgeList.filter(e => ['elternteil', 'kind', 'geschwister'].includes(e.typ));
    if (!familyEdges.length) {
      graphPlaceholder(container, window.__app.t('graph.empty.familie'));
      return;
    }
    const familyIds = new Set();
    for (const e of familyEdges) { familyIds.add(e.from); familyIds.add(e.to); }

    const nodes = new vis.DataSet(figuren.filter(f => familyIds.has(f.id)).map(f => this._baseNode(f)));
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
};
