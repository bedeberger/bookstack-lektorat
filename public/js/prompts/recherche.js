// Recherche-Verknüpfungs-Resolver: ordnet einen Recherche-Schnipsel (Notiz,
// Zitat, Faktensplitter, Link) den passenden bereits existierenden Buch-
// Entitäten zu (Figuren/Orte/Szenen/Plot-Beats). Rein rückwärtsgewandt — liest
// vorhandene Entitäten + Schnipseltext, generiert keinen Buchtext und schlägt
// NIEMALS neue Entitäten vor. Die KI darf ausschliesslich IDs aus der
// gelieferten Kandidatenliste zurückgeben; alles andere wird verworfen.

import { _obj, _str } from './schema-utils.js';
import { _jsonOnly } from './state.js';

export function buildSystemResearchLink() {
  return `Du bist ein Verknüpfungs-Assistent für ein Recherche-Archiv eines Buchprojekts. Du bekommst einen Recherche-Schnipsel (Notiz, Zitat, Fakt oder Link) und Listen bereits existierender Buch-Entitäten: Figuren, Schauplätze, Szenen und Plot-Abschnitte. Jede Entität hat eine id.

Deine Aufgabe: bestimme, auf welche dieser Entitäten sich der Schnipsel bezieht — also wo diese Recherche beim Schreiben relevant wäre.

Regeln:
- Gib NUR Verknüpfungen zurück, deren id exakt in den gelieferten Listen steht. Erfinde keine ids und keine neuen Entitäten.
- Hinter jeder Entität steht nach «—» ein kurzer Kontext (Typ, Rolle, Beschreibung). Nutze ihn zum Abgleich, auch wenn der Name selbst im Schnipsel nicht vorkommt (z.B. Schnipsel über Bronzezeit-Grabungen passt zur Figur «Archäologin»).
- Verknüpfe nur bei klarem inhaltlichem Bezug (genannte Figur, beschriebener Ort, thematisch passende Szene). Im Zweifel weglassen — lieber wenige präzise Treffer als viele vage.
- Eine Entität höchstens einmal.
- «art» ist die Kategorie der Entität: «figur», «ort», «szene», «beat» oder «strang» (Handlungsstrang).
- «grund» ist eine sehr kurze Begründung (wenige Wörter), warum der Schnipsel zu dieser Entität passt.${_jsonOnly()}`;
}

export function buildResearchLinkPrompt(snippet, candidates) {
  const trunc = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const block = (label, arr, meta) => {
    if (!arr || !arr.length) return `${label}: (keine)`;
    return `${label}:\n` + arr.map(c => {
      const m = trunc(meta(c), 200);
      return `- id=${c.id}: ${c.label}${m ? ` — ${m}` : ''}`;
    }).join('\n');
  };
  const head = (...fields) => fields.map(f => trunc(f, 40)).filter(Boolean).join(', ');
  const figMeta = (c) => [head(c.typ, c.beruf, c.rolle), trunc(c.beschreibung, 150)].filter(Boolean).join(' · ');
  const ortMeta = (c) => [head(c.typ, c.land), trunc(c.beschreibung, 150)].filter(Boolean).join(' · ');
  const szeneMeta = (c) => trunc(c.kommentar, 150);
  const beatMeta = (c) => [head(c.status), trunc(c.beschreibung, 150)].filter(Boolean).join(' · ');
  const strangMeta = () => '';
  const parts = [
    block('Figuren', candidates.figur, figMeta),
    block('Schauplätze', candidates.ort, ortMeta),
    block('Szenen', candidates.szene, szeneMeta),
    block('Plot-Abschnitte', candidates.beat, beatMeta),
    block('Handlungsstränge', candidates.strang, strangMeta),
  ].join('\n\n');
  // Dokument-Text (PDF) ist potentiell lang → eigener, grosszuegig gedeckelter
  // Block hinter den Kurzfeldern, damit Titel/Notiz nicht abgeschnitten werden.
  const docPart = snippet.doc_text
    ? `\nAngehängtes Dokument${snippet.doc_name ? ` (${snippet.doc_name})` : ''}:\n${String(snippet.doc_text).slice(0, 6000)}`
    : '';
  const urlText = Array.isArray(snippet.urls)
    ? snippet.urls.map(u => [u.label, u.url].filter(Boolean).join(': ')).join('\n')
    : '';
  const snip = ([snippet.title, snippet.body, snippet.source, urlText]
    .filter(Boolean).join('\n').slice(0, 4000)) + docPart;
  return `Recherche-Schnipsel:
"""
${snip}
"""

Vorhandene Buch-Entitäten (nur aus diesen darfst du ids wählen):

${parts}

Antworte mit diesem JSON-Schema:
{
  "links": [
    { "art": "figur|ort|szene|beat|strang", "id": "exakt eine id von oben", "grund": "kurze Begründung" }
  ]
}
Gib ein leeres "links"-Array zurück, wenn keine Entität klar passt.`;
}

