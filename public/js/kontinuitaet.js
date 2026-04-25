// Kontinuitätsprüfer-Methoden (werden in Alpine.data('kontinuitaetCard')
// gespreadet). Job-Flow (runKontinuitaetCheck + startKontinuitaetPoll) direkt
// implementiert, ohne createCardJobFeature.

import { fetchJson, escHtml } from './utils.js';

export const kontinuitaetMethods = {
  async _loadKontinuitaetHistory() {
    try {
      const data = await fetchJson('/jobs/kontinuitaet/' + window.__app.selectedBookId);
      this.kontinuitaetResult = data;
    } catch (e) {
      console.error('[_loadKontinuitaetHistory]', e);
    }
  },

  _kontinuitaetWriteStatus(msg, spinner) {
    const safe = escHtml(msg);
    this.kontinuitaetStatus = spinner ? `<span class="spinner"></span>${safe}` : safe;
  },

  async runKontinuitaetCheck() {
    const root = window.__app;
    const bookId = root.selectedBookId;
    this.kontinuitaetLoading = true;
    this.kontinuitaetProgress = 0;
    root.showKontinuitaetCard = true;
    this.kontinuitaetResult = null;
    this._kontinuitaetWriteStatus(root.t('kontinuitaet.starting'), true);

    try {
      const { jobId } = await fetchJson('/jobs/kontinuitaet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          book_id: parseInt(bookId),
          book_name: root.selectedBookName,
        }),
      });
      localStorage.setItem(`lektorat_kontinuitaet_job_${bookId}`, jobId);
      this.startKontinuitaetPoll(jobId);
    } catch (e) {
      console.error('[runKontinuitaetCheck]', e);
      this.kontinuitaetStatus = `<span class="error-msg">${root.t('common.errorColon')}${escHtml(e.message)}</span>`;
      this.kontinuitaetLoading = false;
      this.kontinuitaetProgress = 0;
    }
  },

  startKontinuitaetPoll(jobId) {
    const root = window.__app;
    const bookId = root.selectedBookId;
    const lsKey = `lektorat_kontinuitaet_job_${bookId}`;
    if (this._kontinuitaetPollTimer) clearInterval(this._kontinuitaetPollTimer);
    this._kontinuitaetPollTimer = setInterval(async () => {
      try {
        const resp = await fetch('/jobs/' + jobId);
        if (resp.status === 404) {
          clearInterval(this._kontinuitaetPollTimer);
          this._kontinuitaetPollTimer = null;
          localStorage.removeItem(lsKey);
          this.kontinuitaetLoading = false;
          this.kontinuitaetProgress = 0;
          this._kontinuitaetWriteStatus(root.t('kontinuitaet.interrupted'), false);
          return;
        }
        if (!resp.ok) return;
        const job = await resp.json();
        this.kontinuitaetProgress = job.progress || 0;
        if (job.status === 'running' || job.status === 'queued') {
          this.kontinuitaetStatus = root._runningJobStatus(
            job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut,
            job.progress, job.tokensPerSec, job.statusParams,
          );
          return;
        }
        clearInterval(this._kontinuitaetPollTimer);
        this._kontinuitaetPollTimer = null;
        localStorage.removeItem(lsKey);
        this.kontinuitaetLoading = false;
        this.kontinuitaetProgress = 0;
        if (job.status === 'cancelled' || job.status === 'error') {
          this.kontinuitaetStatus = `<span class="error-msg">${root.t('common.errorColon')}${escHtml(root.t(job.error || '', job.errorParams))}</span>`;
          return;
        }
        if (job.result?.empty) {
          this._kontinuitaetWriteStatus(root.t('kontinuitaet.noPages'), false);
          return;
        }
        await this._loadKontinuitaetHistory();
        const count = job.result?.count || 0;
        this._kontinuitaetWriteStatus(
          count === 0
            ? root.t('kontinuitaet.noIssues')
            : root.t(count === 1 ? 'kontinuitaet.issuesOne' : 'kontinuitaet.issuesMany', { count }),
          false,
        );
      } catch (e) { console.error('[startKontinuitaetPoll]', e); }
    }, 2000);
  },

  // Issues gefiltert nach UI-Filtern (figurId, kapitel). Reads figuren+tree
  // from root. Muss eine Methode sein (keine `get`-Syntax): `kontinuitaetMethods`
  // wird per `...spread` in die Alpine.data-Factory übernommen, und Spread ruft
  // Getter auf und speichert nur den Wert — die Reaktivität auf Filter/Result
  // ginge verloren, und der Wert wäre zur Spread-Zeit `[]`.
  kontinuitaetIssuesFiltered() {
    const root = window.__app;
    const chapters = (root.tree || []).filter(t => t.type === 'chapter');
    const chapterNames = new Set(chapters.map(t => t.name));
    const fromStelle = (s) => {
      if (!s) return null;
      const ci = s.indexOf(':');
      const c = ci > 0 ? s.substring(0, ci).trim() : s.trim();
      return chapterNames.has(c) ? c : null;
    };
    return (this.kontinuitaetResult?.issues || []).filter(issue => {
      if (this.kontinuitaetFilters.figurId) {
        if (issue.fig_ids?.length) {
          if (!issue.fig_ids.includes(this.kontinuitaetFilters.figurId)) return false;
        } else {
          const selectedName = root.figuren.find(f => f.id === this.kontinuitaetFilters.figurId)?.name || '';
          if (selectedName && !(issue.figuren || []).includes(selectedName)) return false;
        }
      }
      if (this.kontinuitaetFilters.kapitel) {
        const f = this.kontinuitaetFilters.kapitel;
        const selectedId = chapters.find(t => t.name === f)?.id;
        const idMatch    = selectedId !== undefined && issue.chapter_ids?.includes(selectedId);
        const nameMatch  = (issue.kapitel || []).includes(f);
        const stelleMatch = fromStelle(issue.stelle_a) === f || fromStelle(issue.stelle_b) === f;
        if (!idMatch && !nameMatch && !stelleMatch) return false;
      }
      return true;
    });
  },

  kontinuitaetIssuesBySchwere() {
    if (!this.kontinuitaetResult?.issues) return { kritisch: [], mittel: [], niedrig: [] };
    const groups = { kritisch: [], mittel: [], niedrig: [] };
    for (const issue of this.kontinuitaetIssuesFiltered()) {
      const s = issue.schwere || 'niedrig';
      if (groups[s]) groups[s].push(issue);
      else groups.niedrig.push(issue);
    }
    return groups;
  },

  kontinuitaetKapitelListe() {
    const root = window.__app;
    const chapterById = new Map(
      (root.tree || []).filter(t => t.type === 'chapter').map(t => [t.id, t.name])
    );
    const chapterNames = new Set(chapterById.values());
    const fromStelle = (s) => {
      if (!s) return null;
      const ci = s.indexOf(':');
      const c = ci > 0 ? s.substring(0, ci).trim() : s.trim();
      return chapterNames.has(c) ? c : null;
    };
    const names = new Set();
    for (const issue of (this.kontinuitaetResult?.issues || [])) {
      if (issue.chapter_ids?.length) {
        for (const id of issue.chapter_ids) { const n = chapterById.get(id); if (n) names.add(n); }
      }
      if (issue.kapitel?.length) {
        for (const k of issue.kapitel) if (k && chapterNames.has(k)) names.add(k);
      }
      const a = fromStelle(issue.stelle_a); if (a) names.add(a);
      const b = fromStelle(issue.stelle_b); if (b) names.add(b);
    }
    return root._sortByChapterOrder([...names]);
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
    const root = window.__app;
    if (!stelle) return null;
    const chapters = (root.tree || []).filter(t => t.type === 'chapter');
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

    if (targetCh) {
      const byPart2 = pageByName(targetCh.pages, part2);
      if (byPart2) return byPart2;
      const byPart1 = pageByName(targetCh.pages, part1);
      if (byPart1) return byPart1;
    }
    const chFromName = chapters.find(c => c.name === part1);
    if (chFromName) {
      const p = pageByName(chFromName.pages, part2);
      if (p) return p;
    }
    const globalByPart1 = pageByName(root.pages || [], part1);
    if (globalByPart1) return globalByPart1;
    if (targetCh?.pages?.length) return targetCh.pages[0];
    if (chFromName?.pages?.length) return chFromName.pages[0];
    return null;
  },

  kontinuitaetGotoStelle(stelle, issue, side) {
    const page = this.kontinuitaetResolveStelle(stelle, issue, side);
    if (page) window.__app.selectPage(page);
  },
};
