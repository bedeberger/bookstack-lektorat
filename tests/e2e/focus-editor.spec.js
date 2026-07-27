const { test, expect } = require('./_helpers/fixtures');

const HARNESS = '/tests/fixtures/focus-harness.html';
const EDITOR = '#editor-card .focus-editor__content';

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
    const p = document.querySelectorAll(`${'#editor-card .focus-editor__content'} p`)[i];
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
  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.harnessReady === true);
});

test('Focus-Höhenkette: Scroll-Container hat begrenzte Höhe (scrollHeight > clientHeight)', async ({ page }) => {
  // Regression: Toolbar-Refactor zog `.page-editor-wrap` als neue Flex-Spalte
  // zwischen `.editor-preview-wrap` und `.page-content-view--editing`. Ohne
  // `display: contents` / `flex: 1; min-height: 0` auf der neuen Schicht
  // kollabiert die Höhenkette → contenteditable expandiert auf Content-Höhe
  // → clientHeight == scrollHeight → kein Scroll. Tests hatten den Bug nicht
  // gefangen, weil die alte Harness-DOM-Struktur flach war.
  await enter(page);
  const dims = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return { client: el.clientHeight, scroll: el.scrollHeight };
  }, EDITOR);
  expect(dims.client).toBeGreaterThan(100);
  expect(dims.scroll).toBeGreaterThan(dims.client + 200);
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
  expect(capturedClass).toMatch(/focus-editor__content/);

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

test('Manueller Scroll verschiebt Spotlight auf Viewport-Center-Absatz (preferCenter)', async ({ page }) => {
  await enter(page);

  // Caret in Absatz 0 (oben). Bei Caret-first bliebe das Spotlight hier kleben,
  // auch wenn man weit nach unten scrollt.
  await placeCaretInParagraph(page, 0);
  await page.evaluate(() => window.harness._focusUpdateActive(false));
  await page.waitForTimeout(60);

  // Manuell ins untere Drittel scrollen; IntersectionObserver-Callbacks
  // (visibleBlocks-Set) müssen settlen, bevor der Center-Pick greift — sonst
  // pickt findBlockAtViewportCenter aus dem stale Set einen Block der alten
  // Scroll-Position.
  await page.evaluate((sel) => {
    document.querySelector(sel).scrollTop = Math.round(document.querySelector(sel).scrollHeight * 0.6);
  }, EDITOR);
  await page.waitForTimeout(150);

  // Keine prog-Scroll-Marke → echter User-Scroll, kein Typewriter-Scroll.
  // Spotlight muss dem Viewport-Center folgen, nicht beim Caret-Absatz 0 bleiben.
  const { activeIdx, centerIdx } = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (window.harness._focusListeners) window.harness._focusListeners.progScrollTop = null;
    el.dispatchEvent(new Event('scroll'));
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
      const ps = [...el.querySelectorAll('p')];
      const active = el.querySelector('.focus-paragraph-active');
      const cr = el.getBoundingClientRect();
      const centerY = cr.top + cr.height / 2;
      let best = -1, bestDist = Infinity;
      ps.forEach((p, i) => {
        const r = p.getBoundingClientRect();
        const d = Math.abs((r.top + r.bottom) / 2 - centerY);
        if (d < bestDist) { bestDist = d; best = i; }
      });
      resolve({ activeIdx: active ? ps.indexOf(active) : -1, centerIdx: best });
    })));
  }, EDITOR);

  expect(activeIdx).toBeGreaterThan(0);                            // nicht mehr beim Caret-Absatz
  expect(Math.abs(activeIdx - centerIdx)).toBeLessThanOrEqual(1);  // folgt dem Viewport-Center
});

