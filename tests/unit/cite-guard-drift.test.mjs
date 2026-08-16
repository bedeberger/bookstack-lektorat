// Schutz der Beleg-Chips in LanguageTool, TTS und den KI-Prompts.
//
// Drei Schichten sollen den Nachweis „(Müller, 2020, S. 44)" NICHT anfassen:
//   LanguageTool — sonst rote Wellen unter Autorennamen, und ein angewandter
//     Vorschlag ersetzt den Bereich samt Zeiger auf die Quelle.
//   TTS — sonst liest die Stimme den Beleg mitten im Satz vor.
//   Lektorat-Prompts — sonst streicht das Modell den Kurzbeleg als Füllwerk,
//     Klammer-Einschub oder Stilbruch an.
//
// Zwei der drei Schichten tragen eine bewusste KOPIE des Chip-Selektors, weil sie
// nichts aus dem App-Bundle importieren dürfen (tts-segment.js muss pre-auth
// ladbar bleiben, mapping.js hält sich frei von Bundle-Kanten). Diese Kopien
// werden hier gegen die SSoT gegated — dasselbe Muster wie READER_BLOCK_SEL.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';

import { CITE_SEL, buildCiteHtml } from '../../public/js/sources/cite-html.js';
import { XREF_SEL, buildXrefHtml } from '../../public/js/xrefs/xref-html.js';
import { TTS_SKIP_SEL, ttsTextNodes, ttsBlockText } from '../../public/js/tts-segment.js';
import {
  buildOffsetTable, overlapsProtected, filterProtectedMatches,
} from '../../public/js/cards/editor-spellcheck/mapping.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const CHIP = buildCiteHtml({ id: 7, loc: '44', text: '(Müller, 2020, S. 44)' });

