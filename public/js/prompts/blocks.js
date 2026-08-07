// Wiederverwendbare Regel-Blöcke für Lektorat- und Review-Prompts.
// Pure Funktionen – keine Modul-State-Abhängigkeiten.
//
// Dialog-Ausnahme – zwei bewusste Stufen (gilt einheitlich über alle Blöcke):
//   · HARTE Ausnahme («in direkter Rede NICHT melden»): rein stilistisch-literarische
//     Typen, die Figurensprache legitim charakterisieren – stil, satzbau, show_vs_tell,
//     filterwort, klischee, ki_geruch. Figurenrede ist hier nie ein Finding.
//   · WEICHE Ausnahme («in direkter Rede konservativer»): Typen, die auch im Dialog
//     ein echter Mangel sein können – wiederholung, schwaches_verb, fuellwort, passiv.
//     Nur melden, wenn die Stelle auch in der Figurenrede hörbar holpert.
//   · KEINE Ausnahme (auch im Dialog voll melden): mechanische Fehler – rechtschreibung,
//     grammatik (inkl. Zeichensetzung), dialogformat; Ausnahme nur bei klar erkennbarem,
//     bewusst gesetztem Dialekt/Idiolekt.
//
// Blöcke, die andere Fehlertypen als Abgrenzung nennen, bekommen das aktive
// Typ-Enum des Laufs (`typen`) und filtern ihre Verweise darauf – im Stil-Pass
// des Claude-Splits existieren die objektiven Typen nicht.

import { verweisTypen, verweisZiel, OBJEKTIV_VERWEIS } from './lektorat-typen.js';

// Grammatik + Zeichensetzung/Interpunktion (beide unter typ «grammatik»). Locale-scharf.
// Beide Fehlergruppen sind objektiv und mechanisch – sie werden SYSTEMATISCH geprüft und
// IMMER gemeldet (keine Schwere-Schwelle, keine Mengen-Obergrenze). Zeichensetzungsfehler
// sind ein häufig übersehener, aber objektiver Mangel – darum hier explizit ausbuchstabiert.
export function _buildGrammatikBlock(langCode = 'de') {
  if (langCode === 'en') {
    return `
Grammar & punctuation rules (typ: «grammatik»):
- These are OBJECTIVE, mechanical errors. Scan the WHOLE text sentence by sentence – do not sample. Every clear violation is reported; none is dropped as "minor" or "matter of taste".
- Grammar: subject-verb agreement, pronoun case and reference, verb tense formation, dangling/misplaced modifiers, article misuse, faulty parallelism, comparative/superlative errors, preposition/idiom errors.
- Punctuation / commas: comma splices (two independent clauses joined by only a comma), missing comma after an introductory clause/phrase, missing comma before a coordinating conjunction joining two independent clauses, missing paired commas around non-restrictive clauses/appositives, inconsistent serial (Oxford) comma, apostrophe errors (its vs it's, possessive vs plural), missing or doubled terminal punctuation, capitalisation at sentence start, quotation/dash/ellipsis misuse.
- «original»: the exact span containing the error – for a comma error, copy the phrase around the spot (with enough surrounding words to be uniquely findable), character-exact.
- «korrektur»: the SAME span with the grammar/punctuation corrected (1:1 replacement, same span type).
- «erklaerung»: ONE sentence naming the rule («missing comma before the subordinate clause», «comma splice – use a period or semicolon», «its = possessive, no apostrophe», …).
- Report inside direct speech too – punctuation and grammar errors are mistakes there as well, unless an intentional dialect/idiolect is clearly signalled.`;
  }
  // Default: Deutsch
  return `
Grammatik- & Zeichensetzungs-Regeln (typ: «grammatik»):
- Das sind OBJEKTIVE, mechanische Fehler. Prüfe den GESAMTEN Text Satz für Satz – nicht stichprobenartig. Jeder eindeutige Verstoss wird gemeldet; keiner wird als «geringfügig» oder «Geschmacksache» weggelassen.
- Grammatik: Subjekt-Verb-Kongruenz (Numerus), Kasus/Rektion (z.B. «wegen/trotz/während» + Genitiv, Dativ-statt-Genitiv, Akkusativ-statt-Dativ und umgekehrt), Adjektiv-/Artikeldeklination, falsche Verbformen (starke/schwache Konjugation, Partizip, «ich habe gegangen» statt «bin gegangen»), Modus (Konjunktiv I in indirekter Rede, Konjunktiv II im Irrealis/Konditional), Wortstellung (Verbzweit-/Verbletztstellung), falscher Pronomen-/Relativbezug, doppelte Verneinung, «als/wie»-Verwechslung, «scheinbar/anscheinend».
- Zeichensetzung / Interpunktion (PFLICHT, häufig übersehen):
  · Komma vor Nebensätzen (dass, weil, obwohl, wenn, als, damit …) und vor/um Relativsätze.
  · Komma beim erweiterten Infinitiv mit «zu» (um/ohne/(an)statt … zu; sowie bei ankündigendem Hinweiswort).
  · Paariges Komma bei Einschüben, Appositionen, nachgestellten Erläuterungen, Partizip-/Adjektivgruppen, Anreden, Ausrufen («ja, nein, bitte, danke»).
  · Komma zwischen zwei vollständigen Hauptsätzen, insbesondere vor «aber, sondern, doch, denn»; bei «und/oder» zwischen selbstständigen Hauptsätzen optional, aber konsistent.
  · KEIN Komma zwischen gleichrangigen Satzgliedern, die mit «und/oder» verbunden sind.
  · Satzschlusszeichen: fehlende oder doppelte Punkte/Frage-/Ausrufezeichen, fehlendes Fragezeichen bei direkter Frage, Grossschreibung am Satzanfang.
  · Apostroph: Genitiv ohne Apostroph («Annas Buch», nicht «Anna's»), korrekter Auslassungsapostroph.
  · Gedankenstrich (Halbgeviert «–») vs. Bindestrich («-»), Auslassungspunkte («…»), Doppelpunkt – jeweils korrekte Verwendung und Abstände.
- «original»: die fehlerhafte Stelle zeichengenau – bei Kommafehlern die Phrase um die Stelle kopieren (mit genug Kontext, damit sie eindeutig auffindbar ist).
- «korrektur»: dieselbe Stelle mit korrigierter Grammatik/Zeichensetzung (1:1-Ersatz, gleicher Span-Typ).
- «erklaerung»: EIN Satz, benennt die verletzte Regel («Komma vor dem Nebensatz fehlt», «wegen verlangt den Genitiv», «Komma zwischen zwei Hauptsätzen fehlt», «Genitiv ohne Apostroph»).
- AUCH in direkter Rede / Dialog melden: Zeichensetzungs- und Grammatikfehler sind dort genauso Fehler – Ausnahme nur, wenn klar erkennbar bewusste Figurensprache/Dialekt vorliegt.`;
}

