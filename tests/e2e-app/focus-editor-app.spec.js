// Focus-Editor gegen die ECHTE App (playwright.app.config.js) — die gefuehlten
// Schreib-Invarianten, nicht nur „oeffnet ohne Fehler" (das macht smoke.spec.js).
//
// WARUM DIESE SCHICHT trotz 52 gruener Tests in tests/e2e/focus-editor.spec.js:
// jene laufen gegen tests/fixtures/focus-harness.html mit fuenf CSS-Dateien und
// synthetischem DOM. Die Schreiblinien-Geometrie des Focus-Editors haengt aber an
// der CSS-HOEHENKETTE der echten Shell (Cardroot-Overlay, Topbar, --focus-vh /
// --focus-anchor / --focus-pad-reserve, Puffer-Paddings) und am echten
// Alpine-Template-Baum. Das Harness kann deshalb gruen bleiben, waehrend im
// echten Editor die Schreiblinie abdriftet, die erste/letzte Zeile den Anker nie
// erreicht oder der Container gar nicht mehr scrollt.
//
// Was hier geprueft wird (Invariante 9 der docs/focus-editor.md, aus Autorensicht):
//   1. die Schreibflaeche scrollt ueberhaupt (Hoehenkette intakt)
//   2. die Schreibzeile ruht beim Tippen auf dem Anker (kein Abdriften)
//   3. die ERSTE Zeile erreicht den Anker (Kopf-Puffer)
//   4. die LETZTE Zeile erreicht den Anker (Tail-Puffer)
//   5. Tippen recentert
//   6. manueller Scroll verschiebt das Spotlight auf die Viewport-Mitte
//   7. Exit raeumt Overlay/Chrome ab
//
// Toleranz ueberall = halbe Zeilenhoehe: genau die Schwelle, unter der der
// Typewriter absichtlich nicht nachzieht (typewriter.js, Jitter-Filter).

const { test, expect } = require('@playwright/test');
const { attachConsoleGuard } = require('../e2e/_helpers/console-guard');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const FOCUS = '.focus-editor__content';

// Kein `serial`: jeder Test bootet seine eigene Seite, und ein Fehlschlag soll die
// restlichen Invarianten NICHT verschlucken — der diagnostische Wert liegt darin,
// welche Teilmenge bricht.

// --- Helper -----------------------------------------------------------------

// Bis in den aktiven Fokusmodus: Buch → erste Seite (Notebook-Editor) →
// Trampoline-Event wie der Focus-Button im Page-View-Header.
async function enterFocus(page) {
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(async () => { await window.__app.selectPage(window.Alpine.store('nav').pages[0]); });
  await page.waitForFunction(() => window.__app.showEditorCard === true, null, { timeout: 15000 });

  await page.evaluate(() => window.dispatchEvent(new CustomEvent('editor:focus:enter-from-pageview')));
  await page.waitForFunction(() => {
    const el = document.querySelector('.focus-editor');
    if (!el || !window.Alpine) return false;
    const d = window.Alpine.$data(el);
    return !!d && d._focusState === 'active';
  }, null, { timeout: 15000 });
  // Entry-Recenter (scrollEntryTargetToAnchor) settlen lassen.
  await page.waitForTimeout(200);
}

// Die Seed-Seiten sind zwei Absaetze lang — zu kurz, um Scroll und Tail-Puffer zu
// pruefen. Absaetze direkt an den echten Container haengen (der MutationObserver
// nimmt sie inkrementell auf, genau wie beim Tippen entstandene Bloecke).
// Kein input-Event → editDirty bleibt false → der Exit speichert nichts.
async function seedParagraphs(page, count) {
  await page.evaluate(({ sel, n }) => {
    const el = document.querySelector(sel);
    for (let i = 0; i < n; i++) {
      const p = document.createElement('p');
      p.textContent = `Testabsatz ${i + 1}. ` + 'Nur Fuellwort fuer die Zeilenhoehe. '.repeat(3);
      el.appendChild(p);
    }
  }, { sel: FOCUS, n: count });
  await page.waitForTimeout(150);
}

