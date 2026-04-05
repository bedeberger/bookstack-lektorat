import { escHtml, htmlToText, fmtTok } from './utils.js';

// Chat-Methoden (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.
// Direkt-Streaming via fetch + ReadableStream – kein Job-Queue nötig.

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
    this.$nextTick(() => {
      document.getElementById('chat-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      this._scrollChatToBottom();
    });
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

  // ── Nachricht senden (Streaming) ────────────────────────────────────────────

  async sendChatMessage() {
    const msg = (this.chatInput || '').trim();
    if (!msg || this.chatLoading || !this.chatSessionId) return;

    this.chatInput   = '';
    this.chatLoading = true;
    this.chatStatus  = '';

    // User-Nachricht sofort anzeigen
    this.chatMessages.push({ role: 'user', content: msg, id: null });

    // Placeholder für Assistant-Antwort (progressiv befüllt)
    const placeholderIdx = this.chatMessages.length;
    this.chatMessages.push({ role: 'assistant', content: '', vorschlaege: [], id: null, streaming: true });

    this.$nextTick(() => this._scrollChatToBottom());

    // Seiteninhalt holen (frisch laden für aktuelle Version)
    let pageText = '';
    try {
      const pageData = await this.bsGet('pages/' + this.currentPage.id);
      pageText = htmlToText(pageData.html || '');
      // originalHtml für spätere Vorschlags-Übernahme sichern
      if (!this.originalHtml) this.originalHtml = pageData.html || '';
    } catch (e) {
      console.warn('[sendChatMessage] Seiteninhalt konnte nicht geladen werden:', e.message);
    }

    try {
      const resp = await fetch('/chat/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: this.chatSessionId,
          message:    msg,
          page_text:  pageText,
        }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${resp.status}`);
      }

      // SSE-Stream lesen
      const reader  = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let streamError = null; // Fehler aus Server-SSE-Event merken

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop(); // unvollständige letzte Zeile aufheben

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6);
          if (raw === '[DONE]') continue;

          let ev;
          try { ev = JSON.parse(raw); } catch { continue; } // JSON-Parse-Fehler ignorieren

          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
            this.chatMessages[placeholderIdx].content += ev.delta.text;
            this.$nextTick(() => this._scrollChatToBottom());
          }

          if (ev.type === 'error') {
            streamError = new Error(ev.error || 'KI-Fehler');
          }

          if (ev.type === 'meta') {
            this.chatMessages[placeholderIdx].id          = ev.assistant_message_id;
            this.chatMessages[placeholderIdx].vorschlaege = ev.vorschlaege || [];
            this.chatMessages[placeholderIdx].tokens_in   = ev.tokens_in;
            this.chatMessages[placeholderIdx].tokens_out  = ev.tokens_out;
            if (placeholderIdx > 0) {
              this.chatMessages[placeholderIdx - 1].id = ev.user_message_id;
            }
          }
        }
      }

      // Server-seitigen Fehler jetzt werfen (nach Stream-Ende)
      if (streamError) throw streamError;

      // JSON parsen: nur antwort-Text anzeigen, rohen JSON einklappen
      try {
        const clean = this.chatMessages[placeholderIdx].content.replace(/```json\s*|```/g, '').trim();
        const parsed = JSON.parse(clean);
        if (parsed.antwort !== undefined) {
          this.chatMessages[placeholderIdx].content = parsed.antwort;
        }
      } catch { /* Rohtext behalten wenn kein valides JSON */ }

      // Streaming-Marker entfernen → Rendering wechselt auf finalen Modus
      this.chatMessages[placeholderIdx].streaming = false;

      // Session-Liste aktualisieren (Preview + last_message_at)
      if (this.currentPage) await this.loadChatSessions(this.currentPage.id);

    } catch (e) {
      console.error('[sendChatMessage]', e);
      this.chatMessages[placeholderIdx].content  = '';
      this.chatMessages[placeholderIdx].streaming = false;
      this.chatStatus = `<span class="error-msg">Fehler: ${escHtml(e.message)}</span>`;
    } finally {
      this.chatLoading = false;
      this.$nextTick(() => this._scrollChatToBottom());
    }
  },

  // ── Vorschlag übernehmen ────────────────────────────────────────────────────

  async applyChatVorschlag(vorschlag, msgIdx, vIdx) {
    if (!this.currentPage || !this.originalHtml) {
      this.chatStatus = '<span class="error-msg">Seiteninhalt nicht geladen – bitte Seite neu auswählen.</span>';
      return;
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

  /**
   * Einfaches Markdown → HTML für Chat-Antworten.
   * Unterstützt: **fett**, *kursiv*, `code`, Zeilenumbrüche, Listen.
   */
  _renderChatMarkdown(text) {
    if (!text) return '';
    let html = escHtml(text);

    // Blockebene: Leerzeile → Absatz-Trenner
    html = html.replace(/\n\n+/g, '\n<br>\n');

    // Listen: Zeilen die mit «- » oder «* » beginnen
    html = html.replace(/^([-*]) (.+)$/gm, '<li>$2</li>');
    html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul class="chat-list">$&</ul>');

    // Inline: **fett**
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Inline: *kursiv*
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    // Inline: `code`
    html = html.replace(/`([^`]+)`/g, '<code class="chat-code">$1</code>');

    // Einfacher Zeilenumbruch → <br>
    html = html.replace(/\n/g, '<br>');

    return html;
  },

  /** Formatiert Token-Info für eine Assistant-Nachricht. */
  _chatTokenInfo(msg) {
    if (!msg.tokens_in && !msg.tokens_out) return '';
    return `↑${fmtTok(msg.tokens_in || 0)} ↓${fmtTok(msg.tokens_out || 0)}`;
  },

  /** Wird beim Seitenwechsel (selectPage / resetPage) aufgerufen. */
  resetChat() {
    this.showChatCard  = false;
    this.chatSessions  = [];
    this.chatMessages  = [];
    this.chatSessionId = null;
    this.chatInput     = '';
    this.chatLoading   = false;
    this.chatStatus    = '';
  },
};
