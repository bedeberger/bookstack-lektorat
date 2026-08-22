// Focus-Editor gegen die ECHTE App (playwright.app.config.js) — die gefuehlten
// Schreib-Invarianten, nicht nur „oeffnet ohne Fehler" (das macht smoke.spec.js).
//
// WARUM DIESE SCHICHT trotz 52 gruener Tests in tests/e2e/focus-editor.spec.js:
// jene laufen gegen tests/fixtures/focus-harness.html mit fuenf CSS-Dateien und
// synthetischem DOM. Die Schreiblinien-Geometrie des Focus-Editors haengt aber an
// der CSS-HOEHENKETTE der echten Shell (Cardroot-Overlay, Topbar, --focus-vh /
// --focus-anchor / --focus-pad-reserve, Puffer-Paddings) und am echten
// Alpine-Template-Baum. Das Harness kann deshalb gruen bleiben, waehrend im
// echten Editor die Schreiblinie abdriftet, die erste/letzte Zeile den Anker nie
// erreicht oder der Container gar nicht mehr scrollt.
//
// Was hier geprueft wird (Invariante 9 der docs/focus-editor.md, aus Autorensicht):
//   1. die Schreibflaeche scrollt ueberhaupt (Hoehenkette intakt)
//   2. die Schreibzeile ruht beim Tippen auf dem Anker (kein Abdriften)
//   3. die ERSTE Zeile erreicht den Anker (Kopf-Puffer)
//   4. die LETZTE Zeile erreicht den Anker (Tail-Puffer)
//   5. Tippen recentert
//   6. manueller Scroll verschiebt das Spotlight auf die Viewport-Mitte
//   7. Exit raeumt Overlay/Chrome ab
//
// Toleranz ueberall = halbe Zeilenhoehe: genau die Schwelle, unter der der
// Typewriter absichtlich nicht nachzieht (typewriter.js, Jitter-Filter).

const { test, expect } = require('@playwright/test');
const { attachConsoleGuard } = require('../e2e/_helpers/console-guard');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const FOCUS = '.focus-editor__content';

// Kein `serial`: jeder Test bootet seine eigene Seite, und ein Fehlschlag soll die
// restlichen Invarianten NICHT verschlucken — der diagnostische Wert liegt darin,
// welche Teilmenge bricht.

// --- Helper -----------------------------------------------------------------

// Bis in den aktiven Fokusmodus: Buch → erste Seite (Notebook-Editor) →
// Trampoline-Event wie der Focus-Button im Page-View-Header.
async function enterFocus(page) {
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(async () => { await window.__app.selectPage(window.Alpine.store('nav').pages[0]); });
  await page.waitForFunction(() => window.__app.showEditorCard === true, null, { timeout: 15000 });

  await page.evaluate(() => window.dispatchEvent(new CustomEvent('editor:focus:enter-from-pageview')));
  await page.waitForFunction(() => {
    const el = document.querySelector('.focus-editor');
    if (!el || !window.Alpine) return false;
    const d = window.Alpine.$data(el);
    return !!d && d._focusState === 'active';
  }, null, { timeout: 15000 });
  // Entry-Recenter (scrollEntryTargetToAnchor) settlen lassen.
  await page.waitForTimeout(200);
}

// Die Seed-Seiten sind zwei Absaetze lang — zu kurz, um Scroll und Tail-Puffer zu
// pruefen. Absaetze direkt an den echten Container haengen (der MutationObserver
// nimmt sie inkrementell auf, genau wie beim Tippen entstandene Bloecke).
// Kein input-Event → editDirty bleibt false → der Exit speichert nichts.
async function seedParagraphs(page, count) {
  await page.evaluate(({ sel, n }) => {
    const el = document.querySelector(sel);
    for (let i = 0; i < n; i++) {
      const p = document.createElement('p');
      p.textContent = `Testabsatz ${i + 1}. ` + 'Nur Fuellwort fuer die Zeilenhoehe. '.repeat(3);
      el.appendChild(p);
    }
  }, { sel: FOCUS, n: count });
  await page.waitForTimeout(150);
}

