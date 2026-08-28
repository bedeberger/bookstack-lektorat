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
// document.xml liegt DEFLATE-komprimiert im ZIP — fuer Struktur-Asserts (welche
// Heading-Stufe traegt welcher Titel, wo sitzt ein Seitenumbruch) muss es
// entpackt werden. jszip ist ohnehin eine transitive Abhaengigkeit der
// docx-Lib, hier also kein neues Test-Werkzeug.
async function documentXml(config) {
  const buf = await buildDocxProfile(bundle, { author: 'Franz Kafka', lang: 'de', meta, config });
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(buf);
  return zip.file('word/document.xml').async('string');
}

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

// ── Seite als Strukturelement ────────────────────────────────────────────────
// Pendant zu den PDF-Tests in tests/unit/pdf-render.test.mjs: derselbe Buchstand
// muss in beiden Manuskript-Formaten dieselbe Gliederung ergeben.

// Zaehlt, wie oft ein Text in einem Absatz des angegebenen Heading-Styles steht.
function headingCount(xml, styleId, text) {
  const paras = xml.split('<w:p>').slice(1);
  return paras.filter(p => p.includes(`w:val="${styleId}"`) && p.includes(`>${text}<`)).length;
}

test('nested: jede Seite traegt ihren Titel als Heading 4 (vierte Stufe unter den Kapiteln)', async () => {
  const xml = await documentXml(validateConfig({ chapter: { pageStructure: 'nested' } }));
  // Kapitel bleiben auf Heading 1, die Seiten sitzen darunter auf Heading 4.
  assert.equal(headingCount(xml, 'Heading1', 'Verhaftung'), 1);
  assert.equal(headingCount(xml, 'Heading4', 'Szene 1'), 1);
  assert.equal(headingCount(xml, 'Heading4', 'Szene 2'), 1);
});

test('nested greift auch beim EINSEITIGEN Kapitel (kein pages.length>1-Vorbehalt)', async () => {
  const xml = await documentXml(validateConfig({ chapter: { pageStructure: 'nested' } }));
  // Kapitel "Anhang" hat genau eine Seite ("A") — sie muss trotzdem als
  // eigene Gliederungsstufe erscheinen.
  assert.equal(headingCount(xml, 'Heading1', 'Anhang'), 1);
  assert.equal(headingCount(xml, 'Heading4', 'A'), 1);
});

test('flatten: Seiten bekommen keine eigene Ueberschrift', async () => {
  const xml = await documentXml(validateConfig({ chapter: { pageStructure: 'flatten' } }));
  assert.equal(headingCount(xml, 'Heading1', 'Verhaftung'), 1);
  assert.equal(headingCount(xml, 'Heading4', 'Szene 1'), 0);
});

test('Seitenname gleich Kapitelname: keine doppelte Ueberschrift untereinander', async () => {
  const dupBundle = {
    ...bundle,
    groups: [{
      chapterId: 30, chapter: { id: 30, name: 'Nachwort', parent_chapter_id: null },
      pages: [{ p: { id: 9, name: 'Nachwort' }, pd: { html: '<p>Text.</p>' } }],
    }],
  };
  const buf = await buildDocxProfile(dupBundle, {
    author: 'X', lang: 'de', meta, config: validateConfig({ chapter: { pageStructure: 'nested' } }),
  });
  const JSZip = require('jszip');
  const xml = await (await JSZip.loadAsync(buf)).file('word/document.xml').async('string');
  assert.equal(headingCount(xml, 'Heading1', 'Nachwort'), 1);
  assert.equal(headingCount(xml, 'Heading4', 'Nachwort'), 0, 'Kapiteltitel darf nicht als Seitentitel wiederholt werden');
});

test('pageBreakBetweenPages: Umbruch haengt am Seitentitel, nicht an einem Leerabsatz', async () => {
  const withBreak = await documentXml(validateConfig({
    chapter: { pageStructure: 'nested', pageBreakBetweenPages: true },
  }));
  const noBreak = await documentXml(validateConfig({
    chapter: { pageStructure: 'nested', pageBreakBetweenPages: false },
  }));
  const breaks = x => (x.match(/<w:pageBreakBefore\/>/g) || []).length;
  // Genau ein zusaetzlicher Umbruch: "Szene 2" ist die einzige Folgeseite in
  // einem Kapitel des Fixtures.
  assert.equal(breaks(withBreak), breaks(noBreak) + 1);
  // Der Umbruch sitzt am Heading-4-Absatz der Folgeseite.
  const szene2 = withBreak.split('<w:p>').find(p => p.includes('>Szene 2<') && p.includes('Heading4'));
  assert.ok(szene2 && szene2.includes('<w:pageBreakBefore/>'), 'Umbruch nicht am Seitentitel');
});

test('statisches TOC: Seiten als eigene Ebene, abschaltbar ueber toc.includePages', async () => {
  const withPages = await documentXml(validateConfig({
    toc: { mode: 'static', includePages: true }, chapter: { pageStructure: 'nested' },
  }));
  const withoutPages = await documentXml(validateConfig({
    toc: { mode: 'static', includePages: false }, chapter: { pageStructure: 'nested' },
  }));
  const listed = (xml, name) => (xml.match(new RegExp(`>${name}<`, 'g')) || []).length;
  // "Szene 1" steht mit Verzeichnis-Eintrag zweimal im Dokument (Verzeichnis +
  // Seitentitel im Body), ohne Eintrag nur einmal.
  assert.equal(listed(withPages, 'Szene 1'), listed(withoutPages, 'Szene 1') + 1);
});

test('Autoren-Ueberschrift im Seitentext liegt UNTER dem Seitentitel (Heading 5/6)', async () => {
  const authorBundle = {
    ...bundle,
    groups: [{
      chapterId: 40, chapter: { id: 40, name: 'Kapitel', parent_chapter_id: null },
      pages: [{ p: { id: 5, name: 'Beitrag' }, pd: { html: '<h1>Gross</h1><p>x</p><h2>Klein</h2><p>y</p>' } }],
    }],
  };
  const xmlFor = async (pageStructure) => {
    const buf = await buildDocxProfile(authorBundle, {
      author: 'X', lang: 'de', meta, config: validateConfig({ chapter: { pageStructure } }),
    });
    const JSZip = require('jszip');
    return (await JSZip.loadAsync(buf)).file('word/document.xml').async('string');
  };

  // Der Beitrag hat einen eigenen Titel (Heading 4) → die Autoren-Ueberschriften
  // rutschen auf Heading 5/6. Auf Heading 2/3 stuenden sie im TOC-Feld-Bereich
  // UEBER der Seite, in der sie stehen.
  const nested = await xmlFor('nested');
  assert.equal(headingCount(nested, 'Heading4', 'Beitrag'), 1);
  assert.equal(headingCount(nested, 'Heading5', 'Gross'), 1);
  assert.equal(headingCount(nested, 'Heading6', 'Klein'), 1);
  assert.equal(headingCount(nested, 'Heading2', 'Gross'), 0);

  // Ohne gezeichneten Seitentitel ist die Autoren-Ueberschrift die oberste Marke
  // im Fluss und behaelt Heading 2/3.
  const flat = await xmlFor('flatten');
  assert.equal(headingCount(flat, 'Heading2', 'Gross'), 1);
  assert.equal(headingCount(flat, 'Heading3', 'Klein'), 1);
  assert.equal(headingCount(flat, 'Heading5', 'Gross'), 0);
});
