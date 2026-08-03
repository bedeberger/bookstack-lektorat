// Verwaiste Einträge zusammenfuehren (Panel in der Danger-Zone der
// Bucheinstellungen) gegen die ECHTE App.
//
// Warum hier und nicht als Fixture-Harness: Testgegenstand ist die ganze Kette —
// Panel-Fragment (`@include book-settings-merge`), zwei nested Comboboxen INNERHALB
// eines `x-for` (deren Options-Expression die karten-lokale Liste reaktiv lesen
// muss, siehe DESIGN.md „Reaktivitaet bei Datenquelle aus Karten-Scope"), der
// echte POST und das Verschwinden der Quelle danach. Der Smoke deckt davon nur
// „rendert ohne Konsolenfehler mit LEEREN Listen" ab: genau die Options-Expression
// mit Inhalt und der Merge selbst bleiben dort unbetreten.
//
// Kein Stub: der Merge braucht kein Modell (rein relationale Arbeit), also laeuft
// alles echt — Figuren anlegen ueber PUT /figures/:book_id, Merge ueber
// POST /figures/:book_id/merge, Kontrolle ueber GET /figures/:book_id.
const { test, expect } = require('@playwright/test');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const CARD = '.card--settings';
// Namen pro Lauf eindeutig: die App-Suite laeuft mit `reuseExistingServer`, ein
// zweiter Lauf traefe sonst auf die Ziel-Figur des ersten (die ueberlebt den Merge
// per Definition) — der Options-Filter faende sie doppelt und der Test waere
// scheinbar rot. Am Ende wird der Bestand wiederhergestellt.
const RUN = String(Date.now()).slice(-6);
const SRC_NAME = `Merge-Quelle Gerold ${RUN}`;
const TGT_NAME = `Merge-Ziel Gerold Brunner ${RUN}`;

