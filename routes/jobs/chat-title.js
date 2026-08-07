'use strict';
// Generiert einen kurzen, KI-zusammengefassten Titel für den History-Eintrag
// einer Chat-Session (Seiten-/Buch-/Recherche-Chat). Wird einmal pro Session
// erzeugt — beim ersten Antwort-Turn; danach via vorhandenem title-Feld
// übersprungen. Non-fatal: schlägt die Generierung fehl, bleibt title NULL und
// das Frontend fällt auf die Vorschau (erste Nachricht) zurück.

const { db } = require('../../db/schema');
const { callAI, parseJSON } = require('../../lib/ai');
const { getPromptsForProvider } = require('../../lib/prompts-loader');

const MAX_TITLE_LEN = 80;

/**
 * @param {object}  args
 * @param {object}  args.session          Session-Row (braucht id + title)
 * @param {string}  args.userMessage      Erste Userfrage der Session
 * @param {string}  args.assistantAnswer  Antwort der KI auf die erste Frage
 * @param {string}  args.provider         Effektiver Provider für den Titel-Call
 * @param {object} [args.logger]
 * @returns {Promise<string|null>}        Generierter Titel oder null (Fallback)
 */
async function generateSessionTitle({ session, userMessage, assistantAnswer, provider, logger }) {
  if (!session || session.title) return null;
  const uMsg = (userMessage || '').trim();
  if (!uMsg) return null;
  try {
    const { buildChatTitlePrompt, SCHEMA_CHAT_TITLE } = await getPromptsForProvider(provider);
    const systemPrompt = buildChatTitlePrompt();
    const convo = [
      `Nutzer: ${uMsg}`,
      (assistantAnswer || '').trim() ? `Assistent: ${assistantAnswer.trim()}` : null,
    ].filter(Boolean).join('\n\n').slice(0, 4000);

    // signal=null: der Titel-Call läuft NACH der gespeicherten Antwort und ist
    // bewusst nicht abbrechbar — ein Abbruch hier darf den bereits fertigen
    // Chat-Turn nicht als cancelled markieren.
    const { text, truncated } = await callAI(convo, systemPrompt, null, 120, null, provider, SCHEMA_CHAT_TITLE);
    if (truncated) throw new Error('Titel-Antwort truncated');
    const parsed = parseJSON(text);
    let titel = typeof parsed?.titel === 'string' ? parsed.titel.trim() : '';
    if (!titel) return null;
    // Umrahmende Anführungszeichen/Schlusspunkte abräumen, hart kappen.
    titel = titel.replace(/^[\s"'«»„“”]+|[\s"'«»„“”.]+$/g, '').slice(0, MAX_TITLE_LEN).trim();
    if (!titel) return null;
    db.prepare('UPDATE chat_sessions SET title = ? WHERE id = ?').run(titel, session.id);
    logger?.info?.(`Session-Titel generiert: «${titel}» (session=${session.id}).`);
    return titel;
  } catch (e) {
    logger?.warn?.(`Session-Titel-Generierung fehlgeschlagen: ${e.message}`);
    return null;
  }
}

module.exports = { generateSessionTitle };