// Rechtschreibung (Einzelwort-Schreibung). Locale-scharf. Objektiv/mechanisch –
// SYSTEMATISCH geprüft und IMMER gemeldet (keine Schwere-Schwelle, keine Obergrenze).
// Bewusst getrennt vom Grammatik-Block: hier nur die Schreibung des einzelnen Worts,
// nicht Kommasetzung/Kasus/Kongruenz. ss/ß bzw. AE/BE regelt die KORREKTUR-SPRACHE-
// Regel (locale-spezifisch) – darum hier NICHT erwähnt.
export function _buildRechtschreibungBlock(langCode = 'de') {
  if (langCode === 'en') {
    return `
Spelling rules (typ: «rechtschreibung»):
- OBJECTIVE, mechanical errors. Check word by word; every clear violation is reported, none dropped as "minor". Do NOT flag spellings that are valid in the book's variety – the allowed norm follows from the CORRECTION LANGUAGE rule below.
- Boundary: pure single-word spelling → «rechtschreibung». Commas, case agreement, verb forms, and apostrophe issues (its/it's, your/you're) → «grammatik».
- Typical classes:
  · Commonly confused homophones: their/there, lose/loose, affect/effect, then/than, to/too, complement/compliment, stationary/stationery.
  · Compound vs. open spelling: everyday vs. every day, alright/all right, into vs. in to.
  · Doubled/dropped letters, transpositions, typos (recieve→receive, seperate→separate, definately→definitely).
  · Capitalisation of proper nouns mid-sentence.
- «original»: the misspelled word, character-exact.
- «korrektur»: the same span spelled correctly (1:1 replacement, same span type).
- «erklaerung»: ONE sentence naming the rule («there = place, their = possessive», «typo: receive»).
- Report inside direct speech too – exception only for clearly intentional dialect/idiolect.`;
  }
  // Default: Deutsch
  return `
Rechtschreib-Regeln (typ: «rechtschreibung»):
- OBJEKTIVE, mechanische Fehler. Prüfe Wort für Wort; jeder eindeutige Verstoss wird gemeldet, keiner als «geringfügig» weggelassen. Schreibvarianten der Buch-Sprache NICHT als Fehler melden – die zulässige Norm ergibt sich aus der KORREKTUR-SPRACHE-Regel weiter unten.
- Abgrenzung: reine Schreibung des Einzelworts → «rechtschreibung». Kommasetzung, Kasus/Kongruenz, Verbformen → «grammatik».
- Typische Fehlerklassen:
  · Homophone / Verwechslungen: das/dass, seit/seid, wider/wieder, Lid/Lied, Saite/Seite, Ende/Ente.
  · Getrennt- und Zusammenschreibung: «kennenlernen», «sodass», «infrage», «aufgrund», «zurzeit» – fälschliche Trennung oder Zusammenziehung.
  · Gross-/Kleinschreibung im Satzinnern: Substantivierungen grossschreiben («das Schöne», «im Allgemeinen», «etwas Neues»); nominalisierte Verben/Adjektive; Verben/Adjektive klein.
  · Doppelkonsonanten/-vokale, Dehnung/Schärfung, Fugen-s, Endungen (-ig/-lich/-isch) – z.B. «Standart» statt «Standard», «wiederspiegeln» statt «widerspiegeln».
  · Tippfehler, Buchstabendreher, fehlende oder zusätzliche Buchstaben.
- «original»: das falsch geschriebene Wort (bei Getrennt-/Zusammenschreibung die ganze Wortgruppe) zeichengenau.
- «korrektur»: dieselbe Stelle korrekt geschrieben (1:1-Ersatz, gleicher Span-Typ).
- «erklaerung»: EIN Satz, benennt die Regel («das (Artikel) vs. dass (Konjunktion)», «Zusammenschreibung: kennenlernen», «Substantivierung grossschreiben»).
- AUCH in direkter Rede / Dialog melden – Ausnahme nur bei klar erkennbarer, bewusst gesetzter Figurensprache/Dialekt.`;
}

// `typen` = aktives Typ-Enum des Laufs. Die Abgrenzungs-Verweise werden darauf
// gefiltert, weil im Stil-Pass grammatik/rechtschreibung nicht gemeldet werden
// dürfen (siehe verweisTypen in prompts/lektorat-typen.js).
export function _buildStilBlock(typen = []) {
  const spezifisch = verweisTypen(
    ['satzbau', 'schwaches_verb', 'fuellwort', 'wiederholung', 'passiv', 'show_vs_tell', 'grammatik', 'rechtschreibung'],
    typen,
  ).join(', ');
  const nichtAbgedeckt = [
    'holprige Wortstellung / schwerfälliger oder verschachtelter Satzbau / monotoner Satzrhythmus (→ satzbau)',
    'einzelne schwache Verben (→ schwaches_verb)',
    'einzelne Füllwörter (→ fuellwort)',
    'Wortwiederholung (→ wiederholung)',
    'abstraktes Telling (→ show_vs_tell)',
    'Passivkonstruktion (→ passiv)',
    `Grammatikfehler (→ ${verweisZiel('grammatik', typen)})`,
  ].join(', ');
  return `
Stil-Regeln (typ: «stil»):
- «stil» ist KEIN Auffang-Eimer. Er greift NUR für stilistische Schwächen, die KEINEM spezifischeren Typ zugeordnet werden können.
- Wenn ein spezifischerer Typ passt (${spezifisch}) → diesen Typ verwenden, NICHT «stil».
- «stil» deckt ab: gestelzte oder umständliche Wortwahl, Stilbruch im Register (z.B. Bürokratendeutsch in literarischem Text), unklare Bezüge / Mehrdeutigkeit, falsch gewählte Idiomatik / Kollokation, übermässige Adjektiv-/Adverb-Häufung.
- «stil» deckt NICHT ab: ${nichtAbgedeckt}.
- In direkter Rede / Dialog NICHT melden: Figurensprache darf holprig, gestelzt oder unidiomatisch sein – das charakterisiert die Figur. «stil» gilt ausschliesslich für Erzähltext.
- «original»: vollständiger Satz oder eindeutig abgrenzbare Phrase zeichengenau aus dem Text.
- PFLICHT: «korrektur» muss immer eine konkrete Umformulierung enthalten – nicht leer lassen, nicht dasselbe wie «original». Keine Stilanmerkung ohne konkreten Verbesserungsvorschlag.
- «erklaerung»: EIN Satz, benennt die stilistische Schwäche («gestelzte Wortwahl», «unklarer Bezug», «Adjektiv-Häufung»).
- Selbsttest: Lässt sich die Schwäche präzise mit einem der spezifischen Typen benennen? Wenn ja → spezifischen Typ verwenden, «stil» weglassen.`;
}

