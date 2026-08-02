// Der 0-statt-null-Platzhalter der Sprachmodelle in den Event-Datumsfeldern.
//
// Anlass: Opus liefert fuer ein unbekanntes Datumsfeld durchgaengig `0` statt
// `null`, bei lokalen Providern erzwingt das Constrained Decoding es sogar
// strukturell. Die Auswertungskette prueft auf `== null` / `IS NOT NULL`, also
// rutschte die 0 als echtes Datum durch — Anzeige "00.00.1988 – 00.00.0",
// Jahres-Band ab Jahr 0, nie gefuellter "ohne Datum"-Bucket.
//
// Drei Schichten, alle hier gegated:
//   1. lib/datum-parse#normalizeDatumFields — SSoT der Normalisierung
//   2. db/event-datum#structuredDatum       — Schreibpfad beider Event-Tabellen
//   3. ereignisse-card#formatEventDateParts — Anzeige (Gegenstueck, s. Modul)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { formatEventDateParts, hasEventYear, buildTimelineItems } from '../../public/js/cards/ereignisse-card.js';

const require = createRequire(import.meta.url);
const { normalizeDatumFields } = require('../../lib/datum-parse.js');
const { structuredDatum } = require('../../db/event-datum.js');

// ── 1. Normalizer ────────────────────────────────────────────────────────────

test('0 in jedem Zahlenfeld wird zu null', () => {
  const d = normalizeDatumFields({
    datum_year: 0, datum_month: 0, datum_day: 0,
    datum_ende_year: 0, datum_ende_month: 0, datum_ende_day: 0, story_tag: 0,
  });
  assert.deepEqual(d, {
    datum_year: null, datum_month: null, datum_day: null,
    datum_ende_year: null, datum_ende_month: null, datum_ende_day: null, story_tag: null,
  });
});

test('gueltige Werte bleiben unveraendert', () => {
  const d = normalizeDatumFields({
    datum_year: 1987, datum_month: 10, datum_day: 17,
    datum_ende_year: 1990, datum_ende_month: 3, datum_ende_day: 1, story_tag: 4,
  });
  assert.equal(d.datum_year, 1987);
  assert.equal(d.datum_month, 10);
  assert.equal(d.datum_day, 17);
  assert.equal(d.datum_ende_year, 1990);
  assert.equal(d.datum_ende_day, 1);
  assert.equal(d.story_tag, 4);
});

test('v.-Chr.-Jahre (negativ) ueberleben — nur 0 ist ungueltig', () => {
  assert.equal(normalizeDatumFields({ datum_year: -500 }).datum_year, -500);
  assert.equal(normalizeDatumFields({ datum_year: 0 }).datum_year, null);
});

test('Monat/Tag ausserhalb des Bereichs fallen weg', () => {
  assert.equal(normalizeDatumFields({ datum_month: 13 }).datum_month, null);
  assert.equal(normalizeDatumFields({ datum_month: -1 }).datum_month, null);
  assert.equal(normalizeDatumFields({ datum_month: 5, datum_day: 32 }).datum_day, null);
});

test('Tag ohne Monat wird verworfen (nicht darstellbar)', () => {
  const d = normalizeDatumFields({ datum_year: 1987, datum_month: 0, datum_day: 17 });
  assert.equal(d.datum_month, null);
  assert.equal(d.datum_day, null);
});

test('Spannen-Ende ohne eigenes Jahr faellt komplett weg', () => {
  const d = normalizeDatumFields({
    datum_year: 1988, datum_ende_year: 0, datum_ende_month: 5, datum_ende_day: 3,
  });
  assert.equal(d.datum_ende_year, null);
  assert.equal(d.datum_ende_month, null);
  assert.equal(d.datum_ende_day, null);
});

test('rueckwaerts laufende Spanne wird verworfen', () => {
  assert.equal(normalizeDatumFields({ datum_year: 1990, datum_ende_year: 1985 }).datum_ende_year, null);
  assert.equal(normalizeDatumFields({ datum_year: 1990, datum_ende_year: 1990 }).datum_ende_year, 1990);
});

test('story_tag beginnt bei 1', () => {
  assert.equal(normalizeDatumFields({ story_tag: 0 }).story_tag, null);
  assert.equal(normalizeDatumFields({ story_tag: 1 }).story_tag, 1);
});

// ── 2. Schreibpfad ───────────────────────────────────────────────────────────

