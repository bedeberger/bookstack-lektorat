// Der Titel-Kopf am Beitrag: Dachzeile/Titel/Lead über dem Text, auf jedem
// Ausgabeweg (Share-Reader, sechs Export-Builder, PDF-Renderer).
//
// SSoT ist lib/headline-render.js. Getestet wird hier, was leise brechen kann:
//   - der Titel ERSETZT den Seitennamen (und fällt auf ihn zurück)
//   - der Teaser bleibt draussen — er ist kein Kopf-Feld
//   - das Kopf-Markup trägt Klasse UND Auszeichnung (zwei Zielgruppen)
//   - jeder Ausgabeweg ruft den Helper (sonst zeigt er „Beitrag 12")
//   - der Kopf zählt nirgends als Prosa
//   - das Gate: ausserhalb publizistischer Bücher passiert nichts

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const require = createRequire(import.meta.url);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-headhead-'));
process.env.DB_PATH = path.join(TMP, 'test.db');

// Schema VOR allem anderen: db/headline.js praepariert seine Statements beim
// Modul-Load, und lib/headline-render.js zieht es herein.
const { db } = require(path.join(ROOT, 'db/connection.js'));
require(path.join(ROOT, 'db/migrations.js'));

const H = require(path.join(ROOT, 'lib/headline-render.js'));
const ch = await import(pathToFileURL(path.join(ROOT, 'public/js/headline/channels.js')).href);
const registry = await import(pathToFileURL(path.join(ROOT, 'public/js/cards/feature-registry.js')).href);
const { renderStreamHtml } = await import(pathToFileURL(path.join(ROOT, 'public/js/manuscript-render.js')).href);
const { fromGroups } = await import(pathToFileURL(path.join(ROOT, 'public/js/manuscript-stream.js')).href);

/** Seiten-Metadaten wie sie ein Builder sieht (loadContents-Shape). */
function page(name, hl = null) {
  return { id: 7, name, hl };
}

const FULL = {
  dachzeile: 'Politik · Bundeshaus',
  titel: 'Der lange Weg zum Referendum',
  lead: 'Nach zwei Jahren Streit steht der Termin.',
  teaser: 'Kurz erklärt, worum es geht.',
};

// ── Feld-Katalog ─────────────────────────────────────────────────────────────

test('die Kopf-Felder sind eine echte Teilmenge der Titel-Felder', () => {
  for (const f of ch.HEADLINE_HEAD_FIELDS) {
    assert.ok(ch.HEADLINE_FIELDS.includes(f), `${f} ist kein bekanntes Titel-Feld`);
  }
  assert.equal(ch.HEADLINE_HEAD_FIELDS.length, new Set(ch.HEADLINE_HEAD_FIELDS).size);
});

test('der Teaser gehört NICHT in den Beitrag', () => {
  // Er ist der Anreisser für Übersichten und Vorschaukarten; im Artikel selbst
  // wäre er die Wiederholung des Leads. Er verlässt die App nur als
  // WordPress-`excerpt`. Wer ihn hier aufnimmt, dreht die Entscheidung um.
  assert.ok(!ch.HEADLINE_HEAD_FIELDS.includes('teaser'));
  const html = H.headHtml(page('Beitrag 12', FULL), { titleTag: 'h3' });
  assert.ok(!html.includes('Kurz erklärt'), 'Teaser steht im Kopf-Markup');
});

test('Frontend- und Server-Buchtyp-Gate stimmen überein', () => {
  const server = require(path.join(ROOT, 'lib/buchtyp.js')).JOURNALISTIC_BUCHTYPEN;
  assert.deepEqual([...registry.JOURNALISTIC_BUCHTYPEN].sort(), [...server].sort());
  for (const bt of server) assert.ok(registry.isJournalisticBuchtyp(bt), bt);
  for (const bt of ['roman', 'krimi', null, '']) assert.ok(!registry.isJournalisticBuchtyp(bt), String(bt));
});

// ── Titel ersetzt den Seitennamen ────────────────────────────────────────────

