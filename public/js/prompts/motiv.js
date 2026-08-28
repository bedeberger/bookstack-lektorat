// Motiv-Werkstatt: planende KI-Assistenz. Zwei Job-Typen.
//
// Brainstorm — die KI liest den Buchtext und schlägt WIEDERKEHRENDE Motive +
// übergeordnete Themen vor, die noch nicht katalogisiert sind.
//
// Consistency — die KI beurteilt den bestehenden Katalog gegen die Buchrealität.
// Sie bekommt die deterministischen Befunde (lib/motif-consistency.js) als
// VORBEFUND mit und prüft, was sich nicht messen lässt: trägt eine behauptete
// Beziehung in den Belegstellen? Meinen zwei Motive dasselbe? Greifen die
// Trigger-Begriffe daneben?
//
// Beide rein rückwärtsgewandt/planend: sie finden Bestehendes im Text und
// schreiben NIE Prosa ins Manuskript. Der Autor entscheidet, was folgt.

import { _obj, _str } from './schema-utils.js';
import { _jsonOnly } from './state.js';

export function buildMotivSystemPrompt() {
  return `Du bist Lektorin und Literaturwissenschaftlerin. Du analysierst den vorliegenden Buchtext auf wiederkehrende MOTIVE (konkrete, sich wiederholende Bilder/Objekte/Gesten/Wörter wie Wasser, Spiegel, ein Lied) und übergeordnete THEMEN (abstrakte Ideen wie Schuld & Vergebung, Preis der Freiheit).

WICHTIG: Du identifizierst nur, was IM TEXT bereits angelegt ist — du erfindest keine Motive und schreibst NIEMALS Prosa oder Fortsetzungen. Deine Vorschläge sind kurze Katalog-Einträge, keine ausformulierten Passagen.${_jsonOnly()}`;
}

function _catalogLines(themes, motifs) {
  const t = (themes || []).map(x => `- Thema: ${x.name}`);
  const m = (motifs || []).map(x => `- Motiv: ${x.name}`);
  const all = [...t, ...m];
  return all.length ? all.join('\n') : '(noch keine)';
}

// text: zusammengefügter Buchtext (bereits aufs Budget gekürzt). existingThemes/
// existingMotifs: bereits katalogisierte Namen (NICHT erneut vorschlagen).
export function buildMotivBrainstormPrompt(text, existingThemes = [], existingMotifs = [], buchKontext = '') {
  const ctxSeg = (buchKontext || '').trim() ? `\nBUCH-KONTEXT:\n${buchKontext}\n` : '';
  return `Die Autorin möchte die Motiv- und Themenarbeit ihres Buches ausbauen. Analysiere den folgenden Text und schlage 4–8 wiederkehrende Motive und/oder übergeordnete Themen vor, die TATSÄCHLICH im Text angelegt sind, aber noch NICHT im Katalog stehen.
${ctxSeg}
BEREITS KATALOGISIERT (NICHT wiederholen):
${_catalogLines(existingThemes, existingMotifs)}

BUCHTEXT (Auszug):
${text}

Regeln:
- Jeder Vorschlag ist entweder ein "thema" (abstrakte Idee) oder ein "motiv" (konkretes, wiederkehrendes Element).
- Nur was im Text belegbar wiederkehrt — keine Erfindungen, keine generische Literatur-Theorie.
- Für Motive: liefere 2–6 wörtliche Trigger-Begriffe (Wörter/Wortstämme, die im Text auf das Motiv hindeuten), für Themen ein leeres Array.
- Keine Dubletten zum Katalog, keine ausformulierte Prosa.

Antworte mit diesem JSON-Schema:
{
  "vorschlaege": [
    { "typ": "motiv", "name": "kurzer Name", "beschreibung": "1 Satz: wofür es steht / wie es im Text auftritt", "trigger_terms": ["Wort", "Wort"] }
  ]
}`;
}

export const SCHEMA_MOTIV_BRAINSTORM = _obj({
  vorschlaege: {
    type: 'array',
    items: _obj({
      typ: _str,
      name: _str,
      beschreibung: _str,
      trigger_terms: { type: 'array', items: _str },
    }),
  },
});


