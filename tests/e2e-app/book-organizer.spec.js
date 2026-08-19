// Buchorganizer gegen die ECHTE App (Server + SQLite + Alpine).
//
// Warum hier und nicht als Fixture-Harness: der geprüfte Pfad ist ein
// Zusammenspiel aus Root (`_applyCollabChanges` → `_removePageFromTree` →
// `page:removed`-Event) und der echten Karten-Instanz mit ihrem Lifecycle-
// Listener — ein Harness müsste beide Seiten nachbauen und würde genau die
// Koppelung nicht messen, um die es geht.
//
// Regressions-Abdeckung für: eine remote geloeschte Seite (Collab-Feed
// `kind: 'delete'`, z.B. auf einem anderen Geraet geloescht) verschwand zwar
// aus dem Sidebar-Pagetree (in-place Splice auf nav.tree/nav.pages), blieb
// aber im offenen Buchorganizer als Zeile stehen, weil kein `pages:loaded`
// feuert und die Karte ihr workTree nie neu snapshotete.

const { test, expect } = require('@playwright/test');
const { attachConsoleGuard } = require('../e2e/_helpers/console-guard.js');
const { bootApp, selectSeededBook } = require('./_helpers/app.js');

async function openOrganizer(page) {
  await page.evaluate(() => window.__app.toggleBookOrganizerCard());
  await expect(page.locator('.card--organizer')).toBeVisible();
  await page.waitForFunction(() =>
    document.querySelectorAll('.card--organizer .organizer-page').length > 0);
}

function organizerRowIds(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.card--organizer .organizer-page')]
      .map((li) => li.dataset.pageId));
}

// Simuliert den Eingang eines Remote-Deletes aus dem Collab-Poll (kein
// Server-Call: `_applyCollabChanges` behandelt kind:'delete' rein lokal).
function remoteDelete(page, pageId, name) {
  return page.evaluate(({ id, n }) => window.__app._applyCollabChanges([{
    kind: 'delete',
    page_id: id,
    page_name: n,
    chapter_id: null,
    updated_at: new Date().toISOString(),
    last_editor_email: 'other@example.com',
    last_editor_name: 'Other',
    is_self: false,
    device_label: null,
  }]), { id: pageId, n: name });
}

test('remote-delete einer Kapitel-Seite aktualisiert die Organizer-Liste', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);
  await openOrganizer(page);

  const rows = await organizerRowIds(page);
  expect(rows.length).toBeGreaterThan(0);
  const victim = parseInt(rows[rows.length - 1], 10);

  await remoteDelete(page, victim, 'X');
  await page.waitForTimeout(400);

  const after = await organizerRowIds(page);
  expect(after.includes(String(victim)), 'Zeile aus Organizer-Liste entfernt').toBe(false);
  const navHas = await page.evaluate((id) =>
    window.Alpine.store('nav').pages.some((p) => p.id === id), victim);
  expect(navHas, 'Seite aus nav.pages entfernt').toBe(false);
  guard.assertClean('remote-delete kapitel-seite');
});

test('remote-delete einer Solo-Seite aktualisiert die Organizer-Liste', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  const bookId = await selectSeededBook(page);

  // Solo-Seite (ohne Kapitel) lokal im Store nachziehen — sie existiert nur
  // clientseitig, das reicht: der gepruefte Pfad ist rein clientseitig.
  const soloId = await page.evaluate(async (bid) => {
    const { contentRepo } = await import('/js/repo/content.js');
    const created = await contentRepo.createPage({ book_id: parseInt(bid, 10), name: 'Solo-Remote-Delete', html: '<p>x</p>' });
    await window.__app.loadPages();
    return created.id;
  }, bookId);

  await openOrganizer(page);
  const rows = await organizerRowIds(page);
  expect(rows.includes(String(soloId)), 'Solo-Zeile vorhanden').toBe(true);

  await remoteDelete(page, soloId, 'Solo-Remote-Delete');
  await page.waitForTimeout(400);

  const after = await organizerRowIds(page);
  expect(after.includes(String(soloId)), 'Solo-Zeile aus Organizer-Liste entfernt').toBe(false);
  guard.assertClean('remote-delete solo-seite');

  // Hygiene: die Suite teilt sich eine DB pro Lauf — die Test-Seite serverseitig
  // aufraeumen (der Remote-Delete oben war bewusst nur clientseitig).
  await page.evaluate(async (id) => {
    const { contentRepo } = await import('/js/repo/content.js');
    await contentRepo.deletePage(id);
  }, soloId);
});
