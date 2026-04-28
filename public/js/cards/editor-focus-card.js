// Alpine.data('editorFocusCard') — Sub-Komponente für den Vollbild-Fokusmodus
// mit Absatz-Hervorhebung und Typewriter-Scroll.
//
// Eigener State: _focusState ('idle'|'entering'|'active'|'exiting'),
//   _focusGen, _focusListeners, _focusVisibleBlocks, _focusRaf.
// Root behält: `focusMode` (als sichtbare Flag für Templates, CSS, body-Class,
//   editor-toolbar/figur-lookup-Checks), `editMode`, `editDirty`, `editSaving`,
//   `saveOffline`, `lastDraftSavedAt`. Die Sub schreibt `window.__app.focusMode`.
//
// Trigger-Events aus dem Root (Trampoline in editor-focus.js):
//   - `editor:focus:toggle`    — toggle je nach State
//   - `editor:focus:enter`     — explizit betreten (muss editMode sein)
//   - `editor:focus:exit`      — verlassen
//   - `editor:focus:start-edit` — startet Edit-Mode und tritt dann in Fokus ein

import { focusCardMethods, readFocusSnapshot, clearFocusSnapshot } from '../editor-focus.js';

export function registerEditorFocusCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('editorFocusCard', () => ({
    _focusState: 'idle',
    _focusGen: 0,
    _focusListeners: null,
    _focusVisibleBlocks: null,
    _focusRaf: null,

    _onToggle: null,
    _onEnter: null,
    _onExit: null,
    _onStartEdit: null,
    _restoreSnapshot: null,

    init() {
      this._onToggle    = () => this.toggleFocusMode();
      this._onEnter     = () => this.enterFocusMode();
      this._onExit      = () => this.exitFocusMode();
      this._onStartEdit = () => this.startFocusEdit();
      window.addEventListener('editor:focus:toggle',     this._onToggle);
      window.addEventListener('editor:focus:enter',      this._onEnter);
      window.addEventListener('editor:focus:exit',       this._onExit);
      window.addEventListener('editor:focus:start-edit', this._onStartEdit);

      // Live-Switch: User ändert Granularität in den Settings, während Focus
      // aktiv ist → Body-Class + State sofort umstellen, ohne Exit/Re-Enter.
      this.$watch(() => window.__app?.focusGranularity, (g) => {
        if (this._focusState !== 'active') return;
        document.body.classList.remove('focus-mode--paragraph', 'focus-mode--sentence', 'focus-mode--window-3', 'focus-mode--typewriter-only');
        document.body.classList.add('focus-mode--' + (g || 'paragraph'));
        this._focusUpdateActive(false);
      });

      // Auto-Restore: Reload (z.B. via Session-Banner-Relogin oder manuelles
      // F5) soll den Fokusmodus wieder einnehmen, wenn die ursprüngliche Seite
      // geladen ist. Snapshot wird beim Eintritt in editor-focus.js geschrieben
      // und beim regulären Exit gelöscht.
      this._restoreSnapshot = readFocusSnapshot();
      if (this._restoreSnapshot) {
        const tryRestore = () => this._tryRestoreFocus();
        this.$watch(() => window.__app?.currentPage?.id, tryRestore);
        this.$watch(() => window.__app?.renderedPageHtml, tryRestore);
        this.$watch(() => window.__app?.showEditorCard, tryRestore);
        // Initial check für den Fall, dass beim Mount bereits alles da ist.
        queueMicrotask(tryRestore);
      }
    },

    _tryRestoreFocus() {
      const snap = this._restoreSnapshot;
      if (!snap) return;
      const app = window.__app;
      if (!app) return;
      if (this._focusState !== 'idle') return;
      if (!app.showEditorCard) return;
      if (!app.currentPage || app.currentPage.id !== snap.pageId) return;
      if (!app.renderedPageHtml) return;

      // Snapshot konsumieren — auch bei späterem Misserfolg nicht erneut
      // versuchen, sonst Loop bei kaputter Seite.
      this._restoreSnapshot = null;
      // Snapshot wird in startEdit/enterFocusMode wieder gesetzt; hier vorab
      // löschen, falls startFocusEdit bricht (z.B. checkLoading aktiv).
      clearFocusSnapshot();
      this.startFocusEdit();
    },

    destroy() {
      if (this._onToggle)    window.removeEventListener('editor:focus:toggle',     this._onToggle);
      if (this._onEnter)     window.removeEventListener('editor:focus:enter',      this._onEnter);
      if (this._onExit)      window.removeEventListener('editor:focus:exit',       this._onExit);
      if (this._onStartEdit) window.removeEventListener('editor:focus:start-edit', this._onStartEdit);
      // Defensive: falls bei destroy noch Listener offen sind (z.B. Hot-Reload)
      if (this._focusListeners) {
        try { this._focusTeardown(); } catch (e) { /* ignorieren */ }
      }
    },

    ...focusCardMethods,
  }));
}
