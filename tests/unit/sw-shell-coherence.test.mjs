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

// DIE ZWEITE INVARIANTE: Nur die echte SPA-Shell darf als Shell gelten.
// `GET /` liefert unter EINER URL zwei Dokumente — eingeloggt die Shell, anonym
// die Landing-Seite (routes/public.js), beide mit 200 und ohne Redirect —, und
// die Partials stehen hinter dem Auth-Guard (302 auf /login). Ein Install ohne
// gueltige Session legte darum frueher die Landing-Seite als Shell und die
// Login-Seite unter jedem Partial-Pfad ab. Weil Shell-Assets cache-only
// ausgeliefert werden, blieb die Generation danach dauerhaft kaputt: der
// eingeloggte User sah die anonyme Startseite, ein Klick auf "Anmelden" fuehrte
// ueber /login zurueck auf dieselbe gecachte Seite ("nichts passiert"), und nur
// ein Hard-Refresh (umgeht den SW) kam daran vorbei.
//
// Minimal-Stubs der SW-Umgebung. Nur so viel, dass sw.js evaluiert und
// handleNavigate/install aufrufbar sind.
const SHELL_HTML = '<body x-data="lektorat">GENERATION-A</body>';
const SHELL_HEADERS = { 'X-App-Shell': '1' };

