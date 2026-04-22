// Alpine.data('chatCard') — Sub-Komponente des Seiten-Chats.
// SSE-basierte Konversation über die aktuell offene Seite.
//
// Eigener State: chatSessions, chatMessages, chatSessionId, chatInput,
//   chatLoading, chatProgress, chatStatus, _chatPollTimer, _chatPendingRefresh.
// Root behält: showChatCard (Hash-Router), currentPage, originalHtml,
//   saveApplying, lektoratFindings, checkDone, _checkDoneBeforeChat,
//   bsGet, _loadApplyAndSave, updatePageView, selectedBookId, t.

import { chatMethods } from '../chat.js';

export function registerChatCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('chatCard', () => ({
    chatSessions: [],
    chatMessages: [],
    chatSessionId: null,
    chatInput: '',
    chatLoading: false,
    chatProgress: 0,
    chatStatus: '',
    _chatPollTimer: null,
    _chatPendingRefresh: false,

    _onBookChanged: null,
    _onViewReset: null,
    _onResetChat: null,

    init() {
      this.$watch(() => window.__app.showChatCard, async (visible) => {
        if (!visible) return;
        await this._onVisibleChat();
      });

      // Beim Seitenwechsel Chat-Session komplett zurücksetzen — chat gehört
      // zur aktuellen Seite. Der Root ruft bei selectPage() jetzt das Event.
      this._onResetChat = () => this.resetChat();
      window.addEventListener('chat:reset', this._onResetChat);

      this._onBookChanged = () => this.resetChat();
      window.addEventListener('book:changed', this._onBookChanged);

      this._onViewReset = () => this.resetChat();
      window.addEventListener('view:reset', this._onViewReset);
    },

    destroy() {
      if (this._chatPollTimer) { clearInterval(this._chatPollTimer); this._chatPollTimer = null; }
      if (this._onResetChat)   window.removeEventListener('chat:reset', this._onResetChat);
      if (this._onBookChanged) window.removeEventListener('book:changed', this._onBookChanged);
      if (this._onViewReset)   window.removeEventListener('view:reset', this._onViewReset);
    },

    ...chatMethods,
  }));
}
