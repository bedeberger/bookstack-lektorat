// Lektorat-Prompts (Einzel- und Batch-Variante).
// Schema SCHEMA_LEKTORAT ist _isLocal-abhängig und wird via _rebuildLektoratSchema()
// nach configurePrompts() neu gebaut.

import { _isLocal } from './state.js';
import { _obj, _str } from './schema-utils.js';
import {
  _buildRechtschreibungBlock,
  _buildGrammatikBlock,
  _buildStilBlock,
  _buildSatzbauBlock,
  _buildWiederholungBlock,
  _buildSchwacheVerbenBlock,
  _buildFuellwortBlock,
  _buildFilterwortBlock,
  _buildKlischeeBlock,
  _buildPleonasmusBlock,
  _buildFigurenkonsistenzBlock,
  _buildSchauplatzkonsistenzBlock,
  _buildShowVsTellBlock,
  _buildDialogformatBlock,
  _buildPassivBlock,
  _buildPerspektivbruchBlock,
  _buildTempuswechselBlock,
  _buildErzaehlformBlock,
  _buildAiSmellBlock,
  _buildBelegBlock,
} from './blocks.js';
import { STOPWORDS, ERKLAERUNG_RULE, KORREKTUR_REGELN } from './core.js';

function _buildLektoratPromptBody(text, textLabel, {
  stopwords = STOPWORDS,
  erklaerungRule = ERKLAERUNG_RULE,
  korrekturRegeln = KORREKTUR_REGELN,
  figuren = [],
  figurenBeziehungen = [],
  orte = [],
  motive = [],
  pageName = null,
  chapterName = null,
  erzaehlperspektive = null,
  erzaehlzeit = null,
  buchtyp = null,
  previousExcerpt = null,
  hatBelege = false,
  langCode = 'de',
  mode = 'full',
} = {}) {
  // Stil-Modus (Claude-Split): objektive/mechanische Typen werden in einem
  // separaten Objektiv-Pass geprüft (buildObjektivLektoratPrompt) und hier
  // ausgeschlossen, damit sie nicht doppelt auftauchen. Nur im Cloud-Pfad
  // relevant – lokale Provider fahren weiterhin den kombinierten Single-Call.
  const stilOnly = mode === 'stil' && !_isLocal;
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

  // Geplante Motive (Soll aus der Motiv-Werkstatt) als PASSIVER Kontext. Zweck:
  // motivtragende Formulierungen nicht gegen ein Motiv wegkorrigieren – kein
  // Drift-Urteil, keine eigenen Findings. Lokal weggelassen (kleine Modelle
  // ziehen daraus keinen Nutzen, nur Token-Kosten). Für den Objektiv-Pass irrelevant.
  const motivBlock = (_isLocal || motive.length === 0)
    ? ''
    : `\nGeplante Motive/Themen für diese Stelle (Soll laut Motiv-Werkstatt – reiner HINTERGRUNDKONTEXT, NICHT bewerten und NICHT als «fehler» melden):\n${motive.map(m => {
        const parts = [m.name];
        if (m.theme_name) parts.push(`Thema: ${m.theme_name}`);
        if (m.beschreibung) parts.push(m.beschreibung);
        if (m.trigger_terms?.length) parts.push(`Schlüsselbegriffe: ${m.trigger_terms.join(', ')}`);
        return '- ' + parts.join(' | ');
      }).join('\n')}\nHinweis: Formulierungen, wiederkehrende Bilder, Symbole oder Schlüsselbegriffe, die bewusst eines dieser Motive tragen, NICHT als Wiederholung, Klischee, Füllwort oder Stilschwäche anstreichen – motivische Wiederholung ist gewollt. Bewerte weiterhin echte handwerkliche Schwächen; nur den bewussten Motiv-Bezug nicht wegkorrigieren.\n`;

  // Quellennachweis-Schutz: nur wenn die Seite tatsächlich Belege trägt. Anders
  // als die übrigen Kontextblöcke AUCH lokal — kleine Modelle korrigieren
  // Klammer-Einschübe besonders gern weg, und ein zerstörter Beleg verliert den
  // Zeiger auf die Quelle.
  const belegBlock = hatBelege ? `\n${_buildBelegBlock(langCode)}\n` : '';

  // Vorseiten-Absatz dient Tempus-/Perspektiv-Übergang – lokal nicht geprüft.
  const previousBlock = (_isLocal || !previousExcerpt)
    ? ''
    : `\nLetzter Absatz der vorherigen Seite (NUR als Übergangskontext für Tempus-/Perspektiv-/Pronomen-Prüfung – NICHT bewerten, nicht in «fehler» aufnehmen):\n"""\n${previousExcerpt}\n"""\n`;

  // Lokaler Modus: kleinere Typ-Enum, keine Beispiele, keine spezialisierten Rule-Blöcke
  // (show_vs_tell, passiv, perspektivbruch, tempuswechsel). Diese Typen verlangen nuanciertes
  // Textverständnis, an dem kleine Modelle häufig scheitern oder in Wiederholungsloops geraten.
  const typEnum = _isLocal
    ? 'rechtschreibung|grammatik|stil|wiederholung|schwaches_verb|fuellwort'
    : (stilOnly
      ? 'stil|satzbau|wiederholung|schwaches_verb|fuellwort|filterwort|klischee|pleonasmus|ki_geruch|show_vs_tell|passiv|perspektivbruch|tempuswechsel|schauplatzmerkmal'
      : 'rechtschreibung|grammatik|stil|satzbau|wiederholung|schwaches_verb|fuellwort|filterwort|klischee|pleonasmus|ki_geruch|show_vs_tell|passiv|perspektivbruch|tempuswechsel|dialogformat|namenskonsistenz|figurenmerkmal|anrede|schauplatzmerkmal');

  // Lokal + Cloud: Typ-Priorität und Anti-Doppelung pro Textspanne. Verhindert,
  // dass derselbe Satz mehrfach gemeldet wird (z.B. fuellwort + schwaches_verb +
  // stil am gleichen Wort) – pro Span genau ein Eintrag mit dem spezifischsten Typ.
  const dedupTypen = _isLocal
    ? 'rechtschreibung > grammatik > wiederholung > schwaches_verb > fuellwort > stil'
    : 'dialogformat > rechtschreibung > grammatik > namenskonsistenz > figurenmerkmal > schauplatzmerkmal > anrede > pleonasmus > wiederholung > perspektivbruch > tempuswechsel > klischee > ki_geruch > passiv > show_vs_tell > filterwort > schwaches_verb > fuellwort > satzbau > stil';

  const dedupBlock = `
EIN-EINTRAG-PRO-STELLE (Anti-Doppelung, alle Typen):
- Pro Textspanne (überlappendes Wort oder überlappende Phrase) maximal EIN Eintrag im «fehler»-Array.
- Typ-Priorität bei Überlappung (spezifisch schlägt generisch): ${dedupTypen}.
- Beispiel «Er war eigentlich wütend»: NICHT als «fuellwort» (eigentlich) UND «show_vs_tell» (war wütend) UND «stil» (ganze Phrase) melden. Den treffendsten Typ wählen; die anderen Aspekte können knapp in «erklaerung» mitschwingen, aber KEIN zweiter Eintrag am gleichen Span.
- Mehrere Einträge zum selben Satz sind erlaubt NUR bei klar getrennten, nicht-überlappenden Textspannen (z.B. Fehler am Satzanfang UND unabhängiger Fehler am Satzende).
- Selbsttest pro Eintrag: Überlappt «original» textlich mit einem bereits ausgewählten Eintrag (gleiches Wort, gleiche Phrase, oder ineinandergeschachtelt)? Wenn ja → Eintrag streichen oder mit dem bereits gewählten zusammenführen (treffenderen Typ behalten).
`;

  const wichtigBlock = _isLocal
    ? dedupBlock
    : `\nWICHTIG: Bei wirklich unabhängigen Problemen an unterschiedlichen Textspannen separate Einträge erstellen (niemals in einer gemeinsamen «erklaerung» zusammenfassen). Für überlappende Spannen gilt die folgende Anti-Doppelung-Regel:\n${dedupBlock}`;

  // Gilt für ALLE Typen (lokal + cloud). Modelle bündeln sonst Meta-Präfixe,
  // Anführungszeichen oder Begründungs-Anhänge in das «korrektur»-Feld – das
  // Feld muss aber 1:1 in den Editor einsetzbar sein.
  const korrekturPuritaetBlock = `
KORREKTUR-PURITÄT (zwingend für jeden Eintrag, alle Typen):
- «korrektur» enthält AUSSCHLIESSLICH den Ersatztext, der «original» wortwörtlich ersetzen soll – sonst nichts.
- VERBOTEN in «korrektur»: Meta-Präfixe («Satz kürzen auf:», «Ersetzen durch:», «Vorschlag:», «Besser:», «Stattdessen:» o.Ä.), umschliessende Anführungszeichen oder Guillemets («»/„“/“”) um den ganzen Ersatztext, Begründungs-Anhänge per Gedankenstrich («... – weil/damit/sonst ...»), Variantenlisten («A oder B»), Kommentare in Klammern.
- Begründungen, Hinweise, Alternativen gehören AUSSCHLIESSLICH in «erklaerung».
- Einsetz-Selbsttest: Würde «original» 1:1 durch «korrektur» ersetzt, ergäbe der Satz korrekten, lesbaren Fliesstext ohne Reste? Wenn nein → Eintrag korrigieren oder weglassen.

ZEICHENGENAUIGKEIT von «original» (zwingend, alle Typen):
- «original» MUSS exakt – Zeichen für Zeichen – aus dem oben gegebenen Originaltext kopiert sein. KEINE Normalisierung erlaubt:
  · Anführungszeichen / Guillemets: «...», „...", "...", '...', ‹...› → exakt so übernehmen wie im Text, nicht durch eine andere Variante ersetzen
  · Halbgeviertstrich (–), Bindestrich (-), Geviertstrich (—) → exakt so übernehmen
  · Geschützte Leerzeichen ( ), schmale Leerzeichen ( ), normale Leerzeichen → exakt so übernehmen
  · Apostroph-Varianten (gerade ', typografisch ' und '), Auslassungspunkte (…) vs. drei Punkte (...) → exakt so übernehmen
  · Gross-/Kleinschreibung, Satzzeichen, Whitespace → 1:1
- Wenn die Stelle im Text Zeichen enthält, die in deinem JSON-Output durch Escaping repräsentiert werden müssen (z.B. Anführungszeichen), entsprechend escapen – aber den ursprünglichen Zeichensatz beibehalten.
- Selbsttest: Wenn ein automatisierter String-Find mit «original» den Text durchsucht, MUSS er die Stelle genau einmal finden. Approximationen (z.B. „..." statt «...») bedeuten: Stelle wird im Editor nicht gefunden → Eintrag unbrauchbar.

SPAN-TYP-KONSISTENZ (zwischen «original» und «korrektur», zwingend):
- «original» und «korrektur» müssen DENSELBEN Span-Typ haben:
  · Wenn «original» eine einzelne Phrase / ein Wort ist → «korrektur» auch eine Phrase / ein Wort (Ersatz im Satz).
  · Wenn «original» ein vollständiger Satz ist → «korrektur» auch ein vollständiger, kompletter Satz.
- VERBOTEN: «original» = «wegen dem Regen», «korrektur» = «Wegen des Regens blieben wir zu Hause.» (Phrase vs. ganzer Satz). Richtig: «korrektur» = «wegen des Regens».
- VERBOTEN: «original» = ganzer Satz, «korrektur» = nur die ersetzte Phrase ohne Satzrest.
- Pflicht-Span-Typ pro Typ:
${_isLocal
  ? `  · rechtschreibung, grammatik: Phrase oder Wort (genau die fehlerhafte Stelle)
  · wiederholung, schwaches_verb, fuellwort: vollständiger Satz
  · stil: vollständiger Satz ODER eindeutig abgrenzbare Phrase – beide Felder müssen denselben Span-Typ haben`
  : `  · rechtschreibung, grammatik: Phrase oder Wort (genau die fehlerhafte Stelle)
  · namenskonsistenz: einzelnes Wort (der falsch geschriebene Name)
  · figurenmerkmal, anrede, schauplatzmerkmal, pleonasmus, dialogformat: Phrase (genau die widersprüchliche / redundante / typografisch falsche Stelle)
  · wiederholung, schwaches_verb, fuellwort, filterwort, passiv, show_vs_tell, perspektivbruch, tempuswechsel: vollständiger Satz
  · klischee, ki_geruch, stil, satzbau: vollständiger Satz ODER eindeutig abgrenzbare Phrase – beide Felder müssen denselben Span-Typ haben`}
`;

  const filterBlock = _isLocal
    ? ''
    : `${erklaerungRule ? `\nFILTER-PFLICHT: ${erklaerungRule}\n` : ''}${korrekturRegeln ? `\n${korrekturRegeln}\n` : ''}`;

  // Severity + Findings-Obergrenze: Anti-Pedanterie. Cloud-only – kleine Modelle
  // produzieren ohnehin weniger und sollten nicht zusätzlich gefiltert werden.
  const severityBlock = _isLocal ? '' : `
SCHWERE-SCHWELLE (Anti-Pedanterie, Pflicht-Filter vor dem Aufnehmen ins «fehler»-Array):
- Melde NUR Schwächen, die einem ernsthaften Leser spürbar ins Auge fallen oder das Lese-Erlebnis nachweislich beeinträchtigen.
- Selbsttest pro Eintrag: «Würde ein professioneller Lektor diese Stelle in einem bezahlten Lektorat anstreichen?» Wenn die Antwort «vielleicht», «Geschmacksache» oder «nur am Rand» wäre → weglassen.
- VERWORFEN-Kandidaten: minimal alternative Synonyme ohne klaren Gewinn, Mikro-Stilpräferenzen, ein einzelnes «sehr» / «ein bisschen» wenn der Satz sonst rund läuft, vollkommen idiomatische Wendungen, regional übliche Formulierungen, ironisch oder bewusst eingesetzte «Schwächen».
- MECHANISCHE FEHLER unterliegen der Schwere-Schwelle UND der Mengen-Obergrenze NICHT – sie werden IMMER und VOLLSTÄNDIG gemeldet, egal wie viele es sind: Rechtschreibung, Grammatik (Kongruenz, Kasus, Rektion, Verbformen, Modus), ZEICHENSETZUNG/INTERPUNKTION (fehlende oder falsch gesetzte Kommas, Satzschlusszeichen, Apostroph, Gedankenstrich), TEMPUSBRÜCHE (typ «tempuswechsel»), PERSPEKTIVBRÜCHE (typ «perspektivbruch») und Dialogformat-Typografie (typ «dialogformat»). Das sind objektive Fehler, keine Geschmacksfragen – nie als «vielleicht» / «Geschmacksache» / «nur am Rand» abtun, nie wegen einer Obergrenze streichen.
- Die Schwere-Schwelle und die Mengen-Obergrenze gelten NUR für subjektive/stilistische Findings (stil, satzbau, schwaches_verb, fuellwort, filterwort, klischee, ki_geruch, show_vs_tell, passiv, pleonasmus, wiederholung). Dort gilt: lieber 5 starke, präzise Findings als 25 schwache. Wenn nach dem Selbsttest mehr als ~20 solcher stilistischen Einträge übrig bleiben, hart priorisieren: nur die schwersten ~20 behalten, restliche weglassen. Mechanische Fehler (oben) zählen NICHT gegen dieses Limit und werden nie gestrichen.
`;

  // Selbstkontroll-Pass: Sortierung + Schluss-Review. Hat bei Claude messbaren
  // Effekt; bei lokalen Modellen erhöht es Halluzinationsrisiko und wird
  // weggelassen.
  const selbstkontrollBlock = _isLocal ? '' : `
SELBSTKONTROLL-PASS (Pflicht vor dem Antworten):
Bevor du die JSON-Antwort ausgibst, gehe deine gesammelten Findings einmal durch und prüfe:
1. SCHWERE: Hat jeder stilistische Eintrag den Selbsttest «professioneller Lektor anstreichen?» bestanden? Wenn nein → streichen. AUSNAHME: mechanische Fehler (rechtschreibung, grammatik inkl. Zeichensetzung/Interpunktion, tempuswechsel, perspektivbruch, dialogformat) bestehen diesen Test immer und werden NIE gestrichen – auch nicht, um unter eine Mengen-Obergrenze zu kommen.
2. DOPPELUNG: Überlappt «original» eines Eintrags textlich mit dem «original» eines anderen Eintrags? Wenn ja → nur den mit dem treffendsten Typ (gemäss Typ-Priorität oben) behalten.
3. PURITÄT: Enthält «korrektur» Meta-Präfixe / Guillemets / Begründungs-Anhänge? Wenn ja → korrigieren oder Eintrag streichen.
4. ZEICHENGENAUIGKEIT: Liesse sich «original» mit einem String-Find im Originaltext genau einmal finden? Wenn nein → korrigieren oder streichen.
5. SPAN-TYP-KONSISTENZ: Sind «original» und «korrektur» beide gleichlange Spans (beide Phrase ODER beide Satz)? Wenn nein → korrigieren.
6. ERKLÄRUNGS-FILTER: Enthält «erklaerung» «kein Fehler» / «vertretbar» / «möglicherweise» / «akzeptabel» / «im Schweizer Kontext»? Wenn ja → Eintrag streichen.
7. SORTIERUNG: Sortiere das «fehler»-Array AUFSTEIGEND nach Textposition (erstes Auftreten von «original» im Originaltext – früh im Text zuerst, spät im Text zuletzt).
8. ZUSAMMENFASSUNGS-DISJUNKTION: Lies «stilanalyse», «fazit» und jedes «szenen[].kommentar» einzeln. Wenn ein Satz dort einen Mangel beschreibt, der textuell oder thematisch bereits durch einen Eintrag im «fehler»-Array abgedeckt ist (auch in Aggregat-Form wie «viele Wiederholungen», «passivlastig», «schwache Verben», «zu viele Füllwörter», «häufige Stilbrüche», «Show-vs-Tell-Probleme») → diesen Satz löschen oder durch eine inhaltlich nicht überlappende Beobachtung ersetzen. Selbsttest: Wäre der Satz überflüssig, wenn der Leser das «fehler»-Array bereits gesehen hat? Wenn ja → raus. Die drei Summary-Felder dürfen keine konkreten Findings paraphrasieren und keine Findings-Gruppen charakterisieren.
`;

  // Few-Shot: ein GUTES + ein VERWORFENES Beispiel. Das Erklärung-Filter-
  // Anti-Pattern ist bereits durch SCHWERE-SCHWELLE + SELBSTKONTROLL-PASS Step 6
  // explizit abgedeckt (Trigger-Wörter: kein Fehler / vertretbar / möglicherweise / akzeptabel)
  // — extra Beispiel wäre Token-Redundanz. Das Korrektur-Purität-Beispiel bleibt,
  // weil es einzigartig die IN-PLACE-Korrektur (Meta-Präfix raus + Reformulierung)
  // demonstriert, die keine Regel-Beschreibung gleichwertig zeigt.
  const beispielBlock = _isLocal ? '' : `
Beispiel eines GUTEN Eintrags:
{ "typ": "grammatik", "original": "wegen dem Regen", "korrektur": "wegen des Regens", "erklaerung": "«wegen» verlangt den Genitiv." }
Beispiel eines VERWORFENEN Eintrags (Korrektur-Purität verletzt):
{ "typ": "show_vs_tell", "original": "Dort versteckte er sich vor der Konfrontation, vor der eigentlich normalsten Auseinandersetzung zwischen Ehepartnern.", "korrektur": "Satz kürzen auf: «Dort versteckte er sich vor der Konfrontation.» – der erklärende Nachsatz nimmt dem Leser die Deutung vorweg.", "erklaerung": "..." } → «korrektur» enthält Meta-Präfix, Guillemets und Begründungs-Anhang → KORRIGIEREN zu: { "korrektur": "Dort versteckte er sich vor der Konfrontation.", "erklaerung": "Der erklärende Nachsatz nimmt dem Leser die Deutung vorweg – Satz kürzen." }
`;

  // Figurenkonsistenz (namens-/figuren-/anrede) ist objektiv → im Stil-Modus dem
  // separaten Objektiv-Pass überlassen. Schauplatzkonsistenz bleibt im Stil-Pass.
  const figurenkonsistenzBlock = (!_isLocal && !stilOnly && figuren.length > 0)
    ? _buildFigurenkonsistenzBlock()
    : '';
  const schauplatzkonsistenzBlock = (!_isLocal && orte.length > 0)
    ? _buildSchauplatzkonsistenzBlock()
    : '';

  const spezialBlocks = _isLocal
    ? ''
    : `${_buildSatzbauBlock()}
${_buildFilterwortBlock()}
${_buildKlischeeBlock()}
${_buildPleonasmusBlock()}
${_buildShowVsTellBlock()}
${stilOnly ? '' : _buildDialogformatBlock(langCode)}
${_buildPassivBlock()}
${_buildPerspektivbruchBlock()}
${_buildTempuswechselBlock()}
${_buildAiSmellBlock()}
${figurenkonsistenzBlock}
${schauplatzkonsistenzBlock}
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
      "erklaerung": "Erklärung in EINEM Satz, maximal 25 Wörter – nur diesen einen Mangel beschreiben, keine Mehrfach-Begründungen, keine Alternativ-Vorschläge"
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
      "erklaerung": "Erklärung in EINEM Satz, maximal 25 Wörter – nur diesen einen Mangel beschreiben, keine Mehrfach-Begründungen, keine Alternativ-Vorschläge"
    }
  ],
  "szenen": [
    {
      "titel": "Kurze Szenenbezeichnung (1 Satz)",
      "wertung": "stark|mittel|schwach",
      "kommentar": "1-2 Sätze: was funktioniert, was fehlt (Spannung, Tempo, Figurenentwicklung). KEINE konkreten Fehler aus dem «fehler»-Array wiederholen (keine Wortwahl-, Stil-, Grammatik-, Wiederholungs-, Füllwort-Hinweise zu Einzelstellen). Nur szenen-übergreifende Beobachtungen (Spannungsbogen, Tempo, Konflikt, Figurenentwicklung, Schauplatzwirkung)."
    }
  ],
  "stilanalyse": "4-5 Sätze Stilanalyse – KEINE konkreten Fehler erwähnen, die bereits im «fehler»-Array stehen (weder Rechtschreibung, Grammatik, Stil, Wiederholungen, Füllwörter, schwache Verben, Show-vs-Tell, Passiv, Perspektive, Tempus noch andere Typen). KEINE Aggregat-Hinweise auf bereits gemeldete Muster («häufige Wiederholungen», «viele Füllwörter», «passivlastig», «schwache Verben dominieren» o.Ä.) – diese Muster sind durch die Einzel-Findings abgedeckt. Fokus ausschliesslich auf übergreifende Beobachtungen, die NICHT als Einzelfehler erfasst sind: Rhythmus über mehrere Absätze, Bildsprache, Erzählhaltung, Atmosphäre, Wirkung beim Leser.",
  "fazit": "ein Satz Gesamtfazit zur literarischen Qualität – KEINE Fehler aus dem «fehler»-Array wiederholen, zusammenfassen oder als Gruppe charakterisieren («viele Stilbrüche», «zahlreiche Wiederholungen» o.Ä.). Nur Gesamtwirkung, nicht das Findings-Resultat paraphrasieren."
}`;

  const szenenRegelnBlock = _isLocal ? '' : `
Szenen-Regeln:
- Eine Szene ist ein abgegrenzter Handlungsabschnitt mit eigenem Anfang und Ende
- Wenn die Seite keine erkennbaren Szenen enthält (z.B. rein beschreibender Text, Exposition): «szenen» als leeres Array zurückgeben
- wertung: «stark» = funktioniert gut, «mittel» = verbesserungswürdig, «schwach» = klare Schwächen`;

  const aufgabeSatz = _isLocal
    ? 'Analysiere den Text vollständig von Anfang bis Ende – nicht nur lokale Abschnitte oder die letzten Sätze – auf Rechtschreibfehler, Grammatikfehler, Zeichensetzungs-/Interpunktionsfehler (insbesondere Kommasetzung), stilistische Auffälligkeiten und auffällige Wortwiederholungen. Prüfe Grammatik und Zeichensetzung Satz für Satz und gründlich.'
    : (stilOnly
      ? 'Analysiere den Text vollständig von Anfang bis Ende – nicht nur lokale Abschnitte oder die letzten Sätze – auf STILISTISCHE Schwächen: holprigen Satzbau, Wortwiederholungen, schwache Verben, Füll- und Filterwörter, Klischees, KI-Geruch, Show-statt-Tell, vermeidbares Passiv, Pleonasmen sowie Tempus- und Perspektivbrüche und Schauplatz-Konsistenz (Zuständigkeit und Details siehe Regelblöcke unten). WICHTIG: Objektive/mechanische Fehler – Rechtschreibung, Grammatik, Zeichensetzung/Interpunktion, Dialogformat-Typografie sowie Namens-/Figuren-Konsistenz und Anreden – werden in einem SEPARATEN Pass geprüft und dürfen hier NICHT gemeldet werden. Bewerte ausserdem die Szenen der Seite.'
      : 'Analysiere den Text vollständig von Anfang bis Ende – nicht nur lokale Abschnitte oder die letzten Sätze – auf Rechtschreibfehler, Grammatikfehler, Zeichensetzungs-/Interpunktionsfehler (insbesondere Kommasetzung), Tempus- und Perspektivbrüche, holprigen Satzbau, stilistische Auffälligkeiten und auffällige Wortwiederholungen – ebenso auf schwache Verben, Füll- und Filterwörter, Klischees, KI-Geruch, Show-statt-Tell, vermeidbares Passiv, Dialogformat-Typografie und Konsistenz von Figuren und Schauplätzen (Zuständigkeit und Details der einzelnen Typen siehe Regelblöcke unten). Prüfe Grammatik, Zeichensetzung und Erzähltempus Satz für Satz und gründlich – das sind objektive Fehler, die nicht übersehen werden dürfen. Bewerte ausserdem die Szenen der Seite.');

  // XML-Wrapper für die strukturell trennbaren Sektionen — hilft Claude beim
  // Parsen von Aufgabe, Schema, Beispielen und Originaltext als distinkte
  // Einheiten. Der mittlere Regel-Korpus bleibt als geordnete Textblöcke; die
  // bestehenden Section-Header (KORREKTUR-PURITÄT, SCHWERE-SCHWELLE, …) wirken
  // bereits als interne Marker.
  const beispielSection = beispielBlock.trim()
    ? `<beispiele>\n${beispielBlock.trim()}\n</beispiele>\n`
    : '';
  return `<aufgabe>
${aufgabeSatz}
</aufgabe>
${metaBlock}${povBlock}${wichtigBlock}${korrekturPuritaetBlock}${severityBlock}${filterBlock}
<output_format>
${schemaBlock}
</output_format>
${beispielSection}${szenenRegelnBlock}
${stilOnly ? '' : _buildRechtschreibungBlock(langCode)}
${stilOnly ? '' : _buildGrammatikBlock(langCode)}
${_buildStilBlock()}
${_buildWiederholungBlock(stopwords)}
${_buildSchwacheVerbenBlock()}
${_buildFuellwortBlock()}
${spezialBlocks}${figurenBlock}${beziehungenBlock}${orteBlock}${motivBlock}${belegBlock}${previousBlock}
${selbstkontrollBlock}
<originaltext label="${textLabel.replace(/:\s*$/, '')}">
${text}
</originaltext>`;
}

