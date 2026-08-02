// Konsolidierungs-Prompts: Zeitstrahl, Songs, Schauplätze (kapitelweise → Gesamtliste).
import { ORTE_SCHEMA, ORTE_RULES, SONGS_SCHEMA, SONGS_RULES } from './schema-strings.js';

export function buildZeitstrahlConsolidationPrompt(events) {
  return `Du erhältst eine Liste von Lebensereignissen verschiedener Figuren aus einem Buch. Erkenne semantisch identische oder sehr ähnliche Ereignisse (gleicher realer Vorfall, nur unterschiedlich formuliert) und fasse sie zu einem einzigen Eintrag zusammen. Führe die Figurenlisten zusammen und wähle die präziseste Formulierung.

Ereignisse die sich inhaltlich unterscheiden, bleiben getrennt – auch wenn sie im selben Jahr stattfanden.

Antworte mit diesem JSON-Schema:
{
  "ereignisse": [
    {
      "datum": "Original-Datum (JJJJ oder Freitext)",
      "datum_label": "User-lesbarer Original-String, z.B. «Mai 1850», «12. März 1850», «1850», «vor der Reise»",
      "datum_year":  1850,          // Jahr als INT (negativ für v.Chr.); null wenn unbekannt
      "datum_month": 5,             // 1–12; null wenn unbekannt
      "datum_day":   12,            // 1–31; null wenn unbekannt
      "datum_ende_year":  null,     // Falls Spanne (Krieg, Reise, Schwangerschaft): Ende-Jahr
      "datum_ende_month": null,
      "datum_ende_day":   null,
      "story_tag": null,            // Relative Story-Zeit (Tag 3, Day 12) wenn kein Kalender
      "datum_unsicher": false,      // true wenn datum_year nur aus dem Kontext abgeleitet (nicht explizit belegt) ist
      "subtyp": "wendepunkt",       // geburt|tod|hochzeit|liebe|trennung|krankheit|reise|umzug|konflikt|wendepunkt|entdeckung|verlust|sieg|extern_politisch|extern_wirtschaftlich|extern_natur|extern_kulturell|extern_krieg|sonstiges
      "ereignis": "kanonische Formulierung",
      "typ": "persoenlich|extern",
      "bedeutung": "zusammengeführte Bedeutung oder leer",
      "kapitel": ["Kapitelname1", "Kapitelname2"],
      "seiten": ["Seite1", "Seite2"],
      "figuren": [{ "id": "fig_1", "name": "Name", "typ": "hauptfigur|nebenfigur|antagonist|mentor|randfigur|andere" }]
    }
  ]
}

Regeln:
- Strukturierte Datums-Felder PFLICHT: datum_year/month/day aus jedem datum_label extrahieren. Nur ein Teil bekannt? Restliche Felder null.
- UNBEKANNT HEISST null, NIEMALS 0: Jedes unbekannte Zahlenfeld (datum_year, datum_month, datum_day, datum_ende_*, story_tag) MUSS exakt null sein. Eine 0 wird als echtes Datum gelesen und ergibt Unsinn wie «00.00.0». Gültige Bereiche: Monat 1–12, Tag 1–31, story_tag ab 1; Jahr 0 gibt es nicht (v.Chr. negativ). Punkt-Ereignisse lassen datum_ende_* komplett null – nur echte Spannen füllen es.
- datum_unsicher unverändert aus den Eingabe-Ereignissen übernehmen. Beim Zusammenführen: ist mindestens ein zusammengeführtes Ereignis sicher datiert (datum_unsicher=false mit datum_year), gilt das Ergebnis als sicher (datum_unsicher=false); sonst datum_unsicher=true. Niemals ein abgeleitetes Jahr als sicher ausgeben.
- Spannen (z.B. «Krieg 1914–1918», «Reise Mai–August 1850»): datum_*_year/month/day = Start, datum_ende_*_year/month/day = Ende.
- Behalte die chronologische Reihenfolge (aufsteigend nach datum_year, dann _month, _day)
- subtyp: Eines aus der Whitelist. Default 'sonstiges'. Bei externen Welt-Events: extern_politisch|extern_wirtschaftlich|extern_natur|extern_kulturell|extern_krieg.
- Dedupliziere figuren (gleiche id nur einmal pro Ereignis)
- kapitel: Alle Kapitel der zusammengeführten Ereignisse beibehalten (Union der Arrays, Duplikate entfernen)
- seiten: Alle Seiten der zusammengeführten Ereignisse beibehalten (Union der Arrays, Duplikate entfernen)
- Ereignisse verschiedener Figuren zum gleichen Datum die denselben realen Vorfall beschreiben (z.B. Geburt, Heirat, Tod, Unfall, Krieg) MÜSSEN zusammengeführt werden – auch wenn die Formulierungen leicht abweichen. Führe alle beteiligten Figuren im figuren-Array zusammen.
- Nur bei inhaltlich klar verschiedenen Vorfällen trennen

Ereignisse:
${JSON.stringify(events, null, 2)}`;
}

