// Listener- und Observer-Setup des Fokusmodus. Baut den ctx (AbortController,
// IO/MO, Timer, Caches) und hängt alle Handler daran — genau ein `abort()` räumt
// später alles ab (Invariante 2).
//
// Getrennt von card.js, weil dort die State-Machine wohnt: hier steht WANN
// gerechnet wird, in recenter.js WAS gerechnet wird. `ctrl` ist die Focus-Karte
// (bzw. der Standalone-Controller) und wird nur für `_focusState` +
// `_focusUpdateActive` / `enter`- und `exitFocusMode` gebraucht.

import {
  BLOCK_TAGS, FOCUS_BLOCK_SEL,
  POINTER_GRACE_MS, POINTER_GRACE_TOUCH_MS,
  HAS_IO, HAS_MO, isFocusToggleChord, isFocusExitBlocked,
} from './constants.js';
import { findBlockFromNode, resolveGutterCaretPoint, caretRangeAtPoint, blockLineRects } from './dom-blocks.js';
import { applyBlockMarks, repairBlockMarks } from './recenter.js';
import { consumeProgrammaticScroll, resolveScrollBox } from './typewriter.js';
import { makeCursorHide } from './cursor-hide.js';
import { makeViewportSync } from './viewport.js';
import { editorHost } from '../shared/editor-host.js';
import { bindInlineFormattingShortcuts } from '../shared/shortcuts.js';
import { insertSoftBreak } from '../shared/soft-break.js';
import { collapseSoftNewlines } from './soft-newlines.js';

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
    // Zuletzt selbst geschriebene Scroll-Position samt Box (`{ box, top }`) —
    // im Fallback-Fall scrollt ein Vorfahr, nicht der Container.
    progScroll: null,
    // Box, die tatsächlich scrollt (Container oder — bei fremdem Host-CSS —
    // ein Vorfahr/das Dokument). Wird im Viewport-Tick neu aufgelöst, weil
    // Host-CSS die Kette per Media-Query umhängen kann.
    scrollBox: null,
    vvTimer: 0,
    cursorTimer: 0,
    // Short-circuit-Cache für den Recenter: bleibt der aktive Block gleich
    // (häufigster Fall beim Tippen), entfällt das Satz-Highlight.
    // _lastGranularity invalidiert bei Live-Mode-Switch.
    _lastBlock: null,
    _lastGranularity: null,
    // Hängen aktuell near-Marks im Baum? Erlaubt setNearBlocks, den Vollscan zu
    // überspringen, solange keine gesetzt sind und keine gewünscht werden —
    // also in jedem Tick ausserhalb von window-3.
    _marks: { near: false },
    _twCache: { block: null, value: null },  // cachedTypewriterThreshold
    // Letzter sichtbarer Ausschnitt `{ h, top }` (Tastatur-/Pan-Erkennung).
    _lastViewport: null,
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
    // Root ist die Box, die wirklich scrollt. Hat fremdes Host-CSS den Scroll an
    // einen Vorfahr abgegeben, wäre `root: container` eine Box, die mit dem
    // Inhalt mitwächst — sie „sieht" dann alle Blöcke gleichzeitig und der
    // Center-Pick verliert seine Vorauswahl. `null` (= Viewport) ist in dem Fall
    // der richtige Bezug und deckt sich mit dem Anker-Bezug in typewriter.js.
    const root = ctx.scrollBox === container ? container : null;
    ctx.io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) visibleBlocks.add(e.target);
        else visibleBlocks.delete(e.target);
      }
    }, { root, threshold: 0 });
    for (const el of container.querySelectorAll(FOCUS_BLOCK_SEL)) ctx.io.observe(el);
  }
  if (!HAS_MO) return;
  const observeSubtree = (node) => {
    if (!ctx.io || node.nodeType !== 1) return;
    if (BLOCK_TAGS.has(node.tagName)) ctx.io.observe(node);
    const nested = node.querySelectorAll?.(FOCUS_BLOCK_SEL);
    if (nested) for (const el of nested) ctx.io.observe(el);
  };
  const unobserveSubtree = (node) => {
    if (!ctx.io || node.nodeType !== 1) return;
    visibleBlocks.delete(node);
    if (BLOCK_TAGS.has(node.tagName)) ctx.io.unobserve(node);
    const nested = node.querySelectorAll?.(FOCUS_BLOCK_SEL);
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
  ctx.scrollBox = resolveScrollBox(container);
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

  // Klick/Tap ist Zeiger-Aktivität und macht den Zeiger wieder sichtbar.
  //
  // Why: `showCursor` hing ausschliesslich an `pointermove`. Wer den Zeiger auf
  // einem Wort ruhen lässt, bis Auto-Hide greift, und dann klickt, markiert
  // blind — die Selektion entsteht korrekt, aber Zeiger und I-Beam bleiben
  // unsichtbar, solange die Maus stillsteht. Genau das braucht man beim
  // Doppelklick auf ein Wort und beim Aufziehen einer Auswahl.
  const onPointerActivity = (e) => { markPointer(e); showCursor(); };

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
    if (repairBlockMarks(container, block, granularity, ctx._marks)) ctx._lastBlock = block;
  };

  // Input fängt, was selectionchange nicht abdeckt: undo/redo ohne Caret-Move,
  // Paste mit stabiler Caret-Position, Content-Rewrite durch externe Module.
  const onInput = (e) => {
    if (!isActive()) return;
    // Eingefügtes Fremd-HTML bringt Zeilenumbrüche und Einrückungen aus seiner
    // Quellformatierung mit; unter pre-wrap rendern die als Phantom-Zeilen
    // (Invariante 11c). Gleich hier einebnen, im selben Task wie die Mutation.
    // Auf den Paste-/Drop-`inputType` gefiltert, weil dies der einzige Weg ist,
    // auf dem solcher Whitespace mitten in einer Session entsteht — beim Tippen
    // liefe der Vollscan sonst bei jedem Zeichen.
    if (e?.inputType === 'insertFromPaste' || e?.inputType === 'insertFromDrop') {
      collapseSoftNewlines(container);
    }
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

  // Welche Box hat gescrollt? Ein Scroll des Dokuments feuert mit `document` als
  // Target; für alle anderen ist das Target die Box selbst.
  const scrollBoxOf = (e) => {
    const t = e.target;
    if (!t || t === document) return document.scrollingElement || document.documentElement;
    return t;
  };

  const onScroll = (e) => {
    if (!isActive()) return;
    const box = scrollBoxOf(e);
    // Nur Boxen, in denen der Editor liegt (`contains` schliesst die Box selbst
    // ein). Filtert fremde Scroller — Sidebar, Modal, Popover — heraus.
    if (!box || !box.contains?.(container)) return;
    if (consumeProgrammaticScroll(box, ctx)) return;
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
    applyBlockMarks(container, null, editorHost()?.focusGranularity || 'paragraph', ctx._marks);
    ctx._lastBlock = null;
  };
  // Fokus zurück im Editor (Modal zu, Tab-Navigation, Gutter-Klick) → Markierung
  // wieder setzen. Recentert wird dabei nur, wenn der Fokus NICHT von einem
  // Klick kommt: dieselbe Schonfrist wie im `selectionchange`-Pfad, denn ein
  // Klick ist eine absichtliche Positionswahl.
  //
  // Why: die Schonfrist hing bisher allein am `selectionchange`, das `focus`
  // aber läuft davor. Ob der Klick die angeklickte Zeile auf den Anker riss, war
  // damit ein Wettlauf — auf Touch und langsamen Geräten kommt der
  // `selectionchange` deutlich später (darum POINTER_GRACE_TOUCH_MS), der
  // Focus-Tick war längst durch. `pointerIntent` wird hier bewusst NICHT
  // verbraucht: der folgende `selectionchange` braucht es noch.
  const onFocus = () => {
    if (isActive()) ctrl._focusUpdateActive(!ctx.pointerIntent);
  };

  // Beide Verlassen-Wege — Escape und der Toggle-Chord — münden in
  // `exitFocusMode`, also in „speichern und zurück".
  //
  // Why: Escape ist im ablenkungsfreien Vollbild die intuitivste Verlassen-Taste.
  // Würde sie bei ungespeichertem Inhalt auf `cancelEdit` (Verwerfen-Dialog)
  // umbiegen, hätten die zwei Tasten gegensätzliche Ausgänge — und die
  // naheliegendste wäre die einzige, die Text wegwerfen kann. Verwerfen gehört
  // dem expliziten Abbrechen-Knopf.
  const onKey = (e) => {
    if (!isActive()) return;
    const app = editorHost();
    if (e.key === 'Escape') {
      // Offene Popover haben Vorrang: Escape schliesst erst sie.
      if (app?._synonymMenuOpen || app?._synonymPickerOpen) return;
      if (app?._figurLookupOpen) { app.closeFigurLookup?.(); return; }
      if (app?.editSaving) return;   // während Save-Request kein Exit
      e.preventDefault();
      ctrl.exitFocusMode();
    } else if (isFocusToggleChord(e)) {
      // Dieselbe Vorrang-Regel wie bei Escape (Invariante 16): laufender Save
      // und offene Popover gehen vor. Ohne den Guard riss der Chord den Editor
      // mitten im PUT ab — `exitFocusMode` überspringt dann seinen eigenen Save
      // (`!app.editSaving`) und räumt die Listener trotzdem weg.
      if (isFocusExitBlocked(app)) return;
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

  // Shift+Enter = weicher Umbruch, hier selbst gesetzt statt dem Browser
  // überlassen. Grund ist die pre-wrap-Regel auf den Schreibblöcken (Invariante
  // 11c): unter ihr schreibt Chromiums Default ein rohes `\n` statt eines <br>,
  // das ausserhalb des Fokusmodus zum Leerzeichen kollabiert — der Umbruch wäre
  // nach dem Speichern still weg.
  //
  // Am Container, nicht am Window: der Handler muss VOR dem delegierten
  // Keydown-Dispatcher der Toolbar-Karte laufen (document-Level, Bubble-Phase),
  // dessen `_kbSoftBreak` sonst zusätzlich `insertLineBreak` absetzen würde.
  // `stopPropagation` erledigt das. Zugleich deckt der Container-Listener die
  // Standalone-Shell der nativen Clients ab, die gar keine Toolbar-Karte hat —
  // dort galt bisher der blosse Browser-Default.
  const onSoftBreak = (e) => {
    if (!isActive()) return;
    if (e.key !== 'Enter' || !e.shiftKey) return;
    // Während einer IME-Composition nichts abfangen: Enter schliesst dort die
    // Kandidatenauswahl ab und darf den Editor nicht erreichen.
    if (e.isComposing || ctx.composing) return;
    e.preventDefault();
    e.stopPropagation();
    insertSoftBreak(container);
  };

  const onPointerMove = () => { if (isActive()) showCursor(); };

  // Klick in die leere Seitenfläche der Schreibspalte. Das Target ist genau dann
  // der Container selbst, wenn kein Block getroffen wurde — also im Padding.
  // Zwei Fälle, ein Handler:
  //   - seitlich neben einer Zeile → Caret an deren erstes (links) bzw. letztes
  //     (rechts) Zeichen. Der Browser-Default würde stattdessen an Buchanfang
  //     oder -ende springen, weil der Container der nächste Treffer ist.
  //   - im Kopf-/Tail-Puffer (über dem ersten, unter dem letzten Block) → nichts.
  //     Die Puffer sind Anker-hoch (Invariante 9); ein Caret-Sprung an
  //     Buchanfang/-ende ist dort nie gemeint.
  // Darum `preventDefault` in BEIDEN Fällen und der Caret danach selbst gesetzt.
  // `pointer-events` bleibt auto, sonst targetiert das Mausrad das Padding nicht
  // und Scroll funktioniert nur über dem Text.
  const onGutterMousedown = (e) => {
    if (e.target !== container || e.button !== 0) return;
    e.preventDefault();
    const box = container.getBoundingClientRect();
    const cs = getComputedStyle(container);
    const pad = (v) => parseFloat(v) || 0;
    const pt = resolveGutterCaretPoint(
      { left: box.left + pad(cs.paddingLeft), right: box.right - pad(cs.paddingRight) },
      container.querySelectorAll(FOCUS_BLOCK_SEL),
      e.clientX, e.clientY,
      blockLineRects,
    );
    if (!pt) return;
    const range = caretRangeAtPoint(pt.x, pt.y);
    if (!range || !container.contains(range.startContainer)) return;
    // Fokus VOR der Selection: `preventDefault` hat den Browser-Fokuswechsel
    // mitgeschluckt, und ein `focus()` danach würde den Caret erneut setzen.
    if (document.activeElement !== container) {
      try { container.focus({ preventScroll: true }); } catch { container.focus(); }
    }
    const sel = document.getSelection();
    if (!sel) return;
    // Shift-Klick erweitert die bestehende Auswahl bis zum Zeilenrand (links-
    // klick + Shift-Rechtsklick markiert damit genau eine Zeile).
    if (e.shiftKey && sel.rangeCount > 0 && sel.focusNode && container.contains(sel.focusNode)) {
      sel.extend(range.startContainer, range.startOffset);
      return;
    }
    sel.removeAllRanges();
    sel.addRange(range);
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
  container.addEventListener('keydown', onSoftBreak, { signal });
  container.addEventListener('compositionstart', onCompositionStart, { signal });
  container.addEventListener('compositionend', onCompositionEnd, { signal });
  // Scroll-Events bubbeln nicht — der Listener hängt darum am `document` in der
  // CAPTURE-Phase: die läuft für jedes dispatchte Event den vollen Pfad von
  // document zum Ziel ab, unabhängig vom bubbles-Flag. Ein einziger Listener
  // erwischt damit den Container UND die Box, an die eine fremde Schale den
  // Scroll abgegeben hat (Vorfahr oder Dokument, siehe `resolveScrollBox`). Hing
  // er nur am Container, wäre in genau diesen Schalen der Lese-Scroll unsichtbar
  // und das Spotlight bliebe beim Blättern stehen.
  document.addEventListener('scroll', onScroll, { capture: true, passive: true, signal });
  container.addEventListener('pointerdown', onPointerActivity, { signal });
  container.addEventListener('pointerup', onPointerActivity, { signal });
  container.addEventListener('mousedown', onGutterMousedown, { signal });
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
