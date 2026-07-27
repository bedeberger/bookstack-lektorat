// E2E für den Focus-Editor in einer Schale mit feindlichem Host-CSS
// (tests/fixtures/shell-host-harness.html): der Scroll liegt auf einem Vorfahr
// statt auf dem contenteditable, und die Schale hat `scroll-behavior: smooth`.
//
// Warum eine eigene Ebene: focus-harness.html lädt die Bundle-CSS-Dateien und
// prüft damit immer die heile Konstellation. macOS- und Android-Client bringen
// aber eigenes Boot-CSS mit, das unlayered jede Regel aus focus-mode.css
// (`@layer components`) schlägt — Brüche dort fielen bisher erst im
// ausgelieferten OTA-Bundle auf.

const { test, expect } = require('./_helpers/fixtures');

const HARNESS = '/tests/fixtures/shell-host-harness.html';
const BOX = '#shell-scroll';
const CONTENT = '.focus-editor__content';

test.beforeEach(async ({ page }) => {
  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.shellReady === true);
});

async function placeCaretInParagraph(page, idx) {
  await page.evaluate((i) => {
    const p = document.querySelectorAll('.focus-editor__content p')[i];
    const range = document.createRange();
    range.selectNodeContents(p);
    range.collapse(true);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.querySelector('.focus-editor__content').focus();
  }, idx);
}

test('Scroll-Box wird auf den Vorfahr aufgelöst, nicht auf das contenteditable', async ({ page }) => {
  // Grundlage für alles Weitere: `resolveScrollBox` erkennt, dass das
  // contenteditable hier gar nicht scrollen kann, und benennt den Schalen-
  // Scroller. Daran hängen Typewriter-Ziel, IntersectionObserver-Root und der
  // Abgleich der prog-Scroll-Marke.
  const resolved = await page.evaluate(() => {
    const ctx = window.__standalone.controller._focusListeners;
    const content = document.querySelector('.focus-editor__content');
    return {
      isShellScroll: ctx.scrollBox === document.getElementById('shell-scroll'),
      isContent: ctx.scrollBox === content,
      contentCanScroll: content.scrollHeight > content.clientHeight + 1,
    };
  });
  expect(resolved.contentCanScroll).toBe(false);
  expect(resolved.isContent).toBe(false);
  expect(resolved.isShellScroll).toBe(true);
});

test('Typewriter scrollt den Vorfahr — synchron trotz scroll-behavior:smooth', async ({ page }) => {
  // Zwei Aussagen in einem Test, weil sie dieselbe Ursache haben: der Scroll
  // muss (a) überhaupt am Vorfahr ankommen und (b) `behavior: 'instant'`
  // verwenden. Mit `'auto'` (oder der Kurzform) delegiert der Aufruf laut
  // CSSOM-View an die CSS-Property, der Scroll animiert, `scrollTop` steht
  // direkt danach noch auf dem Altwert → gefahrene Strecke 0 → KEINE
  // prog-Scroll-Marke → das eigene scroll-Event gilt später als User-Scroll und
  // reisst das Spotlight weg. Die gesetzte Marke ist damit der Beweis für den
  // synchronen Scroll.
  await page.evaluate((sel) => { document.querySelector(sel).scrollTo({ top: 0, behavior: 'instant' }); }, BOX);
  await placeCaretInParagraph(page, 30);
  await page.keyboard.type('x');
  await page.waitForTimeout(200);

  const state = await page.evaluate((sel) => {
    const ctx = window.__standalone.controller._focusListeners;
    return {
      boxScrollTop: document.querySelector(sel).scrollTop,
      contentScrollTop: document.querySelector('.focus-editor__content').scrollTop,
      // Die Marke wird beim nächsten scroll-Event verbraucht; sie kann hier also
      // schon konsumiert sein. Entscheidend ist, dass die Box gescrollt hat.
      markBoxIsShell: !ctx.progScroll || ctx.progScroll.box === document.querySelector(sel),
    };
  }, BOX);

  expect(state.boxScrollTop).toBeGreaterThan(200);
  expect(state.contentScrollTop).toBe(0);
  expect(state.markBoxIsShell).toBe(true);
});

test('Lese-Scroll am Vorfahr verschiebt das Spotlight', async ({ page }) => {
  // Der Kern-Regress: der scroll-Listener hing früher am contenteditable. In
  // dieser Schale feuert das Event aber am Vorfahr — `preferCenter` lief nie und
  // das Spotlight blieb beim Blättern auf dem Caret-Absatz stehen. Jetzt hängt
  // der Listener am document (Capture-Phase) und filtert auf Boxen, die den
  // Editor enthalten.
  await placeCaretInParagraph(page, 0);
  await page.waitForTimeout(80);
  const before = await page.evaluate(() =>
    document.querySelector('.focus-paragraph-active')?.textContent || '');
  expect(before).toContain('Absatz 0');

  // Echter Lese-Scroll. `behavior: 'instant'` bildet den User-Scroll korrekt ab:
  // Wheel/Touch sind von `scroll-behavior` nicht betroffen, nur programmatische
  // Scrolls ohne explizites Verhalten.
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    el.scrollTo({ top: Math.round(el.scrollHeight * 0.55), behavior: 'instant' });
  }, BOX);
  await page.waitForTimeout(200);

  const { activeText, centerText } = await page.evaluate((contentSel) => {
    const content = document.querySelector(contentSel);
    const active = content.querySelector('.focus-paragraph-active');
    // Erwartung unabhängig nachrechnen: welcher Absatz liegt der Mitte des
    // sichtbaren Bildschirms am nächsten?
    const centerY = window.innerHeight / 2;
    let best = null, bestDist = Infinity;
    for (const p of content.querySelectorAll('p')) {
      const r = p.getBoundingClientRect();
      if (r.height <= 0) continue;
      const d = Math.abs((r.top + r.bottom) / 2 - centerY);
      if (d < bestDist) { bestDist = d; best = p; }
    }
    return { activeText: active?.textContent || '', centerText: best?.textContent || '' };
  }, CONTENT);

  expect(activeText).not.toBe('');
  expect(activeText).not.toContain('Absatz 0');
  expect(activeText).toBe(centerText);
});
