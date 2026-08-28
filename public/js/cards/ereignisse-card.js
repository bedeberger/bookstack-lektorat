// Alpine.data('ereignisseCard') — Sub-Komponente der Zeitstrahl-Karte.
//
// Eigener State: Meta-Flags (Loading/Status/Progress/PollTimer) + UI-Helper.
// Geteilt:
//   - `globalZeitstrahl` (Alpine.store('catalog'))
//   - `ereignisseFilters` (Alpine.store('catalogUi') — app-navigation schreibt darauf)
// Root behält:
//   - `_buildGlobalZeitstrahl` (wird aus figuren.js / loadFiguren gerufen)
//   - `_reloadZeitstrahl` (wird aus app-komplett.js gerufen)
//
// Die Sachlogik liegt als reine Module im Subfolder `ereignisse/` (Datum,
// Subtyp, Band-Geometrie, Event-Modell) und wird hier re-exportiert, damit
// Tests und Konsumenten einen Einstieg behalten.
import { setupCardLifecycle } from './card-lifecycle.js';
import { hasEventYear, formatEventDateParts } from './ereignisse/date.js';
import { subtypIcon, bandMarkerColor, eventSpanYears, POINT_SUBTYPES } from './ereignisse/subtyp.js';
import {
  buildTimelineItems, timelineBounds, layoutBandItems, bandAxisTicks, buildBandModel,
} from './ereignisse/band.js';
import { normalizeEvent, normalizeEvents, compareEvents, sortEvents } from './ereignisse/model.js';

export { hasEventYear, formatEventDateParts };
export { subtypIcon, bandMarkerColor, eventSpanYears, POINT_SUBTYPES };
export { buildTimelineItems, timelineBounds, layoutBandItems, bandAxisTicks, buildBandModel };
export { normalizeEvent, normalizeEvents, compareEvents, sortEvents };

// Pure Filter-Logik. Aus dem memoized Wrapper extrahiert, damit sie ohne
// Alpine-Root testbar ist (siehe tests/unit/ereignisse-card-filter.test.mjs).
// Setzt die Kanonform aus `ereignisse/model.js` voraus: Kapitel/Seiten sind
// Arrays, weil beide Produzenten durch `normalizeEvent` laufen.
export function applyEreignisseFilters(events, { suche = '', figurId = '', subtyp = '', kapitel = '', seite = '' } = {}) {
  let result = events || [];
  if (suche) {
    const q = suche.toLowerCase();
    result = result.filter(ev => (ev.ereignis || '').toLowerCase().includes(q));
  }
  if (figurId) result = result.filter(ev => (ev.figuren || []).some(f => f.id === figurId));
  if (subtyp) result = result.filter(ev => (ev.subtyp || 'sonstiges') === subtyp);
  if (kapitel) result = result.filter(ev => (ev.kapitel || []).includes(kapitel));
  // Die Seiten-Achse ist an ein gewaehltes Kapitel gebunden (gleiche Seitennamen
  // koennen in mehreren Kapiteln vorkommen); die Combobox ist ohne Kapitel
  // deaktiviert.
  if (seite && kapitel) result = result.filter(ev => (ev.seiten || []).includes(seite));
  return result;
}

