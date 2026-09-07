// Snapshot-artige Asserts auf Page-Counts + PDF-Marker. Vermeidet echte
// Pixel-Vergleiche (zu fragil). Stattdessen prüfen wir, dass das Output:
//   - %PDF-Header trägt
//   - PDF/A-XMP enthält
//   - die erwartete Page-Anzahl pro Konfig produziert
//   - Header/Footer-Pass keine Ghost-Pages produziert (Bug-Regression)

import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';

process.env.DB_PATH = path.join('/tmp', `pdfx-render-test-${process.pid}-${Date.now()}.db`);
// Migrationen MÜSSEN vor pdf-render laufen, weil font-fetch beim Modul-Load
// Prepared-Statements auf `font_cache` anlegt. Schema-Import zuerst.
await import('../../db/schema.js');
const { renderPdfBuffer } = await import('../../lib/pdf-render.js');
const { defaultConfig } = await import('../../lib/pdf-export-defaults.js');
const { tocEntryVisible } = await import('../../lib/pdf-render/pages.js');

const para = '<p>' + 'Es war einmal ein König. '.repeat(10) + '</p>';
const html = '<h1>Vorgeschichte</h1>' + para.repeat(2);

const baseGroups = [
  { chapter: { id: 1, name: 'Eins' }, pages: [
    { p: { id: 1, name: 'A' }, pd: { html } },
    { p: { id: 2, name: 'B' }, pd: { html } },
  ]},
  { chapter: { id: 2, name: 'Zwei' }, pages: [{ p: { id: 3, name: 'C' }, pd: { html } }]},
];
const baseBook = { name: 'Test', created_by: { name: 'X' }, created_at: '2024-01-01' };

function pageCount(buf) {
  return (buf.toString('binary').match(/\/Type\s*\/Page(?!s)/g) || []).length;
}

// Alle Recto/Verso- + Gerade-Seitenzahl-Paritätsregeln abschalten (Defaults sind
// an). Strukturelle Page-Count-Delta-Tests brauchen das, damit eingeschobene
// Leerseiten die Deltas nicht verfälschen; jede Paritätsregel hat einen eigenen
// dedizierten Test weiter unten.
function parityOff(cfg) {
  cfg.toc.startOnRecto = false;
  cfg.chapter.firstChapterOnRecto = false;
  cfg.extras.dedicationOnRecto = false;
  cfg.extras.imprintOnVerso = false;
  cfg.print.padToEvenPages = false;
  return cfg;
}

test('Render produziert valides PDF mit %PDF-Header', async () => {
  const cfg = defaultConfig();
  cfg.cover.enabled = false;
  const buf = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null,
  });
  assert.equal(buf.slice(0, 5).toString(), '%PDF-');
  assert.ok(pageCount(buf) >= 4);
});

test('PDF/A-Modus hängt XMP-Marker + sRGB-OutputIntent ein', async () => {
  const cfg = defaultConfig();
  cfg.cover.enabled = false;
  cfg.pdfa.enabled = true;
  const buf = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null,
  });
  assert.ok(buf.indexOf('pdfaid:part') > 0, 'XMP-pdfaid:part fehlt');
  assert.ok(buf.indexOf('sRGB IEC61966') > 0, 'OutputIntent-ICC-Identifier fehlt');
});

test('Footer-Token erzeugt KEINE Ghost-Pages (Regression)', async () => {
  const cfg = defaultConfig();
  cfg.cover.enabled = false;
  cfg.layout.footerCenter = '{page} / {pages}';
  const withFooter = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null,
  });
  const cfgNoFooter = { ...cfg, layout: { ...cfg.layout, footerLeft: '', footerCenter: '', footerRight: '' } };
  const noFooter = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfgNoFooter }, coverBuf: null, token: null,
  });
  assert.equal(pageCount(withFooter), pageCount(noFooter), 'Footer-Pass darf keine Extra-Pages erzeugen');
});

test('pageCountMode=physical + pageNumberFirstVisible ändern Page-Count nicht', async () => {
  const cfg = defaultConfig();
  cfg.cover.enabled = false;
  cfg.layout.footerCenter = '{page} / {pages}';
  const baseline = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null,
  });
  const tuned = {
    ...cfg,
    layout: { ...cfg.layout, pageCountMode: 'physical', pageNumberFirstVisible: 3 },
  };
  const withOpts = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: tuned }, coverBuf: null, token: null,
  });
  // Reine Stempel-Optionen: keine zusätzlichen/fehlenden Seiten.
  assert.equal(pageCount(withOpts), pageCount(baseline));
});

test('pageCountMode=physical zählt Body-Leerseiten mit, ohne Ghost-Pages', async () => {
  // firstChapterOnRecto erzwingt bei geradem Seitenstand eine Leer-Verso vor
  // dem ersten Kapitel — der 'physical'-Zählpfad muss diese mitzählen (cnt++),
  // ohne die Seitenanzahl gegenüber dem 'body'-Modus zu verändern.
  const cfgBody = defaultConfig();
  cfgBody.cover.enabled = false;
  cfgBody.chapter.firstChapterOnRecto = true;
  cfgBody.layout.footerCenter = '{page} / {pages}';
  cfgBody.layout.pageCountMode = 'body';
  const bodyBuf = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfgBody }, coverBuf: null, token: null,
  });
  const cfgPhys = { ...cfgBody, layout: { ...cfgBody.layout, pageCountMode: 'physical' } };
  const physBuf = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfgPhys }, coverBuf: null, token: null,
  });
  assert.equal(physBuf.slice(0, 5).toString(), '%PDF-');
  assert.equal(pageCount(physBuf), pageCount(bodyBuf), 'Zählmodus darf keine Seiten hinzufügen/entfernen');
});

test('frontMatterNumbering=roman ändert Page-Count nicht + rendert ohne Crash', async () => {
  const cfg = defaultConfig();
  cfg.cover.enabled = false;      // ohne Cover: Titelseite + TOC bilden die Titelei
  cfg.toc.enabled = true;
  cfg.extras.dedication = 'Für alle.';
  const baseline = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null,
  });
  const roman = {
    ...cfg,
    layout: { ...cfg.layout, frontMatterNumbering: 'roman', frontMatterNumberFirstVisible: 1 },
  };
  const withRoman = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: roman }, coverBuf: null, token: null,
  });
  assert.equal(buf5(withRoman), '%PDF-', 'kein valides PDF');
  assert.equal(pageCount(withRoman), pageCount(baseline), 'Titelei-Nummerierung darf keine Seiten hinzufügen');
});

test('padToEvenPages füllt ungerade Gesamtseitenzahl auf gerade auf', async () => {
  const cfg = defaultConfig();
  cfg.cover.enabled = false;
  cfg.print.padToEvenPages = false; // Default ist an — für den off-Vergleich explizit aus
  const off = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null,
  });
  const cfgOn = { ...cfg, print: { ...cfg.print, padToEvenPages: true } };
  const on = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfgOn }, coverBuf: null, token: null,
  });
  const nOff = pageCount(off);
  const nOn = pageCount(on);
  // Mit Padding ist die Gesamtzahl immer gerade …
  assert.equal(nOn % 2, 0, 'gepolstertes PDF muss gerade Seitenzahl haben');
  // … und es kommt höchstens genau eine Leerseite dazu (nur bei ungeradem Basis-Count).
  assert.equal(nOn, nOff + (nOff % 2), 'Padding darf nur bei ungerader Basis +1 Seite ergeben');
});

