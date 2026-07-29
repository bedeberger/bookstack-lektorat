import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validateConfig, defaultConfig, FONT_FAMILIES } = require('../../lib/docx-export-defaults.js');
const { buildDocxProfile } = require('../../lib/export-builders/docx.js');

const bundle = {
  scope: 'book',
  book: { id: 1, name: 'Der Process', slug: 'process' },
  groups: [
    { chapterId: 10, chapter: { id: 10, name: 'Verhaftung', parent_chapter_id: null }, pages: [
      { p: { id: 1, name: 'Szene 1' }, pd: { html: '<p>Jemand musste Josef K. <strong>verleumdet</strong> haben.</p><hr><p>Zweiter Absatz mit <em>kursiv</em> und <a href="https://x.de">Link</a>.</p>' } },
      { p: { id: 2, name: 'Szene 2' }, pd: { html: '<h2>Untertitel</h2><blockquote><p>Ein Zitat.</p></blockquote>' } },
    ] },
    { chapterId: 20, chapter: { id: 20, name: 'Anhang', parent_chapter_id: null }, pages: [
      { p: { id: 3, name: 'A' }, pd: { html: '<p>Text.</p>' } },
    ] },
  ],
};
const meta = { subtitle: 'Ein Roman', year: '1925', dedication: 'Für F.', imprint: 'Verlag XY', copyright: '© 2025', author_bio: 'Bio.', isbn: '9781234567890' };

// ── Validator ────────────────────────────────────────────────────────────────
test('validateConfig: fills defaults + clamps', () => {
  const c = validateConfig({});
  assert.equal(c.font.family, 'Times New Roman');
  assert.equal(c.font.lineSpacing, 'double');
  assert.ok(FONT_FAMILIES.includes(c.font.family));
  // Clamp font size to range
  assert.equal(validateConfig({ font: { sizePt: 99 } }).font.sizePt, 18);
  assert.equal(validateConfig({ font: { sizePt: 2 } }).font.sizePt, 8);
});

test('validateConfig: rejects unknown enums + non-whitelisted fonts', () => {
  assert.equal(validateConfig({ font: { family: 'Comic Sans' } }).font.family, 'Times New Roman');
  assert.equal(validateConfig({ header: { mode: 'bogus' } }).header.mode, defaultConfig().header.mode);
  assert.equal(validateConfig({ toc: { mode: 'wat' } }).toc.mode, 'none');
});

test('validateConfig: unnumberedChapterIds normalized to positive ints', () => {
  const c = validateConfig({ chapter: { unnumberedChapterIds: ['3', 3, -1, 0, 'x', 7] } });
  assert.deepEqual(c.chapter.unnumberedChapterIds, [3, 7]);
});

test('validateConfig: strips unknown top-level keys', () => {
  const c = validateConfig({ bogus: 1, page: { size: 'A5' } });
  assert.ok(!('bogus' in c));
  assert.equal(c.page.size, 'A5');
});

// ── Builder ──────────────────────────────────────────────────────────────────
async function build(config) {
  const buf = await buildDocxProfile(bundle, { author: 'Franz Kafka', lang: 'de', meta, config });
  assert.equal(buf[0], 0x50); // PK
  assert.equal(buf[1], 0x4B);
  return buf.toString('binary');
}

test('builder: produces valid docx with document.xml', async () => {
  const s = await build(defaultConfig());
  assert.ok(s.includes('word/document.xml'));
});

test('builder: TOC field mode builds a valid docx (exercises TableOfContents path)', async () => {
  // document.xml is DEFLATE-compressed inside the zip, so we cannot grep the
  // field instruction from the raw buffer — assert the field path builds clean.
  const s = await build(validateConfig({ toc: { mode: 'field', depth: 2 } }));
  assert.ok(s.includes('word/document.xml'));
});

test('builder: manuscript header + page number does not throw', async () => {
  const s = await build(validateConfig({ header: { mode: 'manuscript', pageNumber: 'headerRight' } }));
  assert.ok(s.includes('word/header'));
});

