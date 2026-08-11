'use strict';
// Job-Checkpoints (`job_checkpoints`).

const { db } = require('./connection');
// Prepared Statements dieses Moduls sitzen auf migrierten Spalten — die
// Migrationen muessen vor dem Anlegen gelaufen sein.
require('./migrations');
const { NOW_ISO_SQL } = require('./now');
const { requireUserEmail: _requireUserEmail } = require('./write-helpers');

// Speichert Zwischenergebnisse für Multi-Pass-Jobs, damit diese nach einem
// Server-Neustart fortgesetzt werden können statt von vorne zu beginnen.
// user_email ist Teil des UNIQUE-Constraints (job_type, book_id, user_email)
// und FK auf app_users(email) — der Schreibpfad verlangt deshalb einen echten
// User (siehe _requireUserEmail).

const _saveCheckpoint = db.prepare(`
  INSERT INTO job_checkpoints (job_type, book_id, user_email, data, updated_at)
  VALUES (?, ?, ?, ?, ${NOW_ISO_SQL})
  ON CONFLICT(job_type, book_id, user_email) DO UPDATE SET
    data = excluded.data, updated_at = excluded.updated_at
`);
const _loadCheckpoint = db.prepare(
  'SELECT data FROM job_checkpoints WHERE job_type = ? AND book_id = ? AND user_email = ?'
);
const _deleteCheckpoint = db.prepare(
  'DELETE FROM job_checkpoints WHERE job_type = ? AND book_id = ? AND user_email = ?'
);

function saveCheckpoint(jobType, bookId, userEmail, data) {
  const email = _requireUserEmail(userEmail, `saveCheckpoint(${jobType})`);
  _saveCheckpoint.run(jobType, parseInt(bookId), email, JSON.stringify(data));
}
function loadCheckpoint(jobType, bookId, userEmail) {
  const row = _loadCheckpoint.get(jobType, parseInt(bookId), userEmail || '');
  return row ? JSON.parse(row.data) : null;
}
function deleteCheckpoint(jobType, bookId, userEmail) {
  _deleteCheckpoint.run(jobType, parseInt(bookId), userEmail || '');
}

module.exports = {
  saveCheckpoint,
  loadCheckpoint,
  deleteCheckpoint,
};
