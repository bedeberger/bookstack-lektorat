import { makeChatMethods } from './chat-base.js';

// Buch-Chat-Methoden (werden in Alpine.data('bookChatCard') gespreadet).
// Keine Vorschläge – nur freie Konversation über das gesamte Buch (Agent-Flow).

export const bookChatMethods = {
  // Gruppiert Tool-Calls eines Agent-Buch-Chat-Turns nach Name.
  // Rückgabe: [{ name, count, errors }]
  _agentToolSummary(toolCalls) {
    if (!Array.isArray(toolCalls) || !toolCalls.length) return [];
    const byName = new Map();
    for (const tc of toolCalls) {
      const e = byName.get(tc.name) || { name: tc.name, count: 0, errors: 0 };
      e.count++;
      if (tc.ok === false) e.errors++;
      byName.set(tc.name, e);
    }
    return Array.from(byName.values());
  },

  ...makeChatMethods({
    label: 'BookChat',
    props: {
      show: 'showBookChatCard',
      sessions: 'bookChatSessions',
      messages: 'bookChatMessages',
      sessionId: 'bookChatSessionId',
      input: 'bookChatInput',
      loading: 'bookChatLoading',
      status: 'bookChatStatus',
      progress: 'bookChatProgress',
      pollTimer: '_bookChatPollTimer',
    },
    scrollElId: 'book-chat-messages',
    activeJobType: 'book-chat',
    canOpen: (ctx) => !!ctx.$app.selectedBookId,
    sessionsUrl: (ctx) => '/chat/sessions/book/' + ctx.$app.selectedBookId,
    newSessionUrl: '/chat/session/book',
    newSessionBody: (ctx) => ({
      book_id:   parseInt(ctx.$app.selectedBookId),
      book_name: ctx.$app.selectedBookName,
    }),
    sendUrl: '/jobs/book-chat',
    onBeforeNewSession: async function () {
      await fetch('/jobs/book-chat-cache?book_id=' + window.__app.selectedBookId, { method: 'DELETE' });
    },
    onReopen: async function () {
      await this.loadBookChatSessions();
    },
    onPollProgress: function (job) {
      this.bookChatStatus = this._runningJobStatus(job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut, job.progress, job.tokensPerSec, job.statusParams);
    },
    onPollDone: async function () {
      await this.loadBookChatSessions();
    },
  }),
};
