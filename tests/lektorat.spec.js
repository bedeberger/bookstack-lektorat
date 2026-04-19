const { test, expect } = require('@playwright/test');

const HARNESS = '/tests/fixtures/lektorat-harness.html';

async function loadHarness(page, scenario) {
  const url = scenario ? `${HARNESS}?scenario=${scenario}` : HARNESS;
  await page.request.post('http://localhost:8765/__mock/reset');
  await page.goto(url);
  await page.waitForFunction(() => window.harnessReady === true);
}

async function waitUntil(page, predSource, timeoutMs = 3000) {
  await page.evaluate(([src, t]) => window.harness.waitUntil(src, t), [predSource, timeoutMs]);
}

async function state(page, getter) {
  return page.evaluate((src) => {
    const fn = new Function('h', 'return (' + src + ')(h);');
    return fn(window.harness);
  }, getter);
}

test.describe('Lektorat-Flow', () => {
  test('runCheck: Findings erscheinen, correctedHtml ersetzt Fehler', async ({ page }) => {
    await loadHarness(page, 'ok');
    await page.evaluate(() => window.harness.runCheck());

    await waitUntil(page, 'h => h.checkDone === true');

    // Drei Findings (2 hart + 1 weich), Default-Selektion: nur hart.
    const snap = await state(page, `h => ({
      findings: h.lektoratFindings.length,
      selected: h.selectedFindings.slice(),
      hasErrors: h.hasErrors,
      originalHtml: h.originalHtml,
      correctedHtml: h.correctedHtml,
      renderedPageHtml: h.renderedPageHtml,
    })`);

    expect(snap.findings).toBe(3);
    expect(snap.hasErrors).toBe(true);

    // Harte Findings (rechtschreibung, grammatik) sind vorausgewählt;
    // weiches Finding (wiederholung) nicht.
    const types = await state(page, 'h => h.lektoratFindings.map(f => f.typ)');
    for (let i = 0; i < types.length; i++) {
      const isHard = types[i] === 'rechtschreibung' || types[i] === 'grammatik';
      expect(snap.selected[i]).toBe(isHard);
    }

    // correctedHtml hat beide harten Korrekturen angewendet, weiches Finding nicht.
    expect(snap.correctedHtml).toContain('Wald');
    expect(snap.correctedHtml).toContain('scheint');
    expect(snap.correctedHtml).not.toContain('Walld');
    expect(snap.correctedHtml).not.toContain('scheinet');

    // renderedPageHtml enthält Mark-Tags für alle Findings.
    expect(snap.renderedPageHtml).toMatch(/<mark class="lektorat-mark/);
    const markCount = (snap.renderedPageHtml.match(/<mark class="lektorat-mark/g) || []).length;
    expect(markCount).toBe(3);
  });

  test('toggleFinding: weiches Finding aktivieren fügt Korrektur zu correctedHtml hinzu', async ({ page }) => {
    await loadHarness(page, 'ok');
    await page.evaluate(() => window.harness.runCheck());
    await waitUntil(page, 'h => h.checkDone === true');

    const weichIdx = await state(page, `h => h.lektoratFindings.findIndex(f => f.typ === 'wiederholung')`);
    expect(weichIdx).toBeGreaterThanOrEqual(0);

    const before = await state(page, 'h => h.correctedHtml');
    expect(before).toContain('Die Sonne');

    await page.evaluate((i) => window.harness.toggleFinding(i), weichIdx);

    const after = await state(page, 'h => h.correctedHtml');
    expect(after).toContain('Eine Sonne');
    expect(after).not.toContain('Die Sonne');
  });

  test('selectAllFindings(false): correctedHtml entspricht originalHtml', async ({ page }) => {
    await loadHarness(page, 'ok');
    await page.evaluate(() => window.harness.runCheck());
    await waitUntil(page, 'h => h.checkDone === true');

    await page.evaluate(() => window.harness.selectAllFindings(false));

    const snap = await state(page, 'h => ({ c: h.correctedHtml, o: h.originalHtml, sel: h.selectedFindings })');
    expect(snap.sel.every(v => v === false)).toBe(true);
    expect(snap.c).toBe(snap.o);
  });

  test('closeFindings: State wird komplett geleert', async ({ page }) => {
    await loadHarness(page, 'ok');
    await page.evaluate(() => window.harness.runCheck());
    await waitUntil(page, 'h => h.checkDone === true');

    await page.evaluate(() => window.harness.closeFindings());

    const snap = await state(page, `h => ({
      findings: h.lektoratFindings.length,
      selected: h.selectedFindings.length,
      corrected: h.correctedHtml,
      hasErrors: h.hasErrors,
      analysisOut: h.analysisOut,
      checkDone: h.checkDone,
    })`);
    expect(snap.findings).toBe(0);
    expect(snap.selected).toBe(0);
    expect(snap.corrected).toBeNull();
    expect(snap.hasErrors).toBe(false);
    expect(snap.analysisOut).toBe('');
    expect(snap.checkDone).toBe(false);
  });

  test('empty-Szenario: analysisOut zeigt pageEmpty-Hinweis', async ({ page }) => {
    await loadHarness(page, 'empty');
    await page.evaluate(() => window.harness.runCheck());
    await waitUntil(page, 'h => h.checkLoading === false && h.analysisOut !== ""');

    const snap = await state(page, `h => ({
      analysisOut: h.analysisOut,
      findings: h.lektoratFindings.length,
      checkDone: h.checkDone,
    })`);
    expect(snap.analysisOut).toContain('job.pageEmpty');
    expect(snap.findings).toBe(0);
    expect(snap.checkDone).toBe(false);
  });

  test('error-Szenario: analysisOut zeigt Fehlermeldung, nicht Success-State', async ({ page }) => {
    await loadHarness(page, 'error');
    await page.evaluate(() => window.harness.runCheck());
    await waitUntil(page, 'h => h.checkLoading === false && h.analysisOut !== ""');

    const snap = await state(page, 'h => ({ out: h.analysisOut, done: h.checkDone })');
    expect(snap.out).toContain('error-msg');
    expect(snap.done).toBe(false);
  });

  test('saveCorrections: sendet korrigiertes HTML an BookStack und räumt State ab', async ({ page }) => {
    await loadHarness(page, 'ok');
    await page.evaluate(() => window.harness.runCheck());
    await waitUntil(page, 'h => h.checkDone === true');

    await page.evaluate(() => window.harness.saveCorrections());
    await waitUntil(page, 'h => h.saveApplying === null && h.checkDone === false', 5000);

    const mock = await page.request.get('http://localhost:8765/__mock/state').then(r => r.json());
    expect(mock.lastBsPut).not.toBeNull();
    expect(mock.lastBsPut.html).toContain('Wald');
    expect(mock.lastBsPut.html).toContain('scheint');
    expect(mock.lastBsPut.html).not.toContain('Walld');
    expect(mock.lastHistoryPatch).not.toBeNull();
    expect(Array.isArray(mock.lastHistoryPatch.applied_errors_json)).toBe(true);
    expect(mock.lastHistoryPatch.applied_errors_json.length).toBe(2); // nur harte

    const snap = await state(page, `h => ({
      findings: h.lektoratFindings.length,
      corrected: h.correctedHtml,
      originalHtml: h.originalHtml,
      analysisOut: h.analysisOut,
    })`);
    expect(snap.findings).toBe(0);
    expect(snap.corrected).toBeNull();
    expect(snap.originalHtml).toContain('Wald');
    expect(snap.analysisOut).toBe('');
  });
});
