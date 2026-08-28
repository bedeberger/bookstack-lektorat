// Motiv-Werkstatt — Konsistenz (dritte Ansicht neben Konstellation und
// Verlaufsband). ZWEI Schichten, die in der Oberfläche getrennt bleiben:
// die MESSUNG (unten, deterministisch, kostenlos) und das KI-URTEIL (Job
// `motif-consistency`, knopfgesteuert, historisiert). Eine Messung darf nicht
// wie eine Modellmeinung aussehen und umgekehrt — darum die `quelle`-Plakette.
//
// Teil 1: die Messung. Deterministische MESSUNG, kein KI-Lauf: der Server rechnet die
// vom Autor gezogenen Motiv-Kanten gegen den Ist-Index (GET /motifs/consistency,
// pure Logik in lib/motif-consistency.js). Darum kein Job, kein Polling, keine
// Kosten — die Befunde kommen mit jedem Board-Load mit.
//
// Der Befund-Text lebt in den Locales (motiv.check.<code>), nicht im Server-
// Payload: der Server liefert `code` + `params`, der Betrachter bestimmt die
// Sprache (gleiche Regel wie persistierte Job-Status-Keys).

import { fetchJson } from '../../utils.js';
import { startPoll } from '../../cards/job-helpers.js';

export const consistencyMethods = {
  async loadMotifChecks() {
    const bookId = this.$store.nav.selectedBookId;
    if (!bookId) return;
    this.checksLoading = true;
    try {
      const data = await fetchJson(`/motifs/consistency?book_id=${bookId}`);
      this.checks = data.befunde || [];
      this.checksScanned = !!data.scanned;
    } catch (e) {
      // Non-fatal: die Befunde sind eine Zusatzsicht, kein Board-Blocker. Ein
      // Fehler darf weder den Graph noch das Verlaufsband verschlucken.
      this.checks = [];
      this.checksScanned = true;
    } finally {
      this.checksLoading = false;
    }
  },

  // Befund-Satz aus Code + Parametern. Motiv-/Partnername und der übersetzte
  // Kanten-Typ kommen aus dem Befund selbst, die Zahlen aus `params`.
  checkText(f) {
    const app = window.__app;
    return app.t('motiv.check.' + f.code, {
      motiv: f.motiv || '',
      partner: f.partner || '',
      typ: f.typ ? this.motifRelLabel(f.typ) : '',
      ...(f.params || {}),
    });
  },

  checkHint(f) {
    const app = window.__app;
    const key = 'motiv.check.' + f.code + '.hint';
    const label = app.t(key);
    return label === key ? '' : label;
  },

  checkSeverityLabel(f) {
    return window.__app.t('motiv.severity.' + f.schwere);
  },

  // Visuelle Klasse des Schwere-Chips. NICHT einfach `severity-tag--<schwere>`:
  // die geteilte Palette (entity-list.css) kodiert STÄRKE, nicht Schwere — dort
  // ist `stark` grün (starker Beleg = gut) und `schwach` rot. Für einen Befund
  // heisst `stark` aber „schwerwiegend"; ungemappt wäre der schlimmste Befund
  // grün und der harmloseste rot. Darum die Zuordnung hier explizit:
  // schwerwiegend → rot, mittel → amber, leicht → neutral.
  checkSeverityClass(f) {
    const map = {
      kritisch: 'severity-tag--kritisch',
      stark: 'severity-tag--kritisch',
      mittel: 'severity-tag--mittel',
      schwach: 'severity-tag--niedrig',
      niedrig: 'severity-tag--niedrig',
    };
    return map[f && f.schwere] || 'severity-tag--niedrig';
  },

  // Befund anklicken → Motiv in der Konstellation auswählen (und dorthin wechseln).
  gotoCheckMotif(f) {
    if (!f || f.motiv_id == null) return;
    this.setMotivView('graph');
    this.selectMotif(f.motiv_id);
  },

  // Kanten, zu denen ein Befund vorliegt — die Konstellation zeichnet sie als
  // Warnkante. Eine Menge statt einer Liste: der Graph fragt pro Kante einmal.
  checkedRelationIds() {
    return this._memo('checkedRelationIds', [this.checks], () =>
      new Set(this.checks.filter(f => f.relation_id != null).map(f => f.relation_id)));
  },

  // ── KI-Urteil (Job `motif-consistency`) ────────────────────────────────────
  // Die Messbefunde gehen serverseitig als Vorbefund in den Prompt; hier steht
  // nur der Anstoss + die Anzeige. Knopfgesteuert, kein Cron: es kostet Tokens.
  async runConsistency() {
    const bookId = this.$store.nav.selectedBookId;
    if (!bookId || this.consistencyRunning) return;
    if (!this.motifs.length) { this.errorMessage = window.__app.t('job.error.motivKatalogLeer'); return; }
    this.consistencyRunning = true;
    this.consistencyProgress = 0;
    this.errorMessage = '';
    try {
      const { jobId } = await fetchJson('/jobs/motif-consistency', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId }),
      });
      this.motivConsistencyJobId = jobId;
      startPoll(this, {
        timerProp: '_consistencyPollTimer',
        jobId,
        progressProp: 'consistencyProgress',
        onDone: (job) => {
          this.consistencyRunning = false;
          this.motivConsistencyJobId = null;
          this.consistencyResult = {
            konflikte: job.result?.konflikte || [],
            fazit: job.result?.fazit || '',
            scanned: job.result?.scanned !== false,
          };
          this.selectedConsistencyRunId = job.result?.runId || null;
          this.selectedKonfliktIdx = null;
          this.loadConsistencyRuns();
          this.setMotivView('checks');
        },
        onNotFound: () => { this.consistencyRunning = false; this.motivConsistencyJobId = null; },
        onError: () => {
          this.consistencyRunning = false;
          this.motivConsistencyJobId = null;
          this.errorMessage = window.__app.t('motiv.error.consistency');
        },
      });
    } catch (e) {
      this.consistencyRunning = false;
      this.errorMessage = window.__app.t('motiv.error.consistency');
    }
  },

  dismissConsistency() {
    this.consistencyResult = null;
    this.selectedConsistencyRunId = null;
    this.selectedKonfliktIdx = null;
  },

  // Befund → Motiv in der Konstellation. Übergreifende Befunde („—") haben kein
  // Ziel; die Fundstelle ist ein eigener Knopf (springt in den Buchtext).
  gotoKonfliktMotiv(k) {
    if (!k || k.motiv_id == null) return;
    this.setMotivView('graph');
    this.selectMotif(k.motiv_id);
  },

  konfliktSeverityLabel(k) {
    return window.__app.t('motiv.severity.' + k.schwere);
  },

  // Dieselbe Zuordnung wie bei den Messbefunden (siehe checkSeverityClass):
  // die geteilte Palette kodiert Stärke, nicht Schwere.
  konfliktSeverityClass(k) {
    return this.checkSeverityClass(k);
  },

  // ── Lauf-Historie ──────────────────────────────────────────────────────────
  async loadConsistencyRuns() {
    const bookId = this.$store.nav.selectedBookId;
    if (!bookId) { this.consistencyRuns = []; return; }
    try {
      const rows = await fetchJson(`/motifs/consistency-runs?book_id=${bookId}`);
      this.consistencyRuns = Array.isArray(rows) ? rows : [];
    } catch (e) { this.consistencyRuns = []; }
  },

  // Toggle wie die Brainstorm-Historie: Klick auf den offenen Lauf schliesst ihn.
  async openConsistencyRun(run) {
    if (!run || this.consistencyRunning) return;
    if (this.selectedConsistencyRunId === run.id) { this.dismissConsistency(); return; }
    try {
      const detail = await fetchJson(`/motifs/consistency-runs/${run.id}`);
      if (!detail?.result) throw new Error('no result');
      this.consistencyResult = {
        konflikte: detail.result.konflikte || [],
        fazit: detail.result.fazit || '',
        scanned: detail.result.scanned !== false,
      };
      this.selectedConsistencyRunId = detail.id;
      this.selectedKonfliktIdx = null;
    } catch (e) {
      this.errorMessage = window.__app.t('motiv.error.consistencyRunLoad');
    }
  },

  async deleteConsistencyRun(runId) {
    if (!runId) return;
    if (!await window.__app.appConfirm({ message: window.__app.t('motiv.consistency.confirmDeleteRun'), danger: true })) return;
    try {
      await fetchJson(`/motifs/consistency-runs/${runId}`, { method: 'DELETE' });
      this.consistencyRuns = this.consistencyRuns.filter(r => r.id !== runId);
      if (this.selectedConsistencyRunId === runId) this.dismissConsistency();
    } catch (e) {
      this.errorMessage = window.__app.t('motiv.error.runDelete');
    }
  },
};
