'use strict';
// Invarianten des Integration-Harness-Pollers (tests/integration/_helpers/setup.js).
// Sein Budget zaehlt Event-Loop-Zeit statt Wandzeit — sonst kippen die
// Job-Pipeline-Tests auf ueberbuchten CI-Runnern in falsche Timeouts, waehrend
// ein echt haengender Job weiterhin zuegig auffallen muss.
//
// Der Hard-Cap-Pfad (Dauer-Stall -> Abbruch nach max(60s, 20x Budget)) ist hier
// bewusst nicht getestet: er kostet per Definition eine Minute Wandzeit.

const test = require('node:test');
const assert = require('node:assert/strict');

const { waitForJob } = require('../integration/_helpers/setup');

function shim(status) {
  const job = { status };
  return { jobs: new Map([['j1', job]]), job };
}

test('waitForJob: terminale Stati werden sofort zurueckgegeben', async () => {
  for (const status of ['done', 'error', 'cancelled']) {
    const shared = shim(status);
    const job = await waitForJob(shared, 'j1', { timeoutMs: 200 });
    assert.equal(job.status, status);
  }
});

test('waitForJob: haengender Job scheitert nahe am Budget', async () => {
  const shared = shim('running');
  const t0 = Date.now();
  await assert.rejects(
    () => waitForJob(shared, 'j1', { timeoutMs: 300 }),
    /timeout after 300ms Loop-Budget/,
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 2000, `Timeout kam erst nach ${elapsed}ms — Toleranz zu grosszuegig`);
});

test('waitForJob: Fehlermeldung nennt Job-Status (Diagnose)', async () => {
  const shared = shim('running');
  await assert.rejects(() => waitForJob(shared, 'j1', { timeoutMs: 60 }), /Job-Status: running/);
  // Unbekannte ID -> explizit als solche gemeldet, nicht als stiller Timeout.
  await assert.rejects(() => waitForJob(shared, 'fehlt', { timeoutMs: 60 }), /nicht in shared\.jobs/);
});

test('waitForJob: blockierter Event-Loop frisst das Budget nicht', async () => {
  const shared = shim('running');
  // Stall deutlich laenger als das Budget: waehrend die Loop steht, kann auch
  // der Job nicht laufen — das darf kein Timeout werden.
  setTimeout(() => {
    const until = Date.now() + 900;
    while (Date.now() < until) { /* Loop blockieren */ }
    shared.job.status = 'done';
  }, 20);

  const job = await waitForJob(shared, 'j1', { timeoutMs: 200 });
  assert.equal(job.status, 'done');
});
