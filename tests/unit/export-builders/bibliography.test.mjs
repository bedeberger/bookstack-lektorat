// Quellenangaben in den Export-Buildern.
//
// Zwei Zusagen, die fuer JEDEN Ausgabeweg gelten muessen (siehe
// lib/export-builders/shared.js#prepareCitations):
//   1. Der Chip-Text im Export ist der FRISCHE Kurzbeleg, nicht der im HTML
//      gespeicherte Cache vom Einfuege-Zeitpunkt. Im numerischen Stil ist das der
//      Unterschied zwischen "[1, S. 44]" und einer veralteten Autor-Jahr-Form.
//   2. Das Verzeichnis erscheint nur beim ganzen Buch — bei Kapitel-/Seiten-Export
//      werden die Chips aufgeloest, aber kein Apparat angehaengt.
//
// Der Test faehrt bewusst ALLE Builder gegen dieselbe Zusage: genau hier ist das
// Feature zuletzt auseinandergelaufen (PDF/DOCX konnten es, der Rest nicht).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';

import { buildHtml } from '../../../lib/export-builders/html.js';
import { buildTxt } from '../../../lib/export-builders/txt.js';
import { buildMd } from '../../../lib/export-builders/md.js';
import { buildSubstack } from '../../../lib/export-builders/substack.js';
import { buildEpub } from '../../../lib/export-builders/epub.js';

const SOURCE = {
  id: 7,
  csl_type: 'book',
  authors: [{ family: 'Müller', given: 'Anna' }],
  title: 'Ein Titel',
  year: '2020',
  publisher: 'Verlag',
  place: 'Bern',
};

// Der gespeicherte Chip-Text ist absichtlich falsch — nur so zeigt der Test, dass
// wirklich neu formatiert und nicht der Cache durchgereicht wird.
const STALE_CHIP = '<span class="cite" data-src="7" data-loc="44">(veraltet, 1999)</span>';

// Bewusst synthetisch statt „Quellenverzeichnis": der Titel dient hier als
// Anwesenheits-Marker, und das echte Wort steht auch in Kommentaren und CSS der
// Builder — ein Substring-Test darauf wuerde falsch anschlagen.
const BIB_TITLE = 'Verzeichnis-Marker-4711';

function bib({ style = 'numeric', enabled = true } = {}) {
  return {
    enabled,
    inBlog: false,
    title: BIB_TITLE,
    style,
    lang: 'de',
    scope: 'cited',
    numbers: new Map([[7, 1]]),
    sourcesById: new Map([[7, SOURCE]]),
    entries: enabled ? [{
      id: 7,
      num: 1,
      text: 'Müller, A. (2020). Ein Titel. Verlag.',
      html: 'Müller, A. (2020). <em>Ein Titel</em>. Verlag.',
      runs: [],
    }] : [],
  };
}

function bundle(scope = 'book') {
  const chapter = { id: 10, name: 'Erstes Kapitel', parent_chapter_id: null };
  const page = { id: 100, name: 'Seite eins' };
  return {
    scope,
    book: { id: 1, name: 'Mein Buch', slug: 'mein-buch' },
    chapter,
    page,
    groups: [{
      chapterId: 10,
      chapter,
      pages: [{ p: page, pd: { html: `<p>Satz mit Beleg ${STALE_CHIP}.</p>` } }],
    }],
  };
}

const TEXT_BUILDERS = [
  ['html', buildHtml],
  ['txt', buildTxt],
  ['md', buildMd],
  ['substack', buildSubstack],
];

for (const [name, build] of TEXT_BUILDERS) {
  test(`${name}: Chip traegt den frischen Kurzbeleg, nicht den gespeicherten Cache`, async () => {
    const s = (await build(bundle('book'), { lang: 'de', bibliography: bib() })).toString('utf8');
    assert.ok(s.includes('[1, S. 44]'), 'numerischer Kurzbeleg fehlt');
    assert.ok(!s.includes('veraltet'), 'Cache-Text steht noch im Export');
  });

  test(`${name}: Verzeichnis beim Buch, nicht beim Kapitel`, async () => {
    const b = bib();
    const book = (await build(bundle('book'), { lang: 'de', bibliography: b })).toString('utf8');
    assert.ok(book.includes(BIB_TITLE));
    assert.ok(book.includes('Ein Titel'));

    const chap = (await build(bundle('chapter'), { lang: 'de', bibliography: b })).toString('utf8');
    assert.ok(!chap.includes(BIB_TITLE), 'Kapitel-Export haengt ein Verzeichnis an');
    // Aufgeloest wird trotzdem — die Nummern folgen dann dieser Einheit.
    assert.ok(chap.includes('[1, S. 44]'));
  });

  test(`${name}: abgeschaltetes Verzeichnis loest die Chips trotzdem auf`, async () => {
    const s = (await build(bundle('book'), { lang: 'de', bibliography: bib({ enabled: false }) })).toString('utf8');
    assert.ok(s.includes('[1, S. 44]'));
    assert.ok(!s.includes(BIB_TITLE));
  });

  test(`${name}: ohne bibliography-Option bleibt der Export unveraendert`, async () => {
    const s = (await build(bundle('book'), { lang: 'de' })).toString('utf8');
    assert.ok(s.includes('veraltet, 1999'), 'ohne Kontext darf nichts umformatiert werden');
    assert.ok(!s.includes(BIB_TITLE));
  });
}

