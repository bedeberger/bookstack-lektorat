export const CLAUDE_API = '/claude';

// Superregeln – gelten für alle Prompts
const BASE_RULES = `\
SCHWEIZER KONTEXT – STRIKTE REGEL: Im Schweizer Schriftdeutsch wird kein ß verwendet. Deshalb sind alle ss-Schreibungen, die im Deutschen ß wären, korrekte Helvetismen: zerreisst, heisst, weiss, ausserdem, Strasse, gemäss, grösser usw. Diese Wörter sind KEIN FEHLER und dürfen NICHT ins «fehler»-Array. Auch «zerreisst» als Verbform von «zerreissen» ist korrekt. \
Der Gedankenstrich (–) ist korrekte Schreibweise – NICHT ins «fehler»-Array. Der Bindestrich (-) als Ersatz für den Gedankenstrich ist ebenfalls kein Fehler – NICHT ins «fehler»-Array. \
Anführungszeichen-Regel: Die Wahl der Anführungszeichen («», „", "", '') ist kein Fehler und kein Stilproblem – NICHT ins «fehler»-Array, egal welche Variante verwendet wird. \
GRUNDREGEL FÜR DAS «fehler»-ARRAY: Ein Eintrag kommt nur rein, wenn er eindeutig, zweifelsfrei und ohne Einschränkung falsch ist. Enthält die Erklärung Formulierungen wie «im Schweizer Kontext akzeptabel», «kein Fehler», «vertretbar», «könnte», «möglicherweise» – dann darf der Eintrag NICHT im Array stehen. Vor jedem Eintrag: Selbsttest – «Ist das im Schweizer Kontext wirklich falsch?» Wenn nein oder unsicher: weglassen. \
Antworte ausschliesslich mit einem JSON-Objekt – kein Markdown, kein Text davor oder danach.`;

export const SYSTEM_LEKTORAT = `Du bist ein deutschsprachiger Lektor für literarische Texte aus der Schweiz. ${BASE_RULES}`;

export const SYSTEM_BUCHBEWERTUNG = `Du bist ein erfahrener Literaturkritiker und Lektor für deutschsprachige Texte aus der Schweiz. ${BASE_RULES}`;

export const SYSTEM_KAPITELANALYSE = `Du bist ein erfahrener Literaturkritiker und Lektor für deutschsprachige Texte aus der Schweiz. ${BASE_RULES}`;

export const SYSTEM_FIGUREN = `Du bist ein Literaturanalytiker für deutschsprachige Texte aus der Schweiz. ${BASE_RULES}`;

export const SYSTEM_STILKORREKTUR = `Du bist ein deutschsprachiger Lektor für literarische Texte aus der Schweiz. ${BASE_RULES}`;

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

// Batch-Variante ohne korrekturen_html (spart Output-Tokens, für Server-Side-Jobs)
export function buildBatchLektoratPrompt(text) {
  return `Analysiere diesen deutschsprachigen Text auf Rechtschreibfehler, Grammatikfehler und stilistische Auffälligkeiten.

WICHTIG: Jede einzelne Beanstandung erhält einen eigenen Eintrag im «fehler»-Array. Wenn an einer Stelle mehrere unabhängige Probleme vorliegen, müssen diese als separate Einträge erscheinen – niemals in einer gemeinsamen «erklaerung» zusammenfassen.

Antworte mit diesem JSON-Schema:
{
  "fehler": [
    {
      "typ": "rechtschreibung|grammatik|stil",
      "original": "das fehlerhafte Wort oder die fehlerhafte Phrase (genau eine Beanstandung pro Eintrag)",
      "korrektur": "die korrekte Version",
      "kontext": "der Satz in dem der Fehler vorkommt (gekürzt)",
      "erklaerung": "kurze Erklärung auf Deutsch (nur diesen einen Mangel beschreiben)"
    }
  ],
  "stilanalyse": "2-3 Sätze Stilanalyse",
  "fazit": "ein Satz Gesamtfazit"
}

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

Buchinhalt (${pageCount} Seiten):

${bookText}`;
}

