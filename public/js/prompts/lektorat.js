// Lektorat-Prompts (Einzel- und Batch-Variante) + Stilkorrektur.
// Schema SCHEMA_LEKTORAT ist _isLocal-abhängig und wird via _rebuildLektoratSchema()
// nach configurePrompts() neu gebaut.

import { _isLocal } from './state.js';
import { _obj, _str, _num } from './schema-utils.js';
import {
  _buildStilBlock,
  _buildWiederholungBlock,
  _buildSchwacheVerbenBlock,
  _buildFuellwortBlock,
  _buildShowVsTellBlock,
  _buildPassivBlock,
  _buildPerspektivbruchBlock,
  _buildTempuswechselBlock,
  _buildErzaehlformBlock,
} from './blocks.js';
import { STOPWORDS, ERKLAERUNG_RULE, KORREKTUR_REGELN } from './core.js';

function _buildLektoratPromptBody(text, textLabel, {
  stopwords = STOPWORDS,
  erklaerungRule = ERKLAERUNG_RULE,
  korrekturRegeln = KORREKTUR_REGELN,
  figuren = [],
  figurenBeziehungen = [],
  orte = [],
  pageName = null,
  chapterName = null,
  erzaehlperspektive = null,
  erzaehlzeit = null,
  buchtyp = null,
  previousExcerpt = null,
} = {}) {
  const metaParts = [];
  if (chapterName) metaParts.push(`Kapitel: «${chapterName}»`);
  if (pageName)    metaParts.push(`Seite: «${pageName}»`);
  const metaBlock = metaParts.length ? `\nVerortung im Buch: ${metaParts.join(' · ')}\n` : '';

  // Erzählform-Block dient nur perspektivbruch/tempuswechsel – lokal ohnehin nicht geprüft.
  const povBlock = _isLocal
    ? ''
    : _buildErzaehlformBlock(erzaehlperspektive, erzaehlzeit, buchtyp, 'lektorat');

  // Lokal: nur Namen (+ Kurzname) als Erkennungshilfe – Geschlecht/Beruf/Typ/Beschreibung
  // werden für Rechtschreibung/Grammatik/Stil nicht gebraucht und kosten nur Tokens.
  const figurenBlock = figuren.length > 0
    ? (_isLocal
      ? `\nBekannte Figuren in diesem Kapitel (Namen sind KEINE Rechtschreibfehler):\n${figuren.map(f => {
          const parts = [f.name];
          if (f.kurzname && f.kurzname !== f.name) parts.push(f.kurzname);
          return '- ' + parts.join(' / ');
        }).join('\n')}\n`
      : `\nBekannte Figuren in diesem Kapitel (Kontext für Namenskonsistenz und Perspektivprüfung):\n${figuren.map(f => {
          const parts = [f.name];
          if (f.kurzname) parts.push(`Kurzname: ${f.kurzname}`);
          if (f.geschlecht) parts.push(f.geschlecht);
          if (f.beruf) parts.push(f.beruf);
          if (f.typ) parts.push(`Typ: ${f.typ}`);
          if (f.beschreibung) parts.push(f.beschreibung);
          return '- ' + parts.join(' | ');
        }).join('\n')}\nHinweis: Figurennamen und deren Varianten sind KEINE Rechtschreibfehler.\n`)
    : '';

  // Beziehungen dienen v.a. Anreden/Pronomen/Perspektiv-Prüfung – lokal nicht relevant.
  const beziehungenBlock = (_isLocal || figurenBeziehungen.length === 0)
    ? ''
    : `\nBeziehungen zwischen diesen Figuren (Kontext für Anreden, Pronomen, Rollen):\n${figurenBeziehungen.map(b => {
        const head = `${b.von} → ${b.zu}: ${b.typ}`;
        return b.beschreibung ? `- ${head} – ${b.beschreibung}` : `- ${head}`;
      }).join('\n')}\n`;

  // Lokal: nur Ortsnamen als Erkennungshilfe – Typ/Stimmung/Beschreibung sind für Lektorat irrelevant.
  const orteBlock = orte.length > 0
    ? (_isLocal
      ? `\nSchauplätze in diesem Kapitel (Ortsnamen sind KEINE Rechtschreibfehler):\n${orte.map(o => '- ' + o.name).join('\n')}\n`
      : `\nSchauplätze in diesem Kapitel (Kontext – Ortsnamen und deren Varianten sind KEINE Rechtschreibfehler):\n${orte.map(o => {
          const parts = [o.name];
          if (o.typ) parts.push(`Typ: ${o.typ}`);
          if (o.stimmung) parts.push(`Stimmung: ${o.stimmung}`);
          if (o.beschreibung) parts.push(o.beschreibung);
          return '- ' + parts.join(' | ');
        }).join('\n')}\n`)
    : '';

  // Vorseiten-Absatz dient Tempus-/Perspektiv-Übergang – lokal nicht geprüft.
  const previousBlock = (_isLocal || !previousExcerpt)
    ? ''
    : `\nLetzter Absatz der vorherigen Seite (NUR als Übergangskontext für Tempus-/Perspektiv-/Pronomen-Prüfung – NICHT bewerten, nicht in «fehler» aufnehmen):\n"""\n${previousExcerpt}\n"""\n`;

  // Lokaler Modus: kleinere Typ-Enum, keine Beispiele, keine spezialisierten Rule-Blöcke
  // (show_vs_tell, passiv, perspektivbruch, tempuswechsel). Diese Typen verlangen nuanciertes
  // Textverständnis, an dem kleine Modelle häufig scheitern oder in Wiederholungsloops geraten.
  const typEnum = _isLocal
    ? 'rechtschreibung|grammatik|stil|wiederholung|schwaches_verb|fuellwort'
    : 'rechtschreibung|grammatik|stil|wiederholung|schwaches_verb|fuellwort|show_vs_tell|passiv|perspektivbruch|tempuswechsel';

  const wichtigBlock = _isLocal
    ? ''
    : '\nWICHTIG: Jede einzelne Beanstandung erhält einen eigenen Eintrag im «fehler»-Array. Wenn an einer Stelle mehrere unabhängige Probleme vorliegen (z.B. ein Gallizismus und separate Anführungszeichen-Problematik), müssen diese als separate Einträge erscheinen – niemals in einer gemeinsamen «erklaerung» zusammenfassen.\n';

  // Gilt für ALLE Typen (lokal + cloud). Modelle bündeln sonst Meta-Präfixe,
  // Anführungszeichen oder Begründungs-Anhänge in das «korrektur»-Feld – das
  // Feld muss aber 1:1 in den Editor einsetzbar sein.
  const korrekturPuritaetBlock = `
KORREKTUR-PURITÄT (zwingend für jeden Eintrag, alle Typen):
- «korrektur» enthält AUSSCHLIESSLICH den Ersatztext, der «original» wortwörtlich ersetzen soll – sonst nichts.
- VERBOTEN in «korrektur»: Meta-Präfixe («Satz kürzen auf:», «Ersetzen durch:», «Vorschlag:», «Besser:», «Stattdessen:» o.Ä.), umschliessende Anführungszeichen oder Guillemets («»/„"/"") um den ganzen Ersatztext, Begründungs-Anhänge per Gedankenstrich («... – weil/damit/sonst ...»), Variantenlisten («A oder B»), Kommentare in Klammern.
- Begründungen, Hinweise, Alternativen gehören AUSSCHLIESSLICH in «erklaerung».
- Einsetz-Selbsttest: Würde «original» 1:1 durch «korrektur» ersetzt, ergäbe der Satz korrekten, lesbaren Fliesstext ohne Reste? Wenn nein → Eintrag korrigieren oder weglassen.
`;

  const filterBlock = _isLocal
    ? ''
    : `${erklaerungRule ? `\nFILTER-PFLICHT: ${erklaerungRule}\n` : ''}${korrekturRegeln ? `\n${korrekturRegeln}\n` : ''}`;

  const beispielBlock = _isLocal ? '' : `
Beispiel eines GUTEN Eintrags:
{ "typ": "grammatik", "original": "wegen dem Regen", "korrektur": "wegen des Regens", "erklaerung": "«wegen» verlangt den Genitiv." }
Beispiel eines VERWORFENEN Eintrags (Erklärung-Filter):
{ "typ": "rechtschreibung", "original": "heisst", "korrektur": "heißt", "erklaerung": "Könnte im Standarddeutschen mit ß geschrieben werden." } → Erklärung enthält Unsicherheit → Selbsttest nicht bestanden → weglassen.
Beispiel eines VERWORFENEN Eintrags (Korrektur-Purität verletzt):
{ "typ": "show_vs_tell", "original": "Dort versteckte er sich vor der Konfrontation, vor der eigentlich normalsten Auseinandersetzung zwischen Ehepartnern.", "korrektur": "Satz kürzen auf: «Dort versteckte er sich vor der Konfrontation.» – der erklärende Nachsatz nimmt dem Leser die Deutung vorweg.", "erklaerung": "..." } → «korrektur» enthält Meta-Präfix, Guillemets und Begründungs-Anhang → KORRIGIEREN zu: { "korrektur": "Dort versteckte er sich vor der Konfrontation.", "erklaerung": "Der erklärende Nachsatz nimmt dem Leser die Deutung vorweg – Satz kürzen." }
`;

  const spezialBlocks = _isLocal
    ? ''
    : `${_buildShowVsTellBlock()}
${_buildPassivBlock()}
${_buildPerspektivbruchBlock()}
${_buildTempuswechselBlock()}
`;

  // Lokal: szenen/stilanalyse/fazit werden aus Schema und Prompt gestrichen. Kleine Modelle
  // halluzinieren diese Felder oft generisch und das Generieren kostet spürbar Output-Tokens.
  const schemaBlock = _isLocal
    ? `Antworte mit diesem JSON-Schema:
{
  "fehler": [
    {
      "typ": "${typEnum}",
      "original": "das fehlerhafte Wort oder die fehlerhafte Phrase – bei «wiederholung»: vollständiger Satz zeichengenau aus dem Text",
      "korrektur": "die korrekte Version – bei «wiederholung»: derselbe Satz mit Synonym",
      "erklaerung": "kurze Erklärung – nur diesen einen Mangel beschreiben"
    }
  ]
}`
    : `Antworte mit diesem JSON-Schema:
{
  "fehler": [
    {
      "typ": "${typEnum}",
      "original": "das fehlerhafte Wort oder die fehlerhafte Phrase – bei «wiederholung»: vollständiger Satz zeichengenau aus dem Text",
      "korrektur": "die korrekte Version – bei «wiederholung»: derselbe Satz mit Synonym",
      "erklaerung": "kurze Erklärung – nur diesen einen Mangel beschreiben"
    }
  ],
  "szenen": [
    {
      "titel": "Kurze Szenenbezeichnung (1 Satz)",
      "wertung": "stark|mittel|schwach",
      "kommentar": "1-2 Sätze: was funktioniert, was fehlt (Spannung, Tempo, Figurenentwicklung)"
    }
  ],
  "stilanalyse": "4-5 Sätze Stilanalyse – KEINE konkreten Fehler erwähnen, die bereits im «fehler»-Array stehen (weder Rechtschreibung, Grammatik, Stil, Wiederholungen noch andere Typen). Fokus ausschliesslich auf übergreifende Beobachtungen zu literarischem Stil, Rhythmus, Bildsprache und Wirkung, die nicht als Einzelfehler erfasst sind.",
  "fazit": "ein Satz Gesamtfazit zur literarischen Qualität – KEINE Fehler aus dem «fehler»-Array wiederholen oder zusammenfassen, da diese separat behoben werden"
}`;

  const szenenRegelnBlock = _isLocal ? '' : `
Szenen-Regeln:
- Eine Szene ist ein abgegrenzter Handlungsabschnitt mit eigenem Anfang und Ende
- Wenn die Seite keine erkennbaren Szenen enthält (z.B. rein beschreibender Text, Exposition): «szenen» als leeres Array zurückgeben
- wertung: «stark» = funktioniert gut, «mittel» = verbesserungswürdig, «schwach» = klare Schwächen`;

  const aufgabeSatz = _isLocal
    ? 'Analysiere den Text vollständig von Anfang bis Ende – nicht nur lokale Abschnitte oder die letzten Sätze – auf Rechtschreibfehler, Grammatikfehler, stilistische Auffälligkeiten und auffällige Wortwiederholungen.'
    : 'Analysiere den Text vollständig von Anfang bis Ende – nicht nur lokale Abschnitte oder die letzten Sätze – auf Rechtschreibfehler, Grammatikfehler, stilistische Auffälligkeiten und auffällige Wortwiederholungen. Bewerte ausserdem die Szenen der Seite.';

  return `${aufgabeSatz}
${metaBlock}${povBlock}${wichtigBlock}${korrekturPuritaetBlock}${filterBlock}
${schemaBlock}
${beispielBlock}${szenenRegelnBlock}
${_buildStilBlock()}
${_buildWiederholungBlock(stopwords)}
${_buildSchwacheVerbenBlock()}
${_buildFuellwortBlock()}
${spezialBlocks}${figurenBlock}${beziehungenBlock}${orteBlock}${previousBlock}
${textLabel}
${text}`;
}

