// Fussnotenapparat am Seitenfuss (lib/pdf-render/footnotes.js + der Fit-Check in
// justify.js).
//
// Die zentrale Zusage ist raeumlich und darum nur am gerenderten PDF pruefbar:
// JEDE NOTE STEHT AUF DER SEITE IHRES MARKERS. Alles andere in dieser Datei
// stuetzt genau das ab — die Reserve, der Deckel und vor allem die
// Terminierung des Umbruchs.

import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PDFDocument = require('pdfkit');
const { createFootnoteState, noteIdsOfLine } = require('../../lib/pdf-render/footnotes.js');
const { renderPdfBuffer } = require('../../lib/pdf-render/index.js');
const { defaultConfig } = require('../../lib/pdf-export-defaults.js');

const OUTER = { top: 50, right: 50, bottom: 50, left: 50 };

function stubDoc() {
  const doc = new PDFDocument({ size: 'A5', margin: 50, bufferPages: true });
  for (const k of ['footnote', 'footnote-bold', 'footnote-italic', 'footnote-bolditalic']) {
    doc.registerFont(k, 'Helvetica');
  }
  return doc;
}

function state(doc, notes, over = {}) {
  return createFootnoteState({
    doc,
    notesById: new Map(notes.map(n => [n.id, n])),
    cfg: { separator: true, separatorWidthMm: 30, gapMm: 2, hangMm: 4, maxHeightPct: 45, ...over },
    fontCfg: { sizePt: 8, lineHeight: 1.25 },
    outerMargins: OUTER,
    pageWidth: doc.page.width,
    pageHeight: doc.page.height,
  });
}

const NOTE = (id, text) => ({ id, n: id, runs: [{ text }] });

// ── Reserve ──────────────────────────────────────────────────────────────────

test('commit blaeht margins.bottom auf — der einzige Hebel, den alle Umbruchpruefungen sehen', () => {
  const doc = stubDoc();
  const fn = state(doc, [NOTE(1, 'Kafka, Franz: Die Verwandlung.')]);
  const before = doc.page.margins.bottom;
  fn.commit(0, [1]);
  assert.ok(doc.page.margins.bottom > before, 'Rand muss wachsen');
  // Genau um die Reservehoehe, nicht um mehr.
  const [[, st]] = fn.pages();
  assert.ok(Math.abs((doc.page.margins.bottom - before) - st.reserveH) < 0.01);
});

test('zweite Note auf derselben Seite zieht nur die Differenz nach (kein Doppel-Aufschlag)', () => {
  const doc = stubDoc();
  const fn = state(doc, [NOTE(1, 'Erste Note.'), NOTE(2, 'Zweite Note.')]);
  const base = doc.page.margins.bottom;
  fn.commit(0, [1]);
  const afterOne = doc.page.margins.bottom;
  fn.commit(0, [2]);
  const [[, st]] = fn.pages();
  assert.equal(st.notes.length, 2);
  assert.ok(Math.abs((doc.page.margins.bottom - base) - st.reserveH) < 0.01, 'Rand spiegelt die Gesamtreserve');
  assert.ok(doc.page.margins.bottom > afterOne);
});

test('dieselbe Note zweimal zugeschlagen zaehlt einmal', () => {
  const doc = stubDoc();
  const fn = state(doc, [NOTE(1, 'Nur einmal.')]);
  fn.commit(0, [1]);
  const h = fn.pages()[0][1].reserveH;
  fn.commit(0, [1]);
  assert.equal(fn.pages()[0][1].notes.length, 1);
  assert.equal(fn.pages()[0][1].reserveH, h);
});

test('der Separator zaehlt nur vor der ERSTEN Note einer Seite', () => {
  const doc = stubDoc();
  const fn = state(doc, [NOTE(1, 'A.'), NOTE(2, 'B.')]);
  const first = fn.extraHeightFor(0, [1]);
  fn.commit(0, [1]);
  const second = fn.extraHeightFor(0, [2]);
  assert.ok(first > second, 'die erste Note kostet zusaetzlich den Separator');
  assert.ok(Math.abs((first - second) - fn.separatorHeight()) < 0.01);
});

// ── Deckel ───────────────────────────────────────────────────────────────────

test('Deckel begrenzt den Apparat auf seinen Anteil des Satzspiegels', () => {
  const doc = stubDoc();
  const fn = state(doc, [NOTE(1, 'x')], { maxHeightPct: 20 });
  const textBlock = doc.page.height - OUTER.top - OUTER.bottom;
  assert.ok(Math.abs(fn.capPt - textBlock * 0.2) < 0.01);
  assert.equal(fn.wouldExceedCap(0, fn.capPt - 1), false);
  assert.equal(fn.wouldExceedCap(0, fn.capPt + 1), true);
});