export function buildLektoratPrompt(text, opts = {}) {
  return _buildLektoratPromptBody(text, 'Originaltext:', opts);
}

// Batch-Variante ohne korrekturen_html (spart Output-Tokens, für Server-Side-Jobs)
export function buildBatchLektoratPrompt(text, opts = {}) {
  return _buildLektoratPromptBody(text, 'Text:', opts);
}

// Stil-Pass des Claude-Splits: kombinierter Prompt OHNE die objektiven Typen
// (die laufen im buildObjektivLektoratPrompt-Pass). Liefert weiterhin szenen/
// stilanalyse/fazit. Fällt bei lokalen Providern (_isLocal) automatisch auf den
// vollen Kombi-Prompt zurück – der lokale Pfad splittet nicht.
export function buildStilLektoratPrompt(text, opts = {}) {
  return _buildLektoratPromptBody(text, 'Text:', { ...opts, mode: 'stil' });
}

// ── Objektiv-Pass ──────────────────────────────────────────────────────────────
// Fokussierter Prompt AUSSCHLIESSLICH für objektive/mechanische Fehler
// (Rechtschreibung, Grammatik/Zeichensetzung, Dialogformat, Figurenkonsistenz).
// Kein Stil, keine Szenen, keine Severity-Schwelle, keine Mengen-Obergrenze.
// Zweck: erschöpfende, stabile Recall auf genau den Fehlern, die vollständig sein
// müssen – die im Kombi-Prompt geteilte Aufmerksamkeit über ~20 Typen macht sie
// unvollständig und lauf-zu-lauf zufällig. Bei temp 0 aufrufen. Provider-unabhängig
// (kein _isLocal-Split) – gedacht für den Cloud-Pfad.
export function buildObjektivLektoratPrompt(text, {
  figuren = [],
  figurenBeziehungen = [],
  orte = [],
  pageName = null,
  chapterName = null,
  hatBelege = false,
  langCode = 'de',
} = {}) {
  const en = langCode === 'en';
  const hasFiguren = figuren.length > 0;

  const metaParts = [];
  if (chapterName) metaParts.push(en ? `Chapter: «${chapterName}»` : `Kapitel: «${chapterName}»`);
  if (pageName)    metaParts.push(en ? `Page: «${pageName}»` : `Seite: «${pageName}»`);
  const metaBlock = metaParts.length ? `\n${en ? 'Location in the book' : 'Verortung im Buch'}: ${metaParts.join(' · ')}\n` : '';

  const konsistenzTypen = hasFiguren ? '|namenskonsistenz|figurenmerkmal|anrede' : '';
  const typEnum = `rechtschreibung|grammatik|dialogformat${konsistenzTypen}`;
  const dedupPrio = `dialogformat > rechtschreibung > grammatik${hasFiguren ? ' > namenskonsistenz > figurenmerkmal > anrede' : ''}`;

  const aufgabe = en
    ? `You are a meticulous proofreader. Check the text below EXCLUSIVELY for OBJECTIVE, mechanical errors: spelling, grammar, punctuation/commas, dialogue-format typography${hasFiguren ? ', and consistency of figure names/attributes against the figure block' : ''}. NO stylistic judgements, NO matters of taste. The following types are FORBIDDEN in this pass and must not appear: stil, satzbau, wiederholung, schwaches_verb, fuellwort, filterwort, klischee, ki_geruch, show_vs_tell, passiv, pleonasmus, perspektivbruch, tempuswechsel.

COMPLETENESS (most important rule): Work through the text from the first to the last line, sentence by sentence, in reading order. Do not skip any paragraph or sentence. Explicitly check every single sentence against each error class above before moving on. The goal is EXHAUSTIVE coverage: report every clear violation, no matter how many. There is NO cap on the number of findings and NO severity threshold – objective errors are never "too minor".`
    : `Du bist ein akribischer Korrektor. Prüfe den folgenden Text AUSSCHLIESSLICH auf OBJEKTIVE, mechanische Fehler: Rechtschreibung, Grammatik, Zeichensetzung/Interpunktion, Dialogformat-Typografie${hasFiguren ? ' sowie Konsistenz von Figuren-Namen/-Merkmalen gegen den Figuren-Block' : ''}. KEINE stilistischen Bewertungen, KEINE Geschmacksfragen. Folgende Typen sind in diesem Pass VERBOTEN und dürfen NICHT auftauchen: stil, satzbau, wiederholung, schwaches_verb, fuellwort, filterwort, klischee, ki_geruch, show_vs_tell, passiv, pleonasmus, perspektivbruch, tempuswechsel.

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
${_buildDialogformatBlock(langCode)}
${figurenkonsistenzBlock}${figurenBlock}${beziehungenBlock}${orteBlock}${belegBlock}
${selbstkontroll}
<originaltext label="${en ? 'Original text' : 'Originaltext'}">
${text}
</originaltext>`;
}

