// Nummerierung der Querverweise — pure Logik, kein DOM, keine DB.
import test from 'node:test';
import assert from 'node:assert';

import {
  defaultChapterLabels, anchorNumbers, buildXrefNumbers,
} from '../../public/js/xrefs/xref-number.js';
import {
  formatXref, figureCaptionPrefix, tableCaptionPrefix, captionPrefix,
} from '../../public/js/xrefs/xref-format.js';

const CHAPTERS = [
  { chapterId: 10, depth: 1, title: 'Anfang' },
  { chapterId: 11, depth: 2, title: 'Erstes Unterkapitel' },
  { chapterId: 12, depth: 2, title: 'Zweites Unterkapitel' },
  { chapterId: 13, depth: 1, title: 'Mitte' },
  { chapterId: 14, depth: 2, title: 'Wieder tiefer' },
];

test('defaultChapterLabels zaehlt nested und setzt tiefere Zaehler zurueck', () => {
  const l = defaultChapterLabels(CHAPTERS);
  assert.equal(l.get('10'), '1');
  assert.equal(l.get('11'), '1.1');
  assert.equal(l.get('12'), '1.2');
  assert.equal(l.get('13'), '2');
  // Der Unterkapitel-Zaehler startet unter Kapitel 2 neu — nicht bei 1.3.
  assert.equal(l.get('14'), '2.1');
});

test('unnummerierte Kapitel bekommen kein Label und verbrauchen keine Nummer', () => {
  const l = defaultChapterLabels([
    { chapterId: 1, depth: 1 },
    { chapterId: 2, depth: 1, unnumbered: true },
    { chapterId: 3, depth: 1 },
  ]);
  assert.equal(l.get('1'), '1');
  assert.equal(l.has('2'), false);
  assert.equal(l.get('3'), '2');
});

test('Abbildungen zaehlen kapitelweise: Praefix = Kapitelnummer, Zaehler startet neu', () => {
  const labels = defaultChapterLabels(CHAPTERS);
  const nums = anchorNumbers([
    { bid: 'a1', chapterId: 10 },
    { bid: 'a2', chapterId: 10 },
    { bid: 'b1', chapterId: 11 },
    { bid: 'c1', chapterId: 13 },
  ], labels);
  assert.equal(nums.get('a1'), '1.1');
  assert.equal(nums.get('a2'), '1.2');
  assert.equal(nums.get('b1'), '1.1.1');
  assert.equal(nums.get('c1'), '2.1');
});

test('eine Abbildung ohne Kapitel-Label kippt die GANZE Einheit auf buchweite Zaehlung', () => {
  // Warum: sonst stuenden „3.2" und „7" im selben Dokument nebeneinander und die
  // Nummernfolge waere fuer den Leser nicht mehr nachvollziehbar.
  const labels = defaultChapterLabels(CHAPTERS);
  const nums = anchorNumbers([
    { bid: 'a1', chapterId: 10 },
    { bid: 'a2', chapterId: 10 },
    { bid: 'x1', chapterId: null },
  ], labels);
  assert.deepEqual([...nums.values()], ['1', '2', '3']);
});

test('Kapitel-Labels aus dem Render-Pfad schlagen die Vorgabe (roemisches Profil)', () => {
  // Der PDF-Renderer reicht seine eigenen Labels herein; der Verweis MUSS sie
  // uebernehmen, sonst sagt der Text „Kapitel 3" und die Ueberschrift „III".
  const fromPdf = new Map([['10', 'III'], ['11', 'III.1']]);
  const { chapter, figure } = buildXrefNumbers({
    chapters: CHAPTERS,
    anchors: [{ bid: 'a1', chapterId: 10, caption: 'Der Kaefer' }],
    chapterLabels: fromPdf,
  });
  assert.equal(chapter.get('10').number, 'III');
  assert.equal(figure.get('a1').number, 'III.1');
  // Kapitel ohne Eintrag in der Profil-Map haben keine Nummer.
  assert.equal(chapter.get('13').number, null);
});

test('formatXref: Anzeigeformen', () => {
  const entry = { number: '3.2', title: 'Der Kaefer' };
  assert.equal(formatXref({ kind: 'figure', fmt: 'label', entry }), 'Abb. 3.2');
  assert.equal(formatXref({ kind: 'figure', fmt: 'number', entry }), '3.2');
  assert.equal(formatXref({ kind: 'figure', fmt: 'title', entry }), 'Abb. 3.2: Der Kaefer');
  assert.equal(formatXref({ kind: 'chapter', entry: { number: '3', title: 'X' } }), 'Kapitel 3');
  assert.equal(formatXref({ kind: 'chapter', entry: { number: '3', title: 'X' }, lang: 'en' }), 'Chapter 3');
});

