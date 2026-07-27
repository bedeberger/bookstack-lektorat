// Viewport-Synchronisation des Fokusmodus: hält `--focus-vh` / `--focus-vh-top`
// am sichtbaren Bereich (Mobile-Tastatur, Rotation, Desktop-Resize) und
// entscheidet, wann ein Viewport-Tick einen Recenter verdient.
//
// Eigenes Modul, weil das Thema quer zur Block-/Spotlight-Logik in card.js
// liegt: Bezug ist der Bildschirm, nicht der Text.

import { VV_DEBOUNCE_MS } from './constants.js';

// Pure: rechtfertigt dieser Viewport-Tick einen Recenter?
//
// Nur bei echtem Höhenwechsel (Tastatur auf/zu, Rotation, Fenster-Resize) —
// dann springt die Schreiblinie mit, weil der Anker in der Mitte des SICHTBAREN
// Bereichs liegt. Ein Recenter pro Tick wäre falsch: die KB-Animation, der
// Scroll der mobilen URL-Leiste und Pinch-Zoom feuern in Serie und liessen den
// Editor flattern. Zusätzlich muss der Fokus im Editor sitzen, sonst risse ein
// Resize beim Lesen die Ansicht weg. `prevH == null` ist der erste Tick (Mount).
export function shouldRecenterOnViewport(prevH, h, isWriting) {
  return isWriting && prevH != null && Math.abs(h - prevH) > 1;
}

// Baut das Paar `applyViewport` (sofort) / `syncViewport` (debounced) für den
// Focus-Controller. `ctx` liefert den Zustandsspeicher (`_lastViewportH`,
// `_twCache`, `vvTimer`), `isActive()` den State-Machine-Guard und
// `updateActive(scroll)` den Recenter-Einstieg.
export function makeViewportSync({ ctx, container, isActive, updateActive }) {
  const applyViewport = () => {
    const vv = window.visualViewport;
    const h = vv ? vv.height : window.innerHeight;
    const top = vv ? vv.offsetTop : 0;
    document.documentElement.style.setProperty('--focus-vh', h + 'px');
    document.documentElement.style.setProperty('--focus-vh-top', top + 'px');
    ctx._twCache.value = null;   // Resize kann via Media-Query line-height ändern
    const prevH = ctx._lastViewportH;
    ctx._lastViewportH = h;
    if (!isActive()) return;
    const active = document.activeElement;
    const writing = !!active && (active === container || container.contains(active));
    updateActive(shouldRecenterOnViewport(prevH, h, writing));
  };

  const syncViewport = () => {
    clearTimeout(ctx.vvTimer);
    ctx.vvTimer = setTimeout(applyViewport, VV_DEBOUNCE_MS);
  };

  return { applyViewport, syncViewport };
}
