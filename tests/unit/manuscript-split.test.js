'use strict';

// Zerlegung eines importierten Dokuments nach Ueberschriften-Ebenen.
// Die Zuordnung h1..h6 -> Rolle ist die Konfiguration, um die es beim
// Manuskript-Import geht; Vorschau und Import teilen sich diese Funktion,
// darum haengt hier beides dran.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  splitManuscript, countHeadings, normalizeHeadingMap,
  serializeHeadingMap, parseHeadingMap, DEFAULT_HEADING_MAP, HEADING_ROLES,
} = require('../../lib/import-parsers/manuscript-split');

// Kompakte Gliederungs-Form fuer die Assertions.
function outline(nodes) {
  return nodes.map(n => (n.type === 'chapter'
    ? { c: n.name, k: outline(n.children) }
    : { p: n.name }));
}

test('Default-Zuordnung: h1 = Kapitel, h2 = Seite', () => {
  const r = splitManuscript(
    '<h1>Teil A</h1><h2>Eins</h2><p>x</p><h2>Zwei</h2><p>y</p><h1>Teil B</h1><h2>Drei</h2><p>z</p>',
  );
  assert.deepEqual(outline(r.nodes), [
    { c: 'Teil A', k: [{ p: 'Eins' }, { p: 'Zwei' }] },
    { c: 'Teil B', k: [{ p: 'Drei' }] },
  ]);
  assert.equal(r.chapterCount, 2);
  assert.equal(r.pageCount, 3);
  assert.deepEqual(r.warnings, []);
});

test('Zuordnung ist konfigurierbar: h1 = Kapitel, h2 = Unterkapitel, h3 = Seite', () => {
  const r = splitManuscript(
    '<h1>Buch</h1><h2>Teil</h2><h3>Kap</h3><p>x</p><h3>Kap2</h3><p>y</p>',
    { headingMap: { h1: 'chapter', h2: 'subchapter', h3: 'page' } },
  );
  assert.deepEqual(outline(r.nodes), [
    { c: 'Buch', k: [{ c: 'Teil', k: [{ p: 'Kap' }, { p: 'Kap2' }] }] },
  ]);
});

test('Rolle content laesst die Ueberschrift im Seitentext stehen', () => {
  const r = splitManuscript('<h1>K</h1><h2>Zwischentitel</h2><p>x</p>', {
    headingMap: { h1: 'chapter', h2: 'content' },
  });
  assert.equal(r.pageCount, 1);
  assert.match(r.nodes[0].children[0].html, /<h2>Zwischentitel<\/h2>/);
});

test('Ueberschrift wird per Default NICHT in den Seitentext dupliziert', () => {
  const r = splitManuscript('<h1>K</h1><h2>S</h2><p>x</p>');
  const page = r.nodes[0].children[0];
  assert.equal(page.html.includes('<h2>'), false);
  assert.equal(page.html.includes('<h1>'), false);
});

test('keepHeadings behaelt Kapitel- und Seiten-Ueberschrift im Text', () => {
  const r = splitManuscript('<h1>K</h1><h2>S</h2><p>x</p>', { keepHeadings: true });
  const page = r.nodes[0].children[0];
  assert.match(page.html, /<h1>K<\/h1>[\s\S]*<h2>S<\/h2>[\s\S]*<p>x<\/p>/);
});

test('Text vor der ersten Ueberschrift landet auf einer eigenen Seite', () => {
  const r = splitManuscript('<p>Vorwort</p><h1>K</h1><p>x</p>', { untitledPage: 'Seite' });
  assert.deepEqual(outline(r.nodes), [{ p: 'Seite 1' }, { c: 'K', k: [{ p: 'K' }] }]);
  assert.equal(r.nodes[0].html, '<p>Vorwort</p>');
});

test('Kapitel ohne eigene Seiten-Ueberschrift bekommt eine Seite mit Kapitelnamen', () => {
  const r = splitManuscript('<h1>Allein</h1><p>x</p><p>y</p>');
  assert.deepEqual(outline(r.nodes), [{ c: 'Allein', k: [{ p: 'Allein' }] }]);
  assert.equal(r.nodes[0].children[0].html, '<p>x</p>\n<p>y</p>');
});

test('Fehlende Elternebene zieht die Tiefe hoch statt das Kapitel zu verwerfen', () => {
  const r = splitManuscript('<h2>Ohne Eltern</h2><p>x</p>', {
    headingMap: { h2: 'subchapter' },
  });
  assert.deepEqual(outline(r.nodes), [{ c: 'Ohne Eltern', k: [{ p: 'Ohne Eltern' }] }]);
  assert.equal(r.warnings[0].code, 'DEPTH_CLAMPED');
});

test('Tiefer als drei Kapitel-Ebenen entsteht nicht', () => {
  const r = splitManuscript(
    '<h1>A</h1><h2>B</h2><h3>C</h3><h4>D</h4><p>x</p>',
    { headingMap: { h1: 'chapter', h2: 'subchapter', h3: 'subsubchapter', h4: 'subsubchapter' } },
  );
  let depth = 0;
  let node = r.nodes[0];
  while (node && node.type === 'chapter') { depth += 1; node = node.children.find(c => c.type === 'chapter'); }
  assert.equal(depth, 3);
});

test('Leeres Dokument meldet EMPTY_DOCUMENT statt zu werfen', () => {
  const r = splitManuscript('');
  assert.deepEqual(r.nodes, []);
  assert.equal(r.warnings[0].code, 'EMPTY_DOCUMENT');
});

test('Ueberschrift ohne Text bekommt einen Ersatznamen', () => {
  const r = splitManuscript('<h1></h1><p>x</p>', { untitledChapter: 'Kapitel' });
  assert.equal(r.nodes[0].name, 'Kapitel 1');
});

test('Unbekannte Rolle faellt auf den Default zurueck', () => {
  const m = normalizeHeadingMap({ h1: 'boss', h2: 'page' });
  assert.equal(m.h1, DEFAULT_HEADING_MAP.h1);
  assert.equal(m.h2, 'page');
  for (const lvl of Object.keys(m)) assert.ok(HEADING_ROLES.includes(m[lvl]));
});

test('Query-Serialisierung ist verlustfrei', () => {
  const map = { h1: 'chapter', h2: 'subchapter', h3: 'page', h4: 'content', h5: 'content', h6: 'content' };
  assert.deepEqual(parseHeadingMap(serializeHeadingMap(map)), map);
  // Zu kurze Angabe fuellt mit Defaults auf statt zu werfen.
  assert.deepEqual(parseHeadingMap('chapter,page'), {
    h1: 'chapter', h2: 'page', h3: 'content', h4: 'content', h5: 'content', h6: 'content',
  });
});

test('countHeadings zaehlt jede Ebene unabhaengig von der Zuordnung', () => {
  assert.deepEqual(
    countHeadings('<h1>a</h1><h2>b</h2><h2>c</h2><p>d</p>'),
    { h1: 1, h2: 2, h3: 0, h4: 0, h5: 0, h6: 0 },
  );
});
