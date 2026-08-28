// Seiten-Chat + Buch-Chat (klassisch + Agentic) Prompt-Builder.
// Liest SYSTEM_CHAT/SYSTEM_BOOK_CHAT live-bound aus core.js (von configurePrompts gesetzt).

import { _isLocal, JSON_ONLY } from './state.js';
import { _obj, _str } from './schema-utils.js';
import { SYSTEM_CHAT, SYSTEM_BOOK_CHAT } from './core.js';

/**
 * Figuren-Block der Chat-Prompts — gebudgetet.
 *
 * `getFiguren` (routes/jobs/shared/queries.js) liefert VOLLDOSSIERS: neben den
 * Stammdaten auch Lebensereignisse, Beziehungen, Schauplätze und Szenen jeder
 * Figur. Das ist die grösste unkontrollierte Grösse im Chat-Prompt — bei einem
 * ausanalysierten Buch mit über hundert Figuren sind das mehrere Hunderttausend
 * Zeichen. Ungekappt sprengt allein dieser Block das Kontextfenster, bevor eine
 * einzige Zeile Buchtext oder ein Werkzeug-Ergebnis im Prompt steht; der Call
 * scheitert dann am Preflight (lib/ai/shared.js#assertPromptFitsContext) — und
 * zwar bei JEDEM Provider, ein 200k-Fenster reicht dafür genauso wenig.
 *
 * Drei Stufen, in dieser Reihenfolge:
 *   'voll'    — die Dossiers passen ins Budget (kleines Ensemble: unverändert)
 *   'stamm'   — nur Stammdaten je Figur, die Detaillisten als ANZAHL
 *   'gekappt' — Stammdaten bis zum Budget, der Rest offengelegt
 *
 * GERATEN WIRD NICHTS: was der Block nicht trägt, wird als fehlend AUSGEWIESEN —
 * sonst hält das Modell ein gekapptes Ensemble für das ganze. `detailTools: true`
 * (agentischer Pfad) nennt die Werkzeuge, über die die Details einzeln nachzuladen
 * sind; ohne Werkzeuge bleibt es beim Hinweis.
 *
 * Reihenfolge ist die von `getFiguren` (figures.sort_order, Hauptfiguren zuerst) —
 * beim Kappen fällt damit das Nebenpersonal weg, nicht die Hauptfigur.
 *
 * @param {Array}  figuren  Ergebnis von getFiguren (kann leer/null sein)
 * @param {Object} opts     { maxChars, detailTools }
 * @returns {{ text, mode, shown, total, chars }|null}  null = kein Block
 */
export const FIGUREN_BLOCK_DEFAULT_MAX_CHARS = 40000;
const FIGUREN_DETAIL_KEYS = ['lebensereignisse', 'beziehungen', 'schauplätze', 'szenen'];
const FIGUREN_HEAD = '=== FIGUREN DES BUCHS ===';

function _figurStamm(f) {
  const out = {};
  for (const [k, v] of Object.entries(f)) {
    if (!FIGUREN_DETAIL_KEYS.includes(k)) out[k] = v;
  }
  const details = {};
  for (const k of FIGUREN_DETAIL_KEYS) {
    const n = Array.isArray(f[k]) ? f[k].length : 0;
    if (n > 0) details[k] = n;
  }
  if (Object.keys(details).length) out.weggelassen = details;
  return out;
}

export function buildFigurenBlock(figuren, opts = {}) {
  const list = Array.isArray(figuren) ? figuren.filter(Boolean) : [];
  if (!list.length) return null;
  const maxChars = Number(opts.maxChars) > 0 ? Number(opts.maxChars) : FIGUREN_BLOCK_DEFAULT_MAX_CHARS;
  const withTools = opts.detailTools === true;

  const voll = JSON.stringify(list, null, 2);
  if (voll.length <= maxChars) {
    const text = [FIGUREN_HEAD, voll].join('\n');
    return { text, mode: 'voll', shown: list.length, total: list.length, chars: text.length };
  }

  const hint = withTools
    ? 'Details je Figur (Beziehungen, Szenen, Schauplätze, Lebensereignisse) über `get_figure_profile` / `get_figure_relations` nachladen.'
    : 'Die Detaillisten je Figur sind hier nicht enthalten — schliesse aus ihrem Fehlen nichts.';
  const lead = [
    FIGUREN_HEAD,
    `(Stammdaten je Figur; \`weggelassen\` nennt die Anzahl der nicht enthaltenen Detaileinträge. ${hint})`,
  ];
  // Eine Figur pro Zeile: kein Pretty-Print-Aufschlag, aber lesbar — und zeilenweise
  // füllbar, weshalb das Kappen immer an einer Figurengrenze endet.
  const rows = list.map(f => JSON.stringify(_figurStamm(f)));
  const wrap = (head, body) => [...head, '[', body.join(',\n'), ']'].join('\n');

  const stamm = wrap(lead, rows);
  if (stamm.length <= maxChars) {
    return { text: stamm, mode: 'stamm', shown: list.length, total: list.length, chars: stamm.length };
  }

  const overhead = wrap([...lead, ''], []).length + 120;   // Kopf + Kappungs-Hinweis
  const shownRows = [];
  let used = 0;
  for (const row of rows) {
    if (used + row.length + overhead > maxChars) break;
    shownRows.push(row);
    used += row.length + 2;
  }
  const rest = list.length - shownRows.length;
  const capped = [
    ...lead,
    `(NUR ${shownRows.length} von ${list.length} Figuren aufgeführt — ${rest} weitere fehlen in diesem Block. `
    + (withTools
      ? 'Frage nach einer hier fehlenden Figur gezielt via `get_figure_profile`.)'
      : 'Behandle die Liste NICHT als vollständiges Ensemble.)'),
  ];
  const text = wrap(capped, shownRows);
  return { text, mode: 'gekappt', shown: shownRows.length, total: list.length, chars: text.length };
}

