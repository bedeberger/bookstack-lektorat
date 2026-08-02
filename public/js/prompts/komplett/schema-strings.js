// Geteilte Schema-Text- und Regel-Bausteine der Komplett-Pipeline.
// Reine Strings/Funktionen ohne Provider-State – von extraktion.js, figuren.js,
// konsolidierung.js und kontinuitaet.js konsumiert.

// ── Figurenextraktion (Basis – ohne Lebensereignisse) ─────────────────────────

export const FIGUREN_BASIS_SCHEMA = `{
  "figuren": [
    {
      "id": "fig_1",
      "name": "Vollständiger Name",
      "kurzname": "Vorname oder Spitzname",
      "typ": "hauptfigur|nebenfigur|antagonist|mentor|randfigur|andere",
      "geburtstag": "JJJJ oder leer wenn unbekannt",
      "geschlecht": "männlich|weiblich|divers|unbekannt",
      "beruf": "Beruf oder Rolle oder leer",
      "wohnadresse": "Wohnort/Wohnadresse der Figur oder leer wenn nicht belegt",
      "aeusseres": "Körperliche Erscheinung wie im Text beschrieben (Statur, Gesicht, Kleidung, Auffälliges) – 1-3 Sätze; leer wenn der Text nichts hergibt",
      "stimme": "Sprechweise/Register/typische Wendungen der Figur (z.B. «knapp und sarkastisch», «gehobener Ton», «spricht Dialekt») – 1-2 Sätze; leer wenn kein Dialog",
      "hintergrund": "Relevante Vorgeschichte vor bzw. ausserhalb der Haupthandlung (Herkunft, prägende frühere Ereignisse) – 1-3 Sätze; leer wenn nicht belegt",
      "rolle": "Funktion in der Handlung, 1-2 Sätze (z.B. 'Ermittelt den Mordfall', 'Erzählerin, blickt rückblickend zurück')",
      "motivation": "Was die Figur antreibt: äusseres Ziel (Want) UND innerer Mangel/Bedürfnis (Need) – 2-4 Sätze, textbelegt; leer wenn nicht belegt",
      "konflikt": "Zentrale(r) innere(r) und äussere(r) Konflikt(e) – 2-3 Sätze; leer wenn nicht belegt",
      "beschreibung": "Charakterporträt: Persönlichkeit, Wirkung auf andere, Bedeutung für die Handlung – 4-6 Sätze, textnah verdichtet",
      "sozialschicht": "wirtschaftselite|gehobenes_buergertum|mittelschicht|arbeiterschicht|migrantenmilieu|prekariat|unterwelt|andere",
      "eigenschaften": ["Eigenschaft1", "Eigenschaft2"],
      "praesenz": "zentral|regelmaessig|punktuell|randfigur",
      "arc": { "typ": "statisch|wandel|bogen", "anfang": "Zustand der Figur zu Beginn (1 Satz; leer wenn statisch)", "wendepunkte": ["Was die Figur im Verlauf verändert – je 1 Satz, in Reihenfolge der Handlung"], "ende": "Zustand am Schluss (1 Satz; leer wenn offen oder statisch)" },
      "erste_erwaehnung": "Kapitelname oder Seitenname der ersten Erwähnung (leer wenn unklar)",
      "schluesselzitate": ["Bis zu 5 charakterisierende Zitate, wörtlich aus dem Text – vollständige Sätze in Original-Interpunktion"],
      "kapitel": [{ "name": "Kapitelname" }],
      "beziehungen": [{ "figur_id": "fig_2", "typ": "elternteil|geschwister|kind|freund|feind|kollege|bekannt|liebesbeziehung|ehepartner|ex_partner|rivale|mentor|schuetzling|patronage|geschaeft|verbuendete|komplize|vorgesetzter|untergebener|andere", "machtverhaltnis": 0, "beschreibung": "1 Satz", "belege": [{ "kapitel": "Kapitelname (ohne ##-Präfix)", "seite": "Seitentitel (ohne ###-Präfix); leer wenn = Kapitel oder unklar" }] }]
    }
  ]
}`;

// Stammdaten-Variante OHNE Beziehungen (Claude-Single-Pass A1; Beziehungen folgen im A2-Pass).
// Aus FIGUREN_BASIS_SCHEMA abgeleitet, damit neue Felder automatisch mitwandern – die
// beziehungen-Zeile wird entfernt und das dadurch entstehende Trailing-Comma bereinigt.
export const FIGUREN_STAMM_SCHEMA = FIGUREN_BASIS_SCHEMA
  .split('\n')
  .filter(l => !l.trimStart().startsWith('"beziehungen"'))
  .join('\n')
  .replace(/,(\s*\}\s*\]\s*\})\s*$/, '$1');

