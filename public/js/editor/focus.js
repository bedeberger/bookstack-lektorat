// Vollbild-Fokusmodus mit Absatz-Hervorhebung + Typewriter-Scroll.
// Nur im Bearbeitungsmodus aktivierbar.
//
// Facade-Datei. Implementierung in `editor/focus/` aufgeteilt:
//   - constants.js   – Block-Tags/Selektoren, Timing-Konstanten, Feature-Detects
//   - storage.js     – Focus-Snapshot (sessionStorage)
//   - dom-blocks.js  – Block-Lookup + active/near-Markierungen
//   - sentence.js    – Satz-Erkennung am Caret + CSS-Custom-Highlight
//   - typewriter.js  – Schwelle, Caret-Rect, Anker-Geometrie, Scroll
//   - recenter.js    – ein Recenter-Tick: Block-Auflösung, Marks, Typewriter
//   - listeners.js   – Listener-/Observer-Setup (ctx-Aufbau) im Fokusmodus
//   - viewport.js    – --focus-vh/-top + Recenter-Entscheid bei Viewport-Ticks
//   - cursor-hide.js – Auto-Hide des Mauszeigers
//   - trampoline.js  – Root-Methoden (Event-Dispatch an die Sub)
//   - card.js        – State-Machine in Alpine.data('editorFocusCard')
// Counter-Logik (fmtSigned/dailyDelta/installEditCounter) lebt in
// editor/shared/edit-counter.js — beide Editoren konsumieren sie von dort.

export { focusMethods } from './focus/trampoline.js';
export { focusCardMethods } from './focus/card.js';
export { readFocusSnapshot, clearFocusSnapshot } from './focus/storage.js';
export { fmtSigned, dailyDelta, installEditCounter } from './shared/edit-counter.js';
export {
  findBlockFromNode, pickCenterBlock, findBlockAtViewportCenter,
  setActiveBlock, setNearBlocks, clearAllFocusMarks,
} from './focus/dom-blocks.js';
export {
  findSentenceRanges, findSentenceAtCaret, applySentenceHighlight,
  clearSentenceHighlight,
} from './focus/sentence.js';
export {
  TYPEWRITER_THRESHOLD_PX, dynamicTypewriterThreshold,
  getCaretRect, computeTypewriterDelta, typewriterScroll, visibleViewportRect,
  caretWithinViewport, consumeProgrammaticScroll,
  normAnchorRatio, publishAnchorRatio, clearAnchorRatio, ANCHOR_CSS_VAR,
} from './focus/typewriter.js';
export {
  resolveActiveBlock, applyBlockMarks, syncSentenceMarks,
  blockMarksIntact, repairBlockMarks,
} from './focus/recenter.js';
