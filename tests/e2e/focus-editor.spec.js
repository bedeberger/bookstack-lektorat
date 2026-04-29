const { test, expect } = require('@playwright/test');

const HARNESS = '/tests/fixtures/focus-harness.html';
const EDITOR = '#editor-card .page-content-view--editing';

async function enter(page) {
  // exitFocusMode droppt bei !editDirty zurück in den View-Modus (editMode=false).
  // Für Re-Entry im Test editMode zurücksetzen.
  await page.evaluate(() => { window.harness.editMode = true; window.harness.enterFocusMode(); });
  await page.waitForFunction(() => window.harness._focusListeners !== null);
  // Focus-Entry hängt einen leeren <p> ans Ende und recentert – dadurch
  // scrollt der Editor initial. Auf den abschliessenden RAF warten, damit
  // Tests von einem stabilen Scroll-Zustand aus arbeiten können.
  await page.waitForTimeout(50);
}

async function placeCaretInParagraph(page, idx) {
  await page.evaluate((i) => {
    const p = document.querySelectorAll(`${'#editor-card .page-content-view--editing'} p`)[i];
    const range = document.createRange();
    range.selectNodeContents(p);
    range.collapse(true);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }, idx);
}

async function scrollTop(page) {
  return page.evaluate((sel) => document.querySelector(sel).scrollTop, EDITOR);
}

test.beforeEach(async ({ page }) => {
  await page.goto(HARNESS);
  await page.waitForFunction(() => window.harnessReady === true);
});

test('getScrollContainer greift trotz sichtbarer Schwester `.page-content-view` auf --editing', async ({ page }) => {
  // Produktionsbug: im Edit-Modus existieren zwei `.page-content-view`-Elemente
  // (Edit-Partial + View-Partial, gegenseitig via Alpine-x-show versteckt).
  // Während Alpine die Flags flush-t, konnte `:not([style*="display: none"])`
  // kurz den LEEREN View-Container fangen – `_focusListeners.container` zeigte
  // auf 0×0, IntersectionObserver fand keine Blöcke, nichts wurde aktiv.
  // Fixture enthält beide DIVs – der Scroll-Container muss der Editor sein.
  await enter(page);
  const capturedClass = await page.evaluate(() => window.harness._focusListeners?.container?.className);
  expect(capturedClass).toMatch(/page-content-view--editing/);

  // Und es landet tatsächlich eine aktive Markierung – nicht null.
  await page.waitForTimeout(80);
  expect(await page.locator('.focus-paragraph-active').count()).toBe(1);
});

test('toggle: enterFocusMode setzt body-Klasse, exit entfernt sie', async ({ page }) => {
  await enter(page);
  await expect(page.locator('body')).toHaveClass(/focus-mode/);

  await page.evaluate(() => window.harness.exitFocusMode());
  await expect(page.locator('body')).not.toHaveClass(/focus-mode/);
});

test('Tippen führt zu Recenter (scroll bewegt sich)', async ({ page }) => {
  await enter(page);

  // Reset auf 0, damit Recenter messbar ist.
  await page.evaluate((sel) => { document.querySelector(sel).scrollTop = 0; }, EDITOR);
  await page.waitForTimeout(50);
  expect(await scrollTop(page)).toBe(0);

  // Caret weit unten setzen + ein Zeichen tippen → muss recentern.
  await placeCaretInParagraph(page, 30);
  await page.keyboard.type('x');
  await page.waitForTimeout(100);

  expect(await scrollTop(page)).toBeGreaterThan(200);
});