export function buildLektoratPrompt(text, opts = {}) {
  return _buildLektoratPromptBody(text, 'Originaltext:', opts);
}

// Batch-Variante ohne korrekturen_html (spart Output-Tokens, für Server-Side-Jobs)
export function buildBatchLektoratPrompt(text, opts = {}) {
  return _buildLektoratPromptBody(text, 'Text:', opts);
}

export function buildStilkorrekturPrompt(html, styles) {
  const liste = styles.map((s, i) =>
    `${i + 1}. Originalstelle (kann durch andere Korrekturen schon verändert sein): "${s.original}"\n   Empfehlung: "${s.korrektur}"\n   Begründung: ${s.erklaerung}`
  ).join('\n\n');

  return `Du bekommst einen HTML-Text und eine Liste stilistischer Verbesserungsvorschläge. Für jede Stelle entscheidest du selbst, wie die beste Formulierung lautet – die Empfehlung ist ein Hinweis, keine Vorgabe.

Wichtige Regeln für das "original"-Feld:
- Der HTML-Text unten ist die VERBINDLICHE Wahrheit. Andere Korrekturen können den Wortlaut bereits verändert haben — die "Originalstelle" oben ist daher nur ein Hinweis, NICHT der zu suchende Text.
- Suche im HTML-Text die Passage, die der Originalstelle entspricht, und gib den jetzt im HTML stehenden Wortlaut zeichen-für-zeichen exakt zurück (inkl. Anführungszeichen-Stil, Whitespace, geschützte Leerzeichen, Tags wenn sie mitten in der Passage liegen).
- Wenn die Stelle so nicht (mehr) im HTML steht, lass den Eintrag komplett weg — niemals erfinden, niemals approximieren.
- Wenn die Originalstelle keine Verbesserung braucht (Ersatz wäre identisch oder gleichwertig), lass den Eintrag ebenfalls weg — gib nicht "original" und "ersatz" identisch zurück.

Stilistische Verbesserungen:
${liste}

Antworte mit diesem JSON-Schema. Das Feld "index" ist die 1-basierte Position aus der nummerierten Liste oben (also 1 für den ersten Eintrag, 2 für den zweiten usw.) — gib es immer korrekt an, damit deine Antwort dem ursprünglichen Vorschlag zugeordnet werden kann:
{
  "korrekturen": [
    { "index": 1, "original": "zeichengenauer Wortlaut aus dem HTML-Text unten", "ersatz": "deine gewählte Ersatzformulierung" }
  ]
}

HTML-Text:
${html}`;
}

