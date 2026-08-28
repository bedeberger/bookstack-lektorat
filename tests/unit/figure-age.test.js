'use strict';
// Alters-Analyse der Figuren: die drei reinen Schichten unter lib/figure-age/.
// Was hier gegated ist, ist genau das, was das Feature glaubwuerdig macht —
// Muster, die auch ausgeschriebene Zahlen greifen, eine Auswahl, die den
// Buchbogen abdeckt, und eine Verdichtung, die Widersprueche findet statt sie zu
// glaetten.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  germanNumberWord, germanOrdinalWord, extractAgeSignals, numbersIn,
  splitSentences, buildNameIndex, scanPage, selectCandidates, consolidateFigure,
} = require('../../lib/figure-age');

test('Zahlwoerter inkl. Komposita und Umlaut-Varianten', () => {
  assert.equal(germanNumberWord('zwölf'), 12);
  assert.equal(germanNumberWord('fünfundzwanzig'), 25);
  assert.equal(germanNumberWord('einundvierzig'), 41);
  assert.equal(germanNumberWord('dreissig'), 30);
  assert.equal(germanNumberWord('dreißig'), 30);
  assert.equal(germanNumberWord('Kutsche'), null);
  assert.equal(germanOrdinalWord('sechzehnten'), 16);
  assert.equal(germanOrdinalWord('dritten'), 3);
});

test('Altersmuster: Ziffer, Zahlwort, Ordinal-Geburtstag, Englisch', () => {
  const alter = s => extractAgeSignals(s).filter(x => x.art === 'alter').map(x => x.wert);
  assert.deepEqual(alter('Die 12-jährige Anna.'), [12]);
  assert.deepEqual(alter('Die zwölfjährige Anna.'), [12]);
  assert.ok(alter('Er war vierzig Jahre alt.').includes(40));
  assert.ok(alter('Mit 63 Jahren ging er.').includes(63));
  assert.ok(alter('An ihrem sechzehnten Geburtstag.').includes(16));
  assert.ok(alter('She was 34 years old.').includes(34));
  assert.ok(alter('Im Alter von neunzehn verliess sie die Stadt.').includes(19));
});

test('Geburtsjahr in beiden Leserichtungen', () => {
  const geb = s => extractAgeSignals(s).filter(x => x.art === 'geburtsjahr').map(x => x.wert);
  assert.deepEqual(geb('Geboren 1850 in Prag.'), [1850]);
  assert.deepEqual(geb('Sie wurde 1850 geboren.'), [1850]);
  assert.ok(geb('Jahrgang 1903, Sohn eines Schmieds.').includes(1903));
});

test('Unplausible Werte fallen heraus', () => {
  // 300 Jahre ist keine Altersangabe, 12 keine Jahreszahl.
  assert.equal(extractAgeSignals('Der 300-jährige Baum.').filter(x => x.art === 'alter').length, 0);
  assert.equal(extractAgeSignals('Seite 12 des Berichts.').filter(x => x.art === 'jahr').length, 0);
});

test('numbersIn erkennt Ziffer, Zahlwort UND Kompositum — die Pruefgroesse gegen erfundene Werte', () => {
  assert.ok(numbersIn('sie war zwölf').has(12));
  assert.ok(numbersIn('mit 63 Jahren').has(63));
  // Kompositum: das Zahlwort steckt IM Wort. Ohne diesen Fall verwirft die
  // Zahl-Pruefung des Jobs genau die woertlich belegten Angaben.
  assert.ok(numbersIn('Die neunzehnjährige Anna Berg').has(19));
  assert.ok(numbersIn('an ihrem sechzehnten Geburtstag').has(16));
  assert.ok(!numbersIn('sie war ein Kind').has(12));
});

test('splitSentences: Zeile ohne Schlusspunkt bleibt eigener Satz', () => {
  const s = splitSentences('Erster Satz. Zweiter Satz!\nDialogzeile ohne Punkt\nDritter Satz.');
  assert.equal(s.length, 4);
  assert.ok(s[2].text.includes('Dialogzeile'));
});

