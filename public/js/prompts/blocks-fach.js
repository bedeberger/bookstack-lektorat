// Regelblöcke für die Nicht-Erzähl-Profile des Lektorats (sachlich /
// wissenschaft / journalistisch, Profil-Zuordnung in prompts/lektorat-typen.js).
// Pure Funktionen ohne Modul-State.
//
// Zwei Sorten Blöcke stehen hier:
//   1. Regeln für die vier Fach-Fehlertypen (unbelegt, begriffsinkonsistenz,
//      autorenform, hedging), die es im narrativen Profil nicht gibt.
//   2. Fach-Varianten von Blöcken, deren narrative Fassung in prompts/blocks.js
//      inhaltlich falsch wäre — Stil (Nominalstil ist hier legitim), Wiederholung
//      (Fachtermini MÜSSEN wiederholt werden), Tempus (abschnittsgebunden statt
//      erzählform-gebunden) sowie Aufgabe/Schwere/Selbstkontrolle, die die
//      narrativen Typen namentlich aufführen.
//
// Die narrativen Blöcke in blocks.js bleiben davon unberührt — ein Roman-Prompt
// sieht exakt dieselben Regeln wie bisher.
//
// Blöcke, die andere Fehlertypen als Abgrenzung nennen, bekommen das aktive
// Typ-Enum des Laufs (`typen`) und filtern ihre Verweise darauf – im Stil-Pass
// des Claude-Splits existieren die objektiven Typen nicht.

import { verweisTypen } from './lektorat-typen.js';

// ── Fach-Fehlertypen ─────────────────────────────────────────────────────────

// Unbelegte Behauptung. Der wichtigste Befund einer wissenschaftlichen Arbeit und
// im narrativen Lektorat sinnlos. Kein Umformulierungs-, sondern ein Belegauftrag:
// «korrektur» kann die Quelle nicht erfinden, darum wird die Behauptung
// abgeschwächt oder als eigene Deutung markiert.
export function _buildUnbelegtBlock() {
  return `
Beleg-Regeln (typ: «unbelegt»):
- Melde Sätze, die eine PRÜFBARE Tatsachen-, Zahlen- oder Forschungsstands-Aussage treffen, ohne dass ein Quellennachweis im Satz oder im unmittelbar umgebenden Kontext steht.
- Typische Muster:
  · Forschungsstand ohne Nachweis: «Die Forschung ist sich weitgehend einig, dass …», «Zahlreiche Studien belegen …», «Es gilt als erwiesen, dass …», «In der Literatur wird häufig argumentiert …».
  · Quantifizierung ohne Quelle: Prozentwerte, Fallzahlen, Zeitreihen, Rankings, «die Mehrheit der Betroffenen».
  · Fremde Position ohne Fundstelle: eine namentlich genannte Position, Definition oder Theorie ohne Kurzbeleg.
  · Kausalbehauptung im Indikativ, die aus den eigenen Daten nicht folgt.
- NICHT melden: eigene Befunde der Arbeit (die belegt der Ergebnisteil selbst), explizit als eigene Deutung/Hypothese markierte Sätze, Definitionen, die die Arbeit selbst einführt, Allgemeinwissen, Überleitungen, Verweise auf eigene Abschnitte, Sätze mit vorhandenem Kurzbeleg.
- «original»: der behauptende Satz zeichengenau aus dem Text (vollständiger Satz).
- «korrektur»: derselbe Satz, so umformuliert, dass die Aussage ohne Beleg tragfähig wird — als eigene Einschätzung markiert («Die vorliegenden Daten legen nahe, dass …») oder auf das reduziert, was ohne Quelle behauptbar ist. Erfinde NIEMALS einen Beleg, keinen Autornamen, keine Jahreszahl, kein «(vgl. …)».
- «erklaerung»: EIN Satz, benennt die unbelegte Aussage («Forschungsstands-Behauptung ohne Kurzbeleg», «Prozentwert ohne Quelle»).
- Selbsttest: Würde ein Gutachter «Belegen?» an den Rand schreiben? Nur dann melden. Bei Zweifel weglassen.`;
}

// Begriffsdisziplin. Das Gegenstück zu «wiederholung»: hier ist die VARIATION der
// Fehler, nicht die Wiederholung — darum muss der Wiederholungs-Block im
// Fach-Profil Fachtermini explizit ausnehmen (siehe _buildFachWiederholungBlock).
export function _buildBegriffsinkonsistenzBlock() {
  return `
Begriffs-Regeln (typ: «begriffsinkonsistenz»):
- Melde Stellen, an denen DASSELBE Konzept mit wechselnden Termini bezeichnet wird, ohne dass der Wechsel eine Unterscheidung markiert. Terminologische Einheitlichkeit hat hier Vorrang vor stilistischer Abwechslung.
- Typische Muster:
  · Synonym-Drift für einen eingeführten Fachbegriff («Probandinnen» / «Teilnehmende» / «Versuchspersonen» / «Befragte» für dieselbe Gruppe).
  · Deutsch/englisch gemischte Doppelbenennung desselben Konstrukts ohne Festlegung.
  · Ein Begriff wird eingeführt und definiert, später aber in abweichender Bedeutung verwendet (Bedeutungsverschiebung).
  · Wechselnde Schreibweise oder Abkürzungspraxis eines Fachbegriffs (Bindestrich/zusammen, Abkürzung ohne Einführung, Abkürzung und Vollform wechselnd ohne Grund).
- NICHT melden: ein Wechsel, der bewusst zwei VERSCHIEDENE Konzepte trennt; Zitate, die die Terminologie der Quelle behalten müssen; die einmalige Einführung eines Synonyms mit expliziter Gleichsetzung («… (im Folgenden: X)»).
- «original»: die abweichende Begriffs-Phrase zeichengenau aus dem Text (Span = Phrase).
- «korrektur»: derselbe Span mit dem im Text etablierten Terminus.
- «erklaerung»: EIN Satz, benennt beide Varianten und die etablierte Form («oben als «Teilnehmende» eingeführt, hier «Versuchspersonen»»).
- Selbsttest: Bezeichnen beide Ausdrücke im Text nachweislich dasselbe? Nur dann melden — wenn unklar, weglassen.`;
}

