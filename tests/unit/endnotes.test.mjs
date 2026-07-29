// Anmerkungsapparat (lib/endnotes.js + public/js/sources/format/notes.js).
//
// Hier entscheidet sich die inhaltliche Korrektheit des Apparats, nicht im
// Renderer: Zaehlung pro Kapitel, welche Belegstelle welche Kurzform bekommt, und
// dass die Marker im HTML landen, ohne den Zeiger zu verlieren.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildEndnotes, endnoteItemHtml, CITATION_NOTES_MODES } from '../../lib/endnotes.js';
import { noteForm, noteRuns } from '../../public/js/sources/format/notes.js';
import { labelsFor, runsToText } from '../../public/js/sources/format.js';

const SRC = (id, over = {}) => ({
  id,
  csl_type: 'book',
  authors: [{ family: 'Müller', given: 'Anna' }],
  title: `Titel ${id}`,
  year: '2020',
  publisher: 'Verlag',
  place: 'Bern',
  ...over,
});

const chip = (id, loc = '') =>
  `<span class="cite" data-src="${id}"${loc ? ` data-loc="${loc}"` : ''}>(Cache-Text)</span>`;

function ctx(over = {}) {
  return {
    style: 'apa7',
    lang: 'de',
    notesMode: 'endnotes',
    suffixes: new Map(),
    sourcesById: new Map([
      [7, SRC(7)],
      [8, SRC(8, { authors: [{ family: 'Schmidt', given: 'Bo' }] })],
    ]),
    ...over,
  };
}

function group(id, name, pages) {
  return {
    chapter: { id, name, parent_chapter_id: null },
    chapterId: id,
    pages: pages.map((html, i) => ({ p: { id: id * 100 + i, name: `S${i}` }, pd: { html } })),
  };
}

// ── Zaehlung ─────────────────────────────────────────────────────────────────

test('Nummern laufen pro Kapitel und beginnen in jedem neu bei 1', async () => {
  const groups = [
    group(1, 'K1', [`<p>A ${chip(7, '44')} B ${chip(8, '10')}</p>`, `<p>C ${chip(7, '99')}</p>`]),
    group(2, 'K2', [`<p>D ${chip(8, '5')}</p>`]),
  ];
  const r = await buildEndnotes(groups, ctx());
  assert.equal(r.total, 4);
  assert.deepEqual(r.groups[0].notes.map(n => n.n), [1, 2, 3]);
  assert.deepEqual(r.groups[1].notes.map(n => n.n), [1]);
  // Marker im Text traegt dieselbe Ziffer wie die Note.
  const marker = (src, n) => new RegExp(`data-src="${src}"[^>]*><sup>${n}</sup>`);
  assert.match(r.groups[0].pages[0].pd.html, marker(7, 1));
  assert.match(r.groups[0].pages[1].pd.html, marker(7, 3));
  assert.match(r.groups[1].pages[0].pd.html, marker(8, 1));
});

test('Ein Kapitel in mehreren Gruppen zaehlt durch; der Apparat haengt an der letzten', async () => {
  // Entsteht, wenn Unterkapitel einen Kapitel-Lauf unterbrechen.
  const groups = [
    { ...group(1, 'K1', [`<p>A ${chip(7, '1')}</p>`]) },
    { ...group(9, 'Unterkapitel', [`<p>Z ${chip(8, '2')}</p>`]) },
    { ...group(1, 'K1 (Fortsetzung)', [`<p>B ${chip(7, '3')}</p>`]) },
  ];
  const r = await buildEndnotes(groups, ctx());
  assert.deepEqual(r.groups[0].notes, [], 'nur die letzte Gruppe des Kapitels traegt den Apparat');
  assert.deepEqual(r.groups[2].notes.map(n => n.n), [1, 2]);
  // Fortlaufend ueber den Unterbruch hinweg: die zweite Nennung ist Nr. 2.
  assert.match(r.groups[2].pages[0].pd.html, /<sup>2<\/sup>/);
  // Das Unterkapitel zaehlt fuer sich.
  assert.deepEqual(r.groups[1].notes.map(n => n.n), [1]);
});

