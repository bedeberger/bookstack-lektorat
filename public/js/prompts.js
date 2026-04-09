export const CLAUDE_API = '/claude';

// Unveränderliche technische Pflicht-Anweisung – darf nicht konfiguriert werden,
// da callAI() immer ein JSON-Objekt erwartet.
const JSON_ONLY = 'Antworte ausschliesslich mit einem JSON-Objekt – kein Markdown, kein Text davor oder danach. Beginne deine Antwort direkt mit { und beende sie mit }.';


function buildSystem(prefix, rules) {
  return `${prefix}\n\n${rules}\n\n${JSON_ONLY}`;
}

// Für Chat-Prompts: Prefix + Rules, aber kein JSON_ONLY am Ende –
// buildChatSystemPrompt/buildBookChatSystemPrompt hängen das Schema selbst an.
function buildSystemNoJson(prefix, rules) {
  return `${prefix}\n\n${rules}`;
}

// Live-Exports – werden durch configurePrompts() gesetzt (Pflicht vor erstem Prompt-Aufruf).
// Alle importierenden Module erhalten via ESM-Live-Binding immer den aktuellen Wert.
export let ERKLAERUNG_RULE      = null;
export let STOPWORDS            = [];
export let SYSTEM_LEKTORAT      = null;
export let SYSTEM_BUCHBEWERTUNG = null;
export let SYSTEM_KAPITELANALYSE= null;
export let SYSTEM_FIGUREN       = null;
export let SYSTEM_STILKORREKTUR = null;
export let SYSTEM_CHAT          = null;
export let SYSTEM_BOOK_CHAT     = null;
export let SYSTEM_ORTE          = null;
export let SYSTEM_KONTINUITAET  = null;

/**
 * Setzt alle System-Prompts aus dem promptConfig-Objekt (geladen aus prompt-config.json).
 * Pflichtaufruf beim App-Start – wirft einen Fehler wenn cfg fehlt.
 * @param {Object} cfg  promptConfig-Objekt aus /config
 */
export function configurePrompts(cfg) {
  if (!cfg) throw new Error('prompt-config.json fehlt oder ist ungültig – Prompts können nicht konfiguriert werden.');
  const rules = cfg.baseRules;
  if (!rules) throw new Error('prompt-config.json: Pflichtfeld "baseRules" fehlt.');
  const sp = cfg.systemPrompts || {};
  ERKLAERUNG_RULE       = cfg.erklaerungRule || '';
  STOPWORDS             = Array.isArray(cfg.stopwords) ? cfg.stopwords : [];
  SYSTEM_LEKTORAT       = buildSystem(sp.lektorat       || '', rules);
  SYSTEM_BUCHBEWERTUNG  = buildSystem(sp.buchbewertung  || '', rules);
  SYSTEM_KAPITELANALYSE = buildSystem(sp.kapitelanalyse || '', rules);
  SYSTEM_FIGUREN        = buildSystem(sp.figuren        || '', rules);
  SYSTEM_STILKORREKTUR  = buildSystem(sp.stilkorrektur  || '', rules);
  SYSTEM_CHAT           = buildSystemNoJson(sp.chat     || '', rules);
  SYSTEM_BOOK_CHAT      = buildSystemNoJson(sp.buchchat || '', rules);
  SYSTEM_ORTE           = buildSystem(sp.orte           || 'Du bist ein Literaturanalytiker für deutschsprachige Texte. Du identifizierst Schauplätze und Orte präzise und konservativ – nur was im Text eindeutig belegt ist.', rules);
  SYSTEM_KONTINUITAET   = buildSystem(sp.kontinuitaet   || 'Du bist ein sorgfältiger Literaturlektor für deutschsprachige Texte. Du prüfst einen Roman auf Kontinuitätsfehler und Widersprüche – Figuren, Zeitabläufe, Orte, Objekte und Charakterverhalten.', rules);
}

export function buildStilkorrekturPrompt(html, styles) {
  const liste = styles.map((s, i) =>
    `${i + 1}. Originalstelle: "${s.original}"\n   Empfehlung: "${s.korrektur}"\n   Begründung: ${s.erklaerung}\n   Kontext: ${s.kontext}`
  ).join('\n\n');

  return `Du bekommst einen HTML-Text und eine Liste stilistischer Verbesserungsvorschläge. Für jede Stelle entscheidest du selbst, wie die beste Formulierung lautet – die Empfehlung ist ein Hinweis, keine Vorgabe. Gib für jede Stelle das exakte Original (wie es im HTML steht) und deine gewählte Ersatzformulierung zurück.

Stilistische Verbesserungen:
${liste}

Antworte mit diesem JSON-Schema:
{
  "korrekturen": [
    { "original": "exakter Originaltext wie im HTML", "ersatz": "deine gewählte Ersatzformulierung" }
  ]
}

HTML-Text:
${html}`;
}

// Wiederholung-Regeln für Lektorat-Prompts (beide Varianten)
function _buildWiederholungBlock() {
  const sw = STOPWORDS.length > 0
    ? `\n- Stoppwörter nie melden (auch flektierte Formen): ${STOPWORDS.join(', ')}`
    : '';
  return `
Wiederholung-Regeln (typ: «wiederholung»):
- Nur Inhaltswörter, die auffällig oft vorkommen: mind. 3× im Text ODER 2× in enger Nähe (5 Sätze)
- Keine Pronomen, Hilfsverben, Artikel, Konjunktionen, Präpositionen, Eigennamen${sw}
- «original»: vollständiger Satz zeichengenau aus dem Text (damit die Textstelle eindeutig auffindbar ist)
- «korrektur»: derselbe Satz mit dem besten Synonym – exakt gleiche grammatische Form (Kasus, Numerus, Tempus)
- Synonym-Selbsttest vor jedem Eintrag: Klingt der Satz danach natürlich? Bedeutung erhalten? Passt zum Autorenstil?`;
}