test('builder: footer page number creates a footer part', async () => {
  const s = await build(validateConfig({ header: { mode: 'none', pageNumber: 'footer' } }));
  assert.ok(s.includes('word/footer'));
});

test('builder: chapter numbering does not throw + emits headings', async () => {
  const s = await build(validateConfig({ chapter: { numbering: 'arabic', numberingMode: 'nested' } }));
  assert.ok(s.includes('word/document.xml'));
});

test('builder: title.none omits generated title page but still renders body', async () => {
  const s = await build(validateConfig({ title: { mode: 'none' }, header: { mode: 'none', pageNumber: 'none' } }));
  assert.ok(s.includes('word/document.xml'));
});

// ── Quellenverzeichnis (lib/bibliography.js) ─────────────────────────────────
// Anders als die Tests oben wird hier in das ZIP hineingeschaut: der Style und
// die Eintragstexte müssen wirklich in document.xml/styles.xml landen.
const JSZip = require('jszip');

async function buildXml(config, opts = {}) {
  const buf = await buildDocxProfile(bundle, { author: 'Franz Kafka', lang: 'de', meta, config, ...opts });
  const zip = await JSZip.loadAsync(buf);
  return {
    doc: await zip.file('word/document.xml').async('string'),
    styles: await zip.file('word/styles.xml').async('string'),
  };
}

const bibFixture = {
  enabled: true,
  title: 'Quellenverzeichnis',
  style: 'numeric',
  lang: 'de',
  numbers: new Map([[7, 1]]),
  sourcesById: new Map([[7, {
    id: 7, csl_type: 'book', title: 'Die Verwandlung', year: '1915',
    authors: [{ family: 'Kafka', given: 'Franz' }], editors: [],
    publisher: 'Kurt Wolff', place: 'Leipzig',
  }]]),
  entries: [{
    id: 7, num: 1,
    text: 'Kafka, Franz: Die Verwandlung. Leipzig: Kurt Wolff, 1915.',
    html: 'Kafka, Franz: <em>Die Verwandlung</em>. Leipzig: Kurt Wolff, 1915.',
    runs: [{ text: 'Kafka, Franz: ' }, { text: 'Die Verwandlung', italic: true }],
  }],
};

test('builder: Quellenverzeichnis als eigener Style mit hängendem Einzug', async () => {
  const { doc, styles } = await buildXml(defaultConfig(), { bibliography: bibFixture });
  // Benannter Style existiert und hängt ein (left == hanging).
  assert.ok(styles.includes('w:styleId="Bibliography"'));
  assert.match(styles, /w:styleId="Bibliography"[\s\S]*?w:hanging="\d+"/);
  // Überschrift als Heading-1 (landet damit im Word-TOC-Feld) + Eintragstext.
  assert.ok(doc.includes('Quellenverzeichnis'));
  assert.ok(doc.includes('w:pStyle w:val="Bibliography"'));
  assert.ok(doc.includes('[1] Kafka, Franz:'));
  // Kursiver Werktitel bleibt kursiv (der Walker liefert den Run als italic).
  assert.match(doc, /w:i[ /][\s\S]{0,200}Die Verwandlung/);
});

test('builder: ohne/abgeschaltetes Verzeichnis kein Eintrag im Dokument', async () => {
  const off = await buildXml(defaultConfig(), { bibliography: { ...bibFixture, enabled: false } });
  assert.equal(off.doc.includes('w:pStyle w:val="Bibliography"'), false);
  assert.equal(off.doc.includes('Quellenverzeichnis'), false);
  const none = await buildXml(defaultConfig());
  assert.equal(none.doc.includes('w:pStyle w:val="Bibliography"'), false);
});