// Caret in Absatz `idx` (negativ = von hinten). Bewusst IM TEXTKNOTEN, nicht als
// kollabierter Range auf dem <p>: Chromium liefert fuer letzteren keine
// Client-Rects (`getClientRects()` leer, `getBoundingClientRect()` → 0/0/0/0), und
// jede Anker-Messung waere dann stillschweigend Unsinn. Erst eine Ein-Zeichen-
// Auswahl aufziehen und auf ihr Ende kollabieren erzwingt eine echte Zeilen-Box.
async function placeCaret(page, idx) {
  const ok = await page.evaluate(({ sel, i }) => {
    const container = document.querySelector(sel);
    const ps = container.querySelectorAll('p');
    const p = i < 0 ? ps[ps.length + i] : ps[i];
    if (!p) return false;
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    let tn = null;
    while (walker.nextNode()) {
      if (walker.currentNode.length > 1) { tn = walker.currentNode; break; }
    }
    if (!tn) return false;
    container.focus({ preventScroll: true });
    const r = document.createRange();
    r.setStart(tn, Math.min(3, tn.length - 1));
    r.setEnd(tn, Math.min(4, tn.length));
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    s.collapseToEnd();
    return true;
  }, { sel: FOCUS, i: idx });
  if (!ok) throw new Error(`placeCaret(${idx}): kein Absatz mit Textknoten gefunden`);
}

// Ein Recenter-Tick am echten Card-Scope anstossen (wie jeder Caret-Move es tut).
async function recenter(page, scroll = true) {
  await page.evaluate(() => {
    window.Alpine.$data(document.querySelector('.focus-editor'))._focusUpdateActive(true);
  });
  await page.waitForTimeout(scroll ? 250 : 120);
}

// Abstand der Caret-Zeilenmitte zur Schreiblinie, plus Zeilenhoehe als Toleranzmass.
// Bezug ist der sichtbare BILDSCHIRM (visualViewport) x --focus-anchor — dieselbe
// Definition, die typewriter.js#anchorY anfaehrt.
async function caretOffsetFromAnchor(page) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const s = getSelection();
    if (!s || !s.rangeCount) return null;
    const r = s.getRangeAt(0);
    const rect = r.getClientRects()[0] || r.getBoundingClientRect();
    // Ohne echte Zeilen-Box gibt es nichts zu messen — als Fehler melden statt
    // eine 0-Koordinate gegen den Anker zu rechnen (das ergaebe einen
    // plausibel aussehenden, frei erfundenen Abstand).
    if (!(rect.height > 0)) return { invalid: true };
    const cs = getComputedStyle(el);
    const ratio = parseFloat(cs.getPropertyValue('--focus-anchor'));
    const vvTop = window.visualViewport?.offsetTop || 0;
    const vvH = window.visualViewport?.height || window.innerHeight;
    const anchor = vvTop + vvH * (Number.isFinite(ratio) ? ratio : 0.5);
    const box = el.getBoundingClientRect();
    return {
      off: (rect.top + rect.height / 2) - anchor,
      lh: parseFloat(cs.lineHeight) || 24,
      // Diagnose-Kontext: bei einem Fehlschlag soll aus der Meldung ablesbar sein,
      // WARUM die Zeile nicht auf dem Anker liegt (Scroll am Anschlag? Puffer zu
      // kurz? Box an der falschen Stelle?) — sonst beginnt die Suche bei Null.
      anchorY: Math.round(anchor),
      caretY: Math.round(rect.top + rect.height / 2),
      scrollTop: Math.round(el.scrollTop),
      scrollMax: Math.round(el.scrollHeight - el.clientHeight),
      padTop: Math.round(parseFloat(cs.paddingTop)),
      padBottom: Math.round(parseFloat(cs.paddingBottom)),
      boxTop: Math.round(box.top),
      boxHeight: Math.round(box.height),
    };
  }, FOCUS);
}

// Fehlermeldung mit vollem Geometrie-Kontext.
function geom(label, m) {
  return `${label} — off=${Math.round(m.off)} caretY=${m.caretY} anchorY=${m.anchorY} `
       + `scrollTop=${m.scrollTop}/${m.scrollMax} padTop=${m.padTop} padBottom=${m.padBottom} `
       + `box=${m.boxTop}+${m.boxHeight} lh=${Math.round(m.lh)}`;
}

// --- Tests ------------------------------------------------------------------

