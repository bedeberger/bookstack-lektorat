// Lektorat-Prompts (Einzel- und Batch-Variante).
//
// Welche Fehlertypen ein Lauf überhaupt kennt, entscheidet das Buchtyp-Profil in
// prompts/lektorat-typen.js (narrativ | sachlich | wissenschaft) — Typ-Enum,
// Dedup-Priorität, Span-Regeln und Regelblock-Auswahl leiten sich daraus ab. Die
// Fach-Profile ziehen ihre Regeltexte aus prompts/blocks-fach.js; das narrative
// Profil bleibt unverändert bei den Blöcken aus prompts/blocks.js.
//
// Schema SCHEMA_LEKTORAT ist _isLocal-abhängig und wird via _rebuildLektoratSchema()
// nach configurePrompts() neu gebaut; das profil-spezifische Schema kommt aus
// buildLektoratSchema(). Der fokussierte Objektiv-Pass des Claude-Splits liegt samt
// eigenem Schema in prompts/lektorat-objektiv.js.

import { _isLocal } from './state.js';
import { _obj, _str } from './schema-utils.js';
import {
  lektoratProfil, lektoratTypen,
  typPrioritaetString, spanRegeln, STILISTISCHE_TYPEN,
} from './lektorat-typen.js';
import {
  _buildUnbelegtBlock,
  _buildBegriffsinkonsistenzBlock,
  _buildAutorenformBlock,
  _buildHedgingBlock,
  _buildFachStilBlock,
  _buildFachWiederholungBlock,
  _buildFachTempusBlock,
  _buildFachAufgabe,
  _buildFachSeverityBlock,
  _buildFachSelbstkontrollBlock,
  _buildFachAbschnittRegelnBlock,
  _buildKonjunktivBlock,
  _buildZuschreibungBlock,
  _buildWertungBlock,
  _buildAmtsdeutschBlock,
  _buildJournalTempusBlock,
  _buildJournalStilBlock,
  _buildZitattreueBlock,
} from './blocks-fach.js';
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
import { textsorteLabel } from './textsorten.js';
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
  textsorte = null,
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
  // Buchtyp-Profil: entscheidet über Typ-Enum, Regelblöcke, Span-Regeln und die
  // Rahmenblöcke. 'narrativ' ist der Default (auch bei buchtyp === null).
  const profil = lektoratProfil(buchtyp);
  const fach = profil !== 'narrativ';
  // Journalistisch: die Textsorte schneidet zusaetzlich (kein `wertung` im
  // Kommentar) und benennt sich in den Regelbloecken selbst.
  const journal = profil === 'journalistisch';
  const typen = lektoratTypen(buchtyp, { local: _isLocal, stilOnly, textsorte });
  const aktiv = (t) => typen.includes(t);
  const metaParts = [];
  if (chapterName) metaParts.push(`Kapitel: «${chapterName}»`);
  if (pageName)    metaParts.push(`Seite: «${pageName}»`);
  if (journal && textsorte) metaParts.push(`Textsorte: «${textsorteLabel(textsorte)}»`);
  const metaBlock = metaParts.length ? `\nVerortung im Buch: ${metaParts.join(' · ')}\n` : '';

  // Erzählform-Block dient nur perspektivbruch/tempuswechsel – lokal ohnehin nicht
  // geprüft. In den Fach-Profilen gibt es keine Erzählform: dort richtet sich das
  // Tempus nach der Funktion des Abschnitts (_buildFachTempusBlock), und
  // perspektivbruch existiert als Typ nicht.
  const povBlock = (_isLocal || fach)
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
      // Zweck-Angabe muss zum Lauf passen: im Stil-Pass ist «namenskonsistenz»
      // nicht im Enum, der Block dient dort nur der Perspektiv-/Anreden-Prüfung.
      : `\nBekannte Figuren in diesem Kapitel (Kontext für ${aktiv('namenskonsistenz') ? 'Namenskonsistenz und Perspektivprüfung' : 'Perspektivprüfung – Namens- und Anredekonsistenz prüft ein separater Pass'}):\n${figuren.map(f => {
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

  // Typ-Enum des Laufs. Der lokale Modus reduziert zusätzlich (kein show_vs_tell,
  // passiv, perspektivbruch, tempuswechsel – diese Typen verlangen nuanciertes
  // Textverständnis, an dem kleine Modelle scheitern oder in Wiederholungsloops
  // geraten); der Stil-Pass lässt die objektiven Typen weg (separater Pass).
  const typEnum = typen.join('|');

  // Lokal + Cloud: Typ-Priorität und Anti-Doppelung pro Textspanne. Verhindert,
  // dass derselbe Satz mehrfach gemeldet wird (z.B. fuellwort + schwaches_verb +
  // stil am gleichen Wort) – pro Span genau ein Eintrag mit dem spezifischsten Typ.
  const dedupTypen = typPrioritaetString(typen);

  const dedupBlock = `
