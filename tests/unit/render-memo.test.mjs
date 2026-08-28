// Memoisierung der Render-Pfade, die im Template PRO ZEILE gelesen werden.
//
// Gemeinsames Muster: eine Methode, die ueber eine buchgrosse Sammlung laeuft,
// wird aus einem `x-for`-Rumpf heraus mehrfach je Zeile aufgerufen — der Render
// wird damit quadratisch. Die Tests halten zweierlei fest: dass der Cache greift
// (gleiche Eingabe ⇒ derselbe Rechenlauf) und dass er an den Stellen wieder
// aufmacht, an denen sich die Antwort aendern kann. Der zweite Teil ist der
// wichtigere: ein Cache, der zu lange haelt, ist ein Anzeigefehler.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { kontinuitaetMethods } = await import('../../public/js/book/kontinuitaet.js');
const { kapitelReviewMethods } = await import('../../public/js/book/kapitel-review.js');

// ── Test-Doubles ───────────────────────────────────────────────────────────

function chapter(id, name, pageNames = ['S1']) {
  return {
    id, name, type: 'chapter', solo: false,
    pages: pageNames.map((n, i) => ({ id: id * 100 + i, name: n })),
  };
}

function installAlpine({ tree = [], pages = [], filters = {} } = {}) {
  const stores = {
    nav: { tree, pages, selectedBookId: 1 },
    catalog: { figuren: [] },
    catalogUi: {
      kontinuitaetFilters: { figurId: '', kapitel: '', schwere: '', ...filters },
    },
    shell: { uiLocale: 'de' },
  };
  globalThis.Alpine = { store: (k) => stores[k] };
  globalThis.window = globalThis.window || {};
  globalThis.window.Alpine = globalThis.Alpine;
  globalThis.window.__app = {
    $store: stores,
    t: (k) => k,
    _sortByChapterOrder: (names) => [...names].sort(),
  };
  return stores;
}

function kontinuitaetCtx(stores, issues) {
  return {
    _memos: {},
    kontinuitaetResult: { issues },
    $store: stores,
    ...kontinuitaetMethods,
  };
}

// ── Kontinuitaet: Kapitel-Index ────────────────────────────────────────────

test('_kontinuitaetChapters: liefert bei unveraendertem Baum dasselbe Objekt', () => {
  const stores = installAlpine({ tree: [chapter(1, 'Eins'), chapter(2, 'Zwei')] });
  const ctx = kontinuitaetCtx(stores, []);
  const a = ctx._kontinuitaetChapters();
  const b = ctx._kontinuitaetChapters();
  assert.equal(a, b, 'zweiter Aufruf muss aus dem Cache kommen');
  assert.deepEqual([...a.byId.keys()], [1, 2]);
});

test('_kontinuitaetChapters: neuer Baum und geaenderte Kapitelzahl brechen den Cache', () => {
  const stores = installAlpine({ tree: [chapter(1, 'Eins')] });
  const ctx = kontinuitaetCtx(stores, []);
  const first = ctx._kontinuitaetChapters();

  stores.nav.tree = [chapter(1, 'Eins'), chapter(2, 'Zwei')]; // Neuladen: neue Referenz
  const second = ctx._kontinuitaetChapters();
  assert.notEqual(second, first);
  assert.equal(second.list.length, 2);

  stores.nav.tree.push(chapter(3, 'Drei')); // in place: Referenz gleich, Laenge nicht
  const third = ctx._kontinuitaetChapters();
  assert.notEqual(third, second);
  assert.equal(third.list.length, 3);
});

test('_kontinuitaetChapters: haelt lebende Baum-Objekte — Umbenennen bleibt sichtbar', () => {
  // Der Buchorganizer benennt Kapitel IN PLACE um (crud.js: `it.name = neu`).
  // Der Index cached darum bewusst keine Namen, sondern die Objekte selbst.
  const ch = chapter(1, 'Alter Name');
  const stores = installAlpine({ tree: [ch] });
  const ctx = kontinuitaetCtx(stores, []);
  ctx._kontinuitaetChapters();
  ch.name = 'Neuer Name';
  assert.equal(ctx._kontinuitaetChapters().list[0].name, 'Neuer Name');
});

// ── Kontinuitaet: Stellen-Aufloesung ───────────────────────────────────────

test('kontinuitaetResolveStelle: chapter_ids gewinnen vor dem Namen in der Stelle', () => {
  const stores = installAlpine({ tree: [chapter(1, 'Eins', ['A1']), chapter(2, 'Zwei', ['B1'])] });
  const ctx = kontinuitaetCtx(stores, []);
  const page = ctx.kontinuitaetResolveStelle('Eins', { chapter_ids: [2] }, 'a');
  assert.equal(page.name, 'B1');
});

test('kontinuitaetResolveStelle: Seite 2 der Stelle, Kapitel-Fallback, Seite ueber Namen', () => {
  const stores = installAlpine({ tree: [chapter(1, 'Eins', ['A1', 'A2'])] });
  const ctx = kontinuitaetCtx(stores, []);
  assert.equal(ctx.kontinuitaetResolveStelle('Eins: A2', {}, 'a').name, 'A2');
  assert.equal(ctx.kontinuitaetResolveStelle('Eins', {}, 'a').name, 'A1');
  assert.equal(ctx.kontinuitaetResolveStelle('Unbekannt', {}, 'a'), null);
});