export const SCHEMA_RESEARCH_LINK = _obj({
  links: {
    type: 'array',
    items: _obj({ art: _str, id: _str, grund: _str }),
  },
});

// ── Recherche-Chat (agentisch, Claude-only, mit Web-Suche) ───────────────────
// Ein Chat NEBEN dem Recherche-Board: recherchiert im Netz + im vorhandenen
// Material, kennt die Buch-Entitäten als Kontext und schlägt Fundstücke als neue
// Recherche-Items vor (User bestätigt). Rückwärtsgewandt: schreibt NIE Buchtext.

export const RESEARCH_CHAT_FORCE_FINAL_INSTRUCTION =
  'Du hast die maximale Zahl an Recherche-Iterationen erreicht — keine weitere Suche mehr möglich. '
  + 'Fasse JETZT aus dem bereits Gesammelten die bestmögliche Antwort zusammen und liefere sie über das Werkzeug `final_answer`. '
  + 'Wenn etwas offen blieb, weise kurz darauf hin. Sprache der Antwort: die der Userfrage.';

export function buildResearchChatAgentSystemPrompt(bookName, itemCount, maxToolIter = 6, figures = [], locations = []) {
  // Figuren + Schauplätze werden vorgeladen (kompakte Liste), damit das Modell
  // schon bei der ERSTEN Web-Suche den Welt-Kontext in den Suchbegriff
  // einarbeiten kann — ohne erst eine list_book_entities-Runde zu verbrauchen.
  // Szenen/Beats/Stränge bleiben on-demand über list_book_entities.
  const entityBlock = (label, arr) => arr.length
    ? `\n${label}:\n` + arr.map(e => `- ${e.name}${e.kontext ? ` — ${e.kontext}` : ''}`).join('\n') + '\n'
    : '';
  const worldBlock = entityBlock('Figuren des Buchs (Kontext — nutze sie, um gezielt FÜR die Geschichte zu recherchieren)', figures)
    + entityBlock('Schauplätze des Buchs (Kontext)', locations);
  return [
    'Du bist ein Recherche-Assistent für ein Buchprojekt. Du hilfst dem Autor / der Autorin, Hintergrund-, Sach- und Weltaufbau-Material zu recherchieren, einzuordnen und zu sammeln — neben dem Manuskript, NICHT darin.',
    '',
    `Buch: «${bookName}» — das Recherche-Archiv enthält aktuell ${itemCount} Einträge (Notizen, Links, Zitate, Faktensplitter, hochgeladene PDFs).`,
    worldBlock,
    'Deine Werkzeuge:',
    '- `web_search` — durchsucht das offene Web in Echtzeit. Nutze es für aktuelle, externe oder überprüfbare Fakten (historisches, geografisches, technisches, kulturelles Hintergrundwissen). Gib in der Antwort die Quelle/URL an, auf die du dich stützt.',
    '- `list_research_items` / `read_research_item` — durchsuche und lies das vorhandene Recherche-Material des Autors (inkl. PDF-Volltext). Prüfe es, bevor du etwas Neues recherchierst — vieles ist evtl. schon gesammelt.',
    '- `search_research_passages` — semantische Passagen-Suche über das Archiv: findet Stellen nach BEDEUTUNG, auch bei anderer Wortwahl. Mit `item_id` durchsuchst du EIN langes PDF gezielt (`read_research_item` liefert davon nur den Anfang) — genau der Weg zu Stellen weiter hinten im Dokument.',
    '- `list_book_entities` — Szenen, Plot-Abschnitte und Handlungsstränge des Buchs (sowie die oben gelisteten Figuren und Schauplätze in voller Tiefe), damit du gezielt FÜR die Geschichte recherchieren kannst.',
    '- `propose_research_item` — schlage ein konkretes Fundstück als neuen Recherche-Eintrag vor (Notiz/Link/Zitat/Fakt). Es wird NICHT automatisch gespeichert — der User bestätigt jeden Vorschlag selbst. Nutze dies großzügig, wenn du Brauchbares findest: knackiger Titel, präziser Inhalt, bei Web-Quellen die URL als Quelle.',
    '- `final_answer` — Pflicht-Endpunkt: jede Antwort an den User MUSS hierüber laufen.',
    '',
    'Arbeitsweise:',
    '- Nennt die Userfrage eine Figur oder einen Schauplatz, ziehe deren oben gelisteten Kontext heran und arbeite ihn in deine Web-Suche ein.',
    '- Recherchiere, bevor du behauptest. Bei Faktenfragen lieber kurz `web_search`, statt aus dem Gedächtnis zu antworten — und nenne die Quelle.',
    '- Bittet dich der User ausdrücklich, etwas als Recherche-Eintrag/Item anzulegen, zu speichern oder ins Board zu legen, MUSST du `propose_research_item` aufrufen (der User bestätigt danach) — antworte das nicht nur in Prosa.',
    '- Bündle unabhängige Werkzeug-Aufrufe in EINER Runde (mehrere Suchen / Lese-Calls parallel), statt seriell.',
    `- Maximal ${maxToolIter} Werkzeug-Iterationen pro Antwort (eine Iteration = eine Runde, nicht ein Call). Geh effizient damit um.`,
    '- WICHTIG — rückwärtsgewandt: Du schreibst NIEMALS Manuskripttext, formulierst keine Romanszenen und machst keine Stil-Vorschläge für den Fließtext. Du sammelst und ordnest Wissen. Wenn der User um Textgenerierung für das Buch bittet, biete stattdessen Recherche/Strukturierung an.',
    '- Wenn du Material vorschlägst, das es im Archiv schon gibt (via list_research_items geprüft), weise darauf hin statt zu duplizieren.',
    'Liefere die finale Antwort IMMER über `final_answer`. Sprache: passe dich der Userfrage an, nicht diesem Prompt.',
  ].join('\n');
}