/**
 * Welt-Fakten-Block des AGENTISCHEN Buch-Chats — gebudgetet, buch-stabil.
 *
 * Bewusst nur dort: der klassische Buch-Chat-Pfad füllt sein Textbudget mit
 * Buchtext-Passagen, und ein zweiter reservierter Block würde diese Rechnung
 * verschieben. Der Seiten-Chat arbeitet auf EINER Seite, für die die buchweiten
 * Weltregeln selten den Ausschlag geben.
 *
 * `world_facts` ist deklaratives Buch-Wissen aus der Komplettanalyse: etablierte
 * Weltregeln, Geografie, Daten, Technik, Kultur. Kurz, verdichtet, und damit die
 * billigste Antwort auf «welche Regel gilt hier», «was ist über X etabliert» —
 * Stufe 1 der Kosten-Leiter. Ohne den Block muss der Agent dieselbe Auskunft
 * über ein Werkzeug oder, schlimmer, über einen Kapitel-Volltext holen.
 *
 * Der Block gehört in den STABILEN, gecachten System-Anteil (nicht in den
 * Erst-Kontext): er hängt am Buch, nicht an der Frage. Im Erst-Kontext-Block
 * (`cache: false`) würde er jede Iteration neu bezahlt.
 *
 * ZWEI DINGE WERDEN NIE VERSCHWIEGEN:
 *  · Was der Deckel geschluckt hat, steht im Block (sonst hält das Modell eine
 *    gekappte Liste für den ganzen Kanon).
 *  · Ein NICHT erhobener Index liefert KEINEN Block (`scanned: false` → null) —
 *    ein leerer Block würde als «diese Welt hat keine Regeln» gelesen. Dass der
 *    Index fehlt, sagt dem Agenten das Werkzeug `list_world_facts`, wenn er fragt.
 *
 * Die Fakten stammen aus der KI-Extraktion, nicht von der Autorin — der Kopf
 * sagt das, damit das Modell sie nicht als kuratierten Kanon über den Buchtext
 * stellt.
 *
 * @param {{scanned:boolean, fakten:Array}|null} welt  Ausgabe von
 *        db/world-facts.js#listWorldFacts + #worldFactsScanState
 * @param {Object} opts { maxChars }
 * @returns {{ text, shown, total, chars }|null}  null = kein Block
 */
export const WELTFAKTEN_BLOCK_DEFAULT_MAX_CHARS = 8000;
const WELTFAKTEN_HEAD = '=== ETABLIERTE WELT-FAKTEN DES BUCHS ===';

// Rangfolge NUR fuer das Kappen, keine Taxonomie (die ist FAKT_KATEGORIE_WL in
// db/world-facts.js): die tragenden Weltgesetze stehen vorn, damit der Deckel
// zuerst das Beiwerk frisst und nicht die Regel, an der die Welt haengt.
function _weltKatRank(kategorie) {
  if (kategorie === 'regel' || kategorie === 'technik') return 0;
  if (kategorie === 'sonstiges') return 2;
  return 1;
}

