// Alpine.store('config') — read-only Settings, die einmalig aus /config beim
// Boot gesetzt werden (app-init.js) und danach nicht mehr mutieren. Vorher flach
// in der Root-God-State; jetzt eine schmale, benannte Store-Oberfläche.
//
// Anders als die Laufzeit-Stores (catalog/nav/stt/tts) ist das hier reine
// Konfiguration. Konsumenten greifen direkt zu (kein Root-Proxy): Templates via
// `$store.config.languagetoolEnabled`, Karten via `this.$store.config.mapTiles`
// (orte-map.js) bzw. `ctx.$store.config.researchChatEnabled` (research-chat.js),
// app-init.js setzt beim Boot `this.$store.config.*`, der Spellcheck-Dispatcher
// watcht `() => app.$store.config.languagetoolEnabled` (Getter-Watch statt
// String-Pfad). Keine gemeinsame Präfix-Kürzung — die Keys tragen ihre Domäne
// selbst.
//
// Feld-Bedeutung:
//   mapTiles — Tile-Server der Orte-Karte (/config → app_settings geocode.tiles.*).
//             Leaflet holt die Kacheln direkt im Browser; attribution leer →
//             orte-map.js fällt auf den i18n-Default zurück. Default deckt den
//             Hard-Refresh ab, bevor /config geladen ist.
//   languagetoolEnabled — LT-Spellcheck-Master-Switch (/config `languagetool.enabled`,
//             true wenn Admin enabled + URL gesetzt). Editor-Templates lesen ihn
//             via `:spellcheck="!$app.languagetoolEnabled"`.
//   languagetoolDebounceMs — Debounce (ms) zwischen Eingabe und LT-Check im
//             Editor-Controller (/config `languagetool.debounce_ms`). Form-Felder
//             nutzen eigene Defaults und ignorieren den Wert.
//   researchChatEnabled — Recherche-Chat-Umschalter (/config `researchChat.enabled`,
//             true wenn effektiver Provider Claude + API-Key + Kill-Switch an).
//   semanticSearchEnabled — Semantik-Suche/„ähnliche Stellen"/Chat-Tool
//             `search_similar` (/config `semanticSearch.enabled`, true wenn
//             Embedding-Backend konfiguriert). Provider-unabhängig.
//   pdfMaxBytes — Upload-Limit fuer PDF-Anhaenge (Quelle + Recherche-Fundstueck),
//             /config `pdfUpload.maxBytes`. SSoT ist der Server
//             (lib/pdf-extract.js#MAX_INPUT_BYTES) — die Vorpruefung im Browser
//             darf keine eigene Zahl fuehren.
//   redundancyThresholds — Cosinus-Schwellen der drei Redundanz-Radar-Bänder
//             (strict/medium/loose, /config `redundancy.*`). Modellabhängig; der
//             Radar sendet den Wert des gewählten Bandes an /jobs/redundancy.
//   apiProvider — globaler KI-Provider ('claude'/'ollama'/'openai-compat'), aus
//             /config (globaler ai.provider, OHNE Per-User-Override). Steuert die
//             Provider-Anzeige im Avatar-Menü; configurePrompts liest den Wert
//             beim Boot separat aus cfg.
//   effectiveProvider — per-User aufgelöster Provider (Profil > global). Basis fürs
//             Claude-only-Gating dessen, was eine Anthropic-API-Fähigkeit braucht
//             (Recherche-Chat, Faktencheck).
//   effectiveProviderClass — Klasse desselben Providers ('cloud' | 'local', SSoT
//             lib/ai/config.js#providerClass). Basis fürs Modell-Klassen-Gating
//             (Kontinuität/Erzählprofil-Karten via `requiresCloudModel` in
//             feature-registry, _toggleCardGeneric-Guard).
//   claudeModel / claudeMaxTokens / ollamaModel / openaiCompatModel — Modell-IDs
//             + Output-Cap des jeweiligen Providers, rein fürs Avatar-Menü-Label.

export function registerConfigStore() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.store('config', {
    mapTiles: { url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '' },
    languagetoolEnabled: false,
    languagetoolDebounceMs: 1500,
    researchChatEnabled: false,
    semanticSearchEnabled: false,
    semanticHybrid: false,
    semanticRerank: false,
    redundancyThresholds: { strict: 0.88, medium: 0.82, loose: 0.76 },
    pdfMaxBytes: 25 * 1024 * 1024,
    factcheckEnabled: false,
    apiProvider: 'claude',
    effectiveProvider: 'claude',
    effectiveProviderClass: 'cloud',
    claudeModel: 'claude-sonnet-4-6',
    claudeMaxTokens: 64000,
    ollamaModel: 'llama3.2',
    openaiCompatModel: 'llama3.2',
  });
}