test('der Titel gewinnt über den Seitennamen, sonst bleibt der Seitenname', () => {
  assert.equal(H.pageTitle(page('Beitrag 12', FULL)), FULL.titel);
  assert.equal(H.pageTitle(page('Beitrag 12', null)), 'Beitrag 12');
  assert.equal(H.pageTitle(page('Beitrag 12', { titel: '   ' })), 'Beitrag 12');
  // Ein leerer Kopf wäre schlimmer als ein technischer Name.
  assert.equal(H.pageTitle(page('Beitrag 12', { dachzeile: 'Politik' })), 'Beitrag 12');
});

test('needsOwnHead greift, sobald irgendetwas gesetzt ist', () => {
  assert.equal(H.needsOwnHead(page('P', null)), false);
  assert.equal(H.needsOwnHead(page('P', { titel: 'T' })), true);
  assert.equal(H.needsOwnHead(page('P', { dachzeile: 'D' })), true);
  assert.equal(H.needsOwnHead(page('P', { lead: 'L' })), true);
  // Nur ein Teaser ist kein Grund, im Beitrag einen Kopf zu setzen.
  assert.equal(H.needsOwnHead(page('P', { teaser: 'X' })), false);
});

test('der Datei-Slug folgt dem Titel NICHT', () => {
  // Eine Adresse soll sich nicht ändern, weil jemand den Titel umformuliert hat.
  const { resolveTitle, resolveSlug } = require(path.join(ROOT, 'lib/export-builders/shared.js'));
  const p = { ...page('Beitrag 12', FULL), slug: 'beitrag-12' };
  const args = { scope: 'page', book: { name: 'Ressort', slug: 'ressort' }, page: p };
  assert.equal(resolveTitle(args), FULL.titel);
  assert.equal(resolveSlug(args), 'beitrag-12');
});

// ── Markup ───────────────────────────────────────────────────────────────────

test('das Kopf-Markup trägt Klasse UND Auszeichnung', () => {
  // Zwei Zielgruppen: die Wege mit eigenem Stylesheet hängen sich an die Klasse,
  // die Wege durch den HTML-Walker (PDF, Word, Markdown) kennen nur die
  // Auszeichnung. Wer eines von beiden entfernt, macht den Kopf auf der Hälfte
  // der Wege unsichtbar bzw. unformatierbar.
  const k = H.kickerHtml(page('P', FULL));
  assert.ok(k.includes(`class="${H.KICKER_CLASS}"`), 'Klasse fehlt');
  assert.ok(k.includes('<strong>'), 'Auszeichnung fehlt');
  const l = H.leadHtml(page('P', FULL));
  assert.ok(l.includes(`class="${H.LEAD_CLASS}"`), 'Klasse fehlt');
  assert.ok(l.includes('<em>'), 'Auszeichnung fehlt');
});

test('nicht gesetzte Felder erzeugen kein leeres Markup', () => {
  assert.equal(H.kickerHtml(page('P', { titel: 'T' })), '');
  assert.equal(H.leadHtml(page('P', { titel: 'T' })), '');
  assert.equal(H.headHtml(page('P', null)), '');
});

test('Kopf-Text wird escaped', () => {
  const evil = { dachzeile: '<script>x</script>', lead: 'a & b', titel: '"Zitat"' };
  const html = H.headHtml(page('P', evil), { titleTag: 'h3' });
  assert.ok(!html.includes('<script>'), 'roher Script-Tag im Kopf');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('a &amp; b'));
  assert.ok(html.includes('&quot;Zitat&quot;'));
});

test('headHtml setzt Dachzeile über und Lead unter die Überschrift', () => {
  const html = H.headHtml(page('P', FULL), { titleTag: 'h3' });
  const iK = html.indexOf('Politik');
  const iT = html.indexOf('<h3>');
  const iL = html.indexOf('Nach zwei Jahren');
  assert.ok(iK >= 0 && iT > iK && iL > iT, `Reihenfolge falsch:\n${html}`);
});

