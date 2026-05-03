// Provider-Flag und JSON-Only-Pflicht – Single Source of Truth für alle Submodule.
// Für lokale Provider (ollama, llama) werden Prompts abgespeckt:
// - JSON_ONLY entfällt, weil lib/ai.js Grammar-Constrained JSON-Output erzwingt (format: 'json' / response_format).
// - commonRules wird durch eine kompakte Slim-Version ersetzt (siehe core.js).
// - Lektorat-Prompts droppen Beispiele, WICHTIG-Paragrafen und spezialisierte Fehler-Typen.
// - Komplett-Extraktions-Schema droppt lange Regeln (Schema bleibt, einzeilige Regeln statt Paragrafen).

export let _isLocal = false;

export function _setIsLocal(v) { _isLocal = !!v; }

// Unveränderliche technische Pflicht-Anweisung – darf nicht konfiguriert werden,
// da callAI() immer ein JSON-Objekt erwartet.
export const JSON_ONLY = 'Antworte ausschliesslich mit einem JSON-Objekt – kein Markdown, kein Text davor oder danach. Beginne deine Antwort direkt mit { und beende sie mit }.';

export function _jsonOnly() { return _isLocal ? '' : `\n\n${JSON_ONLY}`; }