// Caret in Absatz `idx` (negativ = von hinten). Bewusst IM TEXTKNOTEN, nicht als
// kollabierter Range auf dem <p>: Chromium liefert fuer letzteren keine
// Client-Rects (`getClientRects()` leer, `getBoundingClientRect()` → 0/0/0/0), und
// jede Anker-Messung waere dann stillschweigend Unsinn. Erst eine Ein-Zeichen-
// Auswahl aufziehen und auf ihr Ende kollabieren erzwingt eine echte Zeilen-Box.
async function placeCaret(page, idx) {
  const ok = await page.evaluate(({ sel, i }) => {
    const container = document.querySelector(sel);
    const ps = container.querySelectorAll('p');
    const p = i < 0 ? ps[ps.length + i] : ps[i];
    if (!p) return false;
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    let tn = null;
    while (walker.nextNode()) {
      if (walker.currentNode.length > 1) { tn = walker.currentNode; break; }
    }
    if (!tn) return false;
    container.focus({ preventScroll: true });
    const r = document.createRange();
    r.setStart(tn, Math.min(3, tn.length - 1));
    r.setEnd(tn, Math.min(4, tn.length));
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    s.collapseToEnd();
    return true;
  }, { sel: FOCUS, i: idx });
  if (!ok) throw new Error(`placeCaret(${idx}): kein Absatz mit Textknoten gefunden`);
}

// Ein Recenter-Tick am echten Card-Scope anstossen (wie jeder Caret-Move es tut).
async function recenter(page, scroll = true) {
  await page.evaluate(() => {
    window.Alpine.$data(document.querySelector('.focus-editor'))._focusUpdateActive(true);
  });
  await page.waitForTimeout(scroll ? 250 : 120);
}

// Abstand der Caret-Zeilenmitte zur Schreiblinie, plus Zeilenhoehe als Toleranzmass.
// Bezug ist der sichtbare BILDSCHIRM (visualViewport) x --focus-anchor — dieselbe
// Definition, die typewriter.js#anchorY anfaehrt.
async function caretOffsetFromAnchor(page) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const s = getSelection();
    if (!s || !s.rangeCount) return null;
    const r = s.getRangeAt(0);
    const rect = r.getClientRects()[0] || r.getBoundingClientRect();
    // Ohne echte Zeilen-Box gibt es nichts zu messen — als Fehler melden statt
    // eine 0-Koordinate gegen den Anker zu rechnen (das ergaebe einen
    // plausibel aussehenden, frei erfundenen Abstand).
    if (!(rect.height > 0)) return { invalid: true };
    const cs = getComputedStyle(el);
    const ratio = parseFloat(cs.getPropertyValue('--focus-anchor'));
    const vvTop = window.visualViewport?.offsetTop || 0;
    const vvH = window.visualViewport?.height || window.innerHeight;
    const anchor = vvTop + vvH * (Number.isFinite(ratio) ? ratio : 0.5);
    const box = el.getBoundingClientRect();
    return {
      off: (rect.top + rect.height / 2) - anchor,
      lh: parseFloat(cs.lineHeight) || 24,
      // Diagnose-Kontext: bei einem Fehlschlag soll aus der Meldung ablesbar sein,
      // WARUM die Zeile nicht auf dem Anker liegt (Scroll am Anschlag? Puffer zu
      // kurz? Box an der falschen Stelle?) — sonst beginnt die Suche bei Null.
      anchorY: Math.round(anchor),
      caretY: Math.round(rect.top + rect.height / 2),
      scrollTop: Math.round(el.scrollTop),
      scrollMax: Math.round(el.scrollHeight - el.clientHeight),
      padTop: Math.round(parseFloat(cs.paddingTop)),
      padBottom: Math.round(parseFloat(cs.paddingBottom)),
      boxTop: Math.round(box.top),
      boxHeight: Math.round(box.height),
    };
  }, FOCUS);
}

// Fehlermeldung mit vollem Geometrie-Kontext.
function geom(label, m) {
  return `${label} — off=${Math.round(m.off)} caretY=${m.caretY} anchorY=${m.anchorY} `
       + `scrollTop=${m.scrollTop}/${m.scrollMax} padTop=${m.padTop} padBottom=${m.padBottom} `
       + `box=${m.boxTop}+${m.boxHeight} lh=${Math.round(m.lh)}`;
}

// --- Tests ------------------------------------------------------------------

