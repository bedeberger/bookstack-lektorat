export const CLAUDE_API = '/claude';

// Superregeln – gelten für alle Prompts
const BASE_RULES = `\
Schweizer Kontext: Helvetismen (grösser, Strasse, gemäss, weiss, zerreisst usw.) sind korrekt und werden nicht bemängelt. \
Der Gedankenstrich (–) gilt als akzeptable Schreibweise – keine Korrektur zu Halbgeviertstrich oder Bindestrich. \
Etwas gilt nur dann als Fehler, wenn es eindeutig falsch ist. Fälle, die zwar abweichen, aber im Schweizer Kontext oder sonst vertretbar sind, werden nicht als Fehler gemeldet – auch keine «möglichen Fehler» mit relativierender Erklärung. Im Zweifel: kein Fehler. \
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

Antworte mit diesem JSON-Schema:
{
  "fehler": [
    {
      "typ": "rechtschreibung|grammatik|stil",
      "original": "das fehlerhafte Wort oder die fehlerhafte Phrase",
      "korrektur": "die korrekte Version",
      "kontext": "der Satz in dem der Fehler vorkommt (gekürzt)",
      "erklaerung": "kurze Erklärung auf Deutsch"
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
