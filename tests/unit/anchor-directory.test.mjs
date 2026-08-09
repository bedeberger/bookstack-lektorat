// Abbildungs-/Tabellenverzeichnis (lib/anchor-directory.js).
//
// Die tragende Zusage: das Verzeichnis rechnet NICHT selbst, sondern liest die
// Nummern, die lib/xref-render.js schon gesetzt hat. Ein zweiter Zaehler hier
// erzeugte genau die Abweichung, die ein Verzeichnis unbrauchbar macht —
// „Tab. 3.2" im Verzeichnis, „Tab. 3.1" im Text.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  directoryEntries, directoryTitle, directoryHtml, directoryMd, directoryLines,
} = require('../../lib/anchor-directory.js');

// Form von buildXrefContext: Map bid → { number, title }, in Leserichtung.
const CTX = {
  lang: 'de',
  figure: new Map([
    ['f1', { number: '1.1', title: 'Der Kaefer' }],
    ['f2', { number: '1.2', title: 'Die Tuer' }],
  ]),
  table: new Map([
    ['t1', { number: '1.1', title: 'Umsatz nach Jahr' }],
    ['t2', { number: '2.1', title: 'Kosten' }],
  ]),
};

test('Eintraege in Leserichtung, mit typrichtigem Wort', () => {
  const figs = directoryEntries(CTX, 'figure', { lang: 'de' });
  assert.deepEqual(figs.map(e => e.label), ['Abb. 1.1', 'Abb. 1.2']);
  const tbls = directoryEntries(CTX, 'table', { lang: 'de' });
  assert.deepEqual(tbls.map(e => e.label), ['Tab. 1.1', 'Tab. 2.1']);
});

test('Reihenfolge ist die Leserichtung, NICHT lexikografisch sortiert', () => {
  // „3.10" nach „3.9" waere lexikografisch falsch — darum wird die
  // Einfuege-Reihenfolge der Map bewahrt und nichts nachsortiert.
  const ctx = {
    lang: 'de',
    table: new Map([
      ['a', { number: '3.9', title: 'neun' }],
      ['b', { number: '3.10', title: 'zehn' }],
    ]),
  };
  assert.deepEqual(directoryEntries(ctx, 'table').map(e => e.number), ['3.9', '3.10']);
});

test('ohne Nummer kein Eintrag — Nummerierung im Buch ausgeschaltet', () => {
  const ctx = { lang: 'de', table: new Map([['t1', { number: null, title: 'Umsatz' }]]) };
  assert.deepEqual(directoryEntries(ctx, 'table'), []);
  assert.equal(directoryHtml(ctx, 'table'), '', 'ein Verzeichnis ohne Nummern hat kein Sprungziel');
  assert.equal(directoryMd(ctx, 'table'), '');
  assert.deepEqual(directoryLines(ctx, 'table'), []);
});

test('Ueberschrift folgt der BUCHSPRACHE, nicht der UI-Locale', () => {
  assert.equal(directoryTitle('table', 'de'), 'Tabellenverzeichnis');
  assert.equal(directoryTitle('table', 'en'), 'List of Tables');
  assert.equal(directoryTitle('figure', 'de'), 'Abbildungsverzeichnis');
  assert.equal(directoryTitle('figure', 'en'), 'List of Figures');
  assert.equal(directoryTitle('figure', 'xx'), 'Abbildungsverzeichnis', 'unbekannt → Default-Locale');
});

test('HTML: Ueberschrift, Eintraege, escaped', () => {
  const ctx = { lang: 'de', table: new Map([['t', { number: '1.1', title: 'A & <B>' }]]) };
  const html = directoryHtml(ctx, 'table', { lang: 'de' });
  assert.match(html, /<h2>Tabellenverzeichnis<\/h2>/);
  assert.match(html, /Tab\. 1\.1/);
  assert.match(html, /A &amp; &lt;B&gt;/, 'Beschriftungen sind Autorentext und muessen escaped werden');
  assert.ok(!html.includes('<B>'));
});

test('HTML: headingLevel wird geklemmt', () => {
  assert.match(directoryHtml(CTX, 'table', { headingLevel: 9 }), /<h6>/);
  assert.match(directoryHtml(CTX, 'table', { headingLevel: 0 }), /<h1>/);
});

test('Markdown und Klartext', () => {
  const md = directoryMd(CTX, 'table', { lang: 'de' });
  assert.match(md, /^## Tabellenverzeichnis/m);
  assert.match(md, /- \*\*Tab\. 1\.1\*\* Umsatz nach Jahr/);
  const lines = directoryLines(CTX, 'figure', { lang: 'de' });
  assert.equal(lines[0], 'Abbildungsverzeichnis');
  assert.equal(lines[2], 'Abb. 1.1 Der Kaefer');
});

test('Eintrag ohne Beschriftung bleibt gueltig', () => {
  const ctx = { lang: 'de', table: new Map([['t', { number: '1.1', title: '' }]]) };
  assert.deepEqual(directoryEntries(ctx, 'table').map(e => e.title), ['']);
  assert.match(directoryMd(ctx, 'table'), /- \*\*Tab\. 1\.1\*\*$/m);
});

test('robuste Rueckfaelle', () => {
  assert.deepEqual(directoryEntries(null, 'table'), []);
  assert.deepEqual(directoryEntries({}, 'table'), []);
  assert.equal(directoryHtml(null, 'table'), '');
  assert.equal(directoryMd(undefined, 'figure'), '');
});
