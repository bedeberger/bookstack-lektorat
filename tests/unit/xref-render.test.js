'use strict';
// Render-Zeit-Aufloesung der Querverweise: Nummern folgen der gerenderten
// Einheit, Attribute bleiben unberuehrt, Verwaiste werden nie ueberschrieben.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

process.env.DB_PATH = path.join('/tmp', `xref-render-test-${process.pid}-${Date.now()}.db`);

const schema = require('../../db/schema');
const { db } = require('../../db/schema');
const { buildXrefContext, applyXrefsInHtml, applyXrefsInGroups } = require('../../lib/xref-render');

const BOOK = 910;
schema.upsertBookByName(BOOK, 'Render-Buch');
db.prepare(`INSERT INTO chapters (chapter_id, book_id, chapter_name, position)
            VALUES (7110, ${BOOK}, 'Anfang', 0), (7111, ${BOOK}, 'Mitte', 1)`).run();

const FIG = (bid, cap) =>
  `<figure data-bid="${bid}"><img src="x.png"><figcaption>${cap}</figcaption></figure>`;
const TBL = (bid, cap) =>
  `<table data-bid="${bid}"><caption>${cap}</caption>`
  + '<thead><tr><th scope="col">Jahr</th></tr></thead><tbody><tr><td>2023</td></tr></tbody></table>';
const REF = (kind, id, text, fmt) =>
  `<span class="xref" data-xref="${kind}" data-xref-id="${id}"${fmt ? ` data-xref-fmt="${fmt}"` : ''}>${text}</span>`;

// groups-Shape von lib/load-contents
const GROUPS = [
  {
    chapterId: 7110,
    chapter: { id: 7110, chapter_name: 'Anfang', parent_chapter_id: null },
    pages: [{
      p: { id: 8110 },
      pd: {
        html: `<p>Los.</p>${FIG('aaaaaaaaaaaaaaaa', 'Der Kaefer')}`
          + TBL('cccccccccccccccc', 'Umsatz nach Jahr'),
      },
    }],
  },
  {
    chapterId: 7111,
    chapter: { id: 7111, chapter_name: 'Mitte', parent_chapter_id: null },
    pages: [{ p: { id: 8111 }, pd: { html: `<p>Weiter.</p>${FIG('bbbbbbbbbbbbbbbb', 'Das Zimmer')}` } }],
  },
];

async function ctxWith({ figureNumbering = 1, tableNumbering = 0, chapterLabels = null } = {}) {
  schema.setBookXrefSettings(BOOK, {
    figure_numbering: figureNumbering,
    table_numbering: tableNumbering,
  });
  return buildXrefContext({ bookId: BOOK, groups: GROUPS, chapterLabels });
}

test('Kapitel- und Abbildungsverweise werden aufgeloest', async () => {
  const ctx = await ctxWith();
  const res = await applyXrefsInHtml(
    `<p>Siehe ${REF('chapter', '7111', 'Kapitel 9')} und ${REF('figure', 'bbbbbbbbbbbbbbbb', 'Abb. 9.9')}.</p>`,
    ctx,
  );
  assert.match(res.html, /Kapitel 2/);
  assert.match(res.html, /Abb\. 2\.1/);
  assert.equal(res.unresolved.length, 0);
});

test('Invariante B: Attribute des Markers bleiben unberuehrt', async () => {
  const ctx = await ctxWith();
  const res = await applyXrefsInHtml(`<p>${REF('chapter', '7110', 'veraltet')}</p>`, ctx);
  assert.match(res.html, /data-xref="chapter"/);
  assert.match(res.html, /data-xref-id="7110"/);
  assert.match(res.html, /class="xref"/);
  assert.match(res.html, />Kapitel 1</);
});

test('Invariante B: unveraendertes HTML kommt als EINGABE-String zurueck', async () => {
  const ctx = await ctxWith({ figureNumbering: 0 });
  const html = '<p>Ganz normaler Text.</p>';
  const res = await applyXrefsInHtml(html, ctx);
  assert.strictEqual(res.html, html);
});

test('Invariante C: verwaister Verweis behaelt den Text des Autors und wird gemeldet', async () => {
  const ctx = await ctxWith();
  const res = await applyXrefsInHtml(`<p>Siehe ${REF('chapter', '99999', 'Kapitel 4')}.</p>`, ctx);
  // Kein „???", kein leerer Verweis — der Cache-Text bleibt stehen.
  assert.match(res.html, />Kapitel 4</);
  assert.equal(res.unresolved.length, 1);
  assert.equal(res.unresolved[0].kind, 'chapter');
  assert.equal(res.unresolved[0].target, '99999');
});

test('Nummern folgen der gerenderten Einheit: Profil-Labels schlagen die Vorgabe', async () => {
  // Dasselbe Ziel, anderes Exportprofil → anderer Text. Genau der Punkt des
  // Features (Muster: numerische Quellen-Nummern in lib/bibliography.js).
  const ctx = await ctxWith({ chapterLabels: new Map([['7110', 'III'], ['7111', 'IV']]) });
  const res = await applyXrefsInHtml(`<p>${REF('chapter', '7111', 'x')}</p>`, ctx);
  assert.match(res.html, />Kapitel IV</);
  // Und die Abbildung erbt das Praefix ihres Kapitels.
  const res2 = await applyXrefsInHtml(`<p>${REF('figure', 'bbbbbbbbbbbbbbbb', 'x')}</p>`, ctx);
  assert.match(res2.html, />Abb\. IV\.1</);
});

