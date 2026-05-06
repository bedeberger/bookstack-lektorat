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
