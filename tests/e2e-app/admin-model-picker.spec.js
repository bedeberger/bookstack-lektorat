// Modell-Picker der Admin-Settings (settingField `models`) gegen die ECHTE App.
//
// Warum hier und nicht im Fixture-Harness: das Feld haengt an drei Dingen, die
// nur im vollen Alpine-Baum existieren — der x-effect-Spiegel des Host-Feldes
// aus `adminSettingsForm`, die transiente Combobox, die ihren Treffer zurueck
// in dieselbe Form schreibt, und die Karte, die beides umschliesst. Ein Mock
// haette genau diese Kette wegabstrahiert.
//
// Der Modell-Host ist ein Stub im Test-Prozess; die App fragt ihn ueber
// POST /admin/settings/models (Dev-Session ist Admin).

const http = require('http');
const { test, expect } = require('@playwright/test');
const { bootApp } = require('./_helpers/app');

let stub, stubUrl;

test.beforeAll(async () => {
  stub = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/tags') {
      res.end(JSON.stringify({ models: [{ name: 'mistral-small3.2' }, { name: 'llama3.2:latest' }] }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  stubUrl = `http://127.0.0.1:${stub.address().port}`;
});

test.afterAll(() => stub?.close());

// Settings-Karte oeffnen + Provider-Tab auf Ollama stellen.
async function openOllamaProviderTab(page) {
  await page.evaluate(async () => {
    await window.__app.toggleAdminSettingsCard();
  });
  const card = page.locator('[x-show="$app.showAdminSettingsCard"]').first();
  await expect(card).toBeVisible();
  await page.evaluate(() => {
    const c = window.Alpine.$data(document.querySelector('[x-data="adminSettingsCard"]'));
    c.adminSettingsTab = 'provider';
    c.adminSettingsProviderSubtab = 'ollama';
  });
  return card;
}

test('Modell-Picker: laedt die Liste des eingetippten Hosts und fuellt das Feld', async ({ page }) => {
  await bootApp(page);
  const card = await openOllamaProviderTab(page);

  const field = card.locator('.setting-field').filter({ hasText: 'ai.ollama.model' }).first();
  const input = field.locator('input[type="text"]').first();
  await expect(input).toBeVisible();

  // Host im Formular setzen (NICHT speichern) — der Picker muss den
  // ungespeicherten Wert mitschicken.
  await page.evaluate((host) => {
    const c = window.Alpine.$data(document.querySelector('[x-data="adminSettingsCard"]'));
    c.adminSettingsForm['ai.ollama.host'] = host;
  }, stubUrl);

  await field.locator('.setting-field__model-btn').click();

  const trigger = field.locator('.setting-field__model-pick .combobox-trigger');
  await expect(trigger).toBeVisible();
  await trigger.click();
  const options = field.locator('.setting-field__model-pick .combobox-option');
  await expect(options).toHaveCount(2);
  await options.filter({ hasText: 'mistral-small3.2' }).click();

  await expect(input).toHaveValue('mistral-small3.2');
  await expect(await page.evaluate(() => {
    const c = window.Alpine.$data(document.querySelector('[x-data="adminSettingsCard"]'));
    return c.adminSettingsForm['ai.ollama.model'];
  })).toBe('mistral-small3.2');
});

test('Modell-Picker: toter Host meldet den Fehler und laesst das Textfeld stehen', async ({ page }) => {
  await bootApp(page);
  const card = await openOllamaProviderTab(page);

  const field = card.locator('.setting-field').filter({ hasText: 'ai.ollama.model' }).first();
  await page.evaluate(() => {
    const c = window.Alpine.$data(document.querySelector('[x-data="adminSettingsCard"]'));
    c.adminSettingsForm['ai.ollama.host'] = 'http://127.0.0.1:1';
    c.adminSettingsForm['ai.ollama.model'] = 'handgetippt';
  });

  await field.locator('.setting-field__model-btn').click();
  await expect(field.locator('.muted-msg').filter({ hasText: /UNREACHABLE|TIMEOUT/ })).toBeVisible();
  await expect(field.locator('input[type="text"]').first()).toHaveValue('handgetippt');
  await expect(field.locator('.setting-field__model-pick')).toBeHidden();
});
