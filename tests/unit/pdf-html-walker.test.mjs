import { test } from 'node:test';
import assert from 'node:assert';
import { parseHtmlToBlocks } from '../../lib/pdf-render/html-walker.js';

test('Heading + Paragraph + Inline-Stil', () => {
  const blocks = parseHtmlToBlocks('<h1>Kapitel 1</h1><p>Text mit <strong>fett</strong> und <em>kursiv</em>.</p>');
  assert.deepEqual(blocks[0], { kind: 'heading', level: 1, text: 'Kapitel 1' });
  assert.equal(blocks[1].kind, 'paragraph');
  const runs = blocks[1].runs;
  assert.equal(runs[0].text, 'Text mit ');
  assert.equal(runs[1].bold, true);
  assert.equal(runs[1].text, 'fett');
  assert.equal(runs[3].italic, true);
});

test('div.poem wird als poem-Block erkannt mit pro-Absatz-Linie', () => {
  const blocks = parseHtmlToBlocks(
    '<div class="poem"><p>Wenn nicht mehr Zahlen und Figuren</p><p>Sind Schlüssel aller Kreaturen</p></div>'
  );
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'poem');
  assert.equal(blocks[0].lines.length, 2);
  assert.equal(blocks[0].lines[0][0].italic, true);
});

test('div.poem behält Strophen-Trenner (leere Absätze) als leere Zeilen', () => {
  const blocks = parseHtmlToBlocks(
    '<div class="poem"><p>Strophe eins A</p><p>Strophe eins B</p><p><br></p><p>Strophe zwei A</p><p>Strophe zwei B</p></div>'
  );
  assert.equal(blocks[0].kind, 'poem');
  assert.equal(blocks[0].lines.length, 5);
  assert.equal(blocks[0].lines[2].length, 0);
  assert.equal(blocks[0].lines[3][0].text, 'Strophe zwei A');
});

test('div.poem kollabiert führende/doppelte/schliessende Leerzeilen', () => {
  const blocks = parseHtmlToBlocks(
    '<div class="poem"><p><br></p><p>A</p><p><br></p><p><br></p><p>B</p><p><br></p></div>'
  );
  assert.equal(blocks[0].lines.length, 3);
  assert.equal(blocks[0].lines[0][0].text, 'A');
  assert.equal(blocks[0].lines[1].length, 0);
  assert.equal(blocks[0].lines[2][0].text, 'B');
});

test('leerer Absatz (Leerzeile) wird als blankline-Block erhalten', () => {
  const blocks = parseHtmlToBlocks('<p>Erster</p><p></p><p>Zweiter</p>');
  assert.deepEqual(blocks.map(b => b.kind), ['paragraph', 'blankline', 'paragraph']);
});

test('blankline: führende/abschliessende verworfen, aufeinanderfolgende kollabiert', () => {
  const blocks = parseHtmlToBlocks('<p><br></p><p>A</p><p></p><p><br></p><p>B</p><p></p>');
  assert.deepEqual(blocks.map(b => b.kind), ['paragraph', 'blankline', 'paragraph']);
});

test('Listen mit ordered/unordered + verschachtelte Inline-Styles', () => {
  const blocks = parseHtmlToBlocks('<ol><li>Eins</li><li>Zwei mit <em>kursiv</em></li></ol>');
  assert.equal(blocks[0].kind, 'list');
  assert.equal(blocks[0].ordered, true);
  assert.equal(blocks[0].items.length, 2);
});

test('Tabellen werden als table-Block gelesen, nicht als Fliesstext', () => {
  const blocks = parseHtmlToBlocks('<table><tr><td>Zelle</td></tr></table>');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'table');
  assert.equal(blocks[0].rows[0][0][0].text, 'Zelle');
  assert.equal(blocks[0].header, null, 'ohne <th> gibt es keine Kopfzeile');
});

