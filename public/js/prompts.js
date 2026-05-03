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
import { configureLocales } from './prompts/core.js';

/**
 * Pflichtaufruf beim App-Start. Wirft bei fehlender Config.
 * @param {Object} cfg        promptConfig-Objekt (aus prompt-config.json bzw. /config)
 * @param {string} [provider] 'claude' | 'ollama' | 'llama' – Default: 'claude'.
 *   Bei 'ollama'/'llama' werden die Prompts abgespeckt.
 */
export function configurePrompts(cfg, provider = 'claude') {
  if (!cfg) throw new Error('prompt-config.json fehlt oder ist ungültig – Prompts können nicht konfiguriert werden.');
  _setIsLocal(provider === 'ollama' || provider === 'llama');
  _rebuildLektoratSchema();
  _rebuildKomplettSchemas();
  configureLocales(cfg);
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
  SYSTEM_STILKORREKTUR,
  SYSTEM_SYNONYM,
  SYSTEM_CHAT,
  SYSTEM_BOOK_CHAT,
  SYSTEM_ORTE,
  SYSTEM_KONTINUITAET,
  SYSTEM_ZEITSTRAHL,
  SYSTEM_KOMPLETT_EXTRAKTION,
  SYSTEM_KOMPLETT_FIGUREN_PASS,
  SYSTEM_KOMPLETT_ORTE_PASS,
  getLocalePromptsForBook,
} from './prompts/core.js';

export {
  buildLektoratPrompt,
  buildBatchLektoratPrompt,
  buildStilkorrekturPrompt,
  SCHEMA_LEKTORAT,
  SCHEMA_STILKORREKTUR,
} from './prompts/lektorat.js';

export {
  buildBookReviewSinglePassPrompt,
  buildChapterAnalysisPrompt,
  buildChapterReviewPrompt,
  buildBookReviewMultiPassPrompt,
  SCHEMA_REVIEW,
  SCHEMA_CHAPTER_ANALYSIS,
  SCHEMA_CHAPTER_REVIEW,
} from './prompts/review.js';

export {
  figurenBasisRules,
  buildFiguresBasisConsolidationPrompt,
  buildKapiteluebergreifendeBeziehungenPrompt,
  buildSoziogrammConsolidationPrompt,
  buildSystemKomplett,
  buildSystemKomplettFiguren,
  buildSystemKomplettOrteSzenen,
  buildExtraktionKomplettChapterPrompt,
  buildExtraktionFigurenPassPrompt,
  buildExtraktionOrtePassPrompt,
  buildZeitstrahlConsolidationPrompt,
  buildLocationsConsolidationPrompt,
  buildKontinuitaetChapterFactsPrompt,
  buildKontinuitaetCheckPrompt,
  buildKontinuitaetSinglePassPrompt,
  SCHEMA_KOMPLETT_EXTRAKTION,
  SCHEMA_KOMPLETT_FIGUREN_PASS,
  SCHEMA_KOMPLETT_ORTE_PASS,
  SCHEMA_FIGUREN_KONSOL,
  SCHEMA_BEZIEHUNGEN,
  SCHEMA_ORTE_KONSOL,
  SCHEMA_SOZIOGRAMM_KONSOL,
  SCHEMA_ZEITSTRAHL,
  SCHEMA_KONTINUITAET_FAKTEN,
  SCHEMA_KONTINUITAET_PROBLEME,
} from './prompts/komplett.js';

export {
  buildChatSystemPrompt,
  buildBookChatSystemPrompt,
  buildBookChatAgentSystemPrompt,
  BOOK_CHAT_TOOLS,
  SCHEMA_CHAT,
  SCHEMA_BOOK_CHAT,
} from './prompts/chat.js';

export {
  buildSynonymPrompt,
  SCHEMA_SYNONYM,
} from './prompts/synonym.js';

export {
  buildFinetuneAugmentSystem,
  buildFinetuneReversePromptsPrompt,
  buildFinetuneFactQAPrompt,
  buildFinetuneReasoningBackfillPrompt,
  SCHEMA_FT_REVERSE_PROMPTS,
  SCHEMA_FT_FACT_QA,
  SCHEMA_FT_REASONING,
} from './prompts/finetune.js';
