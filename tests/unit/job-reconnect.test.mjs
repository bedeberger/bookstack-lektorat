// Tests für app-jobs-core: checkPendingJobs + _reconnectJob.
// Beim Buch-Wechsel pollt der Root die Server-Job-Status für gespeicherte
// localStorage-Job-IDs. Bei „running" dispatcht er `job:reconnect`-Events,
// damit Sub-Karten ihren Loading/Polling-State wiederherstellen.
//   - laufender Review-Job → Event mit { type:'review', jobId, job }
//   - laufender Kapitel-Review-Job → Event mit chapter-extra
//   - „done"-Job → kein Event, localStorage geräumt
//   - 404 → kein Event, localStorage geräumt
import test from 'node:test';
import assert from 'node:assert/strict';
import { appJobsCoreMethods } from '../../public/js/app-jobs-core.js';

// ── Stubs ────────────────────────────────────────────────────────────────────
const events = [];
globalThis.window = globalThis.window || {};
globalThis.window.dispatchEvent = (e) => events.push({ type: e.type, detail: e.detail });
globalThis.CustomEvent = globalThis.CustomEvent || class {
  constructor(type, init) { this.type = type; this.detail = init?.detail; }
};

// localStorage-Stub – mimick Browser-API
const lsStore = new Map();
globalThis.localStorage = {
  getItem: (k) => lsStore.has(k) ? lsStore.get(k) : null,
  setItem: (k, v) => { lsStore.set(k, String(v)); },
  removeItem: (k) => { lsStore.delete(k); },
  clear: () => lsStore.clear(),
};

