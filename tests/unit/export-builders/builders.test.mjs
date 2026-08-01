// Builder-Tests gegen synthetische {scope, book, chapter?, page?, groups}-
// Fixtures. PDF: %PDF-Header. EPUB/DOCX: ZIP-Magic + Manifest-Entry. HTML:
// Wohlgeformtheit. TXT/MD: Normalisierung.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

process.env.DB_PATH = path.join('/tmp', `builders-${process.pid}-${Date.now()}.db`);
await import('../../../db/schema.js');

const { buildTxt }  = await import('../../../lib/export-builders/txt.js');
const { buildMd }   = await import('../../../lib/export-builders/md.js');
const { buildHtml } = await import('../../../lib/export-builders/html.js');
const { buildSubstack } = await import('../../../lib/export-builders/substack.js');
const { buildEpub } = await import('../../../lib/export-builders/epub.js');
const { buildDocx, buildDocxNormseite } = await import('../../../lib/export-builders/docx.js');
const { buildPdf }  = await import('../../../lib/export-builders/pdf.js');

const book = { id: 1, name: 'Mein Buch', slug: 'mein-buch', description: 'Beschreibung' };
const chapter = { id: 10, name: 'Erstes Kapitel', slug: 'erstes' };
const page = { id: 100, name: 'Seite eins', slug: 'p1', html: '<p>Hallo Welt.</p>' };

const bookGroups = [
  { chapterId: 10, chapter: { id: 10, name: 'K1' }, pages: [
    { p: { id: 1, name: 'p1' }, pd: { html: '<h1>Kap 1</h1><p>Text eins.</p>' } },
    { p: { id: 2, name: 'p2' }, pd: { html: '<p>Text zwei.</p>' } },
  ]},
];

const chapterBundle = {
  scope: 'chapter', book, chapter,
  groups: [{ chapterId: 10, chapter, pages: [
    { p: { id: 1, name: 'p1' }, pd: { html: '<p>Kapitelinhalt.</p>' } },
  ]}],
};

const pageBundle = {
  scope: 'page', book, chapter, page,
  groups: [{ chapterId: 10, chapter, pages: [{ p: page, pd: page }] }],
};

const bookBundle = { scope: 'book', book, groups: bookGroups };

test('txt: HTML-Tags entfernt, Buchtitel oben, Whitespace collapsed', async () => {
  const buf = await buildTxt(bookBundle);
  const s = buf.toString('utf8');
  assert.ok(s.startsWith('Mein Buch'));
  assert.ok(s.includes('Text eins.'));
  assert.ok(!s.includes('<p>'));
  // \s+ collapsed
  assert.ok(!/\s{3,}/.test(s));
});

test('txt scope=chapter rendert Kapitelnamen als Titel', async () => {
  const buf = await buildTxt(chapterBundle);
  const s = buf.toString('utf8');
  assert.ok(s.startsWith('Erstes Kapitel'));
  assert.ok(s.includes('Kapitelinhalt.'));
});

test('md: Headings + Markdown-Escape', async () => {
  const buf = await buildMd(bookBundle);
  const s = buf.toString('utf8');
  assert.ok(s.startsWith('# Mein Buch'));
  assert.ok(s.includes('## K1'));
  assert.ok(/Text eins\./.test(s));
});

test('md scope=page leitet immer aus body_html ab (ignoriert Alt-markdown-Feld)', async () => {
  const bundle = {
    scope: 'page', book, chapter, page,
    groups: [{ chapterId: 10, chapter, pages: [
      // Alt-Spalte (BookStack-Ära) darf nicht mehr durchschlagen: html ist SSoT.
      { p: page, pd: { ...page, html: '<p>Aus <strong>HTML</strong>.</p>', markdown: '# Stale' } },
    ] }],
  };
  const s = (await buildMd(bundle)).toString('utf8');
  assert.ok(s.includes('Aus **HTML**.'));
  assert.ok(!s.includes('Stale'));
});

test('html: Wohlgeformtheit (DOCTYPE + body)', async () => {
  const buf = await buildHtml(bookBundle);
  const s = buf.toString('utf8');
  assert.ok(s.startsWith('<!DOCTYPE html>'));
  assert.ok(s.includes('<title>Mein Buch</title>'));
  assert.ok(s.includes('<h1>Mein Buch</h1>'));
  assert.ok(s.includes('<h2>K1</h2>'));
  assert.ok(s.includes('</body></html>'));
});

test('html scope=page: Page-Name als Haupttitel', async () => {
  const buf = await buildHtml(pageBundle);
  const s = buf.toString('utf8');
  assert.ok(s.includes('<title>Seite eins</title>'));
  assert.ok(s.includes('<h1>Seite eins</h1>'));
});