function buf5(b) { return b.slice(0, 5).toString(); }

test('blankPageAfter erzeugt zusätzliche leere Page pro Kapitel', async () => {
  const cfg = defaultConfig();
  cfg.cover.enabled = false;
  cfg.toc.enabled = false;
  const baseline = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null,
  });
  cfg.chapter.blankPageAfter = true;
  const withBlanks = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null,
  });
  // 2 Kapitel → 2 zusätzliche Blanks
  assert.equal(pageCount(withBlanks) - pageCount(baseline), 2);
});

test('Widmung + Impressum erzeugen je eine zusätzliche Seite', async () => {
  const cfg = defaultConfig();
  cfg.cover.enabled = false;
  parityOff(cfg); // Parität-Leerseiten würden das Struktur-Delta verfälschen
  const baseline = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null,
  });
  cfg.extras.dedication = 'Für …';
  cfg.extras.imprint = '© 2026';
  const withExtras = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null,
  });
  assert.equal(pageCount(withExtras) - pageCount(baseline), 2);
});

test('Motto/Frontmatter-Seite erzeugt zusätzliche Seite', async () => {
  const cfg = defaultConfig();
  cfg.cover.enabled = false;
  parityOff(cfg); // Parität-Leerseiten würden das Struktur-Delta verfälschen
  const baseline = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null,
  });
  cfg.extras.frontMatter = 'Wer kämpft, kann verlieren. Wer nicht kämpft, hat schon verloren.';
  const withFm = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null,
  });
  assert.equal(pageCount(withFm) - pageCount(baseline), 1);
});

test('Autor-Seite (Bio-Text) erzeugt zusätzliche Seite', async () => {
  const cfg = defaultConfig();
  cfg.cover.enabled = false;
  parityOff(cfg); // Parität-Leerseiten würden das Struktur-Delta verfälschen
  const baseline = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null,
  });
  cfg.extras.authorBio = 'Der Autor lebt und schreibt in der Schweiz.';
  const withBio = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null,
  });
  assert.equal(pageCount(withBio) - pageCount(baseline), 1);
});

test('ISBN/Copyright ohne Impressum-Freitext erzeugt trotzdem Impressum-Seite', async () => {
  const cfg = defaultConfig();
  cfg.cover.enabled = false;
  parityOff(cfg); // Parität-Leerseiten würden das Struktur-Delta verfälschen
  const baseline = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null,
  });
  cfg.extras.isbn = '978-3-16-148410-0';
  cfg.extras.copyright = '© 2026 Max Mustermann';
  const withIsbn = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null,
  });
  assert.equal(pageCount(withIsbn) - pageCount(baseline), 1);
});

test('EAN-13-Barcode auf der Impressum-Seite erzeugt keine Extra-Seite', async () => {
  const noBc = defaultConfig();
  noBc.cover.enabled = false;
  noBc.extras.isbn = '978-3-16-148410-0';
  noBc.extras.barcode = false;
  const without = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: noBc }, coverBuf: null, token: null,
  });
  const withBc = defaultConfig();
  withBc.cover.enabled = false;
  withBc.extras.isbn = '978-3-16-148410-0';
  withBc.extras.barcode = true;
  const withBuf = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: withBc }, coverBuf: null, token: null,
  });
  assert.equal(pageCount(withBuf), pageCount(without));
});

test('Ungültige ISBN unterdrückt den Barcode ohne Crash', async () => {
  const cfg = defaultConfig();
  cfg.cover.enabled = false;
  cfg.extras.isbn = 'keine-zahl';
  cfg.extras.barcode = true;
  cfg.extras.copyright = '© 2026';
  const buf = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null,
  });
  assert.ok(buf.length > 0);
});

test('imprintPosition back: Impressum am Buchende, eine Seite', async () => {
  const front = defaultConfig(); front.cover.enabled = false; parityOff(front);
  const baseline = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: front }, coverBuf: null, token: null,
  });
  const cfg = defaultConfig();
  cfg.cover.enabled = false;
  parityOff(cfg); // Parität-Leerseiten würden das Struktur-Delta verfälschen
  cfg.extras.imprint = '© 2026';
  cfg.extras.imprintPosition = 'back';
  const withBack = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null,
  });
  assert.equal(pageCount(withBack) - pageCount(baseline), 1);
});

test('Beschnitt: Seite wird um 2×Bleed grösser, TrimBox vorhanden', async () => {
  const base = defaultConfig(); base.cover.enabled = false;
  const bufNo = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: base }, coverBuf: null, token: null,
  });
  const cfg = defaultConfig(); cfg.cover.enabled = false; cfg.print.bleedMm = 3;
  const bufBleed = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null,
  });
  assert.ok(bufBleed.toString('binary').includes('/TrimBox'), 'TrimBox fehlt im Bleed-PDF');
  assert.ok(!bufNo.toString('binary').includes('/TrimBox'), 'TrimBox darf ohne Bleed fehlen');
  const mb = (b) => { const m = b.toString('binary').match(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/); return m ? [parseFloat(m[1]), parseFloat(m[2])] : null; };
  const a = mb(bufNo), c = mb(bufBleed);
  assert.ok(a && c, 'MediaBox nicht gefunden');
  assert.ok(Math.abs((c[0] - a[0]) - 6 * 72 / 25.4) < 1, `Breiten-Delta ~17pt erwartet, war ${(c[0] - a[0]).toFixed(2)}`);
});

test('Schnittmarken: Render mit Bleed + cropMarks läuft, gleiche Page-Anzahl', async () => {
  const cfg = defaultConfig(); cfg.cover.enabled = false; cfg.print.bleedMm = 3;
  const noMarks = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null,
  });
  const cfg2 = defaultConfig(); cfg2.cover.enabled = false; cfg2.print.bleedMm = 3; cfg2.print.cropMarks = true;
  const marks = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfg2 }, coverBuf: null, token: null,
  });
  assert.equal(pageCount(marks), pageCount(noMarks), 'cropMarks dürfen keine Extra-Pages erzeugen');
});

test('Lose Seite vor erstem Kapitel: Kapitel-Heading bricht auf eigene Page (Regression)', async () => {
  // Bug: spaceBeforeMm-Reset (doc.y = margin.top + 60mm) lief auch für
  // Kapitel 1 unbedingt, sodass auf einer mit losen Seiten befüllten Body-
  // Page das Kapitel-Heading mitten in den Vorgängerinhalt gestempelt wurde
  // ("drückt durch"). Fix: Break, sobald die Body-Page schon Inhalt hat.
  const longHtml = '<p>' + 'Es war einmal in einem fernen Land. '.repeat(80) + '</p>';
  const groups = [
    { chapter: null, pages: [{ p: { id: 1, name: 'Vorwort' }, pd: { html: longHtml } }] },
    { chapter: { id: 10, name: 'Erstes Kapitel' }, pages: [{ p: { id: 2, name: 'S' }, pd: { html: '<p>kurz</p>' } }] },
  ];
  const cfg = defaultConfig();
  cfg.cover.enabled = false;
  cfg.toc.enabled = false;
  const buf = await renderPdfBuffer({ book: baseBook, groups, profile: { config: cfg }, coverBuf: null, token: null });
  // Erwartet: Title-Page + Vorwort-Body-Page(s) + eigene Kapitel-1-Page → ≥3.
  // Vor dem Fix kollabierten Vorwort + Kapitel-Heading auf eine Body-Page,
  // dann wäre pageCount=2.
  assert.ok(pageCount(buf) >= 3, `Erwartet ≥3 Pages, war ${pageCount(buf)} (Overlap-Bug?)`);
});

