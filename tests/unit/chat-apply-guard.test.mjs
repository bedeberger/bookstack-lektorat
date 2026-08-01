// Regression: Der Seiten-Chat darf einen `vorschlag` nur dann als „gespeichert"
// melden, wenn die Ersetzung tatsaechlich stattfindet — und nie blind die
// falsche Fundstelle treffen.
//
// Der Guard lebt in public/js/chat/chat.js#applyChatVorschlag (Alpine-Methode,
// in Node nicht importierbar wegen Browser-Deps). Getestet wird die Engine
// direkt (countInHtml/replaceInHtml aus utils.js) plus ein 1:1-Mirror des
// Pre-Check-Entscheidungsbaums:
//   countInHtml == 0  -> 'originalNotFound'
//   countInHtml  > 1  -> 'originalAmbiguous'   (kein Blind-Ersatz)
//   replaceInHtml No-Op + Link   -> 'spansLink'   (Hyperlink umschlossen)
//   replaceInHtml No-Op + Marker -> 'spansMarker' (Quellenangabe/Querverweis)
//   replaceInHtml No-Op          -> 'crossesBlockBoundary' (Absatzgrenze)
//   sonst              -> 'ok'

import test from 'node:test';
import assert from 'node:assert/strict';
import { countInHtml, replaceInHtml, skipReason } from '../../public/js/utils.js';

// 1:1-Mirror der Pre-Check-Reihenfolge in applyChatVorschlag.
function guard(html, vorschlag) {
  const occurrences = countInHtml(html, vorschlag.original);
  if (occurrences === 0) return 'originalNotFound';
  if (occurrences > 1) return 'originalAmbiguous';
  if (replaceInHtml(html, vorschlag.original, vorschlag.ersatz) === html) {
    return { spansLink: 'spansLink', spansMarker: 'spansMarker' }[skipReason(html, vorschlag.original)]
      || 'crossesBlockBoundary';
  }
  return 'ok';
}

// ── countInHtml ──────────────────────────────────────────────────────────────

test('countInHtml: 0 wenn Text fehlt, 1 bei einmaligem Vorkommen', () => {
  const html = '<p>Der Hund bellt.</p>';
  assert.equal(countInHtml(html, 'gibt es nicht'), 0);
  assert.equal(countInHtml(html, 'Der Hund bellt.'), 1);
});

test('countInHtml: mehrfaches Vorkommen wird gezaehlt (nicht ueberlappend)', () => {
  const html = '<p>Hallo Welt.</p><p>Hallo Welt.</p><p>Hallo Welt.</p>';
  assert.equal(countInHtml(html, 'Hallo Welt.'), 3);
});

test('countInHtml: tolerant ueber Inline-Tags und kollabierbaren Whitespace hinweg', () => {
  // KI sieht Plaintext; im HTML steckt ein <em> + kollabierbarer Whitespace.
  // (Entity-Dekodierung braucht das DOM und wird darum hier nicht geprueft.)
  const html = '<p>Er sagte   <em>das magische</em>\n Wort.</p>';
  assert.equal(countInHtml(html, 'das magische Wort'), 1);
});

// ── Guard-Entscheidungsbaum ──────────────────────────────────────────────────

test('Guard: eindeutige, ersetzbare Stelle -> ok', () => {
  const html = '<p>Der Hund bellt laut.</p><p>Die Katze schläft.</p>';
  assert.equal(guard(html, { original: 'bellt laut', ersatz: 'bellt leise' }), 'ok');
});

test('Guard: fehlender Originaltext -> originalNotFound', () => {
  const html = '<p>Der Hund bellt.</p>';
  assert.equal(guard(html, { original: 'die Katze miaut', ersatz: 'x' }), 'originalNotFound');
});

test('Guard: mehrdeutige Stelle -> originalAmbiguous (kein Blind-Ersatz)', () => {
  const html = '<p>Hallo Welt.</p><p>Hallo Welt.</p>';
  assert.equal(guard(html, { original: 'Hallo Welt.', ersatz: 'Servus Welt.' }), 'originalAmbiguous');
});

