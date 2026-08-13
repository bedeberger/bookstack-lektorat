// Alpine.data('ereignisseCard') — Sub-Komponente der Zeitstrahl-Karte.
//
// Eigener State: Meta-Flags (Loading/Status/Progress/PollTimer) + UI-Helper.
// Geteilt:
//   - `globalZeitstrahl` (Alpine.store('catalog'))
//   - `ereignisseFilters` (Alpine.store('catalogUi') — app-navigation schreibt darauf)
// Root behält:
//   - `_buildGlobalZeitstrahl` (wird aus figuren.js / loadFiguren gerufen)
//   - `_reloadZeitstrahl` (wird aus app-komplett.js gerufen)
import { setupCardLifecycle } from './card-lifecycle.js';
// Datums-Schicht (Gültigkeit + Anzeige-Format) — reine Funktionen im Subfolder,
// hier re-exportiert, damit Tests und Konsumenten einen Einstieg behalten.
import {
  validYear as _validYear, validMonth as _validMonth, validDay as _validDay,
  hasEventYear, eventDate as _eventDate, formatEventDateParts,
} from './ereignisse/date.js';
export { hasEventYear, formatEventDateParts };

// Pure Filter-Logik. Aus dem memoized Wrapper extrahiert, damit sie ohne
// Alpine-Root testbar ist (siehe tests/unit/ereignisse-card-filter.test.mjs).
export function applyEreignisseFilters(events, { suche = '', figurId = '', subtyp = '', kapitel = '', seite = '' } = {}) {
  let result = events || [];
  if (suche) {
    const q = suche.toLowerCase();
    result = result.filter(ev => (ev.ereignis || '').toLowerCase().includes(q));
  }
  if (figurId) result = result.filter(ev => (ev.figuren || []).some(f => f.id === figurId));
  if (subtyp) result = result.filter(ev => (ev.subtyp || 'sonstiges') === subtyp);
  if (kapitel) {
    result = result.filter(ev => {
      const kap = Array.isArray(ev.kapitel) ? ev.kapitel : (ev.kapitel ? [ev.kapitel] : []);
      return kap.includes(kapitel);
    });
  }
  if (seite && kapitel) {
    result = result.filter(ev => {
      const seiten = Array.isArray(ev.seiten) ? ev.seiten : (ev.seite ? [ev.seite] : []);
      return seiten.includes(seite);
    });
  }
  return result;
}

// Pure: übersetzt die (gefilterte) Event-Liste in normalisierte Achsen-Items für
// das Jahres-Band. Nur datierte Events (datum_year gesetzt) landen auf der Achse
// — story_tag/undatiert bleiben nur in der Liste. id = Listen-Index (Brücke zu
// [data-ev-index] für Klick→Scroll). Spannen (datum_ende_year) werden zu Range-
// Items. subtyp trägt die Farbcodierung der Liste auf die Achse. Speist
// layoutBandItems; extrahiert für Tests (ereignisse-card-filter.test.mjs).
export function buildTimelineItems(events) {
  const items = [];
  (events || []).forEach((ev, i) => {
    if (!hasEventYear(ev)) return;
    const start = _eventDate(_validYear(ev.datum_year), _validMonth(ev.datum_month), _validDay(ev.datum_day));
    const item = {
      id: i,
      start,
      extern: ev.typ === 'extern',
      subtyp: ev.subtyp || 'sonstiges',
      content: ev.ereignis || '',
    };
    if (_validYear(ev.datum_ende_year) !== null && !POINT_SUBTYPES.has(item.subtyp)) {
      const end = _eventDate(_validYear(ev.datum_ende_year), _validMonth(ev.datum_ende_month), _validDay(ev.datum_ende_day));
      if (end > start) { item.end = end; item.type = 'range'; }
      else item.type = 'point';
    } else {
      item.type = 'point';
    }
    items.push(item);
  });
  return items;
}

// Pure: früheste Start- und späteste End-/Start-Zeit (ms) der datierten
// Timeline-Items. Basis für die Sprung-Buttons (moveTo). null bei leerer Liste.
// Extrahiert für Tests (ereignisse-card-filter.test.mjs).
export function timelineBounds(items) {
  const list = items || [];
  let min = Infinity, max = -Infinity;
  for (const it of list) {
    const s = +new Date(it.start);
    const e = it.end != null ? +new Date(it.end) : s;
    if (s < min) min = s;
    if (e > max) max = e;
  }
  return Number.isFinite(min) ? { min, max } : null;
}