export function buildWeltfaktenBlock(welt, opts = {}) {
  if (!welt || welt.scanned === false) return null;
  const list = (Array.isArray(welt.fakten) ? welt.fakten : []).filter(f => f && f.fakt);
  if (!list.length) return null;
  const maxChars = Number(opts.maxChars) > 0 ? Number(opts.maxChars) : WELTFAKTEN_BLOCK_DEFAULT_MAX_CHARS;

  const sorted = list
    .map((f, i) => ({ f, i }))
    .sort((a, b) => _weltKatRank(a.f.kategorie) - _weltKatRank(b.f.kategorie) || a.i - b.i)
    .map(x => x.f);

  const rows = sorted.map(f => {
    const subj = f.subjekt ? `${f.subjekt}: ` : '';
    const kap = (f.kapitel || []).length ? ` (${f.kapitel.slice(0, 3).join(', ')})` : '';
    return `- [${f.kategorie || 'sonstiges'}] ${subj}${String(f.fakt).trim()}${kap}`;
  });

  const lead = [
    WELTFAKTEN_HEAD,
    '(Aus der Komplettanalyse extrahiert, nicht von der Autorin kuratiert — im Zweifel gilt der Buchtext.',
    'Form: [kategorie] Subjekt: Aussage (Kapitel). Beantwortet die Frage schon hier, rufe direkt `final_answer`.)',
  ];
  // Der Kappungs-Hinweis waechst mit den Zahlen darin, ein geschaetzter Overhead
  // reisst den Deckel deshalb gelegentlich. Darum EXAKT: rendern, und solange Zeilen
  // zurueckziehen, bis der fertige Block passt.
  const render = (shown) => {
    const rest = rows.length - shown.length;
    const parts = [...lead];
    if (rest > 0) {
      parts.push(`(NUR ${shown.length} von ${rows.length} Fakten aufgeführt — ${rest} weitere fehlen hier. `
        + 'Die Liste ist NICHT der vollständige Kanon; fehlt ein Fakt, frage `list_world_facts` mit kategorie/subjekt.)');
    }
    return [...parts, ...shown].join('\n');
  };
  // Grob vorfuellen (linear), damit ein Buch mit tausenden Fakten nicht tausendmal
  // gerendert wird; die Feinkorrektur unten braucht danach nur noch Einzelschritte.
  const estOverhead = lead.join('\n').length + 200;
  let fit = 0, used = 0;
  while (fit < rows.length && used + rows[fit].length + 1 + estOverhead <= maxChars) {
    used += rows[fit].length + 1;
    fit++;
  }
  let shown = rows.slice(0, Math.max(fit, 1));
  let text = render(shown);
  while (shown.length && text.length > maxChars) {
    shown = shown.slice(0, -1);
    text = render(shown);
  }
  if (!shown.length) return null;
  return { text, shown: shown.length, total: rows.length, chars: text.length };
}

/**
 * Baut den vollständigen System-Prompt für den Seiten-Chat.
 * @param {string}      pageName        Name der Seite
 * @param {string}      pageText        Aktueller Seiteninhalt als Plaintext
 * @param {Array}       figuren         Figuren-Array aus der DB (kann leer sein)
 * @param {Object}      review          Letzte Buchbewertung aus der DB (kann null sein)
 * @param {string|null} systemOverride  Optionaler System-Prompt-Override
 * @param {string|null} openingPageText Snapshot beim Chat-Öffnen; nur setzen wenn
 *                                      ungleich pageText (sonst null → keine
 *                                      redundante Section).
 * @param {Array}       ideen           Offene Ideen des Autors für diese Seite +
 *                                      das umliegende Kapitel — Notizen zu möglichen
 *                                      Fortsetzungen, Szenen, Ankern. Jedes Item hat
 *                                      `scope: 'page'|'chapter'`. KI darf sie
 *                                      aufgreifen/diskutieren, aber nicht
 *                                      eigenmächtig in Vorschläge umwandeln.
 * @param {Object|null} lektorat        Letztes Lektorat dieser Seite aus page_checks
 *                                      ({ checked_at, fehler, stilanalyse, fazit }).
 *                                      Kann gegenüber pageText veraltet sein.
 * @param {Object}      opts            { figurenMaxChars } — Zeichenbudget des
 *                                      Figuren-Blocks (siehe buildFigurenBlock).
 */