// ── Kurzformen ───────────────────────────────────────────────────────────────

test('Wiederholung direkt danach wird zu «Ebd.», mit Stelle nur bei Aenderung', async () => {
  const groups = [group(1, 'K1', [
    `<p>A ${chip(7, '44')} B ${chip(7, '44')} C ${chip(7, '51')}</p>`,
  ])];
  const notes = (await buildEndnotes(groups, ctx())).groups[0].notes;
  assert.equal(notes[0].form, 'full');
  assert.match(notes[0].text, /Müller.*Titel 7.*S\. 44/);
  assert.equal(notes[1].form, 'ibid');
  assert.equal(notes[1].text, 'Ebd.', 'gleiche Stelle → keine Seitenzahl wiederholen');
  assert.equal(notes[2].form, 'ibid');
  assert.equal(notes[2].text, 'Ebd., S. 51.');
});

test('Wiederholung mit fremder Quelle dazwischen wird zu «a. a. O.»', async () => {
  const groups = [group(1, 'K1', [
    `<p>A ${chip(7, '44')} B ${chip(8, '10')} C ${chip(7, '99')}</p>`,
  ])];
  const notes = (await buildEndnotes(groups, ctx())).groups[0].notes;
  assert.equal(notes[2].form, 'opCit');
  assert.equal(notes[2].text, 'Müller, a. a. O., S. 99.');
});

test('Erstnennung ist pro Kapitel voll — der Leser blaettert nicht zurueck', async () => {
  const groups = [
    group(1, 'K1', [`<p>A ${chip(7, '1')}</p>`]),
    group(2, 'K2', [`<p>B ${chip(7, '2')}</p>`]),
  ];
  const r = await buildEndnotes(groups, ctx());
  assert.equal(r.groups[0].notes[0].form, 'full');
  assert.equal(r.groups[1].notes[0].form, 'full');
});

test('englische Kurzformen folgen der Buchsprache', async () => {
  const groups = [group(1, 'K1', [`<p>A ${chip(7, '44')} B ${chip(7, '44')}</p>`])];
  const notes = (await buildEndnotes(groups, ctx({ lang: 'en' }))).groups[0].notes;
  assert.equal(notes[1].text, 'Ibid.');
});

// ── Blockzitate ──────────────────────────────────────────────────────────────

test('Belegtes Blockzitat ohne eigenen Chip bekommt seine Note ans Zitatende', async () => {
  const groups = [group(1, 'K1', [
    `<blockquote data-src="8"><p>Woertlich uebernommen</p></blockquote>`,
  ])];
  const r = await buildEndnotes(groups, ctx());
  assert.equal(r.groups[0].notes.length, 1);
  // Marker sitzt IM letzten Absatz, nicht hinter dem Blockquote.
  assert.match(r.groups[0].pages[0].pd.html, /Woertlich uebernommen<span class="cite" data-src="8"><sup>1<\/sup><\/span><\/p>/);
});

test('Belegtes Blockzitat MIT eigenem Chip bekommt keine zweite Note', async () => {
  const groups = [group(1, 'K1', [
    `<blockquote data-src="8"><p>Woertlich ${chip(8, '12')}</p></blockquote>`,
  ])];
  const r = await buildEndnotes(groups, ctx());
  assert.equal(r.groups[0].notes.length, 1);
  assert.equal(r.groups[0].notes[0].form, 'full');
});

// ── Robustheit ───────────────────────────────────────────────────────────────

test('Chip auf eine unbekannte Quelle behaelt seinen Text und bekommt keine Note', async () => {
  const groups = [group(1, 'K1', [`<p>A ${chip(999, '4')}</p>`])];
  const r = await buildEndnotes(groups, ctx());
  assert.equal(r.total, 0);
  assert.match(r.groups[0].pages[0].pd.html, /\(Cache-Text\)/);
});

