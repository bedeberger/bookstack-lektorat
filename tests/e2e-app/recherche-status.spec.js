// Recherche-Board, Ansicht „Status": Kanban ueber die Einarbeitungs-Stufen —
// gegen die ECHTE App.
//
// Warum hier und nicht als Fixture-Harness: die Ansicht haengt an drei Dingen,
// die nur die gebootete App hat — dem `x-if`/`x-show`-Zusammenspiel im echten
// Template-Baum (Board mountet erst beim Umschalten, die Drag-Container werden
// danach neu gebunden), dem echten `PATCH /research/:id` (der Status ist ein
// CHECK-gegatetes Spaltenfeld, kein Client-Zustand) und dem Shell-CSS (dass die
// Spalten nebeneinander stehen, ist eine Layout-Aussage). Nichts gestubbt.
const { test, expect } = require('@playwright/test');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const COLUMNS = ['offen', 'in_arbeit', 'eingearbeitet', 'verworfen'];

test('recherche: Status-Board sortiert in Spalten, das Aktionsmenue verschiebt, die Liste zeigt dieselbe Stufe', async ({ page }) => {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await bootApp(page);
  const bookId = await selectSeededBook(page);

  // Zwei Fundstuecke: eines mit Kapitel-Verknuepfung (hat eine Stelle im Buch),
  // eines ohne (daran haengt der „eingearbeitet ohne Stelle"-Befund).
  const made = await page.evaluate(async (id) => {
    const post = (url, payload) => fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(r => r.json());

    const withPlace = await post('/research', { book_id: id, kind: 'fact', title: 'Zollakten 1912' });
    const noPlace = await post('/research', { book_id: id, kind: 'note', title: 'Randnotiz ohne Ort' });

    const targets = await fetch(`/research/link-targets?book_id=${id}`).then(r => r.json());
    const chapterId = targets.chapter?.[0]?.id;
    const linked = chapterId
      ? await post(`/research/${withPlace.id}/links`, { target_kind: 'chapter', target_id: chapterId })
      : null;

    return { withPlace: withPlace.id, noPlace: noPlace.id, chapterId, status: withPlace.status, links: linked?.links?.length ?? 0 };
  }, bookId);

  // Frisch angelegt heisst unbearbeitet — der Default kommt vom Server.
  expect(made.status).toBe('offen');
  expect(made.chapterId, 'Seed-Buch braucht ein Kapitel fuer die Stelle-im-Buch-Achse').toBeTruthy();
  expect(made.links).toBe(1);

  await page.evaluate((id) => { location.hash = `#book/${id}/recherche`; }, bookId);
  await expect(page.locator('#recherche-card')).toBeVisible();

  // ── Liste: die Default-Stufe traegt KEINE Plakette ───────────────────────
  // Wer die Achse nie benutzt, sieht die Liste unveraendert — `offen` an jeder
  // Zeile zu wiederholen waere Rauschen ohne Aussage.
  const listRow = page.locator(`[data-research-id="${made.withPlace}"]`);
  await expect(listRow.locator('.research-status-badge')).toBeHidden();

  // ── Umschalten aufs Board ─────────────────────────────────────────────────
  const board = page.locator('.research-status-board');
  await expect(board).toHaveCount(0); // `x-if`: in der Listenansicht gar nicht im DOM
  await page.locator('.entity-view-toggle .tabs-btn', { hasText: 'Status' }).click();
  await expect(board).toBeVisible();
  await expect(page.locator('.recherche-list')).toBeHidden();

  // Vier Spalten in der Stufenfolge, nebeneinander (Kanban, nicht gestapelt).
  const columnKeys = await board.locator('.research-status-column').evaluateAll(
    els => els.map(el => (el.className.match(/research-status-column--(\w+)/) || [])[1]),
  );
  expect(columnKeys).toEqual(COLUMNS);
  const tops = await board.locator('.research-status-column').evaluateAll(
    els => els.map(el => Math.round(el.getBoundingClientRect().top)),
  );
  expect(new Set(tops).size, 'Spalten stehen auf einer Zeile').toBe(1);

  // Beide Fundstuecke stehen in „offen".
  const cell = (st) => board.locator(`[data-research-status-cell="${st}"]`);
  await expect(cell('offen').locator(`[data-research-card-id="${made.withPlace}"]`)).toBeVisible();
  await expect(cell('offen').locator(`[data-research-card-id="${made.noPlace}"]`)).toBeVisible();
  await expect(cell('eingearbeitet').locator('.research-status-card')).toHaveCount(0);

  // Drag-Griff ist da und SortableJS gebunden (der Drag selbst ist Maus-Komfort;
  // geprueft wird der tastaturerreichbare Weg darunter).
  await expect(cell('offen').locator(`[data-research-card-id="${made.withPlace}"] .research-status-grip`)).toBeVisible();
  expect(await page.evaluate(() => typeof window.Sortable === 'function')).toBe(true);

  // ── Aktionsmenue der Board-Karte verschiebt die Karte ─────────────────────
  const card = () => cell('offen').locator(`[data-research-card-id="${made.withPlace}"]`);
  await card().locator('.research-status-card-actions .icon-btn').first().click();
  const menu = page.locator('.research-status-card-actions .context-menu:visible');
  await expect(menu).toBeVisible();
  await expect(menu.locator('[role="menuitemradio"]')).toHaveCount(COLUMNS.length);
  // Der aktuelle Stand ist markiert, nicht bloss vorhanden.
  await expect(menu.locator('[role="menuitemradio"][aria-checked="true"]')).toContainText('Offen');
  await menu.locator('[role="menuitemradio"]', { hasText: 'Eingearbeitet' }).click();

  await expect(cell('eingearbeitet').locator(`[data-research-card-id="${made.withPlace}"]`)).toBeVisible();
  await expect(cell('offen').locator(`[data-research-card-id="${made.withPlace}"]`)).toHaveCount(0);
  // Spaltenzaehler zaehlt mit.
  await expect(board.locator('.research-status-column--eingearbeitet .research-status-column-count')).toHaveText('1');

  // Verknuepftes Kapitel steht als Sprungziel auf der Karte, kein Befund.
  const moved = cell('eingearbeitet').locator(`[data-research-card-id="${made.withPlace}"]`);
  await expect(moved.locator('.research-status-place')).toHaveCount(1);
  await expect(moved.locator('.research-status-noplace')).toBeHidden();

  // ── „eingearbeitet ohne Stelle im Buch" ist ein Befund auf der Karte ──────
  const bare = () => cell('offen').locator(`[data-research-card-id="${made.noPlace}"]`);
  await bare().locator('.research-status-card-actions .icon-btn').first().click();
  await page.locator('.research-status-card-actions .context-menu:visible [role="menuitemradio"]', { hasText: 'Eingearbeitet' }).click();
  const bareMoved = cell('eingearbeitet').locator(`[data-research-card-id="${made.noPlace}"]`);
  await expect(bareMoved).toBeVisible();
  await expect(bareMoved.locator('.research-status-noplace')).toBeVisible();

  // ── Der Stand ist persistiert, nicht bloss angezeigt ─────────────────────
  const fromServer = await page.evaluate(async (id) => {
    const rows = await fetch(`/research?book_id=${id}`).then(r => r.json());
    return Object.fromEntries(rows.map(r => [r.id, r.status]));
  }, bookId);
  expect(fromServer[made.withPlace]).toBe('eingearbeitet');
  expect(fromServer[made.noPlace]).toBe('eingearbeitet');

  // ── Zurueck in die Liste: dieselbe Stufe, dieselbe Aussage ───────────────
  await page.locator('.entity-view-toggle .tabs-btn', { hasText: 'Liste' }).click();
  await expect(board).toHaveCount(0);
  const badge = listRow.locator('.research-status-badge');
  await expect(badge).toBeVisible();
  await expect(badge).toHaveClass(/research-status-badge--eingearbeitet/);

  // Aufraeumen: die Suite teilt einen Seed-Stand.
  await page.evaluate(async (ids) => {
    for (const id of ids) await fetch(`/research/${id}`, { method: 'DELETE' });
  }, [made.withPlace, made.noPlace]);

  expect(errors, errors.join('\n')).toEqual([]);
});