test('Guard: Absatzgrenzen-Vorschlag -> crossesBlockBoundary statt still-falscher Erfolg', () => {
  // Kern-Bug: countInHtml/findInHtml finden den Text (Tag-agnostisch), aber
  // replaceInHtml laesst ihn zum Schutz der Absatzstruktur unangetastet.
  const html = '<p>Er ging nach Hause.</p><p>Dann schlief er ein.</p>';
  assert.equal(guard(html, { original: 'nach Hause. Dann', ersatz: 'heim. Sofort danach' }), 'crossesBlockBoundary');
});

test('Guard: Listen-Grenzen-Vorschlag -> crossesBlockBoundary', () => {
  const html = '<ul><li>Erstens.</li><li>Zweitens.</li></ul>';
  assert.equal(guard(html, { original: 'Erstens. Zweitens', ersatz: 'Eins. Zwei' }), 'crossesBlockBoundary');
});

test('Guard: Inline-<em>-Spanne bleibt ok (keine Block-Grenze)', () => {
  const html = '<p>Er sagte <em>das magische</em> Wort.</p>';
  assert.equal(guard(html, { original: 'das magische Wort', ersatz: 'das geheime Wort' }), 'ok');
});

// ── Link-Schutz ──────────────────────────────────────────────────────────────
// Kern-Bug dieser Session: ein Vorschlag, der einen vollständigen <a>…</a>
// umspannt, hätte beim Ersetzen das href ersatzlos verworfen (nur Linktext blieb).
// replaceInHtml lässt die Stelle jetzt unangetastet, der Guard meldet spansLink.

test('Guard: umspannter Hyperlink -> spansLink (Link nicht zerstört)', () => {
  const html = '<p>Besuche <a href="https://example.com">unsere Website</a> heute.</p>';
  const res = replaceInHtml(html, 'Besuche unsere Website heute', 'Schau heute auf unserer Website vorbei');
  assert.equal(res, html, 'replaceInHtml darf den Link-Bereich nicht verändern');
  assert.equal(guard(html, { original: 'Besuche unsere Website heute', ersatz: 'Schau heute auf unserer Website vorbei' }), 'spansLink');
});

test('Guard: Korrektur neben dem Link (Link nicht umspannt) -> ok, Link bleibt erhalten', () => {
  const html = '<p>Besuche <a href="https://example.com">unsere Website</a> heute unbedingt.</p>';
  const res = replaceInHtml(html, 'heute unbedingt', 'gleich morgen');
  assert.ok(res.includes('href="https://example.com"'), 'Link muss erhalten bleiben');
  assert.ok(res.includes('gleich morgen'), 'Korrektur muss angewandt sein');
  assert.equal(guard(html, { original: 'heute unbedingt', ersatz: 'gleich morgen' }), 'ok');
});

// ── Marker-Schutz (Quellenangabe / Querverweis) ──────────────────────────────
// Gleiche Ursache wie beim Link, andere Nutzlast: `data-src` bzw. `data-xref-id`
// sind die Wahrheit, der sichtbare Chip-Text nur ihr Cache. Ein Vorschlag, der
// den ganzen Marker umspannt, hätte den Zeiger ersatzlos verworfen und toten
// Klartext hinterlassen — die Fundstelle wäre aus source_citations/xref_links
// gefallen, das Quellenverzeichnis hätte den Beleg verloren.

test('Guard: umspannte Quellenangabe -> spansMarker (data-src nicht verloren)', () => {
  const html = '<p>Das ist belegt <span class="cite" data-src="7" data-loc="44">(Müller, 2020, S. 44)</span> und gilt.</p>';
  const original = 'Das ist belegt (Müller, 2020, S. 44) und gilt.';
  const res = replaceInHtml(html, original, 'Dies ist belegt (Müller, 2020, S. 44) und gilt.');
  assert.equal(res, html, 'replaceInHtml darf den Marker-Bereich nicht verändern');
  assert.equal(guard(html, { original, ersatz: 'Dies ist belegt (Müller, 2020, S. 44) und gilt.' }), 'spansMarker');
});

