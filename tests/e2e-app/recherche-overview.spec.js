// Recherche-Board, Uebersichts-Darstellung eines Fundstuecks: Text-Cap + direkt
// klickbares Bild — gegen die ECHTE App.
//
// Warum hier und nicht als Fixture-Harness: beides haengt in der Anzeige-Variante
// INNERHALB des `x-for` der Item-Liste (`noteBodyForClamp`/`bodyClampable`/
// `bodyExpanded`/`imageUrl`), und der Cap ist eine CSS-Hoehen-Aussage — ob er
// abschneidet, sieht nur ein Browser mit dem VOLLEN Shell-CSS. Der Smoke oeffnet
// die Karte, prueft aber kein Verhalten. Nichts gestubbt: Anlegen, Bild-Upload
// und Klicks laufen ueber die echten Routen.
const { test, expect } = require('@playwright/test');
const { bootApp, selectSeededBook } = require('./_helpers/app');

// Text, der den Cap in JEDER Spaltenbreite ueberschreitet (der Toggle erscheint
// nur bei echtem Ueberlauf — genau das ist hier der Testgegenstand).
const LONG_BODY = 'Im Landesarchiv liegen die Prozessakten in zwoelf Kartons. '.repeat(60);
// 8x8-PNG (rot) — laeuft durch dieselbe sharp-Pipeline (prepareCover) wie ein
// echter Upload, inklusive Magic-Bytes-Pruefung und JPEG-Normalisierung.
const PNG_8PX_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVR4nGM4oaGBFTEMLQkAgl1GAWqNFmsAAAAASUVORK5CYII=';

test('recherche-uebersicht: langer Text ist geklappt, Bild ist direkt klickbar', async ({ page }) => {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await bootApp(page);
  const bookId = await selectSeededBook(page);

  // Zwei Fundstuecke: eines mit langem Text (Cap + Toggle), eines mit Bild.
  const made = await page.evaluate(async ({ id, body, png }) => {
    const post = (payload) => fetch('/research', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ book_id: id, ...payload }),
    }).then(r => r.json());

    const long = await post({ kind: 'note', title: 'Aktenlage', body });
    const short = await post({ kind: 'note', title: 'Randnotiz', body: 'Zwei Zeilen, mehr nicht.' });
    const withImg = await post({ kind: 'image', title: 'Grundrissplan' });

    const bin = Uint8Array.from(atob(png), c => c.charCodeAt(0));
    const up = await fetch(`/research/${withImg.id}/image`, {
      method: 'POST', headers: { 'Content-Type': 'image/png' }, body: bin,
    });
    const upBody = await up.json();
    return { long: long.id, short: short.id, img: withImg.id, upStatus: up.status, upBody };
  }, { id: bookId, body: LONG_BODY, png: PNG_8PX_B64 });
  // Ohne erfolgreichen Upload traegt das Item kein has_image und die Bild-Zusicherung
  // unten wuerde aus dem falschen Grund scheitern.
  expect(made.upStatus, JSON.stringify(made.upBody)).toBe(200);
  expect(made.upBody.has_image).toBe(true);

  await page.evaluate((id) => { location.hash = `#book/${id}/recherche`; }, bookId);
  await expect(page.locator('#recherche-card')).toBeVisible();

  // ── Text-Cap ───────────────────────────────────────────────────────────────
  const longItem = page.locator(`[data-research-id="${made.long}"]`);
  const longText = longItem.locator('.research-item-text');
  await expect(longText).toHaveClass(/research-item-text--clamped/);
  // Der Cap ist echt: die gerenderte Hoehe bleibt unter der Inhaltshoehe.
  const clampedHeight = await longText.evaluate(el => el.getBoundingClientRect().height);
  const fullHeight = await longText.evaluate(el => el.scrollHeight);
  expect(clampedHeight).toBeLessThan(fullHeight);
  await expect(longItem.locator('.research-item-more')).toBeVisible();

  // Kurzer Text laeuft nicht ueber → kein Toggle (die Messung entscheidet, nicht
  // die Textlaenge: ein „Mehr anzeigen" ohne etwas zum Aufklappen waere Rauschen).
  const shortItem = page.locator(`[data-research-id="${made.short}"]`);
  await expect(shortItem.locator('.research-item-text')).toBeVisible();
  await expect(shortItem.locator('.research-item-more')).toBeHidden();

  // Aufklappen: Klasse weg, volle Hoehe — und der Klick auf den Toggle wechselt
  // NICHT in den Edit-Modus (der Button steht in der onItemBodyClick-Allowlist).
  await longItem.locator('.research-item-more').click();
  await expect(longText).not.toHaveClass(/research-item-text--clamped/);
  await expect(longItem.locator('.recherche-form')).toHaveCount(0);
  expect(await longText.evaluate(el => el.getBoundingClientRect().height))
    .toBeGreaterThan(clampedHeight);

  // Wieder zuklappen — der Toggle bleibt dabei erreichbar.
  await longItem.locator('.research-item-more').click();
  await expect(longText).toHaveClass(/research-item-text--clamped/);
  await expect(longItem.locator('.research-item-more')).toBeVisible();

  // ── Bild direkt klickbar ───────────────────────────────────────────────────
  const imgLink = page.locator(`[data-research-id="${made.img}"] a.research-item-image-link`);
  await expect(imgLink).toHaveAttribute('href', `/research/${made.img}/image`);
  await expect(imgLink).toHaveAttribute('target', '_blank');
  await expect(imgLink.locator('img.research-item-image')).toBeVisible();
  // Die Vollansicht liefert wirklich ein Bild aus.
  const head = await page.evaluate(url => fetch(url).then(r => ({ ok: r.ok, mime: r.headers.get('content-type') })),
    `/research/${made.img}/image`);
  expect(head.ok).toBe(true);
  expect(head.mime).toMatch(/^image\//);

  // Aufraeumen: die App-Suite teilt eine DB, fremde Specs sollen die Fundstuecke
  // nicht mitzaehlen.
  await page.evaluate(async (ids) => {
    for (const id of ids) await fetch(`/research/${id}`, { method: 'DELETE' });
  }, [made.long, made.short, made.img]);

  expect(errors, `Konsolenfehler:\n${errors.join('\n')}`).toEqual([]);
});