test('Der Zeiger bleibt unberuehrt — nur der Chip-INHALT wird ersetzt', async () => {
  const groups = [group(1, 'K1', [`<p>A ${chip(7, '44')}</p>`])];
  const html = (await buildEndnotes(groups, ctx())).groups[0].pages[0].pd.html;
  assert.match(html, /data-src="7"/);
  assert.match(html, /data-loc="44"/);
  assert.equal(html.includes('Cache-Text'), false);
});

test('Seiten ohne Belegstelle und leere Eingaben bleiben unveraendert', async () => {
  const groups = [group(1, 'K1', ['<p>Nur Text</p>'])];
  const r = await buildEndnotes(groups, ctx());
  assert.equal(r.total, 0);
  assert.equal(r.groups[0].pages[0].pd.html, '<p>Nur Text</p>');
  assert.deepEqual((await buildEndnotes([], ctx())).groups, []);
  // Ohne Quellen im Kontext passiert nichts — kein Sonderpfad beim Aufrufer.
  const untouched = await buildEndnotes(groups, { sourcesById: new Map() });
  assert.equal(untouched.total, 0);
});

test('endnoteItemHtml stellt die Ziffer vor den Eintrag', () => {
  const html = endnoteItemHtml([{ n: 3, html: 'Müller, A. (2020).' }]);
  assert.equal(html, '<p>3. Müller, A. (2020).</p>');
  assert.equal(endnoteItemHtml([]), '');
});

test('Modus-Enum deckt sich mit dem, was die Schicht darunter kennt', async () => {
  assert.deepEqual(CITATION_NOTES_MODES, ['inline', 'endnotes', 'footnotes']);
  const { VALID_CITATION_NOTES } = await import('../../db/schema.js').then(m => m.default || m);
  assert.deepEqual([...VALID_CITATION_NOTES].sort(), [...CITATION_NOTES_MODES].sort());
  // Dritte Stelle: die Frontend-Liste, aus der die Combobox ihre Optionen baut.
  // Laeuft sie auseinander, bietet die Oberflaeche einen Modus an, den der
  // Endpunkt mit 400 verwirft (oder verschweigt einen, den es gibt).
  const { CITATION_NOTES } = await import('../../public/js/book/book-settings/citation.js');
  assert.deepEqual([...CITATION_NOTES].sort(), [...CITATION_NOTES_MODES].sort());
});

// ── Reine Note-Logik ─────────────────────────────────────────────────────────

test('noteForm: ibid vor opCit vor full', () => {
  const seen = new Set([7]);
  assert.equal(noteForm({ sourceId: 7 }, { sourceId: 7 }, seen), 'ibid');
  assert.equal(noteForm({ sourceId: 7 }, { sourceId: 8 }, seen), 'opCit');
  assert.equal(noteForm({ sourceId: 9 }, { sourceId: 8 }, seen), 'full');
  assert.equal(noteForm({ sourceId: 9 }, null, new Set()), 'full');
});

test('noteRuns: der Schlusspunkt des Eintrags kollabiert vor der Stellenangabe', () => {
  const labels = labelsFor('de');
  const runs = noteRuns({
    form: 'full',
    fullRuns: [{ text: 'Müller, A. (2020). Titel. Verlag.' }],
    loc: '44',
    labels,
  });
  const text = runsToText(runs);
  assert.equal(text, 'Müller, A. (2020). Titel. Verlag, S. 44.');
  assert.equal(text.includes('.,'), false, 'kein «Verlag., S. 44»');
});

test('noteRuns: eine bereits qualifizierte Stellenangabe bleibt unveraendert', () => {
  const labels = labelsFor('de');
  const runs = noteRuns({ form: 'ibid', loc: 'Kap. 3', prevLoc: '44', labels });
  assert.equal(runsToText(runs), 'Ebd., Kap. 3.');
});
