// Belegzitat-Verifikation (lib/quote-verify.js).
//
// Zwei Fehlerrichtungen, beide teuer:
//   · zu streng → echte Zitate fallen wegen Anführungszeichen- oder
//     Whitespace-Varianten heraus, die Bewertung verliert ihre Belege;
//   · zu lax → ein halluziniertes Zitat bleibt stehen, und weil es (anders als
//     ein Lektorats-Finding) kein Sprungziel hat, fällt das nie auf.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const {
  quoteFoundIn, verifyZitate, applyQuoteVerification, belegHaystack, normalizeForQuoteMatch,
} = require(path.resolve(__dirname, '..', '..', 'lib', 'quote-verify.js'));

const norm = normalizeForQuoteMatch;
const TEXT = 'Der Nebel lag über dem Fluss.\nSie sagte: «Ich gehe jetzt» – und ging.';

test('wörtliches Zitat wird gefunden', () => {
  assert.ok(quoteFoundIn('Der Nebel lag über dem Fluss.', norm(TEXT)));
  assert.ok(quoteFoundIn('lag über dem Fluss', norm(TEXT)));
});

test('Anführungszeichen- und Strichvarianten sind kein Grund zu verwerfen', () => {
  assert.ok(quoteFoundIn('Sie sagte: "Ich gehe jetzt" - und ging.', norm(TEXT)));
  assert.ok(quoteFoundIn('Sie sagte: „Ich gehe jetzt“ — und ging.', norm(TEXT)));
});

test('Whitespace-Varianten und Zeilenumbrüche werden geglättet', () => {
  assert.ok(quoteFoundIn('Fluss.   Sie sagte', norm(TEXT)));
  assert.ok(quoteFoundIn('Der Nebel lag', norm(TEXT)));
});

test('Gross-/Kleinschreibung am Zitatanfang blockiert nicht', () => {
  assert.ok(quoteFoundIn('der Nebel lag', norm(TEXT)));
});

test('Auslassungen sind Platzhalter, aber die Reihenfolge zählt', () => {
  assert.ok(quoteFoundIn('Der Nebel … und ging.', norm(TEXT)));
  assert.ok(quoteFoundIn('Der Nebel ... und ging.', norm(TEXT)));
  // Rückwärts zusammengesetzt ist kein Zitat, sondern eine Montage.
  assert.ok(!quoteFoundIn('und ging … Der Nebel', norm(TEXT)));
});

test('erfundene Zitate fallen durch', () => {
  assert.ok(!quoteFoundIn('Der Nebel lag über dem Meer.', norm(TEXT)));
  assert.ok(!quoteFoundIn('Sie schwieg und blieb.', norm(TEXT)));
  assert.ok(!quoteFoundIn('', norm(TEXT)));
});

test('verifyZitate trennt gefundene von erfundenen', () => {
  const list = [
    { kind: 'staerke', zitat: 'Der Nebel lag über dem Fluss.', kommentar: 'a' },
    { kind: 'schwaeche', zitat: 'Nie gesagter Satz.', kommentar: 'b' },
  ];
  const { kept, dropped } = verifyZitate(list, TEXT);
  assert.equal(kept.length, 1);
  assert.equal(dropped.length, 1);
  assert.equal(kept[0].zitat, 'Der Nebel lag über dem Fluss.');
});

test('leere und fehlende Listen bleiben unangetastet', () => {
  assert.deepEqual(verifyZitate([], TEXT), { kept: [], dropped: [] });
  assert.deepEqual(verifyZitate(undefined, TEXT).kept, []);
  // Ohne Heuhaufen (leerer Text) wird NICHT alles verworfen – lieber die
  // ungeprüfte Liste als ein stiller Totalverlust wegen eines Bugs weiter oben.
  const list = [{ zitat: 'X' }];
  assert.deepEqual(verifyZitate(list, '').kept, list);
});

test('applyQuoteVerification schreibt in-place und meldet die Zahl', () => {
  const review = {
    gesamtnote: 4.5,
    beispielzitate: [
      { zitat: 'Der Nebel lag über dem Fluss.' },
      { zitat: 'Frei erfunden.' },
    ],
  };
  assert.equal(applyQuoteVerification(review, TEXT), 1);
  assert.equal(review.beispielzitate.length, 1);
  // Anderes Feld (Kapitelanalyse) ebenso.
  const ca = { zitate: [{ zitat: 'Frei erfunden.' }] };
  assert.equal(applyQuoteVerification(ca, TEXT, 'zitate'), 1);
  assert.equal(ca.zitate.length, 0);
  // Kein Zitatfeld → kein Absturz.
  assert.equal(applyQuoteVerification({}, TEXT), 0);
  assert.equal(applyQuoteVerification(null, TEXT), 0);
});

test('belegHaystack sammelt die Zitate der Teil-Analysen', () => {
  const analyses = [
    { zitate: [{ zitat: 'Erstes Zitat.' }, { zitat: 'Zweites Zitat.' }] },
    { zitate: [] },
    {},
  ];
  const hay = belegHaystack(analyses);
  assert.ok(quoteFoundIn('Erstes Zitat.', norm(hay)));
  assert.ok(quoteFoundIn('Zweites Zitat.', norm(hay)));
  // Im Multi-Pass darf die Synthese NUR aus diesen Zitaten zitieren.
  assert.ok(!quoteFoundIn('Der Nebel lag über dem Fluss.', norm(hay)));
});
