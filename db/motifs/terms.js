'use strict';
// Motiv-Werkstatt — Trigger-Begriffe: die (De-)Serialisierung von
// `motifs.trigger_terms` (JSON-Array-Spalte). Eigenes Mini-Modul, weil zwei
// Domänen sie brauchen: der Katalog beim Lesen/Schreiben eines Motivs und der
// Lektorat-Kontext (`getPageMotifs`) beim Hydrieren seiner Zeilen. Ohne das
// wäre eine der beiden auf den privaten Helfer der anderen angewiesen.

function parseTerms(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim()) : [];
  } catch { return []; }
}

function serializeTerms(terms) {
  if (!Array.isArray(terms)) return null;
  const clean = terms.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim());
  return clean.length ? JSON.stringify(clean) : null;
}

module.exports = { parseTerms, serializeTerms };