// Selbstreferenz der Autorenschaft. In der Praxis der häufigste formale
// Beanstandungspunkt einer Abschlussarbeit und weder von «stil» noch von
// «perspektivbruch» (narrativ, POV-Figur) abgedeckt.
export function _buildAutorenformBlock() {
  return `
Autorenreferenz-Regeln (typ: «autorenform»):
- Die Arbeit muss EINE Form der Selbstbezeichnung durchhalten. Melde Stellen, die von der im Text etablierten Form abweichen.
- Zulässige Formen (die im Text dominierende ist die Norm): Ich-Form («ich untersuche»), Autoren-Wir («wir zeigen»), unpersönlich-passiv («untersucht wurde»), Verweis auf die Arbeit selbst («die vorliegende Arbeit untersucht»).
- Melde:
  · Wechsel zwischen diesen Formen ohne Grund («Wir haben erhoben … Ich interpretiere …»).
  · Autoren-Wir in einer Einzelarbeit, wenn der übrige Text die Ich-Form oder die unpersönliche Form führt.
  · Inklusives «wir», das Leserschaft und Autorenschaft vermischt, während «wir» sonst die Autorenschaft bezeichnet.
  · Unpersönliches «man» dort, wo der Text sonst eine bestimmte Selbstbezeichnung verwendet.
- NICHT melden: direkte Zitate, referierte Aussagen anderer Autorinnen und Autoren, Passiv aus Sachgründen (der Handelnde ist irrelevant), einen Wechsel, der durch eine formale Vorgabe des Abschnitts gedeckt ist.
- «original»: die abweichende Phrase zeichengenau aus dem Text (Span = Phrase, nicht der ganze Satz).
- «korrektur»: derselbe Span in der etablierten Form.
- «erklaerung»: EIN Satz, benennt etablierte und abweichende Form («Text führt die unpersönliche Form, hier Autoren-Wir»).
- Selbsttest: Lässt sich aus dem umgebenden Text eine dominierende Form ablesen? Wenn nein → weglassen, kein Raten.`;
}

// Hedging-Inflation. Der einzige subjektiv-stilistische der vier Fach-Typen und
// darum der einzige, der dem Mengen-Cap unterliegt.
export function _buildHedgingBlock() {
  return `
Hedging-Regeln (typ: «hedging»):
- Wissenschaftliche Vorsicht ist Pflicht — GESTAPELTE Vorsicht ist ein Mangel. Melde Stellen, an denen mehrere Absicherungen dieselbe Aussage gleichzeitig relativieren und die Aussage dadurch nichts mehr behauptet.
- Melde:
  · Hedge-Stapel: zwei oder mehr Absicherungen in einer Aussage («könnte möglicherweise unter Umständen darauf hindeuten», «scheint tendenziell eher darauf hinzuweisen, dass eventuell …»).
  · Doppelte Modalisierung von Modalverb plus Adverb («dürfte wahrscheinlich», «kann vermutlich»).
  · Absicherung eines ohnehin belegten oder eines eigenen, gemessenen Befunds («die Daten zeigen möglicherweise», wo die Daten es zeigen).
  · Leere Vorsichts-Präambeln ohne Informationsgehalt («An dieser Stelle sei angemerkt, dass …», «Es ist wichtig zu betonen, dass …», «Grundsätzlich lässt sich festhalten, dass …»).
- NICHT melden: EINE angemessene Absicherung («deutet darauf hin», «legt nahe», «vermutlich») — das ist korrekte wissenschaftliche Diktion und kein Finding. Ebenso nicht: begründete Einschränkungen im Limitationsteil, Konjunktiv in referierter Rede.
- «original»: die absichernde Phrase zeichengenau aus dem Text (Span = Phrase).
- «korrektur»: derselbe Span mit genau EINER Absicherung — Aussagekraft erhalten, Vorsicht nicht komplett streichen.
- «erklaerung»: EIN Satz, benennt die Stapelung («drei Absicherungen für eine Aussage», «Modalverb und Adverb doppeln die Vorsicht»).
- Severity-Schwelle: nur deutliche Stapel. Ein einzelnes «möglicherweise» im sonst klaren Satz → weglassen.`;
}

// ── Journalistische Fehlertypen ──────────────────────────────────────────────

// Indirekte Rede im Konjunktiv I. Der haeufigste Formfehler im
// deutschsprachigen Journalismus und zugleich ein presserechtlicher: der
// Indikativ macht die fremde Aussage zur eigenen Behauptung des Blattes.
export function _buildKonjunktivBlock() {
  return `
Konjunktiv-Regeln (typ: «konjunktiv»):
- Referierte (indirekte) Rede steht im KONJUNKTIV I. Der Indikativ macht die fremde Aussage zur Behauptung der Redaktion — das ist kein Stil-, sondern ein Haftungsproblem.
- Melde:
  · Indirekte Rede im Indikativ («Müller sagte, der Umbau ist finanziert» → «sei finanziert»).
  · Fehlender Modus nach Verben des Sagens, Meinens, Behauptens, Fordernds, Bestreitens, auch bei «laut», «nach Angaben von», «wie X mitteilte».
  · Konjunktiv II, wo Konjunktiv I formengleich mit dem Indikativ WÄRE (dann ist Konjunktiv II korrekt) — NICHT melden. Umgekehrt melden: Konjunktiv II, obwohl eine eindeutige Konjunktiv-I-Form existiert («sie hätten erklärt», wo «sie haben erklärt» als «sie hätten» eindeutig wäre — pruefe die Form, bevor du meldest).
  · Modus-Wechsel innerhalb derselben referierten Aussage (erster Satz Konjunktiv, Folgesatz Indikativ, ohne dass die Redaktion die Aussage übernimmt).
- NICHT melden: wörtliche Zitate in Anführungszeichen (dort gilt der Wortlaut des Sprechers), unstrittige Tatsachen im Nebensatz einer Redewiedergabe («Müller sagte, der Bahnhof, der 1902 eröffnet wurde, …»), Aussagen, die die Redaktion selbst recherchiert hat und verantwortet.
- «original»: der vollständige Satz der referierten Rede, zeichengenau aus dem Text.
- «korrektur»: derselbe Satz mit korrektem Modus — sonst NICHTS ändern.
- «erklaerung»: EIN Satz, benennt die Form («indirekte Rede nach «sagte» verlangt Konjunktiv I: «sei»»).
- Selbsttest: Steht ein Verb des Sagens im Satz oder davor? Nur dann melden.`;
}

