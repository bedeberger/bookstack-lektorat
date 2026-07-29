// Zentrale Registry aller App-internen CustomEvent-Namen (der „Event-Bus").
//
// SSoT für jeden `window.dispatchEvent(new CustomEvent(...))` /
// `addEventListener(...)`-Namen, der NICHT ein nativer DOM-Event ist. Ziel:
// ein Umbenennen eines Wire-Namens ist genau eine Änderung hier statt einer
// stillen Bruchstelle über N Dateien, und die Liste ist auffindbar statt
// Tribal Knowledge.
//
// Regeln:
// - Neuer App-Event → hier als Konstante + Payload-Kommentar ergänzen, dann
//   überall via `EVT.NAME` referenzieren. Keine String-Literale mehr in JS.
// - Native DOM-Events (click/input/scroll/online/pagehide/visibilitychange,
//   Service-Worker-Events, alpine:init, unhandledrejection …) bleiben Literale
//   und gehören NICHT hierher.
// - Payload steht im Kommentar als `detail`-Form; `null`/keiner = kein detail.
//
// Templates feuern keine dieser Events (kein `$dispatch`), darum reicht JS.

export const EVT = {
  // ── Job-Queue ───────────────────────────────────────────────────────────
  JOB_ENQUEUED: 'job:enqueued',                 // detail: { type, jobId, job, extra? }
  JOB_FINISHED: 'job:finished',                 // detail: { type, jobId, status }
  JOB_RECONNECT: 'job:reconnect',               // detail: { type, jobId, job, extra? }

  // ── Karten-Lifecycle / Navigation-Signale ───────────────────────────────
  // State-Sync-Broadcasts: Buchwechsel / Voll-Reset / Re-Klick-Refresh.
  // Zentral konsumiert von cards/card-lifecycle.js (Single Chokepoint).
  BOOK_CHANGED: 'book:changed',                 // kein detail
  VIEW_RESET: 'view:reset',                     // kein detail
  CARD_REFRESH: 'card:refresh',                 // detail: { name }
  BOOK_SETTINGS_UPDATED: 'book:settings:updated', // detail: { bookId }
  PAGES_LOADED: 'pages:loaded',                 // kein detail

  // ── Command-Palette ──────────────────────────────────────────────────────
  PALETTE_OPEN: 'palette:open',                 // detail: { mode? }
  PALETTE_CLOSE: 'palette:close',               // kein detail
  PALETTE_RERENDER: 'palette:rerender',         // kein detail

  // ── Quellenverzeichnis ───────────────────────────────────────────────────
  // Die Quellen-Karte broadcastet Anlage/Änderung/Löschung einer Quelle. Der
  // Beleg-Picker im Notebook-Editor cacht die Quellenliste je Buch und
  // verwirft sie darauf — sonst zeigt er die alte Liste bis zum Buchwechsel.
  SOURCES_CHANGED: 'sources:changed',           // detail: { bookId }

  // ── Querverweise ─────────────────────────────────────────────────────────
  // Die verweisbaren Ziele eines Buchs (Kapitel + Abbildungen) ändern sich beim
  // Umbauen im Buchorganizer und beim Einfügen/Löschen einer Abbildung. Der
  // Ziel-Picker cacht sie je Buch und verwirft sie darauf.
  XREFS_CHANGED: 'xrefs:changed',               // detail: { bookId }

  // ── Semantische Suche ────────────────────────────────────────────────────
  SEARCH_SIMILAR: 'search:similar',             // detail: { kind, id, label }

  // ── Editor: Focus-Modus (Trampoline aus dem Root) ────────────────────────
  EDITOR_FOCUS_ENTER: 'editor:focus:enter',     // detail: { granularity? }
  EDITOR_FOCUS_EXIT: 'editor:focus:exit',       // kein detail
  EDITOR_FOCUS_ENTER_FROM_PAGEVIEW: 'editor:focus:enter-from-pageview', // kein detail

  // ── Editor: Draft/Offline-Sync ───────────────────────────────────────────
  DRAFT_CHANGED: 'draft:changed',               // kein detail (Draft-Bestand hat sich geändert)

  // ── Editor: Synonyme ─────────────────────────────────────────────────────
  EDITOR_SYNONYM_OPEN: 'editor:synonym:open',   // detail: { word, rect }
  EDITOR_SYNONYM_CLOSE_MENU: 'editor:synonym:close-menu',     // kein detail
  EDITOR_SYNONYM_CLOSE_PICKER: 'editor:synonym:close-picker', // kein detail
  EDITOR_SYNONYM_REQUEST: 'editor:synonym:request',           // detail: { word }

  // ── Editor: Figur-Lookup ─────────────────────────────────────────────────
  EDITOR_FIGUR_LOOKUP_OPEN: 'editor:figur-lookup:open',   // detail: { name, rect }
  EDITOR_FIGUR_LOOKUP_CLOSE: 'editor:figur-lookup:close', // kein detail

  // ── Editor: LanguageTool / Revisionen ────────────────────────────────────
  LANGUAGETOOL_RECHECK: 'languagetool:recheck',                       // kein detail
  LANGUAGETOOL_EXTENSION_DETECTED: 'languagetool:extension-detected', // kein detail
  LANGUAGETOOL_EXTENSION_CLEARED: 'languagetool:extension-cleared',   // kein detail
  PAGE_REVISIONS_CHANGED: 'page-revisions:changed',                   // detail: { pageId }

  // ── Buch-Erstellung ──────────────────────────────────────────────────────
  BOOK_CREATE_OPEN: 'book-create:open',         // kein detail (Root-Trigger → Karte)

  // ── Chats ────────────────────────────────────────────────────────────────
  CHAT_RESET: 'chat:reset',                     // kein detail
  BOOK_CHAT_RESET: 'book-chat:reset',           // kein detail

  // ── Bucheditor / Kommentar-Rail ──────────────────────────────────────────
  BOOK_EDITOR_OPEN_FIND: 'book-editor:open-find',     // kein detail
  BOOK_EDITOR_GOTO_COMMENT: 'book-editor:goto-comment', // detail: { commentId }
  COMMENTS_RAIL_GOTO: 'comments-rail:goto',     // detail: { commentId }
  COMMENTS_RAIL_TOGGLE: 'comments-rail:toggle', // kein detail

  // ── Cross-Card Selektion / Filter ────────────────────────────────────────
  FIGUR_WERKSTATT_SELECT: 'figur-werkstatt:select',       // detail: { figureId }
  MOTIV_SELECT: 'motiv:select',                           // detail: { motifId }
  PLOT_FOCUS_BEAT: 'plot:focus-beat',                     // detail: { beatId }
  PLOT_FILTER_DRAFT_FIGURE: 'plot:filter-draft-figure',   // detail: { figureId }
  RUECKBLICK_SELECT: 'rueckblick:select',                 // detail: { date }
  RECHERCHE_FILTER_PAGE: 'recherche:filter-page',         // detail: { pageId }
  RECHERCHE_FILTER_CHAPTER: 'recherche:filter-chapter',   // detail: { chapterId }
  RECHERCHE_FOCUS_ITEM: 'recherche:focus-item',           // detail: { itemId }
  BOOK_STATS_SELECT: 'book-stats:select',                 // detail: { metric }
  SHARE_PREFILL: 'share:prefill',                         // detail: { scope, id }

  // ── Export-Presets ───────────────────────────────────────────────────────
  EXPORT_PRESET: 'export:preset',               // detail: { preset } (PDF)
  EXPORT_EPUB_PRESET: 'export:epub:preset',     // detail: { preset }
  EXPORT_DOCX_PRESET: 'export:docx:preset',     // detail: { preset }

  // ── Tooltip-Layer ────────────────────────────────────────────────────────
  TOOLTIP_HIDE: 'tooltip:hide',                 // kein detail (programmatisches Ausblenden)

  // ── App-global ───────────────────────────────────────────────────────────
  SESSION_EXPIRED: 'session-expired',           // kein detail
  APP_UPDATE_AVAILABLE: 'app:update-available', // kein detail
  FILE_DROP: 'file-drop',                       // detail: { files }
};
