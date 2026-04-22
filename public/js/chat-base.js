// Gemeinsame Chat-Logik für Seiten-Chat und Buch-Chat Sub-Komponenten.
//
// Nach der Alpine.data-Migration liefert makeChatMethods ein Methoden-Objekt,
// das in eine Sub-Komponente gespreadet wird. `this` ist die Sub-Komponente;
// Zugriff auf Root-State (t, selectedBookId, selectedBookName, currentPage,
// bsGet, _loadApplyAndSave, updatePageView, saveApplying, originalHtml,
// lektoratFindings, checkDone, _checkDoneBeforeChat, _chatPendingRefresh)
// läuft über this.$root.
//
// Der `toggle`-Teil (open/close + _closeOtherMainCards) lebt nicht mehr hier:
// Root setzt die `showXxxCard`-Flag, die Sub-Komponente reagiert per $watch
// und führt onVisible() aus. Das Refresh-Pattern (erneuter Klick auf offene
// Karte) läuft über `card:refresh`-Events.

import { escHtml, fmtTok, renderChatMarkdown, fetchJson } from './utils.js';
import { startPoll, runningJobStatus } from './cards/job-helpers.js';

export function makeChatMethods(cfg) {
  const p = cfg.props;
  const L = cfg.label; // 'Chat' oder 'BookChat'

  // ── Interne Helfer (Aufruf via .call(this)) ──────────────────────────────

  async function loadSessions() {
    try {
      this[p.sessions] = await fetchJson(cfg.sessionsUrl(this));
    } catch (e) {
      console.error(`[load${L}Sessions]`, e);
    }
  }

  async function loadSession(sessionId) {
    try {
      const data = await fetchJson('/chat/session/' + sessionId);
      this[p.sessionId] = data.id;
      this[p.messages] = data.messages || [];
      this[p.status] = '';
      if (cfg.onAfterSessionLoad) cfg.onAfterSessionLoad.call(this);
      this.$nextTick(() => scrollToBottom.call(this));

      // Reconnect: prüfen ob ein Chat-Job für diese Session noch läuft
      if (!this[p.pollTimer] && !this[p.loading]) {
        try {
          const { jobId } = await fetchJson(`/jobs/active?type=${cfg.activeJobType}&book_id=${sessionId}`);
          if (jobId) {
            this[p.loading] = true;
            startPollLocal.call(this, jobId);
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
      const { id } = await fetchJson(cfg.newSessionUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg.newSessionBody(this)),
      });
      this[p.sessionId] = id;
      this[p.messages] = [];
      this[p.status] = '';
      await loadSessions.call(this);
    } catch (e) {
      console.error(`[startNew${L}Session]`, e);
    }
  }

  function startPollLocal(jobId) {
    const sessionId = this[p.sessionId];
    const root = this.$root;
    startPoll(this, {
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
              // tokIn ist bei Ollama/Llama erst am Streaming-Ende bekannt (aus usage);
              // vorher wird nur tokOut angezeigt, um falsche Schätzwerte zu vermeiden.
              const inPart = tokIn > 0 ? `↑${fmtTok(tokIn)} ` : '';
              this[p.status] = `<span class="muted-msg">${inPart}↓${fmtTok(tokOut)} Tokens${tpsPart}</span>`;
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
        this[p.status] = `<span class="error-msg">${root.t('common.errorColon')}${escHtml(job.error ? root.t(job.error, job.errorParams) : root.t('common.unknownError'))}</span>`;
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

  // Wrapper, den die Sub-Komponenten beim $watch(showXxxCard) aufrufen.
  // Ersetzt das frühere `toggleXxxCard` aus chat-base (öffnende Hälfte).
  async function onVisible() {
    if (!cfg.canOpen(this)) return;
    const root = this.$root;
    root._checkDoneBeforeChat = root.checkDone;
    root.checkDone = false;
    await loadSessions.call(this);
    if (this[p.sessions].length === 0) {
      await startNewSession.call(this);
    } else if (!this[p.sessionId]) {
      await loadSession.call(this, this[p.sessions][0].id);
    }
    this.$nextTick(() => scrollToBottom.call(this));
  }

  // ── Öffentliche Methoden ────────────────────────────────────────────────

  const m = {};

  m[`_onVisible${L}`] = async function () { return onVisible.call(this); };

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
    const root = this.$root;
    const msg = (this[p.input] || '').trim();
    if (!msg || this[p.loading] || !this[p.sessionId]) return;
    this[p.input] = '';
    this[p.loading] = true;
    this[p.status] = '';
    this[p.messages].push({ role: 'user', content: msg, id: null });
    this.$nextTick(() => scrollToBottom.call(this));
    if (cfg.onBeforeSend) await cfg.onBeforeSend.call(this);
    try {
      const { jobId } = await fetchJson(cfg.sendUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: this[p.sessionId], message: msg }),
      });
      if (cfg.lsKeyFn) localStorage.setItem(cfg.lsKeyFn(this[p.sessionId]), jobId);
      startPollLocal.call(this, jobId);
    } catch (e) {
      console.error(`[send${L}Message]`, e);
      this[p.messages] = this[p.messages].slice(0, -1);
      this[p.status] = `<span class="error-msg">${root.t('common.errorColon')}${escHtml(e.message)}</span>`;
      this[p.loading] = false;
      this.$nextTick(() => scrollToBottom.call(this));
    }
  };

  m[`start${L}Poll`]      = function (jobId) { return startPollLocal.call(this, jobId); };
  m[`_scroll${L}ToBottom`] = function () { scrollToBottom.call(this); };
  // Server-persistierte Fallback-Nachrichten werden als `__i18n:key__` gespeichert
  // und beim Rendern in die aktuelle Locale aufgelöst (siehe CLAUDE.md, i18n-Regel).
  m._renderChatMarkdown    = function (text) {
    const match = /^__i18n:([a-zA-Z0-9_.-]+)__$/.exec(text || '');
    return renderChatMarkdown(match ? this.$root.t(match[1]) : text);
  };

  // Status-HTML für laufende Jobs — wird von onPollProgress-Callbacks der
  // konkreten Chats genutzt (sie rufen this._runningJobStatus).
  m._runningJobStatus = function (statusText, tokIn, tokOut, maxTokOut, progress, tokPerSec, statusParams) {
    return runningJobStatus(
      (k, p2) => this.$root.t(k, p2),
      statusText, tokIn, tokOut, maxTokOut, progress, tokPerSec, statusParams,
    );
  };

  m[`reset${L}`] = function () {
    if (this[p.pollTimer]) { clearInterval(this[p.pollTimer]); this[p.pollTimer] = null; }
    this[p.sessions] = [];
    this[p.messages] = [];
    this[p.sessionId] = null;
    this[p.input] = '';
    this[p.loading] = false;
    if (p.progress) this[p.progress] = 0;
    this[p.status] = '';
    if (p.pendingRefresh) this[p.pendingRefresh] = false;
    if (cfg.onReset) cfg.onReset.call(this);
  };

  return m;
}
