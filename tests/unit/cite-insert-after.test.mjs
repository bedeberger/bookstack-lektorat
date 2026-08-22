// Belegvorschlag — die Einfuege-Engine `insertAfterInHtml` (public/js/utils/
// html-find.js). Sie setzt den Kurzbeleg hinter einen unbelegten Satz, ohne den
// Satz anzutasten.
//
// KERN-INVARIANTE, gegen die hier geprueft wird: es geht NICHTS verloren. Der
// Unterschied zu `replaceInHtml` ist genau das — dort wird der Match-Bereich
// ersetzt (und ein balanciertes `<em>`/`<span class="cite">` DARIN faellt weg),
// hier wird nur an einer Position gespleisst. Ein Regress in diese Richtung
// waere stiller Datenverlust im Manuskript: verlorene Auszeichnung, oder eine
// Quellenangabe, die als toter Klartext zurueckbleibt und aus dem Fund-Index
// (`source_citations`) verschwindet.
//
// Der Aufrufer ist public/js/editor/lektorat-evidence.js#applyEvidence; die
// Mehrdeutigkeits-Pruefung davor (`countInHtml`) ist dort und wird hier
// mitgeprueft, weil sie zur Entscheidung gehoert.

import test from 'node:test';
import assert from 'node:assert/strict';
import { insertAfterInHtml, countInHtml } from '../../public/js/utils.js';

// So sieht der Chip aus, den buildCiteHtml erzeugt (Form hier nur als Fixture —
// die SSoT ist public/js/sources/cite-html.js).
const CHIP = '<span class="cite" data-src="7" data-mode="paraphrase">(vgl. Müller, 2020)</span>';
const NBSP = ' ';

// Text-View: Tags weg, Whitespace kollabiert. Misst „ist Text verschwunden"
// unabhaengig von der Struktur.
const textOf = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('setzt den Beleg direkt hinter den Satz', () => {
  const html = '<p>Erster Satz. Zweiter Satz. Dritter Satz.</p>';
  const out = insertAfterInHtml(html, 'Zweiter Satz.', NBSP + CHIP);
  assert.ok(out.includes('Zweiter Satz.' + NBSP + CHIP), out);
  assert.ok(out.includes('Dritter Satz.'));
});

test('der belegte Satz bleibt Zeichen fuer Zeichen stehen', () => {
  const html = '<p>Die Zahl lag bei 3,4 Prozent — laut Erhebung.</p>';
  const claim = 'Die Zahl lag bei 3,4 Prozent — laut Erhebung.';
  const out = insertAfterInHtml(html, claim, NBSP + CHIP);
  assert.ok(out.includes(claim), 'der Satz selbst darf nicht umgeschrieben werden');
});

test('Inline-Auszeichnung IM Satz ueberlebt (der Unterschied zu replaceInHtml)', () => {
  const html = '<p>Der <em>entscheidende</em> Befund ist unstrittig.</p>';
  const out = insertAfterInHtml(html, 'Der entscheidende Befund ist unstrittig.', NBSP + CHIP);
  assert.ok(out.includes('<em>entscheidende</em>'), 'das <em> darf nicht verloren gehen');
  assert.equal(textOf(out).includes('entscheidende'), true);
});

test('eine bestehende Quellenangabe IM Satz bleibt erhalten', () => {
  const existing = '<span class="cite" data-src="3">(Weber, 1919)</span>';
  const html = `<p>Schon fruehe Arbeiten ${existing} sahen das so.</p>`;
  const out = insertAfterInHtml(html, 'Schon fruehe Arbeiten (Weber, 1919) sahen das so.', NBSP + CHIP);
  assert.ok(out.includes('data-src="3"'), 'der bestehende Zeiger darf nicht wegfallen');
  assert.ok(out.includes('data-src="7"'), 'der neue Beleg muss dazukommen');
});

