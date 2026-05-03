// Komplett-Pipeline-Prompts: Vollextraktion (Figuren/Orte/Fakten/Szenen/Lebensereignisse),
// Konsolidierungen (Figuren-Basis, Soziogramm, Orte), Zeitstrahl, Kontinuitätsprüfung.
// Mehrere Schemas sind _isLocal-abhängig (machtverhaltnis-Weglassen für lokale Provider) –
// _rebuildKomplettSchemas() baut sie nach configurePrompts() neu.

import { _isLocal, _jsonOnly } from './state.js';
import { _obj, _str, _num } from './schema-utils.js';
import { _buildErzaehlformBlock } from './blocks.js';

// ── Figurenextraktion (Basis – ohne Lebensereignisse) ─────────────────────────

const FIGUREN_BASIS_SCHEMA = `{
  "figuren": [
    {
      "id": "fig_1",
      "name": "Vollständiger Name",
      "kurzname": "Vorname oder Spitzname",
      "typ": "hauptfigur|nebenfigur|antagonist|mentor|randfigur|andere",
      "geburtstag": "JJJJ oder leer wenn unbekannt",
      "geschlecht": "männlich|weiblich|divers|unbekannt",
      "beruf": "Beruf oder Rolle oder leer",
      "wohnadresse": "Wohnort/Wohnadresse der Figur oder leer wenn nicht belegt",
      "rolle": "1 Satz: Funktion in der Handlung (z.B. 'Ermittelt den Mordfall', 'Erzählerin, blickt rückblickend zurück')",
      "motivation": "1 Satz: was die Figur antreibt; leer wenn nicht belegt",
      "konflikt": "1 Satz: zentraler innerer oder äusserer Konflikt; leer wenn nicht belegt",
      "beschreibung": "2-3 Sätze: Rolle + Persönlichkeit + Bedeutung, textnah",
      "sozialschicht": "wirtschaftselite|gehobenes_buergertum|mittelschicht|arbeiterschicht|migrantenmilieu|prekariat|unterwelt|andere",
      "eigenschaften": ["Eigenschaft1", "Eigenschaft2"],
      "praesenz": "zentral|regelmaessig|punktuell|randfigur",
      "entwicklung": "statisch|Kurzbeschreibung des Wandels (1 Satz, z.B. 'verliert Vertrauen in Mentor')",
      "erste_erwaehnung": "Kapitelname oder Seitenname der ersten Erwähnung (leer wenn unklar)",
      "schluesselzitate": ["Bis zu 3 charakterisierende Zitate, wörtlich aus dem Text"],
      "kapitel": [{ "name": "Kapitelname", "haeufigkeit": 3 }],
      "beziehungen": [{ "figur_id": "fig_2", "typ": "elternteil|geschwister|kind|freund|feind|kollege|bekannt|liebesbeziehung|rivale|mentor|schuetzling|patronage|geschaeft|andere", "machtverhaltnis": 0, "beschreibung": "1 Satz", "belege": [{ "kapitel": "EXAKT der ## Kapitel-Header", "seite": "EXAKT ein ### Seiten-Header aus dem Kapitel – NIE der Kapitelname; leer wenn unklar" }] }]
    }
  ]
}`;

export const figurenBasisRules = (kontext = '') => `Regeln:
- Eindeutige IDs (fig_1, fig_2, …)
- beziehungen.figur_id: nur IDs aus dieser Liste; jede Beziehung nur einmal eintragen
- kapitel: absteigend nach Häufigkeit; haeufigkeit = Anzahl Seiten/Abschnitte mit aktivem Auftreten; name = immer der Kapitelname (aus dem ## Kapitel-Header über dem Abschnitt oder aus dem Prompt-Kontext) – NIEMALS Seitentitel als Kapitelnamen verwenden
- typ: Figuren-Archetyp. hauptfigur=trägt zentral die Handlung, antagonist=Gegenspieler, mentor=Anleiter/Lehrerin, nebenfigur=klar identifizierbarer Sekundärcharakter mit mehreren Auftritten, randfigur=tritt nur am Rand in Erscheinung (kaum mehr als Erwähnung), andere=nicht zuordenbar. NICHT mit praesenz verwechseln (Typ = Rolle, Präsenz = Handlungsgewicht).
- praesenz: Gewichtung der Figur im Gesamtbuch. zentral=Haupthandlungsträger, regelmaessig=wiederkehrend und handlungsrelevant, punktuell=taucht in einzelnen Szenen auf, randfigur=kaum mehr als Erwähnung. Bei Einzelkapitel-Analyse: Einschätzung basiert nur auf diesem Kapitel.
- rolle / motivation / konflikt: je 1 Satz, textnah. Leer lassen wenn nicht belegt – nicht spekulieren.
- beschreibung: 2-3 Sätze Zusammenfassung (Fallback für Anzeige und Chat-Kontext). Soll KEINE Spekulation enthalten.
- schluesselzitate: bis zu 3 wörtliche Zitate (max. 80 Zeichen) die die Figur charakterisieren – exakt aus dem Text, in der Original-Interpunktion. Leer lassen wenn keine prägnanten Stellen gefunden.
- erste_erwaehnung: Kapitel- oder Seitenname der ersten Erwähnung (so präzise wie belegt). Leer wenn unklar.
- wohnadresse: Wohnort oder Wohnadresse der Figur, so präzise wie textnah belegt (z.B. «Zürich», «Bahnhofstrasse 12, Bern», «kleines Bauernhaus am Waldrand»). Nur ausfüllen wenn explizit aus dem Text hervorgeht. Leer wenn nicht erwähnt – nicht spekulieren.
- entwicklung: "statisch" wenn die Figur über das Buch hinweg unverändert bleibt, sonst 1 Satz zum Wandel. Leer wenn nicht eindeutig.
- sozialschicht: gesellschaftliche Schicht der Figur${kontext ? ` (${kontext})` : ''} – nur vergeben wenn eindeutig belegt; wirtschaftselite=Unternehmerfamilien/Direktoren, gehobenes_buergertum=Akademiker/freie Berufe/obere Kader, mittelschicht=Angestellte/Beamte/mittlere Kader, arbeiterschicht=Fabrik-/Bauarbeiter/Servicepersonal, migrantenmilieu=Zugewanderte/zweite Generation, prekariat=Sozialhilfe/Randständige/Langzeitarbeitslose, unterwelt=kriminelles Milieu, andere=nicht eindeutig
- beziehungen.machtverhaltnis: Machtasymmetrie: +2=Gegenüber (figur_id) dominiert klar, +1=Gegenüber hat leichten Vorteil, 0=symmetrisch, -1=diese Figur hat leichten Vorteil, -2=diese Figur dominiert klar; weglassen oder 0 wenn unklar
- beziehungen.belege: 1-3 Stellen (Kapitelname + Seitentitel) an denen die Beziehung klar wird. Genau wie im Text stehen lassen; leer lassen wenn unsicher. Seitennamen aus ### Überschriften, Kapitelnamen aus ## Überschriften oder dem Prompt-Kontext.
- Beziehungstypen: typ beschreibt die ROLLE von figur_id (NICHT der aktuellen Figur!). Bei Figur X der Eintrag {figur_id: Y, typ: elternteil} bedeutet: Y IST der Elternteil von X. Konkretes Beispiel: Robert hat Mutter Sandra → bei Robert eintragen {figur_id: «<Sandras fig_id>», typ: elternteil, machtverhaltnis: 2}. patronage=Schutzherrschaft (figur_id = Patron), geschaeft=wirtschaftliche Beziehung, geschwister=undirektional, übrige selbsterklärend
- Pro Figurenpaar höchstens EINE Beziehung eintragen – aus der Perspektive EINER Figur. Keine widersprüchlichen Angaben (z.B. nicht gleichzeitig elternteil und kind für dasselbe Paar)
- Nur fiktive Charaktere oder Figuren die aktiv an der Buchhandlung teilnehmen – keine Orte oder Objekte
- KEINE historischen oder realen Personen die nur erwähnt, zitiert oder als Referenz genannt werden (z.B. Napoleon, Einstein, ein Politiker, eine Künstlerin)
- Sortiert nach Wichtigkeit (zentral zuerst)
- KONSERVATIV: Nur Figuren und Beziehungen aufnehmen die im Text eindeutig belegt sind. Lieber weglassen als spekulieren. Leere Strings/Arrays sind besser als erfundene Inhalte.
- DEDUPLIZIERUNG MIT KONTEXTABGLEICH: Figuren zusammenführen wenn der Name übereinstimmt (gleicher Vor- und Nachname) ODER ein Teilname (nur Vorname oder nur Nachname) mit mindestens einem inhaltlichen Indiz zusammenpasst – z.B. gleicher Beruf, überschneidende Fachkenntnisse, konsistente Charakterzüge oder übereinstimmendes Verhalten kapitelübergreifend. Beispiel: «Maria» die in Kapitel 1 als Kräuterkundige gilt und «Maria Huber» die in Kapitel 3 Naturheilkunde beherrscht – zusammenführen. Widersprechen sich Eigenschaften eindeutig, getrennt behalten. Gibt es nur Namensähnlichkeit ohne inhaltliche Überschneidung: getrennt behalten.`;

