// Seiten-Chat + Buch-Chat (klassisch + Agentic) Prompt-Builder.
// Liest SYSTEM_CHAT/SYSTEM_BOOK_CHAT live-bound aus core.js (von configurePrompts gesetzt).

import { _isLocal, JSON_ONLY } from './state.js';
import { _obj, _str } from './schema-utils.js';
import { SYSTEM_CHAT, SYSTEM_BOOK_CHAT } from './core.js';

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
 * @param {Array}       ideen           Offene Ideen des Autors für diese Seite —
 *                                      Notizen zu möglichen Fortsetzungen, Szenen,
 *                                      Ankern. KI darf sie aufgreifen/diskutieren,
 *                                      aber nicht eigenmächtig in Vorschläge umwandeln.
 */
export function buildChatSystemPrompt(pageName, pageText, figuren, review, systemOverride = null, openingPageText = null, ideen = null) {
  const parts = [
    systemOverride ?? SYSTEM_CHAT,
    '',
    `Aktuelle Seite: «${pageName}»`,
    '',
  ];

  if (openingPageText) {
    parts.push(
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
    parts.push(
      '=== SEITENINHALT ===',
      pageText,
      '',
    );
  }

  if (Array.isArray(ideen) && ideen.length > 0) {
    parts.push('=== OFFENE IDEEN (Notizen des Autors für diese Seite) ===');
    for (const i of ideen) {
      const datum = i.created_at ? ` (${i.created_at.slice(0, 10)})` : '';
      parts.push(`- ${i.content}${datum}`);
    }
    parts.push('');
    parts.push('Hinweis: Diese Ideen sind Notizen des Autors zu möglichen Fortsetzungen, Szenen oder inhaltlichen Ankern. Greife sie auf, hinterfrage oder ergänze sie konversationell — wandle sie aber nicht eigenmächtig in vorschlaege-Einträge um, solange der Autor nicht danach fragt.');
    parts.push('');
  }

  if (figuren && figuren.length > 0) {
    parts.push('=== FIGUREN DES BUCHS ===');
    parts.push(JSON.stringify(figuren, null, 2));
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

  return parts.join('\n');
}

/**
 * Baut den System-Prompt für den Agentic Buch-Chat (Tool-Use-Modus).
 * Unterscheidet sich von buildBookChatSystemPrompt: enthält KEINE Seiteninhalte,
 * dafür eine Anweisung an das Modell, Werkzeuge aufzurufen statt zu raten.
 * Figuren + Review bleiben im System-Prompt (klein, gecacht).
 */
export function buildBookChatAgentSystemPrompt(bookName, figuren, review, systemOverride = null) {
  const parts = [
    systemOverride ?? SYSTEM_BOOK_CHAT,
    '',
    `Buch: «${bookName}»`,
    '',
    'Du hast Zugriff auf Werkzeuge, die Fragen über das gesamte Buch aus einem vorberechneten Index beantworten. Nutze sie, bevor du antwortest, wann immer die Frage gemessen oder aus konkreten Textstellen belegt werden kann:',
    '- Häufigkeit, Verteilung, Erzählperspektive → count_pronouns, get_chapter_stats',
    '- Figurenverteilung, erstes Auftreten → get_figure_mentions, list_chapters',
    '- Konkrete Textstellen oder Zitate → search_passages, get_pages',
    '',
    'Rufe Werkzeuge an, bevor du vermutest. Bei interpretatorischen Fragen (Stil, Ton, Wirkung) kannst du direkt antworten oder mit search_passages Belege suchen.',
    'Maximal 6 Werkzeug-Aufrufe pro Antwort. Halte Werkzeug-Argumente präzise und kurz.',
    '',
  ];

  if (figuren && figuren.length > 0) {
    parts.push('=== FIGUREN DES BUCHS ===');
    parts.push(JSON.stringify(figuren, null, 2));
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
    'Deine finale Antwort (nach allen nötigen Werkzeug-Aufrufen) hat dieses JSON-Format:',
    '{',
    '  "antwort": "Deine Antwort als Freitext (Markdown erlaubt)"',
    '}',
    ...(_isLocal ? [] : ['', JSON_ONLY]),
  );

  return parts.join('\n');
}

/**
 * Werkzeug-Definitionen für den Agentic Buch-Chat.
 * Anthropic-Tool-Format (name/description/input_schema). lib/ai.js liest daraus direkt.
 * Beschreibungen bewusst kurz — kosten Input-Tokens.
 */
export const BOOK_CHAT_TOOLS = [
  {
    name: 'list_chapters',
    description: 'Liefert die komplette Kapitel- und Seitenliste: pro Kapitel chapter_id, Name, Seitenzahl, Wortzahl UND pages[{page_id,page_name,words}]. Zusätzlich total_pages/total_words für das ganze Buch. Nutze dies zuerst für einen Überblick – und um page_ids für get_pages zu bekommen, z.B. wenn du bei einem kleinen Buch alle Seiten laden willst.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'count_pronouns',
    description: 'Zählt Pronomen im ganzen Buch (Summe) oder pro Kapitel (per_chapter=true). Unterscheidet narrativen Text und Dialog. Ideal für Fragen zur Erzählperspektive ("kommt der Ich-Erzähler häufiger vor?").',
    input_schema: {
      type: 'object',
      properties: {
        per_chapter: { type: 'boolean', description: 'true = pro Kapitel aufschlüsseln, false = gesamt (default).' },
        pronouns: {
          type: 'array',
          items: { type: 'string', enum: ['ich', 'du', 'er', 'sie_sg', 'wir', 'ihr_pl', 'man'] },
          description: 'Optionaler Filter auf bestimmte Pronomen-Gruppen. Ohne Angabe: alle.',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_chapter_stats',
    description: 'Zusammenfassende Statistik eines Kapitels: Wortzahl, Satzzahl, Dialoganteil, Top-Figuren-Erwähnungen.',
    input_schema: {
      type: 'object',
      properties: {
        chapter_id: { type: 'integer', description: 'ID des Kapitels (aus list_chapters).' },
      },
      required: ['chapter_id'],
    },
  },
  {
    name: 'get_figure_mentions',
    description: 'Wo und wie oft wird eine Figur erwähnt? Antwort nach Kapitel und Seite, mit Count je Seite. Ideal für "wann taucht X erstmals auf?". Gib figur_id (bevorzugt) ODER figur_name an.',
    input_schema: {
      type: 'object',
      properties: {
        figur_id:   { type: 'string', description: 'fig_id aus der Figurenliste (z.B. "fig_3").' },
        figur_name: { type: 'string', description: 'Alternative: Name oder Kurzname der Figur.' },
      },
      required: [],
    },
  },
  {
    name: 'search_passages',
    description: 'Durchsucht das Buch nach Textstellen. Liefert Treffer mit Kurzkontext (Snippet). Standard: case-insensitive Literal-Suche; mit regex=true als Regex.',
    input_schema: {
      type: 'object',
      properties: {
        pattern:     { type: 'string',  description: 'Suchmuster (literal oder Regex).' },
        regex:       { type: 'boolean', description: 'true = pattern als Regex interpretieren. Default: false.' },
        max_results: { type: 'integer', description: 'Maximale Anzahl Treffer (default 10, max 30).' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'get_pages',
    description: 'Lädt den vollen Text bestimmter Seiten (bei Bedarf für Zitate oder Detail-Analyse). Bis zu 20 Seiten pro Aufruf – bei kleinen Büchern kannst du in einem Call das ganze Buch laden (Page-IDs vorher via list_chapters holen).',
    input_schema: {
      type: 'object',
      properties: {
        ids:                { type: 'array', items: { type: 'integer' }, description: 'Liste der page_ids (aus list_chapters oder anderen Tool-Ergebnissen).' },
        max_chars_per_page: { type: 'integer', description: 'Harte Kürzung pro Seite (default 3000, max 8000).' },
      },
      required: ['ids'],
    },
  },
];

export function buildBookChatSystemPrompt(bookName, relevantPages, figuren, review, systemOverride = null) {
  const parts = [
    systemOverride ?? SYSTEM_BOOK_CHAT,
    '',
    `Buch: «${bookName}»`,
    '',
  ];

  if (relevantPages && relevantPages.length > 0) {
    parts.push('=== RELEVANTE BUCHSEITEN ===');
    for (const page of relevantPages) {
      parts.push(`--- Seite: ${page.name} ---`);
      parts.push(page.text);
      parts.push('');
    }
  }

  if (figuren && figuren.length > 0) {
    parts.push('=== FIGUREN DES BUCHS ===');
    parts.push(JSON.stringify(figuren, null, 2));
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
    'Antworte immer im folgenden JSON-Format:',
    '{',
    '  "antwort": "Deine Antwort als Freitext (Markdown erlaubt)"',
    '}',
    ...(_isLocal ? [] : ['', JSON_ONLY]),
  );

  return parts.join('\n');
}

// ── Schemas ──────────────────────────────────────────────────────────────────

export const SCHEMA_CHAT = _obj({
  antwort: _str,
  vorschlaege: {
    type: 'array',
    items: _obj({ original: _str, ersatz: _str, begruendung: _str }),
  },
});

export const SCHEMA_BOOK_CHAT = _obj({ antwort: _str });