test('ohne titleTag bleibt die Überschrift weg', () => {
  // Der Seiten-Share setzt den Titel in seine H1 — eine zweite Überschrift im
  // Body wäre doppelt.
  const html = H.headHtml(page('P', FULL));
  assert.ok(!html.includes(FULL.titel));
  assert.ok(html.includes('Politik') && html.includes('Nach zwei Jahren'));
});

// ── Der Kopf zählt nirgends als Prosa ────────────────────────────────────────

test('stripHeadBlocks entfernt genau den Kopf und sonst nichts', () => {
  const body = '<p>Erster Absatz.</p><p class="foo">Zweiter.</p>';
  const full = H.headHtml(page('P', FULL), { titleTag: 'h3' }) + body;
  const stripped = H.stripHeadBlocks(full);
  assert.ok(!stripped.includes('Politik'), 'Dachzeile überlebt');
  assert.ok(!stripped.includes('Nach zwei Jahren'), 'Lead überlebt');
  assert.ok(stripped.includes('Erster Absatz.'), 'Fliesstext verloren');
  assert.ok(stripped.includes('Zweiter.'), 'Fremder Absatz mit Klasse verloren');
  // Die Überschrift ist Teil des Beitrags und bleibt.
  assert.ok(stripped.includes(FULL.titel), 'Überschrift wurde mitgeschnitten');
});

test('Umfang und Lesezeit des Share-Readers messen den Beitrag ohne Kopf', () => {
  const { htmlToPlainLength } = require(path.join(ROOT, 'lib/share-helpers.js'));
  const body = '<p>Erster Absatz.</p>';
  const bloss = htmlToPlainLength(body);
  const mitKopf = htmlToPlainLength(H.headHtml(page('P', FULL), { titleTag: 'h3' }) + body);
  // Die Überschrift zählt mit (sie steht im Beitrag), Dachzeile und Lead nicht.
  assert.ok(mitKopf < bloss + FULL.dachzeile.length + FULL.lead.length,
    'Dachzeile und/oder Lead sind in den Umfang eingerechnet');
  assert.ok(mitKopf >= bloss, 'Umfang ist kleiner als der reine Text');
});

// ── Manuskript-Stream (Share-Reader Buch/Kapitel) ────────────────────────────

test('der Stream stellt den Kopf um die Seitenüberschrift und markiert den Beitrag', () => {
  const groups = [{
    chapterId: 3,
    chapter: { id: 3, name: 'Politik' },
    pages: [{ p: page('Beitrag 12', FULL), pd: { id: 7, name: 'Beitrag 12', html: '<p>Text.</p>' } }],
  }];
  const entries = fromGroups(groups, {
    pageHead: (p) => H.needsOwnHead(p)
      ? { name: H.pageTitle(p), before: H.kickerHtml(p), after: H.leadHtml(p) }
      : null,
  });
  const { html, toc } = renderStreamHtml(entries);
  const iK = html.indexOf('Politik · Bundeshaus');
  const iT = html.indexOf(FULL.titel);
  const iL = html.indexOf('Nach zwei Jahren');
  const iB = html.indexOf('<p>Text.</p>');
  assert.ok(iK >= 0 && iT > iK && iL > iT && iB > iL, `Reihenfolge falsch:\n${html}`);
  // Variantenklassen: die Seiten-Caption ist sonst eine kleine gesperrte
  // Marginalie — als Schlagzeile gesetzt wäre das falsch.
  assert.ok(html.includes('ms-page--article'), 'Beitrags-Variante nicht markiert');
  assert.ok(html.includes('ms-page__title--headline'), 'Schlagzeile trägt Caption-Stil');
  // Das Inhaltsverzeichnis folgt dem Titel, nicht dem Ordnungsnamen.
  assert.ok(toc.some(e => e.label === FULL.titel), 'TOC zeigt den Seitennamen');
});

