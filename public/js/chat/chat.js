import { escHtml, findInHtml, countInHtml, replaceInHtml, skipReason, clearStatusAfter } from '../utils.js';
import { makeChatMethods } from './chat-base.js';
import { contentRepo } from '../repo/content.js';

// Seiten-Chat-Methoden (werden in Alpine.data('chatCard') gespreadet).
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
  canOpen: (ctx) => !!ctx.$app.currentPage,
  sessionsUrl: (ctx) => '/chat/sessions/' + ctx.$app.currentPage.id,
  newSessionUrl: '/chat/session',
  newSessionBody: (ctx) => ({
    book_id:   parseInt(Alpine.store('nav').selectedBookId),
    book_name: ctx.$app.selectedBookName,
    page_id:   ctx.$app.currentPage.id,
    page_name: ctx.$app.currentPage.name,
  }),
  sendUrl: '/jobs/chat',
  lsKeyFn: (sessionId) => 'lektorat_chat_job_' + sessionId,
  onPollProgress: function (job) {
    this.chatStatus = this._runningJobStatus(job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut, job.progress, job.tokensPerSec, job.statusParams, job.cacheReadIn);
  },
  onBeforeSend: async function () {
    const root = window.__app;
    // Ungespeicherte Editor-Änderungen flushen, sonst sieht der Chat-Job den
    // alten BookStack-Stand (Autosave läuft nur alle 30s).
    if (root.editMode && root.editDirty && !root.editSaving) {
      try { await root.quickSave(); }
      catch (e) { console.warn('[sendChatMessage] quickSave fehlgeschlagen:', e.message); }
    }
    try {
      // `fresh: true`: nach quickSave oben muss der Read den neuen Stand sehen
      // (SW-CONTENT_CACHE ist sonst noch stale, falls Cache-Bust noch nicht durch ist).
      const pageData = await contentRepo.loadPage(root.currentPage.id, { fresh: true });
      root.originalHtml = pageData.html || '';
      this._chatPendingRefresh = false;
    } catch (e) {
      console.warn('[sendChatMessage] Seiteninhalt konnte nicht geladen werden:', e.message);
    }
  },
  onPollDone: async function () {
    if (window.__app.currentPage) await this.loadChatSessions();
    window.__app.updatePageView();
  },
  onSessionsChanged: function () {
    const root = window.__app;
    const pageId = root?.currentPage?.id;
    if (!pageId) return;
    root.currentPageChatSessionCount = (this.chatSessions || []).length;
  },
  onAfterSessionLoad: function () {
    for (const m of this.chatMessages) {
      if (Array.isArray(m.vorschlaege)) {
        for (const v of m.vorschlaege) if (v.applied) v._applied = true;
      }
    }
    window.__app.updatePageView();
  },
  onReset: function () {
    window.__app.updatePageView();
  },
});

export const chatMethods = {
  ...baseMethods,

  // ── Seiten-Chat-spezifisch: Vorschlag übernehmen ──────────────────────────

  async applyChatVorschlag(vorschlag, msgIdx, vIdx) {
    const root = window.__app;
    const v = () => this.chatMessages[msgIdx].vorschlaege[vIdx];
    const setErr = (msg) => { v()._error = msg; };

    if (!root.currentPage) {
      setErr(root.t('chat.pageNotLoaded'));
      return;
    }

    // User kann zwischen den awaits unten zur nächsten Seite wechseln; ohne
    // Snapshot würde der Vorschlag dann auf der falschen Seite landen
    // (= stiller Datenverlust auf der ursprünglichen Seite).
    const pageIdAtStart = root.currentPage.id;
    const samePage = () => root.currentPage?.id === pageIdAtStart;

    // Vorab prüfen ob der Originaltext noch existiert – sonst meldet _loadApplyAndSave
    // nur einen No-Op, was sich fälschlich wie ein Erfolg anfühlt.
    // Tolerant suchen: die KI sieht die Seite als Plaintext, im HTML stecken aber
    // Tags und Entities (z.B. `das <em>magische</em> Wort` vs Plaintext
    // `das magische Wort`). Ohne Tolerant-Match würde die Mehrheit realistischer
    // KI-Vorschläge fälschlich abgelehnt.
    try {
      // `fresh: true`: Stale-Check vor dem Apply muss den aktuellen Server-Stand
      // sehen — sonst kann der gleich folgende _loadApplyAndSave-PUT Edits
      // überschreiben, die zwischen letztem GET und jetzt geschrieben wurden.
      const page = await contentRepo.loadPage(pageIdAtStart, { fresh: true });
      if (!samePage()) return;
      const occurrences = countInHtml(page.html, vorschlag.original);
      if (occurrences === 0) {
        setErr(root.t('chat.originalNotFound'));
        return;
      }
      // Mehrdeutig: findInHtml/replaceInHtml greifen immer das erste Vorkommen —
      // bei mehrfachem Text würde also evtl. die falsche Stelle ersetzt. Lieber
      // abbrechen als still-falsch ersetzen.
      if (occurrences > 1) {
        setErr(root.t('chat.originalAmbiguous'));
        return;
      }
      // Block-Grenzen-/Link-/Marker-Vorschlag: countInHtml findet ihn zwar
      // (Tag-agnostische Text-View), aber replaceInHtml lässt ihn zum Schutz der
      // Absatzstruktur, des Hyperlinks bzw. des Quellen-/Verweis-Zeigers
      // unangetastet. Ohne Abfang wäre das ein stiller No-Op, der sich unten
      // fälschlich wie „gespeichert" anfühlt (_applied + Erfolgsmeldung).
      // Grund über `skipReason` statt eigener Fallunterscheidung — derselbe
      // Entscheidungsbaum wie im Lektorat-Apply, nur andere Meldungs-Keys.
      if (replaceInHtml(page.html, vorschlag.original, vorschlag.ersatz) === page.html) {
        setErr(root.t({
          spansLink: 'chat.spansLink',
          spansMarker: 'chat.spansMarker',
        }[skipReason(page.html, vorschlag.original)] || 'chat.crossesBlockBoundary'));
        return;
      }
    } catch (e) {
      console.error('[chat applyVorschlag pageLoad]', e);
      if (samePage()) setErr(root.t('chat.pageLoadFailed'));
      return;
    }

    if (!samePage()) return;
    v()._applying = true;
    v()._error = null;
    try {
      // Gleiche Pipeline wie beim Lektorat: laden → anwenden → Safety-Check → speichern.
      // onProgress setzt saveApplying (→ Editor-Progressbar) und chatStatus.
      const { finalHtml } = await root._loadApplyAndSave(
        [{ original: vorschlag.original, korrektur: vorschlag.ersatz }],
        (pct, text) => {
          root.saveApplying = pct;
          if (text) this.chatStatus = `<span class="spinner"></span>${escHtml(text)}`;
        },
        'chat-apply',
      );
      if (!samePage()) return;
      root.originalHtml = finalHtml;
      this._chatPendingRefresh = true;
      v()._applied = true;
      root.updatePageView();
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
      const successMsg = `<span class="success-msg">${escHtml(root.t('chat.changeSaved'))}</span>`;
      this.chatStatus = successMsg;
      clearStatusAfter(this, 'chatStatus', successMsg, 3000);
    } catch (e) {
      console.error('[applyChatVorschlag]', e);
      setErr(root.t('chat.saveFailedPrefix') + e.message);
      this.chatStatus = '';
    } finally {
      v()._applying = false;
      root.saveApplying = null;
    }
  },
};
