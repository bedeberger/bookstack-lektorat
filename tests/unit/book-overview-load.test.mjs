// Tests für loadBookOverview Dedupe + Buchwechsel-Race.
// Symptom: nach Combobox-Buchwechsel feuern view:reset (sync) +
// $watch('selectedBookId') → book:changed (async) beide einen Reset+Load. Race
// liess Tiles partial verschwinden, hard refresh fixte. Card-init coalesciert
// jetzt via Microtask, loadBookOverview deduped per `_loadingBookId`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bookOverviewMethods } from '../../public/js/book-overview.js';

// fetch-Stub: Promise.all bekommt alles auf einmal — kontrolliert resolved.
let fetchCalls = [];
let fetchDelay = 0;
globalThis.fetch = async (url) => {
  fetchCalls.push(String(url));
  if (fetchDelay) await new Promise(r => setTimeout(r, fetchDelay));
  return { ok: true, json: async () => [] };
};

function makeCtx() {
  const ctx = {
    overviewLoading: false,
    overviewBookId: null,
    overviewStats: [],
    overviewCoverage: null,
    overviewHeat: null,
    overviewLastReview: null,
    overviewPrevReview: null,
    overviewRecent: [],
    overviewFiguren: [],
    overviewSzenen: [],
    overviewOrte: [],
    overviewLektoratTime: null,
    _memos: {},
    ...bookOverviewMethods,
  };
  return ctx;
}

test('loadBookOverview dedupes parallele Calls für gleiches Buch', async () => {
  fetchCalls = [];
  fetchDelay = 20;
  const ctx = makeCtx();

  const p1 = ctx.loadBookOverview(42);
  const p2 = ctx.loadBookOverview(42);
  const p3 = ctx.loadBookOverview(42);
  await Promise.all([p1, p2, p3]);

  // 9 Endpoints × 1 Load (statt 3 × 9 = 27)
  assert.equal(fetchCalls.length, 9, 'nur ein Load darf laufen');
  assert.equal(ctx.overviewBookId, 42);
  fetchDelay = 0;
});

test('loadBookOverview: zweiter Call mit anderem Buch ersetzt ersten', async () => {
  fetchCalls = [];
  fetchDelay = 20;
  const ctx = makeCtx();

  const p1 = ctx.loadBookOverview(42);
  // Sofort zweite Buch-ID — startet weiteren Load.
  const p2 = ctx.loadBookOverview(99);
  await Promise.all([p1, p2]);

  // Beide Loads laufen (verschiedene Bücher), je 9 Calls.
  assert.equal(fetchCalls.length, 18);
  // Letztes Buch wins — overviewBookId-Guard verhindert Stale-Assign.
  assert.equal(ctx.overviewBookId, 99);
  // Stats wurden für 99 geholt, nicht für 42.
  const lastStatsCall = fetchCalls.find(u => u.includes('book-stats') && u.includes('99'));
  assert.ok(lastStatsCall, 'book-stats für 99 muss aufgerufen worden sein');
  fetchDelay = 0;
});

test('loadBookOverview räumt _loadingBookId nach Abschluss', async () => {
  fetchCalls = [];
  const ctx = makeCtx();
  await ctx.loadBookOverview(42);
  assert.equal(ctx._loadingBookId, null, 'nach Done muss _loadingBookId frei sein');

  // Nach Done darf erneuter Call wieder durchlaufen.
  await ctx.loadBookOverview(42);
  assert.equal(fetchCalls.length, 18);
});

test('overviewOrtPresence invalidiert Memo wenn tree nachgeladen wird', () => {
  // Bug vorher: load(B) füllte overviewOrte, aber `app.tree` war noch [],
  // weil loadPages parallel lief. Erste Memo-Compute → null cached. Tree
  // nachgeladen → overviewOrte-Ref unverändert → Memo-Hit liefert null
  // weiter → Tile blieb verschwunden bis Hard-Refresh.
  const ctx = makeCtx();
  const orte = [{ id: 1, name: 'Olten', kapitel: [{ chapter_id: 10, name: 'Kap A', haeufigkeit: 3 }] }];
  ctx.overviewOrte = orte;

  // Phase 1: tree leer → null
  globalThis.window = { __app: { tree: [] } };
  assert.equal(ctx.overviewOrtPresence(), null, 'leerer tree → null');

  // Phase 2: tree befüllt → muss neu computen, nicht null aus Cache
  globalThis.window = { __app: { tree: [{ type: 'chapter', id: 10, name: 'Kap A' }] } };
  const result = ctx.overviewOrtPresence();
  assert.ok(result, 'mit befülltem tree muss Resultat kommen');
  assert.equal(result.places.length, 1);
  assert.equal(result.rows.length, 1);
});

test('overviewFigurePresence invalidiert Memo wenn tree nachgeladen wird', () => {
  const ctx = makeCtx();
  ctx.overviewFiguren = [{ id: 1, name: 'Robert' }];
  ctx.overviewSzenen = [{ chapter_id: 10, kapitel: 'Kap A', fig_ids: [1] }];

  globalThis.window = { __app: { tree: [] } };
  assert.equal(ctx.overviewFigurePresence(), null, 'leerer tree → null');

  globalThis.window = { __app: { tree: [{ type: 'chapter', id: 10, name: 'Kap A' }] } };
  const result = ctx.overviewFigurePresence();
  assert.ok(result, 'mit tree muss Resultat kommen');
  assert.equal(result.figures.length, 1);
  assert.equal(result.rows.length, 1);
});
