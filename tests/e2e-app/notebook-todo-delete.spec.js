// Backspace/Delete in Checkbox-Listen (`ul.todo`) im NOTEBOOK-Editor, gegen die
// ECHTE App.
//
// WARUM DIESE SCHICHT: Testgegenstand ist genau das Ersetzen des nativen
// contenteditable-Löschverhaltens. Ein Fixture-Harness (linkedom/jsdom) hat
// keinen Editing-Default — dort wäre jeder nicht abgefangene Tastendruck
// automatisch ein No-Op und die Regression unsichtbar. Nur ein echter Browser
// zeigt, dass Chromium die `<input>`-Checkbox wie ein Textzeichen behandelt.
//
// Geprüfte Invarianten (public/js/editor/notebook/toolbar/keydown.js,
// `_kbTodoDelete` + Helfer):
//   1. Die Checkbox ist Struktur, nie Löschziel — es gibt keinen Zustand, in
//      dem ein `li.todo-item` ohne `<input type=checkbox>` zurückbleibt.
//   2. Ein Tastendruck bewirkt genau einen Schritt (kein toter erster Druck).
//   3. Backspace am Anfang der ersten Zeile verlässt die Liste (Absatz davor).
//   4. Zeilen-Merge erhält den `checked`-Zustand der bleibenden Zeile.
//   5. Über die Listengrenze hinweg entsteht kein Inline-`style`-Attribut
//      (verstösst gegen die „Styles nur in public/css"-Regel) und kein Block
//      verschwindet spurlos.

const { test, expect } = require('@playwright/test');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const EDIT_SEL = '#editor-card .page-content-view--editing';

const LIST_TWO = '<p>Vorher</p><ul class="todo">'
  + '<li class="todo-item"><input type="checkbox"><span class="todo-text">Erstens</span></li>'
  + '<li class="todo-item"><input type="checkbox" checked><span class="todo-text">Zweitens</span></li>'
  + '</ul><p>Nachher</p>';

async function enterNotebookEdit(page) {
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(async () => { await window.__app.selectPage(window.Alpine.store('nav').pages[0]); });
  await page.waitForFunction(() => window.__app.showEditorCard === true, null, { timeout: 15000 });
  await page.evaluate(() => window.__app.startEdit());
  await page.waitForSelector(EDIT_SEL, { timeout: 15000 });
  await page.waitForTimeout(300);
}

// Editor-Inhalt setzen und den Caret an eine definierte Stelle legen.
// `target`: { todo: n } = n-tes `.todo-text`, { p: n } = n-tes Top-Level-<p>.
// `pos`: 'start' | 'end'.
async function seed(page, html, target, pos) {
  await page.evaluate(({ html, target, pos }) => {
    const editEl = document.querySelector('#editor-card .page-content-view--editing');
    editEl.innerHTML = html;
    const el = target.todo !== undefined
      ? editEl.querySelectorAll('.todo-text')[target.todo]
      : editEl.querySelectorAll(':scope > p')[target.p];
    editEl.focus({ preventScroll: true });
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(pos === 'start');
    const sel = document.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }, { html, target, pos });
}

