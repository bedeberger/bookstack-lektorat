// Facade: re-exports aller Prompt-Submodule unter prompts/.
// Externer Zugriff (Frontend + Server) erfolgt ausschliesslich über diese Datei.
//
// configurePrompts() orchestriert die Reihenfolge:
//   1. _setIsLocal(provider) – Schemas und _jsonOnly() müssen den Flag kennen, bevor sie greifen
//   2. _rebuildLektoratSchema / _rebuildKomplettSchemas – Schemas neu mit aktuellem _isLocal
//   3. configureLocales(cfg) – baut SYSTEM_* via buildSystemKomplett* (ruft _jsonOnly intern)

import { _setIsLocal } from './prompts/state.js';
import { _rebuildLektoratSchema } from './prompts/lektorat.js';
import { _rebuildKomplettSchemas } from './prompts/komplett.js';
import { configureLocales, _setPromptsContentHash, _allLocalePromptsSnapshot } from './prompts/core.js';
import * as lektoratNs from './prompts/lektorat.js';
import * as lektoratTypenNs from './prompts/lektorat-typen.js';
import * as reviewNs from './prompts/review.js';
import * as komplettNs from './prompts/komplett.js';
import * as synonymNs from './prompts/synonym.js';
import * as tagebuchNs from './prompts/tagebuch.js';
import * as motivNs from './prompts/motiv.js';

// FNV-1a 32-bit über einen String → base36. Deterministisch, dependency-frei,
// in Browser + Node identisch. Zweck ist Cache-Busting, nicht Kryptografie:
// eine seltene Kollision verpasst nur eine Invalidierung (gleiche Risikoklasse
// wie der frühere manuelle Bump), während jede reale Änderung den Hash bewegt.
function _hashContent(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0).toString(36) + str.length.toString(36));
}

// Kanonischer Inhalt für den Versions-Hash: alle Locale-Prompts (alle Sprachen,
// SYSTEM_*-Cores inkl. eingebettetem Komplett-Schema) + die cache-gateten Schemas,
// die NICHT im Prompt-Text eingebettet sind (Lektorat/Review/Synonym).
//
// PFLICHT: hier müssen ALLE Schemas stehen, die als Grammar an einen Call gehen, dessen
// Ergebnis PERSISTENT gecacht wird (chapter_extract_cache/book_extract_cache: Phase-1-
// Extraktion inkl. Multi-Pass-Split-Pässe FIGUREN_PASS/ORTE_PASS; chapter_review_cache etc.).
// Eine isolierte Änderung NUR an einem hier fehlenden Schema würde den persistenten Cache
// nicht invalidieren → stale Extraktion. Konsolidierungs-/Kontinuitäts-Schemas (Zeitstrahl/
// Orte-Konsol/Songs/Soziogramm/Kontinuität-Check) sind bewusst NICHT gelistet: ihre Outputs
// werden pro Lauf frisch berechnet, nie persistent gecacht. Wer das ändert (eine Konsolidierung
// cachen), muss deren Schema + Regeltext hier nachziehen.
function _promptsContentHash() {
  const schemaPart = JSON.stringify([
    lektoratNs.SCHEMA_LEKTORAT,
    reviewNs.SCHEMA_REVIEW, reviewNs.SCHEMA_CHAPTER_ANALYSIS, reviewNs.SCHEMA_CHAPTER_REVIEW,
    komplettNs.SCHEMA_KOMPLETT_EXTRAKTION, komplettNs.SCHEMA_KOMPLETT_FIGUREN_STAMM,
    komplettNs.SCHEMA_KOMPLETT_FIGUREN_PASS,
    komplettNs.SCHEMA_KOMPLETT_ORTE_PASS, komplettNs.SCHEMA_KOMPLETT_FAKTEN_PASS,
    komplettNs.SCHEMA_KOMPLETT_EVENTS,
    komplettNs.SCHEMA_BEZIEHUNGEN,
    komplettNs.SCHEMA_FIGUREN_KONSOL, komplettNs.SCHEMA_KONTINUITAET_PROBLEME,
    // Erzählprofil: über den Konsolidierungs-Checkpoint (F5) effektiv gecacht — Schema-
    // Änderung muss die Cache-Version bumpen, sonst überspringt ein Folgelauf die Phase.
    komplettNs.SCHEMA_ERZAEHLPROFIL,
    // Autoren-Befund läuft in derselben Phase; Prompt-/Schema-Wechsel soll die
    // Erzählprofil-Phase über den Konsolidierungs-Checkpoint (F5) re-triggern.
    komplettNs.SCHEMA_AUTOREN_BEFUND,
    synonymNs.SCHEMA_SYNONYM,
    tagebuchNs.SCHEMA_RUECKBLICK,
    tagebuchNs.SCHEMA_RUECKBLICK_SYNTH,
    // Motiv-Brainstorm: seit dem Delta-Cache (motif_brainstorm_cache) persistent
    // gecacht — Schema-Änderung muss die Cache-Version (PROMPTS_VERSION) bumpen.
    motivNs.SCHEMA_MOTIV_BRAINSTORM,
  ]);
  // Lektorat-Typ-Profile: die Prompt-BODYS hängen an Call-Argumenten (buchtyp) und
  // fliessen darum nicht in den Locale-Snapshot. Ohne diese Signatur würde eine
  // Profil-Änderung den `lektorat_cache` eines wissenschaftlichen Buchs nicht
  // invalidieren – das Buch behielte seine narrativ geprägten Alt-Findings.
  return _hashContent(_allLocalePromptsSnapshot() + schemaPart + lektoratTypenNs.PROFIL_SIGNATUR);
}