test('eine Note ueber dem Deckel wird geclampt und als Ueberlauf gemeldet', () => {
  const doc = stubDoc();
  const lang = 'Sehr langer Notentext der garantiert ueber den Deckel hinauslaeuft. '.repeat(40);
  const fn = state(doc, [NOTE(1, lang)], { maxHeightPct: 15 });
  fn.commit(0, [1], { maxReserve: fn.capPt });
  const [[, st]] = fn.pages();
  assert.ok(st.reserveH <= fn.capPt + 0.01, 'Reserve bleibt unter dem Deckel');
  assert.ok(st.overflow > 0, 'der ueberstehende Teil wird als Ueberlauf gefuehrt');
  assert.equal(fn.overflowCount(), 1);
});

// ── Marker-Zuordnung ─────────────────────────────────────────────────────────

test('noteIdsOfLine faltet Verbund-Tokens auf — sonst entgeht genau der geklebte Marker', () => {
  const line = { items: [
    { parts: [{ text: 'Satz', style: {} }, { text: '3', style: { sup: true, noteId: 7 } }] },
    { word: 'weiter', style: {} },
    { word: '9', style: { sup: true, noteId: 9 } },
  ] };
  assert.deepEqual(noteIdsOfLine(line), [7, 9]);
  assert.deepEqual(noteIdsOfLine({ items: [{ word: 'a', style: {} }] }), []);
  // Ein `<sup>` aus dem Manuskript (m²) traegt keine ID und darf keine Note ziehen.
  assert.deepEqual(noteIdsOfLine({ items: [{ word: '2', style: { sup: true } }] }), []);
});

// ── Die eigentliche Zusage, am gerenderten PDF ───────────────────────────────

const SRC = {
  id: 7, csl_type: 'book', title: 'Die Verwandlung', year: '1915',
  authors: [{ family: 'Kafka', given: 'Franz' }], editors: [],
  publisher: 'Kurt Wolff', place: 'Leipzig',
};

function fnBib(over = {}) {
  return {
    enabled: false, notesMode: 'footnotes', notesTitle: 'Anmerkungen', title: 'Quellen',
    style: 'apa7', lang: 'de', scope: 'cited',
    numbers: new Map(), suffixes: new Map(),
    sourcesById: new Map([[7, SRC]]), entries: [],
    ...over,
  };
}

function fnCfg(over = {}) {
  const c = defaultConfig();
  c.cover.enabled = false;
  c.toc.enabled = false;
  c.pdfa.enabled = false;
  Object.assign(c.layout, over);
  return c;
}

// Genug Text fuer mehrere Seiten, jede vierte Passage belegt.
function longGroups(markEvery = 4, count = 40) {
  const chip = loc => `<span class="cite" data-src="7" data-loc="${loc}">(x)</span>`;
  let html = '';
  for (let i = 0; i < count; i++) {
    html += `<p>Absatz ${i} mit reichlich Text damit die Seite voll wird und der Umbruch greift, denn nur so zeigt sich ob der Apparat den Platz richtig reserviert${i % markEvery === 0 ? chip(String(40 + i)) : ''}. Weiterer Text zum Auffuellen.</p>`;
  }
  return [{ chapter: { id: 1, name: 'Erstes Kapitel', parent_chapter_id: null }, chapterId: 1, pages: [{ p: { id: 1, name: 'S1' }, pd: { html } }] }];
}

async function pageTexts(buf) {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const doc = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(doc, { mergePages: false });
  return text.map(t => String(t).replace(/\s+/g, ' '));
}

/** Textstuecke je Seite MIT y-Position (PDF-Koordinaten: y waechst nach oben).
 *  Nur damit laesst sich pruefen, dass der Apparat den Fliesstext nicht
 *  ueberlagert — im reinen Text sieht eine Ueberlappung genauso aus wie ein
 *  sauber gesetzter Seitenfuss. */
async function pageItems(buf) {
  const { getDocumentProxy } = await import('unpdf');
  const doc = await getDocumentProxy(new Uint8Array(buf));
  const out = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    out.push(tc.items.filter(i => i.str && i.str.trim()).map(i => ({ s: i.str, y: i.transform[5] })));
  }
  return out;
}

