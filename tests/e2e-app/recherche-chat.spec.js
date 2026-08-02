// Recherche-Chat-Panel: Zugänglichkeit des Panels nach dem Refactoring, das
// die Render-Logik aus research-chat.js in research-chat-render.js ausgelagert
// hat. Smoke oeffnet die Karte, prueft aber KEINE Verhaltens-Invariante des
// Chat-Panels — dieser Spec tut genau das: Toggle-Button sichtbar (config
// enabled), Panel klappt auf, Eingabefeld + Sende-Button gerendert, Schliessen
// via Toggle-Icon. Kein echter Send: der Job-Worker ist Claude-only und ohne
// API-Key im Devmode ohne Wert (Server-Return 404 researchChatClaudeOnly);
// das Frontend-Refactoring ist der Gegenstand, nicht das Backend-Verhalten.
const { test, expect } = require('@playwright/test');
const { bootApp, selectSeededBook } = require('./_helpers/app');

test('recherche-chat: Toggle-Button sichtbar, Panel klappt auf, Eingabefeld + Close arbeiten', async ({ page }) => {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await bootApp(page);
  const bookId = await selectSeededBook(page);
  await page.evaluate((id) => { location.hash = `#book/${id}/recherche`; }, bookId);
  await expect(page.locator('#recherche-card')).toBeVisible();

  // /config liefert researchChat.enabled=false, wenn kein Claude-API-Key gesetzt
  // ist (Devmode ohne Key). Der Spec prueft Frontend-Zugaenglichkeit nach dem
  // Render-Refactoring, nicht das Feature-Enablement — darum den Store-Wert hier
  // auf true legen, damit der Toggle-Button sichtbar wird.
  await page.evaluate(() => { window.Alpine.store('config').researchChatEnabled = true; });

  // Toggle-Button: nur sichtbar, wenn /config researchChat.enabled true ist.
  const toggleBtn = page.locator('#recherche-card .card-header-aside button[aria-pressed]').first();
  await expect(toggleBtn).toBeVisible();
  // Panel initial zu.
  await expect(page.locator('#recherche-card .research-chat')).toBeHidden();

  // Aufklappen: Panel sichtbar, Eingabefeld + Sende-Button gerendert, Fokus
  // landet im Textarea (toggleResearchChat fokussiert beim Oeffnen).
  await toggleBtn.click();
  await expect(page.locator('#recherche-card .research-chat')).toBeVisible();
  const textarea = page.locator('#research-chat-messages + .chat-input-row textarea.research-chat-input');
  await expect(textarea).toBeVisible();
  await expect(page.locator('#recherche-card .chat-send-btn')).toBeVisible();
  await expect(textarea).toBeFocused();

  // Eingabefeld nimmt Text auf (x-model an researchChatInput) — keine Aenderung
  // am State, nur Bindung geprueft (Alpine laeuft, Methode nicht verloren).
  await textarea.fill('Recherche-Testeingabe');
  await expect(textarea).toHaveValue('Recherche-Testeingabe');

  // Close-Icon im Panel-Head legt researchChatOpen=false → Panel zu.
  await page.locator('#recherche-card .research-chat-head .icon-btn[aria-label]').last().click();
  await expect(page.locator('#recherche-card .research-chat')).toBeHidden();

  expect(errors, `Konsolenfehler:\n${errors.join('\n')}`).toEqual([]);
});