test('Schreiblinie ruht auf der Bildschirmmitte (kein Abdriften nach unten)', async ({ page }) => {
  await enter(page);
  await placeCaretInParagraph(page, 30);
  await page.evaluate(() => window.harness._focusUpdateActive(true));
  await page.waitForTimeout(80);

  // Mehrere Zeilenwechsel simulieren: nach jedem Enter muss der Typewriter die
  // Caret-Zeile wieder auf den Anker ziehen. Die Ruheposition darf nicht mit
  // jedem Schritt tiefer wandern und nicht dauerhaft unter der Mitte parken.
  const offsets = [];
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => {
      document.querySelector('#editor-card .focus-editor__content').focus();
      document.execCommand('insertParagraph');
      document.execCommand('insertText', false, 'Neue Zeile');
    });
    await page.waitForTimeout(80);
    offsets.push(await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const cr = el.getBoundingClientRect();
      const caret = getSelection().getRangeAt(0).getClientRects()[0];
      const lh = parseFloat(getComputedStyle(el).lineHeight) || 24;
      return { off: (caret.top + caret.height / 2) - (cr.top + cr.height / 2), lh };
    }, EDITOR));
  }

  // Toleranz = halbe Zeilenhöhe: genau die Schwelle, unter der der Typewriter
  // absichtlich nicht nachzieht (Jitter-Filter). Alles darüber wäre ein Anker,
  // der nicht mehr die Mitte ist.
  for (const { off, lh } of offsets) {
    expect(Math.abs(off)).toBeLessThanOrEqual(lh * 0.5 + 1);
  }
});

// Kopf- und Tail-Puffer sind die Layout-Voraussetzung dafür, dass die
// Schreibzeile über die GANZE Seite auf dem Anker ruht (Invariante 9). Beide
// leiten sich aus `--focus-anchor` × `--focus-vh` ab; die Matrix prüft genau die
// Dimensionen, in denen das schon einmal auseinandergedriftet ist: der
// Mobile-Breakpoint (eigene padding-Regeln) und ein Anker ≠ 0.5 (host-gesetzt,
// z.B. nativer Client).
const BUFFER_CASES = [
  { label: 'Desktop', viewport: { width: 1024, height: 768 }, anchor: undefined },
  { label: 'Mobile', viewport: { width: 390, height: 844 }, anchor: undefined },
  { label: 'Mobile mit Tastatur', viewport: { width: 390, height: 420 }, anchor: undefined },
  { label: 'Anker oberes Drittel', viewport: { width: 1024, height: 768 }, anchor: 0.33 },
  { label: 'Anker am oberen Rand', viewport: { width: 1024, height: 768 }, anchor: 0 },
];

for (const c of BUFFER_CASES) {
  test(`Erste + letzte Zeile erreichen die Schreiblinie — ${c.label}`, async ({ page }) => {
    await page.setViewportSize(c.viewport);
    if (c.anchor !== undefined) {
      await page.evaluate((a) => { window.harness.typewriterAnchor = a; }, c.anchor);
    }
    await enter(page);
    // Kopf: um die ERSTE Zeile auf die Linie zu senken, bräuchte es negativen
    // Scroll — den gibt es nicht, also muss der Puffer oberhalb des Textes
    // mindestens `Anker − Boxoberkante` betragen. Tail: unter der LETZTEN Zeile
    // muss der Rest der Box scrollbar bleiben, sonst klemmt der Scroll am
    // Anschlag und die letzten Absätze bleiben tiefer stehen („man kommt nur bis
    // zum zweitletzten").
    const m = await page.evaluate(({ sel, ratio }) => {
      const el = document.querySelector(sel);
      const cr = el.getBoundingClientRect();
      const vvTop = window.visualViewport?.offsetTop || 0;
      const vvH = window.visualViewport?.height || window.innerHeight;
      const anchor = vvTop + vvH * ratio;
      const cs = getComputedStyle(el);
      return {
        padTop: parseFloat(cs.paddingTop),
        padBottom: parseFloat(cs.paddingBottom),
        neededTop: anchor - cr.top,
        neededBottom: cr.bottom - anchor,
        cssAnchor: parseFloat(cs.getPropertyValue('--focus-anchor')),
      };
    }, { sel: EDITOR, ratio: c.anchor === undefined ? 0.5 : c.anchor });
    expect(m.cssAnchor).toBeCloseTo(c.anchor === undefined ? 0.5 : c.anchor, 5);
    expect(m.padTop).toBeGreaterThanOrEqual(m.neededTop - 1);
    expect(m.padBottom).toBeGreaterThanOrEqual(m.neededBottom - 1);
  });
}