export function _buildSatzbauBlock(typen = []) {
  // Ohne aktives «grammatik» (Stil-Pass) muss die Abgrenzung ins Leere zeigen,
  // nicht auf einen Typ, den der Lauf nicht ausgeben darf – sonst wird der
  // Grammatikfehler als «satzbau» umetikettiert statt weggelassen.
  const grammatikZiel = typen.includes('grammatik')
    ? 'typ «grammatik», NICHT «satzbau»'
    : `${OBJEKTIV_VERWEIS} (weder «satzbau» noch «stil»)`;
  return `
Satzbau-Regeln (typ: «satzbau»):
- «satzbau» greift, wenn ein Satz GRAMMATISCH KORREKT, aber ungeschickt KONSTRUIERT ist und dadurch schwer lesbar wirkt. Es geht um die Architektur des Satzes (Reihenfolge, Verschachtelung, Rhythmus), nicht um Wortwahl.
- Abgrenzung (Pflicht):
  · Ist die Wortstellung grammatisch FALSCH (Verbzweit-/Verbletztstellung verletzt, falscher Bezug) → ${grammatikZiel}.
  · Geht es um Register, Idiomatik, Adjektiv-Häufung, Nominalstil eines Einzelworts, Mehrdeutigkeit → typ «stil».
  · «satzbau» = der Satz ist regelkonform, liest sich aber holprig wegen seiner Konstruktion.
- Typische Muster:
  · SCHACHTELSATZ: tief verschachtelte Nebensätze / verschränkte Konstruktion, bei der der Leser den Faden verliert; weit auseinandergerissene Satzklammer (Subjekt und finites Verb / Hilfsverb und Partizip durch lange Einschübe getrennt).
  · MONOTONIE: mehrere aufeinanderfolgende Sätze mit identischem Bau oder identischem Satzanfang (z.B. drei Sätze nacheinander «Er …», «Er …», «Er …»; reihenweise gleich lange Hauptsätze).
  · UMSTÄNDLICHE KONSTRUKTION: schwerfällige Voranstellungen, übermässige Inversion, gestelzte Wortfolge, Nominalstil-Bandwurm über den ganzen Satz, der sich klarer als Verbalstil sagen liesse.
- In direkter Rede / Dialog NICHT melden: Figurensprache darf holprig oder verschachtelt sein. «satzbau» gilt ausschliesslich für Erzähltext.
- «original»: vollständiger Satz (bei Monotonie der erste betroffene Satz) ODER eindeutig abgrenzbare Phrase zeichengenau aus dem Text – denselben Span-Typ in «korrektur» beibehalten.
- «korrektur»: derselbe Satz klarer konstruiert (entschachteln, Klammer schliessen, Satzanfang variieren, Nominal- zu Verbalstil) – Bedeutung und Stimme erhalten, nicht bloss kürzen.
- «erklaerung»: EIN Satz, benennt das verletzte Muster («tief verschachtelter Schachtelsatz», «dritter Satz in Folge mit gleichem Anfang», «weit auseinandergerissene Satzklammer»).
- Severity-Schwelle: nur deutliche Fälle, die ein Lektor anstreichen würde. Ein leicht längerer, aber gut lesbarer Satz ist KEIN Finding. Bei Zweifel → weglassen.`;
}

// sw: explizite Stoppwort-Liste; Caller muss sie übergeben (kein globaler Fallback).
export function _buildWiederholungBlock(sw = []) {
  const swNote = sw.length > 0
    ? `\n- Stoppwörter nie melden (auch flektierte Formen): ${sw.join(', ')}`
    : '';
  return `
Wiederholung-Regeln (typ: «wiederholung»):
- Nur Inhaltswörter, die auffällig oft vorkommen: mind. 3× auf der gesamten Seite ODER 2× im selben oder direkt aufeinanderfolgenden Absatz
- LEMMA-/STAMMBASIERT zählen, nicht oberflächlich nach Wortform: «lief / läuft / gelaufen / liefen» zählen alle als Wiederholung des Stamms «laufen». «Sonne / sonnig / sonnenklar» als Stamm «Sonn-». Auch Komposita mit identischem Kern zählen mit («Hauptmann / Mannschaft / Mann»). Wortformen einzelner Lemmas separat aufzulisten ist verboten.
- Keine Pronomen, Hilfsverben, Artikel, Konjunktionen, Präpositionen, Eigennamen${swNote}
- In direkter Rede / Dialog konservativer: Wiederholungen in Figurensprache sind oft bewusste Charakterisierung – nur melden, wenn die Wiederholung den Erzähltext (nicht die Figurenrede) betrifft, oder eine Figur derart auffällig wiederholt, dass es als Sprachfehler statt Charakterisierung wirkt.
- «original»: vollständiger Satz zeichengenau aus dem Text (damit die Textstelle eindeutig auffindbar ist)
- «korrektur»: derselbe Satz mit dem besten Synonym – exakt gleiche grammatische Form (Kasus, Numerus, Tempus)
- «erklaerung»: EIN Satz, nennt das wiederholte Wort bzw. den Stamm («Stamm «laufen» dreimal auf der Seite»)
- Synonym-Selbsttest vor jedem Eintrag: Klingt der Satz danach natürlich? Bedeutung erhalten? Passt zum Autorenstil?`;
}

