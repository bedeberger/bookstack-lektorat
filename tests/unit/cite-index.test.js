'use strict';
// Fund-Index der Belege: lib/cite-index.js + der Hook am Schreib-Chokepoint der
// Content-Store-Facade.
//
// Der Chokepoint ist der Grund, warum diese Tests gegen die Facade laufen und
// nicht nur gegen den Indexer: kein Schreibpfad (Editor, Import, Blog-Pull,
// Restore) darf an der Indexierung vorbeikommen, und genau das kann man nur
// dort pruefen.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const tmp = path.join('/tmp', `cite-index-test-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmp;

const schema = require('../../db/schema');
const { db } = require('../../db/connection');
const citeIndex = require('../../lib/cite-index');
const contentStore = require('../../lib/content-store');

const BOOK = 5001;
const OTHER_BOOK = 5002;
schema.upsertBookByName(BOOK, 'Beleg-Testbuch');
schema.upsertBookByName(OTHER_BOOK, 'Fremdbuch');

function chip(id, text = '(Beleg)', loc = null) {
  const locAttr = loc ? ` data-loc="${loc}"` : '';
  return `<span class="cite" data-src="${id}"${locAttr}>${text}</span>`;
}

async function newPage(html) {
  const p = await contentStore.createPage({ book_id: BOOK, name: 'S', html }, null);
  return p.id;
}

function citesOf(pageId) {
  return schema.listPageCitations(pageId).map(r => [r.source_id, r.count, r.first_offset]);
}

test('MARKER_HINT entspricht CITE_ATTR_SRC', async () => {
  // Der Hint ist der Vorab-Test, der die Indexierung fuer Buecher ohne Belege
  // ueberspringt. Driftet er vom Attributnamen ab, wird NIE indiziert.
  const mod = await import('../../public/js/sources/cite-html.js');
  assert.equal(citeIndex.MARKER_HINT, mod.CITE_ATTR_SRC);
});

test('savePage indiziert Belege, Full-Replace bei jedem Save', async () => {
  const a = schema.createSource(BOOK, 'me@x.test', { title: 'Quelle A' });
  const b = schema.createSource(BOOK, 'me@x.test', { title: 'Quelle B' });
  const pageId = await newPage('<p>leer</p>');
  assert.deepEqual(citesOf(pageId), []);

  await contentStore.savePage(pageId, {
    html: `<p>Vorher ${chip(a.id, '[1]', '44')} und ${chip(b.id, '[2]')}.</p>`,
  }, null);
  // "Vorher "(7) + "[1]"(3) + " und "(5) = 15
  assert.deepEqual(citesOf(pageId), [[a.id, 1, 7], [b.id, 1, 15]]);

  // Zweiter Save mit nur einem Beleg → der andere verschwindet (Full-Replace,
  // kein Fortschreiben).
  await contentStore.savePage(pageId, { html: `<p>Nur ${chip(b.id, '[2]')}</p>` }, null);
  assert.deepEqual(citesOf(pageId), [[b.id, 1, 4]]);

  // Belege ganz entfernt → Index leer.
  await contentStore.savePage(pageId, { html: '<p>ohne alles</p>' }, null);
  assert.deepEqual(citesOf(pageId), []);
});

test('Mehrfachbeleg derselben Quelle wird gezaehlt, nicht dupliziert', async () => {
  const s = schema.createSource(BOOK, 'me@x.test', { title: 'Oft zitiert' });
  const pageId = await newPage(`<p>${chip(s.id, '[1]')} x ${chip(s.id, '[1]')} y ${chip(s.id, '[1]')}</p>`);
  const rows = schema.listPageCitations(pageId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 3);
  assert.equal(rows[0].first_offset, 0);
});

test('createPage indiziert mit — Import/Blog-Pull laufen nicht ueber savePage', async () => {
  const s = schema.createSource(BOOK, 'me@x.test', { title: 'Aus Import' });
  const pageId = await newPage(`<p>importiert ${chip(s.id, '[1]')}</p>`);
  assert.deepEqual(citesOf(pageId), [[s.id, 1, 11]]);  // "importiert " = 11 Zeichen
});

