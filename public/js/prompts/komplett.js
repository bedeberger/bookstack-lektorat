// Komplett-Pipeline-Prompts (Facade): Vollextraktion (Figuren/Orte/Fakten/Szenen/
// Lebensereignisse), Konsolidierungen (Figuren-Basis, Soziogramm, Orte, Songs, Zeitstrahl),
// Kontinuitätsprüfung. Interne Aufteilung in das gleichnamige komplett/-Subfolder:
//   schema-strings  – geteilte Schema-Text- und Regel-Bausteine
//   figuren         – Figuren-Konsolidierung, Beziehungen, Soziogramm
//   extraktion      – Vollextraktion-Schemas + System-/User-Prompts pro Pass
//   konsolidierung  – Zeitstrahl/Songs/Orte-Konsolidierung
//   kontinuitaet    – Kontinuitätsprüfung (Disambig, Fakten, Check, Single-Pass)
//   schemas         – dynamische + statische JSON-Schemas (_rebuildKomplettSchemas)

export { figurenBasisRules } from './komplett/schema-strings.js';

export {
  buildFiguresBasisConsolidationPrompt,
  buildKapiteluebergreifendeBeziehungenPrompt,
  buildFigurenBeziehungenExtraktionPrompt,
  buildSoziogrammConsolidationPrompt,
  buildAliasClusterPrompt,
} from './komplett/figuren.js';

export {
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
  buildCoverageAuditPrompt,
  buildTargetedFigurenPrompt,
  buildTargetedOrtePrompt,
  buildTargetedSzenenPrompt,
  buildNameResolutionPrompt,
} from './komplett/extraktion.js';

export {
  buildZeitstrahlConsolidationPrompt,
  buildSongsConsolidationPrompt,
  buildLocationsConsolidationPrompt,
  buildEntityMatchJudgePrompt,
} from './komplett/konsolidierung.js';

export {
  buildKontinuitaetChapterFactsPrompt,
  buildKontinuitaetCheckPrompt,
  buildKontinuitaetVerifyPrompt,
  buildKontinuitaetSinglePassPrompt,
  buildAttributeContradictionJudgePrompt,
  buildWeltfaktRealityJudgePrompt,
  SYSTEM_FAKTENCHECK,
} from './komplett/kontinuitaet.js';

export {
  buildErzaehlprofilSinglePassPrompt,
  buildErzaehlprofilChapterPrompt,
  buildAutorenBefundPrompt,
} from './komplett/erzaehlprofil.js';

export {
  _rebuildKomplettSchemas,
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
  SCHEMA_ENTITY_MATCH,
  SCHEMA_FAKT_REALITY,
  SCHEMA_NAME_RESOLUTION,
  SCHEMA_ERZAEHLPROFIL,
  SCHEMA_ERZAEHLPROFIL_CHAPTER,
  SCHEMA_AUTOREN_BEFUND,
} from './komplett/schemas.js';