export function buildFiguresBasisConsolidationPrompt(bookName, chapterFiguren, buchKontext = '') {
  const synthInput = chapterFiguren.map(cf => {
    const nameById = Object.fromEntries((cf.figuren || []).map(f => [f.id, f.name]));
    return `## Kapitel: ${cf.kapitel}\n` + (cf.figuren || []).map(f => {
      const meta = [f.typ, f.beruf, f.geburtstag ? `*${f.geburtstag}` : '', f.geschlecht].filter(Boolean).join(', ');
      return `- ${f.name}${f.kurzname && f.kurzname !== f.name ? ` («${f.kurzname}»)` : ''} (${meta}): ${f.beschreibung || ''}` +
        (f.wohnadresse ? '\n  Wohnadresse: ' + f.wohnadresse : '') +
        (f.eigenschaften?.length ? '\n  Eigenschaften: ' + f.eigenschaften.join(', ') : '') +
        (f.kapitel?.length ? '\n  Kapitel: ' + f.kapitel.map(k => k.name + (k.haeufigkeit > 1 ? ' ×' + k.haeufigkeit : '')).join(', ') : '') +
        (f.beziehungen?.length ? '\n  Beziehungen: ' + f.beziehungen.map(b => {
          const relName = nameById[b.figur_id] || b.name || b.figur_id;
          return `${relName} [${b.typ}]${b.beschreibung ? ': ' + b.beschreibung : ''}`;
        }).join(', ') : '');
    }).join('\n');
  }).join('\n\n');
  return `Konsolidiere die folgenden Figurenanalysen aller Kapitel des Buchs «${bookName}» zu einer einheitlichen Gesamtliste. Dedupliziere Figuren, führe Informationen zusammen und vergib stabile IDs.

Kapitelanalysen:

${synthInput}

Antworte mit diesem JSON-Schema:
${FIGUREN_BASIS_SCHEMA}

${figurenBasisRules(buchKontext)}`;
}

// ── Kapitelübergreifende Beziehungen ──────────────────────────────────────────
export function buildKapiteluebergreifendeBeziehungenPrompt(bookName, figurenList, bookText) {
  const idToName = Object.fromEntries(figurenList.map(f => [f.id, f.name]));
  const figInfo = figurenList.map(f => {
    const kap = (f.kapitel || []).map(k => k.name).join(', ') || '(kein Kapitel)';
    const bzStr = (f.beziehungen || [])
      .map(b => `${idToName[b.figur_id] || b.figur_id} [${b.typ}]`)
      .join(', ');
    return `- **${f.id}** ${f.name}${f.kurzname && f.kurzname !== f.name ? ` («${f.kurzname}»)` : ''} | ${f.typ} | Kapitel: ${kap}` +
      (f.beschreibung ? `\n  ${f.beschreibung}` : '') +
      (bzStr ? `\n  Bekannte Beziehungen: ${bzStr}` : '');
  }).join('\n');

  return `Buchname: «${bookName}»

Analysiere die folgende Figurenliste und den Buchtext. Identifiziere Beziehungen zwischen Figuren aus VERSCHIEDENEN Kapiteln, die noch NICHT in «Bekannte Beziehungen» aufgeführt sind.

Figurenliste:
${figInfo}

Buchtext:
${bookText}

Antworte mit diesem JSON-Schema:
{
  "beziehungen": [
    { "von": "fig_1", "zu": "fig_2", "typ": "elternteil|geschwister|kind|freund|feind|kollege|bekannt|liebesbeziehung|rivale|mentor|schuetzling|patronage|geschaeft|andere", "machtverhaltnis": 0, "beschreibung": "1 Satz", "belege": [{ "kapitel": "EXAKT der ## Kapitel-Header", "seite": "EXAKT ein ### Seiten-Header aus dem Kapitel – NIE der Kapitelname; leer wenn unklar" }] }
  ]
}

Regeln:
- Nur Beziehungen zwischen Figuren aus VERSCHIEDENEN Kapiteln
- Nur Beziehungen die im Buchtext eindeutig belegt sind – KONSERVATIV, lieber weglassen als spekulieren
- von/zu: nur IDs aus der obigen Figurenliste
- Jede Beziehung nur einmal eintragen (nicht von→zu UND zu→von für denselben Typ)
- Keine Beziehungen die bereits in «Bekannte Beziehungen» stehen
- machtverhaltnis: Machtasymmetrie: +2=Gegenüber («zu») dominiert klar, +1=Gegenüber hat leichten Vorteil, 0=symmetrisch, -1=diese Figur («von») hat leichten Vorteil, -2=diese Figur dominiert klar; weglassen oder 0 wenn unklar
- belege: 1-3 Stellen (Kapitelname + Seitentitel) an denen die Beziehung sichtbar wird. Seitennamen aus ### Überschriften, Kapitel aus ## Überschriften des übergebenen Textes.
- Leeres Array wenn keine neuen kapitelübergreifenden Beziehungen eindeutig belegt sind`;
}

