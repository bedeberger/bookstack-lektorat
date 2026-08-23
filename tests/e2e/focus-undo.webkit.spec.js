// Undo-Körnung im Fokusmodus unter WebKit (Safari/iOS/WKWebView).
//
// Warum eine eigene Browser-Engine dafür: WebKit hält seinen TypingCommand
// offen, bis ein ECHTER Mausklick kommt — eine ganze Tippstrecke ist dort ein
// einziger Undo-Schritt. Gemessen am 2026-08-22 gegen WebKit 26.x mit echten
// NSEvent-Anschlägen: 66 in einem Rutsch getippte Zeichen fielen einem einzigen
// Cmd+Z zum Opfer (`canUndo` danach false). Wirkungslos als Trennung waren
// Pfeiltasten, Enter, Backspace, Auto-Save, blur()/focus(),
// Fenster-Deaktivierung, JS-Selektions-Reset, execCommand('bold'),
// insertText('') und die AppKit-Kommandos moveLeft:/moveRight:/moveWordLeft:.
// Praktische Folge im Mac-Client: der Auto-Save (1,5 s) persistierte die
// Löschung anschliessend still weiter.
//
// Chromium ist von dieser Körnung nicht in dieser Härte betroffen — die
// bestehenden Focus-Specs waren grün, während ein Cmd+Z in Safari eine
// Schreibsitzung wegnahm. Gleiche Fehlerklasse wie focus-selection.webkit.
//
// Der Fix ist die eigene Snapshot-Historie (public/js/editor/shared/edit-history.js)
// plus `preventDefault` auf Cmd/Ctrl+Z (focus/listeners.js#onHistoryKey) — ohne
// das preventDefault liefen beide Stacks parallel und ein Cmd+Z wirkte doppelt.
//
// Gefahren gegen den Standalone-Bootstrap: das ist die Konstellation des
// nativen Clients (keine SPA, keine Alpine-Root) und zugleich die einzige, in
// der die Historie eine eigene Instanz hat.
//
// MUTATIONSGEPRÜFT (Handler in focus/listeners.js ausgehängt → WebKit-Stack
// übernimmt): vier Tests werden rot — die Körnung, die Schritt-für-Schritt-Kette,
// die Konsum-Zusage und der Caret. Der erste meldete dabei genau den gemessenen
// Befund: ein Cmd+Z stellte den Absatz auf den unberührten Ladestand zurück,
// beide Tippblöcke weg, trotz 650 ms Pause dazwischen. Die übrigen sechs sind
// bewusst KEINE Fix-Detektoren, sondern halten Verträge fest, die auch der
// Browser-Stack erfüllt (`inputType`, Marken-Reparatur) oder die gar nicht an
// der Taste hängen (Handle-API, Seiten-Reset, Save-überlebt-Historie).

const { test, expect } = require('./_helpers/fixtures');

const HARNESS = '/tests/fixtures/standalone-harness.html';
const EDITOR = '.focus-editor__content';

// Caret ans Ende des ersten Absatzes — ohne Mausklick, denn genau der wäre die
// Trennung, die WebKits Undo-Körnung reparieren würde.
async function caretAtFirstParagraphEnd(page) {
  await page.evaluate((sel) => {
    const box = document.querySelector(sel);
    const p = box.querySelector('p');
    const range = document.createRange();
    range.selectNodeContents(p);
    range.collapse(false);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(range);
    box.focus();
  }, EDITOR);
}

const firstParagraph = (page) =>
  page.evaluate((sel) => document.querySelector(sel).querySelector('p').textContent, EDITOR);

test.beforeEach(async ({ page }) => {
  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.standaloneReady === true);
  await page.waitForFunction(() => document.querySelectorAll('.focus-paragraph-active').length === 1);
  await caretAtFirstParagraphEnd(page);
});