test('Hyphenation: SHY-Codepoint erscheint nicht im fertigen PDF', async () => {
  const cfg = defaultConfig();
  cfg.cover.enabled = false;
  cfg.toc.enabled = false;
  cfg.layout.hyphenate = true;
  // Donaudampfschifffahrtsgesellschaft = klassischer Hypher-Trefferkandidat.
  const longPara = '<p>' + 'Donaudampfschifffahrtsgesellschaftskapitän stolpert. '.repeat(20) + '</p>';
  const groups = [{ chapter: { id: 1, name: 'X' }, pages: [{ p: { id: 1, name: 'A' }, pd: { html: '<h1>K</h1>' + longPara } }] }];
  const buf = await renderPdfBuffer({ book: baseBook, groups, profile: { config: cfg }, coverBuf: null, token: null, lang: 'de' });
  // SHY (U+00AD) als UTF-8: 0xC2 0xAD. Darf nicht im PDF auftauchen.
  assert.equal(buf.indexOf(Buffer.from([0xC2, 0xAD])), -1, 'SHY-Codepoint im PDF-Output → _fragment-Patch verschluckt nicht alle');
});

test('mirrorMargins: Render läuft ohne Crash, gleiche Page-Count wie ohne Mirror', async () => {
  const cfg = defaultConfig();
  cfg.cover.enabled = false;
  cfg.toc.enabled = false;
  const baseline = await renderPdfBuffer({ book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null });
  cfg.layout.mirrorMargins = true;
  const mirrored = await renderPdfBuffer({ book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null });
  assert.equal(pageCount(mirrored), pageCount(baseline), 'Mirror darf Page-Count nicht ändern');
});

test('mirrorMargins: Text-Cursor folgt dem gespiegelten Rand (Regression: Verso-Textstart)', async () => {
  // addPage() setzt doc.x auf den BASIS-Rand, BEVOR der pageAdded-Hook spiegelt.
  // Ohne Cursor-Nachzug startet der Body auf Verso-Seiten am (grösseren) Recto-
  // Innenrand → linker/rechter Rand vertauscht sich sichtbar. Invariante:
  // doc.x == margins.left auf JEDER Seite (recto wie verso).
  const PDFDocument = (await import('pdfkit')).default;
  const { createPageGeometry } = await import('../../lib/pdf-render/page-geometry.js');
  const { MM_TO_PT } = await import('../../lib/pdf-render/layout.js');

  const margins = { top: 25 * MM_TO_PT, right: 15 * MM_TO_PT, bottom: 25 * MM_TO_PT, left: 30 * MM_TO_PT };
  const doc = new PDFDocument({ size: [595, 842], margins, autoFirstPage: false, bufferPages: true });
  doc.on('data', () => {});
  const geo = createPageGeometry(doc, {
    layout: { bodyInsetMm: { top: 0, right: 0, bottom: 0, left: 0 } },
    margins, bleedPt: 0, mirror: true, frontMatterAllowed: true, blankPageIdxs: new Set(),
  });
  geo.attach();

  for (let i = 0; i < 4; i++) {
    doc.addPage();
    const idx = doc.bufferedPageRange().start + doc.bufferedPageRange().count - 1;
    const verso = idx % 2 === 1;
    assert.ok(Math.abs(doc.x - doc.page.margins.left) < 0.01,
      `Seite ${idx} (${verso ? 'verso' : 'recto'}): doc.x=${doc.x} muss margins.left=${doc.page.margins.left} folgen`);
    // Verso spiegelt tatsächlich (linker Rand = Aussenrand 15mm, nicht 30mm).
    const expectLeftMm = verso ? 15 : 30;
    assert.ok(Math.abs(doc.page.margins.left / MM_TO_PT - expectLeftMm) < 0.01,
      `Seite ${idx}: erwarteter linker Rand ${expectLeftMm}mm`);
  }
  doc.end();
});

test('page-geometry: TrimBox/BleedBox exakt + mirror+bleed kombiniert', async () => {
  // Deckt zwei Lücken ab: (1) die exakten Beschnitt-Koordinaten (nicht nur
  // TrimBox-Existenz) und (2) mirror + bleed GEMEINSAM in einem Setup — der
  // bestehende Cursor-Test läuft mit bleedPt: 0.
  const PDFDocument = (await import('pdfkit')).default;
  const { createPageGeometry } = await import('../../lib/pdf-render/page-geometry.js');
  const { MM_TO_PT } = await import('../../lib/pdf-render/layout.js');

  const bleedPt = 3 * MM_TO_PT;
  const W = 595, H = 842;
  // Basis-Ränder inkl. Bleed (wie index.js sie baut): left = Bund (gross),
  // right = Aussenkante (klein).
  const margins = {
    top: 25 * MM_TO_PT + bleedPt, right: 15 * MM_TO_PT + bleedPt,
    bottom: 25 * MM_TO_PT + bleedPt, left: 30 * MM_TO_PT + bleedPt,
  };
  const doc = new PDFDocument({ size: [W, H], margins, autoFirstPage: false, bufferPages: true });
  doc.on('data', () => {});
  const geo = createPageGeometry(doc, {
    layout: { bodyInsetMm: {} }, margins, bleedPt, mirror: true, frontMatterAllowed: true, blankPageIdxs: new Set(),
  });
  geo.attach();

  for (let i = 0; i < 4; i++) {
    doc.addPage();
    const idx = doc.bufferedPageRange().start + doc.bufferedPageRange().count - 1;
    const verso = idx % 2 === 1;
    const tb = doc.page.dictionary.data.TrimBox;
    const bb = doc.page.dictionary.data.BleedBox;
    assert.ok(tb, `Seite ${idx}: TrimBox fehlt`);
    // Endformat sitzt exakt Bleed-Offset innerhalb der Medienkante.
    for (const [got, exp, label] of [[tb[0], bleedPt, 'x0'], [tb[1], bleedPt, 'y0'], [tb[2], W - bleedPt, 'x1'], [tb[3], H - bleedPt, 'y1']]) {
      assert.ok(Math.abs(got - exp) < 0.01, `Seite ${idx} TrimBox.${label}=${got} != ${exp}`);
    }
    assert.deepEqual(bb, [0, 0, W, H], `Seite ${idx}: BleedBox muss die volle Medienkante sein`);
    // Spiegelung greift TROTZ Bleed: Verso tauscht den Bund nach aussen.
    const expLeftMm = verso ? 15 : 30;
    assert.ok(Math.abs(doc.page.margins.left - (expLeftMm * MM_TO_PT + bleedPt)) < 0.01,
      `Seite ${idx}: linker Rand (mirror+bleed) muss ${expLeftMm}mm+Bleed sein`);
  }
  doc.end();
});

