// Profil-getriebene Prompt-Bausteine der Bewertung.
//
// Achsen-Block, Notenanker, Empfehlungs-/Zitat-Regeln, Antwort-Template und der
// Format-Block der Kapitelanalyse. Alle vier hängen an denselben Achsen wie das
// Schema (prompts/review/schemas.js) — sie werden aus derselben Quelle gebaut,
// damit Prompt und Schema nicht auseinanderlaufen können.

/** «die Arbeit» → «Die Arbeit». Nur für den Satzanfang im Notenanker. */
function _cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function _pad(items, key = 'key') {
  return Math.max(...items.map(i => i[key].length)) + 1;
}

/**
 * Achsen-Block: alle Achsen zwingend, mit Hint und Gewichtungssatz.
 */
function _buildAchsenBlock(axes, gewichtung) {
  const pad = _pad(axes);
  const lines = axes.map(a => `- ${a.key}:${' '.repeat(pad - a.key.length)}${a.hint}`).join('\n');
  return `
Bewertungsachsen (alle ${axes.length} zwingend, je 2–5 Sätze, konkret und am Text belegt):
${lines}

GEWICHTUNG: ${gewichtung}`;
}

/**
 * Notenanker. Verhindert Drift zur Mitte (4.0–4.5) und erzwingt achsenbasierte
 * Begründung. Die 4.5-Schwelle nennt die Achsen DIESES Profils — eine fixe Liste
 * («Plot / Figuren / Dramaturgie») wäre für eine Dissertation oder einen
 * Gedichtband unerreichbar und der Anker damit wirkungslos.
 */
function _buildNotenskala(axes, tiers, { scope = 'book', werk = 'das Buch' } = {}) {
  const namen = axes.map(a => a.key).join(' / ');
  const rahmen = scope === 'chapter'
    ? `Notenskala (verbindlich – bewertet das Handwerk dieses Abschnitts im Kontext des Ganzen, nicht die Reife eines ganzen Werks):`
    : `Notenskala (verbindlich – nicht abweichen):`;
  const kontextzeile = scope === 'chapter'
    ? '\n- Bewerte den Abschnitt im Kontext seiner Funktion im Ganzen (siehe Position), nicht als eigenständiges Werk.'
    : '';
  return `
${rahmen}
- 1.0–2.5: ${tiers.mangelhaft}
- 3.0–3.5: ${tiers.schwach}
- 4.0:     ${tiers.solide}
- 4.5:     gut, klare Stärke in mind. zwei Achsen (${namen}).
- 5.0:     ${tiers.sehrGut}
- 5.5–6.0: ausgezeichnet bis herausragend.
- Eine Note über 4.5 verlangt eine konkrete Stärke pro genannter Achse; ohne → maximal 4.5.${kontextzeile}
- Halbschritte (.0, .5) bevorzugen; .25 / .75 nur wenn die Bewertung klar zwischen zwei Stufen liegt.
- Die Note steht im Antwort-JSON ABSICHTLICH zuletzt: schreibe erst die Achsen, lies dann, was dort steht, und leite die Note daraus ab. Nicht umgekehrt.
- ${_cap(werk)} als Ganzes bekommt EINE Note; sie ist kein Durchschnitt der Achsen, sondern deren gewichtetes Urteil.`;
}

/**
 * Empfehlungen + Zitatbelege. Scope-parametrisiert: Wortlaut, Menge und das
 * Kategorien-Enum unterscheiden sich zwischen Buch- und Kapitelbewertung.
 */