// Jahr → ms (Jan 1, lokale Mitternacht). Gleiche Basis wie _eventDate, damit
// Achsen-Ticks und Marker auf derselben Skala sitzen.
function _yearToMs(year) {
  const d = new Date(0);
  d.setFullYear(year, 0, 1);
  d.setHours(0, 0, 0, 0);
  return +d;
}

// Pure: ordnet datierte Timeline-Items (aus buildTimelineItems) in eine
// Säulen-Dichte an und berechnet ihre x-Position als Prozent entlang [min..max].
// Statt greedy über die Breite zu streuen (zerstreutes „Konfetti") werden
// Punkt-Events nach x-Spalte gebündelt und vom Baseline (Spur 0, unten) nach
// oben gestapelt: hohe Säule = ereignisreiches Jahr, lesbar wie ein farbiges
// Histogramm. `lane` zählt von der Baseline aufwärts; CSS verankert unten.
//
// Spannen (datum_ende) liegen als horizontale Balken auf den untersten Spuren
// (unter sich greedy gepackt); Punkte stapeln darüber (baseLane = #Spannen-Spuren).
//
// Höhe gedeckelt bei maxLanes: in dichten Jahren (z.B. viele Geburten) würde
// striktes Einzeln-Stapeln zweistellige Spurenzahlen erzwingen. Läuft eine Säule
// über, ersetzt EIN „+N"-Marker (kind:'more') die oberste Zelle der Säule statt
// als Extra-Blase zu kollidieren — die Achse bleibt flach. Kein stilles
// Wegschneiden: jedes überzählige Event zählt in count, Klick springt zum ersten
// in der Liste.
//
// `lane`/`x`/`widthPct` werden vom Template in CSS-Custom-Props übersetzt.
// Extrahiert für Tests (ereignisse-card-filter.test.mjs).
//
// `bandWidthPx` = real gerenderte Track-Breite (vom ResizeObserver der Karte):
// nötig, weil die „+N"-Chips Text tragen und damit breiter sind als ein
// Punkt-Marker. In dichten Spannen (viele Jahre → schmale Spalten) bleiben die
// Chip-Boxen benachbarter Säulen sonst nicht auf Distanz und ihre Zahlen
// überlappen sich („+10-10"). Mit bekannter Pixelbreite lässt sich die Chip-
// Breite in Prozent umrechnen und kollidierende Chips werden links→rechts zu
// einem Sammel-Chip verschmolzen (Counts addiert, Klick springt zum ersten).
// `bandWidthPx = 0` (Tests, erster Paint vor der Messung) ⇒ kein Merge.
export function layoutBandItems(items, { minSlotPct = 1.4, maxLanes = 12, bandWidthPx = 0 } = {}) {
  const bounds = timelineBounds(items);
  if (!bounds) return { lanes: 0, markers: [], bounds: null };
  const spanMs = Math.max(1, bounds.max - bounds.min);
  const toPct = (ms) => ((ms - bounds.min) / spanMs) * 100;
  // Nach Start sortieren (defensiv) + Original-id für Klick→Liste behalten.
  const sorted = [...(items || [])].sort((a, b) => (+new Date(a.start)) - (+new Date(b.start)));
  const ranges = sorted.filter(it => it.type === 'range' && it.end != null);
  const points = sorted.filter(it => !(it.type === 'range' && it.end != null));
  let markers = [];
  let usedLanes = 0;

  // 1) Spannen: greedy unter sich lane-packen → liegen als Balken auf den
  //    untersten Spuren. Punkte stapeln darüber.
  const rangeLaneEnd = [];
  for (const it of ranges) {
    const x = toPct(+new Date(it.start));
    const xEnd = toPct(+new Date(it.end));
    const slotEnd = Math.max(xEnd, x + minSlotPct);
    let lane = 0;
    while (lane < rangeLaneEnd.length && rangeLaneEnd[lane] > x + 0.0001) lane++;
    if (lane >= maxLanes) lane = maxLanes - 1; // Notfall: Spannen kollabieren
    rangeLaneEnd[lane] = slotEnd;
    if (lane + 1 > usedLanes) usedLanes = lane + 1;
    markers.push({
      kind: 'event', id: it.id, x, lane, isRange: true,
      widthPct: Math.max(xEnd - x, minSlotPct),
      subtyp: it.subtyp || 'sonstiges', extern: !!it.extern, content: it.content || '',
    });
  }
  const baseLane = rangeLaneEnd.length;     // Punkte beginnen über den Spannen
  const capacity = Math.max(1, maxLanes - baseLane); // Punkt-Spuren pro Säule

  // 2) Punkte je Kalenderjahr zu einer Säule bündeln (nicht nach x-Spalte —
  //    sonst spalten sich Monate desselben Jahres in Nachbar-Säulchen auf).
  //    Repräsentant-x = erstes (frühestes) Event des Jahres, damit Einzel-Events
  //    ihre exakte Position (inkl. Boundary 0%/100%) behalten.
  const cols = new Map();
  for (const it of points) {
    const start = new Date(it.start);
    const colKey = start.getFullYear();
    let col = cols.get(colKey);
    if (!col) { col = { x: toPct(+start), items: [] }; cols.set(colKey, col); }
    col.items.push(it);
  }

  for (const col of cols.values()) {
    const list = col.items;                      // bereits nach start sortiert
    const overflow = list.length > capacity;
    const showN = overflow ? capacity - 1 : list.length; // Platz für +N-Zelle
    for (let i = 0; i < showN; i++) {
      const it = list[i];
      const lane = baseLane + i;
      if (lane + 1 > usedLanes) usedLanes = lane + 1;
      markers.push({
        kind: 'event', id: it.id, x: col.x, lane, isRange: false, widthPct: 0,
        subtyp: it.subtyp || 'sonstiges', extern: !!it.extern, content: it.content || '',
      });
    }
    if (overflow) {
      const lane = baseLane + capacity - 1;      // oberste Zelle der Säule
      if (lane + 1 > usedLanes) usedLanes = lane + 1;
      markers.push({ kind: 'more', id: list[showN].id, x: col.x, lane, count: list.length - showN });
    }
  }

  // 3) „+N"-Chips kollisionsfrei machen: bei bekannter Pixelbreite benachbarte
  //    Chips, deren Text-Boxen überlappen würden, links→rechts verschmelzen
  //    (Count addiert, Lane = oberste der Gruppe, x = Mitte, Klick-id = erster).
  //    Kollisionsprüfung ist *paarweise* zwischen benachbarten Original-Chips
  //    (Anker = x + Eigenbreite des letzten Mitglieds), NICHT gegen die wachsende
  //    Gruppen-Summe — sonst kettet ein bereits dicker Chip immer weitere
  //    Nachbarn an und es entsteht ein einziges Riesen-„+N". So bleiben in einer
  //    dichten Strecke mehrere kleine Chips statt eines opaken Klumpens.
  if (bandWidthPx > 0) {
    const more = markers.filter(m => m.kind === 'more').sort((a, b) => a.x - b.x);
    if (more.length > 1) {
      const halfPct = (count) => {
        // grobe Chip-Breite: min-width + Padding + ~Zeichenbreite des Labels.
        const px = Math.max(11, 14 + 6.5 * String('+' + count).length);
        return (px / 2) / bandWidthPx * 100;
      };
      const gapPct = 3 / bandWidthPx * 100;       // Mindestabstand zwischen Chips
      const groups = [];
      let cur = null;
      for (const m of more) {
        // Überlappt m mit dem zuletzt einsortierten Chip (dessen Eigenbreite)?
        if (cur && (m.x - cur.lastX) < halfPct(cur.lastCount) + halfPct(m.count) + gapPct) {
          cur.count += m.count;
          cur.xRight = m.x;
          cur.lastX = m.x;
          cur.lastCount = m.count;
          cur.lane = Math.max(cur.lane, m.lane);
          continue;
        }
        cur = { kind: 'more', id: m.id, xLeft: m.x, xRight: m.x, lastX: m.x, lastCount: m.count, lane: m.lane, count: m.count };
        groups.push(cur);
      }
      const mergedMore = groups.map(g => ({
        kind: 'more', id: g.id, x: (g.xLeft + g.xRight) / 2, lane: g.lane, count: g.count,
      }));
      markers = markers.filter(m => m.kind !== 'more').concat(mergedMore);
    }
  }

  return { lanes: Math.min(usedLanes, maxLanes), markers, bounds };
}

