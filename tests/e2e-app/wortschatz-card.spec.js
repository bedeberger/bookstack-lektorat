// Wortschatz-Karte gegen die ECHTE App (playwright.app.config.js).
//
// Warum diese Schicht und nicht ein Fixture-Harness: die drei Ranglisten liegen in
// einem `<template x-if="wortschatzHasResult">` und kommen ueber den String-Include
// (`<!-- @include wortschatz-terms -->`) herein. Beides wird erst mit ECHTEN Daten
// wirklich ausgefuehrt — der Smoke oeffnet die Karte, sieht aber nur den
// Leer-Hinweis, weil es fuer das Seed-Buch noch keine Analyse gibt. Ein Tippfehler
// in einer Expression der Fragmente faende dort niemand.
//
// Der Test loest den Scan ueber die App selbst aus (Knopf → Job → Polling) und
// prueft danach jeden der vier Reiter. Die Wortwolke braucht diese Schicht
// zusaetzlich, weil d3-cloud jedes Wort auf einem Canvas misst.

const { test, expect } = require('@playwright/test');
const { attachConsoleGuard } = require('../e2e/_helpers/console-guard');
const { bootApp, selectSeededBook } = require('./_helpers/app');

test.describe.configure({ mode: 'serial' });

test('Wortschatz: Scan laeuft, alle vier Reiter rendern mit Daten', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);

  await page.evaluate(() => window.__app.toggleWortschatzCard());
  const card = page.locator('.card--wortschatz');
  await expect(card).toBeVisible();

  // Scan anstossen und auf das Ergebnis warten. Der Job ist reine Arithmetik ohne
  // KI-Call — er braucht fuer das Seed-Buch Bruchteile einer Sekunde, das Polling
  // der Karte laeuft im Sekundentakt.
  await card.getByRole('button', { name: /Analysieren|Analyse/i }).click();
  await page.waitForFunction(
    () => !!window.Alpine.$data(document.querySelector('.card--wortschatz')).wortschatzData?.stats,
    null,
    { timeout: 60000 },
  );

  // Reiter 1: Lieblingswoerter. Das Seed-Buch hat keine Vergleichsbuecher desselben
  // Besitzers, also gibt es kein Referenzkorpus — die Keyness-Spalte bleibt
  // ausgeblendet und es kann keine 'key'-Zeile geben. Genau der Zustand, den die
  // Karte aushalten muss (eine Spalte voller „–" waere Rauschen).
  const termRows = card.locator('div[x-show="wortschatzTab === \'terms\'"] tbody tr');
  await expect.poll(() => termRows.count()).toBeGreaterThan(0);

  // Reiter 2: Wendungen.
  await card.getByRole('button', { name: /Wendungen/ }).click();
  const phraseRows = card.locator('div[x-show="wortschatzTab === \'phrases\'"] tbody tr');
  await expect.poll(() => phraseRows.count()).toBeGreaterThan(0);

  // Reiter 3: Einmalwoerter — Wortlaenge als Sortierschluessel, laengstes zuerst.
  await card.getByRole('button', { name: /Einmalwörter/ }).click();
  const hapaxRows = card.locator('div[x-show="wortschatzTab === \'hapax\'"] tbody tr');
  await expect.poll(() => hapaxRows.count()).toBeGreaterThan(0);
  const lengths = await hapaxRows.evaluateAll(
    (rows) => rows.map((r) => r.querySelector('td').textContent.trim().length),
  );
  expect(lengths[0]).toBeGreaterThanOrEqual(lengths[lengths.length - 1]);

  // Reiter 4: Wortwolke. Braucht die echte App, weil d3-cloud jedes Wort auf
  // einem Canvas misst — im Fixture-Harness gaebe es nichts zu messen. Der
  // Keyness-Modus ist hier gesperrt (kein Referenzkorpus, siehe oben) und muss
  // sichtbar bleiben statt zu verschwinden.
  await card.getByRole('button', { name: /^Wolke$/ }).click();
  const words = card.locator('.wortschatz-cloud .wortschatz-cloud-word');
  await expect.poll(() => words.count(), { timeout: 30000 }).toBeGreaterThan(0);
  await expect(card.getByRole('button', { name: /Auffälligkeit/ })).toBeDisabled();

  // Deterministisch: derselbe Datenstand muss dieselbe Anordnung ergeben, sonst
  // sind zwei Scans nicht vergleichbar.
  const first = await words.evaluateAll(
    (els) => els.map((e) => `${e.textContent}@${e.getAttribute('transform')}`),
  );
  await page.evaluate(() => {
    window.Alpine.$data(document.querySelector('.card--wortschatz')).wsBuildCloud();
  });
  await expect.poll(() => words.count(), { timeout: 30000 }).toBe(first.length);
  const second = await words.evaluateAll(
    (els) => els.map((e) => `${e.textContent}@${e.getAttribute('transform')}`),
  );
  expect(second).toEqual(first);

  guard.assertClean('Wortschatz-Karte mit Analyse');
});