test('Pointer-Schonfrist verhindert Recenter (Klick-Verhalten)', async ({ page }) => {
  await enter(page);

  // Erst zentrieren auf Absatz 10.
  await placeCaretInParagraph(page, 10);
  await page.evaluate(() => window.harness._focusUpdateActive(true));
  await page.waitForTimeout(100);
  const before = await scrollTop(page);

  // Echter Playwright-Click würde das Ziel auto-in-Viewport-scrollen → verfälscht
  // die Messung. Wir testen direkt das relevante Verhalten: ein Pointer-Event
  // unmittelbar gefolgt von selectionchange darf nicht recentern (auch wenn der
  // Cursor weit weg vom Zentrum landet).
  await page.evaluate(() => {
    const editor = document.querySelector('#editor-card .page-content-view--editing');
    editor.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    editor.dispatchEvent(new PointerEvent('pointerup',   { bubbles: true }));
    const p = document.querySelectorAll('#editor-card .page-content-view--editing p')[40];
    const range = document.createRange();
    range.selectNodeContents(p);
    range.collapse(true);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await page.waitForTimeout(100);
  const after = await scrollTop(page);

  expect(Math.abs(after - before)).toBeLessThan(20);
});

test('Cleanup: exit nullt State, entfernt Klassen + CSS-Vars', async ({ page }) => {
  await enter(page);
  // Etwas State erzeugen.
  await placeCaretInParagraph(page, 5);
  await page.waitForTimeout(50);
  expect(await page.locator('.focus-paragraph-active').count()).toBeGreaterThan(0);

  await page.evaluate(() => window.harness.exitFocusMode());

  await expect(page.locator('body')).not.toHaveClass(/focus-mode/);
  expect(await page.locator('.focus-paragraph-active').count()).toBe(0);

  const cssVars = await page.evaluate(() => ({
    vh:  document.documentElement.style.getPropertyValue('--focus-vh'),
    top: document.documentElement.style.getPropertyValue('--focus-vh-top'),
  }));
  expect(cssVars.vh).toBe('');
  expect(cssVars.top).toBe('');

  const state = await page.evaluate(() => ({
    listeners: window.harness._focusListeners,
    visible:   window.harness._focusVisibleBlocks,
    raf:       window.harness._focusRaf,
  }));
  expect(state.listeners).toBeNull();
  expect(state.visible).toBeNull();
  expect(state.raf).toBeNull();
});

test('Enter erzeugt <p>-Absatz (kein <div>), auch bei bare-text Content', async ({ page }) => {
  // Chromium-Default für contenteditable-Enter ist <div>. startEdit muss
  // defaultParagraphSeparator=p setzen, sonst verlieren neue Absätze das
  // Block-Styling (margin, focus-paragraph-Erkennung via BLOCK_TAGS).
  await page.evaluate(() => window.harness.startEdit());
  await enter(page);

  // Bare-Text mit <br> – klassische Problemstelle, wo Chromium ohne Fix <div> produziert.
  await page.evaluate(() => {
    const el = document.querySelector('#editor-card .page-content-view--editing');
    el.replaceChildren(
      document.createTextNode('Zeile eins.'),
      document.createElement('br'),
      document.createTextNode('Zeile zwei.'),
    );
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await page.keyboard.press('Enter');
  await page.keyboard.type('neu');
  await page.waitForTimeout(50);

  const divCount = await page.locator(`${EDITOR} > div`).count();
  const pCount   = await page.locator(`${EDITOR} > p`).count();
  expect(divCount).toBe(0);
  expect(pCount).toBeGreaterThan(0);
  await expect(page.locator(`${EDITOR} > p`).last()).toHaveText('neu');
});

test('Enter in <p> splittet sauber in zwei <p> (Standardfall)', async ({ page }) => {
  await page.evaluate(() => window.harness.startEdit());
  await enter(page);

  const before = await page.locator(`${EDITOR} > p`).count();
  await placeCaretInParagraph(page, 3);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(50);
  const after = await page.locator(`${EDITOR} > p`).count();
  expect(after).toBe(before + 1);
  expect(await page.locator(`${EDITOR} > div`).count()).toBe(0);
});

test('Enter im Fokus-Mode zentriert auf den neuen Absatz (Typewriter-Scroll)', async ({ page }) => {
  // Regression: vor defaultParagraphSeparator=p erzeugte Enter <div>, das
  // nicht in BLOCK_TAGS ist → findBlockFromNode lieferte null → kein
  // Recenter auf die neue Zeile. Ergebnis: Cursor wanderte unsichtbar
  // aus dem Viewport-Zentrum.
  await page.evaluate(() => window.harness.startEdit());
  await enter(page);

  // Absatz weit unten fokussieren + zentrieren, damit Enter einen messbaren
  // Scroll-Delta erzeugen kann. Caret ans Ende, damit der neue <p> nach
  // Enter die aktive Zeile ist (nicht der verbleibende Rest).
  await page.evaluate(() => {
    const p = document.querySelectorAll('#editor-card .page-content-view--editing p')[30];
    const range = document.createRange();
    range.selectNodeContents(p);
    range.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  // Scroll auf 0 zurücksetzen: ohne Recenter bleibt der neue Absatz weit
  // unterhalb des Viewports. Mit Recenter springt scrollTop messbar nach oben.
  await page.evaluate((sel) => { document.querySelector(sel).scrollTop = 0; }, EDITOR);
  await page.waitForTimeout(50);

  await page.keyboard.press('Enter');
  await page.keyboard.type('frisch');
  await page.waitForTimeout(100);

  // Der frisch getippte Absatz muss aktiv markiert sein (Recenter-Pfad
  // basiert auf BLOCK_TAGS-Match, DIV würde hier durchfallen).
  const activeText = await page.locator(`${EDITOR} .focus-paragraph-active`).innerText();
  expect(activeText).toBe('frisch');

  // Recenter muss scrollTop klar nach oben bewegen (neuer Absatz weit unten).
  expect(await scrollTop(page)).toBeGreaterThan(200);
});

test('Dim-Logik: nicht-aktive Absätze opacity 0.5, aktiver opacity 1 (2-Absatz-Fall + Enter)', async ({ page }) => {
  // Reproduziert den User-Report: zwei Absätze, Wechsel in den zweiten,
  // dann Enter für einen dritten. Der jeweils aktive Absatz muss opacity 1
  // haben, alle anderen opacity 0.5 – inklusive des ersten, der sonst
  // (wenn die Dim-Regel `> *` z.B. durch Wrapper oder Active-Class-Leichen
  // kippt) hell stehen bleibt. Deshalb liest der Test die computed opacity
  // und nicht nur die Klasse – die Class-Logik kann korrekt sein, während
  // die visuelle Wirkung daneben liegt.
  await page.evaluate(() => {
    const ed = document.querySelector('#editor-card .page-content-view--editing');
    ed.replaceChildren(
      Object.assign(document.createElement('p'), { textContent: 'Erster Absatz.' }),
      Object.assign(document.createElement('p'), { textContent: 'Zweiter Absatz.' }),
    );
  });
  await page.evaluate(() => window.harness.startEdit());
  await enter(page);

  const readState = () => page.evaluate(() => {
    const ps = [...document.querySelectorAll('#editor-card .page-content-view--editing p')];
    return ps.map(p => ({
      text: p.textContent,
      active: p.classList.contains('focus-paragraph-active'),
      opacity: parseFloat(getComputedStyle(p).opacity),
    }));
  });

  // Caret in den zweiten Absatz → nur P2 aktiv, P1 gedimmt.
  await placeCaretInParagraph(page, 1);
  await page.waitForTimeout(80);

  // Focus-Entry hängt zusätzlich einen leeren <p> ans Ende (Caret-Sprung-
  // Feature: User soll sofort tippen können). State enthält daher 3 <p>.
  let state = await readState();
  expect(state).toHaveLength(3);
  expect(state.filter(s => s.active)).toHaveLength(1);
  expect(state[1].active).toBe(true);
  expect(state[0].active).toBe(false);
  expect(state[2].active).toBe(false);
  expect(state[1].opacity).toBe(1);
  expect(state[0].opacity).toBeLessThan(1); // der entscheidende Punkt
  expect(state[2].opacity).toBeLessThan(1);

  // Caret ans Ende von P2, Enter → neuer P. Nach Typing: getippter Absatz aktiv.
  await page.evaluate(() => {
    const p = document.querySelectorAll('#editor-card .page-content-view--editing p')[1];
    const r = document.createRange();
    r.selectNodeContents(p); r.collapse(false);
    getSelection().removeAllRanges(); getSelection().addRange(r);
  });
  await page.keyboard.press('Enter');
  await page.keyboard.type('Dritter.');
  await page.waitForTimeout(80);

  state = await readState();
  // Erster, Zweiter, Dritter., trailing-empty (vom Focus-Entry).
  expect(state).toHaveLength(4);
  expect(state.filter(s => s.active)).toHaveLength(1);
  expect(state[2].active).toBe(true);
  expect(state[2].text).toBe('Dritter.');
  expect(state[2].opacity).toBe(1);
  // Alle Nicht-Aktiven müssen gedimmt sein – insbesondere der erste, der im
  // Report hell blieb.
  expect(state[0].opacity).toBeLessThan(1);
  expect(state[1].opacity).toBeLessThan(1);
  expect(state[3].opacity).toBeLessThan(1);
});

test('Dim-Logik: greift auch bei Wrapper-Elementen um die <p> (BookStack-Struktur)', async ({ page }) => {
  // Realer Bug-Report: „alle Absätze hervorgehoben, keiner ausgegraut".
  // Hypothese: BookStack-HTML liefert Absätze gelegentlich in Wrappern
  // (z.B. <div>…<p>…</p>…</div>), dann trifft ein `> *`-Child-Selector nur
  // den Wrapper. Der Test forciert genau diese Struktur, damit Regressionen
  // in der Dim-Regel sofort auffallen.
  await page.evaluate(() => {
    const ed = document.querySelector('#editor-card .page-content-view--editing');
    const wrap = document.createElement('div');
    wrap.appendChild(Object.assign(document.createElement('p'), { textContent: 'Erster Absatz.' }));
    wrap.appendChild(Object.assign(document.createElement('p'), { textContent: 'Zweiter Absatz.' }));
    ed.replaceChildren(wrap);
  });
  await page.evaluate(() => window.harness.startEdit());
  await enter(page);

  // Caret in den zweiten Absatz.
  await page.evaluate(() => {
    const p = document.querySelectorAll('#editor-card .page-content-view--editing p')[1];
    const r = document.createRange();
    r.selectNodeContents(p); r.collapse(true);
    getSelection().removeAllRanges(); getSelection().addRange(r);
  });
  await page.waitForTimeout(80);

  const state = await page.evaluate(() => {
    const ps = [...document.querySelectorAll('#editor-card .page-content-view--editing p')];
    return ps.map(p => ({
      active: p.classList.contains('focus-paragraph-active'),
      opacity: parseFloat(getComputedStyle(p).opacity),
    }));
  });
  // Focus-Entry hängt einen weiteren leeren <p> direkt ans Editor-Root – die
  // Wrapper-<div>-Struktur bleibt unverändert, nur am Ende kommt ein Sibling
  // dazu. P1/P2 sind im Wrapper, P3 ist der Trailing-Empty.
  expect(state).toHaveLength(3);
  expect(state[1].active).toBe(true);
  expect(state[1].opacity).toBe(1);
  // Der entscheidende Fall: P1 ist KEIN direktes Kind von
  // .page-content-view--editing, muss aber trotzdem gedimmt werden.
  expect(state[0].active).toBe(false);
  expect(state[0].opacity).toBeLessThan(1);
  expect(state[2].active).toBe(false);
  expect(state[2].opacity).toBeLessThan(1);
});

test('5× Toggle leakt keine Observer/Listeners', async ({ page }) => {
  for (let i = 0; i < 5; i++) {
    await enter(page);
    await page.evaluate(() => window.harness.exitFocusMode());
  }
  // Nach dem letzten Exit: alles sauber zurück.
  const state = await page.evaluate(() => ({
    listeners: window.harness._focusListeners,
    visible:   window.harness._focusVisibleBlocks,
  }));
  expect(state.listeners).toBeNull();
  expect(state.visible).toBeNull();
  expect(await page.locator('.focus-paragraph-active').count()).toBe(0);
});

test('Re-Entry-Race: zweiter enterFocusMode() im gleichen Tick wird ignoriert', async ({ page }) => {
  // State-Machine blockt Double-Install. Ohne Guard würde der zweite
  // enterFocusMode() alle Event-Listener doppelt registrieren → jeder
  // User-Event feuert zweimal.
  await page.evaluate(() => {
    window.harness.editMode = true;
    window.harness.enterFocusMode();
    window.harness.enterFocusMode(); // muss No-Op sein (_focusState === 'entering')
  });
  await page.waitForFunction(() => window.harness._focusListeners !== null);
  const state = await page.evaluate(() => window.harness._focusState);
  expect(state).toBe('active');
});

test('Escape während editSaving wird ignoriert (kein Exit mitten im Save)', async ({ page }) => {
  await enter(page);
  await page.evaluate(() => { window.harness.editSaving = true; });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(50);
  const still = await page.evaluate(() => ({
    focusMode: window.harness.focusMode,
    state: window.harness._focusState,
  }));
  expect(still.focusMode).toBe(true);
  expect(still.state).toBe('active');
  await page.evaluate(() => { window.harness.editSaving = false; });
});

test('Blur des Editors entfernt aktive Markierung', async ({ page }) => {
  await enter(page);
  await placeCaretInParagraph(page, 5);
  await page.waitForTimeout(50);
  expect(await page.locator('.focus-paragraph-active').count()).toBeGreaterThan(0);

  await page.evaluate(() => {
    const el = document.querySelector('#editor-card .page-content-view--editing');
    el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
  });
  await page.waitForTimeout(50);
  expect(await page.locator('.focus-paragraph-active').count()).toBe(0);
});

test('Chromium-Split: zwei .focus-paragraph-active → setActiveBlock räumt ab', async ({ page }) => {
  await enter(page);
  await placeCaretInParagraph(page, 5);
  await page.waitForTimeout(50);

  // Ghost-Klasse auf zweiten Absatz setzen (simuliert Enter-Split-Bug).
  await page.evaluate(() => {
    document.querySelectorAll('#editor-card .page-content-view--editing p')[6]
      .classList.add('focus-paragraph-active');
  });
  expect(await page.locator('.focus-paragraph-active').count()).toBe(2);

  // Re-trigger → setActiveBlock(container, currentBlock) räumt alle anderen.
  await page.evaluate(() => window.harness._focusUpdateActive(false));
  await page.waitForTimeout(50);
  expect(await page.locator('.focus-paragraph-active').count()).toBe(1);
});

test('Save-Fail beim Exit: User bleibt im Edit-Modus (Draft retten)', async ({ page }) => {
  await enter(page);
  await page.evaluate(() => {
    window.harness.editDirty = true;
    window.harness.quickSave = async function () {
      this.editSaving = true;
      await Promise.resolve();
      this.editSaving = false;
      throw new Error('offline');
    };
  });

  await page.evaluate(() => window.harness.exitFocusMode());

  const after = await page.evaluate(() => ({
    focusMode: window.harness.focusMode,
    editMode:  window.harness.editMode,
    editDirty: window.harness.editDirty,
    state:     window.harness._focusState,
    listeners: window.harness._focusListeners,
  }));
  expect(after.focusMode).toBe(false);
  expect(after.editMode).toBe(true);
  expect(after.editDirty).toBe(true);
  expect(after.state).toBe('idle');
  expect(after.listeners).toBeNull();
});

test('MutationObserver: 50 neu hinzugefügte <p> werden observiert (inkremental, kein Vollscan)', async ({ page }) => {
  await enter(page);
  await page.evaluate(() => {
    const editor = document.querySelector('#editor-card .page-content-view--editing');
    for (let i = 0; i < 50; i++) {
      const p = document.createElement('p');
      p.textContent = `Neuer Absatz ${i}`;
      p.setAttribute('data-new', '1');
      editor.appendChild(p);
    }
  });
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    const neu = document.querySelectorAll('[data-new="1"]')[10];
    const range = document.createRange();
    range.selectNodeContents(neu);
    range.collapse(true);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await page.waitForTimeout(100);
  const activeTxt = await page.locator('.focus-paragraph-active').first().innerText();
  expect(activeTxt).toContain('Neuer Absatz 10');
});

test('visualViewport-resize debounced: setzt --focus-vh, kein Recenter-Storm', async ({ page }) => {
  await enter(page);
  await placeCaretInParagraph(page, 10);
  await page.evaluate(() => window.harness._focusUpdateActive(true));
  await page.waitForTimeout(100);

  // 10× rasch resize feuern → durch Debounce (100ms) zählt nur das letzte.
  await page.evaluate(() => {
    for (let i = 0; i < 10; i++) {
      window.visualViewport?.dispatchEvent(new Event('resize'));
    }
  });
  await page.waitForTimeout(200);

  const vh = await page.evaluate(() =>
    document.documentElement.style.getPropertyValue('--focus-vh'));
  expect(vh).toMatch(/^\d+px$/);
});

test('Enter-Error (fehlender Scroll-Container) → sauberer Rollback', async ({ page }) => {
  // _focusInstall throwt → try/catch → rollback: focusMode=false,
  // body.focus-mode weg, state=idle. Ohne Rollback würde die body-Klasse
  // bestehen und die App fühlte sich „hängend" an.
  await page.evaluate(() => {
    const card = document.querySelector('#editor-card');
    window.__savedCard = card;
    card.remove();
  });
  await page.evaluate(() => {
    window.harness.editMode = true;
    window.harness.enterFocusMode();
  });
  await page.waitForTimeout(50);

  const state = await page.evaluate(() => ({
    focusMode: window.harness.focusMode,
    state: window.harness._focusState,
    bodyFocus: document.body.classList.contains('focus-mode'),
    listeners: window.harness._focusListeners,
  }));
  expect(state.focusMode).toBe(false);
  expect(state.state).toBe('idle');
  expect(state.bodyFocus).toBe(false);
  expect(state.listeners).toBeNull();

  await page.evaluate(() => {
    document.body.insertBefore(window.__savedCard, document.body.firstChild);
  });
});

test('IME-Composition: selectionchange während compositionstart/end kein Recenter', async ({ page }) => {
  // Japanisch/Chinesisch/Koreanisch: IME feuert während Kandidatenfenster
  // selectionchange + input. Recenter würde den Kandidaten-Popup verschieben.
  await enter(page);
  await placeCaretInParagraph(page, 10);
  await page.evaluate(() => window.harness._focusUpdateActive(true));
  await page.waitForTimeout(100);
  const before = await scrollTop(page);

  // compositionstart → caret weit unten setzen → selectionchange feuert, darf
  // aber während IME nicht recentern.
  await page.evaluate(() => {
    const editor = document.querySelector('#editor-card .page-content-view--editing');
    editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    const p = document.querySelectorAll('#editor-card .page-content-view--editing p')[40];
    const range = document.createRange();
    range.selectNodeContents(p);
    range.collapse(true);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
  });
  await page.waitForTimeout(100);
  const during = await scrollTop(page);
  expect(Math.abs(during - before)).toBeLessThan(20);

  // compositionend → jetzt Recenter.
  await page.evaluate(() => {
    const editor = document.querySelector('#editor-card .page-content-view--editing');
    editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
  });
  await page.waitForTimeout(100);
  const after = await scrollTop(page);
  expect(Math.abs(after - before)).toBeGreaterThan(100);
});

test('Input-Event triggert Recenter (Undo/Redo-Pfad ohne Caret-Move)', async ({ page }) => {
  await enter(page);
  // Reset.
  await page.evaluate((sel) => { document.querySelector(sel).scrollTop = 0; }, EDITOR);
  await page.waitForTimeout(50);
  expect(await scrollTop(page)).toBe(0);

  // Caret weit unten setzen (via Pointer-Pfad, damit selectionchange
  // unterdrückt → nur input soll feuern).
  await page.evaluate(() => {
    const editor = document.querySelector('#editor-card .page-content-view--editing');
    editor.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    editor.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    const p = document.querySelectorAll('#editor-card .page-content-view--editing p')[30];
    const range = document.createRange();
    range.selectNodeContents(p);
    range.collapse(true);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await page.waitForTimeout(100);
  // Pointer-Grace → kein Recenter bisher.
  expect(await scrollTop(page)).toBeLessThan(50);

  // Input-Event → Recenter muss jetzt greifen.
  await page.evaluate(() => {
    const editor = document.querySelector('#editor-card .page-content-view--editing');
    editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
  });
  await page.waitForTimeout(100);
  expect(await scrollTop(page)).toBeGreaterThan(200);
});

test('window.resize (Desktop, kein visualViewport-Event) → --focus-vh aktualisiert', async ({ page }) => {
  await enter(page);
  // CSS-Var leeren → Resize muss sie wieder setzen.
  await page.evaluate(() => document.documentElement.style.removeProperty('--focus-vh'));
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await page.waitForTimeout(200);
  const vh = await page.evaluate(() =>
    document.documentElement.style.getPropertyValue('--focus-vh'));
  expect(vh).toMatch(/^\d+px$/);
});

test('Editor-Focus nach Blur → Recenter (Modal-Zurückkehr-Szenario)', async ({ page }) => {
  await enter(page);
  await placeCaretInParagraph(page, 20);
  await page.waitForTimeout(100);
  expect(await page.locator('.focus-paragraph-active').count()).toBeGreaterThan(0);

  // Blur simuliert offen-Modal → Markierung weg.
  await page.evaluate(() => {
    const el = document.querySelector('#editor-card .page-content-view--editing');
    el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
  });
  await page.waitForTimeout(50);
  expect(await page.locator('.focus-paragraph-active').count()).toBe(0);

  // Focus simuliert Modal-Close → Markierung wieder da.
  await page.evaluate(() => {
    const el = document.querySelector('#editor-card .page-content-view--editing');
    el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
  });
  await page.waitForTimeout(100);
  expect(await page.locator('.focus-paragraph-active').count()).toBeGreaterThan(0);
});

test('MO: removedNodes → visibleBlocks räumt Ref ab (kein Leak)', async ({ page }) => {
  await enter(page);
  // Erst scrollen, damit IO die sichtbaren Blöcke meldet.
  await page.evaluate((sel) => { document.querySelector(sel).scrollTop = 0; }, EDITOR);
  await page.waitForTimeout(100);

  const before = await page.evaluate(() => window.harness._focusVisibleBlocks.size);
  expect(before).toBeGreaterThan(0);

  // Ersten sichtbaren Absatz entfernen → MO-removedNodes feuert → IO.unobserve
  // + visibleBlocks.delete. Ohne diesen Pfad behielte Set die Referenz bis
  // exit – bei langen Edit-Sessions relevant.
  const removed = await page.evaluate(() => {
    const first = [...window.harness._focusVisibleBlocks][0];
    const txt = first.textContent;
    first.remove();
    return txt;
  });
  await page.waitForTimeout(100);

  const stillThere = await page.evaluate((needle) => {
    for (const b of window.harness._focusVisibleBlocks) {
      if (b.textContent === needle) return true;
    }
    return false;
  }, removed);
  expect(stillThere).toBe(false);
});

test('prefers-reduced-motion: typewriter-scroll via scrollTop-assign, nicht scrollBy', async ({ page }) => {
  // matchMedia stubben, bevor wir enter aufrufen. Verifiziert, dass Recenter
  // trotzdem den scrollTop bewegt (Funktionalität erhalten), aber den
  // scrollBy-Pfad umgeht (kein smooth-scroll, wenn System es nicht will).
  await page.evaluate(() => {
    window.__origMM = window.matchMedia;
    window.matchMedia = (q) => ({
      matches: q.includes('prefers-reduced-motion: reduce'),
      media: q, onchange: null,
      addEventListener() {}, removeEventListener() {},
      addListener() {}, removeListener() {}, dispatchEvent() { return false; },
    });
    window.__scrollByCalls = 0;
    const proto = HTMLElement.prototype;
    const orig = proto.scrollBy;
    window.__origScrollBy = orig;
    proto.scrollBy = function (...args) {
      window.__scrollByCalls++;
      return orig.apply(this, args);
    };
  });

  await enter(page);
  await page.evaluate((sel) => { document.querySelector(sel).scrollTop = 0; }, EDITOR);
  await page.waitForTimeout(50);
  await placeCaretInParagraph(page, 30);
  await page.keyboard.type('x');
  await page.waitForTimeout(200);

  const [scrolled, scrollByCalls] = await Promise.all([
    scrollTop(page),
    page.evaluate(() => window.__scrollByCalls),
  ]);
  expect(scrolled).toBeGreaterThan(200);
  expect(scrollByCalls).toBe(0);

  // Restore, damit Folgetests sauber laufen.
  await page.evaluate(() => {
    if (window.__origMM) window.matchMedia = window.__origMM;
    HTMLElement.prototype.scrollBy = window.__origScrollBy;
  });
});