// Rückgabe: Array von System-Cache-Blöcken (für callAIChat → Claude separate
// cache_control-Blöcke; lokale Provider flatten sie auf einen String).
//   Block 1 (ttl '1h'): buch-stabiler Anteil (System + Figuren + Review) — ändert
//     sich weder über die Turns derselben Seite noch beim Seitenwechsel innerhalb
//     des Buchs. Der grosse SYSTEM_CHAT + die Figuren-JSON werden so über alle
//     Seiten-Chats eines Buchs aus dem Cache gelesen.
//   Block 2 (5min): seiten-spezifischer Anteil (Seitenname/-inhalt + Ideen +
//     Lektorat + JSON-Format-Trailer) — stabil über die Turns einer Seiten-Session,
//     invalidiert beim Seitenwechsel oder wenn der Autor die Seite editiert.
export function buildChatSystemPrompt(pageName, pageText, figuren, review, systemOverride = null, openingPageText = null, ideen = null, lektorat = null, opts = {}) {
  const stable = [systemOverride ?? SYSTEM_CHAT];

  // Figuren des KAPITELS (der Aufrufer filtert), trotzdem gebudgetet: auch ein
  // Kapitel-Ensemble trägt Volldossiers. opts.figurenMaxChars kommt aus dem
  // Kontextfenster des effektiven Providers.
  const figBlock = buildFigurenBlock(figuren, { maxChars: opts.figurenMaxChars });
  if (figBlock) stable.push('', figBlock.text);

  if (review) {
    stable.push('', '=== LETZTE BUCHBEWERTUNG ===', JSON.stringify({
      gesamtnote:  review.gesamtnote,
      fazit:       review.fazit,
      staerken:    review.staerken,
      schwaechen:  review.schwaechen,
    }, null, 2));
  }

  const page = [
    `Aktuelle Seite: «${pageName}»`,
    '',
  ];

  if (openingPageText) {
    page.push(
      '=== SEITENINHALT BEIM CHAT-START ===',
      openingPageText,
      '',
      '=== SEITENINHALT JETZT (nach Änderungen des Autors) ===',
      pageText,
      '',
      'Hinweis: Der Autor hat die Seite seit Chat-Start verändert. Beziehe dich beim Antworten auf den aktuellen Stand; verweise nur auf den Chat-Start-Stand, wenn die Änderung selbst Thema ist.',
      '',
    );
  } else {
    page.push(
      '=== SEITENINHALT ===',
      pageText,
      '',
    );
  }

  if (Array.isArray(ideen) && ideen.length > 0) {
    page.push('=== OFFENE IDEEN (Notizen des Autors für diese Seite + das umliegende Kapitel) ===');
    for (const i of ideen) {
      const datum = i.created_at ? ` (${i.created_at.slice(0, 10)})` : '';
      const tag = i.scope === 'chapter' ? '[Kapitel] ' : '[Seite] ';
      page.push(`- ${tag}${i.content}${datum}`);
    }
    page.push('');
    page.push('Hinweis: Diese Ideen sind Notizen des Autors zu möglichen Fortsetzungen, Szenen oder inhaltlichen Ankern. [Kapitel]-Notizen gelten fürs ganze Kapitel, [Seite]-Notizen nur für diese Seite. Greife sie auf, hinterfrage oder ergänze sie konversationell — wandle sie aber nicht eigenmächtig in vorschlaege-Einträge um, solange der Autor nicht danach fragt.');
    page.push('');
  }

  if (lektorat && ((Array.isArray(lektorat.fehler) && lektorat.fehler.length > 0) || lektorat.stilanalyse || lektorat.fazit)) {
    const datum = lektorat.checked_at ? lektorat.checked_at.slice(0, 16).replace('T', ' ') : null;
    page.push(`=== LETZTES LEKTORAT DIESER SEITE${datum ? ` (Stand ${datum})` : ''} ===`);
    page.push(JSON.stringify({
      ...(Array.isArray(lektorat.fehler) && lektorat.fehler.length > 0 ? { fehler: lektorat.fehler } : {}),
      ...(lektorat.stilanalyse ? { stilanalyse: lektorat.stilanalyse } : {}),
      ...(lektorat.fazit ? { fazit: lektorat.fazit } : {}),
    }, null, 2));
    page.push('');
    page.push('Hinweis: Diese Beanstandungen stammen aus einem früheren Lektoratslauf. Der Seitentext kann seitdem überarbeitet worden sein — prüfe gegen den aktuellen Seiteninhalt, bevor du dich darauf beziehst. Wiederhole bereits erledigte Punkte nicht; greife noch offene Beanstandungen auf, wenn der Autor danach fragt oder daran arbeitet.');
    page.push('');
  }

  page.push(
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
    'VORSCHLÄGE-REGELN:',
    '- Wenn du stilistische, inhaltliche oder sprachliche Schwächen erkennst oder der Autor nach Verbesserungen fragt: liefere mindestens einen konkreten Vorschlag mit original und ersatz.',
    '- original muss zeichengenau mit dem Seitentext übereinstimmen.',
    '- ersatz muss den Stil des Autors beibehalten.',
    '- vorschlaege ist nur dann ein leeres Array, wenn die Frage rein inhaltlich/konzeptionell ist und keine Textstelle betrifft (z.B. Plotfragen, Figurenmotivation).',
    ...(_isLocal ? [] : ['', JSON_ONLY]),
  );

  return [
    { text: stable.join('\n'), ttl: '1h' },
    { text: page.join('\n') },
  ];
}

