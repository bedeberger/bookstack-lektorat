// Alpine.data('figurenCard') — Sub-Komponente der Figurenübersicht.
//
// Eigener State:
//   - Graph-Modus (figurenGraphModus, figurenGraphKapitel, figurenGraphFullscreen)
//   - Alterstabelle (figurenAlterData/-Filters/-Loading/-Progress/-Status,
//     figurenAlterOpenId) — der Index wird erst beim Oeffnen des Reiters geholt
//   - vis-network-Internals (_figurenNetwork, _figurenHash, _figurenNodes, _figurenEdges)
//   - aufgelöste Canvas-Farben (_graphTheme) + Theme-Observer (_themeObserver)
//   - figurenUpdatedAt (Render-Timestamp im Card-Header)
//
// Geteilt:
//   - `figuren` (Alpine.store('catalog'))
//   - `figurenFilters`/`selectedFigurId`/`figurenLoading/Progress/Status`
//     (Alpine.store('catalogUi') — app-navigation/Hash-Router/checkPendingJobs
//     schreiben darauf)
// Root behält:
//   - `loadFiguren`, `saveFiguren` (von vielen Modulen gerufen)

import { graphMethods } from '../graph.js';
import { presenceMethods } from '../book/figuren-presence.js';
import { figurenAlterMethods } from '../book/figuren-alter.js';
import { setupCardLifecycle } from './card-lifecycle.js';
import { attachFullscreenSync } from '../fullscreen.js';
import { observeThemeChange } from '../graph-kit.js';

const FIGUR_TYP_ORDER = { hauptfigur: 0, antagonist: 1, mentor: 2, nebenfigur: 3, randfigur: 4, andere: 5 };

// Pure Filter+Sort der Figurenliste. Aus dem memoized Wrapper extrahiert, damit
// sie ohne Alpine-Root testbar bleibt. `chapterMap` = Kapitel-Name → Reihenfolge-
// Index (root._chapterOrderMap).
export function computeFilteredFiguren(figuren, chapterMap, { suche = '', kapitel = '', seite = '' } = {}) {
  let result = figuren ?? [];
  const q = (suche || '').toLowerCase();
  if (q) result = result.filter(f => (f.name ?? '').toLowerCase().includes(q));
  if (kapitel) result = result.filter(f => (f.kapitel ?? []).some(k => k.name === kapitel));
  if (seite) result = result.filter(f =>
    (f.seiten ?? []).some(s => s.kapitel === kapitel && s.seite === seite));

  // minChapterIdx pro Figur einmal vorab berechnen (kein Math.min(...spread) im Comparator).
  const minIdx = new Map();
  const idxOf = (f) => {
    let m = minIdx.get(f);
    if (m !== undefined) return m;
    m = 9999;
    const ks = f.kapitel;
    if (ks) for (let i = 0; i < ks.length; i++) {
      const v = chapterMap?.get(ks[i].name) ?? 9999;
      if (v < m) m = v;
    }
    minIdx.set(f, m);
    return m;
  };
  return [...result].sort((a, b) => {
    const aK = idxOf(a);
    const bK = idxOf(b);
    if (aK !== bK) return aK - bK;
    const aT = FIGUR_TYP_ORDER[a.typ] ?? 99;
    const bT = FIGUR_TYP_ORDER[b.typ] ?? 99;
    if (aT !== bT) return aT - bT;
    return (a.name ?? '').localeCompare(b.name ?? '', 'de');
  });
}

// Pure: sichtbare Seiten-Namen eines Kapitels über alle Figuren (Filter-Combobox).
export function computeFigurenSeiten(figuren, kapitel) {
  const names = new Set();
  for (const f of (figuren || [])) {
    for (const s of (f.seiten || [])) {
      if (s.kapitel === kapitel && s.seite) names.add(s.seite);
    }
  }
  return names;
}

