'use strict';
// Konto-Selbstloeschung: DELETE /me/account (App-Store-Guideline 5.1.1(v)).
//
// Zwei Testgegenstaende:
//   1. Der Endpunkt-Vertrag, den der native macOS-Client auswertet — inklusive
//      der Frage, die nur hier pruefbar ist: funktioniert das mit einem
//      DEVICE-TOKEN (der Client hat keine Session) und ist derselbe Token
//      danach wirklich tot?
//   2. Die Vollstaendigkeit von USER_REF_PLAN gegen das echte Schema. Ohne
//      dieses Gate ist „die Inhalte sind weg" eine Behauptung, die mit der
//      naechsten Tabelle still verfaellt.
//
// Wie in tests/unit/admin-users-routes.test.js: Mini-Express, per http
// aufgerufen, kein Supertest. Der Auth-Guard wird mit derselben Funktion
// nachgebaut, die server.js benutzt (tryDeviceAuth) — sonst prueft der Test
// eine Auth, die es so nicht gibt.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const tmpDb = path.join(os.tmpdir(), `account-delete-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmpDb;
delete process.env.ADMIN_EMAIL;
delete process.env.DEMO_EMAIL;
delete process.env.DEMO_PASSWORD;

require('../../db/migrations');
const { db } = require('../../db/connection');
const appUsers = require('../../db/app-users');
const bookAccess = require('../../db/book-access');
const deviceTokens = require('../../db/device-tokens');
const contentStore = require('../../lib/content-store');
const { tryDeviceAuth } = require('../../lib/device-auth');
const { USER_REF_PLAN } = require('../../lib/account-delete');

const express = require('express');
const userSettingsRouter = require('../../routes/usersettings');

// Session-Attrappe + der echte Device-Token-Pfad. `session.destroy` gibt es in
// express-session; hier reicht ein Stub, den die Route aufrufen kann.
const app = express();
app.use((req, res, next) => {
  req.session = {
    destroy(cb) { delete this.user; cb && cb(); },
  };
  const deviceUser = tryDeviceAuth(req);
  if (deviceUser) { req.session.user = deviceUser; return next(); }
  const email = req.headers['x-test-user-email'];
  if (email) {
    req.session.user = { email, name: email, role: req.headers['x-test-user-role'] || 'user' };
    return next();
  }
  return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
});
app.use('/me', userSettingsRouter);

const server = app.listen(0);
const port = server.address().port;

test.after(() => {
  server.close();
  try { db.close(); } catch {}
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch {}
  }
});

