const { test, expect } = require('./_helpers/fixtures');

const HARNESS = '/tests/fixtures/lektorat-harness.html';

async function loadHarness(page, scenario) {
  const url = scenario ? `${HARNESS}?scenario=${scenario}` : HARNESS;
  await page.request.post('http://localhost:8765/__mock/reset');
  await page.goto(url, { waitUntil: 'domcontentloaded' });
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
  test.describe.configure({ mode: 'serial' });

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

  // Szenario: im Mac-Client schreiben → Lektorat starten → im Mac-Client
  // weiterschreiben. Der Browser erfährt vom Fremd-Write NICHT verlässlich über
  // den Collab-Poll (40s-Device-Ping als Voraussetzung), darum verifiziert
  // onDone den Stempel selbst. Erwartung: nicht pauschal verwerfen, sondern die
  // Findings gegen den frischen Text refiltern.
  test('stale-Szenario: Fremd-Write während der Analyse → Findings refiltert, nicht verworfen', async ({ page }) => {
    await loadHarness(page, 'stale');
    await page.evaluate(() => window.harness.runCheck());
    await waitUntil(page, 'h => h.checkDone === true');

    const snap = await state(page, `h => ({
      findings: h.lektoratFindings.map(f => f.original),
      originalHtml: h.originalHtml,
      correctedHtml: h.correctedHtml,
      analysisOut: h.analysisOut,
      updatedAt: h.currentPage.updated_at,
    })`);

    // Basis ist der FRISCHE Text, nicht der Job-Snapshot.
    expect(snap.originalHtml).toContain('lief zum Fluss');
    expect(snap.originalHtml).not.toContain('in den Walld');
    expect(snap.updatedAt).toBe('2026-07-31T10:05:00.000Z');

    // Das Finding auf «Walld» ist hinfällig und fliegt raus; die beiden
    // Findings im unveränderten Satz überleben. Die Reihenfolge folgt der
    // Position im FRISCHEN Text («Die» vor «scheinet») — im Job-Snapshot lagen
    // sie in der Reihenfolge scheinet/Die. Beweis, dass die Positionen gegen
    // `base` neu berechnet wurden und nicht aus dem Snapshot stammen.
    expect(snap.findings).toEqual(['Die', 'scheinet']);

    // Der Hinweis nennt die Zahl der verworfenen Befunde (1 von 3).
    expect(snap.analysisOut).toContain('analysis-notice');
    expect(snap.analysisOut).toContain('lektorat.staleResultRefiltered');
    // Params escaped (`&quot;` statt `"`) — der Hinweis geht durch escHtml,
    // bevor er in `analysisOut` (x-html-Sink) landet.
    expect(snap.analysisOut).toContain('&quot;dropped&quot;:1');
    expect(snap.analysisOut).toContain('&quot;total&quot;:3');

    // Die überlebende harte Korrektur wird auf dem frischen Text angewandt —
    // der Fremd-Write-Satz bleibt dabei unangetastet.
    expect(snap.correctedHtml).toContain('scheint');
    expect(snap.correctedHtml).toContain('lief zum Fluss');

    // Übernehmen schreibt den frischen Text mit der Korrektur zurück; der im
    // Mac-Client geschriebene Satz darf nicht überschrieben werden.
    await page.evaluate(() => window.harness.saveCorrections());
    await waitUntil(page, 'h => h.saveApplying === null && h.checkDone === false', 5000);

    const mock = await page.request.get('http://localhost:8765/__mock/state').then(r => r.json());
    expect(mock.lastBsPut.html).toContain('lief zum Fluss');
    expect(mock.lastBsPut.html).toContain('scheint');
    expect(mock.lastBsPut.html).not.toContain('scheinet');
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
