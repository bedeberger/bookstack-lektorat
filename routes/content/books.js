'use strict';
// Content-Routes: Buch-Ebene (Liste/Detail/Tree/Changes/Sync/Order/CRUD),
// Buch-weite Geräte-Präsenz (device-ping/presence) + Volltextsuche.

const contentStore = require('../../lib/content-store');
const bookOrder = require('../../db/book-order');
const bookPresence = require('../../db/book-presence');
const pagePresence = require('../../db/page-presence');
const appUsersDevices = require('../../db/app-users-devices');
const bookAccess = require('../../db/book-access');
const { db } = require('../../db/connection');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');
const { resolvePageBookId } = require('../../lib/content-ownership');
const { aclParamGuard, requireBookAccess, sendACLError, sessionEmail } = require('../../lib/acl');
const { localIsoDaysAgo } = require('../../lib/local-date');
const logger = require('../../logger');
const { jsonBody, NAME_MAX, _validDeviceId, _fail } = require('./shared');

const SYNC_PAGE_LIMIT = 200;

function register(router) {
  // GET /content/books — Liste der fuer den User per book_access sichtbaren
  // Buecher. Strikt gefiltert: Admin ohne Share-Row sieht leeres Array.
  // Jedes Buch traegt `role` (eigene Buch-Rolle) und `owner_email` als Hint.
  router.get('/books', async (req, res) => {
    const email = sessionEmail(req);
    if (!email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
    const accessRows = bookAccess.listBookIdsForUser(email);
    if (accessRows.length === 0) return res.json([]);
    const allowedIds = new Set(accessRows.map(r => r.book_id));
    const roleByBook = new Map(accessRows.map(r => [r.book_id, r.role]));
    try {
      const all = await contentStore.listBooks(req);
      const meta = new Map(
        db.prepare(`
          SELECT b.book_id, b.owner_email, b.category_id, s.buchtyp
          FROM books b
          LEFT JOIN book_settings s ON s.book_id = b.book_id
        `).all().map(r => [r.book_id, {
          owner_email: r.owner_email,
          category_id: r.category_id,
          buchtyp: r.buchtyp,
        }])
      );
      const visible = all
        .filter(b => allowedIds.has(b.id))
        .map(b => ({
          ...b,
          role: roleByBook.get(b.id) || null,
          owner_email: meta.get(b.id)?.owner_email || null,
          category_id: meta.get(b.id)?.category_id ?? null,
          buchtyp: meta.get(b.id)?.buchtyp ?? null,
        }));
      res.json(visible);
    } catch (e) { _fail(res, e, 'GET /content/books'); }
  });

  // GET /content/books/:book_id — Buch-Detail.
  router.get('/books/:book_id', aclParamGuard('viewer'), async (req, res) => {
    try {
      const book = await contentStore.loadBook(req.bookId, req);
      res.json({ ...book, role: req.bookRole });
    } catch (e) { _fail(res, e, 'GET /content/books/:id'); }
  });

  // GET /content/books/:book_id/tree — Hierarchie als `{ chapters, topPages }`.
  router.get('/books/:book_id/tree', aclParamGuard('viewer'), async (req, res) => {
    try { res.json(await contentStore.bookTree(req.bookId, req)); }
    catch (e) { _fail(res, e, 'GET /content/books/:id/tree'); }
  });

  // GET /content/books/:book_id/changes?since=<iso>&device_id=<uuid> — Seiten, die
  // seit `since` von einer ANDEREN Partei editiert wurden. „Andere Partei" =
  // anderer User ODER ein anderes EIGENES Geraet (z.B. nativer Mac-Focus-Client).
  // Nur der Echo des ANFRAGENDEN Geraets (gleiche device_id) wird ausgefiltert.
  // Ohne `device_id` (Legacy-Client) faellt der Filter auf reine E-Mail-Exklusion
  // zurueck. Polling-Endpoint fuer das Collab-Toast-Signal. Ohne `since` liefert er
  // den Server-„jetzt"-Stempel + leeres Array (Baseline-Sync). Cap 200 Rows.
  // Jede Change-Row traegt `is_self` (gleicher User, anderes Geraet) + das
  // `device_label` des schreibenden Geraets, damit der Client Multi-Device-Edits
  // nicht als Fremd-Edits formuliert.
  router.get('/books/:book_id/changes', aclParamGuard('viewer'), (req, res) => {
    const email = sessionEmail(req);
    const sinceRaw = (req.query?.since || '').toString().trim();
    const nowIso = new Date().toISOString();
    if (!sinceRaw) return res.json({ now: nowIso, changes: [] });
    const since = !Number.isNaN(Date.parse(sinceRaw)) ? sinceRaw : nowIso;
    const reqDeviceId = (req.query?.device_id || '').toString();
    const hasDevice = _validDeviceId(reqDeviceId);
    let rows = [];
    try {
      // Mit device_id: nur ausfiltern, wenn der Edit von DIESEM Geraet stammt —
      // also gleiche E-Mail UND (device == mein Geraet ODER device unbekannt/NULL,
      // z.B. Server-/Job-Write, der weiter wie eigener Edit gilt). Fremde User und
      // eigene Edits von anderen Geraeten (non-NULL, abweichende device_id) bleiben.
      const selfFilter = hasDevice
        ? `AND NOT (p.last_editor_email = ?
                    AND (p.last_editor_device_id IS NULL OR p.last_editor_device_id = ?))`
        : `AND (? IS NULL OR p.last_editor_email <> ?)`;
      const selfArgs = hasDevice ? [email, reqDeviceId] : [email, email];
      rows = db.prepare(`
        SELECT p.page_id, p.page_name, p.chapter_id,
               p.updated_at, p.last_editor_email,
               u.display_name AS last_editor_name,
               d.label        AS last_editor_device_label
          FROM pages p
          LEFT JOIN app_users         u ON u.email = p.last_editor_email
          -- Geraete-Label nur fuer die EIGENEN Geraete des Anfragers (gleicher
          -- Join-Scope wie loadPage) — fremde Geraetenamen leaken nicht.
          LEFT JOIN app_users_devices d ON d.device_id = p.last_editor_device_id
                                       AND d.user_email = ?
         WHERE p.book_id = ?
           AND p.updated_at > ?
           AND p.last_editor_email IS NOT NULL
           ${selfFilter}
         ORDER BY p.updated_at ASC
         LIMIT 200
      `).all(email, req.bookId, since, ...selfArgs);
    } catch (e) {
      return _fail(res, e, 'GET /content/books/:id/changes');
    }
    res.json({
      now: nowIso,
      changes: rows.map(r => ({
        page_id: r.page_id,
        page_name: r.page_name || '',
        chapter_id: r.chapter_id || null,
        updated_at: r.updated_at,
        last_editor_email: r.last_editor_email,
        last_editor_name: r.last_editor_name || r.last_editor_email,
        // Eigenes Zweit-Geraet vs. fremder ACL-User: der Client formuliert die
        // Meldung danach („auf Mac-Client geaendert" statt „anderer User").
        is_self: !!email && r.last_editor_email === email,
        device_label: r.last_editor_device_label || null,
      })),
    });
  });

  // GET /content/books/:book_id/sync?since=<iso>&since_id=<n>&limit=<n> —
  // Inkrementeller Delta-Pull fuer native Offline-Clients (Mac-Focus-Writer).
  // Liefert ALLE seit dem Cursor geaenderten/neuen Seiten des Buchs INKLUSIVE
  // eigener Edits, mit vollem HTML, damit der Client seinen lokalen Spiegel
  // aktualisieren kann. (Unterschied zu /changes: das ist self-exkludierend +
  // ohne HTML, fuer Collab-Toasts.) Ohne `since` = Voll-Pull (Baseline).
  //
  // Keyset-Cursor (updated_at, page_id): die Antwort traegt `cursor` (Position
  // NACH der letzten gelieferten Seite) + `has_more`. Der Client paged mit diesem
  // Cursor weiter, bis has_more=false. Push laeuft ueber den bestehenden
  // PUT /content/pages/:id (409 PAGE_CONFLICT → Block-Merge clientseitig).
  // Geloeschte Seiten: Client reconciled ueber GET /content/books/:id/tree.
  router.get('/books/:book_id/sync', aclParamGuard('viewer'), async (req, res) => {
    const sinceRaw = (req.query?.since || '').toString().trim();
    const since = sinceRaw && !Number.isNaN(Date.parse(sinceRaw)) ? sinceRaw : null;
    const sinceId = parseInt(req.query?.since_id, 10) || 0;
    const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || SYNC_PAGE_LIMIT, 1), SYNC_PAGE_LIMIT);
    const nowIso = new Date().toISOString();
    try {
      // limit+1 ziehen, um has_more ohne zweite Query zu erkennen.
      const metas = contentStore.pagesChangedSince(req.bookId, { since, sinceId }, limit + 1);
      const hasMore = metas.length > limit;
      const wanted = metas.slice(0, limit);
      const loaded = (await contentStore.loadPagesBatch(
        wanted.map(m => ({ id: m.id })), req, { onError: () => null }
      )).filter(Boolean);
      const pages = loaded.map(p => ({
        page_id: p.id,
        page_name: p.name,
        chapter_id: p.chapter_id,
        updated_at: p.updated_at,
        html: p.html,
      }));
      const last = wanted.length ? wanted[wanted.length - 1] : null;
      const cursor = last
        ? { since: last.updated_at, since_id: last.id }
        : { since: sinceRaw || null, since_id: sinceId };
      res.json({ now: nowIso, pages, has_more: hasMore, cursor });
    } catch (e) { _fail(res, e, 'GET /content/books/:id/sync'); }
  });

  // Eigene Sortierung.
  //
  // GET /content/books/:book_id/order — Tree-Snapshot + Audit-Meta. Auto-init:
  // keine Row -> aus aktuellen pages.position/chapters.position bauen; vorhandene
  // Row gegen DB-Stand reconcilen (neue/geloeschte Items).
  router.get('/books/:book_id/order', aclParamGuard('viewer'), (req, res) => {
    try {
      const data = bookOrder.ensureTree(req.bookId, sessionEmail(req));
      res.json(data);
    } catch (e) { _fail(res, e, 'GET /content/books/:id/order'); }
  });

  // PUT /content/books/:book_id/order — Vollstaendigen Tree speichern. Body:
  // `{ order_json: [...] }`. Server validiert (Schema + Vollstaendigkeit +
  // Doppel-IDs) und materialisiert chapters.position/pages.position/
  // pages.chapter_id in einer Transaction.
  router.put('/books/:book_id/order', aclParamGuard('editor'), jsonBody, (req, res) => {
    const tree = req.body?.order_json;
    if (!Array.isArray(tree)) {
      return res.status(400).json({ error_code: 'INVALID_BODY', detail: 'order_json must be array' });
    }
    try {
      const saved = bookOrder.putOrder(req.bookId, tree, sessionEmail(req));
      res.json(saved);
    } catch (e) {
      if (e instanceof bookOrder.TreeValidationError) {
        return res.status(400).json({ error_code: 'INVALID_TREE', reason: e.code, detail: e.detail });
      }
      _fail(res, e, 'PUT /content/books/:id/order');
    }
  });

  // POST /content/books/:book_id/device-ping — leichter Geraete-Heartbeat (Buch
  // offen, nicht zwingend Edit-Mode). Bootstrap fuer page-scoped
  // Multi-Device-Erkennung: Body traegt die aktuell offene `page_id` (optional),
  // Antwort enthaelt `self_page_device_count` (aktive eigene Geraete auf DERSELBEN
  // Seite inkl. diesem) UND `self_book_device_count` (eigene Geraete im GANZEN Buch,
  // seitenuebergreifend). Der Client startet den vollen Collab-Poll, sobald eine der
  // beiden >1 ist — so wird ein eigenes Zweit-Geraet (z.B. nativer Mac-Client) auch
  // bei Einzel-Owner-Buechern sichtbar, selbst wenn es eine ANDERE Seite editiert.
  // Min-Role viewer.
  router.post('/books/:book_id/device-ping', aclParamGuard('viewer'), jsonBody, (req, res) => {
    const email = sessionEmail(req);
    if (!email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
    const deviceId = req.body?.device_id;
    if (!_validDeviceId(deviceId)) return res.status(400).json({ error_code: 'INVALID_DEVICE_ID' });
    // page_id optional. Nur akzeptieren, wenn die Seite zu DIESEM Buch gehoert —
    // sonst null (verhindert fremde page_id im eigenen Praesenz-Zaehler).
    let pageId = toIntId(req.body?.page_id);
    if (pageId && resolvePageBookId(pageId) !== req.bookId) pageId = null;
    try {
      appUsersDevices.upsertDevice(deviceId, email, req.get('user-agent') || '');
      bookPresence.ping(req.bookId, email, deviceId, pageId);
      const selfPageDeviceCount = pageId ? bookPresence.countSelfDevicesOnPage(pageId, email) : 0;
      const selfBookDeviceCount = bookPresence.countSelfDevicesInBook(req.bookId, email);
      res.json({
        ok: true,
        self_page_device_count: selfPageDeviceCount,
        self_book_device_count: selfBookDeviceCount,
      });
    } catch (e) { return _fail(res, e, 'POST /content/books/:id/device-ping'); }
  });

  // DELETE /content/books/:book_id/device-ping — Buch geschlossen/gewechselt.
  // Optional (Stale-Filter raeumt eh nach 90s), aber gibt der Erkennung sofortige
  // Korrektheit. device_id auch als Query — keepalive/sendBeacon verschluckt Body.
  router.delete('/books/:book_id/device-ping', aclParamGuard('viewer'), jsonBody, (req, res) => {
    const email = sessionEmail(req);
    if (!email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
    const deviceId = req.body?.device_id || req.query?.device_id;
    if (!_validDeviceId(deviceId)) return res.status(400).json({ error_code: 'INVALID_DEVICE_ID' });
    try { bookPresence.leave(req.bookId, email, deviceId); }
    catch (e) { return _fail(res, e, 'DELETE /content/books/:id/device-ping'); }
    res.json({ ok: true });
  });

  // GET /content/books/:book_id/presence?device_id=… — Liste aktiver Sessions am Buch.
  // Filtert die anrufende Session (gleicher User + gleiche device_id) raus. Sessions
  // desselben Users auf anderen Geraeten bleiben sichtbar (`is_self: true`), damit
  // der User sein eigenes Multi-Device sehen kann.
  router.get('/books/:book_id/presence', aclParamGuard('viewer'), (req, res) => {
    const email = sessionEmail(req);
    const selfDevice = (req.query?.device_id || '').toString();
    let rows;
    try { rows = pagePresence.listForBook(req.bookId); }
    catch (e) { return _fail(res, e, 'GET /content/books/:id/presence'); }
    const selfEmailLc = email ? String(email).toLowerCase() : null;
    const filtered = rows
      .filter(r => {
        if (!selfEmailLc) return true;
        const sameUser = String(r.user_email).toLowerCase() === selfEmailLc;
        const sameDevice = selfDevice && r.device_id === selfDevice;
        // eigene aktuelle Session droppen; eigene andere Geraete behalten.
        return !(sameUser && sameDevice);
      })
      .map(r => ({
        page_id: r.page_id,
        user_email: r.user_email,
        user_display_name: r.user_display_name || r.user_email,
        device_id: r.device_id,
        device_label: r.device_label || null,
        is_self: selfEmailLc ? String(r.user_email).toLowerCase() === selfEmailLc : false,
        last_ping_at: r.last_ping_at,
      }));
    res.json({ presence: filtered });
  });

  // PUT /content/books/:book_id — Buch-Update (rename / description). minRole editor.
  router.put('/books/:book_id', aclParamGuard('editor'), jsonBody, async (req, res) => {
    const hasName = typeof req.body?.name === 'string';
    const hasDesc = typeof req.body?.description === 'string';
    if (!hasName && !hasDesc) return res.status(400).json({ error_code: 'EMPTY_BODY' });
    const body = { ...req.body };
    if (hasName) {
      const trimmed = body.name.trim();
      if (!trimmed) return res.status(400).json({ error_code: 'NAME_REQUIRED' });
      if (trimmed.length > NAME_MAX) return res.status(400).json({ error_code: 'NAME_TOO_LONG', params: { max: NAME_MAX } });
      body.name = trimmed;
    }
    try { res.json(await contentStore.updateBook(req.bookId, body, req)); }
    catch (e) { _fail(res, e, 'PUT /content/books/:id'); }
  });

  // DELETE /content/books/:book_id — Buch loeschen. minRole owner.
  router.delete('/books/:book_id', aclParamGuard('owner'), async (req, res) => {
    try {
      await contentStore.deleteBook(req.bookId, req);
      res.json({ ok: true });
    } catch (e) { _fail(res, e, 'DELETE /content/books/:id'); }
  });

  // GET /content/search?query=…&book_id=… — Volltextsuche, nur Page-Hits.
  // Mit book_id: viewer-Guard auf Buch. Ohne book_id: filtert auf
  // book_access-Buecher des Users (Cross-Book-Suche).
  router.get('/search', async (req, res) => {
    const query = (req.query?.query || '').toString().trim();
    const bookId = req.query?.book_id ? toIntId(req.query.book_id) : null;
    const count = req.query?.count;
    if (query.length < 2) return res.json({ hits: [] });
    if (bookId) {
      setContext({ book: bookId });
      try { requireBookAccess(req, bookId, 'viewer'); }
      catch (e) { if (sendACLError(res, e)) return; throw e; }
    }
    const email = sessionEmail(req);
    const allowedIds = new Set(bookAccess.listBookIdsForUser(email).map(r => r.book_id));
    try {
      const hits = await contentStore.searchPages(query, { bookId, count }, req);
      const filtered = bookId ? hits : hits.filter(h => !h.book_id || allowedIds.has(h.book_id));
      res.json({ hits: filtered });
    } catch (e) { _fail(res, e, 'GET /content/search'); }
  });

  // POST /content/books — Neues Buch anlegen. Anleger wird automatisch Owner
  // via book_access-Row.
  router.post('/books', jsonBody, async (req, res) => {
    const email = sessionEmail(req);
    if (!email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
    const name = (req.body?.name || '').toString().trim();
    const description = (req.body?.description || '').toString().trim();
    if (!name) return res.status(400).json({ error_code: 'NAME_REQUIRED' });
    if (name.length > NAME_MAX) return res.status(400).json({ error_code: 'NAME_TOO_LONG', params: { max: NAME_MAX } });
    try {
      const created = await contentStore.createBook({ name, description }, req);
      setContext({ book: created.id });
      // Owner-Grant + books.owner_email setzen (idempotent).
      try {
        db.prepare(`UPDATE books SET owner_email = COALESCE(owner_email, ?) WHERE book_id = ?`)
          .run(email, created.id);
        bookAccess.grantAccess(created.id, email, 'owner', email);
      } catch (gErr) {
        logger.warn(`Auto-Owner-Grant fuer book=${created.id} fehlgeschlagen: ${gErr.message}`);
      }
      // Baseline-Snapshot Vortag: gibt dem Tages-Donut einen prevChars-Wert,
      // damit erstes Schreiben am Anlege-Tag bereits korrekt als Delta zaehlt.
      try {
        db.prepare(`
          INSERT OR IGNORE INTO book_stats_history (book_id, recorded_at, page_count, words, chars, tok, unique_words, chapter_count)
          VALUES (?, ?, 0, 0, 0, 0, 0, 0)
        `).run(created.id, localIsoDaysAgo(1));
      } catch (sErr) {
        logger.warn(`Baseline-Snapshot fuer book=${created.id} fehlgeschlagen: ${sErr.message}`);
      }
      logger.info(`Buch erstellt id=${created.id} name="${created.name}" owner=${email}`);
      res.json({ ...created, role: 'owner' });
    } catch (e) {
      const status = e?.status || 500;
      let detail = '';
      try {
        const parsed = JSON.parse(e?.bodyText || '{}');
        const validation = parsed?.error?.validation;
        detail = validation && typeof validation === 'object'
          ? Object.values(validation).flat().filter(Boolean).join('; ')
          : (parsed?.error?.message || parsed?.message || '');
      } catch { /* bodyText kein JSON */ }
      logger.warn(`Buch erstellen fehlgeschlagen: ${status} ${detail || e.message}`);
      res.status(status === 401 ? 502 : status).json({
        error_code: 'CREATE_FAILED',
        status,
        detail: detail || e.message,
      });
    }
  });
}

module.exports = { register };
