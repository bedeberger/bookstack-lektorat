import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hubspotToAppHtml, appToHubspotHtml } from '../../lib/hubspot-html.js';

test('hubspotToAppHtml strips images, scripts, iframes', () => {
  const input = `
    <p>Vor Bild</p>
    <img src="https://x.com/foo.png" alt="x">
    <script>alert(1)</script>
    <iframe src="https://e.com"></iframe>
    <p>Nach Bild</p>
  `;
  const out = hubspotToAppHtml(input);
  assert.match(out, /<p>Vor Bild<\/p>/);
  assert.match(out, /<p>Nach Bild<\/p>/);
  assert.doesNotMatch(out, /<img/);
  assert.doesNotMatch(out, /<script/);
  assert.doesNotMatch(out, /<iframe/);
});

test('hubspotToAppHtml maps h1/h4-h6 to h2/h3, keeps h2/h3', () => {
  const out = hubspotToAppHtml('<h1>A</h1><h2>B</h2><h3>C</h3><h4>D</h4><h5>E</h5><h6>F</h6>');
  assert.match(out, /<h2>A<\/h2>/);
  assert.match(out, /<h2>B<\/h2>/);
  assert.match(out, /<h3>C<\/h3>/);
  assert.match(out, /<h3>D<\/h3>/);
  assert.match(out, /<h3>E<\/h3>/);
  assert.match(out, /<h3>F<\/h3>/);
});