test('Beschnitt: TrimBox trägt die exakten Bleed-Koordinaten (durch die Pipeline)', async () => {
  const { MM_TO_PT } = await import('../../lib/pdf-render/layout.js');
  const cfg = defaultConfig(); cfg.cover.enabled = false; cfg.print.bleedMm = 3;
  const buf = await renderPdfBuffer({ book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null });
  const bin = buf.toString('binary');
  const media = bin.match(/\/MediaBox\s*\[([^\]]+)\]/);
  const trim = bin.match(/\/TrimBox\s*\[([^\]]+)\]/);
  assert.ok(media && trim, 'MediaBox/TrimBox fehlen im gerenderten PDF');
  const [, , W, H] = media[1].trim().split(/\s+/).map(Number);
  const t = trim[1].trim().split(/\s+/).map(Number);
  const bleedPt = 3 * MM_TO_PT;
  assert.ok(Math.abs(t[0] - bleedPt) < 0.05 && Math.abs(t[1] - bleedPt) < 0.05, `TrimBox-Ursprung ${t[0]}/${t[1]} != Bleed ${bleedPt}`);
  assert.ok(Math.abs(t[2] - (W - bleedPt)) < 0.05 && Math.abs(t[3] - (H - bleedPt)) < 0.05, `TrimBox-Ecke ${t[2]}/${t[3]} != ${W - bleedPt}/${H - bleedPt}`);
});

test('mirror+bleed durch die Pipeline: Render ok, TrimBox vorhanden, Page-Count wie ohne Mirror', async () => {
  const cfg = defaultConfig(); cfg.cover.enabled = false; cfg.toc.enabled = false; cfg.print.bleedMm = 3;
  const noMirror = await renderPdfBuffer({ book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null });
  cfg.layout.mirrorMargins = true;
  const mirrored = await renderPdfBuffer({ book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null });
  assert.equal(pageCount(mirrored), pageCount(noMirror), 'mirror+bleed darf Page-Count nicht ändern');
  assert.ok(mirrored.toString('binary').includes('/TrimBox'), 'TrimBox fehlt bei mirror+bleed');
});

test('TOC bei mirrorMargins: jede Zeile folgt dem Bundsteg IHRER Buchseite (Verso ≠ Recto)', async () => {
  // Regression: eine mehrseitige TOC (Userin: 50 Kapitel) muss den Bundsteg pro
  // Verso/Recto-Seite spiegeln wie der Body — nicht auf allen Seiten den Recto-
  // Innenrand erzwingen. Wir spionieren die x-Position jedes Eintrags-Writes und
  // den linken Rand der Zielseite ab.
  const PDFDocument = (await import('pdfkit')).default;
  const { createPageGeometry } = await import('../../lib/pdf-render/page-geometry.js');
  const { MM_TO_PT } = await import('../../lib/pdf-render/layout.js');
  const { _renderToc } = await import('../../lib/pdf-render/pages.js');

  const margins = { top: 25 * MM_TO_PT, right: 15 * MM_TO_PT, bottom: 25 * MM_TO_PT, left: 30 * MM_TO_PT };
  const doc = new PDFDocument({ size: [595, 842], margins, autoFirstPage: false, bufferPages: true });
  doc.on('data', () => {});
  doc.registerFont('toc', 'Helvetica');
  doc.registerFont('toc-title', 'Helvetica-Bold');
  const geo = createPageGeometry(doc, {
    layout: { bodyInsetMm: {} }, margins, bleedPt: 0, mirror: true, frontMatterAllowed: true, blankPageIdxs: new Set(),
  });
  geo.attach();

  const writes = [];
  const origText = doc.text.bind(doc);
  doc.text = function (str, x, y, opts) {
    if (typeof x === 'number' && typeof str === 'string' && str.startsWith('Kapitel')) {
      writes.push({ x, mLeft: doc.page.margins.left });
    }
    return origText(str, x, y, opts);
  };

  // level 0 + keine Nummer → Eintrags-x == linker Rand der Seite (numColW=0).
  const entries = Array.from({ length: 60 }, (_, i) => ({
    title: `Kapitel ${i + 1}`, num: '', level: 0, blockIdx: i, itemIdx: -1, pageIdx: -1,
  }));
  const toc = { enabled: true, depth: 1, showPageNumbers: false, title: 'Inhalt', leader: 'none', indentMm: 6 };
  const font = { toc: { sizePt: 11, lineHeight: 1.45 }, tocTitle: { sizePt: 20 } };

  _renderToc(doc, toc, entries, 'de', font);
  doc.end();

  assert.ok(writes.length >= 40, `zu wenige TOC-Einträge geschrieben (${writes.length})`);
  for (const w of writes) {
    assert.ok(Math.abs(w.x - w.mLeft) < 0.5, `Eintrag-x=${w.x} muss dem Seitenrand ${w.mLeft} folgen`);
  }
  // Beide Bund-Seiten kommen vor → die TOC spiegelt tatsächlich über die Seiten.
  const seenMm = new Set(writes.map(w => Math.round(w.mLeft / MM_TO_PT)));
  assert.ok(seenMm.has(30), 'Recto-Seite (30mm Bund) fehlt');
  assert.ok(seenMm.has(15), 'Verso-Seite (15mm) fehlt — TOC spiegelt den Bundsteg nicht');
});

test('TOC: langer Titel bricht um, Anker für Seitenzahl liegt auf der LETZTEN Zeile', async () => {
  const PDFDocument = (await import('pdfkit')).default;
  const { MM_TO_PT } = await import('../../lib/pdf-render/layout.js');
  const { _renderToc } = await import('../../lib/pdf-render/pages.js');

  const margins = { top: 25 * MM_TO_PT, right: 15 * MM_TO_PT, bottom: 25 * MM_TO_PT, left: 20 * MM_TO_PT };
  const doc = new PDFDocument({ size: [400, 600], margins, autoFirstPage: false, bufferPages: true });
  doc.on('data', () => {});
  doc.registerFont('toc', 'Helvetica');
  doc.registerFont('toc-title', 'Helvetica-Bold');

  const writes = [];
  const origText = doc.text.bind(doc);
  doc.text = function (str, x, y, opts) {
    if (typeof x === 'number' && typeof str === 'string') writes.push({ str, y });
    return origText(str, x, y, opts);
  };

  const entries = [
    { title: 'Ein kurzer Titel', num: '', level: 0, blockIdx: 0, itemIdx: -1, pageIdx: -1 },
    { title: 'Ein sehr langer Kapiteltitel, der unmöglich in eine einzige Zeile des Verzeichnisses passt', num: '', level: 0, blockIdx: 1, itemIdx: -1, pageIdx: -1 },
  ];
  const toc = { enabled: true, depth: 1, showPageNumbers: true, title: 'Inhalt', leader: 'dots', indentMm: 0, pageNumReserveMm: 14 };
  const font = { toc: { sizePt: 11, lineHeight: 1.45 }, tocTitle: { sizePt: 20 } };

  const positions = _renderToc(doc, toc, entries, 'de', font);
  doc.end();

  const shortWrites = writes.filter(w => w.str === 'Ein kurzer Titel');
  assert.equal(shortWrites.length, 1, 'kurzer Titel muss einzeilig bleiben');
  assert.equal(positions[0].y, shortWrites[0].y, 'Anker eines einzeiligen Eintrags = seine Zeile');

  // Alle übrigen Writes (ausser Verzeichnis-Überschrift) gehören dem langen Titel.
  const longWrites = writes.filter(w => w.str !== 'Ein kurzer Titel' && w.str !== 'Inhalt');
  assert.ok(longWrites.length >= 2, `langer Titel muss umbrechen (Writes: ${longWrites.length})`);
  assert.equal(positions[1].y, longWrites[longWrites.length - 1].y,
    'Anker (Seitenzahl/Leader) muss auf der letzten Zeile des umgebrochenen Eintrags liegen');
  assert.equal(positions[1].tocPageIdx, positions[0].tocPageIdx,
    'umgebrochener Eintrag darf nicht über zwei TOC-Seiten zerrissen werden');
});