test('kontinuitaetResolveStelle: side b nimmt das zweite Kapitel des Befunds', () => {
  const stores = installAlpine({ tree: [chapter(1, 'Eins', ['A1']), chapter(2, 'Zwei', ['B1'])] });
  const ctx = kontinuitaetCtx(stores, []);
  const issue = { chapter_ids: [1, 2] };
  assert.equal(ctx.kontinuitaetResolveStelle('x', issue, 'a').name, 'A1');
  assert.equal(ctx.kontinuitaetResolveStelle('x', issue, 'b').name, 'B1');
});

// ── Kontinuitaet: Befundliste ──────────────────────────────────────────────

const ISSUES = [
  { id: 1, schwere: 'niedrig', resolved: false, typ: 'a' },
  { id: 2, schwere: 'kritisch', resolved: false, typ: 'b' },
  { id: 3, schwere: 'mittel',  resolved: false, typ: 'c' },
];

test('kontinuitaetIssuesSorted: cached, sortiert nach Schwere', () => {
  const stores = installAlpine({ tree: [chapter(1, 'Eins')] });
  const ctx = kontinuitaetCtx(stores, ISSUES.map(i => ({ ...i })));
  const a = ctx.kontinuitaetIssuesSorted();
  assert.deepEqual(a.map(i => i.id), [2, 3, 1]);
  assert.equal(ctx.kontinuitaetIssuesSorted(), a, 'zweiter Aufruf aus dem Cache');
});

test('kontinuitaetIssuesSorted: Erledigt-Umschalten sortiert sofort neu', () => {
  // `resolved` wird optimistisch IN PLACE gesetzt; ohne gezielte Invalidierung
  // bliebe die Zeile bis zum naechsten Laden an ihrem Platz.
  const stores = installAlpine({ tree: [chapter(1, 'Eins')] });
  const ctx = kontinuitaetCtx(stores, ISSUES.map(i => ({ ...i })));
  const before = ctx.kontinuitaetIssuesSorted();
  assert.equal(before[0].id, 2);

  before[0].resolved = true;
  ctx._invalidateKontinuitaetSort();
  assert.deepEqual(ctx.kontinuitaetIssuesSorted().map(i => i.id), [3, 1, 2]);
});

test('kontinuitaetIssuesFiltered: Filterwechsel bricht den Cache', () => {
  const stores = installAlpine({ tree: [chapter(1, 'Eins'), chapter(2, 'Zwei')] });
  const ctx = kontinuitaetCtx(stores, [
    { id: 1, schwere: 'mittel', kapitel: ['Eins'] },
    { id: 2, schwere: 'mittel', kapitel: ['Zwei'] },
  ]);
  assert.equal(ctx.kontinuitaetIssuesFiltered().length, 2);
  stores.catalogUi.kontinuitaetFilters.kapitel = 'Zwei';
  assert.deepEqual(ctx.kontinuitaetIssuesFiltered().map(i => i.id), [2]);
});

// ── Kapitel-Review: Eignungs-Praedikat der Sidebar ─────────────────────────

function reviewCtx(stores) {
  return {
    _chapterReviewEligibleMemo: null,
    $store: stores,
    _bookQualifiesForChapterReview: kapitelReviewMethods._bookQualifiesForChapterReview,
  };
}

test('_bookQualifiesForChapterReview: erst ab einem Kapitel mit mehreren Seiten', () => {
  const stores = installAlpine({ tree: [chapter(1, 'Eins', ['A'])], pages: [{ id: 100 }] });
  const ctx = reviewCtx(stores);
  assert.equal(ctx._bookQualifiesForChapterReview(), false);

  stores.nav.tree = [chapter(1, 'Eins', ['A', 'B'])];
  stores.nav.pages = [{ id: 100 }, { id: 101 }];
  assert.equal(ctx._bookQualifiesForChapterReview(), true);
});

test('_bookQualifiesForChapterReview: Seite anlegen und verschieben brechen den Cache', () => {
  const ch1 = chapter(1, 'Eins', ['A']);
  const ch2 = chapter(2, 'Zwei', ['B']);
  const stores = installAlpine({ tree: [ch1, ch2], pages: [{ id: 100 }, { id: 200 }] });
  const ctx = reviewCtx(stores);
  assert.equal(ctx._bookQualifiesForChapterReview(), false);

  // Seite anlegen: Baum-Referenz bleibt, die flache Seitenliste waechst.
  ch1.pages = [...ch1.pages, { id: 101, name: 'A2' }];
  stores.nav.pages.push({ id: 101 });
  assert.equal(ctx._bookQualifiesForChapterReview(), true, 'Laenge der Seitenliste muss greifen');

  // Verschieben: Laenge bleibt, der Buchorganizer weist `nav.pages` neu zu.
  ch1.pages = [{ id: 100, name: 'A' }];
  ch2.pages = [{ id: 200, name: 'B' }, { id: 101, name: 'A2' }];
  stores.nav.pages = [...stores.nav.pages];
  assert.equal(ctx._bookQualifiesForChapterReview(), true);

  ch2.pages = [{ id: 200, name: 'B' }];
  stores.nav.pages = [{ id: 100 }, { id: 200 }];
  assert.equal(ctx._bookQualifiesForChapterReview(), false);
});

test('_bookQualifiesForChapterReview: zweiter Aufruf rechnet nicht neu', () => {
  const stores = installAlpine({ tree: [chapter(1, 'Eins', ['A', 'B'])], pages: [{ id: 1 }, { id: 2 }] });
  const ctx = reviewCtx(stores);
  ctx._bookQualifiesForChapterReview();
  const memo = ctx._chapterReviewEligibleMemo;
  ctx._bookQualifiesForChapterReview();
  assert.equal(ctx._chapterReviewEligibleMemo, memo, 'Memo-Objekt darf nicht neu geschrieben werden');
});
