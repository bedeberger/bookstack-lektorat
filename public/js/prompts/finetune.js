// Finetune-Export · AI-Augmentation. Drei Builder für die Sample-Multiplizierung:
//   1) buildFinetuneReversePromptsPrompt — N natürliche User-Instructions zu
//      einer gegebenen Buchpassage. Assistant-Content bleibt der Originaltext;
//      nur die User-Seite wird KI-generiert. Verhindert Stil-Drift, weil die
//      Trainings-Antwort immer Autorprosa ist.
//   2) buildFinetuneFactQAPrompt — synthetische Q&A-Paare aus strukturierten
//      DB-Feldern (Figuren/Orte/Ereignisse). Trainiert Welt-Wissen.
//   3) buildFinetuneReasoningBackfillPrompt — Begründung in einem Satz für
//      eine vorhandene Korrektur (Original→Verbesserung), wenn die ursprüngliche
//      Lektoratsantwort kein erklaerung-Feld geliefert hat.
//
// Locale-aware: alle drei nehmen `langIsEn` als Hinweis fürs Output-Format
// (Felder bleiben deutsch, damit Schemas stabil sind, aber die Strings selbst
// kommen in der Buch-Sprache zurück).

import { _jsonOnly } from './state.js';
import { _obj, _str } from './schema-utils.js';

const FT_AUGMENT_SYSTEM_DE = 'Du unterstützt die Aufbereitung von Trainingsdaten aus einem Roman. Du erfindest keine Inhalte, sondern formulierst Instruktionen, Fragen oder Begründungen, die zu vorgegebenem Originaltext passen. Antworte präzise, in natürlicher Sprache, ohne Floskeln.';
const FT_AUGMENT_SYSTEM_EN = 'You help prepare training data from a novel. You do not invent content; you phrase instructions, questions, or justifications that match the given source text. Answer precisely, in natural language, no fluff.';

export function buildFinetuneAugmentSystem(langIsEn) {
  const base = langIsEn ? FT_AUGMENT_SYSTEM_EN : FT_AUGMENT_SYSTEM_DE;
  return `${base}${_jsonOnly()}`;
}

export function buildFinetuneReversePromptsPrompt({ passage, count = 4, langIsEn = false, bookName = '', chapter = '', pageTitle = '' }) {
  const lines = langIsEn
    ? [
        `Generate ${count} different, natural user instructions or questions that would lead an author to write the following passage from «${bookName || 'the book'}». Each instruction must be answerable by exactly the given text — no extra context.`,
        '',
        'Rules:',
        '- Each instruction in plain natural language, 4–25 words, no quotation marks around the whole instruction.',
        '- Vary phrasing: imperative ("Write …"), question ("What happens when …"), context-setting ("Imagine …"), perspective shift, action focus, character focus, location focus.',
        '- Do not name the page or chapter title literally; describe content instead.',
        '- Do not invent facts not present in the passage.',
        '- Output the instructions only, no commentary.',
      ]
    : [
        `Erzeuge ${count} verschiedene, natürliche User-Instructions oder Fragen, die einen Autor zur folgenden Passage aus «${bookName || 'dem Buch'}» führen würden. Jede Instruction muss durch genau diesen Text beantwortet werden — kein Zusatzkontext.`,
        '',
        'Regeln:',
        '- Jede Instruction in natürlicher Sprache, 4–25 Wörter, keine Anführungszeichen um die ganze Instruction.',
        '- Variation: Imperativ ("Schreibe …"), Frage ("Was passiert, wenn …"), Kontext-Setzung ("Stell dir vor …"), Perspektivwechsel, Handlungsfokus, Figurenfokus, Ortsfokus.',
        '- Kapitel- oder Seitentitel nicht wörtlich nennen; stattdessen den Inhalt beschreiben.',
        '- Keine Fakten erfinden, die nicht in der Passage stehen.',
        '- Nur die Instructions ausgeben, kein Kommentar.',
      ];
  if (chapter) lines.push((langIsEn ? `Chapter context: ${chapter}` : `Kapitel-Kontext: ${chapter}`));
  if (pageTitle) lines.push((langIsEn ? `Page title (do not name literally): ${pageTitle}` : `Seitentitel (nicht wörtlich nennen): ${pageTitle}`));
  lines.push('');
  lines.push(langIsEn
    ? 'Schema:\n{ "instructions": ["...", "..."] }'
    : 'Schema:\n{ "instructions": ["...", "..."] }');
  lines.push('');
  lines.push(langIsEn ? 'Passage:' : 'Passage:');
  lines.push(passage);
  return lines.join('\n');
}