// ── Schemas ──────────────────────────────────────────────────────────────────

// SCHEMA_LEKTORAT ist _isLocal-abhängig (lokale Provider erhalten ein reduziertes
// Schema ohne szenen/stilanalyse/fazit) → wird via _rebuildLektoratSchema() neu
// gebaut, damit der dynamisch gesetzte _isLocal-Flag korrekt wirkt.
export let SCHEMA_LEKTORAT = null;

function _buildLektoratSchema() {
  const enumLocal = ['rechtschreibung', 'grammatik', 'stil', 'wiederholung', 'schwaches_verb', 'fuellwort'];
  const enumCloud = [
    ...enumLocal,
    'satzbau',
    'filterwort', 'klischee', 'pleonasmus', 'ki_geruch',
    'show_vs_tell', 'passiv', 'perspektivbruch', 'tempuswechsel',
    'dialogformat',
    'namenskonsistenz', 'figurenmerkmal', 'anrede', 'schauplatzmerkmal',
  ];
  const fehlerField = {
    type: 'array',
    items: _obj({
      typ: { type: 'string', enum: _isLocal ? enumLocal : enumCloud },
      original: _str,
      korrektur: _str,
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

// Schema für den Objektiv-Pass (buildObjektivLektoratPrompt). Statisch und
// provider-unabhängig – nur objektive Fehlertypen, kein szenen/stilanalyse/fazit.
export const SCHEMA_LEKTORAT_OBJEKTIV = _obj({
  fehler: {
    type: 'array',
    items: _obj({
      typ: {
        type: 'string',
        enum: ['rechtschreibung', 'grammatik', 'dialogformat', 'namenskonsistenz', 'figurenmerkmal', 'anrede'],
      },
      original: _str,
      korrektur: _str,
      erklaerung: _str,
    }),
  },
});
