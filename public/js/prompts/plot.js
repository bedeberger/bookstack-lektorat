// Plot-Werkstatt (Beat-Board): planende KI-Assistenz für die Handlungsskizze.
// Zwei Job-Typen — beide rein planend/überwachend, NIE generativ in den Text:
//   - Brainstorm:   schlägt Beats (Handlungspunkte) für einen Akt vor.
//   - Consistency:  prüft den geplanten Plot gegen die Buchrealität
//                   (archivierte Akte = abgeschlossen: Kontext, kein Arbeitsziel)
//                   (Kapitel + extrahierte Szenen + Figuren) und meldet
//                   Brüche, Lücken und „geplant vs. schon geschrieben"-Drift.
//
// Severity-Vokabular: kritisch/stark/mittel/schwach/niedrig — matcht
// .severity-tag--* in DESIGN.md (gleiche Skala wie die Figuren-Werkstatt).

import { _obj, _str } from './schema-utils.js';
import { _jsonOnly } from './state.js';

const SEVERITY_ENUM = ['kritisch', 'stark', 'mittel', 'schwach', 'niedrig'];

const STATUS_LABEL = {
  geplant: 'geplant',
  im_buch: 'im Buch',
};

// ── Hilfen ───────────────────────────────────────────────────────────────────

// Kompakte Board-Übersicht: Akte als Spalten, Beats darunter mit Status + Kapitel.
// threadInfo (optional): Map id→{name, figur, kapitel}; existieren Stränge, wird je
// Beat der Strang annotiert. Vererbung (live): ein Beat ohne eigenes Kapitel erbt
// das Strang-Kapitel (als „(vom Strang)" markiert); die Strang-Hauptfigur gilt
// implizit als beteiligt (Regel-Hinweis im Prompt, hier nicht pro Beat wiederholt).
// Textbeleg-Marker eines Beats (nur Consistency, wenn ein befüllter Verankerungs-
// Index vorliegt): ob/wo der Beat semantisch im ECHTEN Manuskript auftaucht.
// Nur „im Buch"-Beats werden verankert — „im Buch" ohne Beleg = Drift-Signal.
// Geplante/verworfene Beats tragen keinen Marker (sie werden nicht durchsucht).
// Ähnlichkeit, kein Beweis — die KI urteilt am Ausschnitt.
function _beatAnchorMarker(beat, anchorMap) {
  if (!anchorMap || beat.verworfen || beat.status !== 'im_buch') return '';
  const a = anchorMap[beat.id];
  const has = a && a.count > 0;
  if (!has) return ' ⟨KEIN Textbeleg im Manuskript gefunden⟩';
  const wo = (n) => (a.top || []).slice(0, n)
    .map(t => t.page_name || (t.scene_titel ? `Szene „${t.scene_titel}"` : null))
    .filter(Boolean).join(', ');
  const snip = a.top[0] && a.top[0].snippet ? `: „${_trunc(a.top[0].snippet, 120)}"` : '';
  return ` ⟨Textbeleg ${wo(2)}${snip}⟩`;
}

function _boardOutline(acts, beats, threadInfo = null, anchorMap = null) {
  return (acts || []).map(act => {
    const own = (beats || [])
      .filter(b => b.act_id === act.id)
      .map(b => {
        const st = (STATUS_LABEL[b.status] || b.status) + (b.verworfen ? ', verworfen' : '');
        const info = threadInfo && b.thread_id != null ? threadInfo[b.thread_id] : null;
        const kap = b.chapter_name
          ? ` → Kapitel: ${b.chapter_name}`
          : (info && info.kapitel ? ` → Kapitel: ${info.kapitel} (vom Strang)` : '');
        const str = info ? ` {Strang: ${info.name}}` : '';
        // Stabile Beat-ID als [#id]-Marker voranstellen: der Consistency-Check gibt
        // sie in `beat_id` zurück, sodass ein Befund seinen Beat auch nach einer
        // Umbenennung noch trifft (Titel-Match wäre sonst der einzige Anker).
        return `  - [#${b.id}] ${b.titel} [${st}]${kap}${str}${_beatAnchorMarker(b, anchorMap)}`;
      });
    // Hybrid-Akte: ein Akt kann GETEILT sein (alle Stränge) oder einem Strang
    // EIGEN gehören (thread_id). Eigene Akte ausweisen, damit die KI versteht,
    // dass dieser Strang eine unabhängige Aktstruktur hat (kein „fehlt"-Befund).
    const owner = act.thread_id != null && threadInfo ? threadInfo[act.thread_id] : null;
    // Archivierter Akt: von der Autorin als abgeschlossen erklaert (Beats sind ins
    // Manuskript eingearbeitet). Bleibt im Outline, weil Kausalitaets- und
    // Setup/Payoff-Ketten hineinreichen — wird aber als erledigt gekennzeichnet.
    const scope = owner ? `eigener Akt von Strang „${owner.name}"` : 'geteilt';
    const arch = act.archiviert ? ', ARCHIVIERT: von der Autorin als abgeschlossen erklärt' : '';
    return `AKT (${scope}${arch}): ${act.name}\n${own.length ? own.join('\n') : '  (noch keine Beats)'}`;
  }).join('\n\n');
}

