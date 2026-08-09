'use strict';
const appSettings = require('../../../../lib/app-settings');
const { getContextConfigFor, providerClass } = require('../../../../lib/ai');

/**
 * Output-Cap für Komplettanalyse-Calls (Extraktion + Konsolidierung), provider-abhängig.
 * Claude rechnet nur generierte Tokens ab — reserviertes max_tokens ist gratis — also
 * grosszügig aufs Provider-Ceiling deckeln (keine Retry-Ladder nötig).
 * CAVEAT (Opus 4.7+ mit adaptive thinking): Reasoning-Tokens zählen gegen dasselbe
 * max_tokens-Budget wie das sichtbare JSON. Bei sehr dichten Büchern kann das Reasoning
 * einen Teil des Caps verbrauchen → theoretisch erreicht das JSON das Ceiling doch
 * (stop_reason max_tokens → truncated). In der Praxis liegt Extraktions-JSON (≈20–40K Tokens)
 * weit unter dem 128K-Opus-Cap, der Fall ist also selten — aber NICHT strukturell ausgeschlossen.
 * Lokale Provider knapper auf das konfigurierte ai.komplett.extract_max_tokens (VRAM/Latenz),
 * gedeckelt aufs jeweilige Ceiling. aiCall deckelt selbst nochmal aufs Provider-Ceiling.
 */
function komplettMaxTokens(provider) {
  const ceiling = getContextConfigFor(provider).maxTokensOut;
  if (providerClass(provider) === 'cloud') return ceiling;
  const base = Math.max(1024, parseInt(appSettings.get('ai.komplett.extract_max_tokens'), 10) || 16000);
  return Math.min(base, ceiling);
}

module.exports = { komplettMaxTokens };
