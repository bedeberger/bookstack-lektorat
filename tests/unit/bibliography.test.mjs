// Quellenverzeichnis als Render-Artefakt (lib/bibliography.js).
//
// Geprueft werden die Eigenschaften, auf die die Exporter bauen:
//   - Nummern folgen der GERENDERTEN EINHEIT (Buch- vs. Seiten-Scope)
//   - scope='cited' vs 'all'
//   - Titel-Default je Buchsprache, abgeschaltetes Verzeichnis
//   - resolveCitesInHtml ersetzt den Chip-TEXT (Cache) und nichts sonst:
//     Attribute bleiben, Fremd-Chips bleiben, kein Chip verschwindet
import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';

process.env.DB_PATH = path.join('/tmp', `bibliography-test-${process.pid}-${Date.now()}.db`);

// db/schema.js re-exportiert per Spread — cjs-module-lexer erkennt daraus keine
// Named Exports, darum ueber den Default-Export.
const schema = (await import('../../db/schema.js')).default;
const { db } = (await import('../../db/connection.js')).default;
const {
  buildBibliography, bibliographyItemHtml,
  resolveCitesInHtml, resolveCitesInGroups, pageIdsFromGroups,
} = await import('../../lib/bibliography.js');

const NOW = '2026-07-29T08:00:00.000Z';
const BOOK = 7101;      // deutsches Buch, numerischer Stil
const BOOK_EN = 7102;   // englisches Buch, APA — fuer den Titel-Default

schema.upsertBookByName(BOOK, 'Quellen-Renderbuch');
schema.upsertBookByName(BOOK_EN, 'Sources render book');

