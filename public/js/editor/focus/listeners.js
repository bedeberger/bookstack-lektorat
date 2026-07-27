// Listener- und Observer-Setup des Fokusmodus. Baut den ctx (AbortController,
// IO/MO, Timer, Caches) und hängt alle Handler daran — genau ein `abort()` räumt
// später alles ab (Invariante 2).
//
// Getrennt von card.js, weil dort die State-Machine wohnt: hier steht WANN
// gerechnet wird, in recenter.js WAS gerechnet wird. `ctrl` ist die Focus-Karte
// (bzw. der Standalone-Controller) und wird nur für `_focusState` +
// `_focusUpdateActive` / `enter`- und `exitFocusMode` gebraucht.

import {
  BLOCK_TAGS, BLOCK_SEL,
  POINTER_GRACE_MS, POINTER_GRACE_TOUCH_MS,
  HAS_IO, HAS_MO,
} from './constants.js';
import { findBlockFromNode } from './dom-blocks.js';
import { applyBlockMarks, repairBlockMarks } from './recenter.js';
import { consumeProgrammaticScroll } from './typewriter.js';
import { makeCursorHide } from './cursor-hide.js';
import { makeViewportSync } from './viewport.js';
import { editorHost } from '../shared/editor-host.js';
import { bindInlineFormattingShortcuts } from '../shared/shortcuts.js';

function makeCtx(container) {
  const abort = new AbortController();
  return {
    abort,
    container,
    visibleBlocks: new Set(),
    io: null,
    mo: null,
    // pointerIntent: Klick → Flag an → der folgende selectionchange konsumiert es
    // und recentert NICHT (Klick ist absichtliche Positionsänderung). Der Timer
    // fängt Klicks ab, die nie einen selectionchange erzeugen (leerer Margin).
    pointerIntent: false,
    pointerTimer: 0,
    composing: false,       // IME-Composition aktiv
    progScrollTop: null,    // zuletzt selbst geschriebene Scroll-Position
    vvTimer: 0,
    cursorTimer: 0,
    // Short-circuit-Cache für den Recenter: bleibt der aktive Block gleich
    // (häufigster Fall beim Tippen), entfällt das Satz-Highlight.
    // _lastGranularity invalidiert bei Live-Mode-Switch.
    _lastBlock: null,
    _lastGranularity: null,
    _twCache: { block: null, value: null },  // cachedTypewriterThreshold
    _lastViewportH: null,   // letzte sichtbare Viewport-Höhe (Tastatur-Erkennung)
  };
}

// IntersectionObserver pflegt das Set sichtbarer Blöcke (Quelle für den
// Viewport-Center-Pick). MutationObserver beobachtet NEU hinzukommende Blöcke —
// nur addedNodes, kein Vollscan pro Mutation, sonst wird ein Paste von 500
// Absätzen O(n²). removedNodes werden unobserved, sonst sammelt der IO über eine
// lange Edit-Session Refs auf abgehängte Knoten (Invariante 3).
function installObservers(ctx) {
  const { container, visibleBlocks } = ctx;
  if (HAS_IO) {
    ctx.io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) visibleBlocks.add(e.target);
        else visibleBlocks.delete(e.target);
      }
    }, { root: container, threshold: 0 });
    for (const el of container.querySelectorAll(BLOCK_SEL)) ctx.io.observe(el);
  }
  if (!HAS_MO) return;
  const observeSubtree = (node) => {
    if (!ctx.io || node.nodeType !== 1) return;
    if (BLOCK_TAGS.has(node.tagName)) ctx.io.observe(node);
    const nested = node.querySelectorAll?.(BLOCK_SEL);
    if (nested) for (const el of nested) ctx.io.observe(el);
  };
  const unobserveSubtree = (node) => {
    if (!ctx.io || node.nodeType !== 1) return;
    visibleBlocks.delete(node);
    if (BLOCK_TAGS.has(node.tagName)) ctx.io.unobserve(node);
    const nested = node.querySelectorAll?.(BLOCK_SEL);
    if (nested) for (const el of nested) { visibleBlocks.delete(el); ctx.io.unobserve(el); }
  };
  ctx.mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) observeSubtree(node);
      for (const node of m.removedNodes) unobserveSubtree(node);
    }
  });
  ctx.mo.observe(container, { childList: true, subtree: true });
}