// ── Soziogramm-Konsolidierung (Claude-only, holistische Revision) ────────────
export function buildSoziogrammConsolidationPrompt(bookName, figuren, buchKontext = '') {
  const figInfo = figuren.map(f => {
    const nameById = Object.fromEntries(figuren.map(x => [x.id, x.name]));
    const meta = [f.typ, f.beruf, f.geschlecht].filter(Boolean).join(', ');
    const bzStr = (f.beziehungen || [])
      .map(b => `${nameById[b.figur_id] || b.figur_id} [${b.typ}${Number.isFinite(b.machtverhaltnis) ? ', macht=' + b.machtverhaltnis : ''}]`)
      .join(', ');
    return `- **${f.id}** ${f.name}${f.kurzname && f.kurzname !== f.name ? ` («${f.kurzname}»)` : ''} | ${meta || '—'} | sozialschicht=${f.sozialschicht || '—'}` +
      (f.beschreibung ? `\n  ${f.beschreibung}` : '') +
      (bzStr ? `\n  Beziehungen: ${bzStr}` : '');
  }).join('\n');

  return `Buch: «${bookName}»${buchKontext ? `\nBuchkontext: ${buchKontext}` : ''}

Die folgenden Figuren sind bereits konsolidiert. Die preliminary-Werte für sozialschicht und die machtverhaltnis-Werte in den Beziehungen stammen aus einer kapitelweisen Vorab-Analyse und sind oft inkonsistent oder fehlen. Revidiere beides HOLISTISCH mit Blick auf das ganze Buch.

Figurenliste:
${figInfo}

Antworte mit diesem JSON-Schema:
{
  "figuren": [
    { "id": "fig_1", "sozialschicht": "wirtschaftselite|gehobenes_buergertum|mittelschicht|arbeiterschicht|migrantenmilieu|prekariat|unterwelt|andere" }
  ],
  "beziehungen": [
    { "from_fig_id": "fig_1", "to_fig_id": "fig_2", "machtverhaltnis": 0 }
  ]
}

Regeln sozialschicht:
- Für JEDE Figur der Liste einen Eintrag – auch wenn der preliminary-Wert übernommen wird
- id: exakt aus der obigen Liste (keine neuen IDs, keine Namensfelder)
- wirtschaftselite=Unternehmerfamilien/Direktoren, gehobenes_buergertum=Akademiker/freie Berufe/obere Kader, mittelschicht=Angestellte/Beamte/mittlere Kader, arbeiterschicht=Fabrik-/Bauarbeiter/Servicepersonal, migrantenmilieu=Zugewanderte/zweite Generation (primär nach Milieu-Zugehörigkeit, nicht nach beruflichem Status), prekariat=Sozialhilfe/Randständige/Langzeitarbeitslose, unterwelt=kriminelles Milieu, andere=nicht eindeutig zuordenbar
- Innerhalb eines Buchs Milieu-Zuordnungen konsistent halten: wenn zwei Figuren im gleichen Haushalt/Familienverbund leben, teilen sie meist die sozialschicht
- KONSERVATIV: im Zweifel «andere» statt spekulativ eine Schicht wählen

Regeln beziehungen (machtverhaltnis):
- Nur Beziehungen der obigen Liste – keine neuen Paare, keine Pfeile zwischen Figuren ohne bestehende Beziehung
- from_fig_id / to_fig_id: exakt die figur_id aus dem obigen Beziehungsfeld («von» = die Figur in deren Block die Beziehung steht, «zu» = figur_id darin)
- machtverhaltnis: +2=to_fig_id dominiert klar, +1=to_fig_id hat leichten Vorteil, 0=symmetrisch, -1=from_fig_id hat leichten Vorteil, -2=from_fig_id dominiert klar
- HOLISTISCH bewerten: wer hat strukturelle Macht (Kapital, Hierarchie, Wissen), wer psychologische (Manipulation, Autorität)? Im Zweifel 0
- Pro ungeordnetem Paar (A,B) nur EIN Eintrag – nicht sowohl A→B als auch B→A
- Beziehungen weglassen wenn machtverhaltnis unklar oder 0 ist und der preliminary-Wert ebenfalls 0/leer war`;
}

