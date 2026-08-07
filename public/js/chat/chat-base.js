// Gemeinsame Chat-Logik für Seiten-Chat und Buch-Chat Cards.
// makeChatMethods liefert ein Methoden-Objekt, das in eine Card gespreadet wird.
// `this` ist die Card; Root-Zugriffe laufen über window.__app. Der Root setzt
// die showXxxCard-Flag, die Card reagiert per $watch und ruft onVisible().

import { escHtml, fmtTok, renderChatMarkdown, fetchJson } from '../utils.js';
import { startPoll, runningJobStatus } from '../cards/job-helpers.js';

function _newClientMsgId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback für sehr alte Browser ohne crypto.randomUUID.
  return 'cm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export function makeChatMethods(cfg) {
  const p = cfg.props;
  const L = cfg.label; // 'Chat' oder 'BookChat'

  // ── Interne Helfer (Aufruf via .call(this)) ──────────────────────────────

  async function loadSessions() {
    try {
      this[p.sessions] = await fetchJson(cfg.sessionsUrl(this));
      if (cfg.onSessionsChanged) cfg.onSessionsChanged.call(this);
    } catch (e) {
      console.error(`[load${L}Sessions]`, e);
    }
  }

  async function loadSession(sessionId) {
    try {
      // Session-Payload und Active-Job-Check parallel — beide Reads idempotent,
      // sequentielle awaits verdoppelten sonst Latenz beim History-Klick.
      const wantActiveCheck = !this[p.pollTimer] && !this[p.loading];
      const [data, active] = await Promise.all([
        fetchJson('/chat/session/' + sessionId),
        wantActiveCheck
          ? fetchJson(`/jobs/active?type=${cfg.activeJobType}&book_id=${sessionId}`)
              .catch((e) => { console.error(`[load${L}Session] active-job check:`, e); return null; })
          : Promise.resolve(null),
      ]);
      this[p.sessionId] = data.id;
      this[p.messages] = data.messages || [];
      this[p.status] = '';
      if (cfg.onAfterSessionLoad) cfg.onAfterSessionLoad.call(this);
      this.$nextTick(() => scrollToBottom.call(this));

      if (active && active.jobId) {
        this[p.loading] = true;
        startPollLocal.call(this, active.jobId);
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
    const root = window.__app;
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
              // tokIn ist bei Ollama/Llama erst am Streaming-Ende bekannt (aus
              // usage) — vorher nur tokOut zeigen statt falscher Schätzwerte.
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
      onError: async (job) => {
        // Belt-and-suspenders: startPoll clear't Timer eigentlich vor dem
        // Callback. Doppelt clearen schützt vor stuck `loading=true`-States,
        // bei denen weder „Neue Session" noch Senden möglich wäre.
        if (this[p.pollTimer]) { clearInterval(this[p.pollTimer]); this[p.pollTimer] = null; }
        this[p.loading] = false;
        if (p.progress) this[p.progress] = 0;
        if (p.pendingRefresh) this[p.pendingRefresh] = false;
        const errLabel = job.error ? root.t(job.error, job.errorParams) : root.t('common.unknownError');
        const errHtml = `<span class="error-msg">${root.t('common.errorColon')}${escHtml(errLabel)}</span>`;
        // Server-State neu laden: User-Msg ist serverseitig persistiert
        // (_handleChatPost), Assistant-Msg fehlt. Optimistischer Stub wird durch
        // Server-Stand ersetzt; danach kann der User eine neue Session starten
        // oder eine neue Nachricht senden. loadSession setzt intern status='',
        // Fehler-HTML deshalb DANACH setzen.
        try { await loadSession.call(this, sessionId); }
        catch (e) { console.error(`[${L} onError reload]`, e); }
        this[p.status] = errHtml;
      },
      onDone: async (job) => {
        this[p.loading] = false;
        if (p.progress) this[p.progress] = 0;
        this[p.status] = '';
        await loadSession.call(this, sessionId);
        if (cfg.onPollDone) await cfg.onPollDone.call(this);
        // KI-Titel wird nur auf der ersten Runde generiert und kommt im Job-Result
        // zurück. In die (ggf. optimistisch aufgebaute) Sessions-Liste übernehmen,
        // damit der History-Eintrag sofort den Titel statt der Vorschau zeigt.
        const newTitle = job?.result?.sessionTitle;
        if (newTitle && Array.isArray(this[p.sessions])) {
          const row = this[p.sessions].find(s => s.id === sessionId);
          if (row) row.title = newTitle;
        }
      },
    });
  }

  function scrollToBottom() {
    const el = document.getElementById(cfg.scrollElId);
    if (el) el.scrollTop = el.scrollHeight;
  }

  // Wird beim $watch(showXxxCard) aufgerufen, wenn die Karte geöffnet wird.
  async function onVisible() {
    if (!cfg.canOpen(this)) return;
    const root = window.__app;
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
      if (cfg.onSessionsChanged) cfg.onSessionsChanged.call(this);
      if (this[p.sessionId] === id) {
        // Laufenden Polling-Timer der gelöschten Session abbrechen, sonst
        // pollt er weiter mit der nun toten sessionId/jobId.
        if (this[p.pollTimer]) { clearInterval(this[p.pollTimer]); this[p.pollTimer] = null; }
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
    const root = window.__app;
    if (this[p.loading] || !this[p.sessionId]) return;
    const msg = (this[p.input] || '').trim();
    if (!msg) return;

    // Idempotency-Key: UUID pro logischem Send. Bei Retry mit identischem Text
    // wird die UUID des fehlgeschlagenen Versuchs wiederverwendet, damit der
    // Server (chat.js _handleChatPost) Doppel-Inserts dedupen kann.
    const lastMsg = this[p.messages][this[p.messages].length - 1];
    const isRetry = !!(lastMsg && lastMsg.role === 'user' && lastMsg.sendError && lastMsg.content === msg && lastMsg.clientMsgId);
    const clientMsgId = isRetry ? lastMsg.clientMsgId : _newClientMsgId();

    this[p.input] = '';
    this[p.loading] = true;
    this[p.status] = '';
    if (isRetry) {
      lastMsg.sendError = false;
    } else {
      this[p.messages].push({ role: 'user', content: msg, id: null, clientMsgId, sendError: false });
    }
    this.$nextTick(() => scrollToBottom.call(this));
    if (cfg.onBeforeSend) await cfg.onBeforeSend.call(this);
    try {
      const { jobId } = await fetchJson(cfg.sendUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: this[p.sessionId], message: msg, client_msg_id: clientMsgId }),
      });
      if (cfg.lsKeyFn && jobId) localStorage.setItem(cfg.lsKeyFn(this[p.sessionId]), jobId);
      if (jobId) startPollLocal.call(this, jobId);
      else { this[p.loading] = false; this.$nextTick(() => scrollToBottom.call(this)); }
    } catch (e) {
      console.error(`[send${L}Message]`, e);
      // Optimistische Msg behalten + sendError markieren + Input restaurieren,
      // damit User mit selber UUID erneut senden kann (Server dedupt dann).
      const tail = this[p.messages][this[p.messages].length - 1];
      if (tail && tail.clientMsgId === clientMsgId) tail.sendError = true;
      this[p.input] = msg;
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
    return renderChatMarkdown(match ? window.__app.t(match[1]) : text);
  };

  // `tokens_in` ist cache-INKLUSIV (input + cache_read + cache_creation, siehe
  // lib/ai/claude.js) und im agentischen Pfad zusätzlich über alle Tool-Iterationen
  // aufsummiert. Ohne den Cache-Anteil liest sich die Zahl wie voll bezahlter Input,
  // obwohl der gelesene Cache nur ein Zehntel des Tarifs kostet — darum die Quote
  // sichtbar am Badge, die vollständige Aufschlüsselung im title.
  m._chatTokenInfo = function (msg) {
    if (!msg.tokens_in && !msg.tokens_out) return '';
    const tokIn = msg.tokens_in || 0;
    const cached = msg.cache_read_in || 0;
    const tpsPart = msg.tps ? ` · ${Math.round(msg.tps)} tok/s` : '';
    const cachePart = (tokIn > 0 && cached > 0)
      ? ` · ${window.__app.t('chat.tokenCacheShare', { pct: Math.round((cached / tokIn) * 100) })}`
      : '';
    return `↑${fmtTok(tokIn)} ↓${fmtTok(msg.tokens_out || 0)}${cachePart}${tpsPart}`;
  };

  // Vollständige Input-Aufschlüsselung als title (Hover) — die drei Posten haben
  // drei verschiedene Tarife (frisch 1x, Cache-Schreiben 1.25x, Cache-Lesen 0.1x).
  m._chatTokenTitle = function (msg) {
    const tokIn = msg.tokens_in || 0;
    if (!tokIn) return '';
    const cached  = msg.cache_read_in || 0;
    const written = msg.cache_creation_in || 0;
    const fresh   = Math.max(0, tokIn - cached - written);
    if (!cached && !written) return '';
    const t = (k, p2) => window.__app.t(k, p2);
    return [
      t('chat.tokenBreakdownTotal',  { n: fmtTok(tokIn) }),
      t('chat.tokenBreakdownFresh',  { n: fmtTok(fresh) }),
      t('chat.tokenBreakdownWrite',  { n: fmtTok(written) }),
      t('chat.tokenBreakdownRead',   { n: fmtTok(cached) }),
    ].join(' · ');
  };

  // Status-HTML für laufende Jobs — wird von onPollProgress-Callbacks der
  // konkreten Chats genutzt (sie rufen this._runningJobStatus).
  // cacheReadIn (optional): Cache-Anteil der bisher gezählten Input-Tokens; im
  // agentischen Tool-Loop wächst tokensIn pro Iteration um den ganzen Präfix.
  m._runningJobStatus = function (statusText, tokIn, tokOut, maxTokOut, progress, tokPerSec, statusParams, cacheReadIn) {
    return runningJobStatus(
      (k, p2) => window.__app.t(k, p2),
      statusText, tokIn, tokOut, maxTokOut, progress, tokPerSec, statusParams, cacheReadIn,
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
