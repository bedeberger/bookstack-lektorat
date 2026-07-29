import { EVT } from '../events.js';
// editorEntitiesCard — Entity-Linking-Sub-Komponente (Notebook-Editor):
//   - Inline-Highlights (Figuren, Orte) im contenteditable.
//   - Popover (teleport) bei Klick auf ein Highlight.
//   - Quellen-Popover bei Klick auf einen Beleg-Chip in der LESEANSICHT
//     (read-only; der Edit-Modus oeffnet stattdessen den Beleg-Picker in
//     cards/editor-toolbar-card.js).
// Die Kontext-Listen (Figuren/Szenen/Ereignisse) leben im Referenz-Slot
// (cards/reference-card.js), nicht mehr hier.
//
// Lifecycle:
//   - Aktivierung gesteuert ueber Root-Flag `entitiesEnabledForCurrentBook`
//     (Spiegel von book_settings.entities_enabled). Toggle in der Notebook-
//     Toolbar; persistiert via PUT /booksettings/:id/entities-enabled.
//   - Highlight-Recompute: bei editMode-Wechsel, currentPage-Wechsel, nach
//     Edit-Input (debounce), nach book:settings:updated, nach Figuren/Orte-
//     Reload.
//   - Cleanup: clearHighlights() bei Toggle-Off, Edit-Exit, Page-Exit,
//     Buchwechsel.
//
// State-Quellen: figuren/orte/szenen kommen vom Catalog-Store (root proxy);
// Ereignisse aus `figuren[].lebensereignisse` (siehe entities.js#selectEventsForView).

import {
  applyHighlights, clearHighlights, findHighlightAtPoint,
  toEntitiesList,
} from '../editor/notebook/entities.js';
import { closestCiteEl, CITE_ATTR_SRC, CITE_ATTR_LOC, citeModeOf } from '../sources/cite-html.js';
import { loadBookSources, invalidateSourceCache } from '../sources/source-cache.js';
import { buildCitePopoverModel } from '../sources/cite-popover.js';

const RECOMPUTE_DEBOUNCE_MS = 400;
const EDIT_SELECTOR = '#editor-card .page-content-view--editing';
// Leseansicht derselben Karte. Der Edit-Container traegt zusaetzlich
// `--editing`, darum wird der Klick-Pfad ueber `app.editMode` abgegrenzt.
const VIEW_SELECTOR = '#editor-card .page-content-view';

