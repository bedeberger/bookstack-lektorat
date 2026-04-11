// Figurenentwicklungsbögen-Methoden (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.

import { escHtml } from './utils.js';

export const charakterentwicklungMethods = {
  async toggleCharacterArcsCard() {
    if (this.showCharacterArcsCard) { this.showCharacterArcsCard = false; return; }
    this._closeOtherMainCards('characterArcs');
    this.showCharacterArcsCard = true;
    if (!this.figuren?.length) await this.loadFiguren();
    await this.loadCharacterArcs();
    // Prüfen ob bereits ein Job läuft
    if (!this._characterArcsPollTimer && !this.characterArcsLoading) {
      try {
        const { jobId } = await fetch(`/jobs/active?type=character-arcs&book_id=${this.selectedBookId}`).then(r => r.json());
        if (jobId) {
          this.characterArcsLoading = true;
          this.characterArcsProgress = 0;
          this.characterArcsStatus = 'Analyse läuft bereits…';
          this.startCharacterArcsPoll(jobId);
        }
      } catch (e) {
        console.error('[toggleCharacterArcsCard] active-job check:', e);
      }
    }
  },

  async loadCharacterArcs() {
    if (!this.selectedBookId) return;
    try {
      const data = await fetch('/figures/character-arcs/' + this.selectedBookId).then(r => r.json());
      this.characterArcs = data?.entwicklungsboegen || null;
      this.characterArcsUpdatedAt = data?.updated_at || null;
    } catch (e) {
      console.error('[loadCharacterArcs]', e);
    }
  },

  startCharacterArcsPoll(jobId) {
    const bookId = this.selectedBookId;
    this._startPoll({
      timerProp: '_characterArcsPollTimer',
      jobId,
      lsKey: 'lektorat_character_arcs_job_' + bookId,
      progressProp: 'characterArcsProgress',
      onProgress: (job) => {
        this.characterArcsStatus = this._runningJobStatus(job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut, job.progress);
      },
      onNotFound: () => {
        this.characterArcsLoading = false;
        this.characterArcsProgress = 0;
        this.characterArcsStatus = 'Analyse unterbrochen (Server-Neustart). Bitte neu starten.';
      },
      onError: (job) => {
        this.characterArcsLoading = false;
        this.characterArcsProgress = 0;
        this.characterArcsStatus = `<span class="error-msg">Fehler: ${escHtml(job.error)}</span>`;
      },
      onDone: async (job) => {
        this.characterArcsLoading = false;
        this.characterArcsProgress = 0;
        if (job.result?.empty) { this.characterArcsStatus = 'Keine Seiten gefunden.'; return; }
        await this.loadCharacterArcs();
        const count = job.result?.count || 0;
        this.characterArcsStatus = `${count} Entwicklungsbogen${count === 1 ? '' : 'bögen'} ermittelt.`;
      },
    });
  },

  async runCharacterArcsExtraction() {
    const bookId = this.selectedBookId;
    const bookName = this.selectedBookName;
    this.characterArcsLoading = true;
    this.characterArcsProgress = 0;
    this.characterArcsStatus = 'Starte Analyse…';
    this.characterArcs = null;
    try {
      const { jobId } = await fetch('/jobs/character-arcs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: parseInt(bookId), book_name: bookName }),
      }).then(r => r.json());
      localStorage.setItem('lektorat_character_arcs_job_' + bookId, jobId);
      this.startCharacterArcsPoll(jobId);
    } catch (e) {
      console.error('[runCharacterArcsExtraction]', e);
      this.characterArcsStatus = `<span class="error-msg">Fehler: ${escHtml(e.message)}</span>`;
      this.characterArcsLoading = false;
      this.characterArcsProgress = 0;
    }
  },

  // Gibt den arc_typ als lesbares Label zurück
  arcTypLabel(typ) {
    const map = {
      'Reifebogen': 'Reife',
      'Verfallsbogen': 'Verfall',
      'Erlösungsbogen': 'Erlösung',
      'Tragischer Bogen': 'Tragik',
      'Wandlungsbogen': 'Wandlung',
      'Stasis': 'Stasis',
    };
    return map[typ] || (typ || '');
  },

  // Gibt eine CSS-Klasse für den arc_typ zurück (für Farb-Badges)
  arcTypClass(typ) {
    const map = {
      'Reifebogen': 'arc-reife',
      'Verfallsbogen': 'arc-verfall',
      'Erlösungsbogen': 'arc-erloesung',
      'Tragischer Bogen': 'arc-tragik',
      'Wandlungsbogen': 'arc-wandlung',
      'Stasis': 'arc-stasis',
    };
    return map[typ] || 'arc-andere';
  },

  // Gibt die Figur-Daten zur fig_id aus dem figuren-Array zurück
  arcFigurData(figId) {
    return (this.figuren || []).find(f => f.id === figId) || null;
  },

  // Entwicklungsbögen gefiltert + sortiert
  characterArcsSorted() {
    if (!this.characterArcs) return [];
    const typOrder = ['Reifebogen', 'Verfallsbogen', 'Erlösungsbogen', 'Tragischer Bogen', 'Wandlungsbogen', 'Stasis'];
    return [...this.characterArcsFiltered].sort((a, b) => {
      const ta = typOrder.indexOf(a.arc_typ);
      const tb = typOrder.indexOf(b.arc_typ);
      return (ta === -1 ? 99 : ta) - (tb === -1 ? 99 : tb);
    });
  },
};
