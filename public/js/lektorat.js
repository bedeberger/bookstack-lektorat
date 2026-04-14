import { escHtml, htmlToText } from './utils.js';
import { sortByPosition } from './page-view.js';

// Lektorat-Workflow-Methoden (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.

export const lektoratMethods = {
  _recomputeCorrectedHtml() {
    if (!this.originalHtml) return;
    const selected = this.lektoratErrors.filter((_, i) => this.selectedErrors[i]);
    this.correctedHtml = selected.length > 0
      ? this._applyCorrections(this.originalHtml, selected)
      : this.originalHtml;
    this.updatePageView();
  },

  toggleError(i) {
    this.selectedErrors[i] = !this.selectedErrors[i];
    this._recomputeCorrectedHtml();
  },

  toggleStyle(i) {
    this.selectedStyles[i] = !this.selectedStyles[i];
    this._recomputeCorrectedHtml();
  },

  selectAllErrors(val) {
    this.selectedErrors = this.selectedErrors.map(() => val);
    this._recomputeCorrectedHtml();
  },

  selectAllStyles(val) {
    this.selectedStyles = this.selectedStyles.map(() => val);
    this._recomputeCorrectedHtml();
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
    this.lektoratErrors = [];
    this.lektoratStyles = [];
    this.selectedErrors = [];
    this.selectedStyles = [];
    this.checkProgress = 0;
    this.setStatus('Starte Lektorat…', true);

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
      this.analysisOut = `<span class="error-msg">Fehler: ${escHtml(e.message)}</span>`;
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
        this.analysisOut = '<span class="error-msg">Analyse unterbrochen (Server-Neustart). Bitte neu starten.</span>';
        this.setStatus('');
      },
      onError: (job) => {
        if (this.currentPage?.id !== pageId) return;
        this.checkLoading = false;
        setTimeout(() => { this.checkProgress = 0; }, 400);
        this.analysisOut = `<span class="error-msg">Fehler: ${escHtml(job.error)}</span>`;
        this.setStatus('');
      },
      onDone: async (job) => {
        if (this.currentPage?.id !== pageId) return;
        this.checkLoading = false;
        setTimeout(() => { this.checkProgress = 0; }, 400);
        if (job.result?.empty) {
          this.analysisOut = '<span class="muted-msg">Seite ist leer.</span>';
          this.setStatus('');
          return;
        }
        const r = job.result;
        this.originalHtml = r.originalHtml;
        const fehler = r.fehler || [];
        const SOFT_TYPEN = new Set(['wiederholung', 'schwaches_verb', 'fuellwort', 'show_vs_tell', 'passiv', 'perspektivbruch', 'tempuswechsel']);
        const errors = sortByPosition(r.originalHtml, fehler.filter(f => f.typ !== 'stil'));
        const styles = sortByPosition(r.originalHtml, fehler.filter(f => f.typ === 'stil'));
        this.lektoratErrors = errors;
        this.lektoratStyles = styles;
        this.selectedErrors = errors.map(f => !SOFT_TYPEN.has(f.typ));
        this.selectedStyles = styles.map(() => false);
        const hardErrors = errors.filter(f => !SOFT_TYPEN.has(f.typ));
        this.hasErrors = hardErrors.length > 0;
        this.correctedHtml = hardErrors.length > 0
          ? this._applyCorrections(r.originalHtml, hardErrors)
          : r.originalHtml;
        this.updatePageView();
        let out = '';
        const szenen = r.szenen || [];
        if (szenen.length > 0) {
          const wertungBadge = w => {
            if (w === 'stark')   return '<span class="badge badge-ok">stark</span>';
            if (w === 'schwach') return '<span class="badge badge-err">schwach</span>';
            return '<span class="badge badge-warn">mittel</span>';
          };
          const rows = szenen.map(s =>
            `<div class="szene-item">
              <div class="szene-header">${wertungBadge(s.wertung)} <span class="szene-titel">${escHtml(s.titel)}</span></div>
              ${s.kommentar ? `<div class="szene-kommentar">${escHtml(s.kommentar)}</div>` : ''}
            </div>`
          ).join('');
          out += `<div class="stilbox"><div class="bewertung-section-title">Szenen</div>${rows}</div>`;
        }
        if (r.stilanalyse) out += `<div class="stilbox"><div class="bewertung-section-title">Stilanalyse</div>${escHtml(r.stilanalyse)}</div>`;
        if (r.fazit) out += `<div class="fazit">${escHtml(r.fazit)}</div>`;
        this.analysisOut = out;
        this.checkDone = true;
        this.lastCheckId = r.checkId || null;
        this.activeHistoryEntryId = r.checkId || null;
        if (pageId != null) await this.loadPageHistory(pageId);
        this.setStatus('Analyse abgeschlossen.', false, 5000);
      },
    });
  },

  async saveCorrections() {
    if (!this.currentPage) return;
    const selectedErrors = this.lektoratErrors.filter((_, i) => this.selectedErrors[i]);
    const selectedStyles = this.lektoratStyles.filter((_, i) => this.selectedStyles[i]);
    if (selectedErrors.length === 0 && selectedStyles.length === 0) return;

    try {
      const finalHtml = await this._loadApplyAndSave(selectedErrors, selectedStyles, (pct, text) => {
        this.saveApplying = pct;
        if (text) this.setStatus(text, true);
      });

      if (this.lastCheckId) {
        try {
          this.saveApplying = 95;
          let applied = selectedErrors;
          let selected = [...selectedErrors, ...selectedStyles];
          // Bei History-Einträgen: mit bereits angewendeten Korrekturen mergen
          if (this.activeHistoryEntryId) {
            const entry = this.pageHistory.find(e => e.id === this.activeHistoryEntryId);
            if (entry) {
              const merge = (existing, items) => {
                const set = new Set((existing || []).map(e => e.original));
                return [...(existing || []), ...items.filter(e => !set.has(e.original))];
              };
              applied = merge(entry.applied_errors_json, selectedErrors);
              selected = merge(entry.selected_errors_json, [...selectedErrors, ...selectedStyles]);
            }
          }
          await fetch('/history/check/' + this.lastCheckId + '/saved', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ applied_errors_json: applied, selected_errors_json: selected }),
          });
          await this.loadPageHistory(this.currentPage.id);
        } catch (e) { console.error('[history saved]', e); }
      }
      this.saveApplying = null;
      this.setStatus('✓ Korrekturen gespeichert.', false, 5000);
      this.correctedHtml = null;
      this.hasErrors = false;
      this.lektoratErrors = [];
      this.lektoratStyles = [];
      this.selectedErrors = [];
      this.selectedStyles = [];
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
      this.setStatus('Fehler: ' + e.message);
    }
  },

  async batchCheck() {
    if (!this.pages.length) return;
    if (!confirm(`Alle ${this.pages.length} Seiten prüfen und Ergebnisse in der History speichern?\n\nDies kann bei grossen Büchern mehrere Minuten dauern.`)) return;
    this.batchLoading = true;
    this.batchProgress = 0;
    this.batchStatus = this._runningJobStatus('Starte…', 0, 0);
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
      this.batchStatus = `<span class="error-msg">Fehler: ${escHtml(e.message)}</span>`;
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
        this.batchStatus = 'Analyse unterbrochen (Server-Neustart). Bitte neu starten.';
      },
      onError: (job) => {
        this.batchLoading = false;
        setTimeout(() => { this.batchProgress = 0; }, 400);
        this.batchStatus = `<span class="error-msg">Fehler: ${escHtml(job.error)}</span>`;
      },
      onDone: async (job) => {
        this.batchLoading = false;
        setTimeout(() => { this.batchProgress = 0; }, 400);
        if (job.result?.empty) { this.batchStatus = 'Keine Seiten im Buch gefunden.'; return; }
        const r = job.result;
        this.batchStatus = `Fertig: ${r.done}/${r.pageCount} Seiten geprüft, ${r.totalErrors} Beanstandungen.`;
        if (this.currentPage) await this.loadPageHistory(this.currentPage.id);
      },
    });
  },
};
