// Gemeinsame Chat-Logik für Seiten-Chat und Buch-Chat.
// makeChatMethods() erzeugt ein Methoden-Objekt mit konfigurierbaren
// Property-Namen und Endpoints, das in die Alpine-Komponente gespreadet wird.

import { escHtml, fmtTok, renderChatMarkdown } from './utils.js';

export function makeChatMethods(cfg) {
  const p = cfg.props;
  const L = cfg.label; // 'Chat' oder 'BookChat'

  // ── Interne Helfer (Aufruf via .call(this)) ──────────────────────────────

  async function loadSessions() {
    try {
      this[p.sessions] = await fetch(cfg.sessionsUrl(this)).then(r => r.json());
    } catch (e) {
      console.error(`[load${L}Sessions]`, e);
    }
  }

  async function loadSession(sessionId) {
    try {
      const data = await fetch('/chat/session/' + sessionId).then(r => r.json());
      this[p.sessionId] = data.id;
      this[p.messages] = data.messages || [];
      this[p.status] = '';
      this.$nextTick(() => scrollToBottom.call(this));

      // Reconnect: prüfen ob ein Chat-Job für diese Session noch läuft
      if (!this[p.pollTimer] && !this[p.loading]) {
        try {
          const { jobId } = await fetch(`/jobs/active?type=${cfg.activeJobType}&book_id=${sessionId}`).then(r => r.json());
          if (jobId) {
            this[p.loading] = true;
            startPoll.call(this, jobId);
          }
        } catch (e) {
          console.error(`[load${L}Session] active-job check:`, e);
        }
      }
    } catch (e) {
      console.error(`[load${L}Session]`, e);
    }
  }

  async function startNewSession() {
    if (!cfg.canOpen(this)) return;
    try {
      if (cfg.onBeforeNewSession) await cfg.onBeforeNewSession.call(this);
      const { id } = await fetch(cfg.newSessionUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg.newSessionBody(this)),
      }).then(r => r.json());
      this[p.sessionId] = id;
      this[p.messages] = [];
      this[p.status] = '';
      await loadSessions.call(this);
    } catch (e) {
      console.error(`[startNew${L}Session]`, e);
    }
  }

  function startPoll(jobId) {
    const sessionId = this[p.sessionId];
    this._startPoll({
      timerProp: p.pollTimer,
      ...(p.progress ? { progressProp: p.progress } : {}),
      jobId,
      lsKey: cfg.lsKeyFn ? cfg.lsKeyFn(sessionId) : null,
      onProgress: cfg.onPollProgress
        ? (job) => cfg.onPollProgress.call(this, job)
        : (job) => {
            const tokIn = job.tokensIn || 0;
            const tokOut = job.tokensOut || 0;
            if (tokIn + tokOut > 0) {
              const tpsPart = job.tokensPerSec ? ` · ${Math.round(job.tokensPerSec)} tok/s` : '';
              this[p.status] = `<span class="muted-msg">↑${fmtTok(tokIn)} ↓${fmtTok(tokOut)} Tokens${tpsPart}</span>`;
            } else {
              this[p.status] = '';
            }
          },
      onNotFound: async () => {
        this[p.loading] = false;
        if (p.progress) this[p.progress] = 0;
        this[p.status] = '';
        await loadSession.call(this, sessionId);
      },
      onError: (job) => {
        this[p.loading] = false;
        if (p.progress) this[p.progress] = 0;
        this[p.status] = `<span class="error-msg">Fehler: ${escHtml(job.error || 'Unbekannter Fehler')}</span>`;
      },
      onDone: async () => {
        this[p.loading] = false;
        if (p.progress) this[p.progress] = 0;
        this[p.status] = '';
        await loadSession.call(this, sessionId);
        if (cfg.onPollDone) await cfg.onPollDone.call(this);
      },
    });
  }

  function scrollToBottom() {
    const el = document.getElementById(cfg.scrollElId);
    if (el) el.scrollTop = el.scrollHeight;
  }

  // ── Öffentliche Methoden (dynamische Namen via cfg.label) ─────────────────

  const m = {};

  m[`toggle${L}Card`] = async function () {
    if (this[p.show]) {
      if (cfg.onReopen) await cfg.onReopen.call(this);
      else this[p.show] = false;
      if (this._checkDoneBeforeChat && this.lektoratErrors?.length + this.lektoratStyles?.length > 0) {
        this.checkDone = true;
        this._checkDoneBeforeChat = false;
      }
      return;
    }
    if (!cfg.canOpen(this)) return;
    if (cfg.closeOtherCards) this._closeOtherMainCards(cfg.closeOtherCards);
    this._checkDoneBeforeChat = this.checkDone;
    this.checkDone = false;
    this[p.show] = true;
    await loadSessions.call(this);
    if (this[p.sessions].length === 0) {
      await startNewSession.call(this);
    } else if (!this[p.sessionId]) {
      await loadSession.call(this, this[p.sessions][0].id);
    }
    this.$nextTick(() => scrollToBottom.call(this));
  };

  m[`startNew${L}Session`] = function () { return startNewSession.call(this); };
  m[`load${L}Sessions`]    = function () { return loadSessions.call(this); };
  m[`load${L}Session`]     = function (id) { return loadSession.call(this, id); };

  m[`delete${L}Session`] = async function (id) {
    try {
      await fetch('/chat/session/' + id, { method: 'DELETE' });
      this[p.sessions] = this[p.sessions].filter(s => s.id !== id);
      if (this[p.sessionId] === id) {
        this[p.sessionId] = null;
        this[p.messages] = [];
        if (this[p.sessions].length > 0) {
          await loadSession.call(this, this[p.sessions][0].id);
        } else {
          await startNewSession.call(this);
        }
      }
    } catch (e) {
      console.error(`[delete${L}Session]`, e);
    }
  };

  m[`send${L}Message`] = async function () {
    const msg = (this[p.input] || '').trim();
    if (!msg || this[p.loading] || !this[p.sessionId]) return;
    this[p.input] = '';
    this[p.loading] = true;
    this[p.status] = '';
    this[p.messages].push({ role: 'user', content: msg, id: null });
    this.$nextTick(() => scrollToBottom.call(this));
    if (cfg.onBeforeSend) await cfg.onBeforeSend.call(this);
    try {
      const { jobId } = await fetch(cfg.sendUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: this[p.sessionId], message: msg }),
      }).then(r => r.json());
      if (cfg.lsKeyFn) localStorage.setItem(cfg.lsKeyFn(this[p.sessionId]), jobId);
      startPoll.call(this, jobId);
    } catch (e) {
      console.error(`[send${L}Message]`, e);
      this[p.messages] = this[p.messages].slice(0, -1);
      this[p.status] = `<span class="error-msg">Fehler: ${escHtml(e.message)}</span>`;
      this[p.loading] = false;
      this.$nextTick(() => scrollToBottom.call(this));
    }
  };

  m[`start${L}Poll`]      = function (jobId) { return startPoll.call(this, jobId); };
  m[`_scroll${L}ToBottom`] = function () { scrollToBottom.call(this); };
  m._renderChatMarkdown    = (text) => renderChatMarkdown(text);

  m[`reset${L}`] = function () {
    if (this[p.pollTimer]) { clearInterval(this[p.pollTimer]); this[p.pollTimer] = null; }
    this[p.show] = false;
    this[p.sessions] = [];
    this[p.messages] = [];
    this[p.sessionId] = null;
    this[p.input] = '';
    this[p.loading] = false;
    if (p.progress) this[p.progress] = 0;
    this[p.status] = '';
    if (p.pendingRefresh) this[p.pendingRefresh] = false;
  };

  return m;
}