test('Erste Zeile ruht tatsächlich auf der Schreiblinie (Mobile)', async ({ page }) => {
  // Ergänzung zur Puffer-Rechnung oben: der Caret sitzt im ersten Absatz und
  // muss nach dem Recenter auf dem Anker liegen. Mit gekürztem Kopf-Puffer stand
  // die Zeile hier mehrere Zeilen zu hoch und `scrollTop` klemmte bei 0.
  await page.setViewportSize({ width: 390, height: 844 });
  await enter(page);
  const { off, lh } = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    el.focus();
    const tn = el.querySelector('p').firstChild;
    const r = document.createRange();
    r.setStart(tn, 3);
    r.setEnd(tn, 4);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    s.collapseToEnd();
    return new Promise((resolve) => {
      window.harness._focusUpdateActive(true);
      setTimeout(() => {
        const rr = getSelection().getRangeAt(0);
        const rect = rr.getClientRects()[0] || rr.getBoundingClientRect();
        const vvH = window.visualViewport?.height || window.innerHeight;
        const anchor = (window.visualViewport?.offsetTop || 0) + vvH * 0.5;
        resolve({
          off: (rect.top + rect.height / 2) - anchor,
          lh: parseFloat(getComputedStyle(el).lineHeight),
        });
      }, 150);
    });
  }, EDITOR);
  // Toleranz = halbe Zeilenhöhe (die Typewriter-Schwelle, unter der bewusst
  // nicht nachgezogen wird).
  expect(Math.abs(off)).toBeLessThanOrEqual(lh * 0.5 + 1);
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
    const editor = document.querySelector('#editor-card .focus-editor__content');
    editor.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    editor.dispatchEvent(new PointerEvent('pointerup',   { bubbles: true }));
    const p = document.querySelectorAll('#editor-card .focus-editor__content p')[40];
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
    const el = document.querySelector('#editor-card .focus-editor__content');
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

