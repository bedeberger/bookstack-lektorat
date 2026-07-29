// Objektiv-Pass des Lektorats: fokussierter Prompt AUSSCHLIESSLICH für objektive/
// mechanische Fehler (Rechtschreibung, Grammatik/Zeichensetzung, Dialogformat,
// Figurenkonsistenz) plus das dazugehörige Schema. Ausgelagert aus prompts/lektorat.js.
//
// Welche dieser Typen ein Buch überhaupt kennt, entscheidet das Buchtyp-Profil in
// prompts/lektorat-typen.js: in den Fach-Profilen (sachlich/wissenschaft) bleiben
// nur rechtschreibung + grammatik übrig.

import { _obj, _str } from './schema-utils.js';
import {
  lektoratObjektivTypen, lektoratStilTypen, typPrioritaetString,
} from './lektorat-typen.js';
import {
  _buildRechtschreibungBlock,
  _buildGrammatikBlock,
  _buildDialogformatBlock,
  _buildFigurenkonsistenzBlock,
  _buildBelegBlock,
} from './blocks.js';

export function buildObjektivLektoratPrompt(text, {
  figuren = [],
  figurenBeziehungen = [],
  orte = [],
  pageName = null,
  chapterName = null,
  hatBelege = false,
  langCode = 'de',
  buchtyp = null,
} = {}) {
  const en = langCode === 'en';
  // Objektiv-Enum aus dem Buchtyp-Profil: in den Fach-Profilen bleiben nur
  // rechtschreibung + grammatik (kein Dialogformat, keine Figurenkonsistenz).
  const objektivTypen = lektoratObjektivTypen(buchtyp, { hasFiguren: figuren.length > 0 });
  const hasFiguren = objektivTypen.includes('namenskonsistenz');
  const hatDialogformat = objektivTypen.includes('dialogformat');

  const metaParts = [];
  if (chapterName) metaParts.push(en ? `Chapter: «${chapterName}»` : `Kapitel: «${chapterName}»`);
  if (pageName)    metaParts.push(en ? `Page: «${pageName}»` : `Seite: «${pageName}»`);
  const metaBlock = metaParts.length ? `\n${en ? 'Location in the book' : 'Verortung im Buch'}: ${metaParts.join(' · ')}\n` : '';

  const typEnum = objektivTypen.join('|');
  const dedupPrio = typPrioritaetString(objektivTypen);
  // Verbotene Typen = alles Nicht-Objektive des Profils; die prüft der Stil-Pass.
  const verboten = lektoratStilTypen(buchtyp).join(', ');
  const scopeDe = [
    'Rechtschreibung, Grammatik, Zeichensetzung/Interpunktion',
    hatDialogformat ? 'Dialogformat-Typografie' : null,
    hasFiguren ? 'Konsistenz von Figuren-Namen/-Merkmalen gegen den Figuren-Block' : null,
  ].filter(Boolean).join(', ');
  const scopeEn = [
    'spelling, grammar, punctuation/commas',
    hatDialogformat ? 'dialogue-format typography' : null,
    hasFiguren ? 'consistency of figure names/attributes against the figure block' : null,
  ].filter(Boolean).join(', ');

  const aufgabe = en
    ? `You are a meticulous proofreader. Check the text below EXCLUSIVELY for OBJECTIVE, mechanical errors: ${scopeEn}. NO stylistic judgements, NO matters of taste. The following types are FORBIDDEN in this pass and must not appear: ${verboten}.

COMPLETENESS (most important rule): Work through the text from the first to the last line, sentence by sentence, in reading order. Do not skip any paragraph or sentence. Explicitly check every single sentence against each error class above before moving on. The goal is EXHAUSTIVE coverage: report every clear violation, no matter how many. There is NO cap on the number of findings and NO severity threshold – objective errors are never "too minor".`
    : `Du bist ein akribischer Korrektor. Prüfe den folgenden Text AUSSCHLIESSLICH auf OBJEKTIVE, mechanische Fehler: ${scopeDe}. KEINE stilistischen Bewertungen, KEINE Geschmacksfragen. Folgende Typen sind in diesem Pass VERBOTEN und dürfen NICHT auftauchen: ${verboten}.

VOLLSTÄNDIGKEIT (wichtigste Regel): Arbeite den Text von der ersten bis zur letzten Zeile durch, Satz für Satz, in Textreihenfolge. Überspringe keinen Absatz und keinen Satz. Prüfe jeden einzelnen Satz explizit gegen jede der oben genannten Fehlerklassen, bevor du weitergehst. Ziel ist ERSCHÖPFENDE Erfassung: jeder eindeutige Verstoss wird gemeldet, egal wie viele es sind. Es gibt KEINE Mengen-Obergrenze und KEINE Schwere-Schwelle – objektive Fehler sind nie «zu geringfügig».`;

  const puritaetBlock = en
    ? `
CORRECTION PURITY & CHARACTER-EXACTNESS (mandatory for every entry):
- «korrektur» contains ONLY the replacement text that should replace «original» verbatim – nothing else. No meta-prefixes, no surrounding quotes/guillemets, no reasoning appended by dash, no variant lists. Reasons belong in «erklaerung».
- «original» MUST be copied character-for-character from the text below (quotes, dashes, spaces, apostrophes, ellipses, case 1:1). A string-find with «original» must hit the spot exactly once.
- «original» and «korrektur» must have the SAME span type (word↔word, phrase↔phrase); all objective types here are word- or phrase-level, never a whole rewritten sentence.`
    : `
KORREKTUR-PURITÄT & ZEICHENGENAUIGKEIT (zwingend für jeden Eintrag):
- «korrektur» enthält AUSSCHLIESSLICH den Ersatztext, der «original» wortwörtlich ersetzt – sonst nichts. Keine Meta-Präfixe («Ersetzen durch:», «Besser:»), keine umschliessenden Anführungszeichen/Guillemets, keine per Gedankenstrich angehängten Begründungen, keine Variantenlisten. Begründungen gehören in «erklaerung».
- «original» MUSS zeichengenau – Zeichen für Zeichen – aus dem untenstehenden Text kopiert sein (Anführungszeichen, Gedanken-/Bindestriche, Leerzeichen, Apostrophe, Auslassungspunkte, Gross-/Kleinschreibung 1:1). Ein String-Find mit «original» muss die Stelle genau einmal finden.
- «original» und «korrektur» haben denselben Span-Typ (Wort↔Wort, Phrase↔Phrase); alle objektiven Typen hier sind Wort- oder Phrasen-Ebene, nie ein ganzer umformulierter Satz.`;

  const dedupBlock = en
    ? `
ONE ENTRY PER SPOT: For any overlapping text span report at most ONE entry. Priority on overlap (specific beats generic): ${dedupPrio}.`
    : `
EIN EINTRAG PRO STELLE: Pro überlappender Textspanne maximal EIN Eintrag. Priorität bei Überlappung (spezifisch schlägt generisch): ${dedupPrio}.`;

  const schemaBlock = en
    ? `Respond with EXACTLY this JSON schema (no other fields):
{
  "fehler": [
    { "typ": "${typEnum}", "original": "the exact erroneous word/phrase, copied character-exact", "korrektur": "the corrected version (1:1 replacement, same span type)", "erklaerung": "ONE sentence, max 25 words, naming the violated rule" }
  ]
}
If the text contains no objective errors, return { "fehler": [] }.`
    : `Antworte mit EXAKT diesem JSON-Schema (keine weiteren Felder):
{
  "fehler": [
    { "typ": "${typEnum}", "original": "das fehlerhafte Wort / die fehlerhafte Phrase, zeichengenau kopiert", "korrektur": "die korrekte Version (1:1-Ersatz, gleicher Span-Typ)", "erklaerung": "EIN Satz, max 25 Wörter, benennt die verletzte Regel" }
  ]
}
Enthält der Text keine objektiven Fehler, gib { "fehler": [] } zurück.`;

  const figurenBlock = hasFiguren
    ? (en
      ? `\nKnown figures in this chapter (their names and variants are NOT spelling errors):\n${figuren.map(f => '- ' + [f.name, f.kurzname && f.kurzname !== f.name ? f.kurzname : null].filter(Boolean).join(' / ')).join('\n')}\n`
      : `\nBekannte Figuren in diesem Kapitel (ihre Namen und Varianten sind KEINE Rechtschreibfehler):\n${figuren.map(f => '- ' + [f.name, f.kurzname && f.kurzname !== f.name ? f.kurzname : null].filter(Boolean).join(' / ')).join('\n')}\n`)
    : '';
  const orteBlock = orte.length > 0
    ? (en
      ? `\nLocations in this chapter (place names and their variants are NOT spelling errors):\n${orte.map(o => '- ' + o.name).join('\n')}\n`
      : `\nSchauplätze in diesem Kapitel (Ortsnamen und deren Varianten sind KEINE Rechtschreibfehler):\n${orte.map(o => '- ' + o.name).join('\n')}\n`)
    : '';
  const beziehungenBlock = (hasFiguren && figurenBeziehungen.length > 0)
    ? (en
      ? `\nRelationships between these figures (context for forms of address):\n${figurenBeziehungen.map(b => `- ${b.von} → ${b.zu}: ${b.typ}${b.beschreibung ? ' – ' + b.beschreibung : ''}`).join('\n')}\n`
      : `\nBeziehungen zwischen diesen Figuren (Kontext für Anreden):\n${figurenBeziehungen.map(b => `- ${b.von} → ${b.zu}: ${b.typ}${b.beschreibung ? ' – ' + b.beschreibung : ''}`).join('\n')}\n`)
    : '';

  // Quellennachweis-Schutz auch hier: dieser Pass prueft Rechtschreibung und
  // Grammatik und wuerde „Mueller 2020" bzw. „[12]" sonst anstreichen.
  const belegBlock = hatBelege ? `\n${_buildBelegBlock(langCode)}\n` : '';

  const selbstkontroll = en
    ? `
SELF-CHECK (before answering):
1. COMPLETENESS: Go through the text a SECOND time and add any objective error you missed on the first pass – especially commas and verb forms.
2. TYPE DISCIPLINE: Does any entry carry a forbidden stylistic/subjective type? → delete it, it does not belong in this pass.
3. CHARACTER-EXACTNESS: Would a string-find on «original» hit exactly once? If not → fix or drop.
4. PURITY: Does «korrektur» contain meta-prefixes/guillemets/appended reasons? → fix.
5. SORT the «fehler» array ascending by text position (first occurrence of «original»).`
    : `
SELBSTKONTROLLE (vor dem Antworten):
1. VOLLSTÄNDIGKEIT: Gehe den Text ein ZWEITES Mal durch und ergänze jeden objektiven Fehler, den du im ersten Durchgang übersehen hast – besonders Kommas und Verbformen.
2. TYP-DISZIPLIN: Trägt ein Eintrag einen verbotenen stilistischen/subjektiven Typ? → streichen, gehört nicht in diesen Pass.
3. ZEICHENGENAUIGKEIT: Würde ein String-Find auf «original» genau einmal treffen? Wenn nein → korrigieren oder streichen.
4. PURITÄT: Enthält «korrektur» Meta-Präfixe/Guillemets/angehängte Begründungen? → korrigieren.
5. SORTIERE das «fehler»-Array aufsteigend nach Textposition (erstes Auftreten von «original»).`;

  const figurenkonsistenzBlock = hasFiguren ? _buildFigurenkonsistenzBlock() : '';

  return `<aufgabe>
${aufgabe}
</aufgabe>
${metaBlock}${puritaetBlock}
${dedupBlock}
<output_format>
${schemaBlock}
</output_format>
${_buildRechtschreibungBlock(langCode)}
${_buildGrammatikBlock(langCode)}
${hatDialogformat ? _buildDialogformatBlock(langCode) : ''}
${figurenkonsistenzBlock}${figurenBlock}${beziehungenBlock}${orteBlock}${belegBlock}
${selbstkontroll}
<originaltext label="${en ? 'Original text' : 'Originaltext'}">
${text}
</originaltext>`;
}
// Schema des Objektiv-Passes. Trägt dasselbe Typ-Set wie das Enum im Prompt-Text.
export function buildObjektivLektoratSchema({ buchtyp = null, hasFiguren = true } = {}) {
  return _obj({
    fehler: {
      type: 'array',
      items: _obj({
        typ: { type: 'string', enum: lektoratObjektivTypen(buchtyp, { hasFiguren }) },
        original: _str,
        korrektur: _str,
        erklaerung: _str,
      }),
    },
  });
}
