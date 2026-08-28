// Kontext-Blöcke der Bewertung: was die Bewertung ausser dem Text noch weiss.
//
// Vier Quellen, drei Wahrheitsgrade — die Rahmung im jeweiligen Block ist das
// Wesentliche daran:
//   · Komplettanalyse (Figuren/Beziehungen/Kontinuität/Zeitstrahl) = Kartei-Wahrheit,
//   · Motiv-Werkstatt = Absicht des Autors (Soll), keine Textwahrheit,
//   · Struktur-Check = Messung am Text (Ist),
//   · Genre-Schwerpunkt + Kapitel-Position = Rahmen, kein Befund.

import { textsorte, textsorteLabel } from '../textsorten.js';

/**
 * Erzeugt den Buchtyp-Schwerpunkt-Block für Buchreview- und Kapitelreview-Prompts.
 * Übersteuert nicht die ACHSEN, sondern schärft, worauf das Modell je nach Genre
 * zusätzlich achten soll (z.B. Krimi: Logik der Auflösung).
 *
 * @param {string} schwerpunkt Text aus prompt-config.json buchtypen[lang][key].reviewSchwerpunkt
 * @returns {string} Block oder '' (wenn schwerpunkt leer)
 */
function _buildReviewSchwerpunktBlock(schwerpunkt) {
  const t = (schwerpunkt || '').trim();
  if (!t) return '';
  return `\nGenre-Schwerpunkt (zusätzlich zu den Achsen, nicht statt ihnen):\n${t}\n`;
}

/**
 * Positioniert das Kapitel im Buch und weist das Modell an, die zeitlichen Achsen
 * relativ zur Funktion des Kapitels zu bewerten (Aufbau-/Ruhekapitel vs.
 * Wende-/Schlusskapitel) statt absolut.
 *
 * @param {{index:number,total:number,prevName?:string,nextName?:string}|null} position
 * @returns {string} Block oder '' (wenn keine Position bekannt)
 */
function _buildChapterPositionBlock(position) {
  if (!position || !position.total) return '';
  const nachbarn = [];
  if (position.prevName) nachbarn.push(`Vorheriges Kapitel: «${position.prevName}».`);
  if (position.nextName) nachbarn.push(`Nächstes Kapitel: «${position.nextName}».`);
  return `
Position im Buch: Kapitel ${position.index} von ${position.total}.${nachbarn.length ? '\n' + nachbarn.join(' ') : ''}
Bewerte den Bogen dieses Kapitels relativ zu seiner FUNKTION im Ganzen, nicht absolut: ein frühes Aufbau-/Ruhekapitel darf bewusst langsamer sein, ein Wende- oder Schlusskapitel muss einlösen. Ein ruhiges Kapitel an der richtigen Stelle ist kein Mangel.
`;
}

/**
 * Baut den Strukturdaten-Block aus Komplettanalyse-Daten.
 * Erscheint nur, wenn mindestens eine Quelle Daten liefert.
 *
 * Wichtig: die Daten gelten als Wahrheit. Modell darf sich darauf beziehen
 * (z.B. "die Figurenkartei nennt Anna als Lehrerin – im Kap. 5 wird sie
 * Ärztin genannt"). Bei leeren Quellen wird der jeweilige Abschnitt weggelassen –
 * keine erfundenen Befunde.
 *
 * @param {{figuren:Array, beziehungen:Array, continuityIssues:Array, zeitstrahl:Array}} ctx
 * @returns {string} Block oder '' (wenn alle Buckets leer)
 */
