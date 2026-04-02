export const CLAUDE_API = '/claude';

// Superregeln – gelten für alle Prompts
const BASE_RULES = `\
SCHWEIZER KONTEXT – STRIKTE REGEL: Im Schweizer Schriftdeutsch wird kein ß verwendet. Deshalb sind alle ss-Schreibungen, die im Deutschen ß wären, korrekte Helvetismen: zerreisst, heisst, weiss, ausserdem, Strasse, gemäss, grösser usw. Diese Wörter sind KEIN FEHLER und dürfen NICHT ins «fehler»-Array. Auch «zerreisst» als Verbform von «zerreissen» ist korrekt. \
Der Gedankenstrich (–) ist korrekte Schreibweise – NICHT ins «fehler»-Array. \
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
