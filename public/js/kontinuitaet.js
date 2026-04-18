// Kontinuitätsprüfer-Methoden (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.

import { escHtml } from './utils.js';

export const kontinuitaetMethods = {
  async toggleKontinuitaetCard() {
    if (this.showKontinuitaetCard) { await this._loadKontinuitaetHistory(); return; }
    this._closeOtherMainCards('kontinuitaet');
    this.showKontinuitaetCard = true;
    if (!this.figuren?.length) await this.loadFiguren(this.selectedBookId);
    await this._loadKontinuitaetHistory();
    // Prüfen ob bereits ein Job läuft
    if (!this._kontinuitaetPollTimer && !this.kontinuitaetLoading) {
      try {
        const { jobId } = await fetch(`/jobs/active?type=kontinuitaet&book_id=${this.selectedBookId}`).then(r => r.json());
        if (jobId) {
          this.kontinuitaetLoading = true;
          this.kontinuitaetProgress = 0;
          this.kontinuitaetStatus = 'Prüfung läuft bereits…';
          this.startKontinuitaetPoll(jobId);
        }
      } catch (e) {
        console.error('[toggleKontinuitaetCard] active-job check:', e);
      }
    }
  },

  async _loadKontinuitaetHistory() {
    try {
      const data = await fetch('/jobs/kontinuitaet/' + this.selectedBookId).then(r => r.json());
      this.kontinuitaetResult = data;
    } catch (e) {
      console.error('[_loadKontinuitaetHistory]', e);
    }
  },

  startKontinuitaetPoll(jobId) {
    const bookId = this.selectedBookId;
    this._startPoll({
      timerProp: '_kontinuitaetPollTimer',
      jobId,
      lsKey: 'lektorat_kontinuitaet_job_' + bookId,
      progressProp: 'kontinuitaetProgress',
      onProgress: (job) => {
        this.kontinuitaetStatus = this._runningJobStatus(job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut, job.progress, job.tokensPerSec);
      },
      onNotFound: () => {
        this.kontinuitaetLoading = false;
        this.kontinuitaetProgress = 0;
        this.kontinuitaetStatus = 'Prüfung unterbrochen (Server-Neustart). Bitte neu starten.';
      },
      onError: (job) => {
        this.kontinuitaetLoading = false;
        this.kontinuitaetProgress = 0;
        this.kontinuitaetStatus = `<span class="error-msg">Fehler: ${escHtml(job.error)}</span>`;
      },
      onDone: async (job) => {
        this.kontinuitaetLoading = false;
        this.kontinuitaetProgress = 0;
        if (job.result?.empty) { this.kontinuitaetStatus = 'Keine Seiten gefunden.'; return; }
        await this._loadKontinuitaetHistory();
        const count = job.result?.count || 0;
        this.kontinuitaetStatus = count === 0
          ? 'Keine Kontinuitätsprobleme gefunden.'
          : `${count} Problem${count === 1 ? '' : 'e'} gefunden.`;
      },
    });
  },

  async runKontinuitaetCheck() {
    const bookId = this.selectedBookId;
    const bookName = this.selectedBookName;
    this.kontinuitaetLoading = true;
    this.kontinuitaetProgress = 0;
    this.kontinuitaetStatus = 'Starte Prüfung…';
    this.kontinuitaetResult = null;
    try {
      const { jobId } = await fetch('/jobs/kontinuitaet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: parseInt(bookId), book_name: bookName }),
      }).then(r => r.json());
      localStorage.setItem('lektorat_kontinuitaet_job_' + bookId, jobId);
      this.startKontinuitaetPoll(jobId);
    } catch (e) {
      console.error('[runKontinuitaetCheck]', e);
      this.kontinuitaetStatus = `<span class="error-msg">Fehler: ${escHtml(e.message)}</span>`;
      this.kontinuitaetLoading = false;
      this.kontinuitaetProgress = 0;
    }
  },

  kontinuitaetIssuesBySwere() {
    if (!this.kontinuitaetResult?.issues) return { kritisch: [], mittel: [], niedrig: [] };
    const groups = { kritisch: [], mittel: [], niedrig: [] };
    for (const issue of this.kontinuitaetIssuesFiltered) {
      const s = issue.schwere || 'niedrig';
      if (groups[s]) groups[s].push(issue);
      else groups.niedrig.push(issue);
    }
    return groups;
  },

  // Löst "Kapitel X: Seite Y" zu einem Page-Objekt auf. Fallback über
  // issue.chapter_ids (serverseitig gemappte Kapitel), damit mindestens
  // das Kapitel angesprungen wird, wenn die AI den Kapitelnamen nicht
  // wortwörtlich trifft oder nur eine Seitennummer nennt.
  kontinuitaetResolveStelle(stelle, issue, side) {
    if (!stelle) return null;
    const ci = stelle.indexOf(':');
    const kapitelName = (ci > 0 ? stelle.slice(0, ci) : stelle).trim();
    const seite = ci > 0 ? stelle.slice(ci + 1).trim() : '';
    const direct = this._resolvePage(kapitelName, seite);
    if (direct) return direct;
    const chIds = issue?.chapter_ids || [];
    if (!chIds.length) return null;
    const chapters = (this.tree || []).filter(t => t.type === 'chapter');
    const idx = side === 'b' && chIds.length > 1 ? 1 : 0;
    const chapter = chapters.find(c => c.id === chIds[idx]);
    if (!chapter?.pages?.length) return null;
    if (seite) {
      const sLower = seite.toLowerCase();
      const match = chapter.pages.find(p => p.name === seite)
        || chapter.pages.find(p => p.name.toLowerCase() === sLower)
        || chapter.pages.find(p => {
          const n = p.name.toLowerCase();
          return n && (n.includes(sLower) || sLower.includes(n));
        });
      if (match) return match;
    }
    return chapter.pages[0];
  },

  kontinuitaetGotoStelle(stelle, issue, side) {
    const page = this.kontinuitaetResolveStelle(stelle, issue, side);
    if (page) this.selectPage(page);
  },
};