// Pure: "nette" Jahres-Ticks für die Achsenbeschriftung. Schrittweite aus einer
// festen Leiter (1/2/5/10/…) so gewählt, dass ~targetTicks Beschriftungen
// entstehen. Liefert [{ year, x }] (x = Prozent). Extrahiert für Tests.
export function bandAxisTicks(bounds, { targetTicks = 6 } = {}) {
  if (!bounds) return [];
  const y0 = new Date(bounds.min).getFullYear();
  const y1 = new Date(bounds.max).getFullYear();
  const yearsSpan = Math.max(1, y1 - y0);
  const ladder = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000];
  const step = ladder.find(s => yearsSpan / s <= targetTicks) || ladder[ladder.length - 1];
  const spanMs = Math.max(1, bounds.max - bounds.min);
  const start = Math.ceil(y0 / step) * step;
  const ticks = [];
  for (let y = start; y <= y1; y += step) {
    ticks.push({ year: y, x: ((_yearToMs(y) - bounds.min) / spanMs) * 100 });
  }
  if (!ticks.length) ticks.push({ year: y0, x: 0 }); // sehr kurze Spanne → Start-Jahr
  return ticks;
}

// Pure: komplettes Anzeige-Modell des Jahres-Bands aus der (gefilterten) Event-
// Liste. itemCount = Anzahl datierter Items (achsen-fähig; undatierte bleiben nur
// in der Liste), lanes/markers fürs Layout, ticks für die Achse. Extrahiert für
// Tests; in der Karte via _memo('band') über die gefilterte Liste gecacht.
export function buildBandModel(events, bandWidthPx = 0) {
  const items = buildTimelineItems(events);
  const { lanes, markers, bounds } = layoutBandItems(items, { bandWidthPx });
  return { itemCount: items.length, lanes, markers, ticks: bandAxisTicks(bounds), bounds };
}