// ── Consistency-Check ─────────────────────────────────────────────────────────
// Prüft den Motiv-Katalog gegen die Buchrealität: Ist-Dichte pro Kapitel +
// Belegstellen aus motif_occurrences. Pendant zu buildPlotConsistencyPrompt.

// Eigene Skala statt Import aus plot.js: die beiden Features sind unabhängig,
// eine geteilte Konstante bände sie ohne fachlichen Grund aneinander. Die Stufen
// sind Persistenz-Werte (motif_consistency_runs.result_json + i18n motiv.severity.*).
const MOTIV_SEVERITY_ENUM = ['kritisch', 'stark', 'mittel', 'schwach', 'niedrig'];

// Liste kappen und das Weglassen AUSWEISEN (nie stillschweigend abschneiden —
// sonst hält das Modell einen Ausschnitt für die Gesamtlage).
function _capped(lines, max, was) {
  if (lines.length <= max) return lines.join('\n');
  return [...lines.slice(0, max), `… (${lines.length - max} weitere ${was} nicht gelistet)`].join('\n');
}

const _pct = (v) => `${Math.round((Number(v) || 0) * 100)} %`;

// Katalog-Outline. Der [#id]-Marker macht Motive für den Befund referenzierbar
// (gleiche Mechanik wie der Beat-Board-Marker im Plot-Check).
function _motivKatalogLines(motifs, themes) {
  const themeName = new Map((themes || []).map(t => [t.id, t.name]));
  return (motifs || []).map(m => {
    const meta = [
      m.theme_id != null && themeName.has(m.theme_id) ? `Thema: ${themeName.get(m.theme_id)}` : 'ohne Thema',
      `${m.occurrenceCount || 0} Fundstellen`,
    ];
    if (m.occurrenceCount) meta.push(`⌀ ${_pct(m.occAvgScore)}`);
    const parts = [`- [#${m.id}] «${m.name}» (${meta.join(' · ')}).`];
    const desc = (m.beschreibung || '').trim();
    if (desc) parts.push(/[.!?…]$/.test(desc) ? desc : `${desc}.`);
    if ((m.trigger_terms || []).length) parts.push(`Trigger: ${m.trigger_terms.join(', ')}.`);
    return parts.join(' ');
  });
}

// Lesbare Phrase je kuratiertem Kanten-Typ (Schlüssel = motif_relations.typ,
// SSoT der Liste: public/js/book/motiv/constants.js + lib/motif-consistency.js).
// Freitext-Typen fallen auf „<typ> →" zurück — analog REL_PHRASE im Plot-Prompt.
const REL_PHRASE = {
  verstaerkt: 'verstärkt →',
  spiegelt: 'spiegelt →',
  bedingt: 'bedingt →',
  kontrastiert: 'kontrastiert mit →',
  bricht: 'bricht →',
  verdraengt: 'verdrängt →',
};

function _motivRelationLines(relations, motifs) {
  const nameById = new Map((motifs || []).map(m => [m.id, m.name]));
  return (relations || [])
    .filter(r => nameById.has(r.from_motif_id) && nameById.has(r.to_motif_id))
    .map(r => `- «${nameById.get(r.from_motif_id)}» ${REL_PHRASE[r.typ] || `${r.typ} →`} «${nameById.get(r.to_motif_id)}»`);
}

// Kapitel-Verlauf: pro Motiv die Kapitelnummern mit Trefferzahl. Verdichtete Form
// des Verlaufsbands — zeigt, WO über den Buchbogen ein Motiv trägt.
function _verlaufLines(motifs, kapitel) {
  const posById = new Map((kapitel || []).map((k, i) => [k.id, i + 1]));
  return (motifs || [])
    .filter(m => (m.occChapters || []).length)
    .map(m => {
      const cells = (m.occChapters || [])
        .map(o => ({ pos: posById.get(o.chapterId), n: o.n }))
        .filter(c => c.pos != null)
        .sort((a, b) => a.pos - b.pos)
        .map(c => `K${c.pos}(${c.n})`);
      return `- «${m.name}»: ${cells.join(' ')}`;
    })
    .filter(l => !l.endsWith(': '));
}