test('Hoehenkette: die Schreibflaeche scrollt (echtes Shell-CSS)', async ({ page }) => {
  // Regressionsnetz fuer den Klassiker: eine neue Flex-Schicht ohne
  // `min-height: 0` laesst das contenteditable auf Content-Hoehe expandieren →
  // clientHeight == scrollHeight → kein Typewriter-Scroll mehr moeglich. Im
  // Minimal-CSS-Harness unsichtbar, weil dort die Shell-Schichten fehlen.
  const guard = attachConsoleGuard(page);
  await enterFocus(page);
  await seedParagraphs(page, 40);

  const dims = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const r = el.getBoundingClientRect();
    return { client: el.clientHeight, scroll: el.scrollHeight, top: r.top, height: r.height };
  }, FOCUS);

  expect(dims.client, 'Scroll-Box hat echte Hoehe').toBeGreaterThan(200);
  expect(dims.scroll, 'Inhalt ueberragt die Box → scrollbar').toBeGreaterThan(dims.client + 200);
  // Das Overlay sitzt am Bildschirm, nicht irgendwo unterhalb des Dokuments.
  expect(dims.top).toBeLessThan(400);
  guard.assertClean('Hoehenkette');
});

test('Schreiblinie ruht beim Tippen auf dem Anker (kein Abdriften)', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await enterFocus(page);
  await seedParagraphs(page, 40);

  await placeCaret(page, 25);
  await recenter(page);

  // Mehrere Zeilenwechsel: nach jedem Enter+Text muss der Typewriter die
  // Caret-Zeile auf den Anker zurueckholen. Die Ruheposition darf nicht mit
  // jedem Schritt tiefer wandern.
  const offsets = [];
  for (let i = 0; i < 4; i++) {
    await page.evaluate((sel) => {
      document.querySelector(sel).focus();
      document.execCommand('insertParagraph');
      document.execCommand('insertText', false, 'Neue Zeile');
    }, FOCUS);
    await page.waitForTimeout(180);
    offsets.push(await caretOffsetFromAnchor(page));
  }

  for (const [i, m] of offsets.entries()) {
    expect(m?.invalid, `Messung ${i}: Caret-Zeilenbox vorhanden`).toBeFalsy();
    expect(Math.abs(m.off), geom(`Zeilenwechsel ${i + 1}`, m)).toBeLessThanOrEqual(m.lh * 0.5 + 1);
  }
  guard.assertClean('Schreiblinie beim Tippen');
});

// Kopf- und Tail-Puffer sind die Layout-Voraussetzung dafuer, dass die
// Schreibzeile ueber die GANZE Seite auf dem Anker ruht. Beide leiten sich in
// focus-mode.css aus --focus-anchor x --focus-vh ab; genau diese Rechnung sieht
// das Minimal-CSS-Harness nicht.
for (const vp of [
  { label: 'Desktop', viewport: { width: 1280, height: 900 } },
  { label: 'Mobile', viewport: { width: 390, height: 844 } },
]) {
  test(`Erste Zeile erreicht die Schreiblinie — ${vp.label}`, async ({ page }) => {
    // Um die erste Zeile auf den Anker zu senken, braeuchte es negativen Scroll —
    // den gibt es nicht. Also muss der Kopf-Puffer die Strecke abdecken; sonst
    // klemmt scrollTop bei 0 und die Zeile steht zu hoch.
    const guard = attachConsoleGuard(page);
    await page.setViewportSize(vp.viewport);
    await enterFocus(page);
    await seedParagraphs(page, 40);

    await placeCaret(page, 0);
    await recenter(page);

    const m = await caretOffsetFromAnchor(page);
    expect(m?.invalid, 'Caret-Zeilenbox vorhanden').toBeFalsy();
    expect(Math.abs(m.off), geom('erste Zeile auf dem Anker', m)).toBeLessThanOrEqual(m.lh * 0.5 + 1);
    guard.assertClean(`erste Zeile ${vp.label}`);
  });

  test(`Letzte Zeile erreicht die Schreiblinie — ${vp.label}`, async ({ page }) => {
    // Spiegelbild: unter der letzten Zeile muss genug Tail-Puffer scrollbar
    // bleiben, sonst klemmt der Scroll am Anschlag und die letzten Absaetze
    // stehen tiefer als der Anker („man kommt nur bis zum zweitletzten").
    const guard = attachConsoleGuard(page);
    await page.setViewportSize(vp.viewport);
    await enterFocus(page);
    await seedParagraphs(page, 40);

    await placeCaret(page, -1);
    await recenter(page);

    const m = await caretOffsetFromAnchor(page);
    expect(m?.invalid, 'Caret-Zeilenbox vorhanden').toBeFalsy();
    expect(Math.abs(m.off), geom('letzte Zeile auf dem Anker', m)).toBeLessThanOrEqual(m.lh * 0.5 + 1);
    guard.assertClean(`letzte Zeile ${vp.label}`);
  });
}