// Zuschreibung. Das journalistische Gegenstueck zu «unbelegt»: der Beleg ist
// hier keine Fussnote, sondern die genannte Person oder Stelle IM Satz.
export function _buildZuschreibungBlock() {
  return `
Zuschreibungs-Regeln (typ: «zuschreibung»):
- Jede Tatsachenbehauptung, die die Redaktion nicht selbst beobachtet hat, braucht eine erkennbare Herkunft IM Text — nicht in einer Fussnote, sondern als Nennung: «laut …», «X sagte», «nach Angaben von …», «aus dem Bericht geht hervor».
- Melde:
  · Behauptung ohne jede Herkunft, die erkennbar von jemandem stammt («Die Sanierung kostet 40 Millionen»).
  · Anonyme Sammelquelle als einziger Beleg («Kritiker sagen», «Beobachter rechnen damit», «es heisst», «wie verlautet»), wo eine konkrete Nennung möglich wäre.
  · Zahl, Statistik oder Studienergebnis ohne die Stelle, die sie erhoben hat.
  · Vorwurf gegen eine benannte Person oder Stelle, ohne dass erkennbar ist, wer ihn erhebt.
- NICHT melden: unstrittiges Allgemeinwissen, eigene Beobachtung der Reportage («Vor dem Eingang stehen zwölf Menschen»), Aussagen, die im selben Absatz bereits zugeschrieben sind und erkennbar weiterlaufen, sowie Sätze im Kommentar, die als Meinung der Autorin auftreten.
- «original»: der behauptende Satz zeichengenau aus dem Text (vollständiger Satz).
- «korrektur»: derselbe Satz, so umformuliert, dass er ohne Zuschreibung trägt — als eigene Beobachtung, als offene Frage oder abgeschwächt. Erfinde NIEMALS eine Quelle, keinen Namen, keine Behörde, kein «laut Polizei».
- «erklaerung»: EIN Satz, benennt die Lücke («Kostenangabe ohne Herkunft», «anonyme Sammelquelle als einziger Beleg»).
- Selbsttest: Könnte die Redaktion diesen Satz vor Gericht selbst verantworten? Wenn ja → weglassen.`;
}

// Trennung von Nachricht und Meinung. Textsortenabhaengig — im Kommentar ist
// die Wertung der Zweck, darum steuert die Textsorte diesen Block (siehe
// _buildWertungBlock-Parameter in prompts/journalismus.js).
export function _buildWertungBlock(textsorteLabel = 'Bericht') {
  return `
Wertungs-Regeln (typ: «wertung»):
- Die Textsorte dieses Textes ist: ${textsorteLabel}. Dort sind Nachricht und Meinung zu TRENNEN — die Wertung gehört in ein Zitat oder in einen als Kommentar gekennzeichneten Text, nicht in den berichtenden Satz.
- Melde:
  · Wertende Adjektive und Adverbien der Redaktion («der skandalöse Entscheid», «erfreulicherweise», «eine überfällige Reform», «erschreckend hoch»).
  · Verben, die eine Bewertung transportieren, wo ein neutrales genügt («gestand» statt «sagte», «beschönigte», «giftete», «musste einräumen»).
  · Suggestive Formulierungen und rhetorische Fragen, die dem Leser das Urteil vorgeben.
  · Einseitige Zuspitzung im Vorspann, die der Text danach nicht deckt.
- NICHT melden: Wertungen INNERHALB eines wörtlichen oder referierten Zitats (das ist die Meinung des Sprechers — sie zu streichen wäre ein Eingriff), belegte Superlative («der grösste Bau des Kantons», wenn belegt), zugespitzte, aber sachliche Sprachbilder in der Reportage, sowie Fach- und Rechtsbegriffe, die nur wertend klingen («fahrlässig», «rechtswidrig», wenn sie als Feststellung einer Instanz auftreten).
- «original»: der wertende Satz ODER genau die wertende Phrase, zeichengenau aus dem Text.
- «korrektur»: derselbe Span, neutral formuliert — die Tatsache bleibt, die Bewertung fällt weg.
- «erklaerung»: EIN Satz, benennt die Wertung (««skandalös» ist das Urteil der Redaktion, nicht die Nachricht»).
- Selbsttest: Steht die Wertung in einem Zitat? Dann weglassen — immer.`;
}

