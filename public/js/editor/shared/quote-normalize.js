// Anführungszeichen-Normalisierer für Notebook- + Focus-Editor (Facade).
//
// Setzt gerade `"` / `'` und alle typografischen Varianten (`„` `“` `”` `‚` `‘`
// `’` `«` `»` `‹` `›`) auf das Buch-Locale (book_settings.language + region) —
// und repariert dabei bereits falsch gesetzte Anführungszeichen, statt sie nur
// umzuschreiben. Apostrophe (`geht's`, `Chris'`, `'tis`) bleiben Apostrophe.
//
// Drei Scopes: `normalizeQuotes(rootEl, style)` seitenweit (Slash-Item Notebook
// + Focus-Topbar), `normalizeQuotesInRange(range, style)` für eine Selection
// (Bubble-Toolbar Notebook), `normalizeQuotesInHtml(html, style)` off-DOM für
// KI-Vorschläge vor dem Speichern.
//
// Submodule: `styles` (Locale-Tabelle + Zeichenklassen), `classify` (Apostroph
// vs. Öffner vs. Schliesser, Run-Auflösung), `walk` (DOM/Zeichenstrom),
// `api` (Buch-Locale laden + Scope wählen).

export { resolveQuoteStyle, STYLES } from './quote-normalize/styles.js';
export { normalizeQuotes, normalizeQuotesInRange, normalizeQuotesInHtml } from './quote-normalize/walk.js';
export { runQuoteNormalize, runQuoteNormalizeHtml } from './quote-normalize/api.js';