// Editor-HTML ohne die Write-Path-Block-IDs (die vergibt erst der Save-Pfad).
function html(page) {
  return page.evaluate(() => document
    .querySelector('#editor-card .page-content-view--editing')
    .innerHTML.replace(/ data-bid="[^"]*"/g, ''));
}

// Invariante 1 + 5: strukturelle Grundregeln, die in KEINEM Zwischenschritt
// brechen dürfen — unabhängig davon, welcher Fall gerade geprüft wird.
async function expectStructureIntact(page, label) {
  const bad = await page.evaluate(() => {
    const editEl = document.querySelector('#editor-card .page-content-view--editing');
    return {
      naked: editEl.querySelectorAll('li.todo-item:not(:has(input[type=checkbox]))').length,
      styled: editEl.querySelectorAll('[style]').length,
    };
  });
  expect(bad.naked, `${label}: kein todo-item ohne Checkbox`).toBe(0);
  expect(bad.styled, `${label}: kein Inline-style-Attribut`).toBe(0);
}

test.describe('Notebook — Löschen in Checkbox-Listen', () => {
  test('Backspace räumt die leere Zeile in EINEM Druck auf', async ({ page }) => {
    await enterNotebookEdit(page);
    // Zweite Zeile leer (Zustand direkt nach Enter auf einer Todo-Zeile).
    await seed(page, '<p>Vorher</p><ul class="todo">'
      + '<li class="todo-item"><input type="checkbox"><span class="todo-text">Erstens</span></li>'
      + '<li class="todo-item"><input type="checkbox"><span class="todo-text"><br></span></li>'
      + '</ul><p>Nachher</p>', { todo: 1 }, 'start');

    await page.keyboard.press('Backspace');
    await expectStructureIntact(page, 'leere Zeile');
    // Genau ein Schritt: die Zeile ist weg, "Erstens" unangetastet (kein
    // mitgeschleiftes Platzhalter-<br>, das als Leerzeile sichtbar wäre).
    expect(await html(page)).toBe('<p>Vorher</p><ul class="todo">'
      + '<li class="todo-item"><input type="checkbox"><span class="todo-text">Erstens</span></li>'
      + '</ul><p>Nachher</p>');

    // Caret sitzt an der Naht → weiter tippen verlängert "Erstens".
    await page.keyboard.type('!');
    expect(await html(page)).toContain('>Erstens!<');
  });

  test('Backspace in der ersten Zeile verlässt die Liste', async ({ page }) => {
    await enterNotebookEdit(page);
    await seed(page, '<p>Vorher</p><ul class="todo">'
      + '<li class="todo-item"><input type="checkbox"><span class="todo-text">Erstens</span></li>'
      + '</ul><p>Nachher</p>', { todo: 0 }, 'start');

    await page.keyboard.press('Backspace');
    await expectStructureIntact(page, 'erste Zeile');
    // Text bleibt erhalten, Liste ist aufgelöst (war die einzige Zeile).
    expect(await html(page)).toBe('<p>Vorher</p><p>Erstens</p><p>Nachher</p>');
  });

  test('Backspace am Zeilenanfang merged nach oben und erhält checked', async ({ page }) => {
    await enterNotebookEdit(page);
    await seed(page, LIST_TWO, { todo: 1 }, 'start');

    await page.keyboard.press('Backspace');
    await expectStructureIntact(page, 'Merge nach oben');
    // Die BLEIBENDE (erste, ungecheckte) Zeile bestimmt den Zustand.
    expect(await html(page)).toBe('<p>Vorher</p><ul class="todo">'
      + '<li class="todo-item"><input type="checkbox"><span class="todo-text">ErstensZweitens</span></li>'
      + '</ul><p>Nachher</p>');
  });

  test('Delete am Zeilenende zieht die nächste Zeile hoch', async ({ page }) => {
    await enterNotebookEdit(page);
    // Caret am Ende der ersten Zeile: der native Default frisst hier die
    // Checkbox der ZWEITEN Zeile und lässt sie nackt zurück.
    await seed(page, LIST_TWO, { todo: 0 }, 'end');

    await page.keyboard.press('Delete');
    await expectStructureIntact(page, 'Delete nach unten');
    expect(await html(page)).toBe('<p>Vorher</p><ul class="todo">'
      + '<li class="todo-item"><input type="checkbox"><span class="todo-text">ErstensZweitens</span></li>'
      + '</ul><p>Nachher</p>');
  });

  test('Listengrenze: Folgeabsatz wird sauber angehängt, in beide Richtungen', async ({ page }) => {
    await enterNotebookEdit(page);

    // (a) Delete am Ende der LETZTEN Zeile.
    await seed(page, LIST_TWO, { todo: 1 }, 'end');
    await page.keyboard.press('Delete');
    await expectStructureIntact(page, 'Grenze vorwärts');
    expect(await html(page), 'Grenze vorwärts').toBe('<p>Vorher</p><ul class="todo">'
      + '<li class="todo-item"><input type="checkbox"><span class="todo-text">Erstens</span></li>'
      + '<li class="todo-item"><input type="checkbox" checked=""><span class="todo-text">ZweitensNachher</span></li>'
      + '</ul>');

    // (b) Backspace am Anfang des Absatzes NACH der Liste — gleiches Ergebnis.
    await seed(page, LIST_TWO, { p: 1 }, 'start');
    await page.keyboard.press('Backspace');
    await expectStructureIntact(page, 'Grenze rückwärts');
    expect(await html(page), 'Grenze rückwärts').toBe('<p>Vorher</p><ul class="todo">'
      + '<li class="todo-item"><input type="checkbox"><span class="todo-text">Erstens</span></li>'
      + '<li class="todo-item"><input type="checkbox" checked=""><span class="todo-text">ZweitensNachher</span></li>'
      + '</ul>');
  });

  test('Delete am Ende des Absatzes VOR der Liste frisst die Checkbox nicht', async ({ page }) => {
    await enterNotebookEdit(page);
    // Gegenrichtung zur Listengrenze. Der native Default frisst hier die
    // Checkbox der ERSTEN Zeile und lässt sie nackt in der Liste stehen.
    await seed(page, LIST_TWO, { p: 0 }, 'end');

    await page.keyboard.press('Delete');
    await expectStructureIntact(page, 'Absatz vor der Liste');
    // Erste Zeile wandert in den Absatz (dort gibt es keine Checkbox — gleiche
    // Semantik wie beim Verlassen der Liste), Rest der Liste bleibt intakt.
    expect(await html(page)).toBe('<p>VorherErstens</p><ul class="todo">'
      + '<li class="todo-item"><input type="checkbox" checked=""><span class="todo-text">Zweitens</span></li>'
      + '</ul><p>Nachher</p>');
  });

  test('mitten im Text bleibt der Browser-Default zuständig', async ({ page }) => {
    await enterNotebookEdit(page);
    await seed(page, LIST_TWO, { todo: 0 }, 'end');

    // Backspace am Zeilenende ist ein reiner Textfall — die Struktur darf sich
    // nicht anfassen lassen (Gegenprobe: der Handler greift nicht zu breit).
    await page.keyboard.press('Backspace');
    await expectStructureIntact(page, 'Textfall');
    expect(await html(page)).toBe('<p>Vorher</p><ul class="todo">'
      + '<li class="todo-item"><input type="checkbox"><span class="todo-text">Ersten</span></li>'
      + '<li class="todo-item"><input type="checkbox" checked=""><span class="todo-text">Zweitens</span></li>'
      + '</ul><p>Nachher</p>');
  });
});
