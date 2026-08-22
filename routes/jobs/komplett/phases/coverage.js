'use strict';
// Coverage-Self-Audit (F2, nur Cloud-Klasse): misst den Extraktions-Recall an einer
// Kapitel-Stichprobe. Pro Sample bekommt das Modell den Kapiteltext + die bekannten
// Figuren-/Ort-Namen und meldet Wiedererkannte + Fehlende. Rein diagnostisch (kein
// DB-Schreibzugriff), non-critical. Läuft auf dem Extraktions-Tier.
const appSettings = require('../../../../lib/app-settings');
const { updateJob, toSystemBlocks, retryOnTransientAi, settledAll } = require('../../shared');
const { sampleChapters, computeCoverageScore } = require('../utils');
const { komplettMaxTokens } = require('./tokens');

// Gibt `{ score, erkannt, fehlend, missingFiguren, missingOrte, sampledChapters }` oder null.
async function runCoverageAudit(ctx, figurenNames, orteNames) {
  const { jobId, bookName, call, tok, log, prompts, sys, groups, groupOrder, coverageTier } = ctx;
  const n = Math.max(0, Math.min(20, parseInt(appSettings.get('ai.komplett.coverage_audit_chapters'), 10) || 0));
  if (n <= 0) return null;
  const samples = sampleChapters(groups, groupOrder, n);
  if (!samples.length) return null;
  updateJob(jobId, { statusText: 'job.phase.coverageAudit' });
  const cap = komplettMaxTokens(ctx.effectiveProvider);
  const results = await settledAll(samples.map(s => () => retryOnTransientAi(() => call(jobId, tok,
    prompts.buildCoverageAuditPrompt(bookName, s.name, s.chText, figurenNames, orteNames),
    toSystemBlocks(sys.SYSTEM_KOMPLETT_EXTRAKTION_BLOCKS), null, null, cap, 0.2, null,
    prompts.SCHEMA_COVERAGE_AUDIT, coverageTier,
  ), { log, label: `Coverage «${s.name}»` })), { concurrency: 3 });
  const ok = results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
  if (!ok.length) { log.warn('Coverage-Audit: keine auswertbare Stichprobe.'); return null; }
  const cov = computeCoverageScore(ok);
  log.info(`Coverage-Audit: Score ${cov.score == null ? 'n/a' : cov.score} (${cov.erkannt} erkannt, ${cov.fehlend} fehlend) über ${ok.length}/${samples.length} Kapitel.`);
  return { ...cov, sampledChapters: ok.length };
}

module.exports = { runCoverageAudit };
