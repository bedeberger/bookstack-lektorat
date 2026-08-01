// Unit-Tests fuer den Remote-Zweig von lib/pdf-render/images.js.
//
// Warum eigene Suite: die Bild-URL kommt aus dem `src` eines <img> im
// Manuskript-HTML und ist damit user-kontrolliert. Der PDF-Export macht daraus
// einen serverseitigen Request — ohne Guard ist das ein SSRF-Werkzeug aus dem
// Inneren des Containers (interne Dienste, Cloud-Metadaten-Endpunkt), und ohne
// Deckel ein Speicher- und Haenger-Risiko. Gegated werden hier genau diese vier
// Eigenschaften: Ziel-Pruefung, Pruefung PRO Redirect-Hop, Byte-Deckel, Timeout.
//
// Lauf: `node --test tests/unit/pdf-image-fetch.test.mjs`

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Muss vor dem Import stehen: der Test nutzt nicht-aufloesbare Reserved-TLD-Hosts
// (example.test) und stubbt fetch — nur die DNS-Aufloesung wird uebersprungen,
// der Literal-/localhost-Block des Guards bleibt aktiv.
process.env.SSRF_SKIP_DNS_CHECK = '1';

const sharp = (await import('sharp')).default;
const { _fetchImage, MAX_REMOTE_BYTES } = await import('../../lib/pdf-render/images.js');

const PNG_1x1 = await sharp({
  create: { width: 4, height: 4, channels: 3, background: '#336699' },
}).png().toBuffer();

const realFetch = globalThis.fetch;

// Minimal-Response, die der Loader braucht: headers.get + body/arrayBuffer.
function okResponse(buf, headers = {}) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok: true,
    status: 200,
    headers: { get: (k) => map.get(String(k).toLowerCase()) ?? null },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

function redirectResponse(location) {
  return {
    ok: false,
    status: 302,
    headers: { get: (k) => (String(k).toLowerCase() === 'location' ? location : null) },
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

// Stubbt fetch und protokolliert die Aufrufe. Gibt eine restore-Funktion zurueck.
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return handler(String(url), opts, calls.length - 1);
  };
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

// ── Ziel-Pruefung ────────────────────────────────────────────────────────────

const BLOCKED = [
  ['loopback',            'http://127.0.0.1/x.png'],
  ['localhost-Name',      'http://localhost:3737/x.png'],
  ['Cloud-Metadaten',     'http://169.254.169.254/latest/meta-data/iam/'],
  ['privates Netz /8',    'http://10.0.0.5:8080/x.png'],
  ['privates Netz /16',   'http://192.168.1.1/x.png'],
  ['IPv6-loopback',       'http://[::1]/x.png'],
];

for (const [label, url] of BLOCKED) {
  test(`SSRF: ${label} wird nicht abgerufen`, async () => {
    const f = stubFetch(() => okResponse(PNG_1x1));
    try {
      assert.equal(await _fetchImage(url, null, undefined), null);
      assert.equal(f.calls.length, 0, 'fetch darf gar nicht losgehen');
    } finally { f.restore(); }
  });
}

test('SSRF: Redirect auf eine interne Adresse wird beim zweiten Hop gestoppt', async () => {
  // Der gefaehrliche Fall: der erste Hop ist oeffentlich und unauffaellig, das
  // Ziel liegt hinter der Umleitung. Ein Einmal-Check am Anfang liesse das durch.
  const f = stubFetch((url) =>
    url.includes('example.test') ? redirectResponse('http://127.0.0.1/secret') : okResponse(PNG_1x1)
  );
  try {
    assert.equal(await _fetchImage('http://example.test/pic.png', null, undefined), null);
    assert.equal(f.calls.length, 1, 'nur der erste Hop darf laufen');
  } finally { f.restore(); }
});

test('SSRF: Redirects werden manuell verfolgt (nicht von fetch)', async () => {
  const f = stubFetch((url) =>
    url.endsWith('/a.png') ? redirectResponse('https://cdn.example.test/b.png') : okResponse(PNG_1x1)
  );
  try {
    const out = await _fetchImage('https://example.test/a.png', null, undefined);
    assert.ok(out?.buffer, 'oeffentlicher Redirect bleibt erlaubt');
    assert.equal(f.calls.length, 2);
    for (const c of f.calls) {
      assert.equal(c.opts.redirect, 'manual', 'sonst folgt fetch ungeprueft');
      assert.ok(c.opts.signal, 'Timeout-Signal fehlt');
    }
  } finally { f.restore(); }
});

test('SSRF: Redirect-Kette endet nach dem Deckel statt endlos zu laufen', async () => {
  let n = 0;
  const f = stubFetch(() => redirectResponse(`https://example.test/hop${++n}.png`));
  try {
    assert.equal(await _fetchImage('https://example.test/start.png', null, undefined), null);
    assert.ok(f.calls.length <= 5, `zu viele Hops: ${f.calls.length}`);
  } finally { f.restore(); }
});

// ── Groessen-Deckel ──────────────────────────────────────────────────────────

test('Deckel: angekuendigte Ueberlaenge (content-length) bricht vor dem Lesen ab', async () => {
  let read = false;
  const f = stubFetch(() => {
    const res = okResponse(PNG_1x1, { 'content-length': String(MAX_REMOTE_BYTES + 1) });
    res.arrayBuffer = async () => { read = true; return new ArrayBuffer(0); };
    return res;
  });
  try {
    assert.equal(await _fetchImage('https://example.test/huge.png', null, undefined), null);
    assert.equal(read, false, 'Body darf nicht mehr gelesen werden');
  } finally { f.restore(); }
});

test('Deckel: gestreamte Ueberlaenge bricht mitten im Body ab', async () => {
  // Kein content-length (chunked) — der Zaehler im Stream muss greifen.
  const chunk = Buffer.alloc(1024 * 1024, 0x41);
  let yielded = 0;
  const f = stubFetch(() => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      async *[Symbol.asyncIterator]() {
        for (;;) { yielded++; yield chunk; }
      },
    },
  }));
  try {
    assert.equal(await _fetchImage('https://example.test/stream.png', null, undefined), null);
    assert.ok(yielded <= MAX_REMOTE_BYTES / chunk.length + 1, `Stream zu lange gelesen: ${yielded}`);
  } finally { f.restore(); }
});