// Batch-Variante ohne korrekturen_html (spart Output-Tokens, für Server-Side-Jobs)
export function buildBatchLektoratPrompt(text) {
  return `Analysiere diesen deutschsprachigen Text auf Rechtschreibfehler, Grammatikfehler, stilistische Auffälligkeiten und auffällige Wortwiederholungen. Bewerte ausserdem die Szenen der Seite.

WICHTIG: Jede einzelne Beanstandung erhält einen eigenen Eintrag im «fehler»-Array. Wenn an einer Stelle mehrere unabhängige Probleme vorliegen, müssen diese als separate Einträge erscheinen – niemals in einer gemeinsamen «erklaerung» zusammenfassen.

Antworte mit diesem JSON-Schema:
{
  "fehler": [
    {
      "typ": "rechtschreibung|grammatik|stil|wiederholung",
      "original": "das fehlerhafte Wort oder die fehlerhafte Phrase – bei «wiederholung»: vollständiger Satz zeichengenau aus dem Text",
      "korrektur": "die korrekte Version – bei «wiederholung»: derselbe Satz mit Synonym",
      "kontext": "der Satz in dem der Fehler vorkommt (bei «wiederholung» gleich wie «original»)",
      "erklaerung": "kurze Erklärung auf Deutsch (nur diesen einen Mangel beschreiben) ${ERKLAERUNG_RULE}"
    }
  ],
  "szenen": [
    {
      "titel": "Kurze Szenenbezeichnung (1 Satz)",
      "wertung": "stark|mittel|schwach",
      "kommentar": "1-2 Sätze: was funktioniert, was fehlt (Spannung, Tempo, Figurenentwicklung)"
    }
  ],
  "stilanalyse": "2-3 Sätze Stilanalyse",
  "fazit": "ein Satz Gesamtfazit"
}

Szenen-Regeln:
- Eine Szene ist ein abgegrenzter Handlungsabschnitt mit eigenem Anfang und Ende
- Wenn die Seite keine erkennbaren Szenen enthält (z.B. rein beschreibender Text, Exposition): «szenen» als leeres Array zurückgeben
- wertung: «stark» = funktioniert gut, «mittel» = verbesserungswürdig, «schwach» = klare Schwächen
${_buildWiederholungBlock()}

Text:
${text}`;
}

// ── Buchbewertung ─────────────────────────────────────────────────────────────

export function buildBookReviewSinglePassPrompt(bookName, pageCount, bookText) {
  return `Bewerte das folgende Buch «${bookName}» kritisch und umfassend. Analysiere:
- Struktur und Aufbau (Kapitel, Übergänge, Logik)
- Sprachstil und Konsistenz über alle Seiten hinweg
- Stärken des Texts
- Schwächen und Verbesserungspotenzial
- Konkrete Empfehlungen für den Autor

Antworte mit diesem JSON-Schema:
{
  "gesamtnote": "Zahl von 1 (sehr schwach) bis 5 (ausgezeichnet)",
  "gesamtnote_begruendung": "Ein Satz warum diese Note",
  "zusammenfassung": "2-3 Sätze Gesamteindruck",
  "struktur": "Analyse des Aufbaus und der Struktur (3-4 Sätze)",
  "stil": "Analyse des Schreibstils und seiner Konsistenz (3-4 Sätze)",
  "staerken": ["Stärke 1", "Stärke 2", "Stärke 3"],
  "schwaechen": ["Schwäche 1", "Schwäche 2"],
  "empfehlungen": ["Empfehlung 1", "Empfehlung 2", "Empfehlung 3"],
  "fazit": "Abschliessendes Urteil in 1-2 Sätzen"
}

${JSON_ONLY}

Buchinhalt (${pageCount} Seiten):

${bookText}`;
}

export function buildChapterAnalysisPrompt(chapterName, bookName, pageCount, chText) {
  return `Analysiere das Kapitel «${chapterName}» aus dem Buch «${bookName}».
Lies den vollständigen Kapiteltext und gib eine kompakte Analyse als JSON zurück:

Antworte mit diesem JSON-Schema:
{
  "themen": "Hauptthemen und Inhalte in 2-3 Sätzen",
  "stil": "Schreibstilbeobachtungen: Wortwahl, Satzbau, Ton in 2 Sätzen",
  "qualitaet": "Allgemeiner Qualitätseindruck in 1-2 Sätzen",
  "staerken": ["konkrete Stärke 1", "konkrete Stärke 2"],
  "schwaechen": ["konkrete Schwäche 1", "konkrete Schwäche 2"]
}

${JSON_ONLY}

Kapitelinhalt (${pageCount} Seiten):

${chText}`;
}

export function buildBookReviewMultiPassPrompt(bookName, chapterAnalyses, totalPageCount) {
  const synthIn = chapterAnalyses.map((ca, i) =>
    `## Kapitel ${i + 1}: ${ca.name} (${ca.pageCount} Seiten)\nThemen: ${ca.themen || '–'}\nStil: ${ca.stil || '–'}\nQualität: ${ca.qualitaet || '–'}\nStärken: ${(ca.staerken || []).join(' | ')}\nSchwächen: ${(ca.schwaechen || []).join(' | ')}`
  ).join('\n\n');
  return `Bewerte das Buch «${bookName}» kritisch und umfassend.
Grundlage sind die Analysen aller ${chapterAnalyses.length} Kapitel (insgesamt ${totalPageCount} Seiten).

Kapitelanalysen:

${synthIn}

${JSON_ONLY}

Antworte mit diesem JSON-Schema:
{
  "gesamtnote": "Zahl von 1 (sehr schwach) bis 5 (ausgezeichnet)",
  "gesamtnote_begruendung": "Ein Satz warum diese Note",
  "zusammenfassung": "2-3 Sätze Gesamteindruck",
  "struktur": "Analyse des Aufbaus und der Struktur über alle Kapitel (3-5 Sätze)",
  "stil": "Analyse des Schreibstils und seiner Konsistenz über das gesamte Buch (3-5 Sätze)",
  "staerken": ["Stärke 1", "Stärke 2", "Stärke 3"],
  "schwaechen": ["Schwäche 1", "Schwäche 2"],
  "empfehlungen": ["Empfehlung 1", "Empfehlung 2", "Empfehlung 3"],
  "fazit": "Abschliessendes Urteil in 1-3 Sätzen"
}`;
}

