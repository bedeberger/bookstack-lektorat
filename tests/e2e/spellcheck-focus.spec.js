// E2E: Spellcheck-Controller im Focus-Editor-Setup.

const { test, expect } = require('./_helpers/fixtures');

const HARNESS = '/tests/fixtures/spellcheck-harness.html?kind=focus';

async function squiggleCount(page) {
  return page.evaluate(() => {
    return ['lt-typo', 'lt-grammar', 'lt-style'].reduce((sum, k) => {
      const h = CSS.highlights.get(k);
      return sum + (h ? h.size : 0);
    }, 0);
  });
}

async function waitForSquiggles(page, timeout = 5000) {
  await page.waitForFunction(() => {
    return ['lt-typo', 'lt-grammar', 'lt-style'].some((k) => {
      const h = CSS.highlights.get(k);
      return h && h.size > 0;
    });
  }, null, { timeout });
}

async function clickFirstSquiggle(page) {
  const pt = await page.evaluate(() => {
    for (const k of ['lt-typo', 'lt-grammar', 'lt-style']) {
      const h = CSS.highlights.get(k);
      if (!h || !h.size) continue;
      const range = h.values().next().value;
      const r = range.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    return null;
  });
  if (!pt) throw new Error('no squiggle present');
  await page.mouse.click(pt.x, pt.y);
}

test('focus: squiggle erscheint, badge sichtbar', async ({ page }) => {
  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__harnessReady === true);
  await waitForSquiggles(page);
  await page.waitForSelector('.lt-badge[data-editor="focus"]');
});

test('focus: ignore entfernt squiggle bis zur naechsten Pruefung', async ({ page }) => {
  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__harnessReady === true);
  await waitForSquiggles(page);
  const initial = await squiggleCount(page);
  await clickFirstSquiggle(page);
  await page.waitForSelector('.lt-popover');
  await page.locator('.lt-popover__ignore').click();
  await expect.poll(() => squiggleCount(page)).toBeLessThan(initial);
});

test('focus: ersetzung am absatz-ende lässt caret IM absatz (kein sprung in den leeren folge-<p>)', async ({ page }) => {
  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__harnessReady === true);
  const res = await page.evaluate(() => {
    const root = document.getElementById('editor');
    // Typo als LETZTES Wort im Absatz + leerer Folge-<p> (wie der Focus-Auto-
    // Trailing-Slot). Genau diese Geometrie liess den Caret früher hinter den
    // Absatz in den leeren <p> rutschen (setStartAfter(range.endContainer) →
    // Boundary auf <p> → Caret nach dem Block → Normalisierung in den nächsten).
    root.innerHTML = '<p>Das ist wunderbra</p><p><br></p>';
    const paras = Array.from(root.querySelectorAll('p'));
    const tn = paras[0].firstChild;
    const range = document.createRange();
    range.setStart(tn, 'Das ist '.length);
    range.setEnd(tn, tn.length);
    window.__applySpellcheckReplacement(range, 'wunderbar');
    const sel = window.getSelection();
    const n = sel.anchorNode;
    const el = n && (n.nodeType === 3 ? n.parentElement : n);
    const block = el && el.closest('p');
    return {
      firstText: paras[0].textContent,
      caretInFirstParagraph: block === paras[0],
      caretInTrailingEmpty: block === paras[1],
    };
  });
  expect(res.firstText).toBe('Das ist wunderbar');
  expect(res.caretInFirstParagraph).toBe(true);
  expect(res.caretInTrailingEmpty).toBe(false);
});

// Der Focus-Editor haengt seinen eigenen Escape-Handler (Exit Fokus-Modus /
// cancelEdit) an `window` in der Bubble-Phase (editor/focus/card.js). Der
// Popover-Handler laeuft in der Capture-Phase auf `document` und stoppt die
// Propagation — erstes Escape schliesst nur den Popover, zweites wirkt normal.
test('focus: erstes escape schliesst nur popover, zweites erreicht den editor-handler', async ({ page }) => {
  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__harnessReady === true);
  await waitForSquiggles(page);
  await page.evaluate(() => {
    window.__escHits = 0;
    // Stellvertreter fuer card.js#onKey: window, Bubble-Phase.
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') window.__escHits++;
    });
  });
  await clickFirstSquiggle(page);
  await page.waitForSelector('.lt-popover');

  await page.keyboard.press('Escape');
  await expect.poll(() => page.locator('.lt-popover').count()).toBe(0);
  expect(await page.evaluate(() => window.__escHits)).toBe(0);

  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => window.__escHits)).toBe(1);
});

// Waisen-Knoten: eine Kopie des Popovers, die kein Controller mehr kennt (aus
// Enter-Split/Undo/geladenem HTML). Sie ist per Definition unschliessbar — darum
// raeumt jedes _openPopover und jedes attach() ALLE Popover im Root weg.
test('focus: waisen-popover wird beim naechsten oeffnen weggeraeumt', async ({ page }) => {
  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__harnessReady === true);
  await waitForSquiggles(page);
  await page.evaluate(() => {
    const orphan = document.createElement('div');
    orphan.className = 'lt-popover';
    orphan.setAttribute('contenteditable', 'false');
    orphan.textContent = 'Waise';
    document.getElementById('editor').appendChild(orphan);
  });
  expect(await page.locator('.lt-popover').count()).toBe(1);
  await clickFirstSquiggle(page);
  await page.waitForSelector('.lt-popover');
  // Genau einer — der eigene; die Waise ist weg.
  expect(await page.locator('.lt-popover').count()).toBe(1);
  expect(await page.locator('.lt-popover').textContent()).not.toContain('Waise');
  await page.keyboard.press('Escape');
  await expect.poll(() => page.locator('.lt-popover').count()).toBe(0);
});

test('focus: attach raeumt popover-markup aus geladenem HTML (altbestand)', async ({ page }) => {
  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__harnessReady === true);
  await waitForSquiggles(page);
  await page.evaluate(() => {
    window.__spellcheckCtl.detach();
    // Seite mit mitgespeichertem UI-Markup neu geladen.
    document.getElementById('editor').innerHTML =
      '<p>Der Jungen ging in den Walld.</p>'
      + '<div class="lt-popover"><button class="lt-popover__close">x</button></div>'
      + '<div class="lt-badge"><span class="lt-badge__label">2</span></div>';
    window.__spellcheckCtl.attach();
  });
  await expect.poll(() => page.evaluate(
    () => document.getElementById('editor').innerHTML.indexOf('lt-popover') !== -1
  )).toBe(false);
  const saved = await page.evaluate(
    () => window.__stripLektoratMarks(document.getElementById('editor').innerHTML)
  );
  expect(saved).not.toContain('lt-popover');
  expect(saved).not.toContain('lt-badge');
});

test('focus: detach raeumt highlights + badge', async ({ page }) => {
  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__harnessReady === true);
  await waitForSquiggles(page);
  await page.evaluate(() => window.__spellcheckCtl.detach());
  await expect.poll(() => squiggleCount(page)).toBe(0);
  await expect.poll(() => page.locator('.lt-badge').count()).toBe(0);
});
