import { escHtml, fetchJson, SAFETY_HTML_RATIO, replaceInHtml, skipReason, stripFocusArtefacts } from '../utils.js';
import { sortByPosition, SOFT_TYPEN } from '../book/page-view.js';
import { contentRepo } from '../repo/content.js';
import { savePage } from './shared/page-api.js';
import { runQuoteNormalizeHtml } from './shared/quote-normalize.js';

// Lektorat-Workflow-Methoden (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.

export const lektoratMethods = {
  // `outSkipped` (optional): sammelt Korrekturen, die replaceInHtml unangetastet
  // liess (No-Op), als `{ f, reason }`. Vier Gründe, die der User auseinander
  // halten MUSS — „Stelle existiert nicht mehr" (Seite wurde zwischenzeitlich
  // umgeschrieben, typisch nach einem Write von einem Zweitgerät) verlangt keine
  // manuelle Nachkontrolle, „Link/Quellenangabe/Absatzgrenze betroffen" schon.
  // Reihenfolge des
  // Entscheidungsbaums identisch zum Seiten-Chat (chat.js#applyChatVorschlag).
  // Ausgewertet wird gegen `result`, den sequenziell mitwandernden Stand: ein
  // Finding, dessen `original` erst durch eine vorherige Korrektur verschwindet,
  // ist `notFound` und nicht `boundary`.
  // Aufrufer ohne Interesse an den Skips lassen den Parameter weg.
  _applyCorrections(html, fehler, outSkipped) {
    let result = html;
    for (const f of fehler) {
      if (!f.original || !f.korrektur || f.original === f.korrektur) continue;
      const next = replaceInHtml(result, f.original, f.korrektur);
      if (next === result) {
        if (outSkipped) outSkipped.push({ f, reason: skipReason(result, f.original) });
        continue;
      }
      result = next;
    }
    return result;
  },

  // Fasst uebersprungene Korrekturen nach Grund zusammen: je vorkommender Grund
  // ein lokalisierter Teilsatz, in fester Reihenfolge verbunden. Feste Reihenfolge
  // statt Iteration ueber die Skip-Liste, damit die Meldung bei gleicher Ursache
  // gleich lautet.
  _skipSummary(skipped) {
    const counts = {};
    for (const s of skipped) counts[s.reason] = (counts[s.reason] || 0) + 1;
    return ['notFound', 'spansLink', 'spansMarker', 'boundary']
      .filter(k => counts[k] > 0)
      .map(k => this.t('lektorat.skip.' + k, { count: counts[k] }))
      .join(', ');
  },

  // Gemeinsamer Kern fuer Lektorat-Save und History-Apply:
  // Seite frisch laden → Korrekturen anwenden → Safety-Check → Speichern.
  // `fresh: true` umgeht SWR; sonst koennte der CONTENT_CACHE nach kurz zuvor
  // gesetzten Edits noch die alte Fassung liefern und der gleich folgende PUT
  // wuerde frische Server-Edits mit Stale-Daten ueberschreiben.
  async _loadApplyAndSave(selectedErrors, onProgress, source = 'lektorat-apply') {
    onProgress(10, this.t('lektorat.loadingPage'));
    const page = await contentRepo.loadPage(this.currentPage.id, { fresh: true });
    page.html = stripFocusArtefacts(page.html || '');

    const skipped = [];
    let finalHtml = selectedErrors.length > 0
      ? this._applyCorrections(page.html, selectedErrors, skipped)
      : page.html;

    // KI-Korrekturen/Vorschläge liefern oft gerade `"`/`'` — auf Buch-Style
    // ziehen (de-CH «», de-DE „" …), bevor sie persistiert werden. Ganze Seite,
    // damit Quotes vollen Open/Close-Kontext haben. Idempotent, fehlertolerant.
    if (selectedErrors.length > 0 && this.$store.nav.selectedBookId) {
      const { html } = await runQuoteNormalizeHtml({ bookId: this.$store.nav.selectedBookId, html: finalHtml });
      finalHtml = html;
    }

    if (finalHtml.length < page.html.length * SAFETY_HTML_RATIO) {
      throw new Error(this.t('lektorat.unsafeHtml'));
    }

    onProgress(85, this.t('lektorat.saving'));
    // `page.updated_at` ist der frisch geladene Stand; PUT optimistisch gegen
    // genau diesen Stamp. Wenn dazwischen jemand schreibt → 409 vom Server.
    const saved = await savePage(this.currentPage.id, {
      html: finalHtml,
      pageName: this.currentPage.name,
      source,
      expectedUpdatedAt: page.updated_at || null,
    });
    if (saved?.updated_at) this.currentPage.updated_at = saved.updated_at;
    // Uebernommene Korrekturen sind direkte Folge des Lektorats — Seite soll
    // nicht unmittelbar danach auf "seit Lektorat bearbeitet" flippen.
    this.markPageChecked?.(this.currentPage.id);
    this._syncPageStatsAfterSave?.(this.currentPage, finalHtml);
    return { finalHtml, skipped };
  },


  _recomputeCorrectedHtml() {
    if (!this.originalHtml) return;
    const selected = this.lektoratFindings.filter((_, i) => this.selectedFindings[i]);
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
    this.appliedHistoricCorrections = [];
    this.correctedHtml = null;
    this.hasErrors = false;
    this.analysisOut = '';
    this.checkStatus = '';
    this.activeHistoryEntryId = null;
    this.updatePageView();
  },

  async runCheck() {
    if (!this.currentPage) return;
    // Guard: Lektorat darf nicht auf nicht-persistierten Edits laufen.
    // Server-Job liest BookStack server-seitig; sind Edits nur lokal (offline-
    // Draft oder editDirty), sieht der Job die alte Fassung. Findings haben
    // dann Positionen aus altem Text, und der spätere Save-Pfad würde nach
    // einem zwischenzeitlichen Online-Retry ein Race auslösen, das Edits
    // überschreiben kann. Lieber blocken bis der Save durch ist.
    if (this.saveOffline || this.editDirty) {
      this.setStatus(this.t('lektorat.blockedUnsavedEdits'), false, 6000);
      return;
    }
    const pageIdAtStart = this.currentPage.id;
    this.logAuditEvent?.('lektoratOpened', { book: this.$store.nav.selectedBookId, page: pageIdAtStart });
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
    this.appliedHistoricCorrections = [];
    this.checkProgress = 0;
    this.checkStatus = `<span class="spinner"></span>${escHtml(this.t('lektorat.starting'))}`;

    try {
      const { jobId } = await fetchJson('/jobs/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          page_id: this.currentPage.id,
          book_id: this.currentPage.book_id || null,
          page_name: this.currentPage.name || null,
        }),
      });
      if (this.currentPage?.id !== pageIdAtStart) return;
      localStorage.setItem('lektorat_check_job_' + this.currentPage.id, jobId);
      this.startCheckPoll(jobId);
    } catch (e) {
      console.error('[runCheck]', e);
      if (this.currentPage?.id !== pageIdAtStart) return;
      this.analysisOut = `<span class="error-msg">${this.t('common.errorColon')}${escHtml(e.message)}</span>`;
      this.checkStatus = '';
      this.checkLoading = false;
    }
  },

  startCheckPoll(jobId) {
    const pageId = this.currentPage?.id;
    // Per-pageId Timer-Slot: Wechselt User während laufendem Check auf eine
    // andere Seite, soll der Poll für die ursprüngliche Seite weiterlaufen
    // (sonst feuert `onDone` nie → Sidebar-Status der Ursprungsseite bleibt
    // stale). Ein zweiter Check für eine andere Seite kollidiert nicht.
    this._startPoll({
      timerProp: '_checkPollTimer_' + pageId,
      jobId,
      lsKey: pageId != null ? 'lektorat_check_job_' + pageId : null,
      onProgress: (job) => {
        if (this.currentPage?.id !== pageId) return;
        this.checkProgress = job.progress || 0;
        this.checkStatus = this._runningJobStatus(job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut, job.progress, job.tokensPerSec, job.statusParams);
      },
      onNotFound: () => {
        if (this.currentPage?.id !== pageId) return;
        this.checkLoading = false;
        this.analysisOut = `<span class="error-msg">${escHtml(this.t('job.interrupted'))}</span>`;
        this.checkStatus = '';
      },
      onError: (job) => {
        if (this.currentPage?.id !== pageId) return;
        this.checkLoading = false;
        setTimeout(() => { this.checkProgress = 0; }, 400);
        this.analysisOut = `<span class="error-msg">${this.t('common.errorColon')}${escHtml(this.t(job.error, job.errorParams))}</span>`;
        this.checkStatus = '';
      },
      onDone: async (job) => {
        // Sidebar-Status immer aktualisieren, auch wenn User inzwischen auf eine andere Seite gewechselt hat.
        const r = job.result || {};
        const fehler = r.fehler || [];
        if (!r.empty) this.markPageChecked(pageId, { pending: fehler.length > 0 });
        if (this.currentPage?.id !== pageId) return;
        this.checkLoading = false;
        setTimeout(() => { this.checkProgress = 0; }, 400);
        this.checkStatus = '';
        if (r.empty) {
          this.analysisOut = `<span class="muted-msg">${escHtml(this.t('job.pageEmpty'))}</span>`;
          return;
        }
        // Staleness: `r.originalHtml` ist der Seitenstand aus dem Moment, in dem
        // der Job gelesen hat. Wurde danach geschrieben, sind die Findings gegen
        // einen Text berechnet, den es nicht mehr gibt.
        //
        // `currentPage.updated_at` taugt als Vergleichswert NICHT allein: es ist
        // eine browserlokale Kopie und rückt nur vor, wenn `_refetchCurrentPage`
        // lief. Das setzt den 5s-Collab-Poll voraus, der am 40s-Buch-Device-Ping
        // hängt und ganz schweigt, wenn ein Zweitgerät (Mac-/Android-Client)
        // offline schrieb und beim Reconnect nur pusht. Darum den Stempel hier
        // selbst holen statt der lokalen Kopie zu glauben.
        let base = r.originalHtml;
        let verified = false;
        let staleRefiltered = false;
        if (pageId != null) {
          try {
            const pd = await contentRepo.loadPage(pageId, { fresh: true });
            if (this.currentPage?.id !== pageId) return;
            verified = true;
            if (r.updatedAt && pd.updated_at && pd.updated_at !== r.updatedAt) {
              // Frischen Stand in die Seitenansicht ziehen (setzt originalHtml,
              // renderedPageHtml und currentPage.updated_at über _applyPageData).
              // Der interne _filterFindingsAfterSave-Zweig ist hier No-Op —
              // runCheck hat die Findings geleert.
              await this._refetchCurrentPage();
              if (this.currentPage?.id !== pageId) return;
              base = this.originalHtml;
              staleRefiltered = true;
            }
          } catch (e) {
            console.error('[lektorat staleness-check]', e);
          }
        }
        // Verifikation nicht möglich (offline, SW-Fehler, kein pageId): auf den
        // lokalen Vergleich zurückfallen und komplett verwerfen, statt ungeprüft
        // auf dem Snapshot weiterzuarbeiten.
        if (!verified && r.updatedAt && this.currentPage?.updated_at && r.updatedAt !== this.currentPage.updated_at) {
          this.analysisOut = `<span class="error-msg">${escHtml(this.t('lektorat.staleResultDropped'))}</span>`;
          return;
        }
        // `sortByPosition` IST der Survivor-Filter: es verwirft jedes Finding,
        // dessen `original` per findInHtml nicht in `base` auffindbar ist, und
        // berechnet die Position aus `base`. Im Stale-Fall bleibt damit genau die
        // Teilmenge stehen, die den Fremd-Write verbatim überlebt hat — ihre
        // Positionen zeigen auf den aktuellen Text, nicht ins Leere.
        const findings = sortByPosition(base, fehler);
        if (staleRefiltered && findings.length === 0) {
          this.analysisOut = `<span class="error-msg">${escHtml(this.t('lektorat.staleResultDropped'))}</span>`;
          return;
        }
        this.originalHtml = base;
        this.lektoratFindings = findings;
        // Default selected: nur „harte" Typen (rechtschreibung, grammatik). Weiche Typen und Stil default unselected.
        this.selectedFindings = findings.map(f => !SOFT_TYPEN.has(f.typ) && f.typ !== 'stil');
        this.appliedOriginals = [];
        const hardErrors = findings.filter(f => !SOFT_TYPEN.has(f.typ) && f.typ !== 'stil');
        this.hasErrors = hardErrors.length > 0;
        this.correctedHtml = hardErrors.length > 0
          ? this._applyCorrections(base, hardErrors)
          : base;
        this.updatePageView();
        let out = '';
        // Hinweis nur, wenn der Fremd-Write wirklich Befunde gekostet hat. Haben
        // alle überlebt, gibt es nichts zu warnen — ein „0 von N verworfen"
        // trainiert den User nur, die Warnbox zu überlesen.
        const droppedByStale = staleRefiltered ? fehler.length - findings.length : 0;
        if (droppedByStale > 0) {
          out += `<div class="analysis-notice">${escHtml(this.t('lektorat.staleResultRefiltered', {
            dropped: droppedByStale,
            total: fehler.length,
          }))}</div>`;
        }
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

    try {
      const { finalHtml, skipped } = await this._loadApplyAndSave(selected, (pct, text) => {
        this.saveApplying = pct;
        if (text) this.setStatus(text, true);
      });

      if (this.lastCheckId) {
        try {
          this.saveApplying = 95;
          let applied = selected;
          let selectedAll = selected;
          // Bei History-Einträgen: mit bereits angewendeten Korrekturen mergen
          if (this.activeHistoryEntryId) {
            const entry = this.pageHistory.find(e => e.id === this.activeHistoryEntryId);
            if (entry) {
              const merge = (existing, items) => {
                const set = new Set((existing || []).map(e => e.original));
                return [...(existing || []), ...items.filter(e => !set.has(e.original))];
              };
              applied = merge(entry.applied_errors_json, applied);
              selectedAll = merge(entry.selected_errors_json, selected);
            }
          }
          const body = { applied_errors_json: applied, selected_errors_json: selectedAll };
          const r = await fetch('/history/check/' + this.lastCheckId + '/saved', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          await this.loadPageHistory(this.currentPage.id);
          this.refreshPageAges();
        } catch (e) { console.error('[history saved]', e); }
      }
      this.saveApplying = null;
      this.setStatus(
        skipped.length > 0
          ? this.t('lektorat.correctionsSavedWithSkips', {
            details: this._skipSummary(skipped),
            // Nachkontrolle nur, wo ein Schutzmechanismus gegriffen hat. Ein
            // reiner `notFound` ist ein veralteter Textbezug — dort gibt es
            // nichts zu prüfen.
            hint: skipped.some(s => s.reason !== 'notFound') ? ' ' + this.t('lektorat.skipCheckHint') : '',
          })
          : this.t('lektorat.correctionsSaved'),
        false,
        skipped.length > 0 ? 8000 : 5000,
      );
      this.correctedHtml = null;
      this.hasErrors = false;
      this.lektoratFindings = [];
      this.selectedFindings = [];
      this.appliedOriginals = [];
      this.appliedHistoricCorrections = [];
      this.checkDone = false;
      this.activeHistoryEntryId = null;
      // Seitenansicht aus dem gerade gespeicherten HTML neu aufbauen
      this.originalHtml = finalHtml;
      this.renderedPageHtml = finalHtml;
      this.analysisOut = '';
    } catch (e) {
      console.error('[saveCorrections]', e);
      this.saveApplying = null;
      this.setStatus(this.t('common.errorColon') + e.message);
    }
  },

  async batchCheck() {
    if (!this.$store.nav.pages.length) return;
    if (!await this.appConfirm({ message: this.t('lektorat.batchConfirm', { n: this.$store.nav.pages.length }) })) return;
    this.batchLoading = true;
    this.batchProgress = 0;
    this.batchStatus = this._runningJobStatus(this.t('common.starting'), 0, 0);
    try {
      const { jobId } = await fetchJson('/jobs/batch-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: parseInt(this.$store.nav.selectedBookId), book_name: this.selectedBookName || null }),
      });
      localStorage.setItem('lektorat_batchcheck_job_' + this.$store.nav.selectedBookId, jobId);
      this.startBatchPoll(jobId);
    } catch (e) {
      console.error('[batchCheck]', e);
      this.batchStatus = `<span class="error-msg">${this.t('common.errorColon')}${escHtml(e.message)}</span>`;
      this.batchLoading = false;
    }
  },

  startBatchPoll(jobId) {
    const bookId = this.$store.nav.selectedBookId;
    this._startPoll({
      timerProp: '_batchPollTimer',
      jobId,
      lsKey: 'lektorat_batchcheck_job_' + bookId,
      progressProp: 'batchProgress',
      onProgress: (job) => {
        this.batchStatus = this._runningJobStatus(job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut, job.progress, job.tokensPerSec, job.statusParams);
      },
      onNotFound: () => {
        this.batchLoading = false;
        this.batchStatus = this.t('job.interrupted');
      },
      onError: (job) => {
        this.batchLoading = false;
        setTimeout(() => { this.batchProgress = 0; }, 400);
        this.batchStatus = `<span class="error-msg">${this.t('common.errorColon')}${escHtml(this.t(job.error, job.errorParams))}</span>`;
      },
      onDone: async (job) => {
        this.batchLoading = false;
        setTimeout(() => { this.batchProgress = 0; }, 400);
        if (job.result?.empty) { this.batchStatus = this.t('lektorat.batchNoPages'); return; }
        const r = job.result;
        this.batchStatus = this.t('lektorat.batchDone', { done: r.done, total: r.pageCount, errors: r.totalErrors });
        this.refreshPageAges();
        if (this.currentPage) await this.loadPageHistory(this.currentPage.id);
      },
    });
  },
};