// ── Schauplatz-Schemata (auch verwendet in Komplett-Analyse) ─────────────────

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
- SEHR GROSSZÜGIG erfassen: alle Schauplätze inklusive Nebenschauplätze und einmaliger Erwähnungen; lieber inkludieren als weglassen. haeufigkeit=1 ist gültig.
- figuren: nur IDs aus der gelieferten Figurenliste (leer lassen wenn keine Figuren bekannt)
- kapitel: absteigend nach Häufigkeit; haeufigkeit = Anzahl Seiten/Abschnitte in denen der Ort aktiv vorkommt
- Kein Cap auf Anzahl Orte – vollständige Erfassung wichtiger als Kürze`;

// ── Fakten-Schema (verwendet in Komplett-Analyse und Kontinuität) ────────────

const FAKTEN_SCHEMA = `"fakten": [
    {
      "kategorie": "figur|ort|objekt|zeit|ereignis|soziolekt|sonstiges",
      "subjekt": "Über wen/was geht es (Name oder Bezeichnung)",
      "fakt": "Was genau behauptet wird (1 Satz, so präzise wie möglich)",
      "seite": "Seitenname oder Abschnittsname (leer wenn unklar)"
    }
  ]`;

const FAKTEN_RULES = `Fakten-Regeln:
- Nur konkrete, prüfbare Aussagen – keine Interpretationen
- Figuren-Zustände besonders genau erfassen (Wissen, Können, körperlicher Zustand, Wohnort, Beruf)
- Soziolekt: Wenn eine Figur erstmals oder markant spricht, ein Faktum erfassen das ihr Sprachregister beschreibt. Kategorie «soziolekt» verwenden.
- Objekte: Wer besitzt was, wo liegt was, in welchem Zustand
- Zeitangaben: Relative («am nächsten Morgen») und absolute («1943») erfassen
- Kein Cap auf Anzahl Fakten – vollständige, präzise Erfassung wichtiger als Kürze`;

// ── Kontinuitäts-Probleme-Schema (verwendet in Check und SinglePass) ─────────

const PROBLEME_SCHEMA = `{
  "probleme": [
    {
      "schwere": "kritisch|mittel|niedrig",
      "typ": "figur|zeitlinie|ort|objekt|verhalten|soziolekt|sonstiges",
      "beschreibung": "Was genau widerspricht sich (1-2 Sätze)",
      "stelle_a": "Erste Textstelle (Kapitel: Seite oder Abschnitt)",
      "stelle_b": "Zweite Textstelle (Kapitel: Seite oder Abschnitt)",
      "figuren": ["Name der direkt betroffenen Figur"],
      "kapitel": ["Exakter Kapitelname A", "Exakter Kapitelname B"],
      "empfehlung": "Wie könnte das aufgelöst werden (1 Satz)"
    }
  ],
  "zusammenfassung": "Gesamteinschätzung der Konsistenz des Buchs in 2-3 Sätzen"
}`;

const PROBLEME_RULES = `Regeln:
- Nur echte Widersprüche – keine stilistischen oder inhaltlichen Anmerkungen
- WICHTIG: Wenn du bei der Analyse zum Schluss kommst, dass KEIN Widerspruch vorliegt (z.B. «konsistent», «passt», «kein echter Widerspruch»), dann das Problem NICHT melden. Nur tatsächliche Widersprüche ins Array aufnehmen.
- Das «probleme»-Array ist AUSSCHLIESSLICH für bestätigte Widersprüche da – nicht für Zwischenüberlegungen, geprüfte-aber-verworfene Kandidaten oder Entwarnungen. Wenn ein Kandidat sich beim Nachdenken als harmlos herausstellt, wird er komplett weggelassen, nicht mit einer Erklärung ins Array geschrieben.
- Selbstcheck vor dem Antworten: Lies jede «beschreibung» gegen. Enthält sie Formulierungen wie «kein Widerspruch», «kein echter Widerspruch», «konsistent», «passt zusammen», «stimmig», «wird nicht gemeldet», «Entwarnung», «unproblematisch», «lässt sich erklären durch …» (als Entwarnung) – dann den ganzen Eintrag ersatzlos aus dem Array entfernen. Jede «beschreibung» muss den Widerspruch positiv benennen, nicht seine Abwesenheit.
- schwere: «kritisch» = klarer Logikfehler der dem Leser sofort auffällt und zwingend korrigiert werden muss; «mittel» = wahrscheinlicher Fehler der den Leser stören könnte; «niedrig» = mögliche Inkonsistenz die eventuell beabsichtigt ist
- Soziolekt-Probleme: nur wenn klar ein Sprachmuster etabliert wurde und dann ohne Begründung bricht – nicht melden wenn Figur wenig Dialoganteil hat
- figuren: PFLICHTFELD – immer angeben, mindestens []; Namen exakt wie in der Figurenliste; [] nur wenn wirklich keine Figur betroffen (rein ortsbezogene Widersprüche)
- kapitel: PFLICHTFELD – immer angeben, mindestens []; exakte Kapitelnamen aus stelle_a/stelle_b; wenn beide Stellen im selben Kapitel nur einmal; [] nur wenn der Text keine Kapitelinformation enthält
- Wenn keine Widersprüche gefunden: «probleme» als leeres Array, «zusammenfassung» = positive Einschätzung
- Konservativ: Im Zweifel weglassen – lieber ein echtes Problem übersehen als ein Nicht-Problem melden`;

// ── Komplett-Analyse (kombinierte Extraktion) ─────────────────────────────────
// Hilfsfunktion: Extrahiert den Inhalt des äussersten Objekts aus einem Schema-String.
// Ermöglicht das Zusammensetzen von Schemas ohne Duplikation der Felddefinitionen.
function _schemaBody(schemaStr) {
  return schemaStr.trim().replace(/^\s*\{\s*/, '').replace(/\s*\}\s*$/, '').trim();
}

// Kombiniertes Schema für Komplett-Extraktion (P1+P5 merged).
// buildSystemKomplett() bettet es in den System-Prompt ein → Caching über alle Kapitel-Calls.
// figuren_namen / orte_namen / figur_name: Klarnamen statt IDs, da konsolidierte IDs
// erst nach P2/P3 bekannt sind. Remapping nach der Konsolidierung in jobs.js.
function buildKomplettSchemaStatic(kontext = '') {
  const schemaPart = `Priorität: Figuren und deren Beziehungen sind am wichtigsten. Im Zweifel lieber weniger Fakten/Szenen und dafür korrekte Figurenanalyse.

Antworte mit diesem JSON-Schema:
{
  ${_schemaBody(FIGUREN_BASIS_SCHEMA)},
  ${_schemaBody(ORTE_SCHEMA)},
  ${FAKTEN_SCHEMA},
  "szenen": [
    {
      "seite": "NUR der reine Seitentitel aus einem ### Header – OHNE die ###-Markierung und OHNE führende Leerzeichen. Beispiel: aus «### Was macht Adrian?» wird «Was macht Adrian?». NIEMALS den Kapitelnamen als seite. Leer wenn kein passender ### Header identifizierbar.",
      "kapitel": "NUR der reine Kapitelname aus dem ## Header – OHNE die ##-Markierung. Beispiel: aus «## Der Vater» wird «Der Vater». Nicht der ### Seiten-Header. Leer wenn unklar.",
      "titel": "Kurze Szenenbezeichnung (1 Satz)",
      "wertung": "stark|mittel|schwach",
      "kommentar": "1-2 Sätze: was funktioniert, was fehlt (Spannung, Tempo, Figurenentwicklung)",
      "figuren_namen": ["Figurenname exakt wie im Text"],
      "orte_namen": ["Schauplatzname exakt wie im Text"]
    }
  ],
  "assignments": [
    {
      "figur_name": "Figurenname exakt wie im Text",
      "lebensereignisse": [
        {
          "datum": "JJJJ (nur Jahreszahl; aus Kontext errechnen wenn nötig; leer wenn nicht errechenbar)",
          "ereignis": "Was passierte – neutral und kanonisch formuliert, NICHT aus der Figurenperspektive. Ereignisse die mehrere Figuren betreffen MÜSSEN bei allen beteiligten Figuren identisch formuliert sein (z.B. 'Geburt von Maria' für Vater, Mutter und Kind – nicht 'Geburt seiner Tochter' oder 'Eigene Geburt').",
          "typ": "persoenlich|extern",
          "bedeutung": "Bedeutung für diese Figur (1 Satz, leer wenn nicht klar)",
          "seite": "NUR der reine Seitentitel aus einem ### Header – OHNE ###-Markierung. NIE der Kapitelname. Leer wenn unklar.",
          "kapitel": "NUR der reine Kapitelname aus dem ## Header – OHNE ##-Markierung. Nicht der ### Seiten-Header. Leer wenn unklar."
        }
      ]
    }
  ]
}`;

  if (_isLocal) {
    return `${schemaPart}

