// Sprung auf eine Entitaet raeumt IHRE Listen-Filter weg.
//
// Why: `openXxxById` oeffnet die Karte und scrollt auf die Zeile. Steht in der
// Liste noch ein Filter, der das Ziel ausschneidet, wird die Zeile nie gerendert
// — der Klick sieht fuer den User wie ein Aussetzer aus (Karte offen, geklickte
// Figur fehlt). Genau so gemeldet aus der Alterstabelle: Liste nach „fabio"
// gefiltert, Klick auf „reto" tat nichts.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.document = { querySelector: () => null };
globalThis.requestAnimationFrame = () => {};
globalThis.window = globalThis.window || { dispatchEvent: () => {} };

const { appNavigationMethods } = await import('../../public/js/app/app-navigation.js');

function makeCtx() {
  return {
    showFiguresCard: true,
    $store: {
      catalogUi: {
        selectedFigurId: null,
        figurenFilters: { kapitel: 'Kapitel 1', seite: 'S. 3', suche: 'fabio' },
      },
    },
    $nextTick: async () => {},
    _beginNavigation() {},
    _endNavigation() {},
  };
}

test('openFigurById raeumt alle drei Figuren-Filter weg', async () => {
  const ctx = makeCtx();
  await appNavigationMethods.openFigurById.call(ctx, '7');
  assert.equal(ctx.$store.catalogUi.figurenFilters.suche, '');
  assert.equal(ctx.$store.catalogUi.figurenFilters.kapitel, '');
  assert.equal(ctx.$store.catalogUi.figurenFilters.seite, '');
  assert.equal(ctx.$store.catalogUi.selectedFigurId, 7, 'ID auf Number normalisiert');
});

test('openFigurMitKapitel raeumt die Suche weg, setzt aber das Kapitel', async () => {
  const ctx = makeCtx();
  await appNavigationMethods.openFigurMitKapitel.call(ctx, 7, 'Kapitel 9');
  assert.equal(ctx.$store.catalogUi.figurenFilters.suche, '');
  assert.equal(ctx.$store.catalogUi.figurenFilters.kapitel, 'Kapitel 9');
  assert.equal(ctx.$store.catalogUi.figurenFilters.seite, '');
});