export function _buildSchwacheVerbenBlock() {
  return `
Schwache-Verben-Regeln (typ: «schwaches_verb»):
- Schwache, blasse oder nichtssagende Verben identifizieren
- Typische schwache Verben: machen, tun, sein, haben, geben, gehen, kommen, bringen, stehen, liegen, sagen, meinen, finden u.ä.
- Nur melden, wenn ein ausdrucksstärkeres Verb den Satz spürbar verbessert — keine Pedanterie bei idiomatischen Wendungen oder Hilfsverb-Konstruktionen
- In direkter Rede / Dialog konservativer: blasse Verben in Figurensprache sind oft authentisch (Alltagston). Nur melden, wenn das Verb im Erzähltext steht oder die Figurenrede auffällig flach klingt und durch ein präziseres Verb messbar gewinnt.
- «original»: vollständiger Satz zeichengenau aus dem Text (damit die Textstelle eindeutig auffindbar ist)
- «korrektur»: derselbe Satz mit dem stärkeren Verb — exakt gleiche grammatische Form und Tempus
- «erklaerung»: EIN Satz, benennt das schwache Verb und den Gewinn («blasses «machen» – präziseres Verb möglich»)
- Selbsttest vor jedem Eintrag: Ist das Ersatzverb wirklich präziser und bildstärker? Passt es zum Stil und Ton des Textes?`;
}

export function _buildFuellwortBlock() {
  return `
Füllwort-Regeln (typ: «fuellwort»):
- Überflüssige Füllwörter identifizieren, die den Text verwässern
- Typische Füllwörter: eigentlich, irgendwie, quasi, halt, eben, wohl, ja, doch, mal, nun, also, natürlich, gewissermassen, sozusagen, durchaus, ziemlich, etwas, ein wenig, ein bisschen u.ä.
- Nur melden, wenn das Streichen oder Ersetzen den Satz strafft, ohne Bedeutung oder Stimme zu verlieren — in Dialogen können Füllwörter bewusst eingesetzt sein
- «original»: vollständiger Satz zeichengenau aus dem Text
- «korrektur»: derselbe Satz ohne das Füllwort (oder mit knapperer Formulierung)
- «erklaerung»: EIN Satz, nennt das Füllwort («überflüssiges «eigentlich»»)
- Selbsttest: Verliert der Satz durch die Streichung an Rhythmus, Stimme oder Bedeutungsnuance? Dann weglassen.`;
}

// Quellennachweise im Text (Quellenverzeichnis-Feature). PASSIVER Kontext, kein
// eigener Fehlertyp: das Modell sieht den Beleg nur als Klartext im Satz —
// „(Müller, 2020, S. 44)" bzw. „[12]" — und würde ihn sonst als Füllwerk,
// Klammer-Einschub oder Stilbruch anstreichen und wegkorrigieren. Ein
// angewandter Vorschlag zerstört dabei den Zeiger auf die Quelle.
// Wird nur eingehängt, wenn die Seite tatsächlich Belege trägt (Option
// `hatBelege`) — in einem Roman wäre die Regel sinnloser Ballast.
export function _buildBelegBlock(langCode = 'de') {
  const beispiele = langCode === 'en'
    ? '"(Müller, 2020, p. 44)", "(Müller 2020, 44)", "[12]"'
    : '«(Müller, 2020, S. 44)», «(Müller 2020, 44)», «[12]»';
  return `
Quellennachweise (WICHTIG — nicht anfassen):
- Dieser Text enthält wissenschaftliche Kurzbelege, z.B. ${beispiele}
- Kurzbelege sind KEIN Stilproblem: nicht als Füllwort, Klammer-Einschub, Wiederholung, Satzbaufehler oder Klischee melden
- Kurzbelege NICHT umformulieren, kürzen, verschieben oder entfernen — auch nicht innerhalb eines «korrektur»-Vorschlags
- Enthält ein Satz einen Kurzbeleg und hat er einen echten Fehler daneben, muss der Beleg im «korrektur»-Feld ZEICHENGENAU unverändert erhalten bleiben
- Namen und Jahreszahlen in Kurzbelegen sind keine Rechtschreib- oder Grammatikfehler`;
}

export function _buildShowVsTellBlock() {
  return `
Show-vs-Tell-Regeln (typ: «show_vs_tell»):
- Stellen identifizieren, an denen Emotionen, Eigenschaften oder Zustände abstrakt benannt statt szenisch gezeigt werden
- Typische Muster:
  · «sein»/«fühlen»/«wirken» + Adjektiv für Innenleben: «Er war wütend», «Sie fühlte sich traurig», «Er wirkte nervös», «Sie schien erschöpft»
  · Zustandsverben mit Eigenschafts-Etikett: «Das Haus war alt», «Die Stimmung war gedrückt», «Es herrschte Stille»
  · Abstrakte Substantive als Subjekt oder Prädikatsnomen: «Die Schönheit der Landschaft überwältigte ihn», «Es war pure Trauer in ihren Augen», «Ein Gefühl der Einsamkeit erfasste sie»
  · Erklärende Adverbien statt Handlung: «sagte er wütend», «antwortete sie traurig» (ein EINZELNES solches Redebegleit-Adverb gehört hierher; erst die gehäufte Inquit-Adverb-Inflation über die Passage ist «ki_geruch»)
- «original»: vollständiger Satz zeichengenau aus dem Text
- «korrektur»: derselbe Satz umformuliert mit konkreten Sinneseindrücken, Handlungen, Körpersprache oder Details, die das Gleiche zeigen (NICHT der ganze Absatz – nur den einen Satz ersetzen)
- «erklaerung»: EIN Satz, benennt das Telling («Gefühl benannt statt gezeigt», «erklärendes Inquit-Adverb statt Handlung»)
- In direkter Rede / Dialog NICHT melden: Figuren dürfen abstrakt über ihre Gefühle sprechen («Ich bin müde»). Show-vs-Tell gilt ausschliesslich für Erzähltext.
- Nur melden, wenn eine szenische Darstellung den Text spürbar lebendiger macht — nicht jede abstrakte Aussage muss umgeschrieben werden (z.B. in Zusammenfassungen, Rückblenden oder schnellen Übergängen ist Telling erlaubt und stilistisch korrekt)
- Selbsttest: Passt die szenische Variante zum Erzähltempo und zur Szene? Nicht aufblähen. Würde die szenische Variante den Lesefluss bremsen, obwohl die Stelle gerade Tempo braucht? Dann weglassen.`;
}

