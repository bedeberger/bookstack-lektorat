// Gate fuer die Kohaerenz-Invariante der SPA-Shell im Service Worker.
//
// WARUM ALS UNIT-TEST: Der SW ist auf localhost bewusst deaktiviert
// (public/js/app/boot/sw-register.js) — dieser Fehlerfall kann darum weder
// lokal noch per Klick-Test noch im Smoke auffallen. Er entsteht ausschliesslich
// beim Deploy auf HTTPS und schlaegt dann als Wand von Alpine-Expression-Fehlern
// zu ("$store.x is undefined", "xxxCard is not defined").
//
// DIE INVARIANTE: Der Shell-HTML gehoert zum kohaerenz-kritischen Asset-Satz.
// Jede SW-Generation precacht ihren Satz atomar und liefert ihn cache-only aus.
// Wuerde handleNavigate die Netzkopie in den SHELL_CACHE zurueckschreiben,
// landete nach einem Deploy das HTML der NEUEN Generation im Cache des noch
// aktiven ALTEN SW (kein skipWaiting) — waehrend jedes Modul/Partial weiter
// cache-only aus der ALTEN Generation kommt. Ergebnis: neues Markup gegen alte
// JS-Module. Ein Login ist der typische Ausloeser, weil er mehrere echte
// Navigationen hintereinander macht: die erste schreibt das fremde HTML in den
// Cache, die zweite serviert es.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SW_SRC = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');

// Minimal-Stubs der SW-Umgebung. Nur so viel, dass sw.js evaluiert und
// handleNavigate aufrufbar ist.
class FakeResponse {
  constructor(body, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.headers = init.headers ?? {};
    this.type = init.type ?? 'basic';
  }
  get ok() { return this.status >= 200 && this.status < 300; }
  clone() { return new FakeResponse(this.body, { status: this.status, headers: this.headers, type: this.type }); }
}

class FakeRequest {
  constructor(url, init = {}) {
    this.url = String(url).startsWith('http') ? String(url) : 'https://example.test' + url;
    this.method = init.method ?? 'GET';
    this.mode = init.mode ?? 'navigate';
  }
}

function makeCache(initial = {}) {
  const store = new Map(Object.entries(initial));
  const writes = [];
  return {
    store,
    writes,
    async match(req, opts = {}) {
      const key = typeof req === 'string' ? req : new URL(req.url).pathname;
      if (store.has(key)) return store.get(key);
      if (opts.ignoreSearch) {
        const bare = key.split('?')[0];
        if (store.has(bare)) return store.get(bare);
      }
      return undefined;
    },
    async put(req, res) {
      const key = typeof req === 'string' ? req : new URL(req.url).pathname;
      writes.push(key);
      store.set(key, res);
    },
    async add() { throw new Error('cache.add nicht erwartet'); },
    async keys() { return [...store.keys()]; },
  };
}

// Laedt sw.js in einen frischen VM-Context. Top-Level-Funktionsdeklarationen
// (handleNavigate) landen dabei als Globals des Contexts und sind aufrufbar,
// waehrend die `const`-Bindings (SHELL_CACHE, SHELL_PATH) im Scope sichtbar
// bleiben.
function loadSw({ cache, fetchImpl }) {
  const caches = {
    async open() { return cache; },
    async keys() { return []; },
    async delete() { return true; },
    async match() { return undefined; },
  };
  const sandbox = {
    console,
    URL,
    setTimeout,
    clearTimeout,
    Response: FakeResponse,
    Request: FakeRequest,
    caches,
    fetch: fetchImpl,
    importScripts() { /* Manifest-Konstanten werden unten direkt gesetzt */ },
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self.__SHELL_BUILD = 'testbuild';
  sandbox.self.__SHELL_MANIFEST = ['/js/app.js', '/partials/x.html'];
  sandbox.self.addEventListener = () => {};
  sandbox.self.clients = { matchAll: async () => [] };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(SW_SRC, ctx);
  return ctx;
}

test('handleNavigate ueberschreibt eine gecachte Shell NICHT mit der Netzkopie', async () => {
  const cachedShell = new FakeResponse('<html>GENERATION-A</html>');
  const cache = makeCache({ '/index.html': cachedShell });
  let fetchCalls = 0;
  const ctx = loadSw({
    cache,
    fetchImpl: async () => {
      fetchCalls++;
      return new FakeResponse('<html>GENERATION-B</html>');
    },
  });

  const res = await ctx.handleNavigate(new FakeRequest('/'));

  assert.equal(res.body, '<html>GENERATION-A</html>',
    'Bei Cache-Hit muss die Shell DIESER Generation ausgeliefert werden.');
  assert.deepEqual(cache.writes, [],
    'Kein Write in den SHELL_CACHE bei Cache-Hit — sonst landet fremdes HTML in dieser Generation.');
  assert.equal(cache.store.get('/index.html').body, '<html>GENERATION-A</html>',
    'Die gecachte Shell darf unveraendert bleiben.');
  assert.equal(fetchCalls, 0,
    'Kein Revalidate-Fetch: die Generation ist unveraenderlich (HTML-Bytes gehen in __SHELL_BUILD ein).');
});

test('handleNavigate faellt bei kaltem Cache aufs Netz zurueck und fuellt einmalig', async () => {
  const cache = makeCache({});
  const ctx = loadSw({
    cache,
    fetchImpl: async () => new FakeResponse('<html>FRISCH</html>'),
  });

  const res = await ctx.handleNavigate(new FakeRequest('/'));

  assert.equal(res.body, '<html>FRISCH</html>');
  assert.deepEqual(cache.writes, ['/index.html'],
    'Erstbefuellung ist erlaubt — es gibt keine kohaerente Generation, die ueberschrieben wuerde.');
});

test('handleNavigate cacht keinen Login-Redirect und keine Fehlerantwort als Shell', async () => {
  for (const bad of [
    new FakeResponse('', { status: 302, type: 'opaqueredirect' }),
    new FakeResponse('nope', { status: 500 }),
  ]) {
    const cache = makeCache({});
    const ctx = loadSw({ cache, fetchImpl: async () => bad });
    await ctx.handleNavigate(new FakeRequest('/'));
    assert.deepEqual(cache.writes, [],
      `Antwort (status=${bad.status}, type=${bad.type}) darf nicht als SPA-Shell gecacht werden.`);
  }
});

test('handleNavigate liefert 503 statt zu haengen, wenn offline und Cache leer', async () => {
  const cache = makeCache({});
  const ctx = loadSw({
    cache,
    fetchImpl: async () => { throw new Error('offline'); },
  });

  const res = await ctx.handleNavigate(new FakeRequest('/'));
  assert.equal(res.status, 503);
});
