// Geometrie-Schicht des Jahres-Bands: uebersetzt die (gefilterte) Event-Liste in
// Achsen-Items, packt sie in Spuren und berechnet die Achsen-Ticks. Reine
// Funktionen ohne Alpine und ohne DOM — direkt testbar
// (tests/unit/ereignisse-card-filter.test.mjs). Die Karte
// (../ereignisse-card.js) importiert und re-exportiert sie.
import { validYear, validMonth, validDay, hasEventYear, eventDate } from './date.js';
import { POINT_SUBTYPES } from './subtyp.js';

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
    const start = eventDate(validYear(ev.datum_year), validMonth(ev.datum_month), validDay(ev.datum_day));
    const item = {
      id: i,
      start,
      extern: ev.typ === 'extern',
      subtyp: ev.subtyp || 'sonstiges',
      content: ev.ereignis || '',
    };
    if (validYear(ev.datum_ende_year) !== null && !POINT_SUBTYPES.has(item.subtyp)) {
      const end = eventDate(validYear(ev.datum_ende_year), validMonth(ev.datum_ende_month), validDay(ev.datum_ende_day));
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
