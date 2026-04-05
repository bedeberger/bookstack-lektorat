export const CLAUDE_API = '/claude';

// Unveränderliche technische Pflicht-Anweisung – darf nicht konfiguriert werden,
// da callAI() immer ein JSON-Objekt erwartet.
const JSON_ONLY = 'Antworte ausschliesslich mit einem JSON-Objekt – kein Markdown, kein Text davor oder danach. Beginne deine Antwort direkt mit { und beende sie mit }.';

// Standard-Werte (werden durch configurePrompts() überschrieben)
const DEFAULT_BASE_RULES = `\
SCHWEIZER KONTEXT – STRIKTE REGEL: Im Schweizer Schriftdeutsch wird kein ß verwendet. Deshalb sind alle ss-Schreibungen, die im Deutschen ß wären, korrekte Helvetismen: zerreisst, heisst, weiss, ausserdem, Strasse, gemäss, grösser usw. Diese Wörter sind KEIN FEHLER und dürfen NICHT ins «fehler»-Array. Auch «zerreisst» als Verbform von «zerreissen» ist korrekt. \
Der Gedankenstrich (–) ist korrekte Schreibweise – NICHT ins «fehler»-Array. Der Bindestrich (-) als Ersatz für den Gedankenstrich ist ebenfalls kein Fehler – NICHT ins «fehler»-Array. \
Anführungszeichen-Regel: Die Wahl der Anführungszeichen («», „", "", '') ist kein Fehler und kein Stilproblem – NICHT ins «fehler»-Array, egal welche Variante verwendet wird. \
GRUNDREGEL FÜR DAS «fehler»-ARRAY: Ein Eintrag kommt nur rein, wenn er eindeutig, zweifelsfrei und ohne Einschränkung falsch ist. Enthält die Erklärung Formulierungen wie «im Schweizer Kontext akzeptabel», «kein Fehler», «vertretbar», «könnte», «möglicherweise» – dann darf der Eintrag NICHT im Array stehen. Vor jedem Eintrag: Selbsttest – «Ist das im Schweizer Kontext wirklich falsch?» Wenn nein oder unsicher: weglassen.`;

const DEFAULT_PREFIXES = {
  lektorat:       'Du bist ein deutschsprachiger Lektor für literarische Texte aus der Schweiz.',
  buchbewertung:  'Du bist ein erfahrener Literaturkritiker und Lektor für deutschsprachige Texte aus der Schweiz.',
  kapitelanalyse: 'Du bist ein erfahrener Literaturkritiker und Lektor für deutschsprachige Texte aus der Schweiz.',
  figuren:        'Du bist ein Literaturanalytiker für deutschsprachige Texte aus der Schweiz.',
  stilkorrektur:  'Du bist ein deutschsprachiger Lektor für literarische Texte aus der Schweiz.',
  chat:           'Du bist ein intelligenter literarischer Assistent für deutschsprachige Texte aus der Schweiz. Du hilfst dem Autor mit Fragen zu einer spezifischen Buchseite, gibst Feedback zu Inhalt und Stil, und kannst konkrete Textänderungen vorschlagen.',
};

function buildSystem(prefix, rules) {
  return `${prefix}\n\n${rules}\n\n${JSON_ONLY}`;
}

const DEFAULT_ERKLAERUNG_RULE = `– ACHTUNG: Falls diese Erklärung Formulierungen enthält wie 'kein Fehler', 'korrekt', 'vertretbar', 'möglicherweise', 'im Schweizer Kontext akzeptabel' o.Ä., darf der Eintrag NICHT im Array stehen.`;

// Live-Exports – werden durch configurePrompts() aktualisiert.
// Alle importierenden Module erhalten via ESM-Live-Binding immer den aktuellen Wert.
export let ERKLAERUNG_RULE      = DEFAULT_ERKLAERUNG_RULE;
export let SYSTEM_LEKTORAT      = buildSystem(DEFAULT_PREFIXES.lektorat,       DEFAULT_BASE_RULES);
export let SYSTEM_BUCHBEWERTUNG = buildSystem(DEFAULT_PREFIXES.buchbewertung,  DEFAULT_BASE_RULES);
export let SYSTEM_KAPITELANALYSE= buildSystem(DEFAULT_PREFIXES.kapitelanalyse, DEFAULT_BASE_RULES);
export let SYSTEM_FIGUREN       = buildSystem(DEFAULT_PREFIXES.figuren,        DEFAULT_BASE_RULES);
export let SYSTEM_STILKORREKTUR = buildSystem(DEFAULT_PREFIXES.stilkorrektur,  DEFAULT_BASE_RULES);
export let SYSTEM_CHAT          = DEFAULT_PREFIXES.chat; // Kein buildSystem – Chat hat eigenes JSON-Schema

/**
 * Überschreibt die konfigurierbaren Teile aller System-Prompts.
 * Wird einmalig beim App-Start aus dem /config-Endpunkt befüllt.
 * @param {Object} cfg  promptConfig-Objekt aus /config  (kann null/undefined sein → No-op)
 */
export function configurePrompts(cfg) {
  if (!cfg) return;
  const rules   = cfg.baseRules || DEFAULT_BASE_RULES;
  const sp      = cfg.systemPrompts || {};
  ERKLAERUNG_RULE = cfg.erklaerungRule || DEFAULT_ERKLAERUNG_RULE;
  SYSTEM_LEKTORAT       = buildSystem(sp.lektorat       || DEFAULT_PREFIXES.lektorat,       rules);
  SYSTEM_BUCHBEWERTUNG  = buildSystem(sp.buchbewertung  || DEFAULT_PREFIXES.buchbewertung,  rules);
  SYSTEM_KAPITELANALYSE = buildSystem(sp.kapitelanalyse || DEFAULT_PREFIXES.kapitelanalyse, rules);
  SYSTEM_FIGUREN        = buildSystem(sp.figuren        || DEFAULT_PREFIXES.figuren,        rules);
  SYSTEM_STILKORREKTUR  = buildSystem(sp.stilkorrektur  || DEFAULT_PREFIXES.stilkorrektur,  rules);
  SYSTEM_CHAT           = sp.chat || DEFAULT_PREFIXES.chat;
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
      "erklaerung": "kurze Erklärung auf Deutsch (nur diesen einen Mangel beschreiben) ${ERKLAERUNG_RULE}"
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

${JSON_ONLY}

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

${JSON_ONLY}

Antworte mit diesem JSON-Schema:
${FIGUREN_SCHEMA}

${FIGUREN_RULES}`;
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
      "erklaerung": "kurze Erklärung auf Deutsch (nur diesen einen Mangel beschreiben) ${ERKLAERUNG_RULE}"
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