// Amts-, Behoerden- und PR-Sprache. Der Nominalstil, den das wissenschaftliche
// Profil ausdruecklich freigibt, ist hier der Kernmangel.
export function _buildAmtsdeutschBlock() {
  return `
Amtsdeutsch-Regeln (typ: «amtsdeutsch»):
- Der Text muss übersetzen, was Behörden, Unternehmen und Verbände in ihrer eigenen Sprache mitteilen. Melde unübersetzte Amts-, Juristen- und PR-Sprache im Fliesstext der Redaktion.
- Melde:
  · Nominalstil und Streckformen («zur Durchführung bringen», «unter Beweis stellen», «Inbetriebnahme erfolgt», «im Rahmen der Massnahme»).
  · Behörden-Substantive ohne Übersetzung («Aufwuchs», «Sachverhalt», «Verkehrsteilnehmende» im Fliesstext, «Personalkörper»).
  · PR- und Werbevokabular, das eine Aussage vortäuscht («innovativ», «nachhaltig aufgestellt», «ganzheitliche Lösung», «Synergien heben»).
  · Passiv-Ketten, die den Handelnden verschwinden lassen, wo er bekannt ist («Es wurde entschieden» statt «Der Gemeinderat entschied»).
- NICHT melden: dieselben Wendungen INNERHALB eines Zitats (der Sprecher redet so — das ist die Nachricht), Rechts- und Fachbegriffe ohne Alltagsentsprechung («Einsprache», «Rekurs», «Baurekursgericht»), Eigennamen von Ämtern und Verfahren.
- «original»: der Satz ODER die Phrase, zeichengenau aus dem Text.
- «korrektur»: derselbe Span in Alltagssprache — konkretes Subjekt, aktives Verb, gleiche Aussage. Keine Vereinfachung, die die Sache verfälscht.
- «erklaerung»: EIN Satz, benennt die Wendung («Streckform «zur Durchführung bringen» statt «durchführen»»).
- Selbsttest: Steht die Wendung in einem Zitat? Dann weglassen.`;
}

// Tempus im journalistischen Text: nicht abschnittsgebunden wie in der Arbeit
// und nicht erzaehlform-gebunden wie im Roman, sondern funktionsgebunden.
export function _buildJournalTempusBlock() {
  return `
Tempus-Regeln (typ: «tempuswechsel»):
- Das Tempus richtet sich nach der Funktion des Satzes:
  · Meldung des Ereignisses, Vorspann/Lead → Perfekt oder Präteritum, im Text dann durchgehalten.
  · Fliesstext eines Berichts über Vergangenes → Präteritum.
  · Dauernde Zustände, geltende Regelungen, Beschreibung von Personen und Orten → Präsens.
  · Reportage-Szene → entweder durchgehend Präsens (szenisches Präsens) ODER durchgehend Präteritum; die im Text dominierende Wahl ist die Norm.
  · Redewiedergabe → Tempus des Sprechers, Modus nach den Konjunktiv-Regeln.
  · Ausblick, Angekündigtes → Futur oder Präsens mit Zeitangabe.
- Melde jeden Satz, dessen Tempus der Funktion widerspricht, und jeden ungedeckten Wechsel innerhalb derselben Szene oder desselben Abschnitts.
- NICHT melden: Plusquamperfekt für Vorzeitigkeit, Präsens in einer Zwischenüberschrift, Tempus in wörtlichen Zitaten, den bewussten Wechsel beim Sprung von der Szene in den Hintergrundabsatz.
- «original»: vollständiger Satz zeichengenau aus dem Text.
- «korrektur»: derselbe Satz im passenden Tempus.
- «erklaerung»: EIN Satz, benennt Funktion und erwartetes Tempus («Szene läuft im Präsens, hier Präteritum»).`;
}

// Stil im journalistischen Text. Bewusst NICHT _buildFachStilBlock: dort ist
// Nominalstil ein Praezisionsmittel, hier ist er der Mangel (typ «amtsdeutsch»).
export function _buildJournalStilBlock(typen = []) {
  const spezifisch = verweisTypen(
    ['satzbau', 'wiederholung', 'fuellwort', 'amtsdeutsch', 'wertung', 'zuschreibung',
      'konjunktiv', 'begriffsinkonsistenz', 'grammatik', 'rechtschreibung'],
    typen,
  ).join(', ');
  return `
Stil-Regeln (typ: «stil»):
- «stil» ist KEIN Auffang-Eimer. Er greift NUR für sprachliche Schwächen, die KEINEM spezifischeren Typ zugeordnet werden können.
- Wenn ein spezifischerer Typ passt (${spezifisch}) → diesen Typ verwenden, NICHT «stil».
- «stil» deckt ab: unklare Bezüge und Mehrdeutigkeit, falsch gewählte Kollokation, Register-Bruch (Kanzleiton neben Umgangssprache), Schachtelung von Zusatzinformation, die die Nachricht verdeckt, überflüssige Verstärker («ganz besonders», «absolut zentral»), Floskeln der Nachrichtensprache («ins Visier nehmen», «auf den Weg bringen», «einen Schlussstrich ziehen»).
- «stil» deckt NICHT ab und ist hier ausdrücklich KEIN Mangel: kurze Hauptsätze, Alltagssprache, konkrete Zahlen und Namen dicht nebeneinander, die wörtliche Wiederholung eines Eigennamens statt eines Pronomens, sachlich-nüchterner Ton, direkte Rede.
- «original»: vollständiger Satz oder eindeutig abgrenzbare Phrase zeichengenau aus dem Text.
- PFLICHT: «korrektur» muss eine konkrete Umformulierung enthalten — nicht leer, nicht identisch mit «original». Keine Angabe darf dabei verloren gehen oder sich ändern.
- «erklaerung»: EIN Satz, benennt die Schwäche («unklarer Bezug», «Nachrichtenfloskel», «Register-Bruch»).
- Selbsttest: Lässt sich die Schwäche präzise mit einem der spezifischen Typen benennen? Wenn ja → spezifischen Typ verwenden, «stil» weglassen.`;
}