export function installFocusListeners({ ctrl, container }) {
  const ctx = makeCtx(container);
  const signal = ctx.abort.signal;
  const isActive = () => ctrl._focusState === 'active';
  installObservers(ctx);

  // Touch bekommt eine längere Karenz als Maus/Stift: der Fingertipp ist auf
  // Mobile die einzige Art, den Caret zu setzen, und das `selectionchange` kommt
  // dort spät (Soft-Keyboard-Animation, langsame Geräte).
  const markPointer = (e) => {
    ctx.pointerIntent = true;
    clearTimeout(ctx.pointerTimer);
    const grace = e?.pointerType === 'touch' ? POINTER_GRACE_TOUCH_MS : POINTER_GRACE_MS;
    ctx.pointerTimer = setTimeout(() => { ctx.pointerIntent = false; }, grace);
  };

  // `selectionchange` gibt es nur am document, feuert also auch für Selections
  // ausserhalb des Editors (Sidebar-Input, Modal). Die dürfen weder einen
  // Recenter-Versuch auslösen noch die Klick-Schonfrist verbrauchen.
  const onSelection = () => {
    if (!isActive()) return;
    const sel = document.getSelection();
    const anchor = sel && sel.rangeCount > 0 ? sel.anchorNode : null;
    // Abgehängter Anker (`!isConnected`) ist KEIN Fremd-Selection-Fall, sondern
    // die Nachwehe einer Löschung: der Knoten, in dem der Caret sass, ist gerade
    // aus dem DOM geflogen. Der Tick muss laufen, sonst bleibt die Markierung
    // auf dem verschwundenen Block stehen bzw. ganz weg.
    if (anchor && anchor.isConnected !== false && !container.contains(anchor)) return;
    const isPointer = ctx.pointerIntent;
    ctx.pointerIntent = false;
    clearTimeout(ctx.pointerTimer);
    ctrl._focusUpdateActive(!isPointer, ctx.composing ? { imeSafe: true } : undefined);
  };

  const { showCursor } = makeCursorHide({ ctx, isActive });

  // Markierung SYNCHRON reparieren, solange sie kaputt ist — `input` feuert im
  // selben Task nach der DOM-Mutation und vor dem Paint, hier Korrigiertes
  // rendert also nie als Zwischenzustand. Deckt zwei Strukturwechsel ab, die der
  // RAF erst einen Frame später sähe:
  //   - **Split** (`insertParagraph`/`insertLineBreak`): Chromium kopiert
  //     `.focus-paragraph-active` auf beide `<p>` → kurz leuchten zwei Absätze.
  //   - **Merge/Löschen** (`deleteContentBackward` & Co.): Backspace am
  //     Absatzanfang zieht den markierten `<p>` aus dem DOM → KEIN Element trägt
  //     die Klasse mehr → die Dim-Regel greift für den ganzen Text.
  // Nicht auf einzelne `inputType`-Werte gefiltert: Android-IMEs ersetzen ganze
  // Wörter über `insertCompositionText`, Undo/Redo und Paste bauen ebenfalls
  // Blöcke um. Der Ist-Soll-Vergleich (`repairBlockMarks`) macht den Aufruf im
  // Normalfall zum reinen Lesevorgang, deshalb ist „immer prüfen" billiger als
  // eine unvollständige Whitelist.
  const repairMarksNow = () => {
    const sel = document.getSelection();
    const anchor = sel && sel.rangeCount > 0 ? sel.anchorNode : null;
    const block = anchor && container.contains(anchor)
      ? findBlockFromNode(anchor, container) : null;
    // Kein Block auflösbar → transienter null-Tick; hier NICHT clearen, das
    // entscheidet der reguläre Tick mit `_lastBlock`-Schutz.
    if (!block) return;
    const granularity = editorHost()?.focusGranularity || 'paragraph';
    if (repairBlockMarks(container, block, granularity)) ctx._lastBlock = block;
  };

  // Input fängt, was selectionchange nicht abdeckt: undo/redo ohne Caret-Move,
  // Paste mit stabiler Caret-Position, Content-Rewrite durch externe Module.
  const onInput = () => {
    if (!isActive()) return;
    repairMarksNow();
    // Composition läuft: das DOM sonst nicht anfassen (Kandidatenfenster/
    // Composition darf nicht gestört werden), aber der Typewriter bleibt als
    // Notnagel scharf — Android-Soft-Keyboards halten auch für gewöhnliche
    // lateinische Wörter eine Composition offen, teils über ganze Sätze.
    if (ctx.composing) { ctrl._focusUpdateActive(true, { imeSafe: true }); return; }
    ctrl._focusUpdateActive(true);
  };

  const onCompositionStart = () => { ctx.composing = true; };
  // `force`: während der Composition wurde das Satz-Highlight übersprungen, der
  // Block kann sich trotzdem geändert haben (Merge). Ohne erzwungenes Recompute
  // liesse der Short-Circuit-Cache das Highlight auf dem Stand von vor der
  // Composition stehen.
  const onCompositionEnd = () => {
    ctx.composing = false;
    if (isActive()) ctrl._focusUpdateActive(true, { force: true });
  };

  const onScroll = () => {
    if (!isActive()) return;
    if (consumeProgrammaticScroll(container, ctx)) return;
    // Manueller Scroll: Spotlight auf den Absatz in der Viewport-Mitte setzen
    // (preferCenter), nicht auf den Caret. scroll=false → kein programmatischer
    // Typewriter-Scroll, der gegen den User-Scroll kämpft.
    ctrl._focusUpdateActive(false, { preferCenter: true });
  };

  // Editor verliert Fokus (Modal öffnet, Sidebar-Klick) → aktive Markierung weg,
  // damit nichts „hängen" bleibt. `_lastBlock` mit-nullen, sonst hält der
  // null-Tick-Schutz im Recenter die Markierung fest.
  const onBlur = () => {
    if (!isActive()) return;
    applyBlockMarks(container, null, editorHost()?.focusGranularity || 'paragraph');
    ctx._lastBlock = null;
  };
  const onFocus = () => {
    if (isActive()) ctrl._focusUpdateActive(true);
  };

  const onKey = (e) => {
    if (!isActive()) return;
    const app = editorHost();
    if (e.key === 'Escape') {
      if (app?._synonymMenuOpen || app?._synonymPickerOpen) return;
      if (app?._figurLookupOpen) { app.closeFigurLookup?.(); return; }
      if (app?.editSaving) return;   // während Save-Request kein Exit
      e.preventDefault();
      if (app?.editMode && app?.editDirty && app?.cancelEdit) app.cancelEdit();
      else ctrl.exitFocusMode();
    } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === 'KeyE') {
      e.preventDefault();
      ctrl.exitFocusMode();
    } else if ((e.key === 'l' || e.key === 'L') && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      // Vim/emacs-Konvention: Ctrl+L recentert die Cursor-Zeile auf den Anker.
      // Browser-Default (Adressleiste) wird im Fokusmodus unterdrückt — der User
      // wollte ohnehin im Editor bleiben.
      e.preventDefault();
      ctrl._focusUpdateActive(true);
    }
  };

  const onPointerMove = () => { if (isActive()) showCursor(); };

  // Klick ins Padding (oberhalb/unterhalb/neben der Textspalte) soll den Caret
  // nicht an Anfang/Ende der Seite werfen. Wheel-Scroll braucht aber
  // pointer-events:auto am Container — preventDefault nur, wenn das Target
  // wirklich der Container selbst ist (nicht ein Absatz darin).
  const onPaddingMousedown = (e) => {
    if (e.target === container) e.preventDefault();
  };

  // Mobile-Tastatur: visualViewport schrumpft UND kann scrollen (Android Chrome
  // schiebt den fixed Container nach oben → offsetTop). Debounced, damit der
  // KB-Öffnen-Storm nicht permanent recentert. Desktop: window.resize (Sidebar,
  // DevTools, Rotation) feuert, visualViewport evtl. nicht — beide abonnieren.
  const { applyViewport, syncViewport } = makeViewportSync({
    ctx,
    container,
    isActive,
    updateActive: (scroll) => ctrl._focusUpdateActive(scroll),
  });

  document.addEventListener('selectionchange', onSelection, { signal });
  container.addEventListener('input', onInput, { signal });
  container.addEventListener('compositionstart', onCompositionStart, { signal });
  container.addEventListener('compositionend', onCompositionEnd, { signal });
  container.addEventListener('scroll', onScroll, { passive: true, signal });
  container.addEventListener('pointerdown', markPointer, { signal });
  container.addEventListener('pointerup', markPointer, { signal });
  container.addEventListener('mousedown', onPaddingMousedown, { signal });
  container.addEventListener('blur', onBlur, { signal, capture: true });
  container.addEventListener('focus', onFocus, { signal, capture: true });
  window.addEventListener('keydown', onKey, { signal });
  // Inline-Format-Whitelist im Focus: ausschliesslich Bold/Italic/Underline per
  // Cmd/Ctrl+B/I/U. Hängt am contenteditable, nicht am Window — sonst feuern die
  // Shortcuts auch ausserhalb des Focus-Editors.
  bindInlineFormattingShortcuts(container, {
    allowedCommands: ['bold', 'italic', 'underline'],
    signal,
    onCommand: () => { editorHost()?._markEditDirty?.(); },
  });
  window.addEventListener('pointermove', onPointerMove, { signal, passive: true });
  window.addEventListener('resize', syncViewport, { signal });
  window.visualViewport?.addEventListener('resize', syncViewport, { signal });
  window.visualViewport?.addEventListener('scroll', syncViewport, { signal });

  // Initial: direkt anwenden (ohne Debounce), damit der erste Frame stimmt.
  applyViewport();
  showCursor();

  return ctx;
}
