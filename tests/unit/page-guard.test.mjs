// Der Seiten-Guard (lib/page-guard.js) als Vertrag.
//
// Die Kette stand fünfmal kopiert in den Routen des redaktionellen Apparats, und
// eine Kopie hatte das Buchtyp-Gate verloren. Was hier geprüft wird, ist genau
// das, was beim Kopieren verloren geht:
//
//   1. Das Buch kommt AUS DER SEITE. Eine vom Client behauptete `book_id` darf
//      den ACL-Guard nicht erreichen — sonst prüft er das falsche Buch.
//   2. Die REIHENFOLGE: ACL vor Buchtyp. Ein Unberechtigter darf nicht erfahren,
//      welchen Typ ein fremdes Buch hat.
//   3. Der Guard antwortet SELBST und liefert dann null.
//
// Gefahrlos ohne DB: die drei Abhängigkeiten (Seiten-Lookup, ACL, Settings)
// werden über den Modul-Cache ersetzt.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const require = createRequire(import.meta.url);

// ── Stubs vor dem ersten require des Prüflings in den Modul-Cache legen ──────
const stub = (rel, exports) => {
  const p = require.resolve(path.join(ROOT, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

const calls = { guardBook: [], settings: [] };
let seiten = { 7: 42 };            // page_id → book_id
let aclErlaubt = true;
let buchtyp = 'journalismus';

stub('lib/content-ownership.js', {
  resolvePageBookId: (id) => seiten[Number(id)] || null,
  resolveChapterBookId: () => null,
});
stub('lib/acl.js', {
  guardBook: (req, res, bookId, minRole) => {
    calls.guardBook.push({ bookId, minRole });
    if (aclErlaubt) return true;
    res.status(403).json({ error_code: 'INSUFFICIENT_ROLE' });
    return false;
  },
  sessionEmail: () => 'a@b.ch',
});
stub('db/schema.js', {
  getBookSettings: (bookId) => { calls.settings.push(bookId); return { buchtyp }; },
});

const { pageBookGuard, journalisticBookSettings } = require(path.join(ROOT, 'lib/page-guard.js'));

function fakeRes() {
  const r = { code: null, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
const reset = () => {
  calls.guardBook = []; calls.settings = [];
  seiten = { 7: 42 }; aclErlaubt = true; buchtyp = 'journalismus';
};

test('das Buch kommt aus der Seite, nicht aus dem Body', () => {
  reset();
  const res = fakeRes();
  const g = pageBookGuard({ params: { page_id: '7' }, body: { book_id: 999 } }, res);
  assert.deepEqual(g && { pageId: g.pageId, bookId: g.bookId }, { pageId: 7, bookId: 42 });
  assert.deepEqual(calls.guardBook, [{ bookId: 42, minRole: 'editor' }],
    'die ACL muss gegen das Buch DER SEITE laufen, nicht gegen die behauptete ID');
});

test('unbekannte Seite → 404, ACL wird gar nicht erst gefragt', () => {
  reset();
  const res = fakeRes();
  assert.equal(pageBookGuard({ params: { page_id: '999' } }, res), null);
  assert.equal(res.code, 404);
  assert.equal(res.body.error_code, 'PAGE_NOT_FOUND');
  assert.equal(calls.guardBook.length, 0);
});

test('fehlende/ungültige page_id → 400', () => {
  reset();
  for (const params of [{}, { page_id: 'abc' }, { page_id: '0' }]) {
    const res = fakeRes();
    assert.equal(pageBookGuard({ params }, res), null);
    assert.equal(res.code, 400);
    assert.equal(res.body.error_code, 'PAGE_ID_REQUIRED');
  }
});

test('ACL läuft VOR dem Buchtyp-Gate', () => {
  reset();
  aclErlaubt = false;
  buchtyp = 'roman';
  const res = fakeRes();
  assert.equal(pageBookGuard({ params: { page_id: '7' } }, res, { journalistic: true }), null);
  assert.equal(res.code, 403, 'der Typ eines fremden Buchs darf nicht durchsickern');
  assert.equal(calls.settings.length, 0, 'Settings dürfen ohne Recht nicht gelesen werden');
});

test('Buchtyp-Gate greift nur, wenn es verlangt wird', () => {
  reset();
  buchtyp = 'roman';
  const ohne = pageBookGuard({ params: { page_id: '7' } }, fakeRes());
  assert.equal(ohne?.bookId, 42, 'ohne journalistic-Flag ist der Buchtyp egal');

  const res = fakeRes();
  assert.equal(pageBookGuard({ params: { page_id: '7' } }, res, { journalistic: true }), null);
  assert.equal(res.code, 400);
  assert.equal(res.body.error_code, 'NOT_JOURNALISTIC_BOOK');
});

test('blog zählt als publizistisch, roman nicht', () => {
  for (const [typ, erwartet] of [['journalismus', true], ['blog', true], ['roman', false], [null, false]]) {
    reset();
    buchtyp = typ;
    const g = pageBookGuard({ params: { page_id: '7' } }, fakeRes(), { journalistic: true });
    assert.equal(!!g, erwartet, `buchtyp=${typ}`);
    assert.equal(!!journalisticBookSettings({}, 42), erwartet, `journalisticBookSettings buchtyp=${typ}`);
  }
});

test('pageId kann direkt übergeben werden (Body-Routen der Job-Endpunkte)', () => {
  reset();
  const g = pageBookGuard({ params: {}, body: { page_id: 7 } }, fakeRes(), { pageId: 7 });
  assert.equal(g?.pageId, 7);
});

test('minRole wird durchgereicht', () => {
  reset();
  pageBookGuard({ params: { page_id: '7' } }, fakeRes(), { minRole: 'viewer' });
  assert.equal(calls.guardBook[0].minRole, 'viewer');
});
