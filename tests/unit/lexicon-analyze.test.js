'use strict';
// Unit-Tests des Wortschatz-Orchestrators (lib/lexicon/analyze.js). Pure — die
// Funktion bekommt Seiten-HTML als Strings und gibt Zahlen zurück, keine DB.
// Lauf: `node --test tests/unit/lexicon-analyze.test.js`

const test = require('node:test');
const assert = require('node:assert/strict');

const { analyzeBook, blockTextsFromHtml, LEXICON_VERSION } = require('../../lib/lexicon/analyze');
const { frequencies, tokenize } = require('../../lib/lexicon/tokenize');

// Baut eine Seite mit `count` Wiederholungen eines Satzes (für Masse mit Mindestlänge).
function page(page_id, chapter_id, html) {
  return { page_id, chapter_id, html };
}

test('blockTextsFromHtml: jeder Block wird ein eigener Text', () => {
  assert.deepEqual(
    blockTextsFromHtml('<h2>Kapitel eins</h2><p>Er ging fort.</p><ul><li>Erstens</li><li>Zweitens</li></ul>'),
    ['Kapitel eins', 'Er ging fort.', 'Erstens', 'Zweitens']
  );
});

test('blockTextsFromHtml: <br> trennt, leere Blöcke fallen weg', () => {
  assert.deepEqual(blockTextsFromHtml('<p>Eins<br>Zwei</p><p></p>'), ['Eins', 'Zwei']);
});

test('analyzeBook: Überschrift ohne Satzzeichen klebt nicht am Folgeabsatz', async () => {
  // Ohne Blockgrenzen-Behandlung entstünde die Phantom-Wendung "wald wald".
  const pages = [];
  for (let i = 1; i <= 4; i++) {
    pages.push(page(i, 10, '<h2>Der dunkle Wald</h2><p>Wald war still.</p>'));
  }
  const { phrases } = await analyzeBook(pages);
  assert.equal(phrases.some(p => p.phrase === 'wald wald'), false);
  // Die echten Wendungen innerhalb der Blöcke sind da.
  assert.ok(phrases.some(p => p.phrase === 'der dunkle wald'));
  assert.ok(phrases.some(p => p.phrase === 'wald war still'));
});

test('analyzeBook: Kennzahlen + Version, Token-Zahl aus der Token-Sequenz', async () => {
  const pages = [page(1, 10, '<p>Der Hund bellt laut.</p>'), page(2, 10, '<p>Die Katze schläft tief.</p>')];
  const { stats } = await analyzeBook(pages);
  assert.equal(stats.version, LEXICON_VERSION);
  assert.equal(stats.pages, 2);
  assert.equal(stats.segments, 2);
  // 4 + 4 Token, alle unterschiedlich → types = tokens, Hapax-Quote 1.
  assert.equal(stats.tokens, 8);
  assert.equal(stats.types, 8);
  assert.equal(stats.hapax_ratio, 1);
  // Kurzer Text: MATTR fällt auf die einfache TTR mit Fenster = Textlänge zurück,
  // MTLD/Heaps liefern null statt einer Scheingenauigkeit.
  assert.equal(stats.mattr_window, 8);
  assert.equal(stats.mattr, 1);
  assert.equal(stats.mtld, null);
  assert.equal(stats.heaps_beta, null);
});

test('analyzeBook: Stoppwörter und Eigennamen stehen nicht in der Wortliste', async () => {
  const html = '<p>Und dann sagte Kassandra, dass der Nebel über dem Nebel lag.</p>';
  const pages = [page(1, 10, html), page(2, 10, html), page(3, 10, html)];
  const names = new Set(['kassandra']);
  const { terms } = await analyzeBook(pages, { nameStopwords: names });
  const words = terms.map(t => t.term);
  assert.ok(words.includes('nebel'), 'Inhaltswort muss drin sein');
  assert.equal(words.includes('kassandra'), false, 'Eigenname muss raus');
  assert.equal(words.includes('dass'), false, 'Stoppwort muss raus');
  assert.equal(words.includes('und'), false, 'Stoppwort muss raus');
  // "sagte" ist ein Inhaltswort ≥4 Zeichen und darf NICHT stillschweigend fehlen.
  assert.ok(words.includes('sagte'));
});

