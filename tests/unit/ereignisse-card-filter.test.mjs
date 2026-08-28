// Unit-Tests für den Filter der Ereignisse-Karte
// (`applyEreignisseFilters` aus public/js/cards/ereignisse-card.js).
//
// Filter kombinieren `suche`, `figurId`, `subtyp`, `kapitel`, `seite`. Seiten-
// Filter greift nur in Kombination mit Kapitel (sonst „alle Seiten dieses Buchs"
// → unsinnig). Subtyp-Default ist 'sonstiges' (Events ohne `subtyp`-Feld matchen
// also nur, wenn als 'sonstiges' gefiltert wird). Mapping Subtyp → Lucide-Icon
// wird ebenfalls hier getestet (`subtypIcon`).
//
// Die Fixture mischt bewusst beide Produzenten-Formen (Server: Listen;
// Figuren-Fallback: Skalare) und schickt sie durch `normalizeEvents` — genau so
// laeuft es in der App: normalisiert wird EINMAL am Store-Schreibpfad
// (book/ereignisse.js), der Filter sieht nur noch die Kanonform.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  applyEreignisseFilters, subtypIcon, buildTimelineItems, timelineBounds,
  layoutBandItems, bandAxisTicks, buildBandModel, bandMarkerColor, normalizeEvents,
} = await import('../../public/js/cards/ereignisse-card.js');

const EVENTS = normalizeEvents([
  {
    id: 1, ereignis: 'Hochzeit auf dem Hügel', subtyp: 'hochzeit',
    figuren: [{ id: 'fA' }, { id: 'fB' }],
    kapitel: ['Kapitel 1'], seiten: ['1', '2'],
  },
  {
    id: 2, ereignis: 'Tod des Vaters', subtyp: 'tod',
    figuren: [{ id: 'fA' }],
    kapitel: 'Kapitel 1', seite: '3',
  },
  {
    id: 3, ereignis: 'Reise nach Norden', subtyp: 'reise',
    figuren: [{ id: 'fB' }, { id: 'fC' }],
    kapitel: ['Kapitel 2'], seiten: ['10'],
  },
  {
    id: 4, ereignis: 'Anonymer Vorfall', /* kein subtyp */
    figuren: [],
    kapitel: ['Kapitel 2'], seiten: ['11'],
  },
]);

// ── kein Filter ─────────────────────────────────────────────────────────────

test('ohne Filter: alle Events durchgereicht', () => {
  const out = applyEreignisseFilters(EVENTS, {});
  assert.equal(out.length, 4);
});

test('kein Crash bei undefiniertem events-Argument', () => {
  assert.deepEqual(applyEreignisseFilters(undefined, {}), []);
  assert.deepEqual(applyEreignisseFilters(null, { suche: 'x' }), []);
});

// ── Such-Filter ─────────────────────────────────────────────────────────────

test('Such-Filter matcht ereignis case-insensitive', () => {
  const out = applyEreignisseFilters(EVENTS, { suche: 'HOCHZEIT' });
  assert.deepEqual(out.map(e => e.id), [1]);
});

test('Such-Filter matcht Teilstring', () => {
  const out = applyEreignisseFilters(EVENTS, { suche: 'reise' });
  assert.deepEqual(out.map(e => e.id), [3]);
});

test('Such-Filter ohne Match → leer', () => {
  const out = applyEreignisseFilters(EVENTS, { suche: 'xxxxxx' });
  assert.equal(out.length, 0);
});

// ── Figur-Filter ────────────────────────────────────────────────────────────

test('Figur-Filter matcht über figuren[].id', () => {
  const out = applyEreignisseFilters(EVENTS, { figurId: 'fA' });
  assert.deepEqual(out.map(e => e.id).sort(), [1, 2]);
});

test('Figur-Filter ignoriert Events ohne figuren-Array', () => {
  const out = applyEreignisseFilters(EVENTS, { figurId: 'fX' });
  assert.equal(out.length, 0);
});

// ── Subtyp-Filter ───────────────────────────────────────────────────────────

test('Subtyp-Filter: exakter Match', () => {
  const out = applyEreignisseFilters(EVENTS, { subtyp: 'tod' });
  assert.deepEqual(out.map(e => e.id), [2]);
});

test("Subtyp-Filter 'sonstiges' matcht Events ohne subtyp-Feld", () => {
  const out = applyEreignisseFilters(EVENTS, { subtyp: 'sonstiges' });
  assert.deepEqual(out.map(e => e.id), [4]);
});

test('Subtyp-Filter ohne Match → leer', () => {
  const out = applyEreignisseFilters(EVENTS, { subtyp: 'geburt' });
  assert.equal(out.length, 0);
});

