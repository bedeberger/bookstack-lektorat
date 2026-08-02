import { makeChatMethods } from './chat-base.js';
import { fetchJson, escHtml, renderChatMarkdown } from '../utils.js';
import {
  renderResearchAnswer as _renderResearchAnswerText,
  citedSources as _citedSources,
  parseCiteDocNums as _parseCiteDocNums,
  resolveSource as _resolveSource,
} from './research-chat-render.js';

// Recherche-Chat-Methoden (gespreadet in die rechercheCard). Agentischer Chat
// NEBEN dem Wissensboard: recherchiert im Netz + im vorhandenen Material und
// schlägt Fundstücke als neue Recherche-Items vor (User bestätigt). Claude-only.

export const researchChatMethods = {
  // Panel auf-/zuklappen. Beim ersten Öffnen Sessions laden (onVisible-Pfad).
  async toggleResearchChat() {
    this.researchChatOpen = !this.researchChatOpen;
    if (this.researchChatOpen) {
      await this._onVisibleResearchChat();
      this.$nextTick(() => {
        const ta = this.$root?.querySelector('.research-chat-input');
        if (ta) ta.focus();
      });
    }
  },

  // Tool-Call-Zusammenfassung eines Agent-Turns (nach Name gruppiert).
  _researchToolSummary(toolCalls) {
    if (!Array.isArray(toolCalls) || !toolCalls.length) return [];
    const byName = new Map();
    for (const tc of toolCalls) {
      if (tc.name === 'final_answer') continue;
      const e = byName.get(tc.name) || { name: tc.name, count: 0, errors: 0 };
      e.count++;
      if (tc.ok === false) e.errors++;
      byName.set(tc.name, e);
    }
    return Array.from(byName.values());
  },

  // Vorschläge einer Assistant-Nachricht (aus context_info.proposals).
  researchProposals(msg) {
    return (msg?.context_info?.proposals) || [];
  },

  // Web-Such-Trefferdokumente (1-basiert, Auftrittsreihenfolge) aus dem Backend.
  researchSources(msg) {
    return (msg?.context_info?.sources) || [];
  },

  // Dokument-Indizes aus `index="4-4,4-5"` (Delegation an pure Helper).
  _parseCiteDocNums(idxStr) { return _parseCiteDocNums(idxStr); },
  _resolveSource(sources, n) { return _resolveSource(sources, n); },

  // Assistant-Antwort rendern. Delegiert an die pure Funktion (Unit-testbar);
  // die Alpine-Methode bleibt Bindung-Ziel der Templates (Live-Export erhalten).
  _renderResearchAnswer(msg) {
    const app = window.__app;
    return _renderResearchAnswerText({
      text: msg?.content || '',
      sources: this.researchSources(msg),
      renderChatMarkdown,
      escHtml,
      t: (k) => app?.t?.(k) ?? k,
    });
  },

  // Distinkte, in der Antwort tatsächlich zitierte Quellen — für die Quellenliste
  // unter der Antwort. Pure Helper genutzt, das schliesst Drift zwischen Render
  // und Digest aus (vorher zwei handgeschriebene Loops über denselben Regex).
  researchCitedSources(msg) {
    return _citedSources(msg?.content || '', this.researchSources(msg));
  },

  // Stabiler Schlüssel für den Speicher-Status eines Vorschlags (pro Session,
  // Nachricht und Vorschlags-Index). Trägt den UI-Status auf Card-Ebene statt auf
  // dem x-for-Item-Proxy — siehe `_proposalSaved`/`_proposalSaving` in recherche-card.js.
  _proposalKey(msgIdx, pi) { return `${this.researchChatSessionId}:${msgIdx}:${pi}`; },
  isProposalSaved(msgIdx, pi) { return !!this._proposalSaved[this._proposalKey(msgIdx, pi)]; },
  isProposalSaving(msgIdx, pi) { return !!this._proposalSaving[this._proposalKey(msgIdx, pi)]; },

  // Einen vom Chat vorgeschlagenen Eintrag tatsächlich ins Board speichern.
  // Persistiert erst HIER (POST /research) — der Chat hat nur vorgeschlagen.
  async saveResearchProposal(msgIdx, pi, proposal) {
    const app = window.__app;
    const bookId = Alpine.store('nav').selectedBookId;
    const key = this._proposalKey(msgIdx, pi);
    if (!bookId || !proposal || this._proposalSaved[key] || this._proposalSaving[key]) return;
    this._proposalSaving = { ...this._proposalSaving, [key]: true };
    try {
      await fetchJson('/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          book_id: bookId,
          kind: proposal.kind || 'note',
          title: proposal.title || '',
          body: proposal.body || '',
          urls: Array.isArray(proposal.urls) ? proposal.urls : [],
          source: proposal.source || '',
          tags: Array.isArray(proposal.tags) ? proposal.tags : [],
        }),
      });
      // Board aus Server-Wahrheit neu laden (respektiert aktive Filter/Sortierung
      // + frischt den Tag-Pool mit) statt das Item blind oben einzufügen.
      await this.loadRecherche();
      this._proposalSaved = { ...this._proposalSaved, [key]: true };
    } catch (e) {
      this.errorMessage = app.t('recherche.chat.saveError');
    } finally {
      const next = { ...this._proposalSaving };
      delete next[key];
      this._proposalSaving = next;
    }
  },

  ...makeChatMethods({
    label: 'ResearchChat',
    props: {
      show: 'researchChatOpen',
      sessions: 'researchChatSessions',
      messages: 'researchChatMessages',
      sessionId: 'researchChatSessionId',
      input: 'researchChatInput',
      loading: 'researchChatLoading',
      status: 'researchChatStatus',
      progress: 'researchChatProgress',
      pollTimer: '_researchChatPollTimer',
    },
    scrollElId: 'research-chat-messages',
    activeJobType: 'research-chat',
    canOpen: (ctx) => !!Alpine.store('nav').selectedBookId && !!ctx.$store.config.researchChatEnabled,
    sessionsUrl: (ctx) => '/chat/sessions/research/' + Alpine.store('nav').selectedBookId,
    newSessionUrl: '/chat/session/research',
    newSessionBody: (ctx) => ({
      book_id:   parseInt(Alpine.store('nav').selectedBookId),
      book_name: ctx.$app.selectedBookName,
    }),
    sendUrl: '/jobs/research-chat',
    onPollProgress: function (job) {
      this.researchChatStatus = this._runningJobStatus(job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut, job.progress, job.tokensPerSec, job.statusParams);
    },
    onPollDone: async function () {
      const sid = this.researchChatSessionId;
      const sessions = this.researchChatSessions || [];
      const idx = sessions.findIndex(s => s.id === sid);
      const nowIso = new Date().toISOString();
      if (idx >= 0) {
        const row = { ...sessions[idx], last_message_at: nowIso };
        const next = sessions.slice();
        next.splice(idx, 1);
        next.unshift(row);
        this.researchChatSessions = next;
      } else {
        const firstUserMsg = (this.researchChatMessages || []).find(m => m.role === 'user');
        const root = window.__app;
        this.researchChatSessions = [
          { id: sid, book_id: parseInt(Alpine.store('nav').selectedBookId), book_name: root.selectedBookName, created_at: nowIso, last_message_at: nowIso, preview: firstUserMsg ? firstUserMsg.content : '' },
          ...sessions,
        ];
      }
    },
  }),
};