function makePage(pageId, bookId, position) {
  db.prepare('INSERT INTO pages (page_id, book_id, page_name, position, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(pageId, bookId, `S${position}`, position, NOW);
  return pageId;
}
const P1 = makePage(71001, BOOK, 1);
const P2 = makePage(71002, BOOK, 2);

// Drei Quellen; Alphabet (Adorno < Kafka < Zweig) steht bewusst QUER zur
// Erstzitat-Reihenfolge (Kafka auf S.1, Zweig auf S.2, Adorno unzitiert), damit
// alphabetische und numerische Sortierung unterscheidbar sind.
// Quellen leben im User-Pool und werden dem Buch ueber die Bruecke zugeordnet
// (db/sources.js) — das Verzeichnis eines Buchs kennt nur verknuepfte Quellen.
function addSource(bookId, fields) {
  const s = schema.createSource('me@x.test', fields);
  schema.linkSource(bookId, s.id, 'me@x.test');
  return s;
}
const KAFKA = addSource(BOOK, {
  csl_type: 'book', title: 'Die Verwandlung', year: '1915',
  authors: [{ family: 'Kafka', given: 'Franz' }], publisher: 'Kurt Wolff', place: 'Leipzig',
});
const ZWEIG = addSource(BOOK, {
  csl_type: 'book', title: 'Schachnovelle', year: '1942',
  authors: [{ family: 'Zweig', given: 'Stefan' }], publisher: 'Pigmalión', place: 'Buenos Aires',
});
const ADORNO = addSource(BOOK, {
  csl_type: 'book', title: 'Minima Moralia', year: '1951',
  authors: [{ family: 'Adorno', given: 'Theodor W.' }], publisher: 'Suhrkamp',
});

// Fund-Index: Kafka auf Seite 1 (Offset 10) + Seite 2, Zweig nur auf Seite 2.
schema.replacePageCitations(P1, [{ sourceId: KAFKA.id, count: 1, firstOffset: 10 }]);
schema.replacePageCitations(P2, [
  { sourceId: ZWEIG.id, count: 1, firstOffset: 5 },
  { sourceId: KAFKA.id, count: 1, firstOffset: 40 },
]);

function setSettings(bookId, patch) {
  schema.setBookCitationSettings(bookId, {
    citation_style: 'numeric', bibliography_enabled: 1,
    bibliography_title: null, bibliography_scope: 'cited', bibliography_in_blog: 0,
    ...patch,
  });
}
schema.saveBookSettings(BOOK, 'de', 'CH', null, null);
setSettings(BOOK, {});

// ── buildBibliography ────────────────────────────────────────────────────────

test('Buch-Scope: Nummern nach Erstzitat in Buch-Leserichtung', async () => {
  const bib = await buildBibliography({ bookId: BOOK });
  assert.equal(bib.enabled, true);
  assert.equal(bib.style, 'numeric');
  assert.equal(bib.lang, 'de');
  // Kafka steht auf Seite 1 → [1]; Zweig erst auf Seite 2 → [2].
  assert.equal(bib.numbers.get(KAFKA.id), 1);
  assert.equal(bib.numbers.get(ZWEIG.id), 2);
  // Verzeichnis-Reihenfolge folgt im numerischen Stil der Nummer, nicht dem
  // Alphabet (Zweig vor Adorno, obwohl Z > A).
  assert.deepEqual(bib.entries.map(e => e.num), [1, 2]);
  assert.deepEqual(bib.entries.map(e => e.id), [KAFKA.id, ZWEIG.id]);
});

test('Seiten-Scope nummeriert nur die Fundstellen dieser Seite, ab 1', async () => {
  const bib = await buildBibliography({ bookId: BOOK, pageIds: [P2] });
  // Auf Seite 2 zitiert Zweig zuerst (Offset 5) → [1], Kafka danach → [2].
  assert.equal(bib.numbers.get(ZWEIG.id), 1);
  assert.equal(bib.numbers.get(KAFKA.id), 2);
  assert.deepEqual(bib.entries.map(e => e.id), [ZWEIG.id, KAFKA.id]);
  // Eine Quelle, die auf dieser Seite nicht vorkommt, ist auch nicht im
  // Verzeichnis dieser Einheit.
  assert.equal(bib.entries.some(e => e.id === ADORNO.id), false);
});

test('Seiten-Scope ohne Fundstellen liefert ein leeres Verzeichnis', async () => {
  const bib = await buildBibliography({ bookId: BOOK, pageIds: [] });
  assert.equal(bib.entries.length, 0);
  assert.equal(bib.numbers.size, 0);
});

test("scope='cited' laesst unzitierte Quellen weg, 'all' nimmt sie mit", async () => {
  const cited = await buildBibliography({ bookId: BOOK });
  assert.equal(cited.entries.some(e => e.id === ADORNO.id), false);

  setSettings(BOOK, { bibliography_scope: 'all' });
  const all = await buildBibliography({ bookId: BOOK });
  assert.equal(all.entries.length, 3);
  // Unzitierte Quellen haengen im numerischen Stil ohne Nummer hinten an.
  const adorno = all.entries.find(e => e.id === ADORNO.id);
  assert.equal(adorno.num, null);
  assert.equal(all.entries[all.entries.length - 1].id, ADORNO.id);

  setSettings(BOOK, { bibliography_scope: 'cited' });
});

test('Titel: Buch-Einstellung schlaegt Sprach-Default', async () => {
  const de = await buildBibliography({ bookId: BOOK });
  assert.equal(de.title, 'Quellenverzeichnis');

  schema.saveBookSettings(BOOK_EN, 'en', 'US', null, null);
  setSettings(BOOK_EN, { citation_style: 'apa7' });
  const en = await buildBibliography({ bookId: BOOK_EN });
  assert.equal(en.lang, 'en');
  assert.equal(en.title, 'Sources');

  setSettings(BOOK, { bibliography_title: 'Literatur' });
  const custom = await buildBibliography({ bookId: BOOK });
  assert.equal(custom.title, 'Literatur');
  setSettings(BOOK, { bibliography_title: null });
});

test('Abgeschaltet: keine Eintraege, aber Nummern + Quellen fuer die Chips', async () => {
  setSettings(BOOK, { bibliography_enabled: 0 });
  const bib = await buildBibliography({ bookId: BOOK });
  assert.equal(bib.enabled, false);
  assert.deepEqual(bib.entries, []);
  // Die Chips im Text brauchen ihren Kurzbeleg unabhaengig vom Verzeichnis.
  assert.equal(bib.numbers.get(KAFKA.id), 1);
  assert.ok(bib.sourcesById.get(KAFKA.id));
  setSettings(BOOK, { bibliography_enabled: 1 });
});

test('Unbekanntes Buch liefert ein leeres, aber vollstaendiges Ergebnis', async () => {
  const bib = await buildBibliography({ bookId: 999999 });
  assert.equal(bib.enabled, false);
  assert.deepEqual(bib.entries, []);
  assert.equal(bib.numbers.size, 0);
  assert.equal(bib.sourcesById.size, 0);
  assert.equal(bib.title, 'Quellenverzeichnis');
});

test('bibliographyItemHtml stellt die Nummer nur im numerischen Stil voran', async () => {
  const num = await buildBibliography({ bookId: BOOK });
  const html = bibliographyItemHtml(num);
  assert.match(html, /^<p>\[1\] /);
  assert.equal((html.match(/<p>/g) || []).length, 2);
  // Kursive Werktitel bleiben als <em> erhalten (der Walker liest sie als Run).
  assert.match(html, /<em>/);

  setSettings(BOOK, { citation_style: 'apa7' });
  const apa = await buildBibliography({ bookId: BOOK });
  assert.equal(apa.style, 'apa7');
  assert.equal(bibliographyItemHtml(apa).includes('[1]'), false);
  // APA sortiert alphabetisch: Kafka vor Zweig.
  assert.deepEqual(apa.entries.map(e => e.id), [KAFKA.id, ZWEIG.id]);
  setSettings(BOOK, { citation_style: 'numeric' });
});

// ── resolveCitesInHtml ───────────────────────────────────────────────────────

const CHIP = (id, loc, text) =>
  `<span class="cite" data-src="${id}"${loc ? ` data-loc="${loc}"` : ''}>${text}</span>`;

test('numerischer Stil ersetzt den Autor-Jahr-Cache durch [n]', async () => {
  const bib = await buildBibliography({ bookId: BOOK });
  // Cache-Text stammt vom Einfuege-Zeitpunkt (Autor-Jahr) — im numerischen Stil
  // steht die Nummer erst beim Rendern fest.
  const html = `<p>Text ${CHIP(KAFKA.id, '44', '(Kafka, 1915, S. 44)')} weiter.</p>`;
  const out = await resolveCitesInHtml(html, bib);
  assert.match(out, />\[1, S\. 44\]</);
  assert.equal(out.includes('(Kafka, 1915, S. 44)'), false);
  // Attribute unveraendert (Invariante B).
  assert.match(out, new RegExp(`data-src="${KAFKA.id}"`));
  assert.match(out, /data-loc="44"/);
  assert.match(out, /class="cite"/);
});

test('kein Chip verschwindet, auch nicht der ohne data-src', async () => {
  const bib = await buildBibliography({ bookId: BOOK });
  const html = `<p>${CHIP(KAFKA.id, '', 'alt')} und ${CHIP(ZWEIG.id, '7', 'alt2')}`
    + ' und <span class="cite">Fremdmarkup</span>.</p>';
  const out = await resolveCitesInHtml(html, bib);
  assert.equal((out.match(/<span class="cite"/g) || []).length, 3);
  assert.match(out, />\[1\]</);
  assert.match(out, />\[2, S\. 7\]</);
  // Ein span.cite OHNE data-src ist kein Quellennachweis und bleibt unangetastet.
  assert.match(out, /<span class="cite">Fremdmarkup<\/span>/);
});

test('Zeiger ins Leere behaelt den Cache-Text', async () => {
  const bib = await buildBibliography({ bookId: BOOK });
  const html = `<p>${CHIP(987654, '3', '(Wer auch immer, 2001, S. 3)')}</p>`;
  const out = await resolveCitesInHtml(html, bib);
  assert.equal(out, html);
});

test('HTML ohne Quellenangabe kommt unveraendert zurueck (kein Re-Serialize)', async () => {
  const bib = await buildBibliography({ bookId: BOOK });
  const html = '<p>Ein Absatz mit <em>Kursive</em> &amp; Entities.</p>';
  assert.equal(await resolveCitesInHtml(html, bib), html);
  // Auch identischer Chip-Text loest keine Neu-Serialisierung aus.
  const same = `<p>${CHIP(KAFKA.id, '44', '[1, S. 44]')}</p>`;
  assert.equal(await resolveCitesInHtml(same, bib), same);
});

test('resolveCitesInGroups laesst unveraenderte Seiten als Original stehen', async () => {
  const bib = await buildBibliography({ bookId: BOOK });
  const plain = { p: { id: P1, name: 'A' }, pd: { html: '<p>ohne Quelle</p>' } };
  const withCite = { p: { id: P2, name: 'B' }, pd: { html: `<p>${CHIP(ZWEIG.id, '', 'alt')}</p>` } };
  const groups = [{ chapter: { id: 1, name: 'Eins' }, pages: [plain, withCite] }];
  const out = await resolveCitesInGroups(groups, bib);

  assert.equal(out[0].pages[0], plain);            // identisches Objekt
  assert.notEqual(out[0].pages[1], withCite);      // Kopie mit neuem HTML
  assert.match(out[0].pages[1].pd.html, />\[2\]</);
  assert.equal(withCite.pd.html.includes('[2]'), false);   // Eingabe unberuehrt
  assert.deepEqual(pageIdsFromGroups(groups), [P1, P2]);
});
