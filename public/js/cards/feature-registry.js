// Single Source of Truth für Karten-Features + globale Aktionen + Provider-Hooks.
// Wird von Quick-Pills, Command-Palette und Tracking-Hook gelesen.
// Karten-Keys synchron mit der Allowlist in routes/usage.js — bei Erweiterung
// beide Stellen anpassen.
//
// Karten (`kind: 'toggle'`): öffnen/schliessen eine Hauptkarte.
//   `flag`   – Name des Show-State-Flags am Root.
//   `toggle` – Methodenname am Root, der die Karte ein-/ausschaltet.
//   `requiresPages` – disabled, wenn Buch leer.
//   `requiresBook`  – disabled, wenn kein Buch gewählt.
//
// Aktionen (`kind: 'action'`): einmalige Befehle (Theme wechseln, Logout …).
//   `run(root)` – wird mit Root als Argument aufgerufen.
//
// `aliases` (optional): zusätzliche Suchbegriffe (Synonyme, EN-Übersetzungen).

export const FEATURES = [
  // Übersicht
  { key: 'overview',       kind: 'toggle', group: 'tools',  labelKey: 'tile.overview',       descKey: 'tile.overview.desc',       flag: 'showBookOverviewCard',   toggle: 'toggleBookOverviewCard',   requiresBook: true,
    aliases: ['uebersicht','overview','dashboard','home','start','startseite','landing'] },
  // Bewertung
  { key: 'review',         kind: 'toggle', group: 'review', labelKey: 'tile.review',         descKey: 'tile.review.desc',         flag: 'showBookReviewCard',     toggle: 'toggleBookReviewCard',     requiresBook: true,
    aliases: ['bewertung','rating','note','stars','sterne','feedback'] },
  { key: 'stil',           kind: 'toggle', group: 'review', labelKey: 'tile.stil',           descKey: 'tile.stil.desc',           flag: 'showStilCard',           toggle: 'toggleStilCard',           requiresBook: true,
    aliases: ['style','heatmap','passiv','fuellwoerter','filler','readability','lesbarkeit','metrik'] },
  { key: 'fehlerHeatmap',  kind: 'toggle', group: 'review', labelKey: 'tile.fehlerHeatmap',  descKey: 'tile.fehlerHeatmap.desc',  flag: 'showFehlerHeatmapCard',  toggle: 'toggleFehlerHeatmapCard',  requiresBook: true,
    aliases: ['errors','heatmap','findings','lektorat','typo','tippfehler'] },
  { key: 'kontinuitaet',   kind: 'toggle', group: 'review', labelKey: 'tile.kontinuitaet',   descKey: 'tile.kontinuitaet.desc',   flag: 'showKontinuitaetCard',   toggle: 'toggleKontinuitaetCard',   requiresBook: true,
    aliases: ['continuity','widerspruch','plot-hole','contradiction','consistency'] },
  // Welt & Plot
  { key: 'figuren',        kind: 'toggle', group: 'world',  labelKey: 'tile.figuren',        descKey: 'tile.figuren.desc',        flag: 'showFiguresCard',        toggle: 'toggleFiguresCard',        requiresBook: true,
    aliases: ['characters','personen','cast','protagonist','antagonist','soziogramm','graph'] },
  { key: 'szenen',         kind: 'toggle', group: 'world',  labelKey: 'tile.szenen',         descKey: 'tile.szenen.desc',         flag: 'showSzenenCard',         toggle: 'toggleSzenenCard',         requiresBook: true,
    aliases: ['scenes','beats','sequences','akt'] },
  { key: 'orte',           kind: 'toggle', group: 'world',  labelKey: 'tile.orte',           descKey: 'tile.orte.desc',           flag: 'showOrteCard',           toggle: 'toggleOrteCard',           requiresBook: true,
    aliases: ['locations','schauplaetze','places','setting','welt','world'] },
  { key: 'ereignisse',     kind: 'toggle', group: 'world',  labelKey: 'tile.events',         descKey: 'tile.events.desc',         flag: 'showEreignisseCard',     toggle: 'toggleEreignisseCard',     requiresBook: true,
    aliases: ['events','timeline','zeitstrahl','plot','chronologie'] },
  // Werkzeug
  { key: 'bookchat',       kind: 'toggle', group: 'tools',  labelKey: 'tile.bookchat',       descKey: 'tile.bookchat.desc',       flag: 'showBookChatCard',       toggle: 'toggleBookChatCard',       requiresPages: true,
    aliases: ['ai','frage','question','rag','assistant'] },
  { key: 'stats',          kind: 'toggle', group: 'tools',  labelKey: 'tile.stats',          descKey: 'tile.stats.desc',          flag: 'showBookStatsCard',      toggle: 'toggleBookStatsCard',      requiresBook: true,
    aliases: ['statistik','progress','wordcount','entwicklung','timeline'] },
  { key: 'bookSettings',   kind: 'toggle', group: 'tools',  labelKey: 'tile.bookSettings',   descKey: 'tile.bookSettings.desc',   flag: 'showBookSettingsCard',   toggle: 'toggleBookSettingsCard',   requiresBook: true,
    aliases: ['settings','config','buchtyp','booktype','einstellungen','genre'] },
  { key: 'finetuneExport', kind: 'toggle', group: 'tools',  labelKey: 'tile.finetuneExport', descKey: 'tile.finetuneExport.desc', flag: 'showFinetuneExportCard', toggle: 'toggleFinetuneExportCard', requiresBook: true,
    aliases: ['export','training','jsonl','llm','dataset','samples'] },
  { key: 'export',         kind: 'toggle', group: 'tools',  labelKey: 'tile.export',         descKey: 'tile.export.desc',         flag: 'showExportCard',         toggle: 'toggleExportCard',         requiresBook: true,
    aliases: ['download','pdf','epub','html','txt','markdown','md','herunterladen','speichern'] },
  { key: 'pdfExport',      kind: 'toggle', group: 'tools',  labelKey: 'tile.pdfExport',      descKey: 'tile.pdfExport.desc',      flag: 'showPdfExportCard',      toggle: 'togglePdfExportCard',      requiresBook: true,
    aliases: ['pdf','pdfa','custom','layout','schrift','font','cover','titelbild','print','druck'] },
];

