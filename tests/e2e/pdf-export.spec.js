// E2E-Smoke-Test für pdfExportCard. Lädt das Harness, mockt Backend in
// tests/server.js, klickt durch Profile-CRUD und Tab-Wechsel.
//
// Profil-Management ist jetzt einzeilig (export-shared.css): Auswahl-Combobox +
// Icon-Buttons (neu/standard/löschen). Die Combobox ist im Harness gestubbt
// (nicht interaktiv) — Anlegen läuft über das Name-Feld + Anlegen-Button der
// Create-Zeile, Auswahl/Löschen über die Icon-Buttons; Listenstand wird über
// den Mock-Backend-State (GET /pdf-export/profiles) geprüft.

const { test, expect } = require('./_helpers/fixtures');

// Serial-Mode: alle pdf-export-Tests teilen sich denselben Mock-Server-State
// (pdfProfiles[]). Parallel würden sich Profile-IDs überlappen und CRUD-
// Erwartungen brechen.
test.describe.configure({ mode: 'serial' });

const BASE = 'http://localhost:8765';

test.describe('pdf-export-card', () => {
  test.beforeEach(async ({ page }) => {
    await page.request.post(`${BASE}/__mock/pdf-reset`);
    await page.goto(`${BASE}/tests/fixtures/pdf-export-harness.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__harnessReady === true);
  });

  // Profil-Anlage: "+"-Icon öffnet die Create-Zeile (Name + Anlegen).
  // createProfile() schliesst sie wieder (_showCreate = false) und selektiert
  // das neue Profil → Editor (export-tabs) mountet.
  async function createProfile(page, name) {
    await page.locator('.export-profile-bar button:has(use[href$="#plus"])').click();
    await page.locator('.export-create-row:not(.export-rename-row) .card-form-input').fill(name);
    await page.locator('.export-create-row button.primary', { hasText: 'Anlegen' }).click();
    await expect(page.locator('.export-tabs')).toBeVisible();
  }

  test('Card lädt + Profil-Leiste sichtbar', async ({ page }) => {
    await expect(page.locator('.pdf-export-card')).toBeVisible();
    await expect(page.locator('.pdf-export-card .export-profile-bar')).toBeVisible();
  });

  test('Profil anlegen → Editor mit Tabs sichtbar', async ({ page }) => {
    await createProfile(page, 'Mein Profil');
    await expect(page.locator('.export-tabs .tabs-btn').filter({ hasText: 'Format' })).toBeVisible();
    // Backend kennt das Profil.
    const { profiles } = await page.request.get(`${BASE}/pdf-export/profiles`).then(r => r.json());
    expect(profiles.some(p => p.name === 'Mein Profil')).toBe(true);
  });

  test('Tab-Wechsel zeigt verschiedene Tab-Panels', async ({ page }) => {
    await createProfile(page, 'X');
    const activeTab = page.locator('.export-tabs .tabs-btn--active');
    await expect(activeTab).toHaveText(/Format/);
    await page.locator('.export-tabs .tabs-btn').filter({ hasText: 'Cover' }).click();
    await expect(activeTab).toHaveText(/Cover/);
    await page.locator('.export-tabs .tabs-btn').filter({ hasText: 'Druck' }).click();
    await expect(activeTab).toHaveText(/Druck/);
  });

  test('Apparat-Tab zeigt die Fussnoten-Regler', async ({ page }) => {
    await createProfile(page, 'X');
    await page.locator('.export-tabs .tabs-btn').filter({ hasText: 'Apparat' }).click();
    await expect(page.locator('.export-tabs .tabs-btn--active')).toHaveText(/Apparat/);
    // `.export-tab-panel` gibt es siebenmal im DOM (nur eines ist sichtbar), und
    // „Trennlinie" steht auch in anderen Panels — darum ueber das sichtbare.
    const panel = page.locator('.export-tab-panel:visible');
    await expect(panel).toContainText('Trennlinie');
    await expect(panel).toContainText('Maximale Höhe');
    // Die Laenge der Trennlinie haengt an einem x-show: sie erscheint nur mit
    // aktivierter Linie. Default ist an, also muss das Feld da sein.
    await expect(panel).toContainText('Länge der Linie');
  });

  test('Cover-Tab: Umschlag-Sektion berechnet Live-Rückenbreite', async ({ page }) => {
    await createProfile(page, 'Umschlag');
    await page.locator('.export-tabs .tabs-btn').filter({ hasText: 'Cover' }).click();
    // Collapsible "Separates Umschlag-PDF" öffnen.
    const spine = page.locator('.pdfx-cover-spine');
    await spine.locator('.collapsible-toggle').click();
    await expect(spine.locator('.collapsible-section')).toBeVisible();
    // pageCount + Papiervolumen setzen → Rückenbreite = 200 × 80 / 1000 = 16.0 mm.
    const nums = spine.locator('.pdfx-num-input');
    await nums.nth(0).fill('200');
    await nums.nth(0).press('Tab');
    await nums.nth(1).fill('80');
    await nums.nth(1).press('Tab');
    await expect(spine.locator('.pdfx-spine-width')).toHaveText('16.0 mm');
    // Render-Button ist erst mit beiden Werten aktiv.
    await expect(spine.locator('.pdfx-cover-spine-actions button.primary')).toBeEnabled();
  });

  test('Profil löschen entfernt es aus dem Backend-State', async ({ page }) => {
    page.on('dialog', d => d.accept());
    // Zwei Profile — der Löschen-Button erscheint erst ab >1 Profil.
    await createProfile(page, 'Behalten');
    await createProfile(page, 'Wegwerf');
    let { profiles } = await page.request.get(`${BASE}/pdf-export/profiles`).then(r => r.json());
    expect(profiles.some(p => p.name === 'Wegwerf')).toBe(true);
    // Löschen-Icon (Papierkorb) klicken — löscht das aktive Profil (Wegwerf).
    await page.locator('.export-profile-bar button:has(use[href$="#trash"])').click();
    await expect.poll(async () => {
      const r = await page.request.get(`${BASE}/pdf-export/profiles`).then(r => r.json());
      return r.profiles.some(p => p.name === 'Wegwerf');
    }).toBe(false);
  });
});