test('Tippen recentert (Typewriter-Scroll greift)', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await enterFocus(page);
  await seedParagraphs(page, 40);

  // Auf Anschlag oben zuruecksetzen, damit der Recenter messbar ist.
  await page.evaluate((sel) => { document.querySelector(sel).scrollTop = 0; }, FOCUS);
  await page.waitForTimeout(80);
  expect(await page.evaluate((sel) => document.querySelector(sel).scrollTop, FOCUS)).toBe(0);

  await placeCaret(page, 30);
  await page.keyboard.type('x');
  await page.waitForTimeout(300);

  // Bewusst NICHT nur „scrollTop hat sich bewegt": das tut auch der native
  // Caret-Scroll des Browsers, wenn der Typewriter gar nicht laeuft (mit einem
  // abgeschalteten runTypewriter blieb genau diese Fassung des Tests gruen).
  // Gepruefte Eigenschaft ist die Ziel-Geometrie: die getippte Zeile LIEGT auf
  // dem Anker.
  const m = await caretOffsetFromAnchor(page);
  expect(m?.invalid, 'Caret-Zeilenbox vorhanden').toBeFalsy();
  expect(m.scrollTop, 'Tippen weit unten scrollt ueberhaupt').toBeGreaterThan(200);
  expect(Math.abs(m.off), geom('getippte Zeile auf dem Anker', m)).toBeLessThanOrEqual(m.lh * 0.5 + 1);
  guard.assertClean('Tippen recentert');
});

test('Manueller Scroll verschiebt das Spotlight auf die Viewport-Mitte', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await enterFocus(page);
  await seedParagraphs(page, 40);

  // Caret oben halten: bei Caret-first bliebe das Spotlight hier kleben, auch
  // wenn der User weit nach unten scrollt.
  await placeCaret(page, 0);
  await recenter(page, false);

  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    el.scrollTop = Math.round(el.scrollHeight * 0.6);
  }, FOCUS);
  await page.waitForTimeout(200);

  const { activeIdx, centerIdx } = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    // Keine prog-Scroll-Marke → echter User-Scroll, kein Typewriter-Scroll.
    const d = window.Alpine.$data(document.querySelector('.focus-editor'));
    if (d._focusListeners) d._focusListeners.progScroll = null;
    el.dispatchEvent(new Event('scroll'));
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
      const ps = [...el.querySelectorAll('p')];
      const active = el.querySelector('.focus-paragraph-active');
      const cr = el.getBoundingClientRect();
      const centerY = cr.top + cr.height / 2;
      let best = -1;
      let bestDist = Infinity;
      ps.forEach((p, i) => {
        const r = p.getBoundingClientRect();
        const dist = Math.abs((r.top + r.bottom) / 2 - centerY);
        if (dist < bestDist) { bestDist = dist; best = i; }
      });
      resolve({ activeIdx: active ? ps.indexOf(active) : -1, centerIdx: best });
    })));
  }, FOCUS);

  expect(activeIdx, 'Spotlight nicht mehr beim Caret-Absatz').toBeGreaterThan(0);
  expect(Math.abs(activeIdx - centerIdx), 'Spotlight folgt der Viewport-Mitte').toBeLessThanOrEqual(1);
  guard.assertClean('manueller Scroll');
});

