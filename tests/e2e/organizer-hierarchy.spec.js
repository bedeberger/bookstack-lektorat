const { test, expect } = require('./_helpers/fixtures');

// Der Buchorganizer rendert drei Kapitel-Tiefen aus EINEM Fragment-Include
// (`organizer-chapter-body`), das auf jeder Tiefe denselben x-for-Alias `ch`
// benutzt. Diese Spec faehrt das echte Partial inkl. Include-Auflösung gegen
// die echte Alpine-Runtime — Slim-Kopien wie in anderen Harnesses wuerden genau
// den kritischen Teil (Alias-Shadowing + Include-Expansion) nicht abdecken.
const URL = 'http://localhost:8765/tests/fixtures/organizer-harness.html';

async function open(page) {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.Alpine && window.harnessReady);
}

test('alle drei Kapitel-Tiefen rendern mit korrekter Verschachtelung', async ({ page }) => {
  await open(page);

  // Je eine Chapter-Liste pro Tiefe, mit dem passenden Drop-Target-Marker.
  await expect(page.locator('[data-organizer="chapter-list"][data-organizer-depth="1"]')).toHaveCount(1);
  await expect(page.locator('[data-organizer="chapter-list"][data-organizer-depth="2"]')).toHaveCount(1);
  await expect(page.locator('[data-organizer="chapter-list"][data-organizer-depth="3"]')).toHaveCount(1);

  // Alle vier Kapitel da, jedes genau einmal (kein Include-Doppel-Render).
  for (const id of [1, 11, 111, 2]) {
    await expect(page.locator(`.organizer-chapter[data-chapter-id="${id}"]`)).toHaveCount(1);
  }

  // Verschachtelung: 111 liegt unter 11, 11 unter 1, 2 nicht unter 1.
  const nested = await page.evaluate(() => {
    const at = (id) => document.querySelector(`.organizer-chapter[data-chapter-id="${id}"]`);
    return {
      deepInMid: at('11').contains(at('111')),
      midInTop: at('1').contains(at('11')),
      siblingSeparate: !at('1').contains(at('2')),
    };
  });
  expect(nested).toEqual({ deepInMid: true, midInTop: true, siblingSeparate: true });

  // Depth-Klasse + CSS-Custom-Prop pro Ebene aus ch.depth (nicht aus Markup).
  await expect(page.locator('.organizer-chapter[data-chapter-id="1"]')).toHaveClass(/organizer-chapter--depth-1/);
  await expect(page.locator('.organizer-chapter[data-chapter-id="11"]')).toHaveClass(/organizer-chapter--depth-2/);
  await expect(page.locator('.organizer-chapter[data-chapter-id="111"]')).toHaveClass(/organizer-chapter--depth-3/);
});

test('Alias-Shadowing: jede Tiefe zeigt ihren eigenen Kapitelnamen', async ({ page }) => {
  await open(page);
  // Der Include liest `ch.name` — ohne korrektes Shadowing wuerde Level 2/3 den
  // Namen des Eltern-Kapitels anzeigen (oder „ch is not defined" werfen).
  const nameIn = (id) => page.locator(`.organizer-chapter[data-chapter-id="${id}"] > .organizer-chapter-header input.organizer-name--chapter`);
  await expect(nameIn(1)).toHaveValue('Kapitel Eins');
  await expect(nameIn(11)).toHaveValue('Unter Eins');
  await expect(nameIn(111)).toHaveValue('Tief Eins');
  await expect(nameIn(2)).toHaveValue('Kapitel Zwei');
});

test('Seitenlisten haengen an der richtigen Tiefe', async ({ page }) => {
  await open(page);
  const pagesOf = (chapId) => page.locator(`ul.organizer-pages[data-chapter-id="${chapId}"] .organizer-page`);
  await expect(pagesOf(0)).toHaveCount(1);   // Solo-Liste
  await expect(pagesOf(1)).toHaveCount(1);
  await expect(pagesOf(11)).toHaveCount(1);
  await expect(pagesOf(111)).toHaveCount(1);

  await expect(page.locator('ul.organizer-pages[data-chapter-id="111"] input.organizer-name'))
    .toHaveValue('L3-Seite');
  // Page-Row-Include liefert auf jeder Tiefe Handle + Aktions-Spalte.
  await expect(page.locator('[data-page-id="921"] .organizer-drag-handle')).toHaveCount(1);
  await expect(page.locator('[data-page-id="921"] .organizer-delete-btn')).toHaveCount(1);
});

test('Struktur-Buttons sind pro Tiefe korrekt gegated', async ({ page }) => {
  await open(page);
  const btn = (chapId, sel) => page.locator(`.organizer-chapter[data-chapter-id="${chapId}"] > .organizer-chapter-header ${sel}`);

  // Sub-Kapitel anlegen: auf Tiefe 3 gesperrt (maxChapterDepth erreicht).
  await expect(btn(1, '.organizer-chapter-actions button >> nth=1')).toBeEnabled();
  await expect(btn(111, '.organizer-chapter-actions button >> nth=1')).toBeDisabled();

  // canPromote/canDemote kommen aus dem Workstate, nicht aus dem Markup.
  const flags = await page.evaluate(() => ({
    promoteTop: window.__card.canPromoteChapter(1),
    promoteDeep: window.__card.canPromoteChapter(111),
    demoteFirst: window.__card.canDemoteChapter(1),
    demoteSecond: window.__card.canDemoteChapter(2),
  }));
  expect(flags).toEqual({
    promoteTop: false, promoteDeep: true, demoteFirst: false, demoteSecond: true,
  });
});

test('Collapse blendet Sub-Baum und Seitenliste aus', async ({ page }) => {
  await open(page);
  await expect(page.locator('.organizer-chapter[data-chapter-id="11"]')).toBeVisible();
  await page.locator('.organizer-chapter[data-chapter-id="1"] > .organizer-chapter-header .organizer-chapter-toggle').click();
  // Level 2 haengt am x-if des Parents → verschwindet komplett aus dem DOM.
  await expect(page.locator('.organizer-chapter[data-chapter-id="11"]')).toHaveCount(0);
  await expect(page.locator('ul.organizer-pages[data-chapter-id="1"]')).toHaveCount(0);
});

test('Suche zeigt Treffer in der Tiefe samt Eltern-Kette', async ({ page }) => {
  await open(page);
  await page.locator('input.page-search').fill('L3-Seite');
  // Kapitel-Kette 1 → 11 → 111 bleibt sichtbar, Geschwister-Kapitel fliegt raus.
  await expect(page.locator('.organizer-chapter[data-chapter-id="111"]')).toHaveCount(1);
  await expect(page.locator('.organizer-chapter[data-chapter-id="11"]')).toHaveCount(1);
  await expect(page.locator('.organizer-chapter[data-chapter-id="1"]')).toHaveCount(1);
  await expect(page.locator('.organizer-chapter[data-chapter-id="2"]')).toHaveCount(0);
  await expect(page.locator('[data-page-id="921"]')).toHaveCount(1);
  await expect(page.locator('[data-page-id="901"]')).toHaveCount(0);
});
