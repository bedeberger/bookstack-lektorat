// TEMP: SW-Lifecycle debug
const { test } = require('@playwright/test');

test('sw lifecycle', async ({ page }) => {
  await page.addInitScript(() => { try { localStorage.setItem('sw', '1'); } catch {} });
  page.on('console', (m) => console.log('[pg]', m.text()));

  await page.goto('/', { waitUntil: 'load' });
  const st1 = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return {
      controller: !!navigator.serviceWorker.controller,
      installing: !!reg?.installing, waiting: !!reg?.waiting, active: !!reg?.active,
    };
  });
  console.log('nach erstem load:', JSON.stringify(st1));

  await page.waitForFunction(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return !!reg?.active;
  }, null, { timeout: 20000 });
  const st2 = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    const keys = await caches.keys();
    return {
      controller: !!navigator.serviceWorker.controller,
      active: !!reg?.active, waiting: !!reg?.waiting,
      caches: keys,
    };
  });
  console.log('nach active-wait:', JSON.stringify(st2));

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const st3 = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    const keys = await caches.keys();
    let contentKeys = [];
    try {
      const c = await caches.open('schreibwerkstatt-content-v1');
      contentKeys = (await c.keys()).map((k) => new URL(k.url).pathname);
    } catch (e) {}
    return {
      controller: !!navigator.serviceWorker.controller,
      active: !!reg?.active,
      caches: keys,
      content: contentKeys,
    };
  });
  console.log('nach reload:', JSON.stringify(st3, null, 1));
});