test('Hoehenkette: die Schreibflaeche scrollt (echtes Shell-CSS)', async ({ page }) => {
  // Regressionsnetz fuer den Klassiker: eine neue Flex-Schicht ohne
  // `min-height: 0` laesst das contenteditable auf Content-Hoehe expandieren →
  // clientHeight == scrollHeight → kein Typewriter-Scroll mehr moeglich. Im
  // Minimal-CSS-Harness unsichtbar, weil dort die Shell-Schichten fehlen.
  const guard = attachConsoleGuard(page);
  await enterFocus(page);
  await seedParagraphs(page, 40);

  const dims = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const r = el.getBoundingClientRect();
    return { client: el.clientHeight, scroll: el.scrollHeight, top: r.top, height: r.height };
  }, FOCUS);

  expect(dims.client, 'Scroll-Box hat echte Hoehe').toBeGreaterThan(200);
  expect(dims.scroll, 'Inhalt ueberragt die Box → scrollbar').toBeGreaterThan(dims.client + 200);
  // Das Overlay sitzt am Bildschirm, nicht irgendwo unterhalb des Dokuments.
  expect(dims.top).toBeLessThan(400);
  guard.assertClean('Hoehenkette');
});

test('Schreiblinie ruht beim Tippen auf dem Anker (kein Abdriften)', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await enterFocus(page);
  await seedParagraphs(page, 40);

  await placeCaret(page, 25);
  await recenter(page);

  // Mehrere Zeilenwechsel: nach jedem Enter+Text muss der Typewriter die
  // Caret-Zeile auf den Anker zurueckholen. Die Ruheposition darf nicht mit
  // jedem Schritt tiefer wandern.
  const offsets = [];
  for (let i = 0; i < 4; i++) {
    await page.evaluate((sel) => {
      document.querySelector(sel).focus();
      document.execCommand('insertParagraph');
      document.execCommand('insertText', false, 'Neue Zeile');
    }, FOCUS);
    await page.waitForTimeout(180);
    offsets.push(await caretOffsetFromAnchor(page));
  }

  for (const [i, m] of offsets.entries()) {
    expect(m?.invalid, `Messung ${i}: Caret-Zeilenbox vorhanden`).toBeFalsy();
    expect(Math.abs(m.off), geom(`Zeilenwechsel ${i + 1}`, m)).toBeLessThanOrEqual(m.lh * 0.5 + 1);
  }
  guard.assertClean('Schreiblinie beim Tippen');
});

// Kopf- und Tail-Puffer sind die Layout-Voraussetzung dafuer, dass die
// Schreibzeile ueber die GANZE Seite auf dem Anker ruht. Beide leiten sich in
// focus-mode.css aus --focus-anchor x --focus-vh ab; genau diese Rechnung sieht
// das Minimal-CSS-Harness nicht.
for (const vp of [
  { label: 'Desktop', viewport: { width: 1280, height: 900 } },
  { label: 'Mobile', viewport: { width: 390, height: 844 } },
]) {
  test(`Erste Zeile erreicht die Schreiblinie — ${vp.label}`, async ({ page }) => {
    // Um die erste Zeile auf den Anker zu senken, braeuchte es negativen Scroll —
    // den gibt es nicht. Also muss der Kopf-Puffer die Strecke abdecken; sonst
    // klemmt scrollTop bei 0 und die Zeile steht zu hoch.
    const guard = attachConsoleGuard(page);
    await page.setViewportSize(vp.viewport);
    await enterFocus(page);
    await seedParagraphs(page, 40);

    await placeCaret(page, 0);
    await recenter(page);

    const m = await caretOffsetFromAnchor(page);
    expect(m?.invalid, 'Caret-Zeilenbox vorhanden').toBeFalsy();
    expect(Math.abs(m.off), geom('erste Zeile auf dem Anker', m)).toBeLessThanOrEqual(m.lh * 0.5 + 1);
    guard.assertClean(`erste Zeile ${vp.label}`);
  });

  test(`Letzte Zeile erreicht die Schreiblinie — ${vp.label}`, async ({ page }) => {
    // Spiegelbild: unter der letzten Zeile muss genug Tail-Puffer scrollbar
    // bleiben, sonst klemmt der Scroll am Anschlag und die letzten Absaetze
    // stehen tiefer als der Anker („man kommt nur bis zum zweitletzten").
    const guard = attachConsoleGuard(page);
    await page.setViewportSize(vp.viewport);
    await enterFocus(page);
    await seedParagraphs(page, 40);

    await placeCaret(page, -1);
    await recenter(page);

    const m = await caretOffsetFromAnchor(page);
    expect(m?.invalid, 'Caret-Zeilenbox vorhanden').toBeFalsy();
    expect(Math.abs(m.off), geom('letzte Zeile auf dem Anker', m)).toBeLessThanOrEqual(m.lh * 0.5 + 1);
    guard.assertClean(`letzte Zeile ${vp.label}`);
  });
}

