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
    await expect(page.locator('.pdf-export-card .card-status')).toBeVisible();
  });

  test('Profil anlegen → wird Profil-Pill + Editor sichtbar', async ({ page }) => {
    await page.locator('.pdfx-profile-create .pdfx-name-input').fill('Mein Profil');
    await page.locator('.pdfx-profile-create button', { hasText: 'Anlegen' }).click();
    // Pill erscheint
    await expect(page.locator('.pdfx-profile-pill').filter({ hasText: 'Mein Profil' })).toBeVisible();
    // Editor mit Tabs erscheint (Tabs nutzen das DESIGN.md .tabs-Pattern)
    await expect(page.locator('.pdfx-tabs')).toBeVisible();
    await expect(page.locator('.pdfx-tabs .tabs-btn').filter({ hasText: 'Layout' })).toBeVisible();
  });

  test('Tab-Wechsel zeigt verschiedene Tab-Panels', async ({ page }) => {
    await page.locator('.pdfx-profile-create .pdfx-name-input').fill('X');
    await page.locator('.pdfx-profile-create button', { hasText: 'Anlegen' }).click();
    const activeTab = page.locator('.pdfx-tabs .tabs-btn--active');
    await expect(activeTab).toHaveText(/Layout/);
    await page.locator('.pdfx-tabs .tabs-btn').filter({ hasText: 'Cover' }).click();
    await expect(activeTab).toHaveText(/Cover/);
    await page.locator('.pdfx-tabs .tabs-btn').filter({ hasText: 'PDF/A' }).click();
    await expect(activeTab).toHaveText(/PDF\/A/);
  });

  test('Profil löschen entfernt es aus der Liste', async ({ page }) => {
    page.on('dialog', d => d.accept());
    await page.locator('.pdfx-profile-create .pdfx-name-input').fill('Wegwerf');
    await page.locator('.pdfx-profile-create button', { hasText: 'Anlegen' }).click();
    await expect(page.locator('.pdfx-profile-pill').filter({ hasText: 'Wegwerf' })).toBeVisible();
    // Profil-Header > .card-actions > button.danger trägt jetzt das standard
    // Button-Pattern (DESIGN.md). Filter über sichtbaren Text "Löschen".
    await page.locator('button.danger', { hasText: 'Löschen' }).click();
    await expect(page.locator('.pdfx-profile-pill').filter({ hasText: 'Wegwerf' })).toHaveCount(0);
  });
});
