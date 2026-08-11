'use strict';
// Lektorats-Laeufe (`page_checks`): Lauf-Historie einer Seite, Detail-JSON,
// Speichern/Loeschen eines Laufs sowie die beiden buchweiten Ableitungen
// Seiten-Alter und Abdeckung.

const { db } = require('../../db/schema');
const { toIntId } = require('../../lib/validate');
const { guardBook, sessionEmail } = require('../../lib/acl');
const { resolvePageBookId } = require('../../lib/content-ownership');
const logger = require('../../logger');
const { jsonBody } = require('./shared');

function register(router) {
  // Lauf als gespeichert markieren (oder zurücksetzen).
  router.patch('/check/:id/saved', jsonBody, (req, res) => {
    const saved = req.body?.saved !== undefined ? (req.body.saved ? 1 : 0) : 1;
    const saved_at = saved ? new Date().toISOString() : null;
    const applied = req.body?.applied_errors_json !== undefined
      ? JSON.stringify(req.body.applied_errors_json)
      : null;
    const selected = req.body?.selected_errors_json !== undefined
      ? JSON.stringify(req.body.selected_errors_json)
      : null;
    const user_email = sessionEmail(req);
    const id = toIntId(req.params.id);
    if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });

    // Erst Ownership prüfen (user_email-Scope), dann updaten. Verhindert ID-Raten
    // über Buch-/User-Grenzen und liefert verifizierte book_id für das Log.
    const row = db.prepare(`
      SELECT pc.page_id, p.page_name, pc.book_id, pc.chapter_id
      FROM page_checks pc
      LEFT JOIN pages p ON p.page_id = pc.page_id
      WHERE pc.id = ? AND pc.user_email = ?
    `).get(id, user_email);
    if (!row) return res.status(404).json({ error_code: 'NOT_FOUND' });
    if (!row.book_id) return res.status(400).json({ error_code: 'CHECK_HAS_NO_BOOK' });
    if (!guardBook(req, res, row.book_id, 'lektor')) return;

    db.prepare('UPDATE page_checks SET saved = ?, saved_at = ?, applied_errors_json = COALESCE(?, applied_errors_json), selected_errors_json = COALESCE(?, selected_errors_json) WHERE id = ? AND user_email = ? AND book_id = ?')
      .run(saved, saved_at, applied, selected, id, user_email, row.book_id);

    if (saved) {
      const appliedErrors = req.body?.applied_errors_json;
      if (Array.isArray(appliedErrors)) {
        const counts = { rechtschreibung: 0, grammatik: 0, wiederholung: 0, stil: 0 };
        for (const f of appliedErrors) if (f.typ && counts[f.typ] !== undefined) counts[f.typ]++;
        const total = appliedErrors.length;
        logger.info(
          `Lektorat gespeichert: «${row.page_name}» (user=${user_email || '-'}, book=${row.book_id || '-'}, chap=${row.chapter_id || '-'}, page=${row.page_id}, ${total} Korrekturen: R=${counts.rechtschreibung} G=${counts.grammatik} W=${counts.wiederholung} S=${counts.stil})`
        );
      }
    }

    res.json({ ok: true });
  });

  // Letzte 20 Läufe für eine Seite (Listenansicht – ohne grosse JSON-Felder).
  // JSON-Daten (errors_json/szenen_json/applied/selected) lädt das Frontend
  // lazy via /check/:id/details, sobald der User einen Eintrag öffnet. Spart
  // 20× JSON.parse pro Aufruf, auch wenn keiner expandiert wird.
  router.get('/page/:page_id', (req, res) => {
    const user_email = sessionEmail(req);
    const pageId = toIntId(req.params.page_id);
    if (!pageId) return res.status(400).json({ error_code: 'INVALID_ID' });
    const bookId = resolvePageBookId(pageId);
    if (!bookId) return res.status(404).json({ error_code: 'PAGE_NOT_FOUND' });
    if (!guardBook(req, res, bookId, 'viewer')) return;
    const rows = db.prepare(`
      SELECT pc.id, pc.page_id, p.page_name, pc.book_id, pc.chapter_id, pc.checked_at,
             pc.error_count, pc.stilanalyse, pc.fazit, pc.model, pc.saved, pc.saved_at
      FROM page_checks pc
      LEFT JOIN pages p ON p.page_id = pc.page_id
      WHERE pc.page_id = ? AND pc.user_email = ?
      ORDER BY pc.checked_at DESC LIMIT 20`).all(pageId, user_email);
    res.json(rows.map(r => ({ ...r, saved: !!r.saved })));
  });

  // JSON-Detail eines page_check (errors/szenen/applied/selected).
  // Wird vom Frontend bei Klick auf einen History-Eintrag nachgeladen.
  router.get('/check/:id/details', (req, res) => {
    const user_email = sessionEmail(req);
    const id = toIntId(req.params.id);
    if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
    const r = db.prepare(`
      SELECT book_id, errors_json, applied_errors_json, selected_errors_json, szenen_json
      FROM page_checks WHERE id = ? AND user_email = ?`).get(id, user_email);
    if (!r) return res.status(404).json({ error_code: 'NOT_FOUND' });
    if (r.book_id && !guardBook(req, res, r.book_id, 'viewer')) return;
    res.json({
      errors_json: JSON.parse(r.errors_json || '[]'),
      applied_errors_json: r.applied_errors_json ? JSON.parse(r.applied_errors_json) : null,
      selected_errors_json: r.selected_errors_json ? JSON.parse(r.selected_errors_json) : null,
      szenen_json: r.szenen_json ? JSON.parse(r.szenen_json) : null,
    });
  });

  // Lektorat-Prüfung löschen
  router.delete('/check/:id', (req, res) => {
    const user_email = sessionEmail(req);
    const id = toIntId(req.params.id);
    if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
    db.prepare('DELETE FROM page_checks WHERE id = ? AND user_email = ?')
      .run(id, user_email);
    res.json({ ok: true });
  });

  // Pro Seite: letzter Check-Zeitpunkt + Pending-Flag. Cross-User — alle Editoren
  // mit Buchzugriff sehen denselben Status, damit Co-Editoren wissen, was schon
  // geprüft ist. Findings/Reviews bleiben weiterhin user-spezifisch.
  // "Pending" = jüngster Check hat Fehler, wurde weder geöffnet noch übernommen.
  // Wenn Korrekturen aus einem Check übernommen wurden, zählt saved_at — sonst
  // würde das anschliessende BookStack-updated_at die Seite sofort wieder auf
  // "bearbeitet seit Lektorat" (warn) flippen.
  // `by` enthält die E-Mail des Editors, der den jüngsten Check gemacht hat
  // (oder null) — Frontend zeigt das als „geprüft von …" im Tooltip.
  router.get('/page-ages/:book_id', (req, res) => {
    const bookId = req.bookId;
    const rows = db.prepare(`
      WITH latest AS (
        SELECT page_id, checked_at, saved_at, error_count, user_email,
               ROW_NUMBER() OVER (PARTITION BY page_id ORDER BY checked_at DESC) AS rn
        FROM page_checks
        WHERE book_id = ?
      )
      SELECT page_id,
             CASE WHEN saved_at IS NOT NULL AND saved_at > checked_at THEN saved_at ELSE checked_at END AS at,
             CASE WHEN saved_at IS NULL AND error_count > 0 THEN 1 ELSE 0 END AS pending,
             user_email AS by_email
      FROM latest
      WHERE rn = 1
    `).all(bookId);
    const map = {};
    for (const r of rows) map[r.page_id] = { at: r.at, pending: !!r.pending, by: r.by_email || null };
    res.json(map);
  });

  // Lektorat-Abdeckung: wie viele Seiten eines Buchs wurden schon geprüft. Cross-User.
  router.get('/coverage/:book_id', (req, res) => {
    const bookId = req.bookId;
    const { total } = db.prepare('SELECT COUNT(*) as total FROM page_stats WHERE book_id = ?').get(bookId);
    const { checked } = db.prepare(
      'SELECT COUNT(DISTINCT page_id) as checked FROM page_checks WHERE book_id = ?'
    ).get(bookId);
    const pct = total > 0 ? Math.round((checked / total) * 100) : 0;
    res.json({ checked_pages: checked, total_pages: total, pct });
  });
}

module.exports = { register };
