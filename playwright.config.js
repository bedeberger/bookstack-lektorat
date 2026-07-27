// Smoke-Tests für Fokus-Editor. Lädt eine Mini-Fixture-Page (kein Express,
// kein BookStack), die `focusMethods` direkt importiert und an ein Test-
// Harness-Objekt bindet. Reicht aus, um die DOM-Logik (Toggle, Recenter,
// Pointer-Schonfrist, Cleanup) abzudecken.

module.exports = {
  testDir: './tests/e2e',
  testMatch: '**/*.spec.js',
  fullyParallel: false,
  // CI läuft auf lokalem Runner über Ceph-RBD-Storage; IO-Stalls bremsen
  // Chromium → reine Setup/Navigations-Timeouts. Sequenziell (worker=1)
  // hält die IO-Last niedrig, höhere Timeouts + 3 Retries fangen Spikes.
  workers: process.env.CI ? 1 : undefined,
  retries: process.env.CI ? 3 : 0,
  timeout: 90000,
  expect: { timeout: 10000 },
  use: {
    baseURL: 'http://localhost:8765',
    viewport: { width: 1024, height: 768 },
    navigationTimeout: 45000,
    actionTimeout: 30000,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' }, testIgnore: '**/*.webkit.spec.js' },
    // `*.webkit.spec.js` deckt Engine-spezifische Fehlerklassen ab, die Chromium
    // strukturell nicht sieht — z.B. die kaputte contenteditable-Selektion, wenn
    // die Padding-Summe die clientHeight der Scroll-Box erreicht
    // (focus-selection.webkit.spec.js). Eigenes Projekt statt zweitem Durchlauf
    // aller Specs: die übrige Suite ist auf Chromium geeicht.
    { name: 'webkit', use: { browserName: 'webkit' }, testMatch: '**/*.webkit.spec.js' },
  ],
  webServer: {
    command: 'node tests/server.js',
    url: 'http://localhost:8765/tests/fixtures/focus-harness.html',
    timeout: process.env.CI ? 30000 : 10000,
    reuseExistingServer: !process.env.CI,
  },
};
