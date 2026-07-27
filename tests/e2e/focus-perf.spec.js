// Perf-Regressionsgates für den Focus-Editor-Hotpath (_focusUpdateActive,
// RAF-coalesced pro Frame). Der Editor-Code ist SSoT für Web-SPA UND den
// nativen macOS-Client (WKWebView, OTA-Bundle) — pro Keystroke unnötige
// Layout-Reads / DOM-Mutationen schlagen dort als CPU-Last durch. Diese Tests
// pinnen fest, dass beim Tippen im selben Block NICHT pro Keystroke ein
// Style-Recalc erzwungen, das near-Set neu geschrieben oder ein Intl.Segmenter
// neu gebaut wird.

const { test, expect } = require('./_helpers/fixtures');

const HARNESS = '/tests/fixtures/focus-harness.html';

async function enter(page) {
  await page.evaluate(() => { window.harness.editMode = true; window.harness.enterFocusMode(); });
  await page.waitForFunction(() => window.harness._focusListeners !== null);
  await page.waitForTimeout(50);
}
async function placeCaretInParagraph(page, idx) {
  await page.evaluate((i) => {
    const p = document.querySelectorAll('#editor-card .focus-editor__content p')[i];
    const range = document.createRange();
    range.selectNodeContents(p); range.collapse(true);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
  }, idx);
}

test.beforeEach(async ({ page }) => {
  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.harnessReady === true);
});

// P1: dynamicTypewriterThreshold ist pro Block gecacht (cachedTypewriterThreshold)
// → getComputedStyle läuft nur beim ersten Tick eines Blocks, nicht pro Keystroke.
test('P1: getComputedStyle nicht pro Keystroke bei gleichem Block', async ({ page }) => {
  await enter(page);
  await placeCaretInParagraph(page, 2);
  const gcsCalls = await page.evaluate(async () => {
    const orig = window.getComputedStyle;
    let n = 0;
    window.getComputedStyle = function (...a) { n++; return orig.apply(this, a); };
    for (let i = 0; i < 10; i++) {
      window.harness._focusUpdateActive(true);
      await new Promise(r => requestAnimationFrame(r));
    }
    window.getComputedStyle = orig;
    return n;
  });
  expect(gcsCalls).toBeLessThanOrEqual(1);
});

// P2: setNearBlocks ist idempotent → bei unverändertem Block keine class-Mutation
// (kein Style-/Paint-Invalidieren pro Keystroke). window-3-Granularität.
test('P2: setNearBlocks idempotent, keine near-Mutation pro Keystroke', async ({ page }) => {
  await page.evaluate(() => { window.harness.focusGranularity = 'window-3'; });
  await enter(page);
  await placeCaretInParagraph(page, 3);
  await page.evaluate(() => window.harness._focusUpdateActive(false));
  await page.waitForTimeout(30);

  const mutations = await page.evaluate(async () => {
    const container = window.harness._focusListeners.container;
    let count = 0;
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'attributes' && m.attributeName === 'class') count++;
      }
    });
    mo.observe(container, { attributes: true, attributeFilter: ['class'], subtree: true });
    for (let i = 0; i < 8; i++) {
      window.harness._focusUpdateActive(true);
      await new Promise(r => requestAnimationFrame(r));
    }
    await new Promise(r => setTimeout(r, 20));
    mo.disconnect();
    return count;
  });
  expect(mutations).toBe(0);
});

