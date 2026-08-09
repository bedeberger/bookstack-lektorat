// Builder-Tests gegen synthetische {scope, book, chapter?, page?, groups}-
// Fixtures. PDF: %PDF-Header. EPUB/DOCX: ZIP-Magic + Manifest-Entry. HTML:
// Wohlgeformtheit. TXT/MD: Normalisierung.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import JSZip from 'jszip';

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

// ── Tabellen ────────────────────────────────────────────────────────────────
// Der Walker (lib/pdf-render/html-walker.js) ist GETEILT: PDF, DOCX, Markdown
// und Substack lesen dieselbe Blockliste. Ein neuer Blocktyp faellt in ihrem
// `default` und verschwindet lautlos — darum fahren alle Wege hier gegen
// dieselbe Zusage: DER INHALT DER ZELLEN KOMMT AN. TXT geht bewusst nicht durch
// den Walker (parserfrei) und ist trotzdem mit dabei, weil die Zusage dieselbe
// ist.

const TABLE_HTML = '<table>'
  + '<caption>Umsatz nach Jahr</caption>'
  + '<thead><tr><th scope="col">Jahr</th><th scope="col" data-align="right">Umsatz</th></tr></thead>'
  + '<tbody><tr><td>2023</td><td data-align="right">1.2 Mio</td></tr>'
  + '<tr><td>2024</td><td data-align="right">1.8 Mio</td></tr></tbody></table>';

const tableBundle = {
  scope: 'page', book, chapter,
  page: { id: 9, name: 'Tabellenseite', html: `<p>davor</p>${TABLE_HTML}<p>danach</p>` },
  groups: [{ chapterId: 10, chapter, pages: [
    { p: { id: 9, name: 'Tabellenseite' }, pd: { html: `<p>davor</p>${TABLE_HTML}<p>danach</p>` } },
  ] }],
};

// Jede Zelle, die Beschriftung und der Text drumherum — pro Ausgabeweg.
const TABLE_BITS = ['Jahr', 'Umsatz', '2023', '1.2 Mio', '2024', '1.8 Mio', 'Umsatz nach Jahr', 'davor', 'danach'];

test('txt: Tabelle wird zum Zeilenraster, kein Zellensalat', async () => {
  const s = (await buildTxt(tableBundle)).toString('utf8');
  for (const bit of TABLE_BITS) assert.ok(s.includes(bit), `fehlt in txt: ${bit}`);
  assert.ok(s.includes('Jahr | Umsatz'), 'Kopfzeile muss als eine Zeile erkennbar sein');
  assert.ok(s.includes('2023 | 1.2 Mio'), 'Datenzeile muss als eine Zeile erkennbar sein');
  assert.ok(!/2023 1\.2 Mio 2024/.test(s), 'Zellen duerfen nicht zu einer Textwurst zusammenlaufen');
});

test('md: GFM-Pipe-Tabelle mit Ausrichtungszeile', async () => {
  const s = (await buildMd(tableBundle)).toString('utf8');
  for (const bit of TABLE_BITS) assert.ok(s.includes(bit), `fehlt in md: ${bit}`);
  assert.ok(s.includes('| Jahr | Umsatz |'), 'Kopfzeile als Pipe-Zeile');
  assert.ok(/\|\s*---\s*\|\s*---:\s*\|/.test(s), 'Trennzeile muss die rechte Ausrichtung tragen');
  assert.ok(s.includes('*Umsatz nach Jahr*'), 'Beschriftung als kursive Zeile');
});

test('md: Tabelle ohne Kopfzeile bekommt eine leere — sonst rendert GFM nichts', async () => {
  const html = '<table><tbody><tr><td>a</td><td>b</td></tr></tbody></table>';
  const b = { scope: 'page', book, chapter, page: { id: 1, name: 'p', html },
    groups: [{ chapterId: 10, chapter, pages: [{ p: { id: 1, name: 'p' }, pd: { html } }] }] };
  const s = (await buildMd(b)).toString('utf8');
  assert.ok(/\|\s*---\s*\|\s*---\s*\|/.test(s), 'Trennzeile ist in GFM Pflicht');
  assert.ok(s.includes('| a | b |'));
  assert.ok(!/\|\s*a\s*\|\s*b\s*\|\s*\n\s*\|\s*---/.test(s), 'die Datenzeile darf nicht zur Kopfzeile werden');
});

test('md: Pipe in einer Zelle wird escaped', async () => {
  const html = '<table><tbody><tr><td>1.2 | Mio</td></tr></tbody></table>';
  const b = { scope: 'page', book, chapter, page: { id: 1, name: 'p', html },
    groups: [{ chapterId: 10, chapter, pages: [{ p: { id: 1, name: 'p' }, pd: { html } }] }] };
  const s = (await buildMd(b)).toString('utf8');
  assert.ok(s.includes('1.2 \\| Mio'), 'ein rohes | beendet dort die Spalte');
});

