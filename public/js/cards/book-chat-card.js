// Alpine.data('bookChatCard') — Sub-Komponente des Buch-Chats.
// Freie Konversation über das gesamte Buch (Agent mit Tool-Use).
//
// Eigener State: bookChatSessions, bookChatMessages, bookChatSessionId,
//   bookChatInput, bookChatLoading, bookChatProgress, bookChatStatus,
//   _bookChatPollTimer.
// Root behält: showBookChatCard (Hash-Router), selectedBookId,
//   selectedBookName, t.

import { bookChatMethods } from '../book-chat.js';

export function registerBookChatCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('bookChatCard', () => ({
    bookChatSessions: [],
    bookChatMessages: [],
    bookChatSessionId: null,
    bookChatInput: '',
    bookChatLoading: false,
    bookChatProgress: 0,
    bookChatStatus: '',
    _bookChatPollTimer: null,

    _onBookChanged: null,
    _onViewReset: null,
    _onResetBookChat: null,

    init() {
      this.$watch(() => this.$root.showBookChatCard, async (visible) => {
        if (!visible) return;
        await this._onVisibleBookChat();
      });

      this._onResetBookChat = () => this.resetBookChat();
      window.addEventListener('book-chat:reset', this._onResetBookChat);

      this._onBookChanged = () => this.resetBookChat();
      window.addEventListener('book:changed', this._onBookChanged);

      this._onViewReset = () => this.resetBookChat();
      window.addEventListener('view:reset', this._onViewReset);
    },

    destroy() {
      if (this._bookChatPollTimer) { clearInterval(this._bookChatPollTimer); this._bookChatPollTimer = null; }
      if (this._onResetBookChat) window.removeEventListener('book-chat:reset', this._onResetBookChat);
      if (this._onBookChanged)   window.removeEventListener('book:changed', this._onBookChanged);
      if (this._onViewReset)     window.removeEventListener('view:reset', this._onViewReset);
    },

    ...bookChatMethods,
  }));
}
