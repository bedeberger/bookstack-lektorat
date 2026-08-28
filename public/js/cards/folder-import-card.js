// Alpine.data('folderImportCard') — die Import-Karte. Drei Import-Arten:
//   'diary'      ZIP mit YYYY/Monat/Tagesdatei      → /jobs/folder-import
//   'manuscript' EIN Word-/ODT-Dokument, nach Ueberschriften-Ebenen zerlegt
//                (Zuordnung h1..h6 → Kapitel/Unterkapitel/Seite/Fliesstext)
//                → /jobs/manuscript-import, Vorschau ueber …/preview
//   'swbook'     Buch-Migrations-Bundle             → /jobs/book-import
// Modes: 'new-book' (neues Buch anlegen) und 'merge' (in offenes Buch kippen).
// Datei-Upload als raw body, Job-Polling via startPoll.

import { setupCardLifecycle } from './card-lifecycle.js';
import { startPoll, runningJobStatus } from './job-helpers.js';
import { tzOpts, localeTag } from '../utils.js';

export function registerFolderImportCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('folderImportCard', () => ({
    // 'diary' = Tagebuch-ZIP (YYYY/Monat), 'manuscript' = EIN Dokument nach
    // Ueberschriften-Ebenen zerlegt, 'swbook' = Buch-Migration.
    importKind: 'diary',
    mode: 'new-book',
    grouping: 'year-month', // Kapitel-Gruppierung: 'year-month' | 'year' | 'flat'
    // Manuskript-Import: Rolle pro Ueberschriften-Ebene. Serverseitige SSoT der
    // erlaubten Rollen + Default ist lib/import-parsers/manuscript-split.js;
    // eine unbekannte Rolle faellt dort auf den Default zurueck.
    headingMap: { h1: 'chapter', h2: 'page', h3: 'content', h4: 'content', h5: 'content', h6: 'content' },
    keepHeadings: false,
    preview: null,
    previewBusy: false,
    bookName: '',
    file: null,
    fileName: '',
    fileSize: 0,
    busy: false,
    errorMessage: '',
    jobId: null,
    jobProgress: 0,
    jobStatusText: '',
    jobStatusParams: null,
    jobTokIn: 0,
    jobTokOut: 0,
    jobTokPerSec: null,
    result: null,
    _pollTimer: null,
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        name: 'folderImport',
        showFlag: 'showFolderImportCard',
        showNeedsBookId: false,
        onShow: () => {
          if (Alpine.store('nav').selectedBookId) {
            this.mode = 'merge';
          }
        },
        onViewReset: () => this.reset(),
      });
    },

    destroy() {
      this._lifecycle?.destroy();
      if (this._pollTimer) clearInterval(this._pollTimer);
    },

    reset() {
      this.file = null;
      this.fileName = '';
      this.fileSize = 0;
      this.preview = null;
      this.previewBusy = false;
      this.busy = false;
      this.errorMessage = '';
      this.jobId = null;
      this.jobProgress = 0;
      this.jobStatusText = '';
      this.jobStatusParams = null;
      this.jobTokIn = 0;
      this.jobTokOut = 0;
      this.jobTokPerSec = null;
      this.result = null;
    },

    setFile(f) {
      const isZip = /\.zip$/i.test(f.name) || f.type === 'application/zip' || f.type === 'application/x-zip-compressed';
      const isSwbook = /\.swbook$/i.test(f.name);
      const isDoc = /\.(docx|doc|odt|abw)$/i.test(f.name);
      let ok;
      if (this.importKind === 'swbook') ok = isSwbook || isZip;
      else if (this.importKind === 'manuscript') ok = isDoc;
      else ok = isZip;
      if (!ok) {
        this.errorMessage = window.__app.t(
          this.importKind === 'manuscript' ? 'folderImport.error.notDocument' : 'folderImport.error.notZip',
        );
        return;
      }
      this.file = f;
      this.fileName = f.name;
      this.fileSize = f.size;
      this.errorMessage = '';
      this.preview = null;
    },

    // Query-Form der Zuordnung — identische Serialisierung wie
    // serializeHeadingMap() auf dem Server (Position = h1..h6).
    _mapParam() {
      return ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map(l => this.headingMap[l]).join(',');
    },

    _manuscriptQuery(extra = {}) {
      const params = new URLSearchParams();
      params.set('filename', this.fileName);
      params.set('map', this._mapParam());
      if (this.keepHeadings) params.set('keep_headings', '1');
      for (const [k, v] of Object.entries(extra)) params.set(k, v);
      return params.toString();
    },

    // Vorschau: dieselbe Zerlegung, nur ohne zu schreiben. Kein KI-Call, darum
    // synchroner Endpunkt statt Job-Queue.
    async loadPreview() {
      if (!this.file || this.previewBusy) return;
      this.previewBusy = true;
      this.errorMessage = '';
      try {
        const buf = await this.file.arrayBuffer();
        const resp = await fetch('/jobs/manuscript-import/preview?' + this._manuscriptQuery(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: buf,
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          this.errorMessage = window.__app.t('folderImport.error.preview', { code: err.error_code || resp.status });
          this.preview = null;
          return;
        }
        this.preview = await resp.json();
      } catch (e) {
        this.errorMessage = window.__app.t('folderImport.error.preview', { code: e.message });
        this.preview = null;
      } finally {
        this.previewBusy = false;
      }
    },

    // Gliederung flach mit Tiefen-Angabe — ein x-for reicht, kein rekursives
    // Template (Alpine kann sich nicht selbst als Komponente einbinden).
    flattenOutline(nodes, depth = 0, out = []) {
      for (const n of (nodes || [])) {
        out.push({ ...n, depth });
        if (n.children?.length) this.flattenOutline(n.children, depth + 1, out);
      }
      return out;
    },

    get previewOutlineFlat() {
      return this.flattenOutline(this.preview?.outline);
    },

    get resultOutlineFlat() {
      return this.flattenOutline(this.result?.outline);
    },

    get headingCountList() {
      const counts = this.preview?.headingCounts || {};
      return Object.entries(counts)
        .filter(([, n]) => n > 0)
        .map(([lvl, n]) => ({ level: lvl.slice(1), n }));
    },

    get canSubmit() {
      if (!this.file || this.busy) return false;
      if (this.previewBusy) return false;
      if (this.importKind === 'swbook') return true; // Buch-Name + Owner kommen aus dem Bundle
      if (this.mode === 'new-book' && !this.bookName.trim()) return false;
      if (this.mode === 'merge' && !Alpine.store('nav').selectedBookId) return false;
      return true;
    },

    fmtLogTime(iso) {
      if (!iso) return '';
      const tag = localeTag(Alpine.store('shell').uiLocale);
      return new Date(iso).toLocaleTimeString(tag, tzOpts({ hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    },

    get runningStatusHtml() {
      if (!this.jobId) return '';
      return runningJobStatus(
        window.__app.t.bind(window.__app),
        this.jobStatusText,
        this.jobTokIn, this.jobTokOut, 0,
        this.jobProgress, this.jobTokPerSec, this.jobStatusParams,
      );
    },

    async submit() {
      if (!this.canSubmit) return;
      this.busy = true;
      this.errorMessage = '';
      this.result = null;
      let url;
      if (this.importKind === 'swbook') {
        url = '/jobs/book-import';
      } else if (this.importKind === 'manuscript') {
        const extra = { mode: this.mode };
        if (this.mode === 'new-book') extra.book_name = this.bookName.trim();
        else extra.book_id = String(Alpine.store('nav').selectedBookId);
        url = '/jobs/manuscript-import?' + this._manuscriptQuery(extra);
      } else {
        const params = new URLSearchParams();
        params.set('mode', this.mode);
        params.set('grouping', this.grouping);
        if (this.mode === 'new-book') params.set('book_name', this.bookName.trim());
        else params.set('book_id', String(Alpine.store('nav').selectedBookId));
        url = '/jobs/folder-import?' + params.toString();
      }
      try {
        const buf = await this.file.arrayBuffer();
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': this.importKind === 'manuscript' ? 'application/octet-stream' : 'application/zip' },
          body: buf,
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          this.errorMessage = window.__app.t('folderImport.error.upload', { code: err.error_code || resp.status });
          this.busy = false;
          return;
        }
        const { jobId } = await resp.json();
        this.jobId = jobId;
        this._startPolling();
      } catch (e) {
        this.errorMessage = window.__app.t('folderImport.error.upload', { code: e.message });
        this.busy = false;
      }
    },

    _startPolling() {
      startPoll(this, {
        timerProp: '_pollTimer',
        jobId: this.jobId,
        progressProp: 'jobProgress',
        intervalMs: 1500,
        onProgress: (job) => {
          this.jobStatusText = job.statusText || '';
          this.jobStatusParams = job.statusParams || null;
          this.jobTokIn = job.tokensIn || 0;
          this.jobTokOut = job.tokensOut || 0;
          this.jobTokPerSec = job.tokPerSec || null;
        },
        onNotFound: () => {
          this.busy = false;
          this.errorMessage = window.__app.t('folderImport.error.jobLost');
        },
        onError: (job) => {
          this.busy = false;
          this.errorMessage = window.__app.t('folderImport.error.jobFailed', { msg: job?.error || '' });
        },
        onDone: (job) => {
          this.busy = false;
          this.result = job.result || null;
          if (this.result?.bookId) {
            window.__app.loadBooks?.().then(() => {
              Alpine.store('nav').selectedBookId = this.result.bookId;
              location.hash = '#book/' + this.result.bookId;
            });
          }
        },
      });
    },
  }));
}
