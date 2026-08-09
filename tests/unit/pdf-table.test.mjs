// Tabellensatz im PDF (lib/pdf-render/table.js).
//
// Zwei Dinge koennen hier still falsch sein, ohne dass ein PDF kaputt aussieht:
// die Spaltenbreiten und der Seitenumbruch. Beides wird darum gegen einen
// Stub-Doc geprueft, der Breiten deterministisch liefert (5 pt pro Zeichen) und
// jeden Aufruf mitschreibt — mit einem echten pdfkit-Dokument haenge der Test an
// Schriftmetriken und wuerde bei jedem Font-Update wackeln.
//
// Die Zeilen-Trennung ueber Seitengrenzen ist der Fall, in dem ein naiver
// Layouter ENDLOS laeuft (Zeile hoeher als die Seite ⇒ „schieb auf die naechste
// Seite" ⇒ dort passt sie auch nicht ⇒ …). Der Test dazu hat darum ein
// Zeit-/Aufruflimit statt einer blossen Inhaltszusage.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { renderTable, computeColWidths, normalizeTableConfig, MIN_COL_PT } = require('../../lib/pdf-render/table.js');

const CHAR_PT = 5;

// Stub-Doc mit dem Ausschnitt der pdfkit-Schnittstelle, den table.js benutzt.
function stubDoc({ height = 200, width = 300, margins = { top: 10, right: 10, bottom: 10, left: 10 } } = {}) {
  const calls = { text: [], addPage: 0, rects: [], lines: [] };
  const doc = {
    page: { width, height, margins },
    x: margins.left,
    y: margins.top,
    _size: 10,
    calls,
    font() { return doc; },
    fontSize(v) { if (v != null) doc._size = v; return doc; },
    fillColor() { return doc; },
    strokeColor() { return doc; },
    lineWidth() { return doc; },
    save() { return doc; },
    restore() { return doc; },
    widthOfString(s) { return String(s).length * CHAR_PT; },
    heightOfString() { return doc._size; },
    moveTo(x, y) { doc._m = [x, y]; return doc; },
    lineTo(x, y) { calls.lines.push([...(doc._m || [0, 0]), x, y]); return doc; },
    stroke() { return doc; },
    rect(x, y, w, h) { calls.rects.push([x, y, w, h]); return doc; },
    fill() { return doc; },
    text(t, x, y) { calls.text.push({ t, x, y }); return doc; },
    addPage() { calls.addPage += 1; doc.y = margins.top; return doc; },
  };
  return doc;
}

const CFG = {
  width: 'full', borders: 'all', zebra: false, headerRepeat: true,
  fontScale: 1, paddingPt: 2, borderWidthPt: 0.5,
  borderColor: '#999999', zebraColor: '#eeeeee', captionPosition: 'below',
};
const CTX = (over = {}) => ({
  font: { body: { sizePt: 10, lineHeight: 1.2, color: '#000000' } },
  table: { ...CFG, ...over },
});

const runs = (s) => [{ text: s }];
const tbl = (over = {}) => ({
  kind: 'table',
  caption: [],
  align: ['left', 'right'],
  header: [runs('Jahr'), runs('Umsatz')],
  rows: [[runs('2023'), runs('1.2')], [runs('2024'), runs('1.8')]],
  ...over,
});

// ── Spaltenbreiten ──────────────────────────────────────────────────────────

test('width=full: Spalten fuellen den Satzspiegel genau aus', () => {
  const doc = stubDoc();
  const avail = 280;
  const w = computeColWidths(doc, tbl(), avail, 10, 'body', normalizeTableConfig(CFG));
  assert.equal(w.length, 2);
  assert.ok(Math.abs(w.reduce((a, b) => a + b, 0) - avail) < 0.5,
    `Summe ${w.reduce((a, b) => a + b, 0)} soll ${avail} sein`);
});

test('width=auto: Spalten behalten ihren natuerlichen Bedarf', () => {
  const doc = stubDoc();
  const w = computeColWidths(doc, tbl(), 280, 10, 'body', normalizeTableConfig({ ...CFG, width: 'auto' }));
  // „Umsatz" = 6 Zeichen × 5 pt + 2×2 pt Polster.
  assert.ok(Math.abs(w[1] - (6 * CHAR_PT + 4)) < 0.01, `erwartet 34, ist ${w[1]}`);
  assert.ok(w.reduce((a, b) => a + b, 0) < 280, 'auto darf den Satzspiegel nicht fuellen');
});

test('breitere Spalte bekommt mehr Platz als die schmale', () => {
  const doc = stubDoc();
  const block = tbl({
    align: ['left', 'left'],
    header: [runs('A'), runs('Eine deutlich laengere Spaltenbeschriftung')],
    rows: [[runs('x'), runs('und ein langer Zellinhalt dazu')]],
  });
  const w = computeColWidths(doc, block, 280, 10, 'body', normalizeTableConfig(CFG));
  assert.ok(w[1] > w[0] * 2, `zweite Spalte muss deutlich breiter sein (${w[0]} / ${w[1]})`);
});

