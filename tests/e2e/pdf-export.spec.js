// E2E-Smoke-Test für pdfExportCard. Lädt das Harness, mockt Backend in
// tests/server.js, klickt durch Profile-CRUD und Tab-Wechsel.

const { test, expect } = require('@playwright/test');

// Serial-Mode: alle pdf-export-Tests teilen sich denselben Mock-Server-State
// (pdfProfiles[]). Parallel würden sich Profile-IDs überlappen und CRUD-
// Erwartungen brechen.
test.describe.configure({ mode: 'serial' });

test.describe('pdf-export-card', () => {
  test.beforeEach(async ({ page }) => {
    await page.request.post('http://localhost:8765/__mock/pdf-reset');
    await page.goto('http://localhost:8765/tests/fixtures/pdf-export-harness.html');
    await page.waitForFunction(() => window.__harnessReady === true);
  });

  test('Card lädt + Empty-State wird angezeigt', async ({ page }) => {
    await expect(page.locator('.pdf-export-card')).toBeVisible();
    await expect(page.locator('.pdfx-empty')).toBeVisible();
  });

  test('Profil anlegen → wird Profil-Pill + Editor sichtbar', async ({ page }) => {
    await page.locator('.pdfx-input--name').first().fill('Mein Profil');
    await page.locator('.pdfx-btn').filter({ hasText: 'Anlegen' }).click();
    // Pill erscheint
    await expect(page.locator('.pdfx-profile-pill').filter({ hasText: 'Mein Profil' })).toBeVisible();
    // Editor mit Tabs erscheint
    await expect(page.locator('.pdfx-tabs')).toBeVisible();
    await expect(page.locator('.pdfx-tab').filter({ hasText: 'Layout' })).toBeVisible();
  });

  test('Tab-Wechsel zeigt verschiedene Tab-Panels', async ({ page }) => {
    await page.locator('.pdfx-input--name').first().fill('X');
    await page.locator('.pdfx-btn').filter({ hasText: 'Anlegen' }).click();
    await expect(page.locator('.pdfx-tab.is-active')).toHaveText(/Layout/);
    await page.locator('.pdfx-tab').filter({ hasText: 'Cover' }).click();
    await expect(page.locator('.pdfx-tab.is-active')).toHaveText(/Cover/);
    await page.locator('.pdfx-tab').filter({ hasText: 'PDF/A' }).click();
    await expect(page.locator('.pdfx-tab.is-active')).toHaveText(/PDF\/A/);
  });

  test('Profil löschen entfernt es aus der Liste', async ({ page }) => {
    page.on('dialog', d => d.accept());
    await page.locator('.pdfx-input--name').first().fill('Wegwerf');
    await page.locator('.pdfx-btn').filter({ hasText: 'Anlegen' }).click();
    await expect(page.locator('.pdfx-profile-pill').filter({ hasText: 'Wegwerf' })).toBeVisible();
    await page.locator('.pdfx-btn--danger').filter({ hasText: 'Löschen' }).click();
    await expect(page.locator('.pdfx-profile-pill').filter({ hasText: 'Wegwerf' })).toHaveCount(0);
  });
});
