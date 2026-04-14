import { escHtml, fmtTok } from './utils.js';
import { makeChatMethods } from './chat-base.js';

// Seiten-Chat-Methoden (werden in die Alpine-Komponente gespreadet).
// Gemeinsame Logik kommt aus chat-base.js; hier nur Seiten-Chat-Spezifika.

const baseMethods = makeChatMethods({
  label: 'Chat',
  props: {
    show: 'showChatCard',
    sessions: 'chatSessions',
    messages: 'chatMessages',
    sessionId: 'chatSessionId',
    input: 'chatInput',
    loading: 'chatLoading',
    status: 'chatStatus',
    progress: 'chatProgress',
    pollTimer: '_chatPollTimer',
    pendingRefresh: '_chatPendingRefresh',
  },
  scrollElId: 'chat-messages',
  activeJobType: 'chat',
  canOpen: (ctx) => !!ctx.currentPage,
  sessionsUrl: (ctx) => '/chat/sessions/' + ctx.currentPage.id,
  newSessionUrl: '/chat/session',
  newSessionBody: (ctx) => ({
    book_id:   parseInt(ctx.selectedBookId),
    book_name: ctx.selectedBookName,
    page_id:   ctx.currentPage.id,
    page_name: ctx.currentPage.name,
  }),
  sendUrl: '/jobs/chat',
  lsKeyFn: (sessionId) => 'lektorat_chat_job_' + sessionId,
  onPollProgress: function (job) {
    this.chatStatus = this._runningJobStatus(job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut, job.progress, job.tokensPerSec);
  },
  onBeforeSend: async function () {
    try {
      const pageData = await this.bsGet('pages/' + this.currentPage.id);
      this.originalHtml = pageData.html || '';
      this._chatPendingRefresh = false;
    } catch (e) {
      console.warn('[sendChatMessage] Seiteninhalt konnte nicht geladen werden:', e.message);
    }
  },
  onPollDone: async function () {
    if (this.currentPage) await this.loadChatSessions();
  },
});

export const chatMethods = {
  ...baseMethods,

  // ── Seiten-Chat-spezifisch: Vorschlag übernehmen ──────────────────────────

  async applyChatVorschlag(vorschlag, msgIdx, vIdx) {
    const setErr = (msg) => { this.chatMessages[msgIdx].vorschlaege[vIdx]._error = msg; };

    if (!this.currentPage) {
      setErr('Seiteninhalt nicht geladen – bitte Seite neu auswählen.');
      return;
    }

    try {
      const pageData = await this.bsGet('pages/' + this.currentPage.id);
      this.originalHtml = pageData.html || '';
    } catch (e) {
      setErr('Seiteninhalt konnte nicht geladen werden.');
      return;
    }

    const idx = this.originalHtml.indexOf(vorschlag.original);
    if (idx === -1) {
      setErr('Originaltext nicht mehr in der Seite gefunden.');
      return;
    }

    const newHtml = this.originalHtml.slice(0, idx) + vorschlag.ersatz + this.originalHtml.slice(idx + vorschlag.original.length);

    try {
      await this.bsPut('pages/' + this.currentPage.id, { html: newHtml });
      this.originalHtml = newHtml;
      this._chatPendingRefresh = true;
      this.chatMessages[msgIdx].vorschlaege[vIdx]._applied = true;
      this.chatMessages[msgIdx].vorschlaege[vIdx]._error = null;
      this.chatStatus = '<span class="success-msg">Änderung in BookStack gespeichert.</span>';
      setTimeout(() => { if (this.chatStatus.includes('gespeichert')) this.chatStatus = ''; }, 3000);
    } catch (e) {
      console.error('[applyChatVorschlag]', e);
      setErr('Fehler beim Speichern: ' + e.message);
    }
  },

  _chatTokenInfo(msg) {
    if (!msg.tokens_in && !msg.tokens_out) return '';
    const tpsPart = msg.tps ? ` · ${Math.round(msg.tps)} tok/s` : '';
    return `↑${fmtTok(msg.tokens_in || 0)} ↓${fmtTok(msg.tokens_out || 0)}${tpsPart}`;
  },
};
