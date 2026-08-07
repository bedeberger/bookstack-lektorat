const express = require('express');
const { db, upsertBookByName } = require('../db/schema');
const logger = require('../logger');
const { toIntId } = require('../lib/validate');
const contentStore = require('../lib/content-store');
const { setContext } = require('../lib/log-context');
const { aclParamGuard, requireBookAccess, sendACLError } = require('../lib/acl');
const { htmlToText } = require('./jobs/shared');

const router = express.Router();
router.param('book_id', aclParamGuard('viewer'));
const jsonBody = express.json();

// ── Hilfsfunktionen ──────────────────────────────────────────────────────────

/**
 * Normalisiert context_info aus der DB – ältere Einträge speicherten pages als
 * String-Array, neue als Objekt-Array { name, id, slug, book_slug }.
 */
function normalizeContextInfo(ci) {
  if (!ci || !Array.isArray(ci.pages)) return ci;
  ci.pages = ci.pages.map(p => (typeof p === 'string' ? { name: p } : p));
  return ci;
}

// ── Routen ───────────────────────────────────────────────────────────────────

/** Neue Chat-Session erstellen */
router.post('/session', jsonBody, async (req, res) => {
  const { book_name } = req.body;
  const book_id = toIntId(req.body?.book_id);
  const page_id = toIntId(req.body?.page_id);
  const userEmail = req.session?.user?.email || null;
  if (!book_id || !page_id || !userEmail) {
    return res.status(400).json({ error_code: 'BOOKID_PAGEID_LOGIN_REQ' });
  }
  setContext({ book: book_id });
  try { requireBookAccess(req, book_id, 'lektor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }

  // Snapshot: Seitentext beim Chat-Öffnen einmalig sichern. Ermöglicht später
  // im System-Prompt einen Vergleich „Stand beim Öffnen" vs. „aktueller Stand",
  // damit die KI Änderungen während laufendem Chat erkennt.
  let openingPageText = null;
  try {
    const pd = await contentStore.loadPage(page_id, req);
    openingPageText = htmlToText(pd.html || '');
  } catch (e) {
    const status = e?.status ? ` status=${e.status}` : '';
    logger.warn(`[chat/session] Snapshot-Load fehlgeschlagen page=${page_id}${status}: ${e.message}`);
  }

  // Orphan-Cleanup: vorher angelegte leere Sessions desselben Users für dieselbe
  // Seite löschen, bevor wir eine neue erstellen. So sammeln sich keine Karteileichen
  // an, wenn der User Chat-Karte mehrmals öffnet/schliesst, ohne zu schreiben.
  // Why: 60s-Schonfrist verhindert Race mit parallelem /jobs/chat-Send, der gerade
  // erst user_msg in eine 30s-junge Session geschrieben hat — Cleanup würde sonst
  // die Session mitsamt user_msg löschen und der laufende Chat-Job fällt auf
  // FK-Verletzung beim assistant-msg-INSERT.
  const cleanupRes = db.prepare(`
    DELETE FROM chat_sessions
    WHERE page_id = ? AND user_email = ? AND kind = 'page'
      AND created_at < datetime('now', '-60 seconds')
      AND NOT EXISTS (SELECT 1 FROM chat_messages WHERE session_id = chat_sessions.id)
  `).run(page_id, userEmail);
  if (cleanupRes.changes > 0) {
    logger.info(`[chat/session] Orphan-Cleanup: ${cleanupRes.changes} leere page-Session(s) für page=${page_id} entfernt.`);
  }

  upsertBookByName(book_id, book_name);
  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO chat_sessions (book_id, page_id, user_email, created_at, last_message_at, opening_page_text)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(book_id, page_id, userEmail, now, now, openingPageText);
  res.json({ id: result.lastInsertRowid });
});

// Buch-weite Chat-Session anlegen (Buch-Chat + Recherche-Chat). Beide
// unterscheiden sich nur in `kind` und der ACL-Mindestrolle; Orphan-Cleanup
// (leere, nie benutzte Sessions desselben kind älter als 60 s verwerfen) und
// Insert sind geteilt. `minRole(book_id)` löst die Rolle ggf. buch-abhängig auf.
function createBookScopedSession(req, res, { kind, minRole }) {
  const { book_name } = req.body;
  const book_id = toIntId(req.body?.book_id);
  const userEmail = req.session?.user?.email || null;
  if (!book_id || !userEmail) return res.status(400).json({ error_code: 'BOOKID_LOGIN_REQ' });
  setContext({ book: book_id });
  try { requireBookAccess(req, book_id, minRole(book_id)); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }

  const cleanup = db.prepare(`
    DELETE FROM chat_sessions
    WHERE book_id = ? AND kind = ? AND user_email = ?
      AND created_at < datetime('now', '-60 seconds')
      AND NOT EXISTS (SELECT 1 FROM chat_messages WHERE session_id = chat_sessions.id)
  `).run(book_id, kind, userEmail);
  if (cleanup.changes > 0) logger.info(`[chat/session/${kind}] Orphan-Cleanup: ${cleanup.changes} leere Session(s) für book=${book_id} entfernt.`);

  upsertBookByName(book_id, book_name);
  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO chat_sessions (book_id, kind, user_email, created_at, last_message_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(book_id, kind, userEmail, now, now);
  res.json({ id: result.lastInsertRowid });
}

// Buch-weite Chat-Sessions auflisten (neueste zuerst, max. 20). Leere Sessions
// (ohne Nachrichten) werden ausgefiltert — sie entstehen beim Öffnen der Karte
// (auto-`startNewSession`) und sollen erst auftauchen, wenn der User schreibt.
function listBookScopedSessions(req, res, { kind }) {
  const userEmail = req.session?.user?.email || null;
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  const rows = db.prepare(`
    SELECT cs.id, cs.book_id, b.name AS book_name, cs.title, cs.created_at, cs.last_message_at,
           (SELECT content FROM chat_messages WHERE session_id = cs.id ORDER BY created_at ASC LIMIT 1) AS preview
    FROM chat_sessions cs
    LEFT JOIN books b ON b.book_id = cs.book_id
    WHERE cs.book_id = ? AND cs.kind = ? AND cs.user_email = ?
      AND EXISTS (SELECT 1 FROM chat_messages WHERE session_id = cs.id)
    ORDER BY cs.last_message_at DESC
    LIMIT 20
  `).all(bookId, kind, userEmail);
  res.json(rows);
}

/** Neue Buch-Chat-Session erstellen (ohne Seiten-Bezug).
 *  Buch-Chat: editor+, ausser allow_lektor_book_chat=1 → lektor+. */
router.post('/session/book', jsonBody, (req, res) => createBookScopedSession(req, res, {
  kind: 'book',
  minRole: (book_id) => {
    const { getBookSettings } = require('../db/schema');
    return getBookSettings(book_id)?.allow_lektor_book_chat ? 'lektor' : 'editor';
  },
}));

router.get('/sessions/book/:book_id', (req, res) => listBookScopedSessions(req, res, { kind: 'book' }));

/** Neue Recherche-Chat-Session erstellen (kind='research', buchweit, editor+).
 *  Claude-only — das Frontend öffnet sie nur, wenn der Provider Claude ist. */
router.post('/session/research', jsonBody, (req, res) => createBookScopedSession(req, res, {
  kind: 'research',
  minRole: () => 'editor',
}));

router.get('/sessions/research/:book_id', (req, res) => listBookScopedSessions(req, res, { kind: 'research' }));

/** Alle Sessions einer Seite (neueste zuerst, max. 20).
 *  Siehe Kommentar oben — leere Sessions werden ausgefiltert. */
router.get('/sessions/:page_id', (req, res) => {
  const userEmail = req.session?.user?.email || null;
  const pageId = toIntId(req.params.page_id);
  if (!pageId) return res.status(400).json({ error_code: 'INVALID_ID' });
  const rows = db.prepare(`
    SELECT cs.id, cs.book_id, cs.page_id, p.page_name, cs.title, cs.created_at, cs.last_message_at,
           (SELECT content FROM chat_messages WHERE session_id = cs.id ORDER BY created_at ASC LIMIT 1) AS preview
    FROM chat_sessions cs
    LEFT JOIN pages p ON p.page_id = cs.page_id
    WHERE cs.page_id = ? AND cs.user_email = ?
      AND EXISTS (SELECT 1 FROM chat_messages WHERE session_id = cs.id)
    ORDER BY cs.last_message_at DESC
    LIMIT 20
  `).all(pageId, userEmail);
  res.json(rows);
});

/** Session mit allen Nachrichten laden */
router.get('/session/:id', (req, res) => {
  const userEmail = req.session?.user?.email || null;
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const session = db.prepare(`
    SELECT cs.*, p.page_name FROM chat_sessions cs
    LEFT JOIN pages p ON p.page_id = cs.page_id
    WHERE cs.id = ? AND cs.user_email = ?
  `).get(id, userEmail);
  if (!session) return res.status(404).json({ error_code: 'SESSION_NOT_FOUND' });

  const messages = db.prepare(`
    SELECT id, role, content, vorschlaege, tokens_in, tokens_out,
           cache_read_in, cache_creation_in, tps, context_info, created_at
    FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC
  `).all(session.id);

  res.json({
    ...session,
    messages: messages.map(m => ({
      ...m,
      vorschlaege:  m.vorschlaege  ? JSON.parse(m.vorschlaege)  : [],
      context_info: m.context_info ? normalizeContextInfo(JSON.parse(m.context_info)) : null,
    })),
  });
});

/** Im Buch-Chat generiertes Bild streamen (Owner-Scope via Session-Join).
 *  ?download=1 erzwingt den Attachment-Disposition (Speichern-Dialog). */
router.get('/image/:id', (req, res) => {
  const userEmail = req.session?.user?.email || null;
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const { getChatImage } = require('../db/chat-images');
  const row = getChatImage(id);
  if (!row) return res.status(404).json({ error_code: 'IMAGE_NOT_FOUND' });
  if (row.user_email !== userEmail) return res.status(403).json({ error_code: 'FORBIDDEN' });

  // Defense-in-depth gegen Stored XSS: row.mime stammt letztlich aus dem
  // (untrusted) Upstream-Image-Endpunkt. Nur Raster-MIMEs inline ausliefern;
  // alles andere als Download mit neutralem Typ. nosniff + restriktive CSP
  // verhindern, dass der Browser den Body als HTML/Script interpretiert.
  const SAFE_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  const safe = SAFE_IMAGE_MIME.has(row.mime);
  const ext = (safe && row.mime.split('/')[1]) || 'png';
  res.setHeader('Content-Type', safe ? row.mime : 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cache-Control', 'private, max-age=3600');
  if (req.query.download || !safe) {
    res.setHeader('Content-Disposition', `attachment; filename="bild-${id}.${ext}"`);
  }
  res.setHeader('Content-Length', row.image.length);
  res.end(row.image);
});

/** Session löschen */
router.delete('/session/:id', (req, res) => {
  const userEmail = req.session?.user?.email || null;
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  db.prepare('DELETE FROM chat_sessions WHERE id = ? AND user_email = ?')
    .run(id, userEmail);
  res.json({ ok: true });
});

/** Einzelnen Vorschlag einer Assistant-Nachricht als übernommen markieren (oder zurücksetzen) */
router.patch('/message/:id/vorschlag/:idx/applied', jsonBody, (req, res) => {
  const userEmail = req.session?.user?.email || null;
  const msgId = toIntId(req.params.id);
  // idx kann 0 sein → toIntId reicht nicht (lehnt 0 ab). Eigene Prüfung auf nicht-negativen Integer.
  const idx = /^(0|[1-9][0-9]*)$/.test(String(req.params.idx ?? '')) ? Number(req.params.idx) : null;
  if (!msgId || idx == null) return res.status(400).json({ error_code: 'INVALID_ID' });
  const applied = req.body?.applied !== false;

  const row = db.prepare(`
    SELECT cm.vorschlaege FROM chat_messages cm
    JOIN chat_sessions cs ON cs.id = cm.session_id
    WHERE cm.id = ? AND cs.user_email = ?
  `).get(msgId, userEmail);
  if (!row) return res.status(404).json({ error_code: 'MESSAGE_NOT_FOUND' });

  const vorschlaege = row.vorschlaege ? JSON.parse(row.vorschlaege) : [];
  if (!vorschlaege[idx]) return res.status(400).json({ error_code: 'VORSCHLAG_INDEX_INVALID' });

  if (applied) {
    vorschlaege[idx].applied = true;
    vorschlaege[idx].applied_at = new Date().toISOString();
  } else {
    delete vorschlaege[idx].applied;
    delete vorschlaege[idx].applied_at;
  }

  db.prepare('UPDATE chat_messages SET vorschlaege = ? WHERE id = ?')
    .run(JSON.stringify(vorschlaege), msgId);
  res.json({ ok: true });
});

module.exports = router;