Kernregeln:
- IDs eindeutig (fig_1, ort_1, …); Beziehungen nur zwischen IDs aus dieser Liste.
- KONSERVATIV: Nur aufnehmen was im Text eindeutig belegt ist. Im Zweifel weglassen.
- Keine historischen/realen Personen die nur erwähnt werden.
- kapitel[].name: immer der Kapitelname (aus dem ## Header oder dem Prompt-Kontext), niemals Seitentitel.
- figuren_namen / orte_namen / figur_name: Klarnamen exakt wie im Text.
- Ereignisse: datum als JJJJ; ohne errechenbares Jahr weglassen. Gleiches Ereignis bei allen beteiligten Figuren identisch formulieren.
- Leere Arrays wenn nichts gefunden.`;
  }

  return `${schemaPart}

Figuren-Regeln:
${figurenBasisRules(kontext)}

Schauplatz-Regeln:
${ORTE_RULES}

${FAKTEN_RULES}

Szenen-Regeln:
- Eine Szene ist ein abgegrenzter Handlungsabschnitt mit eigenem Anfang und Ende
- seite: NUR der reine Seitentitel, OHNE die «### »-Markierung am Anfang. Aus «### Was macht Adrian?» wird «Was macht Adrian?». Wortwörtlich sonst (Gross-/Kleinschreibung, Satzzeichen). Leer lassen wenn kein passender ### Header identifizierbar. Der Kapitelname ist NIE ein gültiger Wert für seite.
- kapitel: NUR der reine Kapitelname aus dem ## Header, OHNE die «## »-Markierung.
- figuren_namen: aktiv beteiligte Figuren – Namen exakt wie im Text (vollständiger Name oder Spitzname); leeres Array wenn keine Figur beteiligt
- orte_namen: Schauplatz der Szene – exakter Name wie im Text; leeres Array wenn kein konkreter Ort erwähnt
- wertung: «stark» = überzeugend/spannend, «mittel» = verbesserungswürdig, «schwach» = klare Schwächen
- Wenn ein Abschnitt keine erkennbaren Szenen enthält (reine Exposition, Beschreibung): «szenen» als leeres Array

Ereignis-Regeln:
- typ='persoenlich': echte biografische Wendepunkte (Geburt, Tod, Trauma, neue/beendete Beziehung, Jobwechsel, Umzug, wichtige Entscheidung) – nur wenn tatsächlich im Text belegt
- typ='extern': gesellschaftliche/historische Ereignisse – SEHR GROSSZÜGIG erfassen: Kriege, politische Umbrüche, Sport- und Kulturereignisse, Wirtschaftskrisen, Seuchen, Naturkatastrophen; auch wenn nur kurz erwähnt; jedes externe Ereignis ALLEN betroffenen Figuren zuweisen
- datum: immer als vierstellige Jahreszahl (JJJJ) – aus Kontext errechnen wenn nötig; Events ohne errechenbare Jahreszahl weglassen
- figur_name: exakt wie in figuren[].name dieser Antwort (kanonischen Namen aus der Figurenliste verwenden, KEINE Textvariante, kein Titel, kein Spitzname der dort nicht steht)
- Nur Figuren ausgeben die mindestens ein Ereignis haben; leeres assignments-Array wenn keine Ereignisse gefunden`;
}

// Split-Schemas für lokale Modelle (Welle 4 · #11). Kleine Modelle werden vom kombinierten
// 5-Array-Schema überfordert. Für Ollama/llama teilen wir die Extraktion in zwei fokussierte
// Pässe auf. Claude bekommt weiterhin den kombinierten Pass.

/** Schema-Block nur für Figuren + Lebensereignisse (Pass A, Lokalmodus). */
function buildKomplettSchemaFigurenOnly(kontext = '') {
  const schemaPart = `Antworte mit diesem JSON-Schema (nur Figuren und Lebensereignisse):
{
  ${_schemaBody(FIGUREN_BASIS_SCHEMA)},
  "assignments": [
    {
      "figur_name": "Figurenname exakt wie im Text",
      "lebensereignisse": [
        {
          "datum": "JJJJ (nur Jahreszahl; aus Kontext errechnen wenn nötig; leer wenn nicht errechenbar)",
          "ereignis": "Was passierte – neutral formuliert. Gleiches Ereignis bei allen beteiligten Figuren identisch.",
          "typ": "persoenlich|extern",
          "bedeutung": "Bedeutung für diese Figur (1 Satz, leer wenn nicht klar)",
          "seite": "EXAKT ein ### Seiten-Header aus dem aktuellen ## Kapitel. NIE der Kapitelname. Leer wenn unklar.",
          "kapitel": "EXAKT der ## Kapitel-Header (nicht ###); leer wenn unklar"
        }
      ]
    }
  ]
}`;
  if (_isLocal) {
    return `${schemaPart}

Kernregeln:
- Nur Figuren erfassen, keine Orte/Szenen/Fakten.
- Eindeutige IDs (fig_1, fig_2, …); Beziehungen nur zwischen IDs dieser Liste.
- KONSERVATIV: Nur was im Text eindeutig belegt ist.
- Keine historischen/realen Personen die nur erwähnt werden.
- kapitel[].name: aus ## Header oder Prompt-Kontext. Nie Seitentitel.
- figur_name: Klarname exakt wie im Text.
- Ereignisse: datum JJJJ; ohne errechenbares Jahr weglassen.
- Leere Arrays wenn nichts gefunden.`;
  }
  return `${schemaPart}

Figuren-Regeln:
${figurenBasisRules(kontext)}

Ereignis-Regeln:
- typ='persoenlich' / typ='extern' wie oben dokumentiert.
- Nur Figuren ausgeben die mindestens ein Ereignis haben.`;
}

/** Schema-Block nur für Orte + Fakten + Szenen (Pass B, Lokalmodus). */
function buildKomplettSchemaOrteSzenen(_kontext = '') {
  const schemaPart = `Antworte mit diesem JSON-Schema (nur Schauplätze, Fakten, Szenen):
{
  ${_schemaBody(ORTE_SCHEMA)},
  ${FAKTEN_SCHEMA},
  "szenen": [
    {
      "seite": "NUR der reine Seitentitel aus einem ### Header – OHNE ###-Markierung (Beispiel: aus «### Was macht Adrian?» wird «Was macht Adrian?»). NIE der Kapitelname. Leer wenn unklar.",
      "kapitel": "NUR der reine Kapitelname aus dem ## Header – OHNE ##-Markierung. Nicht der ### Seiten-Header. Leer wenn unklar.",
      "titel": "Kurze Szenenbezeichnung (1 Satz)",
      "wertung": "stark|mittel|schwach",
      "kommentar": "1-2 Sätze: was funktioniert, was fehlt",
      "figuren_namen": ["Figurenname exakt wie im Text"],
      "orte_namen": ["Schauplatzname exakt wie im Text"]
    }
  ]
}`;
  if (_isLocal) {
    return `${schemaPart}

Kernregeln:
- Keine Figuren-Stammdaten; figuren_namen nur als Klarname-Referenz in Szenen.
- KONSERVATIV: Nur was eindeutig belegt ist.
- kapitel[].name: aus ## Header oder Prompt-Kontext, OHNE «## »-Markierung.
- Szene.seite: reiner Titel eines ### Headers aus dem aktuellen ## Kapitel, OHNE «### »-Markierung. NIE der Kapitelname. Im Zweifel leer.
- Leere Arrays wenn nichts gefunden.`;
  }
  return `${schemaPart}

Schauplatz-Regeln:
${ORTE_RULES}

${FAKTEN_RULES}

Szenen-Regeln:
- seite: NUR der reine Titel eines ### Headers im aktuellen ## Kapitel, OHNE «### »-Markierung. NIEMALS den Kapitelnamen. Bei Unklarheit: leer.
- figuren_namen: Klarnamen exakt wie im Text; leeres Array wenn keine Figur beteiligt.
- orte_namen: exakter Name wie im Text; leeres Array wenn kein konkreter Ort.`;
}

// System-Prompt-Builder mit eingebettetem Schema+Regeln-Block (für Caching der parallelen
// Kapitel-Calls über cache_control: ephemeral in lib/ai.js – spart bei ~20 Kapiteln viele
// Schema-Tokens). kontext kommt aus book_settings.buch_kontext (per-Buch-Freitext).
export function buildSystemKomplett(prefix, rules, kontext) {
  return `${prefix}\n\n${rules}\n\n${buildKomplettSchemaStatic(kontext)}${_jsonOnly()}`;
}
export function buildSystemKomplettFiguren(prefix, rules, kontext) {
  return `${prefix}\n\n${rules}\n\n${buildKomplettSchemaFigurenOnly(kontext)}${_jsonOnly()}`;
}
export function buildSystemKomplettOrteSzenen(prefix, rules, kontext) {
  return `${prefix}\n\n${rules}\n\n${buildKomplettSchemaOrteSzenen(kontext)}${_jsonOnly()}`;
}

/**
 * Kombinierter Vollextraktion-Prompt (P1 + P5 in einem Call):
 * Figuren + Schauplätze + Kontinuitätsfakten + Szenen + Lebensereignisse.
 *
 * Schema und Regeln leben im System-Prompt (SYSTEM_KOMPLETT_EXTRAKTION) – diese User-Message
 * enthält nur den Kapiteltext und den chapter-spezifischen Kapitelnamen-Hinweis.
 */
export function buildExtraktionKomplettChapterPrompt(chapterName, bookName, pageCount, chText) {
  const isSinglePass = chapterName === 'Gesamtbuch';
  const scope = isSinglePass ? `dem Buch «${bookName}»` : `dem Kapitel «${chapterName}» des Buchs «${bookName}»`;
  const kapitelNote = isSinglePass
    ? 'Der Text ist in Kapitel-Sektionen gegliedert (## Kapitelname) mit Seiten darunter (### Seitentitel). Für alle Kapitel-Felder (kapitel[].name der Figuren und Orte, szenen[].kapitel, lebensereignisse[].kapitel): den Kapitelnamen exakt aus dem ## Header entnehmen, unter dem der jeweilige Abschnitt steht.'
    : `Für alle Kapitel-Felder (kapitel[].name der Figuren und Orte, szenen[].kapitel, lebensereignisse[].kapitel): immer genau «${chapterName}» verwenden – die ### Überschriften im Text sind Seitentitel, keine Kapitelnamen.`;
  const textBlock = chText == null
    ? 'Der Buchtext steht im System-Prompt oben.'
    : `${isSinglePass ? `Buchtext (${pageCount} Seiten)` : `Kapiteltext (${pageCount} Seiten)`}:\n\n${chText}`;
  return `Extrahiere aus ${scope} in einem Durchgang: alle Figuren, alle Schauplätze, alle kontinuitätsrelevanten Fakten, alle Szenen und alle Lebensereignisse der Figuren.

${kapitelNote}

${textBlock}`;
}