/**
 * Baut den System-Prompt für den Agentic Buch-Chat (Tool-Use-Modus).
 * Unterscheidet sich von buildBookChatSystemPrompt: enthält KEINE Seiteninhalte,
 * dafür eine Anweisung an das Modell, Werkzeuge aufzurufen statt zu raten.
 * Figuren + Review bleiben im System-Prompt (klein, gecacht).
 */
// Synthese-Aufforderung für den Fall, dass die Werkzeug-Iterationen erschöpft
// sind, ohne dass das Modell final_answer gerufen hat. Statt mit einem Fehler
// aufzugeben, wird das Modell mit dieser Nachricht (und nur noch final_answer als
// verfügbarem Werkzeug) gezwungen, aus dem bereits Gesammelten zu antworten.
export const BOOK_CHAT_FORCE_FINAL_INSTRUCTION =
  'Du hast die maximale Zahl an Recherche-Iterationen erreicht — keine weitere Recherche mehr möglich. '
  + 'Fasse JETZT aus den bereits gesammelten Informationen die bestmögliche Antwort zusammen und liefere sie über das Werkzeug `final_answer`. '
  + 'Wenn die Recherche unvollständig blieb, beantworte die Frage so weit wie möglich mit dem Vorhandenen und weise kurz darauf hin, was nicht abgedeckt werden konnte. '
  + 'Sprache der Antwort: die der Userfrage.';