test('Anzeigeform number/title', async () => {
  const ctx = await ctxWith();
  const num = await applyXrefsInHtml(`<p>${REF('chapter', '7111', 'x', 'number')}</p>`, ctx);
  assert.match(num.html, />2</);
  const tit = await applyXrefsInHtml(`<p>${REF('figure', 'aaaaaaaaaaaaaaaa', 'x', 'title')}</p>`, ctx);
  assert.match(tit.html, />Abb\. 1\.1: Der Kaefer</);
});

test('Legenden werden nummeriert, wenn die Einstellung an ist', async () => {
  const ctx = await ctxWith({ figureNumbering: 1 });
  const res = await applyXrefsInHtml(FIG('aaaaaaaaaaaaaaaa', 'Der Kaefer'), ctx);
  assert.match(res.html, /<figcaption>Abb\. 1\.1: Der Kaefer<\/figcaption>/);
});

test('Legenden-Nummerierung ist idempotent (kein doppeltes Praefix)', async () => {
  const ctx = await ctxWith({ figureNumbering: 1 });
  const once = await applyXrefsInHtml(FIG('aaaaaaaaaaaaaaaa', 'Der Kaefer'), ctx);
  const twice = await applyXrefsInHtml(once.html, ctx);
  assert.strictEqual(twice.html, once.html);
});

test('ohne Legenden-Nummerierung nennt auch der Verweis keine Zahl', async () => {
  // Sonst zeigte der Text auf eine Nummer, die im Dokument nirgends steht.
  const ctx = await ctxWith({ figureNumbering: 0 });
  const res = await applyXrefsInHtml(`<p>${REF('figure', 'aaaaaaaaaaaaaaaa', 'Abb. 1.1')}</p>`, ctx);
  assert.match(res.html, />„Der Kaefer“</);
  assert.doesNotMatch(res.html, /Abb\. 1\.1<\/span>/);
});

// ── Tabellenbeschriftung: eigener Schalter, eigener Gate ────────────────────
// Der Vorab-Test in applyXrefsInHtml hing frueher an `figureNumbering` UND am
// Vorkommen von `<figure>`. Beides ist fuer Tabellen falsch: ein Fachbuch
// nummeriert oft Tabellen und keine Abbildungen, und eine Seite kann
// ausschliesslich Tabellen fuehren. Die drei Faelle unten sind die Mutationen,
// die den alten Gate rot machen.

test('Beschriftung wird nummeriert, wenn NUR die Tabellen-Einstellung an ist', async () => {
  const ctx = await ctxWith({ figureNumbering: 0, tableNumbering: 1 });
  const res = await applyXrefsInHtml(TBL('cccccccccccccccc', 'Umsatz nach Jahr'), ctx);
  assert.match(res.html, /<caption>Tab\. 1\.1: Umsatz nach Jahr<\/caption>/);
});

test('Tabelle ohne Abbildung auf der Seite bekommt trotzdem ihre Nummer', async () => {
  // Der alte Gate testete auf `<figure>` im HTML — eine reine Tabellenseite
  // fiel damit still durch, obwohl beide Schalter an waren.
  const ctx = await ctxWith({ figureNumbering: 1, tableNumbering: 1 });
  const res = await applyXrefsInHtml(TBL('cccccccccccccccc', 'Umsatz nach Jahr'), ctx);
  assert.match(res.html, /<caption>Tab\. 1\.1: Umsatz nach Jahr<\/caption>/);
});

test('ein ausgeschalteter Schalter zieht den anderen Typ nicht mit', async () => {
  const html = FIG('aaaaaaaaaaaaaaaa', 'Der Kaefer') + TBL('cccccccccccccccc', 'Umsatz nach Jahr');
  const nurTab = await applyXrefsInHtml(html, await ctxWith({ figureNumbering: 0, tableNumbering: 1 }));
  assert.match(nurTab.html, /<caption>Tab\. 1\.1: /);
  assert.match(nurTab.html, /<figcaption>Der Kaefer<\/figcaption>/, 'Abbildung bleibt ohne Nummer');
  const nurAbb = await applyXrefsInHtml(html, await ctxWith({ figureNumbering: 1, tableNumbering: 0 }));
  assert.match(nurAbb.html, /<figcaption>Abb\. 1\.1: /);
  assert.match(nurAbb.html, /<caption>Umsatz nach Jahr<\/caption>/, 'Tabelle bleibt ohne Nummer');
});

test('Tabellen-Beschriftung ist ebenfalls idempotent', async () => {
  const ctx = await ctxWith({ tableNumbering: 1 });
  const once = await applyXrefsInHtml(TBL('cccccccccccccccc', 'Umsatz nach Jahr'), ctx);
  const twice = await applyXrefsInHtml(once.html, ctx);
  assert.strictEqual(twice.html, once.html);
});

test('applyXrefsInGroups mutiert die Eingabe nicht und sammelt Verwaiste', async () => {
  const ctx = await ctxWith();
  const input = [{
    chapterId: 7110,
    chapter: GROUPS[0].chapter,
    pages: [{ p: { id: 8110 }, pd: { html: `<p>${REF('chapter', '99999', 'Kapitel Weg')}</p>` } }],
  }];
  const before = input[0].pages[0].pd.html;
  const res = await applyXrefsInGroups(input, ctx);
  assert.strictEqual(input[0].pages[0].pd.html, before);
  assert.equal(res.unresolved.length, 1);
  assert.equal(res.unresolved[0].pageId, 8110);
});