test('Tippen recentert (Typewriter-Scroll greift)', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await enterFocus(page);
  await seedParagraphs(page, 40);

  // Auf Anschlag oben zuruecksetzen, damit der Recenter messbar ist.
  await page.evaluate((sel) => { document.querySelector(sel).scrollTop = 0; }, FOCUS);
  await page.waitForTimeout(80);
  expect(await page.evaluate((sel) => document.querySelector(sel).scrollTop, FOCUS)).toBe(0);

  await placeCaret(page, 30);
  await page.keyboard.type('x');
  await page.waitForTimeout(300);

  // Bewusst NICHT nur „scrollTop hat sich bewegt": das tut auch der native
  // Caret-Scroll des Browsers, wenn der Typewriter gar nicht laeuft (mit einem
  // abgeschalteten runTypewriter blieb genau diese Fassung des Tests gruen).
  // Gepruefte Eigenschaft ist die Ziel-Geometrie: die getippte Zeile LIEGT auf
  // dem Anker.
  const m = await caretOffsetFromAnchor(page);
  expect(m?.invalid, 'Caret-Zeilenbox vorhanden').toBeFalsy();
  expect(m.scrollTop, 'Tippen weit unten scrollt ueberhaupt').toBeGreaterThan(200);
  expect(Math.abs(m.off), geom('getippte Zeile auf dem Anker', m)).toBeLessThanOrEqual(m.lh * 0.5 + 1);
  guard.assertClean('Tippen recentert');
});

test('Manueller Scroll verschiebt das Spotlight auf die Viewport-Mitte', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await enterFocus(page);
  await seedParagraphs(page, 40);

  // Caret oben halten: bei Caret-first bliebe das Spotlight hier kleben, auch
  // wenn der User weit nach unten scrollt.
  await placeCaret(page, 0);
  await recenter(page, false);

  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    el.scrollTop = Math.round(el.scrollHeight * 0.6);
  }, FOCUS);
  await page.waitForTimeout(200);

  const { activeIdx, centerIdx } = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    // Keine prog-Scroll-Marke → echter User-Scroll, kein Typewriter-Scroll.
    const d = window.Alpine.$data(document.querySelector('.focus-editor'));
    if (d._focusListeners) d._focusListeners.progScroll = null;
    el.dispatchEvent(new Event('scroll'));
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
      const ps = [...el.querySelectorAll('p')];
      const active = el.querySelector('.focus-paragraph-active');
      const cr = el.getBoundingClientRect();
      const centerY = cr.top + cr.height / 2;
      let best = -1;
      let bestDist = Infinity;
      ps.forEach((p, i) => {
        const r = p.getBoundingClientRect();
        const dist = Math.abs((r.top + r.bottom) / 2 - centerY);
        if (dist < bestDist) { bestDist = dist; best = i; }
      });
      resolve({ activeIdx: active ? ps.indexOf(active) : -1, centerIdx: best });
    })));
  }, FOCUS);

  expect(activeIdx, 'Spotlight nicht mehr beim Caret-Absatz').toBeGreaterThan(0);
  expect(Math.abs(activeIdx - centerIdx), 'Spotlight folgt der Viewport-Mitte').toBeLessThanOrEqual(1);
  guard.assertClean('manueller Scroll');
});

test('Exit raeumt Overlay + Chrome ab', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await enterFocus(page);

  await expect(page.locator('body')).toHaveClass(/focus-mode/);
  await expect(page.locator('.focus-editor')).toHaveClass(/is-active/);

  await page.evaluate(() => window.dispatchEvent(new CustomEvent('editor:focus:exit')));
  await page.waitForFunction(() => {
    const d = window.Alpine.$data(document.querySelector('.focus-editor'));
    return d._focusState === 'idle';
  }, null, { timeout: 15000 });
  await page.waitForTimeout(200);

  await expect(page.locator('body')).not.toHaveClass(/focus-mode/);
  const state = await page.evaluate(() => ({
    focusActive: window.__app.focusActive,
    listeners: window.Alpine.$data(document.querySelector('.focus-editor'))._focusListeners,
    marks: document.querySelectorAll('.focus-paragraph-active, .focus-paragraph-near').length,
  }));
  expect(state.focusActive).toBe(false);
  expect(state.listeners, 'Listener-Kontext abgeraeumt').toBeNull();
  expect(state.marks, 'keine Restmarkierungen').toBe(0);
  guard.assertClean('Exit');
});
