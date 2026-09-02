// Motiv-Werkstatt — Interaktions-Smoke gegen die echte App (playwright.app.config.js).
// Deckt die Schreibpfade ab, die der reine Karten-Öffnen-Smoke NICHT prüft:
// Thema/Motiv anlegen, Motiv auswählen, Beziehung setzen, Graph-Aufbau — alles am
// echten Card-/Root-Scope gegen /motifs + Wegwerf-DB, mit Konsolenfehler-Guard.

const { test, expect } = require('@playwright/test');
const { attachConsoleGuard } = require('../e2e/_helpers/console-guard');

async function bootApp(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__app && Array.isArray(window.Alpine.store('nav').books) && window.Alpine.store('nav').books.length > 0,
    null, { timeout: 30000 },
  );
}
async function selectSeededBook(page) {
  const bookId = await page.evaluate(() => window.Alpine.store('nav').books[0].id);
  await page.evaluate((id) => { location.hash = '#book/' + id; }, bookId);
  await page.waitForFunction(
    (id) => String(window.Alpine.store('nav').selectedBookId) === String(id)
            && Array.isArray(window.Alpine.store('nav').pages) && window.Alpine.store('nav').pages.length > 0,
    bookId, { timeout: 20000 },
  );
  return bookId;
}

test.describe.configure({ mode: 'serial' });

test('Motiv-Werkstatt: anlegen, verknüpfen, Graph — ohne Konsolenfehler', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);

  // Karte öffnen + Sub-Mount abwarten.
  await page.evaluate(() => window.__app.toggleMotivCard());
  await page.waitForFunction(() => !!document.querySelector('.card--motiv'), null, { timeout: 10000 });
  await page.waitForFunction(
    () => { const c = window.Alpine.$data(document.querySelector('.card--motiv')); return c && !c.loading; },
    null, { timeout: 10000 },
  );

  // Thema + zwei Motive anlegen, erstes selektieren, Beziehung setzen — alles am
  // echten Scope gegen das Backend.
  const result = await page.evaluate(async () => {
    const card = window.Alpine.$data(document.querySelector('.card--motiv'));

    card.newThemeName = 'Wasser & Schuld';
    await card.addTheme();

    card.newMotifName = 'Regen';
    await card.addMotif();               // selektiert das neue Motiv
    const firstId = card.selectedMotifId;

    card.newMotifName = 'Spiegel';
    await card.addMotif();
    const secondId = card.selectedMotifId;

    // Beziehung Regen → Spiegel.
    await card.selectMotif(firstId);
    card.newRelationTargetId = String(secondId);
    card.newRelationTyp = 'kontrastiert';
    await card.addRelation();

    return {
      themes: card.themes.length,
      motifs: card.motifs.length,
      relations: card.relations.length,
      relTyp: card.relations[0]?.typ,
      semanticActiveIsBool: typeof card.semanticActive() === 'boolean',
    };
  });

  expect(result.themes, 'ein Thema angelegt').toBe(1);
  expect(result.motifs, 'zwei Motive angelegt').toBe(2);
  expect(result.relations, 'eine Beziehung angelegt').toBe(1);
  expect(result.relTyp).toBe('kontrastiert');
  expect(result.semanticActiveIsBool, 'semanticActive() liefert Boolean (Task 1)').toBe(true);

  // Graph rendert (vis-network lazy) — Netzwerk-Instanz + Motiv-Knoten vorhanden.
  await page.waitForFunction(
    () => { const c = window.Alpine.$data(document.querySelector('.card--motiv')); return !!c._motivNetwork; },
    null, { timeout: 10000 },
  );

  await page.waitForTimeout(300);
  guard.assertClean('Motiv-Werkstatt Interaktion');
});

// Regression: Verknüpfungs-Comboboxen sind transiente Picker mit $event.detail.
// Ein Temp-x-model wäre im combobox-change-Handler noch stale (x-modelable synct
// asynchron via Effect-Flush) — die erste Auswahl landete dann nirgends, die
// zweite fügte die vorherige hinzu.
test('Motiv-Werkstatt: erste Combobox-Auswahl landet sofort im Link-Puffer (dirty)', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);

  await page.evaluate(() => window.__app.toggleMotivCard());
  await page.waitForFunction(() => {
    const el = document.querySelector('.card--motiv');
    if (!el) return false;
    const c = window.Alpine.$data(el);
    return c && !c.loading;
  }, null, { timeout: 15000 });

  await page.evaluate(async () => {
    const card = window.Alpine.$data(document.querySelector('.card--motiv'));
    card.newMotifName = 'Combobox-Regression';
    await card.addMotif(); // selektiert das neue Motiv
  });

  // Kapitel-Verknüpfung über die ECHTE Combobox wählen (3. Link-Gruppe) —
  // genau EIN Klick muss reichen. Trigger vorher ZENTRIEREN: die Combobox
  // schliesst bei Window-Scroll, und der Autofokus aufs Suchfeld scrollt nach,
  // wenn das Dropdown unter dem Viewport-Rand aufginge.
  const chapGroup = page.locator('.motiv-link-group').nth(2);
  await chapGroup.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(150);
  await chapGroup.locator('.combobox-trigger').click();
  const opt = chapGroup.locator('.combobox-option').first();
  await expect(opt).toBeVisible();
  await opt.click();

  await page.waitForFunction(() => {
    const c = window.Alpine.$data(document.querySelector('.card--motiv'));
    return c.editChapters.length === 1 && c.motifDirty();
  }, null, { timeout: 5000 });

  // Save/Cancel-Icons erscheinen (motifDirty).
  await expect(page.locator('.motiv-editor-head .icon-btn--success')).toBeVisible();

  guard.assertClean('Motiv-Werkstatt Combobox-Link');
});

