// Geteilte Heartbeat-Invarianten der drei Zeit-Tracker (writing-time,
// lektorat-time, stt-time): Tick-Clamp gegen gestallte Timer + Tab-Lease gegen
// Doppelzählung durch parallele Tabs.
//
// Zwei "Tabs" simuliert das Suite über zwei Modul-Instanzen (Cache-Bust via
// Query-String) — jede zieht beim Laden ihre eigene TAB_ID.

import { strict as assert } from 'node:assert';
import test from 'node:test';

// Minimaler localStorage-Stub. Muss VOR dem ersten Import stehen: das Modul
// liest globalThis.localStorage zwar erst zur Aufrufzeit, aber so ist die
// Reihenfolge in jedem Testlauf identisch.
function installStorage() {
  const map = new Map();
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => map.clear(),
  };
  return map;
}
const store = installStorage();

const MOD = '../../public/js/book/heartbeat.js';
const tabA = await import(MOD);
const tabB = await import(`${MOD}?tab=b`);

test('clampTickSeconds: normaler Tick bleibt unangetastet', () => {
  assert.equal(tabA.clampTickSeconds(15), 15);
  assert.equal(tabA.clampTickSeconds(15.4), 15);
  assert.equal(tabA.clampTickSeconds(29), 29);
});

test('clampTickSeconds: Suspend-Lücke wird auf zwei Intervalle gedeckelt', () => {
  const max = tabA._internals.MAX_TICK_SECONDS;
  assert.equal(max, 30);
  assert.equal(tabA.clampTickSeconds(3600), max);   // 1 h Systemschlaf
  assert.equal(tabA.clampTickSeconds(36000), max);  // 10 h über Nacht
});

test('clampTickSeconds: unbrauchbare Werte werden zu 0', () => {
  for (const v of [0, -5, NaN, undefined, null, 'abc', Infinity]) {
    assert.equal(tabA.clampTickSeconds(v), 0, `${String(v)} → 0`);
  }
});

test('acquireTickLease: erster Tab gewinnt, zweiter Tab wird blockiert', () => {
  store.clear();
  const now = 1_000_000;
  assert.equal(tabA.acquireTickLease('writing', now), true);
  assert.equal(tabB.acquireTickLease('writing', now), false);
  // Halter darf beliebig oft erneuern.
  assert.equal(tabA.acquireTickLease('writing', now + 15_000), true);
  assert.equal(tabB.acquireTickLease('writing', now + 15_000), false);
});

test('acquireTickLease: Leases sind pro Tracker getrennt', () => {
  store.clear();
  const now = 2_000_000;
  assert.equal(tabA.acquireTickLease('writing', now), true);
  // Anderer Tracker → eigener Schlüssel, tabB kommt zum Zug.
  assert.equal(tabB.acquireTickLease('lektorat', now), true);
  assert.equal(tabB.acquireTickLease('writing', now), false);
});

test('acquireTickLease: abgelaufenes Lease wird übernommen', () => {
  store.clear();
  const now = 3_000_000;
  assert.equal(tabA.acquireTickLease('writing', now), true);
  // Halter verstummt (Crash/Tab-Kill ohne pagehide) → nach LEASE_MS übernimmt B.
  const later = now + tabA._internals.LEASE_MS + 1;
  assert.equal(tabB.acquireTickLease('writing', later), true);
  assert.equal(tabA.acquireTickLease('writing', later), false);
});

test('releaseTickLease: Halter gibt sofort frei, Fremder nicht', () => {
  store.clear();
  const now = 4_000_000;
  assert.equal(tabA.acquireTickLease('writing', now), true);
  // B hält es nicht → release ist ein No-Op, A bleibt Halter.
  tabB.releaseTickLease('writing');
  assert.equal(tabB.acquireTickLease('writing', now), false);
  // A gibt frei → B übernimmt ohne LEASE_MS abzuwarten.
  tabA.releaseTickLease('writing');
  assert.equal(tabB.acquireTickLease('writing', now), true);
});

test('acquireTickLease: korrupter Eintrag wird überschrieben statt zu blockieren', () => {
  store.clear();
  globalThis.localStorage.setItem(tabA._internals.LEASE_PREFIX + 'writing', '{kein json');
  assert.equal(tabA.acquireTickLease('writing', 5_000_000), true);
});

test('acquireTickLease: ohne localStorage zählen alle Tabs (kein Datenverlust)', () => {
  const saved = globalThis.localStorage;
  globalThis.localStorage = null;
  try {
    assert.equal(tabA.acquireTickLease('writing', 6_000_000), true);
    assert.equal(tabB.acquireTickLease('writing', 6_000_000), true);
  } finally {
    globalThis.localStorage = saved;
  }
});

test('die beiden Modul-Instanzen haben verschiedene TAB_IDs', () => {
  assert.notEqual(tabA._internals.TAB_ID, tabB._internals.TAB_ID);
});