// ── Kapitel-Filter (Multi-Kapitel Array + Legacy-String) ───────────────────

test('Kapitel-Filter matcht Array-Form', () => {
  const out = applyEreignisseFilters(EVENTS, { kapitel: 'Kapitel 2' });
  assert.deepEqual(out.map(e => e.id).sort(), [3, 4]);
});

test('Kapitel-Filter matcht auch die Skalar-Form des Fallback-Pfads', () => {
  const out = applyEreignisseFilters(EVENTS, { kapitel: 'Kapitel 1' });
  assert.deepEqual(out.map(e => e.id).sort(), [1, 2]);
});

// ── Seiten-Filter (nur gemeinsam mit Kapitel) ──────────────────────────────

test('Seiten-Filter greift nur in Kombination mit Kapitel', () => {
  const ohneKapitel = applyEreignisseFilters(EVENTS, { seite: '1' });
  assert.equal(ohneKapitel.length, 4, 'ohne kapitel: seite ignoriert');
  const mitKapitel = applyEreignisseFilters(EVENTS, { kapitel: 'Kapitel 1', seite: '1' });
  assert.deepEqual(mitKapitel.map(e => e.id), [1]);
});

test('Seiten-Filter: Listen- und Skalar-Herkunft sind nach der Normalisierung gleich', () => {
  const ausListe = applyEreignisseFilters(EVENTS, { kapitel: 'Kapitel 1', seite: '2' });
  assert.deepEqual(ausListe.map(e => e.id), [1]);   // kam als seiten: ['1','2']
  const ausSkalar = applyEreignisseFilters(EVENTS, { kapitel: 'Kapitel 1', seite: '3' });
  assert.deepEqual(ausSkalar.map(e => e.id), [2]);  // kam als seite: '3'
});

// ── Kombination ─────────────────────────────────────────────────────────────

test('Kombi: Subtyp + Figur', () => {
  const out = applyEreignisseFilters(EVENTS, { subtyp: 'hochzeit', figurId: 'fA' });
  assert.deepEqual(out.map(e => e.id), [1]);
});

test('Kombi: Subtyp + Kapitel + Such-Filter', () => {
  const out = applyEreignisseFilters(EVENTS, {
    subtyp: 'reise',
    kapitel: 'Kapitel 2',
    suche: 'norden',
  });
  assert.deepEqual(out.map(e => e.id), [3]);
});

// ── subtypIcon-Mapping ─────────────────────────────────────────────────────

test('subtypIcon: vollständige Whitelist auf Lucide-IDs gemappt', () => {
  const map = {
    geburt:           'baby',
    tod:              'skull',
    hochzeit:         'heart',
    reise:            'plane',
    konflikt:         'swords',
    wendepunkt:       'git-fork',
    entdeckung:       'compass',
    verlust:          'heart-crack',
    sieg:             'trophy',
    extern_politisch: 'landmark',
    extern_natur:     'mountain',
    extern_kulturell: 'book-open',
    sonstiges:        'more-horizontal',
  };
  for (const [subtyp, icon] of Object.entries(map)) {
    assert.equal(subtypIcon(subtyp), icon, `${subtyp} → ${icon}`);
  }
});

test('subtypIcon: unbekannter Subtyp → sonstiges-Fallback', () => {
  assert.equal(subtypIcon('schwurbel'),  'more-horizontal');
  assert.equal(subtypIcon(undefined),    'more-horizontal');
  assert.equal(subtypIcon(null),         'more-horizontal');
  assert.equal(subtypIcon(''),           'more-horizontal');
});

// --- Achsen-Items (Jahres-Band) ---

test('buildTimelineItems: nur datierte Events landen auf der Achse, id = Listen-Index', () => {
  const items = buildTimelineItems([
    { datum_year: 1990, ereignis: 'A' },   // 0 → Punkt
    { story_tag: 'Tag 3', ereignis: 'B' }, // 1 → übersprungen (kein Jahr)
    {},                                     // 2 → übersprungen
    { datum_year: 1995, ereignis: 'C' },   // 3 → Punkt
  ]);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map(i => i.id), [0, 3]);
  assert.equal(items[0].type, 'point');
  assert.equal(items[0].content, 'A');
  assert.equal(items[0].start.getFullYear(), 1990);
});

test('buildTimelineItems: Spanne mit Ende-Jahr → Range-Item', () => {
  const [item] = buildTimelineItems([
    { datum_year: 1980, datum_ende_year: 1985, ereignis: 'Krieg' },
  ]);
  assert.equal(item.type, 'range');
  assert.equal(item.start.getFullYear(), 1980);
  assert.equal(item.end.getFullYear(), 1985);
});