function _buildKomplettContextBlock(ctx) {
  if (!ctx) return '';
  const parts = [];

  if (ctx.figuren?.length) {
    const lines = ctx.figuren.map(f => {
      const head = [f.name, f.kurzname && f.kurzname !== f.name ? `«${f.kurzname}»` : null].filter(Boolean).join(' ');
      const attrs = [f.typ, f.geschlecht, f.beruf].filter(Boolean).join(', ');
      const desc = f.beschreibung ? ` – ${f.beschreibung}` : '';
      return `- ${head}${attrs ? ` (${attrs})` : ''}${desc}`;
    });
    parts.push(`Figurenkartei (Stamm, verbindliche Wahrheit über das Buch):\n${lines.join('\n')}`);
  }

  if (ctx.beziehungen?.length) {
    const lines = ctx.beziehungen.map(b => {
      const desc = b.beschreibung ? ` – ${b.beschreibung}` : '';
      return `- ${b.von} → ${b.zu}: ${b.typ}${desc}`;
    });
    parts.push(`Soziogramm (Figurenbeziehungen):\n${lines.join('\n')}`);
  }

  if (ctx.continuityIssues?.length) {
    const lines = ctx.continuityIssues.map(i => {
      const kap = i.kapitel?.length ? ` [${i.kapitel.join(' / ')}]` : '';
      const fig = i.figuren?.length ? ` (Figuren: ${i.figuren.join(', ')})` : '';
      return `- ${i.schwere || '–'} | ${i.typ || '–'}${kap}: ${i.beschreibung}${fig}`;
    });
    parts.push(`Kontinuitäts-Befunde aus der letzten Komplettanalyse (Plot-Logik nicht ignorieren):\n${lines.join('\n')}`);
  }

  if (ctx.zeitstrahl?.length) {
    const lines = ctx.zeitstrahl.map(e => {
      const kap = e.kapitel ? ` [${e.kapitel}]` : '';
      const typ = e.typ ? ` (${e.typ})` : '';
      return `- ${e.datum || '?'}${typ}${kap}: ${e.ereignis}`;
    });
    parts.push(`Globaler Zeitstrahl (Reihenfolge der wichtigen Ereignisse):\n${lines.join('\n')}`);
  }

  if (!parts.length) return '';
  return `
=== STRUKTURDATEN AUS DER KOMPLETTANALYSE (verbindlich) ===
Wo Aussagen im Buchtext den folgenden Strukturdaten widersprechen, beziehe dich in
der passenden Achse konkret auf die widersprüchliche Stelle und nenne die
Kartei-Wahrheit. Wo die Strukturdaten schweigen, NICHT raten.

${parts.join('\n\n')}
=== ENDE STRUKTURDATEN ===
`;
}

/**
 * Auf welche Achse der Form-Befund zielt. `textsortentreue` gibt es nur im
 * journalistischen Profil; sonst ist der Aufbau die nächstliegende Achse.
 */
function _strukturAchse(axes) {
  const keys = axes.map(a => a.key);
  return ['textsortentreue', 'struktur', 'kohaerenz'].find(k => keys.includes(k)) || keys[0];
}

/**
 * Baut den Block „Form-Befunde des Struktur-Checks".
 *
 * Der einzige Kontextblock, der eine MESSUNG einbringt statt Kartei-Wahrheit
 * (Komplettanalyse) oder Autor-Absicht (Motive): ein regelbasierter Check hat
 * jeden Beitrag gegen den Soll-Katalog seiner Textsorte geprüft. Ohne ihn
 * schätzt das Modell die Formtreue, obwohl sie vorliegt.
 *
 * Drei Rahmungen, die der Block leisten muss:
 *  · Ungeprüfte Beiträge sind UNBEKANNT, nicht in Ordnung — sonst liest das
 *    Modell eine Teilprüfung als Freibrief für den Rest.
 *  · Die Bewertung soll den Befund verwenden, nicht nacherzählen: ihre Aufgabe
 *    ist das Ganze (Auswahl, Bandbreite, Niveau über die Sammlung).
 *  · Was der Deckel geschluckt hat, wird ausgewiesen.
 *
 * @param {object|null} ctx  Ausgabe von lib/struktur-summary.js
 * @param {{achse:string}} opts Achse dieses Profils, auf die der Befund zielt
 */