test('jede Note steht auf der Seite ihres Markers', async () => {
  const meta = {};
  const buf = await renderPdfBuffer({
    book: { id: 1, name: 'Testbuch' }, groups: longGroups(), profile: { config: fnCfg() },
    coverBuf: null, token: null, scope: 'book', meta, bibliography: fnBib(),
  });
  assert.equal(meta.footnoteOverflowPages, 0, 'kein Apparat darf ueberlaufen');

  const pages = await pageTexts(buf);
  let seen = 0;
  for (const [i, flat] of pages.entries()) {
    // Marker klebt am Wort davor (justify.js#_tokenize) → "reserviert7."
    const markers = [...flat.matchAll(/reserviert(\d+)\./g)].map(m => m[1]);
    const notes = [...flat.matchAll(/(\d+)\. (?:Kafka|Ebd)/g)].map(m => m[1]);
    seen += markers.length;
    assert.deepEqual(
      markers.filter(n => !notes.includes(n)), [],
      `Seite ${i}: Note fehlt zum Marker. Text: ${flat.slice(0, 300)}`,
    );
    assert.deepEqual(
      notes.filter(n => !markers.includes(n)), [],
      `Seite ${i}: Note ohne Marker auf dieser Seite. Text: ${flat.slice(0, 300)}`,
    );
  }
  assert.ok(seen >= 8, `zu wenige Marker gefunden (${seen}) — der Test misst sonst nichts`);
});

test('der Apparat ueberlagert den Fliesstext nicht — er steht unter der letzten Zeile', async () => {
  // DAS ist die Zusage, fuer die die Reserve existiert. Sie ist NUR geometrisch
  // pruefbar: faellt die Reserve aus, laufen Text und Apparat ineinander, aber
  // die extrahierte Textreihenfolge sieht unveraendert aus.
  const buf = await renderPdfBuffer({
    book: { id: 1, name: 'T' }, groups: longGroups(), profile: { config: fnCfg() },
    coverBuf: null, token: null, scope: 'book', meta: {}, bibliography: fnBib(),
  });
  let checked = 0;
  for (const [i, items] of (await pageItems(buf)).entries()) {
    const noteYs = items.filter(it => /Kafka|Ebd/.test(it.s)).map(it => it.y);
    const bodyYs = items.filter(it => /Absatz|reserviert|Auffuellen/.test(it.s)).map(it => it.y);
    if (!noteYs.length || !bodyYs.length) continue;
    checked++;
    const noteTop = Math.max(...noteYs);
    const bodyBottom = Math.min(...bodyYs);
    assert.ok(
      bodyBottom > noteTop,
      `Seite ${i}: Apparat (y=${noteTop.toFixed(1)}) ragt in den Fliesstext (unterste Zeile y=${bodyBottom.toFixed(1)})`,
    );
  }
  assert.ok(checked >= 2, `zu wenige Seiten mit Apparat geprueft (${checked})`);
});

test('Klammerform verschwindet, Ebd. erscheint — der Apparat ersetzt den Inline-Beleg', async () => {
  const buf = await renderPdfBuffer({
    book: { id: 1, name: 'T' }, groups: longGroups(2, 12), profile: { config: fnCfg() },
    coverBuf: null, token: null, scope: 'book', meta: {}, bibliography: fnBib(),
  });
  const all = (await pageTexts(buf)).join(' ');
  assert.equal(all.includes('(Kafka, 1915'), false, 'Kurzbeleg darf nicht mehr im Text stehen');
  assert.ok(all.includes('Ebd.'), 'Wiederholungen werden gekuerzt');
});

test('eine Note laenger als der Deckel wird gesetzt und gemeldet, der Umbruch laeuft weiter', async () => {
  const huge = { ...SRC, title: 'Ein ausserordentlich langer Werktitel der jede Fussnote sprengt '.repeat(60) };
  const meta = {};
  const t0 = Date.now();
  const buf = await renderPdfBuffer({
    book: { id: 1, name: 'T' }, groups: longGroups(3, 12), profile: { config: fnCfg() },
    coverBuf: null, token: null, scope: 'book', meta,
    bibliography: fnBib({ sourcesById: new Map([[7, huge]]) }),
  });
  // Terminierung ist strukturell (hoechstens ein Seitenumbruch pro Zeile, plus
  // Deckel) — die Zeitschranke faengt eine kuenftige Regression, die daraus eine
  // Schleife machen wuerde.
  assert.ok(Date.now() - t0 < 20000, 'Umbruch muss terminieren');
  assert.equal(buf.slice(0, 5).toString(), '%PDF-');
  assert.ok(meta.footnoteOverflowPages > 0, 'der Ueberlauf muss gemeldet werden');
});

test('Zweispaltensatz faellt auf den Kapitelapparat zurueck und meldet das', async () => {
  const meta = {};
  const buf = await renderPdfBuffer({
    book: { id: 1, name: 'T' }, groups: longGroups(4, 20), profile: { config: fnCfg({ columns: 2 }) },
    coverBuf: null, token: null, scope: 'book', meta, bibliography: fnBib(),
  });
  assert.equal(meta.footnoteFallback, true);
  const all = (await pageTexts(buf)).join(' ');
  // Kapitelapparat traegt seine Ueberschrift; der Seitenfuss-Apparat nicht.
  assert.ok(all.includes('Anmerkungen'), 'Fallback muss den Kapitelapparat zeigen');
});
