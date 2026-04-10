import { escHtml, fmtTok, renderChatMarkdown } from './utils.js';

// Chat-Methoden (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.
// Nachrichten laufen über den Job-Queue (/jobs/chat) – tab-resilient.

export const chatMethods = {

  // ── Karte öffnen/schliessen ─────────────────────────────────────────────────

  async toggleChatCard() {
    if (this.showChatCard) {
      this.showChatCard = false;
      return;
    }
    if (!this.currentPage) return; // Braucht eine ausgewählte Seite
    this.showChatCard = true;
    await this.loadChatSessions(this.currentPage.id);

    // Wenn keine Session vorhanden: automatisch neue starten
    if (this.chatSessions.length === 0) {
      await this.startNewChatSession();
    } else if (!this.chatSessionId) {
      // Neueste Session laden
      await this.loadChatSession(this.chatSessions[0].id);
    }
    this.$nextTick(() => this._scrollChatToBottom());
  },

  // ── Session-Verwaltung ──────────────────────────────────────────────────────

  async startNewChatSession() {
    if (!this.currentPage) return;
    try {
      const { id } = await fetch('/chat/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          book_id:   parseInt(this.selectedBookId),
          book_name: this.selectedBookName,
          page_id:   this.currentPage.id,
          page_name: this.currentPage.name,
        }),
      }).then(r => r.json());
      this.chatSessionId = id;
      this.chatMessages  = [];
      this.chatStatus    = '';
      await this.loadChatSessions(this.currentPage.id);
    } catch (e) {
      console.error('[startNewChatSession]', e);
    }
  },

  async loadChatSessions(pageId) {
    try {
      this.chatSessions = await fetch('/chat/sessions/' + pageId).then(r => r.json());
    } catch (e) {
      console.error('[loadChatSessions]', e);
    }
  },

  async loadChatSession(sessionId) {
    try {
      const data = await fetch('/chat/session/' + sessionId).then(r => r.json());
      this.chatSessionId = data.id;
      this.chatMessages  = data.messages || [];
      this.chatStatus    = '';
      this.$nextTick(() => this._scrollChatToBottom());

      // Reconnect: prüfen ob ein Chat-Job für diese Session noch läuft
      if (!this._chatPollTimer && !this.chatLoading) {
        try {
          const { jobId } = await fetch(`/jobs/active?type=chat&book_id=${sessionId}`).then(r => r.json());
          if (jobId) {
            this.chatLoading = true;
            this.startChatPoll(jobId);
          }
        } catch (e) {
          console.error('[loadChatSession] active-job check:', e);
        }
      }
    } catch (e) {
      console.error('[loadChatSession]', e);
    }
  },

  async deleteChatSession(id) {
    try {
      await fetch('/chat/session/' + id, { method: 'DELETE' });
      this.chatSessions = this.chatSessions.filter(s => s.id !== id);
      if (this.chatSessionId === id) {
        this.chatSessionId = null;
        this.chatMessages  = [];
        // Nächste verfügbare Session laden oder neue starten
        if (this.chatSessions.length > 0) {
          await this.loadChatSession(this.chatSessions[0].id);
        } else {
          await this.startNewChatSession();
        }
      }
    } catch (e) {
      console.error('[deleteChatSession]', e);
    }
  },

  // ── Nachricht senden (Job-Queue) ────────────────────────────────────────────

  async sendChatMessage() {
    const msg = (this.chatInput || '').trim();
    if (!msg || this.chatLoading || !this.chatSessionId) return;

    this.chatInput   = '';
    this.chatLoading = true;
    this.chatStatus  = '';

    // User-Nachricht sofort anzeigen (optimistisch)
    this.chatMessages.push({ role: 'user', content: msg, id: null });
    this.$nextTick(() => this._scrollChatToBottom());

    // originalHtml vorladen falls noch nicht gesetzt (wird für Vorschläge-Anwenden benötigt)
    if (!this.originalHtml) {
      try {
        const pageData = await this.bsGet('pages/' + this.currentPage.id);
        this.originalHtml = pageData.html || '';
      } catch (e) {
        console.warn('[sendChatMessage] Seiteninhalt konnte nicht geladen werden:', e.message);
      }
    }

    try {
      const { jobId } = await fetch('/jobs/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: this.chatSessionId, message: msg }),
      }).then(r => r.json());

      localStorage.setItem('lektorat_chat_job_' + this.chatSessionId, jobId);
      this.startChatPoll(jobId);
    } catch (e) {
      console.error('[sendChatMessage]', e);
      // Optimistisch hinzugefügte User-Nachricht entfernen
      this.chatMessages = this.chatMessages.slice(0, -1);
      this.chatStatus  = `<span class="error-msg">Fehler: ${escHtml(e.message)}</span>`;
      this.chatLoading = false;
      this.$nextTick(() => this._scrollChatToBottom());
    }
  },

  // Pollt einen laufenden Chat-Job und aktualisiert den UI-State.
  // Wird beim frischen Start und beim Reconnect nach Tab-Schliessen aufgerufen.
  startChatPoll(jobId) {
    const sessionId = this.chatSessionId;
    this._startPoll({
      timerProp: '_chatPollTimer',
      jobId,
      lsKey: 'lektorat_chat_job_' + sessionId,
      onProgress: (job) => {
        const tokIn  = job.tokensIn  || 0;
        const tokOut = job.tokensOut || 0;
        this.chatStatus = tokIn + tokOut > 0
          ? `<span class="muted-msg">↑${fmtTok(tokIn)} ↓${fmtTok(tokOut)} Tokens</span>`
          : '';
      },
      onNotFound: async () => {
        this.chatLoading = false;
        this.chatStatus  = '';
        await this.loadChatSession(sessionId);
      },
      onError: (job) => {
        this.chatLoading = false;
        this.chatStatus = `<span class="error-msg">Fehler: ${escHtml(job.error || 'Unbekannter Fehler')}</span>`;
      },
      onDone: async () => {
        this.chatLoading = false;
        this.chatStatus  = '';
        await this.loadChatSession(sessionId);
        if (this.currentPage) await this.loadChatSessions(this.currentPage.id);
      },
    });
  },

  // ── Vorschlag übernehmen ────────────────────────────────────────────────────

  async applyChatVorschlag(vorschlag, msgIdx, vIdx) {
    if (!this.currentPage) {
      this.chatStatus = '<span class="error-msg">Seiteninhalt nicht geladen – bitte Seite neu auswählen.</span>';
      return;
    }

    // originalHtml nachladen falls nicht vorhanden (z.B. nach Seitenwechsel)
    if (!this.originalHtml) {
      try {
        const pageData = await this.bsGet('pages/' + this.currentPage.id);
        this.originalHtml = pageData.html || '';
      } catch (e) {
        this.chatStatus = '<span class="error-msg">Seiteninhalt konnte nicht geladen werden.</span>';
        return;
      }
    }

    // Direkte String-Ersetzung (zeichengenau, wie _applyCorrections)
    const idx = this.originalHtml.indexOf(vorschlag.original);
    if (idx === -1) {
      this.chatStatus = `<span class="error-msg">Originaltext «${escHtml(vorschlag.original.slice(0, 40))}…» nicht mehr in der Seite gefunden.</span>`;
      return;
    }

    const newHtml = this.originalHtml.slice(0, idx) + vorschlag.ersatz + this.originalHtml.slice(idx + vorschlag.original.length);

    try {
      await this.bsPut('pages/' + this.currentPage.id, { html: newHtml });
      this.originalHtml = newHtml; // lokal aktualisieren für weitere Vorschläge
      // Vorschlag als übernommen markieren
      this.chatMessages[msgIdx].vorschlaege[vIdx]._applied = true;
      this.chatStatus = '<span class="success-msg">Änderung in BookStack gespeichert.</span>';
      setTimeout(() => { if (this.chatStatus.includes('gespeichert')) this.chatStatus = ''; }, 3000);
    } catch (e) {
      console.error('[applyChatVorschlag]', e);
      this.chatStatus = `<span class="error-msg">Fehler beim Speichern: ${escHtml(e.message)}</span>`;
    }
  },

  // ── Hilfsmethoden ───────────────────────────────────────────────────────────

  /** Scrollt den Chat-Container ans Ende. */
  _scrollChatToBottom() {
    const el = document.getElementById('chat-messages');
    if (el) el.scrollTop = el.scrollHeight;
  },

  _renderChatMarkdown(text) { return renderChatMarkdown(text); },

  /** Formatiert Token-Info für eine Assistant-Nachricht. */
  _chatTokenInfo(msg) {
    if (!msg.tokens_in && !msg.tokens_out) return '';
    return `↑${fmtTok(msg.tokens_in || 0)} ↓${fmtTok(msg.tokens_out || 0)}`;
  },

  /** Wird beim Seitenwechsel (selectPage / resetPage) aufgerufen. */
  resetChat() {
    if (this._chatPollTimer) { clearInterval(this._chatPollTimer); this._chatPollTimer = null; }
    this.showChatCard  = false;
    this.chatSessions  = [];
    this.chatMessages  = [];
    this.chatSessionId = null;
    this.chatInput     = '';
    this.chatLoading   = false;
    this.chatStatus    = '';
  },
};
