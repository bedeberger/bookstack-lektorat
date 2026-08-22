// Undo/Redo-Kern für contenteditable-Editoren — Snapshot-Stack aus rohem
// `innerHTML` plus Caret-Text-Offset, entprellt zu satzweisen Schritten.
//
// Framework-frei und ohne Import: keine Alpine-Bindung, kein Host-Zugriff, kein
// DOM-Modul. Konsumenten sind der Notebook-Editor (editor/notebook/history.js,
// Alpine-Karte) und der Fokusmodus in einer fremden Schale
// (editor/focus/standalone.js, WKWebView ohne Alpine). Beide bekommen eine
// eigene Instanz, teilen aber diese eine Implementierung.
//
// WARUM ÜBERHAUPT EIN EIGENER STACK (zwei unabhängige Gründe):
//   1. Der browsereigene Stack kollabiert, sobald ein Editor-Modul `innerHTML`
//      oder `replaceChild` aufruft (Slash-Menü, HR-Insert, Paste-Cleaner).
//   2. WebKit (Safari/iOS/WKWebView) hält seinen TypingCommand offen, bis ein
//      echter Mausklick kommt — gemessen am 2026-08-22 gegen WebKit 26.x mit
//      echten NSEvent-Anschlägen: 66 in einem Rutsch getippte Zeichen fielen
//      einem einzigen Cmd+Z zum Opfer, danach `canUndo === false`. Wirkungslos
//      als Trennung waren Pfeiltasten, Enter, Backspace, Auto-Save,
//      blur()/focus(), Fenster-Deaktivierung, ein JS-Selektions-Reset,
//      execCommand('bold'), insertText('') und die AppKit-Kommandos
//      moveLeft:/moveRight:/moveWordLeft:. Nur ein echter `leftMouseDown`
//      trennte. Wer also eine Weile durchschreibt, ohne in den Text zu klicken,
//      verliert mit einem versehentlichen Cmd+Z alles davon — und der Auto-Save
//      persistiert die Löschung anschliessend still. Chromium ist von dieser
//      Körnung nicht in dieser Härte betroffen, weshalb Chromium-Tests die
//      Fehlerklasse strukturell nicht sehen (wie bei focus-selection.webkit).
//
// Vertrag mit dem Aufrufer:
//   getRoot()            → das contenteditable (oder null, wenn gerade keins da ist)
//   mountHtml(el, html)  → HTML einhängen. Bewusst injiziert, nicht importiert:
//                          der Notebook-Editor braucht die volle Mount-Pipeline
//                          (Block-Normalisierung, Caret-Slot, atomare Chips),
//                          die Standalone-Schale genau ihren eigenen Mount
//                          (`innerHTML` + collapseSoftNewlines). Ein Import der
//                          Notebook-Pipeline zöge cite-/xref-/mermaid-/table-html
//                          in die Import-Closure und damit ins OTA-Bundle des
//                          nativen Clients.
//   onRestored(el, snap) → optional, nach Mount + Caret + Fokus. Hier setzt der
//                          Aufrufer sein Dirty-Flag und plant Draft/Autosave.
//
// XSS: Snapshots stammen ausschliesslich aus `getRoot().innerHTML` — Inhalt, der
// zuvor durch die Paste-Cleaner-Kette gelaufen ist. Kein externer String landet
// hier.

const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_MAX = 100;

// Caret-Position als reiner Text-Offset ab Editor-Anfang. Robust genug über
// strukturelle Mutationen (Slash-Menü, HR-Insert, Block-Wrap im Mount): Wrapping
// verändert keine Textinhalte, `<br>`/`<p>` sind kein Text.
export function captureCaretOffset(root) {
  if (!root) return null;
  const sel = root.ownerDocument?.defaultView?.getSelection?.()
    ?? (typeof document !== 'undefined' ? document.getSelection?.() : null);
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer)) return null;
  const pre = range.cloneRange();
  pre.selectNodeContents(root);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length;
}

export function restoreCaretAtOffset(root, offset) {
  if (!root || offset == null) return;
  const doc = root.ownerDocument;
  if (!doc?.createTreeWalker || !doc?.createRange) return;
  try {
    const filterText = (typeof NodeFilter !== 'undefined' ? NodeFilter.SHOW_TEXT : 4);
    const walker = doc.createTreeWalker(root, filterText);
    let remaining = offset;
    let target = null;
    let targetOffset = 0;
    let n;
    while ((n = walker.nextNode())) {
      const len = n.nodeValue.length;
      if (remaining <= len) {
        target = n;
        targetOffset = remaining;
        break;
      }
      remaining -= len;
    }
    const range = doc.createRange();
    if (typeof range.setStart !== 'function') return;
    if (target) {
      range.setStart(target, targetOffset);
    } else {
      range.selectNodeContents(root);
      range.collapse(false);
    }
    range.collapse(true);
    const win = doc.defaultView || (typeof window !== 'undefined' ? window : null);
    const sel = win?.getSelection?.()
      ?? (typeof document !== 'undefined' ? document.getSelection?.() : null);
    if (sel?.removeAllRanges && sel?.addRange) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
  } catch {
    // Caret-Restore ist Best-Effort — bei Edge-Cases (Tree-Walker-Limits,
    // disconnected Nodes) lieber kein Caret als crash.
  }
}