export function registerEreignisseCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('ereignisseCard', () => ({
    ereignisseLoading: false,
    ereignisseProgress: 0,
    ereignisseStatus: '',
    zeitstrahlConsolidating: false,
    zeitstrahlProgress: 0,
    zeitstrahlStatus: '',
    _consolidatePollTimer: null,
    _ereignisseExtractPollTimer: null,
    _lifecycle: null,
    // Ein Memo-Helper pro Modul (CLAUDE.md): filteredEreignisse()/bandModel()
    // werden im Template mehrfach pro Render gelesen → Cache mit shallow-Array-
    // Deps. Reset bei jedem Daten-Reload via this._memos = {} im load-Pfad.
    _memos: {},
    _bandRO: null,
    // Gerenderte Track-Breite (px, auf 16er gerundet gegen Resize-Thrashing).
    // Speist die Chip-Kollisionsauflösung in bandModel(); 0 = noch nicht gemessen.
    _bandWidth: 0,
    // Listen-Index des aktuell hervorgehobenen Events (Klick auf Marker oder
    // Listen-Datum). Markiert den passenden Band-Marker und scrollt ihn ins Bild.
    selectedEventIndex: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        name: 'ereignisse',
        showFlag: 'showEreignisseCard',
        timerKeys: ['_consolidatePollTimer', '_ereignisseExtractPollTimer'],
        resetState: {
          ereignisseLoading: false,
          ereignisseProgress: 0,
          ereignisseStatus: '',
          zeitstrahlConsolidating: false,
          zeitstrahlProgress: 0,
          zeitstrahlStatus: '',
          selectedEventIndex: null,
        },
        load: async (root) => {
          this._memos = {};
          await root._reloadZeitstrahl();
          // Nach dem Laden erneut spiegeln: bei einem Kaltstart (Palette-Klick,
          // Deep-Link) stand die Auswahl schon, bevor die Liste da war.
          this._syncSelectedEreignis();
        },
        refreshNeedsBookId: false,
      });
      // Auswahl (Store-SSoT, vom Hash-Router/Palette gesetzt) auf den
      // Listen-Index spiegeln, an dem der Band-Marker haengt. Die Listenzeile
      // selbst markiert sich im Template direkt ueber die ID — nur die Achse
      // rechnet in Indizes.
      this.$watch(() => Alpine.store('catalogUi').selectedEreignisId, () => this._syncSelectedEreignis());
      // Das Jahres-Band rendert deklarativ aus bandModel() (reaktiv über
      // filteredEreignisse) — kein imperativer Render-Pfad, kein Lazy-Lib-Load,
      // kein asynchrones Layout. Damit gibt es keinen Einklapp-/Expandier-Effekt.
      //
      // Track-Breite beobachten: die „+N"-Chip-Kollisionsauflösung
      // (layoutBandItems) braucht die echte Pixelbreite, um Chip-Breiten in
      // Prozent umzurechnen. ResizeObserver schreibt _bandWidth → bandModel()
      // rechnet reaktiv neu. Auf 16px gerundet, damit Sub-Pixel-Resizes nicht
      // jedes Frame ein Re-Layout auslösen.
      if (typeof ResizeObserver !== 'undefined') {
        this._bandRO = new ResizeObserver((entries) => {
          const raw = entries[0]?.contentRect?.width || 0;
          const w = Math.round(raw / 16) * 16;
          if (w && w !== this._bandWidth) this._bandWidth = w;
        });
        this.$nextTick(() => {
          if (this.$refs.bandTrack) this._bandRO.observe(this.$refs.bandTrack);
        });
      }
    },

    destroy() {
      this._bandRO?.disconnect();
      this._bandRO = null;
      this._lifecycle?.destroy();
    },

    // Ein Memo-Helper pro Modul (CLAUDE.md): Cache mit shallow-Array-Deps-
    // Vergleich (`===`). Cache hit nur wenn ALLE Deps identisch zur letzten
    // Compute. Reset über this._memos = {} (load-Pfad).
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

    // UI-Helper. Lesen $root-Filter + -Daten.
    ereignisseKapitelListe() {
      return window.__app._deriveKapitel(Alpine.store('catalog').globalZeitstrahl, ev => ev.kapitel);
    },

    ereignisseSeitenListe() {
      return window.__app._deriveSeiten(
        Alpine.store('catalog').globalZeitstrahl,
        Alpine.store('catalogUi').ereignisseFilters.kapitel,
        ev => ev.kapitel,
        ev => ev.seiten,
      );
    },

    // Liste sichtbarer Subtypen im aktuellen Buch — Filter zeigt nur was vorkommt.
    ereignisseSubtypListe() {
      const seen = new Set();
      for (const ev of (Alpine.store('catalog').globalZeitstrahl || [])) {
        seen.add(ev.subtyp || 'sonstiges');
      }
      return [...seen].sort();
    },

    // Klick-Helper: bei mehreren Kapiteln wäre `gotoStelle(kap[0], …)` falsch —
    // der Template-Loop uebergibt darum das Kapitel der geklickten Marke selbst.
    gotoEventKapitel(kapitelName, seite = null) {
      window.__app.gotoStelle(kapitelName, seite);
    },

    formatEventDate(ev) {
      return formatEventDateParts(ev, (k, p) => window.__app.t(k, p));
    },

    // Die reinen Module direkt in den Alpine-Scope haengen, statt sie durch
    // gleichnamige Wrapper zu reichen: ein zweiter Name fuer dieselbe Funktion
    // ist die Stelle, an der die beiden auseinanderlaufen.
    //   eventHasYear  — Template-Gate „hat ein Kalenderjahr" (Achsen-Sprung,
    //                   «ca.»-Hinweis, Unbekannt-Klasse der Listenzeile)
    //   eventSpanYears— Spannen-Hoehe in Jahren fuer --span-years (0 = Punkt)
    eventHasYear: hasEventYear,
    subtypIcon,
    eventSpanYears,

    filteredEreignisse() {
      const events = Alpine.store('catalog').globalZeitstrahl;
      const f = Alpine.store('catalogUi').ereignisseFilters;
      const suche = f.suche ?? '', figurId = f.figurId ?? '', kapitel = f.kapitel ?? '',
        seite = f.seite ?? '', subtyp = f.subtyp ?? '';
      return this._memo('filtered', [events, suche, figurId, kapitel, seite, subtyp],
        () => applyEreignisseFilters(events, { suche, figurId, kapitel, seite, subtyp }));
    },

    // Ausgewaehltes Ereignis (Store-ID) → Listen-Index fuer die Achsen-Markierung.
    // Kein Scroll hier: den macht `openEreignisById` ueber das `data-event-id` der
    // Zeile (gleicher Weg wie bei Figur/Ort/Szene), und zwar wartend, bis die
    // Zeile im DOM steht.
    _syncSelectedEreignis() {
      const id = Alpine.store('catalogUi').selectedEreignisId;
      if (id == null) { this.selectedEventIndex = null; return; }
      const idx = this.filteredEreignisse().findIndex(ev => ev.id === id);
      this.selectedEventIndex = idx >= 0 ? idx : null;
    },

    // Scrollt das Event am Listen-Index ins Sichtfeld (Klick auf Timeline-Item).
    // $root (Karten-Wurzel), nicht $el: aus einem @click-Handler heraus zeigt
    // $el auf das geklickte Kind (Band-Marker bzw. Achse-Hinweis), dessen
    // Subtree die Liste nicht enthält — die Suche liefe sonst leer.
    scrollToEventIndex(index) {
      const node = this.$root?.querySelector(`.global-zeitstrahl-body--card [data-ev-index="${index}"]`);
      node?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    },

    // Index des ersten undatierten Events (kein Kalenderjahr) in der gefilterten
    // Liste, oder -1. Diese Events landen nicht auf der Achse — Basis für die
    // Listen-Trennlinie (gz-section-divider) und den klickbaren Achse-Hinweis.
    // Memoisiert auf die (ihrerseits memoisierte) gefilterte Liste: ereignisse.html
    // liest den Index ZWEIMAL pro Ereigniszeile (Trennlinie + Achse-Hinweis), und
    // bei durchgaengig datierten Buechern laeuft jeder Aufruf die ganze Liste ab —
    // ungecacht ist die Liste damit O(Ereignisse²).
    firstUndatedIndex() {
      const list = this.filteredEreignisse();
      return this._memo('firstUndated', [list], () => {
        for (let i = 0; i < list.length; i++) if (!hasEventYear(list[i])) return i;
        return -1;
      });
    },

    // Klick auf den Achse-Hinweis → zum ersten undatierten Listeneintrag scrollen.
    scrollToFirstUndated() {
      const idx = this.firstUndatedIndex();
      if (idx >= 0) this.scrollToEventIndex(idx);
    },

    // Liste → Band: hebt den Marker zum Listen-Index hervor und scrollt ihn
    // horizontal ins Bild. No-op für undatierte Events (kein Marker auf der Achse).
    selectTimelineEvent(index) {
      this.selectedEventIndex = index;
      this.$nextTick(() => {
        const marker = this.$root?.querySelector(`.gz-band-marker[data-ev-index="${index}"]`);
        marker?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
      });
    },

    // Achse/Zeile → Manuskript: öffnet die erste verknüpfte Seite, sonst das
    // erste Kapitel. Liefert true, wenn ein Sprungziel existiert.
    openEventText(ev) {
      if (!ev) return false;
      const pageId = ev.page_ids?.[0];
      if (pageId != null) { window.__app.gotoPageById(pageId); return true; }
      const kap = ev.kapitel?.[0];
      if (kap) { window.__app.gotoStelle(kap, null); return true; }
      return false;
    },

    // True, wenn openEventText ein Ziel hätte (steuert .internal-link-Affordance).
    eventHasTarget(ev) {
      return ev?.page_ids?.[0] != null || !!ev?.kapitel?.[0];
    },

    // --- Jahres-Band ---------------------------------------------------------
    // Anzeige-Modell (Achsen-Ticks + Lane-gepackte Marker), gecacht über die
    // Identität der gefilterten Liste — filteredEreignisse() liefert dieselbe
    // Array-Referenz solange Daten/Filter unverändert, also rechnet das Layout
    // nur bei echtem Wechsel neu. Das Template ruft bandModel() mehrfach pro
    // Render (Höhe, Tick-Loop, Marker-Loop) — Memo hält das Layout stabil.
    bandModel() {
      const events = this.filteredEreignisse();
      return this._memo('band', [events, this._bandWidth],
        () => buildBandModel(events, this._bandWidth));
    },

    // Anzahl datierter Events (auf der Achse). Treibt die Sichtbarkeit des Bands
    // und den Hinweis auf undatierte Events. Getter statt State — kein
    // imperativer Render mehr, der ihn pflegen müsste.
    get timelineItemCount() {
      return this.bandModel().itemCount;
    },

    // Inline-CSS-Props eines Markers: x-Position (Prozent), Spur (Lane → top via
    // calc in der CSS), Akzentfarbe, sowie Breite bei Spannen. `:style`-Binding
    // mit Custom-Props ist das etablierte Muster (vgl. --span-years/--progress).
    bandMarkerStyle(m) {
      const style = {
        left: m.x.toFixed(3) + '%',
        '--gz-band-lane': m.lane,
        '--gz-marker-color': m.kind === 'more' ? 'var(--color-muted)' : bandMarkerColor(m.subtyp, m.extern),
      };
      if (m.isRange) style.width = m.widthPct.toFixed(3) + '%';
      return style;
    },

    // Klick auf einen Band-Marker → zum Listeneintrag scrollen + hervorheben.
    onBandMarkerClick(index) {
      this.selectedEventIndex = index;
      this.scrollToEventIndex(index);
    },
  }));
}
