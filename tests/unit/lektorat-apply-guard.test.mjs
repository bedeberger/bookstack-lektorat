// Regression: die Skip-Meldung des Lektorat-Apply muss den WAHREN Grund nennen.
//
// `_applyCorrections` (public/js/editor/lektorat.js) sammelt jede Korrektur, die
// replaceInHtml unangetastet liess, in `outSkipped` — und zwar aus vier sehr
// verschiedenen Gründen:
//
//   'notFound'    — der Textbezug ist veraltet: die Stelle wurde inzwischen
//                   umgeschrieben oder gelöscht (typisch, wenn während der
//                   Analyse von einem Zweitgerät geschrieben wurde). KEINE
//                   Nachkontrolle nötig, es gibt nichts mehr zu prüfen.
//   'spansLink'   — Schutzmechanismus: die Ersetzung hätte ein `href` verworfen.
//   'spansMarker' — Schutzmechanismus: die Ersetzung hätte den Zeiger einer
//                   Quellenangabe (`data-src`) oder eines Querverweises
//                   (`data-xref-id`) verworfen und toten Klartext hinterlassen.
//   'boundary'    — Schutzmechanismus: die Ersetzung hätte eine Block-Grenze
//                   bzw. einen `<br>` gekreuzt.
//
// Die Unterscheidung lebt in `skipReason` (utils/html-find.js) und wird hier
// direkt getestet — im Gegensatz zum Chat-Pendant braucht es keinen Mirror, die
// Funktion ist pure und in Node importierbar. Die `_applyCorrections`-Schleife
// selbst ist als 1:1-Mirror nachgebaut (die echte Alpine-Methode scheitert in
// Node an Browser-Deps).

import test from 'node:test';
import assert from 'node:assert/strict';
import { replaceInHtml, skipReason } from '../../public/js/utils.js';

// 1:1-Mirror von lektoratMethods._applyCorrections MIT outSkipped-Zweig.
// Wichtig: `skipReason` wird gegen `result` ausgewertet — den sequenziell
// mitwandernden Stand, nicht gegen das Eingangs-HTML.
function applyCorrections(html, fehler) {
  const skipped = [];
  let result = html;
  for (const f of fehler) {
    if (!f.original || !f.korrektur || f.original === f.korrektur) continue;
    const next = replaceInHtml(result, f.original, f.korrektur);
    if (next === result) {
      skipped.push({ f, reason: skipReason(result, f.original) });
      continue;
    }
    result = next;
  }
  return { html: result, skipped };
}

// Mirror von lektoratMethods._skipSummary: feste Reihenfolge, damit dieselbe
// Ursache immer dieselbe Meldung ergibt.
function skipOrder(skipped) {
  const counts = {};
  for (const s of skipped) counts[s.reason] = (counts[s.reason] || 0) + 1;
  return ['notFound', 'spansLink', 'spansMarker', 'boundary'].filter(k => counts[k] > 0);
}

// ── skipReason: die vier Gründe ──────────────────────────────────────────────

test('skipReason: fehlender Text -> notFound (kein Schutzmechanismus)', () => {
  const html = '<p>Der Hund bellt.</p>';
  assert.equal(skipReason(html, 'die Katze miaut'), 'notFound');
});

test('skipReason: umschlossener Link -> spansLink', () => {
  const html = '<p>Siehe <a href="https://example.org">die Quelle</a> dazu.</p>';
  assert.equal(skipReason(html, 'Siehe die Quelle dazu.'), 'spansLink');
});

test('skipReason: umschlossene Quellenangabe -> spansMarker', () => {
  const html = '<p>Das ist belegt <span class="cite" data-src="7" data-loc="44">(Müller, 2020, S. 44)</span> und gilt.</p>';
  assert.equal(skipReason(html, 'Das ist belegt (Müller, 2020, S. 44) und gilt.'), 'spansMarker');
});

test('skipReason: umschlossener Querverweis -> spansMarker', () => {
  const html = '<p>Siehe <span class="xref" data-xref="chapter" data-xref-id="42">Kapitel 3</span> dazu näher.</p>';
  assert.equal(skipReason(html, 'Siehe Kapitel 3 dazu näher.'), 'spansMarker');
});

test('skipReason: Absatzgrenze -> boundary', () => {
  const html = '<p>Er ging nach Hause.</p><p>Dann schlief er ein.</p>';
  assert.equal(skipReason(html, 'nach Hause. Dann'), 'boundary');
});

test('skipReason: Listen-Grenze -> boundary', () => {
  const html = '<ul><li>Erstens.</li><li>Zweitens.</li></ul>';
  assert.equal(skipReason(html, 'Erstens. Zweitens'), 'boundary');
});

test('skipReason: umspannter <br> -> boundary', () => {
  const html = '<p>Rosen sind rot,<br>Veilchen sind blau.</p>';
  assert.equal(skipReason(html, 'rot, Veilchen'), 'boundary');
});

// ── Apply-Pfad: welcher Grund landet in der Meldung ──────────────────────────