// Rückgabe: Array von System-Cache-Blöcken (wie buildBookChatSystemPrompt).
//   Block 1 (ttl '1h'): der über die Session stabile Anteil (System, Werkzeug-
//     Strategie, Figuren, Review, final_answer-Pflicht). Tools + dieser Block sind
//     der Cache-Präfix jeder Iteration — deshalb steht hier alles, was sich
//     innerhalb der Session nicht ändert.
//   Block 2 (cache:false): der Erst-Kontext (semantisch nächste Passagen zur
//     AKTUELLEN Frage). Bewusst ohne Breakpoint: er trägt pro Frage andere Bytes,
//     ein Breakpoint wäre ein cache_write, das nie gelesen wird. Steht am Ende,
//     damit Block 1 ein stabiler Präfix bleibt.
export function buildBookChatAgentSystemPrompt(bookName, figuren, review, systemOverride = null, maxToolIter = 6, opts = {}) {
  // opts.semantic === false: der Embedding-Endpunkt fehlt, `search_similar` wird dem
  // Modell gar nicht angeboten (Filter in routes/jobs/chat/book-chat.js#prepare) — dann
  // darf der Prompt es auch nicht empfehlen, sonst verbrennt das Modell eine Runde an
  // einem Werkzeug, das es nicht hat.
  const semantic = opts.semantic !== false;
  // opts.toolNames: die TATSÄCHLICH angebotenen Werkzeuge (Slim-Satz bei lokalen
  // Providern). Dieselbe Regel wie bei `semantic`, nur für alle übrigen: was nicht
  // angeboten wird, darf der Prompt nicht empfehlen. Ohne Angabe: alles erlaubt.
  const offered = opts.toolNames ? new Set(opts.toolNames) : null;
  const has = (name) => !offered || offered.has(name);
  // Zeile nur aufnehmen, wenn mindestens eines der genannten Werkzeuge angeboten wird.
  const ifAny = (names, line) => (names.some(has) ? [line] : []);
  const parts = [
    systemOverride ?? SYSTEM_BOOK_CHAT,
    '',
    `Buch: «${bookName}»`,
    '',
    'Du hast Zugriff auf Werkzeuge, die Fragen über das gesamte Buch aus einem vorberechneten Index beantworten. Nutze sie, bevor du antwortest, wann immer die Frage gemessen oder aus konkreten Textstellen belegt werden kann:',
    ...ifAny(['count_pronouns', 'get_stil_metrics'], '- Häufigkeit, Verteilung, Erzählperspektive → count_pronouns, get_stil_metrics'),
    ...ifAny(['get_figure_mentions'], '- Figurenverteilung, erstes Auftreten → get_figure_mentions, list_chapters'),
    ...ifAny(['search_passages', 'quote_match'], `- Konkrete Textstellen oder Zitate → search_passages, quote_match${has('quote_passage') ? ', quote_passage' : ''}`),
    ...(semantic && has('search_similar') ? ['- Stellen nach SINN suchen, wenn du das Stichwort nicht kennst → search_similar'] : []),
    ...ifAny(['get_chapter_text'], '- Ganze Kapitel lesen → get_chapter_text (statt list_chapters→get_pages)'),
    ...ifAny(['get_figure_profile', 'get_figure_relations'], '- Wer ist X, wer kennt wen → get_figure_profile, get_figure_relations'),
    ...ifAny(['get_lektorat_hotspots', 'get_lektorat_findings'], '- Lektorat: Übersicht → get_lektorat_hotspots, konkrete Findings → get_lektorat_findings'),
    ...ifAny(['get_reviews'], '- Kapitel-Qualität, Stärken/Schwächen → get_reviews'),
    ...ifAny(['get_plot_board'], '- Geplante Handlung / Beat-Board / was noch nicht geschrieben ist → get_plot_board'),
    ...ifAny(['get_motifs', 'get_motif_occurrences'], '- Geplante Themen & Motive, Soll/Ist-Abgleich (welche Motive fehlen im Text) → get_motifs, get_motif_occurrences'),
    '',
    'Rufe Werkzeuge an, bevor du vermutest.',
    'KOSTEN-LEITER — nimm die billigste Quelle, die die Frage beantwortet, und HÖRE DANN AUF:',
    '  Stufe 1 (gratis, schon da): der ERST-KONTEXT am Ende dieses Prompts (semantisch nächste Passagen zur aktuellen Frage) plus die Blöcke FIGUREN, WELT-FAKTEN und BUCHBEWERTUNG. Beantwortet das die Frage, rufst du SOFORT `final_answer` — ohne ein einziges Recherche-Werkzeug.',
    `  Stufe 2 (billig, gezielt): ${semantic && has('search_similar') ? '`search_similar` (Sinn), ' : ''}\`search_passages\` (Wortlaut), \`get_figure_profile\`, \`get_figure_mentions\`, \`get_timeline\`, \`quote_match\`. Diese liefern Passagen, keine Volltexte.`,
    '  Stufe 3 (teuer, Volltext): `get_pages`, `get_chapter_text`. Nur wenn die Frage den ZUSAMMENHANG längerer Passagen braucht — Zusammenfassen, Aufbau/Dramaturgie eines Kapitels, Auswahl über den ganzen Text.',
    'Schmale Faktenfragen — Alter, Datum, Beruf, Wohnort, Verwandtschaft, «wann hat X …», «wie heisst Y» — werden auf Stufe 1 oder 2 beantwortet. Lade dafür NIE ein ganzes Kapitel und nie das ganze Buch: ein einzelner Fakt steht in einer Passage, nicht in einem Kapitel.',
    'STRATEGIE — Suche vs. Lektüre: `search_passages` ist Stichwort-Suche („wo kommt das bekannte Wort/der Name X vor?"). Für SEMANTISCHE Aufgaben, bei denen du Stellen nach einer EIGENSCHAFT auswählst (lustigste/schönste/spannendste/traurigste Stellen, Humor, Ton, Stimmung, Beispiele für ein Stilmittel) hat das Gesuchte KEINE Stichwort-Signatur — rate dann NICHT mit search_passages nach Wörtern. Lies stattdessen den Text selbst: lade ganze Kapitel via `get_chapter_text` (mehrere gebündelt in einer Runde) und wähle die Stellen aus eigener Lektüre aus. Bei kleinen/mittleren Büchern, die in den Kontext passen (siehe `hint` aus list_chapters), lade gleich das ganze Buch statt es in vielen Runden zu durchforsten. Das gilt NUR für Aufgaben, die den ganzen Text sichten müssen. Dass ein Buch in den Kontext passt, ist kein Grund, es für eine einzelne Faktenfrage zu laden.',
    'Wörtliche Zitate: IMMER über quote_match (Pattern → Stelle) oder quote_passage (offset+length) holen, NIE aus Erinnerung paraphrasieren. Beim final_answer-Call jedes wörtliche Zitat in `zitate` mitliefern — Server validiert.',
    `Maximal ${maxToolIter} Werkzeug-Iterationen pro Antwort (eine Iteration = eine Runde, NICHT ein Tool-Call). Halte Werkzeug-Argumente präzise und kurz. Die Iterationen sind knapp — verschwende sie nicht mit seriellem Stichwort-Raten, wenn ein paar gebündelte get_chapter_text-Calls den ganzen relevanten Text in einer Runde liefern.`,
    'WICHTIG — bündle Werkzeuge: Rufe in EINER Runde alle Werkzeuge parallel auf, die nicht voneinander abhängen, statt eines nach dem anderen. Bei breiten Aufgaben (z.B. „Zitate/Stellen aus vielen Kapiteln") gleich mehrere search_passages/get_chapter_text gleichzeitig absetzen. Erst danach in der nächsten Runde zitieren/auswerten. So reichen die Iterationen auch für umfangreiche Recherchen.',
    '',
  ];

  // Werkzeuge sind hier der Ausweg aus dem Budget: was der Block nicht trägt, holt
  // das Modell bei Bedarf gezielt via get_figure_profile / get_figure_relations.
  const figBlock = buildFigurenBlock(figuren, { maxChars: opts.figurenMaxChars, detailTools: true });
  if (figBlock) {
    parts.push(figBlock.text);
    parts.push('');
  }

  // Welt-Fakten: buch-stabil, darum hier im gecachten Block 1 und NICHT im
  // Erst-Kontext (der wechselt pro Frage und wird jede Iteration neu bezahlt).
  const weltBlock = buildWeltfaktenBlock(opts.welt, { maxChars: opts.weltfaktenMaxChars });
  if (weltBlock) {
    parts.push(weltBlock.text);
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
    'Liefere deine finale Antwort IMMER über das Werkzeug `final_answer` (Pflicht-Endpunkt). Kein Freitext-Output ohne Tool-Call — auch wenn keine Recherche-Tools nötig sind, muss die Antwort via final_answer kommen. Sprache der Antwort: passe dich der Sprache der Userfrage an, nicht der Sprache dieses Prompts.',
  );

  // Werkzeug-Disziplin für lokale/kleinere Modelle. Nicht Stil, sondern die drei
  // Fehler, die den Loop dort tatsächlich zerlegen: erfundene Werkzeugnamen,
  // Aufrufe als Text statt als Tool-Call, und Werkzeug-Schleifen ohne Abschluss.
  if (_isLocal) {
    parts.push(
      '',
      'WERKZEUG-DISZIPLIN (verbindlich):',
      '- Rufe NUR Werkzeuge aus der bereitgestellten Liste. Ein Werkzeug, das dort nicht steht, existiert nicht — erfinde keine Namen und keine Parameter.',
      '- Rufe Werkzeuge über den Werkzeug-Mechanismus, NIE indem du den Aufruf als Text oder JSON in die Antwort schreibst.',
      '- Argumente als gültiges JSON, nur die dokumentierten Felder.',
      '- Höre auf zu recherchieren, sobald du antworten kannst, und rufe dann `final_answer`. Wiederhole keinen Aufruf, der schon ein Ergebnis geliefert hat.',
      '- Steht die Antwort schon im ERST-KONTEXT, rufe sofort `final_answer` — ohne ein einziges Recherche-Werkzeug.',
    );
  }

  return [
    { text: parts.join('\n'), ttl: '1h' },
    { text: buildBookChatPreContext(opts.passages), cache: false },
  ];
}

