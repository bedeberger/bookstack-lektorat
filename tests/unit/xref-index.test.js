'use strict';
// Fund-Index der Querverweise: Full-Replace, Buch-Guards, Marker-Hints.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// Eigene Test-DB pro Lauf (Suites laufen mit --test-concurrency=4 parallel).
process.env.DB_PATH = path.join('/tmp', `xref-idx-test-${process.pid}-${Date.now()}.db`);

const schema = require('../../db/schema');
const { db } = require('../../db/schema');
const xrefs = require('../../db/xrefs');
const { reindexPageXrefs, XREF_HINT, ANCHOR_HINT } = require('../../lib/xref-index');
const { XREF_ATTR_ID } = { XREF_ATTR_ID: 'data-xref-id' };

// ── Fixture: zwei Buecher, je ein Kapitel und eine Seite ─────────────────────
function seed() {
  schema.upsertBookByName(900, 'Verweis-Buch');
  schema.upsertBookByName(901, 'Fremdes Buch');
  db.prepare(`INSERT INTO chapters (chapter_id, book_id, chapter_name, position)
              VALUES (7010, 900, 'Zielkapitel', 0), (7011, 900, 'Zweites', 1), (7090, 901, 'Fremd', 0)`).run();
  db.prepare(`INSERT INTO pages (page_id, book_id, chapter_id, page_name, position)
              VALUES (8010, 900, 7010, 'Seite A', 0),
                     (8011, 900, 7011, 'Seite B', 1),
                     (8090, 901, 7090, 'Fremde Seite', 0)`).run();
}
seed();

const FIG = '<figure data-bid="aaaaaaaaaaaaaaaa"><img src="x.png"><figcaption>Der Kaefer</figcaption></figure>';
const REF_CH = '<span class="xref" data-xref="chapter" data-xref-id="7010">Kapitel 1</span>';

test('Marker-Hints entsprechen der Markup-SSoT', () => {
  // Der Vorab-Test in lib/xref-index.js darf nicht von der SSoT abdriften —
  // sonst wird eine Seite mit Verweisen gar nicht erst geparst.
  assert.equal(XREF_HINT, XREF_ATTR_ID);
  assert.equal(ANCHOR_HINT, '<figure');
});

test('Anker und Verweise einer Seite werden indiziert', async () => {
  const res = await reindexPageXrefs(8010, `<p>Text</p>${FIG}<p>Siehe ${REF_CH}.</p>`);
  assert.equal(res.anchors, 1);
  assert.equal(res.links, 1);

  const anchors = xrefs.listBookAnchors(900);
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].bid, 'aaaaaaaaaaaaaaaa');
  assert.equal(anchors[0].caption, 'Der Kaefer');
  assert.equal(anchors[0].chapter_id, 7010);

  const links = xrefs.listPageXrefs(8010);
  assert.equal(links.length, 1);
  assert.equal(links[0].kind, 'chapter');
  assert.equal(links[0].chapter_id, 7010);
  assert.equal(links[0].count, 1);
});

test('Full-Replace: entfernte Marker verschwinden aus dem Index', async () => {
  await reindexPageXrefs(8010, '<p>Nichts mehr hier.</p>');
  assert.equal(xrefs.listPageXrefs(8010).length, 0);
  assert.equal(xrefs.listBookAnchors(900).length, 0);
});

test('Mehrfachnennung desselben Ziels wird zu EINER Zeile mit count', async () => {
  await reindexPageXrefs(8010, `<p>${REF_CH} und nochmal ${REF_CH}</p>`);
  const links = xrefs.listPageXrefs(8010);
  assert.equal(links.length, 1);
  assert.equal(links[0].count, 2);
  // firstOffset zeigt auf die fruehste Nennung.
  assert.equal(links[0].first_offset, 0);
});

test('Buch-Guard: Verweis auf ein Kapitel eines FREMDEN Buchs wird nicht indiziert', async () => {
  const res = await reindexPageXrefs(8010,
    '<p><span class="xref" data-xref="chapter" data-xref-id="7090">Kapitel X</span></p>');
  assert.equal(res.links, 0);
  assert.equal(xrefs.listPageXrefs(8010).length, 0);
});

test('Buch-Guard: Verweis auf ein geloeschtes Kapitel wird nicht indiziert', async () => {
  const res = await reindexPageXrefs(8010,
    '<p><span class="xref" data-xref="chapter" data-xref-id="99999">Kapitel Weg</span></p>');
  assert.equal(res.links, 0);
});

test('Abbildungs-Verweis ueber Seitengrenzen: Anker auf A, Verweis von B', async () => {
  await reindexPageXrefs(8010, FIG);
  const res = await reindexPageXrefs(8011,
    '<p>vgl. <span class="xref" data-xref="figure" data-xref-id="aaaaaaaaaaaaaaaa">Abb. 1.1</span></p>');
  assert.equal(res.links, 1);
  const links = xrefs.listPageXrefs(8011);
  assert.equal(links[0].kind, 'figure');
  assert.equal(links[0].anchor_bid, 'aaaaaaaaaaaaaaaa');
  assert.equal(links[0].chapter_id, null);
});

test('Anker und Verweis auf DERSELBEN Seite: Anker wird zuerst geschrieben', async () => {
  // Sonst faende der Buch-Guard in replacePageXrefs sein eigenes Ziel nicht und
  // der Verweis fiele bis zum naechsten Speichern unter den Tisch.
  const res = await reindexPageXrefs(8011,
    `${FIG.replace('aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb')}<p><span class="xref" data-xref="figure" data-xref-id="bbbbbbbbbbbbbbbb">Abb. 2.1</span></p>`);
  assert.equal(res.anchors, 1);
  assert.equal(res.links, 1);
});

test('Rueckwaertsfrage: wer verweist auf dieses Kapitel', async () => {
  await reindexPageXrefs(8010, `<p>${REF_CH}</p>`);
  await reindexPageXrefs(8011, `<p>${REF_CH}</p>`);
  const back = xrefs.listXrefBacklinks('chapter', 7010);
  assert.equal(back.length, 2);
  assert.deepEqual(back.map(b => b.page_id), [8010, 8011]);
});

test('Kapitel loeschen raeumt die Verweis-Zeilen mit (FK CASCADE)', async () => {
  await reindexPageXrefs(8010, `<p>${REF_CH}</p>`);
  assert.equal(xrefs.listXrefBacklinks('chapter', 7010).length > 0, true);
  db.prepare('DELETE FROM chapters WHERE chapter_id = 7010').run();
  assert.equal(xrefs.listXrefBacklinks('chapter', 7010).length, 0);
});

test('Seite ohne Marker loest keinen Parse und keine Schreib-Transaktion aus', async () => {
  const res = await reindexPageXrefs(8090, '<p>Ganz normaler Text ohne alles.</p>');
  assert.deepEqual(res, { anchors: 0, links: 0 });
});