test('widowOrphanControl: schiebt Absatz auf neue Seite statt Single-Line-Witwe/Waise', async () => {
  // Vier mittellange Absätze, plus ein letzter Absatz, der eine Single-Line-
  // Witwe/Waise produzieren würde. Mit Kontrolle wird er als Ganzes
  // verschoben — also genau dann eine zusätzliche Page, wenn der Greedy-Bruch
  // wirklich gegriffen hätte. Wir prüfen Inequality (>=), weil der genaue
  // Bruchpunkt von Font-Metriken abhängt.
  const para = '<p>' + 'Die Sonne ging langsam unter und tauchte alles in goldenes Licht. '.repeat(15) + '</p>';
  const groups = [{ chapter: { id: 1, name: 'X' }, pages: [{ p: { id: 1, name: 'A' }, pd: { html: '<h1>K</h1>' + para.repeat(5) } }] }];
  const cfg = defaultConfig();
  cfg.cover.enabled = false;
  cfg.toc.enabled = false;
  cfg.layout.widowOrphanControl = false;
  const off = await renderPdfBuffer({ book: baseBook, groups, profile: { config: cfg }, coverBuf: null, token: null });
  cfg.layout.widowOrphanControl = true;
  const on = await renderPdfBuffer({ book: baseBook, groups, profile: { config: cfg }, coverBuf: null, token: null });
  assert.ok(pageCount(on) >= pageCount(off), `widow/orphan darf Pages nicht reduzieren (off=${pageCount(off)} on=${pageCount(on)})`);
});

test('TOC mit Page-Numbers stempelt Zahlen rechts ein', async () => {
  const cfg = defaultConfig();
  cfg.cover.enabled = false;
  cfg.toc.enabled = true;
  cfg.toc.showPageNumbers = true;
  const buf = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: cfg }, coverBuf: null, token: null,
  });
  // Schwer reliably zu prüfen ohne Decode — wir checken nur, dass der Render
  // ohne Crash durchläuft und Page-Count plausibel ist (Title + TOC + Body).
  assert.ok(pageCount(buf) >= 4);
});

test('TOC startOnRecto schiebt Leerseite ein, wenn TOC sonst auf Verso landet', async () => {
  // Kein Cover, keine Widmung/Impressum → nur Titelseite als Titelei.
  // Ohne Recto-Padding beginnt die TOC auf Seite 2 (Verso) → +1 Leerseite.
  // Andere Paritätsregeln aus, damit nur startOnRecto wirkt.
  const on = parityOff(defaultConfig());
  on.cover.enabled = false;
  on.toc.startOnRecto = true;
  const off = parityOff(defaultConfig());
  off.cover.enabled = false;
  off.toc.startOnRecto = false;
  const bufOn = await renderPdfBuffer({ book: baseBook, groups: baseGroups, profile: { config: on }, coverBuf: null, token: null });
  const bufOff = await renderPdfBuffer({ book: baseBook, groups: baseGroups, profile: { config: off }, coverBuf: null, token: null });
  assert.equal(pageCount(bufOn), pageCount(bufOff) + 1);
});

test('TOC startOnRecto fügt KEINE Leerseite ein, wenn TOC bereits auf Recto landet', async () => {
  // Titelseite + Widmung (ohne eigenes Recto-Padding) → TOC beginnt auf Seite 3
  // (Recto), Padding no-op. Andere Paritätsregeln aus.
  const on = parityOff(defaultConfig());
  on.cover.enabled = false;
  on.extras.dedication = 'Für alle, die lesen.';
  on.toc.startOnRecto = true;
  const off = parityOff(defaultConfig());
  off.cover.enabled = false;
  off.extras.dedication = 'Für alle, die lesen.';
  off.toc.startOnRecto = false;
  const bufOn = await renderPdfBuffer({ book: baseBook, groups: baseGroups, profile: { config: on }, coverBuf: null, token: null });
  const bufOff = await renderPdfBuffer({ book: baseBook, groups: baseGroups, profile: { config: off }, coverBuf: null, token: null });
  assert.equal(pageCount(bufOn), pageCount(bufOff));
});

test('dedicationOnRecto schiebt Leerseite ein, wenn die Widmung sonst auf Verso landet', async () => {
  // Kein Cover, kein Impressum → nur Titelseite (Recto). Ohne Padding beginnt die
  // Widmung auf Seite 2 (Verso); mit dedicationOnRecto wird eine Leerseite davor
  // eingeschoben → +1 Seite gegenüber der Verso-Variante. Andere Paritätsregeln aus.
  const on = parityOff(defaultConfig());
  on.cover.enabled = false;
  on.toc.enabled = false;
  on.extras.dedication = 'Für alle, die lesen.';
  on.extras.dedicationOnRecto = true;
  const off = parityOff(defaultConfig());
  off.cover.enabled = false;
  off.toc.enabled = false;
  off.extras.dedication = 'Für alle, die lesen.';
  off.extras.dedicationOnRecto = false;
  const bufOn = await renderPdfBuffer({ book: baseBook, groups: baseGroups, profile: { config: on }, coverBuf: null, token: null });
  const bufOff = await renderPdfBuffer({ book: baseBook, groups: baseGroups, profile: { config: off }, coverBuf: null, token: null });
  assert.equal(pageCount(bufOn), pageCount(bufOff) + 1);
});

test('firstChapterOnRecto schiebt Leerseite ein, wenn das erste Kapitel sonst auf Verso landet', async () => {
  // Kein Cover, keine TOC → nur Titelseite (Recto idx0). Ohne Padding beginnt der
  // Body auf Seite 2 (Verso); mit firstChapterOnRecto wird eine Leerseite davor
  // eingeschoben → +1 Seite. Andere Paritätsregeln aus.
  const on = parityOff(defaultConfig());
  on.cover.enabled = false;
  on.toc.enabled = false;
  on.chapter.firstChapterOnRecto = true;
  const off = parityOff(defaultConfig());
  off.cover.enabled = false;
  off.toc.enabled = false;
  off.chapter.firstChapterOnRecto = false;
  const bufOn = await renderPdfBuffer({ book: baseBook, groups: baseGroups, profile: { config: on }, coverBuf: null, token: null });
  const bufOff = await renderPdfBuffer({ book: baseBook, groups: baseGroups, profile: { config: off }, coverBuf: null, token: null });
  assert.equal(pageCount(bufOn), pageCount(bufOff) + 1);
});

