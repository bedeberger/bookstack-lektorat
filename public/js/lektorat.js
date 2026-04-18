import { escHtml, htmlToText } from './utils.js';
import { sortByPosition, SOFT_TYPEN } from './page-view.js';

// Lektorat-Workflow-Methoden (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.

export const lektoratMethods = {
  _recomputeCorrectedHtml() {
    if (!this.originalHtml) return;
    // Nur Nicht-Stil-Korrekturen können direkt angewendet werden (Stil läuft über KI-Reformulierung erst beim Speichern)
    const selected = this.lektoratFindings.filter((f, i) => this.selectedFindings[i] && f.typ !== 'stil');
    this.correctedHtml = selected.length > 0
      ? this._applyCorrections(this.originalHtml, selected)
      : this.originalHtml;
    this.updatePageView();
  },

  toggleFinding(i) {
    this.selectedFindings[i] = !this.selectedFindings[i];
    this._recomputeCorrectedHtml();
  },

  selectAllFindings(val) {
    this.selectedFindings = this.selectedFindings.map(() => val);
    this._recomputeCorrectedHtml();
  },

  closeFindings() {
    this.checkDone = false;
    this.lektoratFindings = [];
    this.selectedFindings = [];
    this.appliedOriginals = [];
    this.correctedHtml = null;
    this.hasErrors = false;
    this.analysisOut = '';
    this.activeHistoryEntryId = null;
    this.updatePageView();
  },

  async runCheck() {
    if (!this.currentPage) return;
    const pageIdAtStart = this.currentPage.id;
    this.checkLoading = true;
    this.checkDone = false;
    this.activeHistoryEntryId = null;
    // originalHtml und renderedPageHtml beibehalten → Seitenansicht bleibt sichtbar
    this.correctedHtml = null;
    this.hasErrors = false;
    this.analysisOut = '';
    this.lektoratFindings = [];
    this.selectedFindings = [];
    this.appliedOriginals = [];
    this.checkProgress = 0;
    this.setStatus(this.t('lektorat.starting'), true);

    try {
      const { jobId } = await fetch('/jobs/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          page_id: this.currentPage.id,
          book_id: this.currentPage.book_id || null,
          page_name: this.currentPage.name || null,
        }),
      }).then(r => r.json());
      if (this.currentPage?.id !== pageIdAtStart) return;
      localStorage.setItem('lektorat_check_job_' + this.currentPage.id, jobId);
      this.startCheckPoll(jobId);
    } catch (e) {
      console.error('[runCheck]', e);
      if (this.currentPage?.id !== pageIdAtStart) return;
      this.analysisOut = `<span class="error-msg">${this.t('common.errorColon')}${escHtml(e.message)}</span>`;
      this.setStatus('');
      this.checkLoading = false;
    }
  },

  startCheckPoll(jobId) {
    const pageId = this.currentPage?.id;
    this._startPoll({
      timerProp: '_checkPollTimer',
      jobId,
      lsKey: pageId != null ? 'lektorat_check_job_' + pageId : null,
      onProgress: (job) => {
        if (this.currentPage?.id !== pageId) return;
        this.checkProgress = job.progress || 0;
        this.status = this._runningJobStatus(job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut, job.progress, job.tokensPerSec);
        this.statusSpinner = false;
      },
      onNotFound: () => {
        if (this.currentPage?.id !== pageId) return;
        this.checkLoading = false;
        this.analysisOut = `<span class="error-msg">${escHtml(this.t('job.interrupted'))}</span>`;
        this.setStatus('');
      },
      onError: (job) => {
        if (this.currentPage?.id !== pageId) return;
        this.checkLoading = false;
        setTimeout(() => { this.checkProgress = 0; }, 400);
        this.analysisOut = `<span class="error-msg">${this.t('common.errorColon')}${escHtml(job.error)}</span>`;
        this.setStatus('');
      },
      onDone: async (job) => {
        if (this.currentPage?.id !== pageId) return;
        this.checkLoading = false;
        setTimeout(() => { this.checkProgress = 0; }, 400);
        if (job.result?.empty) {
          this.analysisOut = `<span class="muted-msg">${escHtml(this.t('job.pageEmpty'))}</span>`;
          this.setStatus('');
          return;
        }
        const r = job.result;
        this.originalHtml = r.originalHtml;
        const fehler = r.fehler || [];
        const findings = sortByPosition(r.originalHtml, fehler);
        this.lektoratFindings = findings;
        // Default selected: nur „harte" Typen (rechtschreibung, grammatik). Weiche Typen und Stil default unselected.
        this.selectedFindings = findings.map(f => !SOFT_TYPEN.has(f.typ) && f.typ !== 'stil');
        this.appliedOriginals = [];
        const hardErrors = findings.filter(f => !SOFT_TYPEN.has(f.typ) && f.typ !== 'stil');
        this.hasErrors = hardErrors.length > 0;
        this.correctedHtml = hardErrors.length > 0
          ? this._applyCorrections(r.originalHtml, hardErrors)
          : r.originalHtml;
        this.updatePageView();
        let out = '';
        const szenen = r.szenen || [];
        if (szenen.length > 0) {
          const wertungBadge = w => {
            if (w === 'stark')   return `<span class="badge badge-ok">${escHtml(this.t('szenen.rating.stark'))}</span>`;
            if (w === 'schwach') return `<span class="badge badge-err">${escHtml(this.t('szenen.rating.schwach'))}</span>`;
            return `<span class="badge badge-warn">${escHtml(this.t('szenen.rating.mittel'))}</span>`;
          };
          const rows = szenen.map(s =>
            `<div class="szene-item">
              <div class="szene-header">${wertungBadge(s.wertung)} <span class="szene-titel">${escHtml(s.titel)}</span></div>
              ${s.kommentar ? `<div class="szene-kommentar">${escHtml(s.kommentar)}</div>` : ''}
            </div>`
          ).join('');
          out += `<div class="stilbox"><div class="bewertung-section-title">${escHtml(this.t('lektorat.section.szenen'))}</div>${rows}</div>`;
        }
        if (r.stilanalyse) out += `<div class="stilbox"><div class="bewertung-section-title">${escHtml(this.t('lektorat.section.stilanalyse'))}</div>${escHtml(r.stilanalyse)}</div>`;
        if (r.fazit) out += `<div class="fazit">${escHtml(r.fazit)}</div>`;
        this.analysisOut = out;
        this.checkDone = true;
        this.lastCheckId = r.checkId || null;
        this.activeHistoryEntryId = r.checkId || null;
        if (pageId != null) await this.loadPageHistory(pageId);
        this.setStatus(this.t('job.analyseDone'), false, 5000);
      },
    });
  },

  async saveCorrections() {
    if (!this.currentPage) return;
    const selected = this.lektoratFindings.filter((_, i) => this.selectedFindings[i]);
    if (selected.length === 0) return;
    // Split: Stil-Typ läuft über KI-Reformulierung, Rest über direkte Textersetzung
    const selectedHard   = selected.filter(f => f.typ !== 'stil');
    const selectedStyles = selected.filter(f => f.typ === 'stil');

    try {
      const finalHtml = await this._loadApplyAndSave(selectedHard, selectedStyles, (pct, text) => {
        this.saveApplying = pct;
        if (text) this.setStatus(text, true);
      });

      if (this.lastCheckId) {
        try {
          this.saveApplying = 95;
          let applied = selectedHard;
          let selectedAll = selected;
          // Bei History-Einträgen: mit bereits angewendeten Korrekturen mergen
          if (this.activeHistoryEntryId) {
            const entry = this.pageHistory.find(e => e.id === this.activeHistoryEntryId);
            if (entry) {
              const merge = (existing, items) => {
                const set = new Set((existing || []).map(e => e.original));
                return [...(existing || []), ...items.filter(e => !set.has(e.original))];
              };
              applied = merge(entry.applied_errors_json, selectedHard);
              selectedAll = merge(entry.selected_errors_json, selected);
            }
          }
          await fetch('/history/check/' + this.lastCheckId + '/saved', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ applied_errors_json: applied, selected_errors_json: selectedAll }),
          });
          await this.loadPageHistory(this.currentPage.id);
        } catch (e) { console.error('[history saved]', e); }
      }
      this.saveApplying = null;
      this.setStatus(this.t('lektorat.correctionsSaved'), false, 5000);
      this.correctedHtml = null;
      this.hasErrors = false;
      this.lektoratFindings = [];
      this.selectedFindings = [];
      this.appliedOriginals = [];
      this.checkDone = false;
      this.activeHistoryEntryId = null;
      // Seitenansicht aus dem gerade gespeicherten HTML neu aufbauen
      this.originalHtml = finalHtml;
      this.renderedPageHtml = finalHtml;
      const rawPreview = htmlToText(finalHtml).trim() || null;
      if (this.currentPage) this.currentPage.previewText = rawPreview;
      this.analysisOut = '';
    } catch (e) {
      console.error('[saveCorrections]', e);
      this.saveApplying = null;
      this.setStatus(this.t('common.errorColon') + e.message);
    }
  },

  async batchCheck() {
    if (!this.pages.length) return;
    if (!confirm(this.t('lektorat.batchConfirm', { n: this.pages.length }))) return;
    this.batchLoading = true;
    this.batchProgress = 0;
    this.batchStatus = this._runningJobStatus(this.t('common.starting'), 0, 0);
    try {
      const { jobId } = await fetch('/jobs/batch-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: parseInt(this.selectedBookId), book_name: this.selectedBookName || null }),
      }).then(r => r.json());
      localStorage.setItem('lektorat_batchcheck_job_' + this.selectedBookId, jobId);
      this.startBatchPoll(jobId);
    } catch (e) {
      console.error('[batchCheck]', e);
      this.batchStatus = `<span class="error-msg">${this.t('common.errorColon')}${escHtml(e.message)}</span>`;
      this.batchLoading = false;
    }
  },

  startBatchPoll(jobId) {
    const bookId = this.selectedBookId;
    this._startPoll({
      timerProp: '_batchPollTimer',
      jobId,
      lsKey: 'lektorat_batchcheck_job_' + bookId,
      progressProp: 'batchProgress',
      onProgress: (job) => {
        this.batchStatus = this._runningJobStatus(job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut, job.progress, job.tokensPerSec);
      },
      onNotFound: () => {
        this.batchLoading = false;
        this.batchStatus = this.t('job.interrupted');
      },
      onError: (job) => {
        this.batchLoading = false;
        setTimeout(() => { this.batchProgress = 0; }, 400);
        this.batchStatus = `<span class="error-msg">${this.t('common.errorColon')}${escHtml(job.error)}</span>`;
      },
      onDone: async (job) => {
        this.batchLoading = false;
        setTimeout(() => { this.batchProgress = 0; }, 400);
        if (job.result?.empty) { this.batchStatus = this.t('lektorat.batchNoPages'); return; }
        const r = job.result;
        this.batchStatus = this.t('lektorat.batchDone', { done: r.done, total: r.pageCount, errors: r.totalErrors });
        if (this.currentPage) await this.loadPageHistory(this.currentPage.id);
      },
    });
  },
};