// ── Figurenextraktion ─────────────────────────────────────────────────────────

const FIGUREN_SCHEMA = `{
  "figuren": [
    {
      "id": "fig_1",
      "name": "Vollständiger Name",
      "kurzname": "Vorname oder Spitzname",
      "typ": "hauptfigur|nebenfigur|antagonist|mentor|andere",
      "geburtstag": "JJJJ oder leer wenn unbekannt",
      "geschlecht": "männlich|weiblich|divers|unbekannt",
      "beruf": "Beruf oder Rolle oder leer",
      "beschreibung": "2-3 Sätze zu Rolle, Persönlichkeit und Bedeutung",
      "eigenschaften": ["Eigenschaft1", "Eigenschaft2"],
      "lebensereignisse": [{ "datum": "JJJJ (nur Jahreszahl; falls nicht direkt genannt aus Kontext errechnen – z.B. Geburtsjahr + damaliges Alter, oder bekannte historische Jahreszahl; leer lassen wenn nicht errechenbar)", "ereignis": "Was passierte (1 Satz)", "typ": "persoenlich|extern", "bedeutung": "Bedeutung für die Figur (1 Satz, leer wenn nicht klar)", "kapitel": "Kapitelname wo dieses Ereignis erwähnt wird (leer wenn unklar)" }],
      "kapitel": [{ "name": "Kapitelname", "haeufigkeit": 3 }],
      "beziehungen": [{ "figur_id": "fig_2", "typ": "elternteil|geschwister|kind|freund|feind|kollege|bekannt|liebesbeziehung|rivale|mentor|schuetzling|andere", "beschreibung": "1 Satz" }]
    }
  ]
}`;

const FIGUREN_RULES = `Regeln:
- Eindeutige IDs (fig_1, fig_2, …)
- beziehungen.figur_id: nur IDs aus dieser Liste; jede Beziehung nur einmal eintragen
- kapitel: absteigend nach Häufigkeit; haeufigkeit = Anzahl Seiten/Abschnitte mit aktivem Auftreten
- lebensereignisse: chronologisch sortiert; kapitel = Kapitelname aus dem der Textbeleg stammt (leer wenn unklar); datum immer als vierstellige Jahreszahl (JJJJ) – falls nicht direkt erwähnt, aus Kontext errechnen (Geburtsjahr der Figur + genannte Altersangabe, bekannte historische Jahreszahlen u.ä.); Events ohne errechenbare Jahreszahl weglassen; typ='persoenlich' nur für echte biografische Wendepunkte (neue Beziehung, Trennung, Jobwechsel, Verlust einer nahestehenden Person, Pubertät/Reifung, Umzug, Trauma, wichtige Entscheidung) – keine Alltagshandlungen oder Szenen die keine bleibende Wirkung haben; typ='extern' für gesellschaftliche/historische Ereignisse (Katastrophen, Massaker, Kriege, politische Umbrüche u.ä.) die die Figur direkt betreffen – hier grosszügig sein, auch erwähnte Ereignisse aufnehmen die nur indirekt wirken
- Beziehungstypen: elternteil/kind (gerichtet), geschwister (undirektional), übrige selbsterklärend
- Nur fiktive Charaktere oder Figuren die aktiv an der Buchhandlung teilnehmen – keine Orte oder Objekte
- KEINE historischen oder realen Personen die nur erwähnt, zitiert oder als Referenz genannt werden (z.B. Napoleon, Einstein, ein Politiker, eine Künstlerin); solche Personen gehören höchstens als lebensereignis.typ='extern' zu einer Figur, aber nicht als eigene Figur in diese Liste
- Sortiert nach Wichtigkeit
- KONSERVATIV: Nur Figuren, Beziehungen und Ereignisse aufnehmen die im Text eindeutig belegt sind. Lieber weglassen als spekulieren.
- DEDUPLIZIERUNG NUR BEI EINDEUTIGER NAMENSGLEICHHEIT: Zwei Figuren nur zusammenführen wenn ihre Namen klar übereinstimmen (gleicher Vor- und Nachname, oder ein Name ist bestätigter Spitzname/Alias des anderen). Namensähnlichkeit allein reicht nicht – im Zweifel als separate Figuren behalten. Figuren ohne oder mit wenig Informationen NICHT mit anderen zusammenführen.`;

export function buildFiguresSinglePassPrompt(bookName, pageCount, bookText) {
  return `Analysiere das Buch «${bookName}» und extrahiere alle wichtigen Figuren.

Antworte mit diesem JSON-Schema:
${FIGUREN_SCHEMA}

${FIGUREN_RULES}

Buchtext (${pageCount} Seiten):

${bookText}`;
}