export const figurenBasisRules = (kontext = '') => `Regeln:
- Eindeutige IDs (fig_1, fig_2, …)
- beziehungen.figur_id: nur IDs aus dieser Liste; jede Beziehung nur einmal eintragen
- kapitel: absteigend nach Häufigkeit; name = immer der Kapitelname (aus dem ## Kapitel-Header über dem Abschnitt oder aus dem Prompt-Kontext) – NIEMALS Seitentitel als Kapitelnamen verwenden. haeufigkeit (= Anzahl Seiten/Abschnitte mit aktivem Auftreten) NUR ergänzen wenn >1; bei Einzelauftreten weglassen.
- typ: Figuren-Archetyp. hauptfigur=trägt zentral die Handlung, antagonist=Gegenspieler, mentor=Anleiter/Lehrerin, nebenfigur=klar identifizierbarer Sekundärcharakter mit mehreren Auftritten, randfigur=tritt nur am Rand in Erscheinung (kaum mehr als Erwähnung), andere=nicht zuordenbar. NICHT mit praesenz verwechseln (Typ = Rolle, Präsenz = Handlungsgewicht).
- praesenz: Gewichtung der Figur im Gesamtbuch. zentral=Haupthandlungsträger, regelmaessig=wiederkehrend und handlungsrelevant, punktuell=taucht in einzelnen Szenen auf, randfigur=kaum mehr als Erwähnung. Liegt der gesamte Buchtext vor, beurteile über das ganze Buch; nur bei isolierter Einzelkapitel-Analyse basiert die Einschätzung auf diesem Kapitel.
- rolle: Funktion in der Handlung, 1-2 Sätze. Leer lassen wenn nicht belegt.
- motivation: äusseres Ziel (Want) UND innerer Mangel/Bedürfnis (Need), 2-4 Sätze, textbelegt. Beides nennen wenn der Text es hergibt. Leer lassen wenn nicht belegt.
- konflikt: zentrale(r) innere(r) und äussere(r) Konflikt(e), 2-3 Sätze. Leer lassen wenn nicht belegt.
- aeusseres: körperliche Erscheinung textnah (Statur, Gesicht, Kleidung, Auffälliges), 1-3 Sätze. Nur was der Text beschreibt; leer wenn nichts genannt – nicht erfinden.
- stimme: Sprechweise/Register/typische Wendungen, 1-2 Sätze (z.B. knapp, sarkastisch, gehoben, Dialekt, Floskeln). Leer wenn die Figur kaum/nicht spricht.
- hintergrund: Vorgeschichte vor bzw. ausserhalb der Haupthandlung (Herkunft, prägende frühere Ereignisse), 1-3 Sätze. Leer wenn nicht belegt.
- beschreibung: Charakterporträt in 4-6 Sätzen – Persönlichkeit, Wirkung auf andere, Bedeutung für die Handlung. Textnah verdichtet, keine Spekulation.
- schluesselzitate: bis zu 5 wörtliche Zitate die die Figur charakterisieren – exakt aus dem Text, vollständige Sätze in Original-Interpunktion (kein Zeichen-Limit). Leer lassen wenn keine prägnanten Stellen gefunden.
- erste_erwaehnung: Kapitel- oder Seitenname der ersten Erwähnung (so präzise wie belegt). Leer wenn unklar.
- wohnadresse: Wohnort oder Wohnadresse der Figur, so präzise wie textnah belegt (z.B. «Zürich», «Bahnhofstrasse 12, Bern», «kleines Bauernhaus am Waldrand»). Nur ausfüllen wenn explizit aus dem Text hervorgeht. Leer wenn nicht erwähnt – nicht spekulieren.
- arc.typ: "statisch" = Figur bleibt über das Buch unverändert; "wandel" = klare Veränderung; "bogen" = ausgeprägter Entwicklungsbogen mit mehreren Stationen. arc.anfang/ende = Zustand zu Beginn/Schluss (je 1 Satz; bei statisch leer). arc.wendepunkte = was die Figur verändert, je 1 Satz in Handlungsreihenfolge (leeres Array bei statisch). Nur Belegtes – nicht spekulieren.
- sozialschicht: gesellschaftliche Schicht der Figur${kontext ? ` (${kontext})` : ''} – nur vergeben wenn eindeutig belegt; wirtschaftselite=Unternehmerfamilien/Direktoren, gehobenes_buergertum=Akademiker/freie Berufe/obere Kader, mittelschicht=Angestellte/Beamte/mittlere Kader, arbeiterschicht=Fabrik-/Bauarbeiter/Servicepersonal, migrantenmilieu=Zugewanderte/zweite Generation, prekariat=Sozialhilfe/Randständige/Langzeitarbeitslose, unterwelt=kriminelles Milieu, andere=nicht eindeutig
- beziehungen.machtverhaltnis: ganzzahlig im Bereich -2 bis 2 (KEIN führendes Plus-Zeichen). Machtasymmetrie: 2=Gegenüber (figur_id) dominiert klar, 1=Gegenüber hat leichten Vorteil, 0=symmetrisch, -1=diese Figur hat leichten Vorteil, -2=diese Figur dominiert klar; weglassen oder 0 wenn unklar
- beziehungen.belege: HÖCHSTENS 1 Stelle (Kapitelname + Seitentitel) an der die Beziehung klar wird. Genau wie im Text stehen lassen; leer lassen wenn unsicher. seite leer lassen wenn identisch mit dem Kapitelnamen (z.B. 1 Seite pro Kapitel) oder unklar. Seitennamen aus ### Überschriften, Kapitelnamen aus ## Überschriften oder dem Prompt-Kontext.
- Beziehungstypen: typ beschreibt die ROLLE von figur_id (NICHT der aktuellen Figur!). Bei Figur X der Eintrag {figur_id: Y, typ: elternteil} bedeutet: Y IST der Elternteil von X. Konkretes Beispiel: Robert hat Mutter Sandra → bei Robert eintragen {figur_id: «<Sandras fig_id>», typ: elternteil, machtverhaltnis: 2}. patronage=Schutzherrschaft (figur_id = Patron), geschaeft=wirtschaftliche Beziehung, geschwister=ungerichtet, ehepartner=verheiratet/Lebenspartner (ungerichtet), ex_partner=frühere Liebes-/Ehebeziehung (ungerichtet), verbuendete=Verbündete/gemeinsame Sache jenseits blosser Freundschaft (ungerichtet), komplize=gemeinsame (oft illegale) Unternehmung (ungerichtet), vorgesetzter=figur_id ist Vorgesetzte(r), untergebener=figur_id ist unterstellt; liebesbeziehung nur für nicht-eheliche romantische Bindung. Übrige selbsterklärend
- Pro Figurenpaar höchstens EINE Beziehung eintragen – aus der Perspektive EINER Figur. Keine widersprüchlichen Angaben (z.B. nicht gleichzeitig elternteil und kind für dasselbe Paar)
- Nur fiktive Charaktere oder Figuren die aktiv an der Buchhandlung teilnehmen – keine Orte oder Objekte
- KEINE historischen oder realen Personen die nur erwähnt, zitiert oder als Referenz genannt werden (z.B. Napoleon, Einstein, ein Politiker, eine Künstlerin)
- Sortiert nach Wichtigkeit (zentral zuerst)
- KONSERVATIV heisst belegt, NICHT knapp: Nur Figuren, Beziehungen und Eigenschaften aufnehmen die im Text belegt sind – aber vorhandene Belege voll ausschöpfen. Unterscheide Spekulation (verboten) von textgestützter Schlussfolgerung (erwünscht – was der Text klar nahelegt, darf benannt werden). Ein leeres Feld ist nur dann richtig, wenn der Text wirklich nichts hergibt; wo Belege da sind, schreibe ausführlich und konkret statt in Stichworten.
- COVERAGE-FIRST bei der AUFNAHME (nicht bei der Feldtiefe): Nimm JEDE namentlich fassbare Figur auf – auch Grenzfälle, Nebenfiguren und nur einmal mit Eigennamen erwähnte Personen. Dubletten und Fehlaufnahmen werden in einer NACHGELAGERTEN Konsolidierung zusammengeführt bzw. entfernt; eine ausgelassene Figur ist dagegen dauerhaft verloren. Im Zweifel also aufnehmen. (Dies senkt NUR die Aufnahme-Schwelle – die einzelnen Felder bleiben streng textbelegt, keine erfundenen Details.)
- DEDUPLIZIERUNG MIT KONTEXTABGLEICH: Figuren zusammenführen wenn der Name übereinstimmt (gleicher Vor- und Nachname) ODER ein Teilname (nur Vorname oder nur Nachname) mit mindestens einem inhaltlichen Indiz zusammenpasst – z.B. gleicher Beruf, überschneidende Fachkenntnisse, konsistente Charakterzüge oder übereinstimmendes Verhalten kapitelübergreifend. Beispiel: «Maria» die in Kapitel 1 als Kräuterkundige gilt und «Maria Huber» die in Kapitel 3 Naturheilkunde beherrscht – zusammenführen. Widersprechen sich Eigenschaften eindeutig, getrennt behalten. Gibt es nur Namensähnlichkeit ohne inhaltliche Überschneidung: getrennt behalten.`;