// `input`-Event nach einem Restore. `inputType` ist HARTER VERTRAG, nicht Kosmetik:
// die Boot-Glue des nativen macOS-Clients erkennt genau 'historyUndo'/'historyRedo',
// um den Umfang-Hinweis zu zeigen, und braucht das Event ausserdem für Dirty-Flag,
// Auto-Save, Live-Statistik und die Rechtschreib-Neuprüfung. Der `Event`-Rückfall
// deckt Umgebungen ohne `InputEvent` ab (linkedom in den Unit-Tests).
function dispatchHistoryInput(el, inputType) {
  const win = el.ownerDocument?.defaultView || (typeof window !== 'undefined' ? window : null);
  const InputEventCtor = win?.InputEvent || (typeof InputEvent !== 'undefined' ? InputEvent : null);
  const EventCtor = win?.Event || (typeof Event !== 'undefined' ? Event : null);
  try {
    if (InputEventCtor) {
      el.dispatchEvent(new InputEventCtor('input', { bubbles: true, inputType }));
      return;
    }
  } catch { /* fällt unten auf Event zurück */ }
  try {
    if (EventCtor) el.dispatchEvent(new EventCtor('input', { bubbles: true }));
  } catch { /* last-resort swallow */ }
}

export function createEditHistory({
  getRoot,
  mountHtml,
  onRestored = null,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  max = DEFAULT_MAX,
} = {}) {
  if (typeof getRoot !== 'function') throw new Error('createEditHistory: getRoot erforderlich');
  if (typeof mountHtml !== 'function') throw new Error('createEditHistory: mountHtml erforderlich');

  let stack = [];
  let idx = -1;
  let timer = null;
  // Während eines Restores: kein Push. Das Restore mutiert das DOM und feuert
  // selbst ein `input` — ohne dieses Flag würde der Restore-Stand als neuer
  // Stack-Eintrag landen und Redo wäre nach einem Undo sofort tot.
  let applying = false;

  const cancelTimer = () => {
    if (timer) { clearTimeout(timer); timer = null; }
  };

  function pushNow() {
    if (applying) return;
    cancelTimer();
    const el = getRoot();
    if (!el) return;
    const html = el.innerHTML;
    const top = stack[idx];
    if (top && top.html === html) return;      // Dedupe gegen die Spitze
    if (idx < stack.length - 1) stack.length = idx + 1;   // Redo-Ast abschneiden
    stack.push({ html, caretOffset: captureCaretOffset(el) });
    if (stack.length > max) stack.splice(0, stack.length - max);
    idx = stack.length - 1;
  }

  function restore(snap, inputType) {
    const el = getRoot();
    if (!el || !snap) return;
    applying = true;
    try {
      mountHtml(el, snap.html || '');
      restoreCaretAtOffset(el, snap.caretOffset);
      el.focus?.();
      if (typeof onRestored === 'function') {
        try { onRestored(el, snap); } catch { /* Aufrufer-Glue darf das Restore nicht kippen */ }
      }
      dispatchHistoryInput(el, inputType);
    } finally {
      applying = false;
    }
  }

  return {
    // Baseline setzen — Session-Start bzw. Seitenwechsel. Historie ist pro Seite.
    reset(html) {
      cancelTimer();
      stack = [{ html: html ?? '', caretOffset: 0 }];
      idx = 0;
      applying = false;
    },

    // Historie komplett verwerfen (Session-Ende / Unmount). NICHT beim Speichern
    // aufrufen: im Fokusmodus wird ununterbrochen weitergeschrieben und alle
    // 1,5 s automatisch gespeichert — ein Clear am Save nähme dem User genau
    // die Schritte weg, die er zurückholen will.
    clear() {
      cancelTimer();
      stack = [];
      idx = -1;
      applying = false;
    },

    // Entprellt: eine Tipp-Serie wird zu EINEM Schritt.
    pushSoon() {
      if (applying) return;
      cancelTimer();
      timer = setTimeout(() => { timer = null; pushNow(); }, debounceMs);
    },

    pushNow,

    canUndo() { return idx > 0; },
    canRedo() { return idx >= 0 && idx < stack.length - 1; },

    undo() {
      if (applying) return false;
      // Offenen Debounce zuerst einlösen, sonst ginge die gerade getippte
      // Strecke verloren statt rückgängig gemacht zu werden.
      if (timer) { cancelTimer(); pushNow(); }
      if (idx <= 0) return false;
      idx--;
      restore(stack[idx], 'historyUndo');
      return true;
    },

    redo() {
      if (applying) return false;
      if (idx < 0 || idx >= stack.length - 1) return false;
      idx++;
      restore(stack[idx], 'historyRedo');
      return true;
    },

    // Nur für Tests/Diagnose — kein Konsument steuert damit Verhalten.
    size() { return stack.length; },
    index() { return idx; },
    isApplying() { return applying; },
  };
}