test('Schmales Fenster: Schreiblinie haelt, kein horizontaler Overflow (Akzeptanz #10)', async ({ page }) => {
  // Punkt 10 der Klickliste — bis hierher die einzige Position ohne jede
  // automatische Abdeckung. Zwei Eigenschaften, die nur mit echtem Shell-CSS
  // messbar sind:
  //
  //   a) KEIN horizontaler Overflow. Die Textspalte wird ueber `padding-inline:
  //      max(2rem, safe-area, calc((100% - 60ch) / 2))` zentriert (Invariante
  //      11a) — im content-box-Modell addiert sich dieses Prozent-Padding auf
  //      `width: 100%` und die Box laeuft breiter als das Fenster. Dagegen steht
  //      ein explizites `box-sizing: border-box` am Container, denn der globale
  //      `*`-Reset lebt in layout/base.css, die weder das Harness noch die
  //      nativen Client-Schalen laden. Genau diese Absicherung war ungetestet.
  //      Mutationsgeprueft: `content-box` am Container → box=500 bei win=480.
  //
  //   b) Die Schreiblinie liegt weiter auf dem Anker. Bei 480px greifen andere
  //      Zweige der Puffer-Formel (schmalere Spalte → mehr Zeilen pro Absatz,
  //      kleinere Box), und ein Media-Query-Override der Puffer waere hier
  //      sofort sichtbar (Invariante 9 verbietet ihn deshalb).
  const guard = attachConsoleGuard(page);
  await page.setViewportSize({ width: 480, height: 800 });
  await enterFocus(page);
  await seedParagraphs(page, 40);

  const overflow = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const de = document.documentElement;
    const cs = getComputedStyle(el);
    return {
      boxOverflow: el.scrollWidth - el.clientWidth,
      docOverflow: de.scrollWidth - de.clientWidth,
      bodyOverflow: document.body.scrollWidth - document.body.clientWidth,
      boxSizing: cs.boxSizing,
      boxWidth: Math.round(el.getBoundingClientRect().width),
      winWidth: window.innerWidth,
    };
  }, FOCUS);

  // Die Box darf nicht breiter sein als das Fenster — sonst schiebt das Padding
  // die Spalte aus dem Bild und der Text wird seitlich abgeschnitten.
  expect(overflow.boxSizing, 'border-box am Container (Invariante 11a)').toBe('border-box');
  expect(overflow.boxWidth,
    `Schreibflaeche passt ins Fenster (box=${overflow.boxWidth} win=${overflow.winWidth})`)
    .toBeLessThanOrEqual(overflow.winWidth);
  expect(overflow.boxOverflow, 'kein H-Scroll in der Schreibflaeche').toBeLessThanOrEqual(1);
  expect(overflow.docOverflow, 'kein H-Scroll im Dokument').toBeLessThanOrEqual(1);
  expect(overflow.bodyOverflow, 'kein H-Scroll im Body').toBeLessThanOrEqual(1);

  // …und die Geometrie haelt trotzdem, an beiden Enden der Seite.
  await placeCaret(page, 0);
  await recenter(page);
  let m = await caretOffsetFromAnchor(page);
  expect(m?.invalid, 'Caret-Zeilenbox vorhanden (erste Zeile)').toBeFalsy();
  expect(Math.abs(m.off), geom('schmal: erste Zeile auf dem Anker', m)).toBeLessThanOrEqual(m.lh * 0.5 + 1);

  await placeCaret(page, -1);
  await recenter(page);
  m = await caretOffsetFromAnchor(page);
  expect(m?.invalid, 'Caret-Zeilenbox vorhanden (letzte Zeile)').toBeFalsy();
  expect(Math.abs(m.off), geom('schmal: letzte Zeile auf dem Anker', m)).toBeLessThanOrEqual(m.lh * 0.5 + 1);

  guard.assertClean('schmales Fenster');
});

test('Offene Textauswahl blockt den Recenter (Akzeptanz #7)', async ({ page }) => {
  // Zweite Haelfte von Punkt 7: der Doppelklick-Fall ist im Harness und im
  // WebKit-Projekt gegated, „Auswahl offen → Viewport springt nicht" war es
  // nicht. Der Guard sitzt in card.js#_focusUpdateActive (`hasSelection` →
  // runTypewriter wird uebersprungen); ohne ihn reisst jeder Tick, den die
  // Auswahl selbst ausloest, die markierte Passage aus dem Bild.
  // Mutationsgeprueft: `hasSelection` auf false gezwungen → scrollTop springt.
  const guard = attachConsoleGuard(page);
  await enterFocus(page);
  await seedParagraphs(page, 40);

  // Ausgangslage weit weg vom Anker erzeugen: Caret oben, dann manuell in die
  // Mitte scrollen. Ein Recenter waere jetzt eine sichtbare Sprungstrecke.
  await placeCaret(page, 0);
  await recenter(page, false);
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    el.scrollTop = Math.round(el.scrollHeight * 0.5);
  }, FOCUS);
  await page.waitForTimeout(200);

  // Referenzposition VOR dem Aufziehen nehmen. Das Setzen der Auswahl feuert
  // selbst ein `selectionchange` und damit einen Recenter-Tick — wird erst danach
  // gemessen, ist der verbotene Sprung schon passiert und der Test bliebe gruen,
  // obwohl der Guard fehlt (genau so lief die erste Fassung ins Leere).
  const before = await page.evaluate((sel) => document.querySelector(sel).scrollTop, FOCUS);

  // Auswahl ueber zwei Absaetze aufziehen (nicht kollabiert).
  const spanned = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const vis = [...el.querySelectorAll('p')].filter(p => {
      const r = p.getBoundingClientRect();
      return r.top > el.getBoundingClientRect().top + 40 && r.bottom < window.innerHeight - 40;
    });
    if (vis.length < 2) return false;
    const a = vis[0]; const b = vis[1];
    const r = document.createRange();
    r.setStart(a.firstChild, 2);
    r.setEnd(b.firstChild, Math.min(6, b.firstChild.length));
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    return !s.isCollapsed;
  }, FOCUS);
  expect(spanned, 'Auswahl ueber zwei Absaetze aufgezogen').toBe(true);

  // Den selectionchange-Tick auslaufen lassen, dann zusaetzlich explizit einen
  // Recenter MIT scroll-Wunsch anstossen — beide Wege muessen am Guard scheitern.
  await page.waitForTimeout(300);
  await recenter(page);
  const after = await page.evaluate((sel) => ({
    top: document.querySelector(sel).scrollTop,
    collapsed: getSelection().isCollapsed,
    text: getSelection().toString().length,
  }), FOCUS);

  expect(after.collapsed, 'Auswahl steht noch').toBe(false);
  expect(after.text, 'Auswahl hat Inhalt').toBeGreaterThan(0);
  expect(Math.abs(after.top - before),
    `Viewport springt nicht (scrollTop ${before} → ${after.top})`).toBeLessThanOrEqual(1);
  guard.assertClean('Auswahl blockt Recenter');
});

