// Auto-Hide des Mauszeigers im Fokusmodus: Maus 2 s ruhig → Zeiger unsichtbar,
// nächste Bewegung bringt ihn zurück (reiner Klassentoggle auf `.focus-editor`).
// Bei offenem Popover/Menü (CURSOR_KEEP_SEL) wird neu bewaffnet statt versteckt —
// der Zeiger muss sichtbar bleiben, solange man Vorschläge liest; nach dem
// Schliessen greift Auto-Hide ohne Mausbewegung wieder.
//
// Pendant im CSS: `.focus-cursor-hidden` in
// public/css/editor/focus/focus-mode.css.

import { CURSOR_HIDE_MS, CURSOR_KEEP_SEL } from './constants.js';

// `ctx.cursorTimer` hält den Timer (Teardown räumt ihn ab), `isActive()` ist der
// State-Machine-Guard des Controllers.
export function makeCursorHide({ ctx, isActive }) {
  const armCursorHide = () => {
    if (!isActive()) return;
    if (document.querySelector(CURSOR_KEEP_SEL)) {
      ctx.cursorTimer = setTimeout(armCursorHide, CURSOR_HIDE_MS);
      return;
    }
    document.querySelector('.focus-editor')?.classList.add('focus-cursor-hidden');
  };

  const showCursor = () => {
    document.querySelector('.focus-editor')?.classList.remove('focus-cursor-hidden');
    clearTimeout(ctx.cursorTimer);
    ctx.cursorTimer = setTimeout(armCursorHide, CURSOR_HIDE_MS);
  };

  return { armCursorHide, showCursor };
}