export function registerEditorEntitiesCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('editorEntitiesCard', () => ({
    // Popover-State (teleport): null = zu; sonst { entity, kind, x, y, name }.
    entityPopover: null,
    // Letzte berechnete Highlight-Ranges (kind, id, name, range) — Hit-Test-
    // Quelle fuer Klicks. Wird in `_recompute` neu gesetzt.
    _highlights: [],
    // Aktuelle Anchor-Range fuer den offenen Popover (nicht reaktiv —
    // Range-Objekte mag Alpines Proxy nicht). Wird beim Scroll/Resize neu
    // vermessen, damit der Popover mit dem Highlight mitwandert.
    _popoverRange: null,
    // Anker-Element fuer Chip-Popovers (Kontext-Leiste). Wenn die Page
    // scrollt, hat das Chip keinen Range — wir messen direkt am DOM-Element
    // neu, damit der Popover am Chip kleben bleibt.
    _popoverAnchor: null,
    _repositionRaf: 0,
    _recomputeTimer: null,
    _abort: null,
    _onSettingsUpdated: null,

    init() {
      const abort = new AbortController();
      this._abort = abort;
      const signal = abort.signal;

      // Highlight neu rechnen wenn relevanter State sich aendert.
      const recompute = () => this._scheduleRecompute();
      this.$watch(() => window.__app?.entitiesEnabledForCurrentBook, (on) => {
        if (!on) {
          clearHighlights();
          this.closePopover();
        } else {
          recompute();
        }
      });
      // Buch-Wechsel: Szenen fuer neues Buch nachladen (Kontext-Panel zeigt
      // Szenen/Ereignisse unabhaengig vom Entity-Toggle, also auch hier laden).
      this.$watch(() => Alpine.store('nav').selectedBookId, () => {
        this._ensureSzenenLoaded();
      });
      this.$watch(() => window.__app?.currentPage?.id, () => {
        clearHighlights();
        this.closePopover();
        recompute();
      });
      this.$watch(() => window.__app?.editMode, () => {
        clearHighlights();
        recompute();
      });
      this.$watch(() => (window.__app?.$store.catalog.figuren || []).length, recompute);
      this.$watch(() => (window.__app?.$store.catalog.orte || []).length, recompute);

      // Wenn BookSettings die Flag aendert oder ein anderes Geraet sie
      // updatet, refetcht der Root die Setting — wir reagieren auf Recompute.
      this._onSettingsUpdated = (ev) => {
        const id = ev?.detail?.bookId;
        if (id && String(id) !== String(Alpine.store('nav').selectedBookId)) return;
        recompute();
      };
      window.addEventListener(EVT.BOOK_SETTINGS_UPDATED, this._onSettingsUpdated, { signal });

      // Klick im Edit-Container — wenn auf eine highlighted Range, Popover.
      // Da CSS Custom Highlights kein eigenes Pointer-Target sind, koennen
      // wir nicht direkt auf das Highlight klicken; stattdessen pruefen wir
      // bei jedem Klick im Editor, ob das angeklickte Wort einem Entity-Name
      // entspricht.
      document.addEventListener('click', (e) => {
        const app = window.__app;
        if (!app?.entitiesEnabledForCurrentBook) return;
        const editEl = e.target?.closest?.(EDIT_SELECTOR + ', #editor-card .page-content-view');
        if (!editEl) return;
        this._maybeOpenPopoverFromClick(e);
      }, { signal });

      // Klick auf einen Beleg-Chip in der LESEANSICHT → Quellen-Popover
      // (read-only). Bewusst NICHT an `entitiesEnabledForCurrentBook` gebunden:
      // das Flag schaltet die Figuren-/Orte-Hervorhebung, ein Quellennachweis
      // steht dagegen unabhaengig davon im Text. Der Edit-Modus gehoert dem
      // Beleg-Picker (cards/editor-toolbar-card.js) — dort wird der Chip
      // geaendert, hier nur nachgeschlagen.
      document.addEventListener('click', (e) => {
        const app = window.__app;
        if (!app || app.editMode || app.focusActive) return;
        const viewEl = e.target?.closest?.(VIEW_SELECTOR);
        if (!viewEl) return;
        const chip = closestCiteEl(e.target, viewEl);
        if (!chip) return;
        this.openSourcePopoverForChip(chip);
      }, { signal });

      // Quellenliste ist modulweit gecacht (ein Fetch pro Buch, geteilt mit dem
      // Beleg-Picker). Ohne diese Invalidierung zeigt das Popover nach einer
      // Aenderung in der Quellen-Karte weiter den alten Eintrag.
      window.addEventListener(EVT.SOURCES_CHANGED, (e) => {
        invalidateSourceCache(e?.detail?.bookId ?? null);
      }, { signal });
      window.addEventListener(EVT.BOOK_CHANGED, () => invalidateSourceCache(), { signal });

      // Outside-Close auf mousedown statt click. Why: der LT-Spellcheck-
      // Controller stoppt das click-Event in der capture-Phase auf .page-content-
      // view--editing, damit Links unter Squiggles nicht gefolgt werden. Dadurch
      // erreicht der Click document nie und Alpine's `@click.outside` feuert
      // nicht — Entity-Popover bleibt offen und ueberdeckt das LT-Popover.
      // Mousedown auf document/capture laeuft vor jedem Root-Listener, schliesst
      // sauber bevor LT sein Popover oeffnet.
      document.addEventListener('mousedown', (e) => {
        if (!this.entityPopover) return;
        if (e.target?.closest?.('.entity-popover')) return;
        // Beleg-Chips durchlassen: sonst raeumt dieses mousedown den Anker weg,
        // bevor der Klick-Handler ihn mit dem offenen Popover vergleichen kann —
        // der zweite Klick auf denselben Chip wuerde neu oeffnen statt zu
        // schliessen. Ein Klick auf einen ANDEREN Chip ueberschreibt das Popover
        // im Klick-Handler ohnehin.
        if (e.target?.closest?.(VIEW_SELECTOR) && closestCiteEl(e.target, null)) return;
        this.closePopover();
      }, { capture: true, signal });

      // Edit-Input → debounced Recompute (Texte aendern Highlights).
      // Early-Out: bei deaktiviertem Buch keinen Timer schedulen — spart bei
      // 20k-Zeichen-Seiten jeden Tipp-Tick einen setTimeout.
      document.addEventListener('input', (e) => {
        if (!window.__app?.entitiesEnabledForCurrentBook) return;
        if (!e.target?.closest?.(EDIT_SELECTOR)) return;
        this._scheduleRecompute();
      }, { signal });

      // Popover anker-treu halten: capture-Phase faengt Scrolls auf jedem
      // Vorfahren (Window, Editor-Container, Card-Body) — egal wo das Layout
      // wirklich scrollt, wir richten am Live-Range-Rect neu aus.
      const onScroll = () => this._schedulePopoverReposition();
      window.addEventListener('scroll', onScroll, { capture: true, passive: true, signal });
      window.addEventListener('resize', onScroll, { signal });

      // Initial-Trigger nach Mount. Szenen werden immer geladen — das Kontext-
      // Panel zeigt sie unabhaengig vom Entity-Toggle.
      this.$nextTick(() => {
        this._ensureSzenenLoaded();
        recompute();
      });
    },

    // Stellt sicher, dass `app.$store.catalog.szenen` fuer das aktuelle Buch geladen ist.
    // Andere Trigger (Szenen-/Orte-Karte, Komplettanalyse, Palette) laden
    // bei Bedarf; das Entity-Panel ist eigener Konsument und muss selber dafuer
    // sorgen, sonst bleibt die Szenen-Sektion permanent leer.
    _ensureSzenenLoaded() {
      const app = window.__app;
      const bookId = Alpine.store('nav').selectedBookId;
      if (!bookId) return;
      if (Array.isArray(app.$store.catalog.szenen) && app.$store.catalog.szenen.length > 0) return;
      const tag = bookId + ':' + (app?.session?.email || '');
      if (this._szenenLoadTag === tag) return;
      this._szenenLoadTag = tag;
      Promise.resolve(app.loadSzenen?.(bookId)).catch(() => {
        this._szenenLoadTag = null;
      });
    },

    destroy() {
      if (this._recomputeTimer) { clearTimeout(this._recomputeTimer); this._recomputeTimer = null; }
      if (this._repositionRaf) { cancelAnimationFrame(this._repositionRaf); this._repositionRaf = 0; }
      this._popoverRange = null;
      this._popoverAnchor = null;
      this._abort?.abort();
      clearHighlights();
    },

    _scheduleRecompute() {
      if (this._recomputeTimer) clearTimeout(this._recomputeTimer);
      this._recomputeTimer = setTimeout(() => {
        this._recomputeTimer = null;
        this._recompute();
      }, RECOMPUTE_DEBOUNCE_MS);
    },

    _recompute() {
      const app = window.__app;
      if (!app?.entitiesEnabledForCurrentBook) {
        clearHighlights();
        this._highlights = [];
        return;
      }
      const root = document.querySelector(EDIT_SELECTOR)
                || document.querySelector('#editor-card .page-content-view');
      if (!root) { clearHighlights(); this._highlights = []; return; }
      const entities = toEntitiesList(app.$store.catalog.figuren, app.$store.catalog.orte);
      this._highlights = applyHighlights(root, entities);
    },

    // ── Navigation ──────────────────────────────────────────────────────────

    // Oeffnet das gemeinsame Entity-Popover fuer einen Chip in der Kontext-
    // Leiste. Identischer State-Sink (`entityPopover`) wie der Klick auf ein
    // Highlight im Editor — eine Popover-Implementierung fuer beide Trigger.
    // `kind` ∈ {'figure','location','scene','event'}, `data` das Quell-Objekt,
    // `displayName` der sichtbare Name, `ev` das urspruengliche Click-Event
    // (currentTarget = Chip-Element zum Positionieren via getBoundingClientRect).
    openPopoverForChip(kind, data, displayName, ev) {
      if (!data || !ev?.currentTarget) return;
      ev.preventDefault();
      ev.stopPropagation();
      // Erneuter Klick auf denselben Chip → Popover schliessen (Toggle).
      // Der mousedown-Capture-Listener laesst Chip-Targets durch, daher sind
      // entityPopover + _popoverAnchor beim Click noch gesetzt.
      if (this.entityPopover && this._popoverAnchor === ev.currentTarget) {
        this.closePopover();
        return;
      }
      const rect = ev.currentTarget.getBoundingClientRect();
      const { x, y } = this._computePopoverXY(rect);
      this._popoverRange = null;
      this._popoverAnchor = ev.currentTarget;
      this.entityPopover = {
        kind,
        id: data.id ?? data.figure_id ?? null,
        name: displayName || data.name || data.titel || data.ereignis || '',
        data,
        x, y,
      };
    },

    // Quellen-Popover eines Beleg-Chips in der Leseansicht. Derselbe State-Sink
    // (`entityPopover`) wie die Entity-Varianten, `kind: 'source'` — damit gelten
    // Positionierung, Scroll-Nachfuehrung, Outside- und Escape-Close unveraendert.
    //
    // Der Voll-Eintrag wird aus der Quelle gebaut, nicht aus dem Chip-Text: der
    // Text ist nur ein Cache des Kurzbelegs (siehe sources/cite-html.js).
    async openSourcePopoverForChip(chip) {
      if (!chip) return;
      // Erneuter Klick auf denselben Chip schliesst (Toggle) — wie bei den
      // Chips der Kontext-Leiste.
      if (this.entityPopover && this._popoverAnchor === chip) {
        this.closePopover();
        return;
      }
      const app = window.__app;
      const bookId = Alpine.store('nav').selectedBookId;
      const srcId = parseInt(chip.getAttribute(CITE_ATTR_SRC), 10);
      const loc = chip.getAttribute(CITE_ATTR_LOC) || '';
      const mode = citeModeOf(chip);

      let sources = [];
      let loadError = false;
      if (bookId) {
        try {
          sources = await loadBookSources(bookId);
        } catch (_) {
          loadError = true;
        }
      } else {
        loadError = true;
      }
      // Waehrend des Fetches kann der User weitergeklickt, die Seite gewechselt
      // oder den Edit-Modus betreten haben — dann ist dieses Popover veraltet.
      if (!chip.isConnected || app?.editMode || app?.focusActive) return;
      if (String(Alpine.store('nav').selectedBookId) !== String(bookId)) return;

      const model = buildCitePopoverModel({
        srcId: Number.isInteger(srcId) ? srcId : null,
        loc, mode, sources, loadError,
        style: app?.citationStyleForCurrentBook || 'apa7',
        lang: app?.citationLangForCurrentBook || 'de',
      });
      const { x, y } = this._computePopoverXY(chip.getBoundingClientRect());
      this._popoverRange = null;
      this._popoverAnchor = chip;
      this.entityPopover = {
        kind: 'source',
        id: model.srcId,
        name: model.name,
        data: model,
        x, y,
      };
    },

    // Vom Popover ins Quellenverzeichnis (Pflege der Quelle passiert dort, nicht
    // im Popover). Gleicher Permalink wie im Quellen-Tab des Referenz-Slots.
    openSourceInList(id) {
      const bookId = Alpine.store('nav').selectedBookId;
      this.closePopover();
      if (!bookId || id == null) return;
      location.hash = `#book/${bookId}/quellen/${id}`;
    },

    openFigure(id) {
      const app = window.__app;
      this.closePopover();
      if (!app?.openFigurById) return;
      app.openFigurById(id);
    },

    openLocation(id) {
      const app = window.__app;
      this.closePopover();
      if (!app?.openOrtById) return;
      app.openOrtById(id);
    },

    openScene(id) {
      const app = window.__app;
      if (app?.openSzeneById) app.openSzeneById(id);
    },

    openEvent(figureId) {
      const app = window.__app;
      if (app?.openFigurById) app.openFigurById(figureId);
    },

    // ── Popover ─────────────────────────────────────────────────────────────

    // Hit-Test ueber die DOM-Ranges, die `applyHighlights` zurueckgeliefert hat.
    // CSS Custom Highlights selbst sind nicht pointer-event-faehig — wir
    // iterieren die gespeicherten Ranges und matchen gegen die Klick-Koordinate.
    _maybeOpenPopoverFromClick(ev) {
      const app = window.__app;
      if (!this._highlights?.length) return;
      const found = findHighlightAtPoint(this._highlights, ev.clientX, ev.clientY);
      if (!found) return;
      const { hit, rect } = found;
      ev.preventDefault();
      const data = hit.kind === 'figure'
        ? (app.$store.catalog.figuren || []).find(f => f.id === hit.id)
        : (app.$store.catalog.orte    || []).find(o => o.id === hit.id);
      const { x, y } = this._computePopoverXY(rect);
      this._popoverRange = hit.range || null;
      this._popoverAnchor = null;
      this.entityPopover = {
        kind: hit.kind,
        id: hit.id,
        name: hit.name,
        data: data || null,
        x, y,
      };
    },

    // Popover an der Highlight-Box ausrichten — unter dem Wort, links mit
    // etwas Inset, Viewport-Clamping. Shared zwischen Open- und Scroll-
    // Reposition-Pfad, damit Initial- und Scroll-Position identisch sind.
    // Mobile (<= 480px): Popover spannt sich via CSS auf volle Breite (left+
    // right: 12px) — JS setzt nur x = 12, damit Inline-`left` mit dem CSS-
    // `right` zusammen die Breite berechnen kann. Aeusserer Math.max(12, …)
    // verhindert ausserdem x < 0 auf sehr schmalen Viewports zwischen 481px
    // und ca. 350px, wo windowInnerWidth - POPOVER_W - 12 negativ werden kann.
    _computePopoverXY(rect) {
      const POPOVER_W = 320;
      const POPOVER_H_EST = 180;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const x = vw <= 480
        ? 12
        : Math.max(12, Math.min(vw - POPOVER_W - 12, Math.max(12, rect.left)));
      const y = rect.bottom + POPOVER_H_EST > vh
        ? Math.max(12, rect.top - POPOVER_H_EST - 6)
        : rect.bottom + 6;
      return { x, y };
    },

    _schedulePopoverReposition() {
      if (!this.entityPopover) return;
      if (!this._popoverRange && !this._popoverAnchor) return;
      if (this._repositionRaf) return;
      this._repositionRaf = requestAnimationFrame(() => {
        this._repositionRaf = 0;
        this._repositionPopover();
      });
    },

    // Anker-Rect ermitteln: Range hat Prioritaet (Inline-Highlight), sonst
    // das DOM-Element (Chip in der Kontext-Leiste). Beides liefert ein
    // viewport-relatives Rect, das `_computePopoverXY` direkt verwertet.
    _currentAnchorRect() {
      if (this._popoverRange) {
        const rects = this._popoverRange.getClientRects?.();
        if (rects && rects.length > 0) return rects[0];
      }
      if (this._popoverAnchor?.isConnected) {
        return this._popoverAnchor.getBoundingClientRect();
      }
      return null;
    },

    _repositionPopover() {
      if (!this.entityPopover) return;
      const rect = this._currentAnchorRect();
      if (!rect) return;
      // Anker vollstaendig ausserhalb des Viewports → Popover hat keinen
      // sichtbaren Bezugspunkt mehr. Schliessen statt am Rand kleben lassen.
      if (rect.bottom < 0 || rect.top > window.innerHeight
          || rect.right < 0 || rect.left > window.innerWidth) {
        this.closePopover();
        return;
      }
      const { x, y } = this._computePopoverXY(rect);
      if (x === this.entityPopover.x && y === this.entityPopover.y) return;
      this.entityPopover = { ...this.entityPopover, x, y };
    },

    closePopover() {
      this._popoverRange = null;
      this._popoverAnchor = null;
      if (this._repositionRaf) { cancelAnimationFrame(this._repositionRaf); this._repositionRaf = 0; }
      this.entityPopover = null;
    },
  }));
}
