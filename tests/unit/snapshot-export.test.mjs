// snapshotToBundle (lib/snapshot-export.js) baut aus dem selbsttragenden
// Fassungs-content_json (buildBookJson-Format) dieselbe { scope, book, groups }-
// Struktur, gegen die die Export-Builder + der PDF-Render sonst aus dem Live-
// Buch arbeiten (lib/load-contents.js). Roundtrip durch den HTML-Builder stellt
// sicher, dass die synthetischen Kapitel-IDs/Tiefen das Heading-Mapping treffen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { snapshotToBundle } = require_('../../lib/snapshot-export.js');
const { buildHtml } = require_('../../lib/export-builders/html.js');

const CONTENT = {
  book: { name: 'Der Prozess', description: 'Roman', settings: null },
  tree: [
    { type: 'page', name: 'Vorwort', html: '<p>vorab</p>', srcId: 10 },
    {
      type: 'chapter', name: 'Erstes Kapitel', srcId: 1,
      children: [
        { type: 'page', name: 'Verhaftung', html: '<p>K. wurde verhaftet.</p>', srcId: 11 },
        { type: 'page', name: 'Gespräch', html: '<p>Er sprach.</p>', srcId: 12 },
        {
          type: 'chapter', name: 'Unterkapitel', srcId: 2,
          children: [
            { type: 'page', name: 'Tiefe Seite', html: '<p>tief</p>', srcId: 13 },
          ],
        },
      ],
    },
    {
      type: 'chapter', name: 'Zweites Kapitel', srcId: 3,
      children: [
        { type: 'page', name: 'Ende', html: '<p>Schluss.</p>', srcId: 14 },
      ],
    },
  ],
};

test('snapshotToBundle: book-Metadaten + scope', () => {
  const b = snapshotToBundle(CONTENT, { bookId: 42 });
  assert.equal(b.scope, 'book');
  assert.equal(b.book.id, 42);
  assert.equal(b.book.name, 'Der Prozess');
  assert.equal(b.book.slug, 'der-prozess');
  assert.equal(b.book.description, 'Roman');
});

test('snapshotToBundle: Gruppen in Lesereihenfolge mit Kapitel-Hierarchie', () => {
  const { groups } = snapshotToBundle(CONTENT, { bookId: 1 });
  // Top-Seite (eigene null-Kapitel-Gruppe), Kapitel 1, Unterkapitel, Kapitel 2.
  assert.equal(groups.length, 4);

  // 1) Top-Seite ohne Kapitel.
  assert.equal(groups[0].chapterId, null);
  assert.equal(groups[0].chapter, null);
  assert.deepEqual(groups[0].pages.map(p => p.p.name), ['Vorwort']);
  assert.equal(groups[0].pages[0].pd.html, '<p>vorab</p>');

  // 2) Erstes Kapitel mit zwei direkten Seiten.
  assert.equal(groups[1].chapter.name, 'Erstes Kapitel');
  assert.equal(groups[1].chapter.parent_chapter_id, null);
  assert.deepEqual(groups[1].pages.map(p => p.p.name), ['Verhaftung', 'Gespräch']);

  // 3) Unterkapitel — parent zeigt auf das erste Kapitel.
  assert.equal(groups[2].chapter.name, 'Unterkapitel');
  assert.equal(groups[2].chapter.parent_chapter_id, groups[1].chapter.id);
  assert.deepEqual(groups[2].pages.map(p => p.p.name), ['Tiefe Seite']);

  // 4) Zweites Kapitel — wieder Top-Level.
  assert.equal(groups[3].chapter.name, 'Zweites Kapitel');
  assert.equal(groups[3].chapter.parent_chapter_id, null);

  // Synthetische Kapitel-IDs sind eindeutig.
  const ids = [groups[1].chapter.id, groups[2].chapter.id, groups[3].chapter.id];
  assert.equal(new Set(ids).size, 3);
});