// Zitattreue. Steht als eigener RAHMEN-Block (nicht als Fehlertyp) im Prompt:
// er verbietet eine ganze Klasse von Korrekturen, statt einen Mangel zu melden.
export function _buildZitattreueBlock() {
  return `
ZITAT-TREUE (Pflicht-Verbot, gilt für JEDEN Typ):
- Wörtliche Zitate — alles zwischen Anführungszeichen und alles, was erkennbar als Wortlaut einer Person auftritt — sind UNANTASTBAR. Ein Zitat wird nicht geglättet, nicht gekürzt, nicht grammatisch repariert und nicht von Wertungen befreit.
- VERBOTEN: ein «fehler»-Eintrag, dessen «original» ganz oder teilweise innerhalb eines wörtlichen Zitats liegt — auch bei Rechtschreibung, Grammatik, Stil, Füllwörtern, Amtsdeutsch oder Wertung.
- ERLAUBT bleibt: der Rahmensatz um das Zitat (Zuschreibung, Modus der indirekten Rede, Zeichensetzung des Rahmens) sowie ein offensichtlicher Tippfehler in der TRANSKRIPTION, wenn er als solcher benannt wird — im Zweifel weglassen.
- Selbsttest pro Eintrag: Steht «original» zwischen Anführungszeichen? Wenn ja oder unklar → Eintrag streichen.
`;
}

// ── Fach-Varianten narrativer Blöcke ─────────────────────────────────────────

// Wie _buildStilBlock, aber ohne die literarischen Annahmen: Nominalstil und
// Fachterminologie sind hier Präzisionsmittel, keine Schwäche, und es gibt keinen
// Erzähltext/Dialog-Gegensatz.
export function _buildFachStilBlock(typen = []) {
  const spezifisch = verweisTypen(
    ['satzbau', 'wiederholung', 'fuellwort', 'hedging', 'begriffsinkonsistenz',
      'autorenform', 'grammatik', 'rechtschreibung'],
    typen,
  ).join(', ');
  return `
Stil-Regeln (typ: «stil»):
- «stil» ist KEIN Auffang-Eimer. Er greift NUR für sprachliche Schwächen, die KEINEM spezifischeren Typ zugeordnet werden können.
- Wenn ein spezifischerer Typ passt (${spezifisch}) → diesen Typ verwenden, NICHT «stil».
- «stil» deckt ab: unklare Bezüge und Mehrdeutigkeit, falsch gewählte Kollokation, Register-Bruch (umgangssprachliche Wendung im Fachtext, werbliche oder pathetische Formulierung), gestapelte Abstrakta, die die Aussage verdecken, überflüssige Verstärker («sehr signifikant», «absolut zentral»).
- «stil» deckt NICHT ab und ist hier ausdrücklich KEIN Mangel: Nominalstil und Substantivierungen, Fachterminologie und Fremdwörter, wo sie präzisieren, sachlich-distanzierter Ton, unpersönliche Formulierung, Passiv (siehe eigene Typ-Zuständigkeit), sowie die Wiederholung eines eingeführten Fachbegriffs.
- «original»: vollständiger Satz oder eindeutig abgrenzbare Phrase zeichengenau aus dem Text.
- PFLICHT: «korrektur» muss eine konkrete Umformulierung enthalten — nicht leer, nicht identisch mit «original». Präzision darf dabei nicht verloren gehen: keine Vereinfachung, die die Aussage unscharf macht.
- «erklaerung»: EIN Satz, benennt die Schwäche («unklarer Bezug», «Register-Bruch», «leerer Verstärker»).
- Selbsttest: Lässt sich die Schwäche präzise mit einem der spezifischen Typen benennen? Wenn ja → spezifischen Typ verwenden, «stil» weglassen.`;
}

// Wie _buildWiederholungBlock, aber mit der zentralen Umkehrung: ein eingeführter
// Fachbegriff MUSS wörtlich wiederholt werden. Ohne diese Ausnahme arbeitet
// «wiederholung» direkt gegen «begriffsinkonsistenz».
export function _buildFachWiederholungBlock(sw = []) {
  const swNote = sw.length > 0
    ? `\n- Stoppwörter nie melden (auch flektierte Formen): ${sw.join(', ')}`
    : '';
  return `
Wiederholung-Regeln (typ: «wiederholung»):
- VORRANG-REGEL: Fachbegriffe, definierte Termini, Variablen-/Konstrukt-Namen, Eigennamen von Verfahren, Institutionen und Instrumenten werden NIE als Wiederholung gemeldet — sie MÜSSEN im ganzen Text identisch bleiben. Ein Synonym dafür wäre ein Fehler (typ «begriffsinkonsistenz»), keine Verbesserung.
- Gemeldet wird nur die Wiederholung NICHT-terminologischer Inhaltswörter, die den Text schwerfällig macht: allgemeine Verben, Adjektive, Rahmen-Substantive («Aspekt», «Bereich», «Rahmen», «Zusammenhang») sowie identische Satzeinleitungen in Folge.
- Schwelle: mind. 3× auf der Seite ODER 2× im selben oder direkt aufeinanderfolgenden Absatz.
- LEMMA-/STAMMBASIERT zählen, nicht nach Wortform. Wortformen desselben Lemmas separat aufzulisten ist verboten.
- Keine Pronomen, Hilfsverben, Artikel, Konjunktionen, Präpositionen, Eigennamen${swNote}
- Nicht melden in direkten Zitaten und in Tabellen-/Abbildungslegenden.
- «original»: vollständiger Satz zeichengenau aus dem Text.
- «korrektur»: derselbe Satz mit dem besten Synonym — exakt gleiche grammatische Form, Aussage unverändert präzise.
- «erklaerung»: EIN Satz, nennt das wiederholte Wort bzw. den Stamm («Rahmen-Substantiv «Bereich» dreimal auf der Seite»).
- Selbsttest vor jedem Eintrag: Ist das Wort ein Fachbegriff dieser Arbeit? Wenn ja oder unklar → weglassen.`;
}