// P3: Intl.Segmenter ist modul-gecacht (pro Locale einmal) → kein Neubau pro
// Keystroke im Satz-Modus.
test('P3: Intl.Segmenter nicht pro Keystroke neu konstruiert', async ({ page }) => {
  await page.evaluate(() => { window.harness.focusGranularity = 'sentence'; });
  await enter(page);
  await placeCaretInParagraph(page, 2);
  // Warm-up-Tick vor der Messung: beim Fokus-Eintritt sitzt der Caret im leeren
  // Auto-<p>-Slot, dort segmentiert nichts (findSentenceRanges('') → []). Der
  // Erstbau des Segmenters fällt also auf den ersten Tick mit Caret in einem
  // nicht-leeren Block — ohne diesen expliziten Tick wäre das der asynchrone
  // selectionchange-Tick, der je nach Maschinenlast in die Messschleife rutscht.
  await page.evaluate(() => window.harness._focusUpdateActive(false));
  await page.waitForTimeout(30);
  const ctorCalls = await page.evaluate(async () => {
    const Orig = Intl.Segmenter;
    let n = 0;
    Intl.Segmenter = function (...a) { n++; return new Orig(...a); };
    Intl.Segmenter.prototype = Orig.prototype;
    for (let i = 0; i < 10; i++) {
      window.harness._focusUpdateActive(false);
      await new Promise(r => requestAnimationFrame(r));
    }
    Intl.Segmenter = Orig;
    return n;
  });
  expect(ctorCalls).toBe(0);
});

// P4: `.focus-paragraph-near` wird ausserhalb von window-3 gar nicht erst
// gesucht. Der Recenter ruft `applyBlockMarks` bewusst jeden Tick auf (Defense
// gegen Ghost-Klassen aus dem Chromium-Split-Bug) — in paragraph/sentence/
// typewriter-only gibt es aber nie near-Marks, der Vollscan über den ganzen
// Baum wäre also pro Keystroke reine Verschwendung. `ctx._marks.near` merkt
// sich, ob überhaupt welche hängen.
test('P4: kein near-Vollscan pro Keystroke im paragraph-Modus', async ({ page }) => {
  await enter(page);
  await placeCaretInParagraph(page, 10);
  await page.waitForTimeout(80);

  await page.evaluate(() => {
    window.__nearScans = 0;
    const orig = Element.prototype.querySelectorAll;
    window.__origQSA = orig;
    Element.prototype.querySelectorAll = function (sel) {
      if (sel === '.focus-paragraph-near') window.__nearScans++;
      return orig.call(this, sel);
    };
  });

  await page.keyboard.type('abcdef');
  await page.waitForTimeout(200);

  const scans = await page.evaluate(() => {
    Element.prototype.querySelectorAll = window.__origQSA;
    return window.__nearScans;
  });
  expect(scans).toBe(0);
});

// Gegenprobe: in window-3 MUSS weiter gescannt werden — sonst blieben die
// Nachbar-Marks beim Blockwechsel stehen.
test('P4b: window-3 scannt weiterhin (Nachbar-Marks bleiben korrekt)', async ({ page }) => {
  await enter(page);
  await page.evaluate(() => {
    window.harness.focusGranularity = 'window-3';
    window.harness.applyFocusGranularity('window-3');
  });
  await placeCaretInParagraph(page, 10);
  await page.waitForTimeout(80);

  await page.evaluate(() => {
    window.__nearScans = 0;
    const orig = Element.prototype.querySelectorAll;
    window.__origQSA = orig;
    Element.prototype.querySelectorAll = function (sel) {
      if (sel === '.focus-paragraph-near') window.__nearScans++;
      return orig.call(this, sel);
    };
  });

  await placeCaretInParagraph(page, 20);
  await page.waitForTimeout(150);

  const out = await page.evaluate(() => {
    Element.prototype.querySelectorAll = window.__origQSA;
    const near = [...document.querySelectorAll('.focus-paragraph-near')];
    const active = document.querySelector('.focus-paragraph-active');
    return {
      scans: window.__nearScans,
      nearCount: near.length,
      neighbours: near.every(el =>
        el === active?.previousElementSibling || el === active?.nextElementSibling),
    };
  });
  expect(out.scans).toBeGreaterThan(0);
  expect(out.nearCount).toBe(2);
  expect(out.neighbours).toBe(true);
});