// ── Schauplatz-Schemata (auch verwendet in Komplett-Analyse) ─────────────────

export const ORTE_SCHEMA = `{
  "orte": [
    {
      "id": "ort_1",
      "name": "Name des Schauplatz",
      "typ": "stadt|gebaeude|raum|landschaft|region|andere",
      "beschreibung": "2-3 Sätze zu Erscheinungsbild, Atmosphäre, Bedeutung für die Handlung",
      "land": "ISO-3166-1-alpha-2-Ländercode des Schauplatzes in Kleinbuchstaben (z.B. ch, de, fr, us); leer wenn nicht bestimmbar",
      "erste_erwaehnung": "Kapitelname oder Seitenname der ersten Erwähnung (leer wenn unklar)",
      "stimmung": "Grundatmosphäre in 2-3 Worten (z.B. bedrohlich, heimelig, verlassen, belebt)",
      "kapitel": ["Kapitelname"],
      "figuren_namen": ["Figurenname exakt wie im Text"]
    }
  ]
}`;

export const ORTE_RULES = `Regeln:
- Eindeutige IDs (ort_1, ort_2, …)
- SEHR GROSSZÜGIG erfassen: alle Schauplätze inklusive Nebenschauplätze und einmaliger Erwähnungen; lieber inkludieren als weglassen. haeufigkeit=1 ist gültig.
- figuren_namen: Klarnamen der Figuren, die am Ort auftreten – exakt wie im Text (vollständiger Name oder Spitzname, KEINE ID); leeres Array wenn keine Figur klar zuordenbar
- kapitel: flaches Array der Kapitelnamen (Strings), in denen der Ort aktiv vorkommt – jeder Kapitelname höchstens einmal
- land: ISO-3166-1-alpha-2 in Kleinbuchstaben. Belege das Land aus dem Text (genannte Stadt/Region/Land). Ist im Text kein anderes Land erkennbar, ordne den Ort dem HAUPT-SCHAUPLATZLAND des Buchs zu (falls im Kontext angegeben). Reine Innenräume/Gebäude ohne geografischen Hinweis erben das Land der umgebenden Stadt/Region. Nur leer lassen, wenn weder Text noch Hauptland eine Zuordnung erlauben.
- COVERAGE-FIRST bei der AUFNAHME: Im Zweifel jeden benannten Schauplatz aufnehmen – Dubletten werden nachgelagert konsolidiert, ein ausgelassener Ort ist verloren.
- Kein Cap auf Anzahl Orte – vollständige Erfassung wichtiger als Kürze`;