function _buildStrukturContextBlock(ctx, { achse = 'struktur' } = {}) {
  if (!ctx || !ctx.geprueft) return '';
  const parts = [];
  const u = ctx.urteile || {};
  parts.push(`Gesamturteile: ${u.traegt || 0}× trägt · ${u.lueckenhaft || 0}× lückenhaft · ${u.verfehlt || 0}× verfehlt`);

  if (ctx.proTextsorte?.length) {
    const lines = ctx.proTextsorte.map(t =>
      `- ${textsorteLabel(t.textsorte)} (${t.anzahl}): ${t.traegt} trägt, ${t.lueckenhaft} lückenhaft, ${t.verfehlt} verfehlt`);
    parts.push(`Nach Textsorte:\n${lines.join('\n')}`);
  }

  if (ctx.luecken?.length) {
    const lines = ctx.luecken.map(l => {
      const regel = textsorte(l.textsorte)?.regeln?.[l.nr - 1] || '';
      const kurz = regel ? regel.replace(/\s+/g, ' ').slice(0, 90).trim() + (regel.length > 90 ? '…' : '') : `Regel ${l.nr}`;
      const zaehler = [l.fehlt ? `${l.fehlt}× fehlt` : null, l.teilweise ? `${l.teilweise}× teilweise` : null].filter(Boolean).join(', ');
      return `- ${textsorteLabel(l.textsorte)}, Regel ${l.nr} (${kurz}): ${zaehler}`;
    });
    parts.push(`Häufigste Formlücken:\n${lines.join('\n')}`);
  }

  if (ctx.wFragen?.length) {
    parts.push(`Im Lead unbeantwortete W-Fragen: ${ctx.wFragen.map(w => `${w.frage} (${w.anzahl}×)`).join(', ')}`);
  }

  if (ctx.seiten?.length) {
    const lines = ctx.seiten.map(s => {
      const m = s.maengel?.length ? `\n    ${s.maengel.map(x => `Regel ${x.nr} ${x.status}: ${x.befund}`).join('\n    ')}` : '';
      return `- «${s.titel}» (${textsorteLabel(s.textsorte)}, ${s.urteil})${m}`;
    });
    const rest = ctx.seitenGekuerzt ? `\n(${ctx.seitenGekuerzt} weitere auffällige Beiträge hier nicht gelistet.)` : '';
    parts.push(`Auffällige Beiträge:\n${lines.join('\n')}${rest}`);
  }

  return `
=== FORM-BEFUNDE DES STRUKTUR-CHECKS (gemessen, keine Schätzung) ===
Ein regelbasierter Check hat ${ctx.geprueft} von ${ctx.gesamt} Beiträgen gegen den
Soll-Katalog ihrer Textsorte geprüft. Stütze die Achse "${achse}" auf diese Befunde,
statt die Formtreue zu schätzen. Die ${ctx.gesamt - ctx.geprueft} ungeprüften Beiträge sind
UNBEKANNT, nicht in Ordnung — zähle sie weder als erfüllt noch als mangelhaft.
Verwende den Befund, zähle ihn nicht noch einmal auf: deine Aufgabe bleibt das Ganze
(Auswahl, Bandbreite, Niveau und Komposition über die Sammlung), nicht die Formkritik
am Einzelbeitrag — die steht bereits hier.

${parts.join('\n\n')}
=== ENDE FORM-BEFUNDE ===
`;
}

/**
 * Baut den Block „Themen & Motive aus der Motiv-Werkstatt" für die BUCHbewertung.
 * Nur buchweit gedacht (nicht für die Kapitelbewertung).
 *
 * Wichtiger Unterschied zu _buildKomplettContextBlock: diese Daten sind teils
 * AUTOR-ABSICHT (das geplante Soll), keine aus dem Text extrahierte Wahrheit.
 * Der Block ist entsprechend gerahmt — das Modell soll die Umsetzung und
 * thematische Kohärenz beurteilen (v.a. auf der Achse "thema"), aber eine
 * bewusste Abweichung vom Plan NICHT als Fehler werten. Pro Motiv steht das
 * Soll (verankerte Figuren/Kapitel/Beats/Seiten) neben dem Ist (Fundstellen der
 * Motiverkennung). Erscheint nur, wenn mindestens ein Motiv existiert.
 *
 * @param {{themen:Array, motive:Array}} ctx
 * @returns {string} Block oder '' (wenn keine Motive)
 */