/**
 * Pflichtaufruf beim App-Start. Wirft bei fehlender Config.
 * @param {Object} cfg        promptConfig-Objekt (aus prompt-config.json bzw. /config)
 * @param {string} [provider] 'claude' | 'ollama' | 'openai-compat' – Default: 'claude'.
 *   Bei 'ollama'/'openai-compat' werden die Prompts abgespeckt.
 */
export function configurePrompts(cfg, provider = 'claude') {
  if (!cfg) throw new Error('prompt-config.json fehlt oder ist ungültig – Prompts können nicht konfiguriert werden.');
  _setIsLocal(provider === 'ollama' || provider === 'openai-compat');
  _rebuildLektoratSchema();
  _rebuildKomplettSchemas();
  configureLocales(cfg);
  // Nach dem Bau aller Prompts + Schemas: PROMPTS_VERSION mit Content-Hash versehen,
  // damit Wortlaut-/Schema-/Config-Drift den persistenten Cache automatisch invalidiert.
  _setPromptsContentHash(_promptsContentHash());
}

export {
  PROMPTS_VERSION,
  ERKLAERUNG_RULE,
  KORREKTUR_REGELN,
  STOPWORDS,
  SYSTEM_LEKTORAT,
  SYSTEM_BUCHBEWERTUNG,
  SYSTEM_KAPITELANALYSE,
  SYSTEM_KAPITELREVIEW,
  SYSTEM_FIGUREN,
  SYSTEM_SYNONYM,
  SYSTEM_CHAT,
  SYSTEM_BOOK_CHAT,
  SYSTEM_ORTE,
  SYSTEM_KONTINUITAET,
  SYSTEM_ZEITSTRAHL,
  SYSTEM_KOMPLETT_EXTRAKTION,
  SYSTEM_KOMPLETT_FIGUREN_PASS,
  SYSTEM_KOMPLETT_ORTE_PASS,
  SYSTEM_KOMPLETT_FAKTEN_PASS,
  getLocalePromptsForBook,
  getBuchtypReviewSchwerpunkt,
} from './prompts/core.js';

export {
  buildLektoratPrompt,
  buildBatchLektoratPrompt,
  buildStilLektoratPrompt,
  buildLektoratSchema,
  SCHEMA_LEKTORAT,
} from './prompts/lektorat.js';

export {
  buildObjektivLektoratPrompt,
  buildObjektivLektoratSchema,
} from './prompts/lektorat-objektiv.js';

// Fehlertyp-Profile pro Buchtyp – SSoT auch für die Server-Seite (Validierung des
// AI-Outputs in routes/jobs/lektorat.js).
export {
  lektoratProfil,
  lektoratTypen,
  lektoratObjektivTypen,
  ALLE_LEKTORAT_TYPEN,
  STILISTISCHE_TYPEN,
  TYP_PRIORITAET,
} from './prompts/lektorat-typen.js';

export {
  buildBookReviewSinglePassPrompt,
  buildChapterAnalysisPrompt,
  buildChapterReviewPrompt,
  buildChapterReviewMultiPassPrompt,
  buildBookReviewMultiPassPrompt,
  SCHEMA_REVIEW,
  SCHEMA_CHAPTER_ANALYSIS,
  SCHEMA_CHAPTER_REVIEW,
} from './prompts/review.js';