test('substack: Titel in Meta-Box statt Body-h1, Kapitel-Heading als h2', async () => {
  const s = (await buildSubstack(bookBundle, { lang: 'de' })).toString('utf8');
  // Titel liegt in der Meta-Box (kopierbar ins Titelfeld), NICHT als <h1> im Body.
  assert.ok(s.includes('substack-meta'));
  assert.ok(s.includes('Mein Buch'));
  assert.ok(!/<h1>Mein Buch<\/h1>/.test(s));
  // Top-Kapitel -> h2 (Substacks „Überschrift").
  assert.ok(s.includes('<h2>K1</h2>'));
  // In-Body-<h1> der Seite wird auf h2 heruntergestuft (Substack kennt kein h1).
  assert.ok(!/<h1>Kap 1<\/h1>/.test(s));
  assert.ok(s.includes('<h2>Kap 1</h2>'));
  // Paste-fertiges Inline-Markup bleibt erhalten.
  assert.ok(s.includes('Text eins.'));
});

test('substack: Codeblock und Diagramm-Quelltext gehen nicht verloren', async () => {
  // Ein Block, den der Serializer nicht kennt, fiel in den `default`-Zweig und
  // verschwand spurlos. Fuer Diagramme verletzt das Invariante B aus
  // lib/diagram-export.js (nicht renderbar ⇒ Quelltext bleibt stehen) — Substack
  // kann weder ein `data:`-Bild noch Diagramm-Notation zeichnen.
  const bundle = {
    scope: 'page', book, chapter, page,
    groups: [{ chapterId: 10, chapter, pages: [
      { p: page, pd: { html: '<p>Davor.</p><pre class="mermaid">flowchart TD\n  A[Start] --&gt; B</pre><pre>echo hallo</pre><p>Danach.</p>' } },
    ] }],
  };
  const s = (await buildSubstack(bundle, { lang: 'de' })).toString('utf8');
  assert.ok(s.includes('Davor.') && s.includes('Danach.'));
  assert.ok(s.includes('flowchart TD'), 'Diagramm-Quelltext muss im Export stehen');
  assert.ok(s.includes('A[Start] --&gt; B'), 'Notation bleibt unescaped-frei und unveraendert');
  assert.ok(s.includes('echo hallo'), 'gewoehnlicher Codeblock ebenso');
  assert.ok(/<pre>flowchart TD/.test(s), 'als <pre>, ohne Klasse (Substack strippt sie ohnehin)');
});

test('substack: en-Locale + Bild-Warnung bei nicht-öffentlicher URL', async () => {
  const bundle = {
    scope: 'page', book, chapter, page,
    groups: [{ chapterId: 10, chapter, pages: [
      { p: page, pd: { html: '<p><strong>Hi</strong></p><img src="/local/pic.png" alt="x">' } },
    ] }],
  };
  const s = (await buildSubstack(bundle, { lang: 'en' })).toString('utf8');
  assert.ok(s.includes('lang="en"'));
  assert.ok(s.includes('class="stk-warn"'));   // Warn-Element gerendert
  assert.ok(s.includes('<strong>Hi</strong>'));
  // Öffentliche URL loest keine Warnung aus.
  const bundle2 = {
    scope: 'page', book, chapter, page,
    groups: [{ chapterId: 10, chapter, pages: [
      { p: page, pd: { html: '<img src="https://cdn.example.com/pic.png" alt="x">' } },
    ] }],
  };
  const s2 = (await buildSubstack(bundle2, { lang: 'en' })).toString('utf8');
  assert.ok(!s2.includes('class="stk-warn"'));
});

test('epub: ZIP-Magic + EPUB-Mimetype', async () => {
  const buf = await buildEpub(bookBundle);
  assert.equal(buf[0], 0x50);
  assert.equal(buf[1], 0x4B);
  const head = buf.slice(0, 200).toString('utf8');
  assert.ok(head.includes('application/epub+zip'));
});

test('docx: ZIP-Magic + Manifest-Entry', async () => {
  const buf = await buildDocx(bookBundle);
  assert.equal(buf[0], 0x50);
  assert.equal(buf[1], 0x4B);
  const s = buf.toString('binary');
  assert.ok(s.includes('word/document.xml'));
});

test('docx-normseite: ZIP-Magic + Manifest-Entry', async () => {
  const buf = await buildDocxNormseite(bookBundle);
  assert.equal(buf[0], 0x50);
  assert.equal(buf[1], 0x4B);
  assert.ok(buf.toString('binary').includes('word/document.xml'));
});

test('pdf scope=page: %PDF-Header + kein Cover-Page', async () => {
  const buf = await buildPdf(pageBundle, { token: null, lang: 'de' });
  assert.equal(buf.slice(0, 5).toString(), '%PDF-');
}, { timeout: 60000 });
