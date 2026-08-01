// Verhaltensguard fuer die zwei Alpine-Plugins, die sichtbares Verhalten fahren
// (`focus`/x-trap und `collapse`/x-collapse) — gegen die ECHTE App, weil beide
// nur im vollen Template-Baum greifen: x-trap sitzt in einem `x-teleport`-Ziel
// (die Palette wird nach <body> bzw. in den Top-Layer gehaengt), und die
// Panel-Hoehe von x-collapse ist erst mit dem echten Shell-CSS messbar.
// Der Smoke-Test prueft nur „oeffnet ohne Konsolenfehler", nicht das Verhalten.
//
// Beide Faelle sind mutationsgeprueft: ohne `x-trap`-Attribut faellt Test 1
// (kein aria-hidden, Fokus verlaesst das Overlay), ohne `x-collapse` im
// panel-Spread faellt Test 2 (Hoehe springt in einem Frame auf den Endwert).
const { test, expect } = require('@playwright/test');
const { bootApp, selectSeededBook } = require('./_helpers/app');

// ── x-trap: Palette ────────────────────────────────────────────────────────
test('Palette: x-trap haelt Tab im Panel, blendet Hintergrund aus, Fokus kehrt zurueck', async ({ page }) => {
  await bootApp(page);

  // Grundlinie: einzelne Body-Kinder (Icon-Sprite, Tooltip-Layer) tragen
  // aria-hidden dauerhaft — nur der Zuwachs beweist den `.inert`-Modifier.
  const countHidden = () => page.evaluate(() => Array.from(document.body.children)
    .filter((el) => !el.classList.contains('palette-overlay')
                    && el.getAttribute('aria-hidden') === 'true').length);
  const hiddenBefore = await countHidden();

  // Rueckkehr-Ziel setzen: der Sidebar-Filter ist vor dem Oeffnen fokussiert.
  await page.locator('.page-search').first().focus();
  await page.evaluate(() => { document.activeElement.dataset.trapReturnProbe = '1'; });

  await page.keyboard.press('Control+k');
  await expect(page.locator('.palette-overlay')).toBeVisible();
  await page.waitForTimeout(150); // x-trap aktiviert 15 ms nach dem Flag

  expect(await countHidden(), 'aria-hidden auf dem Hintergrund').toBeGreaterThan(hiddenBefore);

  // Tab bleibt im Panel UND bewegt weiter die Trefferliste (Palette handelt Tab
  // selbst; der Trap darf ihr den Fokus nicht aus dem Suchfeld ziehen).
  const idxBefore = await page.evaluate(
    () => window.Alpine.$data(document.querySelector('.palette-overlay')).paletteIdx);
  for (let i = 0; i < 4; i++) await page.keyboard.press('Tab');
  const state = await page.evaluate(() => ({
    inside: !!document.activeElement.closest('.palette-overlay'),
    onInput: document.activeElement.classList.contains('palette-input'),
    idx: window.Alpine.$data(document.querySelector('.palette-overlay')).paletteIdx,
  }));
  expect(state.inside, 'Fokus bleibt im Overlay').toBe(true);
  expect(state.onInput, 'Fokus bleibt im Suchfeld').toBe(true);
  expect(state.idx, 'Tab bewegt die Trefferliste weiter').not.toBe(idxBefore);

  // Schliessen: aria-hidden zurueckgenommen, Fokus zurueck auf den Ausloeser.
  await page.keyboard.press('Escape');
  await expect(page.locator('.palette-overlay')).toBeHidden();
  await page.waitForTimeout(150);
  expect(await countHidden(), 'aria-hidden zurueck auf Grundlinie').toBe(hiddenBefore);
  expect(
    await page.evaluate(() => document.activeElement?.dataset?.trapReturnProbe === '1'),
    'Fokus zurueck auf dem Ausloeser',
  ).toBe(true);
});

// ── x-collapse: collapsible-Panel ──────────────────────────────────────────
// Traeger ist die PDF-Export-Karte (Format-Tab: „Raender (mm)") — eine der
// wenigen Karten, deren Klapp-Sektionen ohne Zusatz-Setup sichtbar sind. Der
// Test greift den ersten sichtbaren, geschlossenen Toggle statt einer festen
// Klasse: geprueft wird das Primitiv, nicht diese eine Sektion.
test('collapsible: Panel-Hoehe gleitet statt zu springen', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(() => window.__app.togglePdfExportCard());
  await expect(page.locator('.card--pdfexport .collapsible-toggle').first()).toBeVisible();

  const result = await page.evaluate(() => new Promise((resolve) => {
    const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const toggle = Array.from(document.querySelectorAll('.collapsible-toggle'))
      .find((t) => visible(t) && t.getAttribute('aria-expanded') === 'false');
    if (!toggle) return resolve({ error: 'kein geschlossener Toggle sichtbar' });
    const panel = toggle.nextElementSibling;
    const h = () => panel.getBoundingClientRect().height;
    const closed = h();
    toggle.click();
    const series = [];
    const tick = () => {
      series.push(h());
      if (series.length < 12) requestAnimationFrame(tick);
      else setTimeout(() => resolve({ closed, series, final: h() }), 400);
    };
    requestAnimationFrame(tick);
  }));

  expect(result.error, 'Traeger-Sektion gefunden').toBeUndefined();
  expect(result.closed, 'zu: Hoehe 0').toBe(0);
  expect(result.final, 'offen: Hoehe > 0').toBeGreaterThan(0);
  const intermediate = result.series.filter((v) => v > 0.5 && v < result.final - 0.5);
  expect(
    intermediate.length,
    `Zwischenhoehen (Serie: ${result.series.map(Math.round).join(',')} → ${Math.round(result.final)})`,
  ).toBeGreaterThan(0);
});
