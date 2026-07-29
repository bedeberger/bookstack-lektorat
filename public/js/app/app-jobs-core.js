import { escHtml, fmtTok, fetchJson } from '../utils.js';
import { startPoll as _startPollFn, runningJobStatus as _runningJobStatusFn } from '../cards/job-helpers.js';
import { EXCLUSIVE_CARDS } from '../cards/feature-registry.js';
import { EVT } from '../events.js';

// Job-Typ → EXCLUSIVE_CARDS-Key: Klick auf die Job-Pill im Footer springt zur
// Karte, die den Output des Jobs anzeigt. Nur Typen mit sinnvollem Karten-Ziel.
// Page-scopte (check) und id-tragende Typen (chapter-review, werkstatt-*,
// batch-check) laufen über Sonderfälle in navigateToJob. Bewusst NICHT gelistet
// (kein UI-Ziel): book-import, synonym, blog-*/hubspot-* (Sync).
const JOB_NAV_CARD = {
  'review':            'bookReview',
  'komplett-analyse':  'figures',
  'faktencheck':       'weltfakten',
  'erzaehlprofil':     'erzaehlprofil',
  'kontinuitaet':      'kontinuitaet',
  'redundancy':        'redundanz',
  'embed-index':       'redundanz',
  'stilprofil':        'stil',
  'motif-brainstorm':  'motiv',
  'motif-scan':        'motiv',
  'geocode-resolve':   'orte',
  'plot-brainstorm':   'plot',
  'plot-consistency':  'plot',
  'book-chat':         'bookChat',
  'research-chat':     'recherche',
  'research-link':     'recherche',
  'source-detect':     'sources',
  'rueckblick':        'tagebuchRueckblick',
  'finetune-export':   'finetuneExport',
  'pdf-export':        'pdfExport',
  'epub-export':       'epubExport',
  'docx-export':       'docxExport',
  'folder-import':     'folderImport',
};

// Auto-Open für Reconnect-Pfade: nur wenn keine Hauptkarte/Editor offen ist.
// Verhindert, dass ein spät resolvender Reconnect den vom User geöffneten
// Editor oder eine andere Karte zerstört. Loading-State + Polling laufen
// trotzdem (Footer-Indikator zeigt Progress); User öffnet die Karte manuell.
function canAutoOpenCard(ctx) {
  if (ctx.showEditorCard) return false;
  return !EXCLUSIVE_CARDS.some(c => ctx[c.flag]);
}