// ── Musik-Schema (Songs/Musikstücke) ────────────────────────────────────────
// Parallel zu ORTE_SCHEMA. Pflicht-Feld kontext_typ (hört/spielt/erwähnt/
// leitmotiv/diegetisch); figuren_namen = Klarnamen (wer hört/spielt/komponiert/
// singt) – wie Szenen, NICHT als fig_id-Referenz: der Song-Extraktions-Pass (B)
// läuft parallel zu A1 und kennt dessen fig_ids nicht. Auflösung Name → kanonische
// fig_id erst nach P2 via figNameToId (runPhase3Songs).

export const SONGS_SCHEMA = `{
  "songs": [
    {
      "id": "song_1",
      "titel": "Exakter Titel des Songs/Stücks wie im Text genannt",
      "interpret": "Interpret, Band, Komponist oder Soundtrack (leer wenn nicht belegt)",
      "genre": "Hip-Hop|Rock|Pop|Klassik|Jazz|Electronic|Volksmusik|Soundtrack|Schlager|Punk|Metal|Country|Blues|Folk|R&B|Reggae|Chanson|Lied|Hymne|andere – leer wenn unklar",
      "kontext_typ": "hört|spielt|erwähnt|leitmotiv|diegetisch",
      "beschreibung": "1-2 Sätze: in welcher Szene/Situation der Song auftaucht, welche Funktion er hat",
      "stimmung": "Grundatmosphäre in 2-3 Worten (z.B. melancholisch, euphorisch, beklemmend)",
      "erste_erwaehnung": "Kapitelname oder Seitenname der ersten Erwähnung (leer wenn unklar)",
      "kapitel": [{ "name": "Kapitelname", "haeufigkeit": 2 }],
      "figuren_namen": ["Figurenname exakt wie im Text"]
    }
  ]
}`;

