// Sidebar-Σ + Sortier-Indexe des Pagetrees.
//
// Beide Gegenstaende sind Caches, die still veralten koennen: die Σ-Zeile ueber
// `tokEsts` und die drei Order-Maps ueber `nav.tree`/`nav.pages`. Ein falscher
// Wert sieht dort aus wie ein richtiger — es gibt keine Fehlermeldung, nur eine
// Zahl, die nicht mehr zur Liste darunter passt.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { rootGetterDescriptors } from '../../public/js/app/app-root-getters.js';
import { charBadgeLabel } from '../../public/js/utils/format.js';
import { treeBuildMethods } from '../../public/js/book/tree/build.js';

// Minimaler Traeger fuer den Getter — Alpine ist hier nicht im Spiel, der
// Descriptor wird direkt auf ein Plain-Object gelegt.
function makeHost(tokEsts) {
  const host = { tokEsts, _tokTotalsCache: null };
  Object.defineProperties(host, rootGetterDescriptors);
  return host;
}

test('tokTotals summiert Zeichen/Woerter/Tokens und leitet Normseiten ab', () => {
  const host = makeHost({ 1: { chars: 1500, words: 250, tok: 500 }, 2: { chars: 3000, words: 500, tok: 1000 } });
  const t = host.tokTotals;
  assert.equal(t.chars, 4500);
  assert.equal(t.words, 750);
  assert.equal(t.tok, 1500);
  assert.equal(t.normseiten, 3);
  assert.equal(t.any, true);
});

test('tokTotals: leeres tokEsts meldet any=false', () => {
  assert.equal(makeHost({}).tokTotals.any, false);
  assert.equal(makeHost(null).tokTotals.any, false);
});

test('tokTotals cached ueber die Identitaet — gleiche Referenz, gleiches Objekt', () => {
  const ts = { 1: { chars: 100, words: 10, tok: 30 } };
  const host = makeHost(ts);
  assert.equal(host.tokTotals, host.tokTotals, 'zweiter Zugriff muss den Cache treffen');
});

// Der eigentliche Regressionsschutz: ein Index-Assign laesst die Identitaet von
// `tokEsts` stehen. Ein Cache, der NUR die Referenz vergleicht, gaebe danach
// dauerhaft den alten Wert zurueck — im Erstfall mit `any: false`, sodass die
// Σ-Zeile der Sidebar gar nicht erst erscheint.
test('tokTotals veraltet nicht, wenn eine Seite per Index-Assign dazukommt', () => {
  const ts = {};
  const host = makeHost(ts);
  assert.equal(host.tokTotals.any, false);

  ts[7] = { chars: 900, words: 150, tok: 300 }; // In-Place, Identitaet unveraendert
  assert.equal(host.tokTotals.any, true, 'neue Seite muss die Σ-Zeile sichtbar machen');
  assert.equal(host.tokTotals.chars, 900);

  delete ts[7];
  assert.equal(host.tokTotals.any, false, 'Entfernen muss ebenso durchschlagen');
});

test('charBadgeLabel: unter 1000 exakt, darueber gerundet — Einheit kommt von aussen', () => {
  assert.equal(charBadgeLabel(0, 'Z'), '0 Z');
  assert.equal(charBadgeLabel(999, 'Z'), '999 Z');
  assert.equal(charBadgeLabel(1000, 'Z'), '~1k Z');
  assert.equal(charBadgeLabel(13400, 'Z'), '~13k Z');
  assert.equal(charBadgeLabel(13400, 'c'), '~13k c', 'englische Locale bekommt ihre eigene Einheit');
  assert.equal(charBadgeLabel(undefined, 'Z'), '0 Z');
});

// ── Order-Maps ────────────────────────────────────────────────────────────────
// `_pageOrderMap` keyt auf den SEITENNAMEN, `_pageIdOrderMap` auf die ID. Wer
// beim Entfernen nur den ID-Index pflegt, laesst den Namens-Index auf eine tote
// Position zeigen (app/app-ui.js#_pageIdx).
function makeTreeHost() {
  const host = {
    $store: {
      nav: {
        tree: [
          { type: 'chapter', id: 1, name: 'Erstes Kapitel', solo: false },
          { type: 'chapter', id: 2, name: 'Zweites Kapitel', solo: false },
          { type: 'chapter', id: 'solo-9', name: 'Lose Seite', solo: true },
        ],
        pages: [
          { id: 10, name: 'A' },
          { id: 11, name: 'B' },
          { id: 12, name: 'C' },
        ],
      },
    },
  };
  return Object.assign(host, { _rebuildTreeOrderMaps: treeBuildMethods._rebuildTreeOrderMaps });
}

test('_rebuildTreeOrderMaps indiziert Kapitel nach Namen und Seiten nach Name + ID', () => {
  const host = makeTreeHost();
  host._rebuildTreeOrderMaps();
  assert.equal(host._chapterOrderMap.get('Erstes Kapitel'), 0);
  assert.equal(host._chapterOrderMap.get('Zweites Kapitel'), 1);
  assert.equal(host._chapterOrderMap.has('Lose Seite'), false, 'Solo-Wrapper sind keine Kapitel');
  assert.equal(host._pageOrderMap.get('B'), 1);
  assert.equal(host._pageIdOrderMap.get(12), 2);
});

test('_rebuildTreeOrderMaps raeumt beide Seiten-Indexe, wenn eine Seite verschwindet', () => {
  const host = makeTreeHost();
  host._rebuildTreeOrderMaps();
  host.$store.nav.pages.splice(1, 1); // 'B' entfernt
  host._rebuildTreeOrderMaps();
  assert.equal(host._pageIdOrderMap.has(11), false);
  assert.equal(host._pageOrderMap.has('B'), false, 'Namens-Index darf nicht auf die tote Position zeigen');
  assert.equal(host._pageOrderMap.get('C'), 1, 'nachfolgende Seiten ruecken auf');
});

test('_rebuildTreeOrderMaps: bei doppeltem Seitennamen gewinnt das erste Vorkommen', () => {
  const host = makeTreeHost();
  host.$store.nav.pages.push({ id: 13, name: 'A' });
  host._rebuildTreeOrderMaps();
  assert.equal(host._pageOrderMap.get('A'), 0);
});