test('formatXref faellt ohne Nummer auf den Titel zurueck und meldet Verwaiste mit null', () => {
  // Ohne Kapitel-Nummerierung im Profil gibt es keine Zahl, auf die man zeigen
  // koennte — „siehe Kapitel " waere kaputt.
  assert.equal(formatXref({ kind: 'chapter', entry: { number: null, title: 'Die Verwandlung' } }), '„Die Verwandlung“');
  // null heisst „nicht aufloesbar"; der Aufrufer laesst den Text des Autors stehen.
  assert.equal(formatXref({ kind: 'chapter', entry: null }), null);
  assert.equal(formatXref({ kind: 'chapter', entry: { number: null, title: '' } }), null);
});

test('figureCaptionPrefix nur mit Nummer', () => {
  assert.equal(figureCaptionPrefix('3.2', 'de'), 'Abb. 3.2: ');
  assert.equal(figureCaptionPrefix('3.2', 'en'), 'Fig. 3.2: ');
  assert.equal(figureCaptionPrefix(null, 'de'), '');
});

// ── Tabellen ────────────────────────────────────────────────────────────────

test('Abbildungen und Tabellen zaehlen GETRENNT', () => {
  // Die Konvention im Sach- und Fachbuch: „Abb. 1.1" und „Tab. 1.1" stehen
  // nebeneinander. Ein gemeinsamer Zaehler machte aus der ersten Tabelle eines
  // Kapitels „Tab. 1.3", nur weil davor zwei Abbildungen stehen.
  const { figure, table } = buildXrefNumbers({
    chapters: CHAPTERS,
    anchors: [
      { kind: 'figure', bid: 'f1', chapterId: 10, caption: 'Bild eins' },
      { kind: 'figure', bid: 'f2', chapterId: 10, caption: 'Bild zwei' },
      { kind: 'table', bid: 't1', chapterId: 10, caption: 'Erste Tabelle' },
      { kind: 'table', bid: 't2', chapterId: 10, caption: 'Zweite Tabelle' },
    ],
  });
  assert.equal(figure.get('f1').number, '1.1');
  assert.equal(figure.get('f2').number, '1.2');
  assert.equal(table.get('t1').number, '1.1', 'die erste Tabelle ist 1.1, nicht 1.3');
  assert.equal(table.get('t2').number, '1.2');
});

test('Anker ohne kind gelten als Abbildung (Altdaten)', () => {
  const { figure, table } = buildXrefNumbers({
    chapters: CHAPTERS,
    anchors: [{ bid: 'alt', chapterId: 10, caption: 'Alt' }],
  });
  assert.equal(figure.get('alt').number, '1.1');
  assert.equal(table.size, 0);
});

test('die buchweite Rueckfallebene faellt PRO TYP', () => {
  // Eine Abbildung ohne Kapitel-Label darf die Tabellen nicht mitziehen: deren
  // Nummernfolge ist in sich schluessig und bleibt kapitelweise.
  const { figure, table } = buildXrefNumbers({
    chapters: CHAPTERS,
    anchors: [
      { kind: 'figure', bid: 'f1', chapterId: 10 },
      { kind: 'figure', bid: 'fx', chapterId: null },
      { kind: 'table', bid: 't1', chapterId: 10 },
      { kind: 'table', bid: 't2', chapterId: 13 },
    ],
  });
  assert.equal(figure.get('f1').number, '1', 'Abbildungen kippen auf buchweit');
  assert.equal(figure.get('fx').number, '2');
  assert.equal(table.get('t1').number, '1.1', 'Tabellen bleiben kapitelweise');
  assert.equal(table.get('t2').number, '2.1');
});

test('Beschriftungs-Praefix pro Typ und Sprache', () => {
  assert.equal(captionPrefix('table', '3.2', 'de'), 'Tab. 3.2: ');
  assert.equal(captionPrefix('table', '3.2', 'en'), 'Tab. 3.2: ');
  assert.equal(captionPrefix('figure', '3.2', 'de'), 'Abb. 3.2: ');
  assert.equal(tableCaptionPrefix('1.1', 'de'), 'Tab. 1.1: ');
  assert.equal(tableCaptionPrefix(null, 'de'), '');
  assert.equal(figureCaptionPrefix('1.1', 'en'), 'Fig. 1.1: ');
});

test('formatXref kennt den Tabellen-Typ', () => {
  const entry = { number: '3.2', title: 'Umsatz nach Jahr' };
  assert.equal(formatXref({ kind: 'table', entry, lang: 'de' }), 'Tab. 3.2');
  assert.equal(formatXref({ kind: 'table', fmt: 'number', entry, lang: 'de' }), '3.2');
  assert.equal(formatXref({ kind: 'table', fmt: 'title', entry, lang: 'de' }),
    'Tab. 3.2: Umsatz nach Jahr');
});

test('Tabelle ohne Nummer faellt auf die Beschriftung zurueck', () => {
  // Nummerierung im Buch ausgeschaltet: der Verweis darf keine Zahl nennen, die
  // nirgends steht.
  assert.equal(formatXref({ kind: 'table', entry: { number: null, title: 'Umsatz' }, lang: 'de' }),
    '„Umsatz“');
});