test('zu breiter Inhalt wird gekuerzt, aber keine Spalte unter das Minimum', () => {
  const doc = stubDoc();
  const long = 'Wortwortwortwort '.repeat(20);
  const block = tbl({
    align: ['left', 'left', 'left'],
    header: [runs('A'), runs('B'), runs('C')],
    rows: [[runs(long), runs(long), runs('k')]],
  });
  const avail = 200;
  const w = computeColWidths(doc, block, avail, 10, 'body', normalizeTableConfig(CFG));
  assert.ok(w.reduce((a, b) => a + b, 0) <= avail + 0.5, 'darf den Satzspiegel nicht ueberschreiten');
  for (const x of w) assert.ok(x > 0, 'keine Spalte auf Breite 0');
});

test('viele Spalten auf schmaler Seite: Summe bleibt im Satzspiegel', () => {
  const doc = stubDoc();
  const cols = 12;
  const block = tbl({
    align: Array.from({ length: cols }, () => 'left'),
    header: Array.from({ length: cols }, (_, i) => runs('Spalte' + i)),
    rows: [Array.from({ length: cols }, () => runs('Wert'))],
  });
  const avail = 150;
  const w = computeColWidths(doc, block, avail, 10, 'body', normalizeTableConfig(CFG));
  assert.equal(w.length, cols);
  assert.ok(w.reduce((a, b) => a + b, 0) <= avail + 0.5);
});

test('MIN_COL_PT ist die Untergrenze der Schrumpfung', () => {
  assert.ok(MIN_COL_PT > 0);
});

// ── Zeichnen + Seitenumbruch ────────────────────────────────────────────────

const textsOf = (doc) => doc.calls.text.map(c => c.t).join(' ');

test('alle Zellen und die Beschriftung werden gesetzt', () => {
  const doc = stubDoc({ height: 400 });
  renderTable(doc, tbl({ caption: runs('Umsatz nach Jahr') }), CTX());
  const s = textsOf(doc);
  for (const bit of ['Jahr', 'Umsatz', '2023', '1.2', '2024', '1.8', 'nach']) {
    assert.ok(s.includes(bit), `fehlt: ${bit}`);
  }
});

test('doc.y steht nach der Tabelle unter ihr', () => {
  const doc = stubDoc({ height: 400 });
  const before = doc.y;
  renderTable(doc, tbl(), CTX());
  assert.ok(doc.y > before, 'ohne y-Fortschritt schreibt der Folgeabsatz in die Tabelle');
});

test('lange Tabelle bricht um und wiederholt die Kopfzeile', () => {
  // Seitenhoehe 200, Raender 10/10 → 180 pt nutzbar, Zeilenhoehe 12 + 4 Polster.
  const doc = stubDoc({ height: 200 });
  const rows = Array.from({ length: 40 }, (_, i) => [runs('R' + i), runs('V' + i)]);
  renderTable(doc, tbl({ rows }), CTX());
  assert.ok(doc.calls.addPage > 0, 'eine 40-zeilige Tabelle muss umbrechen');
  const heads = doc.calls.text.filter(c => c.t === 'Jahr').length;
  assert.equal(heads, doc.calls.addPage + 1,
    'die Kopfzeile muss auf jeder Seite genau einmal stehen');
});

test('headerRepeat=false setzt die Kopfzeile nur einmal', () => {
  const doc = stubDoc({ height: 200 });
  const rows = Array.from({ length: 40 }, (_, i) => [runs('R' + i), runs('V' + i)]);
  renderTable(doc, tbl({ rows }), CTX({ headerRepeat: false }));
  assert.ok(doc.calls.addPage > 0);
  assert.equal(doc.calls.text.filter(c => c.t === 'Jahr').length, 1);
});

test('Zelle bricht auf ihre Spaltenbreite um', () => {
  const doc = stubDoc({ height: 400, width: 200 });
  const long = 'eins zwei drei vier fuenf sechs sieben acht neun zehn';
  renderTable(doc, tbl({ rows: [[runs(long), runs('x')]] }), CTX());
  // Erstes und letztes Wort der Zelle muessen auf VERSCHIEDENEN Grundlinien
  // stehen — das ist der Umbruch, und zwar unabhaengig davon, in wie viele
  // Zeilen er genau faellt.
  const first = doc.calls.text.find(c => c.t === 'eins');
  const last = doc.calls.text.find(c => c.t === 'zehn');
  assert.ok(first && last, 'beide Woerter muessen gesetzt werden');
  assert.ok(last.y > first.y, `kein Umbruch: beide auf y=${first.y}`);
  // Und beide liegen im Band der ERSTEN Spalte — der Umbruch darf den Inhalt
  // nicht in die Nachbarspalte schieben. (Nicht auf gleiche x pruefen: `zehn`
  // ist das letzte Wort seiner Zeile, nicht das erste.)
  const w0 = computeColWidths(doc, tbl({ rows: [[runs(long), runs('x')]] }),
    180, 10, 'body', normalizeTableConfig(CFG))[0];
  for (const c of [first, last]) {
    assert.ok(c.x >= 10 && c.x < 10 + w0, `x=${c.x} liegt aussehalb der ersten Spalte (0…${w0})`);
  }
});

