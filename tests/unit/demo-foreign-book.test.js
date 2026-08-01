'use strict';
// Demo-Seed: das zweite Buch, in das der Demo-User NICHT schreiben darf
// (lib/demo-book.js#createForeignDemoBook). Es ist der einzige vorfuehrbare
// 403-Pfad der Browser-Erweiterung — deshalb wird hier gegated, dass es
// entsteht, dass es genau EINMAL entsteht und dass die Rolle stimmt.
//
// Der HTTP-Pfad daneben (GET /content/books zeigt beide, POST /capture 403)
// liegt in tests/integration/demo-seed-acl.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Eigene Test-DB pro Lauf (Statement-Cache-Kollision bei paralleler Suite).
const tmp = path.join('/tmp', `demo-foreign-test-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmp;

const { db } = require('../../db/schema'); // Connection + Migrationen
const appUsers = require('../../db/app-users');
const bookAccess = require('../../db/book-access');
const { requireBookAccess, ACLError } = require('../../lib/acl');
const {
  createForeignDemoBook, FOREIGN_BOOK_NAME, FOREIGN_OWNER_EMAIL,
} = require('../../lib/demo-book');

const DEMO = 'demo@x.test';

function fakeReq(email) {
  return { session: { user: { email } } };
}

test.before(() => {
  appUsers.createUser({ email: DEMO, displayName: 'Demo', globalRole: 'user', status: 'active' });
});

test('Besitzer-Adresse liegt auf example.org (RFC 2606)', () => {
  // `GET /content/books` gibt owner_email an den Store-Pruefer heraus — eine
  // echte Adresse duerfte dort nie stehen. Wer die Konstante aendert, faellt hier.
  assert.match(FOREIGN_OWNER_EMAIL, /@example\.org$/);
});

test('Erstlauf: Buch, Besitzer-Konto, Inhalt und viewer-Grant entstehen', async () => {
  const r = await createForeignDemoBook(DEMO);
  assert.equal(r.deduplicated, false);
  assert.ok(r.bookId > 0);

  const book = db.prepare('SELECT name, owner_email FROM books WHERE book_id = ?').get(r.bookId);
  assert.equal(book.name, FOREIGN_BOOK_NAME);
  assert.equal(book.owner_email, FOREIGN_OWNER_EMAIL);

  // Das Konto existiert nur als FK-Ziel + Besitzer-Label und darf sich nie
  // anmelden koennen.
  const owner = appUsers.getUser(FOREIGN_OWNER_EMAIL);
  assert.equal(owner.status, 'suspended');
  assert.equal(owner.global_role, 'user');
  assert.equal(owner.can_invite_users, 0);

  assert.equal(bookAccess.getBookRole(r.bookId, FOREIGN_OWNER_EMAIL), 'owner');
  assert.equal(bookAccess.getBookRole(r.bookId, DEMO), 'viewer');

  // Nicht leer: ein Pruefer, der hineinklickt, soll die Erklaerung lesen.
  const pages = db.prepare('SELECT COUNT(*) AS n FROM pages WHERE book_id = ?').get(r.bookId).n;
  const chapters = db.prepare('SELECT COUNT(*) AS n FROM chapters WHERE book_id = ?').get(r.bookId).n;
  assert.ok(pages >= 1 && chapters >= 1);
});

test('Zweitlauf (Serverstart / demo-reset): kein zweites Buch', async () => {
  const first = await createForeignDemoBook(DEMO);
  const second = await createForeignDemoBook(DEMO);
  assert.equal(second.deduplicated, true);
  assert.equal(second.bookId, first.bookId);

  const n = db.prepare(
    'SELECT COUNT(*) AS n FROM books WHERE owner_email = ?'
  ).get(FOREIGN_OWNER_EMAIL).n;
  assert.equal(n, 1);
});

test('Idempotenz haengt an der Besitz-Row, nicht am Buchnamen', async () => {
  const first = await createForeignDemoBook(DEMO);
  // Ein Reset spielt einen aelteren Stand ein, in dem das Buch anders heisst.
  // Ein Namens-Dedup wuerde jetzt ein zweites Buch anlegen.
  db.prepare('UPDATE books SET name = ? WHERE book_id = ?').run('Umbenannt', first.bookId);
  const again = await createForeignDemoBook(DEMO);
  assert.equal(again.deduplicated, true);
  assert.equal(again.bookId, first.bookId);
});

test('Entzogener viewer-Grant wird beim naechsten Lauf wiederhergestellt', async () => {
  const r = await createForeignDemoBook(DEMO);
  bookAccess.revokeAccess(r.bookId, DEMO);
  assert.equal(bookAccess.getBookRole(r.bookId, DEMO), null);

  await createForeignDemoBook(DEMO);
  assert.equal(bookAccess.getBookRole(r.bookId, DEMO), 'viewer');
});

test('ACL: Demo-User liest, schreibt aber nicht (INSUFFICIENT_ROLE mit detail)', async () => {
  const r = await createForeignDemoBook(DEMO);
  const req = fakeReq(DEMO);

  assert.equal(requireBookAccess(req, r.bookId, 'viewer'), 'viewer');

  assert.throws(
    () => requireBookAccess(req, r.bookId, 'editor'),
    (e) => {
      assert.ok(e instanceof ACLError);
      assert.equal(e.code, 'INSUFFICIENT_ROLE');
      assert.equal(e.status, 403);
      // Genau dieses Detail macht die Client-Meldung erklaerend statt generisch.
      assert.deepEqual(e.detail, { actual: 'viewer', required: 'editor' });
      return true;
    },
  );
});

test('Fremder User ohne Grant: NO_BOOK_ACCESS, nicht INSUFFICIENT_ROLE', async () => {
  const r = await createForeignDemoBook(DEMO);
  assert.throws(
    () => requireBookAccess(fakeReq('niemand@x.test'), r.bookId, 'viewer'),
    (e) => e.code === 'NO_BOOK_ACCESS' && e.status === 403,
  );
});
