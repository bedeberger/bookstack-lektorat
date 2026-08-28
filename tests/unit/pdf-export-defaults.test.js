'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { defaultConfig, validateConfig } = require('../../lib/pdf-export-defaults');

test('defaultConfig liefert vollständigen Schema-Baum', () => {
  const c = defaultConfig();
  assert.equal(c.layout.pageSize, 'A4');
  assert.equal(c.font.body.family, 'Lora');
  // Die BookStack-Seite ist Strukturelement: eigene Ueberschrift, eigener
  // Umbruch, eigener Verzeichnis-Eintrag (siehe lib/pdf-export-defaults.js).
  assert.equal(c.chapter.pageStructure, 'nested');
  assert.equal(c.chapter.pageBreakBetweenPages, true);
  assert.equal(c.font.heading.sizes.h4, 13);
  assert.equal(c.toc.depth, 3);
  assert.equal(c.toc.includePages, true);
  assert.equal(c.cover.enabled, false);
  assert.equal(c.toc.enabled, true);
  assert.equal(c.toc.startOnRecto, true);
  assert.equal(c.extras.dedicationOnRecto, true);
  assert.equal(c.extras.imprintOnVerso, true);
  assert.equal(c.chapter.firstChapterOnRecto, true);
  assert.equal(c.print.padToEvenPages, true);
  assert.equal(c.pdfa.enabled, true);
  assert.equal(c.pdfa.standard, 'pdfa');
});

test('Seitennummerierung: Defaults + Clamping der neuen Felder', () => {
  const d = defaultConfig();
  assert.equal(d.layout.pageCountMode, 'body');
  assert.equal(d.layout.pageNumberFirstVisible, 1);
  // pageCountMode als Enum, pageNumberFirstVisible als geclampter Num
  assert.equal(validateConfig({ layout: { pageCountMode: 'physical' } }).layout.pageCountMode, 'physical');
  assert.equal(validateConfig({ layout: { pageCountMode: 'nonsense' } }).layout.pageCountMode, 'body');
  // Migration: altes countFrontMatter-Bool → Modus
  assert.equal(validateConfig({ layout: { countFrontMatter: true } }).layout.pageCountMode, 'physical');
  assert.equal(validateConfig({ layout: { countFrontMatter: false } }).layout.pageCountMode, 'body');
  // Neuer Modus gewinnt gegenüber Legacy-Bool, wenn beide vorhanden
  assert.equal(validateConfig({ layout: { pageCountMode: 'body', countFrontMatter: true } }).layout.pageCountMode, 'body');
  assert.equal(validateConfig({ layout: { pageNumberFirstVisible: 4 } }).layout.pageNumberFirstVisible, 4);
  assert.equal(validateConfig({ layout: { pageNumberFirstVisible: 0 } }).layout.pageNumberFirstVisible, 1);
  assert.equal(validateConfig({ layout: { pageNumberFirstVisible: 99999 } }).layout.pageNumberFirstVisible, 9999);
  assert.equal(validateConfig({ layout: { pageNumberFirstVisible: 'nope' } }).layout.pageNumberFirstVisible, 1);
});

test('Titelei-Nummerierung: Enum-Whitelist + Defaults', () => {
  const d = defaultConfig();
  assert.equal(d.layout.frontMatterNumbering, 'none');
  assert.equal(d.layout.frontMatterNumberFirstVisible, 1);
  assert.equal(validateConfig({ layout: { frontMatterNumbering: 'roman' } }).layout.frontMatterNumbering, 'roman');
  assert.equal(validateConfig({ layout: { frontMatterNumbering: 'arabic' } }).layout.frontMatterNumbering, 'arabic');
  // unbekannter Wert fällt auf Default zurück
  assert.equal(validateConfig({ layout: { frontMatterNumbering: 'bogus' } }).layout.frontMatterNumbering, 'none');
  assert.equal(validateConfig({ layout: { frontMatterNumberFirstVisible: 3 } }).layout.frontMatterNumberFirstVisible, 3);
  assert.equal(validateConfig({ layout: { frontMatterNumberFirstVisible: 0 } }).layout.frontMatterNumberFirstVisible, 1);
});

