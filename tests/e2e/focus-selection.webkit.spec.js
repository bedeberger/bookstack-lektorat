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

// Zweite WebKit-Eigenheit derselben Familie: `caretPositionFromPoint` ignoriert
// das x, sobald der Punkt UNTER der letzten Zeilenbox eines Absatzes liegt — im
// Halb-Leading, das `line-height: 1.85` unten stehen lässt. Zurück kommt dann
// das Absatzende, auch bei einem Klick ganz links. Der Gutter-Klick
// (resolveGutterCaretPoint) clampt deshalb in die Zeilenbox statt in die
// Block-Rect. Chromium ist nicht betroffen; der Test gehört darum hierher.
test('Gutter-Klick im unteren Halb-Leading setzt den Caret an den Zeilenanfang', async ({ page }) => {
  const probe = await page.evaluate((sel) => {
    const box = document.querySelector(sel);
    const boxRect = box.getBoundingClientRect();
    for (const p of box.querySelectorAll('p')) {
      const node = p.firstChild;
      if (!node || node.nodeType !== 3) continue;
      const pr = p.getBoundingClientRect();
      // Absatz komfortabel im Bild, sonst scrollt der Klick das Ziel weg.
      if (!(pr.top > boxRect.top + 60 && pr.bottom < boxRect.bottom - 60)) continue;
      const r = document.createRange();
      r.selectNodeContents(p);
      const lines = Array.from(r.getClientRects()).filter((l) => l.height > 0);
      if (!lines.length) continue;
      const last = lines[lines.length - 1];
      // Der Leading-Streifen unter der letzten Zeile — die Bug-Zone.
      const strip = pr.bottom - last.bottom;
      if (!(strip >= 3)) continue;
      // Offset des ersten Zeichens der letzten Zeile (Erwartung für den Caret).
      let lineStart = null;
      for (let i = 0; i < node.nodeValue.length; i++) {
        const cr = document.createRange();
        cr.setStart(node, i);
        cr.setEnd(node, i + 1);
        const cb = cr.getBoundingClientRect();
        if (cb.height > 0 && cb.top >= last.top - 1) { lineStart = i; break; }
      }
      if (lineStart === null) continue;
      return {
        // 1 px innerhalb des Streifens, 8 px vom linken Overlay-Rand: das ist
        // Container-Padding, also der Gutter-Pfad (target === container).
        x: boxRect.left + 8,
        y: pr.bottom - 1,
        lineStart,
        len: node.nodeValue.length,
        lastTop: last.top,
        lastBottom: last.bottom,
      };
    }
    return null;
  }, EDITOR);
  expect(probe, 'Absatz mit Leading-Streifen unter der letzten Zeile gefunden').not.toBeNull();
  expect(probe.lineStart).toBeGreaterThan(0);   // mehrzeilig, Zeilenanfang ≠ Absatzanfang

  await page.mouse.click(probe.x, probe.y);

  const caret = await page.evaluate((sel) => {
    const s = getSelection();
    if (!s || !s.anchorNode) return null;
    const box = document.querySelector(sel);
    return {
      inside: box.contains(s.anchorNode),
      offset: s.anchorOffset,
      collapsed: s.isCollapsed,
    };
  }, EDITOR);
  expect(caret).not.toBeNull();
  expect(caret.inside).toBe(true);
  expect(caret.collapsed).toBe(true);
  // Der Bug: Caret landet am Absatzende statt am Anfang der letzten Zeile.
  expect(caret.offset).toBeLessThan(probe.len);
  // ±1, weil das Leerzeichen am Ende der Vorzeile je nach Affinität mitzählt.
  expect(Math.abs(caret.offset - probe.lineStart)).toBeLessThanOrEqual(1);
});
