// Plot-Werkstatt: die beiden teleportierten Popover der Karte muessen im
// Teilbaum der KARTE haengen, nicht am <body>.
//
// Why: `togglePlotFullscreen` schickt `.card--plot` ins Native-Vollbild. Dort
// rendert nur der Teilbaum des Fullscreen-Elements ueber dem ::backdrop — ein
// nach <body> teleportiertes Popover liegt dahinter und ist unsichtbar (der User
// klickt aufs Anker-Badge und es passiert scheinbar nichts). Das ist reine
// DOM-Struktur des echten Template-Baums, darum diese Schicht und kein Harness.
//
// Geprueft wird die Verankerung, nicht die Sichtbarkeit: die Knoten existieren
// dauerhaft (x-show + x-cloak), Inhalt braucht Fundstellen bzw. Straenge.
const { test, expect } = require('@playwright/test');
const { bootApp, selectSeededBook } = require('./_helpers/app');

test('plot: teleportierte Popover haengen in der Karte (Vollbild-Top-Layer)', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);

  await page.evaluate(() => window.__app.togglePlotCard());
  await page.waitForSelector('.card--plot');
  // Anchor-Popover-Partial wird via _loadPartials-Cascade nachgeladen.
  await page.waitForSelector('.plot-occ-popover', { state: 'attached' });

  const anchored = await page.evaluate(() => {
    const card = document.querySelector('.card--plot');
    const occ = document.querySelector('.plot-occ-popover');
    const thread = document.querySelector('.context-menu[x-ref="threadMenu"]');
    return {
      occInCard: !!(card && occ && card.contains(occ)),
      occAtBody: !!(occ && occ.parentElement === document.body),
      threadFound: !!thread,
      threadInCard: !!(card && thread && card.contains(thread)),
      threadAtBody: !!(thread && thread.parentElement === document.body),
    };
  });

  expect(anchored.occInCard).toBe(true);
  expect(anchored.occAtBody).toBe(false);
  // Strang-Menue lebt im Grid-Board-Partial (x-show, also immer im DOM).
  expect(anchored.threadFound).toBe(true);
  expect(anchored.threadInCard).toBe(true);
  expect(anchored.threadAtBody).toBe(false);
});