export const SONGS_RULES = `Regeln:
- Eindeutige IDs (song_1, song_2, …)
- SEHR GROSSZÜGIG erfassen: jeden namentlich genannten Song, Track, Klassik-Stück, Hymne, Soundtrack, jede konkrete Band/Interpret-Erwähnung als eigenen Eintrag, auch bei einmaliger Erwähnung.
- KEINE generischen Genre-Erwähnungen ohne konkreten Titel/Interpret («Klassische Musik im Hintergrund» reicht nicht). Pflicht: mindestens titel ODER interpret.
- kontext_typ: «hört» = Figur konsumiert (Radio, Kopfhörer, Konzert); «spielt» = Figur produziert aktiv (Instrument, Gesang); «erwähnt» = Song wird im Dialog/Erzähltext genannt, ohne dass jemand ihn hört oder spielt; «leitmotiv» = Song zieht sich als wiederkehrendes Motiv durchs Buch; «diegetisch» = Musik im Hintergrund einer Szene (Bar, Auto, Party) ohne aktive Figur-Bindung.
- figuren_namen: Klarnamen der Figuren, die den Song hören/spielen/erwähnen – exakt wie im Text (vollständiger Name oder Spitzname, KEINE ID); leeres Array wenn keine Figur klar zuordenbar
- kapitel: absteigend nach Häufigkeit; haeufigkeit = Anzahl Seiten/Abschnitte mit aktivem Vorkommen
- Klassische Stücke ohne Interpret: Komponist als interpret eintragen («Beethoven» für «Mondscheinsonate»)
- Kein Cap – vollständige Erfassung wichtiger als Kürze`;

// ── Fakten-Schema (verwendet in Komplett-Analyse und Kontinuität) ────────────

export const FAKTEN_SCHEMA = `"fakten": [
    {
      "kategorie": "figur|ort|objekt|organisation|technik|regel|kultur|historie|zeit|soziolekt|ereignis|sonstiges",
      "subjekt": "Über wen/was geht es (Name oder Bezeichnung)",
      "fakt": "Was genau behauptet wird (1 Satz, so präzise wie möglich)",
      "seite": "Seitenname oder Abschnittsname (leer wenn unklar)"
    }
  ]`;

export const FAKTEN_RULES = `Fakten-Regeln:
- Erfasse möglichst VOLLSTÄNDIG alle konkreten, prüfbaren Aussagen über die Welt des Buchs – nicht nur eng kontinuitätskritische. Lieber zu viele Fakten als zu wenige.
- Welt/Setting dicht erfassen: Geographie, Epoche, Institutionen, Technik, Regeln und Gesetze der erzählten Welt, Kultur, Historie, gesellschaftliche Verhältnisse.
- Figuren-Zustände besonders genau erfassen (Wissen, Können, körperlicher Zustand, Wohnort, Beruf, Besitz)
- Soziolekt: Wenn eine Figur erstmals oder markant spricht, ein Faktum erfassen das ihr Sprachregister beschreibt. Kategorie «soziolekt» verwenden.
- Objekte: Wer besitzt was, wo liegt was, in welchem Zustand
- Zeitangaben: Relative («am nächsten Morgen») und absolute («1943») erfassen
- PFLICHT: «kategorie» ist genau EINER der vorgegebenen Werte – NIE ein eigener Freitext. «sonstiges» nur als letzte Wahl, wenn wirklich keine andere Kategorie passt; ordne so spezifisch wie möglich ein:
  · figur = Eigenschaften/Zustände einer Figur (Wissen, Können, Körper, Beruf, Besitz, Wohnort)
  · ort = Schauplätze, Lage, Geografie, Klima, Wege
  · objekt = Gegenstände, Artefakte, Besitz und deren Zustand
  · organisation = Institutionen, Gruppen, Fraktionen, gesellschaftliche Strukturen
  · technik = Technik, Wissenschaft, Magie-/Welt-Mechanik und ihre Funktionsweise
  · regel = Regeln, Gesetze, Normen, Verbote der erzählten Welt
  · kultur = Kultur, Bräuche, Religion, Werte, gesellschaftliche Verhältnisse
  · historie = Vorgeschichte, historische Fakten/Ereignisse der Welt vor der Handlung
  · zeit = Zeitangaben und Chronologie (relativ wie absolut)
  · soziolekt = Sprachregister/Sprechweise einer Figur
  · ereignis = welt-/kontinuitätsrelevante Geschehnisse, die KEINER einzelnen Figur zuzuordnen sind (Krieg, Naturkatastrophe, öffentliches/gesellschaftliches Ereignis, Umbruch). Biografische Ereignisse einzelner Figuren gehören NICHT hierher.
- PRIORITÄT: Bevorzuge immer die spezifischste Sach-Kategorie. «ereignis» ist die letzte Wahl unter den handlungsnahen Optionen – wenn ein Geschehen einen stabilen Weltzustand offenbart, erfasse diesen Zustand («ort»/«objekt»/«regel»/«figur»), nicht das Geschehen (z.B. statt «Robert betritt die Fabrik» → «ort»: «Die Fabrik liegt am Stadtrand»).
- KEINE gewöhnlichen Handlungsschritte erfassen (Figur betritt einen Raum, führt ein Gespräch, geht irgendwohin, denkt nach). Solche Sätze sind keine Welt-Fakten.
- Nur prüfbare Aussagen aus dem Text – keine Interpretationen, Wertungen oder Spekulationen
- Kein Cap auf Anzahl Fakten – vollständige, präzise Erfassung ist das Ziel`;