// Wie _buildTempuswechselBlock, aber gegen die ABSCHNITTS-Konvention statt gegen
// eine etablierte Erzählform. Derselbe Typ-Key (das Finding heisst weiterhin
// „Tempus"), andere Referenz.
export function _buildFachTempusBlock() {
  return `
Tempus-Regeln (typ: «tempuswechsel»):
- Das korrekte Tempus richtet sich hier nach der FUNKTION des Satzes, nicht nach einem durchgehenden Erzähltempus. Prüfe jeden Satz gegen die Konvention seiner Funktion:
  · Eigenes Vorgehen, Erhebung, Durchführung, Materialbeschreibung → Vergangenheit («Die Daten wurden erhoben», «Befragt wurden 120 Personen»).
  · Eigene Ergebnisse als Einzelbefund am Material → Vergangenheit («Die Gruppe zeigte höhere Werte»).
  · Allgemeine Sachverhalte, Definitionen, Theorie, geltender Forschungsstand, Interpretation und Schlussfolgerung → Präsens («Der Effekt beschreibt …», «Das deutet auf … hin»).
  · Verweise auf Abschnitte, Tabellen und Abbildungen der Arbeit selbst → Präsens («Kapitel 3 stellt … dar», «Tabelle 2 zeigt …»).
  · Referierte Literatur → Präsens («Müller argumentiert …») ODER durchgehend Vergangenheit («Müller argumentierte …»); die im Text dominierende Wahl ist die Norm, Abweichungen davon sind Findings.
  · Ausblick, offene Fragen → Präsens oder Futur.
- Melde jeden Satz, dessen finites Verb der Konvention seiner Funktion widerspricht, sowie jeden Wechsel der Literatur-Referenz-Praxis innerhalb desselben Abschnitts. Das ist ein objektiver Formfehler, keine Geschmacksfrage.
- NICHT melden: Plusquamperfekt für Vorzeitigkeit, historisches Präsens in einem klar historischen Abriss, Tempus in direkten Zitaten, zeitlose Aussagen im Präsens innerhalb eines Vergangenheits-Abschnitts.
- «original»: vollständiger Satz zeichengenau aus dem Text.
- «korrektur»: derselbe Satz im konventionsgemässen Tempus.
- «erklaerung»: EIN Satz, benennt Funktion und erwartetes Tempus («eigenes Vorgehen → Vergangenheit, hier Präsens»).`;
}

// ── Rahmen-Blöcke (Aufgabe / Schwere / Selbstkontrolle) ──────────────────────
// Die narrativen Fassungen in prompts/lektorat.js führen die narrativen Typen
// namentlich auf; hier die Fach-Pendants. `wissenschaft` unterscheidet sich von
// `sachlich` in der Beleg- und Terminologie-Strenge, darum zwei Aufgabensätze.

export function _buildFachAufgabe(profil, stilOnly) {
  const objektivHinweis = stilOnly
    ? ' WICHTIG: Rechtschreibung, Grammatik und Zeichensetzung/Interpunktion werden in einem SEPARATEN Pass geprüft und dürfen hier NICHT gemeldet werden.'
    : '';
  const gemeinsam = 'Analysiere den Text vollständig von Anfang bis Ende – nicht nur lokale Abschnitte oder die letzten Sätze.';
  if (profil === 'journalistisch') {
    return `${gemeinsam} Der Text ist ein JOURNALISTISCHER BEITRAG und wird nach den Massstäben redaktioneller Prosa geprüft, nicht nach denen literarischen Erzählens und nicht nach denen wissenschaftlicher Prosa.${stilOnly ? '' : ' Prüfe Rechtschreibung, Grammatik und Zeichensetzung/Interpunktion (insbesondere Kommasetzung) Satz für Satz und gründlich – das sind objektive Fehler.'} Prüfe ausserdem: den Modus der indirekten Rede, die Zuschreibung fremder Aussagen, die Trennung von Nachricht und Meinung, unübersetzte Amts- und PR-Sprache, Klarheit und Satzbau, Wortwiederholungen, schwache Verben, Füllwörter, abgegriffene Nachrichtenfloskeln, KI-Geruch, vermeidbares Passiv, wechselnde Terminologie, Pleonasmen und Tempus-Konsistenz (Zuständigkeit und Details der einzelnen Typen siehe Regelblöcke unten).
AUSDRÜCKLICH KEIN MANGEL und NICHT zu melden: kurze Hauptsätze, Alltagssprache, die wörtliche Wiederholung eines Eigennamens, dichte Zahlen- und Namensnennung, sachlich-nüchterner Ton, fehlende Szenen, fehlende Figurenarbeit, fehlende Bildsprache. Wörtliche Zitate sind unantastbar – siehe ZITAT-TREUE.${objektivHinweis} Bewerte ausserdem die Abschnitte der Seite.`;
  }
  if (profil === 'wissenschaft') {
    return `${gemeinsam} Der Text ist Teil einer WISSENSCHAFTLICHEN ARBEIT und wird nach den Maßstäben wissenschaftlicher Prosa geprüft, nicht nach denen literarischen Erzählens.${stilOnly ? '' : ' Prüfe Rechtschreibung, Grammatik und Zeichensetzung/Interpunktion (insbesondere Kommasetzung) Satz für Satz und gründlich – das sind objektive Fehler.'} Prüfe ausserdem: unbelegte Behauptungen, Begriffsdisziplin, konsistente Autorenreferenz, Tempus-Konvention der Abschnitte, gestapeltes Hedging, Satzbau, Wortwiederholungen ausserhalb der Fachterminologie, Füllwörter, Pleonasmen und sonstige sprachliche Schwächen (Zuständigkeit und Details der einzelnen Typen siehe Regelblöcke unten).
AUSDRÜCKLICH KEIN MANGEL und NICHT zu melden: Nominalstil und Substantivierungen, sachlich-distanzierter Ton, Passivkonstruktionen, Fachterminologie und Fremdwörter, unpersönliche Formulierung, wiederholte Fachbegriffe, fehlende Szenen, fehlende Bildsprache, fehlende Figuren- oder Spannungsarbeit. Erzählerische Stilmittel sind hier nicht das Ziel; verlange sie nicht und rechne ihr Fehlen nicht als Schwäche.${objektivHinweis} Bewerte ausserdem die Abschnitte der Seite.`;
  }
  return `${gemeinsam} Der Text ist SACHTEXT (Sachbuch, Essay oder Blog) und wird nach den Maßstäben argumentierender Prosa geprüft, nicht nach denen literarischen Erzählens.${stilOnly ? '' : ' Prüfe Rechtschreibung, Grammatik und Zeichensetzung/Interpunktion (insbesondere Kommasetzung) Satz für Satz und gründlich – das sind objektive Fehler.'} Prüfe ausserdem: Klarheit und Satzbau, Wortwiederholungen ausserhalb der Fachbegriffe, schwache Verben, Füllwörter, abgegriffene Phrasen, KI-Geruch, vermeidbares Passiv, gestapelte Absicherungsfloskeln, wechselnde Terminologie für dieselbe Sache, Pleonasmen und Tempus-Konsistenz (Zuständigkeit und Details der einzelnen Typen siehe Regelblöcke unten).
AUSDRÜCKLICH KEIN MANGEL und NICHT zu melden: fehlende Szenen, fehlende Figurenarbeit, abstraktes Benennen statt szenischem Zeigen, Wahrnehmungsverben, sachlicher Ton, Fachterminologie, wo sie präzisiert.${objektivHinweis} Bewerte ausserdem die Abschnitte der Seite.`;
}