// Mapping Subtyp → Lucide-Sprite-Icon-ID. Whitelist deckungsgleich mit
// prompts/komplett.js + i18n events.subtyp.*. Unbekannte/ungültige Subtypen
// fallen auf 'sonstiges' → more-horizontal.
const SUBTYP_ICON = {
  geburt:            'baby',
  tod:               'skull',
  hochzeit:          'heart',
  liebe:             'heart-handshake',
  trennung:          'heart-off',
  krankheit:         'activity',
  reise:             'plane',
  umzug:             'truck',
  konflikt:          'swords',
  wendepunkt:        'git-fork',
  entdeckung:        'compass',
  verlust:           'heart-crack',
  sieg:              'trophy',
  extern_politisch:  'landmark',
  extern_wirtschaftlich: 'banknote',
  extern_natur:      'mountain',
  extern_kulturell:  'book-open',
  extern_krieg:      'bomb',
  sonstiges:         'more-horizontal',
};
export function subtypIcon(subtyp) {
  return SUBTYP_ICON[subtyp] || SUBTYP_ICON.sonstiges;
}

// Subtyp → Akzentfarbe des Band-Markers. Token-SSoT: `--card-accent-event-*`
// (public/css/tokens/colors.css), gleiche Codierung wie die Listen-Badges.
// Unbekannte Subtypen fallen auf 'sonstiges'; extern (Weltgeschehen) übersteuert
// mit der Error-Randfarbe — analog zur Listen-Darstellung.
const _SUBTYP_KEYS = new Set(Object.keys(SUBTYP_ICON));
export function bandMarkerColor(subtyp, extern) {
  if (extern) return 'var(--color-err-border)';
  const key = _SUBTYP_KEYS.has(subtyp) ? subtyp : 'sonstiges';
  return `var(--card-accent-event-${key})`;
}

