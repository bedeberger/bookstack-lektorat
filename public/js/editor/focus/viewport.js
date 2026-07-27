// Viewport-Synchronisation des Fokusmodus: hält `--focus-vh` / `--focus-vh-top`
// / `--focus-box-h` am sichtbaren Bereich (Mobile-Tastatur, Rotation,
// Desktop-Resize) und entscheidet, wann ein Viewport-Tick einen Recenter
// verdient.
//
// Eigenes Modul, weil das Thema quer zur Block-/Spotlight-Logik in card.js
// liegt: Bezug ist der Bildschirm, nicht der Text.

import { VV_DEBOUNCE_MS } from './constants.js';
import { resolveScrollBox } from './typewriter.js';

// Pure: rechtfertigt dieser Viewport-Tick einen Recenter?
//
// `prev`/`next` sind `{ h, top }` — Höhe UND Versatz des sichtbaren Bereichs.
// **Beide** verschieben die Schreiblinie, denn der Anker ist
// `offsetTop + height × ratio` (typewriter.js#anchorY): Android Chrome schiebt
// den sichtbaren Ausschnitt bei Tastatur/URL-Leiste auch ohne Höhenwechsel nach
// unten, WKWebView beim Pinch-Pan. Nur auf die Höhe zu schauen liess die
// Schreibzeile in genau diesen Fällen vom Anker wegdriften.
//
// Ein Recenter pro Tick wäre umgekehrt falsch: KB-Animation, mobiler
// URL-Leisten-Scroll und Pinch-Zoom feuern in Serie und liessen den Editor
// flattern — darum die 1-px-Schwelle auf beiden Achsen. Zusätzlich muss der
// Fokus im Editor sitzen, sonst risse ein Resize beim Lesen die Ansicht weg.
// `prev == null` ist der erste Tick (Mount).
export function shouldRecenterOnViewport(prev, next, isWriting) {
  if (!isWriting || !prev || !next) return false;
  return Math.abs(next.h - prev.h) > 1 || Math.abs(next.top - prev.top) > 1;
}

// Baut das Paar `applyViewport` (sofort) / `syncViewport` (debounced) für den
// Focus-Controller. `ctx` liefert den Zustandsspeicher (`_lastViewport`,
// `scrollBox`, `_twCache`, `vvTimer`), `isActive()` den State-Machine-Guard und
// `updateActive(scroll)` den Recenter-Einstieg.
export function makeViewportSync({ ctx, container, isActive, updateActive }) {
  const applyViewport = () => {
    const vv = window.visualViewport;
    const h = vv ? vv.height : window.innerHeight;
    const top = vv ? vv.offsetTop : 0;
    document.documentElement.style.setProperty('--focus-vh', h + 'px');
    document.documentElement.style.setProperty('--focus-vh-top', top + 'px');
    ctx._twCache.value = null;   // Resize kann via Media-Query line-height ändern
    // Scroll-Box neu auflösen: Host-CSS einer fremden Schale kann die Kette per
    // Media-Query umhängen (Kompakt-Layout bei kleiner Höhe), und dann scrollt
    // ab hier ein anderes Element als beim Mount.
    ctx.scrollBox = resolveScrollBox(container);
    // Höhe der Box, die tatsächlich scrollt (Padding-Box, ohne Scrollbar). Der
    // Tail-Puffer in focus-mode.css leitet sich daraus ab statt aus `100vh`,
    // weil WebKit die Textselektion im contenteditable kaputt macht, sobald
    // `padding-top + padding-bottom >= clientHeight` der Scroll-Box ist
    // (Doppelklick selektiert bis zum Absatzende statt das Wort, Zieh-Select
    // liefert eine leere Selektion). Mit Topbar ist die Box ohnehin kleiner als
    // 100vh — die alte Formel lag also garantiert über der Schwelle.
    // Bezug ist bewusst die Scroll-Box und nicht stur der Container: gibt eine
    // fremde Schale den Scroll an einen Vorfahr ab, wächst der Container mit dem
    // Inhalt und `clientHeight` wäre die ganze Buchseite — der Tail-Puffer
    // blähte sich auf Buchlänge auf und man scrollte nach dem letzten Absatz
    // durch eine ebenso lange Leerfläche. Im Normalfall sind beide dasselbe
    // Element. Kein Circular-Layout: die Höhe kommt aus der Flex-Kette
    // (`flex: 1 1 auto` unter fixer Overlay-Höhe), das Padding geht nicht ein.
    // 0 wird nicht publiziert (Element noch nicht gelayoutet) — dann bleibt der
    // letzte gute Wert bzw. der CSS-Fallback stehen.
    const boxH = ctx.scrollBox ? ctx.scrollBox.clientHeight : 0;
    if (boxH > 0) document.documentElement.style.setProperty('--focus-box-h', boxH + 'px');
    const prev = ctx._lastViewport;
    ctx._lastViewport = { h, top };
    if (!isActive()) return;
    const active = document.activeElement;
    const writing = !!active && (active === container || container.contains(active));
    updateActive(shouldRecenterOnViewport(prev, ctx._lastViewport, writing));
  };

  const syncViewport = () => {
    clearTimeout(ctx.vvTimer);
    ctx.vvTimer = setTimeout(applyViewport, VV_DEBOUNCE_MS);
  };

  return { applyViewport, syncViewport };
}