test('Tabelle: Kopfzeile, Ausrichtung und Beschriftung', () => {
  const [b] = parseHtmlToBlocks(
    '<table><caption>Umsatz</caption>'
    + '<thead><tr><th>Jahr</th><th data-align="right">Wert</th></tr></thead>'
    + '<tbody><tr><td>2023</td><td data-align="right">1.2</td></tr></tbody></table>');
  assert.equal(b.kind, 'table');
  assert.deepEqual(b.align, ['left', 'right']);
  assert.equal(b.header[0][0].text, 'Jahr');
  assert.equal(b.caption[0].text, 'Umsatz');
  assert.equal(b.rows.length, 1);
});

test('Tabelle: colspan verschiebt die Folgezellen nicht in die falsche Spalte', () => {
  // Import-Markup (Word/ODT) kann verbundene Zellen tragen. Der Inhalt steht in
  // der ersten Spalte des Verbunds, die restlichen bleiben leer — ohne das
  // Ueberspringen stuende „Rest" unter der falschen Kopfzeile.
  const [b] = parseHtmlToBlocks(
    '<table><thead><tr><th>A</th><th>B</th><th>C</th></tr></thead>'
    + '<tbody><tr><td colspan="2">Verbund</td><td>Rest</td></tr></tbody></table>');
  assert.equal(b.align.length, 3);
  assert.equal(b.rows[0][0][0].text, 'Verbund');
  assert.deepEqual(b.rows[0][1], [], 'die uebersprungene Spalte bleibt leer');
  assert.equal(b.rows[0][2][0].text, 'Rest');
});

test('Tabelle: weiche Umbrueche in der Zelle werden zu Leerzeichen', () => {
  // Eine Zeile im Tabellensatz bricht nach der Spaltenbreite, nicht nach dem
  // <br> des Autors.
  const [b] = parseHtmlToBlocks('<table><tr><td>a<br>b</td></tr></table>');
  const texts = b.rows[0][0].map(r => r.text);
  assert.ok(!texts.includes('\n'), 'kein harter Umbruch in der Zelle');
  assert.match(texts.join(''), /a\s?b/);
});

test('Links bekommen underline + link', () => {
  const blocks = parseHtmlToBlocks('<p>Siehe <a href="https://x">hier</a>.</p>');
  const link = blocks[0].runs.find(r => r.link);
  assert.equal(link?.link, 'https://x');
  assert.equal(link?.underline, true);
});

test('hr und img werden als eigene Block-Typen erkannt', () => {
  const blocks = parseHtmlToBlocks('<hr><img src="/foo.png" alt="x">');
  assert.equal(blocks[0].kind, 'hr');
  assert.equal(blocks[1].kind, 'image');
  assert.equal(blocks[1].src, '/foo.png');
});

test('hr.pagebreak/blankpage werden erkannt (sonst hr)', () => {
  const blocks = parseHtmlToBlocks('<hr class="pagebreak"><hr class="blankpage"><hr>');
  assert.equal(blocks[0].kind, 'pagebreak');
  assert.equal(blocks[1].kind, 'blankpage');
  assert.equal(blocks[2].kind, 'hr');
});

// ── Realistisches Editor-Markup ─────────────────────────────────────────────
// Die Fälle oben nutzen handgeschriebenes Sauber-HTML. Produktives Seiten-HTML
// aus dem Content-Store trägt aber auf jedem Block-Tag eine stabile `data-bid`
// (lib/html-clean.js#ensureBlockIds, Basis für Block-Level-Merge + Kommentar-
// Anker) und verschachtelt Inline-Stile tiefer. Diese Fälle spiegeln das echte
// Markup, damit der Walker nicht nur an idealisierten Fixtures grün ist.