let fetchResponses = new Map();
let fetchCalls = [];
globalThis.fetch = async (url) => {
  fetchCalls.push(String(url));
  if (fetchResponses.has(String(url))) {
    const { ok, status, body } = fetchResponses.get(String(url));
    return { ok, status, json: async () => body };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

function makeCtx() {
  return {
    selectedBookId: 42,
    tree: [],
    figuren: [],
    figurenLoading: false, figurenProgress: 0, figurenStatus: '',
    showFiguresCard: false, showBookReviewCard: false, showKapitelReviewCard: false,
    batchLoading: false, batchProgress: 0, batchStatus: '',
    alleAktualisierenLoading: false, alleAktualisierenProgress: 0,
    alleAktualisierenTokIn: 0, alleAktualisierenTokOut: 0, alleAktualisierenTps: null,
    alleAktualisierenStatus: '', showKomplettStatus: false,
    t: (k) => k,
    startFiguresPoll() {},
    startBatchPoll() {},
    _startKomplettPoll() {},
    _runningJobStatus: () => '',
    ...appJobsCoreMethods,
  };
}

function reset() {
  events.length = 0;
  fetchCalls.length = 0;
  fetchResponses = new Map();
  lsStore.clear();
}

// ── _reconnectJob ────────────────────────────────────────────────────────────
test('_reconnectJob: kein localStorage-Eintrag → kein fetch, kein Callback', async () => {
  reset();
  const c = makeCtx();
  let called = false;
  await c._reconnectJob('lektorat_review_job_42', () => { called = true; });
  assert.equal(called, false);
  assert.equal(fetchCalls.length, 0);
});

test('_reconnectJob: running-Job → onRunning aufgerufen, lsKey bleibt', async () => {
  reset();
  const c = makeCtx();
  lsStore.set('lektorat_review_job_42', 'job-abc');
  fetchResponses.set('/jobs/job-abc', {
    ok: true, status: 200,
    body: { id: 'job-abc', status: 'running', progress: 30 },
  });
  let received = null;
  await c._reconnectJob('lektorat_review_job_42', (job, jobId) => {
    received = { job, jobId };
  });
  assert.ok(received, 'onRunning muss aufgerufen werden');
  assert.equal(received.jobId, 'job-abc');
  assert.equal(received.job.progress, 30);
  assert.equal(localStorage.getItem('lektorat_review_job_42'), 'job-abc',
    'localStorage-Eintrag bleibt während Job läuft');
});

test('_reconnectJob: done-Job → kein Callback, lsKey geräumt', async () => {
  reset();
  const c = makeCtx();
  lsStore.set('lektorat_review_job_42', 'job-done');
  fetchResponses.set('/jobs/job-done', {
    ok: true, status: 200,
    body: { id: 'job-done', status: 'done' },
  });
  let called = false;
  await c._reconnectJob('lektorat_review_job_42', () => { called = true; });
  assert.equal(called, false);
  assert.equal(localStorage.getItem('lektorat_review_job_42'), null,
    'Stale lsKey muss geräumt werden, sonst pollt der Browser ewig einen toten Job');
});

test('_reconnectJob: 404 → kein Callback, lsKey geräumt', async () => {
  reset();
  const c = makeCtx();
  lsStore.set('lektorat_review_job_42', 'job-gone');
  // kein Mock → fetch liefert 404
  let called = false;
  await c._reconnectJob('lektorat_review_job_42', () => { called = true; });
  assert.equal(called, false);
  assert.equal(localStorage.getItem('lektorat_review_job_42'), null);
});

test('_reconnectJob: Netzwerkfehler → silent fallback, kein Callback', async () => {
  reset();
  const c = makeCtx();
  lsStore.set('lektorat_review_job_42', 'job-x');
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  let called = false;
  await c._reconnectJob('lektorat_review_job_42', () => { called = true; });
  globalThis.fetch = origFetch;
  assert.equal(called, false);
});

// ── checkPendingJobs ─────────────────────────────────────────────────────────
test('checkPendingJobs: laufender Review-Job → dispatcht job:reconnect mit type review', async () => {
  reset();
  const c = makeCtx();
  lsStore.set('lektorat_review_job_42', 'rev-1');
  fetchResponses.set('/jobs/rev-1', {
    ok: true, status: 200,
    body: { id: 'rev-1', status: 'running', progress: 50 },
  });
  // /jobs/active?type=komplett-analyse → 404 (kein laufender Komplett-Job)
  await c.checkPendingJobs(42);
  const ev = events.find(e => e.type === 'job:reconnect' && e.detail?.type === 'review');
  assert.ok(ev, 'job:reconnect-Event mit type=review fehlt');
  assert.equal(ev.detail.jobId, 'rev-1');
  assert.equal(ev.detail.job.progress, 50);
  assert.equal(c.showBookReviewCard, true,
    'Karte muss aufgemacht werden, damit Sub den Loading-State sehen kann');
});

test('checkPendingJobs: kein gespeicherter Job → kein job:reconnect', async () => {
  reset();
  const c = makeCtx();
  await c.checkPendingJobs(42);
  const review = events.find(e => e.type === 'job:reconnect' && e.detail?.type === 'review');
  assert.equal(review, undefined);
});

test('checkPendingJobs: Kapitel-Review – ältestes Kapitel im tree-Order gewinnt bei mehreren Kandidaten', async () => {
  reset();
  const c = makeCtx();
  c.tree = [
    { type: 'chapter', id: 11, name: 'Kap 1' },
    { type: 'page', id: 15 },
    { type: 'chapter', id: 22, name: 'Kap 2' },
  ];
  lsStore.set('lektorat_chapter_review_job_42_11', 'kap-1-job');
  lsStore.set('lektorat_chapter_review_job_42_22', 'kap-2-job');
  fetchResponses.set('/jobs/kap-1-job', {
    ok: true, status: 200,
    body: { id: 'kap-1-job', status: 'running', progress: 20 },
  });
  fetchResponses.set('/jobs/kap-2-job', {
    ok: true, status: 200,
    body: { id: 'kap-2-job', status: 'running', progress: 80 },
  });
  await c.checkPendingJobs(42);
  const ev = events.find(e => e.type === 'job:reconnect' && e.detail?.type === 'kapitel-review');
  assert.ok(ev, 'kapitel-review job:reconnect fehlt');
  assert.equal(ev.detail.jobId, 'kap-1-job',
    'Erstes Kapitel im tree-Order muss gewinnen, sonst flackert die UI bei mehreren parallelen Reviews');
  assert.equal(ev.detail.extra.chapterId, 11);
});

test('checkPendingJobs: Kapitel-Review nicht running → lsKey geräumt, kein Event', async () => {
  reset();
  const c = makeCtx();
  c.tree = [{ type: 'chapter', id: 33 }];
  lsStore.set('lektorat_chapter_review_job_42_33', 'stale');
  fetchResponses.set('/jobs/stale', {
    ok: true, status: 200,
    body: { id: 'stale', status: 'done' },
  });
  await c.checkPendingJobs(42);
  const ev = events.find(e => e.type === 'job:reconnect' && e.detail?.type === 'kapitel-review');
  assert.equal(ev, undefined);
  assert.equal(localStorage.getItem('lektorat_chapter_review_job_42_33'), null);
});

test('checkPendingJobs: laufender Figuren-Job → setzt Loading + öffnet Karte', async () => {
  reset();
  const c = makeCtx();
  lsStore.set('lektorat_figures_job_42', 'fig-1');
  fetchResponses.set('/jobs/fig-1', {
    ok: true, status: 200,
    body: { id: 'fig-1', status: 'running', progress: 40, statusText: 'job.phase.aiAnalyzing' },
  });
  await c.checkPendingJobs(42);
  assert.equal(c.figurenLoading, true);
  assert.equal(c.figurenProgress, 40);
  assert.equal(c.showFiguresCard, true);
});