function _request(method, urlPath, { user = null, bearer = null, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json' };
    if (user) headers['x-test-user-email'] = user;
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    const payload = body === null ? null : JSON.stringify(body);
    if (payload) headers['content-length'] = Buffer.byteLength(payload);
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch {}
        resolve({ status: res.statusCode, json, raw });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Buch mit einem Kapitel + einer Seite, Owner = email. */
async function seedBook(email, name) {
  const ctx = { session: { user: { email } } };
  const book = await contentStore.createBook({ name, owner_email: email }, ctx);
  bookAccess.grantAccess(book.id, email, 'owner', email);
  const chapter = await contentStore.createChapter({ book_id: book.id, name: 'Kapitel 1' }, ctx);
  await contentStore.createPage(
    { book_id: book.id, chapter_id: chapter.id, name: 'Seite 1', html: '<p>Text</p>' },
    ctx,
  );
  return book.id;
}

// ── Endpunkt-Vertrag ─────────────────────────────────────────────────────────

test('ohne confirm → 400 CONFIRM_REQUIRED, Konto bleibt', async () => {
  const email = 'noconfirm@x.test';
  appUsers.createUser({ email, displayName: 'NoConfirm' });

  const empty = await _request('DELETE', '/me/account', { user: email, body: {} });
  assert.equal(empty.status, 400);
  assert.equal(empty.json.error_code, 'CONFIRM_REQUIRED');

  const wrong = await _request('DELETE', '/me/account', { user: email, body: { confirm: 'loeschen' } });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.json.error_code, 'CONFIRM_REQUIRED');

  assert.ok(appUsers.getUser(email), 'Konto darf ohne Bestaetigung nicht angetastet werden');
});

test('Loeschung per Device-Token: 200, danach ist derselbe Token 401', async () => {
  const email = 'native@x.test';
  const other = 'fremd@x.test';
  appUsers.createUser({ email, displayName: 'Native Client' });
  appUsers.createUser({ email: other, displayName: 'Fremd' });

  const ownBook = await seedBook(email, 'Eigenes Buch');
  const foreignBook = await seedBook(other, 'Fremdes Buch');
  bookAccess.grantAccess(foreignBook, email, 'editor', other);

  // Inhalte, die an keiner FK-Kaskade auf app_users haengen und darum vom
  // Sweep leben: eine Quelle im persoenlichen Pool und ein Chat auf dem
  // FREMDEN Buch (das Buch bleibt stehen, der Chat darf nicht).
  db.prepare("INSERT INTO sources (owner_email, csl_type, title) VALUES (?, 'book', 'Testquelle')").run(email);
  db.prepare(`
    INSERT INTO chat_sessions (book_id, kind, page_id, user_email, created_at, last_message_at)
    VALUES (?, 'book', NULL, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `).run(foreignBook, email);

  const tok = deviceTokens.createDeviceToken({ userEmail: email, deviceName: 'MacBook', platform: 'macos' });

  // Vorher: der Token authentisiert.
  const before = await _request('GET', '/me/device-tokens', { bearer: tok.plain_token });
  assert.equal(before.status, 200);

  const res = await _request('DELETE', '/me/account', {
    bearer: tok.plain_token,
    body: { confirm: 'DELETE' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  // Keine Karenzfrist → das Feld darf nicht auftauchen (der Client zeigt sonst
  // ein Datum an, an dem nichts passiert).
  assert.equal(res.json.scheduled_purge_at, undefined);

  // Konto weg, Token weg, Bearer-Request 401.
  assert.equal(appUsers.getUser(email), null);
  assert.equal(deviceTokens.findActiveTokenByPlain(tok.plain_token), null);
  const after = await _request('GET', '/me/device-tokens', { bearer: tok.plain_token });
  assert.equal(after.status, 401);

  // Eigenes Buch samt Inhalt weg …
  assert.equal(db.prepare('SELECT COUNT(*) c FROM books WHERE book_id = ?').get(ownBook).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM pages WHERE book_id = ?').get(ownBook).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM chapters WHERE book_id = ?').get(ownBook).c, 0);
  // … fremdes Buch bleibt, nur die ACL-Zeile faellt.
  assert.equal(db.prepare('SELECT COUNT(*) c FROM books WHERE book_id = ?').get(foreignBook).c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM pages WHERE book_id = ?').get(foreignBook).c, 1);
  assert.equal(bookAccess.getBookRole(foreignBook, email), null);
  assert.equal(bookAccess.getBookRole(foreignBook, other), 'owner');

  // Sweep-Tabellen ohne FK: leer.
  assert.equal(db.prepare('SELECT COUNT(*) c FROM sources WHERE owner_email = ?').get(email).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM chat_sessions WHERE user_email = ?').get(email).c, 0);

  // Audit-Spur ueberlebt bewusst — sie ist der Nachweis der Loeschung.
  const audit = appUsers.listAuditForUser(email, 10);
  assert.ok(audit.some(a => a.event === 'self-deleted'), 'self-deleted-Event muss bleiben');
});

test('Session-Pfad loescht ebenso (Web-Oberflaeche)', async () => {
  const email = 'web@x.test';
  appUsers.createUser({ email, displayName: 'Web' });
  const bookId = await seedBook(email, 'Web-Buch');

  const res = await _request('DELETE', '/me/account', { user: email, body: { confirm: 'DELETE' } });
  assert.equal(res.status, 200);
  assert.equal(appUsers.getUser(email), null);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM books WHERE book_id = ?').get(bookId).c, 0);
});

test('ohne app_users-Row → 404 MIT error_code (nie ohne)', async () => {
  const res = await _request('DELETE', '/me/account', { user: 'ghost@x.test', body: { confirm: 'DELETE' } });
  assert.equal(res.status, 404);
  assert.equal(res.json.error_code, 'USER_NOT_FOUND');
});

test('letzter aktiver Admin → 403 ACCOUNT_DELETE_FORBIDDEN', async () => {
  const admin = 'solo-admin@x.test';
  appUsers.createUser({ email: admin, displayName: 'Solo', globalRole: 'admin' });
  assert.deepEqual(appUsers.getActiveAdminEmails(), [admin], 'Vorbedingung: genau ein Admin');

  const res = await _request('DELETE', '/me/account', { user: admin, body: { confirm: 'DELETE' } });
  assert.equal(res.status, 403);
  assert.equal(res.json.error_code, 'ACCOUNT_DELETE_FORBIDDEN');
  assert.ok(appUsers.getUser(admin));

  // Mit einem zweiten Admin greift die Sperre nicht mehr.
  appUsers.createUser({ email: 'admin2@x.test', displayName: 'Zwei', globalRole: 'admin' });
  const ok = await _request('DELETE', '/me/account', { user: admin, body: { confirm: 'DELETE' } });
  assert.equal(ok.status, 200);
  assert.equal(appUsers.getUser(admin), null);
});

test('Demo-Konto: Reset statt Loeschung — Konto und Token bleiben, Inhalte sind neu', async () => {
  const email = 'demo@x.test';
  appUsers.createUser({ email, displayName: 'Demo' });
  const oldBook = await seedBook(email, 'Alter Kram des vorigen Pruefers');
  const tok = deviceTokens.createDeviceToken({ userEmail: email, deviceName: 'Demo-Client' });

  process.env.DEMO_EMAIL = email;
  process.env.DEMO_PASSWORD = 'irrelevant-fuer-diesen-pfad';
  try {
    const res = await _request('DELETE', '/me/account', {
      bearer: tok.plain_token,
      body: { confirm: 'DELETE' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.demo_reset, true);

    // Konto + Token bleiben — sie sind die einzige Anmeldung der nativen Clients
    // und stehen in den Reviewer-Notes.
    assert.ok(appUsers.getUser(email), 'Demo-Konto darf nicht geloescht werden');
    assert.ok(deviceTokens.findActiveTokenByPlain(tok.plain_token), 'fixes Demo-Token muss weiter gelten');

    // Der alte Inhalt ist weg …
    assert.equal(db.prepare('SELECT COUNT(*) c FROM books WHERE book_id = ?').get(oldBook).c, 0);
    // … und der Pruefer landet nicht in einer leeren App: Beispielbuch neu gesaet.
    const own = bookAccess.listBookIdsForUser(email).filter(r => r.role === 'owner');
    assert.ok(own.length >= 1, 'Neu-Seed muss dem Demo-User wieder ein eigenes Buch geben');

    assert.ok(
      appUsers.listAuditForUser(email, 10).some(a => a.event === 'demo-reset'),
      'Reset muss als demo-reset protokolliert sein, nicht als Loeschung',
    );
  } finally {
    delete process.env.DEMO_EMAIL;
    delete process.env.DEMO_PASSWORD;
  }
});

// ── Vollstaendigkeit des Plans gegen das echte Schema ────────────────────────

// Spalten, die auf ein Konto zeigen. Bewusst eng und benannt: ein Muster wie
// /_by$/ wuerde `updated_by`-artige Felder mitnehmen, die keine Adresse halten.
const ACTOR_COL_RE = /(^|_)email$|^(invited_by|granted_by|added_by|created_by|updated_by|reviewed_by)$/;

test('USER_REF_PLAN deckt jede konto-bezogene Spalte des Schemas ab', () => {
  const planned = new Set(USER_REF_PLAN.map(e => `${e.table}.${e.column}`));
  const tables = db.prepare(`
    SELECT name FROM sqlite_master
     WHERE type = 'table'
       AND name NOT LIKE 'sqlite_%'
       AND name NOT IN ('schema_version')
  `).all().map(r => r.name);

  const missing = [];
  const found = new Set();
  for (const table of tables) {
    for (const col of db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all()) {
      if (!ACTOR_COL_RE.test(col.name)) continue;
      const key = `${table}.${col.name}`;
      found.add(key);
      if (!planned.has(key)) missing.push(key);
    }
  }

  assert.equal(missing.length, 0,
    'Nicht in USER_REF_PLAN (lib/account-delete.js) — es ist ungeklaert, was damit beim '
    + 'Loeschen eines Kontos passiert:\n  ' + missing.join('\n  '));

  // Gegenrichtung: kein Eintrag fuer eine Spalte, die es nicht mehr gibt —
  // sonst laeuft der Sweep in ein SQL-Error oder tut lautlos nichts.
  const stale = [...planned].filter(k => !found.has(k));
  assert.equal(stale.length, 0, 'USER_REF_PLAN nennt Spalten, die das Schema nicht hat:\n  ' + stale.join('\n  '));
});

test('USER_REF_PLAN: nur bekannte Modi, keep/sentinel/anonymize mit Begruendung', () => {
  const MODES = new Set(['fk', 'sweep', 'anonymize', 'sentinel', 'keep', 'books', 'store', 'account', 'tokens']);
  for (const e of USER_REF_PLAN) {
    assert.ok(MODES.has(e.mode), `${e.table}.${e.column}: unbekannter Modus "${e.mode}"`);
    // Eine Zeile, die den Personenbezug BEHAELT, braucht eine Begruendung —
    // das ist der Teil, den man einem Nutzer erklaeren muss.
    if (e.mode === 'keep' || e.mode === 'sentinel') {
      assert.ok(e.why && e.why.length > 10, `${e.table}.${e.column}: Modus "${e.mode}" ohne Begruendung`);
    }
  }
});