// Regression: Re-Klick auf den bereits gewählten Graph-Knoten (selectMotif mit
// derselben ID) darf ungespeicherte Edit-Puffer nicht verwerfen.
test('Motiv-Werkstatt: Re-Select desselben Motivs behält ungespeicherte Edits', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);

  await page.evaluate(() => window.__app.toggleMotivCard());
  await page.waitForFunction(() => {
    const el = document.querySelector('.card--motiv');
    if (!el) return false;
    const c = window.Alpine.$data(el);
    return c && !c.loading;
  }, null, { timeout: 15000 });

  const result = await page.evaluate(async () => {
    const card = window.Alpine.$data(document.querySelector('.card--motiv'));
    card.newMotifName = 'Reselect-Regression';
    await card.addMotif();
    const id = card.selectedMotifId;
    card.editName = 'Umbenannt aber ungespeichert';
    // Graph-Knoten-Klick auf das gewählte Motiv → selectMotif(gleiche ID).
    await card.selectMotif(id);
    return { editName: card.editName, dirty: card.motifDirty() };
  });

  expect(result.editName).toBe('Umbenannt aber ungespeichert');
  expect(result.dirty).toBe(true);

  guard.assertClean('Motiv-Werkstatt Re-Select');
});

// Regression: Wechsel auf ein ANDERES Motiv committet ausstehende Änderungen
// (wie das Beat-Edit-Panel der Plot-Werkstatt: Wechsel = Save, kein stilles
// Verwerfen).
test('Motiv-Werkstatt: Motivwechsel speichert ungespeicherte Edits', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);

  await page.evaluate(() => window.__app.toggleMotivCard());
  await page.waitForFunction(() => {
    const el = document.querySelector('.card--motiv');
    if (!el) return false;
    const c = window.Alpine.$data(el);
    return c && !c.loading;
  }, null, { timeout: 15000 });

  const result = await page.evaluate(async () => {
    const card = window.Alpine.$data(document.querySelector('.card--motiv'));
    card.newMotifName = 'Wechsel-Quelle';
    await card.addMotif();
    const firstId = card.selectedMotifId;
    card.newMotifName = 'Wechsel-Ziel';
    await card.addMotif();
    const secondId = card.selectedMotifId;

    // Erstes Motiv wählen, umbenennen, dann ohne Save aufs zweite wechseln.
    await card.selectMotif(firstId);
    card.editName = 'Wechsel-Quelle umbenannt';
    await card.selectMotif(secondId);

    return {
      selectedId: card.selectedMotifId,
      secondId,
      firstName: card.motifById(firstId)?.name,
      err: card.errorMessage,
    };
  });

  expect(result.selectedId).toBe(result.secondId);
  expect(result.firstName, 'Rename beim Wechsel committet').toBe('Wechsel-Quelle umbenannt');
  expect(result.err).toBe('');

  guard.assertClean('Motiv-Werkstatt Commit-on-Switch');
});

// Schnellweg im Themen-Editor: Motiv mit getipptem Namen anlegen und sofort dem
// offenen Thema zuordnen. Prüft beides — die Verdrahtung (theme_id gesetzt,
// Auswahl wandert in den Motiv-Editor, Draft geleert) UND dass das ausgelagerte
// Themen-Editor-Fragment (@include motiv-panel-theme) überhaupt im Baum landet:
// es hängt hinter `x-if`, kein anderer Test öffnet diesen Panel-Zustand.
test('Motiv-Werkstatt: Themen-Editor legt ein Motiv direkt im Thema an', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);

  await page.evaluate(() => window.__app.toggleMotivCard());
  await page.waitForFunction(() => {
    const el = document.querySelector('.card--motiv');
    if (!el) return false;
    const c = window.Alpine.$data(el);
    return c && !c.loading;
  }, null, { timeout: 15000 });

  // Thema anlegen → addTheme selektiert es, der Themen-Editor rendert.
  await page.evaluate(async () => {
    const card = window.Alpine.$data(document.querySelector('.card--motiv'));
    card.newThemeName = 'Schnellweg-Thema';
    await card.addTheme();
  });
  const quickInput = page.locator('.motiv-theme-addmotif input');
  await expect(quickInput, 'Schnellweg-Zeile im Themen-Editor gerendert').toBeVisible();

  const result = await page.evaluate(async () => {
    const card = window.Alpine.$data(document.querySelector('.card--motiv'));
    const themeId = card.selectedThemeId;
    card.newThemeMotifName = 'Schnellweg-Motiv';
    await card.addMotifToTheme();
    const m = card.motifById(card.selectedMotifId);
    return {
      themeId,
      motifName: m?.name,
      motifThemeId: m?.theme_id,
      selectedThemeId: card.selectedThemeId,
      draft: card.newThemeMotifName,
      err: card.errorMessage,
    };
  });

  expect(result.motifName, 'Motiv unter dem getippten Namen angelegt').toBe('Schnellweg-Motiv');
  expect(result.motifThemeId, 'dem offenen Thema zugeordnet').toBe(result.themeId);
  expect(result.selectedThemeId, 'Motiv-Editor loest den Themen-Editor ab').toBe(null);
  expect(result.draft, 'Draft nach dem Anlegen geleert').toBe('');
  expect(result.err).toBe('');

  guard.assertClean('Motiv-Werkstatt Schnellweg');
});