test('pdfa.standard: enum-Whitelist + enabled leitet ab', () => {
  assert.equal(validateConfig({ pdfa: { standard: 'pdfx' } }).pdfa.standard, 'pdfx');
  assert.equal(validateConfig({ pdfa: { standard: 'pdfx' } }).pdfa.enabled, false);
  assert.equal(validateConfig({ pdfa: { standard: 'none' } }).pdfa.enabled, false);
  assert.equal(validateConfig({ pdfa: { standard: 'pdfa' } }).pdfa.enabled, true);
  // Bogus-Standard faellt auf enabled-Ableitung zurueck.
  assert.equal(validateConfig({ pdfa: { standard: 'bogus' } }).pdfa.standard, 'pdfa');
});

test('pdfa: Legacy-Profil ohne standard leitet aus enabled ab', () => {
  assert.equal(validateConfig({ pdfa: { enabled: true } }).pdfa.standard, 'pdfa');
  assert.equal(validateConfig({ pdfa: { enabled: false } }).pdfa.standard, 'none');
});

test('validateConfig clamped Margins auf erlaubten Bereich', () => {
  const c = validateConfig({ layout: { marginsMm: { top: 1000, right: -50, bottom: 25, left: 22 } } });
  assert.equal(c.layout.marginsMm.top, 80);
  assert.equal(c.layout.marginsMm.right, 5);
  assert.equal(c.layout.marginsMm.bottom, 25);
});

test('validateConfig verwirft unbekannte enum-Werte', () => {
  const c = validateConfig({ chapter: { breakBefore: 'bogus', numbering: 'arabic' } });
  assert.equal(c.chapter.breakBefore, 'always');
  assert.equal(c.chapter.numbering, 'arabic');
});

test('validateConfig verwirft Top-Level-Junk', () => {
  const c = validateConfig({ layout: { pageSize: 'A5' }, junkKey: 42, weirdField: 'x' });
  assert.equal(c.layout.pageSize, 'A5');
  assert.equal(c.junkKey, undefined);
  assert.equal(c.weirdField, undefined);
});

test('validateConfig clamped numerische Bereiche bei Schriftgrössen', () => {
  const c = validateConfig({ font: { body: { family: 'Lora', weight: 400, sizePt: 999 } } });
  assert.equal(c.font.body.sizePt, 72);
});

test('validateConfig erhält pageStructure und pageBreakBetweenPages', () => {
  const c = validateConfig({ chapter: { pageStructure: 'flatten', pageBreakBetweenPages: false } });
  assert.equal(c.chapter.pageStructure, 'flatten');
  assert.equal(c.chapter.pageBreakBetweenPages, false);
});

test('Heading-Skala ist absteigend: Kapitel > Seitentitel > Autoren-Ueberschriften', () => {
  // Die Reihenfolge IST die Aussage (siehe lib/pdf-export-defaults.js): h1..h3
  // Kapitelebenen, h4 Seitentitel, h5/h6 die Ueberschriften im Seitentext.
  const s = defaultConfig().font.heading.sizes;
  const body = defaultConfig().font.body.sizePt;
  assert.ok(s.h1 > s.h2 && s.h2 > s.h3 && s.h3 > s.h4 && s.h4 > s.h5 && s.h5 > s.h6,
    `Kette nicht absteigend: ${JSON.stringify(s)}`);
  assert.ok(s.h6 >= body, 'h6 darf nicht unter die Fliesstext-Groesse fallen');
});

test('validateConfig: h4/h5/h6 clamped, toc.includePages als Bool', () => {
  assert.equal(validateConfig({ font: { heading: { sizes: { h4: 999 } } } }).font.heading.sizes.h4, 30);
  assert.equal(validateConfig({ font: { heading: { sizes: { h5: 999 } } } }).font.heading.sizes.h5, 28);
  assert.equal(validateConfig({ font: { heading: { sizes: { h6: 1 } } } }).font.heading.sizes.h6, 7);
  assert.equal(validateConfig({ font: { heading: { sizes: { h4: 1 } } } }).font.heading.sizes.h4, 7);
  assert.equal(validateConfig({ toc: { includePages: false } }).toc.includePages, false);
  // Unbekannter Wert faellt auf den Default zurueck, nicht auf `false`.
  assert.equal(validateConfig({ toc: { includePages: 'ja' } }).toc.includePages, true);
});

test('validateConfig erhält titleRule und pageTitleRule', () => {
  const c = validateConfig({ chapter: { titleRule: true, pageTitleRule: true } });
  assert.equal(c.chapter.titleRule, true);
  assert.equal(c.chapter.pageTitleRule, true);
});

