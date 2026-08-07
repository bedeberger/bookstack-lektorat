// Schemas der Bewertung — aus denselben Profil-Achsen wie die Prompts.
//
// Feldreihenfolge = Generierungsreihenfolge des Modells und (bei lokalen
// Providern) die per Constrained Decoding erzwungene Reihenfolge. Sie MUSS der
// Reihenfolge im Prompt-Template entsprechen: Note zuletzt.

import { _obj, _str, _num } from '../schema-utils.js';
import { bookReviewAxes, chapterReviewAxes, chapterAnalysisFelder, empfehlungKategorien } from '../review-typen.js';


const _zitatItem = _obj({
  kind:      { type: 'string', enum: ['staerke', 'schwaeche'] },
  zitat:     _str,
  kommentar: _str,
});

function _empfehlungItem(kategorien) {
  return _obj({
    prio:      { type: 'string', enum: ['hoch', 'mittel', 'niedrig'] },
    kategorie: { type: 'string', enum: kategorien },
    text:      _str,
  });
}

function _buildReviewSchemaFor(axes, kategorien) {
  const props = { zusammenfassung: _str };
  for (const a of axes) props[a.key] = _str;
  props.staerken       = { type: 'array', items: _str };
  props.schwaechen     = { type: 'array', items: _str };
  props.empfehlungen   = { type: 'array', items: _empfehlungItem(kategorien) };
  props.beispielzitate = { type: 'array', items: _zitatItem };
  props.fazit          = _str;
  props.gesamtnote     = _num;
  props.gesamtnote_begruendung = _str;
  return _obj(props);
}

/** Schema der Buchbewertung für einen Buchtyp. */
export function buildReviewSchema({ buchtyp = null } = {}) {
  return _buildReviewSchemaFor(bookReviewAxes(buchtyp), empfehlungKategorien(buchtyp, 'book'));
}

/** Schema der Kapitelbewertung für einen Buchtyp. */
export function buildChapterReviewSchema({ buchtyp = null } = {}) {
  return _buildReviewSchemaFor(chapterReviewAxes(buchtyp), empfehlungKategorien(buchtyp, 'chapter'));
}

/** Schema der Kapitelanalyse (Multi-Pass-Zwischenstufe) für einen Buchtyp. */
export function buildChapterAnalysisSchema({ buchtyp = null } = {}) {
  const props = { themen: _str, stil: _str, funktion_kurz: _str };
  for (const f of chapterAnalysisFelder(buchtyp)) props[f.key] = _str;
  props.staerken   = { type: 'array', items: _str };
  props.schwaechen = { type: 'array', items: _str };
  props.zitate     = { type: 'array', items: _zitatItem };
  return _obj(props);
}

// Narrative Defaults. Basis des Prompts-Content-Hashs (zusammen mit
// REVIEW_PROFIL_SIGNATUR, die die übrigen Profile abdeckt) und Fallback für
// Konsumenten ohne Buchtyp-Kontext.
export const SCHEMA_REVIEW           = buildReviewSchema({});
export const SCHEMA_CHAPTER_REVIEW   = buildChapterReviewSchema({});
export const SCHEMA_CHAPTER_ANALYSIS = buildChapterAnalysisSchema({});