test('Viewport-Tick laesst die Scroll-Position stehen (kein Sprung nach oben)', async ({ page }) => {
  // Die Slot-Messung in viewport.js#measureBoxGeometry nullt kurz die Kopf-/
  // Tail-Puffer und liest dann `clientHeight` — das erzwingt ein Layout, in dem
  // `scrollHeight` um die Puffersumme (~eine Boxhoehe) faellt. Der Browser klemmt
  // `scrollTop` dabei auf das neue Maximum, und das Zuruecksetzen des Paddings
  // hebt den Klemm-Vorgang NICHT auf: ohne manuelle Rueckstellung sprang der
  // Editor bei JEDEM Viewport-Tick nach oben, weit unten in der Seite um fast
  // eine Bildschirmhoehe. Auf Mobile feuert der Tick bei jedem vv-Scroll — daher
  // das „nervoese" Scrollen beim Schreiben.
  //
  // Nur mit echtem Shell-CSS pruefbar: das Harness hat keine Puffer-Formel, und
  // in jsdom gibt es kein Layout und damit kein Clamping.
  //
  // Zwei Ausloeser, beide ohne Recenter-Reparatur: `shouldRecenterOnViewport`
  // verlangt eine Aenderung von Hoehe ODER Versatz > 1px, hier aendert sich
  // keines von beiden. Genau darum blieb der Sprung stehen.
  const guard = attachConsoleGuard(page);
  await enterFocus(page);
  await seedParagraphs(page, 40);

  // Weit unten positionieren — nur dort ist die Klemm-Strecke gross.
  await placeCaret(page, -1);
  await recenter(page);

  const paraOf = (sel) => {
    const el = document.querySelector(sel);
    const active = el.querySelector('.focus-paragraph-active');
    return { top: Math.round(el.scrollTop), idx: active ? [...el.querySelectorAll('p')].indexOf(active) : -1 };
  };

  const before = await page.evaluate(paraOf, FOCUS);
  expect(before.top, 'Ausgangslage weit unten (sonst misst der Test nichts)').toBeGreaterThan(400);

  // a) Tick ohne jede Dimensionsaenderung — der Mobile-Fall (vv-scroll bei
  //    offener Tastatur), reflow-frei und damit exakt messbar.
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await page.waitForTimeout(300);   // > VV_DEBOUNCE_MS (100)
  let after = await page.evaluate(paraOf, FOCUS);
  expect(after.top, `Scroll-Position haelt ueber den Viewport-Tick (${before.top} → ${after.top})`)
    .toBeLessThanOrEqual(before.top + 2);
  expect(after.top, `kein Sprung nach oben (${before.top} → ${after.top})`)
    .toBeGreaterThanOrEqual(before.top - 2);
  expect(after.idx, 'Spotlight bleibt auf dem Caret-Absatz').toBe(before.idx);

  // b) Echter Resize, nur in der BREITE. Der Text laeuft dabei um (mehr Zeilen →
  //    hoehere Box), aber `scrollTop` ist eine Pixel-Position und wird davon
  //    nicht renormalisiert — nur das Clamping koennte sie bewegen.
  const w = page.viewportSize().width;
  await page.setViewportSize({ width: w - 160, height: page.viewportSize().height });
  await page.waitForTimeout(300);
  after = await page.evaluate(paraOf, FOCUS);
  expect(after.top, `Breiten-Resize verschiebt die Position nicht (${before.top} → ${after.top})`)
    .toBeGreaterThanOrEqual(before.top - 2);

  guard.assertClean('Viewport-Tick haelt die Scroll-Position');
});

