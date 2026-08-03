// Alpine.store('jobs') — Job-Infrastruktur-State: Queue-Footer, globaler
// Job-Done-Toast und der „Alle aktualisieren"/Komplettanalyse-Pipeline-Status.
// Vorher flach in der Root-God-State; jetzt eine schmale, benannte
// Store-Oberfläche. Der Store-Name liefert den Namespace, darum tragen die Keys
// kein `jobs`-Präfix (Zugriff via `$store.jobs.jobToast`).
//
// Kein Root-Proxy-Spiegel (wie tts/collab): die in den Root gespreadeten
// Methoden (app/app-jobs-core.js, app/app-komplett.js, app-view/bookscope.js)
// greifen via `this.$store.jobs.*` zu; Templates (index.html Footer,
// komplett-status.html, job-toast.html, Entity-Partials) via `$store.jobs.*`;
// die puren Helper (cards/job-helpers.js, figur-werkstatt/runs.js) via
// `Alpine.store('jobs')`. Die Methoden (`alleAktualisieren`, `cancelJob`,
// `navigateToJob`, `_maybeShowJobToast`, …) bleiben am Root.
//
// Feld-Bedeutung:
//   jobQueueItems     — aktueller /jobs/queue-Snapshot (Footer-Pillen).
//   jobQueueExpanded  — Footer zeigt alle statt der ersten 3.
//   _jobQueueTimer    — 5s-Queue-Poll-Timer.
//   alleAktualisieren* — Komplettanalyse-Pipeline-Status (Loading/Progress/
//                     Token-Zähler/TPS/Pass-Modus/Status-Text/LastRun).
//   alleAktualisierenWarnings — Non-critical-Degradierungen aus dem letzten
//                     Komplettlauf (Job-Result.warnings): [{ key }], im
//                     Status-Panel als Hinweiszeilen gerendert.
//   jobToast          — globaler Job-Done-Toast { message, severity, jobType,
//                     bookId } | null. Gesetzt von `_maybeShowJobToast` für
//                     relevante Job-Typen. Zwei Auslösepfade: per-Card-Poller
//                     (`startPoll`) und Queue-Diff (`_onJobFinished`).
//   _jobToastTimer    — Auto-Dismiss-Timer des Toasts.
//   _toastedJobIds    — Dedup-Set, damit ein Job genau einmal toastet, egal
//                     welcher Pfad zuerst feuert.

export function registerJobsStore() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.store('jobs', {
    jobQueueItems: [],
    jobQueueExpanded: false,
    _jobQueueTimer: null,
    alleAktualisierenLoading: false,
    alleAktualisierenStatus: '',
    alleAktualisierenLastRun: null,
    alleAktualisierenProgress: 0,
    alleAktualisierenTokIn: 0,
    alleAktualisierenTokOut: 0,
    alleAktualisierenTps: null,
    alleAktualisierenPassMode: null,
    alleAktualisierenWarnings: [],
    alleAktualisierenCoverage: null,
    // Kosten-Aufschluesselung des letzten Laufs (job.result.costByPhase): zeigt neben
    // dem Coverage-Score, WO die Kosten entstanden sind (Extraktions-Tier vs. Rest).
    alleAktualisierenCost: null,
    jobToast: null,
    _jobToastTimer: null,
    _toastedJobIds: new Set(),
  });
}
