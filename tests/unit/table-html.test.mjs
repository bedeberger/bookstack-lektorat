// Tabellen-Markup: der Vertrag aus public/js/table/table-html.js.
//
// Der Round-Trip Modell → HTML → Modell ist der Kern. Er ist die Zusage, auf der
// der Gitter-Dialog steht: eine Tabelle oeffnen und ohne Aenderung schliessen
// darf das Markup nicht anfassen. Bricht das, verliert jeder Dialog-Aufruf
// stillschweigend Auszeichnung oder Ausrichtung.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

import {
  TABLE_SEL, TABLE_ALIGNS, TABLE_MAX_COLS, TABLE_MAX_ROWS,
  isTableEl, closestTableEl, tableModel, buildTableHtml, collectTables,
  emptyTableModel, markTablesAtomic,
} from '../../public/js/table/table-html.js';

function root(html) {
  const { document } = parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body></html>`);
  return document.getElementById('r');
}
function tableEl(html) {
  return root(html).querySelector('table');
}

const SIMPLE = `<table data-bid="a1b2c3d4">`
  + `<caption>Umsatz nach Jahr</caption>`
  + `<thead><tr><th scope="col">Jahr</th><th scope="col" data-align="right">Umsatz</th></tr></thead>`
  + `<tbody><tr><td>2023</td><td data-align="right">1.2 Mio</td></tr>`
  + `<tr><td>2024</td><td data-align="right">1.8 Mio</td></tr></tbody></table>`;

// ── Auslesen ────────────────────────────────────────────────────────────────

test('tableModel liest Beschriftung, Kopf, Zeilen und Ausrichtung', () => {
  const m = tableModel(tableEl(SIMPLE));
  assert.equal(m.caption, 'Umsatz nach Jahr');
  assert.equal(m.header.length, 2);
  assert.equal(m.header[0].text, 'Jahr');
  assert.equal(m.rows.length, 2);
  assert.deepEqual(m.rows.map(r => r[0].text), ['2023', '2024']);
  assert.deepEqual(m.align, ['left', 'right']);
  assert.equal(m.lossy, false);
});

test('Kopfzeile wird auch ohne thead erkannt (Import-Markup)', () => {
  // mammoth (DOCX-Import) liefert oft kein thead.
  const m = tableModel(tableEl('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>'));
  assert.ok(m.header, 'erste Ganz-th-Zeile muss als Kopf gelten');
  assert.equal(m.rows.length, 1);
});

test('ohne th gibt es keine Kopfzeile', () => {
  const m = tableModel(tableEl('<table><tr><td>1</td><td>2</td></tr></table>'));
  assert.equal(m.header, null);
  assert.equal(m.rows.length, 1);
});

test('kurze Zeilen werden auf die breiteste aufgefuellt', () => {
  const m = tableModel(tableEl('<table><tr><td>1</td><td>2</td><td>3</td></tr><tr><td>a</td></tr></table>'));
  assert.equal(m.align.length, 3);
  assert.equal(m.rows[1].length, 3, 'kurze Zeile muss aufgefuellt werden');
  assert.equal(m.rows[1][2].text, '');
});

test('die Kopfzelle ist fuer die Ausrichtung ihrer Spalte autoritativ', () => {
  const m = tableModel(tableEl(
    '<table><thead><tr><th data-align="center">A</th></tr></thead>'
    + '<tbody><tr><td data-align="right">1</td></tr></tbody></table>'));
  assert.deepEqual(m.align, ['center'], 'Kopf schlaegt Zelle');
});

test('ohne Kopfzeile gewinnt die erste Zelle mit Angabe', () => {
  const m = tableModel(tableEl('<table><tr><td>1</td></tr><tr><td data-align="right">2</td></tr></table>'));
  assert.deepEqual(m.align, ['right']);
});

test('unbekannte Ausrichtung faellt auf left', () => {
  const m = tableModel(tableEl('<table><tr><td data-align="justify">1</td></tr></table>'));
  assert.deepEqual(m.align, ['left']);
  for (const a of m.align) assert.ok(TABLE_ALIGNS.includes(a));
});

// ── Verlustbehaftete Faelle werden gemeldet ─────────────────────────────────

test('colspan/rowspan setzt lossy — der Dialog muss davor warnen', () => {
  assert.equal(tableModel(tableEl('<table><tr><td colspan="2">x</td></tr></table>')).lossy, true);
  assert.equal(tableModel(tableEl('<table><tr><td rowspan="3">x</td></tr></table>')).lossy, true);
});

test('Blockinhalt in einer Zelle setzt lossy', () => {
  assert.equal(tableModel(tableEl('<table><tr><td><p>x</p></td></tr></table>')).lossy, true);
  assert.equal(tableModel(tableEl('<table><tr><td><ul><li>x</li></ul></td></tr></table>')).lossy, true);
});

test('zu viele Zeilen setzen lossy statt still zu kappen', () => {
  const rows = Array.from({ length: TABLE_MAX_ROWS + 5 }, () => '<tr><td>x</td></tr>').join('');
  const m = tableModel(tableEl(`<table>${rows}</table>`));
  assert.equal(m.rows.length, TABLE_MAX_ROWS);
  assert.equal(m.lossy, true);
});

// ── Erzeugen ────────────────────────────────────────────────────────────────

test('buildTableHtml escapet Klartext-Zellen', () => {
  const html = buildTableHtml({ rows: [['<b>fett</b> & mehr']] });
  assert.ok(html.includes('&lt;b&gt;'), 'rohes Markup muss escaped werden');
  assert.ok(!html.includes('<b>'));
});

test('buildTableHtml setzt scope=col auf Kopfzellen', () => {
  const html = buildTableHtml({ header: ['A'], rows: [['1']] });
  assert.ok(html.includes('<th scope="col">'), 'ohne scope kann ein Screenreader die Spalte nicht zuordnen');
});

test('buildTableHtml schreibt data-align nur fuer nicht-left', () => {
  const html = buildTableHtml({ align: ['left', 'right'], header: ['A', 'B'], rows: [['1', '2']] });
  assert.equal((html.match(/data-align="right"/g) || []).length, 2, 'Kopf + Zelle der rechten Spalte');
  assert.ok(!html.includes('data-align="left"'), 'left ist die Vorgabe und gehoert nicht ins Markup');
});

test('buildTableHtml schreibt keine Nummer in die Beschriftung', () => {
  const html = buildTableHtml({ caption: 'Umsatz nach Jahr', rows: [['1']] });
  assert.ok(html.includes('<caption>Umsatz nach Jahr</caption>'));
  assert.ok(!/Tab\.\s*\d/.test(html), 'die Nummer ist ein Render-Artefakt und darf nie persistiert werden');
});

test('buildTableHtml fuellt kurze Zeilen auf die Spaltenzahl auf', () => {
  const html = buildTableHtml({ header: ['A', 'B', 'C'], rows: [['1']] });
  const body = html.split('<tbody>')[1];
  assert.equal((body.match(/<td/g) || []).length, 3);
});

test('buildTableHtml traegt kein data-bid — das setzt der Schreib-Chokepoint', () => {
  assert.ok(!buildTableHtml({ rows: [['1']] }).includes('data-bid'));
});

test('buildTableHtml traegt kein contenteditable', () => {
  assert.ok(!buildTableHtml({ rows: [['1']] }).includes('contenteditable'));
});

test('buildTableHtml wirft aktive Inhalte aus durchgereichtem Zell-HTML', () => {
  const html = buildTableHtml({ rows: [[{ rich: true, html: '<span onclick="x()">a</span><script>y()</script>' }]] });
  assert.ok(!/onclick/i.test(html));
  assert.ok(!/<script/i.test(html));
});

// ── Round-Trip ──────────────────────────────────────────────────────────────

test('Round-Trip Modell → HTML → Modell ist stabil', () => {
  const m1 = tableModel(tableEl(SIMPLE));
  const m2 = tableModel(tableEl(buildTableHtml(m1)));
  assert.equal(m2.caption, m1.caption);
  assert.deepEqual(m2.align, m1.align);
  assert.deepEqual(m2.header.map(c => c.text), m1.header.map(c => c.text));
  assert.deepEqual(m2.rows.map(r => r.map(c => c.text)), m1.rows.map(r => r.map(c => c.text)));
});

test('unangetastete Auszeichnung ueberlebt den Round-Trip', () => {
  const src = '<table><tr><td><strong>fett</strong> und <em>kursiv</em></td></tr></table>';
  const m1 = tableModel(tableEl(src));
  assert.equal(m1.rows[0][0].rich, true, 'Zelle mit Auszeichnung muss als rich erkannt werden');
  const out = buildTableHtml(m1);
  assert.ok(out.includes('<strong>fett</strong>'), 'Auszeichnung darf beim Speichern nicht verschwinden');
  assert.ok(out.includes('<em>kursiv</em>'));
});

test('Quellen-Chip und Querverweis in einer Zelle bleiben unangetastet', () => {
  const src = '<table><tr><td>Wert<span class="cite" data-src="7" data-loc="44">(Müller, 2020, S. 44)</span></td>'
    + '<td><span class="xref" data-xref="chapter" data-xref-id="42">Kapitel 3</span></td></tr></table>';
  const out = buildTableHtml(tableModel(tableEl(src)));
  assert.ok(out.includes('data-src="7"'), 'data-src ist die Wahrheit des Quellennachweises');
  assert.ok(out.includes('data-loc="44"'));
  assert.ok(out.includes('data-xref-id="42"'), 'ohne den Zeiger nummeriert der Verweis nicht mehr mit');
});

test('geaenderter Zelltext ersetzt die Auszeichnung — rich=false ist die Ansage', () => {
  const m = tableModel(tableEl('<table><tr><td><strong>alt</strong></td></tr></table>'));
  m.rows[0][0] = { ...m.rows[0][0], text: 'neu', rich: false };
  const out = buildTableHtml(m);
  assert.ok(out.includes('<td>neu</td>'));
  assert.ok(!out.includes('<strong>'));
});

test('Import-Kruscht faellt raus, der Inhalt bleibt', () => {
  const src = '<table><tr><td><font face="Calibri"><span style="color:red">Wert</span></font></td></tr></table>';
  const out = buildTableHtml(tableModel(tableEl(src)));
  assert.ok(out.includes('Wert'));
  assert.ok(!/font|style=/i.test(out), 'Styles gehoeren nach public/css, nicht in die Persistenz');
});

// ── Selektoren + Editor-Laufzeit ────────────────────────────────────────────

test('isTableEl und closestTableEl', () => {
  const r = root('<p>x</p>' + SIMPLE);
  const t = r.querySelector('table');
  assert.equal(isTableEl(t), true);
  assert.equal(isTableEl(r.querySelector('p')), false);
  assert.equal(closestTableEl(r.querySelector('td')), t);
  assert.equal(closestTableEl(r.querySelector('p')), null);
});

test('TABLE_SEL hat bewusst keinen Marker-Klassennamen', () => {
  assert.equal(TABLE_SEL, 'table', 'importierte Tabellen muessen als Tabellen gelten');
});

test('collectTables liefert Dokumentreihenfolge', () => {
  const r = root('<table><caption>eins</caption><tr><td>a</td></tr></table>'
    + '<table><caption>zwei</caption><tr><td>b</td></tr></table>');
  assert.deepEqual(collectTables(r).map(t => t.model.caption), ['eins', 'zwei']);
});

test('markTablesAtomic setzt contenteditable=false', () => {
  const r = root(SIMPLE);
  markTablesAtomic(r);
  assert.equal(r.querySelector('table').getAttribute('contenteditable'), 'false');
});

test('emptyTableModel liefert ein bearbeitbares Gitter innerhalb der Deckel', () => {
  const m = emptyTableModel(4, 3);
  assert.equal(m.header.length, 4);
  assert.equal(m.rows.length, 3);
  assert.equal(m.rows[0].length, 4);
  const big = emptyTableModel(TABLE_MAX_COLS + 10, TABLE_MAX_ROWS + 10);
  assert.equal(big.header.length, TABLE_MAX_COLS);
  assert.equal(big.rows.length, TABLE_MAX_ROWS);
});

test('robuste Rueckfaelle statt Ausnahmen', () => {
  assert.deepEqual(tableModel(null).rows, []);
  assert.deepEqual(collectTables(null), []);
  assert.equal(isTableEl(null), false);
  assert.equal(closestTableEl(null), null);
  assert.doesNotThrow(() => markTablesAtomic(null));
  assert.ok(buildTableHtml(null).startsWith('<table>'));
});