export function _buildFachSeverityBlock(stilistischeTypen, mechanischeTypen) {
  // Der erläuternde Nachsatz zu Rechtschreibung/Grammatik/Zeichensetzung darf NUR
  // stehen, wenn diese Typen im Lauf überhaupt gemeldet werden dürfen. Im Stil-Pass
  // des Claude-Splits sind sie verboten – die Aufforderung «werden IMMER und
  // VOLLSTÄNDIG gemeldet» widerspräche dort direkt der <aufgabe>.
  const mech = new Set(mechanischeTypen);
  const mechDetail = (mech.has('rechtschreibung') || mech.has('grammatik'))
    ? ' Rechtschreibung, Grammatik (Kongruenz, Kasus, Rektion, Verbformen, Modus) und ZEICHENSETZUNG/INTERPUNKTION (fehlende oder falsch gesetzte Kommas, Satzschlusszeichen, Apostroph, Gedankenstrich) gehören dazu, ebenso die Form- und Beleg-Befunde.'
    : ' Das sind hier die Form- und Beleg-Befunde; Rechtschreibung, Grammatik und Zeichensetzung prüft ein SEPARATER Pass und sie gehören NICHT in diese Antwort.';
  return `
SCHWERE-SCHWELLE (Anti-Pedanterie, Pflicht-Filter vor dem Aufnehmen ins «fehler»-Array):
- Melde NUR Schwächen, die einer fachlich versierten Leserin spürbar auffallen oder die Verständlichkeit, Präzision oder Nachprüfbarkeit des Textes messbar beeinträchtigen.
- Selbsttest pro Eintrag: «Würde ein Gutachter diese Stelle in einem Gutachten anstreichen?» Wenn die Antwort «vielleicht», «Geschmacksache» oder «nur am Rand» wäre → weglassen.
- VERWORFEN-Kandidaten: minimal alternative Synonyme ohne Gewinn an Präzision, Mikro-Stilpräferenzen, fachlich etablierte Wendungen, ein einzelnes angemessenes «möglicherweise», Formulierungen, die eine Fachkonvention der Disziplin erfüllen.
- MECHANISCHE FEHLER UND FORM-/BELEG-BEFUNDE unterliegen der Schwere-Schwelle UND der Mengen-Obergrenze NICHT – sie werden IMMER und VOLLSTÄNDIG gemeldet, egal wie viele es sind: ${mechanischeTypen.join(', ')}.${mechDetail} Das sind objektive Mängel, keine Geschmacksfragen – nie als «vielleicht» abtun, nie wegen einer Obergrenze streichen.
- Die Schwere-Schwelle und die Mengen-Obergrenze gelten NUR für subjektiv-stilistische Findings (${stilistischeTypen.join(', ')}). Dort gilt: lieber 5 starke, präzise Findings als 25 schwache. Bleiben nach dem Selbsttest mehr als ~20 solcher Einträge übrig, hart priorisieren: nur die schwersten ~20 behalten.
`;
}