test('Exit raeumt Overlay + Chrome ab', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await enterFocus(page);

  await expect(page.locator('body')).toHaveClass(/focus-mode/);
  await expect(page.locator('.focus-editor')).toHaveClass(/is-active/);

  await page.evaluate(() => window.dispatchEvent(new CustomEvent('editor:focus:exit')));
  await page.waitForFunction(() => {
    const d = window.Alpine.$data(document.querySelector('.focus-editor'));
    return d._focusState === 'idle';
  }, null, { timeout: 15000 });
  await page.waitForTimeout(200);

  await expect(page.locator('body')).not.toHaveClass(/focus-mode/);
  const state = await page.evaluate(() => ({
    focusActive: window.__app.focusActive,
    listeners: window.Alpine.$data(document.querySelector('.focus-editor'))._focusListeners,
    marks: document.querySelectorAll('.focus-paragraph-active, .focus-paragraph-near').length,
  }));
  expect(state.focusActive).toBe(false);
  expect(state.listeners, 'Listener-Kontext abgeraeumt').toBeNull();
  expect(state.marks, 'keine Restmarkierungen').toBe(0);
  guard.assertClean('Exit');
});

test('Leerschlag an der Umbruchkante: Wort bleibt stehen, kein &nbsp;', async ({ page }) => {
  // Der Bug: unter `white-space: normal` schreibt Blink fuer einen Leerschlag,
  // der am Zeilenende kollabieren wuerde, ein `&nbsp;` in den Text und wandelt
  // es beim naechsten Zeichen zurueck ("whitespace rebalancing"). Ein `&nbsp;`
  // ist umbruchfest — passt Wort + `&nbsp;` nicht mehr in die Zeile, faellt das
  // ganze Wort eine Zeile runter und springt beim naechsten Zeichen zurueck.
  // Dagegen steht die pre-wrap-Regel auf den Schreibbloecken (Invariante 11c):
  // ein Leerschlag am Zeilenende haengt dann ueber den Rand hinaus, statt das
  // Wort mitzureissen.
  //
  // Deterministisch gemacht, weil das Symptom sonst positionsabhaengig ist: die
  // Zeile wird per Layout-Messung exakt bis an die Kante gefuellt (letztes Wort
  // passt gerade noch), dann faellt EIN Leerschlag. Der darf die Blockhoehe
  // nicht veraendern — ein Leerschlag allein braucht nie eine neue Zeile.
  // Erst das darauf folgende echte Zeichen darf umbrechen.
  //
  // Mutationsgeprueft: `white-space: normal !important` auf die Bloecke
  // injiziert (unlayered schlaegt @layer) → Hoehe springt 81 → 122 beim blossen
  // Leerschlag und nbsp=1, beide Assertions rot.
  //
  // Diese Schicht, nicht das Harness: die Zeilenbreite haengt an der echten
  // Spaltenbreite (`padding-inline`-Formel, Invariante 11a) und an der echten
  // Schriftmetrik — im Minimal-CSS des Harness ist die Kante eine andere.
  const guard = attachConsoleGuard(page);
  await enterFocus(page);
  await seedParagraphs(page, 12);

  // Absatz so fuellen, dass das letzte Wort gerade noch auf die Zeile passt.
  const fitted = await page.evaluate((sel) => {
    const p = document.querySelector(sel).querySelectorAll('p')[4];
    const base = 'Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda my ny xi omikron pi rho sigma tau ypsilon phi chi psi omega ';
    p.textContent = base;
    const oneLine = p.getBoundingClientRect().height;
    let word = '';
    for (let i = 0; i < 80; i++) {
      p.textContent = base + word + 'x';
      if (p.getBoundingClientRect().height > oneLine) break;
      word += 'x';
    }
    p.textContent = base + word;
    // Caret ans Textende.
    const t = p.firstChild;
    const r = document.createRange();
    r.setStart(t, t.nodeValue.length);
    r.collapse(true);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    return { height: p.getBoundingClientRect().height, wordLen: word.length };
  }, FOCUS);

  expect(fitted.wordLen, 'Zeile liess sich nicht bis an die Kante fuellen').toBeGreaterThan(0);
  await page.waitForTimeout(120);

  const read = () => page.evaluate((sel) => {
    const p = document.querySelector(sel).querySelectorAll('p')[4];
    return {
      height: p.getBoundingClientRect().height,
      nbsp: (p.textContent.match(/ /g) || []).length,
    };
  }, FOCUS);

  await page.keyboard.type(' ');
  const afterSpace = await read();
  await page.keyboard.type('y');
  const afterChar = await read();

  expect(afterSpace.nbsp, 'Blink hat den Leerschlag zu &nbsp; umgeschrieben').toBe(0);
  expect(afterSpace.height, 'blosser Leerschlag hat das Wort eine Zeile runtergerissen')
    .toBeCloseTo(fitted.height, 0);
  // Gegenprobe: das echte Zeichen darf und soll umbrechen.
  expect(afterChar.height, 'Zeichen nach der Kante bricht nicht um').toBeGreaterThan(fitted.height);
  guard.assertClean('Umbruchkante');
});

