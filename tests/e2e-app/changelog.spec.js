// Neuigkeiten (Release-Notizen) gegen die echte App — der Ablauf, den ein User
// nach einem Release durchlaeuft: Punkt am „?"-Knopf → Hilfe oeffnet direkt auf
// dem Reiter „Neuigkeiten" → Punkt ist weg und bleibt es ueber den Reload.
//
// Warum hier und nicht im Fixture-Harness: die Kette laeuft ueber /config
// (changelogLatest/changelogSeen), die Karte, POST /changelog/seen und die
// app_users-Spalte. Ein gemountetes Karten-Harness mit Mock-Daten wuerde genau
// die Naht nicht pruefen, an der das Ganze haengt — dass der quittierte Stand
// den naechsten Boot ueberlebt.
//
// Der Seed-User ist frisch (`changelog_seen_version IS NULL`), der Punkt steht
// also am Anfang jedes Laufs.

const { test, expect } = require('@playwright/test');
const { attachConsoleGuard } = require('../e2e/_helpers/console-guard');
const { bootApp, reboot } = require('./_helpers/app');

test.describe.configure({ mode: 'serial' });

test('GET /changelog liefert Releases mit beiden Sprachen', async ({ page }) => {
  await bootApp(page);
  const data = await page.evaluate(async () => (await fetch('/changelog', { credentials: 'same-origin' })).json());

  expect(data.releases.length).toBeGreaterThan(0);
  expect(data.latest).toBe(data.releases[0].version);
  for (const rel of data.releases) {
    expect(rel.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(rel.entries.length).toBeGreaterThan(0);
    for (const e of rel.entries) {
      expect(['neu', 'verbessert', 'behoben']).toContain(e.kind);
      expect(e.de.trim()).not.toBe('');
      expect(e.en.trim()).not.toBe('');
    }
  }
});

test('ungelesene Notizen setzen den Punkt am Hilfe-Knopf', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);

  // Vorbedingung: der Seed-User hat noch nichts quittiert.
  const unread = await page.evaluate(() => window.__app.hasUnreadChangelog(window.Alpine.store('shell')));
  expect(unread).toBe(true);

  await expect(page.locator('.header-help-btn')).toHaveClass(/icon-btn--attention/);
  guard.assertClean('Boot mit ungelesenen Notizen');
});

test('Hilfe oeffnet auf „Neuigkeiten", quittiert und der Stand ueberlebt den Reload', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);

  const latest = await page.evaluate(() => window.Alpine.store('shell').changelogLatest);
  expect(latest).toMatch(/^\d+\.\d+\.\d+$/);

  await page.locator('.header-help-btn').click();
  await expect(page.locator('.card--help')).toBeVisible();

  // Wer einen Punkt sieht, landet direkt bei den Neuigkeiten — nicht im
  // Funktionsueberblick, den er schon kennt.
  const changelogPanel = page.locator('.help-tab-panel').nth(1);
  await expect(changelogPanel).toBeVisible();
  await expect(changelogPanel.locator('.changelog-release').first()).toBeVisible();
  await expect(changelogPanel.locator('.changelog-version').first()).toHaveText(`v${latest}`);
  // Eintraege tragen Art-Marke + Text; die Marke ist uebersetzt, nicht der Rohkey.
  const firstKind = changelogPanel.locator('.changelog-kind').first();
  await expect(firstKind).toBeVisible();
  await expect(firstKind).not.toHaveText(/^changelog\.kind\./);

  // Quittung: Punkt verschwindet sofort …
  await expect(page.locator('.header-help-btn')).not.toHaveClass(/icon-btn--attention/);
  await expect.poll(async () => page.evaluate(async () =>
    (await (await fetch('/config', { credentials: 'same-origin' })).json()).changelogSeen,
  )).toBe(latest);

  // … und kommt nach dem Reload nicht wieder (Server ist die Wahrheit).
  // `reboot` statt `reload()` + `bootApp()`: die zwei Navigationen hintereinander
  // brechen die noch laufenden Fetches des Reloads ab (i18n → console.error).
  await reboot(page);
  expect(await page.evaluate(() => window.__app.hasUnreadChangelog(window.Alpine.store('shell')))).toBe(false);
  await expect(page.locator('.header-help-btn')).not.toHaveClass(/icon-btn--attention/);

  guard.assertClean('Neuigkeiten oeffnen + quittieren');
});

test('ohne ungelesene Notizen oeffnet die Hilfe auf „Funktionen"', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  // Vorlauf des vorigen Tests: der Stand ist bereits quittiert (serial).
  expect(await page.evaluate(() => window.__app.hasUnreadChangelog(window.Alpine.store('shell')))).toBe(false);

  await page.locator('.header-help-btn').click();
  await expect(page.locator('.card--help')).toBeVisible();
  await expect(page.locator('.help-tab-panel').first()).toBeVisible();
  await expect(page.locator('.help-features .help-feature').first()).toBeVisible();

  guard.assertClean('Hilfe ohne ungelesene Notizen');
});
