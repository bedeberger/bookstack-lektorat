// Unit-Tests fuer public/js/repo/content.js — Domain-Repository fuer
// Buch/Kapitel/Seiten. Stub globalThis.fetch und verifiziert URL-Bau,
// fresh-Bypass, Retry-Verhalten und Cache-Invalidation-Postmessage.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { contentRepo } = await import('../../public/js/repo/content.js');

let originalFetch;
let originalNavigatorDesc;
let postedMessages;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  postedMessages = [];
  // Node 22+: globalThis.navigator ist non-writable Getter. Via defineProperty
  // mit configurable:true ueberschreibbar, sonst TypeError.
  originalNavigatorDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: {
      serviceWorker: {
        controller: {
          postMessage(msg) { postedMessages.push(msg); },
        },
      },
    },
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalNavigatorDesc) {
    Object.defineProperty(globalThis, 'navigator', originalNavigatorDesc);
  } else {
    delete globalThis.navigator;
  }
});

function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return handler(String(url), opts || {}, calls.length);
  };
  return calls;
}

function ok(json, status = 200) {
  return new Response(JSON.stringify(json), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('listBooks → GET /content/books', async () => {
  const calls = mockFetch(() => ok([{ id: 1, name: 'A' }]));
  const out = await contentRepo.listBooks();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/content/books');
  assert.deepEqual(out, [{ id: 1, name: 'A' }]);
});

test('bookTree → GET /content/books/:id/tree', async () => {
  const calls = mockFetch(() => ok({ chapters: [], topPages: [] }));
  await contentRepo.bookTree(42);
  assert.equal(calls[0].url, '/content/books/42/tree');
});

test('loadPage hängt stripFocusArtefacts ans html', async () => {
  // stripFocusArtefacts entfernt das Persistenz-Backup-Sentinel; ohne Marker
  // bleibt der String unangetastet. Hier reicht es zu verifizieren, dass die
  // Funktion lief (kein Throw, html-String erhalten).
  mockFetch(() => ok({ id: 1, name: 'p', html: '<p>Hallo</p>' }));
  const page = await contentRepo.loadPage(1);
  assert.equal(page.html, '<p>Hallo</p>');
});

test('loadPage mit {fresh:true} setzt __fresh-Query', async () => {
  const calls = mockFetch(() => ok({ id: 1, html: '' }));
  await contentRepo.loadPage(1, { fresh: true });
  assert.equal(calls[0].url, '/content/pages/1?__fresh=1');
});

test('savePage → PUT /content/pages/:id mit JSON-Body', async () => {
  const calls = mockFetch(() => ok({ id: 1, html: '<p>new</p>', name: 'X' }));
  const out = await contentRepo.savePage(1, { html: '<p>new</p>', name: 'X' });
  assert.equal(calls[0].url, '/content/pages/1');
  assert.equal(calls[0].opts.method, 'PUT');
  assert.equal(calls[0].opts.headers['Content-Type'], 'application/json');
  // Body-Change traegt zusaetzlich die device_id (geraete-bewusster /changes-Feed).
  const sent = JSON.parse(calls[0].opts.body);
  assert.equal(sent.html, '<p>new</p>');
  assert.equal(sent.name, 'X');
  assert.equal(typeof sent.device_id, 'string');
  assert.ok(sent.device_id.length > 0);
  assert.equal(out.id, 1);
});

test('savePage dispatcht invalidate-content an SW (inkl. revisions sub-path bei html-Body)', async () => {
  mockFetch(() => ok({ id: 7 }));
  await contentRepo.savePage(7, { html: '<p>x</p>' });
  assert.equal(postedMessages.length, 1);
  assert.deepEqual(postedMessages[0], { type: 'invalidate-content', paths: ['pages/7', 'pages/7/revisions'] });
});

test('savePage ohne html invalidiert nur die Seite, nicht den Revisions-Pfad', async () => {
  mockFetch(() => ok({ id: 7 }));
  await contentRepo.savePage(7, { name: 'rename only' });
  assert.equal(postedMessages.length, 1);
  assert.deepEqual(postedMessages[0], { type: 'invalidate-content', paths: ['pages/7'] });
});

test('createBook → POST /content/books', async () => {
  const calls = mockFetch(() => ok({ id: 99, name: 'Neu' }));
  const out = await contentRepo.createBook({ name: 'Neu' });
  assert.equal(calls[0].url, '/content/books');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(out.id, 99);
});

test('deletePage invalidiert Seite + Tree-Cache (bookId gesetzt)', async () => {
  // SW-SWR: ohne Tree-Bust liefert der naechste bookTree-Read die geloeschte
  // Seite aus dem Cache zurueck (Geister-Seite). Tree-Bust muss wie bei
  // createPage/movePage mitgegeben werden.
  const calls = mockFetch(() => ok({ ok: true }));
  await contentRepo.deletePage(7, { bookId: 42 });
  assert.equal(calls[0].opts.method, 'DELETE');
  assert.ok(calls[0].url.startsWith('/content/pages/7?device_id='));
  assert.equal(postedMessages.length, 1);
  assert.deepEqual(postedMessages[0], {
    type: 'invalidate-content',
    paths: ['pages/7', 'books/42/tree'],
  });
});

test('deletePage ohne bookId invalidiert nur die Seite', async () => {
  mockFetch(() => ok({ ok: true }));
  await contentRepo.deletePage(7);
  assert.equal(postedMessages.length, 1);
  assert.deepEqual(postedMessages[0], {
    type: 'invalidate-content',
    paths: ['pages/7'],
  });
});

test('GET-Fehler liefert Error mit status + error_code', async () => {
  mockFetch(() => new Response(
    JSON.stringify({ error_code: 'INVALID_PAGE_ID' }),
    { status: 400, headers: { 'Content-Type': 'application/json' } },
  ));
  await assert.rejects(
    () => contentRepo.loadPage(0),
    (e) => e.status === 400 && e.code === 'INVALID_PAGE_ID',
  );
});

test('429 wird retried, danach Erfolg', async () => {
  let attempt = 0;
  mockFetch(() => {
    attempt++;
    if (attempt < 2) {
      return new Response('', {
        status: 429,
        headers: { 'Retry-After': '0' },
      });
    }
    return ok({ id: 1, name: 'A' });
  });
  const out = await contentRepo.loadBook(1);
  assert.equal(out.id, 1);
  assert.equal(attempt, 2);
});