test('validateConfig: numberingMode nested|flat + Default nested', () => {
  const def = defaultConfig();
  assert.equal(def.chapter.numberingMode, 'nested');
  const flat = validateConfig({ chapter: { numberingMode: 'flat' } });
  assert.equal(flat.chapter.numberingMode, 'flat');
  const bogus = validateConfig({ chapter: { numberingMode: 'wat' } });
  assert.equal(bogus.chapter.numberingMode, 'nested');
});

test('validateConfig: unnumberedChapterIds dedup + Integer-Cast + Junk-Filter', () => {
  const def = defaultConfig();
  assert.deepEqual(def.chapter.unnumberedChapterIds, []);
  const c = validateConfig({ chapter: { unnumberedChapterIds: [1, '2', 2, 'abc', 0, -3, 4] } });
  assert.deepEqual(c.chapter.unnumberedChapterIds, [1, 2, 4]);
  const empty = validateConfig({ chapter: { unnumberedChapterIds: 'nope' } });
  assert.deepEqual(empty.chapter.unnumberedChapterIds, []);
});

test('validateConfig: skipPageCounter Listen — Defaults leer, Junk gefiltert, dedup', () => {
  const def = defaultConfig();
  assert.deepEqual(def.chapter.skipPageCounterChapterIds, []);
  assert.deepEqual(def.chapter.skipPageCounterPageIds, []);
  const c = validateConfig({
    chapter: {
      skipPageCounterChapterIds: [10, '11', 11, 'x', 0, -1, 12],
      skipPageCounterPageIds:    [9, 9, '8', 'nope', 7],
    },
  });
  assert.deepEqual(c.chapter.skipPageCounterChapterIds, [10, 11, 12]);
  assert.deepEqual(c.chapter.skipPageCounterPageIds,    [9, 8, 7]);
  const empty = validateConfig({ chapter: { skipPageCounterChapterIds: 'no', skipPageCounterPageIds: null } });
  assert.deepEqual(empty.chapter.skipPageCounterChapterIds, []);
  assert.deepEqual(empty.chapter.skipPageCounterPageIds, []);
});

test('validateConfig: breakBeforeSubchapter Default true, akzeptiert false', () => {
  // Sub-Kapitel beginnen auf neuer Seite, sonst haelt „jede Seite beginnt neu"
  // in einer Hierarchie nicht (die erste Seite folgt der Sub-Ueberschrift).
  const def = defaultConfig();
  assert.equal(def.chapter.breakBeforeSubchapter, true);
  const off = validateConfig({ chapter: { breakBeforeSubchapter: false } });
  assert.equal(off.chapter.breakBeforeSubchapter, false);
});

test('validateConfig: toc.depth akzeptiert 3', () => {
  const c = validateConfig({ toc: { depth: 3 } });
  assert.equal(c.toc.depth, 3);
});

test('validateConfig: toc.startOnRecto ist boolean-validiert', () => {
  assert.equal(validateConfig({ toc: { startOnRecto: false } }).toc.startOnRecto, false);
  // Nicht-Boolean fällt auf Default (true) zurück.
  assert.equal(validateConfig({ toc: { startOnRecto: 'nope' } }).toc.startOnRecto, true);
});

test('defaultConfig: Trennlinien-Toggles default off', () => {
  const c = defaultConfig();
  assert.equal(c.chapter.titleRule, false);
  assert.equal(c.chapter.pageTitleRule, false);
});

