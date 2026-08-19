// TEMP-Repro: EXAKTER User-Flow — Rechtsklick in Sidebar, Menuepunkt "Seite
// loeschen", echtes Confirm-Modal, Buchorganizer offen.
const { test, expect } = require('@playwright/test');
const { bootApp, selectSeededBook } = require('./_helpers/app');

test('echter flow: rechtsklick-delete bei offenem organizer', async ({ page }) => {
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text()); });
  await bootApp(page);
  await selectSeededBook(page);

  // Organizer oeffnen
  await page.evaluate(() => window.__app.toggleBookOrganizerCard());
  await page.waitForTimeout(700);

  const ids = await page.evaluate(() =>
    [...document.querySelectorAll('.card--organizer .organizer-page')].map((li) => li.dataset.pageId));
  const victim = ids[ids.length - 1];
  const victimName = await page.evaluate((id) =>
    window.Alpine.store('nav').pages.find((p) => String(p.id) === String(id))?.name, victim);
  console.log('victim:', victim, victimName);

  // Sidebar-Page-Item finden + Rechtsklick
  const sidebarItem = page.locator(`.page-item[data-page-id="${victim}"]`).first();
  await sidebarItem.waitFor({ state: 'visible', timeout: 5000 });
  await sidebarItem.click({ button: 'right' });
  await page.waitForTimeout(400);

  // Kontextmenue-Eintrag "Seite loeschen" klicken
  const menuBtn = page.locator('.pagetree-context-menu .context-menu-item--danger');
  await menuBtn.waitFor({ state: 'visible', timeout: 3000 });
  await menuBtn.click();
  await page.waitForTimeout(400);

  // Echtes Confirm-Modal bestaetigen (danger-Button)
  const confirmBtn = page.locator('#app-confirm-dialog .confirm-dialog-btn--danger');
  await confirmBtn.waitFor({ state: 'visible', timeout: 3000 });
  await confirmBtn.click();
  await page.waitForTimeout(1800);

  const after = await page.evaluate((id) => {
    const nav = window.Alpine.store('nav');
    return {
      navPages: nav.pages.map((p) => String(p.id)),
      organizerRows: [...document.querySelectorAll('.card--organizer .organizer-page')].map((li) => li.dataset.pageId),
      workTree: (() => {
        const el = document.querySelector('.card--organizer');
        const d = el?._x_dataStack?.[0];
        return d ? JSON.stringify(d.workTree.map((c) => ({ id: c.id, pages: c.pages.map((p) => p.id) }))) : 'n/a';
      })(),
    };
  }, victim);
  console.log('nav:', JSON.stringify(after.navPages));
  console.log('organizerRows:', JSON.stringify(after.organizerRows));
  console.log('workTree:', after.workTree);

  expect(after.navPages.includes(String(victim)), 'nav ohne geloeschte Seite').toBe(false);
  expect(after.organizerRows.includes(String(victim)), 'organizer ohne geloeschte Seite').toBe(false);
});
