// Beleg-Chip: Markup-SSoT (public/js/sources/cite-html.js) + die Pipelines, die
// ihn ueberleben lassen muessen.
//
// Warum diese Tests: der Chip laeuft durch sechs Schichten (Einfuegen, Mount,
// Dirty-Vergleich, Paste-Filter, Server-Cleaner, Indexierung). Jede kann ihn
// stillschweigend zerlegen — und dann steht im Text ein Kurzbeleg ohne Zeiger
// auf die Quelle, was man erst im fertigen Verzeichnis merkt.
//
// linkedom liefert das DOM: dasselbe, mit dem lib/html-clean.js und
// lib/cite-index.js serverseitig arbeiten. Damit testet dieselbe Suite die
// DOM-agnostische Zusage des Moduls mit.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';

import {
  CITE_CLASS, CITE_ATTR_SRC, CITE_ATTR_LOC, CITE_SEL,
  CITE_MODES, CITE_MODE_DEFAULT, CITED_QUOTE_SEL,
  isCiteEl, citeModeOf, isQuoteBlockEl, buildCiteHtml,
  collectCites, collectCiteIndex, collectQuoteBlocks, citationsFromCites,
  markCitesAtomic, closestCiteEl, closestQuoteBlock, setQuoteBlockSource,
} from '../../public/js/sources/cite-html.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function root(html) {
  const { document } = parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body></html>`);
  return document.getElementById('r');
}

const CHIP = '<span class="cite" data-src="7" data-loc="44">(Kafka, 1915, S. 44)</span>';

// ── Markup ───────────────────────────────────────────────────────────────────

test('buildCiteHtml erzeugt das dokumentierte Markup', () => {
  assert.equal(
    buildCiteHtml({ id: 7, loc: '44', text: '(Kafka, 1915, S. 44)' }),
    CHIP
  );
  // Ohne Stellenangabe kein leeres data-loc.
  assert.equal(
    buildCiteHtml({ id: 7, text: '(Kafka, 1915)' }),
    '<span class="cite" data-src="7">(Kafka, 1915)</span>'
  );
});

test('buildCiteHtml escapet Text und Stellenangabe', () => {
  // Beide stammen aus User-Eingabe (Quellenfelder bzw. Eingabefeld).
  const html = buildCiteHtml({ id: 7, loc: '"><script>x</script>', text: '<b>&</b>' });
  assert.ok(!html.includes('<script'));
  assert.ok(!html.includes('<b>'));
  assert.ok(html.includes('&lt;b&gt;&amp;&lt;/b&gt;'));
  // Attribut bleibt geschlossen — kein Ausbruch aus dem data-loc.
  assert.equal(root(html).querySelectorAll('span').length, 1);
  assert.equal(root(html).querySelector('span').getAttribute(CITE_ATTR_LOC), '"><script>x</script>');
});

test('buildCiteHtml verweigert ungueltige Zeiger', () => {
  for (const bad of [null, undefined, 0, -1, '', 'abc', '7x', 1.5]) {
    assert.equal(buildCiteHtml({ id: bad, text: 'x' }), '', String(bad));
  }
});

test('isCiteEl: nur span.cite mit numerischem data-src', () => {
  const ok = root(CHIP).firstElementChild;
  assert.equal(isCiteEl(ok), true);

  assert.equal(isCiteEl(root('<span class="cite">ohne Zeiger</span>').firstElementChild), false);
  assert.equal(isCiteEl(root('<span data-src="7">ohne Klasse</span>').firstElementChild), false);
  assert.equal(isCiteEl(root('<em class="cite" data-src="7">falscher Tag</em>').firstElementChild), false);
  assert.equal(isCiteEl(root('<span class="cite" data-src="abc">x</span>').firstElementChild), false);
  assert.equal(isCiteEl(root('<span class="cite" data-src="0">x</span>').firstElementChild), false);
  assert.equal(isCiteEl(null), false);
  // Zusaetzliche Klassen sind erlaubt (Editor darf dekorieren).
  assert.equal(isCiteEl(root('<span class="foo cite bar" data-src="7">x</span>').firstElementChild), true);
});

// ── Auslesen ─────────────────────────────────────────────────────────────────

test('collectCites liefert Zeiger, Stelle, Text und Textoffset', () => {
  const cites = collectCites(root(`<p>Vorher ${CHIP} nachher.</p>`));
  assert.equal(cites.length, 1);
  assert.equal(cites[0].id, 7);
  assert.equal(cites[0].loc, '44');
  assert.equal(cites[0].text, '(Kafka, 1915, S. 44)');
  // "Vorher " = 7 Zeichen → Chip beginnt bei Offset 7.
  assert.equal(cites[0].offset, 7);
});

test('collectCites: Offsets zaehlen den Chip-Text mit', () => {
  const a = buildCiteHtml({ id: 1, text: '[1]' });
  const b = buildCiteHtml({ id: 2, text: '[2]' });
  const cites = collectCites(root(`<p>ab${a}cd${b}</p>`));
  assert.deepEqual(cites.map(c => [c.id, c.offset]), [[1, 2], [2, 7]]);
  // "ab"(2) + "[1]"(3) + "cd"(2) = 7 — der Chip-Text steht auch im Seitentext
  // und geht in die Zeichenzahl ein (bei akademischen Vorgaben richtig).
});

test('collectCites laeuft in Dokumentordnung ueber Bloecke', () => {
  const html = `
    <p>eins ${buildCiteHtml({ id: 3, text: '[3]' })}</p>
    <blockquote><p>zwei ${buildCiteHtml({ id: 1, text: '[1]' })}</p></blockquote>
    <ul><li>drei ${buildCiteHtml({ id: 2, text: '[2]' })}</li></ul>`;
  assert.deepEqual(collectCites(root(html)).map(c => c.id), [3, 1, 2]);
});

test('collectCites steigt nicht in Chips ab und ignoriert Fremdmarkup', () => {
  // Verschachtelte Belege gibt es nicht — der innere Span darf nicht zaehlen.
  const nested = '<span class="cite" data-src="7">(a <span class="cite" data-src="8">b</span>)</span>';
  assert.deepEqual(collectCites(root(`<p>${nested}</p>`)).map(c => c.id), [7]);

  const foreign = '<p><span class="cite">kein Zeiger</span><span>nur Span</span></p>';
  assert.deepEqual(collectCites(root(foreign)), []);
  assert.deepEqual(collectCites(null), []);
});

test('citationsFromCites fasst Mehrfachbelege zusammen', () => {
  const cites = [
    { id: 7, offset: 100 },
    { id: 3, offset: 50 },
    { id: 7, offset: 10 },     // frueher, aber spaeter gefunden
    { id: null, offset: 0 },   // ohne Zeiger → faellt weg
  ];
  const rows = citationsFromCites(cites);
  // Eine Zeile je Quelle — der PK (source_id, page_id) erlaubt keine zwei.
  assert.equal(rows.length, 2);
  const seven = rows.find(r => r.sourceId === 7);
  assert.equal(seven.count, 2);
  // firstOffset ist das MINIMUM, nicht der erste gefundene Eintrag. Bei den Chips
  // allein waere beides gleich (collectCites liefert Dokumentordnung); die
  // Blockzitate kommen aber als zweite Liste dazu, und ein Blockzitat weit vorn
  // im Text darf den Wert eines spaeter gefundenen Chips nicht stehen lassen.
  assert.equal(seven.firstOffset, 10);
  assert.deepEqual(citationsFromCites(null), []);
});

// ── Zitat-Kategorien: Modus am Chip, Zeiger am Blockzitat ────────────────────
// Warum eigene Tests: an diesen zwei Attributen haengen drei Dinge, die man erst
// im fertigen Export bemerkt — das „vgl."-Praefix, die Zitat-Typografie und der
// Zitat-Anteil. Faellt eines still weg, sieht der Text im Editor korrekt aus.

test('data-mode steht nur im Markup, wenn es vom Default abweicht', () => {
  // Der Default darf NICHT persistiert werden: sonst braeuchten alle bestehenden
  // Chips eine Migration, und jede Seite mit Beleg gilt beim Oeffnen als dirty.
  assert.equal(
    buildCiteHtml({ id: 7, text: '(Kafka, 1915)', mode: 'quote' }),
    '<span class="cite" data-src="7">(Kafka, 1915)</span>'
  );
  assert.equal(
    buildCiteHtml({ id: 7, loc: '44', text: '(vgl. Kafka, 1915, S. 44)', mode: 'paraphrase' }),
    '<span class="cite" data-src="7" data-loc="44" data-mode="paraphrase">(vgl. Kafka, 1915, S. 44)</span>'
  );
  // Unbekannter Modus faellt auf den Default zurueck statt ins Markup zu lecken.
  assert.equal(
    buildCiteHtml({ id: 7, text: 'x', mode: 'nonsense' }),
    '<span class="cite" data-src="7">x</span>'
  );
  assert.ok(CITE_MODES.includes(CITE_MODE_DEFAULT));
});

test('citeModeOf: fehlender oder kaputter Wert ergibt den Default', () => {
  const r = root('<p>'
    + '<span class="cite" data-src="1">a</span>'
    + '<span class="cite" data-src="2" data-mode="paraphrase">b</span>'
    + '<span class="cite" data-src="3" data-mode="PARAPHRASE">c</span>'
    + '<span class="cite" data-src="4" data-mode="quatsch">d</span>'
    + '</p>');
  const modes = Array.from(r.querySelectorAll(CITE_SEL)).map(citeModeOf);
  assert.deepEqual(modes, ['quote', 'paraphrase', 'paraphrase', 'quote']);
});

test('isQuoteBlockEl: nur blockquote mit numerischem data-src', () => {
  const r = root('<blockquote data-src="7"><p>a</p></blockquote>'
    + '<blockquote><p>b</p></blockquote>'
    + '<blockquote data-src="0"><p>c</p></blockquote>'
    + '<blockquote data-src="x"><p>d</p></blockquote>'
    + '<div data-src="7">e</div>');
  const all = Array.from(r.children);
  assert.deepEqual(all.map(isQuoteBlockEl), [true, false, false, false, false]);
  assert.equal(r.querySelectorAll(CITED_QUOTE_SEL).length, 3); // Selektor ist grob …
  assert.equal(Array.from(r.querySelectorAll(CITED_QUOTE_SEL)).filter(isQuoteBlockEl).length, 1); // … isQuoteBlockEl entscheidet
});

test('collectQuoteBlocks zaehlt Zitatzeichen ohne die Kurzbeleg-Chips', () => {
  const quote = '<blockquote data-src="7"><p>abcde'
    + '<span class="cite" data-src="7" data-loc="44">(Kafka, 1915, S. 44)</span>'
    + '</p></blockquote>';
  const [q] = collectQuoteBlocks(root(quote));
  assert.equal(q.id, 7);
  // Nur „abcde" — der Beleg ist der Nachweis, nicht das Zitat. Zaehlte er mit,
  // waere der Zitat-Anteil systematisch zu hoch.
  assert.equal(q.chars, 5);
  assert.deepEqual([...q.citeIds], [7]);
});

test('collectCiteIndex: Chips und Blockzitate teilen einen Offset-Raum', () => {
  const html = '<p>vorher</p>'
    + '<blockquote data-src="7"><p>zitat</p></blockquote>'
    + '<p>nachher<span class="cite" data-src="3">(A, 2020)</span></p>';
  const { cites, quotes } = collectCiteIndex(root(html));
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].offset, 'vorher'.length);
  assert.equal(cites.length, 1);
  assert.equal(cites[0].offset, 'vorher'.length + 'zitat'.length + 'nachher'.length);
  // Die Bequemlichkeits-Wrapper liefern dasselbe wie der Ein-Durchlauf.
  assert.deepEqual(collectCites(root(html)).map(c => c.id), [3]);
});

test('collectCiteIndex fuehrt ein verschachteltes Blockzitat nicht doppelt', () => {
  // Sonst waere derselbe Text zweimal Zitat und der Anteil > 100 % moeglich.
  const html = '<blockquote data-src="7"><p>aussen</p>'
    + '<blockquote data-src="8"><p>innen</p></blockquote></blockquote>';
  const { quotes } = collectCiteIndex(root(html));
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].id, 7);
  assert.equal(quotes[0].chars, 'aussen'.length + 'innen'.length);
});

test('citationsFromCites: Blockzitat mit eigenem Chip zaehlt einmal', () => {
  const html = '<blockquote data-src="7"><p>zitat'
    + '<span class="cite" data-src="7">(A, 2020)</span></p></blockquote>';
  const { cites, quotes } = collectCiteIndex(root(html));
  const [row] = citationsFromCites(cites, quotes);
  assert.equal(row.sourceId, 7);
  assert.equal(row.count, 1);                       // NICHT 2
  assert.equal(row.quoteChars, 'zitat'.length);
  assert.equal(row.paraphraseCount, 0);
});

test('citationsFromCites: Blockzitat ohne Chip ist selbst die Fundstelle', () => {
  const html = '<blockquote data-src="7"><p>zitat</p></blockquote>';
  const { cites, quotes } = collectCiteIndex(root(html));
  const [row] = citationsFromCites(cites, quotes);
  assert.equal(row.count, 1);
  assert.equal(row.firstOffset, 0);
  assert.equal(row.quoteChars, 'zitat'.length);
});

test('citationsFromCites: Blockzitat und Chip auf verschiedene Quellen', () => {
  // Zitat aus Quelle 7, im Zitat ein Beleg auf Quelle 8 (Zitat im Zitat) —
  // beide bekommen eine Fundstelle, die Zeichen gehoeren nur der 7.
  const html = '<blockquote data-src="7"><p>zitat'
    + '<span class="cite" data-src="8">(B, 2021)</span></p></blockquote>';
  const { cites, quotes } = collectCiteIndex(root(html));
  const rows = citationsFromCites(cites, quotes);
  assert.equal(rows.length, 2);
  assert.equal(rows.find(r => r.sourceId === 7).count, 1);
  assert.equal(rows.find(r => r.sourceId === 7).quoteChars, 'zitat'.length);
  assert.equal(rows.find(r => r.sourceId === 8).count, 1);
  assert.equal(rows.find(r => r.sourceId === 8).quoteChars, 0);
});

test('citationsFromCites zaehlt Paraphrasen als Teilmenge von count', () => {
  const html = '<p>'
    + '<span class="cite" data-src="7">(A, 2020)</span>'
    + '<span class="cite" data-src="7" data-mode="paraphrase">(vgl. A, 2020)</span>'
    + '</p>';
  const { cites, quotes } = collectCiteIndex(root(html));
  const [row] = citationsFromCites(cites, quotes);
  assert.equal(row.count, 2);
  assert.equal(row.paraphraseCount, 1);
});

test('closestQuoteBlock + setQuoteBlockSource', () => {
  const r = root('<blockquote><p>text</p></blockquote>');
  const p = r.querySelector('p');
  const bq = closestQuoteBlock(p.firstChild, r);
  assert.equal(bq, r.querySelector('blockquote'));
  assert.equal(closestQuoteBlock(r.querySelector('blockquote'), r.querySelector('blockquote')), null);

  assert.equal(setQuoteBlockSource(bq, 7), true);
  assert.equal(bq.getAttribute(CITE_ATTR_SRC), '7');
  assert.equal(isQuoteBlockEl(bq), true);
  // Ungueltiger Zeiger entfernt die Bindung statt sie kaputt zu setzen.
  assert.equal(setQuoteBlockSource(bq, 0), false);
  assert.equal(bq.hasAttribute(CITE_ATTR_SRC), false);
});

// ── Editor-Laufzeit ──────────────────────────────────────────────────────────

test('markCitesAtomic setzt contenteditable nur auf gueltigen Chips', () => {
  const r = root(`<p>${CHIP}<span class="cite">kein Zeiger</span></p>`);
  assert.equal(markCitesAtomic(r), 1);
  assert.equal(r.querySelector(CITE_SEL).getAttribute('contenteditable'), 'false');
  assert.equal(r.querySelectorAll('[contenteditable]').length, 1);
  assert.equal(markCitesAtomic(null), 0);
});

test('closestCiteEl findet den Chip um einen Knoten', () => {
  const r = root(`<p>text ${CHIP}</p>`);
  const chip = r.querySelector(CITE_SEL);
  assert.equal(closestCiteEl(chip.firstChild, r), chip);
  assert.equal(closestCiteEl(chip, r), chip);
  assert.equal(closestCiteEl(r.querySelector('p').firstChild, r), null);
});

// ── Server-Cleaner ───────────────────────────────────────────────────────────

test('cleanPageHtml laesst den Chip unversehrt und strippt contenteditable', async () => {
  const { cleanPageHtml, ensureBlockIds } = await import('../../lib/html-clean.js');

  // Zustand, wie der Editor ihn beim Speichern liefert: Chip mit
  // Editor-Attribut, das nie persistiert werden darf.
  const fromEditor = `<p>Vorher <span class="cite" data-src="7" data-loc="44" contenteditable="false">(Kafka, 1915, S. 44)</span> nachher.</p>`;
  const cleaned = cleanPageHtml(fromEditor);

  assert.ok(!cleaned.includes('contenteditable'), cleaned);
  const chip = root(cleaned).querySelector(CITE_SEL);
  assert.ok(chip, `Chip verschwunden: ${cleaned}`);
  assert.equal(chip.getAttribute(CITE_ATTR_SRC), '7');
  assert.equal(chip.getAttribute(CITE_ATTR_LOC), '44');
  assert.equal(chip.textContent, '(Kafka, 1915, S. 44)');

  // Block-IDs am Write-Chokepoint fassen Inline-Spans nicht an.
  const withBids = ensureBlockIds(cleaned);
  assert.ok(withBids.includes('data-bid'));
  assert.equal(root(withBids).querySelectorAll(CITE_SEL).length, 1);
  assert.equal(root(withBids).querySelector(CITE_SEL).hasAttribute('data-bid'), false);
});

test('cleanPageHtml: Chip als einziger Inhalt eines Blocks kollabiert nicht', () => {
  // collapseEmptyBlocks darf einen Absatz, der nur aus einem Beleg besteht,
  // nicht als leer einstufen.
  return import('../../lib/html-clean.js').then(({ cleanPageHtml }) => {
    const out = cleanPageHtml(`<p>${CHIP}</p><p>danach</p>`);
    assert.equal(root(out).querySelectorAll(CITE_SEL).length, 1, out);
  });
});

// ── Paste-Filter ─────────────────────────────────────────────────────────────
// sanitizePasteHtml laeuft im Browser (DOMParser). Hier wird die Regel
// stattdessen gegen die Quelle geprueft — der Filter selbst ist im
// App-E2E-Test abgedeckt (tests/e2e-app/notebook-cite.spec.js).

test('Paste-Allowlist laesst SPAN nur als Beleg-Chip oder Querverweis zu', () => {
  const src = readFileSync(resolve(ROOT, 'public', 'js', 'utils', 'html.js'), 'utf8');
  assert.ok(/PASTE_ALLOWED_TAGS[\s\S]*?'SPAN'/.test(src), 'SPAN muss in der Tag-Allowlist stehen');
  // Zwei Marker teilen sich das SPAN: der Beleg-Chip (data-src/-loc/-mode) und
  // der Querverweis (data-xref/-id/-fmt, public/js/xrefs/xref-html.js). Beide
  // Zeiger muessen den Paste ueberleben — sonst zerfaellt ein kopierter Satz zu
  // Text, der nicht mehr mitnummeriert bzw. seine Quelle verloren hat.
  assert.ok(/SPAN:\s*new Set\(\['class', CITE_ATTR_SRC, CITE_ATTR_LOC, CITE_ATTR_MODE,\s*XREF_ATTR_KIND, XREF_ATTR_ID, XREF_ATTR_FMT\]\)/.test(src),
    'SPAN darf genau die Chip- und Querverweis-Attribute behalten');
  // Belegtes Blockzitat: der Zeiger muss den Paste ueberleben, sonst faellt ein
  // verschobenes Blockzitat zum unbelegten Einzug zurueck.
  assert.ok(/BLOCKQUOTE:\s*new Set\(\['class', CITE_ATTR_SRC\]\)/.test(src),
    'BLOCKQUOTE darf class + data-src behalten');
  // Der Unwrap-Zweig ist die eigentliche Absicherung: ohne ihn wuerde jede
  // Word-<span>-Huelle den Paste ueberleben.
  assert.ok(/tag === 'SPAN' && !isCiteEl\(el\) && !isXrefEl\(el\)[\s\S]{0,160}_unwrap\(el\)/.test(src),
    'Spans, die weder Chip noch Querverweis sind, muessen unwrapped werden');
});

test('Dirty-Vergleich strippt contenteditable (Struktur-Tripwire)', () => {
  // Nur ein Tripwire gegen das Loeschen des Filters, KEIN Verhaltensbeweis: die
  // Vergleichsform ist Browser-Code (DOMParser), und linkedom weicht davon ab
  // (kein Auto-<body> beim Fragment-Parse) — ein DOM-Shim wuerde hier
  // linkedom-Eigenheiten pruefen statt Chromium.
  // Das VERHALTEN prueft tests/e2e-app/notebook-cite.spec.js gegen die echte
  // App („Speichern ohne Aenderung erzeugt keine neue Fassung"), inkl.
  // Mutationsprobe.
  const src = readFileSync(resolve(ROOT, 'public', 'js', 'editor', 'shared', 'html-clean.js'), 'utf8');
  assert.ok(/hasEditableAttr/.test(src), 'stripLektoratMarks braucht den contenteditable-Trigger');
  assert.ok(/hasMark \|\| hasIns \|\| hasLtUi \|\| hasEditableAttr/.test(src),
    'Trigger muss im Early-Return-Guard stehen, sonst laeuft der Filter nie');
  assert.ok(/querySelectorAll\('\[contenteditable\]'\)[\s\S]{0,80}removeAttribute\('contenteditable'\)/.test(src));
});

// ── Block-Merge ──────────────────────────────────────────────────────────────

test('Block-Merge behandelt einen Chip als Teil seines Blocks', async () => {
  const { mergeBlocks, mergedToHtml } = await import('../../public/js/editor/shared/block-merge.js');

  const base   = `<p data-bid="aaaaaaaaaaaaaaaa">Satz eins.</p><p data-bid="bbbbbbbbbbbbbbbb">Satz zwei.</p>`;
  // Lokal: Beleg an Block A angehaengt. Fremd: Block B geaendert.
  const mine   = `<p data-bid="aaaaaaaaaaaaaaaa">Satz eins. ${CHIP}</p><p data-bid="bbbbbbbbbbbbbbbb">Satz zwei.</p>`;
  const theirs = `<p data-bid="aaaaaaaaaaaaaaaa">Satz eins.</p><p data-bid="bbbbbbbbbbbbbbbb">Satz zwei, erweitert.</p>`;

  const { merged, conflicts } = mergeBlocks(base, mine, theirs);
  assert.equal(conflicts.length, 0, 'kollisionsfrei: verschiedene Bloecke');
  const html = mergedToHtml(merged);
  assert.equal(root(html).querySelectorAll(CITE_SEL).length, 1, html);
  assert.ok(html.includes('Satz zwei, erweitert.'));
});