export function buildSongsConsolidationPrompt(bookName, chapterSongs, figurenKompakt) {
  const synthInput = chapterSongs.map(cs =>
    `## Kapitel: ${cs.kapitel}\n` + (cs.songs || []).map(s =>
      `- «${s.titel || ''}»${s.interpret ? ` — ${s.interpret}` : ''} (${s.genre || 'andere'} / ${s.kontext_typ || '?'}): ${s.beschreibung || ''}` +
      (s.stimmung ? ` | Stimmung: ${s.stimmung}` : '') +
      (s.figuren_namen?.length ? ` | Figuren: ${s.figuren_namen.join(', ')}` : '') +
      (s.kapitel?.length ? ` | Kapitel: ` + s.kapitel.map(k => k.name + (k.haeufigkeit > 1 ? ' ×' + k.haeufigkeit : '')).join(', ') : '')
    ).join('\n')
  ).join('\n\n');
  const figurenStr = figurenKompakt && figurenKompakt.length
    ? '\n\nBekannte Figuren (verwende in «figuren_namen» exakt diese Schreibweise):\n' + figurenKompakt.map(f => `- ${f.name}`).join('\n')
    : '';
  return `Konsolidiere die folgenden Musik-Analysen aller Kapitel des Buchs «${bookName}» zu einer einheitlichen Gesamtliste. Dedupliziere Songs anhand von Titel+Interpret (gleicher Song = ein Eintrag, Kapitel-Liste mergen), führe Informationen zusammen und vergib stabile IDs (song_1, song_2, …).${figurenStr}

Kapitelanalysen:

${synthInput}

Antworte mit diesem JSON-Schema:
${SONGS_SCHEMA}

${SONGS_RULES}`;
}

export function buildLocationsConsolidationPrompt(bookName, chapterOrte, figurenKompakt) {
  const synthInput = chapterOrte.map(co =>
    `## Kapitel: ${co.kapitel}\n` + co.orte.map(o =>
      `- ${o.name} (${o.typ || 'andere'}): ${o.beschreibung || ''}` +
      (o.land ? ` | Land: ${o.land}` : '') +
      (o.stimmung ? ` | Stimmung: ${o.stimmung}` : '') +
      (o.figuren_namen?.length ? ` | Figuren: ${o.figuren_namen.join(', ')}` : '') +
      (o.kapitel?.length ? ` | Kapitel: ` + o.kapitel.map(k => (typeof k === 'string' ? k : k.name)).join(', ') : '')
    ).join('\n')
  ).join('\n\n');
  const figurenStr = figurenKompakt && figurenKompakt.length
    ? '\n\nBekannte Figuren (verwende in «figuren_namen» exakt diese Schreibweise):\n' + figurenKompakt.map(f => `- ${f.name}`).join('\n')
    : '';
  return `Konsolidiere die folgenden Schauplatz-Analysen aller Kapitel des Buchs «${bookName}» zu einer einheitlichen Gesamtliste. Erkenne Schauplätze, die unter verschiedenen Namen denselben realen Ort meinen (Synonyme, bestimmter Artikel, Schreibvarianten, Abkürzungen – z.B. «die Burg» / «Festung Hohenstein» / «das Schloss»), und fasse sie zu einem einzigen Eintrag zusammen. Führe dabei Kapitel- und Figuren-Listen zusammen und vergib stabile IDs (ort_1, ort_2, …).${figurenStr}

Kapitelanalysen:

${synthInput}

Antworte mit diesem JSON-Schema:
${ORTE_SCHEMA}

${ORTE_RULES}

Konsolidierungs-Regeln:
- kapitel: Alle Kapitel der zusammengeführten Orte beibehalten (Union der Arrays, Duplikate entfernen) – ein in mehreren Kapiteln vorkommender Ort behält ALLE seine Kapitel.
- figuren_namen: Figuren-Namenslisten der zusammengeführten Orte vereinen (gleicher Name nur einmal); Klarnamen exakt wie in der bekannten Figurenliste.
- beschreibung/stimmung: bei Merge die Informationen zusammenführen und die präziseste/reichste Formulierung wählen.
- Gleicher Name, aber klar verschiedene Orte (z.B. zwei verschiedene Gasthäuser «zum Löwen», zwei Städte gleichen Namens) bleiben getrennte Einträge.
- Hierarchisch verschachtelte Orte (Raum in Gebäude in Stadt) nur zusammenführen, wenn der Text sie tatsächlich gleichsetzt – sonst als eigenständige Schauplätze behalten.`;
}