test('scanPage bindet die Angabe an die Figur — auch ueber den Pronomen-Anschluss', () => {
  const idx = buildNameIndex([
    { id: 1, patterns: [{ text: 'Anna Berg' }, { text: 'Anna' }] },
    { id: 2, patterns: [{ text: 'Konrad' }] },
  ]);
  const hits = scanPage(
    'Anna Berg trat ein. Sie war damals zwölf Jahre alt. Konrad, geboren 1888, schwieg.',
    idx, { page_id: 7, chapter: 'K1', ordinal: 3 },
  );
  const anna = hits.find(h => h.figure_id === 1);
  const konrad = hits.find(h => h.figure_id === 2);
  assert.ok(anna, 'Anna gefunden');
  assert.equal(anna.indirekt, true, 'Angabe steht im Folgesatz');
  assert.ok(anna.satz.includes('Anna Berg'), 'Vorsatz mit im Fenster');
  assert.ok(konrad && !konrad.indirekt);
  assert.equal(konrad.page_id, 7);
});

test('scanPage: Zahl ohne Figur im Fenster ergibt keinen Kandidaten', () => {
  const idx = buildNameIndex([{ id: 1, patterns: [{ text: 'Anna' }] }]);
  assert.equal(scanPage('Der Zug fuhr 1912 ab. Es regnete.', idx, {}).length, 0);
});

test('selectCandidates deckt den Buchbogen ab und meldet den Deckel', () => {
  const mk = (ord, strong) => ({
    ordinal: ord, offset: 0,
    signale: [{ art: strong ? 'alter' : 'jahr', wert: strong ? 20 : 1900, weak: !strong }],
  });
  const list = Array.from({ length: 20 }, (_, i) => mk(i, i % 5 === 0));
  const { picked, dropped } = selectCandidates(list, 6);
  assert.equal(picked.length, 6);
  assert.equal(dropped, 14);
  assert.equal(picked[0].ordinal, 0, 'Anfang drin');
  assert.ok(picked[picked.length - 1].ordinal >= 15, 'Ende drin');
});

test('consolidateFigure: Textangabe gewinnt, Spanne bleibt Spanne', () => {
  const r = consolidateFigure({
    funde: [
      { art: 'alter', wert: 12, zitat: 'zwölf Jahre alt', ordinal: 1, offset: 0 },
      { art: 'alter', wert: 19, zitat: 'neunzehn Jahre alt', ordinal: 9, offset: 0 },
    ],
    kuratiert: { geburtstag: '1900' },
    zeitstrahl: { jahr_im_roman: 1919, geburtsjahr: 1900, alter_im_roman: 19 },
  });
  assert.equal(r.quelle, 'text');
  assert.equal(r.alter_von, 12);
  assert.equal(r.alter_bis, 19);
  assert.equal(r.geburtsjahr, 1900);
  assert.equal(r.geburtsjahr_quelle, 'kuratiert');
  // Der gerechnete Wert liegt IN der belegten Spanne → kein Widerspruch.
  assert.equal(r.gerechnet, 19);
  assert.equal(r.widerspruch, null);
  assert.equal(r.konfidenz, 0.9);
});

test('consolidateFigure: Rechnung greift ohne Textangabe', () => {
  const r = consolidateFigure({
    funde: [],
    kuratiert: { geburtstag: 'Frühling 1880' },
    zeitstrahl: { jahr_im_roman: 1910, geburtsjahr: 1880, alter_im_roman: 30 },
  });
  assert.equal(r.quelle, 'geburtsjahr');
  assert.equal(r.alter_von, 30);
  assert.equal(r.alter_bis, 30);
  assert.equal(r.bezugsjahr_von, 1910);
  assert.equal(r.konfidenz, 0.75);
});

test('consolidateFigure: Rechnung am ANKERJAHR der Figur, nicht am Buchende', () => {
  // Die Figur verschwindet 1987 aus der Geschichte; das Buch endet 2003. Ihr
  // Alter ist 5, nicht 21 — genau der Fehler, den eine buchweite Spanne machte.
  const r = consolidateFigure({
    funde: [],
    kuratiert: { geburtstag: null },
    zeitstrahl: { jahr_im_roman: 1987, geburtsjahr: 1982, alter_im_roman: 5 },
  });
  assert.equal(r.alter_von, 5);
  assert.equal(r.gerechnet, 5);
  assert.equal(r.quelle, 'zeitstrahl');
});

