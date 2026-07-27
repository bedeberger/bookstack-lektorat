// DOM-Roundtrip zwischen Normal- und Focus-Container.
//
// Der Fokusmodus ist ein eigenes contenteditable, kein umgestylter
// Normal-Editor. Beim Eintritt wandert der Inhalt hinüber, beim Austritt
// zurück. Das ist die riskanteste Operation des Moduls — geht ein Klon
// verloren, verliert der User Text —, deshalb wohnt sie in einem eigenen File
// mit genau einer Definition pro Richtung.
//
// Warum `cloneNode` statt `innerHTML`: der Inhalt kommt aus dem eigenen
// contenteditable und ist bereits geparst. `cloneNode` bleibt strukturidentisch
// ohne Re-Parsing (keine Normalisierung durch den HTML5-Parser, keine
// Selection-Zerstörung durch einen Setter auf dem Ziel-Root).
//
// Die Selektoren kommen aus shared/active-editor.js — dieselben, die der
// Smart-Switch für `getActiveEditorContainer` benutzt. Zwei Definitionen
// desselben Containers wären genau die Drift, die den Roundtrip still in einen
// leeren Klon laufen liesse.

import { NORMAL_SELECTOR, FOCUS_SELECTOR } from '../shared/active-editor.js';

// Kopiert die Kindknoten von `from` nach `to`. No-op (Rückgabe false), wenn eine
// Seite fehlt oder beide dasselbe Element sind — Letzteres würde `replaceChildren`
// mit bereits abgehängten Klonen füttern.
function mirrorNodes(from, to) {
  if (!from || !to || from === to) return false;
  to.replaceChildren(...Array.from(from.childNodes).map(n => n.cloneNode(true)));
  return true;
}

// Eintritt: Normal → Focus. Muss laufen, NACHDEM Alpine den Focus-Cardroot
// gerendert hat ($nextTick in enterFocusMode).
export function mirrorToFocus() {
  return mirrorNodes(
    document.querySelector(NORMAL_SELECTOR),
    document.querySelector(FOCUS_SELECTOR),
  );
}

// Austritt: Focus → Normal. Muss laufen, BEVOR `focusActive = false` greift —
// Alpine blendet den Focus-Cardroot danach via x-show aus und `FOCUS_SELECTOR`
// (verlangt `.is-active`) findet ihn nicht mehr.
export function mirrorToNormal() {
  return mirrorNodes(
    document.querySelector(FOCUS_SELECTOR),
    document.querySelector(NORMAL_SELECTOR),
  );
}