test('imprintOnVerso schiebt Leerseite ein, wenn das Impressum sonst auf Recto landet', async () => {
  // Mit Cover (idx0 Recto) landet die Titelseite auf Verso (idx1) und das
  // Frontmatter-Impressum sonst auf Recto (idx2). Mit imprintOnVerso wird eine
  // Leerseite davor eingeschoben → +1 Seite. Andere Paritätsregeln aus.
  const sharp = (await import('sharp')).default;
  const coverBuf = await sharp({ create: { width: 20, height: 30, channels: 3, background: '#ffffff' } })
    .jpeg().toBuffer();
  const on = parityOff(defaultConfig());
  on.cover.enabled = true;
  on.toc.enabled = false;
  on.extras.imprint = '© 2026';
  on.extras.imprintOnVerso = true;
  const off = parityOff(defaultConfig());
  off.cover.enabled = true;
  off.toc.enabled = false;
  off.extras.imprint = '© 2026';
  off.extras.imprintOnVerso = false;
  const bufOn = await renderPdfBuffer({ book: baseBook, groups: baseGroups, profile: { config: on }, coverBuf, token: null });
  const bufOff = await renderPdfBuffer({ book: baseBook, groups: baseGroups, profile: { config: off }, coverBuf, token: null });
  assert.equal(pageCount(bufOn), pageCount(bufOff) + 1);
});

test('showFooter/HeaderOnChapterEnd=false unterdrückt nur Chrome, keine Ghost-Pages', async () => {
  // Kapitel-Endseiten-Chrome abschalten darf die Seitenanzahl nicht verändern
  // (nur Footer/Header der letzten Kapitelseite entfallen). Regressionsguard
  // gegen die chapterEndSet-Berechnung im Header/Footer-Pass.
  const on = parityOff(defaultConfig());
  on.cover.enabled = false;
  const off = parityOff(defaultConfig());
  off.cover.enabled = false;
  off.layout.showFooterOnChapterEnd = false;
  off.layout.showHeaderOnChapterEnd = false;
  const bufOn = await renderPdfBuffer({ book: baseBook, groups: baseGroups, profile: { config: on }, coverBuf: null, token: null });
  const bufOff = await renderPdfBuffer({ book: baseBook, groups: baseGroups, profile: { config: off }, coverBuf: null, token: null });
  assert.equal(bufOff.slice(0, 5).toString(), '%PDF-');
  assert.equal(pageCount(bufOn), pageCount(bufOff));
});

test('Manuell hinzugefügte Nicht-Kapitel-Seite beginnt auf eigener Seite (wie ein Kapitel)', async () => {
  // Regression: eine Custom-Seite (chapter_id null, z.B. Nachwort) am Buchende
  // floss frueher inline in die letzte Kapitelseite und landete bei mirrorMargins
  // auf der falschen Buchseite (Bundsteg-Kante gespiegelt → «Ränder falsch»). Sie
  // muss denselben Top-Level-Seitenumbruch wie ein Kapitel bekommen.
  const shortHtml = '<p>' + 'Kurzer Text. '.repeat(8) + '</p>';
  const chap = { chapter: { id: 1, name: 'Kapitel' }, pages: [{ p: { id: 1, name: 'A' }, pd: { html: shortHtml } }] };
  const standaloneEnd = { chapter: null, pages: [{ p: { id: 9, name: 'Nachwort' }, pd: { html: shortHtml } }] };
  const chapEnd = { chapter: { id: 2, name: 'Nachwort' }, pages: [{ p: { id: 2, name: 'B' }, pd: { html: shortHtml } }] };

  function cfg() {
    const c = parityOff(defaultConfig());
    c.cover.enabled = false;
    c.toc.enabled = false;
    c.layout.mirrorMargins = true;
    return c;
  }
  const onlyChap    = await renderPdfBuffer({ book: baseBook, groups: [chap],              profile: { config: cfg() }, coverBuf: null, token: null });
  const withCustom  = await renderPdfBuffer({ book: baseBook, groups: [chap, standaloneEnd], profile: { config: cfg() }, coverBuf: null, token: null });
  const withChapter = await renderPdfBuffer({ book: baseBook, groups: [chap, chapEnd],      profile: { config: cfg() }, coverBuf: null, token: null });

  assert.equal(withCustom.slice(0, 5).toString(), '%PDF-');
  // Custom-Seite erzwingt eine eigene Seite (nicht inline in die Kapitelseite gemergt).
  assert.equal(pageCount(withCustom), pageCount(onlyChap) + 1, 'Custom-Seite muss eine eigene Seite bekommen');
  // Strukturell identisch zu «Kapitel am Ende» → gleicher Satzspiegel/Recto-Verso.
  assert.equal(pageCount(withCustom), pageCount(withChapter), 'Custom-Seite muss wie ein Kapitel auf eigener Seite starten');
});

// ── Quellenverzeichnis (lib/bibliography.js) ─────────────────────────────────
// Die synthetische Gruppe hinter den Buchkapiteln muss wie ein Kapitel behandelt
// werden: eigene Seite, Outline-/TOC-Eintrag, unnummeriert. Und sie darf nur beim
// ganzen Buch erscheinen.

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

function bibCfg() {
  const c = parityOff(defaultConfig());
  c.cover.enabled = false;
  return c;
}

test('Quellenverzeichnis hängt als eigenes Kapitel mit Outline-Eintrag hinten an', async () => {
  const withBib = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: bibCfg() },
    coverBuf: null, token: null, scope: 'book', bibliography: bibFixture,
  });
  const withoutBib = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: bibCfg() },
    coverBuf: null, token: null, scope: 'book',
    bibliography: { ...bibFixture, enabled: false },
  });
  assert.equal(withBib.slice(0, 5).toString(), '%PDF-');
  // Eigene Seite (breakBefore='always' greift wie bei jedem Top-Level-Kapitel).
  assert.equal(pageCount(withBib), pageCount(withoutBib) + 1);
  // Titel steht als PDF-Outline-Eintrag im Dokument (ASCII-Literal-String).
  assert.ok(withBib.toString('binary').includes('Quellenverzeichnis'), 'Verzeichnistitel fehlt im PDF');
  assert.equal(withoutBib.toString('binary').includes('Quellenverzeichnis'), false);
});

test('Quellenverzeichnis erscheint nur bei scope=book', async () => {
  const bookScope = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: bibCfg() },
    coverBuf: null, token: null, scope: 'book', bibliography: bibFixture,
  });
  const chapterScope = await renderPdfBuffer({
    book: baseBook, groups: baseGroups, profile: { config: bibCfg() },
    coverBuf: null, token: null, scope: 'chapter', chapter: { id: 1, name: 'Eins' },
    bibliography: bibFixture,
  });
  assert.ok(bookScope.toString('binary').includes('Quellenverzeichnis'));
  assert.equal(chapterScope.toString('binary').includes('Quellenverzeichnis'), false);
});