// Zwei Figuren an den Bestand des Seed-Buchs ANHAENGEN. Der PUT ist Full-Replace
// (reconcile per fig_id, onMissing delete) — die bestehenden Figuren muessen also
// mitgeschickt werden, sonst nimmt dieser Test anderen Specs im geteilten
// Wegwerf-Buch die Daten weg.
async function seedTwoFiguren(page, bookId) {
  return page.evaluate(async ({ bookId, srcName, tgtName }) => {
    const cur = await (await fetch(`/figures/${bookId}`)).json();
    const existing = cur?.figuren || [];
    window.__mergeSpecBefore = existing;
    const used = new Set(existing.map(f => f.id));
    const freshId = (n) => { let i = 1; while (used.has(`fig_e2e_${n}_${i}`)) i++; const id = `fig_e2e_${n}_${i}`; used.add(id); return id; };
    const src = { id: freshId('src'), name: srcName, typ: 'nebenfigur', beruf: 'Schmied', beziehungen: [], kapitel: [], eigenschaften: [] };
    const tgt = { id: freshId('tgt'), name: tgtName, typ: 'hauptfigur', beziehungen: [], kapitel: [], eigenschaften: [] };
    const r = await fetch(`/figures/${bookId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ figuren: [...existing, src, tgt] }),
    });
    if (!r.ok) throw new Error(`PUT /figures fehlgeschlagen: ${r.status}`);
    return { srcId: src.id, tgtId: tgt.id };
  }, { bookId, srcName: SRC_NAME, tgtName: TGT_NAME });
}

function figurenNames(page, bookId) {
  return page.evaluate(async (id) => {
    const d = await (await fetch(`/figures/${id}`)).json();
    return (d?.figuren || []).map(f => f.name);
  }, bookId);
}

test('merge-panel: Kandidaten laden, Figuren zusammenfuehren, Quelle verschwindet', async ({ page }) => {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await bootApp(page);
  const bookId = await selectSeededBook(page);
  const seeded = await seedTwoFiguren(page, bookId);

  // Bucheinstellungen oeffnen → Danger-Tab.
  await page.evaluate(() => window.__app.toggleBookSettingsCard());
  await expect(page.locator(CARD)).toBeVisible();
  await page.locator(`${CARD} .tabs-btn`, { hasText: 'Gefahr' }).click();

  // Der Danger-Tab laedt die Kandidatenlisten (x-effect, einmalig).
  const section = page.locator(`${CARD} .book-settings-danger-section`, { hasText: 'Verwaiste Einträge zusammenführen' }).first();
  await expect(section).toBeVisible();
  await page.waitForFunction(
    (n) => {
      const c = window.Alpine.$data(document.querySelector('.card--settings'));
      return !!c?.mergeLists?.figur?.some(e => e.name === n);
    },
    SRC_NAME,
    { timeout: 15000 },
  );

  // Erste Gattung im Panel ist «Figuren» → deren zwei Comboboxen.
  const figBlock = section.locator('.book-settings-merge-kind').first();
  const boxes = figBlock.locator('.combobox-wrap');
  await expect(boxes).toHaveCount(2);

  // Quelle + Ziel waehlen. Die Combobox rendert ihr Markup selbst (init) —
  // Trigger klicken, dann die Option-Zeile (nicht den Label-Span darin).
  const pick = async (box, name) => {
    await box.locator('.combobox-trigger').click();
    const opts = box.locator('.combobox-option');
    await expect(opts.filter({ hasText: name })).toHaveCount(1);
    await opts.filter({ hasText: name }).click();
  };
  await pick(boxes.nth(0), SRC_NAME);
  await pick(boxes.nth(1), TGT_NAME);

  await expect.poll(() => page.evaluate(() => {
    const c = window.Alpine.$data(document.querySelector('.card--settings'));
    return [c.mergeSel.figur.source, c.mergeSel.figur.target].join('|');
  })).toBe([seeded.srcId, seeded.tgtId].join('|'));

  // Bestaetigungsdialog: nativer <dialog> im Top-Layer → Confirm-Button klicken.
  const mergeBtn = figBlock.locator('.book-settings-btn-danger');
  await expect(mergeBtn).toBeEnabled();
  await mergeBtn.click();
  await page.locator('#app-confirm-dialog .confirm-dialog-btn--danger').click();

  // Erfolgsmeldung + Quelle ist aus dem Katalog verschwunden, Ziel steht noch.
  await expect(page.locator(`${CARD} .card-form-saved`, { hasText: 'zusammengeführt' })).toBeVisible();
  const names = await figurenNames(page, bookId);
  expect(names).not.toContain(SRC_NAME);
  expect(names).toContain(TGT_NAME);

  // Feld-Backfill des Servers: das Ziel hatte keinen Beruf, die Quelle «Schmied».
  const tgt = await page.evaluate(async ({ id, name }) => {
    const d = await (await fetch(`/figures/${id}`)).json();
    return (d?.figuren || []).find(f => f.name === name) || null;
  }, { id: bookId, name: TGT_NAME });
  expect(tgt?.beruf).toBe('Schmied');
  expect(tgt?.kurzname).toBe(SRC_NAME);

  // Auswahl zurueckgesetzt, Quelle nicht mehr waehlbar.
  const state = await page.evaluate(() => {
    const c = window.Alpine.$data(document.querySelector('.card--settings'));
    return { sel: c.mergeSel.figur, names: c.mergeLists.figur.map(e => e.name) };
  });
  expect(state.sel).toEqual({ source: '', target: '' });
  expect(state.names).not.toContain(SRC_NAME);

  expect(errors, `Konsolenfehler: ${errors.join(' | ')}`).toEqual([]);

  // Bestand wiederherstellen: die Ziel-Figur ueberlebt den Merge per Definition und
  // wuerde im geteilten Wegwerf-Buch sonst mit jedem Lauf mitwachsen. Der PUT
  // loescht sie (onMissing delete), weil sie in der Ursprungsliste fehlt.
  await page.evaluate(async ({ id, before }) => {
    await fetch(`/figures/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ figuren: before }),
    });
  }, { id: bookId, before: await page.evaluate(() => window.__mergeSpecBefore) });
  const after = await figurenNames(page, bookId);
  expect(after).not.toContain(TGT_NAME);
});
