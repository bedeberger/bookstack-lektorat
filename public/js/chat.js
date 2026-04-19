import { escHtml, fmtTok, findInHtml, stripFocusArtefacts } from './utils.js';
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
    this.chatStatus = this._runningJobStatus(job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut, job.progress, job.tokensPerSec, job.statusParams);
  },
  onBeforeSend: async function () {
    try {
      const pageData = await this.bsGet('pages/' + this.currentPage.id);
      this.originalHtml = stripFocusArtefacts(pageData.html || '');
      this._chatPendingRefresh = false;
    } catch (e) {
      console.warn('[sendChatMessage] Seiteninhalt konnte nicht geladen werden:', e.message);
    }
  },
  onPollDone: async function () {
    if (this.currentPage) await this.loadChatSessions();
    this.updatePageView();
  },
  onAfterSessionLoad: function () {
    for (const m of this.chatMessages) {
      if (Array.isArray(m.vorschlaege)) {
        for (const v of m.vorschlaege) if (v.applied) v._applied = true;
      }
    }
    this.updatePageView();
  },
  onReset: function () {
    this.updatePageView();
  },
});

export const chatMethods = {
  ...baseMethods,

  // ── Seiten-Chat-spezifisch: Vorschlag übernehmen ──────────────────────────

  async applyChatVorschlag(vorschlag, msgIdx, vIdx) {
    const v = () => this.chatMessages[msgIdx].vorschlaege[vIdx];
    const setErr = (msg) => { v()._error = msg; };

    if (!this.currentPage) {
      setErr(this.t('chat.pageNotLoaded'));
      return;
    }

    // Vorab prüfen ob der Originaltext noch existiert – sonst meldet _loadApplyAndSave
    // nur einen No-Op, was sich fälschlich wie ein Erfolg anfühlt.
    // Tolerant suchen: die KI sieht die Seite als Plaintext, im HTML stecken aber
    // Tags und Entities (z.B. `das <em>magische</em> Wort` vs Plaintext
    // `das magische Wort`). Ohne Tolerant-Match würde die Mehrheit realistischer
    // KI-Vorschläge fälschlich abgelehnt.
    try {
      const page = await this.bsGet('pages/' + this.currentPage.id);
      if (!findInHtml(page.html, vorschlag.original)) {
        setErr(this.t('chat.originalNotFound'));
        return;
      }
    } catch {
      setErr(this.t('chat.pageLoadFailed'));
      return;
    }

    v()._applying = true;
    v()._error = null;
    try {
      // Gleiche Pipeline wie beim Lektorat: laden → anwenden → Safety-Check → speichern.
      // onProgress setzt saveApplying (→ Editor-Progressbar) und chatStatus.
      const finalHtml = await this._loadApplyAndSave(
        [{ original: vorschlag.original, korrektur: vorschlag.ersatz }],
        [],
        (pct, text) => {
          this.saveApplying = pct;
          if (text) this.chatStatus = `<span class="spinner"></span>${escHtml(text)}`;
        },
      );
      this.originalHtml = finalHtml;
      this._chatPendingRefresh = true;
      v()._applied = true;
      this.updatePageView();
      const msgId = this.chatMessages[msgIdx]?.id;
      if (msgId) {
        try {
          const r = await fetch(`/chat/message/${msgId}/vorschlag/${vIdx}/applied`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
          });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          v().applied = true;
        } catch (e) {
          console.warn('[applyChatVorschlag] Markierung nicht persistiert:', e.message);
        }
      }
      const successMsg = `<span class="success-msg">${escHtml(this.t('chat.changeSaved'))}</span>`;
      this.chatStatus = successMsg;
      setTimeout(() => { if (this.chatStatus === successMsg) this.chatStatus = ''; }, 3000);
    } catch (e) {
      console.error('[applyChatVorschlag]', e);
      setErr(this.t('chat.saveFailedPrefix') + e.message);
      this.chatStatus = '';
    } finally {
      v()._applying = false;
      this.saveApplying = null;
    }
  },

  _chatTokenInfo(msg) {
    if (!msg.tokens_in && !msg.tokens_out) return '';
    const tpsPart = msg.tps ? ` · ${Math.round(msg.tps)} tok/s` : '';
    return `↑${fmtTok(msg.tokens_in || 0)} ↓${fmtTok(msg.tokens_out || 0)}${tpsPart}`;
  },
};