// Factory für standard job-driven Feature-Cards (Review, Kontinuität,
// Kapitel-Review, Figuren, …). Die Features folgen alle demselben Muster:
// toggle → POST /jobs/… → localStorage-Backup → poll bis done →
// Status-HTML ins x-html-Feld. Die Factory deklariert die generischen
// Methoden (`start`, `run`, `toggle`) und das Feature-Modul liefert nur
// die variablen Teile (Endpoint, Render, Payload, Post-Processing).
//
// cfg:
//   name              — logischer Feature-Name (z. B. 'review'), Default für
//                       LS-Key und activeType.
//   endpoint          — POST-Ziel, z. B. '/jobs/review'.
//   activeType        — Override für /jobs/active?type=…; Default = name.
//   timerProp         — z. B. '_reviewPollTimer'.
//   closeCardKey      — Argument für _closeOtherMainCards(…).
//   methodNames       — { start, run, toggle? }.
//   fields            — { show, loading, progress, status, out?, result? }.
//   lsKey             — optional: (bookId, self) => string.
//                       Default `lektorat_${name}_job_${bookId}`.
//   i18n              — { starting, interrupted, alreadyRunning,
//                         alreadyRunningSpinner?, empty? }.
//   buildPayload      — (self) => body-Objekt für den POST.
//   render            — (job, self) => html für `fields.out`. Optional.
//   onDone            — async (job, self) => void — nach render.
//   onError           — (job, self) => void — Override des Default-Rendering.
//   onNotFound        — (self) => void — Zusatz nach NotFound.
//   onOpen            — async (self) => void — nach frischem Öffnen.
//   onOpenWhenOpen    — async (self) => void — wenn toggle auf offene Karte.
//   beforeRun         — (self) => void — vor POST (z. B. Result-Reset).
//   resetProgressOnDone — bool (Default: true) — Progress auf 0 nach onDone.
//   progressResetDelay  — ms (Default: 0) — verzögerter Reset nach Erfolg
//                         (lässt die Fortschrittsleiste ausfüllen, bevor sie
//                         zurückspringt). Bei empty/error sofortiger Reset.
export function createJobFeature(cfg) {
  const { show, loading, progress, status, out } = cfg.fields;
  const timerProp  = cfg.timerProp;
  const activeType = cfg.activeType || cfg.name;
  const lsKeyFn    = cfg.lsKey || ((bookId) => `lektorat_${cfg.name}_job_${bookId}`);
  const names      = cfg.methodNames;
  const i18n       = cfg.i18n || {};

  function writeStatus(msg, spinner) {
    const safe = escHtml(msg);
    this[status] = spinner ? `<span class="spinner"></span>${safe}` : safe;
  }
  function jobErrHtml(job) {
    return `<span class="error-msg">${this.t('common.errorColon')}${escHtml(this.t(job.error, job.errorParams))}</span>`;
  }
  function errHtml(err) {
    return `<span class="error-msg">${this.t('common.errorColon')}${escHtml(err.message)}</span>`;
  }

  const startPoll = function (jobId) {
    const bookId = this.$store.nav.selectedBookId;
    this._startPoll({
      timerProp,
      jobId,
      lsKey: lsKeyFn(bookId, this),
      progressProp: progress,
      onProgress: (job) => {
        this[status] = this._runningJobStatus(
          job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut,
          job.progress, job.tokensPerSec, job.statusParams,
        );
      },
      onNotFound: () => {
        this[loading] = false;
        if (progress) this[progress] = 0;
        writeStatus.call(this, this.t(i18n.interrupted), false);
        cfg.onNotFound?.call(this);
      },
      onError: (job) => {
        this[loading] = false;
        if (progress) this[progress] = 0;
        if (cfg.onError) { cfg.onError.call(this, job); return; }
        if (out) {
          this[out] = jobErrHtml.call(this, job);
          writeStatus.call(this, '', false);
        } else {
          this[status] = jobErrHtml.call(this, job);
        }
      },
      onDone: async (job) => {
        this[loading] = false;
        if (i18n.empty && job.result?.empty) {
          writeStatus.call(this, this.t(i18n.empty), false);
          if (cfg.resetProgressOnDone !== false && progress) this[progress] = 0;
          return;
        }
        if (cfg.render && out) {
          const html = cfg.render.call(this, job);
          if (html !== undefined) this[out] = html;
        }
        if (cfg.onDone) await cfg.onDone.call(this, job);
        if (cfg.resetProgressOnDone !== false && progress) {
          const delay = cfg.progressResetDelay || 0;
          if (delay > 0) setTimeout(() => { this[progress] = 0; }, delay);
          else this[progress] = 0;
        }
      },
    });
  };

  const run = async function () {
    const bookId = this.$store.nav.selectedBookId;
    this[loading] = true;
    if (progress) this[progress] = 0;
    this[show] = true;
    if (out) this[out] = '';
    writeStatus.call(this, this.t(i18n.starting), true);
    if (cfg.beforeRun) cfg.beforeRun.call(this);
    try {
      const { jobId } = await fetchJson(cfg.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg.buildPayload.call(this)),
      });
      localStorage.setItem(lsKeyFn(bookId, this), jobId);
      this[names.start](jobId);
    } catch (e) {
      console.error(`[${names.run}]`, e);
      if (out) {
        this[out] = errHtml.call(this, e);
        writeStatus.call(this, '', false);
      } else {
        this[status] = errHtml.call(this, e);
      }
      this[loading] = false;
      if (progress) this[progress] = 0;
    }
  };

  const toggle = async function () {
    if (this[show]) {
      if (cfg.onOpenWhenOpen) await cfg.onOpenWhenOpen.call(this);
      return;
    }
    this._closeOtherMainCards(cfg.closeCardKey);
    this[show] = true;
    if (cfg.onOpen) await cfg.onOpen.call(this);
    if (!this[timerProp] && !this[loading] && this.$store.nav.selectedBookId) {
      try {
        const { jobId } = await fetchJson(
          `/jobs/active?type=${activeType}&book_id=${this.$store.nav.selectedBookId}`
        );
        if (jobId) {
          this[loading] = true;
          if (progress) this[progress] = 0;
          if (out) this[out] = '';
          const spinner = i18n.alreadyRunningSpinner !== false;
          writeStatus.call(this, this.t(i18n.alreadyRunning), spinner);
          this[names.start](jobId);
        }
      } catch (e) {
        console.error(`[${names.toggle || 'toggle-' + cfg.name}] active-job check:`, e);
      }
    }
  };

  const methods = {};
  if (names.start)  methods[names.start]  = startPoll;
  if (names.run)    methods[names.run]    = run;
  if (names.toggle) methods[names.toggle] = toggle;
  return methods;
}

