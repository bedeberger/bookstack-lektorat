// Serverseitiges Lesen einer Webseite (lib/url-scrape.js) + die Uebernahme-Regel
// des Scrape-Wegs (routes/research-scrape.js#composeBody).
//
// Getestet wird hier das, was ohne Netz pruefbar ist: die Extraktion aus einem
// Dokument (reine Funktion) und die Deckel/Guards des Holens (gestubbter fetch).
// Die Verdrahtung von Knopf bis Route deckt tests/e2e-app/recherche-scrape.spec.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.SSRF_SKIP_DNS_CHECK = '1';
const { extractFromHtml, fetchDocument, MAX_BYTES } = require('../../lib/url-scrape.js');
const { composeBody } = require('../../routes/research-scrape.js');

const ARTICLE = `<!doctype html><html lang="de-CH"><head>
  <title>Fallback im title-Tag</title>
  <meta property="og:title" content="Die Prozessakten von 1892">
  <meta name="description" content="Ein Fund im Landesarchiv wirft neues Licht auf den Fall.">
  <meta property="og:site_name" content="Beispielzeitung">
  <link rel="canonical" href="/artikel/prozessakten-1892">
</head><body>
  <nav><a href="/">Startseite</a><a href="/impressum">Impressum</a></nav>
  <header><h1>Beispielzeitung</h1></header>
  <main><article>
    <h1>Die Prozessakten von 1892</h1>
    <p>Im Keller lagen sie <strong>über hundert Jahre</strong>.</p>
    <p>Ein zweiter Absatz mit genug Text, damit dieser Kandidat gegen alles andere im Dokument gewinnt.</p>
    <ul><li>Erster Punkt</li><li>Zweiter Punkt</li></ul>
    <script>window.tracker = 'darf nicht in den Text';</script>
  </article></main>
  <aside>Newsletter abonnieren</aside>
  <footer>© Beispielzeitung, alle Rechte vorbehalten.</footer>
</body></html>`;

test('extractFromHtml: og:title schlaegt <title>, Beschreibung aus meta', () => {
  const r = extractFromHtml(ARTICLE, 'https://zeitung.example.org/a');
  assert.equal(r.title, 'Die Prozessakten von 1892');
  assert.equal(r.description, 'Ein Fund im Landesarchiv wirft neues Licht auf den Fall.');
  assert.equal(r.siteName, 'Beispielzeitung');
  assert.equal(r.lang, 'de-CH');
  assert.equal(r.canonicalUrl, 'https://zeitung.example.org/artikel/prozessakten-1892');
});

test('extractFromHtml: Navigation, Rechtstext und Skript zaehlen nicht als Seiteninhalt', () => {
  // Sonst stehen sie in JEDEM Fundstueck derselben Website wortgleich drin und
  // erzeugen im Semantik-Index Aehnlichkeit zwischen unverwandten Funden.
  const { text } = extractFromHtml(ARTICLE);
  for (const fremd of ['Impressum', 'Startseite', 'Newsletter', 'Rechte vorbehalten', 'window.tracker']) {
    assert.ok(!text.includes(fremd), `"${fremd}" darf nicht im Text stehen`);
  }
  assert.ok(text.includes('Im Keller lagen sie über hundert Jahre.'));
});

test('extractFromHtml: Absatz mit Leerzeile, Listenzeile ohne', () => {
  const { text } = extractFromHtml(ARTICLE);
  assert.ok(text.includes('Jahre.\n\nEin zweiter Absatz'), text);
  assert.ok(text.includes('Erster Punkt\nZweiter Punkt'), text);
  assert.ok(!/\n{3}/.test(text), 'keine Dreifach-Umbrueche');
});

test('extractFromHtml: leere Layout-Huelle verliert gegen den echten Artikel', () => {
  // Viele Seiten fuehren ein <main> als Huelle um den <article>. Gewinnen muss
  // der laengste Text, nicht der erste Treffer der Kandidatenliste.
  const html = `<html><body><main><p>Werbung</p><article>
    <p>${'Der eigentliche Artikeltext steht hier und ist deutlich laenger. '.repeat(6)}</p>
  </article></main></body></html>`;
  const { text } = extractFromHtml(html);
  assert.ok(text.startsWith('Der eigentliche Artikeltext'), text.slice(0, 80));
});

test('extractFromHtml: ohne Kandidat greift der Body', () => {
  const html = '<html><body><p>Nur ein Absatz ohne article oder main.</p></body></html>';
  assert.equal(extractFromHtml(html).text, 'Nur ein Absatz ohne article oder main.');
});

test('extractFromHtml: h1 als letzter Titel-Rueckfall', () => {
  const html = '<html><body><h1>  Titel   aus   der   Ueberschrift </h1></body></html>';
  assert.equal(extractFromHtml(html).title, 'Titel aus der Ueberschrift');
});