test('buildTimelineItems: instantaner Subtyp ignoriert Ende-Jahr → Punkt', () => {
  // Geburt mit Ende = „Jetzt" der Geschichte darf keine 50-Jahre-Spanne werden.
  const [item] = buildTimelineItems([
    { datum_year: 1970, datum_ende_year: 2022, subtyp: 'geburt', ereignis: 'Geburt' },
  ]);
  assert.equal(item.type, 'point');
  assert.equal(item.end, undefined);
});

test('buildTimelineItems: Ende <= Start fällt auf Punkt zurück', () => {
  const [item] = buildTimelineItems([
    { datum_year: 1980, datum_ende_year: 1980, ereignis: 'X' },
  ]);
  assert.equal(item.type, 'point');
  assert.equal(item.end, undefined);
});

test('buildTimelineItems: extern-Flag aus typ', () => {
  const [a, b] = buildTimelineItems([
    { datum_year: 1990, typ: 'extern', ereignis: 'Welt' },
    { datum_year: 1991, typ: 'persoenlich', ereignis: 'Privat' },
  ]);
  assert.equal(a.extern, true);
  assert.equal(b.extern, false);
});

test('buildTimelineItems: subtyp wird durchgereicht (Achsen-Farbcodierung)', () => {
  const [a, b] = buildTimelineItems([
    { datum_year: 1990, subtyp: 'geburt', ereignis: 'A' },
    { datum_year: 1991, /* kein subtyp */ ereignis: 'B' },
  ]);
  assert.equal(a.subtyp, 'geburt');
  assert.equal(b.subtyp, 'sonstiges', 'fehlender Subtyp → sonstiges-Fallback');
});

test('buildTimelineItems: frühes Jahr (<100) wird nicht auf 1900+ gemappt', () => {
  const [item] = buildTimelineItems([{ datum_year: 50, ereignis: 'Antike' }]);
  assert.equal(item.start.getFullYear(), 50);
});

test('buildTimelineItems: leere/fehlende Liste → []', () => {
  assert.deepEqual(buildTimelineItems([]), []);
  assert.deepEqual(buildTimelineItems(undefined), []);
});

// --- timelineBounds (Sprung-Buttons: früheste/späteste Achsenzeit) ---

test('timelineBounds: min = frühester Start, max = spätestes Ende/Start', () => {
  const items = buildTimelineItems([
    { datum_year: 1990, ereignis: 'A' },
    { datum_year: 1980, datum_ende_year: 1985, ereignis: 'Spanne' },
    { datum_year: 2000, ereignis: 'C' },
  ]);
  const b = timelineBounds(items);
  assert.equal(new Date(b.min).getFullYear(), 1980, 'min = frühester Start');
  assert.equal(new Date(b.max).getFullYear(), 2000, 'max = spätester Start/Ende');
});

test('timelineBounds: Spannen-Ende zählt für max', () => {
  const items = buildTimelineItems([
    { datum_year: 1990, ereignis: 'A' },
    { datum_year: 1995, datum_ende_year: 2010, ereignis: 'lange Spanne' },
  ]);
  const b = timelineBounds(items);
  assert.equal(new Date(b.max).getFullYear(), 2010);
});

test('timelineBounds: leere/fehlende Liste → null', () => {
  assert.equal(timelineBounds([]), null);
  assert.equal(timelineBounds(undefined), null);
});

// --- layoutBandItems (Lane-Packing + x-Position) ---

test('layoutBandItems: leere Items → 0 Lanes, keine Marker', () => {
  const r = layoutBandItems(buildTimelineItems([]));
  assert.equal(r.lanes, 0);
  assert.deepEqual(r.markers, []);
  assert.equal(r.bounds, null);
});

test('layoutBandItems: x in Prozent über [min..max], Ränder bei 0% und 100%', () => {
  const items = buildTimelineItems([
    { datum_year: 1900, ereignis: 'A' },
    { datum_year: 1950, ereignis: 'B' },
    { datum_year: 2000, ereignis: 'C' },
  ]);
  const { markers } = layoutBandItems(items);
  const byId = Object.fromEntries(markers.map(m => [m.id, m]));
  assert.equal(byId[0].x.toFixed(1), '0.0', 'frühestes Event ganz links');
  assert.equal(byId[2].x.toFixed(1), '100.0', 'spätestes Event ganz rechts');
  assert.ok(byId[1].x > 49 && byId[1].x < 51, 'mittleres Event ~50%');
});