// Gibt es archivierte (abgeschlossene) Akte? Dann braucht der Prompt den Hinweis,
// wie er sie behandeln soll — sonst produziert er dort Befunde, die die Autorin
// bewusst zugeklappt hat.
function _hasArchivedActs(acts) {
  return (acts || []).some(a => a && a.archiviert);
}

// Haben Stränge eine eigene Aktstruktur (Hybrid)? Dann lohnt der Erklär-Hinweis,
// dass geteilte und strang-eigene Akte nebeneinander existieren.
function _hasOwnActs(acts) {
  return (acts || []).some(a => a && a.thread_id != null);
}

// Handlungsstränge (Swimlanes) als Block: Name + optional gebundene Hauptfigur +
// gebundenes Kapitel. Beats der Lane erben Figur + Kapitel implizit.
function _straengeLines(threads) {
  return (threads || []).slice(0, 40)
    .map(t => {
      const fig = t.figur ? ` (Hauptfigur: ${t.figur})` : '';
      const kap = t.kapitel ? ` (Kapitel: ${t.kapitel})` : '';
      return `- ${t.name}${fig}${kap}`;
    })
    .join('\n');
}

// Lookup id→{name, figur, kapitel} aus der Stränge-Liste (Board-Annotation inkl.
// Kapitel-Vererbung).
function _threadInfoMap(threads) {
  const map = {};
  for (const t of (threads || [])) if (t && t.id != null) map[t.id] = { name: t.name, figur: t.figur || null, kapitel: t.kapitel || null };
  return map;
}

// Hat irgendein Strang eine gebundene Hauptfigur oder ein Kapitel? Dann lohnt der
// Vererbungs-Hinweis im Prompt.
function _hasThreadInheritance(threads) {
  return (threads || []).some(t => t && (t.figur || t.kapitel));
}