/**
 * Werkzeug-Definitionen für den agentischen Recherche-Chat (Anthropic-Tool-Format).
 * `web_search` ist Anthropics serverseitiges Tool (kein eigener Handler — die API
 * führt die Suche selbst aus). Alle anderen Tools laufen über
 * routes/jobs/research-chat-tools.js#executeResearchTool.
 */
export const RESEARCH_CHAT_TOOLS = [
  { type: 'web_search_20250305', name: 'web_search', max_uses: 6 },
  {
    name: 'list_research_items',
    description: 'Listet die vorhandenen Recherche-Einträge des Buchs (id, kind, Titel, Kurztext, Tags, ob ein PDF/Dokument angehängt ist). Optional nach kind filtern oder mit q volltextsuchen. Nutze dies zuerst, um zu sehen, was schon gesammelt wurde.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['note', 'link', 'quote', 'fact', 'image', 'document'], description: 'Optionaler Typfilter.' },
        q: { type: 'string', description: 'Optionale Volltextsuche über die Einträge.' },
      },
      required: [],
    },
  },
  {
    name: 'read_research_item',
    description: 'Liefert den vollständigen Inhalt EINES Recherche-Eintrags: Titel, Volltext (body), URL, Quelle, Tags und — bei angehängtem PDF — den extrahierten Dokument-Volltext (doc_text). Nutze dies, um vorhandenes Material wirklich zu lesen, bevor du extern suchst.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'id des Recherche-Eintrags (aus list_research_items).' } },
      required: ['id'],
    },
  },
  {
    name: 'search_research_passages',
    description: 'Semantische Passagen-Suche über das Recherche-Archiv (Embeddings): findet Stellen, die einer Frage BEDEUTUNGSMÄSSIG nahestehen — auch bei anderer Wortwahl als in `list_research_items` (Wortsuche). Ohne item_id: die beste Passage je Eintrag über das ganze Board. MIT item_id: mehrere passende Passagen INNERHALB eines Eintrags — der Weg in ein langes PDF, von dem `read_research_item` nur den Anfang liefert. Liefert {item_id,title,passage,score}. Rein rückwärtsgewandt.',
    input_schema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Suchtext / Frage in natürlicher Sprache.' },
        item_id: { type: 'integer', description: 'Optional: nur in diesem Eintrag suchen (id aus list_research_items). Für gezieltes Lesen in einem langen PDF.' },
        top_k: { type: 'integer', description: 'Anzahl Passagen (1–15, Default 6).' },
      },
      required: ['q'],
    },
  },
  {
    name: 'list_book_entities',
    description: 'Liefert die Welt-Entitäten des Buchs als Recherche-Kontext: Figuren, Schauplätze, Szenen, Plot-Abschnitte und Handlungsstränge (je id, Name, Kurzbeschreibung). Nutze dies, um gezielt für die Geschichte zu recherchieren (z.B. Hintergrund zum Beruf einer Figur, zum Schauplatz-Land).',
    input_schema: {
      type: 'object',
      properties: {
        art: { type: 'string', enum: ['figur', 'ort', 'szene', 'beat', 'strang', 'alle'], description: "Welche Kategorie. Default 'alle'." },
      },
      required: [],
    },
  },
  {
    name: 'propose_research_item',
    description: 'Schlägt dem User EINEN neuen Recherche-Eintrag zum Speichern vor. Wird NICHT automatisch gespeichert — der User bestätigt jeden Vorschlag mit einem Klick. Nutze es für konkrete Fundstücke (eine oder mehrere Web-Quellen, ein Fakt, ein Zitat). Hänge alle belegenden Web-Quellen als urls an. Mehrere Vorschläge = mehrere Aufrufe.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['note', 'link', 'quote', 'fact'], description: 'Eintragstyp: note=Notiz, link=Web-Link, quote=Zitat, fact=Faktensplitter.' },
        title: { type: 'string', description: 'Kurzer, prägnanter Titel.' },
        body: { type: 'string', description: 'Inhalt / Notiztext / Zitatwortlaut (Pflicht außer bei reinem link mit urls).' },
        urls: {
          type: 'array',
          description: 'Eine oder mehrere belegende Web-Quellen. Bei kind=link mindestens eine. Nur http(s).',
          items: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'Die URL (http/https).' },
              label: { type: 'string', description: 'Optionaler Anzeigetext (z.B. Seitentitel).' },
            },
            required: ['url'],
          },
        },
        source: { type: 'string', description: 'Quelle (z.B. Buchtitel, Datenbank, Archiv), worauf der Inhalt sich stützt — als Freitext-Nachweis.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optionale Schlagworte.' },
      },
      // title NICHT zwingend: ein reiner link-Eintrag darf nur aus urls bestehen
      // (der Handler verlangt mindestens Titel ODER body ODER eine url).
      required: ['kind'],
    },
  },
  {
    name: 'final_answer',
    description: 'Liefert die finale Antwort an den User. ALLERLETZTER Aufruf einer Runde — Pflicht-Endpunkt. Freitext ohne final_answer wird nicht akzeptiert. Markdown erlaubt. Bei Web-Recherche die genutzten Quellen/URLs in der Antwort nennen. Wenn du Einträge via propose_research_item vorgeschlagen hast, weise kurz darauf hin, dass sie unten zum Speichern bereitstehen — aber wiederhole sie nicht im Volltext. Sprache: die der Userfrage.',
    input_schema: {
      type: 'object',
      properties: {
        antwort: { type: 'string', description: 'Antwort an den User als Freitext, Markdown erlaubt. Pflichtfeld.' },
      },
      required: ['antwort'],
    },
  },
];