EIN-EINTRAG-PRO-STELLE (Anti-Doppelung, alle Typen):
- Pro Textspanne (überlappendes Wort oder überlappende Phrase) maximal EIN Eintrag im «fehler»-Array.
- Typ-Priorität bei Überlappung (spezifisch schlägt generisch): ${dedupTypen}.
- Beispiel ${journal
  ? '«Müller sagte, die Sanierung ist im Rahmen der Massnahme zur Durchführung gebracht worden»: NICHT als «konjunktiv» (ist statt sei) UND «amtsdeutsch» (zur Durchführung gebracht) UND «passiv» UND «stil» (ganzer Satz)'
  : fach
  ? '«Die Daten deuten möglicherweise unter Umständen darauf hin»: NICHT als «hedging» (Absicherungs-Stapel) UND «fuellwort» (unter Umständen) UND «stil» (ganze Phrase)'
  : '«Er war eigentlich wütend»: NICHT als «fuellwort» (eigentlich) UND «show_vs_tell» (war wütend) UND «stil» (ganze Phrase)'} melden. Den treffendsten Typ wählen; die anderen Aspekte können knapp in «erklaerung» mitschwingen, aber KEIN zweiter Eintrag am gleichen Span.
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
${spanRegeln(typen)}
`;

  const filterBlock = _isLocal
    ? ''
    : `${erklaerungRule ? `\nFILTER-PFLICHT: ${erklaerungRule}\n` : ''}${korrekturRegeln ? `\n${korrekturRegeln}\n` : ''}`;

  // Zitat-Schutz: bewusst AUCH lokal (kleine Modelle glätten Zitate besonders
  // gern) und bewusst als Rahmen-Verbot statt als Fehlertyp — er verbietet eine
  // ganze Klasse von Korrekturen, statt einen Mangel zu melden.
  const zitattreueBlock = journal ? _buildZitattreueBlock() : '';

  // Zuständigkeit des Mengen-Caps, aus dem Profil abgeleitet: subjektiv-stilistische
  // Typen unterliegen Schwere-Schwelle + Obergrenze, alle übrigen (mechanische Fehler
  // und Konsistenz-/Beleg-Befunde) werden nie gestrichen. Deckt sich mit
  // capStylisticFehler in routes/jobs/lektorat.js.
  const stilistischAktiv = typen.filter(t => STILISTISCHE_TYPEN.includes(t));
  const objektivAktiv    = typen.filter(t => !STILISTISCHE_TYPEN.includes(t));

  // Severity + Findings-Obergrenze: Anti-Pedanterie. Cloud-only – kleine Modelle
  // produzieren ohnehin weniger und sollten nicht zusätzlich gefiltert werden.
  // Der erläuternde Mechanik-Nachsatz darf nur stehen, wenn Rechtschreibung/Grammatik
  // in diesem Lauf überhaupt gemeldet werden dürfen — im Stil-Pass sind sie verboten,
  // und «werden IMMER und VOLLSTÄNDIG gemeldet» widerspräche direkt der <aufgabe>.
  const objektivSet = new Set(objektivAktiv);
  const mechDetail = (objektivSet.has('rechtschreibung') || objektivSet.has('grammatik'))
    ? ' Dazu zählen Rechtschreibung, Grammatik (Kongruenz, Kasus, Rektion, Verbformen, Modus) und ZEICHENSETZUNG/INTERPUNKTION (fehlende oder falsch gesetzte Kommas, Satzschlusszeichen, Apostroph, Gedankenstrich).'
    : ' Rechtschreibung, Grammatik und Zeichensetzung/Interpunktion prüft ein SEPARATER Pass – sie gehören NICHT in diese Antwort, auch nicht unter einem anderen Typ.';
  const severityBlock = _isLocal ? '' : (fach ? _buildFachSeverityBlock(stilistischAktiv, objektivAktiv) : `