/** Welle 4 · #11 – Pass A: nur Figuren + Lebensereignisse (Lokalmodus). */
export function buildExtraktionFigurenPassPrompt(chapterName, bookName, pageCount, chText) {
  const isSinglePass = chapterName === 'Gesamtbuch';
  const scope = isSinglePass ? `dem Buch «${bookName}»` : `dem Kapitel «${chapterName}» des Buchs «${bookName}»`;
  const kapitelNote = isSinglePass
    ? 'Der Text ist in Kapitel-Sektionen gegliedert (## Kapitelname) mit Seiten darunter (### Seitentitel). Für kapitel[].name und lebensereignisse[].kapitel: exakt aus dem ## Header entnehmen.'
    : `Für kapitel[].name und lebensereignisse[].kapitel: immer genau «${chapterName}» verwenden – ### Überschriften sind Seitentitel.`;
  const textBlock = chText == null
    ? 'Der Buchtext steht im System-Prompt oben.'
    : `${isSinglePass ? `Buchtext (${pageCount} Seiten)` : `Kapiteltext (${pageCount} Seiten)`}:\n\n${chText}`;
  return `Extrahiere aus ${scope} AUSSCHLIESSLICH: alle Figuren (inkl. Beziehungen) und alle Lebensereignisse der Figuren. Keine Orte, keine Fakten, keine Szenen – die werden separat extrahiert.

${kapitelNote}

${textBlock}`;
}

/** Welle 4 · #11 – Pass B: nur Orte + Fakten + Szenen (Lokalmodus). */
export function buildExtraktionOrtePassPrompt(chapterName, bookName, pageCount, chText) {
  const isSinglePass = chapterName === 'Gesamtbuch';
  const scope = isSinglePass ? `dem Buch «${bookName}»` : `dem Kapitel «${chapterName}» des Buchs «${bookName}»`;
  const kapitelNote = isSinglePass
    ? 'Der Text ist in Kapitel-Sektionen gegliedert (## Kapitelname). Für alle Kapitel-Felder den Namen aus dem ## Header entnehmen.'
    : `Für alle Kapitel-Felder: immer genau «${chapterName}» verwenden.`;
  const textBlock = chText == null
    ? 'Der Buchtext steht im System-Prompt oben.'
    : `${isSinglePass ? `Buchtext (${pageCount} Seiten)` : `Kapiteltext (${pageCount} Seiten)`}:\n\n${chText}`;
  return `Extrahiere aus ${scope} AUSSCHLIESSLICH: alle Schauplätze, alle kontinuitätsrelevanten Fakten und alle Szenen. Figuren-Stammdaten nicht – die sind separat erfasst. In Szenen nur Figurennamen als Referenz nennen.

${kapitelNote}

${textBlock}`;
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
      "figuren": [{ "id": "fig_1", "name": "Name", "typ": "hauptfigur|nebenfigur|antagonist|mentor|randfigur|andere" }]
    }
  ]
}