function _trunc(s, max = 280) {
  const t = (s || '').trim().replace(/\s+/g, ' ');
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// Beziehungen einer Figur (Soziogramm): „Partner (Typ)". `mit` ist bereits ein
// aufgelöster Name (der Job übersetzt die fig_id vor dem Prompt-Bau).
function _relLine(beziehungen) {
  const rels = (beziehungen || []).filter(b => b && b.mit).slice(0, 12);
  if (!rels.length) return '';
  return `\n  Beziehungen: ${rels.map(b => `${b.mit}${b.typ ? ` (${b.typ})` : ''}`).join('; ')}`;
}

// Lebensereignisse einer Figur (Figuren-Zeitstrahl): „Datum: Ereignis [Kapitel]".
function _eventsLine(lebensereignisse) {
  const evs = (lebensereignisse || []).filter(e => e && e.ereignis).slice(0, 10);
  if (!evs.length) return '';
  return `\n  Ereignisse: ${evs.map(e => `${e.datum ? `${e.datum}: ` : ''}${e.ereignis}${e.kapitel ? ` [${e.kapitel}]` : ''}`).join(' · ')}`;
}

// Detaillierter Figuren-Block für BEIDE Jobs: Name + Kurzname, Rollen-Meta
// (Typ/Beruf/Geschlecht), Tags, gekürzte Beschreibung und — sofern vorhanden —
// Beziehungen (Soziogramm) + Lebensereignisse (Zeitstrahl). So kann die KI Beats
// auf konkrete Figurenprofile, ihr Beziehungsgeflecht und ihre Chronologie
// zuschneiden statt nur auf Namen.
function _figurenLinesDetail(figuren) {
  return (figuren || []).slice(0, 120)
    .map(f => {
      const meta = [f.typ, f.beruf, f.geschlecht].filter(Boolean).join(', ');
      const head = `- ${f.name}${f.kurzname ? ` („${f.kurzname}")` : ''}${meta ? ` [${meta}]` : ''}`;
      const besch = f.beschreibung ? `\n  ${_trunc(f.beschreibung)}` : '';
      const tags = (f.tags || []).length ? `\n  Tags: ${f.tags.join(', ')}` : '';
      return `${head}${besch}${tags}${_relLine(f.beziehungen)}${_eventsLine(f.lebensereignisse)}`;
    })
    .join('\n');
}

// Schauplätze des Buchs: Name + Typ/Stimmung + gekürzte Beschreibung.
function _orteLines(orte) {
  return (orte || []).slice(0, 60)
    .map(o => {
      const meta = [o.typ, o.stimmung].filter(Boolean).join(', ');
      const besch = o.beschreibung ? `: ${_trunc(o.beschreibung, 160)}` : '';
      return `- ${o.name}${meta ? ` [${meta}]` : ''}${besch}`;
    })
    .join('\n');
}

// Buchweiter Figuren-Zeitstrahl (figure_events, chronologisch): „Datum — Ereignis
// (Figur) [Kapitel]". Grundlage für Chronologie-Prüfungen im Consistency-Check.
function _zeitstrahlLines(zeitstrahl) {
  return (zeitstrahl || []).slice(0, 200)
    .map(e => {
      const d = e.datum ? `${e.datum} — ` : '';
      const fig = e.figur ? ` (${e.figur})` : '';
      const kap = e.kapitel ? ` [${e.kapitel}]` : '';
      return `- ${d}${e.ereignis}${fig}${kap}`;
    })
    .join('\n');
}

// Bekannte (offene) Kontinuitäts-Befunde aus dem letzten Continuity-Check.
function _kontinuitaetLines(issues) {
  return (issues || []).slice(0, 40)
    .map(i => {
      const sev = i.schwere ? `[${i.schwere}] ` : '';
      const figs = (i.figuren || []).length ? ` (Figuren: ${i.figuren.join(', ')})` : '';
      const kap = (i.kapitel || []).length ? ` [${i.kapitel.join(', ')}]` : '';
      const emp = i.empfehlung ? `\n  Empfehlung: ${i.empfehlung}` : '';
      return `- ${sev}${i.beschreibung}${figs}${kap}${emp}`;
    })
    .join('\n');
}

// Verknüpfte Recherche-Fundstücke: Titel + gekürzter Inhalt + Quelle + an welche
// Beats/Stränge sie der Autor geknüpft hat. Erdet Brainstorm/Consistency auf das
// gesammelte Material (Fakten, Quellen) — rückwärtsgewandt, NIE generativ: der
// Inhalt darf weder zitiert noch als Prosa in einen Beat übernommen werden.
function _rechercheLines(recherche) {
  return (recherche || []).slice(0, 60)
    .map(r => {
      const anchor = [...(r.beats || []), ...(r.threads || [])];
      const an = anchor.length ? ` {zu: ${anchor.join(', ')}}` : '';
      const head = (r.title || '').trim() || '(ohne Titel)';
      const body = r.body ? `: ${_trunc(r.body, 240)}` : '';
      const src = r.source ? ` (Quelle: ${_trunc(r.source, 80)})` : '';
      return `- ${head}${body}${src}${an}`;
    })
    .join('\n');
}

// Werkstatt-Figuren (Figuren-Werkstatt-Drafts): in Entwicklung, evtl. noch nicht
// im Manuskript. Name + optionaler Archetyp + — sofern in der Mindmap ausgearbeitet
// — die psychologischen Kerne (Want/Need/Wound/Lie + Bogen + Konflikt). So kann der
// Plot Beats auf den inneren Konflikt der Figur zuschneiden, statt nur auf den Namen.
function _werkstattFigurenLines(figuren) {
  return (figuren || []).slice(0, 60)
    .map(f => {
      const head = `- ${f.name}${f.archetype ? ` [${f.archetype}]` : ''}`;
      const p = f.psychologie;
      if (!p) return head;
      const parts = [];
      if ((p.want || []).length)     parts.push(`Will: ${_trunc(p.want.join('; '), 160)}`);
      if ((p.need || []).length)     parts.push(`Braucht: ${_trunc(p.need.join('; '), 160)}`);
      if ((p.wound || []).length)    parts.push(`Wunde: ${_trunc(p.wound.join('; '), 160)}`);
      if ((p.lie || []).length)      parts.push(`Lüge: ${_trunc(p.lie.join('; '), 160)}`);
      if ((p.bogen || []).length)    parts.push(`Bogen: ${_trunc(p.bogen.join(' → '), 200)}`);
      if ((p.konflikt || []).length) parts.push(`Konflikt: ${_trunc(p.konflikt.join('; '), 160)}`);
      return parts.length ? `${head}\n  ${parts.join(' · ')}` : head;
    })
    .join('\n');
}

function _kapitelLines(kapitel) {
  return (kapitel || []).slice(0, 200)
    .map((k, i) => `${i + 1}. ${k}`)
    .join('\n');
}

// Kuratierte Phrasen für die gerichteten Beat-Beziehungen (from --typ--> to).
// Freitext-Typen fallen auf „<typ> →" zurück (analog figure_relations).
const REL_PHRASE = {
  'bereitet-vor': 'bereitet vor →',
  'zahlt-ein': 'zahlt ein auf →',
  'fuehrt-zu': 'führt zu →',
  'motiviert': 'motiviert →',
  'blockiert': 'blockiert →',
  'spiegelt': 'spiegelt →',
};

// Beat-zu-Beat-Beziehungen (Kausalität + Setup/Payoff): „«From» <Phrase> «To»".
// Erdet den Consistency-Check auf die vom Autor explizit gezogenen Kanten, statt
// Kausalität nur aus der Prosa raten zu müssen.
function _relationsLines(relations) {
  return (relations || []).slice(0, 120)
    .filter(r => r && r.from_titel && r.to_titel)
    .map(r => `- «${r.from_titel}» ${REL_PHRASE[r.typ] || `${r.typ} →`} «${r.to_titel}»`)
    .join('\n');
}

// Szenen als „Buchrealität": Titel — Kapitel — beteiligte Figuren.
function _szenenLines(szenen) {
  return (szenen || []).slice(0, 150)
    .map(s => {
      const kap = s.kapitel ? ` — ${s.kapitel}` : '';
      const figs = (s.figuren || []).length ? ` (${s.figuren.join(', ')})` : '';
      return `- ${s.titel}${kap}${figs}`;
    })
    .join('\n');
}

// Weltgesetze (world_facts, Kategorien regel/technik): die etablierten Regeln der
// Buchwelt. Anders als Szenen/Textbelege sagen sie nicht, WAS geschrieben ist,
// sondern was in dieser Welt GILT — der einzige Kontext, an dem sich ein geplanter
// Beat als unmoeglich erweisen kann.
function _weltgesetzeLines(weltgesetze) {
  return (weltgesetze || []).slice(0, 90)
    .filter(w => w && w.fakt)
    .map(w => {
      const subj = w.subjekt ? `${w.subjekt}: ` : '';
      const kap = (w.kapitel || []).length ? ` (etabliert in ${w.kapitel.slice(0, 3).join(', ')})` : '';
      return `- [${w.kategorie || 'regel'}] ${subj}${String(w.fakt).trim()}${kap}`;
    })
    .join('\n');
}

// ── System-Prompt ────────────────────────────────────────────────────────────
// Self-contained (keine Locale-Config-Abhängigkeit): Rolle + JSON-Only-Pflicht.

export function buildPlotSystemPrompt() {
  return `Du bist ein erfahrener Dramaturg und Lektor. Du hilfst der Autorin, die HANDLUNG (Plot) ihres Buches zu PLANEN und zu strukturieren — als Beat-Board aus Akten (Spalten) und Beats (einzelnen Handlungspunkten).

WICHTIG: Du planst und prüfst nur die STRUKTUR. Du schreibst NIEMALS Fliesstext, Szenen oder Prosa ins Manuskript. Deine Beats sind kurze, strukturelle Stichpunkte — keine ausformulierten Textpassagen.${_jsonOnly()}`;
}

// ── Brainstorm ──────────────────────────────────────────────────────────────
// Schlägt 3–7 Beats für einen bestimmten Akt vor, passend zum bisherigen Board,
// Buchkontext und Figuren-Ensemble.

export function buildPlotBrainstormPrompt(aktName, acts, beats, buchKontext, figuren = [], kapitel = [], werkstattFiguren = [], threads = [], threadInfo = null, orte = [], zeitstrahl = [], recherche = []) {
  const ctxSeg = (buchKontext || '').trim() ? `\nBUCH-KONTEXT:\n${buchKontext}\n` : '';
  const figLines = _figurenLinesDetail(figuren);
  const figSeg = figLines ? `\nFIGUREN-ENSEMBLE:\n${figLines}\n` : '';
  const wfLines = _werkstattFigurenLines(werkstattFiguren);
  const wfSeg = wfLines ? `\nFIGUREN-WERKSTATT (in Entwicklung, evtl. noch nicht im Manuskript — als Beat-Figuren nutzbar; wo vorhanden mit innerem Konflikt Will/Braucht/Wunde/Lüge + Bogen):\n${wfLines}\n` : '';
  const kapLines = _kapitelLines(kapitel);
  const kapSeg = kapLines ? `\nVORHANDENE KAPITEL (chronologisch):\n${kapLines}\n` : '';
  const orteLines = _orteLines(orte);
  const orteSeg = orteLines ? `\nSCHAUPLÄTZE (Orte des Buchs):\n${orteLines}\n` : '';
  const zeitLines = _zeitstrahlLines(zeitstrahl);
  const zeitSeg = zeitLines ? `\nZEITSTRAHL (chronologische Ereignisse der Figuren):\n${zeitLines}\n` : '';
  const rechLines = _rechercheLines(recherche);
  const rechSeg = rechLines ? `\nVERKNÜPFTE RECHERCHE (vom Autor zu diesem Akt gesammeltes Material — Fakten/Quellen, die die Beats erden sollen; verwende sie als Hintergrund, übernimm sie NICHT als Prosa und zitiere sie nicht):\n${rechLines}\n` : '';
  const strLines = _straengeLines(threads);
  const inheritNote = _hasThreadInheritance(threads)
    ? '\nVERERBUNG: Ein Beat in einem Strang beteiligt IMPLIZIT dessen Hauptfigur; hat er kein eigenes Kapitel, gilt das Kapitel des Strangs. Behandle das als gesetzt, auch wenn es nicht pro Beat wiederholt wird.\n'
    : '';
  const strSeg = strLines ? `\nHANDLUNGSSTRÄNGE (Swimlanes — parallele Erzähllinien, oft je Hauptfigur):\n${strLines}\n${inheritNote}` : '';

  // Zielzelle: bei gesetztem Strang sind „bereits vorhandene Beats" die der Zelle
  // (Akt × Strang); sonst akt-weit.
  const existing = (beats || [])
    .filter(b => acts.find(a => a.id === b.act_id && a.name === aktName))
    .filter(b => !threadInfo || (b.thread_id ?? null) === (threadInfo.id ?? null))
    .map(b => `- ${b.titel}`);
  const existSeg = existing.length
    ? `\nBEREITS VORHANDENE BEATS ${threadInfo ? 'IN DIESER ZELLE' : 'IN DIESEM AKT'} (NICHT wiederholen):\n${existing.join('\n')}\n`
    : '';

  const threadGoal = threadInfo
    ? `\nZIEL-STRANG: "${threadInfo.name}"${threadInfo.figur ? ` (Hauptfigur: ${threadInfo.figur})` : ''}${threadInfo.kapitel ? ` (Kapitel: ${threadInfo.kapitel})` : ''}\nDie Beats sollen GENAU diesen Erzählstrang vorantreiben${threadInfo.figur ? ` und ${threadInfo.figur} ins Zentrum stellen` : ''}${threadInfo.kapitel ? ` (sie spielen im Kapitel „${threadInfo.kapitel}", sofern nicht anders nötig)` : ''} — nicht die anderen Stränge.\n`
    : '';

  return `Die Autorin skizziert die Handlung ihres Buches als Beat-Board und braucht 3–7 prägnante neue Beats (Handlungspunkte) für den Akt "${aktName}"${threadInfo ? ` im Strang "${threadInfo.name}"` : ''}.

AKTUELLES BOARD:
${_boardOutline(acts, beats, _threadInfoMap(threads))}
${ctxSeg}${figSeg}${wfSeg}${kapSeg}${orteSeg}${zeitSeg}${rechSeg}${strSeg}${threadGoal}${existSeg}
ZIEL-AKT: "${aktName}"

Liefere 3–7 konkrete, voneinander unterscheidbare Beat-Vorschläge für diesen Akt${threadInfo ? ' + Strang' : ''}. Jeder Beat:
- 3–10 Wörter im Label (kurz, dramaturgisch konkret: Wendepunkt, Konflikt, Entscheidung, Enthüllung — kein vager Themen-Begriff)
- Knappe Begründung (1 Satz), warum der Beat an dieser Stelle die Handlung trägt und zum Ensemble passt
- Baut auf den vorhandenen Beats auf und treibt die Spannungskurve voran
- Bedient ein Beat eine beteiligte Werkstatt-Figur, soll er ihren inneren Konflikt (Will/Braucht/Wunde/Lüge) oder Bogen vorantreiben — nicht nur äusserlich funktionieren
- Keine Wiederholung bestehender Beats
- Keine ausformulierte Prosa — nur die strukturelle Idee

Antworte mit diesem JSON-Schema:
{
  "vorschlaege": [
    { "label": "kurzer Beat", "begruendung": "1 Satz" }
  ]
}`;
}

export const SCHEMA_PLOT_BRAINSTORM = _obj({
  vorschlaege: {
    type: 'array',
    items: _obj({ label: _str, begruendung: _str }),
  },
});

// ── Consistency-Check ─────────────────────────────────────────────────────────
// Prüft den geplanten Plot gegen die Buchrealität: extrahierte Szenen + Kapitel +
// Figuren. Findet Brüche, Lücken und „geplant vs. schon geschrieben"-Drift.

export function buildPlotConsistencyPrompt(acts, beats, kapitel = [], szenen = [], figuren = [], buchKontext = '', werkstattFiguren = [], threads = [], orte = [], zeitstrahl = [], kontinuitaet = [], recherche = [], anchorMap = null, anchorInfo = {}, relations = [], weltgesetze = []) {
  const ctxSeg = (buchKontext || '').trim() ? `\nBUCH-KONTEXT:\n${buchKontext}\n` : '';
  const kapLines = _kapitelLines(kapitel);
  const kapSeg = kapLines ? `\nKAPITEL DES BUCHS (chronologisch):\n${kapLines}\n` : '';
  const szLines = _szenenLines(szenen);
  const szSeg = szLines
    ? `\nIM BUCH VORHANDENE SZENEN (aus der Analyse, = „Buchrealität"):\n${szLines}\n`
    : '\nHINWEIS: Es liegen noch keine analysierten Szenen vor (Komplettanalyse evtl. nicht gelaufen). Prüfe den Plot dann primär gegen die Kapitelstruktur.\n';
  const figLines = _figurenLinesDetail(figuren);
  const figSeg = figLines ? `\nFIGUREN-ENSEMBLE:\n${figLines}\n` : '';
  const orteLines = _orteLines(orte);
  const orteSeg = orteLines ? `\nSCHAUPLÄTZE (Orte des Buchs):\n${orteLines}\n` : '';
  const zeitLines = _zeitstrahlLines(zeitstrahl);
  const zeitSeg = zeitLines ? `\nZEITSTRAHL (chronologische Ereignisse der Figuren, = Buchrealität):\n${zeitLines}\n` : '';
  const kontiLines = _kontinuitaetLines(kontinuitaet);
  const kontiSeg = kontiLines ? `\nBEKANNTE KONTINUITÄTS-BEFUNDE (offen, aus dem letzten Continuity-Check — beziehe sie ein, dopple sie aber nicht):\n${kontiLines}\n` : '';
  const rechLines = _rechercheLines(recherche);
  const rechSeg = rechLines ? `\nVERKNÜPFTE RECHERCHE (vom Autor zu Beats/Strängen gesammeltes Material — Fakten/Quellen als Realitätsanker):\n${rechLines}\n` : '';
  const wfLines = _werkstattFigurenLines(werkstattFiguren);
  const wfSeg = wfLines ? `\nFIGUREN-WERKSTATT (geplante/in Entwicklung befindliche Figuren — Beats dürfen sie referenzieren, ohne dass sie schon im Manuskript stehen müssen):\n${wfLines}\n` : '';
  const strLines = _straengeLines(threads);
  const inheritNote = _hasThreadInheritance(threads)
    ? '\nVERERBUNG: Ein Beat in einem Strang beteiligt IMPLIZIT dessen Hauptfigur; hat er kein eigenes Kapitel, gilt das Kapitel des Strangs (im Board als „(vom Strang)" markiert). Beanstande einen Beat NICHT als „Figur fehlt"/„Kapitel fehlt", wenn der Strang sie liefert.\n'
    : '';
  const strSeg = strLines ? `\nHANDLUNGSSTRÄNGE (Swimlanes — parallele Erzähllinien, oft je Hauptfigur; im Board hinter den Beats als {Strang: …} annotiert):\n${strLines}\n${inheritNote}` : '';
  // Archiv-Regel: ein archivierter Akt ist ABGESCHLOSSEN, nicht ausgemustert
  // (das ist „verworfen" auf Beat-Ebene). Er bleibt im Outline, damit Kausalität
  // und Setup/Payoff über ihn hinweg prüfbar sind — aber er ist kein Arbeitsziel
  // mehr. Ausnahme: ein Widerspruch, der IN den offenen Plot hineinreicht, bleibt
  // meldepflichtig (sonst wäre Archivieren ein Weg, Befunde zu verstecken).
  const archNote = _hasArchivedActs(acts)
    ? '\nARCHIVIERTE AKTE: Mit „ARCHIVIERT" gekennzeichnete Akte hat die Autorin als abgeschlossen erklärt — ihre Beats sind ins Manuskript eingearbeitet. Behandle sie als Vorgeschichte/Setup-Kontext, nicht als Arbeitsvorrat: melde dort KEINE Status-Pflege, keine fehlenden Beats und keine dramaturgischen Lücken. Melde einen Befund in einem archivierten Akt nur, wenn er in den noch offenen Plot hineinwirkt (Widerspruch zu einem geplanten Beat, unaufgelöstes Setup, gebrochene Kausalkette) — dann nenne ihn ausdrücklich als Rückwirkung.\n'
    : '';
  const hybridNote = _hasOwnActs(acts)
    ? '\nHYBRID-AKTE: Manche Stränge haben eine EIGENE Aktstruktur (im Board als „eigener Akt von Strang …" gekennzeichnet), andere teilen sich die geteilten Akte. Ein Strang mit eigenen Akten plant absichtlich unabhängig — beanstande NICHT, dass er die geteilten Akte „überspringt". Prüfe seinen dramaturgischen Bogen INNERHALB seiner eigenen Akte.\n'
    : '';
  // Weltgesetz-Segment: fehlt es, wird NICHT behauptet, die Welt habe keine Regeln —
  // der Block entfaellt schlicht (ein nie gelaufener Fakten-Index ist „unbekannt",
  // nicht „regelfrei"; gleiches Muster wie das Textbeleg-Segment).
  const weltLines = _weltgesetzeLines(weltgesetze);
  const weltSeg = weltLines
    ? `\nETABLIERTE WELTGESETZE (aus der Buchanalyse extrahierte Regeln + Technik-Stand dieser Welt — was hier GILT, unabhaengig davon, was schon geschrieben ist):\n${weltLines}\n`
    : '';
  const weltChecks = weltLines
    ? `
- Verstoss gegen ein Weltgesetz: Setzt ein geplanter Beat etwas voraus, das nach den oben gelisteten Regeln/dem Technik-Stand dieser Welt NICHT moeglich ist (eine Regel wird gebrochen, ohne dass der Beat das als Bruch ausweist)? Nenne die verletzte Regel woertlich im "problem". Ein bewusst gesetzter Regelbruch, den der Beat selbst als Wendepunkt benennt, ist KEIN Fehler — beanstande nur den unbemerkten Widerspruch. Die Regeln sind extrahiert, nicht von der Autorin kuratiert: passt eine Regel erkennbar nicht, urteile nicht dagegen.`
    : '';
  const relLines = _relationsLines(relations);
  const relSeg = relLines
    ? `\nBEAT-BEZIEHUNGEN (vom Autor explizit gezogene Kanten zwischen Beats — Kausalität + Setup/Payoff; die Board-Reihenfolge ergibt sich aus Akt → Beat):\n${relLines}\n`
    : '';
  // Textbeleg-Segment (semantische Verankerung gegen das echte Manuskript): nur
  // wenn ein befüllter Index vorliegt (sonst hiesse „KEIN Textbeleg" bloss „nie
  // gescannt", nicht „nicht im Buch" → falsche Drift-Flut).
  const anchorSeg = anchorMap ? `
TEXTBELEGE (semantische Suche über das ECHTE Manuskript): Nur "im Buch"-Beats werden gegen den Text abgeglichen; hinter ihnen stehen ⟨…⟩-Marker, die zeigen, ob und wo der Beat tatsächlich im Buchtext auftaucht. Sie sind dein wichtigster Realitätsanker — genauer als der Szenen-Index:
- "im Buch" + „KEIN Textbeleg" → starkes Drift-Signal: der Plan behauptet etwas, das die Textsuche NICHT findet. Priorisiere das und nenne den Beat samt Seite, falls bekannt.
- "im Buch" + Textbeleg → im Text belegt; beanstande ihn NICHT als „fehlt", ausser der Beleg-Ausschnitt passt inhaltlich erkennbar nicht zum Beat.
Der Marker ist Ähnlichkeit, kein Beweis — urteile am Beleg-Ausschnitt, nicht blind. Nenne die belegende Seite im "problem"/"vorschlag", damit die Autorin sie anspringen kann.${anchorInfo.stale ? ' HINWEIS: Der Beleg-Index ist evtl. veraltet (Beats seit dem letzten Verankerungs-Lauf geändert) — behandle fehlende Belege bei offensichtlich frisch bearbeiteten Beats mit Vorsicht.' : ''}
` : '';
  // Zeitstrahl-spezifischer Prüfpunkt nur, wenn ein Figuren-Zeitstrahl vorliegt.
  const zeitChecks = zeitLines
    ? `
- Chronologie gegen Zeitstrahl: Widerspricht die Beat-Reihenfolge der zeitlichen Abfolge der Figuren-Ereignisse (Vorgriffe, Rückblenden ohne Kennzeichnung, unmögliche Gleichzeitigkeit)?`
    : '';
  // Strang-spezifische Prüfpunkte nur ergänzen, wenn überhaupt Stränge existieren.
  const strChecks = strLines
    ? `
- Pro Strang ein vollständiger Bogen: Hat jeder Handlungsstrang (besonders je Hauptfigur) Setup, Eskalation und Auflösung — oder bricht eine Erzähllinie ohne Abschluss ab?
- Strang-Balance: Wird ein Strang über lange Strecken (Akte) gar nicht bedient, während ein anderer dominiert? POV-/Aufmerksamkeits-Lücken benennen.
- Verweben: Treffen/kreuzen sich die Stränge an sinnvollen Stellen, oder laufen sie beziehungslos nebeneinander her?`
    : '';
  // Recherche-Abgleich nur, wenn verknüpftes Recherche-Material vorliegt.
  const rechChecks = rechLines
    ? `
- Recherche-Abgleich: Widerspricht ein Beat dem verknüpften Recherche-Material (Fakten/Quellen)? Oder wurde zu einem Beat/Strang Recherche gesammelt, die der geplante Beat noch gar nicht aufgreift (ungenutztes Material)?`
    : '';
  // Prüfpunkte für die expliziten Beat-Beziehungen nur, wenn welche gezogen wurden.
  const relChecks = relLines
    ? `
- Setup/Payoff: Wird ein „bereitet vor"-Setup nirgends eingelöst (Ziel-Beat verworfen, fehlt, oder steht in der Board-Reihenfolge VOR dem Setup)? Zahlt ein „zahlt ein auf"-Payoff auf einen Setup ein, der fehlt/verworfen ist oder erst später kommt (Tschechows Gewehr, das nicht abgefeuert wird — oder ein Schuss ohne Gewehr)?
- Kausalität: Steht bei „führt zu"/„motiviert" die Wirkung in der Board-Reihenfolge VOR ihrer Ursache? Widerspricht eine „blockiert"-Kante der geplanten Abfolge?
- Status-Abhängigkeit: Baut ein Beat mit Status „im Buch" (als Wirkung/Payoff einer Kante) auf einem Beat auf, der noch „geplant" ist (das Geschriebene setzt etwas voraus, das laut Plan noch gar nicht geschrieben wurde)?`
    : '';

  return `Du prüfst die GEPLANTE Handlung (Beat-Board) der Autorin auf Stimmigkeit — in sich und gegen die tatsächliche Buchrealität (Kapitel + analysierte Szenen). Sei schonungslos, aber konstruktiv.

GEPLANTES BEAT-BOARD:
${_boardOutline(acts, beats, _threadInfoMap(threads), anchorMap)}
${anchorSeg}${ctxSeg}${kapSeg}${szSeg}${figSeg}${wfSeg}${orteSeg}${zeitSeg}${weltSeg}${kontiSeg}${rechSeg}${strSeg}${hybridNote}${archNote}${relSeg}
Status-Legende der Beats: geplant (Idee, noch nicht eingearbeitet) · im Buch (laut Plan schon geschrieben). Zusätzlich kann ein Beat als "verworfen" markiert sein (ausgemustert, soll nicht mehr ins Buch).

Prüfe auf:
- Beats mit Status "im Buch", für die sich in den Szenen/Kapiteln KEINE Entsprechung finden lässt (Plan behauptet etwas, das nicht im Buch steht)
- Beats, die laut Szenen offenkundig schon geschrieben sind, aber noch auf "geplant" stehen (Status nachziehen)
- Chronologie-Brüche: die Reihenfolge der Beats (Akte → Beats) passt nicht zur Reihenfolge der verknüpften Kapitel
- Logische Brüche / Widersprüche innerhalb der Handlung (Kausalität, Motivation, Figurenlogik)
- Lücken: Kapitel mit Szenen, für die es keinen Beat gibt — oder dramaturgische Leerstellen (fehlender Wendepunkt, fehlende Auflösung eines Konflikts)
- Verworfene Beats, deren Inhalt trotzdem noch im Buch auftaucht${zeitChecks}${weltChecks}${strChecks}${rechChecks}${relChecks}

Schwere-Skala:
- "kritisch": logischer Bruch oder Plan-Realität-Widerspruch, der die Handlung zerstört
- "stark":   deutlicher Widerspruch, sollte aufgelöst werden
- "mittel":  Spannung/Drift zwischen Plan und Buch, Klärung empfohlen
- "schwach": leichte Reibung, Hinweis genügt
- "niedrig": kosmetisch / Status-Pflege

Nenne im Feld "beat" den Titel des betroffenen Beats — oder "—" für übergreifende Befunde (Lücken, fehlende Wendepunkte). Gib zusätzlich im Feld "beat_id" die Zahl aus dem [#…]-Marker des betroffenen Beats an (z.B. [#42] → 42); für übergreifende Befunde ("—") setze "beat_id" auf null. Wenn alles stimmig ist, gib ein leeres "konflikte"-Array zurück und schreibe ein bestätigendes Fazit.

Priorisiere nach Schwere und melde die wichtigsten Befunde (höchstens ~25) — keine redundanten oder rein kosmetischen Dopplungen. Halte "problem" und "vorschlag" knapp (je 1–2 Sätze).

Antworte mit diesem JSON-Schema:
{
  "konflikte": [
    { "beat": "Titel des Beats oder —", "beat_id": 42, "schwere": "kritisch|stark|mittel|schwach|niedrig", "problem": "kurze Beschreibung", "vorschlag": "konkreter Lösungsvorschlag" }
  ],
  "fazit": "1–3 Sätze Gesamteinschätzung"
}`;
}

export const SCHEMA_PLOT_CONSISTENCY = _obj({
  konflikte: {
    type: 'array',
    items: _obj({
      beat: _str,
      // Stabile Beat-ID (aus dem [#…]-Board-Marker) — überlebt Umbenennungen. null
      // bei übergreifenden Befunden ("—", kein einzelner Beat).
      beat_id: { type: ['integer', 'null'] },
      schwere: { type: 'string', enum: SEVERITY_ENUM },
      problem: _str,
      vorschlag: _str,
    }),
  },
  fazit: _str,
});

export const PLOT_SEVERITY_ENUM = SEVERITY_ENUM;