test('ein Cmd+Z nimmt NUR die letzte Tippstrecke zurück, nicht die ganze Sitzung', async ({ page }) => {
  await page.keyboard.type(' ERSTERBLOCK');
  // Über den Debounce (500 ms) warten — hier entsteht die Schrittgrenze, die
  // WebKit von sich aus nicht setzt.
  await page.waitForTimeout(650);
  await page.keyboard.type(' ZWEITERBLOCK');

  expect(await firstParagraph(page)).toContain('ERSTERBLOCK');
  expect(await firstParagraph(page)).toContain('ZWEITERBLOCK');

  await page.keyboard.press('ControlOrMeta+z');

  const after = await firstParagraph(page);
  // Der Kern der Sache: gegen den WebKit-Stack wären BEIDE Blöcke weg.
  expect(after).toContain('ERSTERBLOCK');
  expect(after).not.toContain('ZWEITERBLOCK');
});

test('Cmd+Shift+Z holt den Schritt zurück, Cmd+Y ebenso', async ({ page }) => {
  await page.keyboard.type(' ERSTERBLOCK');
  await page.waitForTimeout(650);
  await page.keyboard.type(' ZWEITERBLOCK');

  await page.keyboard.press('ControlOrMeta+z');
  expect(await firstParagraph(page)).not.toContain('ZWEITERBLOCK');

  await page.keyboard.press('ControlOrMeta+Shift+z');
  expect(await firstParagraph(page)).toContain('ZWEITERBLOCK');

  await page.keyboard.press('ControlOrMeta+z');
  expect(await firstParagraph(page)).not.toContain('ZWEITERBLOCK');

  await page.keyboard.press('ControlOrMeta+y');
  expect(await firstParagraph(page)).toContain('ZWEITERBLOCK');
});

test('mehrere Cmd+Z gehen Schritt für Schritt zurück', async ({ page }) => {
  for (const word of [' EINS', ' ZWEI', ' DREI']) {
    await page.keyboard.type(word);
    await page.waitForTimeout(650);
  }
  expect(await firstParagraph(page)).toContain('DREI');

  await page.keyboard.press('ControlOrMeta+z');
  let txt = await firstParagraph(page);
  expect(txt).toContain('ZWEI');
  expect(txt).not.toContain('DREI');

  await page.keyboard.press('ControlOrMeta+z');
  txt = await firstParagraph(page);
  expect(txt).toContain('EINS');
  expect(txt).not.toContain('ZWEI');

  await page.keyboard.press('ControlOrMeta+z');
  expect(await firstParagraph(page)).not.toContain('EINS');
});

test('Cmd+Z wird konsumiert — der Browser-Stack läuft nicht zusätzlich mit', async ({ page }) => {
  const defaultPrevented = [];
  await page.exposeFunction('__reportKey', (v) => defaultPrevented.push(v));
  await page.evaluate(() => {
    // Am document, also NACH dem Container-Handler: was hier als
    // defaultPrevented ankommt, erreicht den Browser-Undo nicht mehr.
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') window.__reportKey(e.defaultPrevented);
    });
  });
  await page.keyboard.type(' TIPPSTRECKE');
  await page.waitForTimeout(650);
  await page.keyboard.press('ControlOrMeta+z');
  await page.waitForTimeout(50);

  // stopPropagation im Container-Handler heisst: das document sieht das Event
  // gar nicht mehr. Sieht es es doch, MUSS defaultPrevented true sein.
  expect(defaultPrevented.every(Boolean)).toBe(true);
  // Und die Strecke ist genau EINMAL zurückgenommen, nicht doppelt.
  expect(await firstParagraph(page)).not.toContain('TIPPSTRECKE');
  expect(await firstParagraph(page)).toContain('Absatz 0');
});

test('Das Speichern leert die Historie NICHT (Auto-Save alle 150 ms im Harness)', async ({ page }) => {
  await page.keyboard.type(' VORDEMSAVE');
  // Auf einen echten Bridge-Save warten — genau der Punkt, an dem ein Clear
  // beim Speichern den Datenverlust-Fall reproduzieren würde.
  await page.waitForFunction(() => window.__saveLog.some(s => s.html.includes('VORDEMSAVE')), null, { timeout: 3000 });
  await page.waitForTimeout(650);

  expect(await page.evaluate(() => window.__standalone.canUndo())).toBe(true);
  await page.keyboard.press('ControlOrMeta+z');
  expect(await firstParagraph(page)).not.toContain('VORDEMSAVE');
});