// Globale Aktionen (kind:'action'). Eigene Sektion in der Palette.
// `run(root)` wird mit dem Root-Alpine-Proxy als Argument aufgerufen.
export const ACTIONS = [
  { key: 'action.theme.cycle',    kind: 'action', group: 'app', labelKey: 'palette.action.theme',     descKey: 'palette.action.theme.desc',
    aliases: ['dark','light','hell','dunkel','mode','farbe','color','design'],
    run: (root) => {
      const next = root.themePref === 'auto' ? 'light'
                 : root.themePref === 'light' ? 'dark'
                 : 'auto';
      root.setTheme(next);
    } },
  { key: 'action.locale.toggle',  kind: 'action', group: 'app', labelKey: 'palette.action.locale',    descKey: 'palette.action.locale.desc',
    aliases: ['language','sprache','english','deutsch','en','de','i18n'],
    run: (root) => {
      const next = root.uiLocale === 'de' ? 'en' : 'de';
      root.changeLocale(next);
    } },
  { key: 'action.shortcuts',      kind: 'action', group: 'app', labelKey: 'palette.action.shortcuts', descKey: 'palette.action.shortcuts.desc',
    aliases: ['help','hotkeys','tasten','keyboard','hilfe','shortcuts'],
    run: (root) => { root.toggleShortcutsOverlay(); } },
  { key: 'action.closeAll',       kind: 'action', group: 'app', labelKey: 'palette.action.closeAll',  descKey: 'palette.action.closeAll.desc',
    aliases: ['esc','dismiss','reset','schliessen'],
    run: (root) => { root._closeOtherMainCards(null); root._maybeOpenBookOverview(); } },
  { key: 'action.komplett',       kind: 'action', group: 'app', labelKey: 'palette.action.komplett',  descKey: 'palette.action.komplett.desc',
    requiresBook: true,
    aliases: ['analyse','vollanalyse','reload','aktualisieren','refresh','komplett'],
    run: (root) => { root.alleAktualisieren(); } },
  { key: 'action.tokenChange',    kind: 'action', group: 'app', labelKey: 'palette.action.token',     descKey: 'palette.action.token.desc',
    aliases: ['bookstack','api','credentials','login','token'],
    run: (root) => { root.openTokenChange(); } },
  { key: 'action.swReload',       kind: 'action', group: 'app', labelKey: 'palette.action.swReload',  descKey: 'palette.action.swReload.desc',
    aliases: ['cache','update','refresh','sw','service-worker','neu-laden'],
    run: () => {
      navigator.serviceWorker?.getRegistration?.().then(reg => reg?.unregister?.()).finally(() => location.reload(true));
    } },
  { key: 'action.logout',         kind: 'action', group: 'app', labelKey: 'palette.action.logout',    descKey: 'palette.action.logout.desc',
    aliases: ['signout','abmelden','exit'],
    run: async (root) => {
      // Caches via Root-logout-Pfad dropen, falls SW aktiv. Danach immer redirect.
      try { await root.logout({ preventDefault() {} }); } catch {}
      location.href = '/auth/logout';
    } },
];

export const FEATURE_GROUPS = ['review', 'world', 'tools', 'app'];

export const GROUP_LABEL_KEY = {
  review: 'tile.group.review',
  world:  'tile.group.world',
  tools:  'tile.group.tools',
  app:    'palette.group.app',
};

const ALL = [...FEATURES, ...ACTIONS];
const BY_KEY = new Map(ALL.map(f => [f.key, f]));

export function featureByKey(key) {
  return BY_KEY.get(key) || null;
}

export function allFeatures() {
  return ALL;
}

// Default-Set für neuen User ohne Tracking-Daten.
export const DEFAULT_RECENT_KEYS = ['review', 'figuren', 'bookchat'];

export function isFeatureAvailable(feature, ctx) {
  if (!feature) return false;
  if (feature.requiresBook && !ctx.selectedBookId) return false;
  if (feature.requiresPages && !(ctx.pages && ctx.pages.length > 0)) return false;
  return true;
}

// Grund-Key für Disabled-Tooltip / Toast.
export function unavailabilityReasonKey(feature, ctx) {
  if (!feature) return null;
  if (feature.requiresBook && !ctx.selectedBookId) return 'palette.disabled.needBook';
  if (feature.requiresPages && !(ctx.pages && ctx.pages.length > 0)) return 'palette.disabled.needPages';
  return null;
}