// Soll-Verknüpfung auf Kapitel — die einzige Soll-Brücke, die sich direkt gegen
// den Kapitel-Verlauf halten lässt.
function _sollLines(motifs) {
  return (motifs || [])
    .filter(m => (m.chapters || []).length)
    .map(m => `- «${m.name}» → ${(m.chapters || []).map(c => c.name).join(', ')}`);
}

// Belegstellen: die stärksten Fundstellen je Motiv, wörtlich aus dem Manuskript.
// belege: { [motifId]: [{ kapitel, snippet }] }. Sie sind die ERDUNG — ohne sie
// urteilte das Modell über Zahlen statt über Prosa.
function _belegLines(motifs, belege) {
  const out = [];
  for (const m of motifs || []) {
    const rows = (belege && belege[m.id]) || [];
    if (!rows.length) continue;
    out.push(`«${m.name}»:`);
    for (const r of rows) out.push(`  - ${r.kapitel ? `[${r.kapitel}] ` : ''}„${r.snippet}"`);
  }
  return out;
}

export function buildMotivConsistencyPrompt(
  themes = [], motifs = [], relations = [], kapitel = [], belege = {},
  vorbefunde = [], buchKontext = '', occInfo = {},
) {
  const ctxSeg = (buchKontext || '').trim() ? `\nBUCH-KONTEXT:\n${buchKontext}\n` : '';
  const themeLines = (themes || []).map(t => `- «${t.name}»${(t.beschreibung || '').trim() ? ` — ${t.beschreibung.trim()}` : ''}`);
  const themeSeg = themeLines.length ? `\nTHEMEN (Cluster über den Motiven):\n${_capped(themeLines, 40, 'Themen')}\n` : '';
  const katSeg = `\nMOTIV-KATALOG (Soll des Autors; Fundstellen = Ist aus der Motiverkennung):\n${_capped(_motivKatalogLines(motifs, themes), 80, 'Motive')}\n`;
  const relLines = _motivRelationLines(relations, motifs);
  const relSeg = relLines.length
    ? `\nMOTIV-BEZIEHUNGEN (vom Autor gezogene Kanten zwischen Motiven):\n${_capped(relLines, 120, 'Kanten')}\n`
    : '\nHINWEIS: Der Autor hat noch keine Motiv-Beziehungen gezogen.\n';
  const verlaufLines = _verlaufLines(motifs, kapitel);
  const verlaufSeg = verlaufLines.length
    ? `\nKAPITEL-VERLAUF (Fundstellen je Kapitel in Lesereihenfolge, K1 = erstes Kapitel):\n${_capped(verlaufLines, 80, 'Zeilen')}\n`
    : '';
  const sollLines = _sollLines(motifs);
  const sollSeg = sollLines.length
    ? `\nSOLL-VERKNÜPFUNGEN AUF KAPITEL (wo das Motiv laut Plan tragen soll):\n${_capped(sollLines, 60, 'Zeilen')}\n`
    : '';
  const belegLines = _belegLines(motifs, belege);
  const belegSeg = belegLines.length
    ? `\nBELEGSTELLEN (wörtlich aus dem Manuskript, stärkste Treffer je Motiv):\n${_capped(belegLines, 200, 'Zeilen')}\n`
    : '';
  const vorSeg = (vorbefunde || []).length
    ? `\nVORBEFUNDE AUS DER MESSUNG (deterministisch gerechnet, keine Modell-Meinung — VERWENDE sie, wiederhole sie NICHT als eigenen Befund):\n${_capped(vorbefunde.map(v => `- ${v}`), 40, 'Vorbefunde')}\n`
    : '';
  // Die Ist-Seite darf nur als Abwesenheit gelesen werden, wenn sie erhoben wurde.
  const scanSeg = occInfo && occInfo.scanned === false
    ? '\nACHTUNG: Die Motiverkennung ist für dieses Buch noch nicht gelaufen. Alle Fundstellen-Zahlen sind deshalb 0 — das heisst UNGEPRÜFT, nicht „kommt nicht vor". Stütze dein Urteil auf Katalog, Beschreibungen und Beziehungen und melde KEINE Befunde der Art „Motiv fehlt im Text".\n'
    : '';

  return `Du prüfst die Motiv- und Themenarbeit der Autorin auf Stimmigkeit — den geplanten Katalog gegen die tatsächliche Buchrealität (Fundstellen + Belegstellen). Sei schonungslos, aber konstruktiv.
${ctxSeg}${themeSeg}${katSeg}${relSeg}${verlaufSeg}${sollSeg}${belegSeg}${vorSeg}${scanSeg}
Prüfe auf:
- Beziehungen, die der Text nicht einlöst: Sagen die Belegstellen der beiden Motive wirklich, was die Kante behauptet (verstärkt / kontrastiert / spiegelt …)? Eine Kante ist eine Behauptung über den Text, keine Absichtserklärung.
- Motiv-Dubletten: Zwei Katalog-Einträge, die dasselbe meinen (überlappende Fundstellen, austauschbare Beschreibung) — nenne beide und schlage die Zusammenlegung vor.
- Trigger-Begriffe, die danebengreifen: Passen die Belegstellen inhaltlich zum Motiv, oder hat ein zu weiter Begriff fremde Stellen eingesammelt? Nenne den Begriff.
- Motiv gegen Beschreibung: Die Belegstellen zeigen etwas anderes, als die Beschreibung des Motivs behauptet.
- Themen ohne Substanz: Ein Thema, dessen Motive im Text kaum tragen — oder ein tragendes Motiv, das keinem Thema zugeordnet ist und darum im Gefüge hängt.
- Verteilung über den Buchbogen: Ein Motiv, das nach der Buchmitte verschwindet oder erst spät einsetzt — wenn das der erklärten Absicht widerspricht.

Regeln:
- Urteile über die BELEGSTELLEN, nicht über die Namen. Ohne Belegstelle für eine Behauptung: kein Befund.
- Erfinde nichts: keine Motive, die nicht im Katalog stehen, keine Zitate, die nicht in den Belegstellen vorkommen.
- Schreibe NIEMALS Prosa oder Formulierungsvorschläge für das Manuskript. Dein "vorschlag" ist eine Arbeitsanweisung an die Autorin (was prüfen, was zusammenlegen, was streichen).

Schwere-Skala:
- "kritisch": Der Katalog behauptet etwas, das dem Text klar widerspricht
- "stark":   Deutlicher Bruch zwischen Plan und Buch, sollte aufgelöst werden
- "mittel":  Spannung/Drift, Klärung empfohlen
- "schwach": Leichte Reibung, Hinweis genügt
- "niedrig": Kosmetisch / Katalog-Pflege

Nenne im Feld "motiv" den Namen des betroffenen Motivs — oder "—" für übergreifende Befunde (Themen-Struktur, Katalog als Ganzes). Gib zusätzlich im Feld "motiv_id" die Zahl aus dem [#…]-Marker an (z.B. [#42] → 42); für übergreifende Befunde setze "motiv_id" auf null. Wenn alles stimmig ist, gib ein leeres "konflikte"-Array zurück und schreibe ein bestätigendes Fazit.

Priorisiere nach Schwere und melde die wichtigsten Befunde (höchstens ~20) — keine redundanten Dopplungen. Halte "problem" und "vorschlag" knapp (je 1–2 Sätze).

Antworte mit diesem JSON-Schema:
{
  "konflikte": [
    { "motiv": "Name des Motivs oder —", "motiv_id": 42, "schwere": "kritisch|stark|mittel|schwach|niedrig", "problem": "kurze Beschreibung", "vorschlag": "konkreter naechster Schritt" }
  ],
  "fazit": "1-3 Saetze Gesamteinschaetzung"
}`;
}

export const SCHEMA_MOTIV_CONSISTENCY = _obj({
  konflikte: {
    type: 'array',
    items: _obj({
      motiv: _str,
      // Stabile Motiv-ID aus dem [#…]-Marker — überlebt Umbenennungen. null bei
      // übergreifenden Befunden ("—", kein einzelnes Motiv).
      motiv_id: { type: ['integer', 'null'] },
      schwere: { type: 'string', enum: MOTIV_SEVERITY_ENUM },
      problem: _str,
      vorschlag: _str,
    }),
  },
  fazit: _str,
});

export const MOTIV_SEVERITY = MOTIV_SEVERITY_ENUM;