function _buildEmpfehlungenBlock({ kategorien, scope = 'book', werk = 'das Buch', quelle = 'Buchtext' }) {
  const einheit = scope === 'chapter' ? 'der Abschnitt' : werk;
  const menge   = scope === 'chapter' ? '3–5' : '4–8';
  const enumStr = kategorien.map(k => `"${k}"`).join('|');
  return `
Empfehlungen – Format & Priorisierung:
- Jede Empfehlung ist ein Objekt { "prio": "hoch"|"mittel"|"niedrig", "kategorie": ${enumStr}, "text": "konkrete Handlungsanweisung" }.
- "hoch": Eingriff, ohne den ${einheit} in zentralen Achsen nicht trägt. Nur so viele "hoch" wie wirklich gravierend – auch null.
- "mittel": klare Verbesserung mit spürbarem Effekt, aber ${einheit} trägt auch ohne sie.
- "niedrig": Feinschliff / Quick-Win (einzelne Stellen, Dopplungen, Mikro-Mängel).
- "text" ist eine Handlungsanweisung an den Autor (was tun), nicht eine erneute Beschreibung der Schwäche.
- ${menge} Empfehlungen insgesamt, sortiert nach Priorität (hoch zuerst). Keine Doppelungen zu staerken/schwaechen.
- Das Beispiel im Antwort-Schema zeigt die FORM eines Eintrags, nicht die zu liefernde Verteilung: Prioritäten und Kategorien ergeben sich aus dem Befund. Es ist weder eine Pflicht-Mischung noch muss jede Kategorie vorkommen.

Beispielzitate – Format:
- Jedes Beispiel ist ein Objekt { "kind": "staerke"|"schwaeche", "zitat": "zeichengenaue Stelle", "kommentar": "ein Satz: was die Stelle zeigt" }.
- 2–4 Zitate insgesamt, davon mindestens eines vom Typ "staerke" und eines "schwaeche" (sofern beide ableitbar).
- "zitat" MUSS wörtlich, zeichengenau, aus dem vorliegenden ${quelle} stammen. Keine Paraphrase, keine Erfindung, keine Auslassungszeichen. Wenn ein passendes Zitat nicht zu finden ist: Eintrag weglassen, nicht erfinden. Zitate werden serverseitig gegen den Text geprüft und stillschweigend verworfen, wenn sie dort nicht vorkommen.
- "kommentar" benennt knapp, wozu das Zitat steht (z.B. "verdichtet Atmosphäre in zwei Bildern", "Telling statt Showing", "Behauptung ohne Beleg").`;
}

/**
 * Antwort-Template. Wird aus denselben Achsen gebaut wie der Achsen-Block und
 * das Schema — Prompt und Schema können nicht auseinanderlaufen.
 */
function _buildOutputFormat(axes, { scope = 'book', kategorien, zitatQuelle = 'dem Text' }) {
  const pad = _pad(axes);
  const axisLines = axes.map(a => `  "${a.key}":${' '.repeat(pad - a.key.length)}"${a.hint}"`).join(',\n');
  const einheit = scope === 'chapter' ? 'dieses Abschnitts' : 'des Ganzen';
  return `<output_format>
Antworte mit diesem JSON-Schema. Feldreihenfolge einhalten – die Note kommt zuletzt.
{
  "zusammenfassung": "2-3 Sätze Gesamteindruck ${einheit}",
${axisLines},
  "staerken":    ["konkrete Stärke", "…"],
  "schwaechen":  ["konkrete Schwäche", "…"],
  "empfehlungen":[
    { "prio": "hoch|mittel|niedrig", "kategorie": "${kategorien.join('|')}", "text": "konkrete Handlungsanweisung an den Autor" }
  ],
  "beispielzitate":[
    { "kind": "staerke|schwaeche", "zitat": "wörtlich aus ${zitatQuelle}", "kommentar": "was diese Stelle zeigt" }
  ],
  "fazit": "Abschliessendes Urteil in 1-2 Sätzen",
  "gesamtnote": 4.5,
  "gesamtnote_begruendung": "Ein Satz, warum diese Note – gestützt auf die oben ausgeschriebenen Achsen (Dezimalzahl 1.0=sehr schwach bis 6.0=ausgezeichnet, Halbschritte bevorzugt)"
}
</output_format>`;
}

/** Format-Block der Kapitelanalyse (Multi-Pass-Zwischenstufe). */
function _buildKapitelanalyseFormat(felder) {
  const all = [
    { key: 'themen',        hint: 'Hauptthemen und Inhalte.' },
    { key: 'stil',          hint: 'Sprachbeobachtungen (Wortwahl, Satzbau, Ton); bei vorgegebener Erzählform kurz Konsistenz beurteilen.' },
    { key: 'funktion_kurz', hint: 'Funktion im Ganzen: was leistet dieser Abschnitt für das Werk, was ändert sich durch ihn, und wie schliesst er nach vorn und hinten an.' },
    ...felder,
    { key: 'zitate',        hint: '1–2 wörtliche, zeichengenaue Belegstellen aus DIESEM Abschnitt, je mit kind (staerke|schwaeche) und einem Kommentar-Satz. Nur echte Fundstellen – nichts erfinden, sonst leere Liste.' },
  ];
  const pad = _pad(all);
  const lines = all.map(f => `- ${f.key}:${' '.repeat(pad - f.key.length)}${f.hint}`).join('\n');
  return `
Format der Analyse (alle Felder ausfüllen, jeweils 1–2 Sätze, knapp und konkret):
${lines}`;
}

export {
  _cap, _pad,
  _buildAchsenBlock, _buildNotenskala, _buildEmpfehlungenBlock,
  _buildOutputFormat, _buildKapitelanalyseFormat,
};
