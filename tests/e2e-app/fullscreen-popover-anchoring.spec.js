// Karten mit Native-Vollbild: ihre teleportierten Popover muessen im Teilbaum
// der KARTE haengen, nicht am <body>.
//
// Why: `toggleWrapFullscreen` schickt die Karten-Wurzel ins Native-Vollbild. Dort
// rendert nur der Teilbaum des Fullscreen-Elements ueber dem ::backdrop — ein
// nach <body> teleportiertes Popover liegt dahinter und ist unsichtbar (der User
// klickt und es passiert scheinbar nichts). Das ist reine DOM-Struktur des echten
// Template-Baums, darum diese Schicht und kein Harness.
//
// Geprueft wird die Verankerung, nicht die Sichtbarkeit: die Knoten existieren
// dauerhaft (x-show + x-cloak), ihr Inhalt braucht Fundstellen/Straenge/Graph.
const { test, expect } = require('@playwright/test');
const { bootApp, selectSeededBook } = require('./_helpers/app');

// Pro Karte: Toggle, Karten-Selektor und die darin erwarteten Popover.
const CARDS = [
  {
    label: 'plot',
    toggle: 'togglePlotCard',
    card: '.card--plot',
    popovers: [
      '.plot-occ-popover',                      // Anchor-Fundstellen (plot-anchor-popover.html)
      '.context-menu[x-ref="threadMenu"]',      // Strang-Aktionen (plot-board-grid.html)
    ],
  },
  {
    label: 'motiv',
    toggle: 'toggleMotivCard',
    card: '.card--motiv',
    popovers: [
      '.context-menu[x-ref="graphMenu"]',       // Graph-Kontextmenue (motiv-graph-menu.html)
    ],
  },
];

for (const c of CARDS) {
  test(`${c.label}: teleportierte Popover haengen in der Karte (Vollbild-Top-Layer)`, async ({ page }) => {
    await bootApp(page);
    await selectSeededBook(page);

    await page.evaluate((toggle) => window.__app[toggle](), c.toggle);
    await page.waitForSelector(c.card);
    // Popover-Markup kommt via _loadPartials-Cascade bzw. Fragment-Include nach.
    for (const sel of c.popovers) await page.waitForSelector(sel, { state: 'attached' });

    const anchored = await page.evaluate(({ card, popovers }) => {
      const cardEl = document.querySelector(card);
      return popovers.map((sel) => {
        const el = document.querySelector(sel);
        return { sel, inCard: !!(cardEl && el && cardEl.contains(el)), atBody: el?.parentElement === document.body };
      });
    }, c);

    expect(anchored.length).toBe(c.popovers.length);
    for (const a of anchored) {
      expect(a.inCard, `${a.sel} liegt im Karten-Teilbaum`).toBe(true);
      expect(a.atBody, `${a.sel} haengt nicht am <body>`).toBe(false);
    }
  });
}
