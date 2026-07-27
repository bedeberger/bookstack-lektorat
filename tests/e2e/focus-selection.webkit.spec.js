// Textselektion im Fokus-Editor unter WebKit (Safari/iOS/WKWebView).
//
// Warum eine eigene Browser-Engine dafür: WebKit macht die Selektion in einem
// contenteditable kaputt, sobald `padding-top + padding-bottom >= clientHeight`
// der Scroll-Box ist. Doppelklick selektiert dann nicht das Wort, sondern zieht
// vom Klickpunkt bis zum Absatzende; ein Zieh-Select liefert eine leere
// Selektion. Genau diese Summe war im Fokus-Editor exakt 100vh
// (`--focus-vh × Anker` Kopf + `100vh − --focus-vh × Anker` Tail), in der SPA
// wegen der Topbar sogar über der Box-Höhe. Chromium ist nicht betroffen — die
// bestehenden Specs waren grün, während Safari unbenutzbar war.
//
// Der Fix leitet den Tail aus `--focus-box-h` (gemessene clientHeight,
// focus/viewport.js) ab und zieht 4 px Epsilon ab. Die drei Tests hier decken
// die Ursache (Padding-Summe) und beide Symptome (Doppelklick, Drag) ab.

const { test, expect } = require('./_helpers/fixtures');

const HARNESS = '/tests/fixtures/focus-harness.html';
const EDITOR = '#editor-card .focus-editor__content';

async function enter(page) {
  await page.evaluate(() => { window.harness.editMode = true; window.harness.enterFocusMode(); });
  await page.waitForFunction(() => window.harness._focusListeners !== null);
  // Focus-Entry recentert per RAF — auf stabilen Scroll-Zustand warten.
  await page.waitForTimeout(50);
}

// Client-Rect eines Wortes in einem Absatz, der komfortabel im sichtbaren
// Bereich liegt. Bewusst nicht „Absatz N": nach dem Recenter hängt es vom
// Anker ab, welche Absätze überhaupt sichtbar sind.
async function wordRect(page, word) {
  return page.evaluate(({ sel, word }) => {
    const box = document.querySelector(sel);
    const boxRect = box.getBoundingClientRect();
    for (const p of box.querySelectorAll('p')) {
      const node = p.firstChild;
      if (!node || node.nodeType !== 3) continue;
      const idx = node.nodeValue.indexOf(word);
      if (idx < 0) continue;
      const r = document.createRange();
      r.setStart(node, idx);
      r.setEnd(node, idx + word.length);
      const rect = r.getBoundingClientRect();
      // 40 px Rand, damit der Klick nicht am Kachelrand des Viewports landet.
      if (rect.height > 0 && rect.top > boxRect.top + 40 && rect.bottom < boxRect.bottom - 40) {
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
                 left: rect.left, right: rect.right, text: node.nodeValue };
      }
    }
    return null;
  }, { sel: EDITOR, word });
}

test.beforeEach(async ({ page }) => {
  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.harnessReady === true);
  await enter(page);
});

test('Padding-Summe der Schreibfläche bleibt unter der clientHeight (WebKit-Selektions-Schwelle)', async ({ page }) => {
  const m = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const cs = getComputedStyle(el);
    return {
      pt: parseFloat(cs.paddingTop),
      pb: parseFloat(cs.paddingBottom),
      client: el.clientHeight,
      boxVar: getComputedStyle(document.documentElement).getPropertyValue('--focus-box-h').trim(),
    };
  }, EDITOR);
  // focus/viewport.js muss die gemessene Box-Höhe publiziert haben — ohne sie
  // greift der CSS-Fallback 100vh und die Summe landet wieder auf der Schwelle.
  expect(m.boxVar).toMatch(/^\d+(\.\d+)?px$/);
  expect(parseFloat(m.boxVar)).toBeCloseTo(m.client, 0);
  expect(m.pt + m.pb).toBeLessThan(m.client);
  // Der Tail darf nur um das Epsilon zu kurz sein, sonst klemmt Invariante 9
  // (letzte Zeile erreicht den Anker) — max. eine halbe Zeilenhöhe.
  expect(m.client - (m.pt + m.pb)).toBeLessThanOrEqual(8);
});

test('Doppelklick selektiert genau das Wort, nicht bis zum Absatzende', async ({ page }) => {
  const r = await wordRect(page, 'consectetur');
  expect(r).not.toBeNull();
  await page.mouse.dblclick(r.x, r.y);
  const sel = await page.evaluate(() => getSelection().toString());
  expect(sel.trim()).toBe('consectetur');
});

test('Zieh-Selektion über ein Wort liefert eine nicht-leere Selektion', async ({ page }) => {
  const r = await wordRect(page, 'consectetur');
  expect(r).not.toBeNull();
  await page.mouse.move(r.left, r.y);
  await page.mouse.down();
  await page.mouse.move(r.right, r.y, { steps: 8 });
  await page.mouse.up();
  const sel = await page.evaluate(() => getSelection().toString());
  expect(sel.length).toBeGreaterThan(0);
  expect(r.text).toContain(sel.trim());
});
