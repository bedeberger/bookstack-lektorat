// Inline-Formatting-Shortcuts mit Whitelist. Beide Editoren verwenden dieselbe
// Bindings-Funktion; die `allowedCommands`-Liste entscheidet, welche Commands
// im jeweiligen Editor wirken.
//
// MVP-Whitelist (Focus + Normal):  ['bold', 'italic', 'underline']
//                                  → Cmd/Ctrl+B / +I / +U
// Andere Shortcuts werden bewusst nicht abgefangen — Browser-Default greift
// (z.B. Cmd+S wird vom Editor-Karten-Handler verarbeitet).
//
// AUSNAHME Undo/Redo: `matchHistoryCommand` unten. Cmd/Ctrl+Z darf in KEINEM
// der beiden Editoren zum Browser durchfallen — beide fahren eine eigene
// Snapshot-Historie (shared/edit-history.js), und ein zusätzlich laufender
// Browser-Stack liesse ein Cmd+Z doppelt wirken. Der Aufrufer muss also
// preventDefault'en, siehe notebook/toolbar/keydown.js#_kbUndoRedo und
// focus/listeners.js.

const COMMAND_KEY = {
  bold: 'b',
  italic: 'i',
  underline: 'u',
};

// Liefert true, wenn ein KeyboardEvent dem Inline-Format-Pattern entspricht
// (Cmd auf Mac, Ctrl sonst) und der Buchstabe in der Whitelist ist. Reine
// Funktion ohne DOM-Zugriff, damit Whitelist-Verhalten isoliert testbar
// bleibt.
export function matchInlineCommand(event, allowedCommands) {
  if (!event) return null;
  const mod = event.metaKey || event.ctrlKey;
  if (!mod) return null;
  if (event.altKey || event.shiftKey) return null;
  const key = (event.key || '').toLowerCase();
  for (const cmd of allowedCommands) {
    if (COMMAND_KEY[cmd] === key) return cmd;
  }
  return null;
}

// Hängt einen Keydown-Listener an `container`, der bei passendem Shortcut
// `document.execCommand(cmd, false, null)` ausführt und das Event
// preventDefault'et. Liefert die Teardown-Funktion zurück; optional über
// `signal` an einen AbortController gehängt — beide Wege funktionieren parallel.
//
// `execCommand` ist deprecated, aber für `bold`/`italic`/`underline` weiterhin
// in allen aktuellen Browsern unterstützt und der pragmatischste Weg, ohne
// einen Rich-Text-Editor-Stack einzuziehen. Sollte eine spätere Phase mehr
// Commands brauchen, lohnt sich der Umstieg auf ein Beziehungs-Modell mit
// Selection-Range-Mutation.
export function bindInlineFormattingShortcuts(container, { allowedCommands, signal, onCommand } = {}) {
  if (!container) return () => {};
  const allow = Array.isArray(allowedCommands) ? allowedCommands : ['bold', 'italic', 'underline'];
  const handler = (event) => {
    const cmd = matchInlineCommand(event, allow);
    if (!cmd) return;
    event.preventDefault();
    // stopPropagation: verhindert, dass der Notebook-Toolbar-Handler (document-
    // level Delegation, siehe editor-toolbar-card.js) denselben Cmd+B/I noch-
    // mal als execCommand laufen lässt und die gerade gesetzte Formatierung
    // wieder togglet.
    event.stopPropagation();
    try { document.execCommand(cmd, false, null); } catch {}
    if (typeof onCommand === 'function') {
      try { onCommand(cmd); } catch {}
    }
  };
  container.addEventListener('keydown', handler, signal ? { signal } : undefined);
  return () => container.removeEventListener('keydown', handler);
}

// Undo/Redo-Griffe, geteilt von beiden Editoren: Cmd/Ctrl+Z = Undo,
// Cmd/Ctrl+Shift+Z und Ctrl+Y = Redo. Reine Funktion, damit die Griffe nicht in
// zwei Handlern auseinanderdriften (der Notebook-Dispatcher hängt am document,
// der Fokusmodus am contenteditable). Liefert 'undo' | 'redo' | null.
export function matchHistoryCommand(event) {
  if (!event) return null;
  const mod = event.metaKey || event.ctrlKey;
  if (!mod || event.altKey) return null;
  const key = (event.key || '').toLowerCase();
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo';
  if (key === 'y' && !event.shiftKey) return 'redo';
  return null;
}