export function _buildFilterwortBlock() {
  return `
Filterwort-Regeln (typ: «filterwort»):
- Wahrnehmungs-/Kognitions-Verben identifizieren, die die POV-Figur zwischen Leser und Erfahrung schieben («sah», «hörte», «fühlte», «bemerkte», «erkannte», «dachte», «beobachtete», «spürte», «schaute», «blickte», «entdeckte»). Beispiel: «Sie sah, wie er die Tür öffnete» → distanziert; «Er öffnete die Tür» → unmittelbar.
- Nur im Erzähltext aus personaler / Ich-Perspektive melden. In auktorialer Erzählweise sind Wahrnehmungsverben legitim. In direkter Rede / Dialog NICHT melden.
- Nicht melden, wenn die Wahrnehmung selbst der Punkt ist («Erst jetzt sah sie, dass …» – Erkenntnis ist Plot-Beat).
- «original»: vollständiger Satz zeichengenau aus dem Text.
- «korrektur»: derselbe Satz ohne Filter-Verb, mit der Wahrnehmungssache direkt geschildert.
- «erklaerung»: EIN Satz, benennt das Filterverb («Wahrnehmungsverb «sah» schiebt sich zwischen Leser und Szene»).
- Selbsttest: Wird das Filterverb gestrichen und das Wahrgenommene direkt erzählt, gewinnt der Satz an Unmittelbarkeit? Wenn nein → weglassen.`;
}

export function _buildKlischeeBlock() {
  return `
Klischee-Regeln (typ: «klischee»):
- Abgenutzte Bildsprache, abgegriffene Metaphern, Phrasen, die in deutschsprachiger Romanprosa als Klischee gelten. Beispiele: «das Herz raste», «ein kalter Schauer lief ihm den Rücken hinunter», «Augen wie Smaragde», «die Welt blieb stehen», «Schmetterlinge im Bauch», «Gänsehaut überzog ihre Arme», «sein Blut gefror», «Tränen kullerten».
- Auch melden: schiefe Bilder / gemischte Metaphern (zwei unvereinbare Bildebenen in einem Satz), tote Vergleiche («wie ein Blitz», «schwarz wie die Nacht»), reflexartige Genre-Phrasen.
- In direkter Rede / Dialog NICHT melden: Figuren dürfen klischeehaft sprechen.
- «original»: Phrase ODER vollständiger Satz zeichengenau aus dem Text (denselben Span-Typ in «korrektur» beibehalten).
- «korrektur»: konkretes, frisches Bild oder schlichte Beschreibung – nicht das nächste Klischee.
- Abgrenzung: abgenutzte, aber konkrete Bilder/Phrasen → «klischee»; hohle, generische LLM-Floskeln ohne Bodenhaftung («Reise zu sich selbst», «Symphonie der Gefühle») → «ki_geruch».
- «erklaerung»: EIN Satz, benennt das Klischee («abgegriffene Metapher», «toter Vergleich», «gemischtes Bild»).
- Selbsttest: Würde ein professioneller Lektor die Stelle als «zu abgegriffen» markieren? Bei Zweifel weglassen.`;
}

export function _buildPleonasmusBlock() {
  return `
Pleonasmus-Regeln (typ: «pleonasmus»):
- Redundanz / doppelte Bedeutung in einer Phrase. Beispiele: «weisser Schimmel», «tote Leiche», «nickte zustimmend mit dem Kopf», «zuckte mit den Schultern hoch», «zurückkehren wieder», «kleines Detail», «ganz und gar», «runde Kugel», «schwarze Dunkelheit», «hörbares Geräusch».
- Auch melden: Body-Part-Autonomy mit redundantem Bezug («seine Augen blickten ihn an»), tautologische Adjektiv-Substantiv-Paare.
- Nicht melden, wenn die Doppelung als bewusste Verstärkung lesbar ist (Lyrik, ironisches Register, Figurenrede mit Charakterisierung).
- «original»: die redundante Phrase zeichengenau aus dem Text (Span = Phrase).
- «korrektur»: dieselbe Phrase ohne Redundanz – nur die nicht-überflüssige Komponente bleibt stehen.
- «erklaerung»: EIN Satz, benennt die Redundanz («weisser Schimmel – ein Schimmel ist immer weiss»).
- Selbsttest: Geht Information verloren, wenn der redundante Teil gestrichen wird? Wenn nein → melden.`;
}

export function _buildAiSmellBlock() {
  return `
KI-Geruch-Regeln (typ: «ki_geruch»):
- Stellen identifizieren, die nach generischer LLM-Prosa klingen – aufgesetzte Bedeutsamkeit, leere Eleganz, sprachliche Tics, die in massenhaft KI-erzeugten Texten wiederkehren. Ziel ist NICHT, KI-Urheberschaft zu beweisen, sondern Passagen zu markieren, deren Tonfall an seelenlose Maschinenprosa erinnert und die literarische Stimme verwässert.
- Vier konkrete Muster (mindestens eines muss klar erfüllt sein):
  · GENERIC-ADJEKTIVE: leere Intensitäts- und Bedeutungssteigerer ohne sinnliche Verankerung («atemberaubend», «überwältigend», «gewaltig», «sanft», «zart», «geheimnisvoll», «magisch», «episch», «wunderschön», «unendlich», «zeitlos», «pur», «rein», «kristallklar», «samtweich», «strahlend»). Vor allem in Häufung oder als Adjektiv-Kette mehrerer dieser Wörter im gleichen Satz/Absatz.
  · TRICOLA / PARALLELISMUS: dreigliedrige Aufzählung mit auffallend gleicher Satzlänge oder gleichem Bau («Er sah sie, er hörte sie, er fühlte sie.», «Die Stille. Die Leere. Die Kälte.», «Nicht aus Wut, nicht aus Trauer, nicht aus Verzweiflung.»). Typischer LLM-Rhythmus-Tic; vereinzelt vertretbar, gehäuft KI-Marker.
  · GENERISCHE METAPHERN: abstrakte Sinnbild-Phrasen ohne Bodenhaftung («Reise zu sich selbst», «Tanz des Schicksals», «Symphonie der Gefühle», «Echo der Vergangenheit», «Wandteppich der Zeit», «Faden der Erinnerung», «Spiegel der Seele», «Schleier des Vergessens», «Funke der Hoffnung»). Hohle Metapher-Floskeln, die auf alles und nichts passen.
  · ERKLÄR-TICS / AUFGESETZTE BEDEUTSAMKEIT: Inquit-Adverbien-INFLATION (mehrere erklärende Redebegleit-Adverbien gehäuft in derselben Passage: «sagte sie nachdenklich» … «flüsterte er sanft» … «erwiderte sie zögernd» …; ein EINZELNES solches Adverb gehört zu «show_vs_tell», nicht hierher), Bedeutungs-Präambeln («Mit jedem Atemzug ...», «In diesem Moment wusste sie ...», «Es war, als ob ...», «Tief in ihrem Inneren ...», «Etwas in ihr ...»), redundante Gefühls-Doppelung («ein Lächeln, das gleichzeitig Trauer und Hoffnung trug»).
- «original»: vollständiger Satz oder eindeutig abgrenzbare Phrase zeichengenau aus dem Text (denselben Span-Typ in «korrektur» beibehalten).
- «korrektur»: konkrete Umformulierung mit sinnlicher Verankerung, präzisem Verb, eigener Stimme – nicht bloss kürzen, nicht das nächste KI-Muster.
- «erklaerung»: EIN Satz, benennt das verletzte Muster («Generic-Adjektive ohne sinnliche Verankerung», «Tricola-Rhythmus mit drei parallelen Kola», «generische Metapher ohne Bodenhaftung», «Erklär-Inquit / aufgesetzte Bedeutsamkeit»).
- In direkter Rede / Dialog NICHT melden: Figuren dürfen klischeehaft oder pathetisch sprechen – das charakterisiert. «ki_geruch» gilt ausschliesslich für Erzähltext.
- NICHT melden bei: bewusstem Pathos (Trauerrede, feierlicher Anlass, Prolog/Epilog mit erhöhtem Ton), Ironie/Persiflage, lyrischen Passagen mit deutlich poetischem Register, Genre-Konvention (Märchen, Fabel, Saga).
- Severity-Schwelle: nur deutliche Fälle. Ein einzelnes Generic-Adjektiv im sonst dichten Erzähltext → weglassen. Häufung im selben Satz/Absatz oder leerer Bedeutungs-Satz → melden.
- Selbsttest: Liest sich diese Stelle wie generische LLM-Prosa, die in tausend anderen Texten genauso stehen könnte? Würde sie verloren gehen, wenn ein professioneller Lektor sie streicht? Wenn ja → melden. Bei Zweifel → weglassen.`;
}