test('Shift+Enter erzeugt <br> im selben <p> (kein neuer Absatz, kein <div>)', async ({ page }) => {
  // Gegenstück zum insertParagraph-Test: Shift+Enter löst insertLineBreak aus.
  // Der onInput-Handler in card.js behandelt insertLineBreak wie
  // insertParagraph (synchrone Block-Markierung, kein Dim-Flash), darf aber
  // KEINEN neuen <p> erzeugen — der Soft-Break bleibt als <br> im selben
  // Absatz. Bisher war nur der Output-Cleaner (collapseEmptyBlocks) auf <br>
  // getestet, nicht der Eingabepfad im Fokus-Editor.
  await page.evaluate(() => window.harness.startEdit());
  await enter(page);

  const before = await page.locator(`${EDITOR} > p`).count();

  // Caret mitten in den Text von Absatz 3 setzen (Offset 10, nicht an den
  // Rand), damit der Umbruch sichtbar innerhalb des Absatzes landet.
  await page.evaluate(() => {
    const p = document.querySelectorAll('#editor-card .focus-editor__content > p')[3];
    const range = document.createRange();
    range.setStart(p.firstChild, 10);
    range.collapse(true);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });

  await page.keyboard.press('Shift+Enter');
  await page.waitForTimeout(50);

  // Absatz-Anzahl unverändert: Shift+Enter splittet NICHT in zwei <p>.
  expect(await page.locator(`${EDITOR} > p`).count()).toBe(before);
  expect(await page.locator(`${EDITOR} > div`).count()).toBe(0);

  // Der bearbeitete Absatz enthält jetzt einen <br>.
  const brCount = await page.evaluate(() =>
    document.querySelectorAll('#editor-card .focus-editor__content > p')[3].querySelectorAll('br').length);
  expect(brCount).toBeGreaterThanOrEqual(1);

  // Aktiv-Markierung bleibt auf demselben Absatz (insertLineBreak-Zweig in
  // card.js setzt den Block synchron, RAF reconciliiert auf denselben).
  const activeIsP3 = await page.evaluate(() => {
    const active = document.querySelector('#editor-card .focus-editor__content .focus-paragraph-active');
    const p3 = document.querySelectorAll('#editor-card .focus-editor__content > p')[3];
    return active === p3;
  });
  expect(activeIsP3).toBe(true);
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
    const p = document.querySelectorAll('#editor-card .focus-editor__content p')[30];
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
    const ed = document.querySelector('#editor-card .focus-editor__content');
    ed.replaceChildren(
      Object.assign(document.createElement('p'), { textContent: 'Erster Absatz.' }),
      Object.assign(document.createElement('p'), { textContent: 'Zweiter Absatz.' }),
    );
  });
  await page.evaluate(() => window.harness.startEdit());
  await enter(page);

  const readState = () => page.evaluate(() => {
    const ps = [...document.querySelectorAll('#editor-card .focus-editor__content p')];
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
    const p = document.querySelectorAll('#editor-card .focus-editor__content p')[1];
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
    const ed = document.querySelector('#editor-card .focus-editor__content');
    const wrap = document.createElement('div');
    wrap.appendChild(Object.assign(document.createElement('p'), { textContent: 'Erster Absatz.' }));
    wrap.appendChild(Object.assign(document.createElement('p'), { textContent: 'Zweiter Absatz.' }));
    ed.replaceChildren(wrap);
  });
  await page.evaluate(() => window.harness.startEdit());
  await enter(page);

  // Caret in den zweiten Absatz.
  await page.evaluate(() => {
    const p = document.querySelectorAll('#editor-card .focus-editor__content p')[1];
    const r = document.createRange();
    r.selectNodeContents(p); r.collapse(true);
    getSelection().removeAllRanges(); getSelection().addRange(r);
  });
  await page.waitForTimeout(80);

  const state = await page.evaluate(() => {
    const ps = [...document.querySelectorAll('#editor-card .focus-editor__content p')];
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
    focusActive: window.harness.focusActive,
    state: window.harness._focusState,
  }));
  expect(still.focusActive).toBe(true);
  expect(still.state).toBe('active');
  await page.evaluate(() => { window.harness.editSaving = false; });
});

test('Blur des Editors entfernt aktive Markierung', async ({ page }) => {
  await enter(page);
  await placeCaretInParagraph(page, 5);
  await page.waitForTimeout(50);
  expect(await page.locator('.focus-paragraph-active').count()).toBeGreaterThan(0);

  await page.evaluate(() => {
    const el = document.querySelector('#editor-card .focus-editor__content');
    el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
  });
  await page.waitForTimeout(50);
  expect(await page.locator('.focus-paragraph-active').count()).toBe(0);
});

test('Transienter null-Tick (Caret auf Container + kein sichtbarer Block) behält Markierung', async ({ page }) => {
  // Reproduziert den intermittierenden „Hervorhebung verschwindet"-Report:
  // nach Merge/Voll-Löschen sitzt der Caret kurz direkt auf dem Container
  // (findBlockFromNode=null) UND der Viewport-Center-Fallback findet nichts
  // (alle getrackten Blöcke transient Höhe 0). Ohne Schutz clear't
  // setActiveBlock(null) die Markierung → alles dimmt kurz weg. Mit der
  // _lastBlock-Beibehaltung in _focusUpdateActive bleibt der vorige aktive
  // Absatz markiert, bis der nächste echte Tick reconciliiert.
  await enter(page);
  await placeCaretInParagraph(page, 5);
  await page.evaluate(() => window.harness._focusUpdateActive(false));
  await page.waitForTimeout(60);
  expect(await page.locator('.focus-paragraph-active').count()).toBe(1);
  const beforeText = await page.evaluate(() =>
    document.querySelector('#editor-card .focus-editor__content .focus-paragraph-active')?.textContent);

  // Null-Tick erzwingen: ALLE Absätze unsichtbar (Höhe 0 → auch der QSA-
  // Fallback liefert null) + Caret direkt auf den Container.
  await page.evaluate(() => {
    const el = document.querySelector('#editor-card .focus-editor__content');
    el.querySelectorAll('p').forEach(p => { p.style.display = 'none'; });
    const range = document.createRange();
    range.setStart(el, 0);
    range.collapse(true);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    window.harness._focusUpdateActive(false);
  });
  await page.waitForTimeout(60);

  // Markierung NICHT verloren: weiterhin genau ein aktiver Absatz, derselbe.
  expect(await page.locator('.focus-paragraph-active').count()).toBe(1);
  const afterText = await page.evaluate(() =>
    document.querySelector('#editor-card .focus-editor__content .focus-paragraph-active')?.textContent);
  expect(afterText).toBe(beforeText);
});

