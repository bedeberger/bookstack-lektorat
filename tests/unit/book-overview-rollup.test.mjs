// Tests für Sub-Kapitel-Rollup auf Wurzel-Kapitel.
// Buchorganizer + Sidebar + PDF zeigen die volle Hierarchie; Buch-Overview-Tiles
// aggregieren stattdessen auf Top-Level-Kapitel (Sub-Kapitel-Werte addieren
// sich zum Root). Hier abgesichert: Distribution, Findings, LektoratTime,
// Figuren-Matrix, Orte-Matrix, chapter_count.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bookOverviewMethods } from '../../public/js/book-overview.js';

// Nav-State (tree/pages) lebt in Alpine.store('nav') (kein Root-Proxy mehr). Die
// Tests setzen weiterhin globalThis.window.__app.{tree,pages}; dieser Shim
// aliassiert store('nav') darauf, sodass die Methoden ihre Nav-Daten finden.
globalThis.Alpine = { store: (n) => (n === 'nav' ? (globalThis.window?.__app || {}) : {}) };

// Tree-Shape spiegelt tree.js#loadPages: flach, depth-annotiert, parent_id.
// Buch hat:
//   Root A (id=1, depth=1) — pages 100, 101
//     Sub A1 (id=2, depth=2, parent=1) — pages 110, 111
//     Sub A2 (id=3, depth=2, parent=1) — pages 120
//       Sub A2a (id=4, depth=3, parent=3) — pages 130
//   Root B (id=5, depth=1) — pages 200
function makeTree() {
  return [
    { type: 'chapter', id: 1, name: 'Root A', depth: 1, parent_id: null,
      pages: [{ id: 100 }, { id: 101 }] },
    { type: 'chapter', id: 2, name: 'Sub A1', depth: 2, parent_id: 1,
      pages: [{ id: 110 }, { id: 111 }] },
    { type: 'chapter', id: 3, name: 'Sub A2', depth: 2, parent_id: 1,
      pages: [{ id: 120 }] },
    { type: 'chapter', id: 4, name: 'Sub A2a', depth: 3, parent_id: 3,
      pages: [{ id: 130 }] },
    { type: 'chapter', id: 5, name: 'Root B', depth: 1, parent_id: null,
      pages: [{ id: 200 }] },
    // Solo-Wrapper (Spezialseite ohne Kapitel) — muss ignoriert werden
    { type: 'chapter', id: 'solo-999', name: 'Vorwort', depth: 1, parent_id: null,
      solo: true, pages: [{ id: 999 }] },
  ];
}

function makeCtx(tree) {
  globalThis.window = { __app: { tree, tokEsts: {}, pages: [] } };
  return { _memos: {}, ...bookOverviewMethods };
}

test('_chapterRollup: rootOf folgt parent_id-Kette bis depth=1', () => {
  const ctx = makeCtx(makeTree());
  const { roots, rootOf } = ctx._chapterRollup();
  assert.equal(roots.length, 2, 'nur zwei Top-Level-Kapitel');
  assert.deepEqual(roots.map(r => r.id), [1, 5]);
  assert.equal(rootOf(2).id, 1);
  assert.equal(rootOf(3).id, 1);
  assert.equal(rootOf(4).id, 1, 'depth-3 rollt zu depth-1');
  assert.equal(rootOf(5).id, 5);
  assert.equal(rootOf(999), null, 'solo-Wrapper nicht im rollup');
});

test('overviewChapterDistribution: Sub-Kapitel-Chars summieren zum Root', () => {
  const tree = makeTree();
  const tokEsts = {
    100: { chars: 1000, words: 200 }, 101: { chars: 500, words: 100 },
    110: { chars: 300, words: 60 }, 111: { chars: 200, words: 40 },
    120: { chars: 800, words: 160 },
    130: { chars: 100, words: 20 },
    200: { chars: 2000, words: 400 },
  };
  globalThis.window = { __app: { tree, tokEsts, pages: [] } };
  const ctx = { _memos: {}, ...bookOverviewMethods };
  const dist = ctx.overviewChapterDistribution();
  assert.equal(dist.length, 2);
  const a = dist.find(r => r.id === 1);
  const b = dist.find(r => r.id === 5);
  assert.equal(a.chars, 1000 + 500 + 300 + 200 + 800 + 100, 'Root A inkl. aller Subs');
  assert.equal(a.words, 200 + 100 + 60 + 40 + 160 + 20);
  assert.equal(a.pages, 6, '2 + 2 + 1 + 1');
  assert.equal(b.chars, 2000);
  assert.equal(b.pages, 1);
});