// ── Normalbetrieb bleibt intakt ──────────────────────────────────────────────

test('oeffentliches Bild wird geholt und normalisiert', async () => {
  const f = stubFetch(() => okResponse(PNG_1x1, { 'content-length': String(PNG_1x1.length) }));
  try {
    const out = await _fetchImage('https://example.test/pic.png', null, undefined);
    assert.equal(out.width, 4);
    assert.equal(out.height, 4);
    assert.ok(out.buffer.length > 0);
    // PDF/A: sharp liefert JPEG (SOI-Marker), kein PNG mehr.
    assert.equal(out.buffer[0], 0xff);
    assert.equal(out.buffer[1], 0xd8);
  } finally { f.restore(); }
});

test('nicht-OK-Antwort liefert null (kein Abbruch des Exports)', async () => {
  const f = stubFetch(() => ({ ok: false, status: 404, headers: { get: () => null } }));
  try {
    assert.equal(await _fetchImage('https://example.test/missing.png', null, undefined), null);
  } finally { f.restore(); }
});

test('data:-URI laeuft weiter ohne Netz (Fassungs-Export)', async () => {
  const f = stubFetch(() => { throw new Error('darf nicht fetchen'); });
  try {
    const out = await _fetchImage(`data:image/png;base64,${PNG_1x1.toString('base64')}`, null, undefined);
    assert.equal(out.width, 4);
    assert.equal(f.calls.length, 0);
  } finally { f.restore(); }
});

test('geblockte URL wird im imageCache als null gemerkt (kein Zweitversuch)', async () => {
  const cache = new Map();
  const f = stubFetch(() => okResponse(PNG_1x1));
  try {
    await _fetchImage('http://10.1.2.3/x.png', null, cache);
    assert.equal(cache.get('http://10.1.2.3/x.png'), null);
    await _fetchImage('http://10.1.2.3/x.png', null, cache);
    assert.equal(f.calls.length, 0);
  } finally { f.restore(); }
});