export {
  figurenBasisRules,
  buildFiguresBasisConsolidationPrompt,
  buildKapiteluebergreifendeBeziehungenPrompt,
  buildFigurenBeziehungenExtraktionPrompt,
  buildSoziogrammConsolidationPrompt,
  buildAliasClusterPrompt,
  buildSystemKomplett,
  buildSystemKomplettFiguren,
  buildSystemKomplettFigurenStamm,
  buildSystemKomplettOrteSzenen,
  buildSystemKomplettFakten,
  buildSystemKomplettEvents,
  buildExtraktionKomplettChapterPrompt,
  buildExtraktionFigurenPassPrompt,
  buildExtraktionFigurenStammPrompt,
  buildExtraktionOrtePassPrompt,
  buildExtraktionFaktenPassPrompt,
  buildExtraktionEventsPassPrompt,
  buildFigurenStammGapPrompt,
  buildOrteGapPrompt,
  buildFaktenGapPrompt,
  buildSzenenGapPrompt,
  buildChunkGapPrompt,
  buildZeitstrahlConsolidationPrompt,
  buildLocationsConsolidationPrompt,
  buildSongsConsolidationPrompt,
  buildKontinuitaetChapterFactsPrompt,
  buildKontinuitaetCheckPrompt,
  buildKontinuitaetVerifyPrompt,
  buildKontinuitaetSinglePassPrompt,
  SCHEMA_KOMPLETT_EXTRAKTION,
  SCHEMA_KOMPLETT_FIGUREN_PASS,
  SCHEMA_KOMPLETT_FIGUREN_STAMM,
  SCHEMA_KOMPLETT_ORTE_PASS,
  SCHEMA_KOMPLETT_FAKTEN_PASS,
  SCHEMA_KOMPLETT_EVENTS,
  SCHEMA_FIGUREN_KONSOL,
  SCHEMA_BEZIEHUNGEN,
  SCHEMA_ORTE_KONSOL,
  SCHEMA_SONGS_KONSOL,
  SCHEMA_SOZIOGRAMM_KONSOL,
  SCHEMA_ZEITSTRAHL,
  SCHEMA_KONTINUITAET_FAKTEN,
  SCHEMA_KONTINUITAET_PROBLEME,
  SCHEMA_KONTINUITAET_VERIFY,
  SCHEMA_COVERAGE_AUDIT,
  SCHEMA_FIGUREN_ALIAS_CLUSTER,
  SCHEMA_ATTR_CONTRADICTION,
  SCHEMA_FAKT_REALITY,
  SCHEMA_NAME_RESOLUTION,
  buildCoverageAuditPrompt,
  buildTargetedFigurenPrompt,
  buildTargetedOrtePrompt,
  buildTargetedSzenenPrompt,
  buildNameResolutionPrompt,
  buildAttributeContradictionJudgePrompt,
  buildWeltfaktRealityJudgePrompt,
  SYSTEM_FAKTENCHECK,
  buildErzaehlprofilSinglePassPrompt,
  buildErzaehlprofilChapterPrompt,
  buildAutorenBefundPrompt,
  SCHEMA_ERZAEHLPROFIL,
  SCHEMA_ERZAEHLPROFIL_CHAPTER,
  SCHEMA_AUTOREN_BEFUND,
} from './prompts/komplett.js';

export {
  buildChatSystemPrompt,
  buildBookChatSystemPrompt,
  buildBookChatAgentSystemPrompt,
  buildChatTitlePrompt,
  BOOK_CHAT_TOOLS,
  BOOK_CHAT_FORCE_FINAL_INSTRUCTION,
  SCHEMA_CHAT,
  SCHEMA_BOOK_CHAT,
  SCHEMA_CHAT_TITLE,
} from './prompts/chat.js';

export {
  buildSynonymPrompt,
  SCHEMA_SYNONYM,
} from './prompts/synonym.js';

export {
  buildStilprofilPrompt,
  SCHEMA_STILPROFIL,
} from './prompts/stilprofil.js';

export {
  buildRueckblickPrompt,
  buildRueckblickReducePrompt,
  mergeRueckblickFacets,
  SCHEMA_RUECKBLICK,
  SCHEMA_RUECKBLICK_SYNTH,
} from './prompts/tagebuch.js';

export {
  buildBrainstormPrompt,
  buildConsistencyPrompt,
  SCHEMA_BRAINSTORM,
  SCHEMA_CONSISTENCY,
  WERKSTATT_SEVERITY_ENUM,
} from './prompts/figur-werkstatt.js';

export {
  buildPlotSystemPrompt,
  buildPlotBrainstormPrompt,
  buildPlotConsistencyPrompt,
  SCHEMA_PLOT_BRAINSTORM,
  SCHEMA_PLOT_CONSISTENCY,
  PLOT_SEVERITY_ENUM,
} from './prompts/plot.js';

export {
  buildMotivSystemPrompt,
  buildMotivBrainstormPrompt,
  SCHEMA_MOTIV_BRAINSTORM,
} from './prompts/motiv.js';

export {
  buildDateDetectPrompt,
  SCHEMA_DATE_DETECT,
} from './prompts/import.js';

export {
  buildSystemGeocodeResolve,
  buildGeocodeResolvePrompt,
  SCHEMA_GEOCODE_RESOLVE,
} from './prompts/geocode.js';

export {
  buildSystemResearchLink,
  buildResearchLinkPrompt,
  SCHEMA_RESEARCH_LINK,
  buildResearchChatAgentSystemPrompt,
  RESEARCH_CHAT_TOOLS,
  RESEARCH_CHAT_FORCE_FINAL_INSTRUCTION,
} from './prompts/recherche.js';

export {
  buildFinetuneAugmentSystem,
  buildFinetuneReversePromptsPrompt,
  buildFinetuneFactQAPrompt,
  buildFinetuneReasoningBackfillPrompt,
  SCHEMA_FT_REVERSE_PROMPTS,
  SCHEMA_FT_FACT_QA,
  SCHEMA_FT_REASONING,
} from './prompts/finetune.js';