test('overviewChapterFindings: heat.matrix-rows auf Root gemerged', () => {
  const tree = makeTree();
  const ctx = makeCtx(tree);
  ctx.overviewHeat = {
    chapters: [
      { chapter_id: 1, chapter_name: 'Root A', words: 300, pages_total: 2, pages_checked: 2 },
      { chapter_id: 2, chapter_name: 'Sub A1', words: 100, pages_total: 2, pages_checked: 1 },
      { chapter_id: 4, chapter_name: 'Sub A2a', words: 20, pages_total: 1, pages_checked: 1 },
      { chapter_id: 5, chapter_name: 'Root B', words: 400, pages_total: 1, pages_checked: 0 },
    ],
    matrix: {
      1: { stil: { count: 3 }, grammatik: { count: 1 } },
      2: { stil: { count: 2 } },
      4: { grammatik: { count: 5 } },
      5: {},
    },
  };
  const out = ctx.overviewChapterFindings();
  const a = out.find(r => r.id === 1);
  const b = out.find(r => r.id === 5);
  // Root A: 4 + 2 + 5 = 11
  assert.equal(a.count, 11);
  assert.equal(a.words, 300 + 100 + 20);
  assert.equal(a.pages_total, 2 + 2 + 1);
  assert.equal(a.pages_checked, 2 + 1 + 1);
  // Ungeprüfte Kapitel (pages_checked = 0) fallen aus dem Output.
  assert.equal(b, undefined, 'ungeprüfte Kapitel werden gefiltert');
  assert.equal(out.length, 1);
});

test('overviewChapterLektoratTime: per_chapter-rows auf Root summiert', () => {
  const tree = makeTree();
  const ctx = makeCtx(tree);
  ctx.overviewLektoratTime = {
    per_chapter: [
      { chapter_id: 1, seconds: 100, pages_count: 2 },
      { chapter_id: 2, seconds: 50, pages_count: 2 },
      { chapter_id: 3, seconds: 30, pages_count: 1 },
      { chapter_id: 4, seconds: 20, pages_count: 1 },
      { chapter_id: 5, seconds: 200, pages_count: 1 },
    ],
  };
  const out = ctx.overviewChapterLektoratTime();
  // Kapitel ohne erfasste Zeit fallen raus; hier haben beide Roots Zeit.
  const a = out.find(r => r.id === 1);
  const b = out.find(r => r.id === 5);
  assert.equal(a.seconds, 100 + 50 + 30 + 20);
  assert.equal(a.pages_count, 2 + 2 + 1 + 1);
  assert.equal(b.seconds, 200);
});

test('overviewLektoratTime: Name-Fallback für rows ohne chapter_id', () => {
  const tree = makeTree();
  const ctx = makeCtx(tree);
  ctx.overviewLektoratTime = {
    per_chapter: [
      { chapter_name: 'Sub A2', seconds: 60, pages_count: 1 },
      { chapter_name: 'Root B', seconds: 90, pages_count: 1 },
    ],
  };
  const out = ctx.overviewChapterLektoratTime();
  assert.equal(out.find(r => r.id === 1)?.seconds, 60, 'Sub A2 via Name → Root A');
  assert.equal(out.find(r => r.id === 5)?.seconds, 90);
});

test('overviewFigurePresence: Szenen aus Sub-Kapiteln in Root-Spalte', () => {
  const tree = makeTree();
  const ctx = makeCtx(tree);
  ctx.overviewFiguren = [
    { id: 'f1', name: 'Anna', kurzname: 'Anna' },
    { id: 'f2', name: 'Bert', kurzname: 'Bert' },
  ];
  ctx.overviewSzenen = [
    { chapter_id: 1, fig_ids: ['f1'] },
    { chapter_id: 2, fig_ids: ['f1', 'f2'] },
    { chapter_id: 4, fig_ids: ['f1'] },
    { chapter_id: 5, fig_ids: ['f2'] },
  ];
  const out = ctx.overviewFigurePresence();
  assert.equal(out.rows.length, 2, 'nur zwei Root-Zeilen');
  const rowA = out.rows.find(r => r.id === 1);
  const rowB = out.rows.find(r => r.id === 5);
  const cellAnnaA = rowA.cells.find(c => c.id === 'f1');
  const cellAnnaB = rowB.cells.find(c => c.id === 'f1');
  assert.equal(cellAnnaA.value, 3, 'Anna: 1 (Root) + 1 (Sub A1) + 1 (Sub A2a)');
  assert.equal(cellAnnaB.value, 0);
  const cellBertA = rowA.cells.find(c => c.id === 'f2');
  assert.equal(cellBertA.value, 1);
});

test('overviewFigurePresence: Einmal-Szenen-Statisten verdrängen Hauptfiguren nicht', () => {
  const tree = makeTree();
  const ctx = makeCtx(tree);
  ctx.overviewFiguren = [
    { id: 'haupt', name: 'Anna', kurzname: 'Anna' },
    { id: 'statist', name: 'Kellner', kurzname: 'Kellner' },
  ];
  ctx.overviewSzenen = [
    { chapter_id: 1, fig_ids: ['haupt'] },
    { chapter_id: 5, fig_ids: ['haupt'] },
    { chapter_id: 1, fig_ids: ['statist'] },
  ];
  const out = ctx.overviewFigurePresence();
  assert.deepEqual(out.cols.map(f => f.id), ['haupt'], 'nur die mehrfach auftretende Figur');
});

