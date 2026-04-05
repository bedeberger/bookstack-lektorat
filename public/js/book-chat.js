import { escHtml } from './utils.js';


// Buch-Chat-Methoden (werden in die Alpine-Komponente gespreadet).
// `this` bezieht sich auf die Alpine-Komponente.
// Keine Vorschläge – nur freie Konversation über das gesamte Buch.

export const bookChatMethods = {

  // ── Karte öffnen/schliessen ─────────────────────────────────────────────────

  async toggleBookChatCard() {
    if (this.showBookChatCard) {
      this.showBookChatCard = false;
      return;
    }
    if (!this.selectedBookId) return;
    this.showBookChatCard = true;
    await this.loadBookChatSessions();

    if (this.bookChatSessions.length === 0) {
      await this.startNewBookChatSession();
    } else if (!this.bookChatSessionId) {
      await this.loadBookChatSession(this.bookChatSessions[0].id);
    }
    this.$nextTick(() => {
      document.getElementById('book-chat-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      this._scrollBookChatToBottom();
    });
  },

  // ── Session-Verwaltung ──────────────────────────────────────────────────────

  async startNewBookChatSession() {
    if (!this.selectedBookId) return;
    try {
      const { id } = await fetch('/chat/session/book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          book_id:   parseInt(this.selectedBookId),
          book_name: this.selectedBookName,
        }),
      }).then(r => r.json());
      this.bookChatSessionId = id;
      this.bookChatMessages  = [];
      this.bookChatStatus    = '';
      await this.loadBookChatSessions();
    } catch (e) {
      console.error('[startNewBookChatSession]', e);
    }
  },

  async loadBookChatSessions() {
    if (!this.selectedBookId) return;
    try {
      this.bookChatSessions = await fetch('/chat/sessions/book/' + this.selectedBookId).then(r => r.json());
    } catch (e) {
      console.error('[loadBookChatSessions]', e);
    }
  },

  async loadBookChatSession(sessionId) {
    try {
      const data = await fetch('/chat/session/' + sessionId).then(r => r.json());
      this.bookChatSessionId = data.id;
      this.bookChatMessages  = data.messages || [];
      this.bookChatStatus    = '';
      this.$nextTick(() => this._scrollBookChatToBottom());

      // Reconnect: prüfen ob ein Buch-Chat-Job noch läuft
      if (!this._bookChatPollTimer && !this.bookChatLoading) {
        try {
          const { jobId } = await fetch(`/jobs/active?type=book-chat&book_id=${sessionId}`).then(r => r.json());
          if (jobId) {
            this.bookChatLoading = true;
            this._startBookChatPoll(jobId);
          }
        } catch (e) {
          console.error('[loadBookChatSession] active-job check:', e);
        }
      }
    } catch (e) {
      console.error('[loadBookChatSession]', e);
    }
  },

  async deleteBookChatSession(id) {
    try {
      await fetch('/chat/session/' + id, { method: 'DELETE' });
      this.bookChatSessions = this.bookChatSessions.filter(s => s.id !== id);
      if (this.bookChatSessionId === id) {
        this.bookChatSessionId = null;
        this.bookChatMessages  = [];
        if (this.bookChatSessions.length > 0) {
          await this.loadBookChatSession(this.bookChatSessions[0].id);
        } else {
          await this.startNewBookChatSession();
        }
      }
    } catch (e) {
      console.error('[deleteBookChatSession]', e);
    }
  },

  // ── Nachricht senden ────────────────────────────────────────────────────────

  async sendBookChatMessage() {
    const msg = (this.bookChatInput || '').trim();
    if (!msg || this.bookChatLoading || !this.bookChatSessionId) return;

    this.bookChatInput   = '';
    this.bookChatLoading = true;
    this.bookChatStatus  = '';

    // Optimistisch anzeigen
    this.bookChatMessages.push({ role: 'user', content: msg, id: null });
    this.$nextTick(() => this._scrollBookChatToBottom());

    try {
      const { jobId } = await fetch('/jobs/book-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: this.bookChatSessionId, message: msg }),
      }).then(r => r.json());

      this._startBookChatPoll(jobId);
    } catch (e) {
      console.error('[sendBookChatMessage]', e);
      this.bookChatMessages = this.bookChatMessages.slice(0, -1);
      this.bookChatStatus  = `<span class="error-msg">Fehler: ${escHtml(e.message)}</span>`;
      this.bookChatLoading = false;
    }
  },

  _startBookChatPoll(jobId) {
    const sessionId = this.bookChatSessionId;
    this._startPoll({
      timerProp:    '_bookChatPollTimer',
      progressProp: 'bookChatProgress',
      jobId,
      lsKey: null,
      onProgress: (job) => {
        this.bookChatStatus = this._runningJobStatus(job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut);
      },
      onNotFound: async () => {
        this.bookChatLoading   = false;
        this.bookChatProgress  = 0;
        this.bookChatStatus    = '';
        await this.loadBookChatSession(sessionId);
      },
      onError: (job) => {
        this.bookChatLoading  = false;
        this.bookChatProgress = 0;
        this.bookChatStatus   = `<span class="error-msg">Fehler: ${escHtml(job.error || 'Unbekannter Fehler')}</span>`;
      },
      onDone: async () => {
        this.bookChatLoading  = false;
        this.bookChatProgress = 0;
        this.bookChatStatus   = '';
        await this.loadBookChatSession(sessionId);
        await this.loadBookChatSessions();
      },
    });
  },

  // ── Hilfsmethoden ───────────────────────────────────────────────────────────

  _scrollBookChatToBottom() {
    const el = document.getElementById('book-chat-messages');
    if (el) el.scrollTop = el.scrollHeight;
  },

  /** Wird beim Buchwechsel (selectBook / resetView) aufgerufen. */
  resetBookChat() {
    if (this._bookChatPollTimer) { clearInterval(this._bookChatPollTimer); this._bookChatPollTimer = null; }
    this.showBookChatCard  = false;
    this.bookChatSessions  = [];
    this.bookChatMessages  = [];
    this.bookChatSessionId = null;
    this.bookChatInput     = '';
    this.bookChatLoading   = false;
    this.bookChatProgress  = 0;
    this.bookChatStatus    = '';
  },
};
