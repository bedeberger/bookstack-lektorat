// Todo-Checkbox in der LESEANSICHT des Notebook-Editors, gegen die ECHTE App.
//
// WARUM DIESE SCHICHT: der Haken haengt an drei Dingen, die nur zusammen in der
// gebooteten App existieren — dem nativen Klick auf ein `<input>` im
// x-html-gerenderten Lesecontainer, dem Root-State (`originalHtml`,
// `currentPage.updated_at`) und dem echten Save-Pfad inkl. Server-HTML-Cleaner.
// Ein Fixture-Harness kann gruen bleiben, waehrend der Haken visuell umklappt
// und nie gespeichert wird — genau der Bug, den dieser Test einklemmt.
//
// Geprueft (public/js/book/page-view.js#_handleViewTodoClick/_saveViewTodo):
//   1. Klick in der Leseansicht persistiert das `checked`-Attribut (Reload-fest)
//   2. Erneuter Klick nimmt den Haken wieder weg (auch persistent)
//   3. Der Klick trifft genau den angeklickten Kasten, nicht seine Nachbarn
//   4. `updated_at` wird mitgezogen, sodass der Folgeklick keinen 409 baut

const { test, expect } = require('@playwright/test');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const EDIT_SEL = '#editor-card .page-content-view--editing';
const VIEW_SEL = '#editor-card .page-view-wrap .page-content-view';
const BOX_SEL = `${VIEW_SEL} ul.todo > li.todo-item > input[type="checkbox"]`;

// Todo-Liste an die erste Seite anhaengen und ueber den normalen Save-Pfad
// persistieren. Angehaengt (nicht ersetzt), weil saveEdit bei drastischer
// Textkuerzung einen Bestaetigungsdialog oeffnet.
// `pageIdx` trennt die Tests auf eigene Seiten: die Smoke-DB lebt ueber den
// ganzen Lauf, zwei Tests auf derselben Seite wuerden ihre Todo-Listen
// uebereinander stapeln.
async function seedTodoList(page, labels, pageIdx = 0) {
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(async (i) => { await window.__app.selectPage(window.Alpine.store('nav').pages[i]); }, pageIdx);
  await page.waitForFunction(() => window.__app.showEditorCard === true, null, { timeout: 15000 });
  await page.evaluate(() => window.__app.startEdit());
  await page.waitForSelector(EDIT_SEL, { timeout: 15000 });
  await page.evaluate((items) => {
    const el = document.querySelector('#editor-card .page-content-view--editing');
    const li = items.map(txt =>
      `<li class="todo-item"><input type="checkbox"><span class="todo-text">${txt}</span></li>`).join('');
    el.insertAdjacentHTML('beforeend', `<ul class="todo">${li}</ul>`);
    window.__app._markEditDirty();
  }, labels);
  await page.evaluate(async () => { await window.__app.saveEdit(); });
  await page.waitForFunction(() => window.__app.editMode === false, null, { timeout: 15000 });
  await page.waitForSelector(BOX_SEL, { timeout: 15000 });
}

// Haken-Zustand aus dem gespeicherten HTML (nicht aus dem DOM) — genau der
// Unterschied zwischen „sieht abgehakt aus" und „ist abgehakt".
async function savedFlags(page) {
  return page.evaluate(() => {
    const el = document.createElement('div');
    el.innerHTML = window.__app.originalHtml || '';
    return [...el.querySelectorAll('ul.todo > li.todo-item > input[type="checkbox"]')]
      .map(b => b.hasAttribute('checked'));
  });
}

async function domFlags(page) {
  return page.locator(BOX_SEL).evaluateAll(boxes => boxes.map(b => b.checked));
}

test('Leseansicht: Haken wird gespeichert und ueberlebt den Reload', async ({ page }) => {
  await seedTodoList(page, ['Aufgabe eins'], 0);
  expect(await savedFlags(page)).toEqual([false]);

  await page.locator(BOX_SEL).first().click();
  await expect.poll(() => savedFlags(page)).toEqual([true]);
  expect(await domFlags(page)).toEqual([true]);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector(BOX_SEL, { timeout: 30000 });
  expect(await savedFlags(page)).toEqual([true]);
  expect(await domFlags(page)).toEqual([true]);
});

test('Leseansicht: erneuter Klick nimmt den Haken persistent zurueck', async ({ page }) => {
  await seedTodoList(page, ['Aufgabe eins'], 1);

  await page.locator(BOX_SEL).first().click();
  await expect.poll(() => savedFlags(page)).toEqual([true]);

  // Zweiter Klick auf derselben Seite: nur korrekt, wenn der erste Save
  // `currentPage.updated_at` mitgezogen hat — sonst 409 gegen den eigenen Write.
  await page.locator(BOX_SEL).first().click();
  await expect.poll(() => savedFlags(page)).toEqual([false]);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector(BOX_SEL, { timeout: 30000 });
  expect(await savedFlags(page)).toEqual([false]);
});

test('Leseansicht: Klick trifft nur den angeklickten Kasten', async ({ page }) => {
  await seedTodoList(page, ['Aufgabe eins', 'Aufgabe zwei', 'Aufgabe drei'], 2);
  expect(await savedFlags(page)).toEqual([false, false, false]);

  await page.locator(BOX_SEL).nth(1).click();
  await expect.poll(() => savedFlags(page)).toEqual([false, true, false]);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector(BOX_SEL, { timeout: 30000 });
  expect(await savedFlags(page)).toEqual([false, true, false]);
  expect(await domFlags(page)).toEqual([false, true, false]);
});