SCHWERE-SCHWELLE (Anti-Pedanterie, Pflicht-Filter vor dem Aufnehmen ins «fehler»-Array):
- Melde NUR Schwächen, die einem ernsthaften Leser spürbar ins Auge fallen oder das Lese-Erlebnis nachweislich beeinträchtigen.
- Selbsttest pro Eintrag: «Würde ein professioneller Lektor diese Stelle in einem bezahlten Lektorat anstreichen?» Wenn die Antwort «vielleicht», «Geschmacksache» oder «nur am Rand» wäre → weglassen.
- VERWORFEN-Kandidaten: minimal alternative Synonyme ohne klaren Gewinn, Mikro-Stilpräferenzen, ein einzelnes «sehr» / «ein bisschen» wenn der Satz sonst rund läuft, vollkommen idiomatische Wendungen, regional übliche Formulierungen, ironisch oder bewusst eingesetzte «Schwächen».
- MECHANISCHE FEHLER UND KONSISTENZ-BEFUNDE unterliegen der Schwere-Schwelle UND der Mengen-Obergrenze NICHT – sie werden IMMER und VOLLSTÄNDIG gemeldet, egal wie viele es sind: ${objektivAktiv.join(', ')}.${mechDetail} Das sind objektive Fehler, keine Geschmacksfragen – nie als «vielleicht» / «Geschmacksache» / «nur am Rand» abtun, nie wegen einer Obergrenze streichen.
- Die Schwere-Schwelle und die Mengen-Obergrenze gelten NUR für subjektive/stilistische Findings (${stilistischAktiv.join(', ')}). Dort gilt: lieber 5 starke, präzise Findings als 25 schwache. Wenn nach dem Selbsttest mehr als ~20 solcher stilistischen Einträge übrig bleiben, hart priorisieren: nur die schwersten ~20 behalten, restliche weglassen. Die oben genannten objektiven Befunde zählen NICHT gegen dieses Limit und werden nie gestrichen.
`);

  // Selbstkontroll-Pass: Sortierung + Schluss-Review. Hat bei Claude messbaren
  // Effekt; bei lokalen Modellen erhöht es Halluzinationsrisiko und wird
  // weggelassen.
  const selbstkontrollBlock = _isLocal ? '' : (fach ? _buildFachSelbstkontrollBlock(objektivAktiv, profil) : `