// Instantane Subtypen (Momente, kein Zeitraum): bekommen nie einen Span-Balken,
// auch wenn die Daten ein Ende-Jahr tragen (z.B. Geburt mit Ende = „Jetzt" der
// Geschichte → sonst 50-Jahre-Spanne statt Punkt). Dauer-fähige Subtypen
// (liebe, krankheit, reise, umzug, konflikt, extern_*) bleiben Spannen.
export const POINT_SUBTYPES = new Set([
  'geburt', 'tod', 'hochzeit', 'trennung',
  'wendepunkt', 'entdeckung', 'sieg', 'verlust',
]);


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
        ev => Array.isArray(ev.seiten) ? ev.seiten : ev.seite,
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

    // Klick-Helper: bei mehreren Kapiteln wäre `gotoStelle(kap[0], …)` falsch.
    // Wir geben dem Template-Loop einen direkten Helper, damit die Multi-Kapitel-
    // Liste pro Kapitel-Span einzeln öffnet.
    gotoEventKapitel(ev, kapitelName, seite = null) {
      window.__app.gotoStelle(kapitelName, seite);
    },

    formatEventDate(ev) {
      return formatEventDateParts(ev, (k, p) => window.__app.t(k, p));
    },

    // Template-Gate für „hat ein Kalenderjahr" — steuert Achsen-Sprung,
    // «ca.»-Hinweis und die Unbekannt-Klasse der Listenzeile.
    eventHasYear(ev) {
      return hasEventYear(ev);
    },

    subtypIcon(subtyp) {
      return subtypIcon(subtyp);
    },

    // Span-Höhe (Spannen-Events): proportional zur Jahr-Differenz, geclampt.
    // Wird per CSS-Custom-Prop --span-years konsumiert. 0 für Punkt-Events.
    eventSpanYears(ev) {
      const y = _validYear(ev.datum_year), ye = _validYear(ev.datum_ende_year);
      if (y === null || ye === null) return 0;
      if (POINT_SUBTYPES.has(ev.subtyp || 'sonstiges')) return 0;
      const diff = ye - y;
      return diff > 0 ? Math.min(diff, 50) : 0;
    },

    filteredEreignisse() {
      const events = Alpine.store('catalog').globalZeitstrahl;
      const f = Alpine.store('catalogUi').ereignisseFilters;
      const suche = f.suche ?? '', figurId = f.figurId ?? '', kapitel = f.kapitel ?? '',
        seite = f.seite ?? '', subtyp = f.subtyp ?? '';
      return this._memo('filtered', [events, suche, figurId, kapitel, seite, subtyp],
        () => applyEreignisseFilters(events, { suche, figurId, kapitel, seite, subtyp }));
    },

    // Ausgewaehltes Ereignis (Store-ID) → Listen-Index fuer die Achsen-Markierung.
    // Kein Scroll hier: den macht `openEreignisById` ueber das `data-evid` der
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
    firstUndatedIndex() {
      const list = this.filteredEreignisse();
      for (let i = 0; i < list.length; i++) if (!hasEventYear(list[i])) return i;
      return -1;
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
        const marker = this.$root?.querySelector(`.gz-band-marker[data-ev-id="${index}"]`);
        marker?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
      });
    },

    // Achse/Zeile → Manuskript: öffnet die erste verknüpfte Seite, sonst das
    // erste Kapitel. Liefert true, wenn ein Sprungziel existiert.
    openEventText(ev) {
      if (!ev) return false;
      const pageId = Array.isArray(ev.page_ids) ? ev.page_ids[0] : null;
      if (pageId != null) { window.__app.gotoPageById(pageId); return true; }
      const kap = Array.isArray(ev.kapitel) ? ev.kapitel[0] : ev.kapitel;
      if (kap) { window.__app.gotoStelle(kap, null); return true; }
      return false;
    },

    // True, wenn openEventText ein Ziel hätte (steuert .internal-link-Affordance).
    eventHasTarget(ev) {
      const pageId = Array.isArray(ev?.page_ids) ? ev.page_ids[0] : null;
      const kap = Array.isArray(ev?.kapitel) ? ev.kapitel[0] : ev?.kapitel;
      return pageId != null || !!kap;
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