test('overviewTopFiguren: bevorzugt Figuren mit mehreren Szenen', () => {
  const tree = makeTree();
  const ctx = makeCtx(tree);
  ctx.overviewFiguren = [
    { id: 'haupt', name: 'Anna', kurzname: 'Anna' },
    { id: 'statist', name: 'Kellner', kurzname: 'Kellner' },
  ];
  ctx.overviewSzenen = [
    { chapter_id: 1, fig_ids: ['haupt'] },
    { chapter_id: 5, fig_ids: ['haupt'] },
    { chapter_id: 1, fig_ids: ['statist'] },
  ];
  assert.deepEqual(ctx.overviewTopFiguren().map(f => f.id), ['haupt']);
});

test('overviewOrtPresence: location-Kapitel-rows aggregiert', () => {
  const tree = makeTree();
  const ctx = makeCtx(tree);
  ctx.overviewOrte = [
    {
      id: 'o1', name: 'Wald', typ: 'natur',
      kapitel: [
        { chapter_id: 1, name: 'Root A', haeufigkeit: 2 },
        { chapter_id: 2, name: 'Sub A1', haeufigkeit: 3 },
        { chapter_id: 4, name: 'Sub A2a', haeufigkeit: 1 },
        { chapter_id: 5, name: 'Root B', haeufigkeit: 4 },
      ],
    },
  ];
  const out = ctx.overviewOrtPresence();
  assert.equal(out.rows.length, 2);
  const rowA = out.rows.find(r => r.id === 1);
  const rowB = out.rows.find(r => r.id === 5);
  assert.equal(rowA.cells[0].value, 2 + 3 + 1, 'Wald: Root + Sub A1 + Sub A2a');
  assert.equal(rowB.cells[0].value, 4);
});

test('overviewOrtPresence: Einmal-Nennungen verdrängen wiederkehrende Orte nicht', () => {
  const tree = makeTree();
  const ctx = makeCtx(tree);
  // Ein wiederkehrender Ort (2 Kapitel) + zwei Einmal-Nennungen aus demselben Kapitel.
  ctx.overviewOrte = [
    { id: 'wieder', name: 'Marktplatz', typ: 'andere', kapitel: [
      { chapter_id: 1, name: 'Root A', haeufigkeit: 1 },
      { chapter_id: 5, name: 'Root B', haeufigkeit: 1 },
    ] },
    { id: 'einmal1', name: 'Gasse', typ: 'andere', kapitel: [
      { chapter_id: 1, name: 'Root A', haeufigkeit: 1 },
    ] },
    { id: 'einmal2', name: 'Brunnen', typ: 'andere', kapitel: [
      { chapter_id: 1, name: 'Root A', haeufigkeit: 1 },
    ] },
  ];
  const out = ctx.overviewOrtPresence();
  assert.deepEqual(out.cols.map(p => p.id), ['wieder'], 'nur der mehrfach erwähnte Ort');
});

test('overviewOrtPresence: Fallback zeigt Einmal-Nennungen, wenn kein Ort wiederkehrt', () => {
  const tree = makeTree();
  const ctx = makeCtx(tree);
  ctx.overviewOrte = [
    { id: 'a', name: 'Gasse', typ: 'andere', kapitel: [{ chapter_id: 1, name: 'Root A', haeufigkeit: 1 }] },
    { id: 'b', name: 'Brunnen', typ: 'andere', kapitel: [{ chapter_id: 5, name: 'Root B', haeufigkeit: 1 }] },
  ];
  const out = ctx.overviewOrtPresence();
  assert.equal(out.cols.length, 2, 'Fallback: beide Einmal-Orte sichtbar');
});

test('overviewTopOrte: bevorzugt mehrfach erwähnte Schauplätze', () => {
  const tree = makeTree();
  const ctx = makeCtx(tree);
  ctx.overviewOrte = [
    { id: 'wieder', name: 'Marktplatz', kapitel: [
      { chapter_id: 1, name: 'Root A', haeufigkeit: 1 },
      { chapter_id: 5, name: 'Root B', haeufigkeit: 1 },
    ] },
    { id: 'einmal', name: 'Gasse', kapitel: [{ chapter_id: 1, name: 'Root A', haeufigkeit: 1 }] },
  ];
  assert.deepEqual(ctx.overviewTopOrte().map(o => o.id), ['wieder']);
});

test('overviewLatest.chapter_count: Sub-Kapitel zählen nicht eigenständig', () => {
  const tree = makeTree();
  // Pages mit chapter_id — quer durch Hierarchie
  const pages = [
    { id: 100, chapter_id: 1 }, { id: 101, chapter_id: 1 },
    { id: 110, chapter_id: 2 }, { id: 111, chapter_id: 2 },
    { id: 120, chapter_id: 3 },
    { id: 130, chapter_id: 4 },
    { id: 200, chapter_id: 5 },
  ];
  const tokEsts = Object.fromEntries(pages.map(p => [p.id, { chars: 100, words: 20 }]));
  globalThis.window = { __app: { tree, tokEsts, pages } };
  const ctx = { _memos: {}, overviewStats: [], ...bookOverviewMethods };
  const latest = ctx.overviewLatest();
  assert.equal(latest.chapter_count, 2, 'zwei Roots — nicht fünf');
});
