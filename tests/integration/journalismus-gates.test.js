'use strict';
// Integration test: die Buchtyp-Gates des redaktionellen Apparats an der
// HTTP-Schicht.
//
// Der Unit-Test (tests/unit/page-guard.test.mjs) prueft den Guard mit Stubs —
// hier faehrt er unter Express mit echter DB, damit auch die ANDERE Haelfte
// geprueft ist: dass jede der drei Routen den Guard ueberhaupt ruft, und mit
// welchen Argumenten.
//
// Zwei Antwortformen, und die Unterscheidung ist Absicht:
//   LESEND auf Buch-Ebene → 200 mit `enabled: false` und leerer Nutzlast. Die
//     Karten fragen unabhaengig vom Buchtyp und sollen nicht in einen
//     Fehlerpfad laufen, nur weil gerade ein Roman offen ist.
//   SCHREIBEND auf Seiten-Ebene → 400 NOT_JOURNALISTIC_BOOK. Ein Titel oder ein
//     Redaktions-Status an einem Roman ist keine leere Antwort wert, sondern
//     ein Fehler.
//
// `blog` muss ueberall durchkommen: der Apparat gilt fuer beide publizistischen
// Typen (lib/buchtyp.js#JOURNALISTIC), nur der Blog-SYNC haengt allein an `blog`.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');

let ctx;
let db;
let server;
let baseUrl;
let sessionUser = 'autor@test.dev';

const NOW = '2026-01-01T00:00:00.000Z';

function startServer() {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use((req, _res, next) => { req.session = { user: { email: sessionUser } }; next(); });
    app.use('/headline', require('../../routes/headline'));
    app.use('/redaktion', require('../../routes/redaktion'));
    app.use('/textsorte', require('../../routes/textsorte'));
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
    server.on('error', reject);
  });
}

