// Facade der Buch-/Kapitel-Bewertung. Externer Zugriff läuft über prompts.js;
// diese Datei bündelt nur die Submodule unter prompts/review/.
//
// Achsen, Notenanker, Empfehlungs-Kategorien und die Kurzfelder der
// Kapitelanalyse kommen aus dem Bewertungsprofil des Buchtyps
// (prompts/review-typen.js). Prompt-Text UND Schema werden daraus pro Call
// erzeugt — ein globales Schema würde bei lokalen Providern per Constrained
// Decoding Felder erzwingen, die der Prompt gar nicht verlangt.
//
// Reihenfolge-Invariante: `gesamtnote` und `gesamtnote_begruendung` stehen in
// Prompt-Template UND Schema ZULETZT. Ein Modell generiert in Feldreihenfolge;
// stünde die Note vorn, wäre sie ein Bauchurteil und die Achsen darunter nur
// noch dessen Rechtfertigung — genau das, was der Notenanker verhindern soll.
//
// Aufteilung:
//   review/format.js   — profil-getriebene Bausteine (Achsen, Notenanker,
//                        Empfehlungs-/Zitat-Regeln, Antwort-Template)
//   review/context.js  — Kontext-Blöcke (Komplettanalyse, Motive, Struktur-Check,
//                        Genre-Schwerpunkt, Kapitel-Position)
//   review/builders.js — die fünf Prompt-Builder
//   review/schemas.js  — Schema-Builder + narrative Defaults

export {
  buildBookReviewSinglePassPrompt,
  buildChapterAnalysisPrompt,
  buildChapterReviewPrompt,
  buildBookReviewMultiPassPrompt,
  buildChapterReviewMultiPassPrompt,
} from './review/builders.js';

export {
  buildReviewSchema,
  buildChapterReviewSchema,
  buildChapterAnalysisSchema,
  SCHEMA_REVIEW,
  SCHEMA_CHAPTER_REVIEW,
  SCHEMA_CHAPTER_ANALYSIS,
} from './review/schemas.js';

// Re-Export für Server-Konsumenten (Job-Pfade), die das Profil in das
// Ergebnis-JSON schreiben, damit das Frontend die richtigen Achsen rendert.
export { reviewProfil } from './review-typen.js';
