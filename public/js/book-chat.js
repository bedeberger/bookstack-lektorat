import { makeChatMethods } from './chat-base.js';

// Buch-Chat-Methoden (werden in die Alpine-Komponente gespreadet).
// Gemeinsame Logik kommt aus chat-base.js; hier nur Buch-Chat-Konfiguration.
// Keine Vorschläge – nur freie Konversation über das gesamte Buch.

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
    closeOtherCards: 'bookChat',
    canOpen: (ctx) => !!ctx.selectedBookId,
    sessionsUrl: (ctx) => '/chat/sessions/book/' + ctx.selectedBookId,
    newSessionUrl: '/chat/session/book',
    newSessionBody: (ctx) => ({
      book_id:   parseInt(ctx.selectedBookId),
      book_name: ctx.selectedBookName,
    }),
    sendUrl: '/jobs/book-chat',
    onBeforeNewSession: async function () {
      await fetch('/jobs/book-chat-cache?book_id=' + this.selectedBookId, { method: 'DELETE' });
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
