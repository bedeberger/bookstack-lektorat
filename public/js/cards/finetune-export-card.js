// Alpine.data('finetuneExportCard') — Sub-Komponente der Finetune-Export-Karte.
//
// State: Typ-Toggles, Längenfenster, Val-Split, Loading/Progress/Status, Stats,
// Job-ID (für Downloads).
// `showFinetuneExportCard` bleibt im Root (Hash-Router + Exklusivität).
//
// Lifecycle:
//   - $watch($root.showFinetuneExportCard): on-visible → Active-Job-Check.
//   - book:changed / view:reset: Poller stoppen, State leeren.
//   - job:reconnect (type='finetune-export'): Loading-State übernehmen.
//
// Default-Profil: Unsloth Studio + Ministral-3-8B-QLoRA auf 20-GB-GPU
// (z.B. RTX 4000 Ada). Ableitungen:
//   maxChars=4000    → p95 ≈ 1500 Tokens → passt in seq_len=4096
//   maxSeqTokens=4096 → Studio-Empfehlung für 20-GB-QLoRA
//   emitText=false   → Studio rendert das Chat-Template selbst auf Basis des
//                      gewählten Basemodells; ein vorgerenderter text-Feld-
//                      String würde kollidieren. Nur einschalten, wenn du
//                      mit einem CLI-Trainer arbeitest, der `dataset_text_field`
//                      erwartet.

import { finetuneExportMethods } from '../finetune-export.js';
import { createCardJobFeature } from './job-feature-card.js';

export function registerFinetuneExportCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('finetuneExportCard', () => ({
    finetuneTypeStyle:      true,
    finetuneTypeScene:      true,
    finetuneTypeDialog:     true,
    finetuneTypeAuthorChat: true,
    finetuneTypeCorrection: true,
    finetuneMinChars:     200,
    finetuneMaxChars:     4000,
    finetuneValSplit:     0.1,
    finetuneValSeed:      0,
    finetuneMaxSeqTokens: 4096,   // Sweet-Spot Ministral-3-8B-QLoRA @ 20 GB VRAM
    finetuneEmitText:     false,

    finetuneLoading:  false,
    finetuneProgress: 0,
    finetuneStatus:   '',
    finetuneJobId:    null,
    finetuneStats:    null,

    _finetunePollTimer: null,
    _onBookChanged: null,
    _onViewReset: null,
    _onJobReconnect: null,

    init() {
      this.$watch(() => window.__app.showFinetuneExportCard, async (visible) => {
        if (!visible) return;
        if (!window.__app.selectedBookId) return;
        await this._onVisibleFinetuneExport();
      });

      this._onBookChanged = () => {
        if (this._finetunePollTimer) { clearInterval(this._finetunePollTimer); this._finetunePollTimer = null; }
        this.finetuneLoading = false;
        this.finetuneProgress = 0;
        this.finetuneStatus = '';
        this.finetuneJobId = null;
        this.finetuneStats = null;
      };
      window.addEventListener('book:changed', this._onBookChanged);

      this._onViewReset = () => this._onBookChanged();
      window.addEventListener('view:reset', this._onViewReset);

      this._onJobReconnect = (e) => {
        const d = e.detail;
        if (d?.type !== 'finetune-export') return;
        const job = d.job;
        this.finetuneLoading = true;
        this.finetuneProgress = job.progress || 0;
        this.finetuneStatus = `<span class="spinner"></span>${
          job.statusText ? window.__app.t(job.statusText, job.statusParams) : window.__app.t('common.analysisRunning')
        }`;
        this.finetuneJobId = d.jobId;
        this.startFinetuneExportPoll(d.jobId);
      };
      window.addEventListener('job:reconnect', this._onJobReconnect);
    },

    destroy() {
      if (this._finetunePollTimer) { clearInterval(this._finetunePollTimer); this._finetunePollTimer = null; }
      if (this._onBookChanged)  window.removeEventListener('book:changed', this._onBookChanged);
      if (this._onViewReset)    window.removeEventListener('view:reset',  this._onViewReset);
      if (this._onJobReconnect) window.removeEventListener('job:reconnect', this._onJobReconnect);
    },

    ...finetuneExportMethods,

    ...createCardJobFeature({
      name: 'finetune-export',
      endpoint: '/jobs/finetune-export',
      timerProp: '_finetunePollTimer',
      methodNames: {
        start:     'startFinetuneExportPoll',
        run:       'runFinetuneExport',
        onVisible: '_onVisibleFinetuneExport',
      },
      fields: {
        show:     'showFinetuneExportCard',
        loading:  'finetuneLoading',
        progress: 'finetuneProgress',
        status:   'finetuneStatus',
      },
      i18n: {
        starting:       'finetune.starting',
        interrupted:    'job.interrupted',
        alreadyRunning: 'common.analysisAlreadyRunning',
      },
      progressResetDelay: 400,
      buildPayload() {
        this.finetuneStats = null;
        this.finetuneJobId = null;
        return {
          book_id: parseInt(window.__app.selectedBookId),
          book_name: window.__app.selectedBookName,
          types: {
            style:      !!this.finetuneTypeStyle,
            scene:      !!this.finetuneTypeScene,
            dialog:     !!this.finetuneTypeDialog,
            authorChat: !!this.finetuneTypeAuthorChat,
            correction: !!this.finetuneTypeCorrection,
          },
          min_chars:      Number(this.finetuneMinChars) || 200,
          max_chars:      Number(this.finetuneMaxChars) || 4000,
          val_split:      Number(this.finetuneValSplit) || 0,
          val_seed:       Number(this.finetuneValSeed)  || 0,
          max_seq_tokens: Number(this.finetuneMaxSeqTokens) || 0,
          emit_text:      !!this.finetuneEmitText,
        };
      },
      async onDone(job) {
        this.finetuneJobId = job.id;
        if (job.result?.empty) {
          this.finetuneStatus = window.__app.t('finetune.empty');
          this.finetuneStats = null;
          return;
        }
        this.finetuneStats = job.result?.stats || null;
        this.finetuneStatus = window.__app.t('finetune.done', {
          n: this.finetuneStats?.total ?? 0,
          train: this.finetuneStats?.train ?? 0,
          val: this.finetuneStats?.val ?? 0,
        });
      },
    }),
  }));
}
