// Viewport-Synchronisation des Fokusmodus: hält `--focus-vh` / `--focus-vh-top`
// / `--focus-box-h` / `--focus-box-top` am sichtbaren Bereich (Mobile-Tastatur,
// Rotation, Desktop-Resize) und entscheidet, wann ein Viewport-Tick einen
// Recenter verdient.
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

// Geometrie der Schreibfläche als `{ h, top }`: die Höhe, die ihr das Layout
// tatsächlich zuweist, und ihre Oberkante in Client-Koordinaten — beides mit
// kurzzeitig neutralisiertem Kopf-/Tail-Puffer gemessen.
//
// Warum die Höhe nicht einfach `clientHeight` ist: die Puffer sind zusammen ~eine
// Bildschirmhöhe und damit grösser als der Flex-Slot der Box (die Focus-Topbar
// nimmt oben Platz weg). Ein Border-Box-Element kann aber nicht kleiner werden
// als seine eigenen Paddings — die Box wird also auf die Puffer-Summe
// aufgeblasen und `clientHeight` liefert exakt diese Summe zurück, nicht den
// Slot. Die Puffer-Formeln in focus-mode.css leiten sich aus dieser Zahl ab; mit
// dem geblähten Wert wären sie zirkulär (jede Messung bestätigt das aktuelle
// Padding) und die WebKit-Bedingung `pt + pb < clientHeight` bliebe für immer
// verletzt. Kein Chrome-vs-WebKit-Unterschied — das Clamping ist Spec.
//
// `top` ist die zweite Hälfte derselben Rechnung: der Anker ist eine
// BILDSCHIRM-Position (`vvTop + vvH × ratio`, typewriter.js#anchorY), die Puffer
// wirken aber innerhalb der Box — und die beginnt unter der Topbar. Ohne diesen
// Versatz rechnen beide Formeln mit „Boxoberkante == Bildschirmoberkante": der
// Kopf-Puffer wird um die Topbar-Höhe zu lang und nimmt dem Tail genau diese
// Strecke weg, die letzte Zeile bleibt darum um eine Topbar-Höhe unter der
// Schreiblinie stehen („man kommt nur bis zum zweitletzten Absatz").
//
// Setzen → lesen → zurücksetzen läuft synchron in einem Task: es erzwingt ein
// Zwischen-Layout, aber keinen Paint, also kein sichtbares Springen. Der Preis
// ist ein zusätzliches Layout pro Viewport-Tick (debounced), nicht pro Anschlag.
//
// Die Messung ist scroll-NEUTRAL, und das muss sie von Hand sein: die Puffer
// sind zusammen ~eine Boxhöhe, ohne sie fällt `scrollHeight` um genau diesen
// Betrag und der Browser klemmt `scrollTop` beim erzwungenen Layout auf das
// neue Maximum (bei kurzem Text auf 0). Das Zurücksetzen des Paddings hebt den
// Klemm-Vorgang NICHT auf — der Editor sprang sonst pro Viewport-Tick nach oben,
// am Seitenende um fast eine volle Bildschirmhöhe. Reihenfolge zwingend: erst
// Paddings zurück (danach ist `scrollHeight` wieder gross genug), dann
// `scrollTop`. `restored` meldet dem Aufrufer, dass geklemmt wurde — der Write
// hinterlässt trotz Netto-Null ein pending `scroll`-Event.
export function measureBoxGeometry(box) {
  if (!box || !box.style) return { h: 0, top: 0, restored: false };
  const pt = box.style.paddingTop;
  const pb = box.style.paddingBottom;
  const st = box.scrollTop;
  box.style.paddingTop = '0px';
  box.style.paddingBottom = '0px';
  const h = box.clientHeight;
  const top = box.getBoundingClientRect().top;
  box.style.paddingTop = pt;
  box.style.paddingBottom = pb;
  let restored = false;
  if (Number.isFinite(st) && box.scrollTop !== st) {
    box.scrollTop = st;
    restored = true;
  }
  return { h, top: Number.isFinite(top) ? top : 0, restored };
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
    // Layout-Slot der Schreibfläche + ihr Versatz gegen den sichtbaren Bereich.
    // Beide Puffer in focus-mode.css leiten sich daraus ab statt aus `100vh`,
    // weil WebKit die Textselektion im contenteditable kaputt macht, sobald
    // `padding-top + padding-bottom >= clientHeight` der Scroll-Box ist
    // (Doppelklick selektiert bis zum Absatzende statt das Wort, Zieh-Select
    // liefert eine leere Selektion) — mit den gemessenen Werten ist die Summe
    // strukturell `Box-Höhe − Reserve`.
    // Bezug ist bewusst die Scroll-Box und nicht stur der Container: gibt eine
    // fremde Schale den Scroll an einen Vorfahr ab, wächst der Container mit dem
    // Inhalt und seine Höhe wäre die ganze Buchseite — der Tail-Puffer blähte
    // sich auf Buchlänge auf und man scrollte nach dem letzten Absatz durch eine
    // ebenso lange Leerfläche. Im Normalfall sind beide dasselbe Element.
    // Höhe 0 wird nicht publiziert (Element noch nicht gelayoutet) — dann bleibt
    // der letzte gute Wert bzw. der CSS-Fallback stehen. Beim Versatz ist 0 ein
    // legitimer Messwert (Schale ohne Topbar), er hängt darum am Höhen-Gate.
    const box = measureBoxGeometry(ctx.scrollBox);
    if (box.h > 0) {
      const st = document.documentElement.style;
      st.setProperty('--focus-box-h', box.h + 'px');
      st.setProperty('--focus-box-top', (box.top - top) + 'px');
    }
    // Musste die Messung `scrollTop` zurückstellen, steht die Position zwar
    // wieder richtig, das Schreiben hat die Box aber in die pending scroll
    // targets gehängt: es kommt noch ein `scroll`-Event. Ohne Marke gälte es als
    // User-Scroll und risse das Spotlight per `preferCenter` auf den
    // Center-Absatz (typewriter.js#consumeProgrammaticScroll). Eine bereits
    // gesetzte Marke bleibt stehen — ihr `top` ist dieselbe Position und deckt
    // das Event mit ab.
    if (box.restored && !ctx.progScroll && ctx.scrollBox) {
      ctx.progScroll = { box: ctx.scrollBox, top: ctx.scrollBox.scrollTop };
    }
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
