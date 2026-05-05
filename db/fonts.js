'use strict';
// Cache für Google-Fonts-TTF-Buffers. Stale-while-revalidate über 30-Tage-TTL.

const { db } = require('./connection');

const TTL_MS = 30 * 24 * 60 * 60 * 1000;

const _stmtGet = db.prepare(
  `SELECT ttf, fetched_at FROM font_cache WHERE family = ? AND weight = ? AND style = ?`
);
const _stmtUpsert = db.prepare(
  `INSERT INTO font_cache (family, weight, style, ttf, fetched_at)
   VALUES (?, ?, ?, ?, ?)
   ON CONFLICT (family, weight, style) DO UPDATE SET ttf = excluded.ttf, fetched_at = excluded.fetched_at`
);

/**
 * Liefert ein Cache-Result mit Frische-Indikator.
 * Returns { ttf: Buffer, stale: boolean } | null
 *  - null:           kein Eintrag, harter Miss → fetchen
 *  - stale: true:    Eintrag älter als TTL → bevorzugt re-fetchen, aber als Fallback nutzbar
 *  - stale: false:   frisch
 */
function getCachedFont(family, weight, style) {
  const r = _stmtGet.get(family, parseInt(weight), style);
  if (!r) return null;
  return { ttf: r.ttf, stale: (Date.now() - r.fetched_at) > TTL_MS };
}

function cacheFont(family, weight, style, ttfBuffer) {
  _stmtUpsert.run(family, parseInt(weight), style, ttfBuffer, Date.now());
}

module.exports = { getCachedFont, cacheFont, TTL_MS };
