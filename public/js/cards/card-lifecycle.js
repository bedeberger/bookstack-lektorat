import { EVT } from '../events.js';
import { ownedFilterKeys, resetFilterScopes, restoreFilterScopes, watchFilterScopes } from '../filter-persist.js';
// Shared lifecycle helper for Buch-scoped Karten.
//
// Most Cards duplicate the same Pattern: clear timers + reset Meta-Flags on
// `book:changed` / `view:reset`, reload on `card:refresh`, and load on
// `showXxxCard`-watch. This helper centralises that.
//
// Usage:
//   import { setupCardLifecycle } from './card-lifecycle.js';
//
//   init() {
//     this._lifecycle = setupCardLifecycle(this, {
//       name: 'orte',                 // matches event.detail.name on card:refresh
//       showFlag: 'showOrteCard',     // root flag to watch
//       timerKeys: ['_ortePollTimer'],
//       resetState: { orteLoading: false, orteProgress: 0, orteStatus: '' },
//       load: (root) => root.loadOrte(Alpine.store('nav').selectedBookId),
//     });
//   },
//   destroy() { this._lifecycle.destroy(); },
//
// Optional cfg fields:
//   onShow(root)             — overrides default show-watch (which calls cfg.load)
//   onBookChanged(e, ctx, r) — full override; skips the default reset+load
//   onViewReset(e, ctx, r)   — full override; skips the default reset
//   onCardRefresh(e, ctx, r) — runs in place of cfg.load on `card:refresh`
//                              (name-match + book-id check are handled by helper)
//   resetState               — object or factory `() => ({…})` (see applyReset)
//   resetStateView           — override resetState specifically on `view:reset`
//   refreshNeedsBookId       — default true; set false if cfg.load checks itself
//   showNeedsBookId          — default true; set false to call onShow without book
//   extraListeners           — [{ type, handler(e) }] auto-attached + auto-removed
//   filterScopes             — [{ scope, key?, defaults }] (siehe filter-persist.js):
//                              Filterleisten dieser Karte, pro Buch im
//                              localStorage. Der Helper restauriert sie beim
//                              Mount und bei `book:changed` (VOR cfg.load, damit
//                              server-seitig filternde Karten gleich richtig
//                              laden), setzt sie bei `view:reset` auf Defaults
//                              und schreibt jede Mutation zurueck. Die Karte
//                              fasst diese Felder in ihren eigenen Reset-Pfaden
//                              NICHT an — `resetState` wird um sie bereinigt,
//                              eigene Reset-Methoden duerfen sie nicht setzen
//                              (sonst gewinnt der Default gegen den
//                              restaurierten Stand).
//
// Lifecycle returns { signal, destroy } — signal is the AbortController signal
// used internally; cards can attach their own listeners with `{ signal }` to get
// cleanup-for-free.
export function setupCardLifecycle(ctx, cfg) {
  const abort = new AbortController();
  const { signal } = abort;
  const root = () => window.__app;

  const clearTimers = () => {
    for (const k of cfg.timerKeys || []) {
      if (ctx[k]) { clearInterval(ctx[k]); ctx[k] = null; }
    }
  };
  // resetState darf ein Objekt ODER eine Factory sein. Factory bevorzugen,
  // sobald der Reset Arrays/Objekte enthält, die in-place mutiert werden
  // (`saveQueue.push`, `drafts[id] = …`): ein einmalig gebautes Literal teilt
  // seine Referenzen mit dem Live-State und schleppt beim nächsten Reset die
  // Mutationen des letzten Buchs wieder ein.
  // Felder, die die Filter-Persistenz besitzt: aus dem Reset-Payload streichen,
  // damit ein Karten-Reset den restaurierten Filterstand nicht ueberschreibt.
  // Die Karte darf sie weiter in ihrem Initial-State deklarieren (Regel „State
  // explizit deklariert") — nur zurueckgesetzt werden sie hier nicht mehr.
  const filterSpecs = cfg.filterScopes || [];
  const filterKeys = ownedFilterKeys(filterSpecs);
  const applyReset = (which) => {
    const src = which === 'view' && cfg.resetStateView
      ? cfg.resetStateView
      : cfg.resetState;
    let state = typeof src === 'function' ? src() : src;
    if (!state) return;
    if (filterKeys.size) {
      state = { ...state };
      for (const k of filterKeys) delete state[k];
    }
    Object.assign(ctx, state);
  };

  if (cfg.showFlag && (cfg.load || cfg.onShow)) {
    ctx.$watch(() => root()[cfg.showFlag], async (visible) => {
      if (!visible) return;
      if (cfg.showNeedsBookId !== false && !Alpine.store('nav').selectedBookId) return;
      if (cfg.onShow) await cfg.onShow(root());
      else await cfg.load(root());
    });
  }

  const defaultBookChanged = async () => {
    clearTimers();
    applyReset('book');
    if (cfg.showFlag && !root()[cfg.showFlag]) return;
    if (!Alpine.store('nav').selectedBookId) return;
    if (cfg.load) await cfg.load(root());
  };
  const defaultViewReset = () => {
    clearTimers();
    applyReset('view');
  };

  const onBookChanged = cfg.onBookChanged
    ? (e) => cfg.onBookChanged(e, ctx, root())
    : defaultBookChanged;
  const onViewReset = cfg.onViewReset
    ? (e) => cfg.onViewReset(e, ctx, root())
    : defaultViewReset;
  const onCardRefresh = (e) => {
    if (e.detail?.name !== cfg.name) return;
    if (cfg.refreshNeedsBookId !== false && !Alpine.store('nav').selectedBookId) return;
    if (cfg.onCardRefresh) cfg.onCardRefresh(e, ctx, root());
    else if (cfg.load) cfg.load(root());
  };

  // Filter-Persistenz VOR den Karten-Handlern anhaengen: Listener feuern in
  // Registrierungsreihenfolge, und eine Karte, die im `book:changed`-Handler
  // gleich nachlaedt (Recherche filtert serverseitig), muss den restaurierten
  // Stand schon sehen.
  if (filterSpecs.length) {
    const email = () => Alpine.store('session').currentUser?.email;
    const bookId = () => Alpine.store('nav').selectedBookId;
    restoreFilterScopes(ctx, filterSpecs, email(), bookId());
    window.addEventListener(EVT.BOOK_CHANGED, () => {
      restoreFilterScopes(ctx, filterSpecs, email(), bookId());
    }, { signal });
    window.addEventListener(EVT.VIEW_RESET, () => {
      resetFilterScopes(ctx, filterSpecs);
    }, { signal });
    watchFilterScopes(ctx, ctx, filterSpecs, { email, bookId });
  }

  window.addEventListener(EVT.BOOK_CHANGED, onBookChanged, { signal });
  window.addEventListener(EVT.VIEW_RESET, onViewReset, { signal });
  if (cfg.name) window.addEventListener(EVT.CARD_REFRESH, onCardRefresh, { signal });

  for (const { type, handler } of (cfg.extraListeners || [])) {
    window.addEventListener(type, handler, { signal });
  }

  return {
    signal,
    destroy() {
      clearTimers();
      abort.abort();
    },
  };
}
