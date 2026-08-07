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
    canOpen: (ctx) => !!Alpine.store('nav').selectedBookId,
    sessionsUrl: (ctx) => '/chat/sessions/book/' + Alpine.store('nav').selectedBookId,
    newSessionUrl: '/chat/session/book',
    newSessionBody: (ctx) => ({
      book_id:   parseInt(Alpine.store('nav').selectedBookId),
      book_name: ctx.$app.selectedBookName,
    }),
    sendUrl: '/jobs/book-chat',
    onBeforeNewSession: async function () {
      await fetch('/jobs/book-chat-cache?book_id=' + Alpine.store('nav').selectedBookId, { method: 'DELETE' });
    },
    onReopen: async function () {
      await this.loadBookChatSessions();
    },
    onPollProgress: function (job) {
      this.bookChatStatus = this._runningJobStatus(job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut, job.progress, job.tokensPerSec, job.statusParams, job.cacheReadIn);
    },
    onPollDone: async function () {
      const sid = this.bookChatSessionId;
      const sessions = this.bookChatSessions || [];
      const idx = sessions.findIndex(s => s.id === sid);
      const nowIso = new Date().toISOString();
      if (idx >= 0) {
        const row = { ...sessions[idx], last_message_at: nowIso };
        const next = sessions.slice();
        next.splice(idx, 1);
        next.unshift(row);
        this.bookChatSessions = next;
      } else {
        const firstUserMsg = (this.bookChatMessages || []).find(m => m.role === 'user');
        const root = window.__app;
        this.bookChatSessions = [
          {
            id: sid,
            book_id: parseInt(Alpine.store('nav').selectedBookId),
            book_name: root.selectedBookName,
            created_at: nowIso,
            last_message_at: nowIso,
            preview: firstUserMsg ? firstUserMsg.content : '',
          },
          ...sessions,
        ];
      }
    },
  }),
};