test('ohne Kopf bleibt der Stream unverändert (kein Regress für Romane)', () => {
  const groups = [{
    chapterId: 3, chapter: { id: 3, name: 'Kapitel' },
    pages: [{ p: page('Seite 1'), pd: { id: 7, name: 'Seite 1', html: '<p>Text.</p>' } }],
  }];
  const html = renderStreamHtml(fromGroups(groups)).html;
  assert.ok(!html.includes('--article'), 'Nicht-Beitrag als Beitrag markiert');
  assert.ok(!html.includes('ms-head__'), 'Kopf-Markup ohne Kopf');
  assert.ok(html.includes('Seite 1'));
});

test('der Stream escapt Namen, reicht Kopf-Markup aber verbatim durch', () => {
  const entries = fromGroups([{
    chapterId: null, chapter: null,
    pages: [{ p: page('<b>x</b>'), pd: { id: 1, name: '<b>x</b>', html: '<p>a</p>' } }],
  }], { pageHead: () => ({ name: '<b>x</b>', before: '<p class="k"><strong>K</strong></p>', after: '' }) });
  const html = renderStreamHtml(entries).html;
  assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'), 'Name nicht escaped — XSS-Sink');
  assert.ok(html.includes('<p class="k"><strong>K</strong></p>'), 'Kopf-Markup wurde escaped');
});

// ── Jeder Ausgabeweg ruft den Helper ─────────────────────────────────────────

test('alle Export-Builder konsultieren die Kopf-SSoT', () => {
  // Wer den Seitennamen direkt rendert, zeigt „Beitrag 12" statt der
  // Schlagzeile — und das fällt in einem Export niemandem sofort auf.
  const wege = ['html.js', 'md.js', 'txt.js', 'docx.js', 'substack.js'];
  for (const w of wege) {
    const src = fs.readFileSync(path.join(ROOT, 'lib/export-builders', w), 'utf8');
    assert.match(src, /require\('\.\.\/headline-render'\)/, `${w} löst den Titel-Kopf nicht auf`);
  }
  // EPUB ist auf ein Unterverzeichnis aufgeteilt; der Kopf entsteht im Orchestrator.
  const ep = fs.readFileSync(path.join(ROOT, 'lib/export-builders/epub/build.js'), 'utf8');
  assert.match(ep, /require\('\.\.\/\.\.\/headline-render'\)/, 'epub/build.js löst den Titel-Kopf nicht auf');
  // Der PDF-Renderer baut seine Blöcke in coalesce.js.
  const co = fs.readFileSync(path.join(ROOT, 'lib/pdf-render/coalesce.js'), 'utf8');
  assert.match(co, /require\('\.\.\/headline-render'\)/);
  // Angehängt wird an genau einer Stelle.
  const lc = fs.readFileSync(path.join(ROOT, 'lib/load-contents.js'), 'utf8');
  assert.match(lc, /attachHeadlines/);
});

// ── Gate + Anbindung ─────────────────────────────────────────────────────────

const { setHeadline } = require(path.join(ROOT, 'db/headline.js'));

function seedBook(buchtyp) {
  const T = '2026-01-01T10:00:00.000Z';
  db.prepare('INSERT INTO books (name, created_at, updated_at) VALUES (?, ?, ?)').run('W', T, T);
  const bookId = db.prepare('SELECT MAX(book_id) AS id FROM books').get().id;
  db.prepare('INSERT INTO pages (book_id, page_name, updated_at) VALUES (?, ?, ?)')
    .run(bookId, 'Beitrag 12', T);
  const pageId = db.prepare('SELECT MAX(page_id) AS id FROM pages').get().id;
  db.prepare('INSERT INTO book_settings (book_id, buchtyp, updated_at) VALUES (?, ?, ?) '
    + 'ON CONFLICT(book_id) DO UPDATE SET buchtyp = excluded.buchtyp').run(bookId, buchtyp, T);
  setHeadline(pageId, bookId, { dachzeile: FULL.dachzeile, titel: FULL.titel, lead: FULL.lead });
  return { bookId, pageId };
}