test('layoutBandItems: kollidierende Events bekommen getrennte Spuren', () => {
  // Drei Events im selben Jahr → können nicht in einer Spur ohne Überlappung.
  const items = buildTimelineItems([
    { datum_year: 1980, ereignis: 'A' },
    { datum_year: 1980, ereignis: 'B' },
    { datum_year: 1980, ereignis: 'C' },
  ]);
  const { lanes, markers } = layoutBandItems(items, { maxLanes: 6 });
  assert.equal(lanes, 3, 'drei Lanes für drei überlappende Marker');
  assert.deepEqual(markers.map(m => m.lane).sort(), [0, 1, 2]);
});

test('layoutBandItems: Höhe gedeckelt — oberste Zelle wird +N-Chip, kein Datenverlust', () => {
  // 10 Events im selben Jahr, maxLanes=3 → die oberste Säulen-Zelle wird zum
  // „more"-Chip: 2 Einzel-Marker (Spuren 0/1) + 1 Chip(8) auf Spur 2.
  const events = Array.from({ length: 10 }, (_, i) => ({ datum_year: 1990, ereignis: 'E' + i }));
  const { lanes, markers } = layoutBandItems(buildTimelineItems(events), { maxLanes: 3 });
  assert.ok(lanes <= 3, 'Lanes auf maxLanes gedeckelt');
  const single = markers.filter(m => m.kind === 'event');
  const more = markers.filter(m => m.kind === 'more');
  assert.equal(single.length, 2, 'maxLanes-1 Einzel-Marker sichtbar (oberste Zelle = Chip)');
  assert.equal(more.length, 1, 'ein gebündelter Chip');
  assert.equal(more[0].count, 8, 'Chip zählt die 8 überzähligen');
  assert.equal(single.length + more[0].count, 10, 'kein Event verschluckt');
  assert.equal(more[0].lane, 2, 'Chip sitzt allein auf der obersten Spur (keine Kollision)');
  assert.ok(single.every(m => m.lane !== more[0].lane), 'kein Einzel-Marker auf der Chip-Spur');
  assert.ok(Number.isInteger(more[0].id), 'Chip-id = Listen-Index des ersten überzähligen Events (Klick-Ziel)');
});

test('layoutBandItems: ohne bandWidthPx bleiben +N-Chips ungemerged (Default)', () => {
  // Zwei dicht benachbarte Jahre, beide übervoll → zwei „more"-Chips. Ohne
  // gemessene Breite (Tests / erster Paint) findet keine Kollisionsauflösung
  // statt: das Layout bleibt bit-identisch zum bisherigen Verhalten.
  const events = [
    ...Array.from({ length: 8 }, (_, i) => ({ datum_year: 1994, ereignis: 'A' + i })),
    ...Array.from({ length: 8 }, (_, i) => ({ datum_year: 1995, ereignis: 'B' + i })),
  ];
  const more = layoutBandItems(buildTimelineItems(events), { maxLanes: 3 })
    .markers.filter(m => m.kind === 'more');
  assert.equal(more.length, 2, 'zwei separate Chips ohne Breiteninfo');
});

test('layoutBandItems: kollidierende +N-Chips werden bei schmaler Breite gemerged', () => {
  // Dieselben zwei dichten Nachbarjahre (1994/1995, ~50 % vs ~100 % über eine
  // 1958..1995-Spanne ⇒ ~3 % Abstand). Bei schmaler Track-Breite überlappen die
  // Chip-Boxen → ein Sammel-Chip, Counts addiert, kein Datenverlust.
  const events = [
    { datum_year: 1958, ereignis: 'Anker' },
    ...Array.from({ length: 8 }, (_, i) => ({ datum_year: 1994, ereignis: 'A' + i })),
    ...Array.from({ length: 8 }, (_, i) => ({ datum_year: 1995, ereignis: 'B' + i })),
  ];
  const items = buildTimelineItems(events);
  const baseMore = layoutBandItems(items, { maxLanes: 3 }).markers.filter(m => m.kind === 'more');
  const merged = layoutBandItems(items, { maxLanes: 3, bandWidthPx: 300 }).markers.filter(m => m.kind === 'more');
  assert.equal(baseMore.length, 2, 'ungemerged zwei Chips');
  assert.equal(merged.length, 1, 'gemerged zu einem Chip');
  assert.equal(merged[0].count, baseMore.reduce((s, m) => s + m.count, 0), 'Counts addiert, kein Verlust');
  assert.ok(Number.isInteger(merged[0].id), 'Klick-Ziel bleibt ein Listen-Index');
});

