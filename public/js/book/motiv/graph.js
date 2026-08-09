// Motiv-Werkstatt — Konstellations-Graph (vis-network, lazy). Themen sind Cluster-
// Anker, Motive die Naben (Grösse = Ist-Dichte aus motif_occurrences; „geplant aber
// fehlt" = Geist-Knoten). Kanten: Thema→Motiv, Motiv↔Motiv (Beziehungstyp) und
// optionale Soll-Layer (Figuren/Beats/Kapitel). Eigene Netzwerk-Instanz — teilt
// keinen State mit dem Figuren-Graph.

import { sendJson, escHtml } from '../../utils.js';
import { toggleWrapFullscreen } from '../../fullscreen.js';
import { ensureVis, graphPlaceholder, createGraphTooltip, graphTheme, paletteColors } from '../../graph-kit.js';

// Themen-Palette: primär die vom Autor gewählte Farbe (themes.farbe = Palette-
// Schlüssel, theme-aware --palette-*-Tokens wie in der Plot-Werkstatt); ohne Wahl
// deterministisch nach Index in dieselbe Palette. Motive erben die Farbe ihres
// Themas. Graph (Canvas) und Swatch-Leiste teilen defaultThemeColorKey als SSoT,
// damit die Farben nie auseinanderdriften.
export const THEME_COLOR_KEYS = ['blue', 'green', 'amber', 'orange', 'red', 'wine', 'pink', 'purple', 'brown', 'gray'];
const NEUTRAL = '#8a8f98';
const LAYER = { figure: '#0891b2', beat: '#7c3a48', chapter: '#65758b' };

// Auto-Farbe (Palette-Schlüssel) für ein Thema am gegebenen Listen-Index.
export function defaultThemeColorKey(ix) {
  return THEME_COLOR_KEYS[((ix % THEME_COLOR_KEYS.length) + THEME_COLOR_KEYS.length) % THEME_COLOR_KEYS.length];
}

// Knoten-ID-Namespace: jeder Graph-Knoten trägt ein Typ-Präfix vor der DB-ID
// (t=Thema, m=Motiv, f=Figur, df=Werkstatt-Figur, b=Beat, c=Kapitel). Encode/Decode
// als SSoT, damit die Konvention nicht über Render/Click/Hover/Kontextmenü verstreut
// re-implementiert wird — ein neuer Layer-Typ wird nur hier eingetragen.
const NODE_PREFIX = { theme: 't', motif: 'm', figure: 'f', draftFigure: 'df', beat: 'b', chapter: 'c' };
export function nodeId(kind, id) { return `${NODE_PREFIX[kind]}${id}`; }
// Rohe Knoten-ID → { kind, id } oder null. `df` vor den Einzelbuchstaben matchen.
export function parseNode(id) {
  const m = /^(df|[tmfbc])(\d+)$/.exec(id || '');
  if (!m) return null;
  const kind = Object.keys(NODE_PREFIX).find(k => NODE_PREFIX[k] === m[1]);
  return { kind, id: Number(m[2]) };
}

// Knotengrösse der Motiv-Naben — reine Skala, ohne DOM und ohne Karten-State.
// Zwei Dimensionen fliessen ein, nicht bloss die Fundstellen-Zahl:
//   1. Ist-Dichte  — Anzahl Fundstellen, √-gedämpft und gegen die reale Spanne
//      des Datensatzes auf [0,1] normalisiert (Ausreisser dämpfen).
//   2. Übereinstimmung — mittlere Konfidenz der Fundstellen (score, 0..1; wörtliche
//      Trigger-Treffer = 100%). Absolut interpretiert, nicht gegen die Spanne
//      normalisiert — ein 95%-Motiv soll gross sein, egal wie die anderen liegen.
// Blend: gewichtete Summe (Dichte dominiert, Qualität moduliert). Ein oft-aber-
// schwach gefundenes Motiv bleibt so kleiner als ein etwas seltener, aber sehr
// treffsicher belegtes. Geist-Knoten (0 Treffer) bleiben fix klein.
export const MOTIF_SIZE_MIN = 14, MOTIF_SIZE_MAX = 46, MOTIF_SIZE_GHOST = 10;
const COUNT_WEIGHT = 0.6, QUALITY_WEIGHT = 0.4;