Regeln:
- Behalte die chronologische Reihenfolge (aufsteigend nach Jahreszahl)
- Dedupliziere figuren (gleiche id nur einmal pro Ereignis)
- kapitel: Alle Kapitel der zusammengeführten Ereignisse beibehalten (Union der Arrays, Duplikate entfernen)
- seiten: Alle Seiten der zusammengeführten Ereignisse beibehalten (Union der Arrays, Duplikate entfernen)
- Ereignisse verschiedener Figuren zum gleichen Datum die denselben realen Vorfall beschreiben (z.B. Geburt, Heirat, Tod, Unfall, Krieg) MÜSSEN zusammengeführt werden – auch wenn die Formulierungen leicht abweichen. Führe alle beteiligten Figuren im figuren-Array zusammen.
- Nur bei inhaltlich klar verschiedenen Vorfällen trennen

Ereignisse:
${JSON.stringify(events, null, 2)}`;
}

export function buildLocationsConsolidationPrompt(bookName, chapterOrte, figurenKompakt) {
  const synthInput = chapterOrte.map(co =>
    `## Kapitel: ${co.kapitel}\n` + co.orte.map(o =>
      `- ${o.name} (${o.typ || 'andere'}): ${o.beschreibung || ''}` +
      (o.stimmung ? ` | Stimmung: ${o.stimmung}` : '') +
      (o.kapitel?.length ? ` | Kapitel: ` + o.kapitel.map(k => k.name + (k.haeufigkeit > 1 ? ' ×' + k.haeufigkeit : '')).join(', ') : '')
    ).join('\n')
  ).join('\n\n');
  const figurenStr = figurenKompakt && figurenKompakt.length
    ? '\n\nBekannte Figuren (nur diese IDs in «figuren» verwenden):\n' + figurenKompakt.map(f => `${f.id}: ${f.name}`).join('\n')
    : '';
  return `Konsolidiere die folgenden Schauplatz-Analysen aller Kapitel des Buchs «${bookName}» zu einer einheitlichen Gesamtliste. Dedupliziere, führe Informationen zusammen und vergib stabile IDs.${figurenStr}

Kapitelanalysen:

${synthInput}

Antworte mit diesem JSON-Schema:
${ORTE_SCHEMA}

${ORTE_RULES}`;
}

// ── Kontinuitätsprüfung ───────────────────────────────────────────────────────

export function buildKontinuitaetChapterFactsPrompt(chapterName, chText) {
  return `Extrahiere alle konkreten Fakten und Behauptungen aus dem Kapitel «${chapterName}» die für die Kontinuitätsprüfung relevant sind: Figuren-Zustände (lebendig/tot, Verletzungen, Wissen, Beziehungen), Ortsbeschreibungen, Zeitangaben, Objekte und deren Besitz/Zustand, sowie wichtige Handlungsereignisse.

Antworte mit diesem JSON-Schema:
{
  ${FAKTEN_SCHEMA}
}

${FAKTEN_RULES}

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

Prüfe zusätzlich die Soziolekt-Kohärenz: Spricht jede Figur konsistent mit der Herkunft, Bildung und sozialen Schicht, die in früheren Kapiteln durch ihren Soziolekt etabliert wurde? Registerwechsel (z.B. plötzlich formal statt umgangssprachlich, plötzlich Dialekt statt Hochsprache) die sich nicht durch die Situation oder dramaturgischen Kontext erklären lassen, sind Kontinuitätsfehler. Typ «soziolekt» verwenden.

Antworte mit diesem JSON-Schema:
${PROBLEME_SCHEMA}

${PROBLEME_RULES}`;
}

export function buildKontinuitaetSinglePassPrompt(bookName, bookText, figurenKompakt, orteKompakt, { erzaehlperspektive = null, erzaehlzeit = null, buchtyp = null } = {}) {
  const figurenStr = figurenKompakt && figurenKompakt.length
    ? '\n\n## Bekannte Figuren\n' + figurenKompakt.map(f => `${f.name} (${f.typ || ''}): ${f.beschreibung || ''}`).join('\n')
    : '';
  const orteStr = orteKompakt && orteKompakt.length
    ? '\n\n## Bekannte Schauplätze\n' + orteKompakt.map(o => `${o.name} (${o.typ || 'andere'}): ${o.beschreibung || ''}`).join('\n')
    : '';
  const povBlock = _buildErzaehlformBlock(erzaehlperspektive, erzaehlzeit, buchtyp, 'review');
  const erzaehlformHint = (erzaehlperspektive || erzaehlzeit) && buchtyp !== 'kurzgeschichten'
    ? ' Erzählform-Brüche: Kapitel oder Passagen, die die oben angegebene Erzählperspektive oder Erzählzeit unbegründet verlassen (Wechsel nur an Szenen-/Kapitelgrenzen oder bei expliziten Rückblenden zulässig) – typ «sonstiges», Beschreibung: «Erzählform-Bruch: …».'
    : '';

  const textBlock = bookText == null
    ? 'Der Buchtext steht im System-Prompt oben.'
    : `Buchtext:\n\n${bookText}`;
  return `Prüfe das Buch «${bookName}» auf Kontinuitätsfehler und Widersprüche.${figurenStr}${orteStr}
${povBlock}
Suche aktiv nach: Figuren die nach ihrem Tod wieder auftauchen; Orte die sich widersprüchlich beschrieben werden; Zeitangaben die nicht vereinbar sind; Objekte die falsch verwendet werden; Figuren die Wissen haben das sie noch nicht haben könnten; Charakterverhalten das ihrer etablierten Persönlichkeit widerspricht; Soziolekt-Brüche: Figuren die plötzlich anders sprechen als durch ihre Herkunft, Bildung und soziale Schicht etabliert (Registerwechsel ohne dramaturgische Begründung).${erzaehlformHint}

${textBlock}

Antworte mit diesem JSON-Schema:
${PROBLEME_SCHEMA}

${PROBLEME_RULES}`;
}

