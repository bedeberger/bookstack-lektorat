'use strict';
// Pure Aggregation der Stil-Heatmap: Kapitel x Stil-Metrik aus `page_stats`.
// Bewusst ohne DB- und ohne HTTP-Bezug — die Zeilen liefert
// [db/style-stats.js](../db/style-stats.js), die Route in
// [routes/history/stats.js](../routes/history/stats.js) reicht sie nur durch.
// So ist die Aggregation ohne Express + SQLite testbar (Muster:
// lib/fehler-heatmap.js, Gegenstueck der Berechnung: lib/page-index.js).
//
// Warum das hier und nicht im Frontend liegt: die Rohform ist eine Zeile PRO
// SEITE mit Beispielsaetzen und der vollstaendigen Satzlaengen-Sequenz. Bei einem
// Buch mit tausenden Seiten sind das zweistellige Megabytes, aus denen ein
// Kapitel-Raster mit ein paar hundert Zeilen wird. Die Verdichtung gehoert an die
// Datenquelle; der Client bekommt das Raster.
//
// Die Beispielsaetze (`style_samples`) reist NICHT mit: gebraucht wird davon immer
// nur eine Zelle, naemlich die angeklickte. Dafuer gibt es `buildStilDetail`
// hinter einem eigenen Endpunkt.

const { computeRhythmBands, computeOpeners } = require('./stil-rhythmus');

const UNCAT = '__uncat__';

// Beispiel-Eimer, die eine Zelle aufklappen kann, und das Pro-Seite-Zaehlfeld,
// nach dem die Treffer sortiert werden. `repetition` liest stattdessen die
// Top-Woerter aus `repetition_data`.
const SAMPLE_BUCKETS = ['filler', 'passive', 'adverb', 'repetition'];
const COUNT_FIELD = { filler: 'filler_count', passive: 'passive_count', adverb: 'adverb_count' };

/** Ist `bucket` ein erlaubter Drilldown-Eimer? */
function isSampleBucket(bucket) {
  return SAMPLE_BUCKETS.includes(bucket);
}

