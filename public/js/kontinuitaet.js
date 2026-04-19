// Kontinuitätsprüfer-Methoden (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.

import { escHtml, fetchJson } from './utils.js';

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
        const { jobId } = await fetchJson(`/jobs/active?type=kontinuitaet&book_id=${this.selectedBookId}`);
        if (jobId) {
          this.kontinuitaetLoading = true;
          this.kontinuitaetProgress = 0;
          this.kontinuitaetStatus = this.t('kontinuitaet.alreadyRunning');
          this.startKontinuitaetPoll(jobId);
        }
      } catch (e) {
        console.error('[toggleKontinuitaetCard] active-job check:', e);
      }
    }
  },

  async _loadKontinuitaetHistory() {
    try {
      const data = await fetchJson('/jobs/kontinuitaet/' + this.selectedBookId);
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
        this.kontinuitaetStatus = this._runningJobStatus(job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut, job.progress, job.tokensPerSec, job.statusParams);
      },
      onNotFound: () => {
        this.kontinuitaetLoading = false;
        this.kontinuitaetProgress = 0;
        this.kontinuitaetStatus = this.t('kontinuitaet.interrupted');
      },
      onError: (job) => {
        this.kontinuitaetLoading = false;
        this.kontinuitaetProgress = 0;
        this.kontinuitaetStatus = `<span class="error-msg">${this.t('common.errorColon')}${escHtml(this.t(job.error, job.errorParams))}</span>`;
      },
      onDone: async (job) => {
        this.kontinuitaetLoading = false;
        this.kontinuitaetProgress = 0;
        if (job.result?.empty) { this.kontinuitaetStatus = this.t('kontinuitaet.noPages'); return; }
        await this._loadKontinuitaetHistory();
        const count = job.result?.count || 0;
        this.kontinuitaetStatus = count === 0
          ? this.t('kontinuitaet.noIssues')
          : this.t(count === 1 ? 'kontinuitaet.issuesOne' : 'kontinuitaet.issuesMany', { count });
      },
    });
  },

  async runKontinuitaetCheck() {
    const bookId = this.selectedBookId;
    const bookName = this.selectedBookName;
    this.kontinuitaetLoading = true;
    this.kontinuitaetProgress = 0;
    this.kontinuitaetStatus = this.t('kontinuitaet.starting');
    this.kontinuitaetResult = null;
    try {
      const { jobId } = await fetchJson('/jobs/kontinuitaet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: parseInt(bookId), book_name: bookName }),
      });
      localStorage.setItem('lektorat_kontinuitaet_job_' + bookId, jobId);
      this.startKontinuitaetPoll(jobId);
    } catch (e) {
      console.error('[runKontinuitaetCheck]', e);
      this.kontinuitaetStatus = `<span class="error-msg">${this.t('common.errorColon')}${escHtml(e.message)}</span>`;
      this.kontinuitaetLoading = false;
      this.kontinuitaetProgress = 0;
    }
  },

  kontinuitaetIssuesBySchwere() {
    if (!this.kontinuitaetResult?.issues) return { kritisch: [], mittel: [], niedrig: [] };
    const groups = { kritisch: [], mittel: [], niedrig: [] };
    for (const issue of this.kontinuitaetIssuesFiltered) {
      const s = issue.schwere || 'niedrig';
      if (groups[s]) groups[s].push(issue);
      else groups.niedrig.push(issue);
    }
    return groups;
  },

  // Löst "stelle_a/stelle_b" zu einem Page-Objekt auf. `stelle` ist ein
  // LLM-generierter String – Format nominal "Kapitel: Seite", kann aber
  // auch "Seite: Zitat" oder nur "Kapitel" sein. Der authoritative Kontext
  // ist issue.chapter_ids (serverseitig aus issue.kapitel gemappt) – der
  // Seitenname wird innerhalb dieses Kapitels gesucht. Der Kapitel-Namens-
  // Match auf dem ersten Teil darf nur greifen, wenn Teil 2 zu einer Seite
  // passt (sonst Verwechslung zwischen gleichnamigen Kapitel- und Seiten-
  // namen, z.B. Seite "Der Vater" in Kapitel "Der Unauffällige" vs. Kapitel
  // "Der Vater" mit erster Seite "Die letzte Familie").
  kontinuitaetResolveStelle(stelle, issue, side) {
    if (!stelle) return null;
    const chapters = (this.tree || []).filter(t => t.type === 'chapter');
    const chIds = issue?.chapter_ids || [];
    const idx = side === 'b' && chIds.length > 1 ? 1 : 0;
    const targetCh = chIds[idx] ? chapters.find(c => c.id === chIds[idx]) : null;

    const ci = stelle.indexOf(':');
    const part1 = (ci > 0 ? stelle.slice(0, ci) : stelle).trim();
    const part2 = ci > 0 ? stelle.slice(ci + 1).trim() : '';

    const pageByName = (pages, needle) => {
      if (!pages?.length || !needle) return null;
      const nLower = needle.toLowerCase();
      return pages.find(p => p.name === needle)
        || pages.find(p => p.name.toLowerCase() === nLower)
        || null;
    };

    // 1. Innerhalb des LLM-Kapitels: Seite per Namensmatch finden.
    //    Sowohl "Kapitel: Seite" (part2 = Seite) als auch "Seite: Zitat" (part1 = Seite).
    if (targetCh) {
      const byPart2 = pageByName(targetCh.pages, part2);
      if (byPart2) return byPart2;
      const byPart1 = pageByName(targetCh.pages, part1);
      if (byPart1) return byPart1;
    }

    // 2. Klassisches "Kapitel: Seite" ohne chapter_ids – nur wenn part2 eine echte Seite im Kapitel part1 ist.
    const chFromName = chapters.find(c => c.name === part1);
    if (chFromName) {
      const p = pageByName(chFromName.pages, part2);
      if (p) return p;
    }

    // 3. part1 als globaler Seitenname (AI hat Seite vor den Doppelpunkt gestellt).
    const globalByPart1 = pageByName(this.pages || [], part1);
    if (globalByPart1) return globalByPart1;

    // 4. Fallback: erste Seite des LLM-Kapitels (mindestens ins richtige Kapitel springen).
    if (targetCh?.pages?.length) return targetCh.pages[0];

    // 5. Fallback: erste Seite des per Namensmatch gefundenen Kapitels.
    if (chFromName?.pages?.length) return chFromName.pages[0];

    return null;
  },

  kontinuitaetGotoStelle(stelle, issue, side) {
    const page = this.kontinuitaetResolveStelle(stelle, issue, side);
    if (page) this.selectPage(page);
  },
};
