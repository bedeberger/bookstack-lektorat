'use strict';
// Unit-Tests für lib/bookstack.js – authHeader (Token-Shape-Normalisierung) und
// bsGetAll-Paginierung (fetch wird gestubbt).

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

const { authHeader, bsGetAll, bsGet } = require('../../lib/bookstack');

test('authHeader: Session-Shape {id, pw}', () => {
  assert.equal(authHeader({ id: 'abc', pw: 'def' }), 'Token abc:def');
});

test('authHeader: DB-Shape {token_id, token_pw}', () => {
  assert.equal(authHeader({ token_id: 'abc', token_pw: 'def' }), 'Token abc:def');
});

test('authHeader: kein Token → Env-Fallback', () => {
  const prevId = process.env.TOKEN_ID, prevPw = process.env.TOKEN_KENNWORT;
  process.env.TOKEN_ID = 'env-id';
  process.env.TOKEN_KENNWORT = 'env-pw';
  try {
    assert.equal(authHeader(null), 'Token env-id:env-pw');
  } finally {
    if (prevId === undefined) delete process.env.TOKEN_ID; else process.env.TOKEN_ID = prevId;
    if (prevPw === undefined) delete process.env.TOKEN_KENNWORT; else process.env.TOKEN_KENNWORT = prevPw;
  }
});

test('bsGetAll: iteriert alle Seiten via count=500 offset=N', async () => {
  const pages = [
    { total: 750, data: new Array(500).fill(0).map((_, i) => ({ id: i })) },
    { total: 750, data: new Array(250).fill(0).map((_, i) => ({ id: 500 + i })) },
  ];
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, json: async () => pages.shift() };
  };
  try {
    const all = await bsGetAll('pages?filter[book_id]=42', { id: 'x', pw: 'y' });
    assert.equal(all.length, 750);
    assert.equal(all[0].id, 0);
    assert.equal(all[749].id, 749);
    assert.equal(calls.length, 2);
    assert.match(calls[0], /offset=0/);
    assert.match(calls[1], /offset=500/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('bsGetAll: total ≤ count → einzelner Call (kein Endlos-Loop bei kleiner Liste)', async () => {
  // 47 Einträge, count=500 → ein Roundtrip, total=47 erfüllt Abbruchbedingung.
  // Regression-Schutz: wenn die Schleife `all.length >= total` falsch prüft,
  // läuft sie ewig oder fragt eine zweite leere Seite ab.
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      json: async () => ({
        total: 47,
        data: new Array(47).fill(0).map((_, i) => ({ id: i })),
      }),
    };
  };
  try {
    const all = await bsGetAll('books', { id: 'x', pw: 'y' });
    assert.equal(all.length, 47);
    assert.equal(calls.length, 1, 'darf nur einen Call machen wenn alle Items in einer Seite passen');
    assert.match(calls[0], /count=500/);
    assert.match(calls[0], /offset=0/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('bsGetAll: leeres Resultat → ein Call, leeres Array (kein Crash bei total=0)', async () => {
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, json: async () => ({ total: 0, data: [] }) };
  };
  try {
    const all = await bsGetAll('chapters?filter[book_id]=99', { id: 'x', pw: 'y' });
    assert.deepEqual(all, []);
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('bsGetAll: respektiert bestehende Query-Params (& statt ?)', async () => {
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, json: async () => ({ total: 1, data: [{ id: 1 }] }) };
  };
  try {
    await bsGetAll('pages?filter[book_id]=42', { id: 'x', pw: 'y' });
    // Wenn der Pfad ein `?` hat, muss `&` als Separator verwendet werden,
    // sonst entsteht ein zweites `?` und BookStack ignoriert die Pagination.
    assert.match(calls[0], /\?filter\[book_id\]=42&count=500&offset=0/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('bsGet: Non-OK-Response → Error mit status', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 403, text: async () => 'forbidden' });
  try {
    await assert.rejects(
      bsGet('books/1', { id: 'x', pw: 'y' }),
      err => {
        assert.equal(err.status, 403);
        assert.equal(err.bodyText, 'forbidden');
        return true;
      },
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});
