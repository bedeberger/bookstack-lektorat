export const CLAUDE_API = '/claude';

export const SYSTEM_LEKTORAT = `Du bist ein deutschsprachiger Lektor für literarische Texte aus der Schweiz. Helvetismen (grösseres, Strasse, gemäss usw.) sind korrekt und werden nicht bemängelt. Antworte ausschliesslich mit einem JSON-Objekt – kein Markdown, kein Text davor oder danach.`;

export const SYSTEM_BUCHBEWERTUNG = `Du bist ein erfahrener Literaturkritiker und Lektor für deutschsprachige Texte aus der Schweiz. Helvetismen (grösseres, Strasse, gemäss usw.) sind korrekt und werden nicht bemängelt. Antworte ausschliesslich mit einem JSON-Objekt – kein Markdown, kein Text davor oder danach.`;

export const SYSTEM_KAPITELANALYSE = `Du bist ein erfahrener Literaturkritiker und Lektor für deutschsprachige Texte aus der Schweiz. Helvetismen sind korrekt und werden nicht bemängelt. Antworte ausschliesslich mit einem kompakten JSON-Objekt – kein Markdown, kein Text davor oder danach.`;

export const SYSTEM_FIGUREN = `Du bist ein Literaturanalytiker für deutschsprachige Texte. Du extrahierst und analysierst Figuren/Charaktere aus literarischen Werken präzise und strukturiert. Antworte ausschliesslich mit einem JSON-Objekt – kein Markdown, kein Text davor oder danach.`;

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
