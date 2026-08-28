// KI-Lauf-Historie: persistierte Brainstorm- und Consistency-Runs pro Draft.
// Server liefert kompakte Liste (ohne result_json); Detail wird beim Öffnen
// lazy geholt. Apply (Brainstorm) prüft beim Anwenden, ob knoten_id noch in
// der Mindmap existiert — Live-Run gegen mutierten Tree nach `werkstatt.error.knotenGone`.

import { fetchJson, tzOpts } from '../utils.js';
import { reattachWerkstattJob } from './job-poll.js';

export const runsMethods = {
  async loadRuns() {
    const app = window.__app;
    const sel = this.selectedDraft();
    if (!sel) {
      this.runs = { brainstorm: [], consistency: [] };
      this.runsLoadedDraftId = null;
      return;
    }
    // Re-Entry-Guard: bei schnellem Draft-Wechsel zwei parallele Fetches —
    // späterer würde sonst älteren ggf. überschreiben.
    const draftId = sel.id;
    this._runsLoadDraftId = draftId;
    this.runsLoading = true;
    try {
      const rows = await fetchJson(`/draft-figures/by-id/${draftId}/runs`);
      if (this._runsLoadDraftId !== draftId) return; // stale
      const brainstorm = [];
      const consistency = [];
      for (const r of (Array.isArray(rows) ? rows : [])) {
        if (r.kind === 'brainstorm') brainstorm.push(r);
        else if (r.kind === 'consistency') consistency.push(r);
      }
      this.runs = { brainstorm, consistency };
      this.runsLoadedDraftId = draftId;
    } catch (e) {
      if (this._runsLoadDraftId !== draftId) return;
      this.runs = { brainstorm: [], consistency: [] };
      this.errorMessage = app.t('werkstatt.error.runsLoad') || app.t('common.unknownError');
    } finally {
      if (this._runsLoadDraftId === draftId) this.runsLoading = false;
    }
  },

  // Textbeleg-Fundstelle (Consistency): Seitenname aus dem nav-Store auflösen
  // (das Frontend hat die Seitenliste des Buchs bereits geladen — der Job schickt
  // nur die page_id). Fallback auf ein generisches Label.
  belegPageLabel(pageId) {
    const p = (Alpine.store('nav').pages || []).find(x => String(x.id) === String(pageId));
    return (p && (p.name || p.page_name)) || window.__app.t('werkstatt.consistency.belegGeneric');
  },
  gotoBeleg(pageId) {
    if (pageId != null) window.__app.gotoPageById(pageId);
  },

  // Toggle: Klick auf aktiv markierten Eintrag schliesst Result; sonst Detail
  // laden und brainstormResult/consistencyResult füllen wie ein Live-Lauf.
  async openRun(runId, kind) {
    const app = window.__app;
    if (!runId) return;
    // Live-Job darf nicht überschrieben werden: onDone würde sonst nach
    // openRun nochmal drüber rendern → User sieht Result-Flicker.
    if (this.brainstormLoading || this.consistencyLoading) return;
    if (this.selectedRunId === runId) {
      this.selectedRunId = null;
      if (kind === 'brainstorm') this.brainstormResult = null;
      else this.consistencyResult = null;
      return;
    }
    try {
      const run = await fetchJson(`/draft-figures/runs/${runId}`);
      if (!run?.result) throw new Error('no result');
      if (run.kind === 'brainstorm') {
        this.brainstormResult = {
          knotenId: run.knoten_id,
          knotenPfad: run.knoten_pfad || '',
          vorschlaege: run.result.vorschlaege || [],
        };
        this.consistencyResult = null;
      } else if (run.kind === 'consistency') {
        this.consistencyResult = {
          konflikte: run.result.konflikte || [],
          fazit: run.result.fazit || '',
          textbelege: run.result.textbelege || [],
        };
        this.selectedKonfliktIdx = null;
        this.brainstormResult = null;
      }
      this.selectedRunId = run.id;
    } catch (e) {
      this.errorMessage = app.t('werkstatt.error.runLoad') || app.t('common.unknownError');
    }
  },

  async deleteRun(runId, kind) {
    const app = window.__app;
    if (!runId) return;
    const ok = await app.appConfirm({
      message: app.t('werkstatt.run.confirmDelete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await fetchJson(`/draft-figures/runs/${runId}`, { method: 'DELETE' });
      const next = (this.runs[kind] || []).filter(r => r.id !== runId);
      this.runs = { ...this.runs, [kind]: next };
      if (this.selectedRunId === runId) {
        this.selectedRunId = null;
        if (kind === 'brainstorm') this.brainstormResult = null;
        else this.consistencyResult = null;
      }
    } catch (e) {
      this.errorMessage = app.t('werkstatt.error.runDelete') || app.t('common.unknownError');
    }
  },

  // Beim Öffnen einer Figur prüfen, ob noch ein Brainstorm-/Consistency-Job
  // für diesen Draft auf dem Server läuft (Tab-Wechsel, Reload, Card-Reopen).
  // Ohne Reattach würde der Progress-Bar verschwinden, der Job aber im
  // Hintergrund weiterlaufen — Result landet dann nur in der Run-Historie.
  // jobQueueItems enthält dedupId + type; brainstorm-dedupId hat Format
  // "${draftId}|${knotenId}", consistency-dedupId ist die nackte draftId.
  async _reattachActiveJobs(draftId) {
    if (!draftId) return;
    const queued = window.Alpine?.store('jobs')?.jobQueueItems;
    let queue;
    try {
      queue = Array.isArray(queued) && queued.length > 0
        ? queued
        : await fetchJson('/jobs/queue');
    } catch { return; }
    if (!Array.isArray(queue)) return;
    const draftStr = String(draftId);

    if (!this._brainstormJobId && !this.brainstormLoading) {
      const bs = queue.find(j => j.type === 'werkstatt-brainstorm'
        && typeof j.dedupId === 'string'
        && j.dedupId.startsWith(draftStr + '|'));
      if (bs && this.selectedDraftId === draftId) reattachWerkstattJob(this, 'brainstorm', bs, draftId);
    }
    if (!this._consistencyJobId && !this.consistencyLoading) {
      const cs = queue.find(j => j.type === 'werkstatt-consistency'
        && String(j.dedupId) === draftStr);
      if (cs && this.selectedDraftId === draftId) reattachWerkstattJob(this, 'consistency', cs, draftId);
    }
  },

  formatRunDate(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      // Locale-Abbildung wie im Rest der App (num-input.js): de→de-CH, en→en-US.
      const locale = Alpine.store('shell').uiLocale === 'en' ? 'en-US' : 'de-CH';
      return d.toLocaleString(locale, tzOpts());
    } catch { return iso; }
  },
};