// JSON-Spalte defensiv parsen: eine korrupte Zeile darf die ganze Karte nicht kippen.
function _parseJson(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

/** Rohzeile -> Objekt mit geparsten JSON-Spalten.
 *  `sentence_lens` steht in LESERICHTUNG; die Reihenfolge der Zeilen und die
 *  Reihenfolge im Array tragen zusammen den Rhythmus. */
function parseStyleRow(r) {
  const lens = _parseJson(r.sentence_lens);
  const openers = _parseJson(r.opener_counts);
  return {
    ...r,
    repetition_data: _parseJson(r.repetition_data),
    style_samples: _parseJson(r.style_samples),
    sentence_lens: Array.isArray(lens) ? lens : null,
    opener_counts: (openers && typeof openers === 'object') ? openers : null,
  };
}

// Gewichteter Mittelwert eines Felds ueber die Seiten einer Gruppe, Gewicht = Woerter.
function _wAvg(pages, field) {
  let num = 0, den = 0;
  for (const p of pages) {
    const v = p[field];
    if (v == null || !p.words) continue;
    num += v * p.words;
    den += p.words;
  }
  return den > 0 ? Math.round((num / den) * 10) / 10 : null;
}

/** Baut die Kapitel-Zeilen der Heatmap.
 *  Gewichtete Durchschnitte ueber die Wortzahl — dominierende Seiten zaehlen mehr.
 *  `name` bleibt `null` fuer Seiten ohne Kapitel: das Label ist UI-Text. */
function _buildChapters(pages) {
  const groups = new Map();
  for (const p of pages) {
    const key = String(p.chapter_id ?? UNCAT);
    if (!groups.has(key)) groups.set(key, { key, name: p.chapter_name || null, pages: [] });
    groups.get(key).pages.push(p);
  }

  const out = [];
  for (const g of groups.values()) {
    let totalWords = 0, totalChars = 0, totalDialog = 0;
    let fillerSum = 0, passiveSum = 0, adverbSum = 0;
    let repNum = 0, repDen = 0;
    for (const p of g.pages) {
      totalWords  += p.words || 0;
      totalChars  += p.chars || 0;
      totalDialog += p.dialog_chars || 0;
      fillerSum   += p.filler_count || 0;
      passiveSum  += p.passive_count || 0;
      adverbSum   += p.adverb_count || 0;
      if (p.repetition_data?.score != null && p.words) {
        repNum += p.repetition_data.score * p.words;
        repDen += p.words;
      }
    }
    const p90 = _wAvg(g.pages, 'sentence_len_p90');
    out.push({
      key: g.key,
      name: g.name,
      pageCount: g.pages.length,
      words: totalWords,
      filler_per1k:     totalWords > 0 ? Math.round((fillerSum  / totalWords) * 1000 * 10) / 10 : 0,
      passive_per1k:    totalWords > 0 ? Math.round((passiveSum / totalWords) * 1000 * 10) / 10 : 0,
      adverb_per1k:     totalWords > 0 ? Math.round((adverbSum  / totalWords) * 1000 * 10) / 10 : 0,
      avg_sentence_len: _wAvg(g.pages, 'avg_sentence_len'),
      sentence_len_p90: p90 != null ? Math.round(p90) : null,
      dialog_ratio:     totalChars > 0 ? Math.round((totalDialog / totalChars) * 1000) / 10 : 0,
      repetition_score: repDen > 0 ? Math.round((repNum / repDen) * 10) / 10 : 0,
      lix:              _wAvg(g.pages, 'lix'),
      flesch_de:        _wAvg(g.pages, 'flesch_de'),
    });
  }
  return out;
}

/** Verdichtet die Seiten-Rows eines Buchs zur Antwort der Stil-Karte.
 *
 *  @param rows           Rohzeilen aus db/style-stats.js#loadStyleRows
 *  @param metricsVersion aktuelle lib/page-index.js#METRICS_VERSION
 *  @returns Objekt mit chapters, rhythm, openers, needsSync, metricsVersion,
 *           lastUpdated und pageCount.
 */
function buildStilHeatmap({ rows = [], metricsVersion = 0 } = {}) {
  const pages = rows.map(parseStyleRow);

  // „Unvollstaendig" heisst: Werte fehlen trotz Text, oder die Seite stammt aus
  // einer aelteren Metrik-Version. Der Client wuerde sonst dauerhaft alte Zahlen
  // zeigen, ohne dass irgendwo ein Fehler erscheint.
  const needsSync = pages.length === 0
    || pages.some(p => (p.words > 0) && (p.lix == null || (p.metrics_version ?? 0) < metricsVersion));

  let lastUpdated = null;
  for (const p of pages) {
    if (p.cached_at && (!lastUpdated || p.cached_at > lastUpdated)) lastUpdated = p.cached_at;
  }

  return {
    chapters: _buildChapters(pages),
    rhythm: computeRhythmBands(pages),
    openers: computeOpeners(pages),
    needsSync,
    metricsVersion,
    lastUpdated,
    pageCount: pages.length,
  };
}

/** Drilldown einer einzelnen Zelle: die Treffer-Beispiele der Seiten EINES Kapitels.
 *  `rows` sind bereits auf das Kapitel eingeschraenkt (db/style-stats.js#loadStyleSamples).
 *  Sortiert nach Trefferzahl absteigend — die dichteste Seite zuerst. */
function buildStilDetail({ rows = [], bucket } = {}) {
  if (!isSampleBucket(bucket)) return { entries: [] };
  const entries = [];
  for (const r of rows) {
    const p = parseStyleRow(r);
    if (bucket === 'repetition') {
      const top = p.repetition_data?.top || [];
      if (!top.length) continue;
      entries.push({
        page_id: p.page_id,
        page_name: p.page_name || String(p.page_id),
        count: top.reduce((s, x) => s + (x.count || 0), 0),
        words: top.map(x => ({ token: x.word, count: x.count })),
      });
    } else {
      const samples = p.style_samples?.[bucket] || [];
      if (!samples.length) continue;
      const countField = COUNT_FIELD[bucket];
      entries.push({
        page_id: p.page_id,
        page_name: p.page_name || String(p.page_id),
        count: (countField && p[countField]) || samples.length,
        // Nach Token gruppiert, damit jedes Wort im Panel einmal als Plakette
        // erscheint und die Beispielsaetze darunter eingerueckt stehen.
        tokens: _groupByToken(samples),
      });
    }
  }
  entries.sort((a, b) => b.count - a.count);
  return { entries };
}

// [{token, sentence}] -> [{token, sentences: [...]}], Reihenfolge des ersten Auftretens.
function _groupByToken(samples) {
  const groups = [];
  const byToken = new Map();
  for (const s of samples || []) {
    const token = s.token || '';
    let g = byToken.get(token);
    if (!g) { g = { token, sentences: [] }; byToken.set(token, g); groups.push(g); }
    g.sentences.push(s.sentence);
  }
  return groups;
}

module.exports = {
  buildStilHeatmap,
  buildStilDetail,
  parseStyleRow,
  isSampleBucket,
  SAMPLE_BUCKETS,
  UNCAT,
};
