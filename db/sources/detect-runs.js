'use strict';
// Historie der Quellen-Erkennung (`source_detect_runs`, Job `source-detect`).
// Der Lauf haelt seine Vorschlagsliste, aber KEINEN Bibliotheks-Status je Fund —
// der altert und wird bei jedem Oeffnen frisch gerechnet.

const { db } = require('../connection');
const { NOW_ISO_SQL } = require('../now');

// ── Laeufe der Quellen-Erkennung ─────────────────────────────────────────────
// Historie des Jobs `source-detect` (routes/jobs/source-detect.js). Ein Lauf
// liest das ganze Buch mit dem Modell — zu teuer, um sein Ergebnis mit dem
// naechsten Reload zu verlieren.
//
// Die Fundliste liegt als Ganzes in `result_json` und NICHT in Einzelzeilen:
// sie ist unbestaetigter Modell-Output, kein Katalog. Stammdatum wird ein Fund
// erst beim Uebernehmen (`sources` + `book_source_links`).
//
// Der Kapitelname wird NICHT mitgespeichert, sondern zur Lesezeit gejoint —
// benannt das Kapitel sich um, stimmt die Historie weiter. Ein geloeschtes
// Kapitel nullt den FK; `scope` bleibt 'chapter', sodass der Lauf als
// „Kapitel-Lauf ohne Kapitel" erkennbar bleibt statt als Buch-Lauf zu gelten.

const _stmtInsertDetectRun = db.prepare(`
  INSERT INTO source_detect_runs
    (book_id, user_email, scope, scope_chapter_id, created_at, found_count, verified_count, result_json, model)
  VALUES (?, ?, ?, ?, ${NOW_ISO_SQL}, ?, ?, ?, ?)
`);
// Ohne result_json: die Liste zeigt nur Kopfzeilen, das Ergebnis kommt beim
// Oeffnen. Ein Lauf ueber ein grosses Buch traegt hunderte Kilobyte JSON.
const _stmtListDetectRuns = db.prepare(`
  SELECT r.id, r.book_id, r.user_email, r.scope, r.scope_chapter_id,
         r.created_at, r.found_count, r.verified_count, r.model,
         c.chapter_name AS scope_chapter_name
    FROM source_detect_runs r
    LEFT JOIN chapters c ON c.chapter_id = r.scope_chapter_id
   WHERE r.book_id = ? AND r.user_email = ?
   ORDER BY r.created_at DESC, r.id DESC
`);
const _stmtGetDetectRun = db.prepare(`
  SELECT r.*, c.chapter_name AS scope_chapter_name
    FROM source_detect_runs r
    LEFT JOIN chapters c ON c.chapter_id = r.scope_chapter_id
   WHERE r.id = ?
`);
const _stmtDeleteDetectRun = db.prepare(
  'DELETE FROM source_detect_runs WHERE id = ? AND user_email = ?'
);
// Aufbewahrung pro Buch + User. Aeltere Laeufe fallen weg — sie beschreiben
// einen Textstand, den es nicht mehr gibt, und die Liste soll nicht wachsen,
// bis niemand sie mehr liest.
const DETECT_RUN_KEEP = 10;
const _stmtTrimDetectRuns = db.prepare(`
  DELETE FROM source_detect_runs
   WHERE book_id = ? AND user_email = ?
     AND id NOT IN (
       SELECT id FROM source_detect_runs
        WHERE book_id = ? AND user_email = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
     )
`);

const insertDetectRun = db.transaction(({
  bookId, userEmail, scope = 'book', scopeChapterId = null,
  foundCount = 0, verifiedCount = 0, result, model = null,
}) => {
  const chapterId = scope === 'chapter' && scopeChapterId != null ? parseInt(scopeChapterId) : null;
  const info = _stmtInsertDetectRun.run(
    parseInt(bookId), userEmail, scope === 'chapter' ? 'chapter' : 'book', chapterId,
    parseInt(foundCount) || 0, parseInt(verifiedCount) || 0, JSON.stringify(result), model,
  );
  _stmtTrimDetectRuns.run(parseInt(bookId), userEmail, parseInt(bookId), userEmail, DETECT_RUN_KEEP);
  return info.lastInsertRowid;
});

function listDetectRuns(bookId, userEmail) {
  return _stmtListDetectRuns.all(parseInt(bookId), userEmail);
}

function getDetectRun(id) {
  const r = _stmtGetDetectRun.get(parseInt(id));
  if (!r) return null;
  let result = null;
  try { result = JSON.parse(r.result_json); } catch { result = null; }
  return {
    id: r.id, book_id: r.book_id, user_email: r.user_email,
    scope: r.scope, scope_chapter_id: r.scope_chapter_id,
    scope_chapter_name: r.scope_chapter_name || null,
    created_at: r.created_at, found_count: r.found_count,
    verified_count: r.verified_count, model: r.model,
    result,
  };
}

function deleteDetectRun(id, userEmail) {
  return _stmtDeleteDetectRun.run(parseInt(id), userEmail).changes;
}

module.exports = {
  DETECT_RUN_KEEP, insertDetectRun, listDetectRuns, getDetectRun, deleteDetectRun,
};
