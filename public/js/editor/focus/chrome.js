// Overlay-Chrome des Fokusmodus: die Klassen und CSS-Variablen, die den
// Vollbild-Aufsatz sichtbar machen. Getrennt von der State-Machine (card.js),
// weil es hier ausschliesslich um DOM-Dekoration geht — kein Lifecycle, keine
// Listener, kein Recenter.
//
// `applyGranularity` ist die SSoT für „welche `focus-mode--*`-Klasse hängt am
// Cardroot": Eintritt (markFocusChrome), Live-Switch der SPA-Karte und
// Live-Switch einer fremden Schale (standalone.js#setGranularity) rufen alle
// dieselbe Funktion. Ohne diese Bündelung müsste ein neuer Granularitätsmodus
// an drei Stellen nachgezogen werden.

import { publishAnchorRatio, clearAnchorRatio } from './typewriter.js';

export const GRANULARITIES = ['paragraph', 'sentence', 'window-3', 'typewriter-only'];
const GRANULARITY_CLASSES = GRANULARITIES.map(g => 'focus-mode--' + g);

// Normalisiert auf einen bekannten Modus — ein unbekannter Wert (fremde Schale,
// veraltetes localStorage) darf nicht in einer klassenlosen und damit
// wirkungslosen Darstellung enden.
export function normGranularity(g) {
  return GRANULARITIES.includes(g) ? g : 'paragraph';
}

// Tauscht die Granularitäts-Klasse am Focus-Cardroot. `root` erlaubt fremden
// Schalen, ihren eigenen Mount-Punkt zu übergeben (die SPA sucht im Dokument).
// Rückgabe: der normalisierte Modus, damit Aufrufer ihren Host-State damit
// gleichziehen können.
export function applyGranularity(granularity, root = document) {
  const gran = normGranularity(granularity);
  const el = root?.querySelector?.('.focus-editor');
  if (el) {
    el.classList.remove(...GRANULARITY_CLASSES);
    el.classList.add('focus-mode--' + gran);
  }
  return gran;
}

// Overlay-Chrome an: body-Klasse, Host-Karte, Granularitäts-Klasse und der
// Anker als CSS-Variable (Kopf-/Tail-Puffer leiten sich daraus ab — deshalb VOR
// dem ersten Render des Focus-Containers).
//
// `is-active` wird synchron gesetzt, damit `getActiveEditorContainer` im
// folgenden $nextTick den Focus-Container findet: Alpine's
// `:class="{'is-active': focusActive}"` flushed erst danach und liesse das
// Listener-Setup sonst auf den Normal-Container greifen (alle Listener am
// falschen Element → Typewriter/Highlight/Counter/Cursor-Hide tot).
export function markFocusChrome(granularity, anchorRatio) {
  document.body.classList.add('focus-mode');
  document.getElementById('editor-card')?.classList.add('focus-host');
  publishAnchorRatio(anchorRatio);
  applyGranularity(granularity);
  document.querySelector('.focus-editor')?.classList.add('is-active');
}

export function unmarkFocusChrome() {
  document.body.classList.remove('focus-mode');
  document.getElementById('editor-card')?.classList.remove('focus-host');
  document.querySelector('.focus-editor')?.classList.remove(
    'is-active', 'focus-cursor-hidden', ...GRANULARITY_CLASSES);
  clearAnchorRatio();
  document.documentElement.style.removeProperty('--focus-vh');
  document.documentElement.style.removeProperty('--focus-vh-top');
  document.documentElement.style.removeProperty('--focus-box-h');
  document.documentElement.style.removeProperty('--focus-box-top');
}