export function _buildFigurenkonsistenzBlock() {
  return `
Figurenkonsistenz-Regeln (typ: «namenskonsistenz», «figurenmerkmal», «anrede»):
- Diese Typen werden AUSSCHLIESSLICH gegen den oben gelieferten Figuren-Block + Beziehungs-Block geprüft. KEINE externe Welt-Annahme, kein Schluss aus Eigennamen-Klang, kein Raten. Wenn der Stamm zur Stelle schweigt (keine entsprechende Eigenschaft / Beziehung dokumentiert) → Eintrag verwerfen.
- typ «namenskonsistenz»:
  · Eine Figur wird mit einer Schreibvariante genannt, die weder ihrem «name» noch ihrem «kurzname» im Figuren-Block entspricht (z.B. «Hannah» wo der Stamm «Hanna» sagt; «Mayer» wo der Stamm «Meier» sagt).
  · Span: einzelnes Wort (der falsch geschriebene Name).
  · «korrektur»: kanonische Schreibweise aus dem Stamm.
  · «erklaerung»: MUSS die kanonische Form aus dem Figuren-Block zitieren («laut Figurenkartei: Hanna»).
- typ «figurenmerkmal»:
  · Eine Aussage im Text widerspricht einer im Figuren-Block dokumentierten Eigenschaft: Geschlecht/Pronomen (Stamm «weiblich» → Text «er»), Beruf, etablierte Beschreibung (Aussehen / Alter / Herkunft) sofern explizit im Stamm hinterlegt.
  · Span: Phrase (das widersprüchliche Wort / die widersprüchliche Phrase).
  · «korrektur»: Phrase im selben Span-Typ, korrigiert gegen den Stamm.
  · «erklaerung»: MUSS Quelle nennen («laut Figurenkartei: weiblich, Pronomen «sie»» bzw. «laut Figurenkartei: Lehrerin»).
- typ «anrede»:
  · Du/Sie + Anrede­form widerspricht der etablierten Beziehung im Beziehungs-Block (z.B. «Sie» an einen Bruder, «du» an einen Vorgesetzten).
  · Span: die Anrede-Phrase.
  · «korrektur»: Anrede passend zur Beziehung.
  · «erklaerung»: MUSS Beziehungs-Typ aus dem Beziehungs-Block zitieren («laut Beziehungen: Geschwister – duzen üblich»).
- Nicht melden in direkter Rede, wenn die Abweichung als Charakterisierung lesbar ist (Figur lügt, irrt, beleidigt absichtlich, sieztgesteltt) – das ist Subtext, kein Fehler.
- Severity-Schwelle: nur melden, wenn der Widerspruch deutlich ist und ein Lektor ihn anstreichen würde. Bei Unklarheit / Stamm-Schweigen / mehrdeutiger Stelle: weglassen.`;
}

export function _buildSchauplatzkonsistenzBlock() {
  return `
Schauplatzkonsistenz-Regeln (typ: «schauplatzmerkmal»):
- Wird AUSSCHLIESSLICH gegen den oben gelieferten Schauplätze-Block geprüft. KEINE externe Welt-Annahme. Wenn der Stamm zur Stelle schweigt → verwerfen.
- Aussage im Text widerspricht einer im Orts-Block dokumentierten Eigenschaft: Typ (Stadt/Dorf/Wald/…), Stimmung, etablierte Beschreibung (Grösse, Lage, Merkmale) sofern explizit hinterlegt.
- «original»: Phrase zeichengenau aus dem Text.
- «korrektur»: Phrase, korrigiert gegen den Stamm.
- «erklaerung»: MUSS Quelle nennen («laut Orts-Kartei: kleines Dorf, nicht Stadt»).
- Nicht melden bei nachvollziehbarer dramaturgischer Veränderung im Plot (Ort wurde im Verlauf zerstört, umgebaut, anders geworden) – nur Widersprüche zur etablierten Welt, nicht zur Welt-Entwicklung.
- Severity-Schwelle: nur deutliche Widersprüche. Stamm-Schweigen → kein Eintrag.`;
}