// ── Kontinuitäts-Probleme-Schema (verwendet in Check und SinglePass) ─────────

export const PROBLEME_SCHEMA = `{
  "_reasoning": "Kurzer Prüf-Audit (max 6 Zeilen Stichpunkte), KEINE ausführliche Herleitung. Wenn du intern bereits Schritt für Schritt nachgedacht hast, wiederhole das hier NICHT in voller Länge – fasse nur das Ergebnis zusammen: 1) als harmlos verworfene Kandidaten mit Kurz-Grund (z.B. ‹durch Rückblende erklärbar›, ‹im selben Kapitel auflösbar›); 2) bestätigte Widersprüche, die ins probleme-Array kommen.",
  "probleme": [
    {
      "schwere": "kritisch|mittel|niedrig",
      "typ": "figur|zeitlinie|zeitluecke|ort|objekt|verhalten|soziolekt|anachronismus|sonstiges",
      "beschreibung": "Was genau widerspricht sich (1-2 Sätze)",
      "stelle_a": "Kapitel + wörtliches Zitat (5-15 Wörter) der widersprechenden Aussage",
      "stelle_b": "Kapitel + wörtliches Zitat (5-15 Wörter) der Gegen-Aussage",
      "figuren": ["Name der direkt betroffenen Figur"],
      "kapitel": ["Exakter Kapitelname A", "Exakter Kapitelname B"],
      "empfehlung": "Wie könnte das aufgelöst werden (1 Satz)"
    }
  ],
  "zusammenfassung": "Gesamteinschätzung der Konsistenz des Buchs in 2-3 Sätzen"
}`;

