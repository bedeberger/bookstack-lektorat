// Unit-Tests des Anzeigemodells fuer das Quellen-Popover in der Notebook-
// Leseansicht (public/js/sources/cite-popover.js, pure — kein Alpine, kein DOM).
//
// Geprueft wird das, was das Popover behauptet: der Voll-Eintrag stammt aus der
// QUELLE (nicht aus dem Chip-Text-Cache), ein verwaister Zeiger sagt es statt
// leer aufzugehen, und der externe Zeiger landet nie ungeprueft in einem href.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildCitePopoverModel, sourceExternalUrl } =
  await import('../../public/js/sources/cite-popover.js');

const MUELLER = {
  id: 7,
  csl_type: 'book',
  authors: [{ family: 'Müller', given: 'Anna' }],
  title: 'Die Verwandlung der Dinge',
  publisher: 'Suhrkamp',
  place: 'Berlin',
  year: '2020',
  cite_count: 3,
};

test('Voll-Eintrag kommt aus der Quelle, nicht aus dem Chip-Text', () => {
  const m = buildCitePopoverModel({ srcId: 7, loc: '44', sources: [MUELLER], style: 'apa7', lang: 'de' });
  assert.equal(m.missing, false);
  assert.equal(m.srcId, 7);
  assert.match(m.entryHtml, /Müller/);
  assert.match(m.entryHtml, /2020/);
  // Titel-Kursive ist der einzige erzeugte Tag (runsToHtml escapet alles sonst).
  assert.match(m.entryHtml, /<em>/);
  assert.equal(m.name, 'Müller, Anna');
  assert.equal(m.citeCount, 3);
});

test('Stellenangabe wird qualifiziert, aber nicht doppelt', () => {
  const num = buildCitePopoverModel({ srcId: 7, loc: '44', sources: [MUELLER], lang: 'de' });
  assert.equal(num.locLabel, 'S. 44');
  const own = buildCitePopoverModel({ srcId: 7, loc: 'Kap. 3', sources: [MUELLER], lang: 'de' });
  assert.equal(own.locLabel, 'Kap. 3');
  const none = buildCitePopoverModel({ srcId: 7, sources: [MUELLER], lang: 'de' });
  assert.equal(none.locLabel, '');
});

test('Paraphrase-Marke kommt aus data-mode', () => {
  assert.equal(buildCitePopoverModel({ srcId: 7, sources: [MUELLER] }).paraphrase, false);
  assert.equal(
    buildCitePopoverModel({ srcId: 7, mode: 'paraphrase', sources: [MUELLER] }).paraphrase,
    true,
  );
});

test('verwaister Zeiger: missing statt leerem Popover', () => {
  const m = buildCitePopoverModel({ srcId: 99, sources: [MUELLER] });
  assert.equal(m.missing, true);
  assert.equal(m.entryHtml, '');
  assert.equal(m.name, '');
  // Ladefehler ist NICHT dasselbe wie „nicht zugeordnet" — sonst behauptet das
  // Popover bei einem 500er, die Quelle sei aus dem Buch entfernt worden.
  const err = buildCitePopoverModel({ srcId: 7, sources: [], loadError: true });
  assert.equal(err.loadError, true);
  assert.equal(err.missing, false);
});

test('externer Zeiger: DOI vor URL, nur http(s)', () => {
  assert.equal(sourceExternalUrl({ doi: '10.1234/abc' }), 'https://doi.org/10.1234/abc');
  assert.equal(sourceExternalUrl({ doi: 'doi: 10.1234/abc' }), 'https://doi.org/10.1234/abc');
  assert.equal(sourceExternalUrl({ doi: 'https://doi.org/10.9/x', url: 'https://a.example' }),
    'https://doi.org/10.9/x');
  assert.equal(sourceExternalUrl({ url: 'https://a.example/x' }), 'https://a.example/x');
  // Kein javascript:-Wert aus einem importierten BibTeX-Feld ins href.
  assert.equal(sourceExternalUrl({ url: 'javascript:alert(1)' }), '');
  assert.equal(sourceExternalUrl({ url: 'ftp://a.example' }), '');
  assert.equal(sourceExternalUrl({}), '');
});

test('ungueltiger data-src-Wert ist kein Treffer', () => {
  for (const bad of [null, 0, -1, 1.5, NaN]) {
    const m = buildCitePopoverModel({ srcId: bad, sources: [MUELLER] });
    assert.equal(m.srcId, null);
    assert.equal(m.missing, true);
  }
});
