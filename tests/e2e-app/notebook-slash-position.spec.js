// Slash-Menü-Position im NOTEBOOK-Editor gegen die ECHTE App.
//
// WARUM DIESE SCHICHT: das Menü wird nach <body> teleportiert und per JS
// positioniert; seine Höhe entsteht erst aus der gerenderten Trefferliste unter
// dem echten Shell-CSS (`max-height`, Gruppen-Header, Item-Typografie). Ein
// Fixture-Harness kann deshalb grün bleiben, während das Menü in der App aus dem
// Viewport ragt. Auf Mobile ist genau das der Kernfall: das voll besetzte Menü
// braucht ~360 px, im sichtbaren Band über dem Caret sind aber oft weniger frei.
//
// Geprüfte Invarianten (public/js/editor/notebook/toolbar/slash.js):
//   1. das Menü liegt vollständig im sichtbaren Band (oben/unten/links/rechts)
//   2. es klebt am Trigger-Block — oberhalb (Vorzug) oder unterhalb (Flip)
//   3. Filtern (Menü schrumpft) löst es nicht vom Block (gemessene Höhe)
// Prüft Mobile UND Desktop, damit der Flip die Desktop-Vorzugsrichtung nicht
// still umdreht.

const { test, expect } = require('@playwright/test');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const EDIT_SEL = '#editor-card .page-content-view--editing';
const GAP_TOL = 12;   // Abstand Menü↔Block: 4 px Soll + Sub-Pixel/Zeilenrundung

async function enterNotebookEdit(page) {
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(async () => { await window.__app.selectPage(window.Alpine.store('nav').pages[0]); });
  await page.waitForFunction(() => window.__app.showEditorCard === true, null, { timeout: 15000 });
  await page.evaluate(() => window.__app.startEdit());
  await page.waitForSelector(EDIT_SEL, { timeout: 15000 });
  await page.waitForTimeout(300);
}

// Genug Absätze für echten Scroll + leerer Ziel-Absatz als Slash-Trigger.
// `after` ist wichtig: nur mit Text UNTER dem Trigger lässt er sich überhaupt an
// die obere Viewport-Kante scrollen — der Fall, in dem oberhalb kein Platz mehr
// für die Liste ist. Kein input-Event → editDirty bleibt false → nichts wird
// gespeichert.
async function seedTriggerBlock(page, before, after) {
  await page.evaluate(({ before, after }) => {
    const editEl = document.querySelector('#editor-card .page-content-view--editing');
    const filler = (i) => {
      const p = document.createElement('p');
      p.textContent = 'Absatz ' + i + ' mit genug Text, damit die Seite scrollt und Zeilen umbrechen.';
      return p;
    };
    for (let i = 0; i < before; i++) editEl.appendChild(filler(i));
    const target = document.createElement('p');
    target.id = 'slash-trigger';
    target.appendChild(document.createElement('br'));
    editEl.appendChild(target);
    for (let i = 0; i < after; i++) editEl.appendChild(filler(before + i));
  }, { before, after });
}

// Trigger-Block an die gewünschte Stelle scrollen und warten, bis die Geometrie
// ruht (die Editor-Höhenkette settelt sonst NACH dem Scroll nach).
async function scrollTriggerTo(page, block) {
  await page.evaluate(async (pos) => {
    const el = document.getElementById('slash-trigger');
    let last = null;
    for (let i = 0; i < 12; i++) {
      el.scrollIntoView({ block: pos });
      await new Promise((r) => setTimeout(r, 120));
      const top = Math.round(el.getBoundingClientRect().top);
      if (top === last) return;
      last = top;
    }
  }, block);
}

