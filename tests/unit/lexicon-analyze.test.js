'use strict';
// Unit-Tests des Wortschatz-Orchestrators (lib/lexicon/analyze.js). Pure — die
// Funktion bekommt Seiten-HTML als Strings und gibt Zahlen zurück, keine DB.
// Lauf: `node --test tests/unit/lexicon-analyze.test.js`

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  analyzeBook, blockTextsFromHtml, LEXICON_VERSION, TERM_LIMIT, _selectHapax,
} = require('../../lib/lexicon/analyze');
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

// ── Zweite Auswahlachse: Auffälligkeit ────────────────────────────────────────
// Die Häufigkeit allein verfehlt genau die Wörter, die dieses Buch von den
// übrigen unterscheiden. Der Aufbau erzwingt das: mehr Füllwörter als Plätze in
// der Häufigkeitsliste, dazu ein selteneres Wort, das die Referenz nicht kennt.

function fillerWord(i) {
  return 'blind' + String.fromCharCode(97 + Math.floor(i / 26)) + String.fromCharCode(97 + (i % 26));
}

// count Füllwörter à 4 Vorkommen + `sonderling` à 3 → Rang 201+, wenn nur die
// Häufigkeit zählt.
function keynessFixture(fillerCount = TERM_LIMIT + 5) {
  const blocks = [];
  const refFreq = new Map();
  for (let i = 0; i < fillerCount; i++) {
    const w = fillerWord(i);
    blocks.push(`<p>${w} ${w} ${w} ${w}</p>`);
    refFreq.set(w, 40); // in der Referenz zehnfach — also gleiche Rate, nicht auffällig
  }
  blocks.push('<p>sonderling sonderling sonderling</p>');
  const targetTokens = fillerCount * 4 + 3;
  return {
    pages: [page(1, 1, blocks.join(''))],
    reference: { freq: refFreq, total: targetTokens * 10 },
  };
}

test('analyzeBook: auffälliges Wort kommt in die Liste, obwohl es nicht häufig genug ist', async () => {
  const { pages, reference } = keynessFixture();

  // Ohne Referenz entscheidet nur die Häufigkeit — das seltenere Wort fällt raus.
  const solo = await analyzeBook(pages);
  assert.equal(solo.terms.filter(t => t.kind === 'freq').length, TERM_LIMIT);
  assert.equal(solo.terms.some(t => t.term === 'sonderling'), false);

  const withRef = await analyzeBook(pages, { reference: { ...reference, floor: 3 } });
  const row = withRef.terms.find(t => t.term === 'sonderling');
  assert.ok(row, 'über die Auffälligkeit ausgewählt');
  assert.equal(row.kind, 'key');
  assert.equal(row.count, 3);
  // Die Häufigkeitsplätze bleiben unangetastet — die zweite Achse kommt dazu,
  // sie verdrängt nichts.
  assert.equal(withRef.terms.filter(t => t.kind === 'freq').length, TERM_LIMIT);
});

test('analyzeBook: Auswahl ist vorsichtig gegen die Kappungsgrenze der Referenz', async () => {
  // Dieselbe Lage, aber die Referenztabelle ist erst ab 60 Vorkommen gefüllt: ein
  // dort fehlendes Wort kann trotzdem 59-mal vorkommen. Dann ist die Auffälligkeit
  // nicht belegt, und die Zeile darf nicht in die Liste — sonst besteht sie
  // bevorzugt aus Wörtern, deren Wert nur aus der Kappung stammt.
  const { pages, reference } = keynessFixture();
  const withFloor = await analyzeBook(pages, { reference: { ...reference, floor: 60 } });
  assert.equal(withFloor.terms.some(t => t.term === 'sonderling'), false);
});

// ── Einmalwörter ──────────────────────────────────────────────────────────────

test('analyzeBook: Einmalwörter als eigene Zeilensorte, mit Sprungziel', async () => {
  const pages = [
    page(1, 10, '<p>Der Morgennebelschleier lag über allem.</p>'),
    page(2, 10, '<p>Nebel Nebel Nebel und ein Firnfeld.</p>'),
  ];
  const { terms, stats } = await analyzeBook(pages);
  const hapax = terms.filter(t => t.kind === 'hapax');
  const byTerm = new Map(hapax.map(h => [h.term, h]));

  assert.ok(byTerm.has('morgennebelschleier'));
  assert.ok(byTerm.has('firnfeld'));
  assert.equal(byTerm.get('morgennebelschleier').count, 1);
  assert.equal(byTerm.get('morgennebelschleier').first_page_id, 1);
  assert.equal(byTerm.get('firnfeld').first_page_id, 2);
  // Dreimal benutzt heisst: kein Einmalwort, sondern ein Lieblingswort.
  assert.equal(byTerm.has('nebel'), false);
  assert.equal(terms.find(t => t.term === 'nebel').kind, 'freq');
  // Keyness bleibt leer: bei einem einzigen Vorkommen schlägt Log-Likelihood
  // schon bei Zufallsschwankungen an.
  assert.equal(byTerm.get('firnfeld').keyness, null);
  // Die längsten zuerst — so trifft der Deckel die richtigen.
  assert.equal(hapax[0].term, 'morgennebelschleier');
  // hapax_listed zählt ALLE Einmalwörter nach den Listenfiltern, nicht nur die
  // gezeigten; `stats.hapax` zählt zusätzlich Stoppwörter und kurze Wörter.
  assert.equal(stats.hapax_listed, hapax.length);
  assert.ok(stats.hapax > stats.hapax_listed, 'Stoppwörter zählen nur in stats.hapax');
});

test('analyzeBook: Stoppwörter, Eigennamen und kurze Wörter sind keine Einmalwörter', async () => {
  const pages = [page(1, 1, '<p>Kassandra sah aber nur Eis und ein Alpenglühen.</p>')];
  const { terms } = await analyzeBook(pages, { nameStopwords: new Set(['kassandra']) });
  const hapax = terms.filter(t => t.kind === 'hapax').map(t => t.term);
  assert.deepEqual(hapax, ['alpenglühen']);
  assert.equal(hapax.includes('kassandra'), false); // Eigenname
  assert.equal(hapax.includes('eis'), false);       // unter der Mindestlänge
  assert.equal(hapax.includes('aber'), false);      // Stoppwort
});

test('_selectHapax: was der Autor anderswo benutzt, steht hinten — dann die längsten', () => {
  const reference = { freq: new Map([['sonnenaufgangsfarbe', 12]]) };
  const picked = _selectHapax(['kurzwort', 'sonnenaufgangsfarbe', 'nebelkrone'], reference, 2);
  // Das Wort aus der Referenz fliegt trotz Länge raus: einmal HIER und sonst nie
  // ist die Frage, nicht einfach „einmal hier".
  assert.deepEqual(picked, ['nebelkrone', 'kurzwort']);
});

test('_selectHapax: Deckel greift, Reihenfolge ist deterministisch', () => {
  const words = ['aaaaaa', 'bbbbbb', 'cccccc', 'ddddddd'];
  assert.deepEqual(_selectHapax(words, null, 2), ['ddddddd', 'aaaaaa']);
  assert.deepEqual(_selectHapax([...words].reverse(), null, 2), ['ddddddd', 'aaaaaa']);
});