// Locale-scharf: liefert NUR die Normen der Buch-Sprache (DE oder EN).
// langCode = 'de' (default) | 'en'.
export function _buildDialogformatBlock(langCode = 'de') {
  if (langCode === 'en') {
    return `
Dialogue-format rules (typ: «dialogformat»):
- Typographic correctness of direct speech, English convention. Within a book the choice must be consistent – the variant established by the book is the norm, deviations from it are findings.
- Quotation marks: "…" (typographic double quotes). Nested quote: '…' (single).
- Punctuation ALWAYS inside the quotes: «"Come here," she said.» – comma sits before the closing «"», tag verb lowercase.
- Tag after !/?: «"Come here!" she shouted.» – the «,» is replaced by «!» / «?», tag verb still lowercase.
- Independent following sentence instead of tag: «"Come here." She smiled.» – period INSIDE the quotes, capital letter follows.
- Interrupted speech: «"Wait—"» (em-dash). Trailing off: «"I don't…"» (ellipsis).
- Speaker change → new paragraph. Multiple sentences by the same speaker stay in one paragraph.
- «original»: phrase copied character-exact from the text – precisely the typographically wrong span (closing quote + tag transition, stray straight quote «"» / «'», misplaced comma, wrongly capitalised tag verb).
- «korrektur»: same phrase typographically correct; same span type.
- «erklaerung»: ONE sentence naming the rule that was broken («comma belongs inside the closing quote», «tag verb after comma should be lowercase», «straight ASCII quotes instead of typographic «"…"»», …).
- DO NOT report: a quotation-mark style the book uses consistently throughout (that IS the book's norm, not an error); letter/SMS/diary inserts with their own convention; single highlighted words in quotes (not actual speech).
- Self-test: would an editor flag this spot as typographically wrong or inconsistent? If the choice is deliberate and consistently maintained → leave it out.`;
  }
  // Default: Deutsch
  return `
Dialogformat-Regeln (typ: «dialogformat»):
- Typografische Korrektheit der direkten Rede, deutsche Norm. Innerhalb eines Buchs muss die Wahl konsistent sein – etablierte Variante des Buchs ist die Norm, Abweichungen davon sind Findings.
- Anführungszeichen: «„…"» (U+201E unten, U+201C oben) ODER «…» (Guillemets, Spitzen nach aussen). Konsistent innerhalb des Buchs. Gerade ASCII-Quotes ("…", '…') sind in deutscher Romanprosa falsch.
- Zitat im Zitat: ‚…' (halbe Gänsefüsschen).
- Inquit-Komma nach Schlusszeichen: «„Komm her", sagte sie.» – Komma steht nach dem schliessenden Anführungszeichen; Inquit-Verb kleingeschrieben.
- Inquit nach !/?: «„Komm her!" rief sie.» – Satzzeichen bleibt drin, KEIN zusätzliches Komma, Inquit-Verb klein.
- Eigenständiger Folgesatz statt Inquit: «„Komm her." Sie lächelte.» – Punkt am Ende der Rede, Grossbuchstabe folgt.
- Eingeschobenes Inquit: «„Komm her", sagte sie, „aber leise."» – Fortsetzung der Rede klein.
- Sprecherwechsel: neuer Absatz. Mehrere Sätze desselben Sprechers bleiben im selben Absatz.
- «original»: Phrase zeichengenau aus dem Text – exakt der typografisch falsche Bereich (Schlussklammer + Inquit-Übergang, einzelnes falsches Anführungszeichen, falsche Komma-Position, falsch grossgeschriebenes Tag-Verb).
- «korrektur»: dieselbe Phrase typografisch korrekt; gleicher Span-Typ.
- «erklaerung»: EIN Satz, benennt die verletzte Regel («Komma gehört nach das schliessende Anführungszeichen», «Inquit-Verb nach Komma kleinschreiben», «gerade ASCII-Quotes statt typografischer Gänsefüsschen», …).
- NICHT melden: Anführungszeichen-Stil, der im Buch durchgehend konsistent gewählt ist (das ist die Norm des Buchs, nicht ein Fehler). Brief-/SMS-/Tagebuch-Einschübe mit eigener Konvention. Einzelne hervorgehobene Wörter in Quotes (keine echte Rede).
- Selbsttest: Würde ein Lektor diese Stelle als typografisch falsch oder uneinheitlich anstreichen? Wenn die Wahl bewusst und konsequent durchgehalten ist → weglassen.`;
}

export function _buildPassivBlock() {
  return `
Passivkonstruktionen-Regeln (typ: «passiv»):
- Melde vermeidbare VORGANGSPASSIVE (werden + Partizip II), die den Text schwerfällig oder unpersönlich machen, weil das handelnde Subjekt verschwindet. Beispiel: «Die Tür wurde von ihr geöffnet.» → aktiv «Sie öffnete die Tür.»
- NICHT melden: Zustandspassiv (sein + Partizip II), das einen Zustand statt einen Vorgang beschreibt («Die Tür war geschlossen.», «Das Fenster ist zerbrochen.») – meist legitim und kein Passiv im engeren Sinn.
- «original»: vollständiger Satz, zeichengenau aus dem Text.
- «korrektur»: derselbe Satz in aktiver Formulierung — benenne das handelnde Subjekt klar.
- «erklaerung»: EIN Satz, benennt den Grund («Vorgangspassiv verschleiert das handelnde Subjekt – Aktiv ist klarer»).
- In direkter Rede / Dialog: melde konservativer. Figuren-Passiv spiegelt oft Sprechgewohnheit oder Distanz – flagge nur, wenn die Stelle auch im Dialog hörbar holpert.
- Melde nicht, wenn der Autor das Passiv bewusst setzt (Täter unbekannt/unwichtig, wissenschaftlicher Stil, Betonung auf dem Objekt) oder die Aktivform gezwungen klingt.
- Selbsttest: Klingt deine Aktivformulierung klarer, lebendiger und natürlich im Kontext? Wenn nein → weglassen.`;
}

export function _buildPerspektivbruchBlock() {
  return `
Perspektivbruch-Regeln (typ: «perspektivbruch»):
- WENN oben ein Block «Etablierte Erzählform des Buchs» angegeben ist, ist DAS die verbindliche Referenz – primär gegen diese Vorgabe prüfen, nicht gegen Default-Annahmen über den Text. Eine Stelle, die der vorgegebenen Erzählperspektive widerspricht, ist ein Bruch (sofern nicht durch eine der Ausnahmen unten gedeckt).
- WENN kein Erzählform-Block vorliegt: die in den ersten Absätzen der Seite etablierte Perspektive aus dem Text ableiten und gegen Abweichungen prüfen.
- Stellen identifizieren, an denen die Erzählperspektive innerhalb einer Szene unbeabsichtigt wechselt
- Typische Brüche: Wissen oder Gedanken einer Figur beschreiben, die nicht die aktuelle Perspektivfigur ist; plötzlicher Wechsel zwischen Ich-Erzähler und auktorialem Erzähler; Informationen, die der Perspektivfigur nicht zugänglich sind
- «original»: vollständiger Satz zeichengenau aus dem Text
- «korrektur»: derselbe Satz so umformuliert, dass er zur etablierten Perspektive der Szene passt
- «erklaerung»: benennen, welche Perspektive etabliert ist (mit Verweis auf den Erzählform-Block, falls vorhanden) und worin der Bruch besteht
- Nicht melden bei bewusst auktorialer Erzählweise oder bei expliziten Perspektivwechseln (z.B. nach Szenenumbruch); nicht in direkter Rede / Dialog (Figuren reden aus ihrer eigenen Perspektive); nicht in zitierten Briefen / Tagebucheinträgen.`;
}