test('layoutBandItems: weit getrennte +N-Chips bleiben getrennt', () => {
  // 1960 vs 2000 über dieselbe Spanne ⇒ ~100 % Abstand: auch bei schmaler
  // Breite kein Merge.
  const events = [
    ...Array.from({ length: 8 }, (_, i) => ({ datum_year: 1960, ereignis: 'A' + i })),
    ...Array.from({ length: 8 }, (_, i) => ({ datum_year: 2000, ereignis: 'B' + i })),
  ];
  const merged = layoutBandItems(buildTimelineItems(events), { maxLanes: 3, bandWidthPx: 300 })
    .markers.filter(m => m.kind === 'more');
  assert.equal(merged.length, 2, 'zwei getrennte Chips trotz schmaler Breite');
});

test('layoutBandItems: Punkte stapeln je Säule von der Baseline (Spur 0) aufwärts', () => {
  // Zwei Events im selben Jahr stapeln in einer Säule (gleiches x, Spuren 0/1);
  // ein drittes in einem fernen Jahr steht für sich auf Spur 0.
  const items = buildTimelineItems([
    { datum_year: 1980, ereignis: 'A' },
    { datum_year: 1980, ereignis: 'B' },
    { datum_year: 2000, ereignis: 'C' },
  ]);
  const { markers } = layoutBandItems(items, { maxLanes: 6 });
  const byId = Object.fromEntries(markers.map(m => [m.id, m]));
  assert.equal(byId[0].lane, 0, 'erstes Event der Säule auf der Baseline');
  assert.equal(byId[1].lane, 1, 'zweites Event der Säule eine Spur höher');
  assert.equal(byId[0].x.toFixed(1), byId[1].x.toFixed(1), 'gestapelte Events teilen die x-Position');
  assert.equal(byId[2].lane, 0, 'Event im fernen Jahr beginnt wieder auf der Baseline');
});

test('layoutBandItems: Spanne trägt isRange + widthPct', () => {
  const items = buildTimelineItems([
    { datum_year: 1900, ereignis: 'Start' },
    { datum_year: 1950, datum_ende_year: 2000, ereignis: 'Lange Spanne' },
  ]);
  const span = layoutBandItems(items).markers.find(m => m.id === 1);
  assert.equal(span.isRange, true);
  assert.ok(span.widthPct > 0, 'Spanne hat Breite');
});

// --- bandAxisTicks (Jahres-Ticks) ---

test('bandAxisTicks: null bounds → []', () => {
  assert.deepEqual(bandAxisTicks(null), []);
});

test('bandAxisTicks: Ticks liegen im Jahresbereich, x in Prozent', () => {
  const bounds = timelineBounds(buildTimelineItems([
    { datum_year: 1960, ereignis: 'A' },
    { datum_year: 2000, ereignis: 'B' },
  ]));
  const ticks = bandAxisTicks(bounds, { targetTicks: 6 });
  assert.ok(ticks.length >= 2, 'mehrere Ticks');
  for (const t of ticks) {
    assert.ok(t.year >= 1960 && t.year <= 2000, `Tick ${t.year} im Bereich`);
    assert.ok(t.x >= -0.01 && t.x <= 100.01, `x ${t.x} in [0..100]`);
  }
});

// --- buildBandModel (Gesamtmodell) ---

test('buildBandModel: bündelt itemCount + lanes + markers + ticks', () => {
  const events = [
    { datum_year: 1980, subtyp: 'geburt', ereignis: 'A' },
    { story_tag: 'Tag 1', ereignis: 'undatiert' },     // nicht auf Achse
    { datum_year: 1990, typ: 'extern', ereignis: 'Welt' },
  ];
  const bm = buildBandModel(events);
  assert.equal(bm.itemCount, 2, 'nur datierte Events zählen');
  assert.ok(bm.lanes >= 1);
  assert.equal(bm.markers.filter(m => m.kind !== 'more').length, 2);
  assert.ok(bm.ticks.length >= 1);
  assert.equal(bm.markers.find(m => m.id === 2).extern, true);
});

// --- bandMarkerColor (Subtyp → Token) ---

test('bandMarkerColor: bekannter Subtyp → passendes Akzent-Token', () => {
  assert.equal(bandMarkerColor('geburt', false), 'var(--card-accent-event-geburt)');
});

test('bandMarkerColor: unbekannter Subtyp → sonstiges-Fallback', () => {
  assert.equal(bandMarkerColor('schwurbel', false), 'var(--card-accent-event-sonstiges)');
});

test('bandMarkerColor: extern übersteuert mit Error-Randfarbe', () => {
  assert.equal(bandMarkerColor('geburt', true), 'var(--color-err-border)');
});