test('Guard: umspannter Querverweis -> spansMarker (data-xref-id nicht verloren)', () => {
  const html = '<p>Siehe <span class="xref" data-xref="chapter" data-xref-id="42">Kapitel 3</span> dazu näher.</p>';
  const original = 'Siehe Kapitel 3 dazu näher.';
  assert.equal(replaceInHtml(html, original, 'Vergleiche Kapitel 3 dazu näher.'), html);
  assert.equal(guard(html, { original, ersatz: 'Vergleiche Kapitel 3 dazu näher.' }), 'spansMarker');
});

test('Guard: Korrektur neben dem Marker -> ok, Zeiger bleibt erhalten', () => {
  const html = '<p>Das ist belegt <span class="cite" data-src="7">(Müller, 2020)</span> und gilt sicherlich.</p>';
  const res = replaceInHtml(html, 'gilt sicherlich', 'gilt zweifellos');
  assert.ok(res.includes('data-src="7"'), 'Zeiger muss erhalten bleiben');
  assert.ok(res.includes('gilt zweifellos'), 'Korrektur muss angewandt sein');
  assert.equal(guard(html, { original: 'gilt sicherlich', ersatz: 'gilt zweifellos' }), 'ok');
});

test('span.cite OHNE data-src ist Fremdmarkup, kein Marker -> Ersetzung laeuft', () => {
  // Gleiche Regel wie CITE_SEL: ohne Zeiger trägt der Span keine Information,
  // die verloren gehen könnte. Sonst würde jedes fremde <span class="cite">
  // (z.B. aus einem HTML-Import) die Korrektur grundlos blockieren.
  const html = '<p>Er nannte <span class="cite">ein Werk</span> im Text.</p>';
  const res = replaceInHtml(html, 'Er nannte ein Werk im Text.', 'Er erwähnte ein Werk im Text.');
  assert.notEqual(res, html);
  assert.ok(res.includes('Er erwähnte ein Werk im Text.'));
});

test('Gewoehnlicher <span> blockiert nicht (nur Marker-Spans zaehlen)', () => {
  const html = '<p>Er sagte <span class="hervor">das magische</span> Wort.</p>';
  const res = replaceInHtml(html, 'das magische Wort', 'das geheime Wort');
  assert.ok(res.includes('das geheime Wort'));
});

test('Waisen-Marker (Open davor) wird wieder angeklebt statt blockiert', () => {
  // Nur der Close liegt im Treffer: `_splitOrphanTags` rettet das Tag, der
  // Zeiger überlebt. Blockieren wäre hier unnötig streng — der Chip-Text ist
  // ohnehin nur ein Cache, den jeder Ausgabeweg frisch setzt.
  const html = '<p><span class="cite" data-src="7">(Müller, 2020)</span> belegt das klar.</p>';
  const res = replaceInHtml(html, '2020) belegt das klar', '2020) zeigt das klar');
  assert.ok(res.includes('data-src="7"'), 'Zeiger überlebt');
  assert.ok(res.includes('zeigt das klar'), 'Korrektur angewandt');
});

test('replaceInHtml: Waisen-</a> im Treffer (Open davor) wird wieder angeklebt', () => {
  // Treffer umspannt das schliessende </a>: Close liegt im Bereich, Open davor.
  // _containsBalancedAnchor greift NICHT (kein Paar im Slice); der Orphan-
  // Mechanismus klebt </a> wieder an — der Link überlebt die Ersetzung.
  const html = '<p><a href="https://example.com">unsere Website</a> lohnt sich.</p>';
  const res = replaceInHtml(html, 'Website lohnt', 'Seite lohnt');
  assert.ok(res.includes('href="https://example.com"'), 'Link muss erhalten bleiben');
  assert.ok(res.includes('</a>'), 'schliessendes Tag muss erhalten bleiben');
  assert.ok(res.includes('Seite lohnt'), 'Ersetzung muss greifen');
});