// counts = Fundstellen-Zahlen der NICHT-Geist-Motive (die Spanne des Datensatzes).
export function makeMotifSize(counts) {
  const min = counts.length ? Math.min(...counts) : 0;
  const max = counts.length ? Math.max(...counts) : 0;
  return ({ ghost, count = 0, score = 0 }) => {
    if (ghost) return MOTIF_SIZE_GHOST;
    const density = max === min
      ? 0.5
      : (Math.sqrt(count) - Math.sqrt(min)) / (Math.sqrt(max) - Math.sqrt(min));
    const quality = Math.max(0, Math.min(1, score));
    const blend = COUNT_WEIGHT * density + QUALITY_WEIGHT * quality;
    return MOTIF_SIZE_MIN + blend * (MOTIF_SIZE_MAX - MOTIF_SIZE_MIN);
  };
}

// paletteVars: Palette-Schlüssel → konkreter Farbwert (vis-network zeichnet auf
// Canvas, CSS-Custom-Props werden dort NICHT aufgelöst → zur Render-Zeit gelesen).
function _themeColor(themeId, themes, paletteVars) {
  const ix = themes.findIndex(t => t.id === themeId);
  if (ix < 0) return NEUTRAL;
  const key = themes[ix].farbe || defaultThemeColorKey(ix);
  return (paletteVars && paletteVars[key]) || paletteVars[defaultThemeColorKey(ix)] || NEUTRAL;
}