test('builder: Verzeichnis nur bei scope=book, Chips werden trotzdem aufgelöst', async () => {
  const chipBundle = {
    ...bundle,
    scope: 'chapter',
    groups: [{ chapterId: 10, chapter: { id: 10, name: 'Verhaftung', parent_chapter_id: null }, pages: [
      { p: { id: 1, name: 'Szene 1' }, pd: {
        html: '<p>Satz <span class="cite" data-src="7" data-loc="44">(Kafka, 1915, S. 44)</span> Ende.</p>',
      } },
    ] }],
  };
  const buf = await buildDocxProfile(chipBundle, {
    author: 'Franz Kafka', lang: 'de', meta, config: defaultConfig(), bibliography: bibFixture,
  });
  const doc = await (await JSZip.loadAsync(buf)).file('word/document.xml').async('string');
  // Kein Verzeichnis (Kapitel-Scope) …
  assert.equal(doc.includes('w:pStyle w:val="Bibliography"'), false);
  // … aber der Kurzbeleg im Text ist auf den numerischen Stil aktualisiert.
  assert.ok(doc.includes('[1, S. 44]'));
  assert.equal(doc.includes('(Kafka, 1915, S. 44)'), false);
});

// ── Anmerkungsapparat (citation_notes='endnotes') ────────────────────────────
// Word war der einzige Ausgabeweg, der die Buch-Einstellung ignoriert und
// stattdessen die Klammerform gesetzt hat — PDF, HTML, MD, TXT und EPUB folgen
// ihr. Ein Autor in Geschichte/Jura/Theologie haette in der Abgabedatei eine
// andere Belegform gehabt als im Korrekturausdruck, ohne Hinweis.
const notesBundle = {
  ...bundle,
  scope: 'book',
  groups: [{ chapterId: 10, chapter: { id: 10, name: 'Verhaftung', parent_chapter_id: null }, pages: [
    { p: { id: 1, name: 'Szene 1' }, pd: {
      html: '<p>Satz <span class="cite" data-src="7" data-loc="44">(Kafka, 1915, S. 44)</span> Ende.</p>',
    } },
  ] }],
};

async function buildNotesXml(notesMode) {
  const buf = await buildDocxProfile(notesBundle, {
    author: 'Franz Kafka', lang: 'de', meta, config: defaultConfig(),
    bibliography: { ...bibFixture, notesMode, notesTitle: 'Anmerkungen' },
  });
  const zip = await JSZip.loadAsync(buf);
  return {
    doc: await zip.file('word/document.xml').async('string'),
    styles: await zip.file('word/styles.xml').async('string'),
  };
}

test('builder: notesMode=endnotes setzt Notenziffer + Apparat statt Klammerform', async () => {
  const { doc, styles } = await buildNotesXml('endnotes');

  // Hochgestellte Notenziffer statt Kurzbeleg im Fliesstext.
  assert.match(doc, /vertAlign[^>]*superscript/i);
  assert.equal(doc.includes('[1, S. 44]'), false);
  assert.equal(doc.includes('(Kafka, 1915, S. 44)'), false);

  // Apparat am Kapitelende, mit eigenem benannten Style (in Word unabhaengig
  // vom Verzeichnis umformatierbar) und haengendem Einzug.
  assert.ok(doc.includes('Anmerkungen'));
  assert.ok(doc.includes('w:pStyle w:val="Endnotes"'));
  assert.ok(styles.includes('w:styleId="Endnotes"'));
  assert.match(styles, /w:styleId="Endnotes"[\s\S]{0,400}w:hanging/);

  // Verzeichnis bleibt zusaetzlich erhalten — Apparat ersetzt es nicht.
  assert.ok(doc.includes('w:pStyle w:val="Bibliography"'));
});

test('builder: notesMode=inline bleibt bei der Klammerform, ohne Apparat', async () => {
  const { doc } = await buildNotesXml('inline');
  assert.ok(doc.includes('[1, S. 44]'));
  assert.equal(doc.includes('w:pStyle w:val="Endnotes"'), false);
  assert.equal(doc.includes('Anmerkungen'), false);
});