export function buildFiguresConsolidationPrompt(bookName, chapterFiguren) {
  const synthInput = chapterFiguren.map(cf =>
    `## Kapitel: ${cf.kapitel}\n` + cf.figuren.map(f => {
      const meta = [f.typ, f.beruf, f.geburtstag ? `*${f.geburtstag}` : '', f.geschlecht].filter(Boolean).join(', ');
      return `- ${f.name}${f.kurzname && f.kurzname !== f.name ? ` («${f.kurzname}»)` : ''} (${meta}): ${f.beschreibung || ''}` +
        (f.eigenschaften?.length ? '\n  Eigenschaften: ' + f.eigenschaften.join(', ') : '') +
        (f.beziehungen?.length ? '\n  Beziehungen: ' + f.beziehungen.map(b => `${b.name} [${b.typ}]`).join(', ') : '') +
        (f.lebensereignisse?.length ? '\n  Lebensereignisse:\n' + f.lebensereignisse.map(e =>
          `    - datum: ${e.datum || ''}, typ: ${e.typ || 'persoenlich'}, ereignis: ${e.ereignis || ''}` +
          (e.bedeutung ? `, bedeutung: ${e.bedeutung}` : '') +
          (e.kapitel ? `, kapitel: ${e.kapitel}` : '')
        ).join('\n') : '');
    }).join('\n')
  ).join('\n\n');
  return `Konsolidiere die folgenden Figurenanalysen aller Kapitel des Buchs «${bookName}» zu einer einheitlichen Gesamtliste. Dedupliziere Figuren, führe Informationen zusammen und vergib stabile IDs.

Kapitelanalysen:

${synthInput}

${JSON_ONLY}

Antworte mit diesem JSON-Schema:
${FIGUREN_SCHEMA}

${FIGUREN_RULES}`;
}

// ── Figurenextraktion (Basis – ohne Lebensereignisse) ─────────────────────────

const FIGUREN_BASIS_SCHEMA = `{
  "figuren": [
    {
      "id": "fig_1",
      "name": "Vollständiger Name",
      "kurzname": "Vorname oder Spitzname",
      "typ": "hauptfigur|nebenfigur|antagonist|mentor|andere",
      "geburtstag": "JJJJ oder leer wenn unbekannt",
      "geschlecht": "männlich|weiblich|divers|unbekannt",
      "beruf": "Beruf oder Rolle oder leer",
      "beschreibung": "2-3 Sätze zu Rolle, Persönlichkeit und Bedeutung",
      "eigenschaften": ["Eigenschaft1", "Eigenschaft2"],
      "kapitel": [{ "name": "Kapitelname", "haeufigkeit": 3 }],
      "beziehungen": [{ "figur_id": "fig_2", "typ": "elternteil|geschwister|kind|freund|feind|kollege|bekannt|liebesbeziehung|rivale|mentor|schuetzling|andere", "beschreibung": "1 Satz" }]
    }
  ]
}`;

const FIGUREN_BASIS_RULES = `Regeln:
- Eindeutige IDs (fig_1, fig_2, …)
- beziehungen.figur_id: nur IDs aus dieser Liste; jede Beziehung nur einmal eintragen
- kapitel: absteigend nach Häufigkeit; haeufigkeit = Anzahl Seiten/Abschnitte mit aktivem Auftreten; name = immer der Kapitelname (aus dem Prompt-Kontext oder dem [Kapitelname]-Teil der Überschrift) – NIEMALS Seitentitel als Kapitelnamen verwenden
- Beziehungstypen: elternteil/kind (gerichtet), geschwister (undirektional), übrige selbsterklärend
- Nur fiktive Charaktere oder Figuren die aktiv an der Buchhandlung teilnehmen – keine Orte oder Objekte
- KEINE historischen oder realen Personen die nur erwähnt, zitiert oder als Referenz genannt werden (z.B. Napoleon, Einstein, ein Politiker, eine Künstlerin)
- Sortiert nach Wichtigkeit
- KONSERVATIV: Nur Figuren und Beziehungen aufnehmen die im Text eindeutig belegt sind. Lieber weglassen als spekulieren.
- DEDUPLIZIERUNG NUR BEI EINDEUTIGER NAMENSGLEICHHEIT: Zwei Figuren nur zusammenführen wenn ihre Namen klar übereinstimmen (gleicher Vor- und Nachname, oder ein Name ist bestätigter Spitzname/Alias des anderen). Namensähnlichkeit allein reicht nicht – im Zweifel als separate Figuren behalten. Figuren ohne oder mit wenig Informationen NICHT mit anderen zusammenführen.`;

export function buildFiguresBasisSinglePassPrompt(bookName, pageCount, bookText) {
  return `Analysiere das Buch «${bookName}» und extrahiere alle wichtigen Figuren.

Antworte mit diesem JSON-Schema:
${FIGUREN_BASIS_SCHEMA}

${FIGUREN_BASIS_RULES}

${JSON_ONLY}

Buchtext (${pageCount} Seiten):

${bookText}`;
}

export function buildFiguresBasisChapterPrompt(chapterName, bookName, pageCount, chText) {
  return `Extrahiere alle Figuren aus dem Kapitel «${chapterName}» des Buchs «${bookName}».

Antworte mit diesem JSON-Schema:
${FIGUREN_BASIS_SCHEMA}

${FIGUREN_BASIS_RULES}

Wichtig: Für kapitel[].name aller Figuren in diesem Kapitel immer genau «${chapterName}» verwenden – die ### Überschriften im Text sind Seitentitel, keine Kapitelnamen.

${JSON_ONLY}

Kapiteltext (${pageCount} Seiten):

${chText}`;
}

export function buildFiguresBasisConsolidationPrompt(bookName, chapterFiguren) {
  const synthInput = chapterFiguren.map(cf =>
    `## Kapitel: ${cf.kapitel}\n` + (cf.figuren || []).map(f => {
      const meta = [f.typ, f.beruf, f.geburtstag ? `*${f.geburtstag}` : '', f.geschlecht].filter(Boolean).join(', ');
      return `- ${f.name}${f.kurzname && f.kurzname !== f.name ? ` («${f.kurzname}»)` : ''} (${meta}): ${f.beschreibung || ''}` +
        (f.eigenschaften?.length ? '\n  Eigenschaften: ' + f.eigenschaften.join(', ') : '') +
        (f.beziehungen?.length ? '\n  Beziehungen: ' + f.beziehungen.map(b => `${b.figur_id || b.name} [${b.typ}]`).join(', ') : '');
    }).join('\n')
  ).join('\n\n');
  return `Konsolidiere die folgenden Figurenanalysen aller Kapitel des Buchs «${bookName}» zu einer einheitlichen Gesamtliste. Dedupliziere Figuren, führe Informationen zusammen und vergib stabile IDs.

Kapitelanalysen:

${synthInput}

${JSON_ONLY}

Antworte mit diesem JSON-Schema:
${FIGUREN_BASIS_SCHEMA}

${FIGUREN_BASIS_RULES}`;
}