// `/` im leeren Block öffnet das Menü; `query` tippt danach Filterzeichen.
// Die Positionierung läuft über requestAnimationFrame → zwei Frames abwarten.
async function openSlash(page, query) {
  await page.evaluate(async (q) => {
    const editEl = document.querySelector('#editor-card .page-content-view--editing');
    const el = document.getElementById('slash-trigger');
    const sel = document.getSelection();
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(true);
    // preventScroll: ein normaler focus() scrollt den ganzen Editor-Container an
    // den Anfang und macht die vorher eingestellte Scroll-Position kaputt.
    editEl.focus({ preventScroll: true });
    sel.removeAllRanges();
    sel.addRange(r);
    const key = (k) => editEl.dispatchEvent(
      new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    key('/');
    for (const ch of (q || '')) key(ch);
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
  }, query);
}

async function closeSlash(page) {
  await page.evaluate(() => {
    document.querySelector('#editor-card .page-content-view--editing')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
}

async function geometry(page) {
  return page.evaluate(() => {
    const m = document.querySelector('.edit-slash-menu');
    const b = document.getElementById('slash-trigger');
    const mr = m.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    return {
      shown: getComputedStyle(m).display !== 'none',
      menu: { top: mr.top, bottom: mr.bottom, left: mr.left, right: mr.right, height: mr.height },
      block: { top: br.top, bottom: br.bottom },
      vw: window.innerWidth,
      vh: window.innerHeight,
    };
  });
}

function expectInsideViewport(g, label) {
  expect(g.shown, `${label}: Menü sichtbar`).toBe(true);
  expect(g.menu.height, `${label}: Menü hat Höhe`).toBeGreaterThan(0);
  expect(g.menu.top, `${label}: nicht über der oberen Kante`).toBeGreaterThanOrEqual(0);
  expect(g.menu.bottom, `${label}: nicht unter der unteren Kante`).toBeLessThanOrEqual(g.vh);
  expect(g.menu.left, `${label}: nicht links raus`).toBeGreaterThanOrEqual(0);
  expect(g.menu.right, `${label}: nicht rechts raus`).toBeLessThanOrEqual(g.vw);
}

function expectAnchored(g, label) {
  const gapAbove = Math.abs(g.block.top - g.menu.bottom);   // Menü über dem Block
  const gapBelow = Math.abs(g.menu.top - g.block.bottom);   // Menü unter dem Block
  expect(Math.min(gapAbove, gapBelow), `${label}: klebt am Trigger-Block`)
    .toBeLessThanOrEqual(GAP_TOL);
}

test.describe('Notebook-Slash-Menü — Mobile', () => {
  test.use({ viewport: { width: 360, height: 640 }, hasTouch: true, isMobile: true });

  test('bleibt im Viewport und am Block — mittig, oben, gefiltert, unten', async ({ page }) => {
    await enterNotebookEdit(page);
    await seedTriggerBlock(page, 40, 40);

    // (a) Block in der Mitte: oberhalb reicht es knapp für die volle Liste.
    await scrollTriggerTo(page, 'center');
    await openSlash(page);
    let g = await geometry(page);
    expectInsideViewport(g, 'mittig');
    expectAnchored(g, 'mittig');
    await closeSlash(page);

    // (b) Block an der oberen Kante: oberhalb ist nichts frei — das Menü MUSS
    // nach unten klappen statt oben aus dem Viewport zu ragen.
    await scrollTriggerTo(page, 'start');
    await openSlash(page);
    g = await geometry(page);
    expect(g.block.top, 'oben: Trigger wirklich an der oberen Kante')
      .toBeLessThan(200);
    expectInsideViewport(g, 'oben');
    expectAnchored(g, 'oben');
    expect(g.menu.top, 'oben: Menü liegt unter dem Block (Flip)')
      .toBeGreaterThanOrEqual(g.block.bottom - 1);
    await closeSlash(page);

    // (c) Gefiltert: die Liste schrumpft auf wenige Treffer.
    await scrollTriggerTo(page, 'center');
    await openSlash(page, 'zitat');
    g = await geometry(page);
    expect(g.menu.height, 'gefiltert: Liste ist kürzer als die volle')
      .toBeLessThan(200);
    expectInsideViewport(g, 'gefiltert');
    expectAnchored(g, 'gefiltert');
    await closeSlash(page);

    // (d) Gefiltert am UNTEREN Rand: hier klappt das Menü nach oben und wird per
    // Höhen-Subtraktion positioniert — genau die Konstellation, in der eine
    // geratene statt gemessene Höhe das Menü vom Block abheben lässt
    // (harte Regel „Flip-up-Popover messen statt raten").
    await scrollTriggerTo(page, 'end');
    await openSlash(page, 'zitat');
    g = await geometry(page);
    expect(g.menu.height, 'unten+gefiltert: kurze Liste').toBeLessThan(200);
    expectInsideViewport(g, 'unten+gefiltert');
    expectAnchored(g, 'unten+gefiltert');
    expect(g.menu.bottom, 'unten+gefiltert: Menü sitzt direkt über dem Block')
      .toBeLessThanOrEqual(g.block.top + 1);
    await closeSlash(page);
  });
});

test.describe('Notebook-Slash-Menü — Desktop', () => {
  test('öffnet oberhalb des Blocks und bleibt im Viewport', async ({ page }) => {
    await enterNotebookEdit(page);
    await seedTriggerBlock(page, 40, 40);
    await scrollTriggerTo(page, 'center');
    await openSlash(page);
    const g = await geometry(page);
    expectInsideViewport(g, 'desktop');
    expectAnchored(g, 'desktop');
    // Vorzugsrichtung: oberhalb (näher am Caret in langen Texten).
    expect(g.menu.bottom, 'desktop: Menü liegt über dem Block')
      .toBeLessThanOrEqual(g.block.top + 1);
    await closeSlash(page);
  });
});