export const PROBLEME_RULES = `Beispiel eines korrekten Eintrags:
{
  "schwere": "kritisch",
  "typ": "figur",
  "beschreibung": "Marek stirbt im Bombenangriff, taucht zwei Kapitel später lebend auf.",
  "stelle_a": "Kapitel 3: «Marek lag reglos unter den Trümmern»",
  "stelle_b": "Kapitel 5: «Marek öffnete die Tür und lachte»",
  "figuren": ["Marek"],
  "kapitel": ["Kapitel 3", "Kapitel 5"],
  "empfehlung": "Tod in Kapitel 3 abschwächen oder Rückkehr im Text erklären."
}

Regeln:
- Zitat-Pflicht: «stelle_a» UND «stelle_b» MÜSSEN je die konkrete widersprechende Aussage belegen (5-15 Wörter, in «»). Liegt dir der Buchtext vor, zitiere wörtlich aus dem Text; liegen dir nur extrahierte Fakten vor, zitiere die betreffende Fakt-Aussage. Kannst du für eine der beiden Stellen keinen solchen Beleg angeben, melde den Widerspruch NICHT. Keine erfundenen Stellen.
- Reasoning-First: «_reasoning» MUSS das erste Feld im JSON-Output sein. Denke dort schrittweise nach, BEVOR du «probleme» befüllst. Reihenfolge der Schritte: (1) Fakten, (2) paarweise Vergleiche, (3) verworfene Kandidaten mit Grund, (4) bestätigte Widersprüche. Knapp halten, Stichpunkte reichen.
- «probleme» enthält NUR die im _reasoning unter (4) bestätigten Widersprüche – jeden verworfenen Kandidaten lässt du weg, NIE als Eintrag mit «Eintrag entfernen»-Empfehlung.
- Nur echte Widersprüche – keine stilistischen oder inhaltlichen Anmerkungen
- WICHTIG: Wenn du bei der Analyse zum Schluss kommst, dass KEIN Widerspruch vorliegt (z.B. «konsistent», «passt», «kein echter Widerspruch»), dann das Problem NICHT melden. Nur tatsächliche Widersprüche ins Array aufnehmen.
- Das «probleme»-Array ist AUSSCHLIESSLICH für bestätigte Widersprüche da – nicht für Zwischenüberlegungen, geprüfte-aber-verworfene Kandidaten oder Entwarnungen. Wenn ein Kandidat sich beim Nachdenken als harmlos herausstellt, wird er komplett weggelassen, nicht mit einer Erklärung ins Array geschrieben.
- Selbstcheck vor dem Antworten: Lies jede «beschreibung» UND jede «empfehlung» gegen. Enthält EINES der beiden Felder Formulierungen wie «kein Widerspruch», «kein echter Widerspruch», «konsistent», «passt zusammen», «stimmig», «wird nicht gemeldet», «Entwarnung», «unproblematisch», «das ist korrekt», «kein Problem», «Eintrag entfernen», «lässt sich erklären durch …» (als Entwarnung) – dann den ganzen Eintrag ersatzlos aus dem Array entfernen. «beschreibung» muss den Widerspruch positiv benennen, «empfehlung» muss eine Lösung des Widerspruchs vorschlagen – niemals «Eintrag entfernen» oder ähnliche Selbst-Annullierungen.
- schwere: «kritisch» = klarer Logikfehler der dem Leser sofort auffällt und zwingend korrigiert werden muss; «mittel» = wahrscheinlicher Fehler der den Leser stören könnte; «niedrig» = mögliche Inkonsistenz die eventuell beabsichtigt ist
- Soziolekt-Probleme: nur wenn klar ein Sprachmuster etabliert wurde und dann ohne Begründung bricht – nicht melden wenn Figur wenig Dialoganteil hat
- figuren: PFLICHTFELD – immer angeben, mindestens []; Namen exakt wie in der Figurenliste; [] nur wenn wirklich keine Figur betroffen (rein ortsbezogene Widersprüche)
- kapitel: PFLICHTFELD – immer angeben, mindestens []; exakte Kapitelnamen aus stelle_a/stelle_b; wenn beide Stellen im selben Kapitel nur einmal; [] nur wenn der Text keine Kapitelinformation enthält
- Wenn keine Widersprüche gefunden: «probleme» als leeres Array, «zusammenfassung» = positive Einschätzung
- Konservativ: Im Zweifel weglassen – lieber ein echtes Problem übersehen als ein Nicht-Problem melden`;

// Hilfsfunktion: Extrahiert den Inhalt des äussersten Objekts aus einem Schema-String.
// Ermöglicht das Zusammensetzen von Schemas ohne Duplikation der Felddefinitionen.
export function _schemaBody(schemaStr) {
  return schemaStr.trim().replace(/^\s*\{\s*/, '').replace(/\s*\}\s*$/, '').trim();
}

// Geteilter Lebensereignis-Schema-Block (Pass A lokal + Claude-A1-Stammpass).
export const _ASSIGNMENTS_SCHEMA_BLOCK = `"assignments": [
    {
      "figur_name": "Exakt der kanonische figuren[].name aus DIESER Antwort (kein Spitzname/Titel/Textvariante, die dort nicht steht) – sonst wird das Ereignis beim ID-Mapping verworfen",
      "lebensereignisse": [
        {
          "datum": "Original-Datum-Notation (JJJJ, JJJJ-MM, JJJJ-MM-TT, «Mai 1850», «Tag 3», «vor der Reise», …)",
          "datum_label": "User-lesbarer Original-String.",
          "datum_year":  1850,         // null wenn unbekannt – NIEMALS 0
          "datum_month": null,         // 1-12 oder null – NIEMALS 0
          "datum_day":   null,         // 1-31 oder null – NIEMALS 0
          "datum_ende_year":  null,    // Spanne: Ende-Jahr; null wenn Punkt-Ereignis – NIEMALS 0
          "datum_ende_month": null,
          "datum_ende_day":   null,
          "story_tag":   null,         // Relative Story-Zeit (ab 1) – NIEMALS 0
          "datum_unsicher": false,     // true NUR wenn datum_year aus dem Kontext abgeleitet (nicht explizit belegt) wurde
          "subtyp":      "sonstiges",  // geburt|tod|hochzeit|liebe|trennung|krankheit|reise|umzug|konflikt|wendepunkt|entdeckung|verlust|sieg|extern_politisch|extern_wirtschaftlich|extern_natur|extern_kulturell|extern_krieg|sonstiges
          "ereignis": "Was passierte – neutral formuliert. Gleiches Ereignis bei allen beteiligten Figuren identisch.",
          "typ": "persoenlich|extern",
          "bedeutung": "Bedeutung für diese Figur (1 Satz, leer wenn nicht klar)",
          "seite": "EXAKT ein ### Seiten-Header aus dem aktuellen ## Kapitel. NIE der Kapitelname. Leer wenn unklar.",
          "kapitel": "EXAKT der ## Kapitel-Header (nicht ###); leer wenn unklar"
        }
      ]
    }
  ]`;

