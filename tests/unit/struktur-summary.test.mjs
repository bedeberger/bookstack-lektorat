// Verdichtung der Struktur-Check-Befunde für die Bewertung (lib/struktur-summary.js).
//
// Die Zählerei ist die Stelle, an der sich Fehler verstecken: ein falsch
// aggregierter Befund wird im Prompt zu einer Tatsachenbehauptung, die das
// Modell nicht überprüfen kann.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { summarizeStrukturChecks } = require(path.resolve(__dirname, '..', '..', 'lib', 'struktur-summary.js'));

const PAGES = [
  { id: 1, title: 'Gemeinde streicht Budget' },
  { id: 2, title: 'Porträt der Bäuerin' },
  { id: 3, title: 'Kommentar zum Verkehr' },
  { id: 4, name: 'Noch ungeprüft' },   // Seiten liefern mal `title`, mal `name`
];

const check = (page_id, textsorte, gesamturteil, regeln = [], fehlendeWFragen = []) => ({
  page_id, textsorte, gesamturteil, result: { regeln, fehlendeWFragen },
});

const CHECKS = [
  check(1, 'bericht', 'verfehlt', [
    { nr: 3, status: 'fehlt', befund: 'Zahlen ohne Quelle.' },
    { nr: 1, status: 'teilweise', befund: 'Lead nennt kein Datum.' },
    { nr: 2, status: 'erfuellt', befund: 'Aufbau stimmt.' },
  ], ['wann', 'warum']),
  check(2, 'portraet', 'traegt', [{ nr: 1, status: 'erfuellt', befund: 'ok' }]),
  check(3, 'kommentar', 'lueckenhaft', [
    { nr: 3, status: 'fehlt', befund: 'Gegenargument fehlt.' },
  ], ['warum']),
];

test('leere Datenlage → null (Prompt-Block entfällt ganz)', () => {
  assert.equal(summarizeStrukturChecks([], PAGES), null);
  assert.equal(summarizeStrukturChecks(null, PAGES), null);
  assert.equal(summarizeStrukturChecks(CHECKS, []), null);
});

test('Befunde ausserhalb des Scopes zählen nicht mit', () => {
  // Kapitel-Scope: nur Seite 3 gehört dazu, die anderen Befunde sind fremd.
  const s = summarizeStrukturChecks(CHECKS, [{ id: 3, title: 'Kommentar zum Verkehr' }], { scope: 'chapter' });
  assert.equal(s.geprueft, 1);
  assert.equal(s.gesamt, 1);
  assert.deepEqual(s.urteile, { traegt: 0, lueckenhaft: 1, verfehlt: 0 });
});

test('geprueft vs. gesamt: die ungeprüfte Seite bleibt sichtbar', () => {
  const s = summarizeStrukturChecks(CHECKS, PAGES);
  assert.equal(s.geprueft, 3);
  assert.equal(s.gesamt, 4);   // damit der Prompt «3 von 4» sagen kann
});

test('Urteile und Textsorten werden korrekt gezählt', () => {
  const s = summarizeStrukturChecks(CHECKS, PAGES);
  assert.deepEqual(s.urteile, { traegt: 1, lueckenhaft: 1, verfehlt: 1 });
  const bericht = s.proTextsorte.find(t => t.textsorte === 'bericht');
  assert.deepEqual(bericht, { textsorte: 'bericht', anzahl: 1, traegt: 0, lueckenhaft: 0, verfehlt: 1 });
  assert.equal(s.proTextsorte.length, 3);
});

test('Lücken werden pro (Textsorte, Regel) gezählt — nicht regelnummernweise vermischt', () => {
  const s = summarizeStrukturChecks(CHECKS, PAGES);
  const berichtR3 = s.luecken.find(l => l.textsorte === 'bericht' && l.nr === 3);
  const kommentarR3 = s.luecken.find(l => l.textsorte === 'kommentar' && l.nr === 3);
  // Regel 3 bedeutet in jeder Textsorte etwas anderes — zwei Einträge, nicht einer.
  assert.equal(berichtR3.fehlt, 1);
  assert.equal(kommentarR3.fehlt, 1);
  assert.equal(s.luecken.find(l => l.nr === 1 && l.textsorte === 'bericht').teilweise, 1);
  // `erfuellt` ist keine Lücke.
  assert.ok(!s.luecken.some(l => l.textsorte === 'bericht' && l.nr === 2));
});

test('W-Fragen werden über alle Beiträge summiert und sortiert', () => {
  const s = summarizeStrukturChecks(CHECKS, PAGES);
  assert.deepEqual(s.wFragen, [{ frage: 'warum', anzahl: 2 }, { frage: 'wann', anzahl: 1 }]);
});

test('auffällige Beiträge: schlimmste zuerst, mängelfreie «traegt» fallen raus', () => {
  const s = summarizeStrukturChecks(CHECKS, PAGES);
  assert.equal(s.seiten.length, 2);
  assert.equal(s.seiten[0].urteil, 'verfehlt');
  assert.equal(s.seiten[0].titel, 'Gemeinde streicht Budget');
  assert.equal(s.seiten[1].urteil, 'lueckenhaft');
  // Das saubere Porträt trägt keine Information für die Bewertung.
  assert.ok(!s.seiten.some(x => x.titel === 'Porträt der Bäuerin'));
});

test('Deckel wird ausgewiesen statt still zu kürzen', () => {
  const viele = Array.from({ length: 30 }, (_, i) =>
    check(i + 1, 'bericht', 'verfehlt', [{ nr: 1, status: 'fehlt', befund: 'x' }]));
  const pages = viele.map((_, i) => ({ id: i + 1, title: `S${i + 1}` }));
  const buch = summarizeStrukturChecks(viele, pages, { scope: 'book' });
  assert.equal(buch.seiten.length, 12);
  assert.equal(buch.seitenGekuerzt, 18);
  // Kapitel-Scope zeigt mehr: dort ist die Einzelauflösung das Nützliche.
  const kap = summarizeStrukturChecks(viele, pages, { scope: 'chapter' });
  assert.equal(kap.seiten.length, 20);
  assert.equal(kap.seitenGekuerzt, 10);
});

test('kaputte Einzelbefunde kippen die Aggregation nicht', () => {
  const s = summarizeStrukturChecks([
    ...CHECKS,
    { page_id: 2, textsorte: null, gesamturteil: 'quatsch', result: { regeln: null, fehlendeWFragen: ['wieso'] } },
    { page_id: 999, textsorte: 'bericht', gesamturteil: 'traegt', result: {} },   // ausserhalb
    null,
    { page_id: 1, textsorte: 'bericht', gesamturteil: 'traegt', result: null },   // ohne Ergebnis
  ], PAGES);
  assert.equal(s.geprueft, 4);                    // die drei echten + der Kaputte im Scope
  assert.deepEqual(s.urteile, { traegt: 1, lueckenhaft: 1, verfehlt: 1 });   // 'quatsch' zählt nicht
  assert.ok(!s.wFragen.some(w => w.frage === 'wieso'));                       // kein W-Fragen-Key
});