export function _buildTempuswechselBlock() {
  return `
Tempuswechsel-Regeln (typ: «tempuswechsel»):
- WENN oben ein Block «Etablierte Erzählform des Buchs» angegeben ist, ist DAS die verbindliche Referenz – primär gegen diese Vorgabe prüfen, nicht gegen Default-Annahmen. Ein Satz im Präsens innerhalb eines per Buch-Konfiguration auf Präteritum festgelegten Erzähltextes ist ein Bruch (sofern nicht durch eine der Ausnahmen unten gedeckt).
- WENN kein Erzählform-Block vorliegt: das in den ersten Absätzen der Seite dominante Tempus aus dem Text ableiten und gegen Abweichungen prüfen.
- VORGEHEN (Pflicht, systematisch – nicht stichprobenartig): Prüfe das finite Verb JEDES Erzählsatzes gegen das etablierte Erzähltempus. Jeder Erzählsatz, dessen finites Verb ohne dramaturgischen Grund vom etablierten Tempus abweicht, ist ein Bruch und wird gemeldet. Tempusbrüche sind ein häufig übersehener, aber objektiver Fehler – behandle sie wie einen Grammatikfehler, nicht wie eine Geschmacksfrage. Im Zweifel, ob ein Wechsel beabsichtigt ist, lieber melden (der Autor entscheidet beim Durchsehen).
- Typisch: Erzählung im Präteritum mit plötzlichem Wechsel ins Präsens (oder umgekehrt), ohne dass ein Stilmittel erkennbar ist
- «original»: vollständiger Satz zeichengenau aus dem Text
- «korrektur»: derselbe Satz im korrekten Tempus der umgebenden Passage
- «erklaerung»: benennen, welches Tempus in der Passage etabliert ist (mit Verweis auf den Erzählform-Block, falls vorhanden) und welches im Satz verwendet wird
- Nicht melden bei: Plusquamperfekt für Rückblenden, historischem Präsens als bewusstem Stilmittel, Tempuswechsel in direkter Rede / Dialog (Figuren sprechen in ihrer eigenen Zeit), zitierten Briefen / Tagebucheinträgen / Nachrichten, Wechsel an Szenen-/Kapitelgrenzen, allgemeingültigen Aussagen / zeitlosen Wahrheiten im Präsens innerhalb einer Präteritum-Erzählung («Die Sonne geht im Osten auf»), sowie auktorialem Erzähler-/Chronisten-Kommentar aus der Erzählgegenwart (gnomisches Präsens der Erzählinstanz, die aus ihrer Gegenwart auf die im Präteritum erzählte Handlung blickt, z.B. «Doch das ist eine andere Geschichte», «Wir wollen nicht vorgreifen», «Man ahnt bereits, wohin das führt»).`;
}

/**
 * Erzeugt den Erzählform-Kontextblock für Bewertungs-/Lektorat-Prompts.
 * Bei buchtyp='kurzgeschichten' wird die Angabe als Richtwert deklariert, da
 * einzelne Kurzgeschichten legitim eine andere Perspektive oder Erzählzeit
 * verwenden können. Gibt '' zurück, wenn weder perspektive noch zeit gesetzt
 * sind (kein Block im Prompt).
 *
 * @param {string|null} perspektive  lesbares Label (z.B. '3. Person personal')
 * @param {string|null} zeit         lesbares Label (z.B. 'Präteritum')
 * @param {string|null} buchtyp      Buchtyp-Key (z.B. 'kurzgeschichten')
 * @param {'lektorat'|'review'} mode 'lektorat' verweist auf perspektivbruch/tempuswechsel;
 *                                   'review' bleibt neutraler ("Konsistenzprüfung")
 */
export function _buildErzaehlformBlock(perspektive, zeit, buchtyp, mode = 'lektorat') {
  if (!perspektive && !zeit) return '';
  const isShortStories = buchtyp === 'kurzgeschichten';
  const header = isShortStories
    ? 'Erzählform der Sammlung (Richtwert – einzelne Kurzgeschichten dürfen legitim abweichen; Abweichungen NICHT als Fehler melden, wenn sie in sich konsistent bleiben):'
    : (mode === 'review'
      ? 'Etablierte Erzählform des Buchs (Referenz für Konsistenz- und Stilprüfung – abweichende Passagen sind Bruchstellen, sofern nicht dramaturgisch begründet):'
      : 'Etablierte Erzählform des Buchs (verbindliche Referenz für «perspektivbruch» und «tempuswechsel» – abweichende Stellen gegen diese Vorgabe prüfen, nicht gegen Default-Annahmen):');
  const lines = [
    perspektive ? `- Erzählperspektive: ${perspektive}` : null,
    zeit        ? `- Erzählzeit: ${zeit}`              : null,
  ].filter(Boolean);
  const scopeNote = `- Gilt NUR für den narrativen Erzähltext. KEIN Bruch ist in folgenden Fällen: direkte Rede / Dialog (Figuren sprechen in ihrer eigenen Zeit), innere Monologe in direkter Form, zitierte Briefe / Tagebuch­einträge / Nachrichten / Dokumente im Roman, erlebte Rede, historisches Präsens als bewusstes Stilmittel, Rückblenden (Plusquamperfekt) und Antizipationen (Futur), Wechsel an Szenen-/Kapitelgrenzen, sowie auktorialer Erzähler-/Chronisten-Kommentar aus der Erzählgegenwart (gnomisches Präsens der Erzählinstanz innerhalb einer Präteritum-Erzählung).`;
  return `\n${header}\n${lines.join('\n')}\n${scopeNote}\n`;
}