test('Scroll (preferCenter) ohne auffindbaren Center-Block verliert Hervorhebung nicht', async ({ page }) => {
  // Direkter User-Report: „alles wird dunkel beim Scrollen". Manueller Scroll
  // geht über onScroll → _focusUpdateActive(false, { preferCenter: true }), der
  // den Caret IGNORIERT und block ausschliesslich aus findBlockAtViewportCenter
  // zieht. Findet der (z.B. weil das IO-Set transient nur Höhe-0-Einträge hält
  // und auch der QSA-Scan nichts Sichtbares liefert) keinen Block, dimmte früher
  // alles weg. _lastBlock-Schutz behält den vorigen aktiven Absatz.
  await enter(page);
  await placeCaretInParagraph(page, 8);
  await page.evaluate(() => window.harness._focusUpdateActive(false));
  await page.waitForTimeout(60);
  expect(await page.locator('.focus-paragraph-active').count()).toBe(1);
  const beforeText = await page.evaluate(() =>
    document.querySelector('#editor-card .focus-editor__content .focus-paragraph-active')?.textContent);

  // Worst case erzwingen: alle Absätze Höhe 0 (auch QSA liefert null) + IO-Set
  // leeren, dann echten User-Scroll auslösen (keine prog-Scroll-Marke).
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    el.querySelectorAll('p').forEach(p => { p.style.display = 'none'; });
    window.harness._focusVisibleBlocks.clear();
    if (window.harness._focusListeners) window.harness._focusListeners.progScrollTop = null;
    el.dispatchEvent(new Event('scroll'));
  }, EDITOR);
  await page.waitForTimeout(80);

  // Hervorhebung NICHT verloren: weiterhin genau ein aktiver Absatz, derselbe.
  expect(await page.locator('.focus-paragraph-active').count()).toBe(1);
  const afterText = await page.evaluate(() =>
    document.querySelector('#editor-card .focus-editor__content .focus-paragraph-active')?.textContent);
  expect(afterText).toBe(beforeText);
});

test('Blur leert auch mit _lastBlock-Schutz (absichtlicher Clear bleibt)', async ({ page }) => {
  // Gegenprobe zur Beibehaltung: onBlur setzt ctx._lastBlock=null und clear't
  // bewusst. Der Schutz darf den absichtlichen Blur-Clear NICHT wiederbeleben —
  // ein Folge-Tick ohne Caret-Block muss leer bleiben (kein _lastBlock da).
  await enter(page);
  await placeCaretInParagraph(page, 5);
  await page.waitForTimeout(50);
  expect(await page.locator('.focus-paragraph-active').count()).toBe(1);

  await page.evaluate(() => {
    const el = document.querySelector('#editor-card .focus-editor__content');
    el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    // Folge-Tick mit Caret auf Container → block=null, _lastBlock ist bereits
    // null → kein Wiederbeleben.
    const range = document.createRange();
    range.setStart(el, 0);
    range.collapse(true);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    el.querySelectorAll('p').forEach(p => { p.style.display = 'none'; });
    window.harness._focusUpdateActive(false);
  });
  await page.waitForTimeout(60);
  expect(await page.locator('.focus-paragraph-active').count()).toBe(0);
});

