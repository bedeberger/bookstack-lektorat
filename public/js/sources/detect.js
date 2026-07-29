// Quellen-Erkennung im Quellenverzeichnis: startet den Job `source-detect`,
// zeigt die Funde als Vorschlagsliste und uebernimmt sie einzeln in die
// Bibliothek. Wird in Alpine.data('sourcesCard') gespreadet
// (public/js/cards/sources-card.js).
//
// VORSCHLAGEND, NICHT SCHREIBEND — in zwei Richtungen: der Job fasst den
// Buchtext nicht an (er setzt insbesondere keine Quellen-Marker, das bleibt die
// Sache des Autors im Editor), und ein Fund wird erst zur Quelle, wenn der
// Autor ihn uebernimmt. Bis dahin lebt er nur im Job-Ergebnis.
//
// Der Job liefert zu jedem Fund `verified` (im Register bestaetigt) und
// `existing_source_id` (steht schon in der Bibliothek). Beides ist Anzeige, kein
// Filter: auch ein unbestaetigter Fund ist uebernehmbar, er ist nur mit Vorsicht
// zu geniessen.
//
// Ein Lauf ueberlebt den Reload: der Job historisiert ihn (source_detect_runs),
// die Liste unter dem Panel oeffnet ihn wieder. Der Bibliotheks-Status kommt
// dabei frisch vom Server — seit dem Lauf kann uebernommen, geloescht oder
// zugeordnet worden sein.

import { fetchJson, tzOpts, localeTag } from '../utils.js';
import { startPoll } from '../cards/job-helpers.js';
import { draftToPayload, draftFromSource } from './fields.js';

// Reconnect-Anker: ueberlebt den Reload, damit ein laufender Buch-Lauf nach
// F5 weiterverfolgt wird (app-jobs-core.js#checkPendingJobs liest denselben Key).
const DETECT_LS_KEY = bookId => `lektorat_source_detect_job_${bookId}`;

