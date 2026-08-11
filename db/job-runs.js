'use strict';
// Job-Laufzeiten (`job_runs`): eine Zeile pro Job mit Queue-/Start-/Endzeit,
// Token-Verbrauch und Fehlergrund. Quelle der Job-Statistiken und der
// /metrics-Kennzahlen.

const { db } = require('./connection');
// Prepared Statements dieses Moduls sitzen auf migrierten Spalten — die
// Migrationen muessen vor dem Anlegen gelaufen sein.
require('./migrations');
// Kosten-Ledger: endJobRun bucht den Lauf zusaetzlich dort ein (Kosten pro
// Job/Call-Klasse), damit Abrechnung und Job-Historie nicht auseinanderlaufen.
const { recordJobLedger } = require('./cost-ledger');
const { NOW_ISO_SQL } = require('./now');

const _stmtInsJobRun = db.prepare(
  `INSERT INTO job_runs (job_id, type, book_id, user_email, label, provider, model, status, queued_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ${NOW_ISO_SQL})`
);
const _stmtStartJobRun = db.prepare(
  `UPDATE job_runs SET status = 'running', started_at = ${NOW_ISO_SQL} WHERE job_id = ?`
);
const _stmtEndJobRun = db.prepare(
  `UPDATE job_runs SET status = ?, ended_at = ${NOW_ISO_SQL}, tokens_in = ?, tokens_out = ?, cache_read_in = ?, cache_creation_in = ?, cache_creation_1h_in = ?, tokens_per_sec = ?, error = ?, error_params = ? WHERE job_id = ?`
);

function insertJobRun(job) {
  // bookId normalisieren: System-Jobs (Backfill, Synonym ohne Buch, …) übergeben
  // 0 als „kein Buchkontext". Mig 83 hat die books-Sentinel-Zeile (book_id=0)
  // entfernt → FK `job_runs.book_id REFERENCES books(book_id)` würde brechen.
  // Nicht-positive / nicht-numerische Werte daher als NULL persistieren.
  const bookNum = Number(job.bookId);
  const bookId = Number.isInteger(bookNum) && bookNum > 0 ? bookNum : null;
  _stmtInsJobRun.run(
    job.id, job.type, bookId, job.userEmail || null, job.label || null,
    job.provider || null, job.model || null,
  );
}
function startJobRun(jobId) {
  _stmtStartJobRun.run(jobId);
}
function endJobRun(jobId, status, tokensIn, tokensOut, cacheReadIn, cacheCreationIn, cacheCreation1hIn, tokensPerSec, error, errorParams = null) {
  const paramsJson = errorParams ? JSON.stringify(errorParams) : null;
  _stmtEndJobRun.run(
    status,
    tokensIn || 0, tokensOut || 0,
    cacheReadIn || 0, cacheCreationIn || 0, cacheCreation1hIn || 0,
    tokensPerSec ?? null, error || null, paramsJson, jobId,
  );
  // Eingefrorene Kosten ins persistente Ledger schreiben (chat-sourced Typen
  // werden dort uebersprungen — ihr Verbrauch laeuft ueber chat_messages).
  recordJobLedger(jobId);
}

/** Setzt alle hängenden job_runs (status 'running' oder 'queued') auf 'error'.
 *  Gibt die Anzahl bereinigter Einträge zurück. */
function cleanupStuckJobRuns() {
  const result = db.prepare(
    `UPDATE job_runs SET status = 'error', ended_at = ${NOW_ISO_SQL}, error = 'Job-Prozess gestorben (Server-Neustart oder Absturz)'
     WHERE status IN ('running', 'queued')`
  ).run();
  return result.changes;
}

module.exports = {
  insertJobRun,
  startJobRun,
  endJobRun,
  cleanupStuckJobRuns,
};