function _buildMotivContextBlock(ctx) {
  if (!ctx || !ctx.motive?.length) return '';
  const parts = [];

  if (ctx.themen?.length) {
    const lines = ctx.themen.map(t => `- ${t.name}${t.beschreibung ? ` – ${t.beschreibung}` : ''}`);
    parts.push(`Themen (abstrakte Klammern):\n${lines.join('\n')}`);
  }

  const motifLines = ctx.motive.map(m => {
    const thema = m.thema ? ` [Thema: ${m.thema}]` : '';
    const desc = m.beschreibung ? ` – ${m.beschreibung}` : '';
    const soll = [];
    if (m.sollFiguren?.length) soll.push(`Figuren: ${m.sollFiguren.join(', ')}`);
    if (m.sollKapitel?.length) soll.push(`Kapitel: ${m.sollKapitel.join(', ')}`);
    if (m.sollBeats)  soll.push(`${m.sollBeats} Beat(s)`);
    if (m.sollSeiten) soll.push(`${m.sollSeiten} Seite(n)`);
    const sollStr = soll.length ? `geplant verankert an ${soll.join('; ')}` : 'keine konkrete Verankerung geplant';
    return `- «${m.name}»${thema}${desc}\n    Soll: ${sollStr} · Ist: ${m.istFunde} Fundstelle(n) im Text`;
  });
  parts.push(`Motive (Soll = Plan des Autors, Ist = automatisch im Text gefunden):\n${motifLines.join('\n')}`);

  return `
=== THEMEN & MOTIVE AUS DER MOTIV-WERKSTATT (Absicht des Autors, KEINE Textwahrheit) ===
Das Folgende ist die vom Autor GEPLANTE thematische Ebene, nicht aus dem Text
extrahiert. Nutze es, um auf der Achse "thema" (roter Faden) die inhaltliche
Kohärenz und die Umsetzung der Motive zu beurteilen: Wird ein zentrales Motiv
tatsächlich getragen (hohes Ist), oder ist es nur geplant und im Text kaum
präsent (Soll vorhanden, Ist niedrig/0)? Ein solcher Soll/Ist-Bruch ist ein
möglicher Hinweis auf ein unterentwickeltes Motiv. ABER: Weiche der Autor
bewusst von seinem Plan ab, ist das kein Fehler — bewerte die Wirkung des
tatsächlichen Textes, nicht die Treue zum Plan. Wo diese Daten schweigen, NICHT raten.

${parts.join('\n\n')}
=== ENDE THEMEN & MOTIVE ===
`;
}

/** Achse, auf die die Weltaufbau-Messung zielt. Wie _strukturAchse: der Befund
 *  bekommt die Achse des Profils, die inhaltliche Stimmigkeit fuehrt — nicht eine
 *  neue Achse. Ein zusaetzlicher Achsen-Key waere eine Persistenz-Konstante und
 *  wuerde jedes bestehende Bewertungs-JSON um ein Pflichtfeld aermer machen. */
function _weltAchse(axes) {
  const keys = axes.map(a => a.key);
  return ['thema', 'kohaerenz', 'struktur'].find(k => keys.includes(k)) || keys[0];
}

/**
 * Baut den Block „Weltaufbau-Befunde" fuer die BUCHbewertung.
 *
 * Zweiter MESSENDER Block neben dem Struktur-Check: gezaehlt wird der Welt-Fakten-
 * Index (`world_facts`) — Kategorien, Naben, Verteilung ueber den Buchbogen,
 * Kapitel ohne einen einzigen etablierten Fakt. Im Multi-Pass ist das die einzige
 * Aussage zum Weltaufbau, die nicht durch eine Zusammenfassung gegangen ist.
 *
 * Drei Rahmungen sind Pflicht — jede fangt eine Fehllesung ab, die teurer waere
 * als der Block wert ist:
 *  · Die Fakten sind KI-EXTRAHIERT, kein von der Autorin kuratierter Kanon. Eine
 *    Luecke kann eine Luecke der Extraktion sein.
 *  · Ein Kapitel ohne Fakt ist NICHT automatisch weltarm — Szenen brauchen keine
 *    neuen Weltaussagen. Es ist ein Hinweis, kein Befund.
 *  · Wenig Fakten sind kein Mangel: ein Kammerspiel etabliert wenig Welt, und das
 *    ist eine Form, keine Schwaeche.
 *
 * @param {object|null} ctx  Ausgabe von lib/welt-summary.js
 * @param {{achse:string}} opts Achse dieses Profils, auf die der Befund zielt
 * @returns {string} Block oder '' (nicht erhoben / leer)
 */