// ── Lebensereignisse-Zuordnung ────────────────────────────────────────────────

export function buildFiguresEventAssignmentPrompt(chapterName, bookName, pageCount, figurenList, chText) {
  const figurenStr = figurenList.map(f => `${f.id}: ${f.name} (${f.typ || 'andere'})`).join('\n');
  return `Durchforste den Kapiteltext «${chapterName}» des Buchs «${bookName}» systematisch nach Ereignissen – persönliche Wendepunkte UND externe Ereignisse – und verknüpfe sie mit den betroffenen Figuren.

Bekannte Figuren (nur diese IDs in «fig_id» verwenden):
${figurenStr}

Antworte mit diesem JSON-Schema:
{
  "assignments": [
    {
      "fig_id": "fig_1",
      "lebensereignisse": [
        {
          "datum": "JJJJ (nur Jahreszahl; aus Kontext errechnen wenn nötig – Geburtsjahr + Altersangabe, bekannte historische Jahreszahl; leer lassen wenn nicht errechenbar)",
          "ereignis": "Was passierte (1 Satz)",
          "typ": "persoenlich|extern",
          "bedeutung": "Bedeutung für die Figur (1 Satz, leer wenn nicht klar)",
          "kapitel": "${chapterName}",
          "seite": "Name der Seite/des Abschnitts (aus ### Überschrift; leer wenn unklar)"
        }
      ]
    }
  ]
}

Regeln:
- typ='persoenlich': echte biografische Wendepunkte (Geburt, Tod, Trauma, neue/beendete Beziehung, Jobwechsel, Umzug, wichtige Entscheidung) – nur aufnehmen wenn tatsächlich im Text belegt
- typ='extern': gesellschaftliche/historische Ereignisse – SEHR GROSSZÜGIG erfassen:
  • Kriege, Konflikte, Terroranschläge, Attentate, Amokläufe
  • Politische Umbrüche (Mauerfall, Revolutionen, Regierungswechsel, gesellschaftliche Umwälzungen)
  • Sport- und Kulturereignisse (WM, Olympia, Großveranstaltungen)
  • Wirtschaftskrisen, Seuchen, Naturkatastrophen, Umweltereignisse
  • Auch wenn nur kurz erwähnt, nur angedeutet oder nur indirekt auf Figuren wirkt
  • Jedes externe Ereignis ALLEN Figuren zuweisen die dabei waren, davon betroffen waren oder im Zusammenhang erwähnt werden
- datum: immer als vierstellige Jahreszahl (JJJJ) – falls nicht direkt erwähnt, aus Kontext errechnen (Geburtsjahr + Alter, bekannte historische Jahreszahl); Events ohne errechenbare Jahreszahl weglassen
- Nur Figuren ausgeben die mindestens ein Ereignis haben; leeres assignments-Array wenn keine Ereignisse gefunden
- Nur fig_id-Werte aus der obigen Liste verwenden
- Chronologisch sortiert nach Datum innerhalb jeder Figur

${JSON_ONLY}

Kapiteltext (${pageCount} Seiten):

${chText}`;
}

export function buildSzenenAnalysePrompt(kapitel, figurenKompakt, chText) {
  const figurenStr = figurenKompakt.length
    ? figurenKompakt.map(f => `${f.id}: ${f.name} (${f.typ})`).join('\n')
    : '(keine Figuren bekannt)';
  return `Analysiere die Szenen im Kapitel «${kapitel}».

Bekannte Figuren (nur diese IDs in «figuren» verwenden):
${figurenStr}

Antworte mit diesem JSON-Schema:
{
  "szenen": [
    {
      "seite": "Name der Seite/des Abschnitts aus dem die Szene stammt (leer wenn unklar)",
      "titel": "Kurze Szenenbezeichnung (1 Satz)",
      "wertung": "stark|mittel|schwach",
      "kommentar": "1-2 Sätze: was funktioniert, was fehlt (Spannung, Tempo, Figurenentwicklung)",
      "figuren": ["fig_1", "fig_2"]
    }
  ]
}

Regeln:
- Eine Szene ist ein abgegrenzter Handlungsabschnitt mit eigenem Anfang und Ende
- figuren: nur IDs aus der obigen Liste; leer lassen wenn keine bekannte Figur aktiv beteiligt ist
- wertung: «stark» = spannend/überzeugend, «mittel» = verbesserungswürdig, «schwach» = klare Schwächen
- Wenn ein Abschnitt keine erkennbaren Szenen enthält (reine Exposition, Beschreibung): «szenen» als leeres Array
- Jede erkennbare Szene erfassen; konservativ – lieber weniger, aber treffende Einträge

${JSON_ONLY}

Kapiteltext:
${chText}`;
}

export function buildZeitstrahlConsolidationPrompt(events) {
  return `Du erhältst eine Liste von Lebensereignissen verschiedener Figuren aus einem Buch. Erkenne semantisch identische oder sehr ähnliche Ereignisse (gleicher realer Vorfall, nur unterschiedlich formuliert) und fasse sie zu einem einzigen Eintrag zusammen. Führe die Figurenlisten zusammen und wähle die präziseste Formulierung.

Ereignisse die sich inhaltlich unterscheiden, bleiben getrennt – auch wenn sie im selben Jahr stattfanden.

Antworte mit diesem JSON-Schema:
{
  "ereignisse": [
    {
      "datum": "JJJJ",
      "ereignis": "kanonische Formulierung",
      "typ": "persoenlich|extern",
      "bedeutung": "zusammengeführte Bedeutung oder leer",
      "kapitel": ["Kapitelname1", "Kapitelname2"],
      "seiten": ["Seite1", "Seite2"],
      "figuren": [{ "id": "fig_1", "name": "Name", "typ": "hauptfigur|nebenfigur|antagonist|mentor|andere" }]
    }
  ]
}

Regeln:
- Behalte die chronologische Reihenfolge (aufsteigend nach Jahreszahl)
- Dedupliziere figuren (gleiche id nur einmal pro Ereignis)
- kapitel: Alle Kapitel der zusammengeführten Ereignisse beibehalten (Union der Arrays, Duplikate entfernen)
- seiten: Alle Seiten der zusammengeführten Ereignisse beibehalten (Union der Arrays, Duplikate entfernen)
- Im Zweifel getrennt lassen – nur eindeutige Übereinstimmungen zusammenführen

${JSON_ONLY}

Ereignisse:
${JSON.stringify(events, null, 2)}`;
}