async function api(method, urlPath, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${urlPath}`, opts);
  let json = null;
  try { json = await res.json(); } catch (_) { /* leerer Body ist erlaubt */ }
  return { status: res.status, json };
}

test.before(async () => {
  ctx = bootstrap();
  db = require('../../db/schema').db;
  await startServer();
});
test.after(() => {
  if (server) server.close();
  ctx.cleanup();
});

test.beforeEach(() => {
  sessionUser = 'autor@test.dev';
  for (const t of ['page_headline_variants', 'page_headline', 'page_editorial_status',
    'page_structure_checks', 'page_textsorte', 'pages', 'chapters',
    'book_settings', 'book_access', 'books']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
});

/** Konto anlegen, falls es noch keins gibt — `book_access.user_email` ist ein FK
 *  auf `app_users`. */
function ensureUser(email) {
  db.prepare(`INSERT INTO app_users (email, global_role, created_at)
              VALUES (?, 'user', ?) ON CONFLICT(email) DO NOTHING`)
    .run(email, NOW);
}

/** Buch + eine Seite + Buchtyp. Liefert `{ bookId, pageId }`. */
function seed(bookId, buchtyp, user = 'autor@test.dev') {
  const { grantAccess } = require('../../db/book-access');
  ensureUser(user);
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(bookId, `Buch ${bookId}`, NOW, NOW);
  grantAccess(bookId, user, 'editor', user);
  const pageId = bookId * 10 + 1;
  db.prepare(`INSERT INTO pages (page_id, book_id, page_name, body_html, position, updated_at)
              VALUES (?, ?, ?, ?, 1, ?)`)
    .run(pageId, bookId, 'Beitrag 1', '<p>Text</p>', NOW);
  if (buchtyp) {
    db.prepare(`INSERT INTO book_settings (book_id, language, region, updated_at, buchtyp)
                VALUES (?, 'de', 'CH', ?, ?)
                ON CONFLICT(book_id) DO UPDATE SET buchtyp = excluded.buchtyp`)
      .run(bookId, NOW, buchtyp);
  }
  return { bookId, pageId };
}

// ── Lesend auf Buch-Ebene: enabled-Flag statt Fehler ─────────────────────────

test('Roman: die drei Lese-Routen antworten 200 mit enabled:false', async () => {
  const { bookId } = seed(8801, 'roman');
  for (const pfad of ['/headline', '/redaktion', '/textsorte']) {
    const r = await api('GET', `${pfad}/${bookId}`);
    assert.equal(r.status, 200, `${pfad}: kein Fehlerpfad fuer die Karte`);
    assert.equal(r.json.enabled, false, `${pfad}: enabled muss false sein`);
  }
});

test('Roman: die Lese-Routen liefern keine Nutzlast', async () => {
  const { bookId, pageId } = seed(8802, 'roman');
  // Daten liegen da (aus einer frueheren Buchtyp-Phase) — sie duerfen trotzdem
  // nicht herausfallen, sonst zeigte die Karte Inhalt, den es fuer diesen
  // Buchtyp nicht geben soll.
  require('../../db/headline').setHeadline(pageId, bookId, { titel: 'Alte Schlagzeile' });
  const r = await api('GET', `/headline/${bookId}`);
  assert.deepEqual(r.json.pages, {});

  const t = await api('GET', `/textsorte/${bookId}`);
  assert.equal(t.json.book_textsorte, null);
  assert.deepEqual(t.json.checks, []);
});

test('journalismus und blog: enabled:true, Nutzlast kommt', async () => {
  for (const [id, typ] of [[8803, 'journalismus'], [8804, 'blog']]) {
    const { bookId, pageId } = seed(id, typ);
    require('../../db/headline').setHeadline(pageId, bookId, { titel: 'Schlagzeile' });
    const r = await api('GET', `/headline/${bookId}`);
    assert.equal(r.json.enabled, true, `${typ}: enabled`);
    assert.equal(r.json.pages[String(pageId)]?.titel, 'Schlagzeile', `${typ}: Nutzlast`);

    for (const pfad of ['/redaktion', '/textsorte']) {
      const x = await api('GET', `${pfad}/${bookId}`);
      assert.equal(x.json.enabled, true, `${typ} ${pfad}: enabled`);
    }
  }
});

// ── Schreibend auf Seiten-Ebene: Fehler statt stiller No-Op ──────────────────

const schreibwege = (pageId) => [
  ['PUT', `/headline/page/${pageId}`, { titel: 'X' }],
  ['POST', `/headline/page/${pageId}/variants`, { feld: 'titel', text: 'X' }],
  ['PUT', `/redaktion/page/${pageId}`, { status: 'roh' }],
  ['PUT', `/textsorte/page/${pageId}`, { textsorte: 'bericht' }],
];

test('Roman: jeder Schreibweg antwortet 400 NOT_JOURNALISTIC_BOOK', async () => {
  const { pageId } = seed(8805, 'roman');
  for (const [m, pfad, body] of schreibwege(pageId)) {
    const r = await api(m, pfad, body);
    assert.equal(r.status, 400, `${m} ${pfad}`);
    assert.equal(r.json.error_code, 'NOT_JOURNALISTIC_BOOK', `${m} ${pfad}`);
  }
});

test('Buch ohne Buchtyp zaehlt nicht als publizistisch', async () => {
  const { pageId } = seed(8806, null);
  const r = await api('PUT', `/textsorte/page/${pageId}`, { textsorte: 'bericht' });
  assert.equal(r.json.error_code, 'NOT_JOURNALISTIC_BOOK');
});

test('journalismus und blog: die Schreibwege gehen durch', async () => {
  for (const [id, typ] of [[8807, 'journalismus'], [8808, 'blog']]) {
    const { pageId } = seed(id, typ);
    for (const [m, pfad, body] of schreibwege(pageId)) {
      const r = await api(m, pfad, body);
      assert.equal(r.status, 200, `${typ} ${m} ${pfad} → ${JSON.stringify(r.json)}`);
    }
  }
});

// ── Die Invarianten, die beim Kopieren des Guards verloren gehen ─────────────

test('unbekannte Seite → 404 PAGE_NOT_FOUND, nicht 400', async () => {
  seed(8809, 'journalismus');
  for (const [m, pfad, body] of schreibwege(999999)) {
    const r = await api(m, pfad, body);
    assert.equal(r.status, 404, `${m} ${pfad}`);
    assert.equal(r.json.error_code, 'PAGE_NOT_FOUND', `${m} ${pfad}`);
  }
});

test('ohne Buchrecht: 403, und der Buchtyp sickert nicht durch', async () => {
  const { pageId } = seed(8810, 'roman', 'fremd@test.dev');
  sessionUser = 'autor@test.dev';   // hat auf 8810 keine Rolle
  const r = await api('PUT', `/textsorte/page/${pageId}`, { textsorte: 'bericht' });
  assert.equal(r.status, 403);
  assert.notEqual(r.json.error_code, 'NOT_JOURNALISTIC_BOOK',
    'der Typ eines fremden Buchs darf nicht am Fehlercode ablesbar sein');
});

test('das Buch kommt aus der Seite, nicht aus dem Body', async () => {
  const meins = seed(8811, 'journalismus');
  const fremd = seed(8812, 'journalismus', 'fremd@test.dev');
  // Seite des FREMDEN Buchs, dazu die eigene book_id behauptet.
  const r = await api('PUT', `/textsorte/page/${fremd.pageId}`,
    { textsorte: 'bericht', book_id: meins.bookId });
  assert.equal(r.status, 403, 'eine behauptete book_id darf den ACL-Guard nicht umlenken');
});