test('Quellen-Chip im Seitentext bekommt den frisch formatierten Kurzbeleg', async () => {
  // Der gespeicherte Chip-Text ist ein Cache vom Einfüge-Zeitpunkt; im
  // numerischen Stil steht dort noch die Autor-Jahr-Form. Der Renderer muss ihn
  // vor dem Walker durch «[1, S. 44]» ersetzen — sonst steht im PDF ein falscher
  // Kurzbeleg neben einem numerischen Verzeichnis.
  const chip = '<span class="cite" data-src="7" data-loc="44">(Kafka, 1915, S. 44)</span>';
  const groups = [{ chapter: { id: 1, name: 'Eins' }, pages: [
    { p: { id: 1, name: 'A' }, pd: { html: `<p>Ein Satz ${chip} und weiter.</p>` } },
  ]}];
  const cfg = bibCfg();
  cfg.toc.enabled = false;
  // Ohne Silbentrennung/Ligaturen bleibt der Text als zusammenhängendes
  // Fragment im Content-Stream messbar.
  cfg.layout.hyphenate = false;
  const buf = await renderPdfBuffer({
    book: baseBook, groups, profile: { config: cfg },
    coverBuf: null, token: null, scope: 'book', bibliography: bibFixture,
  });
  assert.equal(buf.slice(0, 5).toString(), '%PDF-');
  // Der Kurzbeleg ist Teil des Fliesstext-Fragments; die Autor-Jahr-Form darf
  // nicht mehr im Dokument stehen. Geprüft am gerenderten Text via pdf-extract.
  const { extractPdfText } = (await import('../../lib/pdf-extract.js')).default;
  const text = (await extractPdfText(buf)).text.replace(/\s+/g, ' ');
  assert.ok(text.includes('[1, S. 44]'), `Kurzbeleg nicht ersetzt: ${text.slice(0, 300)}`);
  assert.equal(text.includes('(Kafka, 1915, S. 44)'), false);
});

// ── Anmerkungsapparat (lib/endnotes.js) ──────────────────────────────────────
// Im Modus `citation_notes='endnotes'` traegt der Chip die Notenziffer statt der
// Klammerform, und hinter jedem Kapitel steht dessen Notenliste. Die beiden
// Belegdarstellungen duerfen sich nie ueberlagern.

test('Anmerkungsmodus: Notenziffer im Text, Notenliste hinter dem Kapitel', async () => {
  const chip = (loc) => `<span class="cite" data-src="7" data-loc="${loc}">(Kafka, 1915)</span>`;
  const groups = [
    { chapter: { id: 1, name: 'Erstes Kapitel', parent_chapter_id: null }, chapterId: 1,
      pages: [{ p: { id: 1, name: 'S1' }, pd: { html: `<p>Ein Satz ${chip('44')} und noch einer ${chip('51')}.</p>` } }] },
    { chapter: { id: 2, name: 'Zweites Kapitel', parent_chapter_id: null }, chapterId: 2,
      pages: [{ p: { id: 2, name: 'S2' }, pd: { html: `<p>Anderes Kapitel ${chip('7')}.</p>` } }] },
  ];
  const cfg = bibCfg();
  cfg.toc.enabled = false;
  cfg.layout.hyphenate = false;
  const buf = await renderPdfBuffer({
    book: baseBook, groups, profile: { config: cfg },
    coverBuf: null, token: null, scope: 'book',
    bibliography: { ...bibFixture, notesMode: 'endnotes', notesTitle: 'Anmerkungen', enabled: false, entries: [] },
  });
  const { extractPdfText } = (await import('../../lib/pdf-extract.js')).default;
  const text = (await extractPdfText(buf)).text.replace(/\s+/g, ' ');

  // Klammerform ist verschwunden — der Chip traegt jetzt die Ziffer.
  assert.equal(text.includes('(Kafka, 1915, S. 44)'), false, `Klammerform noch da: ${text.slice(0, 400)}`);
  // Apparat steht hinter JEDEM Kapitel, mit Ueberschrift.
  assert.ok(text.split('Anmerkungen').length - 1 >= 2, `Apparat fehlt bei einem Kapitel: ${text.slice(0, 600)}`);
  // Erstnennung voll, Wiederholung als „Ebd." — und pro Kapitel neu ab 1, darum
  // steht die Vollform zweimal im Dokument (einmal je Kapitel).
  assert.ok(text.includes('Ebd.'), `Wiederholungs-Kurzform fehlt: ${text.slice(0, 600)}`);
  assert.ok(text.split('Die Verwandlung').length - 1 >= 2, 'Erstnennung muss pro Kapitel voll stehen');
});

// ── Seite als Strukturelement ────────────────────────────────────────────────
// Die BookStack-Seite traegt im Default eine eigene Ueberschrift (h4, vierte
// Stufe unter den drei Kapitelebenen), einen eigenen Seitenumbruch und einen
// eigenen Verzeichnis-Eintrag. Pendant im Word-Export:
// tests/unit/docx-export.test.mjs.

// Outline-Titel liegen als unkomprimierte ASCII-Literal-Strings im PDF (siehe
// die Verzeichnis-Tests weiter oben) — darum sind sie zaehlbar.
function occurrences(buf, needle) {
  return buf.toString('binary').split(needle).length - 1;
}

function structCfg(over = {}) {
  const cfg = parityOff(defaultConfig());
  cfg.cover.enabled = false;
  cfg.toc.enabled = false;
  Object.assign(cfg.chapter, over);
  return cfg;
}

const oneShortPage = '<p>Kurzer Absatz.</p>';

test('nested: einseitiges Kapitel bekommt trotzdem einen eigenen Seitentitel', async () => {
  const groups = [{ chapter: { id: 7, name: 'Anhang' }, pages: [
    { p: { id: 70, name: 'Danksagung' }, pd: { html: oneShortPage } },
  ]}];
  const nested = await renderPdfBuffer({
    book: baseBook, groups, profile: { config: structCfg({ pageStructure: 'nested' }) },
    coverBuf: null, token: null, scope: 'book',
  });
  const flat = await renderPdfBuffer({
    book: baseBook, groups, profile: { config: structCfg({ pageStructure: 'flatten' }) },
    coverBuf: null, token: null, scope: 'book',
  });
  // Kein `pages.length > 1`-Vorbehalt mehr: der Seitentitel steht als
  // Lesezeichen im Dokument, im flatten-Modus nicht.
  assert.ok(occurrences(nested, 'Danksagung') > 0, 'Seitentitel fehlt als Outline-Eintrag');
  assert.equal(occurrences(flat, 'Danksagung'), 0);
});