// ═════════════════════════════════════════════════════════════════════════════
// JSON-Schemas für Grammar-Constrained Decoding (lokale Provider)
// ═════════════════════════════════════════════════════════════════════════════
// Beziehungs-Items: für lokale Provider wird `machtverhaltnis` absichtlich aus dem
// JSON-Schema weggelassen – kleine Modelle setzen es fast immer 0 oder halluzinieren.
// Lieber das Feld leer lassen als falsche Werte anzeigen. Für Claude bleibt es erhalten.

const _bzBeleg = _obj({ kapitel: _str, seite: _str });
const _bzItem = () => _obj(_isLocal
  ? { figur_id: _str, typ: _str, beschreibung: _str, belege: { type: 'array', items: _bzBeleg } }
  : { figur_id: _str, typ: _str, machtverhaltnis: _num, beschreibung: _str, belege: { type: 'array', items: _bzBeleg } }
);

const _figurSchemaProps = () => ({
  id: _str,
  name: _str,
  kurzname: _str,
  typ: _str,
  geburtstag: _str,
  geschlecht: _str,
  beruf: _str,
  wohnadresse: _str,
  rolle: _str,
  motivation: _str,
  konflikt: _str,
  beschreibung: _str,
  sozialschicht: _str,
  praesenz: { type: 'string', enum: ['zentral', 'regelmaessig', 'punktuell', 'randfigur'] },
  entwicklung: _str,
  erste_erwaehnung: _str,
  schluesselzitate: { type: 'array', items: _str },
  eigenschaften: { type: 'array', items: _str },
  kapitel: { type: 'array', items: _obj({ name: _str, haeufigkeit: _num }) },
  beziehungen: { type: 'array', items: _bzItem() },
});

// _figurSchema und alle abgeleiteten Schemas werden in _rebuildKomplettSchemas() bei jedem
// configurePrompts-Aufruf neu gebaut, damit der dynamisch gesetzte _isLocal-Flag korrekt
// wirkt (z.B. machtverhaltnis-Weglassen).
let _figurSchema = _obj(_figurSchemaProps());

const _ortSchema = _obj({
  id: _str,
  name: _str,
  typ: _str,
  beschreibung: _str,
  erste_erwaehnung: _str,
  stimmung: _str,
  kapitel: { type: 'array', items: _obj({ name: _str, haeufigkeit: _num }) },
  figuren: { type: 'array', items: _str },
});

const _faktSchema = _obj({ kategorie: _str, subjekt: _str, fakt: _str, seite: _str });

export let SCHEMA_KOMPLETT_EXTRAKTION = null;
export let SCHEMA_KOMPLETT_FIGUREN_PASS = null;
export let SCHEMA_KOMPLETT_ORTE_PASS = null;
export let SCHEMA_FIGUREN_KONSOL = null;
export let SCHEMA_BEZIEHUNGEN = null;

function _szenenField() {
  return {
    type: 'array',
    items: _obj({
      seite: _str,
      kapitel: _str,
      titel: _str,
      wertung: { type: 'string', enum: ['stark', 'mittel', 'schwach'] },
      kommentar: _str,
      figuren_namen: { type: 'array', items: _str },
      orte_namen: { type: 'array', items: _str },
    }),
  };
}

function _assignmentsField() {
  return {
    type: 'array',
    items: _obj({
      figur_name: _str,
      lebensereignisse: {
        type: 'array',
        items: _obj({
          datum: _str,
          ereignis: _str,
          typ: { type: 'string', enum: ['persoenlich', 'extern'] },
          bedeutung: _str,
          seite: _str,
          kapitel: _str,
        }),
      },
    }),
  };
}

function _buildExtraktionSchema() {
  return _obj({
    figuren: { type: 'array', items: _figurSchema },
    orte: { type: 'array', items: _ortSchema },
    fakten: { type: 'array', items: _faktSchema },
    szenen: _szenenField(),
    assignments: _assignmentsField(),
  });
}

function _buildFigurenPassSchema() {
  return _obj({
    figuren: { type: 'array', items: _figurSchema },
    assignments: _assignmentsField(),
  });
}

function _buildOrtePassSchema() {
  return _obj({
    orte: { type: 'array', items: _ortSchema },
    fakten: { type: 'array', items: _faktSchema },
    szenen: _szenenField(),
  });
}

function _buildBeziehungenSchema() {
  const belegeField = { belege: { type: 'array', items: _bzBeleg } };
  const props = _isLocal
    ? { von: _str, zu: _str, typ: _str, beschreibung: _str, ...belegeField }
    : { von: _str, zu: _str, typ: _str, machtverhaltnis: _num, beschreibung: _str, ...belegeField };
  return _obj({ beziehungen: { type: 'array', items: _obj(props) } });
}

export function _rebuildKomplettSchemas() {
  _figurSchema = _obj(_figurSchemaProps());
  SCHEMA_KOMPLETT_EXTRAKTION = _buildExtraktionSchema();
  SCHEMA_KOMPLETT_FIGUREN_PASS = _buildFigurenPassSchema();
  SCHEMA_KOMPLETT_ORTE_PASS = _buildOrtePassSchema();
  SCHEMA_FIGUREN_KONSOL = _obj({ figuren: { type: 'array', items: _figurSchema } });
  SCHEMA_BEZIEHUNGEN = _buildBeziehungenSchema();
}

_rebuildKomplettSchemas();

// ── Statische Schemas (nicht _isLocal-abhängig) ──────────────────────────────

export const SCHEMA_ORTE_KONSOL = _obj({ orte: { type: 'array', items: _ortSchema } });

export const SCHEMA_SOZIOGRAMM_KONSOL = _obj({
  figuren:     { type: 'array', items: _obj({ id: _str, sozialschicht: _str }) },
  beziehungen: { type: 'array', items: _obj({ from_fig_id: _str, to_fig_id: _str, machtverhaltnis: _num }) },
});

export const SCHEMA_ZEITSTRAHL = _obj({
  ereignisse: {
    type: 'array',
    items: _obj({
      datum: _str,
      ereignis: _str,
      typ: { type: 'string', enum: ['persoenlich', 'extern'] },
      bedeutung: _str,
      kapitel: { type: 'array', items: _str },
      seiten: { type: 'array', items: _str },
      figuren: { type: 'array', items: _obj({ id: _str, name: _str, typ: _str }) },
    }),
  },
});

export const SCHEMA_KONTINUITAET_FAKTEN = _obj({
  fakten: { type: 'array', items: _faktSchema },
});

export const SCHEMA_KONTINUITAET_PROBLEME = _obj({
  probleme: {
    type: 'array',
    items: _obj({
      schwere: { type: 'string', enum: ['kritisch', 'mittel', 'niedrig'] },
      typ: _str,
      beschreibung: _str,
      stelle_a: _str,
      stelle_b: _str,
      figuren: { type: 'array', items: _str },
      kapitel: { type: 'array', items: _str },
      empfehlung: _str,
    }),
  },
  zusammenfassung: _str,
});