function bundleFor({ bookId, pageId }) {
  const p = { id: pageId, name: 'Beitrag 12' };
  return {
    scope: 'book', book: { id: bookId, name: 'W' },
    groups: [{ chapterId: null, chapter: null, pages: [{ p, pd: { id: pageId, html: '<p>Text.</p>' } }] }],
  };
}

test('attachHeadlines hängt den Stand an — aber nur in publizistischen Büchern', () => {
  const ressort = seedBook('journalismus');
  const b1 = H.attachHeadlines(bundleFor(ressort));
  const p1 = b1.groups[0].pages[0].p;
  assert.equal(H.pageTitle(p1), FULL.titel);
  assert.equal(H.kickerText(p1), FULL.dachzeile);

  // In einem Roman gibt es keine Dachzeile. Der Stand steht zwar in der Tabelle
  // (Buchtyp-Wechsel löscht ihn nicht), darf aber nirgends erscheinen.
  const roman = seedBook('krimi');
  const b2 = H.attachHeadlines(bundleFor(roman));
  const p2 = b2.groups[0].pages[0].p;
  assert.equal(p2.hl, undefined, 'Gate durchbrochen');
  assert.equal(H.pageTitle(p2), 'Beitrag 12');
  assert.equal(H.needsOwnHead(p2), false);
});

test('ein Blog ist publizistisch — dasselbe Gate wie ein Ressort', () => {
  const blog = seedBook('blog');
  const p = H.attachHeadlines(bundleFor(blog)).groups[0].pages[0].p;
  assert.equal(H.pageTitle(p), FULL.titel);
});

// ── Ende-zu-Ende durch die Builder ───────────────────────────────────────────

test('HTML, Markdown und Plaintext zeigen Kopf statt Seitennamen', async () => {
  const { buildHtml } = require(path.join(ROOT, 'lib/export-builders/html.js'));
  const { buildMd } = require(path.join(ROOT, 'lib/export-builders/md.js'));
  const { buildTxt } = require(path.join(ROOT, 'lib/export-builders/txt.js'));
  const bundle = H.attachHeadlines(bundleFor(seedBook('journalismus')));

  for (const [name, build] of [['html', buildHtml], ['md', buildMd], ['txt', buildTxt]]) {
    const out = (await build(bundle, {})).toString('utf8');
    assert.ok(out.includes(FULL.titel), `${name}: Schlagzeile fehlt`);
    assert.ok(out.includes(FULL.dachzeile), `${name}: Dachzeile fehlt`);
    assert.ok(out.includes('Nach zwei Jahren'), `${name}: Lead fehlt`);
    assert.ok(!out.includes('Beitrag 12'), `${name}: Ordnungsname der Seite steht noch drin`);
    // Reihenfolge: Dachzeile · Schlagzeile · Lead · Text.
    const iK = out.indexOf(FULL.dachzeile);
    const iT = out.indexOf(FULL.titel);
    const iL = out.indexOf('Nach zwei Jahren');
    assert.ok(iK < iT && iT < iL, `${name}: Reihenfolge falsch`);
  }
});

test('Word und EPUB tragen den Kopf im Dokument', async () => {
  const JSZip = require('jszip');
  const { buildDocx } = require(path.join(ROOT, 'lib/export-builders/docx.js'));
  const { buildEpub } = require(path.join(ROOT, 'lib/export-builders/epub.js'));
  const bundle = H.attachHeadlines(bundleFor(seedBook('journalismus')));

  for (const [name, build] of [['docx', buildDocx], ['epub', buildEpub]]) {
    const zip = await JSZip.loadAsync(await build(bundle, {}));
    let text = '';
    for (const f of Object.values(zip.files)) {
      if (f.dir || !/\.(xml|xhtml|html|css|rels)$/i.test(f.name)) continue;
      text += await f.async('string');
    }
    assert.ok(text.includes(FULL.titel), `${name}: Schlagzeile fehlt`);
    // Auf 'Bundeshaus' geprüft, nicht auf die ganze Dachzeile: der EPUB-Packer
    // schreibt das Mittelpunkt-Zeichen als `&#xB7;` ins XHTML. Das ist korrekt
    // und keine Aussage über den Kopf.
    assert.ok(text.includes('Bundeshaus'), `${name}: Dachzeile fehlt`);
    assert.ok(text.includes('Nach zwei Jahren'), `${name}: Lead fehlt`);
    assert.ok(!text.includes('Beitrag 12'), `${name}: Ordnungsname der Seite steht noch drin`);
  }
});

