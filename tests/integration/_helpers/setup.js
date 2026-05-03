'use strict';
// Test bootstrap. Order matters: env -> mocks -> require pipeline modules.

const fs = require('fs');
const os = require('os');
const path = require('path');

function bootstrap() {
  const dbFile = path.join(os.tmpdir(), `lektorat-test-${process.pid}-${Date.now()}.db`);
  process.env.DB_PATH = dbFile;
  process.env.API_PROVIDER = process.env.API_PROVIDER || 'claude';
  process.env.MAX_CONCURRENT_JOBS = '1';
  // Tight token budget so multi-pass kicks in at ~20K chars instead of 600K.
  // Tests with smaller payloads still hit single-pass.
  process.env.MODEL_CONTEXT = process.env.MODEL_CONTEXT || '10000';
  process.env.MODEL_TOKEN = process.env.MODEL_TOKEN || '2000';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

  const mockAi = require('./mock-ai');
  const mockBs = require('./mock-bookstack');
  mockAi.install();
  mockBs.install();

  // Now safe to require pipeline modules — they'll pick up the mocked deps.
  const komplett = require('../../../routes/jobs/komplett');
  const review = require('../../../routes/jobs/review');
  const kapitel = require('../../../routes/jobs/kapitel');
  const shared = require('../../../routes/jobs/shared');
  const dbSchema = require('../../../db/schema');

  function cleanup() {
    try { fs.unlinkSync(dbFile); } catch (_) {}
    try { fs.unlinkSync(`${dbFile}-wal`); } catch (_) {}
    try { fs.unlinkSync(`${dbFile}-shm`); } catch (_) {}
  }

  return { mockAi, mockBs, komplett, review, kapitel, shared, dbSchema, dbFile, cleanup };
}

async function waitForJob(shared, jobId, { timeoutMs = 5000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = shared.jobs.get(jobId);
    if (job && (job.status === 'done' || job.status === 'error' || job.status === 'cancelled')) return job;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error(`waitForJob: timeout after ${timeoutMs}ms`);
}

module.exports = { bootstrap, waitForJob };
