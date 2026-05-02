// Single Source of Truth für die 12 Hauptkarten-Features. Wird von Quick-Pills,
// Command-Palette und Tracking-Hook gelesen. Keys sind synchron mit der
// Allowlist in routes/usage.js — bei Erweiterung beide Stellen anpassen.
//
// `flag`   – Name des Show-State-Flags am Root.
// `toggle` – Methodenname am Root, der die Karte ein-/ausschaltet.
// `requiresPages` – Pill/Palette-Item disabled, wenn Buch leer.
// `requiresBook`  – Pill/Palette-Item disabled, wenn kein Buch gewählt.

export const FEATURES = [
  // Bewertung
  { key: 'review',         group: 'review', labelKey: 'tile.review',         descKey: 'tile.review.desc',         flag: 'showBookReviewCard',     toggle: 'toggleBookReviewCard',     requiresBook: true },
  { key: 'stil',           group: 'review', labelKey: 'tile.stil',           descKey: 'tile.stil.desc',           flag: 'showStilCard',           toggle: 'toggleStilCard',           requiresBook: true },
  { key: 'fehlerHeatmap',  group: 'review', labelKey: 'tile.fehlerHeatmap',  descKey: 'tile.fehlerHeatmap.desc',  flag: 'showFehlerHeatmapCard',  toggle: 'toggleFehlerHeatmapCard',  requiresBook: true },
  { key: 'kontinuitaet',   group: 'review', labelKey: 'tile.kontinuitaet',   descKey: 'tile.kontinuitaet.desc',   flag: 'showKontinuitaetCard',   toggle: 'toggleKontinuitaetCard',   requiresBook: true },
  // Welt & Plot
  { key: 'figuren',        group: 'world',  labelKey: 'tile.figuren',        descKey: 'tile.figuren.desc',        flag: 'showFiguresCard',        toggle: 'toggleFiguresCard',        requiresBook: true },
  { key: 'szenen',         group: 'world',  labelKey: 'tile.szenen',         descKey: 'tile.szenen.desc',         flag: 'showSzenenCard',         toggle: 'toggleSzenenCard',         requiresBook: true },
  { key: 'orte',           group: 'world',  labelKey: 'tile.orte',           descKey: 'tile.orte.desc',           flag: 'showOrteCard',           toggle: 'toggleOrteCard',           requiresBook: true },
  { key: 'ereignisse',     group: 'world',  labelKey: 'tile.events',         descKey: 'tile.events.desc',         flag: 'showEreignisseCard',     toggle: 'toggleEreignisseCard',     requiresBook: true },
  // Werkzeug
  { key: 'bookchat',       group: 'tools',  labelKey: 'tile.bookchat',       descKey: 'tile.bookchat.desc',       flag: 'showBookChatCard',       toggle: 'toggleBookChatCard',       requiresPages: true },
  { key: 'stats',          group: 'tools',  labelKey: 'tile.stats',          descKey: 'tile.stats.desc',          flag: 'showBookStatsCard',      toggle: 'toggleBookStatsCard',      requiresBook: true },
  { key: 'bookSettings',   group: 'tools',  labelKey: 'tile.bookSettings',   descKey: 'tile.bookSettings.desc',   flag: 'showBookSettingsCard',   toggle: 'toggleBookSettingsCard',   requiresBook: true },
  { key: 'finetuneExport', group: 'tools',  labelKey: 'tile.finetuneExport', descKey: 'tile.finetuneExport.desc', flag: 'showFinetuneExportCard', toggle: 'toggleFinetuneExportCard', requiresBook: true },
];

export const FEATURE_GROUPS = ['review', 'world', 'tools'];

export const GROUP_LABEL_KEY = {
  review: 'tile.group.review',
  world:  'tile.group.world',
  tools:  'tile.group.tools',
};

const BY_KEY = new Map(FEATURES.map(f => [f.key, f]));

export function featureByKey(key) {
  return BY_KEY.get(key) || null;
}

// Default-Set für neuen User ohne Tracking-Daten.
export const DEFAULT_RECENT_KEYS = ['review', 'figuren', 'bookchat'];

export function isFeatureAvailable(feature, ctx) {
  if (!feature) return false;
  if (feature.requiresBook && !ctx.selectedBookId) return false;
  if (feature.requiresPages && !(ctx.pages && ctx.pages.length > 0)) return false;
  return true;
}
