// Facade des Graph-Kits: das, was sich beide vis-network-Graphen teilen
// (Figuren-Graph in [graph/](graph/), Motiv-Konstellation in
// [book/motiv/graph.js](book/motiv/graph.js)) — Bundle-Nachladen mit Platzhalter,
// Hover-Tooltip und die Canvas-Farbauflösung inklusive Dark-Mode.
//
// Kein Graph-State und keine fachliche Palette liegt hier: das Kit weiss nichts
// von Figuren, Motiven oder Beziehungstypen.
export { ensureVis, graphPlaceholder } from './graph-kit/vis-mount.js';
export { createGraphTooltip, clampTipPos } from './graph-kit/tooltip.js';
export {
  graphTheme,
  observeThemeChange,
  paletteColors,
  adaptNodeColor,
  readable,
  isDarkTheme,
  parseColor,
  luminance,
  mix,
  rgba,
  toCss,
} from './graph-kit/theme.js';
