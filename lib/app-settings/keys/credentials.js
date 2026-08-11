'use strict';
// Settings-Keys der Zugangsdaten OHNE Default. Getrennt von den uebrigen, weil
// sie eine eigene Regel tragen (siehe Kommentar unten).
// Teil der Registry — Deskriptor-Format und Regeln stehen in
// [../registry.js](../registry.js).

module.exports = {
  // --- Zugangsdaten ohne Default -------------------------------------------
  // Diese Keys tragen bewusst KEINEN Default: ein leerer String waere hier ein
  // gueltiger Wert und wuerde "nicht konfiguriert" von "absichtlich leer" nicht
  // unterscheiden. Bekannte Keys sind sie trotzdem (isKnownKey) und erscheinen
  // im Admin-UI, damit das Passwort-Feld einen Ziel-Key hat.
  'auth.google.client_id': { secret: true, env: [['GOOGLE_CLIENT_ID', v => String(v)]] },
  'auth.google.client_secret': { secret: true, env: [['GOOGLE_CLIENT_SECRET', v => String(v)]] },
  'auth.altcha.hmac_secret': { secret: true },
  'ai.claude.api_key': { secret: true, env: [['ANTHROPIC_API_KEY', v => String(v)]] },
  'stt.api_key': { secret: true },
  'tts.api_key': { secret: true },
  'image.api_key': { secret: true },
  'embed.api_key': { secret: true },
};