test('defaultConfig: Farbe pro Schriftrolle vorkonfiguriert', () => {
  const c = defaultConfig();
  assert.match(c.font.body.color,     /^#[0-9a-f]{6}$/);
  assert.match(c.font.heading.color,  /^#[0-9a-f]{6}$/);
  assert.match(c.font.title.color,    /^#[0-9a-f]{6}$/);
  assert.match(c.font.subtitle.color, /^#[0-9a-f]{6}$/);
  assert.match(c.font.byline.color,   /^#[0-9a-f]{6}$/);
});

test('validateConfig: Hex-Farben akzeptiert (6-stellig, 3-stellig, lowercase)', () => {
  const c = validateConfig({ font: {
    body:     { color: '#ABCDEF' },
    heading:  { color: '#f00' },
    title:    { color: '#012345' },
  }});
  assert.equal(c.font.body.color,    '#abcdef');
  assert.equal(c.font.heading.color, '#ff0000');
  assert.equal(c.font.title.color,   '#012345');
});

test('defaultConfig: mirrorMargins/hyphenate/chapter-start-toggles vorhanden', () => {
  const c = defaultConfig();
  assert.equal(c.layout.mirrorMargins, false);
  assert.equal(c.layout.hyphenate, true);
  assert.equal(c.layout.showHeaderOnChapterStart, false);
  assert.equal(c.layout.showFooterOnChapterStart, false);
  assert.equal(c.layout.headerVersoLeft, '');
  assert.equal(c.layout.headerVersoCenter, '');
  assert.equal(c.layout.headerVersoRight, '');
  assert.equal(c.layout.footerVersoLeft, '');
  assert.equal(c.layout.footerVersoCenter, '');
  assert.equal(c.layout.footerVersoRight, '');
});

test('validateConfig: mirrorMargins akzeptiert true, verso-Slots passieren', () => {
  const c = validateConfig({ layout: {
    mirrorMargins: true,
    hyphenate: false,
    showFooterOnChapterStart: true,
    headerVersoCenter: '{title}',
    footerVersoCenter: '{page}',
  }});
  assert.equal(c.layout.mirrorMargins, true);
  assert.equal(c.layout.hyphenate, false);
  assert.equal(c.layout.showFooterOnChapterStart, true);
  assert.equal(c.layout.headerVersoCenter, '{title}');
  assert.equal(c.layout.footerVersoCenter, '{page}');
});

test('validateConfig: Bad Hex fällt auf Default zurück', () => {
  const d = defaultConfig();
  const c = validateConfig({ font: {
    body:    { color: 'red' },
    heading: { color: '#12' },
    title:   { color: '#GGGGGG' },
    byline:  { color: null },
  }});
  assert.equal(c.font.body.color,    d.font.body.color);
  assert.equal(c.font.heading.color, d.font.heading.color);
  assert.equal(c.font.title.color,   d.font.title.color);
  assert.equal(c.font.byline.color,  d.font.byline.color);
});

test('defaultConfig: neue Extras + Font-Rollen für Frontmatter/Autor', () => {
  const d = defaultConfig();
  assert.equal(d.extras.isbn, '');
  assert.equal(d.extras.copyright, '');
  assert.equal(d.extras.frontMatter, '');
  assert.equal(d.extras.authorBio, '');
  assert.equal(d.extras.imprintPosition, 'front');
  assert.ok(d.font.frontMatter && d.font.authorBio, 'Font-Rollen frontMatter/authorBio fehlen');
});

test('validateConfig: neue Extras + imprintPosition-Enum', () => {
  const c = validateConfig({ extras: {
    isbn: '978-3-16-148410-0',
    copyright: '© 2026 X',
    frontMatter: 'Motto',
    authorBio: 'Bio',
    imprintPosition: 'back',
  }});
  assert.equal(c.extras.isbn, '978-3-16-148410-0');
  assert.equal(c.extras.copyright, '© 2026 X');
  assert.equal(c.extras.frontMatter, 'Motto');
  assert.equal(c.extras.authorBio, 'Bio');
  assert.equal(c.extras.imprintPosition, 'back');
  // Junk-Position fällt auf Default 'front' zurück.
  assert.equal(validateConfig({ extras: { imprintPosition: 'sideways' } }).extras.imprintPosition, 'front');
  // ISBN über 20 Zeichen wird getrimmt.
  assert.ok(validateConfig({ extras: { isbn: 'x'.repeat(50) } }).extras.isbn.length <= 20);
});

test('validateConfig: print.padToEvenPages — Default an, Bool-validiert', () => {
  assert.equal(defaultConfig().print.padToEvenPages, true);
  assert.equal(validateConfig({ print: { padToEvenPages: false } }).print.padToEvenPages, false);
  // Nicht-Boolean fällt auf Default (true) zurück.
  assert.equal(validateConfig({ print: { padToEvenPages: 'yes' } }).print.padToEvenPages, true);
});

test('validateConfig: extras.imprintOnVerso + chapter.firstChapterOnRecto — Default an, Bool-validiert', () => {
  assert.equal(defaultConfig().extras.imprintOnVerso, true);
  assert.equal(defaultConfig().chapter.firstChapterOnRecto, true);
  assert.equal(validateConfig({ extras: { imprintOnVerso: false } }).extras.imprintOnVerso, false);
  assert.equal(validateConfig({ chapter: { firstChapterOnRecto: false } }).chapter.firstChapterOnRecto, false);
  // Nicht-Boolean fällt auf Default (true) zurück.
  assert.equal(validateConfig({ extras: { imprintOnVerso: 'x' } }).extras.imprintOnVerso, true);
  assert.equal(validateConfig({ chapter: { firstChapterOnRecto: 'x' } }).chapter.firstChapterOnRecto, true);
});

test('defaultConfig: coverSpec-Block (Umschlag-PDF) vorhanden + leer', () => {
  const d = defaultConfig();
  assert.ok(d.coverSpec, 'coverSpec fehlt');
  assert.equal(d.coverSpec.pageCount, 0);
  assert.equal(d.coverSpec.paperBulkMmPer1000, 0);
  assert.equal(d.coverSpec.blurb, '');
  assert.equal(d.coverSpec.spineText, '');
  assert.equal(d.coverSpec.backgroundColor, '#ffffff');
});

test('validateConfig: coverSpec — Clamps, Integer-pageCount, Hex-Default', () => {
  const c = validateConfig({ coverSpec: {
    pageCount: 312.7,
    paperBulkMmPer1000: 72.5,
    blurb: 'Klappentext',
    spineText: 'Titel',
    backgroundColor: '#102030',
  }});
  assert.equal(c.coverSpec.pageCount, 313);          // gerundet
  assert.equal(c.coverSpec.paperBulkMmPer1000, 72.5);
  assert.equal(c.coverSpec.blurb, 'Klappentext');
  assert.equal(c.coverSpec.spineText, 'Titel');
  assert.equal(c.coverSpec.backgroundColor, '#102030');
  // Clamps + Junk-Hex.
  assert.equal(validateConfig({ coverSpec: { pageCount: -5 } }).coverSpec.pageCount, 0);
  assert.equal(validateConfig({ coverSpec: { paperBulkMmPer1000: 9999 } }).coverSpec.paperBulkMmPer1000, 300);
  assert.equal(validateConfig({ coverSpec: { backgroundColor: 'nope' } }).coverSpec.backgroundColor, '#ffffff');
  // Unbekannte Keys verworfen.
  assert.equal(validateConfig({ coverSpec: { evil: 1 } }).coverSpec.evil, undefined);
});

// ── Fussnotenapparat ─────────────────────────────────────────────────────────
// `maxHeightPct` ist kein Kosmetik-Regler: er begrenzt, wie viel Satzspiegel der
// Apparat frisst, und garantiert damit, dass auf jeder Seite Text Platz hat.
// Darum eine harte Untergrenze statt 0.

test('defaultConfig: footnotes-Block vorhanden', () => {
  const f = defaultConfig().footnotes;
  assert.equal(f.separator, true);
  assert.equal(f.separatorWidthMm, 30);
  assert.equal(f.gapMm, 2);
  assert.equal(f.hangMm, 4);
  assert.equal(f.maxHeightPct, 45);
});

test('validateConfig: footnotes — Clamps, Bools, Junk', () => {
  const f = validateConfig({ footnotes: { separatorWidthMm: 12, gapMm: 3.5, hangMm: 6, maxHeightPct: 30, separator: false } }).footnotes;
  assert.equal(f.separatorWidthMm, 12);
  assert.equal(f.gapMm, 3.5);
  assert.equal(f.hangMm, 6);
  assert.equal(f.maxHeightPct, 30);
  assert.equal(f.separator, false);

  const clamped = validateConfig({ footnotes: { maxHeightPct: 999, gapMm: -5, separatorWidthMm: 0 } }).footnotes;
  assert.equal(clamped.maxHeightPct, 70);
  assert.equal(clamped.gapMm, 0);
  assert.equal(clamped.separatorWidthMm, 5);

  assert.equal(validateConfig({ footnotes: { evil: 1 } }).footnotes.evil, undefined);
  assert.deepEqual(validateConfig({ footnotes: 'kaputt' }).footnotes, defaultConfig().footnotes);
});

test('defaultConfig: Font-Rolle footnote vorhanden und kleiner als der Fliesstext', () => {
  const font = defaultConfig().font;
  assert.equal(typeof font.footnote.family, 'string');
  assert.ok(font.footnote.sizePt < font.body.sizePt, 'Apparat wird kleiner gesetzt als der Fliesstext');
  assert.equal(validateConfig({ font: { footnote: { sizePt: 999 } } }).font.footnote.sizePt, 72);
});