SELBSTKONTROLL-PASS (Pflicht vor dem Antworten):
Bevor du die JSON-Antwort ausgibst, gehe deine gesammelten Findings einmal durch und prüfe:
1. SCHWERE: Hat jeder stilistische Eintrag den Selbsttest «professioneller Lektor anstreichen?» bestanden? Wenn nein → streichen. AUSNAHME: ${objektivAktiv.join(', ')} bestehen diesen Test immer und werden NIE gestrichen – auch nicht, um unter eine Mengen-Obergrenze zu kommen.
2. DOPPELUNG: Überlappt «original» eines Eintrags textlich mit dem «original» eines anderen Eintrags? Wenn ja → nur den mit dem treffendsten Typ (gemäss Typ-Priorität oben) behalten.
3. PURITÄT: Enthält «korrektur» Meta-Präfixe / Guillemets / Begründungs-Anhänge? Wenn ja → korrigieren oder Eintrag streichen.
4. ZEICHENGENAUIGKEIT: Liesse sich «original» mit einem String-Find im Originaltext genau einmal finden? Wenn nein → korrigieren oder streichen.
5. SPAN-TYP-KONSISTENZ: Sind «original» und «korrektur» beide gleichlange Spans (beide Phrase ODER beide Satz)? Wenn nein → korrigieren.
6. ERKLÄRUNGS-FILTER: Enthält «erklaerung» «kein Fehler» / «vertretbar» / «möglicherweise» / «akzeptabel» / «im Schweizer Kontext»? Wenn ja → Eintrag streichen.
7. SORTIERUNG: Sortiere das «fehler»-Array AUFSTEIGEND nach Textposition (erstes Auftreten von «original» im Originaltext – früh im Text zuerst, spät im Text zuletzt).
8. ZUSAMMENFASSUNGS-DISJUNKTION: Lies «stilanalyse», «fazit» und jedes «szenen[].kommentar» einzeln. Wenn ein Satz dort einen Mangel beschreibt, der textuell oder thematisch bereits durch einen Eintrag im «fehler»-Array abgedeckt ist (auch in Aggregat-Form wie «viele Wiederholungen», «passivlastig», «schwache Verben», «zu viele Füllwörter», «häufige Stilbrüche», «Show-vs-Tell-Probleme») → diesen Satz löschen oder durch eine inhaltlich nicht überlappende Beobachtung ersetzen. Selbsttest: Wäre der Satz überflüssig, wenn der Leser das «fehler»-Array bereits gesehen hat? Wenn ja → raus. Die drei Summary-Felder dürfen keine konkreten Findings paraphrasieren und keine Findings-Gruppen charakterisieren.
`);

  // Few-Shot: ein GUTES + ein VERWORFENES Beispiel. Das Erklärung-Filter-
  // Anti-Pattern ist bereits durch SCHWERE-SCHWELLE + SELBSTKONTROLL-PASS Step 6
  // explizit abgedeckt (Trigger-Wörter: kein Fehler / vertretbar / möglicherweise / akzeptabel)
  // — extra Beispiel wäre Token-Redundanz. Das Korrektur-Purität-Beispiel bleibt,
  // weil es einzigartig die IN-PLACE-Korrektur (Meta-Präfix raus + Reformulierung)
  // demonstriert, die keine Regel-Beschreibung gleichwertig zeigt.
  // Das GUTE Beispiel muss einen Typ tragen, den der Lauf auch ausgeben darf.
  // Im Stil-Pass ist «grammatik» verboten – ein Few-Shot mit verbotenem Typ wiegt
  // schwerer als jede Regel und lädt zur Umetikettierung ein. «fuellwort» steht in
  // allen vier Profilen und ist nie objektiv.
  const gutesBeispiel = stilOnly
    ? '{ "typ": "fuellwort", "original": "Das Ergebnis war dann letztlich eigentlich eindeutig.", "korrektur": "Das Ergebnis war eindeutig.", "erklaerung": "«dann letztlich eigentlich» stapelt Füllwörter ohne Aussagegewinn." }'
    : '{ "typ": "grammatik", "original": "wegen dem Regen", "korrektur": "wegen des Regens", "erklaerung": "«wegen» verlangt den Genitiv." }';
  const beispielBlock = _isLocal ? '' : `
Beispiel eines GUTEN Eintrags:
${gutesBeispiel}
Beispiel eines VERWORFENEN Eintrags (Korrektur-Purität verletzt):
${journal
  ? `{ "typ": "amtsdeutsch", "original": "Die Inbetriebnahme der Anlage erfolgt im Rahmen einer Massnahme des Kantons.", "korrektur": "Satz übersetzen auf: «Der Kanton nimmt die Anlage in Betrieb.» – Amtsdeutsch verdeckt, wer handelt.", "erklaerung": "..." } → «korrektur» enthält Meta-Präfix, Guillemets und Begründungs-Anhang → KORRIGIEREN zu: { "korrektur": "Der Kanton nimmt die Anlage in Betrieb.", "erklaerung": "Streckform «Inbetriebnahme erfolgt» verdeckt den Handelnden." }`
  : fach
  ? `{ "typ": "stil", "original": "Im Rahmen der vorliegenden Untersuchung wird der Aspekt der Wirksamkeit einer Betrachtung unterzogen.", "korrektur": "Satz straffen auf: «Die Untersuchung prüft die Wirksamkeit.» – die Abstrakta verdecken die Aussage.", "erklaerung": "..." } → «korrektur» enthält Meta-Präfix, Guillemets und Begründungs-Anhang → KORRIGIEREN zu: { "korrektur": "Die Untersuchung prüft die Wirksamkeit.", "erklaerung": "Gestapelte Abstrakta verdecken die Aussage – Satz straffen." }`
  : `{ "typ": "show_vs_tell", "original": "Dort versteckte er sich vor der Konfrontation, vor der eigentlich normalsten Auseinandersetzung zwischen Ehepartnern.", "korrektur": "Satz kürzen auf: «Dort versteckte er sich vor der Konfrontation.» – der erklärende Nachsatz nimmt dem Leser die Deutung vorweg.", "erklaerung": "..." } → «korrektur» enthält Meta-Präfix, Guillemets und Begründungs-Anhang → KORRIGIEREN zu: { "korrektur": "Dort versteckte er sich vor der Konfrontation.", "erklaerung": "Der erklärende Nachsatz nimmt dem Leser die Deutung vorweg – Satz kürzen." }`}
