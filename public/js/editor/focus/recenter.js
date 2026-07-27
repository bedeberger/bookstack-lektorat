// Recenter-Kern des Fokusmodus: die drei Schritte, die pro Tick passieren —
// welcher Block ist aktiv, wie wird er markiert, und wohin scrollt der
// Typewriter. Bewusst getrennt von der State-Machine (card.js) und vom
// Listener-Setup (listeners.js): hier steht Was, dort Wann.
//
// Alle Funktionen sind aufrufbar, ohne dass eine Alpine-Karte existiert (nur
// DOM + ctx) — Voraussetzung für die Unit-Tests und für fremde Schalen.

import {
  findBlockFromNode, findBlockAtViewportCenter,
  setActiveBlock, setNearBlocks,
} from './dom-blocks.js';
import { applySentenceHighlight, clearSentenceHighlight } from './sentence.js';
import {
  cachedTypewriterThreshold, getCaretRect, typewriterScroll,
  caretWithinViewport, visibleViewportRect,
} from './typewriter.js';
import { editorHost } from '../shared/editor-host.js';

// Welcher Block ist der aktive? Normalfall ist der Caret-Anchor (Spotlight folgt
// dem Cursor beim Tippen). `preferCenter` (manueller Scroll) ignoriert den Caret
// und nimmt den Absatz in der Viewport-Mitte — beim Lese-Durchlauf wandert die
// Hervorhebung mit dem Sichtfeld, nicht mit dem unsichtbaren Cursor im alten
// Absatz.
//
// `lastBlock` ist die Defensive gegen den transienten null-Tick: der Caret sitzt
// nach Merge/Voll-Löschen kurz direkt auf dem Container (findBlockFromNode=null)
// UND der Viewport-Center-Fallback findet (noch) nichts. Ohne Schutz killte
// setActiveBlock(null) die Hervorhebung („alles dimmt kurz weg"). Greift nicht in
// `typewriter-only` (dort ist nie ein Block aktiv) und nicht nach Blur — der
// Blur-Handler nullt `lastBlock`, sein absichtlicher Clear bleibt also erhalten.
export function resolveActiveBlock({ container, sel, visibleBlocks, granularity, lastBlock, preferCenter = false }) {
  if (!container) return null;
  let block = null;
  if (!preferCenter && sel && sel.rangeCount > 0) {
    const anchor = sel.anchorNode;
    if (anchor && container.contains(anchor)) block = findBlockFromNode(anchor, container);
  }
  if (!block) block = findBlockAtViewportCenter(container, visibleBlocks);
  if (!block && granularity !== 'typewriter-only'
      && lastBlock && container.contains(lastBlock)) {
    block = lastBlock;
  }
  return block;
}

// Block-Markierungen für eine Granularität setzen. Beide Setter sind idempotent
// (mutieren nur bei echter Änderung), der unbedingte Aufruf ist die Defense gegen
// Ghost-Klassen (Chromium-Split-Bug, undo/redo, Paste).
//
// Einzige Quelle für „welche Klasse bei welcher Granularität": der Recenter-Tick
// und der synchrone insertParagraph-Pfad im input-Handler rufen dieselbe Funktion.
export function applyBlockMarks(container, block, granularity) {
  if (!container) return;
  if (granularity === 'typewriter-only') {
    setActiveBlock(container, null);
    setNearBlocks(container, null);
    return;
  }
  setActiveBlock(container, block);
  setNearBlocks(container, granularity === 'window-3' ? block : null);
}

// Satz-Highlight ist der teure Pfad (Range-Iteration über Textknoten), darum nur
// bei `recompute` (Block-/Granularitätswechsel oder Sentence-Mode, wo der Caret
// eine Satzgrenze im selben Block überqueren kann).
export function syncSentenceMarks({ block, sel, granularity, recompute }) {
  if (!recompute) return;
  if (granularity === 'sentence') applySentenceHighlight(block, sel);
  else clearSentenceHighlight();
}

// Typewriter-Schritt. Ziel ist ausschliesslich das Caret-Rect (Invariante 14):
// Block-BBox als Ersatz stünde bei langen Absätzen mit Soft-Wraps/`<br>` still,
// obwohl der Cursor visuell mehrere Zeilen tiefer sitzt. Liefert `getCaretRect`
// null (leerer Absatz ohne Textkind, kein Fokus), bleibt der Scroll aus — der
// nächste echte Input hat wieder ein valides Rect.
//
// `block` dient nur der Schwellen-Herleitung (line-height) und darf null sein
// (typewriter-only, transienter null-Tick) — dann zählt die des Containers.
export function runTypewriter({ container, block, ctx, imeSafe = false }) {
  if (!container || !ctx) return 0;
  const targetRect = getCaretRect(container);
  if (!targetRect) return 0;
  const threshold = cachedTypewriterThreshold(block || container, ctx._twCache);
  // Während einer Composition nur eingreifen, wenn die Caret-Zeile den sichtbaren
  // Bereich (samt einer Zeile Sicherheitsband) verlassen hat: Zeilen-Jitter und
  // ein einzelner Umbruch bleiben unbeantwortet, damit das IME-Kandidatenfenster
  // stehen bleibt; läuft die Zeile aber unter die Tastatur, wird sie geholt.
  if (imeSafe && caretWithinViewport(targetRect, visibleViewportRect(), threshold * 2)) return 0;
  return typewriterScroll(container, targetRect, ctx, threshold, editorHost()?.typewriterAnchor);
}

// Eintritts-Positionierung: bringt den Schreib-Slot beim Öffnen des Fokusmodus
// auf denselben Anker, auf dem der Typewriter danach hält. Bewusst über dieselbe
// Geometrie (`typewriterScroll`, Schwelle 0 = exakt) statt via
// `scrollIntoView({block:'center'})` — das zentrierte in der Scroll-Box (beginnt
// unter der Topbar) statt auf dem Bildschirm-Anker und ignorierte einen
// konfigurierten Anker ≠ 0.5, was beim ersten Tastendruck als Sprung sichtbar war.
//
// Ziel ist hier das Block-Rect, nicht das Caret-Rect: der Slot ist ein leerer
// Ein-Zeilen-`<p>` (beide Rects deckungsgleich), und ein leerer Absatz ist genau
// der Fall, in dem `getCaretRect` null liefern kann.
export function scrollEntryTargetToAnchor(container, target, ctx) {
  if (!container || !target) return 0;
  return typewriterScroll(container, target.getBoundingClientRect(), ctx, 0, editorHost()?.typewriterAnchor);
}
