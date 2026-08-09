'use strict';
const { aiSetting } = require('../../../lib/ai/profile');

// Modellname des effektiven Providers. Geht ueber das Profil-Overlay, NICHT direkt
// an die globalen Settings: der Name landet in jedem `cacheVersion`-String
// (`${_modelName(effectiveProvider)}:${PROMPTS_VERSION}`), und zwei Profile
// desselben Providers mit verschiedenen Modellen wuerden sich sonst Cache-Zeilen
// teilen — der `provider`-Anteil im PRIMARY KEY der Cache-Tabellen unterscheidet
// sie ja nicht. Ergebnis waere ein Treffer aus einem anderen Modell.
function _modelName(prov) {
  if (prov === 'ollama') return aiSetting('ollama', 'model') || 'llama3.2';
  if (prov === 'openai-compat') return aiSetting('openai-compat', 'model') || 'llama3.2';
  return aiSetting('claude', 'model') || 'claude-sonnet-4-6';
}

module.exports = { _modelName };