test('hubspotToAppHtml strips Jinja markers', () => {
  const out = hubspotToAppHtml('<p>Hi {{ name }} und {# note #}!</p>');
  assert.match(out, /<p>Hi/);
  assert.doesNotMatch(out, /\{\{/);
  assert.doesNotMatch(out, /\{#/);
});

test('hubspotToAppHtml unwraps unknown tags but keeps text', () => {
  const out = hubspotToAppHtml('<section><p>Inner</p></section>');
  assert.match(out, /<p>Inner<\/p>/);
});

test('hubspotToAppHtml drops relative/javascript links but keeps inner text', () => {
  const out = hubspotToAppHtml('<p><a href="/rel">rel</a> <a href="javascript:alert(1)">js</a> <a href="https://x.com">ok</a></p>');
  assert.match(out, /rel/);
  assert.match(out, /js/);
  assert.match(out, /<a href="https:\/\/x\.com">ok<\/a>/);
  assert.doesNotMatch(out, /href="\/rel"/);
  assert.doesNotMatch(out, /href="javascript:/);
});

test('hubspotToAppHtml wraps plain text in single <p>', () => {
  const out = hubspotToAppHtml('Plain  text   no   tags');
  assert.equal(out, '<p>Plain text no tags</p>');
});

test('hubspotToAppHtml escapes HTML entities in text content', () => {
  const out = hubspotToAppHtml('<p>5 < 6 & 7 > 4</p>');
  assert.match(out, /5 &lt; 6 &amp; 7 &gt; 4/);
});

test('appToHubspotHtml is defensive — also strips images', () => {
  const out = appToHubspotHtml('<p>x</p><img src="https://x/y.png"><p>y</p>');
  assert.doesNotMatch(out, /<img/);
  assert.match(out, /<p>x<\/p>/);
  assert.match(out, /<p>y<\/p>/);
});

test('hubspotToAppHtml empty/null input returns empty string', () => {
  assert.equal(hubspotToAppHtml(''), '');
  assert.equal(hubspotToAppHtml(null), '');
  assert.equal(hubspotToAppHtml(undefined), '');
});

test('hubspotToAppHtml preserves ul/ol/li structure', () => {
  const out = hubspotToAppHtml('<ul><li>A</li><li>B</li></ul>');
  assert.match(out, /<ul><li>A<\/li><li>B<\/li><\/ul>/);
});

test('hubspotToAppHtml strips CMS-Wrapper classes', () => {
  const out = hubspotToAppHtml('<div class="hs-cta-wrapper">CTA</div><p>real</p>');
  assert.doesNotMatch(out, /CTA/);
  assert.match(out, /<p>real<\/p>/);
});

test('hubspotToAppHtml preserves <hr>', () => {
  const out = hubspotToAppHtml('<p>A</p><hr><p>B</p>');
  assert.match(out, /<p>A<\/p><hr><p>B<\/p>/);
});

test('hubspotToAppHtml preserves <pre> incl. whitespace + escapes inner', () => {
  const out = hubspotToAppHtml('<pre>line 1\n  line 2 < & ></pre>');
  assert.match(out, /<pre>line 1\n  line 2 &lt; &amp; &gt;<\/pre>/);
});

test('hubspotToAppHtml converts font-weight:bold style to <strong>', () => {
  const out = hubspotToAppHtml('<p style="font-weight: bold">Fett</p>');
  assert.match(out, /<p><strong>Fett<\/strong><\/p>/);
});

test('hubspotToAppHtml converts numeric font-weight >=600 to <strong>', () => {
  const out = hubspotToAppHtml('<p style="font-weight:700">Sieben</p><p style="font-weight: 500">Fünf</p>');
  assert.match(out, /<p><strong>Sieben<\/strong><\/p>/);
  assert.match(out, /<p>Fünf<\/p>/);
  assert.doesNotMatch(out, /<strong>Fünf/);
});

test('hubspotToAppHtml converts bold span (unknown tag) to <strong>', () => {
  const out = hubspotToAppHtml('<p>vor <span style="font-weight:bold">fett</span> nach</p>');
  assert.match(out, /<p>vor <strong>fett<\/strong> nach<\/p>/);
});

test('hubspotToAppHtml: bold on <strong> stays single <strong>', () => {
  const out = hubspotToAppHtml('<p><strong style="font-weight:bold">x</strong></p>');
  assert.match(out, /<p><strong>x<\/strong><\/p>/);
  assert.doesNotMatch(out, /<strong><strong>/);
});

test('appToHubspotHtml round-trips hr + pre from editor', () => {
  const out = appToHubspotHtml('<p>x</p><hr><pre>code\n  indent</pre><p>y</p>');
  assert.match(out, /<p>x<\/p>/);
  assert.match(out, /<hr>/);
  assert.match(out, /<pre>code\n  indent<\/pre>/);
  assert.match(out, /<p>y<\/p>/);
});

// ── Quellenangaben + Verzeichnis (Push-only) ────────────────────────────────
//
// HubSpot ist Push-only (kein Pull, kein Update-vom-Remote — docs/hubspot-sync.md).
// Darum braucht das angehaengte Verzeichnis KEINEN Marker: es kann nichts
// zurueckwandern und damit nichts akkumulieren. Der Chip selbst ueberlebt die
// Allowlist nicht (`span` steht in keiner Map) und wird zu Klartext — genau
// richtig, ein Verweis auf `sources.id` waere im HubSpot-Post ohnehin toter Ballast.

const { buildCiteHtml } = await import('../../public/js/sources/cite-html.js');
const { bibliographySectionHtml } = await import('../../lib/bibliography.js');

const HUB_BIB = {
  enabled: true, inBlog: true, style: 'apa7',
  title: 'Quellenverzeichnis', titleHtml: 'Quellenverzeichnis',
  entries: [
    { id: 1, num: 1, text: 'Kafka, F. (1915). Die Verwandlung.', html: 'Kafka, F. (1915). <em>Die Verwandlung</em>.' },
  ],
};

test('appToHubspotHtml: Quellen-Chip wird zu Klartext, Zeiger fliegt raus', () => {
  const chip = buildCiteHtml({ id: 7, loc: '44', text: '(Kafka, 1915, S. 44)' });
  const out = appToHubspotHtml(`<p>Ein Satz ${chip} mit Beleg.</p>`);
  assert.match(out, /<p>Ein Satz \(Kafka, 1915, S\. 44\) mit Beleg\.<\/p>/);
  assert.doesNotMatch(out, /<span/);
  assert.doesNotMatch(out, /data-src/);
  assert.doesNotMatch(out, /class=/);
});

test('appToHubspotHtml: angehaengtes Verzeichnis ueberlebt als h2 + Liste', () => {
  // So baut der Push-Job den Body: Seiten-HTML + Verzeichnis-Abschnitt, dann
  // einmal durch den Serializer (routes/jobs/hubspot-sync.js).
  const section = bibliographySectionHtml(HUB_BIB, { list: true });
  const out = appToHubspotHtml(`<p>Text.</p>${section}`);
  assert.match(out, /<p>Text\.<\/p>/);
  assert.match(out, /<h2>Quellenverzeichnis<\/h2>/);
  assert.match(out, /<li>Kafka, F\. \(1915\)\. <em>Die Verwandlung<\/em>\.<\/li>/);
  // Der Marker-<div> waere hier ohnehin sinnlos — die Allowlist entpackt ihn.
  assert.doesNotMatch(out, /<div/);
  assert.ok(out.indexOf('Text.') < out.indexOf('Quellenverzeichnis'));
});

test('bibliographySectionHtml: numerischer Stil bleibt bei Absaetzen mit [n]', () => {
  const numeric = { ...HUB_BIB, style: 'numeric', entries: [
    { id: 1, num: 1, text: 'A.', html: 'A.' },
    { id: 2, num: 2, text: 'B.', html: 'B.' },
  ] };
  const out = appToHubspotHtml(`<p>x</p>${bibliographySectionHtml(numeric, { list: true })}`);
  assert.doesNotMatch(out, /<ul>/);
  assert.match(out, /<p>\[1\] A\.<\/p>/);
  assert.match(out, /<p>\[2\] B\.<\/p>/);
});

test('bibliographySectionHtml: leer, wenn abgeschaltet oder ohne Eintraege', () => {
  assert.equal(bibliographySectionHtml(null), '');
  assert.equal(bibliographySectionHtml({ ...HUB_BIB, enabled: false }), '');
  assert.equal(bibliographySectionHtml({ ...HUB_BIB, entries: [] }), '');
});

test('bibliographySectionHtml: Marker-Wrapper nur auf Verlangen', () => {
  assert.doesNotMatch(bibliographySectionHtml(HUB_BIB), /sw-bibliography/);
  assert.match(bibliographySectionHtml(HUB_BIB, { marker: true }), /^<div class="sw-bibliography">/);
});

test('bibliographySectionHtml: Titel ist escapet (User-Eingabe in HTML-Senke)', () => {
  const evil = { ...HUB_BIB, title: '<script>x</script>', titleHtml: '&lt;script&gt;x&lt;/script&gt;' };
  const out = bibliographySectionHtml(evil);
  assert.match(out, /<h2>&lt;script&gt;x&lt;\/script&gt;<\/h2>/);
  assert.doesNotMatch(out, /<script>/);
});