/**
 * Erst-Kontext-Block des agentischen Buch-Chats: die semantisch nächsten Passagen
 * zur aktuellen Frage, vorab geholt über dieselbe Pipeline wie `search_similar`.
 * `passages` = [{ kind, entity_id, title, score, text }] (siehe
 * routes/jobs/chat/book-chat-retrieval.js#preContextPassages) oder leer/null.
 *
 * Ohne Treffer bleibt der Hinweis stehen, dass Stufe 1 der Kosten-Leiter diesmal
 * leer ist — sonst deutet das Modell das Fehlen des Blocks als «kein Index» und
 * überspringt gleich auf die Volltext-Werkzeuge.
 */
export function buildBookChatPreContext(passages) {
  const list = Array.isArray(passages) ? passages : [];
  const head = ['=== ERST-KONTEXT: SEMANTISCH NÄCHSTE STELLEN ZUR AKTUELLEN FRAGE ==='];
  if (!list.length) {
    head.push('(Keine Treffer — entweder ist die Frage nicht textbezogen oder der Bedeutungs-Index ist leer. Weiter auf Stufe 2 der Kosten-Leiter.)');
    return head.join('\n');
  }
  head.push(
    '(Automatisch vorab geholt, dieselbe Pipeline wie `search_similar`; nach Ähnlichkeit sortiert, Ausschnitte können unvollständig sein.',
    'Beantworten diese Stellen die Frage, antworte direkt via `final_answer` — kein weiteres Werkzeug. Sonst arbeite von hier aus weiter:',
    '`entity_id` einer Seite geht als page_id in `get_pages`/`quote_match`. Wörtliche Zitate IMMER über quote_match/quote_passage verifizieren, nie aus diesem Ausschnitt abschreiben.)',
  );
  for (const p of list) {
    head.push(`--- ${p.kind}: «${p.title}» (entity_id ${p.entity_id}, score ${p.score}) ---`, p.text, '');
  }
  return head.join('\n');
}

