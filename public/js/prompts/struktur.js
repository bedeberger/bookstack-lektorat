// Struktur-Check journalistischer Beiträge.
//
// Prüft einen Text gegen den Soll-Katalog seiner Textsorte
// (prompts/textsorten.js#regeln) — nicht gegen Sprache. Das Lektorat sagt „der
// Satz ist schief", der Struktur-Check sagt „der Lead beantwortet nicht, wann
// es passiert ist". Beides ist rückwärtsgewandt und schreibt nie in den Text.
//
// Bewusst KEIN Fehlertyp im Lektorat: ein Strukturbefund hat kein «original»
// und keine «korrektur» — er bezieht sich auf den ganzen Text oder auf einen
// Baustein, nicht auf eine Textspanne. Er in das `fehler`-Array zu zwingen
// hiesse, die Zeichengenauigkeits-Invariante aufzuweichen, an der der ganze
// Apply-Pfad hängt.

// Die Rolle (SYSTEM_STRUKTUR) lebt wie alle System-Prompts in prompts/core.js
// und ist über `prompt-config.json` → `locales.<lang>.systemPrompts.struktur`
// überschreibbar; hier stehen nur der User-Prompt-Builder und das Schema.
import { _obj, _str } from './schema-utils.js';
import { _isLocal } from './state.js';
import {
  textsorteLabel, textsorteRegelnListe,
  STRUKTUR_STATUS, STRUKTUR_URTEILE, W_FRAGEN,
} from './textsorten.js';

/**
 * @param {string} text        Klartext des Beitrags
 * @param {object} opts
 * @param {string} opts.textsorte  Key aus prompts/textsorten.js
 * @param {string} [opts.pageName]
 * @param {string} [opts.chapterName]
 */
export function buildStrukturCheckPrompt(text, { textsorte = 'bericht', pageName = null, chapterName = null } = {}) {
  const label = textsorteLabel(textsorte);
  const regeln = textsorteRegelnListe(textsorte);
  const metaParts = [];
  if (chapterName) metaParts.push(`Rubrik: «${chapterName}»`);
  if (pageName)    metaParts.push(`Titel: «${pageName}»`);
  const metaBlock = metaParts.length ? `\nVerortung: ${metaParts.join(' · ')}\n` : '';

  return `<aufgabe>
Prüfe den unten stehenden Beitrag gegen die Formregeln seiner Textsorte. Die Textsorte ist: ${label}.
Gib für JEDE Regel ein Urteil ab — auch für die erfüllten. Der Wert des Berichts liegt darin, dass man sieht, was steht, nicht nur was fehlt.
Bewerte NUR den Aufbau. Sprachliche Mängel (Rechtschreibung, Grammatik, Stil, Wortwahl) gehören NICHT hierher und werden ignoriert.
</aufgabe>
${metaBlock}
<formregeln textsorte="${label}">
${regeln}
</formregeln>

REGELN FÜR DEINE ANTWORT:
- Zu jeder nummerierten Formregel genau EIN Eintrag in «regeln», in derselben Reihenfolge, mit derselben Nummer.
- «status»: «erfuellt» = die Regel ist eingehalten. «teilweise» = im Ansatz vorhanden, aber unvollständig. «fehlt» = nicht vorhanden. «nicht_anwendbar» = die Regel greift bei diesem Beitrag sachlich nicht (begründen!).
- «befund»: EIN Satz, konkret am Text. Nenne die Stelle, auf die du dich beziehst (Absatznummer oder ein kurzes wörtliches Zitat von höchstens acht Wörtern). Keine Allgemeinplätze wie «könnte besser sein».
- «massnahme»: nur bei «teilweise» und «fehlt» — EIN Satz, was der Beitrag braucht (welche Information, welcher Baustein). KEINE Formulierungsvorschläge, keine fertigen Sätze.
- Erfinde keine Angaben. Wenn eine Information im Text fehlt, ist genau das der Befund — ergänze sie nicht selbst.
- «fehlendeWFragen»: nur bei nachrichtlichen Formen relevant. Liste die W-Fragen, die der erste Absatz NICHT beantwortet, als Kleinbuchstaben-Keys: ${W_FRAGEN.join(', ')}. Sind alle beantwortet oder ist die Form nicht nachrichtlich: leeres Array.
- «gesamturteil»: «traegt» = die Form ist eingehalten, «lueckenhaft» = einzelne Bausteine fehlen, «verfehlt» = der Text erfüllt die Textsorte nicht.
- «zusammenfassung»: 2-3 Sätze zur Form des Beitrags. KEINE Wiederholung der Einzelbefunde aus «regeln», keine Sprachkritik.

<output_format>
Antworte mit diesem JSON-Schema:
{
  "gesamturteil": "${STRUKTUR_URTEILE.join('|')}",
  "regeln": [
    {
      "nr": 1,
      "status": "${STRUKTUR_STATUS.join('|')}",
      "befund": "EIN Satz, konkret am Text, mit Stellenangabe",
      "massnahme": "EIN Satz – nur bei teilweise/fehlt, sonst leerer String"
    }
  ],
  "fehlendeWFragen": ["wann", "warum"],
  "zusammenfassung": "2-3 Sätze zur Form – ohne die Einzelbefunde zu wiederholen"
}
</output_format>

<beitrag>
${text}
</beitrag>`;
}

/**
 * Schema des Struktur-Checks. `regelnCount` fixiert die erwartete Anzahl nicht
 * hart (JSON-Schema kann das bei lokalen Providern nicht zuverlässig erzwingen);
 * der Job gleicht die Nummern gegen den Katalog ab.
 */
export function buildStrukturSchema() {
  const eintrag = _obj({
    nr: { type: 'number' },
    status: { type: 'string', enum: STRUKTUR_STATUS.slice() },
    befund: _str,
    massnahme: _str,
  });
  const base = {
    gesamturteil: { type: 'string', enum: STRUKTUR_URTEILE.slice() },
    regeln: { type: 'array', items: eintrag },
    fehlendeWFragen: {
      type: 'array',
      items: { type: 'string', enum: W_FRAGEN.slice() },
    },
  };
  // Lokale Provider: die Zusammenfassung fällt weg (kleine Modelle produzieren
  // dort generischen Text und die Output-Tokens fehlen den Einzelbefunden).
  return _isLocal ? _obj(base) : _obj({ ...base, zusammenfassung: _str });
}
