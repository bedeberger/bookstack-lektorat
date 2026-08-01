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

// Global lebende Schwebe-Elemente koennen kein statisches Teleport-Ziel haben und
// werden zur Anzeigezeit umgehaengt (fullscreen.js#mountInTopLayer). Hier gegen die
// Plot-Karte im echten Native-Vollbild geprueft.
test('Vollbild: Tooltip und Palette erreichen den Top-Layer', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(() => window.__app.togglePlotCard());
  const trigger = '.card--plot .card-header-aside .icon-btn[data-tip]';
  await page.waitForSelector(trigger);
  // cardFadeIn abwarten: waehrend der Animation steht ein Transform auf der Karte
  // und macht sie zum Containing-Block fuer position:fixed.
  await page.waitForTimeout(1000);

  await page.evaluate(() => document.querySelector('.card--plot').requestFullscreen());
  await page.waitForFunction(() => document.fullscreenElement?.classList.contains('card--plot'));

  // ── Tooltip: Pixel-Nachweis. `.tip-layer` hat `pointer-events: none`, ein
  // Hit-Test taugt also nicht — stattdessen denselben Bildausschnitt mit und ohne
  // Tooltip vergleichen. Am <body> haengend lag er hinter dem ::backdrop: gleiche
  // Pixel, Test rot.
  await page.hover(trigger);
  await page.waitForFunction(() => document.querySelector('.tip-layer')?.classList.contains('tip-visible'));
  const tip = await page.evaluate(() => {
    const l = document.querySelector('.tip-layer');
    const r = l.getBoundingClientRect();
    return { inCard: document.querySelector('.card--plot').contains(l),
             clip: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } };
  });
  expect(tip.inCard, 'Tooltip-Layer liegt im Vollbild-Teilbaum').toBe(true);
  expect(tip.clip.width, 'Tooltip hat eine messbare Flaeche').toBeGreaterThan(20);
  const withTip = await page.screenshot({ clip: tip.clip });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('tooltip:hide')));
  await page.waitForTimeout(250); // opacity-Transition (0.08s) auslaufen lassen
  const withoutTip = await page.screenshot({ clip: tip.clip });
  expect(withTip.equals(withoutTip), 'Tooltip ist im Vollbild sichtbar (Pixel unterscheiden sich)').toBe(false);

  // ── Palette: hat pointer-events, also echter Hit-Test. Ausserdem muss sie im
  // Vollbild-Teilbaum haengen und das Vollbild darf NICHT beendet worden sein.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('palette:open')));
  await page.waitForFunction(() => {
    const o = document.querySelector('.palette-overlay');
    return o && getComputedStyle(o).display !== 'none';
  });
  const pal = await page.evaluate(() => {
    const o = document.querySelector('.palette-overlay');
    const r = o.getBoundingClientRect();
    const hit = document.elementFromPoint(window.innerWidth / 2, r.top + r.height * 0.2);
    return { inCard: document.querySelector('.card--plot').contains(o),
             hitInOverlay: !!(hit && o.contains(hit)),
             stillFullscreen: !!document.fullscreenElement };
  });
  expect(pal.inCard, 'Palette-Overlay liegt im Vollbild-Teilbaum').toBe(true);
  expect(pal.hitInOverlay, 'Palette ist im Vollbild anklickbar').toBe(true);
  expect(pal.stillFullscreen, 'Palette beendet das Vollbild nicht').toBe(true);
});