export function buildChapterAnalysisPrompt(chapterName, bookName, pageCount, chText) {
  return `Analysiere das Kapitel «${chapterName}» aus dem Buch «${bookName}».
Lies den vollständigen Kapiteltext und gib eine kompakte Analyse als JSON zurück:
{
  "themen": "Hauptthemen und Inhalte in 2-3 Sätzen",
  "stil": "Schreibstilbeobachtungen: Wortwahl, Satzbau, Ton in 2 Sätzen",
  "qualitaet": "Allgemeiner Qualitätseindruck in 1-2 Sätzen",
  "staerken": ["konkrete Stärke 1", "konkrete Stärke 2"],
  "schwaechen": ["konkrete Schwäche 1", "konkrete Schwäche 2"]
}

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

Antworte mit diesem JSON-Schema:
{
  "gesamtnote": "Zahl von 1 (sehr schwach) bis 5 (ausgezeichnet)",
  "gesamtnote_begruendung": "Ein Satz warum diese Note",
  "zusammenfassung": "2-3 Sätze Gesamteindruck",
  "struktur": "Analyse des Aufbaus und der Struktur über alle Kapitel (3-4 Sätze)",
  "stil": "Analyse des Schreibstils und seiner Konsistenz über das gesamte Buch (3-4 Sätze)",
  "staerken": ["Stärke 1", "Stärke 2", "Stärke 3"],
  "schwaechen": ["Schwäche 1", "Schwäche 2"],
  "empfehlungen": ["Empfehlung 1", "Empfehlung 2", "Empfehlung 3"],
  "fazit": "Abschliessendes Urteil in 1-2 Sätzen"
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
      "kapitel": [{ "name": "Kapitelname", "haeufigkeit": 3 }],
      "beziehungen": [{ "figur_id": "fig_2", "typ": "elternteil|geschwister|kind|freund|feind|kollege|bekannt|liebesbeziehung|rivale|mentor|schuetzling|andere", "beschreibung": "1 Satz" }]
    }
  ]
}`;

const FIGUREN_RULES = `Regeln:
- Eindeutige IDs (fig_1, fig_2, …)
- beziehungen.figur_id: nur IDs aus dieser Liste; jede Beziehung nur einmal eintragen
- kapitel: absteigend nach Häufigkeit; haeufigkeit = Anzahl Seiten/Abschnitte mit aktivem Auftreten
- Beziehungstypen: elternteil/kind (gerichtet), geschwister (undirektional), übrige selbsterklärend
- Nur echte Personen/Charaktere, keine Orte oder Objekte
- Sortiert nach Wichtigkeit; maximal 20 Figuren
- KONSERVATIV: Nur Figuren und Beziehungen aufnehmen die im Text eindeutig belegt sind. Lieber weglassen als spekulieren.`;

export function buildFiguresSinglePassPrompt(bookName, pageCount, bookText) {
  return `Analysiere das Buch «${bookName}» und extrahiere alle wichtigen Figuren.

Antworte mit diesem JSON-Schema:
${FIGUREN_SCHEMA}

${FIGUREN_RULES}

Buchtext (${pageCount} Seiten):

${bookText}`;
}

export function buildFiguresChapterPrompt(chapterName, bookName, pageCount, chText) {
  return `Extrahiere alle Figuren/Charaktere aus dem Kapitel «${chapterName}» des Buchs «${bookName}».
Antworte mit:
{
  "figuren": [
    { "name": "Vollständiger Name", "kurzname": "...", "typ": "hauptfigur|nebenfigur|antagonist|mentor|andere", "beruf": "...", "geburtstag": "JJJJ oder leer", "geschlecht": "männlich|weiblich|divers|unbekannt", "beschreibung": "1-2 Sätze", "eigenschaften": ["..."], "beziehungen": [{ "name": "Name der anderen Figur", "typ": "elternteil|geschwister|kind|freund|feind|kollege|bekannt|liebesbeziehung|rivale|mentor|schuetzling|andere", "beschreibung": "1 Satz" }] }
  ]
}

Nur echte Personen. Sei konservativ: nur Figuren und Beziehungen die im Text eindeutig belegt sind.

Kapiteltext (${pageCount} Seiten):

${chText}`;
}

export function buildFiguresConsolidationPrompt(bookName, chapterFiguren) {
  const synthInput = chapterFiguren.map(cf =>
    `## Kapitel: ${cf.kapitel}\n` + cf.figuren.map(f =>
      `- ${f.name} (${f.typ})${f.beruf ? ', ' + f.beruf : ''}: ${f.beschreibung || ''}` +
      (f.beziehungen?.length ? '\n  Beziehungen: ' + f.beziehungen.map(b => `${b.name} [${b.typ}]`).join(', ') : '')
    ).join('\n')
  ).join('\n\n');
  return `Konsolidiere die folgenden Figurenanalysen aller Kapitel des Buchs «${bookName}» zu einer einheitlichen Gesamtliste. Dedupliziere Figuren, führe Informationen zusammen und vergib stabile IDs.

Kapitelanalysen:

${synthInput}

Antworte mit diesem JSON-Schema:
${FIGUREN_SCHEMA}

${FIGUREN_RULES}`;
}

export function buildLektoratPrompt(text, html) {
  return `Analysiere diesen deutschsprachigen Text auf Rechtschreibfehler, Grammatikfehler und stilistische Auffälligkeiten.

WICHTIG: Jede einzelne Beanstandung erhält einen eigenen Eintrag im «fehler»-Array. Wenn an einer Stelle mehrere unabhängige Probleme vorliegen (z.B. ein Gallizismus und separate Anführungszeichen-Problematik), müssen diese als separate Einträge erscheinen – niemals in einer gemeinsamen «erklaerung» zusammenfassen.

Antworte mit diesem JSON-Schema:
{
  "fehler": [
    {
      "typ": "rechtschreibung|grammatik|stil",
      "original": "das fehlerhafte Wort oder die fehlerhafte Phrase (genau eine Beanstandung pro Eintrag)",
      "korrektur": "die korrekte Version",
      "kontext": "der Satz in dem der Fehler vorkommt (gekürzt)",
      "erklaerung": "kurze Erklärung auf Deutsch (nur diesen einen Mangel beschreiben)"
    }
  ],
  "korrekturen_html": "vollständiges korrigiertes HTML – behalte ALLE Tags exakt bei, ändere nur fehlerhafte Textstellen",
  "stilanalyse": "2-3 Sätze Stilanalyse",
  "fazit": "ein Satz Gesamtfazit"
}

Originaltext:
${text}

Original-HTML (für korrekturen_html):
${html}`;
}