// Werkzeug-Definitionen für den Agentic Buch-Chat: docs/buchchat-tools.md.
export { BOOK_CHAT_TOOLS, BOOK_CHAT_SLIM_TOOL_NAMES } from './book-chat-tools.js';


// Rückgabe: Array von System-Cache-Blöcken (für callAIChat → Claude separate
// cache_control-Blöcke; lokale Provider flatten sie auf einen String).
//   Block 1 (ttl '1h'): buch-stabiler Anteil (System + Buchname + Figuren +
//     Review) — ändert sich über die Turns einer Session nicht. Der potenziell
//     grosse Figuren-/Review-Kontext wird so über alle Turns aus dem Cache gelesen.
//   Block 2 (cache:false): die pro Query neu keyword-selektierten Buchseiten +
//     JSON-Format-Trailer. Bewusst OHNE Breakpoint, weil der Block jede Runde
//     andere Seiten trägt — ein Breakpoint wäre ein cache_write ohne je gelesen
//     zu werden. Steht am Ende, damit Block 1 ein stabiler Präfix bleibt.
export function buildBookChatSystemPrompt(bookName, relevantPages, figuren, review, systemOverride = null, opts = {}) {
  const stable = [
    systemOverride ?? SYSTEM_BOOK_CHAT,
    '',
    `Buch: «${bookName}»`,
  ];

  const figBlock = buildFigurenBlock(figuren, { maxChars: opts.figurenMaxChars });
  if (figBlock) stable.push('', figBlock.text);

  if (review) {
    stable.push('', '=== LETZTE BUCHBEWERTUNG ===', JSON.stringify({
      gesamtnote:  review.gesamtnote,
      fazit:       review.fazit,
      staerken:    review.staerken,
      schwaechen:  review.schwaechen,
    }, null, 2));
  }

  const volatil = [];
  if (relevantPages && relevantPages.length > 0) {
    // excerpt=true: die Textstellen sind semantisch retrievte Chunk-Auszüge (Mini-RAG),
    // nicht ganze Seiten — das Modell darf daraus nicht auf Vollständigkeit der Seite schliessen.
    const excerpt = opts.excerpt === true;
    if (excerpt) {
      volatil.push('=== RELEVANTE TEXTSTELLEN AUS DEM BUCH ===');
      volatil.push('(Bedeutungs-relevanteste Auszüge, nach Ähnlichkeit sortiert; können unvollständig sein.)');
    } else {
      volatil.push('=== RELEVANTE BUCHSEITEN ===');
    }
    for (const page of relevantPages) {
      volatil.push(excerpt ? `--- Auszug aus Seite: ${page.name} ---` : `--- Seite: ${page.name} ---`);
      volatil.push(page.text);
      volatil.push('');
    }
  }

  volatil.push(
    'Antworte immer im folgenden JSON-Format:',
    '{',
    '  "antwort": "Deine Antwort als Freitext (Markdown erlaubt)"',
    '}',
    ...(_isLocal ? [] : ['', JSON_ONLY]),
  );

  return [
    { text: stable.join('\n'), ttl: '1h' },
    { text: volatil.join('\n'), cache: false },
  ];
}

// ── Chat-Titel ────────────────────────────────────────────────────────────────

/**
 * System-Prompt für die KI-Zusammenfassung eines Chat-Verlaufs zu einem kurzen
 * History-Titel. Genutzt von allen drei Chats (Seiten-/Buch-/Recherche-Chat) über
 * routes/jobs/chat-title.js. Bewusst knapp — der Titel steht in einer schmalen
 * History-Liste, nicht als ganzer Satz.
 */
export function buildChatTitlePrompt() {
  const parts = [
    'Du erstellst einen sehr kurzen, prägnanten Titel für einen Chat-Verlauf.',
    'Fasse das Thema der folgenden Konversation in maximal 6 Wörtern zusammen.',
    'Regeln:',
    '- Verwende dieselbe Sprache wie die Konversation.',
    '- Beschreibe das Thema; wiederhole nicht wörtlich die ganze Frage.',
    '- Kein Schlusspunkt, keine Anführungszeichen, keine Emojis, keine Aufzählung.',
    '',
    'Antworte ausschliesslich als JSON-Objekt: {"titel": "…"}',
  ];
  if (!_isLocal) parts.push('', JSON_ONLY);
  return parts.join('\n');
}

export const SCHEMA_CHAT_TITLE = _obj({ titel: _str });

// ── Schemas ──────────────────────────────────────────────────────────────────

export const SCHEMA_CHAT = _obj({
  antwort: _str,
  vorschlaege: {
    type: 'array',
    items: _obj({ original: _str, ersatz: _str, begruendung: _str }),
  },
});

export const SCHEMA_BOOK_CHAT = _obj({ antwort: _str });