test('Chromium-Split: zwei .focus-paragraph-active → setActiveBlock räumt ab', async ({ page }) => {
  await enter(page);
  await placeCaretInParagraph(page, 5);
  await page.waitForTimeout(50);

  // Ghost-Klasse auf zweiten Absatz setzen (simuliert Enter-Split-Bug).
  await page.evaluate(() => {
    document.querySelectorAll('#editor-card .focus-editor__content p')[6]
      .classList.add('focus-paragraph-active');
  });
  expect(await page.locator('.focus-paragraph-active').count()).toBe(2);

  // Re-trigger → setActiveBlock(container, currentBlock) räumt alle anderen.
  await page.evaluate(() => window.harness._focusUpdateActive(false));
  await page.waitForTimeout(50);
  expect(await page.locator('.focus-paragraph-active').count()).toBe(1);
});

test('Save-Fail beim Exit: User bleibt im Edit-Modus (Draft retten)', async ({ page, consoleGuard }) => {
  // Negativ-Test: provoziert absichtlich einen Save-Fehler ("offline"), den der
  // Editor erwartungsgemaess via console.error loggt — kein echter Bug.
  consoleGuard.skip();
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
    focusActive: window.harness.focusActive,
    editMode:  window.harness.editMode,
    editDirty: window.harness.editDirty,
    state:     window.harness._focusState,
    listeners: window.harness._focusListeners,
  }));
  expect(after.focusActive).toBe(false);
  expect(after.editMode).toBe(true);
  expect(after.editDirty).toBe(true);
  expect(after.state).toBe('idle');
  expect(after.listeners).toBeNull();
});

