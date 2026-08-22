'use strict';
// Kosten-Buckets der Komplettanalyse (SSoT). Der Wert landet als `label` im
// Per-Call-Tier (normalizeTier in lib/ai/shared.js), von dort in `tok.byPhase`
// und via summarizeCostByPhase in `job.result.costByPhase`.
//
// SCHNITT NACH HEBEL, NICHT NACH FUNKTION: jeder Bucket entspricht genau einer
// Stellschraube, die der Betreiber drehen kann (Modell/Effort-Tier, ein
// completeness_passes/coverage_audit_chapters-Wert, ein Feature-Toggle). Wer die
// Aufschlüsselung liest, soll daraus ableiten können, WELCHE Einstellung er
// anfassen muss — nicht, welche Funktion gelaufen ist. Darum liegen z.B. P2,
// Alias-Cluster und Soziogramm-Refine in EINEM Bucket (alle drei hängen am
// Konsolidierungs-Modell), während Basis-Extraktion und Gap-Pässe getrennt sind
// (verschiedene Hebel: Extraktions-Tier vs. `ai.komplett.completeness_passes`).
//
// Ein Label ist NICHT bloss Diagnostik: es ist die einzige Stelle, an der sich
// belegen lässt, dass eine Tier-/Effort-Umstellung wirklich gespart hat. Calls
// ohne Label fallen in den Sammel-Bucket 'other' — der soll klein bleiben.
//
// PFLICHT bei einem neuen Label: Key `komplett.costPhase.<label>` in BEIDEN
// Locale-Dateien anlegen; sonst rendert die Karte den rohen Bucket-Namen.
// Gegated durch tests/unit/komplett-cost-labels.test.mjs.
const COST_LABEL = Object.freeze({
  // Phase 1, Basis: Chunk-Extraktion (Multi-Pass) bzw. der Single-Pass-Split
  // A1/B/C plus die Entitäten-Pässe E (Lebensereignisse) und A2 (Beziehungen).
  // Hebel: ai.claude.model.komplett.extract + ai.claude.effort.komplett.extract.
  extract: 'extract',
  // Phase 1, Nachziehen: Completeness-/Gap-Pässe (Single- und Multi-Pass) sowie
  // der Szenen-Backfill. Hebel: ai.komplett.completeness_passes bzw.
  // ai.komplett.scene_backfill. Läuft auf demselben Tier wie `extract` — der
  // eigene Bucket existiert, weil die Gap-Pässe die Call-Zahl der Phase
  // vervielfachen und damit ihren eigenen Hebel haben.
  extractGap: 'extractGap',
  // Vollständigkeits-Audit + der daraus gespeiste gezielte Nachzieh-Pass.
  // Hebel: ai.komplett.coverage_audit_chapters, ai.komplett.coverage_feedback.
  coverage: 'coverage',
  // Figuren-Konsolidierung (P2), Alias-Cluster, Soziogramm-Refine,
  // kapitelübergreifende Beziehungen (P3b). Hebel: Konsolidierungs-Modell/-Effort.
  figuren: 'figuren',
  // Orte-Konsolidierung (P3) + Songs. Hebel: Konsolidierungs-Modell/-Effort.
  orte: 'orte',
  // Zeitstrahl-Konsolidierung (P6).
  zeitstrahl: 'zeitstrahl',
  // Kontinuitätsprüfung (P8) inkl. Verify-Stufe und Attribut-Widerspruchs-Detektor.
  // Hebel: ai.komplett.attribute_check, Teil-Lauf `skip_continuity`.
  kontinuitaet: 'kontinuitaet',
  // Erzählprofil + Autoren-Befund. Hebel: ai.komplett.narrative_profile,
  // Teil-Lauf `skip_narrative_profile`.
  erzaehlprofil: 'erzaehlprofil',
  // Entitäten-Paar-Urteil beim Matching + Remap-Rescue — beide beurteilen nur
  // den Graubereich einer deterministischen Schicht.
  // Hebel: ai.komplett.entity_match_judge, ai.komplett.remap_rescue.
  match: 'match',
});

// Sammel-Bucket für Calls ohne Label (summarizeCostByPhase in
// routes/jobs/shared/ai.js). Hier nur als Konstante für den Drift-Test.
const COST_LABEL_FALLBACK = 'other';

/** Label-Tier für einen Call, der KEIN Modell-/Effort-Override braucht.
 *  Behaviour-neutral: normalizeTier liefert model/effort = undefined, damit
 *  bleibt es beim ALS-/Setting-Wert (siehe _callClaudeAttempt in lib/ai/claude.js). */
function costTier(label) {
  return { label };
}

/** Label-Variante eines bestehenden Tiers: Modell und Effort bleiben, nur der
 *  Kosten-Bucket wechselt. Für die Gap-/Coverage-Pässe, die auf dem
 *  Extraktions-Tier laufen, aber getrennt ausgewiesen werden. */
function relabel(tier, label) {
  return { ...(tier || {}), label };
}

module.exports = { COST_LABEL, COST_LABEL_FALLBACK, costTier, relabel };