// Generische Job-Infrastruktur: Polling, Wiederaufnahme nach Tab-Wechsel,
// Job-Queue-Sichtbarkeit. Von jedem Feature-Modul via `this.` referenziert.
export const appJobsCoreMethods = {
  // Root-Wrapper: delegiert an die pure Helper (cards/job-helpers.js). Karten
  // können die Funktionen auch direkt nutzen.
  _startPoll(config) {
    return _startPollFn(this, config);
  },

  _fmtTok(n) { return fmtTok(n || 0); },

  _runningJobStatus(statusText, tokIn, tokOut, maxTokOut, progress, tokPerSec, statusParams) {
    return _runningJobStatusFn(
      (k, p) => this.t(k, p),
      statusText, tokIn, tokOut, maxTokOut, progress, tokPerSec, statusParams,
    );
  },

  // Diff zwischen letztem und neuem `/jobs/queue`-Snapshot: jeder Job, der
  // verschwindet, ist done/error/cancelled. Final-Status nachladen + globales
  // `job:finished`-Event dispatchen → Konsumenten räumen Sidebar/History auch
  // dann auf, wenn kein per-Job-Poller (mehr) läuft (Reload, anderer Tab,
  // anderes Buch). Idempotent gegenüber per-Card-Pollern, die ggf. parallel
  // dasselbe `onDone` ausführen.
  _detectFinishedJobs(items) {
    const newMap = new Map(items.map(j => [j.id, { type: j.type, dedupId: j.dedupId, bookId: j.bookId }]));
    for (const [prevId, meta] of this._jobQueueIdsLastSeen) {
      if (!newMap.has(prevId)) this._fireJobFinished(prevId, meta);
    }
    this._jobQueueIdsLastSeen = newMap;
  },

  async _fireJobFinished(jobId, meta) {
    try {
      const resp = await fetch('/jobs/' + jobId);
      if (!resp.ok) return;
      const job = await resp.json();
      if (job.status !== 'done' && job.status !== 'error' && job.status !== 'cancelled') return;
      window.dispatchEvent(new CustomEvent(EVT.JOB_FINISHED, {
        detail: { type: meta.type, jobId, job, dedupId: meta.dedupId, bookId: meta.bookId },
      }));
    } catch { /* ignore */ }
  },

  // Root-Handler für `job:finished` — fängt die Reload-Lücke: User startet
  // Lektorat-Check auf Seite A, wechselt zu B, reloadet → A's per-Page-Poller
  // läuft nicht mehr, aber Server-Job geht durch. Disappearance-Detection
  // triggert hier markPageChecked, damit Sidebar live wird, ohne dass der User
  // die Quellseite wieder öffnen muss.
  _onJobFinished(detail) {
    if (!detail) return;
    const isCurrentBook = detail.bookId != null
      && String(detail.bookId) === String(this.$store.nav.selectedBookId);
    if (detail.type === 'check' && detail.job?.status === 'done') {
      const pageId = detail.dedupId;
      const r = detail.job.result || {};
      if (pageId != null && !r.empty) {
        const fehler = r.fehler || [];
        this.markPageChecked(pageId, { pending: fehler.length > 0 });
        if (this.currentPage?.id === pageId) this.loadPageHistory?.(pageId);
      }
      if (isCurrentBook) this.refreshPageAges?.();
    }
    // batch-check schreibt page_checks pro Seite serverseitig; eigener Per-Card-
    // Poller fehlt nach Reload/Buchwechsel/anderem Tab. Server-Map als SSoT nachladen.
    if (detail.type === 'batch-check' && detail.job?.status === 'done' && isCurrentBook) {
      this.refreshPageAges?.();
    }
    // komplett-analyse: der per-Buch-Poller (_startKomplettPoll.onDone) wird bei
    // Buchwechsel/Home/Reload abgerissen — dann ist er beim Job-Ende tot und die
    // obere Status-Leiste (komplett-status.html) bleibt auf „läuft" hängen, obwohl
    // die untere Queue über diese Disappearance-Detection korrekt aufräumt. Nur
    // greifen, wenn der Poller wirklich weg ist (`!_komplettPollTimer`) — sonst
    // erledigt onDone das reichere Reload und wir würden doppelt arbeiten.
    if (detail.type === 'komplett-analyse' && isCurrentBook && !this._komplettPollTimer) {
      this.$store.jobs.alleAktualisierenLoading = false;
      if (detail.job?.status === 'done') {
        this.$store.jobs.alleAktualisierenWarnings = Array.isArray(detail.job?.result?.warnings) ? detail.job.result.warnings : [];
        this.$store.jobs.alleAktualisierenCoverage = detail.job?.result?.coverage || null;
      }
      this.loadLastKomplettRun?.(this.$store.nav.selectedBookId);
    }
    this._maybeShowJobToast(detail);
  },

  // Job-Done-Toast. Whitelist langlaufender Job-Typen. Toast feuert auch dann,
  // wenn der User während des Jobs das Buch gewechselt hat oder die Karte
  // geschlossen war — Reload-/Buchwechsel-Lücken-Fix für komplett-analyse & Co.
  _maybeShowJobToast(detail) {
    if (!detail?.job) return;
    const job = detail.job;
    if (job.status === 'cancelled') return;
    const labels = {
      'komplett-analyse':      'toast.job.komplettAnalyse',
      'kontinuitaet':          'toast.job.kontinuitaet',
      'erzaehlprofil':         'toast.job.erzaehlprofil',
      'review':                'toast.job.review',
      'chapter-review':        'toast.job.kapitelReview',
      'check':                 'toast.job.check',
      'book-chat':             'toast.job.bookChat',
      'finetune-export':       'toast.job.finetuneExport',
      'pdf-export':            'toast.job.pdfExport',
      'docx-export':           'toast.job.docxExport',
      'batch-check':           'toast.job.batchCheck',
      'werkstatt-brainstorm':  'toast.job.werkstattBrainstorm',
      'werkstatt-consistency': 'toast.job.werkstattConsistency',
      'plot-brainstorm':       'toast.job.plotBrainstorm',
      'plot-consistency':      'toast.job.plotConsistency',
      'blog-import':           'toast.job.blogImport',
      'blog-pull':             'toast.job.blogPull',
      'blog-push':             'toast.job.blogPush',
      'blog-reconcile':        'toast.job.blogReconcile',
      'hubspot-import':        'toast.job.hubspotImport',
      'hubspot-push':          'toast.job.hubspotPush',
      'hubspot-reconcile':     'toast.job.hubspotReconcile',
      'book-import':           'toast.job.bookImport',
      'epub-export':           'toast.job.epubExport',
      'geocode-resolve':       'toast.job.geocodeResolve',
    };
    // Dedup: derselbe Job kann über den per-Card-Poller UND den Queue-Diff
    // terminal werden — Toast trotzdem genau einmal.
    if (!this.$store.jobs._toastedJobIds) this.$store.jobs._toastedJobIds = new Set();
    const jobId = job.id ?? detail.jobId;
    if (jobId != null) {
      if (this.$store.jobs._toastedJobIds.has(jobId)) return;
      this.$store.jobs._toastedJobIds.add(jobId);
    }
    const labelKey = labels[detail.type];
    const isError = job.status !== 'done';
    // Errors immer toasten — auch für Job-Typen ohne explizites Label
    // (z.B. synonyme, lektorat-single). Sonst landet AI_UNREACHABLE nur im Log.
    if (!labelKey && !isError) return;
    const severity = isError ? 'err' : 'ok';
    const suffixKey = isError ? 'toast.job.failed' : 'toast.job.done';
    const label = labelKey ? this.t(labelKey) : (detail.type || this.t('toast.job.fallback'));
    const suffix = this.t(suffixKey);
    let message = `${label} ${suffix}`;
    if (isError && job.error) {
      const detailText = this.t(job.error, job.errorParams || {});
      if (detailText && detailText !== job.error) message += `: ${detailText}`;
      else if (job.error) message += `: ${job.error}`;
    }
    this._showJobToast({ message, severity, jobType: detail.type, bookId: detail.bookId ?? null });
  },

  _showJobToast({ message, severity, jobType, bookId }) {
    if (this.$store.jobs._jobToastTimer) { clearTimeout(this.$store.jobs._jobToastTimer); this.$store.jobs._jobToastTimer = null; }
    this.$store.jobs.jobToast = { message, severity, jobType, bookId };
    const ttl = severity === 'err' ? 9000 : 4500;
    this.$store.jobs._jobToastTimer = setTimeout(() => {
      this.$store.jobs.jobToast = null;
      this.$store.jobs._jobToastTimer = null;
    }, ttl);
  },

  _dismissJobToast() {
    if (this.$store.jobs._jobToastTimer) { clearTimeout(this.$store.jobs._jobToastTimer); this.$store.jobs._jobToastTimer = null; }
    this.$store.jobs.jobToast = null;
  },

  _startJobQueuePoll() {
    if (this.$store.jobs._jobQueueTimer) clearInterval(this.$store.jobs._jobQueueTimer);
    if (!this._jobQueueIdsLastSeen) this._jobQueueIdsLastSeen = new Map();
    this._jobQueueFailures = 0;
    const poll = () => this._pollJobQueue();
    poll();
    this.$store.jobs._jobQueueTimer = setInterval(poll, 5000);
    // Wakeup: Tab kommt aus Background. Counter resetten, sofort frisch pollen
    // (löscht den Banner, falls er fälschlich angezeigt wurde) und Polling
    // wieder starten, falls es nach 5 Fehlern eingestellt war.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      this._jobQueueFailures = 0;
      if (!this.$store.jobs._jobQueueTimer) this.$store.jobs._jobQueueTimer = setInterval(poll, 5000);
      poll();
    }, this._abortCtrl?.signal ? { signal: this._abortCtrl.signal } : false);
    // Sofort-Refresh: Feature-Module dispatchen `job:enqueued` nach POST,
    // damit der Footer den frischen Job nicht erst nach bis zu 5s sieht.
    window.addEventListener(EVT.JOB_ENQUEUED, () => poll());
  },

  async _pollJobQueue() {
    try {
      const items = await fetchJson('/jobs/queue');
      this._detectFinishedJobs(items);
      this.$store.jobs.jobQueueItems = items;
      this._jobQueueFailures = 0;
      if (this.$store.session.serverOffline) this.$store.session.serverOffline = false;
    } catch (e) {
      // Ein Setzer schlägt fehl, wenn der Server down ist oder die Session
      // abgelaufen ist – kein Grund für dauerndes Poll-Spam. Nach 2 Fehlern
      // in Folge den serverOffline-Banner zeigen, damit der User weiss warum
      // Aktionen gerade fehlschlagen. Nach 5 Fehlern Polling aussetzen; der
      // Banner bleibt, Reload-Button lädt neu.
      console.error('[jobQueuePoll]', e);
      // Hintergrund-Tab: Browser friert nach einigen Minuten Connections ein,
      // erste Fetches beim Wakeup schlagen fehl. Solche Fails dürfen weder
      // zählen noch das Polling stoppen – sonst false-positive Offline-Banner
      // sobald der User zum Tab zurückkehrt.
      if (document.hidden) return;
      this._jobQueueFailures = (this._jobQueueFailures || 0) + 1;
      if (this._jobQueueFailures >= 2 && !this.$store.session.serverOffline && !this.$store.session.sessionExpired) {
        this.$store.session.serverOffline = true;
      }
      if (this._jobQueueFailures >= 5 && this.$store.jobs._jobQueueTimer) {
        clearInterval(this.$store.jobs._jobQueueTimer);
        this.$store.jobs._jobQueueTimer = null;
      }
    }
  },

  async cancelJob(jobId) {
    try {
      const res = await fetch('/jobs/' + jobId, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
      this.$store.jobs.jobQueueItems = this.$store.jobs.jobQueueItems.filter(j => j.id !== jobId);
    } catch (e) {
      console.error('[cancelJob]', e);
      this.setStatus(this.t('app.jobCancelFailed'), false, 4000);
    }
  },

  async navigateToJob(job) {
    // Cross-Book-Klick: erst Buch wechseln (Reset + loadPages + Sub-Karten),
    // dann Ziel öffnen. Watcher unterdrücken, damit _maybeOpenBookOverview
    // nicht die unmittelbar folgende Ziel-Karte überlagert.
    if (job.bookId && String(job.bookId) !== String(this.$store.nav.selectedBookId)) {
      if (!this.$store.nav.books.some(b => String(b.id) === String(job.bookId))) return;
      this._applyingHash = true;
      try {
        this.$store.nav.selectedBookId = String(job.bookId);
        this._resetBookScopedState();
        await this.loadPages();
        await this._reloadVisibleBookCards();
      } finally {
        this._applyingHash = false;
      }
    }
    // Seiten-Lektorat: springt zur betroffenen Seite (dedupId = page_id).
    if (job.type === 'check') {
      const pageId = job.dedupId ?? job.bookId;
      const page = this.$store.nav.pages.find(p => String(p.id) === String(pageId));
      if (page) await this.selectPage(page);
      return;
    }
    // Kapitel-Bewertung: braucht die Kapitel-ID (dedupId) als Root-State,
    // Hash-Router + Sidebar lesen kapitelReviewChapterId als SSoT.
    if (job.type === 'chapter-review') {
      if (job.dedupId != null) this.kapitelReviewChapterId = String(job.dedupId);
      if (!this.showKapitelReviewCard) await this.toggleKapitelReviewCard();
      else this._scrollToCardByKey?.('kapitelReview');
      return;
    }
    // Batch-Lektorat: Sidebar/Tree-Ansicht (keine EXCLUSIVE_CARDS-Karte).
    if (job.type === 'batch-check') {
      if (this.toggleTreeCard) await this.toggleTreeCard();
      return;
    }
    // Figuren-Werkstatt: Draft (+ optional Knoten) selektieren.
    if (job.type === 'werkstatt-brainstorm' || job.type === 'werkstatt-consistency') {
      const dedup = String(job.dedupId ?? '');
      const [draftPart, knotenPart] = dedup.split('|');
      const draftId = parseInt(draftPart, 10);
      if (!draftId) return;
      if (!this.showFigurWerkstattCard) await this.toggleFigurWerkstattCard();
      window.dispatchEvent(new CustomEvent(EVT.FIGUR_WERKSTATT_SELECT, {
        detail: { draftId, knotenId: knotenPart || null },
      }));
      return;
    }
    // Generisch: zur Karte springen, die den Job-Output anzeigt. Nur öffnen
    // (bereits offen → nur hinscrollen), nicht toggeln — ein Sprung darf die
    // Zielkarte nie zuklappen. cardKey referenziert EXCLUSIVE_CARDS (SSoT für
    // flag + toggle). Typen ohne UI-Ziel (book-import, synonym, blog-*/
    // hubspot-*) fehlen bewusst — dort gibt es nichts anzuspringen.
    const cardKey = JOB_NAV_CARD[job.type];
    if (!cardKey) return;
    const entry = EXCLUSIVE_CARDS.find(c => c.key === cardKey);
    if (!entry) return;
    if (this[entry.flag]) this._scrollToCardByKey?.(cardKey);
    else if (this[entry.toggle]) await this[entry.toggle]();
  },

  // Prüft ob ein gespeicherter Job noch läuft und reconnected ggf.
  // onRunning(job, jobId) wird aufgerufen wenn der Job aktiv ist.
  async _reconnectJob(lsKey, onRunning) {
    const jobId = localStorage.getItem(lsKey);
    if (!jobId) return;
    try {
      const resp = await fetch('/jobs/' + jobId);
      if (resp.ok) {
        const job = await resp.json();
        if (job.status === 'running') { onRunning(job, jobId); return; }
      }
    } catch { /* ignore */ }
    localStorage.removeItem(lsKey);
  },

  // Prüft beim Laden eines Buchs ob noch ein Job aus einer früheren Session
  // läuft (z.B. Tab versehentlich geschlossen während Analyse lief). Karten
  // lauschen auf `job:reconnect { type, jobId, job, extra? }` und stellen
  // ihren Loading/Progress/Status-State selbst her.
  async checkPendingJobs(bookId) {
    await this._reconnectJob('lektorat_review_job_' + bookId, (job, jobId) => {
      if (canAutoOpenCard(this)) this.showBookReviewCard = true;
      window.dispatchEvent(new CustomEvent(EVT.JOB_RECONNECT, {
        detail: { type: 'review', jobId, job },
      }));
    });

    // Kapitel-Review: alle laufenden Jobs des Buchs reconnecten — die Card
    // hat per-Kapitel-Slot-State und akzeptiert N Reconnects. Probes parallel,
    // damit Tab-Reopen bei vielen Kapiteln nicht N serielle Roundtrips kostet.
    const chapterCandidates = [];
    for (const [index, item] of (this.$store.nav.tree || []).entries()) {
      if (item.type !== 'chapter' || item.solo) continue;
      const lsKey = `lektorat_chapter_review_job_${bookId}_${item.id}`;
      const jobIdLs = localStorage.getItem(lsKey);
      if (!jobIdLs) continue;
      chapterCandidates.push({ index, chapterId: item.id, lsKey, jobId: jobIdLs });
    }
    const chapterProbes = await Promise.all(chapterCandidates.map(async (c) => {
      try {
        const resp = await fetch('/jobs/' + c.jobId);
        if (resp.ok) {
          const job = await resp.json();
          if (job.status === 'running') return { ...c, job };
        }
      } catch { /* ignore */ }
      localStorage.removeItem(c.lsKey);
      return null;
    }));
    const winners = chapterProbes
      .filter(Boolean)
      .sort((a, b) => a.index - b.index);
    if (winners.length > 0) {
      if (canAutoOpenCard(this)) this.showKapitelReviewCard = true;
      for (const w of winners) {
        window.dispatchEvent(new CustomEvent(EVT.JOB_RECONNECT, {
          detail: { type: 'kapitel-review', jobId: w.jobId, job: w.job, extra: { chapterId: w.chapterId } },
        }));
      }
    }

    await this._reconnectJob('lektorat_figures_job_' + bookId, (job, jobId) => {
      this.$store.catalogUi.figurenLoading = true;
      this.$store.catalogUi.figurenProgress = job.progress || 0;
      if (canAutoOpenCard(this)) this.showFiguresCard = true;
      this.$store.catalogUi.figurenStatus = job.statusText ? this.t(job.statusText, job.statusParams) : this.t('common.analysisRunning');
      this.startFiguresPoll(jobId);
    });

    await this._reconnectJob('lektorat_batchcheck_job_' + bookId, (job, jobId) => {
      this.batchLoading = true;
      this.batchProgress = job.progress || 0;
      this.batchStatus = this._runningJobStatus(job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut, job.progress, job.tokensPerSec, job.statusParams);
      this.startBatchPoll(jobId);
    });

    // Quellen-Erkennung: ein Buch-Lauf dauert Minuten und kostet Token — ein
    // versehentliches F5 darf ihn nicht ins Leere laufen lassen. Die Karte
    // hängt sich wieder ans Polling und bekommt am Ende das Ergebnis.
    await this._reconnectJob('lektorat_source_detect_job_' + bookId, (job, jobId) => {
      if (canAutoOpenCard(this)) this.showSourcesCard = true;
      window.dispatchEvent(new CustomEvent(EVT.JOB_RECONNECT, {
        detail: { type: 'source-detect', jobId, job },
      }));
    });

    // Prüfen ob ein komplett-analyse Job vom Server noch läuft (z.B. Tab geschlossen)
    if (!this.$store.jobs.alleAktualisierenLoading) {
      try {
        const { jobId, status, progress, statusText, statusParams } = await fetchJson(
          `/jobs/active?type=komplett-analyse&book_id=${bookId}`
        );
        if (jobId && (status === 'running' || status === 'queued')) {
          this.$store.jobs.alleAktualisierenLoading = true;
          this.$store.jobs.alleAktualisierenProgress = progress || 0;
          this.$store.jobs.alleAktualisierenTokIn = 0;
          this.$store.jobs.alleAktualisierenTokOut = 0;
          this.$store.jobs.alleAktualisierenTps = null;
          this.$store.jobs.alleAktualisierenStatus = statusText ? this.t(statusText, statusParams) : this.t('komplett.running');
          this.showKomplettStatus = true;
          this._startKomplettPoll(jobId, bookId);
        }
      } catch { /* ignore — kein aktiver Komplett-Job oder offline */ }
    }
  },
};