test('MutationObserver: 50 neu hinzugefügte <p> werden observiert (inkremental, kein Vollscan)', async ({ page }) => {
  await enter(page);
  await page.evaluate(() => {
    const editor = document.querySelector('#editor-card .focus-editor__content');
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

test('Enter-Error (fehlender Scroll-Container) → sauberer Rollback', async ({ page, consoleGuard }) => {
  // Negativ-Test: _focusInstall wirft absichtlich ("no scroll container"), was
  // der Editor erwartungsgemaess via console.error loggt — kein echter Bug.
  consoleGuard.skip();
  // _focusInstall throwt → try/catch → rollback: focusActive=false,
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
    focusActive: window.harness.focusActive,
    state: window.harness._focusState,
    bodyFocus: document.body.classList.contains('focus-mode'),
    listeners: window.harness._focusListeners,
  }));
  expect(state.focusActive).toBe(false);
  expect(state.state).toBe('idle');
  expect(state.bodyFocus).toBe(false);
  expect(state.listeners).toBeNull();

  await page.evaluate(() => {
    document.body.insertBefore(window.__savedCard, document.body.firstChild);
  });
});

test('IME-Composition: Caret bleibt sichtbar → kein Recenter (Kandidatenfenster ruhig)', async ({ page }) => {
  // Japanisch/Chinesisch/Koreanisch: IME feuert während des Kandidatenfensters
  // selectionchange + input. Solange die Caret-Zeile sichtbar bleibt, darf der
  // Typewriter nicht eingreifen — sonst wandert das Popup unter den Fingern weg.
  await enter(page);
  await placeCaretInParagraph(page, 10);
  await page.evaluate(() => window.harness._focusUpdateActive(true));
  await page.waitForTimeout(100);
  const before = await scrollTop(page);

  // compositionstart → Caret eine Zeile tiefer (bleibt im Sichtfeld) → input.
  await page.evaluate(() => {
    const editor = document.querySelector('#editor-card .focus-editor__content');
    editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    const p = document.querySelectorAll('#editor-card .focus-editor__content p')[11];
    const range = document.createRange();
    range.selectNodeContents(p);
    range.collapse(true);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
  });
  await page.waitForTimeout(100);
  expect(Math.abs(await scrollTop(page) - before)).toBeLessThan(20);

  // compositionend → jetzt volles Reconcile inkl. Recenter.
  await page.evaluate(() => {
    const editor = document.querySelector('#editor-card .focus-editor__content');
    editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
  });
  await page.waitForTimeout(100);
  expect(Math.abs(await scrollTop(page) - before)).toBeGreaterThan(20);
});

test('IME-Composition: Caret ausserhalb des Sichtfelds → Typewriter greift trotzdem', async ({ page }) => {
  // Android-Soft-Keyboards halten auch für gewöhnliche lateinische Wörter eine
  // Composition offen, teils über ganze Sätze. Ein harter Block liesse die
  // Schreibzeile dort unter die Tastatur weglaufen. Notnagel: verlässt der
  // Caret das Sichtfeld, wird er auch während der Composition geholt.
  await enter(page);
  await placeCaretInParagraph(page, 10);
  await page.evaluate(() => window.harness._focusUpdateActive(true));
  await page.waitForTimeout(100);
  const before = await scrollTop(page);

  await page.evaluate(() => {
    const editor = document.querySelector('#editor-card .focus-editor__content');
    editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    const p = document.querySelectorAll('#editor-card .focus-editor__content p')[40];
    const range = document.createRange();
    range.selectNodeContents(p);
    range.collapse(true);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
  });
  await page.waitForTimeout(100);
  expect(Math.abs(await scrollTop(page) - before)).toBeGreaterThan(100);

  // Markup bleibt während der Composition eingefroren — nur gescrollt wird.
  const marked = await page.evaluate(() =>
    document.querySelectorAll('#editor-card .focus-editor__content .focus-paragraph-active').length);
  expect(marked).toBeLessThanOrEqual(1);
});

test('Viewport-Höhenwechsel (Tastatur/Rotation) holt den abgedrifteten Caret zurück', async ({ page }) => {
  // Mobile: die Tastatur halbiert den sichtbaren Bereich. Sass der Caret exakt
  // auf dem Anker, kompensiert die Puffer-Formel (Invariante 9/10) das von
  // selbst — `--focus-vh` schrumpft, Kopf-Puffer und Anker wandern gleich weit.
  // Ist der Caret aber vorher weggescrollt (Lese-Scroll, lange IME-Composition),
  // stünde er nach dem Tastatur-Öffnen irgendwo — im Zweifel dahinter. Der
  // Höhenwechsel ist deshalb der eine Viewport-Tick, der einmal recentert.
  const caretLineOffset = async () => page.evaluate((sel) => {
    const p = document.querySelector(sel).querySelectorAll('p')[20];
    const line = p.getClientRects()[0] || p.getBoundingClientRect();
    const vv = window.visualViewport;
    const anchor = (vv ? vv.offsetTop : 0) + (vv ? vv.height : window.innerHeight) * 0.5;
    return Math.abs(line.top + line.height / 2 - anchor);
  }, EDITOR);

  await enter(page);
  await page.evaluate((sel) => document.querySelector(sel).focus(), EDITOR);
  await placeCaretInParagraph(page, 20);
  await page.evaluate(() => window.harness._focusUpdateActive(true));
  await page.waitForTimeout(150);
  expect(await caretLineOffset()).toBeLessThan(60);

  // Weg-Scrollen wie beim Lesen — Caret bleibt in Absatz 20 zurück.
  await page.evaluate((sel) => { document.querySelector(sel).scrollTop -= 400; }, EDITOR);
  await page.waitForTimeout(100);
  expect(await caretLineOffset()).toBeGreaterThan(200);

  const size = page.viewportSize();
  await page.setViewportSize({ width: size.width, height: Math.round(size.height / 2) });
  await page.waitForTimeout(300);   // VV_DEBOUNCE_MS + RAF
  expect(await caretLineOffset()).toBeLessThan(60);

  await page.setViewportSize(size);
  await page.waitForTimeout(300);
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
    const editor = document.querySelector('#editor-card .focus-editor__content');
    editor.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    editor.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    const p = document.querySelectorAll('#editor-card .focus-editor__content p')[30];
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
    const editor = document.querySelector('#editor-card .focus-editor__content');
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
    const el = document.querySelector('#editor-card .focus-editor__content');
    el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
  });
  await page.waitForTimeout(50);
  expect(await page.locator('.focus-paragraph-active').count()).toBe(0);

  // Focus simuliert Modal-Close → Markierung wieder da.
  await page.evaluate(() => {
    const el = document.querySelector('#editor-card .focus-editor__content');
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
