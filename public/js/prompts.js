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
export let SYSTEM_SYNONYME      = null;

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
  SYSTEM_SYNONYME       = buildSystem(sp.synonyme       || '', rules);
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

// ── Synonymanalyse ────────────────────────────────────────────────────────────

export function buildSynonymPrompt(text) {
  const stopwordsBlock = STOPWORDS.length > 0
    ? `\nSTOPWÖRTER – ABSOLUTE AUSSCHLUSSLISTE (Pflicht-Prüfung vor jedem Eintrag):\nDiese Wörter dürfen unter keinen Umständen im «woerter»-Array erscheinen, egal wie oft sie im Text vorkommen. Prüfe auch Großschreibung und flektierte Formen – ist der Wortstamm auf der Liste, gehört das Wort nicht ins Ergebnis:\n${STOPWORDS.join(', ')}\nSelbsttest (MUSS für jeden Eintrag durchgeführt werden): «Ist dieses Wort oder sein Stamm auf der Ausschlussliste?» – Wenn ja oder unsicher: weglassen und das nächste Wort prüfen.\n`
    : '';
  return `Analysiere diesen deutschsprachigen Prosatext und identifiziere Wörter oder kurze Phrasen, die stilistisch störend oft wiederholt werden.
${stopwordsBlock}
Kriterien:
- Mindestens 3 Vorkommen im Text ODER mindestens 2 Vorkommen in enger Nähe (innerhalb von 5 Sätzen)
- Zähle LEMMA-basiert: flektierte Formen desselben Worts zählen zusammen. «lief», «läuft», «gelaufen» → alle zählen für das Lemma «laufen». Im «wort»-Feld die häufigste oder auffälligste Form im Text eintragen.
- Nur stilistisch ersetzbare Inhaltswörter – keine Pronomen, keine Hilfsverben, keine Artikel, keine Konjunktionen, keine Präpositionen, keine Eigennamen, keine grammatisch erzwungenen Formen, keine inhaltlich unvermeidlichen Begriffe
- Sortiere nach Dringlichkeit (auffälligste Wiederholungen zuerst)
- Maximal 8 Wörter; pro Wort maximal 6 Vorkommen
- Wenn keine geeigneten Wörter gefunden werden: «woerter» als leeres Array zurückgeben

Für jedes Wort: Liste jede Textstelle einzeln auf. Gib den vollständigen Satz als Passage an (zeichengenau wie im Text). Schlage pro Stelle 2–4 Synonyme vor.

WICHTIG – Kontext-Selbsttest pro Vorkommen: Bevor du ein Synonym einträgst, setze es gedanklich in den genauen Satz ein. Klingt der Satz danach natürliches Deutsch? Bleibt die Bedeutung exakt erhalten? Nur dann eintragen. Wenn kein Synonym diesen Test besteht: das Vorkommen weglassen (nicht ins vorkommen-Array aufnehmen).

WICHTIG – Grammatische Form: Die Synonyme müssen exakt dieselbe Konjugation (bei Verben) bzw. Deklination (bei Nomen/Adjektiven) wie das Originalwort haben. Beispiel: steht im Text «sah» (Präteritum, 3. Person Singular), muss das Synonym ebenfalls im Präteritum stehen («erblickte», nicht «erblicken»).

WICHTIG – Semantische Funktion: Das Verb «sein» hat viele verschiedene Verwendungen, die unterschiedliche Alternativen erfordern:
- Adjektivprädikat («war unberührt», «ist entzaubert») → «blieb», «zeigte sich», «wirkte», «galt als» (NICHT «verlief», «befindet sich», «gestaltete sich»)
- Gleichsetzungsnominativ («waren eine behütete Zeit», «waren eine andere Schweiz») → «galten als», «stellten … dar», «wirkten wie» (NICHT «verliefen», «existierten»)
- Zeitangabe / Zustandsaussage («das war noch vor …», «war unberührt») → je nach Kontext «lag», «stammte», «befand sich» oder Adjektivalternative
Generische Füllalternativen wie «existierte», «verlief», «gestaltete sich» nur verwenden, wenn sie im konkreten Satz tatsächlich funktionieren.

WICHTIG – Passage: muss eine zeichengenaue Kopie des Satzes aus dem Text sein – kein Kürzen, kein Umformulieren.

Antworte mit diesem JSON-Schema:
{
  "woerter": [
    {
      "wort": "exakte Wortform wie im Text",
      "vorkommen": [
        {
          "passage": "Vollständiger Satz zeichengenau aus dem Text",
          "synonyme": ["Alternative1", "Alternative2", "Alternative3"]
        }
      ]
    }
  ]
}

Text:
${text}`;
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
