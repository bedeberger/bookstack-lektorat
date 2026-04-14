import { escHtml, htmlToText, SAFETY_HTML_RATIO } from './utils.js';

// Lektorat-Workflow-Methoden (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.

export const lektoratMethods = {
  computeDiff(originalHtml, correctedHtml) {
    const aText = htmlToText(originalHtml);
    const bText = htmlToText(correctedHtml);
    if (aText === bText) {
      return '<div class="diff-unchanged">Keine Textänderungen.</div>';
    }
    const tok = s => s.match(/[^\s]+|\s+/g) || [];
    const a = tok(aText);
    const b = tok(bText);
    if (a.length * b.length > 400000) {
      return `<div class="muted-msg">Text zu lang für Diff-Ansicht (${Math.round(a.length * b.length / 1000)}k Operationen).</div>`;
    }
    const m = a.length, n = b.length;
    const dp = [];
    for (let i = 0; i <= m; i++) dp[i] = new Uint32Array(n + 1);
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = a[i-1] === b[j-1]
          ? dp[i-1][j-1] + 1
          : Math.max(dp[i-1][j], dp[i][j-1]);
      }
    }
    const ops = [];
    let i = m, j = n;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && a[i-1] === b[j-1]) {
        ops.push({ t: '=', s: a[i-1] }); i--; j--;
      } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) {
        ops.push({ t: '+', s: b[j-1] }); j--;
      } else {
        ops.push({ t: '-', s: a[i-1] }); i--;
      }
    }
    ops.reverse();
    let html = '';
    for (const op of ops) {
      const s = escHtml(op.s);
      if (op.t === '=') html += s;
      else if (op.t === '+') html += `<ins>${s}</ins>`;
      else html += `<del>${s}</del>`;
    }
    return `<div class="diff-view">${html}</div>`;
  },

  toggleDiff() {
    if (!this.correctedHtml || !this.originalHtml) return;
    this.showDiff = !this.showDiff;
    if (this.showDiff && !this.diffHtml) {
      this.diffHtml = this.computeDiff(this.originalHtml, this.correctedHtml);
    }
  },

  _recomputeCorrectedHtml() {
    if (!this.originalHtml) return;
    const selected = this.lektoratErrors.filter((_, i) => this.selectedErrors[i]);
    this.correctedHtml = selected.length > 0
      ? this._applyCorrections(this.originalHtml, selected)
      : this.originalHtml;
    this.diffHtml = '';
    this.showDiff = false;
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
    this.originalHtml = null;
    this.correctedHtml = null;
    this.hasErrors = false;
    this.showDiff = false;
    this.diffHtml = '';
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
        this.currentPageUpdatedAt = r.updatedAt || null;
        const fehler = r.fehler || [];
        const errors = fehler.filter(f => f.typ === 'rechtschreibung' || f.typ === 'grammatik' || f.typ === 'wiederholung');
        const styles = fehler.filter(f => f.typ === 'stil');
        this.lektoratErrors = errors;
        this.lektoratStyles = styles;
        this.selectedErrors = errors.map(f => f.typ !== 'wiederholung');
        this.selectedStyles = styles.map(() => false);
        const hardErrors = errors.filter(f => f.typ !== 'wiederholung');
        this.hasErrors = hardErrors.length > 0;
        this.correctedHtml = hardErrors.length > 0
          ? this._applyCorrections(r.originalHtml, hardErrors)
          : r.originalHtml;
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
        if (pageId != null) await this.loadPageHistory(pageId);
        this.setStatus('Analyse abgeschlossen.', false, 5000);
      },
    });
  },

  async saveCorrections() {
    if (!this.correctedHtml || !this.currentPage) return;
    if (this.originalHtml && this.correctedHtml.length < this.originalHtml.length * SAFETY_HTML_RATIO) {
      this.setStatus('Fehler: Korrigiertes HTML wirkt unvollständig – Speichern abgebrochen.');
      console.error('[saveCorrections] correctedHtml zu kurz:', this.correctedHtml.length, 'vs original:', this.originalHtml.length);
      return;
    }

    this.saveApplying = 10;
    let finalHtml = this.correctedHtml;
    const selectedStyles = this.lektoratStyles.filter((_, i) => this.selectedStyles[i]);

    if (selectedStyles.length > 0) {
      this.saveApplying = 30;
      finalHtml = await this._applyStilkorrektur(
        this.correctedHtml,
        selectedStyles,
        (chars, aiBase) => { this.saveApplying = Math.min(70, 30 + Math.round((chars / aiBase) * 40)); }
      );
    }

    this.saveApplying = 75;
    this.setStatus('Prüfe auf Änderungen…', true);
    try {
      const current = await this.bsGet('pages/' + this.currentPage.id);
      if (this.currentPageUpdatedAt && current.updated_at !== this.currentPageUpdatedAt) {
        this.saveApplying = null;
        this.setStatus('Konflikt: Die Seite wurde zwischenzeitlich von jemand anderem geändert. Bitte Lektorat neu starten.');
        return;
      }
    } catch (e) {
      console.warn('[saveCorrections] Konfliktprüfung fehlgeschlagen, fahre fort:', e.message);
    }

    this.saveApplying = 85;
    this.setStatus('Speichere in BookStack…', true);
    try {
      await this.bsPut('pages/' + this.currentPage.id, {
        html: finalHtml,
        name: this.currentPage.name,
      });
      if (this.lastCheckId) {
        try {
          this.saveApplying = 95;
          const appliedErrors = this.lektoratErrors.filter((_, i) => this.selectedErrors[i]);
          const selectedErrors = [
            ...this.lektoratErrors.filter((_, i) => this.selectedErrors[i]),
            ...this.lektoratStyles.filter((_, i) => this.selectedStyles[i]),
          ];
          await fetch('/history/check/' + this.lastCheckId + '/saved', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ applied_errors_json: appliedErrors, selected_errors_json: selectedErrors }),
          });
          await this.loadPageHistory(this.currentPage.id);
        } catch (e) { console.error('[history saved]', e); }
      }
      this.saveApplying = null;
      this.setStatus('✓ Korrekturen gespeichert.', false, 5000);
      this.correctedHtml = null;
      this.hasErrors = false;
      this.showDiff = false;
      this.diffHtml = '';
      this.lektoratErrors = [];
      this.lektoratStyles = [];
      this.selectedErrors = [];
      this.selectedStyles = [];
      this.checkDone = false;
      // Vorschau aus dem gerade gespeicherten HTML neu aufbauen
      const rawPreview = htmlToText(finalHtml).trim() || null;
      if (this.currentPage) this.currentPage.previewText = rawPreview;
      const PREVIEW_MAX_CHARS = 600;
      this.analysisOut = rawPreview
        ? `<div class="preview-text">${escHtml(rawPreview.length > PREVIEW_MAX_CHARS ? rawPreview.slice(0, PREVIEW_MAX_CHARS) + ' …' : rawPreview)}</div>`
        : '<span class="muted-msg">Seite ist leer.</span>';
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