// ── Chat ──────────────────────────────────────────────────────────────────────

/**
 * Baut den vollständigen System-Prompt für den Seiten-Chat.
 * @param {string}   pageName   Name der Seite
 * @param {string}   pageText   Seiteninhalt als Plaintext
 * @param {Array}    figuren    Figuren-Array aus der DB (kann leer sein)
 * @param {Object}   review     Letzte Buchbewertung aus der DB (kann null sein)
 */
export function buildChatSystemPrompt(pageName, pageText, figuren, review) {
  const parts = [
    SYSTEM_CHAT,
    '',
    `Aktuelle Seite: «${pageName}»`,
    '',
    '=== SEITENINHALT ===',
    pageText,
    '',
  ];

  if (figuren && figuren.length > 0) {
    parts.push('=== FIGUREN DES BUCHS ===');
    parts.push(JSON.stringify(figuren, null, 2));
    parts.push('');
  }

  if (review) {
    parts.push('=== LETZTE BUCHBEWERTUNG ===');
    parts.push(JSON.stringify({
      gesamtnote:  review.gesamtnote,
      fazit:       review.fazit,
      staerken:    review.staerken,
      schwaechen:  review.schwaechen,
    }, null, 2));
    parts.push('');
  }

  parts.push(
    'Antworte immer im folgenden JSON-Format:',
    '{',
    '  "antwort": "Deine Antwort als Freitext (Markdown erlaubt)",',
    '  "vorschlaege": [',
    '    {',
    '      "original": "exakter Originaltext aus der Seite (zeichengenau)",',
    '      "ersatz": "Ersatztext",',
    '      "begruendung": "kurze Begründung"',
    '    }',
    '  ]',
    '}',
    '',
    'vorschlaege ist ein leeres Array wenn keine konkreten Textänderungen sinnvoll sind.',
    'original muss zeichengenau mit dem Seitentext übereinstimmen.',
    '',
    JSON_ONLY,
  );

  return parts.join('\n');
}

/**
 * Baut den vollständigen System-Prompt für den Buch-Chat (kein Vorschläge-System).
 * @param {string}  bookName       Name des Buchs
 * @param {Array}   relevantPages  Ausgewählte Seiten [{name, text}] (bereits auf Budget gekürzt)
 * @param {Array}   figuren        Figuren-Array aus der DB (kann leer sein)
 * @param {Object}  review         Letzte Buchbewertung aus der DB (kann null sein)
 */
export function buildBookChatSystemPrompt(bookName, relevantPages, figuren, review) {
  const parts = [
    SYSTEM_BOOK_CHAT,
    '',
    `Buch: «${bookName}»`,
    '',
  ];

  if (relevantPages && relevantPages.length > 0) {
    parts.push('=== RELEVANTE BUCHSEITEN ===');
    for (const page of relevantPages) {
      parts.push(`--- Seite: ${page.name} ---`);
      parts.push(page.text);
      parts.push('');
    }
  }

  if (figuren && figuren.length > 0) {
    parts.push('=== FIGUREN DES BUCHS ===');
    parts.push(JSON.stringify(figuren, null, 2));
    parts.push('');
  }

  if (review) {
    parts.push('=== LETZTE BUCHBEWERTUNG ===');
    parts.push(JSON.stringify({
      gesamtnote:  review.gesamtnote,
      fazit:       review.fazit,
      staerken:    review.staerken,
      schwaechen:  review.schwaechen,
    }, null, 2));
    parts.push('');
  }

  parts.push(
    'Antworte immer im folgenden JSON-Format:',
    '{',
    '  "antwort": "Deine Antwort als Freitext (Markdown erlaubt)"',
    '}',
    '',
    JSON_ONLY,
  );

  return parts.join('\n');
}

// ── Schauplatz-Extraktion ─────────────────────────────────────────────────────

const ORTE_SCHEMA = `{
  "orte": [
    {
      "id": "ort_1",
      "name": "Name des Schauplatz",
      "typ": "stadt|gebaeude|raum|landschaft|region|andere",
      "beschreibung": "2-3 Sätze zu Erscheinungsbild, Atmosphäre, Bedeutung für die Handlung",
      "erste_erwaehnung": "Kapitelname oder Seitenname der ersten Erwähnung (leer wenn unklar)",
      "stimmung": "Grundatmosphäre in 2-3 Worten (z.B. bedrohlich, heimelig, verlassen, belebt)",
      "kapitel": [{ "name": "Kapitelname", "haeufigkeit": 3 }],
      "figuren": ["fig_1", "fig_2"]
    }
  ]
}`;

const ORTE_RULES = `Regeln:
- Eindeutige IDs (ort_1, ort_2, …)
- Nur Schauplätze, die im Text eindeutig beschrieben oder mehrfach genannt werden – keine einmaligen, flüchtigen Erwähnungen
- figuren: nur IDs aus der gelieferten Figurenliste (leer lassen wenn keine Figuren bekannt)
- kapitel: absteigend nach Häufigkeit; haeufigkeit = Anzahl Seiten/Abschnitte in denen der Ort aktiv vorkommt
- KONSERVATIV: Lieber weglassen als spekulieren; maximal 20 Orte`;

