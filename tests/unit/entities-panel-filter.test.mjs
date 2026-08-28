// Unit-Tests fuer Entity-Linking-Panel-Selektoren.
//
// selectEventsForView teilt Eintraege in
//   - onPage: gleiche page_id
//   - inChapter: gleiche chapter_id UND page_id leer
// selectScenesForView hat einen dritten Topf
//   - inChapterOtherPage: gleiche chapter_id, aber an eine ANDERE Seite gebunden
// Ohne den faellt jede seitengebundene Szene des Kapitels aus beiden Listen und
// das Referenz-Panel verschweigt sie.
// Sortierung deterministisch.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { selectScenesForView, selectEventsForView } = await import('../../public/js/editor/notebook/entities.js');

// ── Szenen ─────────────────────────────────────────────────────────────────

test('selectScenesForView: leere Liste', () => {
  const out = selectScenesForView([], 1, 10);
  assert.deepEqual(out, { onPage: [], inChapter: [], inChapterOtherPage: [] });
});

test('selectScenesForView: trennt page-gebundene von kapitel-gebundenen Szenen', () => {
  const scenes = [
    { id: 1, page_id: 7, chapter_id: 10, titel: 'A', sort_order: 1 },
    { id: 2, page_id: 7, chapter_id: 10, titel: 'B', sort_order: 0 },
    { id: 3, page_id: null, chapter_id: 10, titel: 'C', sort_order: 0 },
    { id: 4, page_id: 8, chapter_id: 10, titel: 'D', sort_order: 0 },
    { id: 5, page_id: null, chapter_id: 11, titel: 'E', sort_order: 0 },
  ];
  const out = selectScenesForView(scenes, 7, 10);
  assert.deepEqual(out.onPage.map(s => s.id), [2, 1], 'onPage sortiert nach sort_order');
  assert.deepEqual(out.inChapter.map(s => s.id), [3], 'inChapter nur same chapter UND page_id leer');
  assert.deepEqual(out.inChapterOtherPage.map(s => s.id), [4],
    'inChapterOtherPage: same chapter, andere Seite — faellt sonst durch');
  // Kein Eintrag darf in zwei Toepfen stehen.
  const ids = [...out.onPage, ...out.inChapter, ...out.inChapterOtherPage].map(s => s.id);
  assert.equal(new Set(ids).size, ids.length, 'Toepfe sind disjunkt');
  assert.ok(!ids.includes(5), 'fremdes Kapitel bleibt draussen');
});

test('selectScenesForView: chapter_id null → auch kein inChapterOtherPage', () => {
  const scenes = [{ id: 1, page_id: 8, chapter_id: 10, titel: 'A' }];
  assert.deepEqual(selectScenesForView(scenes, 7, null).inChapterOtherPage, []);
});

test('selectScenesForView: leere page_id zaehlt als ungebunden, nicht als andere Seite', () => {
  const scenes = [
    { id: 1, page_id: '', chapter_id: 10, titel: 'A' },
    { id: 2, page_id: 9, chapter_id: 10, titel: 'B' },
  ];
  const out = selectScenesForView(scenes, 7, 10);
  assert.deepEqual(out.inChapter.map(s => s.id), [1]);
  assert.deepEqual(out.inChapterOtherPage.map(s => s.id), [2]);
});

test('selectScenesForView: inChapterOtherPage sortiert nach sort_order', () => {
  const scenes = [
    { id: 1, page_id: 8, chapter_id: 10, sort_order: 2 },
    { id: 2, page_id: 9, chapter_id: 10, sort_order: 1 },
  ];
  const out = selectScenesForView(scenes, 7, 10);
  assert.deepEqual(out.inChapterOtherPage.map(s => s.id), [2, 1]);
});

test('selectScenesForView: page_id null/undefined → kein onPage', () => {
  const scenes = [{ id: 1, page_id: 5, chapter_id: 10, titel: 'A' }];
  const out = selectScenesForView(scenes, null, 10);
  assert.deepEqual(out.onPage, []);
});

test('selectScenesForView: chapter_id null → kein inChapter', () => {
  const scenes = [{ id: 1, page_id: null, chapter_id: 10, titel: 'A' }];
  const out = selectScenesForView(scenes, 5, null);
  assert.deepEqual(out.inChapter, []);
});

test('selectScenesForView: leere page_id-Werte als ungebunden behandeln', () => {
  const scenes = [
    { id: 1, page_id: '', chapter_id: 10, titel: 'A' },
    { id: 2, page_id: null, chapter_id: 10, titel: 'B' },
  ];
  const out = selectScenesForView(scenes, 5, 10);
  assert.equal(out.inChapter.length, 2);
});

// ── Ereignisse ─────────────────────────────────────────────────────────────

test('selectEventsForView: flatten + sort + figure-attach', () => {
  const figuren = [
    {
      id: 1, name: 'Anna', kurzname: 'A',
      lebensereignisse: [
        { datum: '1990-01-02', datum_year: 1990, datum_month: 1, datum_day: 2,
          ereignis: 'Geburt', page_id: 7, chapter_id: 10 },
        { datum: '2010-05-04', datum_year: 2010, datum_month: 5, datum_day: 4,
          ereignis: 'Reise', page_id: null, chapter_id: 10 },
      ],
    },
    {
      id: 2, name: 'Bob', kurzname: 'B',
      lebensereignisse: [
        { datum: '1985-12-12', datum_year: 1985, datum_month: 12, datum_day: 12,
          ereignis: 'Geburt', page_id: 7, chapter_id: 10 },
      ],
    },
  ];
  const out = selectEventsForView(figuren, 7, 10);
  assert.equal(out.onPage.length, 2);
  // Sortierung nach Datum-Komponenten — Bob (1985) vor Anna (1990).
  assert.equal(out.onPage[0].figure_name, 'Bob');
  assert.equal(out.onPage[1].figure_name, 'Anna');
  assert.equal(out.inChapter.length, 1);
  assert.equal(out.inChapter[0].ereignis, 'Reise');
  assert.equal(out.inChapter[0].figure_id, 1);
  assert.equal(out.inChapter[0].figure_kurzname, 'A');
});

test('selectEventsForView: Ereignis ohne page_id und ohne chapter_id wird ignoriert', () => {
  const figuren = [
    { id: 1, name: 'X', lebensereignisse: [
      { datum: 'irgendwann', ereignis: 'Loose', page_id: null, chapter_id: null },
    ]},
  ];
  const out = selectEventsForView(figuren, 5, 10);
  assert.equal(out.onPage.length, 0);
  assert.equal(out.inChapter.length, 0);
});

test('selectEventsForView: leere Figuren-Liste', () => {
  assert.deepEqual(selectEventsForView([], 1, 1), { onPage: [], inChapter: [] });
});

test('selectEventsForView: Fallback-Sort lexikographisch ueber datum-String wenn keine struct. Felder', () => {
  const figuren = [
    { id: 1, name: 'X', lebensereignisse: [
      { datum: '2020-06-01', ereignis: 'B', page_id: 1, chapter_id: 1 },
      { datum: '2020-01-15', ereignis: 'A', page_id: 1, chapter_id: 1 },
    ]},
  ];
  const out = selectEventsForView(figuren, 1, 1);
  assert.deepEqual(out.onPage.map(e => e.ereignis), ['A', 'B']);
});

