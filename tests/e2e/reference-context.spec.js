const { test, expect } = require('./_helpers/fixtures');

// Kontext-Filter der Referenz-Karte, Scope "Seite" — alle Reiter nach derselben
// Regel: eine Zeile gehoert zur offenen Seite ODER zu deren Kapitel, und die
// Karte sagt, welches von beidem (`refCtx`).
//
// Regression: die Reiter zeigten frueher je nach Tab etwas anderes und liessen
// dabei Zugehoeriges weg — Orte nur bei woertlicher Nennung, Szenen nur an
// genau dieser Seite, Ereignisse nach dem Kapitel-NAMEN (verwechselt gleich-
// benannte Kapitel). Ohne jeden Hinweis, dass da noch etwas ist.
const HARNESS_URL = 'http://localhost:8765/tests/fixtures/reference-context-harness.html';

// Recherche-Fundstuecke kommen per fetch — Verknuepfungen auf Seite 7 (offen),
// Kapitel 3 (deren Kapitel), Seite 8 (Nachbarseite) und Kapitel 4 (fremd).
const RESEARCH = [
  { id: 41, title: 'Direkt', links: [{ target_kind: 'page', target_id: 7 }] },
  { id: 42, title: 'Kapitelweit', links: [{ target_kind: 'chapter', target_id: 3 }] },
  { id: 43, title: 'Nachbarseite', links: [{ target_kind: 'page', target_id: 8 }] },
  { id: 44, title: 'Fremd', links: [{ target_kind: 'chapter', target_id: 4 }] },
];

async function setup(page) {
  await page.route('**/research*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RESEARCH) }));
  await page.route('**/sources*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.Alpine && window.harnessReady);
  // Recherche kommt asynchron — erst warten, dann messen.
  await page.waitForSelector('[data-test="recherche-41"]');
}

const ids = (page, prefix) =>
  page.$$eval(`[data-test^="${prefix}-"]`, els => els.map(e => e.dataset.test));

test('Orte: Kapitel-Kante zaehlt zum Kontext, nicht nur der Namens-Treffer', async ({ page }) => {
  await setup(page);
  expect(await ids(page, 'ort')).toEqual(['ort-1', 'ort-2']);
  await expect(page.locator('[data-test="count-orte"]')).toHaveText('2');
  // Reihenfolge + Herkunft: Seiten-Treffer zuerst, Kapitel-Treffer ausgewiesen.
  await expect(page.locator('[data-test="ort-1"]')).toHaveAttribute('data-ctx', 'page');
  await expect(page.locator('[data-test="ort-2"]')).toHaveAttribute('data-ctx', 'chapter');
});

test('Szenen: auch die seitengebundenen Szenen desselben Kapitels', async ({ page }) => {
  await setup(page);
  expect(await ids(page, 'szene')).toEqual(['szene-11', 'szene-12', 'szene-13']);
  await expect(page.locator('[data-test="count-szenen"]')).toHaveText('3');
  await expect(page.locator('[data-test="szene-11"]')).toHaveAttribute('data-ctx', 'page');
  await expect(page.locator('[data-test="szene-12"]')).toHaveAttribute('data-ctx', 'chapter');
  await expect(page.locator('[data-test="szene-13"]')).toHaveAttribute('data-ctx', 'chapter');
});

test('Szene einer anderen Seite nennt diese Seite beim Namen', async ({ page }) => {
  await setup(page);
  // t() ist im Harness die Identitaet mit Params — der Seitenname muss drin sein.
  await expect(page.locator('[data-test="szene-13"]'))
    .toHaveAttribute('data-where', /reference\.ctx\.onOtherPage.*Seite Acht/);
  // Szenen dieser Seite tragen keine Fremdseiten-Angabe.
  await expect(page.locator('[data-test="szene-11"]')).toHaveAttribute('data-where', '');
});

test('Figuren: Kapitel-Index UND Namens-Treffer, nicht das eine statt des anderen', async ({ page }) => {
  await setup(page);
  // 21 im Text + im Index, 23 nur im Text (frisch), 22 nur im Index. 24 draussen.
  expect(await ids(page, 'figur')).toEqual(['figur-21', 'figur-23', 'figur-22']);
  await expect(page.locator('[data-test="count-figuren"]')).toHaveText('3');
  await expect(page.locator('[data-test="figur-21"]')).toHaveAttribute('data-ctx', 'page');
  await expect(page.locator('[data-test="figur-23"]')).toHaveAttribute('data-ctx', 'page');
  await expect(page.locator('[data-test="figur-22"]')).toHaveAttribute('data-ctx', 'chapter');
});

test('Ereignisse: Anker sind IDs — ein gleichnamiges Fremdkapitel zaehlt nicht', async ({ page }) => {
  await setup(page);
  // 31 Seitenanker, 32 kapitelweit, 33 Nachbarseite, 35 Alt-Eintrag ohne IDs
  // (Namens-Rueckfall). 34 traegt denselben Kapitelnamen, aber chapter_id 4.
  expect(await ids(page, 'ereignis')).toEqual(['ereignis-31', 'ereignis-32', 'ereignis-33', 'ereignis-35']);
  await expect(page.locator('[data-test="ereignis-31"]')).toHaveAttribute('data-ctx', 'page');
  await expect(page.locator('[data-test="ereignis-32"]')).toHaveAttribute('data-ctx', 'chapter');
  await expect(page.locator('[data-test="ereignis-33"]')).toHaveAttribute('data-ctx', 'chapter');
  // Nur das Ereignis mit fremdem Seitenanker nennt die Seite.
  await expect(page.locator('[data-test="ereignis-33"]'))
    .toHaveAttribute('data-where', /reference\.ctx\.onOtherPage.*Seite Acht/);
  await expect(page.locator('[data-test="ereignis-32"]')).toHaveAttribute('data-where', '');
});

test('Recherche: Seiten-Verknuepfung vor Kapitel-Verknuepfung, Herkunft ausgewiesen', async ({ page }) => {
  await setup(page);
  expect(await ids(page, 'recherche')).toEqual(['recherche-41', 'recherche-42']);
  await expect(page.locator('[data-test="count-recherche"]')).toHaveText('2');
  await expect(page.locator('[data-test="recherche-41"]')).toHaveAttribute('data-ctx', 'page');
  await expect(page.locator('[data-test="recherche-42"]')).toHaveAttribute('data-ctx', 'chapter');
});

test('Scope "Buch": kein Kontext-Filter, keine Herkunfts-Markierung', async ({ page }) => {
  await setup(page);
  await page.click('[data-test="scope"]');
  await expect(page.locator('[data-test="scope"]')).toHaveText('book');
  expect(await ids(page, 'ort')).toEqual(['ort-1', 'ort-2', 'ort-3', 'ort-4']);
  expect(await ids(page, 'szene')).toEqual(['szene-11', 'szene-12', 'szene-13', 'szene-14']);
  expect(await ids(page, 'figur')).toEqual(['figur-21', 'figur-22', 'figur-23', 'figur-24']);
  expect(await ids(page, 'ereignis'))
    .toEqual(['ereignis-31', 'ereignis-32', 'ereignis-33', 'ereignis-34', 'ereignis-35']);
  expect(await ids(page, 'recherche'))
    .toEqual(['recherche-41', 'recherche-42', 'recherche-43', 'recherche-44']);
  await expect(page.locator('[data-test="ort-2"]')).toHaveAttribute('data-ctx', '');
});