// ── composeBody: Beschreibung + Haupttext zu EINEM Feldwert ──────────────────

test('composeBody: Beschreibung fuehrt, wenn sie etwas beitraegt', () => {
  assert.equal(composeBody('Der Anriss.', 'Ein ganz anderer Volltext.'),
    'Der Anriss.\n\nEin ganz anderer Volltext.');
});

test('composeBody: og:description, die schon der erste Satz ist, faellt weg', () => {
  // Auf vielen Seiten IST og:description der Artikelanfang, nur anders
  // interpunktiert — er darf nicht zweimal im Fundstueck stehen.
  const text = 'Im Keller lagen sie über hundert Jahre — und niemand sah hinein.';
  assert.equal(composeBody('Im Keller lagen sie über hundert Jahre', text), text);
});

test('composeBody: nur eines von beiden vorhanden', () => {
  assert.equal(composeBody('', 'nur Text'), 'nur Text');
  assert.equal(composeBody('nur Beschreibung', ''), 'nur Beschreibung');
  assert.equal(composeBody('', ''), '');
});

// ── fetchDocument: Guards des Holens ─────────────────────────────────────────

function stubFetch(handler) {
  const orig = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = orig; };
}

function htmlResponse(body, headers = {}) {
  const h = new Map(Object.entries({ 'content-type': 'text/html; charset=utf-8', ...headers }));
  return {
    ok: true, status: 200,
    headers: { get: (k) => h.get(k.toLowerCase()) ?? null },
    arrayBuffer: async () => Buffer.from(body, 'utf8'),
  };
}

test('fetchDocument: private Zieladresse wird nicht abgerufen', async () => {
  let called = false;
  const restore = stubFetch(async () => { called = true; return htmlResponse('<p>x</p>'); });
  try {
    await assert.rejects(fetchDocument('http://127.0.0.1:3737/admin'),
      (e) => e.code === 'SSRF_BLOCKED_HOST');
    assert.equal(called, false, 'der Request darf gar nicht rausgehen');
  } finally { restore(); }
});

test('fetchDocument: JEDER Redirect-Hop wird geprueft', async () => {
  // Ein oeffentlicher Host, der auf 127.0.0.1 umleitet, ist genau der Weg, den
  // ein Einmal-Check am Anfang durchlaesst.
  const seen = [];
  const restore = stubFetch(async (url) => {
    seen.push(url);
    if (seen.length === 1) {
      return { ok: false, status: 302, headers: { get: (k) => (k.toLowerCase() === 'location' ? 'http://169.254.169.254/latest/meta-data' : null) } };
    }
    return htmlResponse('<p>geheim</p>');
  });
  try {
    await assert.rejects(fetchDocument('https://harmlos.example.org/a'),
      (e) => e.code === 'SSRF_BLOCKED_HOST');
    assert.equal(seen.length, 1, 'nach dem geblockten Hop darf kein Request folgen');
  } finally { restore(); }
});

test('fetchDocument: Nicht-HTML wird abgelehnt', async () => {
  const restore = stubFetch(async () => htmlResponse('%PDF-1.7', { 'content-type': 'application/pdf' }));
  try {
    await assert.rejects(fetchDocument('https://x.example.org/a.pdf'),
      (e) => e.code === 'SCRAPE_NOT_HTML');
  } finally { restore(); }
});

test('fetchDocument: angekuendigte Ueberlaenge bricht vor dem Lesen ab', async () => {
  const restore = stubFetch(async () => htmlResponse('<p>x</p>', { 'content-length': String(MAX_BYTES + 1) }));
  try {
    await assert.rejects(fetchDocument('https://x.example.org/a'),
      (e) => e.code === 'SCRAPE_TOO_LARGE');
  } finally { restore(); }
});

test('fetchDocument: HTTP-Fehler des Ziels ist kein Serverfehler', async () => {
  const restore = stubFetch(async () => ({ ok: false, status: 404, headers: { get: () => null } }));
  try {
    await assert.rejects(fetchDocument('https://x.example.org/weg'),
      (e) => e.code === 'SCRAPE_HTTP_ERROR' && e.status === 404);
  } finally { restore(); }
});

test('fetchDocument: latin1-Seite wird nicht zu Fragezeichen', async () => {
  const restore = stubFetch(async () => ({
    ok: true, status: 200,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'text/html; charset=iso-8859-1' : null) },
    arrayBuffer: async () => Buffer.from('<p>Gr\xfcezi</p>', 'latin1'),
  }));
  try {
    const { html } = await fetchDocument('https://x.example.org/a');
    assert.ok(html.includes('Grüezi'), html);
  } finally { restore(); }
});