test('structuredDatum: 0-Platzhalter der KI erreichen die DB nicht', () => {
  const sd = structuredDatum({
    datum: '1988', datum_label: '1988', datum_year: 1988,
    datum_month: 0, datum_day: 0,
    datum_ende_year: 0, datum_ende_month: 0, datum_ende_day: 0,
    story_tag: 0, datum_unsicher: false, ereignis: 'x',
  });
  assert.equal(sd.datum_year, 1988);
  for (const k of ['datum_month', 'datum_day', 'datum_ende_year', 'datum_ende_month', 'datum_ende_day', 'story_tag']) {
    assert.equal(sd[k], null, `${k} muss null sein`);
  }
});

test('structuredDatum: 0 der KI blockiert den parseDatum-Fallback nicht', () => {
  // Regression: `ev.datum_year ?? p.year` liess die 0 gewinnen, obwohl das
  // Label ein echtes Jahr trug. Normalisierung muss VOR dem ?? laufen.
  const sd = structuredDatum({ datum_label: 'Mai 1850', datum_year: 0, datum_month: 0 });
  assert.equal(sd.datum_year, 1850);
  assert.equal(sd.datum_month, 5);
});

test('structuredDatum: datum_unsicher nur mit Jahr', () => {
  assert.equal(structuredDatum({ datum_label: 'irgendwann', datum_unsicher: true }).datum_unsicher, 0);
  assert.equal(structuredDatum({ datum_label: '1850', datum_year: 1850, datum_unsicher: true }).datum_unsicher, 1);
});

// ── 3. Anzeige ───────────────────────────────────────────────────────────────

const t = (k, p) => ({
  'events.circa':       `ca. ${p?.date}`,
  'events.span':        `${p?.start} – ${p?.ende}`,
  'events.storyDay':    `Tag ${p?.n}`,
  'events.unknownDate': 'ohne Datum',
}[k]);

test('Anzeige: alle Datums-Granularitaeten', () => {
  const f = (ev) => formatEventDateParts(ev, t);
  assert.equal(f({ datum_year: 1987 }), '1987');
  assert.equal(f({ datum_year: 1987, datum_month: 10 }), '10.1987');
  assert.equal(f({ datum_year: 1987, datum_month: 10, datum_day: 17 }), '17.10.1987');
  assert.equal(f({ datum_month: 10, datum_day: 17 }), '17.10.');
  assert.equal(f({ datum_year: 1914, datum_ende_year: 1918 }), '1914 – 1918');
  assert.equal(f({ datum_year: 1987, datum_unsicher: true }), 'ca. 1987');
  assert.equal(f({ story_tag: 3 }), 'Tag 3');
  assert.equal(f({ datum_label: 'in Stefans Kindheit' }), 'in Stefans Kindheit');
  assert.equal(f({}), 'ohne Datum');
});

test('Anzeige: 0-Platzhalter erzeugen niemals "00." oder "0"', () => {
  const f = (ev) => formatEventDateParts(ev, t);
  // Genau die Form, die in der Karte stand, bevor der Normalizer existierte.
  assert.equal(f({
    datum_year: 1988, datum_month: 0, datum_day: 0,
    datum_ende_year: 0, datum_ende_month: 0, datum_ende_day: 0, story_tag: 0,
  }), '1988');
  assert.equal(f({
    datum_year: 0, datum_month: 0, datum_day: 0,
    datum_ende_year: 0, story_tag: 0, datum_label: 'Heirat von Juerg und Isabelle',
  }), 'Heirat von Juerg und Isabelle');
  assert.equal(f({ datum_year: 0, datum_month: 0, datum_day: 0, story_tag: 0 }), 'ohne Datum');
});

test('Anzeige: unsicher-Prefix nur mit echtem Jahr', () => {
  assert.equal(formatEventDateParts({ datum_year: 0, datum_label: 'irgendwann', datum_unsicher: true }, t),
    'irgendwann');
});

test('hasEventYear: 0 zaehlt nicht als Jahr', () => {
  assert.equal(hasEventYear({ datum_year: 1987 }), true);
  assert.equal(hasEventYear({ datum_year: -500 }), true);
  assert.equal(hasEventYear({ datum_year: 0 }), false);
  assert.equal(hasEventYear({ datum_year: null }), false);
  assert.equal(hasEventYear({}), false);
});

test('Jahres-Band: Jahr-0-Events landen nicht auf der Achse', () => {
  // Sonst spannt die Achse von Jahr 0 bis heute und staucht alles Echte weg.
  const items = buildTimelineItems([
    { datum_year: 0, ereignis: 'ohne Jahr' },
    { datum_year: 1987, ereignis: 'echt' },
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].content, 'echt');
});

test('Jahres-Band: 0-Ende macht aus einem Punkt keine Spanne', () => {
  const [item] = buildTimelineItems([
    { datum_year: 1987, datum_ende_year: 0, subtyp: 'reise', ereignis: 'x' },
  ]);
  assert.equal(item.type, 'point');
  assert.equal(item.end, undefined);
});