export const sourcesDetectMethods = {
  // ── Panel ──────────────────────────────────────────────────────────────────
  toggleSourceDetect() {
    this.srcDetectOpen = !this.srcDetectOpen;
    if (!this.srcDetectOpen) return;
    this.closeSourcePicker();
    // Historie erst beim Aufklappen holen — die Karte oeffnet oft, ohne dass
    // die Erkennung ueberhaupt gebraucht wird.
    this.loadDetectRuns();
  },

  closeSourceDetect() {
    this.srcDetectOpen = false;
  },

  /** Kapitel-Auswahl fuer den Scope. Leerer Wert = ganzes Buch. Unterkapitel
   *  sind eingerueckt, aber einzeln waehlbar — der Job nimmt zu einem Kapitel
   *  ohnehin seine Unterkapitel mit. */
  srcDetectChapterOptions() {
    const tree = window.Alpine?.store('nav')?.tree || [];
    const out = [];
    const walk = (items, depth) => {
      for (const it of items) {
        if (it.type !== 'chapter' || it.solo) continue;
        out.push({ value: String(it.id), label: '— '.repeat(depth) + it.name });
        if (it.subchapters?.length) walk(it.subchapters, depth + 1);
      }
    };
    walk(tree, 0);
    return out;
  },

  // ── Lauf ───────────────────────────────────────────────────────────────────
  async runSourceDetect() {
    const bookId = window.Alpine?.store('nav')?.selectedBookId;
    if (!bookId || this.srcDetectRunning) return;
    this.srcDetectRunning = true;
    this.srcDetectError = '';
    this.srcDetectProgress = 0;
    this.srcDetectStatus = window.__app.t('sources.detect.starting');
    this.srcDetected = [];
    this.srcDetectMeta = null;
    try {
      const body = { book_id: bookId };
      if (this.srcDetectChapterId) body.chapter_id = Number(this.srcDetectChapterId);
      const { jobId } = await fetchJson('/jobs/source-detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      localStorage.setItem(DETECT_LS_KEY(bookId), jobId);
      this._pollSourceDetect(jobId);
    } catch (e) {
      this._srcDetectIdle();
      this.srcDetectError = window.__app.t('sources.detect.error');
    }
  },

  /** Polling eines laufenden Laufs. Geteilt zwischen frischem Start und dem
   *  Reconnect nach einem Reload (app-jobs-core.js#checkPendingJobs). */
  _pollSourceDetect(jobId) {
    const bookId = window.Alpine?.store('nav')?.selectedBookId;
    startPoll(this, {
      timerProp: '_srcDetectPollTimer',
      jobId,
      lsKey: DETECT_LS_KEY(bookId),
      progressProp: 'srcDetectProgress',
      onProgress: (job) => {
        this.srcDetectStatus = window.__app.t(job.statusText, job.statusParams);
      },
      onDone: (job) => {
        this._srcDetectIdle();
        this.srcDetected = Array.isArray(job.result?.vorschlaege) ? job.result.vorschlaege : [];
        this.srcDetectRan = true;
        this.srcDetectMeta = {
          verified: job.result?.verified || 0,
          lookupSkipped: job.result?.lookupSkipped || 0,
          scopeName: job.result?.scopeName || null,
        };
        // Frischen Lauf sofort als ausgewaehlt markieren + Historie nachziehen.
        this.srcDetectRunId = job.result?.runId || null;
        this.loadDetectRuns();
      },
      onNotFound: () => {
        this._srcDetectIdle();
        this.srcDetectError = window.__app.t('sources.detect.interrupted');
      },
      onError: (job) => {
        this._srcDetectIdle();
        this.srcDetectError = window.__app.t(job.error, job.errorParams);
      },
    });
  },

  /** Reconnect nach Reload: Loading-State wiederherstellen und weiterpollen. */
  reconnectSourceDetect(job, jobId) {
    this.srcDetectOpen = true;
    this.srcDetectRunning = true;
    this.srcDetectProgress = job?.progress || 0;
    this.srcDetectError = '';
    this.srcDetectStatus = window.__app.t(job?.statusText || 'common.analysisRunning', job?.statusParams);
    this._pollSourceDetect(jobId);
  },

  _srcDetectIdle() {
    this.srcDetectRunning = false;
    this.srcDetectProgress = 0;
    this.srcDetectStatus = '';
  },

  // ── Funde ──────────────────────────────────────────────────────────────────
  /** Autoren-/Jahr-Zeile eines Fundes fuer die Kopfzeile der Karte. */
  detectedByline(v) {
    const persons = (v?.authors || [])
      .map(p => p.family || p.literal || '')
      .filter(Boolean);
    const names = persons.length > 3 ? `${persons.slice(0, 3).join(', ')} u. a.` : persons.join(', ');
    return [names, v?.year].filter(Boolean).join(', ');
  },

  /** Uebernehmbar ist alles, was noch nicht in der Bibliothek steht. Memoized
   *  ueber den `_memo`-Helper der Karte (sources/manage.js) — die Methode steht
   *  zweimal im Template derselben Zeile (Button-Label + `:disabled`). */
  detectedAdoptable() {
    return this._memo('detectAdoptable', [this.srcDetected],
      () => (this.srcDetected || []).filter(v => !v.existing_source_id));
  },

  dismissDetected(v) {
    this.srcDetected = this.srcDetected.filter(x => x !== v);
  },

  gotoDetected(v) {
    if (v?.page_id == null) return;
    window.__app.gotoPageById(v.page_id);
  },

  /** Das Werk liegt schon im Pool, aber in einer anderen Arbeit: nur die
   *  Bruecke fehlt. Zuordnen statt neu anlegen — ein zweiter Pool-Eintrag
   *  waere eine Dublette, die der Autor spaeter doppelt pflegen muesste. */
  async linkDetected(v) {
    const bookId = window.Alpine?.store('nav')?.selectedBookId;
    if (!bookId || !v?.existing_source_id || v.existing_linked) return;
    this.sourcesBusy = true;
    this.srcDetectError = '';
    try {
      const r = await fetch(`/sources/${v.existing_source_id}/link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(window.__app.tError(data) || `HTTP ${r.status}`);
      }
      this.dismissDetected(v);
      await this.loadSources();
      this._sourcesChanged();
      this._flashSourcesSaved();
    } catch (e) {
      this.srcDetectError = e.message;
    } finally {
      this.sourcesBusy = false;
    }
  },

  /** Fund → Quelle. Der Entwurf laeuft durch dieselbe Feld-Normalisierung wie
   *  das Formular (fields.js), damit hier kein zweiter Payload-Bauer entsteht. */
  async adoptDetected(v) {
    const bookId = window.Alpine?.store('nav')?.selectedBookId;
    if (!bookId || !v || v.existing_source_id) return;
    this.sourcesBusy = true;
    this.srcDetectError = '';
    try {
      await this._postDetected(v, bookId);
      this.dismissDetected(v);
      await this.loadSources();
      this._sourcesChanged();
      this._flashSourcesSaved();
    } catch (e) {
      this.srcDetectError = e.message;
    } finally {
      this.sourcesBusy = false;
    }
  },

  /** Alle offenen Funde uebernehmen. Ein Fehler stoppt den Lauf NICHT — sonst
   *  bliebe bei einem kollidierenden Zitierschluessel der halbe Stapel liegen,
   *  ohne dass erkennbar waere, was durchging. Was scheitert, bleibt in der
   *  Liste stehen und wird am Ende gezaehlt. */
  async adoptAllDetected() {
    const bookId = window.Alpine?.store('nav')?.selectedBookId;
    const offen = this.detectedAdoptable();
    if (!bookId || !offen.length || this.sourcesBusy) return;
    if (!await window.__app.appConfirm({
      message: window.__app.t('sources.detect.confirmAdoptAll', { n: offen.length }),
    })) return;

    this.sourcesBusy = true;
    this.srcDetectError = '';
    let ok = 0;
    const failed = [];
    for (const v of offen) {
      try {
        await this._postDetected(v, bookId);
        ok++;
      } catch (e) {
        failed.push(v);
      }
    }
    this.srcDetected = this.srcDetected.filter(v => v.existing_source_id || failed.includes(v));
    this.sourcesBusy = false;
    if (failed.length) this.srcDetectError = window.__app.t('sources.detect.adoptPartial', { ok, failed: failed.length });
    await this.loadSources();
    this._sourcesChanged();
    if (ok) this._flashSourcesSaved();
  },

  async _postDetected(v, bookId) {
    const draft = draftFromSource({
      csl_type: v.csl_type,
      authors: v.authors || [],
      editors: [],
      title: v.title,
      container_title: v.container_title,
      publisher: v.publisher,
      place: v.place,
      year: v.year,
      edition: v.edition,
      volume: v.volume,
      issue: v.issue,
      pages: v.pages,
      doi: v.doi,
      isbn: v.isbn,
      issn: v.issn,
      url: v.url,
    });
    const payload = { ...draftToPayload(draft), book_id: bookId };
    const r = await fetch('/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      throw new Error(window.__app.tError(data) || `HTTP ${r.status}`);
    }
    return r.json().catch(() => ({}));
  },

  // ── Lauf-Historie ──────────────────────────────────────────────────────────
  // Ein Lauf kostet Minuten und Token; die Historie macht ihn wieder auffindbar,
  // nachdem der Tab zu war. Die Liste kommt ohne Fundliste (Kopfzeilen), das
  // Ergebnis erst beim Oeffnen.
  async loadDetectRuns() {
    const bookId = window.Alpine?.store('nav')?.selectedBookId;
    if (!bookId) { this.srcDetectRuns = []; return; }
    try {
      const rows = await fetchJson(`/jobs/source-detect/runs?book_id=${encodeURIComponent(bookId)}`);
      this.srcDetectRuns = Array.isArray(rows) ? rows : [];
    } catch (e) {
      this.srcDetectRuns = [];
      console.error('[sources] Lauf-Historie fehlgeschlagen:', e);
    }
  },

  /** Toggle: Klick auf den offenen Lauf schliesst ihn, sonst laden. Waehrend
   *  eines laufenden Jobs gesperrt — sonst ueberschreibt der Lauf beim
   *  Fertigwerden die gerade geoeffnete Historie. */
  async openDetectRun(run) {
    if (!run || this.srcDetectRunning) return;
    if (this.srcDetectRunId === run.id) {
      this.srcDetected = [];
      this.srcDetectRunId = null;
      this.srcDetectMeta = null;
      return;
    }
    this.srcDetectError = '';
    try {
      const detail = await fetchJson(`/jobs/source-detect/runs/${run.id}`);
      // Der Server hat den Bibliotheks-Status beim Lesen frisch gerechnet —
      // „schon erfasst" stimmt damit fuer JETZT, nicht fuer den Lauf-Zeitpunkt.
      this.srcDetected = detail?.result?.vorschlaege || [];
      this.srcDetectRunId = detail?.id || null;
      this.srcDetectRan = true;
      this.srcDetectMeta = {
        verified: detail?.verified_count || 0,
        lookupSkipped: 0,   // nur eine Eigenschaft des Laufs selbst, nicht des Wiederlesens
        scopeName: detail?.scope === 'chapter'
          ? (detail.scope_chapter_name || window.__app.t('sources.detect.chapterGone'))
          : null,
      };
    } catch (e) {
      this.srcDetectError = window.__app.t('sources.detect.runLoadError');
    }
  },

  async deleteDetectRun(run) {
    if (!run?.id) return;
    if (!await window.__app.appConfirm({
      message: window.__app.t('sources.detect.confirmDeleteRun'), danger: true,
    })) return;
    try {
      await fetchJson(`/jobs/source-detect/runs/${run.id}`, { method: 'DELETE' });
      this.srcDetectRuns = this.srcDetectRuns.filter(r => r.id !== run.id);
      if (this.srcDetectRunId === run.id) {
        this.srcDetected = [];
        this.srcDetectRunId = null;
        this.srcDetectMeta = null;
      }
    } catch (e) {
      this.srcDetectError = window.__app.t('sources.detect.runDeleteError');
    }
  },

  /** Kopfzeile eines Laufs: Zeitpunkt + Umfang. */
  detectRunLabel(run) {
    const scope = run?.scope === 'chapter'
      ? (run.scope_chapter_name || window.__app.t('sources.detect.chapterGone'))
      : window.__app.t('sources.detect.scopeBook');
    return `${this.formatDetectRunDate(run?.created_at)} · ${scope}`;
  },

  formatDetectRunDate(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString(localeTag(window.Alpine?.store('shell')?.uiLocale), tzOpts());
    } catch { return iso; }
  },
};