test('html: Tabelle bleibt Tabelle, Ausrichtung ueberlebt', async () => {
  const s = (await buildHtml(tableBundle)).toString('utf8');
  for (const bit of TABLE_BITS) assert.ok(s.includes(bit), `fehlt in html: ${bit}`);
  assert.ok(s.includes('<table'), 'kein Fliesstext-Fallback');
  assert.ok(s.includes('data-align="right"'), 'Ausrichtung ist Teil des Markups');
  assert.ok(/\[data-align="right"\]\s*\{\s*text-align:\s*right/.test(s), 'das Stylesheet muss data-align aufloesen');
  assert.ok(s.includes('<caption>'), 'Beschriftung bleibt caption');
});

test('substack: Tabelle als HTML-Tabelle, Beschriftung als Absatz', async () => {
  const s = (await buildSubstack(tableBundle)).toString('utf8');
  for (const bit of TABLE_BITS) assert.ok(s.includes(bit), `fehlt in substack: ${bit}`);
  assert.ok(s.includes('<table>'));
  assert.ok(s.includes('<th>Jahr</th>'));
  assert.ok(s.includes('<em>Umsatz nach Jahr</em>'), 'caption ueberlebt den Substack-Import nicht — darum Absatz');
});

test('epub: Tabelle im XHTML plus Stylesheet-Regeln', async () => {
  const buf = await buildEpub(tableBundle);
  const zip = await JSZip.loadAsync(buf);
  const files = Object.keys(zip.files);
  const xhtml = (await Promise.all(files.filter(f => f.endsWith('.xhtml'))
    .map(f => zip.file(f).async('string')))).join('\n');
  for (const bit of TABLE_BITS) assert.ok(xhtml.includes(bit), `fehlt im epub: ${bit}`);
  assert.ok(/<table/i.test(xhtml));
  // Die Ausrichtung MUSS als Klasse ankommen: epub-gen-memory filtert jedes
  // Attribut gegen eine feste Allowlist, in der data-* nicht steht — ein
  // `[data-align]`-Selektor im Stylesheet greift dort nie (siehe
  // epub.js#_applyDataClasses).
  assert.ok(/class="[^"]*\bta-right\b/.test(xhtml), 'data-align muss auf eine Klasse abgebildet werden');
  const css = (await Promise.all(files.filter(f => f.endsWith('.css'))
    .map(f => zip.file(f).async('string')))).join('\n');
  assert.ok(/\.ta-right\s*\{\s*text-align:\s*right/.test(css), 'und das Stylesheet muss diese Klasse kennen');
  assert.ok(!/\[data-align/.test(css), 'ein data-align-Selektor waere im EPUB toter Code');
  assert.ok(/text-indent:\s*0/.test(css), 'der Erstzeilen-Einzug des Profils darf nicht in die Zelle schlagen');
});

test('epub: das belegte Blockzitat traegt seine Klasse — data-src allein greift nicht', async () => {
  const html = '<blockquote data-src="7"><p>Zitat.</p></blockquote>';
  const b = { scope: 'page', book, chapter, page: { id: 1, name: 'p', html },
    groups: [{ chapterId: 10, chapter, pages: [{ p: { id: 1, name: 'p' }, pd: { html } }] }] };
  const zip = await JSZip.loadAsync(await buildEpub(b));
  const xhtml = (await Promise.all(Object.keys(zip.files).filter(f => f.endsWith('.xhtml'))
    .map(f => zip.file(f).async('string')))).join('\n');
  assert.ok(/<blockquote class="[^"]*\bcited-quote\b/.test(xhtml));
  const css = (await Promise.all(Object.keys(zip.files).filter(f => f.endsWith('.css'))
    .map(f => zip.file(f).async('string')))).join('\n');
  assert.ok(!/blockquote\[data-src\]/.test(css), 'der Attribut-Selektor war im EPUB wirkungslos');
});

test('docx: Zellinhalt landet im Dokument', async () => {
  const buf = await buildDocx(tableBundle);
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file('word/document.xml').async('string');
  for (const bit of TABLE_BITS) assert.ok(xml.includes(bit), `fehlt im docx: ${bit}`);
  assert.ok(xml.includes('<w:tbl>'), 'Word braucht eine echte Tabelle, keinen Fliesstext');
  assert.ok(xml.includes('<w:tblHeader/>'), 'die Kopfzeile muss sich nach Seitenumbruch wiederholen');
});