test('consolidateFigure: im Text gefundenes Geburtsjahr traegt die Rechnung', () => {
  // `alter_im_roman` kennt nur das KURATIERTE Geburtsjahr — fehlt das, muss der
  // Textfund die Rechnung tragen, sonst bleibt die Spalte leer, obwohl beide
  // Zahlen bekannt sind.
  const r = consolidateFigure({
    funde: [{ art: 'geburtsjahr', wert: 1950, zitat: 'geboren 1950', ordinal: 1, offset: 0 }],
    kuratiert: { geburtstag: null },
    zeitstrahl: { jahr_im_roman: 1980, geburtsjahr: null, alter_im_roman: null },
  });
  assert.equal(r.geburtsjahr, 1950);
  assert.equal(r.geburtsjahr_quelle, 'text');
  assert.equal(r.gerechnet, 30);
  assert.equal(r.alter_von, 30);
  assert.equal(r.quelle, 'geburtsjahr');
});

test('consolidateFigure: ohne Alter kein Bezugsjahr', () => {
  // `jahr_im_roman` faellt fuer eine undatierte Figur auf das Buchende zurueck.
  // Neben „unbekannt" waere diese Jahreszahl eine Scheinantwort.
  const r = consolidateFigure({
    funde: [],
    kuratiert: { geburtstag: null },
    zeitstrahl: { jahr_im_roman: 2003, geburtsjahr: null, alter_im_roman: null },
  });
  assert.equal(r.alter_von, null);
  assert.equal(r.bezugsjahr_von, null);
  assert.equal(r.bezugsjahr_bis, null);
});

test('consolidateFigure: Widerspruch Steckbrief vs. Text', () => {
  const r = consolidateFigure({
    funde: [{ art: 'geburtsjahr', wert: 1875, zitat: 'geboren 1875', ordinal: 2, offset: 0 }],
    kuratiert: { geburtstag: '1880' },
  });
  assert.equal(r.geburtsjahr, 1880, 'Steckbrief gewinnt');
  assert.ok(r.widerspruch.some(w => w.typ === 'geburtsjahr'));
});

test('consolidateFigure: Alter sinkt im Buchverlauf → Hinweis', () => {
  const r = consolidateFigure({
    funde: [
      { art: 'alter', wert: 30, zitat: 'dreissig', ordinal: 1, offset: 0 },
      { art: 'alter', wert: 12, zitat: 'zwölf', ordinal: 8, offset: 0 },
    ],
  });
  assert.ok(r.widerspruch.some(w => w.typ === 'reihenfolge'));
  // Widerspruch senkt die Konfidenz, verwirft den Wert aber nicht.
  assert.ok(r.konfidenz < 0.9 && r.konfidenz > 0);
  assert.equal(r.alter_von, 12);
  assert.equal(r.alter_bis, 30);
});

test('consolidateFigure: Textangabe gegen Rechnung', () => {
  const r = consolidateFigure({
    funde: [{ art: 'alter', wert: 40, zitat: 'vierzig Jahre alt', ordinal: 5, offset: 0 }],
    kuratiert: { geburtstag: '1900' },
    zeitstrahl: { jahr_im_roman: 1920, geburtsjahr: 1900, alter_im_roman: 20 },
  });
  assert.ok(r.widerspruch.some(w => w.typ === 'rechnung'), 'Text sagt 40, Rechnung 20');
});

test('consolidateFigure: nichts bekannt → keine Aussage', () => {
  const r = consolidateFigure({ funde: [], kuratiert: { geburtstag: null } });
  assert.equal(r.alter_von, null);
  assert.equal(r.quelle, null);
  assert.equal(r.konfidenz, 0);
});

test('consolidateFigure: unsichere Funde bekommen niedrige Konfidenz', () => {
  const r = consolidateFigure({
    funde: [{ art: 'alter', wert: 14, zitat: 'vierzehn', ordinal: 1, offset: 0, unsicher: true }],
  });
  assert.equal(r.quelle, 'text');
  assert.ok(r.konfidenz < 0.6);
});