test('der Beleg landet ausserhalb einer abschliessenden Auszeichnung', () => {
  const html = '<p>Das gilt fuer den <em>gesamten Zeitraum.</em></p>';
  const out = insertAfterInHtml(html, 'Das gilt fuer den gesamten Zeitraum.', NBSP + CHIP);
  assert.ok(out.indexOf('</em>') < out.indexOf('class="cite"'),
    'der Chip darf die Kursivierung des Satzendes nicht erben');
});

test('der Beleg bleibt IM Absatz, den er belegt', () => {
  const html = '<p>Ein belegbarer Satz.</p><p>Der naechste Absatz.</p>';
  const out = insertAfterInHtml(html, 'Ein belegbarer Satz.', NBSP + CHIP);
  assert.ok(out.indexOf('class="cite"') < out.indexOf('</p>'),
    'ueber die Absatzgrenze darf der Einfuegepunkt nicht wandern');
});

test('toleranter Match: der Satz laeuft im Markup ueber Inline-Grenzen', () => {
  const html = '<p>Er sagte <strong>das magische</strong> Wort.</p>';
  const out = insertAfterInHtml(html, 'Er sagte das magische Wort.', NBSP + CHIP);
  assert.ok(out.includes('class="cite"'), 'der Satz muss trotz Tags gefunden werden');
  assert.ok(out.includes('<strong>das magische</strong>'), 'und das Markup muss stehen bleiben');
});

test('nicht auffindbarer Satz laesst das HTML unveraendert', () => {
  const html = '<p>Ein Satz.</p>';
  assert.equal(insertAfterInHtml(html, 'Ein anderer Satz.', CHIP), html);
});

test('leere Eingaben aendern nichts', () => {
  const html = '<p>Ein Satz.</p>';
  assert.equal(insertAfterInHtml(html, 'Ein Satz.', ''), html);
  assert.equal(insertAfterInHtml(html, '', CHIP), html);
  assert.equal(insertAfterInHtml('', 'Ein Satz.', CHIP), '');
});

test('roher Zeilenumbruch im Beleg kommt nicht ins Markup', () => {
  const out = insertAfterInHtml('<pre>Ein Satz.</pre>', 'Ein Satz.', '\n' + CHIP);
  assert.ok(!out.includes('\n'), 'in umbruch-erhaltenden Bloecken waere er sichtbar');
});

test('kein Text geht verloren — auch nicht bei mehrfachem Einfuegen', () => {
  const html = '<p>Satz eins. Satz zwei.</p><ul><li>Ein Listenpunkt.</li></ul>';
  let out = insertAfterInHtml(html, 'Satz eins.', NBSP + CHIP);
  out = insertAfterInHtml(out, 'Ein Listenpunkt.', NBSP + CHIP);
  for (const fragment of ['Satz eins.', 'Satz zwei.', 'Ein Listenpunkt.']) {
    assert.ok(textOf(out).includes(fragment), `${fragment} fehlt`);
  }
});

// ── Der Guard davor: Mehrdeutigkeit ─────────────────────────────────────────

test('countInHtml erkennt den mehrfach vorkommenden Satz (Abbruch-Bedingung)', () => {
  const html = '<p>Das ist so. Und noch etwas.</p><p>Das ist so.</p>';
  assert.equal(countInHtml(html, 'Das ist so.'), 2);
  assert.equal(countInHtml(html, 'Und noch etwas.'), 1);
  assert.equal(countInHtml(html, 'Gibt es nicht.'), 0);
});

test('bei Mehrdeutigkeit trifft die Engine ohne Guard das ERSTE Vorkommen', () => {
  // Dokumentiert, WARUM applyEvidence bei count > 1 abbricht statt zu raten.
  const html = '<p>Das ist so.</p><p>Das ist so.</p>';
  const out = insertAfterInHtml(html, 'Das ist so.', CHIP);
  assert.ok(out.indexOf('class="cite"') < out.lastIndexOf('<p>'),
    'ohne Guard landet der Beleg im ersten Absatz — moeglicherweise am falschen Satz');
});
