'use strict';

// JSONL-Nutzdaten liegen NICHT in job.result, weil der generische Status-GET
// (/jobs/:id) die gesamte result-Struktur serialisiert — bei einem grossen Buch
// wären das Megabytes pro Poll. Stattdessen: eigener Store, TTL analog zur
// Job-Cleanup (2 h nach Abschluss, siehe shared.js:_scheduleJobCleanup).
const JSONL_TTL_MS = 2 * 60 * 60 * 1000;
const finetuneResultStore = new Map();

function storeFinetuneResult(jobId, payload) {
  finetuneResultStore.set(jobId, payload);
  const t = setTimeout(() => finetuneResultStore.delete(jobId), JSONL_TTL_MS);
  t.unref?.();
}

module.exports = { finetuneResultStore, storeFinetuneResult };