test('snapshotToBundle: srcId wird als p.id durchgereicht', () => {
  const { groups } = snapshotToBundle(CONTENT, { bookId: 1 });
  assert.equal(groups[0].pages[0].p.id, 10);
  assert.equal(groups[3].pages[0].p.id, 14);
});

test('snapshotToBundle: Roundtrip durch buildHtml mappt Heading-Tiefen', async () => {
  const bundle = snapshotToBundle(CONTENT, { bookId: 1 });
  const html = (await buildHtml(bundle)).toString('utf8');
  // Top-Level-Kapitel → h2, Unterkapitel → h3.
  assert.match(html, /<h2>Erstes Kapitel<\/h2>/);
  assert.match(html, /<h3>Unterkapitel<\/h3>/);
  assert.match(html, /<h2>Zweites Kapitel<\/h2>/);
  // Seiteninhalte sind eingebettet, in Reihenfolge.
  assert.ok(html.indexOf('K. wurde verhaftet.') < html.indexOf('Schluss.'));
});

test('snapshotToBundle: leerer/fehlender Tree → keine Gruppen', () => {
  assert.deepEqual(snapshotToBundle({ book: { name: 'x' } }, { bookId: 1 }).groups, []);
  assert.deepEqual(snapshotToBundle(null, { bookId: 1, bookName: 'Fallback' }).book.name, 'Fallback');
});

// snapshotPublication: loest die eingefrorene book_publication einer Fassung
// (publication_json) zurueck in die getMeta-Form + Buffer-BLOBs, die die
// Export-Pfade sonst live konsumieren.
const { snapshotPublication } = require_('../../lib/snapshot-export.js');

test('snapshotPublication: null/leer/defekt → null', () => {
  assert.equal(snapshotPublication(null), null);
  assert.equal(snapshotPublication(''), null);
  assert.equal(snapshotPublication('{kaputt'), null);
  assert.equal(snapshotPublication('{}'), null);           // keine meta
  assert.equal(snapshotPublication('{"meta":null}'), null);
});

test('snapshotPublication: Textfelder + Cover/Foto decodiert, Flags gespiegelt', () => {
  const coverBytes = Buffer.from('COVER');
  const photoBytes = Buffer.from('PHOTO');
  const json = JSON.stringify({
    meta: { imprint: 'Impressum KDP', isbn: '9783161484100', epub_justify: true,
            has_cover: false, has_author_image: false, cover_mime: null },
    cover: { b64: coverBytes.toString('base64'), mime: 'image/jpeg' },
    authorImage: { b64: photoBytes.toString('base64'), mime: 'image/png' },
  });
  const pub = snapshotPublication(json);
  assert.equal(pub.meta.imprint, 'Impressum KDP');
  assert.equal(pub.meta.isbn, '9783161484100');
  // Flags/Mimes spiegeln die eingefrorenen BLOBs, nicht die im meta gespeicherten Werte.
  assert.equal(pub.meta.has_cover, true);
  assert.equal(pub.meta.cover_mime, 'image/jpeg');
  assert.equal(pub.meta.has_author_image, true);
  assert.equal(pub.meta.author_image_mime, 'image/png');
  assert.ok(Buffer.isBuffer(pub.cover.image));
  assert.equal(pub.cover.image.toString(), 'COVER');
  assert.equal(pub.authorImage.image.toString(), 'PHOTO');
});

test('snapshotPublication: nur Textfelder (keine BLOBs) → Flags false', () => {
  const pub = snapshotPublication(JSON.stringify({ meta: { imprint: 'x', has_cover: true } }));
  assert.equal(pub.cover, null);
  assert.equal(pub.authorImage, null);
  // has_cover aus dem gespeicherten meta wird durch die BLOB-Abwesenheit ueberschrieben.
  assert.equal(pub.meta.has_cover, false);
  assert.equal(pub.meta.imprint, 'x');
});