export function _buildFachSelbstkontrollBlock(mechanischeTypen, profil = 'wissenschaft') {
  // Schritt 1 + 2 unterscheiden sich pro Profil: der Massstab ist im
  // journalistischen Text die Schlussredaktion, nicht das Gutachten — und die
  // Genre-Freigabe ist dort fast das Gegenteil (Nominalstil ist hier ein
  // Mangel, kurze Hauptsaetze sind es nicht).
  const journal = profil === 'journalistisch';
  const schwereTest = journal ? 'Schlussredaktion anstreichen?' : 'Gutachter anstreichen?';
  const genreZeile = journal
    ? 'Beanstandet ein Eintrag kurze Hauptsätze, Alltagssprache, direkte Rede, die wörtliche Wiederholung eines Eigennamens, dichte Zahlen- und Namensnennung oder das Fehlen erzählerischer Mittel? Wenn ja → streichen. Das sind hier keine Mängel.'
    : 'Beanstandet ein Eintrag Nominalstil, Passiv, sachlichen Ton, Fachterminologie, unpersönliche Formulierung, einen wiederholten Fachbegriff oder das Fehlen erzählerischer Mittel? Wenn ja → streichen. Das sind hier keine Mängel.';
  // Nur journalistisch: der Zitat-Schutz muss auch im Schluss-Review greifen,
  // sonst rutscht eine geglaettete Zitatstelle durch, die kein anderer Schritt fängt.
  const zitatSchritt = journal
    ? '\n2b. ZITAT-TREUE: Liegt «original» ganz oder teilweise innerhalb eines wörtlichen Zitats (zwischen Anführungszeichen)? Wenn ja oder unklar → Eintrag streichen, ausnahmslos.'
    : '';
  return `
SELBSTKONTROLL-PASS (Pflicht vor dem Antworten):
Bevor du die JSON-Antwort ausgibst, gehe deine gesammelten Findings einmal durch und prüfe:
1. SCHWERE: Hat jeder stilistische Eintrag den Selbsttest «${schwereTest}» bestanden? Wenn nein → streichen. AUSNAHME: ${mechanischeTypen.join(', ')} bestehen diesen Test immer und werden NIE gestrichen – auch nicht, um unter eine Mengen-Obergrenze zu kommen.
2. GENRE-DISZIPLIN: ${genreZeile}${zitatSchritt}
3. DOPPELUNG: Überlappt «original» eines Eintrags textlich mit dem «original» eines anderen? Wenn ja → nur den mit dem treffendsten Typ (gemäss Typ-Priorität oben) behalten.
4. PURITÄT: Enthält «korrektur» Meta-Präfixe / Guillemets / Begründungs-Anhänge? Wenn ja → korrigieren oder Eintrag streichen.
5. BELEG-ERFINDUNG: ${journal
  ? 'Enthält ein «korrektur»-Feld eine Quelle, einen Personen- oder Behördennamen, eine Zahl oder ein «laut …», das nicht schon im Originaltext stand? Wenn ja → Eintrag umformulieren, sodass er ohne erfundene Zuschreibung trägt, sonst streichen.'
  : 'Enthält ein «korrektur»-Feld einen Quellennachweis, Autornamen, eine Jahreszahl oder ein «(vgl. …)», das nicht schon im Originaltext stand? Wenn ja → Eintrag umformulieren, sodass er ohne erfundenen Beleg trägt, sonst streichen.'}
6. ZEICHENGENAUIGKEIT: Liesse sich «original» mit einem String-Find im Originaltext genau einmal finden? Wenn nein → korrigieren oder streichen.
7. SPAN-TYP-KONSISTENZ: Sind «original» und «korrektur» beide gleichlange Spans (beide Phrase ODER beide Satz)? Wenn nein → korrigieren.
8. ERKLÄRUNGS-FILTER: Enthält «erklaerung» «kein Fehler» / «vertretbar» / «möglicherweise» / «akzeptabel»? Wenn ja → Eintrag streichen.
9. SORTIERUNG: Sortiere das «fehler»-Array AUFSTEIGEND nach Textposition (erstes Auftreten von «original» im Originaltext).
10. ZUSAMMENFASSUNGS-DISJUNKTION: Lies «stilanalyse», «fazit» und jedes «szenen[].kommentar» einzeln. Beschreibt ein Satz dort einen Mangel, der bereits durch einen Eintrag im «fehler»-Array abgedeckt ist (auch in Aggregat-Form wie «viele Wiederholungen», «häufig unbelegt», «zu viel Hedging») → diesen Satz löschen oder durch eine nicht überlappende Beobachtung ersetzen.
`;
}

// Abschnitts-Regeln: Ersatz für die narrativen Szenen-Regeln. Das «szenen»-Feld
// des Schemas bleibt, trägt hier aber Argumentations-Abschnitte — so bleibt
// Schema, Cache, History und Frontend identisch.
export function _buildFachAbschnittRegelnBlock(profil = 'wissenschaft') {
  if (profil === 'journalistisch') {
    return `
Abschnitts-Regeln (Feld «szenen»):
- Ein Abschnitt ist hier ein Textbaustein mit eigener Funktion (Vorspann/Lead, Aufhänger, Hauptteil, Hintergrund/Einordnung, O-Ton-Block, Gegenposition, Schluss) – KEINE Szene.
- Enthält die Seite keine abgrenzbaren Bausteine (z.B. reine Meldung von drei Sätzen, Bildlegende, Faktenkasten): «szenen» als leeres Array zurückgeben.
- wertung: «stark» = Baustein trägt seine Funktion, «mittel» = Funktion unklar oder Information fehlt, «schwach» = Baustein steht ohne erkennbaren Zweck.
- kommentar: 1-2 Sätze zu Funktion, Informationswert und Anschluss an den vorigen Baustein. KEINE Einzelstellen-Kritik aus dem «fehler»-Array wiederholen.`;
  }
  return `
Abschnitts-Regeln (Feld «szenen»):
- Ein Abschnitt ist hier ein Argumentations- oder Darstellungsschritt mit eigener Funktion (Fragestellung, Herleitung, Methodenschritt, Befund, Deutung, Zwischenfazit) – KEINE Szene.
- Enthält die Seite keine abgrenzbaren Schritte (z.B. reine Tabelle, Literaturliste, Fussnotenblock): «szenen» als leeres Array zurückgeben.
- wertung: «stark» = Schritt trägt und ist nachvollziehbar, «mittel» = Lücke in Herleitung oder Beleg, «schwach» = Aussage steht nicht.
- kommentar: 1-2 Sätze zu Nachvollziehbarkeit, Beleglage und Anschluss an den vorigen Schritt. KEINE Einzelstellen-Kritik aus dem «fehler»-Array wiederholen.`;
}
