import { escHtml } from '../utils.js';
import { createGraphTooltip, adaptNodeColor, graphTheme } from '../graph-kit.js';
import {
  DEFAULT_FONT,
  TYP_COLOR,
  SCHICHT_COLOR,
  BZ,
  BZ_SOZIO_COLOR,
  BZ_SOZIO_CAT,
  DIRECTED_TYPES,
  nodeLabel,
} from './constants.js';

// Gemeinsame Methoden: Typ-Color, Node-Basis, Edge-Bau, Tooltip, Kapitel-Filter.
// Werden in graphMethods gespreaded und nutzen `this`-Refs aus Card.
export const sharedMethods = {
  // Figuren-Quelle für alle Graph-Ansichten: verwaiste (stale) Figuren werden
  // ausgeblendet. Sie stehen nicht mehr im Text und würden sonst als
  // beziehungslose Geister-Knoten den Graph verschmutzen (ihre kapitel-Belege
  // bleiben erhalten). Im Figuren-Katalog bleiben sie — mit Badge — sichtbar.
  _graphFiguren() {
    return (Alpine.store('catalog').figuren || []).filter(f => !f.stale);
  },

  // Aufgelöste Canvas-Farben. renderFigurGraph setzt sie vor dem Dispatch; der
  // Fallback greift nur, wenn eine Methode ausserhalb des Render-Pfads zuerst
  // zieht (Kapitel-Filter aus dem Hash-Router).
  _theme() {
    return (this._graphTheme ||= graphTheme(document.getElementById('figuren-graph')));
  },

  // Figurentyp-Farbe, für den aktuellen Grund nachgeführt (Dark-Mode: getönte
  // Fläche statt Pastell, Border bleibt der Erkennungsanker).
  _figTypColor(typ) {
    return adaptNodeColor(TYP_COLOR[typ] || TYP_COLOR.andere, this._theme());
  },

  // Node-Font: im Dark-Mode trägt die abgemischte Fläche keinen dunklen Text mehr.
  _nodeFont() {
    return { ...DEFAULT_FONT, color: this._theme().text };
  },

  // Gemeinsame vis-Node-Basis. Familiengraph nutzt sie direkt; Figurengraph
  // ergänzt borderWidth + x/y, Soziogramm überschreibt color/font und ergänzt
  // x/y + fixed (spätere Keys gewinnen beim Spread).
  _baseNode(f) {
    return {
      id: f.id,
      label: nodeLabel(f),
      color: this._figTypColor(f.typ),
      font: this._nodeFont(),
      shape: 'box',
      margin: 10,
      widthConstraint: { maximum: 160 },
    };
  },

  _figurenGraphSetKapitel(ch) {
    this.figurenGraphKapitel = ch;
    if (!this._figurenNodes || !this._figurenEdges) return;

    const figuren = this._graphFiguren();
    const existingIds = new Set(this._figurenNodes.getIds());
    const activeIds = new Set(
      ch ? figuren.filter(f => (f.kapitel || []).some(k => k.name === ch)).map(f => f.id)
         : figuren.map(f => f.id)
    );
    const soziogrammModus = this.figurenGraphModus === 'soziogramm';
    const theme = this._theme();

    this._figurenNodes.update(figuren.filter(f => existingIds.has(f.id)).map(f => {
      if (!ch || activeIds.has(f.id)) {
        const color = soziogrammModus ? this._schichtNodeColor(f.sozialschicht) : this._figTypColor(f.typ);
        const font = soziogrammModus ? this._schichtNodeFont(f.sozialschicht) : this._nodeFont();
        return { id: f.id, color, font };
      }
      return {
        id: f.id,
        color: { background: theme.dim.background, border: theme.dim.border,
                 highlight: { background: theme.dim.background, border: theme.dim.border } },
        font: { ...DEFAULT_FONT, color: theme.dim.font },
      };
    }));

    this._figurenEdges.update(this._figurenEdges.get().map(e => {
      if (!ch || activeIds.has(e.from) || activeIds.has(e.to)) {
        if (soziogrammModus) {
          const color = theme.ink(BZ_SOZIO_COLOR[BZ_SOZIO_CAT[e.typ] || 'sozial']);
          return { id: e.id, color: { color, highlight: color } };
        }
        const s = BZ[e.typ] || BZ.andere;
        return { id: e.id, color: { color: theme.ink(s.color), highlight: theme.ink(s.highlight) } };
      }
      return { id: e.id, color: { color: theme.dim.edge, highlight: theme.dim.edge } };
    }));
  },

  // Sozialschicht-Node (Soziogramm): Fläche/Border für den Grund nachgeführt.
  // Eigene Font-Wahl der Schicht (weisser Text auf dem dunklen Unterwelt-Band)
  // gewinnt vor der Theme-Textfarbe.
  _schichtNodeColor(schicht) {
    return adaptNodeColor(SCHICHT_COLOR[schicht] || SCHICHT_COLOR.andere, this._theme());
  },
  _schichtNodeFont(schicht) {
    const style = SCHICHT_COLOR[schicht] || SCHICHT_COLOR.andere;
    return style.font || this._nodeFont();
  },

  _buildEdges(soziogrammModus) {
    const figuren = this._graphFiguren();
    const theme = this._theme();
    // id→Figur einmal indizieren (String-Keys: bz.figur_id und f.id sind beide der
    // TEXT-fig_id, die Normalisierung deckt Alt-Daten mit Zahl-IDs mit ab).
    const byId = new Map(figuren.map(f => [String(f.id), f]));
    const edgeList = [];
    const addedPairs = new Set();

    for (const f of figuren) {
      for (const bz of (f.beziehungen || [])) {
        const targetFigur = byId.get(String(bz.figur_id));
        if (!targetFigur) continue;
        const toId = targetFigur.id;

        const dedupeKey = DIRECTED_TYPES.includes(bz.typ)
          ? [f.id, toId, bz.typ].join('|')
          : [[f.id, toId].sort().join('-'), bz.typ].join('|');
        if (addedPairs.has(dedupeKey)) continue;
        addedPairs.add(dedupeKey);

        if (soziogrammModus) {
          const cat    = BZ_SOZIO_CAT[bz.typ] || 'sozial';
          const color  = theme.ink(BZ_SOZIO_COLOR[cat]);
          const macht  = bz.machtverhaltnis ?? 0;
          const width  = 1 + Math.abs(macht) * 1.5;
          let arrows = '';
          if (macht > 0)       arrows = 'to';
          else if (macht < 0)  arrows = 'from';
          else if (DIRECTED_TYPES.includes(bz.typ)) arrows = BZ[bz.typ]?.arrows || '';

          edgeList.push({
            from: f.id, to: toId,
            label: '',
            typ: bz.typ,
            beschreibung: bz.beschreibung || '',
            color: { color, highlight: color },
            arrows,
            dashes: false,
            width,
          });
        } else {
          const s = BZ[bz.typ] || BZ.andere;
          edgeList.push({
            from: f.id, to: toId,
            label: '',
            typ: bz.typ,
            beschreibung: bz.beschreibung || '',
            color: { color: theme.ink(s.color), highlight: theme.ink(s.highlight) },
            arrows: s.arrows,
            dashes: s.dashes,
          });
        }
      }
    }
    return { edgeList };
  },

  // Tooltip: HTML aus escHtml()-Atomen — XSS-Escape-Invariante eingehalten.
  // Positionierung/Klemmung liegt im geteilten Graph-Kit.
  _attachTooltip(container) {
    const tip = document.getElementById('figur-tooltip');
    if (!tip) return;
    // id→Figur einmal pro Render indizieren (Hover-Handler statt O(F)-find).
    const byId = new Map(this._graphFiguren().map(f => [f.id, f]));
    const { show: showTipAt, hide: hideTip } = createGraphTooltip(container, tip);

    this._figurenNetwork.on('hoverNode', ({ node, event }) => {
      const f = byId.get(node);
      if (!f) return;
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
      const fromF = byId.get(e.from);
      const toF   = byId.get(e.to);
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
    // Beim Ziehen wegblenden — der Tooltip klebte sonst über der Zugbahn.
    this._figurenNetwork.on('dragStart', hideTip);
  },
};