export function buildLocationsSinglePassPrompt(bookName, pageCount, bookText, figurenKompakt) {
  const figurenStr = figurenKompakt && figurenKompakt.length
    ? '\n\nBekannte Figuren (nur diese IDs in «figuren» verwenden):\n' + figurenKompakt.map(f => `${f.id}: ${f.name}`).join('\n')
    : '';
  return `Analysiere das Buch «${bookName}» und extrahiere alle wichtigen Schauplätze und Orte.${figurenStr}

Antworte mit diesem JSON-Schema:
${ORTE_SCHEMA}

${ORTE_RULES}

${JSON_ONLY}

Buchtext (${pageCount} Seiten):

${bookText}`;
}

export function buildLocationsChapterPrompt(chapterName, bookName, pageCount, chText, figurenKompakt) {
  const figurenStr = figurenKompakt && figurenKompakt.length
    ? '\n\nBekannte Figuren (nur diese IDs in «figuren» verwenden):\n' + figurenKompakt.map(f => `${f.id}: ${f.name}`).join('\n')
    : '';
  return `Extrahiere alle Schauplätze aus dem Kapitel «${chapterName}» des Buchs «${bookName}».${figurenStr}

Antworte mit:
{ "orte": [{ "name": "Name", "typ": "stadt|gebaeude|raum|landschaft|region|andere", "beschreibung": "1-2 Sätze", "erste_erwaehnung": "${chapterName}", "stimmung": "Atmosphäre", "kapitel": [{"name": "${chapterName}", "haeufigkeit": 1}], "figuren": [] }] }

Nur Schauplätze die im Text eindeutig beschrieben sind. Sei konservativ.

${JSON_ONLY}

Kapiteltext (${pageCount} Seiten):

${chText}`;
}

export function buildLocationsConsolidationPrompt(bookName, chapterOrte, figurenKompakt) {
  const synthInput = chapterOrte.map(co =>
    `## Kapitel: ${co.kapitel}\n` + co.orte.map(o =>
      `- ${o.name} (${o.typ || 'andere'}): ${o.beschreibung || ''}` +
      (o.stimmung ? ` | Stimmung: ${o.stimmung}` : '')
    ).join('\n')
  ).join('\n\n');
  const figurenStr = figurenKompakt && figurenKompakt.length
    ? '\n\nBekannte Figuren (nur diese IDs in «figuren» verwenden):\n' + figurenKompakt.map(f => `${f.id}: ${f.name}`).join('\n')
    : '';
  return `Konsolidiere die folgenden Schauplatz-Analysen aller Kapitel des Buchs «${bookName}» zu einer einheitlichen Gesamtliste. Dedupliziere, führe Informationen zusammen und vergib stabile IDs.${figurenStr}

Kapitelanalysen:

${synthInput}

${JSON_ONLY}

Antworte mit diesem JSON-Schema:
${ORTE_SCHEMA}

${ORTE_RULES}`;
}

// ── Kontinuitätsprüfung ───────────────────────────────────────────────────────

export function buildKontinuitaetChapterFactsPrompt(chapterName, chText) {
  return `Extrahiere alle konkreten Fakten und Behauptungen aus dem Kapitel «${chapterName}» die für die Kontinuitätsprüfung relevant sind: Figuren-Zustände (lebendig/tot, Verletzungen, Wissen, Beziehungen), Ortsbeschreibungen, Zeitangaben, Objekte und deren Besitz/Zustand, sowie wichtige Handlungsereignisse.

Antworte mit diesem JSON-Schema:
{
  "fakten": [
    {
      "kategorie": "figur|ort|objekt|zeit|ereignis|sonstiges",
      "subjekt": "Über wen/was geht es (Name oder Bezeichnung)",
      "fakt": "Was genau behauptet wird (1 Satz, so präzise wie möglich)",
      "seite": "Seitenname oder Abschnittsname (leer wenn unklar)"
    }
  ]
}

Regeln:
- Nur konkrete, prüfbare Aussagen – keine Interpretationen
- Figuren-Zustände besonders genau erfassen (Wissen, Können, körperlicher Zustand, Wohnort, Beruf)
- Objekte: Wer besitzt was, wo liegt was, in welchem Zustand
- Zeitangaben: Relative («am nächsten Morgen») und absolute («1943») erfassen
- Maximal 30 Fakten pro Kapitel; lieber weniger, dafür präzise

${JSON_ONLY}

Kapiteltext:

${chText}`;
}

export function buildKontinuitaetCheckPrompt(bookName, chapterFacts, figurenKompakt, orteKompakt) {
  const factsText = chapterFacts.map(cf =>
    `## ${cf.kapitel}\n` + cf.fakten.map(f => `[${f.kategorie}] ${f.subjekt}: ${f.fakt}${f.seite ? ` (${f.seite})` : ''}`).join('\n')
  ).join('\n\n');

  const figurenStr = figurenKompakt && figurenKompakt.length
    ? '\n\n## Bekannte Figuren\n' + figurenKompakt.map(f => `${f.name} (${f.typ}): ${f.beschreibung || ''}`).join('\n')
    : '';
  const orteStr = orteKompakt && orteKompakt.length
    ? '\n\n## Bekannte Schauplätze\n' + orteKompakt.map(o => `${o.name} (${o.typ || 'andere'}): ${o.beschreibung || ''}`).join('\n')
    : '';

  return `Prüfe das Buch «${bookName}» auf Kontinuitätsfehler und Widersprüche. Dir liegen die extrahierten Fakten aller Kapitel vor.${figurenStr}${orteStr}

## Extrahierte Fakten nach Kapitel:

${factsText}

Suche nach Widersprüchen: Fakten, die sich gegenseitig ausschliessen oder nicht vereinbar sind. Beispiele: Figur stirbt in Kapitel 3 aber erscheint in Kapitel 7; Ort wird in Kap. 2 als verlassen beschrieben, in Kap. 5 als belebt; Figur weiss etwas, das sie noch nicht wissen konnte.

Antworte mit diesem JSON-Schema:
{
  "probleme": [
    {
      "schwere": "kritisch|mittel|niedrig",
      "typ": "figur|zeitlinie|ort|objekt|verhalten|sonstiges",
      "beschreibung": "Was genau widerspricht sich (1-2 Sätze)",
      "stelle_a": "Erste Textstelle (Kapitel: Seite oder Abschnitt)",
      "stelle_b": "Zweite Textstelle (Kapitel: Seite oder Abschnitt)",
      "empfehlung": "Wie könnte das aufgelöst werden (1 Satz)"
    }
  ],
  "zusammenfassung": "Gesamteinschätzung der Konsistenz des Buchs in 2-3 Sätzen"
}

Regeln:
- Nur echte Widersprüche – keine stilistischen oder inhaltlichen Anmerkungen
- schwere: «kritisch» = klarer Logikfehler der auffällt; «mittel» = wahrscheinlicher Fehler; «niedrig» = mögliche Inkonsistenz
- Wenn keine Widersprüche gefunden: «probleme» als leeres Array, «zusammenfassung» = positive Einschätzung
- Konservativ: Im Zweifel weglassen

${JSON_ONLY}`;
}