`;

  // Figurenkonsistenz (namens-/figuren-/anrede) ist objektiv → im Stil-Modus dem
  // separaten Objektiv-Pass überlassen (die Typen fallen dort aus dem Enum).
  // Schauplatzkonsistenz bleibt im Stil-Pass. In den Fach-Profilen existieren beide
  // Typen nicht – dann auch keine Regelblöcke, selbst wenn Stammdaten vorliegen.
  const figurenkonsistenzBlock = (aktiv('namenskonsistenz') && figuren.length > 0)
    ? _buildFigurenkonsistenzBlock()
    : '';
  const schauplatzkonsistenzBlock = (aktiv('schauplatzmerkmal') && orte.length > 0)
    ? _buildSchauplatzkonsistenzBlock()
    : '';

  // Regelblöcke: nur für Typen, die im aktiven Enum stehen. `_buildSatzbauBlock`
  // trägt auch in den Fach-Profilen (Schachtelsatz, Monotonie, umständliche
  // Konstruktion sind dort dieselben Mängel); Stil, Wiederholung und Tempus
  // brauchen dagegen eigene Fach-Fassungen, weil die narrativen Annahmen
  // (Nominalstil = Schwäche, Synonym statt Wiederholung, Erzähltempus) dort
  // falsch wären.
  const spezialBlocks = _isLocal
    ? ''
    : [
      _buildSatzbauBlock(typen),
      aktiv('filterwort')           && _buildFilterwortBlock(),
      aktiv('klischee')             && _buildKlischeeBlock(),
      aktiv('pleonasmus')           && _buildPleonasmusBlock(),
      aktiv('show_vs_tell')         && _buildShowVsTellBlock(),
      aktiv('dialogformat')         && _buildDialogformatBlock(langCode),
      aktiv('passiv')               && _buildPassivBlock(),
      aktiv('perspektivbruch')      && _buildPerspektivbruchBlock(),
      aktiv('tempuswechsel')        && (journal ? _buildJournalTempusBlock()
                                        : fach ? _buildFachTempusBlock() : _buildTempuswechselBlock()),
      aktiv('ki_geruch')            && _buildAiSmellBlock(),
      aktiv('hedging')              && _buildHedgingBlock(),
      aktiv('unbelegt')             && _buildUnbelegtBlock(),
      aktiv('begriffsinkonsistenz') && _buildBegriffsinkonsistenzBlock(),
      aktiv('autorenform')          && _buildAutorenformBlock(),
      aktiv('konjunktiv')           && _buildKonjunktivBlock(),
      aktiv('zuschreibung')         && _buildZuschreibungBlock(),
      aktiv('wertung')              && _buildWertungBlock(textsorteLabel(textsorte)),
      aktiv('amtsdeutsch')          && _buildAmtsdeutschBlock(),
      figurenkonsistenzBlock,
      schauplatzkonsistenzBlock,
    ].filter(Boolean).join('\n') + '\n';

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
      "titel": ${fach ? '"Kurze Bezeichnung des Argumentations-/Darstellungsschritts (1 Satz)"' : '"Kurze Szenenbezeichnung (1 Satz)"'},
      "wertung": "stark|mittel|schwach",
      "kommentar": ${fach
        ? '"1-2 Sätze: trägt der Schritt, ist er nachvollziehbar belegt, schliesst er an den vorigen an. KEINE konkreten Fehler aus dem «fehler»-Array wiederholen (keine Wortwahl-, Stil-, Grammatik-, Wiederholungs-, Hedging-Hinweise zu Einzelstellen). Nur schritt-übergreifende Beobachtungen (Argumentationsführung, Beleglage, Aufbau, Anschluss)."'
        : '"1-2 Sätze: was funktioniert, was fehlt (Spannung, Tempo, Figurenentwicklung). KEINE konkreten Fehler aus dem «fehler»-Array wiederholen (keine Wortwahl-, Stil-, Grammatik-, Wiederholungs-, Füllwort-Hinweise zu Einzelstellen). Nur szenen-übergreifende Beobachtungen (Spannungsbogen, Tempo, Konflikt, Figurenentwicklung, Schauplatzwirkung)."'}
    }
  ],
  "stilanalyse": ${fach
    ? '"4-5 Sätze Sprachanalyse – KEINE konkreten Fehler erwähnen, die bereits im «fehler»-Array stehen, und KEINE Aggregat-Hinweise auf bereits gemeldete Muster («häufige Wiederholungen», «viel Hedging», «oft unbelegt» o.Ä.). Fokus ausschliesslich auf übergreifende Beobachtungen, die NICHT als Einzelfehler erfasst sind: Klarheit über mehrere Absätze, Argumentationsführung, Begriffsschärfe, Informationsdichte, Lesbarkeit für die Fachleserschaft. Erzählerische Mittel NICHT einfordern."'
    : '"4-5 Sätze Stilanalyse – KEINE konkreten Fehler erwähnen, die bereits im «fehler»-Array stehen (weder Rechtschreibung, Grammatik, Stil, Wiederholungen, Füllwörter, schwache Verben, Show-vs-Tell, Passiv, Perspektive, Tempus noch andere Typen). KEINE Aggregat-Hinweise auf bereits gemeldete Muster («häufige Wiederholungen», «viele Füllwörter», «passivlastig», «schwache Verben dominieren» o.Ä.) – diese Muster sind durch die Einzel-Findings abgedeckt. Fokus ausschliesslich auf übergreifende Beobachtungen, die NICHT als Einzelfehler erfasst sind: Rhythmus über mehrere Absätze, Bildsprache, Erzählhaltung, Atmosphäre, Wirkung beim Leser."'},
  "fazit": ${fach
    ? '"ein Satz Gesamtfazit zur sprachlichen und argumentativen Qualität – KEINE Fehler aus dem «fehler»-Array wiederholen, zusammenfassen oder als Gruppe charakterisieren. Nur Gesamtwirkung, nicht das Findings-Resultat paraphrasieren."'
    : '"ein Satz Gesamtfazit zur literarischen Qualität – KEINE Fehler aus dem «fehler»-Array wiederholen, zusammenfassen oder als Gruppe charakterisieren («viele Stilbrüche», «zahlreiche Wiederholungen» o.Ä.). Nur Gesamtwirkung, nicht das Findings-Resultat paraphrasieren."'}
}`;

  const szenenRegelnBlock = _isLocal ? '' : (fach ? _buildFachAbschnittRegelnBlock(profil) : `
Szenen-Regeln:
- Eine Szene ist ein abgegrenzter Handlungsabschnitt mit eigenem Anfang und Ende
- Wenn die Seite keine erkennbaren Szenen enthält (z.B. rein beschreibender Text, Exposition): «szenen» als leeres Array zurückgeben
- wertung: «stark» = funktioniert gut, «mittel» = verbesserungswürdig, «schwach» = klare Schwächen`);

  const aufgabeSatz = _isLocal
    ? 'Analysiere den Text vollständig von Anfang bis Ende – nicht nur lokale Abschnitte oder die letzten Sätze – auf Rechtschreibfehler, Grammatikfehler, Zeichensetzungs-/Interpunktionsfehler (insbesondere Kommasetzung), stilistische Auffälligkeiten und auffällige Wortwiederholungen. Prüfe Grammatik und Zeichensetzung Satz für Satz und gründlich.'
    : (fach
      ? _buildFachAufgabe(profil, stilOnly)
      : (stilOnly
      ? 'Analysiere den Text vollständig von Anfang bis Ende – nicht nur lokale Abschnitte oder die letzten Sätze – auf STILISTISCHE Schwächen: holprigen Satzbau, Wortwiederholungen, schwache Verben, Füll- und Filterwörter, Klischees, KI-Geruch, Show-statt-Tell, vermeidbares Passiv, Pleonasmen sowie Tempus- und Perspektivbrüche und Schauplatz-Konsistenz (Zuständigkeit und Details siehe Regelblöcke unten). WICHTIG: Objektive/mechanische Fehler – Rechtschreibung, Grammatik, Zeichensetzung/Interpunktion, Dialogformat-Typografie sowie Namens-/Figuren-Konsistenz und Anreden – werden in einem SEPARATEN Pass geprüft und dürfen hier NICHT gemeldet werden. Bewerte ausserdem die Szenen der Seite.'
      : 'Analysiere den Text vollständig von Anfang bis Ende – nicht nur lokale Abschnitte oder die letzten Sätze – auf Rechtschreibfehler, Grammatikfehler, Zeichensetzungs-/Interpunktionsfehler (insbesondere Kommasetzung), Tempus- und Perspektivbrüche, holprigen Satzbau, stilistische Auffälligkeiten und auffällige Wortwiederholungen – ebenso auf schwache Verben, Füll- und Filterwörter, Klischees, KI-Geruch, Show-statt-Tell, vermeidbares Passiv, Dialogformat-Typografie und Konsistenz von Figuren und Schauplätzen (Zuständigkeit und Details der einzelnen Typen siehe Regelblöcke unten). Prüfe Grammatik, Zeichensetzung und Erzähltempus Satz für Satz und gründlich – das sind objektive Fehler, die nicht übersehen werden dürfen. Bewerte ausserdem die Szenen der Seite.'));

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
${metaBlock}${povBlock}${wichtigBlock}${korrekturPuritaetBlock}${zitattreueBlock}${severityBlock}${filterBlock}
<output_format>
${schemaBlock}
</output_format>
${beispielSection}${szenenRegelnBlock}
${aktiv('rechtschreibung') ? _buildRechtschreibungBlock(langCode) : ''}
${aktiv('grammatik') ? _buildGrammatikBlock(langCode) : ''}
${journal ? _buildJournalStilBlock(typen) : fach ? _buildFachStilBlock(typen) : _buildStilBlock(typen)}
${fach ? _buildFachWiederholungBlock(stopwords) : _buildWiederholungBlock(stopwords)}
${aktiv('schwaches_verb') ? _buildSchwacheVerbenBlock() : ''}
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


