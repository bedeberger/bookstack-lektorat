import { EVT } from '../../events.js';
import { isFocusToggleChord, isFocusExitBlocked } from './constants.js';
// Root-Trampoline: dispatcht Events an Alpine.data('editorFocusCard').
// Root hält `focusActive` als sichtbare Flag (CSS, body-Class, Template-Checks)
// und die Live-Counter `focusCountWords`/`focusCountChars`, die der Header im
// Fokus-Modus zeigt. State-Felder leben in `focusState` ([app-state.js]) —
// damit liegen alle vier Editor-Modi-Flags in einem konsistenten Slice.

export const focusMethods = {
  enterFocusMode() {
    window.dispatchEvent(new CustomEvent(EVT.EDITOR_FOCUS_ENTER));
  },

  exitFocusMode() {
    window.dispatchEvent(new CustomEvent(EVT.EDITOR_FOCUS_EXIT));
  },

  // Page-View-Direkteinstieg: Sub-Karte trampolinet Edit-Mode hoch und tritt
  // dann in Fokus ein. Quelle: Focus-Button im Page-View-Header + Hotkey aus
  // Lesemodus. Pendant zu enter/exit, eigener Event, damit die Sub-Karte den
  // Mode-Übergang als ein Ganzes verbuchen kann (keine Race zwischen
  // startEdit() und enterFocusMode()).
  enterFocusFromPageview() {
    window.dispatchEvent(new CustomEvent(EVT.EDITOR_FOCUS_ENTER_FROM_PAGEVIEW));
  },

  // Global Cmd/Ctrl+Shift+E-Hotkey. Läuft auf dem Body-Listener (siehe index.html),
  // damit der Fokusmodus auch aus dem Lesemodus heraus einschaltbar ist.
  // Cmd+Shift+F ist für die BookStack-Volltextsuche reserviert.
  handleFocusHotkey(event) {
    if (!isFocusToggleChord(event)) return;
    if (!this.showEditorCard) return;
    // Vorrang-Regel (Invariante 16) vor dem `preventDefault`: dieser Listener
    // ist der zweite Weg, auf dem der Chord im Fokusmodus ankommt — der erste
    // ist listeners.js#onKey. Fehlt der Guard hier, verlässt der Chord den
    // Modus mitten im Save trotzdem, obwohl onKey ihn korrekt abgelehnt hat.
    if (this.focusActive && isFocusExitBlocked(this)) return;
    event.preventDefault();
    if (this.focusActive) {
      window.dispatchEvent(new CustomEvent(EVT.EDITOR_FOCUS_EXIT));
    } else if (this.editMode) {
      window.dispatchEvent(new CustomEvent(EVT.EDITOR_FOCUS_ENTER));
    } else {
      window.dispatchEvent(new CustomEvent(EVT.EDITOR_FOCUS_ENTER_FROM_PAGEVIEW));
    }
  },
};