test('apa7: Chip wird zur Autor-Jahr-Form, nicht zur Nummer', async () => {
  const s = (await buildHtml(bundle('book'), { lang: 'de', bibliography: bib({ style: 'apa7' }) })).toString('utf8');
  assert.ok(s.includes('(Müller, 2020, S. 44)'));
  assert.ok(!s.includes('[1,'));
});

test('epub: Verzeichnis als eigene Backmatter-Datei, im Inhaltsverzeichnis', async () => {
  const buf = await buildEpub(bundle('book'), { lang: 'de', bibliography: bib() });
  const zip = await JSZip.loadAsync(buf);
  const file = Object.keys(zip.files).find(n => n.endsWith('back_bibliography.xhtml'));
  assert.ok(file, 'Verzeichnis-Datei fehlt im EPUB');

  const xhtml = await zip.file(file).async('string');
  assert.ok(xhtml.includes('Ein Titel'));
  assert.ok(xhtml.includes('[1]'), 'Nummern-Spalte des numerischen Stils fehlt');

  const navName = Object.keys(zip.files).find(n => /toc\.xhtml$/.test(n));
  assert.ok((await zip.file(navName).async('string')).includes(BIB_TITLE));

  const body = Object.keys(zip.files).find(n => /(entry|chap)_0/.test(n));
  assert.ok((await zip.file(body).async('string')).includes('[1, S. 44]'));
});

test('epub: Kapitel-Export ohne Verzeichnis', async () => {
  const buf = await buildEpub(bundle('chapter'), { lang: 'de', bibliography: bib() });
  const zip = await JSZip.loadAsync(buf);
  assert.ok(!Object.keys(zip.files).some(n => n.endsWith('back_bibliography.xhtml')));
});

// ── Format-eigene Auspraegung der Eintraege ──────────────────────────────────
// Die Zusagen oben gelten fuer alle Builder gleich. Hier kommt dazu, was jedes
// Format mit dem Eintrags-Markup selbst tun muss — genau die Stellen, an denen
// ein Builder rohes HTML durchreichen koennte, ohne dass ein Anwesenheits-Test
// es merkt.

test('md: kursiver Werktitel wird zu *…*, kein rohes <em> im Markdown', async () => {
  const s = (await buildMd(bundle('book'), { lang: 'de', bibliography: bib() })).toString('utf8');
  assert.ok(s.includes(`## ${BIB_TITLE}`), 'Verzeichnis-Ueberschrift nicht auf Kapitelebene');
  assert.ok(s.includes('*Ein Titel*'), 'Kursivsatz muss durch den Walker zu Markdown werden');
  assert.ok(!s.includes('<em>'), 'rohes HTML im Markdown-Export');
  assert.ok(!s.includes('<p>'));
});

test('txt: Eintraege als Klartext-Zeilen mit [n]-Praefix, kein Markup', async () => {
  const s = (await buildTxt(bundle('book'), { lang: 'de', bibliography: bib() })).toString('utf8');
  // Klartext-Form (bib.entries[].text) via bibliographyItemLines — Plaintext hat
  // keinen Kursivsatz, den man strippen muesste.
  assert.ok(s.includes('[1] Müller, A. (2020). Ein Titel. Verlag.'));
  assert.ok(!s.includes('<em>') && !s.includes('<p>'));
});

test('html: Verzeichnis als eigener <section>-Block mit <h2>', async () => {
  const s = (await buildHtml(bundle('book'), { lang: 'de', bibliography: bib() })).toString('utf8');
  assert.ok(s.includes('<section class="bibliography">'), 'haengender Einzug haengt an der Klasse');
  assert.ok(s.includes(`<h2>${BIB_TITLE}</h2>`));
  assert.ok(s.includes('<p>[1] Müller, A. (2020). <em>Ein Titel</em>. Verlag.</p>'));
});

test('substack: Verzeichnis ueberlebt Substacks Paste-Filter (kein class/style/data-)', async () => {
  const s = (await buildSubstack(bundle('book'), { lang: 'de', bibliography: bib() })).toString('utf8');
  // Nur den Body unterhalb der Trennlinie pruefen — Meta-Box und Trennlinie
  // selbst tragen bewusst eigene Klassen (sie werden nicht mitkopiert).
  const divider = s.indexOf('<div class="substack-divider">');
  assert.ok(divider > 0);
  const body = s.slice(s.indexOf('</div>', divider) + 6);
  assert.ok(body.includes(`<h2>${BIB_TITLE}</h2>`));
  assert.ok(body.includes('<em>Ein Titel</em>'), 'Kursivsatz geht verloren');
  assert.ok(!/class=|style=|data-/.test(body), 'Substack verwirft Attribute beim Paste');
});
