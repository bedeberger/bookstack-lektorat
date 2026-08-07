// Titel-Werkstatt: Varianten für Dachzeile, Titel, Lead und Teaser.
//
// Der einzige generative Pfad des journalistischen Apparats — und er schreibt
// trotzdem nie in den Text: er liefert VORSCHLÄGE, die als Varianten neben dem
// geltenden Stand landen (`page_headline_variants`). Übernommen wird von Hand.
// Ein Titel ist eine redaktionelle Entscheidung; ein Modell, das ihn direkt
// setzt, entscheidet sie.
//
// Der Prompt kennt die Textsorte, weil ein Titel nicht aus dem Text folgt,
// sondern aus der Form: eine Nachricht braucht die Sache in der Zeile, ein
// Kommentar eine Haltung, eine Reportage einen Ton. Ohne Textsorte bekommt man
// vier Varianten desselben braven Sachtitels.
//
// Die Rolle (SYSTEM_HEADLINE) lebt wie alle System-Prompts in prompts/core.js.

import { _obj, _str } from './schema-utils.js';
import { textsorteLabel } from './textsorten.js';

/** Deckungsgleich mit HEADLINE_FIELDS in public/js/headline/channels.js und
 *  db/headline.js. Hier nur als Default des Schemas — die Auswahl kommt vom
 *  Aufrufer. */
const ALLE_FELDER = ['dachzeile', 'titel', 'lead', 'teaser'];

/** Was die vier Felder journalistisch sind. Steht im Prompt, weil «Lead» und
 *  «Teaser» je nach Haus Verschiedenes meinen und das Modell sonst rät. */
const FELD_BESCHREIBUNG = {
  dachzeile: 'Dachzeile — die kurze Zeile ÜBER dem Titel. Nennt Thema, Ort oder Ressort und ordnet ein. Kein ganzer Satz, kein Schlusspunkt.',
  titel: 'Titel — die Schlagzeile. Sagt die Sache, nicht das Thema. Aktiv, konkret, ohne Doppelpunkt-Konstruktion, ohne Fragezeichen als Ausweichmanöver.',
  lead: 'Lead (Vorspann) — der fett gesetzte Einstiegsabsatz, ein bis drei Sätze. Er beantwortet, worum es geht und warum es jetzt zählt. Er wiederholt den Titel nicht.',
  teaser: 'Teaser — der Anreisser für Übersichtsseiten, Newsletter und Vorschaukarten. Steht ALLEIN, ohne den Artikel daneben, und muss auch so verständlich sein.',
};

/**
 * @param {string} text     Klartext des Beitrags
 * @param {object} opts
 * @param {string[]} opts.felder      Welche Felder Varianten bekommen sollen
 * @param {number}   opts.anzahl      Varianten je Feld
 * @param {string}   [opts.textsorte] Key aus prompts/textsorten.js
 * @param {object}   [opts.bestand]   Bereits vorhandene Formulierungen je Feld
 */
export function buildHeadlineVariantsPrompt(text, {
  felder = ['titel'], anzahl = 5, textsorte = null, bestand = null,
} = {}) {
  const label = textsorte ? textsorteLabel(textsorte) : null;
  const feldBlock = felder
    .map(f => `- «${f}»: ${FELD_BESCHREIBUNG[f] || f}`)
    .join('\n');

  // Vorhandene Formulierungen mitgeben, damit das Modell danebenliegt statt
  // daneben — ohne diesen Block liefert der zweite Lauf dieselben Vorschlaege.
  const bestandZeilen = [];
  for (const f of felder) {
    const vorhanden = (bestand?.[f] || []).filter(Boolean);
    if (vorhanden.length) {
      bestandZeilen.push(`«${f}»:\n${vorhanden.map(v => `  - ${v}`).join('\n')}`);
    }
  }
  const bestandBlock = bestandZeilen.length
    ? `\n<bereits_vorhanden>\nDiese Formulierungen gibt es schon. Wiederhole sie nicht und variiere sie nicht bloss geringfügig — such einen anderen Zugriff.\n${bestandZeilen.join('\n')}\n</bereits_vorhanden>\n`
    : '';

  return `<aufgabe>
Schlage Formulierungen für den Titelapparat des unten stehenden Beitrags vor.${label ? `\nDie Textsorte ist: ${label}. Der Titelapparat muss zu dieser Form passen.` : ''}
Liefere je Feld genau ${anzahl} Varianten, die sich WIRKLICH unterscheiden — im Zugriff, nicht nur in der Wortwahl.
</aufgabe>

<felder>
${feldBlock}
</felder>
${bestandBlock}
REGELN FÜR DEINE ANTWORT:
- Alles muss aus dem Beitrag GEDECKT sein. Keine Zuspitzung, die der Text nicht trägt, keine Zahl und kein Name, die nicht dastehen. Ein Titel, der mehr verspricht als der Text hält, ist der teuerste Fehler dieses Handwerks.
- Keine Frageform als Ersatz für eine Aussage («Steht die Sanierung vor dem Aus?»), kein Doppelpunkt-Etikett («Verkehr: Das ist neu»), keine Anspielung, die man erst nach dem Lesen versteht.
- Kein Superlativ und kein Alarm-Vokabular, das im Text keine Entsprechung hat.
- Variiere den ZUGRIFF: eine Variante nennt die Sache, eine die Folge, eine die handelnde Person, eine das Detail. Nicht fünfmal dieselbe Konstruktion.
- «begruendung»: EIN kurzer Satz, worauf diese Variante setzt. Für die Redaktion, nicht für die Leserin.
- Schreibe in der Sprache des Beitrags.
- Erfinde nichts. Fehlt dem Text etwas, das eine gute Zeile bräuchte, lass die Variante weg, statt die Angabe zu ergänzen.

<output_format>
Antworte mit diesem JSON-Schema:
{
  "varianten": [
    { "feld": "titel", "text": "…", "begruendung": "…" }
  ]
}
</output_format>

<beitrag>
${text}
</beitrag>`;
}

/**
 * Schema mit Feld-Enum aus dem CALL, nicht global: bei lokalen Providern
 * erzwingt Constrained Decoding sonst Felder, die der Prompt gar nicht
 * angefordert hat (gleiche Begründung wie bei buildLektoratSchema).
 */
export function buildHeadlineVariantsSchema({ felder = ALLE_FELDER } = {}) {
  const eintrag = _obj({
    feld: { type: 'string', enum: [...felder] },
    text: _str,
    begruendung: _str,
  });
  return _obj({ varianten: { type: 'array', items: eintrag } });
}