function root(html) {
  const { document } = parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body></html>`);
  return document.getElementById('r');
}

// ── Selektor-Kopien gegen die SSoT ───────────────────────────────────────────

test('TTS_SKIP_SEL ist deckungsgleich mit CITE_SEL', () => {
  assert.equal(TTS_SKIP_SEL, CITE_SEL);
});

test('LanguageTool-Mapping traegt denselben Chip-Selektor', () => {
  const src = readFileSync(
    resolve(ROOT, 'public', 'js', 'cards', 'editor-spellcheck', 'mapping.js'), 'utf8');
  const m = /CITE_SKIP_SEL\s*=\s*'([^']+)'/.exec(src);
  assert.ok(m, 'CITE_SKIP_SEL in mapping.js nicht gefunden');
  assert.equal(m[1], CITE_SEL);
});

test('LanguageTool-Mapping traegt denselben Querverweis-Selektor', () => {
  // Ein angewandter LT-Vorschlag ersetzt den Bereich und wuerde den Zeiger
  // mitnehmen — der Verweis nummerierte danach nicht mehr mit.
  const src = readFileSync(
    resolve(ROOT, 'public', 'js', 'cards', 'editor-spellcheck', 'mapping.js'), 'utf8');
  const m = /XREF_SKIP_SEL\s*=\s*'([^']+)'/.exec(src);
  assert.ok(m, 'XREF_SKIP_SEL in mapping.js nicht gefunden');
  assert.equal(m[1], XREF_SEL);
});

test('Querverweise sind fuer LanguageTool geschuetzte Bereiche', () => {
  const r = root(`<p>Wie in ${buildXrefHtml({ kind: 'chapter', target: '42', text: 'Kapitel 3' })} gezeigt.</p>`);
  const { text, protectedRanges } = buildOffsetTable(r);
  assert.ok(protectedRanges.length > 0, 'kein geschuetzter Bereich fuer den Verweis');
  // Der Satz bleibt fuer LTs Grammatikregeln vollstaendig — nicht herausgeschnitten.
  assert.match(text, /Wie in Kapitel 3 gezeigt\./);
  // Ein Treffer, der den Verweis beruehrt, faellt weg.
  const start = text.indexOf('Kapitel 3');
  assert.equal(overlapsProtected(start, 'Kapitel 3'.length, protectedRanges), true);
});

test('TTS liest Querverweise MIT — anders als Belege', () => {
  // „siehe Kapitel 3" ist Teil des Satzes und gehoert vorgelesen; ein
  // Klammerbeleg nicht. Darum steht der Verweis bewusst NICHT in TTS_SKIP_SEL.
  const r = root(`<p>Siehe ${buildXrefHtml({ kind: 'chapter', target: '42', text: 'Kapitel 3' })}.</p>`);
  assert.match(ttsBlockText(r.querySelector('p')), /Siehe Kapitel 3\./);
});

test('tts-segment.js bleibt frei von App-Bundle-Importen', () => {
  // Der Share-Reader importiert es in seinen schlanken Modulgraph. Ein Import
  // aus dem App-Bundle würde die Kette brechen.
  const src = readFileSync(resolve(ROOT, 'public', 'js', 'tts-segment.js'), 'utf8');
  const imports = [...src.matchAll(/^\s*import\s.*?from\s+'([^']+)'/gm)].map(x => x[1]);
  assert.deepEqual(imports, [], `tts-segment.js darf nichts importieren, hat aber: ${imports}`);
});

// ── TTS ──────────────────────────────────────────────────────────────────────

test('ttsBlockText laesst den Beleg aus, ttsTextNodes liefert denselben Offsetraum', () => {
  const block = root(`<p>Vorher ${CHIP} nachher.</p>`).firstElementChild;

  // Gesprochen wird der Satz ohne Nachweis.
  assert.equal(ttsBlockText(block), 'Vorher  nachher.');
  assert.equal(block.textContent, 'Vorher (Müller, 2020, S. 44) nachher.');

  // Und der Range-Bau der Konsumenten laeuft ueber genau diese Knoten — sonst
  // driftet das Satz-Highlight um die Chip-Laenge.
  const nodes = ttsTextNodes(block);
  assert.equal(nodes.map(n => n.nodeValue).join(''), ttsBlockText(block));
  assert.equal(nodes.length, 2);
});

test('ttsTextNodes steigt in verschachtelte Auszeichnung ab, nur nicht in Chips', () => {
  const block = root(`<p>a <strong>fett ${CHIP}</strong> b</p>`).firstElementChild;
  assert.equal(ttsBlockText(block), 'a fett  b');
  assert.equal(ttsTextNodes(null).length, 0);
});

test('ttsBlockText laesst Chips ohne Zeiger stehen', () => {
  // `span.cite` ohne data-src ist kein Beleg, sondern Fremdmarkup — sein Text
  // gehoert zum Satz.
  const block = root('<p>a <span class="cite">kein Zeiger</span> b</p>').firstElementChild;
  assert.equal(ttsBlockText(block), 'a kein Zeiger b');
});

// ── LanguageTool ─────────────────────────────────────────────────────────────

test('buildOffsetTable behaelt den Beleg im Stream und markiert ihn geschuetzt', () => {
  const table = buildOffsetTable(root(`<p>Vorher ${CHIP} nachher.</p>`));
  // Text bleibt vollstaendig: ein Herausschneiden hinterliesse ein doppeltes
  // Leerzeichen — und darauf hat LanguageTool eine eigene Regel.
  assert.equal(table.text, 'Vorher (Müller, 2020, S. 44) nachher.');
  assert.deepEqual(table.protectedRanges, [[7, 28]]);
  assert.equal(table.text.slice(7, 28), '(Müller, 2020, S. 44)');
});

test('geschuetzte Bereiche stimmen auch mit Blockumbruch davor', () => {
  // Der Chip als erstes Element eines zweiten Blocks: der eingefuegte \n\n darf
  // nicht ins Intervall rutschen.
  const table = buildOffsetTable(root(`<p>eins</p><p>${CHIP} zwei</p>`));
  const [[s, e]] = table.protectedRanges;
  assert.equal(table.text.slice(s, e), '(Müller, 2020, S. 44)');
  assert.equal(table.text.slice(0, s), 'eins\n\n');
});

test('mehrere Belege ergeben mehrere Intervalle', () => {
  const a = buildCiteHtml({ id: 1, text: '[1]' });
  const b = buildCiteHtml({ id: 2, text: '[2]' });
  const table = buildOffsetTable(root(`<p>x ${a} y ${b} z</p>`));
  assert.equal(table.protectedRanges.length, 2);
  for (const [s, e] of table.protectedRanges) {
    assert.match(table.text.slice(s, e), /^\[\d\]$/);
  }
});

test('Chip ohne Zeiger erzeugt keinen geschuetzten Bereich', () => {
  const table = buildOffsetTable(root('<p>a <span class="cite">x</span> b</p>'));
  assert.deepEqual(table.protectedRanges, []);
});

test('overlapsProtected verwirft schon bei Teil-Ueberlappung', () => {
  const ranges = [[10, 20]];
  // Ein Treffer, der nur teilweise in den Beleg reicht, wuerde beim Anwenden
  // ebenfalls Chip-Zeichen ersetzen → auch der faellt weg.
  assert.equal(overlapsProtected(12, 3, ranges), true, 'vollstaendig innen');
  assert.equal(overlapsProtected(8, 5, ranges), true, 'ragt von links hinein');
  assert.equal(overlapsProtected(18, 5, ranges), true, 'ragt nach rechts hinaus');
  assert.equal(overlapsProtected(5, 30, ranges), true, 'umspannt den Beleg');
  assert.equal(overlapsProtected(0, 10, ranges), false, 'endet genau davor');
  assert.equal(overlapsProtected(20, 5, ranges), false, 'beginnt genau danach');
  assert.equal(overlapsProtected(12, 0, ranges), true, 'Nulllaenge innen');
  assert.equal(overlapsProtected(5, 5, []), false);
  assert.equal(overlapsProtected(5, 5, null), false);
});

test('filterProtectedMatches verwirft nur die beruehrten Treffer', () => {
  const ms = [
    { offset: 0, length: 5, id: 'a' },    // vor dem Beleg
    { offset: 12, length: 3, id: 'b' },   // im Beleg
    { offset: 25, length: 4, id: 'c' },   // dahinter
  ];
  assert.deepEqual(filterProtectedMatches(ms, [[10, 20]]).map(m => m.id), ['a', 'c']);
  // Ohne geschuetzte Bereiche bleibt die Liste identisch (kein Kopieraufwand).
  assert.equal(filterProtectedMatches(ms, []), ms);
  assert.deepEqual(filterProtectedMatches([], [[1, 2]]), []);
});

test('LanguageTool-Controller filtert Treffer genau einmal', () => {
  // Squiggles und Badge-Zahl muessen dieselbe Menge sehen — wird nur beim
  // Rendern gefiltert, meldet das Badge Fehler, die nirgends markiert sind.
  const src = readFileSync(
    resolve(ROOT, 'public', 'js', 'cards', 'editor-spellcheck', 'controller.js'), 'utf8');
  const hits = [...src.matchAll(/filterProtectedMatches\(/g)].length;
  assert.equal(hits, 1, `filterProtectedMatches darf genau einmal aufgerufen werden, gefunden: ${hits}`);
  assert.match(src, /const matches = filterProtectedMatches\(/);
});

// ── Prompts ──────────────────────────────────────────────────────────────────

test('Beleg-Schutzblock haengt nur bei Seiten mit Belegen im Lektorat-Prompt', async () => {
  const { configurePrompts, buildLektoratPrompt, buildObjektivLektoratPrompt } =
    await import('../../public/js/prompts.js');
  const cfg = JSON.parse(readFileSync(resolve(ROOT, 'prompt-config.json'), 'utf8'));
  configurePrompts(cfg, 'claude');

  const text = 'Ein Satz mit (Müller, 2020, S. 44) darin.';

  const ohne = buildLektoratPrompt(text, {});
  assert.ok(!ohne.includes('Quellennachweise'), 'ohne Belege kein Block — in einem Roman waere die Regel Ballast');

  const mit = buildLektoratPrompt(text, { hatBelege: true });
  assert.ok(mit.includes('Quellennachweise'));
  assert.ok(/NICHT umformulieren|nicht anfassen/i.test(mit));

  // Der Objektiv-Pass (Claude-Split) prueft Rechtschreibung/Grammatik und
  // braucht den Schutz genauso.
  assert.ok(!buildObjektivLektoratPrompt(text, {}).includes('Quellennachweise'));
  assert.ok(buildObjektivLektoratPrompt(text, { hatBelege: true }).includes('Quellennachweise'));
});

test('Lektorat-Job reicht das Beleg-Flag in beide Pfade und in die Cache-Signatur', () => {
  // Ohne den Signatur-Anteil liefert der Cache einer Seite, die frisch Belege
  // bekommen hat, das alte Ergebnis ohne Schutzregel zurueck.
  const job = readFileSync(resolve(ROOT, 'routes', 'jobs', 'lektorat.js'), 'utf8');
  assert.match(job, /_pageHasCitations/);
  assert.match(job, /bl: hatBelege/, 'Einzel-Pfad: Flag muss in der Cache-Signatur stehen');
  assert.match(job, /bl: batchHatBelege/, 'Batch-Pfad: dito');
  assert.match(job, /hatBelege: batchHatBelege/, 'Batch-Pfad: Flag muss in promptOpts');
  assert.match(job, /orte, motive, hatBelege/, 'Einzel-Pfad: Flag muss in promptOpts');

  const split = readFileSync(resolve(ROOT, 'routes', 'jobs', 'lektorat-split.js'), 'utf8');
  assert.match(split, /hatBelege: promptOpts\.hatBelege/, 'Split: Objektiv-Pass braucht das Flag');
});

// ── Buchtyp ──────────────────────────────────────────────────────────────────

test('Buchtyp wissenschaft existiert in beiden Sprachen und ist serverseitig erlaubt', () => {
  const cfg = JSON.parse(readFileSync(resolve(ROOT, 'prompt-config.json'), 'utf8'));
  for (const lang of ['de', 'en']) {
    const bt = cfg.buchtypen[lang].wissenschaft;
    assert.ok(bt, `buchtypen.${lang}.wissenschaft fehlt`);
    assert.ok(bt.label && bt.zusatz && bt.reviewSchwerpunkt, `Felder unvollstaendig in ${lang}`);
  }
  const bs = readFileSync(resolve(ROOT, 'routes', 'booksettings.js'), 'utf8');
  const m = /VALID_BUCHTYPEN\s*=\s*\[([^\]]+)\]/.exec(bs);
  assert.ok(m);
  const allowed = m[1].split(',').map(x => x.trim().replace(/^'|'$/g, ''));
  assert.ok(allowed.includes('wissenschaft'), 'Server wuerde den Buchtyp mit 400 ablehnen');

  // Alle Config-Typen muessen serverseitig erlaubt sein (und umgekehrt), sonst
  // bietet die UI einen Typ an, den der PUT verwirft.
  assert.deepEqual(Object.keys(cfg.buchtypen.de).sort(), [...allowed].sort());
  assert.deepEqual(Object.keys(cfg.buchtypen.de).sort(), Object.keys(cfg.buchtypen.en).sort());
});
