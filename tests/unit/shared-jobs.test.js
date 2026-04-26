'use strict';
// Tests für routes/jobs/shared.js:
//  - aiCall: wirft i18nError wenn callAI {truncated:true} liefert (verhindert
//    «silent partial»-Bug, bei dem jsonrepair Partial-JSON zurückliefert)
//  - findActiveJobId: matcht nur queued/running, ignoriert done/error/cancelled
//
// Lädt shared.js mit gestubbtem lib/ai-Modul und temporärer DB.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Test-DB in tmpfs, damit kein lektorat.db angefasst wird.
const tmpDb = path.join(os.tmpdir(), `lektorat-test-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmpDb;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
// Kein API_PROVIDER → defaults auf claude (kein Netzwerk – wir stubben callAI ohnehin).

// lib/ai stubben BEVOR shared.js geladen wird. parseJSON muss spy-bar sein,
// damit der Test verifizieren kann, dass es bei truncated:true NICHT aufgerufen wird.
const aiPath = require.resolve('../../lib/ai');
const realAi = require(aiPath);
let parseCalls = 0;
let mockResult = null;
require.cache[aiPath].exports = {
  ...realAi,
  callAI: async () => mockResult,
  parseJSON: (text) => { parseCalls++; return realAi.parseJSON(text); },
};

const shared = require('../../routes/jobs/shared');

test.after(() => {
  // Schreibgeschütztes Locking durch better-sqlite3 → Datei am Ende abräumen.
  try { fs.unlinkSync(tmpDb); } catch {}
  try { fs.unlinkSync(tmpDb + '-wal'); } catch {}
  try { fs.unlinkSync(tmpDb + '-shm'); } catch {}
});

// ── aiCall: truncated → throw vor parseJSON ─────────────────────────────────
test('aiCall: truncated=true wirft i18nError VOR parseJSON', async () => {
  const jobId = shared.createJob('test', 'b1', 'u@x', null);
  // Job auf running setzen, damit updateJob die Felder schreibt.
  const jobs = shared.jobs;
  jobs.get(jobId).status = 'running';
  parseCalls = 0;
  mockResult = {
    text: '{"fehler":[{"a":1}', // bewusst Partial-JSON – jsonrepair würde es reparieren
    truncated: true,
    tokensIn: 1000,
    tokensOut: 16000,
    genDurationMs: 1200,
  };
  const tok = { in: 0, out: 0, ms: 0 };
  await assert.rejects(
    shared.aiCall(jobId, tok, 'prompt', 'system'),
    err => {
      assert.equal(err.message, 'job.error.aiTruncated');
      assert.equal(err.i18nParams.tokOut, 16000);
      return true;
    },
  );
  assert.equal(parseCalls, 0,
    'parseJSON darf bei truncated NICHT aufgerufen werden – sonst liefert jsonrepair Partial-Daten');
});

test('aiCall: truncated=false → parseJSON wird normal ausgeführt', async () => {
  const jobId = shared.createJob('test', 'b2', 'u@x', null);
  shared.jobs.get(jobId).status = 'running';
  parseCalls = 0;
  mockResult = {
    text: '{"fehler":[]}',
    truncated: false,
    tokensIn: 100, tokensOut: 50, genDurationMs: 300,
  };
  const tok = { in: 0, out: 0, ms: 0 };
  const out = await shared.aiCall(jobId, tok, 'prompt', 'system');
  assert.deepEqual(out, { fehler: [] });
  assert.equal(parseCalls, 1);
});

// ── findActiveJobId: nur aktive Jobs matchen ────────────────────────────────
test('findActiveJobId: queued-Job → matcht', () => {
  const id = shared.createJob('lektorat', 'pageX', 'u1@x', null);
  // createJob setzt status='queued'
  assert.equal(shared.findActiveJobId('lektorat', 'pageX', 'u1@x'), id);
});

test('findActiveJobId: running-Job → matcht', () => {
  const id = shared.createJob('check', 'pageY', 'u2@x', null);
  shared.jobs.get(id).status = 'running';
  assert.equal(shared.findActiveJobId('check', 'pageY', 'u2@x'), id);
});

test('findActiveJobId: done-Job → matcht NICHT (ohne Status-Filter würde Frontend toten Job pollen)', () => {
  const id = shared.createJob('check', 'pageZ', 'u3@x', null);
  shared.jobs.get(id).status = 'done';
  assert.equal(shared.findActiveJobId('check', 'pageZ', 'u3@x'), null);
});

test('findActiveJobId: error/cancelled → matcht NICHT', () => {
  const idErr = shared.createJob('check', 'pageE', 'u4@x', null);
  shared.jobs.get(idErr).status = 'error';
  assert.equal(shared.findActiveJobId('check', 'pageE', 'u4@x'), null);

  const idCan = shared.createJob('check', 'pageC', 'u5@x', null);
  shared.jobs.get(idCan).status = 'cancelled';
  assert.equal(shared.findActiveJobId('check', 'pageC', 'u5@x'), null);
});

test('findActiveJobId: scope userEmail – fremder User sieht Job nicht', () => {
  const id = shared.createJob('review', 'b9', 'alice@x', null);
  shared.jobs.get(id).status = 'running';
  assert.equal(shared.findActiveJobId('review', 'b9', 'alice@x'), id);
  assert.equal(shared.findActiveJobId('review', 'b9', 'bob@x'), null);
});

test('findActiveJobId: scope type – anderer Job-Typ matcht nicht', () => {
  const id = shared.createJob('review', 'b10', 'u@x', null);
  shared.jobs.get(id).status = 'running';
  assert.equal(shared.findActiveJobId('check', 'b10', 'u@x'), null);
});

test('findActiveJobId: kein Job → null (kein Crash)', () => {
  assert.equal(shared.findActiveJobId('does-not-exist', 'no-id', 'no@one'), null);
});
