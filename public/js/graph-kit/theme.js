// Canvas-Farben für die vis-network-Graphen (Figuren-Graph + Motiv-Konstellation).
// vis-network zeichnet auf ein <canvas> — dort werden CSS-Custom-Properties NICHT
// aufgelöst. Jede Farbe, die auf dem Canvas landet, muss darum zur Render-Zeit als
// konkreter Wert vorliegen. Genau daran driftete der Figuren-Graph: seine
// Chrome-Farben (Spaltenstreifen, Kopfzeilen, Pills, abgeblendete Knoten) waren
// für weissen Grund verdrahtet, während der Container `--color-bg` trägt — im
// Dark-Mode also dunkel.
//
// SSoT: kein Graph-Modul hält eigene Hintergrund-/Chrome-/Dim-Farben. Die
// Datenpaletten (Figurentyp, Sozialschicht, Beziehungstyp) bleiben in ihren
// Modulen — sie sind fachliche Zuordnung, nicht Chrome — und werden hier nur für
// den dunklen Grund nachgeführt (`adaptNodeColor` / `readable`).

// ── Farb-Arithmetik (pure) ───────────────────────────────────────────────────

// '#abc' | '#aabbcc' | 'rgb(…)' | 'rgba(…)' → [r,g,b] (oder null).
export function parseColor(str) {
  if (typeof str !== 'string') return null;
  const s = str.trim();
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    if (hex.length === 3) return [0, 1, 2].map(i => parseInt(hex[i] + hex[i], 16));
    if (hex.length >= 6) return [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
    return null;
  }
  const m = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (!m) return null;
  const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some(n => !Number.isFinite(n))) return null;
  return parts.slice(0, 3);
}

export function mix(a, b, t) {
  const k = Math.max(0, Math.min(1, t));
  return [0, 1, 2].map(i => Math.round(a[i] + (b[i] - a[i]) * k));
}

export function rgba(rgb, alpha) {
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
}

export function toCss(rgb) {
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

// Wahrgenommene Helligkeit (WCAG-Relativluminanz, 0 = schwarz, 1 = weiss).
export function luminance(rgb) {
  const [r, g, b] = rgb.map(v => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];

// Eine für hellen Grund gewählte Akzentfarbe so weit aufhellen, dass sie auf
// dunklem Grund lesbar bleibt. Im Light-Mode unverändert — die Paletten sind
// dafür gebaut und sollen sich nicht verschieben.
export function readable(color, dark) {
  if (!dark) return color;
  const rgb = parseColor(color);
  if (!rgb) return color;
  const l = luminance(rgb);
  if (l >= 0.45) return color;
  return toCss(mix(rgb, WHITE, Math.min(0.7, (0.45 - l) * 1.4)));
}

// Node-Farbspezifikation für den dunklen Grund nachführen: die pastellige Füllung
// wird gegen die Oberfläche abgemischt (dunkle, getönte Fläche), die gesättigte
// Border bleibt der Erkennungsanker. Rückgabe ist immer auf die drei von vis
// gelesenen Schlüssel normalisiert — die Paletten führen daneben noch Werte für
// Bänder und Labels, die im color-Objekt nichts verloren haben.
export function adaptNodeColor(spec, theme) {
  if (!spec) return spec;
  if (!theme.dark) {
    return { background: spec.background, border: spec.border, highlight: spec.highlight };
  }
  const surf = theme.surfaceRgb;
  const fill = parseColor(spec.background);
  const bg = fill ? toCss(mix(fill, surf, 0.80)) : spec.background;
  const hiSrc = parseColor(spec.highlight?.background) || fill;
  const hi = hiSrc ? toCss(mix(hiSrc, surf, 0.62)) : spec.highlight?.background;
  return {
    background: bg,
    border: readable(spec.border, true),
    highlight: {
      background: hi,
      border: readable(spec.highlight?.border || spec.border, true),
    },
  };
}

// ── Theme-Auflösung ──────────────────────────────────────────────────────────

// `data-theme` setzt [theme-init.js](../theme-init.js) vor dem ersten Paint immer
// auf 'light'|'dark'. Der matchMedia-Zweig ist nur der Notnagel, falls das Attribut
// fehlt (z.B. Test-Harness ohne Bootstrap).
export function isDarkTheme() {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'dark') return true;
  if (attr === 'light') return false;
  return !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
}

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

// Konkrete Canvas-Farben für einen Graph-Container. Einmal pro Render aufrufen und
// am Karten-State halten (`this._graphTheme`) — spätere Handler (Kapitel-Filter,
// Overlays) lesen dieselbe Auflösung, statt neu zu messen.
export function graphTheme(container) {
  const dark = isDarkTheme();
  const cs = container ? getComputedStyle(container) : null;
  const text = cs?.color || cssVar('--color-text', dark ? '#e8e8e8' : '#333');
  const muted = cssVar('--color-muted', text);
  const surface = cssVar('--color-surface', dark ? '#1f2023' : '#ffffff');
  const bg = cs?.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)'
    ? cs.backgroundColor
    : cssVar('--color-bg', surface);
  const surfaceRgb = parseColor(surface) || (dark ? [31, 32, 35] : WHITE);
  const ink = dark ? WHITE : BLACK;
  const textRgb = parseColor(text) || (dark ? WHITE : [51, 51, 51]);

  const inkCache = new Map();
  return {
    dark,
    text, muted, surface, bg, surfaceRgb,
    // Chrome des Figurengraphen
    stripe:   rgba(ink, dark ? 0.05 : 0.028),   // alternierende Kapitel-Spalte
    gridLine: rgba(ink, dark ? 0.10 : 0.06),    // Spalten-Trennlinie
    trackBg:  rgba(ink, dark ? 0.14 : 0.07),    // Presence-Bar-Untergrund
    pillBg:   rgba(surfaceRgb, dark ? 0.82 : 0.88), // Pill hinter Tier-/Schicht-Label
    bandLine: rgba(ink, dark ? 0.12 : 0.07),    // Schicht-Trennlinie im Soziogramm
    // Abgeblendeter Zustand (Kapitel-Filter)
    dim: {
      background: toCss(mix(surfaceRgb, ink, 0.06)),
      border:     toCss(mix(surfaceRgb, ink, 0.20)),
      font:       toCss(mix(textRgb, surfaceRgb, 0.55)),
      edge:       toCss(mix(surfaceRgb, ink, 0.13)),
    },
    // Akzentfarbe lesbar machen (memoized — läuft pro Kante/Label im Draw-Pfad).
    ink(color) {
      if (!dark) return color;
      if (!inkCache.has(color)) inkCache.set(color, readable(color, true));
      return inkCache.get(color);
    },
  };
}

// Theme-Wechsel beobachten. Canvas-Inhalte reagieren nicht von selbst auf einen
// `data-theme`-Wechsel — jeder Graph muss neu zeichnen. Rückgabe ist der Observer;
// der Aufrufer trennt ihn in destroy().
export function observeThemeChange(onChange) {
  const obs = new MutationObserver(onChange);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return obs;
}

// Die vom Autor wählbaren Palette-Tokens (`--palette-*`) als konkrete Werte.
// Nutzt die Motiv-Konstellation für Themen-/Motivfarben.
export function paletteColors(keys) {
  const root = getComputedStyle(document.documentElement);
  const out = {};
  for (const k of keys) out[k] = root.getPropertyValue(`--palette-${k}`).trim();
  return out;
}