function _buildWeltContextBlock(ctx, { achse = 'thema' } = {}) {
  if (!ctx || !ctx.gesamt) return '';
  const parts = [];
  parts.push(`Etablierte Welt-Fakten: ${ctx.gesamt}`);

  if (ctx.proKategorie?.length) {
    parts.push(`Nach Kategorie: ${ctx.proKategorie.map(k => `${k.kategorie} (${k.anzahl})`).join(', ')}`);
  }

  const b = ctx.bogen || {};
  parts.push(`Verteilung über den Buchbogen: Anfang ${b.anfang || 0} · Mitte ${b.mitte || 0} · Schluss ${b.schluss || 0}`
    + (ctx.ohneKapitelBezug ? ` (${ctx.ohneKapitelBezug} Fakten ohne Kapitelbezug, im Bogen nicht enthalten)` : ''));

  const ka = ctx.kapitelAbdeckung || {};
  if (ka.gesamt) {
    const rest = ka.ohneFaktenGekuerzt ? ` … und ${ka.ohneFaktenGekuerzt} weitere` : '';
    const liste = ka.ohneFakten?.length ? `: ${ka.ohneFakten.join(', ')}${rest}` : '';
    parts.push(`Kapitel mit mindestens einem etablierten Fakt: ${ka.mitFakten} von ${ka.gesamt}`
      + (ka.ohneFakten?.length ? `\nOhne etablierten Fakt${liste}` : ''));
  }

  if (ctx.topSubjekte?.length) {
    parts.push(`Naben der Welt (Subjekte mit mehreren Fakten): ${ctx.topSubjekte.map(s => `${s.subjekt} (${s.anzahl})`).join(', ')}`);
  }

  if (ctx.beispiele?.length) {
    const lines = ctx.beispiele.map(x => `- [${x.kategorie}] ${x.subjekt ? `${x.subjekt}: ` : ''}${x.fakt}`);
    parts.push(`Beispiele (über die Kategorien gestreut):\n${lines.join('\n')}`);
  }

  return `
=== WELTAUFBAU-BEFUNDE (gemessen am Fakten-Index, keine Schätzung) ===
Die Buchanalyse hat ${ctx.gesamt} etablierte Welt-Fakten extrahiert (Weltregeln, Orte,
Technik, Kultur, Historie …). Nutze die Zahlen für die Achse "${achse}", statt die
Dichte des Weltaufbaus zu schätzen — im Mehrfach-Pass ist das die einzige Angabe
dazu, die nicht durch eine Zusammenfassung gegangen ist.
DREI EINSCHRÄNKUNGEN, die du mitdenken MUSST:
· Die Fakten sind automatisch EXTRAHIERT, kein von der Autorin kuratierter Kanon —
  eine Lücke kann eine Lücke der Extraktion sein, nicht des Buchs.
· Ein Kapitel ohne etablierten Fakt ist NICHT weltarm: eine Szene, die auf bereits
  Etabliertem spielt, braucht keine neue Weltaussage. Behandle es als Hinweis auf
  eine mögliche Leerstelle, nicht als Befund.
· Wenige Fakten sind kein Mangel. Ein Kammerspiel etabliert wenig Welt — das ist
  eine Form, keine Schwäche. Beurteile die WIRKUNG, nicht die Zahl.
Verwende den Befund, zähle ihn nicht noch einmal auf.

${parts.join('\n\n')}
=== ENDE WELTAUFBAU-BEFUNDE ===
`;
}

export {
  _buildReviewSchwerpunktBlock, _buildChapterPositionBlock,
  _buildKomplettContextBlock, _strukturAchse, _buildStrukturContextBlock,
  _buildMotivContextBlock, _weltAchse, _buildWeltContextBlock,
};
