// Slash-Menü-Positionierung (Notebook-Editor) — reine Geometrie.
//
// Ergänzt tests/e2e-app/notebook-slash-position.spec.js: dort läuft die echte App
// mit echtem CSS, aber die Bildschirmtastatur lässt sich in Chromium nicht
// öffnen. Genau ihr Effekt ist hier der Testgegenstand — sie schrumpft (und
// verschiebt) den `visualViewport`, während `window.innerHeight` unverändert
// bleibt. Wer nach `innerHeight` positioniert, schiebt das Menü hinter die
// Tastatur; das Menü muss stattdessen im sichtbaren Band bleiben.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { slashMethods } = await import('../../public/js/editor/notebook/toolbar/slash.js');

// Minimal-Harness: ein Trigger-Block mit fixem Rect und ein Menü-Element, dessen
// Höhe sich (wie im Browser) am gesetzten max-height deckelt.
function makeCtx({ blockTop, blockHeight = 24, contentHeight, band, innerHeight = 900, innerWidth = 400, menuWidth = 282 }) {
  const menu = {
    style: {},
    get offsetHeight() {
      const cap = parseFloat(this.style.maxHeight);
      return Number.isFinite(cap) ? Math.min(contentHeight, cap) : contentHeight;
    },
    offsetWidth: menuWidth,
  };
  global.window = {
    innerHeight,
    innerWidth,
    visualViewport: band ? { offsetTop: band.top, offsetLeft: band.left ?? 0, height: band.height, width: band.width ?? innerWidth } : null,
  };
  return {
    slashShow: true,
    slashX: 0,
    slashY: 0,
    slashMaxH: 360,
    _slashBlock: {
      isConnected: true,
      getBoundingClientRect: () => ({
        top: blockTop, bottom: blockTop + blockHeight, left: 40, right: 40 + 200, height: blockHeight, width: 200,
      }),
    },
    $refs: { slashMenu: menu },
    _closeSlash() { this.slashShow = false; },
    _updateSlashPosition: slashMethods._updateSlashPosition,
    _menu: menu,
  };
}

test.afterEach(() => { delete global.window; });

test('Tastatur offen: Menü bleibt im sichtbaren Band, nicht im Layout-Viewport', () => {
  // Typisch iOS/Android: Layout-Viewport 900 hoch, sichtbares Band nur 380
  // (Tastatur), Caret-Block im unteren Drittel des Bandes.
  const ctx = makeCtx({ blockTop: 300, contentHeight: 360, innerHeight: 900, band: { top: 0, height: 380 } });
  ctx._updateSlashPosition();
  const h = ctx._menu.offsetHeight;
  assert.ok(ctx.slashShow, 'Menü bleibt offen');
  assert.ok(ctx.slashY >= 0, `Oberkante im Band (war ${ctx.slashY})`);
  assert.ok(ctx.slashY + h <= 380, `Unterkante im Band, nicht hinter der Tastatur (war ${ctx.slashY + h})`);
});

test('Tastatur offen: Höhe wird auf das sichtbare Band gedeckelt', () => {
  const ctx = makeCtx({ blockTop: 200, contentHeight: 360, innerHeight: 900, band: { top: 0, height: 300 } });
  ctx._updateSlashPosition();
  assert.ok(ctx.slashMaxH <= 300 - 8, `max-height passt ins Band (war ${ctx.slashMaxH})`);
  assert.equal(ctx._menu.style.maxHeight, ctx.slashMaxH + 'px', 'Deckel vor dem Messen angewandt');
});

test('verschobenes Band (offsetTop) verschiebt das Menü mit', () => {
  // Android Chrome kann den visualViewport zusätzlich scrollen.
  const ctx = makeCtx({ blockTop: 500, contentHeight: 360, innerHeight: 900, band: { top: 200, height: 400 } });
  ctx._updateSlashPosition();
  const h = ctx._menu.offsetHeight;
  assert.ok(ctx.slashY >= 200, `nicht über die Bandkante (war ${ctx.slashY})`);
  assert.ok(ctx.slashY + h <= 600, `nicht unter die Bandkante (war ${ctx.slashY + h})`);
});

test('kein Platz oberhalb → Menü klappt unter den Block', () => {
  const ctx = makeCtx({ blockTop: 20, contentHeight: 360, innerHeight: 900, band: { top: 0, height: 900 } });
  ctx._updateSlashPosition();
  assert.ok(ctx.slashY >= 20 + 24, `unterhalb des Blocks (war ${ctx.slashY})`);
});

test('Platz oberhalb → Vorzugsrichtung bleibt oben und klebt am Block', () => {
  const ctx = makeCtx({ blockTop: 500, contentHeight: 360, innerHeight: 900, band: { top: 0, height: 900 } });
  ctx._updateSlashPosition();
  const h = ctx._menu.offsetHeight;
  assert.equal(Math.round(500 - (ctx.slashY + h)), 4, 'Menü-Unterkante 4 px über dem Block');
});

test('kurze Trefferliste hebt das Menü nicht vom Block ab (gemessene Höhe)', () => {
  const ctx = makeCtx({ blockTop: 500, contentHeight: 81, innerHeight: 900, band: { top: 0, height: 900 } });
  ctx._updateSlashPosition();
  assert.equal(Math.round(500 - (ctx.slashY + 81)), 4, 'Unterkante klebt trotz kurzer Liste am Block');
});

test('schmaler Viewport: Menü wird horizontal in das Band geklemmt', () => {
  const ctx = makeCtx({ blockTop: 500, contentHeight: 360, innerWidth: 320, menuWidth: 300, band: { top: 0, height: 900, width: 320 } });
  ctx._updateSlashPosition();
  assert.ok(ctx.slashX >= 4, `nicht links raus (war ${ctx.slashX})`);
  assert.ok(ctx.slashX + 300 <= 320 - 4 + 0.01, `nicht rechts raus (war ${ctx.slashX + 300})`);
});

test('Block aus dem Band gescrollt → Menü schliesst', () => {
  const ctx = makeCtx({ blockTop: 700, contentHeight: 360, innerHeight: 900, band: { top: 0, height: 380 } });
  ctx._updateSlashPosition();
  assert.equal(ctx.slashShow, false, 'Menü geschlossen statt am Bandrand geparkt');
});

test('ohne visualViewport (Desktop/alte Browser) bleibt innerHeight die Referenz', () => {
  const ctx = makeCtx({ blockTop: 500, contentHeight: 360, innerHeight: 900, band: null });
  ctx._updateSlashPosition();
  const h = ctx._menu.offsetHeight;
  assert.ok(ctx.slashY >= 0 && ctx.slashY + h <= 900, `im Viewport (war ${ctx.slashY}..${ctx.slashY + h})`);
  assert.equal(Math.round(500 - (ctx.slashY + h)), 4, 'klebt am Block');
});