export function buildKontinuitaetSinglePassPrompt(bookName, bookText, figurenKompakt, orteKompakt) {
  const figurenStr = figurenKompakt && figurenKompakt.length
    ? '\n\n## Bekannte Figuren\n' + figurenKompakt.map(f => `${f.name} (${f.typ || ''}): ${f.beschreibung || ''}`).join('\n')
    : '';
  const orteStr = orteKompakt && orteKompakt.length
    ? '\n\n## Bekannte Schauplätze\n' + orteKompakt.map(o => `${o.name} (${o.typ || 'andere'}): ${o.beschreibung || ''}`).join('\n')
    : '';

  return `Prüfe das Buch «${bookName}» auf Kontinuitätsfehler und Widersprüche.${figurenStr}${orteStr}

Suche aktiv nach: Figuren die nach ihrem Tod wieder auftauchen; Orte die sich widersprüchlich beschrieben werden; Zeitangaben die nicht vereinbar sind; Objekte die falsch verwendet werden; Figuren die Wissen haben das sie noch nicht haben könnten; Charakterverhalten das ihrer etablierten Persönlichkeit widerspricht.

Buchtext:

${bookText}

Antworte mit diesem JSON-Schema:
{
  "probleme": [
    {
      "schwere": "kritisch|mittel|niedrig",
      "typ": "figur|zeitlinie|ort|objekt|verhalten|sonstiges",
      "beschreibung": "Was genau widerspricht sich (1-2 Sätze)",
      "stelle_a": "Erste Textstelle (Kapitel: Seite oder Abschnitt)",
      "stelle_b": "Zweite Textstelle (Kapitel: Seite oder Abschnitt)",
      "empfehlung": "Wie könnte das aufgelöst werden (1 Satz)"
    }
  ],
  "zusammenfassung": "Gesamteinschätzung der Konsistenz des Buchs in 2-3 Sätzen"
}

Regeln:
- Nur echte Widersprüche
- schwere: «kritisch» = klarer Logikfehler; «mittel» = wahrscheinlicher Fehler; «niedrig» = mögliche Inkonsistenz
- Wenn keine Widersprüche: «probleme» als leeres Array
- Konservativ: Im Zweifel weglassen

${JSON_ONLY}`;
}

export function buildLektoratPrompt(text, html) {
  return `Analysiere diesen deutschsprachigen Text auf Rechtschreibfehler, Grammatikfehler, stilistische Auffälligkeiten und auffällige Wortwiederholungen. Bewerte ausserdem die Szenen der Seite.

WICHTIG: Jede einzelne Beanstandung erhält einen eigenen Eintrag im «fehler»-Array. Wenn an einer Stelle mehrere unabhängige Probleme vorliegen (z.B. ein Gallizismus und separate Anführungszeichen-Problematik), müssen diese als separate Einträge erscheinen – niemals in einer gemeinsamen «erklaerung» zusammenfassen.

Antworte mit diesem JSON-Schema:
{
  "fehler": [
    {
      "typ": "rechtschreibung|grammatik|stil|wiederholung",
      "original": "das fehlerhafte Wort oder die fehlerhafte Phrase – bei «wiederholung»: vollständiger Satz zeichengenau aus dem Text",
      "korrektur": "die korrekte Version – bei «wiederholung»: derselbe Satz mit Synonym",
      "kontext": "der Satz in dem der Fehler vorkommt (bei «wiederholung» gleich wie «original»)",
      "erklaerung": "kurze Erklärung auf Deutsch (nur diesen einen Mangel beschreiben) ${ERKLAERUNG_RULE}"
    }
  ],
  "korrekturen_html": "vollständiges korrigiertes HTML – behalte ALLE Tags exakt bei, ändere nur fehlerhafte Textstellen",
  "szenen": [
    {
      "titel": "Kurze Szenenbezeichnung (1 Satz)",
      "wertung": "stark|mittel|schwach",
      "kommentar": "1-2 Sätze: was funktioniert, was fehlt (Spannung, Tempo, Figurenentwicklung)"
    }
  ],
  "stilanalyse": "2-3 Sätze Stilanalyse",
  "fazit": "ein Satz Gesamtfazit"
}

Szenen-Regeln:
- Eine Szene ist ein abgegrenzter Handlungsabschnitt mit eigenem Anfang und Ende
- Wenn die Seite keine erkennbaren Szenen enthält (z.B. rein beschreibender Text, Exposition): «szenen» als leeres Array zurückgeben
- wertung: «stark» = funktioniert gut, «mittel» = verbesserungswürdig, «schwach» = klare Schwächen
${_buildWiederholungBlock()}

Originaltext:
${text}

Original-HTML (für korrekturen_html):
${html}`;
}
