// Unit-Tests für den Filter der Titel-Werkstatt.
//
// Zwei Zusagen, die man der Karte nicht ansieht:
//   1. Ein gewähltes Kapitel schliesst seine Sub-Kapitel EIN — `nav.tree` ist
//      flach (Knoten mit `parent_id`, siehe book/tree/load.js), die Hierarchie
//      steckt allein in der Kette. Ohne die Nachfahren wäre die Auswahl eines
//      Ober-Kapitels ohne eigene Seiten leer.
//   2. Die Freitext-Suche greift genau die drei Spalten, die die Tabelle zeigt
//      (Beitragsname, Dachzeile, Titel) — nicht Lead/Teaser.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { titelwerkstattMethods } = await import('../../public/js/book/titelwerkstatt.js');

// `nav.tree`: flache Liste, Kapitel 2 hat ein Sub-Kapitel (21), das seinerseits
// ein Sub-Sub-Kapitel (211) hat — die drei erlaubten Ebenen.
const TREE = [
  { type: 'chapter', id: 'solo-9', name: 'Loses Blatt', depth: 1, parent_id: null, solo: true },
  { type: 'chapter', id: 1,   name: 'Politik',     depth: 1, parent_id: null, solo: false },
  { type: 'chapter', id: 2,   name: 'Kultur',      depth: 1, parent_id: null, solo: false },
  { type: 'chapter', id: 21,  name: 'Musik',       depth: 2, parent_id: 2,    solo: false },
  { type: 'chapter', id: 211, name: 'Jazz',        depth: 3, parent_id: 21,   solo: false },
];

const PAGES = [
  { id: 10, name: 'Abstimmung', chapter_id: 1 },
  { id: 11, name: 'Konzert',    chapter_id: 21 },
  { id: 12, name: 'Session',    chapter_id: 211 },
  { id: 13, name: 'Vernissage', chapter_id: 2 },
  { id: 14, name: 'Notiz',      chapter_id: null },
];

const HEADLINES = {
  10: { dachzeile: 'Bundeshaus', titel: 'Das Nein zur Reform', lead: 'Am Sonntag…', teaser: '' },
  11: { dachzeile: 'Kaserne',    titel: 'Ein lauter Abend',    lead: '', teaser: 'Rockmusik im Hof' },
  12: { dachzeile: '',           titel: '',                    lead: '', teaser: '' },
  13: { dachzeile: 'Galerie',    titel: 'Reform der Blicke',   lead: '', teaser: '' },
};

function makeCtx({ suche = '', kapitel = '' } = {}) {
  const ctx = {
    twPages: Object.fromEntries(Object.entries(HEADLINES)),
    twFilterSuche: suche,
    twFilterKapitel: kapitel,
    twOpenId: null,
    _twRev: 0,
    _memos: {},
    ...titelwerkstattMethods,
  };
  // Die Methoden lesen Seiten und Tree über den Root/Store — im Test gespiegelt.
  globalThis.window = {
    Alpine: { store: (n) => (n === 'nav' ? { pages: PAGES, tree: TREE } : null) },
    __app: { $store: { nav: { pages: PAGES, tree: TREE } } },
  };
  return ctx;
}

const namen = (rows) => rows.map(r => r.name);

// ── Kapitel-Filter ─────────────────────────────────────────────────────────

test('ohne Filter stehen alle Beiträge in der Liste', () => {
  assert.deepEqual(namen(makeCtx().twFilteredRows()),
    ['Abstimmung', 'Konzert', 'Session', 'Vernissage', 'Notiz']);
});

test('Kapitel-Filter schliesst Sub- und Sub-Sub-Kapitel ein', () => {
  // Kultur (2) hat eine eigene Seite, Musik (21) und Jazz (211) je eine —
  // gewählt ist nur das Ober-Kapitel.
  assert.deepEqual(namen(makeCtx({ kapitel: '2' }).twFilteredRows()),
    ['Konzert', 'Session', 'Vernissage']);
});

test('Sub-Kapitel gewählt: nur dessen Ast, nicht das Ober-Kapitel', () => {
  assert.deepEqual(namen(makeCtx({ kapitel: '21' }).twFilteredRows()),
    ['Konzert', 'Session']);
});

test('Kapitel ohne Nachfahren liefert nur seine eigenen Beiträge', () => {
  assert.deepEqual(namen(makeCtx({ kapitel: '1' }).twFilteredRows()), ['Abstimmung']);
});

test('Seiten ohne Kapitel fallen aus jeder Kapitelauswahl heraus', () => {
  const rows = makeCtx({ kapitel: '1' }).twFilteredRows();
  assert.ok(!namen(rows).includes('Notiz'));
});

// ── Freitext ───────────────────────────────────────────────────────────────

test('Suche greift den Titel, nicht nur den Beitragsnamen', () => {
  assert.deepEqual(namen(makeCtx({ suche: 'reform' }).twFilteredRows()),
    ['Abstimmung', 'Vernissage']);
});

test('Suche greift die Dachzeile', () => {
  assert.deepEqual(namen(makeCtx({ suche: 'kaserne' }).twFilteredRows()), ['Konzert']);
});

test('Suche greift NICHT Lead oder Teaser — die Tabelle zeigt sie nicht', () => {
  assert.deepEqual(makeCtx({ suche: 'Sonntag' }).twFilteredRows(), []);
  assert.deepEqual(makeCtx({ suche: 'Rockmusik' }).twFilteredRows(), []);
});

test('Suche ist unabhängig von Gross-/Kleinschreibung und Randleerzeichen', () => {
  assert.deepEqual(namen(makeCtx({ suche: '  KONZERT ' }).twFilteredRows()), ['Konzert']);
});

test('Suche und Kapitel wirken zusammen, nicht alternativ', () => {
  assert.deepEqual(namen(makeCtx({ suche: 'reform', kapitel: '2' }).twFilteredRows()),
    ['Vernissage']);
});

// ── Aufgeklappte Zeile ─────────────────────────────────────────────────────

test('_twCloseHiddenRow schliesst eine Zeile, die der Filter ausblendet', () => {
  const ctx = makeCtx({ kapitel: '1' });
  ctx.twOpenId = 11; // Konzert liegt in Kultur/Musik, nicht in Politik
  ctx._twCloseHiddenRow();
  assert.equal(ctx.twOpenId, null);
});

test('_twCloseHiddenRow lässt eine sichtbare Zeile offen', () => {
  const ctx = makeCtx({ kapitel: '1' });
  ctx.twOpenId = 10;
  ctx._twCloseHiddenRow();
  assert.equal(ctx.twOpenId, 10);
});

// ── Zähler ─────────────────────────────────────────────────────────────────

test('twMitTitel zählt buchweit, nicht im Filter-Ausschnitt', () => {
  // Drei Beiträge haben einen Titel; der Filter zeigt nur einen davon.
  assert.equal(makeCtx({ kapitel: '1' }).twMitTitel(), 3);
});
