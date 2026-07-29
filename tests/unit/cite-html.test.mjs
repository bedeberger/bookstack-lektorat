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
  isCiteEl, buildCiteHtml, collectCites, citationsFromCites,
  markCitesAtomic, closestCiteEl,
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
  // firstOffset ist der ERSTE gefundene, nicht der kleinste: collectCites
  // liefert Dokumentordnung, damit ist der erste auch der frueheste.
  assert.equal(seven.firstOffset, 100);
  assert.deepEqual(citationsFromCites(null), []);
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

test('Paste-Allowlist laesst SPAN nur als Beleg-Chip zu', () => {
  const src = readFileSync(resolve(ROOT, 'public', 'js', 'utils', 'html.js'), 'utf8');
  assert.ok(/PASTE_ALLOWED_TAGS[\s\S]*?'SPAN'/.test(src), 'SPAN muss in der Tag-Allowlist stehen');
  assert.ok(/SPAN:\s*new Set\(\['class', CITE_ATTR_SRC, CITE_ATTR_LOC\]\)/.test(src),
    'SPAN darf genau class/data-src/data-loc behalten');
  // Der Unwrap-Zweig ist die eigentliche Absicherung: ohne ihn wuerde jede
  // Word-<span>-Huelle den Paste ueberleben.
  assert.ok(/tag === 'SPAN' && !isCiteEl\(el\)[\s\S]{0,120}_unwrap\(el\)/.test(src),
    'Nicht-Chip-Spans muessen unwrapped werden');
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