export const _EREIGNIS_RULES = `Ereignis-Regeln:
- VOLLSTÄNDIGKEIT vor Kürze: Gehe jede Figur einzeln durch und erfasse ALLE im Text belegten Ereignisse – kein Cap. Neben den grossen biografischen Wendepunkten (Geburt, Tod, Trauma, neue/beendete Beziehung, Jobwechsel, Umzug, wichtige Entscheidung) auch kleinere, aber belegte Vorfälle (erste Begegnung, Streit/Versöhnung, Reise-Etappe, Erkrankung/Genesung, Erfolg/Niederlage, prägende Beobachtung). Ziel ist die möglichst lückenlose Biografie jeder Figur. Im Zweifel aufnehmen statt weglassen – solange im Text belegt.
- typ='persoenlich' = biografische Ereignisse der Figur; typ='extern' = gesellschaftliche/historische Ereignisse (Kriege, Politik, Wirtschaft, Kultur, Natur) – diese SEHR GROSSZÜGIG erfassen und ALLEN betroffenen Figuren zuweisen.
- datum_label = Original-String; datum_year/month/day strukturiert zerlegen (null wenn unbekannt).
- UNBEKANNT HEISST null, NIEMALS 0: Jedes unbekannte Zahlenfeld (datum_year, datum_month, datum_day, datum_ende_*, story_tag) MUSS exakt \`null\` sein. Eine 0 wird als echtes Datum gelesen und ergibt Unsinn wie «00.00.0». Gültige Bereiche: Monat 1-12, Tag 1-31, story_tag ab 1; Jahr 0 gibt es nicht (v. Chr. negativ schreiben). Kein Ereignis ist eine Spanne, nur weil das Feld existiert – datum_ende_* bleibt bei Punkt-Ereignissen komplett null.
- JAHRES-INFERENZ (wichtig): Steht am Ereignis kein explizites Datum, das Jahr ist aber aus dem Kontext erschliessbar – z.B. aus einer vorher im Kapitel/Buch verankerten Jahreszahl plus relativen Angaben («zwei Jahre später», «im Frühjahr darauf», «als sie 30 war»), aus der Lebensspanne der Figur oder aus der etablierten Epoche/dem Setting – dann das abgeleitete Jahr (notfalls nur das Jahrzehnt, dann z.B. 1850) trotzdem in datum_year eintragen und datum_unsicher=true setzen. Sei dabei GROSSZÜGIG: lieber ein plausibel abgeleitetes Jahr (als unsicher markiert) als gar keins. Monat/Tag nur füllen, wenn ebenfalls ableitbar.
- datum_unsicher=false NUR für explizit im Text belegte Datumsangaben. Ist auch das Jahr nicht erschliessbar, bleibt alles null (Event landet im «unbekannt»-Bucket, darf aber NICHT entfallen).
- Spannen (Krieg, Reise, Studium, Schwangerschaft): Start in datum_*, Ende in datum_ende_*.
- ereignis: neutral und kanonisch formuliert (NICHT aus der Figurenperspektive). Ein Ereignis, das mehrere Figuren betrifft, bei ALLEN beteiligten Figuren WORTGLEICH formulieren (z.B. 'Geburt von Maria' für Vater, Mutter und Kind) – sonst scheitert die spätere Zusammenführung.
- subtyp aus Whitelist; persoenlich → geburt|tod|hochzeit|liebe|trennung|krankheit|reise|umzug|konflikt|wendepunkt|entdeckung|verlust|sieg|sonstiges; extern → extern_politisch|extern_wirtschaftlich|extern_natur|extern_kulturell|extern_krieg|sonstiges. liebe=Beginn einer Liebesbeziehung; trennung=Scheidung/Trennung; krankheit=Erkrankung/Verletzung; umzug=dauerhafter Wohnortwechsel (NICHT reise=temporär); extern_wirtschaftlich=Wirtschaftskrise/Crash/Inflation; extern_krieg=Krieg/Schlacht/militärischer Konflikt.
- Nur Figuren ausgeben die mindestens ein Ereignis haben.`;