export const graphMethods = {
  _graphSignature() {
    const m = this.motifs.map(x =>
      `${x.id}:${x.name || ''}:${x.theme_id || 0}:${x.occurrenceCount || 0}:${(x.occAvgScore || 0).toFixed(3)}:${(x.figures || []).length}:${(x.draftFigures || []).length}:${(x.beats || []).length}:${(x.chapters || []).length}`
    ).join('|');
    const r = this.relations.map(x => `${x.from_motif_id}-${x.to_motif_id}:${x.typ}`).join('|');
    const t = this.themes.map(x => `${x.id}:${x.name || ''}:${x.farbe || ''}`).join(',');
    const layers = `${this.layerFigures}${this.layerBeats}${this.layerChapters}`;
    // Theme im Schlüssel: die Farben liegen im gezeichneten Canvas-Bild, ein
    // blosser CSS-Wechsel erreicht sie nicht.
    const theme = this._graphTheme?.dark ? 'dark' : 'light';
    return [m, r, t, layers, this.$store.shell?.uiLocale, theme].join('##');
  },

  async renderMotivGraph() {
    const container = document.getElementById('motiv-graph');
    if (!container) return;

    if (!await ensureVis(container)) return;

    // vis-network zeichnet auf Canvas → CSS-Custom-Properties werden NICHT
    // aufgelöst. Konkrete Farben zur Render-Zeit auflösen (geteilt mit dem
    // Figuren-Graph), bevor die Signatur gebaut wird — das Theme steckt darin.
    this._graphTheme = graphTheme(container);
    const textColor = this._graphTheme.text;
    const bgColor = this._graphTheme.bg;
    const mutedColor = this._graphTheme.muted;

    const sig = this._graphSignature();
    if (this._motivNetwork && this._motivHash === sig) return;
    this._motivHash = sig;
    this._destroyGraph();

    if (!this.motifs.length && !this.themes.length) {
      graphPlaceholder(container, window.__app.t('motiv.empty.graph'));
      return;
    }
    container.replaceChildren();

    // Gewählte Themen-Farben (Palette-Schlüssel → konkreter Wert) aus den
    // --palette-*-Tokens auflösen (theme-aware).
    const paletteVars = paletteColors(THEME_COLOR_KEYS);

    const nodes = [];
    const edges = [];

    // Themen-Anker. shape:'circle' rendert das Label INNERHALB der farbigen
    // Blase (wächst mit dem Text) — dafür ist die weisse Schrift gedacht.
    for (const t of this.themes) {
      const tc = _themeColor(t.id, this.themes, paletteVars);
      nodes.push({
        id: nodeId('theme', t.id), label: t.name, shape: 'circle', margin: 10, widthConstraint: { maximum: 140 },
        // highlight/hover explizit auf die Thema-Farbe: sonst kippt vis-network die
        // Blase bei Selektion/Hover auf seine hellblaue Default-Farbe → weisse
        // Schrift wird unlesbar. Selektion signalisiert stattdessen borderWidthSelected.
        color: { background: tc, border: tc, highlight: { background: tc, border: tc }, hover: { background: tc, border: tc } },
        font: { color: '#fff', size: 14 },
      });
    }

    // Knotengrösse = Ist-Präsenz (Skala unten, rein berechnet).
    const motifSize = makeMotifSize(
      this.motifs.filter(m => !this.isGhost(m)).map(m => m.occurrenceCount || 0)
    );
    const _motifSize = (m) => motifSize({
      ghost: this.isGhost(m),
      count: m.occurrenceCount || 0,
      score: m.occAvgScore || 0,
    });
    const figCatalog = this.$store.catalog.figuren || [];
    // Layer-Knoten (Figur/Beat/Kapitel) können von mehreren Motiven geteilt werden →
    // ID-Set gegen Doppel-Push (statt O(n²)-`nodes.some` je Layer-Eintrag).
    const layerSeen = new Set();
    for (const m of this.motifs) {
      const col = _themeColor(m.theme_id, this.themes, paletteVars);
      const ghost = this.isGhost(m);
      const size = _motifSize(m);
      // highlight/hover explizit auf die Motiv-Farbe (wie bei den Thema-Knoten):
      // sonst kippt vis-network den Punkt bei Selektion/Hover auf seine hellblaue
      // Default-Farbe (Klick selektiert via _highlightNode) und die Thema-Farbe geht
      // verloren — Geist-Knoten würden dabei sogar solide gefüllt. Selektion
      // signalisiert stattdessen borderWidthSelected.
      const mBg = ghost ? 'rgba(0,0,0,0)' : col;
      const mid = nodeId('motif', m.id);
      nodes.push({
        id: mid, label: m.name, shape: 'dot', size,
        color: {
          background: mBg, border: col,
          highlight: { background: mBg, border: col },
          hover: { background: mBg, border: col },
        },
        borderWidth: ghost ? 2 : 1,
        shapeProperties: ghost ? { borderDashes: [4, 4] } : { borderDashes: false },
        font: { color: textColor, size: 13 },
      });
      if (m.theme_id) {
        edges.push({ from: nodeId('theme', m.theme_id), to: mid, dashes: true, color: { color: col, opacity: 0.5 }, width: 1 });
      }

      // Soll-Layer (optional zuschaltbar).
      if (this.layerFigures) {
        for (const f of (m.figures || [])) {
          const nid = nodeId('figure', f.figId);
          if (!layerSeen.has(nid)) {
            layerSeen.add(nid);
            const cat = figCatalog.find(x => String(x.id) === String(f.figId));
            nodes.push({ id: nid, label: (cat?.name || f.name || '?'), shape: 'diamond', size: 9, color: LAYER.figure, font: { color: mutedColor, size: 11 } });
          }
          edges.push({ from: mid, to: nid, dashes: [2, 3], color: { color: LAYER.figure, opacity: 0.6 }, width: 1 });
        }
        // Werkstatt-Figuren (draft_figures) — gleiche Ebene, eigener Knoten-Namespace.
        for (const f of (m.draftFigures || [])) {
          const nid = nodeId('draftFigure', f.id);
          if (!layerSeen.has(nid)) {
            layerSeen.add(nid);
            nodes.push({ id: nid, label: (f.name || '?'), shape: 'diamond', size: 9, color: LAYER.figure, font: { color: mutedColor, size: 11 } });
          }
          edges.push({ from: mid, to: nid, dashes: [2, 3], color: { color: LAYER.figure, opacity: 0.6 }, width: 1 });
        }
      }
      if (this.layerBeats) {
        for (const b of (m.beats || [])) {
          const nid = nodeId('beat', b.id);
          if (!layerSeen.has(nid)) { layerSeen.add(nid); nodes.push({ id: nid, label: b.titel || '?', shape: 'square', size: 9, color: LAYER.beat, font: { color: mutedColor, size: 11 } }); }
          edges.push({ from: mid, to: nid, dashes: [2, 3], color: { color: LAYER.beat, opacity: 0.6 }, width: 1 });
        }
      }
      if (this.layerChapters) {
        for (const c of (m.chapters || [])) {
          const nid = nodeId('chapter', c.id);
          if (!layerSeen.has(nid)) { layerSeen.add(nid); nodes.push({ id: nid, label: c.name || '?', shape: 'triangle', size: 9, color: LAYER.chapter, font: { color: mutedColor, size: 11 } }); }
          edges.push({ from: mid, to: nid, dashes: [2, 3], color: { color: LAYER.chapter, opacity: 0.6 }, width: 1 });
        }
      }
    }

    // Motiv ↔ Motiv (Beziehungstyp als Kantenlabel). Kanten laufen den direktesten
    // (geraden) Weg und folgen beim Ziehen sofort der neuen Knotenposition —
    // `smooth: false` statt der Default-`dynamic`-Kurve, die mit einem verzögerten
    // Stützknoten ausbeult. Nur wenn zwischen demselben Motiv-Paar mehrere Kanten
    // liegen (z. B. Hin- + Rückbeziehung), biegen wir sie leicht auf getrennte
    // Seiten, damit sie sich nicht überdecken.
    const pairCount = {};
    for (const r of this.relations) {
      const key = [r.from_motif_id, r.to_motif_id].sort((a, b) => a - b).join('-');
      pairCount[key] = (pairCount[key] || 0) + 1;
    }
    for (const r of this.relations) {
      const key = [r.from_motif_id, r.to_motif_id].sort((a, b) => a - b).join('-');
      const parallel = pairCount[key] > 1;
      // Bei Parallelkanten die Ausweich-Seite deterministisch aus der Knoten-
      // Reihenfolge ableiten, damit Hin- und Rückkante gegenläufig ausweichen.
      const cw = r.from_motif_id < r.to_motif_id;
      edges.push({
        from: nodeId('motif', r.from_motif_id), to: nodeId('motif', r.to_motif_id), label: r.typ,
        arrows: 'to', color: { color: '#b45309' }, width: 2,
        font: { size: 11, color: mutedColor, strokeWidth: 3, strokeColor: bgColor },
        smooth: parallel ? { type: cw ? 'curvedCW' : 'curvedCCW', roundness: 0.2 } : false,
      });
    }

    // Persistierte Anordnung anwenden: Knoten mit gespeicherter Position starten dort
    // und werden während der Stabilisierung fixiert (Physik ordnet nur die neuen/noch
    // unplatzierten Knoten drumherum). Sind alle Knoten platziert → Physik gar nicht
    // erst starten. Nach Stabilisierung werden die Pins gelöst (Ziehen bleibt frei).
    const saved = this._savedPositions || {};
    for (const n of nodes) {
      const p = saved[n.id];
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) { n.x = p.x; n.y = p.y; n.fixed = true; }
    }
    const allPlaced = nodes.length > 0 && nodes.every(n => n.fixed);

    this._motivNodes = new window.vis.DataSet(nodes);
    this._motivEdges = new window.vis.DataSet(edges);
    this._motivNetwork = new window.vis.Network(container, { nodes: this._motivNodes, edges: this._motivEdges }, {
      physics: { enabled: !allPlaced, barnesHut: { gravitationalConstant: -6000, springLength: 130, springConstant: 0.04, damping: 0.5 }, stabilization: { iterations: 180 } },
      interaction: { dragNodes: true, hover: true, tooltipDelay: 100 },
      nodes: { borderWidthSelected: 3 },
      // Kanten den direktesten (geraden) Weg nehmen lassen — die Default-`dynamic`-
      // Glättung hängt einen verzögerten Stützknoten an, der beim Ziehen ausbeult.
      // Motiv↔Motiv-Parallelkanten überschreiben das per-Kante mit einer leichten Kurve.
      edges: { selectionWidth: 1, smooth: false },
    });

    this._motivNetwork.on('click', (params) => {
      const ref = parseNode(params.nodes?.[0]);
      this.closeGraphMenu();
      if (ref?.kind === 'motif') this.selectMotif(ref.id);
      else if (ref?.kind === 'theme') this.selectTheme(ref.id);
    });
    // Rechtsklick auf einen Knoten (oder die leere Fläche) öffnet das Kontextmenü —
    // Thema-Knoten → Motiv anlegen, Motiv-Knoten → bearbeiten/anlegen/löschen.
    this._motivNetwork.on('oncontext', (params) => {
      params.event.preventDefault();
      const nid = this._motivNetwork?.getNodeAt(params.pointer.DOM);
      this.openGraphMenu(params.event, nid);
    });
    // Nach dem Ziehen eines Knotens die Anordnung persistieren (debounced).
    this._motivNetwork.on('dragEnd', (params) => {
      if (params.nodes?.length) this._scheduleLayoutSave();
    });
    // Hover-Tooltip (Detail-Karte am Knoten, wie im Figuren-Graph).
    this._attachMotivTooltip(container);

    // Nach der Stabilisierung Physik einfrieren (ruhiges Bild, weiter zieh-/zoombar)
    // und die Start-Pins der gespeicherten Knoten lösen. Sind alle Knoten bereits
    // platziert, lief keine Stabilisierung → direkt nachziehen.
    const afterStable = () => {
      this._motivNetwork?.setOptions({ physics: { enabled: false } });
      const release = nodes.filter(n => n.fixed).map(n => ({ id: n.id, fixed: false }));
      if (release.length) this._motivNodes?.update(release);
      if (this.selectedMotifId) this._highlightNode(this.selectedMotifId);
    };
    if (allPlaced) afterStable();
    else this._motivNetwork.once('stabilizationIterationsDone', afterStable);
  },

  // Knoten-Positionen debounced speichern (mehrere Drags koaleszieren).
  _scheduleLayoutSave() {
    clearTimeout(this._layoutSaveTimer);
    this._layoutSaveTimer = setTimeout(() => this._saveLayout(), 500);
  },

  async _saveLayout() {
    if (!this._motivNetwork) return;
    const bookId = this.$store.nav.selectedBookId;
    if (!bookId) return;
    const positions = this._motivNetwork.getPositions();
    this._savedPositions = positions; // lokal spiegeln, damit Re-Render die Anordnung hält
    try {
      await sendJson('/motifs/layout', 'PUT', { book_id: bookId, positions });
    } catch (e) { /* Layout ist reine Ansicht — Fehler nicht hart melden */ }
  },

  _highlightNode(motifId) {
    if (!this._motivNetwork) return;
    try { this._motivNetwork.selectNodes([nodeId('motif', motifId)]); } catch (_) { /* Knoten evtl. (noch) nicht da */ }
  },

  // Detail-Tooltip beim Hovern über einen Knoten (Motiv bzw. Thema), analog zum
  // Figuren-Graph. HTML ausschliesslich aus escHtml()-Atomen — XSS-Escape-Invariante.
  _attachMotivTooltip(container) {
    const tip = document.getElementById('motiv-tooltip');
    if (!tip) return;
    const t = (k, p) => window.__app.t(k, p);
    const { show: showTipAt, hide: hideTip } = createGraphTooltip(container, tip);

    const motifTipHtml = (m) => {
      const theme = m.theme_id ? this.themeById(m.theme_id) : null;
      const themeLabel = theme ? theme.name : t('motiv.noTheme');
      const ghost = this.isGhost(m);
      const occ = m.occurrenceCount || 0;
      const links = (m.figures?.length || 0) + (m.draftFigures?.length || 0)
        + (m.beats?.length || 0) + (m.chapters?.length || 0) + (m.pages?.length || 0);
      const stats = [];
      if (ghost) {
        stats.push(`<span class="motiv-tip-ghost">${escHtml(t('motiv.tip.ghost'))}</span>`);
      } else if (occ > 0) {
        let line = escHtml(t('motiv.tip.occurrences', { n: occ }));
        if (m.occAvgScore) line += ' · ' + escHtml(t('motiv.tip.confidence', { pct: Math.round(m.occAvgScore * 100) }));
        stats.push(line);
      } else {
        stats.push(escHtml(t('motiv.tip.noOccurrences')));
      }
      if (links > 0) stats.push(escHtml(t('motiv.tip.links', { n: links })));
      return `<strong>${escHtml(m.name)}</strong>`
        + `<em>${escHtml(themeLabel)}</em>`
        + (m.beschreibung ? `<p>${escHtml(m.beschreibung)}</p>` : '')
        + `<div class="motiv-tip-stats">${stats.join('<br>')}</div>`;
    };

    const themeTipHtml = (th) => {
      const count = this.motifs.filter(m => m.theme_id === th.id).length;
      return `<strong>${escHtml(th.name)}</strong>`
        + `<em>${escHtml(t('motiv.tip.themeMotifs', { n: count }))}</em>`
        + (th.beschreibung ? `<p>${escHtml(th.beschreibung)}</p>` : '');
    };

    this._motivNetwork.on('hoverNode', ({ node, event }) => {
      const ref = parseNode(node);
      if (!ref) return;
      let html = '';
      if (ref.kind === 'motif') { const m = this.motifById(ref.id); if (m) html = motifTipHtml(m); }
      else if (ref.kind === 'theme') { const th = this.themeById(ref.id); if (th) html = themeTipHtml(th); }
      if (!html) return;
      showTipAt(html, event.clientX, event.clientY);
    });
    this._motivNetwork.on('blurNode', hideTip);
    this._motivNetwork.on('dragStart', hideTip);
  },

  _destroyGraph() {
    document.getElementById('motiv-tooltip')?.classList.remove('visible');
    if (this._motivNetwork) { this._motivNetwork.destroy(); this._motivNetwork = null; }
    this._motivNodes = null;
    this._motivEdges = null;
  },

  toggleLayer(kind) {
    if (kind === 'figures') this.layerFigures = !this.layerFigures;
    else if (kind === 'beats') this.layerBeats = !this.layerBeats;
    else if (kind === 'chapters') this.layerChapters = !this.layerChapters;
    this.$nextTick(() => this.renderMotivGraph());
  },

  fitGraph() {
    this._motivNetwork?.fit({ animation: { duration: 400 } });
  },

  // Ganze Motiv-Karte ins Native-Vollbild — mehr Platz für die Konstellation.
  // Status-Sync via fullscreenchange-Listener in motiv-card.js (motivFullscreen),
  // der den Graph auf die neue Containergrösse neu zeichnet.
  async toggleMotivFullscreen() {
    try {
      await toggleWrapFullscreen(this.$root);
    } catch {
      this.errorMessage = window.__app.t('motiv.error.fullscreen');
    }
  },

  // Gespeicherte Anordnung verwerfen → Physik-Layout frisch berechnen. Persistiert
  // das leere Layout sofort (kein ausstehender Drag-Save überschreibt es wieder).
  async resetLayout() {
    clearTimeout(this._layoutSaveTimer);
    this._layoutSaveTimer = null;
    this._savedPositions = {};
    const bookId = this.$store.nav.selectedBookId;
    if (bookId) {
      try {
        await sendJson('/motifs/layout', 'PUT', { book_id: bookId, positions: {} });
      } catch (e) { /* Layout ist reine Ansicht — Fehler nicht hart melden */ }
    }
    this._motivHash = ''; // Signatur-Guard umgehen → Neu-Layout erzwingen
    this.renderMotivGraph();
  },

  // ── Graph-Kontextmenü (Rechtsklick auf Knoten / leere Fläche) ────────────
  // Cursor-verankert: an der Klickposition öffnen, nur an den Viewport-Rand
  // clampen (kein Flip nötig, siehe Harte Regel „Flip-up-Popover").
  openGraphMenu(ev, nodeId) {
    this.graphMenuNodeId = nodeId || null;
    this.graphMenuPos = this._computeGraphMenuPos(ev.clientX, ev.clientY, 220, 180);
    this.graphMenuOpen = true;
    this._attachGraphMenuListeners();
    this.$nextTick(() => {
      const el = this.$refs.graphMenu;
      if (!el) return;
      this.graphMenuPos = this._computeGraphMenuPos(ev.clientX, ev.clientY, el.offsetWidth, el.offsetHeight);
    });
  },

  _computeGraphMenuPos(x, y, pw, ph) {
    const left = Math.max(8, Math.min(window.innerWidth - pw - 8, x));
    const top = Math.max(8, Math.min(window.innerHeight - ph - 8, y));
    return { top, left };
  },

  closeGraphMenu() {
    this.graphMenuOpen = false;
    this.graphMenuNodeId = null;
    this._detachGraphMenuListeners();
  },

  _attachGraphMenuListeners() {
    if (this._graphMenuCloseHandler) return;
    this._graphMenuCloseHandler = () => this.closeGraphMenu();
    window.addEventListener('scroll', this._graphMenuCloseHandler, true);
    window.addEventListener('resize', this._graphMenuCloseHandler);
  },

  _detachGraphMenuListeners() {
    if (!this._graphMenuCloseHandler) return;
    window.removeEventListener('scroll', this._graphMenuCloseHandler, true);
    window.removeEventListener('resize', this._graphMenuCloseHandler);
    this._graphMenuCloseHandler = null;
  },

  // Knoten-Typ für den offenen Menü-Kontext: 'theme' | 'motif' | 'canvas' | 'other'.
  graphMenuKind() {
    if (!this.graphMenuNodeId) return 'canvas';
    const kind = parseNode(this.graphMenuNodeId)?.kind;
    return (kind === 'theme' || kind === 'motif') ? kind : 'other';
  },
  graphMenuTheme() {
    const ref = parseNode(this.graphMenuNodeId);
    return ref?.kind === 'theme' ? (this.themes.find(t => t.id === ref.id) || null) : null;
  },
  graphMenuMotif() {
    const ref = parseNode(this.graphMenuNodeId);
    return ref?.kind === 'motif' ? this.motifById(ref.id) : null;
  },
};
