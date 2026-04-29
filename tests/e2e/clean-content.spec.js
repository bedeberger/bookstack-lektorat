const { test, expect } = require('@playwright/test');

test('cleanContentArtefacts strips paste artefacts but keeps structure + img styles', async ({ page }) => {
  await page.goto('http://localhost:8765/tests/fixtures/focus-harness.html');
  await page.addScriptTag({
    type: 'module',
    content: `import { cleanContentArtefacts } from '/public/js/utils.js';
              window.__clean = cleanContentArtefacts;`,
  });
  await page.waitForFunction(() => typeof window.__clean === 'function');

  const sample = `<div class="poem" id="bkmrk-x"><p id="bkmrk-y" style="margin:0.4em 0px;color:rgb(51,51,51);font-family:Lato, 'Lato Fallback', sans-serif;font-style:normal;white-space:normal;"><span style="white-space:pre-wrap;">Beiss nicht gleich in jeden Apfel </span><br><span style="white-space:pre-wrap;">Er könnte sauer sein </span><br>Fällt man leicht herein</p></div>`;

  const cleaned = await page.evaluate(s => window.__clean(s), sample);
  console.log('CLEANED:', cleaned);

  expect(cleaned).toContain('class="poem"');
  expect(cleaned).toContain('Beiss nicht gleich in jeden Apfel');
  expect(cleaned).not.toContain('Lato');
  expect(cleaned).not.toMatch(/<p[^>]*style=/);
  expect(cleaned).not.toMatch(/<span[^>]*style=/);

  const twice = await page.evaluate(s => window.__clean(window.__clean(s)), sample);
  expect(twice).toBe(cleaned);

  const img = '<img src="x.png" style="width:300px;height:auto"><p style="color:red">x</p>';
  const cleanImg = await page.evaluate(s => window.__clean(s), img);
  console.log('IMG:', cleanImg);
  expect(cleanImg).toContain('width:300px');
  expect(cleanImg).not.toMatch(/<p[^>]*style=/);

  const meta = '<meta charset="utf-8"><p>hi</p>';
  const cleanMeta = await page.evaluate(s => window.__clean(s), meta);
  expect(cleanMeta).not.toContain('<meta');
  expect(cleanMeta).toContain('<p>hi</p>');
});

test('collapseEmptyBlocks reduces empty paragraph + br runs to one', async ({ page }) => {
  await page.goto('http://localhost:8765/tests/fixtures/focus-harness.html');
  await page.addScriptTag({
    type: 'module',
    content: `import { collapseEmptyBlocks } from '/public/js/utils.js';
              window.__collapse = collapseEmptyBlocks;`,
  });
  await page.waitForFunction(() => typeof window.__collapse === 'function');

  // Run mehrerer leerer Absätze → einer bleibt
  const multi = '<p>foo</p><p></p><p><br></p><p>&nbsp;</p><p>bar</p>';
  const r1 = await page.evaluate(s => window.__collapse(s), multi);
  expect(r1).toBe('<p>foo</p><p></p><p>bar</p>');

  // Einzelner Leerblock zwischen Inhalt bleibt erhalten
  const single = '<p>a</p><p></p><p>b</p>';
  const r2 = await page.evaluate(s => window.__collapse(s), single);
  expect(r2).toBe('<p>a</p><p></p><p>b</p>');

  // <br><br> innerhalb <p> → ein <br>
  const inlineBr = '<p>foo<br><br>bar</p>';
  const r3 = await page.evaluate(s => window.__collapse(s), inlineBr);
  expect(r3).toBe('<p>foo<br>bar</p>');

  // Top-Level <br><br> + leerer <p> als gemischter Run
  const mixed = '<p>x</p><br><br><p></p><p>y</p>';
  const r4 = await page.evaluate(s => window.__collapse(s), mixed);
  expect(r4).toBe('<p>x</p><br><p>y</p>');

  // Idempotent
  const r5 = await page.evaluate(s => window.__collapse(window.__collapse(s)), multi);
  expect(r5).toBe(r1);

  // Inhalt unangetastet
  const clean = '<p>a</p><p>b</p><p>c</p>';
  const r6 = await page.evaluate(s => window.__collapse(s), clean);
  expect(r6).toBe(clean);
});
