// Smoke-Tests für Fokus-Editor. Lädt eine Mini-Fixture-Page (kein Express,
// kein BookStack), die `focusMethods` direkt importiert und an ein Test-
// Harness-Objekt bindet. Reicht aus, um die DOM-Logik (Toggle, Recenter,
// Pointer-Schonfrist, Cleanup) abzudecken.

module.exports = {
  testDir: './tests/e2e',
  testMatch: '**/*.spec.js',
  fullyParallel: true,
  workers: process.env.CI ? 2 : undefined,
  use: {
    baseURL: 'http://localhost:8765',
    viewport: { width: 1024, height: 768 },
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
  webServer: {
    command: 'node tests/server.js',
    url: 'http://localhost:8765/tests/fixtures/focus-harness.html',
    timeout: 10000,
    reuseExistingServer: !process.env.CI,
  },
};