test('nested: Seitenname gleich Kapitelname → keine doppelte Ueberschrift', async () => {
  const groups = [{ chapter: { id: 8, name: 'Nachwort' }, pages: [
    { p: { id: 80, name: 'Nachwort' }, pd: { html: oneShortPage } },
  ]}];
  const buf = await renderPdfBuffer({
    book: baseBook, groups, profile: { config: structCfg({ pageStructure: 'nested' }) },
    coverBuf: null, token: null, scope: 'book',
  });
  // Genau ein Lesezeichen — der Kapiteltitel. Der gleichnamige Seitentitel
  // stuende unmittelbar darunter und wird unterdrueckt.
  assert.equal(occurrences(buf, 'Nachwort'), 1);
});

test('pageBreakBetweenPages: jede Folgeseite beginnt auf einer neuen PDF-Seite', async () => {
  const groups = [{ chapter: { id: 9, name: 'Eins' }, pages: [
    { p: { id: 91, name: 'A' }, pd: { html: oneShortPage } },
    { p: { id: 92, name: 'B' }, pd: { html: oneShortPage } },
    { p: { id: 93, name: 'C' }, pd: { html: oneShortPage } },
  ]}];
  const withBreak = await renderPdfBuffer({
    book: baseBook, groups, profile: { config: structCfg({ pageStructure: 'nested', pageBreakBetweenPages: true }) },
    coverBuf: null, token: null, scope: 'book',
  });
  const noBreak = await renderPdfBuffer({
    book: baseBook, groups, profile: { config: structCfg({ pageStructure: 'nested', pageBreakBetweenPages: false }) },
    coverBuf: null, token: null, scope: 'book',
  });
  // Zwei Folgeseiten → zwei zusaetzliche PDF-Seiten.
  assert.equal(pageCount(withBreak), pageCount(noBreak) + 2);
});

test('TOC: includePages listet die Seiten und ist getrennt von toc.depth abschaltbar', async () => {
  // Genug Seiten, damit die zusaetzlichen Verzeichnis-Zeilen eine weitere
  // TOC-Seite fuellen — der Body ist in beiden Laeufen identisch, das
  // Seiten-Delta stammt also allein aus dem Verzeichnis.
  const pages = Array.from({ length: 40 }, (_, i) => ({
    p: { id: 200 + i, name: `Seite ${i + 1}` }, pd: { html: oneShortPage },
  }));
  const groups = [{ chapter: { id: 11, name: 'Eins' }, pages }];
  const cfgFor = (includePages) => {
    const cfg = structCfg({ pageStructure: 'nested', pageBreakBetweenPages: false });
    cfg.toc.enabled = true;
    cfg.toc.includePages = includePages;
    return cfg;
  };
  const withPages = await renderPdfBuffer({
    book: baseBook, groups, profile: { config: cfgFor(true) }, coverBuf: null, token: null, scope: 'book',
  });
  const withoutPages = await renderPdfBuffer({
    book: baseBook, groups, profile: { config: cfgFor(false) }, coverBuf: null, token: null, scope: 'book',
  });
  assert.ok(pageCount(withPages) > pageCount(withoutPages),
    'Verzeichnis mit Seiten-Eintraegen muss mehr Platz brauchen');
});

test('tocEntryVisible: Kapitel haengen an toc.depth, Seiten an includePages', () => {
  const chapter = (level) => ({ level });
  const page = (parentLevel) => ({ isPage: true, level: parentLevel + 1, parentLevel });

  // Kapitelebenen: depth schneidet ab.
  assert.equal(tocEntryVisible(chapter(0), { depth: 1, includePages: true }), true);
  assert.equal(tocEntryVisible(chapter(1), { depth: 1, includePages: true }), false);
  assert.equal(tocEntryVisible(chapter(2), { depth: 3, includePages: true }), true);

  // Seiten: eigene Achse — eine Seite im Sub-Sub-Kapitel (Einrueckungsebene 3)
  // bleibt sichtbar, obwohl sie jede erlaubte Kapiteltiefe ueberschreitet.
  assert.equal(tocEntryVisible(page(2), { depth: 3, includePages: true }), true);
  assert.equal(tocEntryVisible(page(0), { depth: 3, includePages: false }), false);

  // ... aber nie ohne ihr Kapitel: wird das Sub-Kapitel weggeschnitten, faellt
  // seine Seite mit.
  assert.equal(tocEntryVisible(page(1), { depth: 1, includePages: true }), false);
  assert.equal(tocEntryVisible(page(0), { depth: 1, includePages: true }), true);
});

test('Autoren-Ueberschrift im Seitentext laeuft auf h5/h6, nicht auf der Kapitelskala', async () => {
  // Der Content-Stream ist komprimiert, die Font-Groesse also nicht direkt
  // lesbar. Gemessen wird stattdessen der PLATZ: 20 Autoren-Ueberschriften auf
  // 60 pt brauchen deutlich mehr Seiten als auf 8 pt. Verglichen wird jeweils
  // derselbe Modus mit nur EINEM geaenderten Wert — so isoliert der Test die
  // Verdrahtung und nicht den Modus-Unterschied.
  const html = '<h1>Ueberschrift</h1><p>Text.</p>'.repeat(20);
  const groups = [{ chapter: { id: 31, name: 'Kap' }, pages: [
    { p: { id: 310, name: 'Beitrag' }, pd: { html } },
  ]}];
  const pagesFor = async (pageStructure, sizes) => {
    const cfg = structCfg({ pageStructure });
    Object.assign(cfg.font.heading.sizes, sizes);
    const buf = await renderPdfBuffer({
      book: baseBook, groups, profile: { config: cfg }, coverBuf: null, token: null, scope: 'book',
    });
    return pageCount(buf);
  };

  // nested: der Beitrag hat einen gezeichneten Seitentitel → h5 regiert die
  // Autoren-Ueberschriften. Wird h5 gross, wird das Dokument dicker.
  const nestedSmall = await pagesFor('nested', { h1: 60, h5: 8, h6: 8 });
  const nestedBig   = await pagesFor('nested', { h1: 60, h5: 44, h6: 44 });
  assert.ok(nestedBig > nestedSmall,
    `h5 muss im nested-Modus wirken (klein=${nestedSmall}, gross=${nestedBig})`);

  // Der Gegenprobe-Weg laeuft ueber h5, nicht ueber h1: h1 setzt zugleich den
  // KAPITELTITEL und veraendert die Seitenzahl darum auch dann, wenn die
  // Autoren-Ueberschrift ihn ignoriert. Die Aussage „h1 regiert hier nicht"
  // wird deshalb unten im flatten-Zweig von der anderen Seite geprueft.

  // flatten: kein Seitentitel davor → die Autoren-Ueberschrift ist die oberste
  // Marke im Fluss und haengt an h1, nicht an h5.
  const flatSmall = await pagesFor('flatten', { h1: 12, h5: 8, h6: 8 });
  const flatBig   = await pagesFor('flatten', { h1: 60, h5: 8, h6: 8 });
  assert.ok(flatBig > flatSmall,
    `h1 muss im flatten-Modus wirken (klein=${flatSmall}, gross=${flatBig})`);
  const flatBigH5 = await pagesFor('flatten', { h1: 12, h5: 44, h6: 44 });
  assert.equal(flatSmall, flatBigH5,
    `h5 darf im flatten-Modus nicht wirken (${flatSmall} vs ${flatBigH5})`);
});