export const SCHEMA_FT_REVERSE_PROMPTS = _obj({
  instructions: { type: 'array', items: _str },
});

export function buildFinetuneFactQAPrompt({ entityType, entityJson, count = 4, langIsEn = false, bookName = '' }) {
  const intro = langIsEn
    ? `Generate ${count} self-contained question–answer pairs about the following ${entityType} from «${bookName || 'the book'}». Use only facts present in the JSON; do not invent details.`
    : `Erzeuge ${count} eigenständige Frage–Antwort-Paare zu folgender(m) ${entityType} aus «${bookName || 'dem Buch'}». Nutze nur Fakten aus dem JSON, erfinde nichts dazu.`;
  const rules = langIsEn
    ? [
        '- Each question 4–20 words, natural reader phrasing.',
        '- Each answer 1–3 sentences, in the author\'s tone, factually grounded in the JSON.',
        '- Vary question forms: identity, relation, location, time, motivation, characteristic.',
        '- Do not repeat the entity name in every question; use pronouns where natural.',
        '- Skip a slot rather than fabricate when the JSON lacks the info.',
      ]
    : [
        '- Jede Frage 4–20 Wörter, natürliche Leserformulierung.',
        '- Jede Antwort 1–3 Sätze, im Ton des Autors, faktentreu zum JSON.',
        '- Frageformen variieren: Identität, Beziehung, Ort, Zeit, Motivation, Eigenschaft.',
        '- Nicht in jeder Frage den Entitäts-Namen wiederholen; wo natürlich, Pronomen nutzen.',
        '- Lieber einen Slot weglassen als zu erfinden, wenn das JSON die Info nicht hergibt.',
      ];
  const schema = '{ "qa": [ { "frage": "...", "antwort": "..." } ] }';
  return [
    intro,
    '',
    langIsEn ? 'Rules:' : 'Regeln:',
    ...rules,
    '',
    langIsEn ? `Schema:\n${schema}` : `Schema:\n${schema}`,
    '',
    `JSON (${entityType}):`,
    typeof entityJson === 'string' ? entityJson : JSON.stringify(entityJson),
  ].join('\n');
}

export const SCHEMA_FT_FACT_QA = _obj({
  qa: { type: 'array', items: _obj({ frage: _str, antwort: _str }) },
});

export function buildFinetuneReasoningBackfillPrompt({ original, korrektur, kontext = '', langIsEn = false }) {
  const lines = langIsEn
    ? [
        'Explain in one short sentence why the corrected version is better than the original. Concrete, no filler, focus on the actual change (word choice, rhythm, redundancy, register).',
        '',
        'Schema:\n{ "begruendung": "..." }',
        '',
        `Original:\n${original}`,
        '',
        `Correction:\n${korrektur}`,
      ]
    : [
        'Erkläre in einem kurzen Satz, warum die korrigierte Fassung besser ist als das Original. Konkret, ohne Floskeln, fokussiert auf die tatsächliche Änderung (Wortwahl, Rhythmus, Redundanz, Register).',
        '',
        'Schema:\n{ "begruendung": "..." }',
        '',
        `Original:\n${original}`,
        '',
        `Korrektur:\n${korrektur}`,
      ];
  if (kontext) lines.push('', langIsEn ? `Context (paragraph):\n${kontext}` : `Kontext (Absatz):\n${kontext}`);
  return lines.join('\n');
}

export const SCHEMA_FT_REASONING = _obj({ begruendung: _str });