// ── Schemas ──────────────────────────────────────────────────────────────────

// Das typ-Enum des Schemas muss dasselbe Set tragen wie das Enum im Prompt-Text —
// sonst bietet die Grammar dem Modell Typen an, die der Prompt verbietet (verschenkte
// Output-Tokens, und bei lokalen Providern erzwingt Constrained Decoding sogar die
// Ausgabe). Darum ist das Schema wie der Prompt buchtyp- und modus-abhängig.
function _fehlerField(typen) {
  return {
    type: 'array',
    items: _obj({
      typ: { type: 'string', enum: typen },
      original: _str,
      korrektur: _str,
      erklaerung: _str,
    }),
  };
}

/**
 * Schema für den kombinierten bzw. den Stil-Pass. Lokale Provider erhalten ein
 * reduziertes Schema ohne szenen/stilanalyse/fazit (kleine Modelle halluzinieren
 * diese Felder generisch und das Generieren kostet spürbar Output-Tokens).
 * @param {{buchtyp?: string|null, stilOnly?: boolean, textsorte?: string|null}} opts
 */
export function buildLektoratSchema({ buchtyp = null, stilOnly = false, textsorte = null } = {}) {
  const fehlerField = _fehlerField(lektoratTypen(buchtyp, { local: _isLocal, stilOnly: stilOnly && !_isLocal, textsorte }));
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

// Default-Schema (narratives Profil, voller Pass). Hängt am _isLocal-Flag und wird
// darum via _rebuildLektoratSchema() nach configurePrompts() neu gebaut. Dient dem
// Prompt-Content-Hash (public/js/prompts.js) und dem Eval-Skript als stabile
// Referenz; die Job-Pfade rufen buildLektoratSchema() mit dem Buchtyp auf.
export let SCHEMA_LEKTORAT = null;

export function _rebuildLektoratSchema() {
  SCHEMA_LEKTORAT = buildLektoratSchema();
}

_rebuildLektoratSchema();
