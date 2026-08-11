'use strict';
// Pure Aggregation der Fehler-Heatmap: Fehler-Typen × Kapitel aus den
// Lektorats-Laeufen eines Buchs. Bewusst ohne DB- und ohne HTTP-Bezug — die
// Zeilen liefert [db/lektorat-heatmap.js](../db/lektorat-heatmap.js), die
// Route in [routes/history/heatmap.js](../routes/history/heatmap.js) reicht
// sie nur durch. So ist die Aggregation ohne Express + SQLite testbar
// (Gegenstueck: lib/page-index.js).
//
// Drei Modi, die entscheiden, WAS als Fehler zaehlt:
//   open    → Findings des juengsten Checks, die nicht angenommen wurden (default)
//   applied → nur die angenommenen Korrekturen
//   all     → alle Findings des juengsten Checks
//
// `applied` wird ueber ALLE Checks der Seite akkumuliert (Union per `original`) —
// angenommene Korrekturen sind kumulativ und duerfen nicht verschwinden, sobald
// die Seite erneut lektoriert wird (neuer Check ohne applied-Feld).

const MODES = ['open', 'applied', 'all'];
const UNCAT = '__uncat__';
// Pro Typ und Seite hoechstens so viele Beispiel-Findings ins Detail-Panel.
const MAX_SAMPLES = 3;

// Einen Modus-String auf einen erlaubten Wert normalisieren.
function normalizeMode(raw) {
  return MODES.includes(raw) ? raw : 'open';
}

// JSON-Spalte defensiv zu einem Array parsen: eine korrupte Zeile darf die
// ganze Heatmap nicht kippen.
function _parseArr(s) {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// page_id → Map<original, finding> ueber alle Checks der Seite (dedupliziert).
function _appliedByPage(appliedRows) {
  const out = new Map();
  for (const row of appliedRows) {
    let m = out.get(row.page_id);
    if (!m) { m = new Map(); out.set(row.page_id, m); }
    for (const e of _parseArr(row.applied_errors_json)) {
      if (e?.original && !m.has(e.original)) m.set(e.original, e);
    }
  }
  return out;
}

// Findings des juengsten Checks einer Seite auf den Modus reduzieren.
function _effectiveFindings(mode, errs, appliedMap) {
  if (mode === 'applied') return [...appliedMap.values()];
  if (mode === 'all') return errs;
  const appliedSet = new Set(appliedMap.keys());
  return errs.filter(e => e?.original && !appliedSet.has(e.original));
}

// Typ-Zaehler + Beispiel-Findings einer einzelnen Seite.
function _perPage(effective) {
  const counts = {};
  const samples = {};
  for (const e of effective) {
    const typ = e?.typ;
    if (!typ) continue;
    counts[typ] = (counts[typ] || 0) + 1;
    if (!samples[typ]) samples[typ] = [];
    if (samples[typ].length < MAX_SAMPLES) {
      samples[typ].push({
        original: e.original || '',
        korrektur: e.korrektur || '',
        erklaerung: e.erklaerung || '',
      });
    }
  }
  return { counts, samples };
}

/** Baut die Heatmap-Antwort aus rohen Zeilen.
 *
 *  @param pages       [{ page_id, page_name, chapter_id, chapter_name, words }]
 *  @param checks      juengster Check pro Seite: [{ page_id, errors_json }]
 *  @param appliedRows alle Checks mit applied: [{ page_id, applied_errors_json }]
 *  @param mode        'open' | 'applied' | 'all'
 *  @returns { mode, chapters, matrix, totals, details }
 */
function buildFehlerHeatmap({ pages = [], checks = [], appliedRows = [], mode } = {}) {
  const effMode = normalizeMode(mode);
  const checkByPage = new Map(checks.map(c => [c.page_id, c]));
  const appliedByPage = _appliedByPage(appliedRows);

  // Gruppierung nach Kapitel. chapter_id kann null sein → UNCAT.
  const chapters = new Map();
  for (const p of pages) {
    const key = p.chapter_id ?? UNCAT;
    if (!chapters.has(key)) {
      chapters.set(key, {
        chapter_id: p.chapter_id ?? null,
        chapter_name: p.chapter_name || null,
        pages_total: 0,
        pages_checked: 0,
        words: 0,
        typen: {},   // { typ: { count, pages: Set<page_id> } }
        details: {}, // { typ: [{ page_id, page_name, count, samples }] }
      });
    }
    const ch = chapters.get(key);
    ch.pages_total++;
    ch.words += Number(p.words) || 0;

    const check = checkByPage.get(p.page_id);
    if (!check) continue;
    ch.pages_checked++;

    const appliedMap = appliedByPage.get(p.page_id) || new Map();
    const effective = _effectiveFindings(effMode, _parseArr(check.errors_json), appliedMap);
    const { counts, samples } = _perPage(effective);

    for (const typ of Object.keys(counts)) {
      if (!ch.typen[typ]) ch.typen[typ] = { count: 0, pages: new Set() };
      ch.typen[typ].count += counts[typ];
      ch.typen[typ].pages.add(p.page_id);
      if (!ch.details[typ]) ch.details[typ] = [];
      ch.details[typ].push({
        page_id: p.page_id,
        page_name: p.page_name || String(p.page_id),
        count: counts[typ],
        samples: samples[typ] || [],
      });
    }
  }

  // Kapitel mit numerischer ID zuerst (Buch-Reihenfolge ist chapter_id),
  // unkategorisiert am Ende.
  const chaptersArr = [...chapters.values()].sort((a, b) => {
    if (a.chapter_id == null && b.chapter_id == null) return 0;
    if (a.chapter_id == null) return 1;
    if (b.chapter_id == null) return -1;
    return a.chapter_id - b.chapter_id;
  });

  const matrix = {};
  const totals = {};
  const details = {};
  for (const ch of chaptersArr) {
    const key = ch.chapter_id ?? UNCAT;
    matrix[key] = {};
    for (const [typ, v] of Object.entries(ch.typen)) {
      const per1k = ch.words > 0 ? Math.round((v.count / ch.words) * 1000 * 10) / 10 : 0;
      matrix[key][typ] = { count: v.count, per1k, pages: v.pages.size };
      totals[typ] = (totals[typ] || 0) + v.count;
    }
    for (const [typ, arr] of Object.entries(ch.details)) {
      details[`${key}:${typ}`] = arr.sort((a, b) => b.count - a.count);
    }
  }

  return {
    mode: effMode,
    chapters: chaptersArr.map(c => ({
      chapter_id: c.chapter_id,
      chapter_name: c.chapter_name,
      pages_total: c.pages_total,
      pages_checked: c.pages_checked,
      words: c.words,
    })),
    matrix,
    totals,
    details,
  };
}

module.exports = { buildFehlerHeatmap, normalizeMode, MODES };