export function registerFigurenCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('figurenCard', () => ({
    figurenUpdatedAt: null,
    figurenGraphModus: 'figur',
    figurenGraphKapitel: null,
    figurenGraphFullscreen: false,
    // Alterstabelle (5. Reiter). `figurenAlterData` = { figuren, scan } aus
    // GET /figures/:id/alter; null heisst „noch nicht geladen", nicht „leer".
    figurenAlterData: null,
    figurenAlterFilters: { suche: '', typ: '', nur: '' },
    figurenAlterLoading: false,
    figurenAlterProgress: 0,
    figurenAlterStatus: '',
    figurenAlterOpenId: null,
    _figurenAlterPollTimer: null,
    _figurenAlterLoadedBookId: null,
    _figurenNetwork: null,
    _figurenHash: null,
    _figurenNodes: null,
    _figurenEdges: null,
    // Aufgelöste Canvas-Farben (Hell/Dunkel). Wird pro Render in renderFigurGraph
    // gesetzt; Overlays + Kapitel-Filter lesen daraus, statt selbst zu messen.
    _graphTheme: null,
    _themeObserver: null,
    // Ein Memo-Helper pro Modul (CLAUDE.md): filteredFiguren()/figurenKapitelListe()/
    // figurenSeitenListe() werden im Template (inkl. Combobox-x-effect) mehrfach pro
    // Render gelesen → Cache mit shallow-Array-Deps. Reset via this._memos = {} im load-Pfad.
    _memos: {},
    _lifecycle: null,

    init() {
      const destroyNet = () => {
        if (this._figurenNetwork) { this._figurenNetwork.destroy(); this._figurenNetwork = null; }
        // vis-network DataSets halten Referenzen aufs alte Buch; ohne null
        // bleiben sie bis zum nächsten view:reset im Speicher.
        this._figurenNodes = null;
        this._figurenEdges = null;
        this._figurenHash = null;
      };

      this._lifecycle = setupCardLifecycle(this, {
        name: 'figuren',
        showFlag: 'showFiguresCard',
        load: async (root) => {
          this._memos = {};
          if (this.figurenGraphModus === 'alter') this.ensureFigurenAlter();
          await root.loadFiguren(Alpine.store('nav').selectedBookId);
          await this.$nextTick();
          this.renderFigurGraph();
        },
        // book:changed: Netzwerk wegwerfen + Header-Timestamp + Kapitelfilter
        // resetten, dann neu rendern. loadFiguren läuft zwar parallel aus
        // _resetBookScopedState (loadPages), ist aber ein Netz-Fetch — book:changed
        // feuert synchron davor. Ein blosses $nextTick würde rendern, solange
        // figuren noch [] ist → Leer-Platzhalter + gecachter Leer-Hash, und der
        // Reactive-Update löst keinen erneuten Render aus. Darum hier den Load
        // explizit awaiten (idempotent zum loadPages-Load) und erst dann rendern.
        onBookChanged: async (e, ctx, root) => {
          destroyNet();
          ctx._memos = {};
          ctx.figurenUpdatedAt = null;
          ctx.figurenGraphKapitel = null;
          ctx._resetFigurenAlter();
          if (!root.showFiguresCard) return;
          const bookId = Alpine.store('nav').selectedBookId;
          if (!bookId) return;
          await root.loadFiguren(bookId);
          // Schneller Folge-Buchwechsel: Ergebnis verwerfen, der neue
          // book:changed-Handler rendert.
          if (String(Alpine.store('nav').selectedBookId) !== String(bookId)) return;
          await ctx.$nextTick();
          ctx.renderFigurGraph();
        },
        onViewReset: (e, ctx) => {
          destroyNet();
          ctx._resetFigurenAlter();
          ctx.figurenUpdatedAt = null;
          ctx.figurenGraphModus = 'figur';
          ctx.figurenGraphKapitel = null;
          ctx.figurenGraphFullscreen = false;
        },
      });

      // Reiter „Alter" ist der einzige, der Daten nachlaedt (der Alters-Index
      // gehoert nicht in den heissen Katalog-Fetch). Darum hier und nicht in
      // graph/core.js#setFigurenGraphModus — die Methode teilt sich die Karte mit
      // dem Graph-Modul und weiss nichts von der Tabelle.
      this.$watch('figurenGraphModus', (mode) => {
        if (mode === 'alter') this.ensureFigurenAlter();
      });

      // Sprachwechsel → Graph-Labels neu rendern (uiLocale Teil des Hash).
      this.$watch(() => Alpine.store('shell').uiLocale, () => {
        if (window.__app.showFiguresCard && Alpine.store('catalog').figuren?.length) {
          this.renderFigurGraph();
        }
      });

      // Figuren-Daten aendern sich auch bei OFFENER Karte: Einzel-Delete einer
      // stale-Figur (root#deleteStaleFigur) und jeder loadFiguren nach einem Job,
      // der Figuren neu abgleicht. Ohne diesen Watcher rendert der Graph nur beim
      // Oeffnen/Buchwechsel/Modus-/Sprachwechsel — die geloeschte Figur bleibt als
      // Knoten stehen, obwohl ihre Listenzeile weg ist. Die Render-Signatur in
      // core.js#renderFigurGraph faengt den No-op-Fall ab, ein Watcher-Lauf ohne
      // layout-relevante Aenderung kostet also nichts.
      // Leeres Array bewusst uebersprungen (wie beim uiLocale-Watcher): waehrend
      // book:changed steht figuren kurz auf [] — rendern wuerde dort nur den
      // Leer-Platzhalter aufblitzen lassen. Faellt die letzte Figur weg, blendet
      // das Partial den ganzen Graph-Block ohnehin aus (figuren.length > 0).
      this.$watch(() => Alpine.store('catalog').figuren, (figuren) => {
        if (window.__app.showFiguresCard && figuren?.length) this.renderFigurGraph();
      });

      // Theme-Wechsel (Hell/Dunkel) → neu zeichnen. Die Canvas-Farben stecken im
      // gezeichneten Bild; ein CSS-Wechsel erreicht sie nicht.
      this._themeObserver = observeThemeChange(() => {
        if (window.__app.showFiguresCard && Alpine.store('catalog').figuren?.length) {
          this.renderFigurGraph();
        }
      });

      // Native Fullscreen-API: State spiegeln, Canvas neu fitten, beim Verlassen
      // (Esc / Browser-UI) Toggle-Flag sauber zurücksetzen.
      attachFullscreenSync({
        resolveWrap: () => document.getElementById('figuren-graph')?.closest('.figuren-graph-wrap'),
        signal: this._lifecycle.signal,
        onChange: (active) => {
          this.figurenGraphFullscreen = active;
          if (this._figurenNetwork) {
            // vis-network hört auf window.resize → Canvas an neuen Container anpassen.
            window.dispatchEvent(new Event('resize'));
            requestAnimationFrame(() => {
              this._figurenNetwork?.fit({ animation: { duration: 200, easingFunction: 'easeInOutQuad' } });
            });
          }
        },
      });
    },

    destroy() {
      // Falls Karte im Vollbild abgebaut wird (Buchwechsel etc.): zuerst Browser-Fullscreen verlassen.
      if (document.fullscreenElement?.classList?.contains?.('figuren-graph-wrap')) {
        try { document.exitFullscreen?.(); } catch {}
      }
      this._lifecycle?.destroy();
      if (this._figurenAlterPollTimer) { clearTimeout(this._figurenAlterPollTimer); this._figurenAlterPollTimer = null; }
      this._themeObserver?.disconnect();
      this._themeObserver = null;
      if (this._figurenNetwork) { this._figurenNetwork.destroy(); this._figurenNetwork = null; }
      this._graphTheme = null;
    },

    // Ein Memo-Helper pro Modul (CLAUDE.md): Cache mit shallow-Array-Deps-
    // Vergleich (`===`). Cache hit nur wenn ALLE Deps identisch zur letzten
    // Compute. Reset über this._memos = {} (load-Pfad / book:changed).
    _memo(key, deps, compute) {
      const memos = (this._memos ||= {});
      const hit = memos[key];
      if (hit && hit.deps.length === deps.length && hit.deps.every((d, i) => d === deps[i])) {
        return hit.value;
      }
      const value = compute();
      memos[key] = { deps: [...deps], value };
      return value;
    },

    // UI-Helper: aus Comboboxen via x-effect mehrfach pro Render gerufen
    // (für _disabled + options). Memo auf Identität der Quell-Daten.
    figurenKapitelListe() {
      const figuren = Alpine.store('catalog').figuren;
      return this._memo('kapitel', [figuren],
        () => window.__app._deriveKapitel(figuren, f => f.kapitel));
    },

    figurenSeitenListe() {
      // seiten = Array {kapitel, seite} — eigener Iterator (keine 1:1-Relation).
      const figuren = Alpine.store('catalog').figuren;
      const kapitel = Alpine.store('catalogUi').figurenFilters.kapitel;
      return this._memo('seiten', [figuren, kapitel], () => {
        if (!kapitel) return [];
        return window.__app._sortByPageOrder([...computeFigurenSeiten(figuren, kapitel)]);
      });
    },

    filteredFiguren() {
      const root = window.__app;
      const f = Alpine.store('catalogUi').figurenFilters;
      const figuren = root.$store.catalog.figuren;
      const chapterMap = root._chapterOrderMap;
      const suche = f.suche ?? '', kapitel = f.kapitel ?? '', seite = f.seite ?? '';
      return this._memo('filtered', [figuren, chapterMap, suche, kapitel, seite],
        () => computeFilteredFiguren(figuren, chapterMap, { suche, kapitel, seite }));
    },

    // Buchwechsel/View-Reset: geladener Index gehoert zum alten Buch, ein
    // laufender Poll zu einem Job, dessen Ergebnis niemand mehr anzeigt.
    _resetFigurenAlter() {
      if (this._figurenAlterPollTimer) { clearTimeout(this._figurenAlterPollTimer); this._figurenAlterPollTimer = null; }
      this.figurenAlterData = null;
      this._figurenAlterLoadedBookId = null;
      this.figurenAlterLoading = false;
      this.figurenAlterProgress = 0;
      this.figurenAlterStatus = '';
      this.figurenAlterOpenId = null;
      this.figurenAlterFilters = { suche: '', typ: '', nur: '' };
    },

    ...graphMethods,
    ...presenceMethods,
    ...figurenAlterMethods,
  }));
}