// ── Schemas ──────────────────────────────────────────────────────────────────

// SCHEMA_LEKTORAT ist _isLocal-abhängig (lokale Provider erhalten ein reduziertes
// Schema ohne szenen/stilanalyse/fazit) → wird via _rebuildLektoratSchema() neu
// gebaut, damit der dynamisch gesetzte _isLocal-Flag korrekt wirkt.
export let SCHEMA_LEKTORAT = null;

function _buildLektoratSchema() {
  const fehlerField = {
    type: 'array',
    items: _obj({
      typ: { type: 'string', enum: ['rechtschreibung', 'grammatik', 'stil', 'wiederholung', 'schwaches_verb', 'fuellwort'] },
      original: _str,
      korrektur: _str,
      kontext: _str,
      erklaerung: _str,
    }),
  };
  if (_isLocal) return _obj({ fehler: fehlerField });
  return _obj({
    fehler: fehlerField,
    szenen: {
      type: 'array',
      items: _obj({
        titel: _str,
        wertung: { type: 'string', enum: ['stark', 'mittel', 'schwach'] },
        kommentar: _str,
      }),
    },
    stilanalyse: _str,
    fazit: _str,
  });
}

export function _rebuildLektoratSchema() {
  SCHEMA_LEKTORAT = _buildLektoratSchema();
}

_rebuildLektoratSchema();

// Statisches Schema – nicht _isLocal-abhängig.
// `index` (1-basiert) referenziert die Position in der Eingabeliste; erlaubt
// eindeutiges Mapping zurück auf die Stil-Findings auch wenn die KI Einträge
// auslässt (z.B. weil keine Verbesserung nötig).
export const SCHEMA_STILKORREKTUR = _obj({
  korrekturen: {
    type: 'array',
    items: _obj({ index: _num, original: _str, ersatz: _str }),
  },
});