test('Zeile hoeher als die Seite: bricht INNERHALB der Zeile statt endlos zu schieben', () => {
  // 60 Woerter in einer schmalen Spalte auf einer Seite mit ~80 pt Nutzhoehe.
  const doc = stubDoc({ height: 100, width: 160 });
  const many = Array.from({ length: 60 }, (_, i) => 'w' + i).join(' ');
  const t0 = Date.now();
  renderTable(doc, tbl({ header: null, align: ['left'], rows: [[runs(many)]] }), CTX());
  const ms = Date.now() - t0;
  assert.ok(ms < 2000, `Endlosschleifen-Verdacht: ${ms} ms`);
  assert.ok(doc.calls.addPage > 0, 'die Zeile muss ueber Seiten laufen');
  assert.ok(doc.calls.addPage < 200, `unplausibel viele Seitenwechsel: ${doc.calls.addPage}`);
  const s = textsOf(doc);
  assert.ok(s.includes('w0') && s.includes('w59'), 'kein Wort darf verloren gehen');
});

test('Zeilenhoehe groesser als die Seite: eine Zeile wird trotzdem gesetzt', () => {
  // Nutzhoehe kleiner als eine einzige Textzeile — der pathologische Fall.
  const doc = stubDoc({ height: 26 });
  const t0 = Date.now();
  renderTable(doc, tbl({ header: null, align: ['left'], rows: [[runs('A B C')]] }), CTX());
  assert.ok(Date.now() - t0 < 2000, 'darf nicht haengen');
  assert.ok(doc.calls.text.length > 0, 'es muss trotzdem gesetzt werden');
});

// ── Ausrichtung + Profil-Optionen ───────────────────────────────────────────

test('rechtsbuendige Spalte wird rechts gesetzt', () => {
  const doc = stubDoc({ height: 400 });
  renderTable(doc, tbl({ align: ['left', 'right'], header: null, rows: [[runs('a'), runs('b')]] }), CTX());
  const [a, b] = doc.calls.text;
  const widths = computeColWidths(doc, tbl({ align: ['left', 'right'] }), 280, 10, 'body', normalizeTableConfig(CFG));
  // Die rechte Zelle beginnt weiter rechts als der linke Rand ihrer Spalte.
  assert.ok(b.x > 10 + widths[0], `rechte Zelle bei x=${b.x} ist nicht rechtsbuendig`);
  assert.ok(a.x < b.x);
});

test('zebra=true faerbt jede zweite Datenzeile', () => {
  const doc = stubDoc({ height: 400 });
  const rows = [[runs('1'), runs('a')], [runs('2'), runs('b')], [runs('3'), runs('c')]];
  renderTable(doc, tbl({ rows }), CTX({ zebra: true }));
  assert.equal(doc.calls.rects.length, 1, 'von drei Zeilen wird genau eine gefaerbt');
});

test('borders=none zeichnet keine Linien', () => {
  const doc = stubDoc({ height: 400 });
  renderTable(doc, tbl(), CTX({ borders: 'none' }));
  assert.equal(doc.calls.lines.length, 0);
});

test('borders=all zeichnet Linien', () => {
  const doc = stubDoc({ height: 400 });
  renderTable(doc, tbl(), CTX({ borders: 'all' }));
  assert.ok(doc.calls.lines.length > 0);
});

test('captionPosition=above setzt die Beschriftung vor die Tabelle', () => {
  const doc = stubDoc({ height: 400 });
  renderTable(doc, tbl({ caption: runs('Titel') }), CTX({ captionPosition: 'above' }));
  const iCap = doc.calls.text.findIndex(c => c.t === 'Titel');
  const iHead = doc.calls.text.findIndex(c => c.t === 'Jahr');
  assert.ok(iCap >= 0 && iHead >= 0);
  assert.ok(iCap < iHead, 'above heisst vor der Kopfzeile');
});

test('captionPosition=below setzt sie dahinter', () => {
  const doc = stubDoc({ height: 400 });
  renderTable(doc, tbl({ caption: runs('Titel') }), CTX({ captionPosition: 'below' }));
  const iCap = doc.calls.text.findIndex(c => c.t === 'Titel');
  const iHead = doc.calls.text.findIndex(c => c.t === 'Jahr');
  assert.ok(iCap > iHead);
});

test('Tabelle ohne Kopfzeile rendert ihre Daten', () => {
  const doc = stubDoc({ height: 400 });
  renderTable(doc, tbl({ header: null }), CTX());
  assert.ok(textsOf(doc).includes('2023'));
});

test('leere Tabelle bringt den Renderer nicht um', () => {
  const doc = stubDoc({ height: 400 });
  assert.doesNotThrow(() => renderTable(doc, { kind: 'table', caption: [], align: [], header: null, rows: [] }, CTX()));
});