test('data-bid auf Block-Tags wird toleriert (ignoriert, kein Leak in Output)', () => {
  const blocks = parseHtmlToBlocks(
    '<h2 data-bid="a1b2c3d4">Kapiteltitel</h2>' +
    '<p data-bid="e5f6a7b8">Erster Absatz mit <strong>Betonung</strong>.</p>'
  );
  assert.deepEqual(blocks[0], { kind: 'heading', level: 2, text: 'Kapiteltitel' });
  assert.equal(blocks[1].kind, 'paragraph');
  assert.equal(blocks[1].runs[1].bold, true);
  assert.equal(blocks[1].runs[1].text, 'Betonung');
});

test('Überschriften-Level > 3 werden auf 3 geklemmt (h4/h5/h6)', () => {
  const blocks = parseHtmlToBlocks(
    '<h4 data-bid="1">Vier</h4><h5 data-bid="2">Fünf</h5><h6 data-bid="3">Sechs</h6>'
  );
  assert.deepEqual(blocks.map(b => b.level), [3, 3, 3]);
  assert.deepEqual(blocks.map(b => b.text), ['Vier', 'Fünf', 'Sechs']);
});

test('verschachtelte Inline-Stile kumulieren (strong > em → bold+italic)', () => {
  const blocks = parseHtmlToBlocks(
    '<p data-bid="1">Ein <strong>fett <em>und kursiv</em></strong> Wort.</p>'
  );
  const runs = blocks[0].runs;
  const both = runs.find(r => r.bold && r.italic);
  assert.ok(both, 'kombinierter bold+italic Run erwartet');
  assert.equal(both.text, 'und kursiv');
});

test('blockquote mit verschachtelten data-bid-Absätzen', () => {
  const blocks = parseHtmlToBlocks(
    '<blockquote data-bid="1"><p data-bid="2">Zitatzeile eins.</p>' +
    '<p data-bid="3">Zitatzeile zwei.</p></blockquote>'
  );
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'blockquote');
  assert.equal(blocks[0].blocks.length, 2);
  assert.equal(blocks[0].blocks[0].runs[0].text, 'Zitatzeile eins.');
});

test('pre behält Zeilenumbrüche als eigene Zeilen', () => {
  const blocks = parseHtmlToBlocks('<pre data-bid="1">Zeile eins\nZeile zwei</pre>');
  assert.equal(blocks[0].kind, 'pre');
  assert.deepEqual(blocks[0].lines.map(l => l[0].text), ['Zeile eins', 'Zeile zwei']);
});

test('figure mit img + figcaption → Bild-Block bleibt erhalten, Caption als kursiver Paragraph', () => {
  const blocks = parseHtmlToBlocks(
    '<figure data-bid="f1"><img src="/bild.png" alt="Ein Bild"><figcaption>Bildunterschrift.</figcaption></figure>'
  );
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], { kind: 'image', src: '/bild.png', alt: 'Ein Bild' });
  assert.equal(blocks[1].kind, 'paragraph');
  assert.equal(blocks[1].runs[0].text, 'Bildunterschrift.');
  assert.equal(blocks[1].runs[0].italic, true);
});

test('figure ohne figcaption → nur Bild-Block, kein leerer Paragraph', () => {
  const blocks = parseHtmlToBlocks('<figure data-bid="f1"><img src="/bild.png"></figure>');
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0], { kind: 'image', src: '/bild.png', alt: '' });
});

test('reale Tabelle (thead/tbody, mehrere Zellen) behaelt Struktur UND Inhalt', () => {
  const blocks = parseHtmlToBlocks(
    '<table data-bid="1"><thead><tr><th>Name</th><th>Rolle</th></tr></thead>' +
    '<tbody><tr><td>Josef K.</td><td>Angeklagter</td></tr></tbody></table>'
  );
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'table', 'kein Fliesstext-Fallback mehr');
  const text = [
    ...blocks[0].header.flat(),
    ...blocks[0].rows.flat(2),
  ].map(r => r.text).join(' ');
  for (const cell of ['Name', 'Rolle', 'Josef K.', 'Angeklagter']) {
    assert.ok(text.includes(cell), `Zellinhalt "${cell}" darf nicht verloren gehen`);
  }
});