test('Word gibt dem Kopf benannte Absatzformate', () => {
  // Das Manuskript geht ins Lektorat bzw. an einen Verlag: dort formatiert man
  // Formate um, keine Einzelabsätze.
  const src = fs.readFileSync(path.join(ROOT, 'lib/export-builders/docx.js'), 'utf8');
  assert.match(src, /KICKER_STYLE_ID\s*=\s*'ArticleKicker'/);
  assert.match(src, /LEAD_STYLE_ID\s*=\s*'ArticleLead'/);
  // allCaps setzt Word — der gespeicherte Wortlaut bleibt unangetastet.
  assert.match(src, /allCaps:\s*true/);
});

test('PDF: nested trägt Dachzeile am Item, flatten schiebt den ganzen Kopf ins HTML', () => {
  // Zwei Wege, weil der Renderer im flatten-Modus (und bei Seiten ohne Kapitel)
  // gar keine Seitenüberschrift zeichnet — dort müsste die Schlagzeile sonst
  // spurlos verschwinden.
  const { _coalesceGroups } = require(path.join(ROOT, 'lib/pdf-render/coalesce.js'));
  const p1 = page('Beitrag 12', FULL);
  const p2 = { ...page('Beitrag 13', { titel: 'Zweiter Fall' }), id: 8 };
  const groups = [{
    chapterId: 3, chapter: { id: 3, name: 'Politik' },
    pages: [{ p: p1, pd: { html: '<p>A</p>' } }, { p: p2, pd: { html: '<p>B</p>' } }],
  }];

  const nested = _coalesceGroups(groups, 'nested', false, [], []);
  const it = nested[0].items[0];
  assert.equal(it.heading, FULL.titel, 'Überschrift ist nicht die Schlagzeile');
  assert.equal(it.kicker, FULL.dachzeile, 'Dachzeile fehlt am Item');
  assert.equal(it.pageName, FULL.titel, 'Kolumnentitel folgt dem Seitennamen');
  assert.ok(it.html.includes('Nach zwei Jahren'), 'Lead fehlt im Item-HTML');
  assert.ok(!it.html.includes(`<h3>${FULL.titel}`), 'Titel doppelt: als heading UND im HTML');

  const flat = _coalesceGroups(groups, 'flatten', false, [], []);
  const html = flat[0].items[0].html;
  assert.ok(html.includes(`<h3>${FULL.titel}</h3>`), 'Schlagzeile fehlt im flatten-HTML');
  assert.ok(html.includes(FULL.dachzeile) && html.includes('Nach zwei Jahren'));
  assert.ok(html.includes('Zweiter Fall'), 'zweiter Beitrag ohne Kopf');

  // Ohne Kopf bleibt alles wie bisher (kein Regress für Romane).
  const roman = _coalesceGroups(
    [{ chapterId: 3, chapter: { id: 3, name: 'Kapitel' }, pages: [{ p: page('Seite 1'), pd: { html: '<p>A</p>' } }] }],
    'flatten', false, [], [],
  );
  assert.equal(roman[0].items[0].html, '<p>A</p>');
});

test('Plaintext schreibt die Dachzeile nicht in Versalien um', () => {
  // Versalien wären eine Änderung am Wortlaut des Autors, um eine Formatierung
  // zu ersetzen, die das Format nicht kann.
  const src = fs.readFileSync(path.join(ROOT, 'lib/export-builders/txt.js'), 'utf8');
  assert.ok(!/toUpperCase|toLocaleUpperCase/.test(src));
});
