// Regelblöcke für die Nicht-Erzähl-Profile des Lektorats (sachlich / wissenschaft,
// Profil-Zuordnung in prompts/lektorat-typen.js). Pure Funktionen ohne Modul-State.
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

// ── Fach-Varianten narrativer Blöcke ─────────────────────────────────────────

// Wie _buildStilBlock, aber ohne die literarischen Annahmen: Nominalstil und
// Fachterminologie sind hier Präzisionsmittel, keine Schwäche, und es gibt keinen
// Erzähltext/Dialog-Gegensatz.
export function _buildFachStilBlock() {
  return `
Stil-Regeln (typ: «stil»):
- «stil» ist KEIN Auffang-Eimer. Er greift NUR für sprachliche Schwächen, die KEINEM spezifischeren Typ zugeordnet werden können.
- Wenn ein spezifischerer Typ passt (satzbau, wiederholung, fuellwort, hedging, begriffsinkonsistenz, autorenform, grammatik, rechtschreibung) → diesen Typ verwenden, NICHT «stil».
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
  if (profil === 'wissenschaft') {
    return `${gemeinsam} Der Text ist Teil einer WISSENSCHAFTLICHEN ARBEIT und wird nach den Maßstäben wissenschaftlicher Prosa geprüft, nicht nach denen literarischen Erzählens.${stilOnly ? '' : ' Prüfe Rechtschreibung, Grammatik und Zeichensetzung/Interpunktion (insbesondere Kommasetzung) Satz für Satz und gründlich – das sind objektive Fehler.'} Prüfe ausserdem: unbelegte Behauptungen, Begriffsdisziplin, konsistente Autorenreferenz, Tempus-Konvention der Abschnitte, gestapeltes Hedging, Satzbau, Wortwiederholungen ausserhalb der Fachterminologie, Füllwörter, Pleonasmen und sonstige sprachliche Schwächen (Zuständigkeit und Details der einzelnen Typen siehe Regelblöcke unten).
AUSDRÜCKLICH KEIN MANGEL und NICHT zu melden: Nominalstil und Substantivierungen, sachlich-distanzierter Ton, Passivkonstruktionen, Fachterminologie und Fremdwörter, unpersönliche Formulierung, wiederholte Fachbegriffe, fehlende Szenen, fehlende Bildsprache, fehlende Figuren- oder Spannungsarbeit. Erzählerische Stilmittel sind hier nicht das Ziel; verlange sie nicht und rechne ihr Fehlen nicht als Schwäche.${objektivHinweis} Bewerte ausserdem die Abschnitte der Seite.`;
  }
  return `${gemeinsam} Der Text ist SACHTEXT (Sachbuch, Essay oder Blog) und wird nach den Maßstäben argumentierender Prosa geprüft, nicht nach denen literarischen Erzählens.${stilOnly ? '' : ' Prüfe Rechtschreibung, Grammatik und Zeichensetzung/Interpunktion (insbesondere Kommasetzung) Satz für Satz und gründlich – das sind objektive Fehler.'} Prüfe ausserdem: Klarheit und Satzbau, Wortwiederholungen ausserhalb der Fachbegriffe, schwache Verben, Füllwörter, abgegriffene Phrasen, KI-Geruch, vermeidbares Passiv, gestapelte Absicherungsfloskeln, wechselnde Terminologie für dieselbe Sache, Pleonasmen und Tempus-Konsistenz (Zuständigkeit und Details der einzelnen Typen siehe Regelblöcke unten).
AUSDRÜCKLICH KEIN MANGEL und NICHT zu melden: fehlende Szenen, fehlende Figurenarbeit, abstraktes Benennen statt szenischem Zeigen, Wahrnehmungsverben, sachlicher Ton, Fachterminologie, wo sie präzisiert.${objektivHinweis} Bewerte ausserdem die Abschnitte der Seite.`;
}

export function _buildFachSeverityBlock(stilistischeTypen, mechanischeTypen) {
  return `
SCHWERE-SCHWELLE (Anti-Pedanterie, Pflicht-Filter vor dem Aufnehmen ins «fehler»-Array):
- Melde NUR Schwächen, die einer fachlich versierten Leserin spürbar auffallen oder die Verständlichkeit, Präzision oder Nachprüfbarkeit des Textes messbar beeinträchtigen.
- Selbsttest pro Eintrag: «Würde ein Gutachter diese Stelle in einem Gutachten anstreichen?» Wenn die Antwort «vielleicht», «Geschmacksache» oder «nur am Rand» wäre → weglassen.
- VERWORFEN-Kandidaten: minimal alternative Synonyme ohne Gewinn an Präzision, Mikro-Stilpräferenzen, fachlich etablierte Wendungen, ein einzelnes angemessenes «möglicherweise», Formulierungen, die eine Fachkonvention der Disziplin erfüllen.
- MECHANISCHE FEHLER UND FORM-/BELEG-BEFUNDE unterliegen der Schwere-Schwelle UND der Mengen-Obergrenze NICHT – sie werden IMMER und VOLLSTÄNDIG gemeldet, egal wie viele es sind: ${mechanischeTypen.join(', ')}. Rechtschreibung, Grammatik (Kongruenz, Kasus, Rektion, Verbformen, Modus) und ZEICHENSETZUNG/INTERPUNKTION (fehlende oder falsch gesetzte Kommas, Satzschlusszeichen, Apostroph, Gedankenstrich) gehören dazu, ebenso die Form- und Beleg-Befunde. Das sind objektive Mängel, keine Geschmacksfragen – nie als «vielleicht» abtun, nie wegen einer Obergrenze streichen.
- Die Schwere-Schwelle und die Mengen-Obergrenze gelten NUR für subjektiv-stilistische Findings (${stilistischeTypen.join(', ')}). Dort gilt: lieber 5 starke, präzise Findings als 25 schwache. Bleiben nach dem Selbsttest mehr als ~20 solcher Einträge übrig, hart priorisieren: nur die schwersten ~20 behalten.
`;
}

export function _buildFachSelbstkontrollBlock(mechanischeTypen) {
  return `
SELBSTKONTROLL-PASS (Pflicht vor dem Antworten):
Bevor du die JSON-Antwort ausgibst, gehe deine gesammelten Findings einmal durch und prüfe:
1. SCHWERE: Hat jeder stilistische Eintrag den Selbsttest «Gutachter anstreichen?» bestanden? Wenn nein → streichen. AUSNAHME: ${mechanischeTypen.join(', ')} bestehen diesen Test immer und werden NIE gestrichen – auch nicht, um unter eine Mengen-Obergrenze zu kommen.
2. GENRE-DISZIPLIN: Beanstandet ein Eintrag Nominalstil, Passiv, sachlichen Ton, Fachterminologie, unpersönliche Formulierung, einen wiederholten Fachbegriff oder das Fehlen erzählerischer Mittel? Wenn ja → streichen. Das sind hier keine Mängel.
3. DOPPELUNG: Überlappt «original» eines Eintrags textlich mit dem «original» eines anderen? Wenn ja → nur den mit dem treffendsten Typ (gemäss Typ-Priorität oben) behalten.
4. PURITÄT: Enthält «korrektur» Meta-Präfixe / Guillemets / Begründungs-Anhänge? Wenn ja → korrigieren oder Eintrag streichen.
5. BELEG-ERFINDUNG: Enthält ein «korrektur»-Feld einen Quellennachweis, Autornamen, eine Jahreszahl oder ein «(vgl. …)», das nicht schon im Originaltext stand? Wenn ja → Eintrag umformulieren, sodass er ohne erfundenen Beleg trägt, sonst streichen.
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
export function _buildFachAbschnittRegelnBlock() {
  return `
Abschnitts-Regeln (Feld «szenen»):
- Ein Abschnitt ist hier ein Argumentations- oder Darstellungsschritt mit eigener Funktion (Fragestellung, Herleitung, Methodenschritt, Befund, Deutung, Zwischenfazit) – KEINE Szene.
- Enthält die Seite keine abgrenzbaren Schritte (z.B. reine Tabelle, Literaturliste, Fussnotenblock): «szenen» als leeres Array zurückgeben.
- wertung: «stark» = Schritt trägt und ist nachvollziehbar, «mittel» = Lücke in Herleitung oder Beleg, «schwach» = Aussage steht nicht.
- kommentar: 1-2 Sätze zu Nachvollziehbarkeit, Beleglage und Anschluss an den vorigen Schritt. KEINE Einzelstellen-Kritik aus dem «fehler»-Array wiederholen.`;
}