test('Veralteter Textbezug wird als notFound gemeldet, nicht als Absatzgrenze', () => {
  // Kern-Bug: die Meldung behauptete pauschal „Link oder Absatzgrenze betroffen
  // – bitte manuell prüfen", obwohl die Stelle einfach nicht mehr existiert
  // (Seite wurde während der Analyse von einem anderen Gerät umgeschrieben).
  const html = '<p>Ein völlig neu geschriebener Absatz.</p>';
  const { html: out, skipped } = applyCorrections(html, [
    { original: 'der alte Satz von vorher', korrektur: 'der neue Satz', typ: 'stil' },
  ]);
  assert.equal(out, html, 'HTML bleibt unverändert');
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, 'notFound');
});

test('Erfolgreiche Korrektur erzeugt keinen Skip', () => {
  const html = '<p>Der Hund bellt laut.</p>';
  const { html: out, skipped } = applyCorrections(html, [
    { original: 'bellt laut', korrektur: 'bellt leise', typ: 'stil' },
  ]);
  assert.ok(out.includes('bellt leise'));
  assert.deepEqual(skipped, []);
});

test('Gemischte Skips: jeder Grund einzeln, in fester Reihenfolge', () => {
  const html = '<p>Er ging nach Hause.</p><p>Dann schlief er ein.</p>'
    + '<p>Siehe <a href="https://example.org">die Quelle</a> dazu.</p>'
    + '<p>Belegt ist <span class="cite" data-src="7">(Müller, 2020)</span> alles.</p>';
  const { skipped } = applyCorrections(html, [
    { original: 'nach Hause. Dann', korrektur: 'heim. Sofort', typ: 'stil' },
    { original: 'Siehe die Quelle dazu.', korrektur: 'Vgl. die Quelle.', typ: 'stil' },
    { original: 'Belegt ist (Müller, 2020) alles.', korrektur: 'Belegt ist (Müller, 2020) vieles.', typ: 'stil' },
    { original: 'existiert hier nicht', korrektur: 'egal', typ: 'stil' },
  ]);
  assert.equal(skipped.length, 4);
  assert.deepEqual(skipOrder(skipped), ['notFound', 'spansLink', 'spansMarker', 'boundary']);
});

test('Quellenangabe ueberlebt den Lektorat-Batch, Nachbar-Korrektur greift', () => {
  // Der praktisch häufigste Fall: das Modell meldet einen echten Fehler im
  // selben Absatz wie ein Beleg. Die Nachbar-Korrektur muss durchgehen, der
  // Zeiger stehen bleiben — sonst kostet jeder Tippfehler neben einem Beleg
  // die Fundstelle.
  const html = '<p>Das ist belegt <span class="cite" data-src="7" data-loc="44">(Müller, 2020, S. 44)</span> und gilt sicherlch.</p>';
  const { html: out, skipped } = applyCorrections(html, [
    { original: 'sicherlch', korrektur: 'sicherlich', typ: 'rechtschreibung' },
  ]);
  assert.deepEqual(skipped, []);
  assert.ok(out.includes('data-src="7"'), 'Zeiger erhalten');
  assert.ok(out.includes('data-loc="44"'), 'Stellenangabe erhalten');
  assert.ok(out.includes('sicherlich'), 'Korrektur angewandt');
});

// ── Nicht-Regression: der Batch-Charakter des Lektorats ──────────────────────

test('Zwei Findings mit identischem original bei zwei Vorkommen: beide angewandt', () => {
  // Warum hier KEIN countInHtml-Mehrdeutigkeits-Guard steht (anders als im
  // Seiten-Chat): das Lektorat wendet einen BATCH an. Derselbe Tippfehler
  // zweimal auf der Seite ergibt zwei Findings mit gleichem `original`;
  // sequenzielles Apply löst das korrekt auf (der erste Aufruf ersetzt das
  // erste Vorkommen, der zweite findet nur noch das zweite). Ein `count > 1`
  // -> skip würde genau diesen legitimen Fall kaputtmachen.
  const html = '<p>Das ist ein Fehlr.</p><p>Und hier noch ein Fehlr.</p>';
  const f = { original: 'Fehlr', korrektur: 'Fehler', typ: 'rechtschreibung' };
  const { html: out, skipped } = applyCorrections(html, [{ ...f }, { ...f }]);
  assert.deepEqual(skipped, [], 'kein Skip — beide Vorkommen sind adressiert');
  assert.equal(out.match(/Fehler/g)?.length, 2);
  assert.ok(!/Fehlr/.test(out), 'kein unkorrigiertes Vorkommen übrig');
});

test('Drittes Finding auf denselben original: notFound (Vorkommen aufgebraucht)', () => {
  // Sequenz-Abhängigkeit explizit: die Klassifizierung läuft gegen den
  // mitwandernden Stand. Nach zwei Ersetzungen ist `original` verschwunden —
  // das dritte Finding ist 'notFound' und nicht 'boundary'.
  const html = '<p>Ein Fehlr.</p><p>Noch ein Fehlr.</p>';
  const f = { original: 'Fehlr', korrektur: 'Fehler', typ: 'rechtschreibung' };
  const { skipped } = applyCorrections(html, [{ ...f }, { ...f }, { ...f }]);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, 'notFound');
});