test('Caret sitzt nach dem Undo an der wiederhergestellten Stelle — Tippen geht dort weiter', async ({ page }) => {
  await page.keyboard.type(' ANKER');
  await page.waitForTimeout(650);
  await page.keyboard.type(' WEG');
  await page.keyboard.press('ControlOrMeta+z');
  await page.keyboard.type('X');

  const txt = await firstParagraph(page);
  expect(txt).toContain('ANKERX');
  expect(txt).not.toContain('WEG');
});

test('Undo reproduziert die Momentaufnahme zeichengenau — auch das Leerzeichen am Blockende', async ({ page }) => {
  // Gemessen am macOS-Client: der Restore lief durch collapseSoftNewlines MIT
  // Blockrand-Trim und schnitt das eben getippte Leerzeichen weg (533 → 532
  // Zeichen). Sichtbar wird das erst danach: restoreCaretAtOffset klemmt den
  // Offset auf die kuerzere Laenge, der Caret sitzt hinter dem letzten Wort
  // statt hinter dem Leerzeichen — und das naechste Wort klebt an.
  await page.keyboard.type(' ANKER ');
  await page.waitForTimeout(650);
  await page.keyboard.type('WEG');
  await page.keyboard.press('ControlOrMeta+z');

  expect(await firstParagraph(page)).toMatch(/ANKER $/);

  await page.keyboard.type('X');
  expect(await firstParagraph(page)).toContain('ANKER X');
});

test('Handle-API (undo/redo/canUndo/canRedo) — Weg des AppKit-Menüs', async ({ page }) => {
  // Im macOS-Client erreicht Cmd+Z die WebView nie: das Menü „Bearbeiten ▸
  // Widerrufen" verbraucht das Kürzel vorher. Die Schale ruft darum diese
  // Methoden — sie müssen dasselbe leisten wie der Tastengriff.
  expect(await page.evaluate(() => window.__standalone.canUndo())).toBe(false);

  await page.keyboard.type(' UEBERSMENUE');
  await page.waitForTimeout(650);

  expect(await page.evaluate(() => window.__standalone.canUndo())).toBe(true);
  expect(await page.evaluate(() => window.__standalone.undo())).toBe(true);
  expect(await firstParagraph(page)).not.toContain('UEBERSMENUE');

  expect(await page.evaluate(() => window.__standalone.canRedo())).toBe(true);
  expect(await page.evaluate(() => window.__standalone.redo())).toBe(true);
  expect(await firstParagraph(page)).toContain('UEBERSMENUE');

  // An den Enden meldet die API false statt zu klemmen.
  expect(await page.evaluate(() => window.__standalone.redo())).toBe(false);
});

test('Seitenwechsel setzt die Historie zurück (pro Seite)', async ({ page }) => {
  await page.keyboard.type(' AUFSEITEEINS');
  await page.waitForTimeout(650);
  expect(await page.evaluate(() => window.__standalone.canUndo())).toBe(true);

  await page.evaluate(() => window.__standalone.setPage({ id: 43, name: 'Zweite', html: '<p>Neue Seite</p>' }));
  expect(await page.evaluate(() => window.__standalone.canUndo())).toBe(false);
  expect(await page.evaluate(() => window.__standalone.undo())).toBe(false);
  expect(await firstParagraph(page)).toBe('Neue Seite');
});

test('Restore feuert ein input mit inputType historyUndo (Vertrag mit dem Client)', async ({ page }) => {
  await page.evaluate(() => {
    window.__inputTypes = [];
    document.querySelector('.focus-editor__content')
      .addEventListener('input', (e) => window.__inputTypes.push(e.inputType ?? null));
  });
  await page.keyboard.type(' TYPTEST');
  await page.waitForTimeout(650);
  await page.keyboard.press('ControlOrMeta+z');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await page.waitForTimeout(50);

  const types = await page.evaluate(() => window.__inputTypes);
  expect(types).toContain('historyUndo');
  expect(types).toContain('historyRedo');
});

test('Die Fokus-Markierung überlebt Undo/Redo (Invariante 18)', async ({ page }) => {
  await page.keyboard.type(' MARKTEST');
  await page.waitForTimeout(650);
  await page.keyboard.press('ControlOrMeta+z');
  await page.waitForTimeout(100);
  expect(await page.locator('.focus-paragraph-active').count()).toBe(1);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await page.waitForTimeout(100);
  expect(await page.locator('.focus-paragraph-active').count()).toBe(1);
});