test('analyzeBook: lexikalische Dichte zählt Eigennamen mit (anders als die Wortliste)', async () => {
  // Bewusster Unterschied: für die Dichte ist ein Name ein Inhaltswort, für die
  // Lieblingswort-Rangliste nicht.
  const pages = [page(1, 10, '<p>Kassandra ging.</p>')];
  const { stats } = await analyzeBook(pages, { nameStopwords: new Set(['kassandra']) });
  assert.equal(stats.tokens, 2);
  assert.equal(stats.lex_density, 1); // beide Token sind Inhaltswörter
});

test('analyzeBook: Streuung über Kapitel + erste Fundstelle', async () => {
  const pages = [
    page(11, 1, '<p>Nebel überall. Nebel bleibt.</p>'),
    page(12, 1, '<p>Nebel wieder.</p>'),
    page(21, 2, '<p>Nebel im zweiten Kapitel.</p>'),
  ];
  const { terms } = await analyzeBook(pages);
  const nebel = terms.find(t => t.term === 'nebel');
  assert.equal(nebel.count, 4);
  assert.equal(nebel.chapter_spread, 2);   // Kapitel 1 und 2
  assert.equal(nebel.first_page_id, 11);   // Sprungziel = erste Fundstelle
});

test('analyzeBook: Seite ohne Kapitel zählt als eigene Streuungs-Einheit', async () => {
  const pages = [
    page(1, null, '<p>Nebel eins.</p>'),
    page(2, null, '<p>Nebel zwei.</p>'),
    page(3, 7, '<p>Nebel drei.</p>'),
  ];
  const { terms } = await analyzeBook(pages);
  const nebel = terms.find(t => t.term === 'nebel');
  // kapitellos (null) + Kapitel 7 = 2 Einheiten, nicht 3 und nicht 1.
  assert.equal(nebel.chapter_spread, 2);
});

test('analyzeBook: Wendung trägt Streuung, Sprungziel und log-Dice', async () => {
  const pages = [
    page(1, 1, '<p>Er zuckte mit einem Ruck zurück.</p>'),
    page(2, 1, '<p>Sie fuhr mit einem Ruck hoch.</p>'),
    page(3, 2, '<p>Der Wagen hielt mit einem Ruck.</p>'),
  ];
  const { phrases } = await analyzeBook(pages);
  const ruck = phrases.find(p => p.phrase === 'mit einem ruck');
  assert.ok(ruck, 'die dreifach vorkommende Wendung muss gefunden werden');
  assert.equal(ruck.n, 3);
  assert.equal(ruck.count, 3);
  assert.equal(ruck.chapter_spread, 2);
  assert.equal(ruck.first_page_id, 1);
  assert.ok(typeof ruck.log_dice === 'number');
});

test('analyzeBook: Keyness leer ohne Referenz, gesetzt mit Referenz', async () => {
  const pages = [page(1, 1, '<p>Nebel Nebel Nebel überall.</p>')];
  const solo = await analyzeBook(pages);
  assert.equal(solo.terms.find(t => t.term === 'nebel').keyness, null);

  // Referenzkorpus, in dem "nebel" nicht vorkommt → deutlich überrepräsentiert.
  const refTokens = tokenize('Sonne Sonne Wiese Wiese Himmel Himmel Wolke Wolke'.repeat(20));
  const withRef = await analyzeBook(pages, {
    reference: { freq: frequencies(refTokens), total: refTokens.length },
  });
  const k = withRef.terms.find(t => t.term === 'nebel').keyness;
  assert.ok(k > 0, `im Zielbuch überrepräsentiert → positiv, war ${k}`);
});

test('analyzeBook: leeres Buch liefert Nullwerte statt NaN', async () => {
  const { stats, terms, phrases } = await analyzeBook([]);
  assert.equal(stats.tokens, 0);
  assert.equal(stats.types, 0);
  assert.equal(stats.mattr, null);
  assert.equal(stats.yule_k, null);
  assert.equal(stats.lex_density, null);
  assert.equal(terms.length, 0);
  assert.equal(phrases.length, 0);
});

test('analyzeBook: onYield wird gerufen (Event-Loop-Rückgabe im Cron)', async () => {
  let calls = 0;
  await analyzeBook([page(1, 1, '<p>Ein Satz.</p>')], { onYield: async () => { calls++; } });
  assert.ok(calls >= 3, `mindestens einmal pro Phase, war ${calls}`);
});