// --- Undo/Redo im Fokusmodus der SPA ---------------------------------------
//
// Zweite betroffene Oberflaeche neben dem nativen Client: die Web-SPA im
// Fokusmodus (Safari/iOS trifft dieselbe WebKit-Undo-Koernung, siehe
// tests/e2e/focus-undo.webkit.spec.js). Hier gegen die ECHTE App, weil genau das
// die Konstellation ist, die kein Harness abbildet: der Fokusmodus haengt an der
// Session-Historie der NOTEBOOK-Karte (gespiegelter Container, `_getEditEl` loest
// dorthin auf, `@input="_markEditDirty()"` schiebt die Snapshots dorthin) — ein
// Fixture ohne Alpine-Root und ohne Notebook-Karte kann das nicht zeigen.
//
// Der Kern: `notebookUndo`/`notebookRedo` trugen ein `|| app.focusActive`-Gate.
// Der Stack lief also voll, war im Fokusmodus aber unbenutzbar, und es griff der
// browsereigene Stack — unter WebKit mit einer ganzen Tippstrecke pro Schritt.
test('Fokusmodus: Undo/Redo laufen auf der Session-Historie der Notebook-Karte', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await enterFocus(page);
  await placeCaret(page, 0);

  await page.keyboard.type(' ERSTERBLOCK');
  await page.waitForTimeout(650);       // ueber den Debounce → Schrittgrenze
  await page.keyboard.type(' ZWEITERBLOCK');
  await page.waitForTimeout(650);

  // Das Gate sass hier: im Fokusmodus meldete die Karte nie „undo moeglich".
  expect(await page.evaluate(() => window.__app.notebookCanUndo()), 'Historie im Fokusmodus leer').toBe(true);

  const text = () => page.evaluate((sel) => document.querySelector(sel).textContent, FOCUS);
  await page.evaluate(() => window.__app.notebookUndo());
  await page.waitForTimeout(120);

  let t = await text();
  expect(t, 'Undo nahm die letzte Tippstrecke nicht zurueck').not.toContain('ZWEITERBLOCK');
  expect(t, 'Undo nahm zu viel zurueck').toContain('ERSTERBLOCK');

  await page.evaluate(() => window.__app.notebookRedo());
  await page.waitForTimeout(120);
  expect(await text(), 'Redo im Fokusmodus wirkungslos').toContain('ZWEITERBLOCK');

  // Der Fokus-Editor darf danach nicht ohne Markierung dastehen (Invariante 18).
  expect(await page.locator('.focus-paragraph-active').count()).toBe(1);
  guard.assertClean('Fokus-Undo');
});

test('Fokusmodus: Cmd/Ctrl+Z wird im Editor konsumiert (kein zweiter Stack)', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await enterFocus(page);
  await placeCaret(page, 0);

  await page.evaluate(() => {
    window.__zSeen = [];
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') window.__zSeen.push(e.defaultPrevented);
    });
  });

  await page.keyboard.type(' TIPPSTRECKE');
  await page.waitForTimeout(650);
  await page.keyboard.press('ControlOrMeta+z');
  await page.waitForTimeout(150);

  // Der Container-Handler verbraucht das Event (stopPropagation); kommt es dennoch
  // am document an, MUSS defaultPrevented gesetzt sein — sonst laeuft der
  // Browser-Undo zusaetzlich und ein Cmd+Z wirkt doppelt.
  const seen = await page.evaluate(() => window.__zSeen);
  expect(seen.every(Boolean), 'Cmd+Z lief unverbraucht zum Browser durch').toBe(true);
  expect(await page.evaluate((sel) => document.querySelector(sel).textContent, FOCUS))
    .not.toContain('TIPPSTRECKE');
  guard.assertClean('Fokus-Undo-Taste');
});