test('buchfremde und tote Zeiger erzeugen keine Fundstelle', async () => {
  const own = schema.createSource(BOOK, 'me@x.test', { title: 'Eigen' });
  const foreign = schema.createSource(OTHER_BOOK, 'me@x.test', { title: 'Fremd' });
  const pageId = await newPage(
    `<p>${chip(own.id)} ${chip(foreign.id)} ${chip(999999)}</p>`
  );
  assert.deepEqual(citesOf(pageId).map(r => r[0]), [own.id]);
});

test('Seite ohne Marker loest keine Schreib-Transaktion aus', async () => {
  // Buecher ohne Quellen sollen nichts kosten. Messbar am Nebeneffekt:
  // reindex liefert 0 und der Index bleibt leer, auch nach vielen Saves.
  const pageId = await newPage('<p>reine Prosa</p>');
  for (let i = 0; i < 3; i++) {
    await contentStore.savePage(pageId, { html: `<p>reine Prosa ${i}</p>` }, null);
  }
  assert.deepEqual(citesOf(pageId), []);
  assert.equal(await citeIndex.reindexPageCitations(pageId, '<p>ohne</p>'), 0);
});

test('Rename-/Reorder-Save laesst den Index unberuehrt', async () => {
  const s = schema.createSource(BOOK, 'me@x.test', { title: 'Bleibt' });
  const pageId = await newPage(`<p>${chip(s.id, '[1]')}</p>`);
  assert.deepEqual(citesOf(pageId), [[s.id, 1, 0]]);
  // Save ohne html-Feld: der Hook darf nicht laufen (sonst wuerde er gegen
  // undefined pruefen und den Index leerraeumen).
  await contentStore.savePage(pageId, { name: 'Neuer Name' }, null);
  assert.deepEqual(citesOf(pageId), [[s.id, 1, 0]]);
});

test('Chip im Editor-Zustand wird gesaeubert und trotzdem indiziert', async () => {
  const s = schema.createSource(BOOK, 'me@x.test', { title: 'Aus dem Editor' });
  const pageId = await newPage('<p>leer</p>');
  await contentStore.savePage(pageId, {
    html: `<p>Text <span class="cite" data-src="${s.id}" data-loc="44" contenteditable="false">(X, 2020, S. 44)</span></p>`,
  }, null);
  const page = await contentStore.loadPage(pageId, null);
  assert.ok(!page.html.includes('contenteditable'), page.html);
  assert.ok(page.html.includes(`data-src="${s.id}"`));
  assert.deepEqual(citesOf(pageId), [[s.id, 1, 5]]);
});

test('movePage verwirft die Belege beim Buchwechsel', async () => {
  const s = schema.createSource(BOOK, 'me@x.test', { title: 'Wandert nicht mit' });
  const pageId = await newPage(`<p>${chip(s.id, '[1]')}</p>`);
  assert.equal(citesOf(pageId).length, 1);

  await contentStore.movePage(pageId, { targetBookId: OTHER_BOOK }, null);
  // Die Quelle gehoert weiter zu BOOK, die Seite jetzt zu OTHER_BOOK → der
  // Buch-Guard verwirft die Fundstelle. Der Chip bleibt im Text stehen (Beleg
  // ohne Ziel) statt im Zielbuch auf eine fremde Quelle zu zeigen.
  assert.deepEqual(citesOf(pageId), []);
  const page = await contentStore.loadPage(pageId, null);
  assert.ok(page.html.includes(`data-src="${s.id}"`), 'Marker bleibt im Text');
});

test('Quelle loeschen raeumt die Fundstellen, Marker bleibt', async () => {
  const s = schema.createSource(BOOK, 'me@x.test', { title: 'Wird geloescht' });
  const pageId = await newPage(`<p>${chip(s.id, '[1]')}</p>`);
  assert.equal(citesOf(pageId).length, 1);
  schema.deleteSource(s.id);
  assert.deepEqual(citesOf(pageId), []);
  const page = await contentStore.loadPage(pageId, null);
  assert.ok(page.html.includes('class="cite"'));
  assert.equal(db.pragma('foreign_key_check').length, 0);
});

test('reindexPageCitationsSafe wirft nie', async () => {
  assert.equal(await citeIndex.reindexPageCitationsSafe(null, '<p>x</p>'), 0);
  assert.equal(await citeIndex.reindexPageCitationsSafe(999999, `<p>${chip(1)}</p>`), 0);
});