class FakeResponse {
  constructor(body, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.type = init.type ?? 'basic';
    this._h = new Map(
      Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    // Echte Responses tragen ein Headers-Objekt; sw.js liest darueber den
    // Shell-Marker. Ein blankes `{}` wuerde den Aufruf werfen lassen.
    this.headers = { get: (k) => this._h.get(String(k).toLowerCase()) ?? null };
  }
  get ok() { return this.status >= 200 && this.status < 300; }
  async text() { return this.body; }
  clone() {
    return new FakeResponse(this.body, {
      status: this.status, type: this.type, headers: Object.fromEntries(this._h),
    });
  }
}

class FakeRequest {
  constructor(url, init = {}) {
    this.url = String(url).startsWith('http') ? String(url) : 'https://example.test' + url;
    this.method = init.method ?? 'GET';
    this.mode = init.mode ?? 'navigate';
    // `redirect`/`signal` reicht der Precache mit — der Test prueft genau das.
    this.redirect = init.redirect ?? 'follow';
    this.signal = init.signal;
  }
  get pathname() { return new URL(this.url).pathname; }
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
  const listeners = {};
  const sandbox = {
    console,
    URL,
    AbortController,
    // Backoff sofort ablaufen lassen — die Tests messen Verhalten, nicht Wartezeit.
    setTimeout: (fn) => { fn(); return 0; },
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
  sandbox.self.addEventListener = (type, fn) => { listeners[type] = fn; };
  sandbox.self.clients = { matchAll: async () => [] };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(SW_SRC, ctx);
  ctx.__listeners = listeners;
  return ctx;
}

// Feuert 'install' und liefert das an waitUntil uebergebene Promise.
function runInstall(ctx) {
  let p;
  ctx.__listeners.install({ waitUntil: (promise) => { p = promise; } });
  return p;
}

test('handleNavigate ueberschreibt eine gecachte Shell NICHT mit der Netzkopie', async () => {
  const cachedShell = new FakeResponse(SHELL_HTML, { headers: SHELL_HEADERS });
  const cache = makeCache({ '/index.html': cachedShell });
  let fetchCalls = 0;
  const ctx = loadSw({
    cache,
    fetchImpl: async () => {
      fetchCalls++;
      return new FakeResponse('<body x-data="lektorat">GENERATION-B</body>', { headers: SHELL_HEADERS });
    },
  });

  const res = await ctx.handleNavigate(new FakeRequest('/'));

  assert.equal(res.body, SHELL_HTML,
    'Bei Cache-Hit muss die Shell DIESER Generation ausgeliefert werden.');
  assert.deepEqual(cache.writes, [],
    'Kein Write in den SHELL_CACHE bei Cache-Hit — sonst landet fremdes HTML in dieser Generation.');
  assert.equal(cache.store.get('/index.html').body, SHELL_HTML,
    'Die gecachte Shell darf unveraendert bleiben.');
  assert.equal(fetchCalls, 0,
    'Kein Revalidate-Fetch: die Generation ist unveraenderlich (HTML-Bytes gehen in __SHELL_BUILD ein).');
});

test('handleNavigate serviert eine gecachte Shell OHNE Marker weiter (Altbestand)', async () => {
  // Eintraege aus einer Generation vor dem Marker sind echte Shells. Sie durch
  // die Netzkopie zu ersetzen waere nach einem Deploy neues HTML gegen alte
  // Module — genau der Skew von oben. Erkannt wird das am Inhalt.
  const cache = makeCache({ '/index.html': new FakeResponse(SHELL_HTML) });
  let fetchCalls = 0;
  const ctx = loadSw({
    cache,
    fetchImpl: async () => { fetchCalls++; return new FakeResponse('<html>GENERATION-B</html>'); },
  });

  const res = await ctx.handleNavigate(new FakeRequest('/'));

  assert.equal(res.body, SHELL_HTML);
  assert.equal(fetchCalls, 0, 'kein Netz-Fetch, kein Generationswechsel durch die Hintertuer');
  assert.deepEqual(cache.writes, []);
});

test('handleNavigate liefert eine eingefangene Landing-Seite NICHT als Shell aus', async () => {
  // Die kaputte Lage: ein Install ohne Session hat die Landing-Seite als Shell
  // abgelegt. Sie auszuliefern hiesse, dem eingeloggten User die anonyme
  // Startseite zu zeigen — die Falle, aus der nur der Hard-Refresh half.
  const cache = makeCache({ '/index.html': new FakeResponse('<h1>Landing</h1>') });
  const ctx = loadSw({
    cache,
    fetchImpl: async () => new FakeResponse(SHELL_HTML, { headers: SHELL_HEADERS }),
  });

  const res = await ctx.handleNavigate(new FakeRequest('/'));

  assert.equal(res.body, SHELL_HTML, 'der User bekommt die echte Shell vom Netz');
  assert.deepEqual(cache.writes, [],
    'aber kein Write in die fremde Generation — die raeumt der naechste Install auf.');
});

test('handleNavigate faellt bei kaltem Cache aufs Netz zurueck und fuellt einmalig', async () => {
  const cache = makeCache({});
  const ctx = loadSw({
    cache,
    fetchImpl: async () => new FakeResponse('<html>FRISCH</html>', { headers: SHELL_HEADERS }),
  });

  const res = await ctx.handleNavigate(new FakeRequest('/'));

  assert.equal(res.body, '<html>FRISCH</html>');
  assert.deepEqual(cache.writes, ['/index.html'],
    'Erstbefuellung ist erlaubt — es gibt keine kohaerente Generation, die ueberschrieben wuerde.');
});

test('handleNavigate cacht die anonyme Landing-Seite nicht als Shell', async () => {
  // Kalter Cache, keine Session: `/` antwortet mit 200 und der Landing-Seite.
  // Ohne Marker-Pruefung landete genau die als SPA-Shell in der Generation.
  const cache = makeCache({});
  const ctx = loadSw({ cache, fetchImpl: async () => new FakeResponse('<h1>Landing</h1>') });

  const res = await ctx.handleNavigate(new FakeRequest('/'));

  assert.equal(res.body, '<h1>Landing</h1>', 'anonyme Besucher sehen sie normal');
  assert.deepEqual(cache.writes, [], 'sie darf dabei nicht zur Shell werden');
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

// --- Install: keine vergiftete Generation anlegen ----------------------------

test('Install bricht ab, wenn `/` die Landing-Seite liefert — nach EINEM Request', async () => {
  const cache = makeCache({});
  const seen = [];
  const ctx = loadSw({
    cache,
    fetchImpl: async (req) => {
      seen.push(req.pathname);
      return req.pathname === '/' ? new FakeResponse('<h1>Landing</h1>') : new FakeResponse('asset');
    },
  });

  await assert.rejects(runInstall(ctx),
    'Ohne Session ist diese Generation nicht installierbar — sie waere nur Muell.');
  assert.deepEqual(cache.writes, [], 'nichts gecacht: die alte Generation bleibt heil');
  assert.deepEqual(seen, ['/'],
    'Die Shell-Antwort klaert die Lage allein — kein Precache-Sturm ueber ~800 Assets.');
});

test('Precache cacht keine umgeleitete Antwort (Auth-Guard → /login)', async () => {
  // Session bricht MITTEN im Install weg: `/` kam noch als Shell, die Partials
  // laufen schon in den Guard. `redirect: 'error'` muss daraus einen Fehler
  // machen — ein gefolgter 302 landete sonst als Login-Seite unter dem
  // Partial-Pfad, und cache-only servierte sie danach als Karte aus.
  const cache = makeCache({});
  const ctx = loadSw({
    cache,
    fetchImpl: async (req) => {
      if (req.pathname === '/') return new FakeResponse(SHELL_HTML, { headers: SHELL_HEADERS });
      if (req.pathname.startsWith('/partials/')) {
        if (req.redirect === 'error') throw new TypeError('Failed to fetch: redirect');
        return new FakeResponse('<title>Anmeldung</title>');
      }
      return new FakeResponse('asset');
    },
  });

  await assert.rejects(runInstall(ctx));
  assert.deepEqual(cache.writes, [], 'kein halb gefuellter Cache, auch nicht die Shell');
});

test('Install cacht die markierte Shell unter beiden Schluesseln', async () => {
  const cache = makeCache({});
  const ctx = loadSw({
    cache,
    fetchImpl: async (req) => (req.pathname === '/'
      ? new FakeResponse(SHELL_HTML, { headers: SHELL_HEADERS })
      : new FakeResponse('asset')),
  });

  await runInstall(ctx);

  assert.equal(cache.store.get('/index.html').body, SHELL_HTML);
  assert.equal(cache.store.get('/').body, SHELL_HTML,
    'Navigation fragt "/", der Lookup greift auf SHELL_PATH — beide muessen treffen.');
  assert.ok(cache.store.has('/partials/x.html'), 'der uebrige Satz ist ebenfalls drin');
});

// --- Drift-Gate --------------------------------------------------------------

test('SHELL_BODY_MARKER steht wirklich in public/index.html', () => {
  const ctx = loadSw({ cache: makeCache({}), fetchImpl: async () => new FakeResponse('') });
  const marker = vm.runInContext('SHELL_BODY_MARKER', ctx);
  const indexHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

  assert.ok(indexHtml.includes(marker),
    `public/index.html enthaelt "${marker}" nicht mehr — der SW erkennt unmarkierte `
    + 'Alt-Eintraege dann nicht als Shell und holt sie bei jeder Navigation neu.');
  for (const other of ['public/landing.html', 'public/register.html']) {
    assert.ok(!fs.readFileSync(path.join(ROOT, other), 'utf8').includes(marker),
      `${other} enthaelt "${marker}" — der Marker muss die SPA-Shell eindeutig auszeichnen.`);
  }
});
