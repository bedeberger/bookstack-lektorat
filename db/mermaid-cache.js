'use strict';

// Render-Cache fuer Diagramme (siehe Migration 264).
//
// Inhaltsadressiert: der Schluessel ist SHA-1 ueber Render-Version + Theme +
// Quelltext (lib/mermaid-render.js#renderKey). Kein Buch-, Seiten- oder
// User-Bezug — dasselbe Diagramm sieht ueberall gleich aus, und ein Cache, der
// pro Buch dieselbe Grafik nochmal haelt, ist nur groesser, nicht richtiger.

const { db } = require('./schema');
const { NOW_ISO_SQL } = require('./now');

const _get = db.prepare('SELECT svg, png, width, height FROM mermaid_cache WHERE code_hash = ?');
const _touch = db.prepare(`UPDATE mermaid_cache SET last_used_at = ${NOW_ISO_SQL} WHERE code_hash = ?`);
const _put = db.prepare(`
  INSERT INTO mermaid_cache (code_hash, theme, svg, png, width, height, created_at, last_used_at)
  VALUES (@code_hash, @theme, @svg, @png, @width, @height, ${NOW_ISO_SQL}, ${NOW_ISO_SQL})
  ON CONFLICT(code_hash) DO UPDATE SET
    svg = excluded.svg, png = excluded.png,
    width = excluded.width, height = excluded.height,
    last_used_at = excluded.last_used_at
`);

/** Cache-Treffer oder null. Aktualisiert `last_used_at` (treibt das Aufraeumen). */
function getCachedDiagram(codeHash) {
  const row = _get.get(codeHash);
  if (!row) return null;
  _touch.run(codeHash);
  return row;
}

function putCachedDiagram(codeHash, theme, asset) {
  _put.run({
    code_hash: codeHash,
    theme: theme || 'default',
    svg: asset.svg,
    png: asset.png || null,
    width: asset.width ?? null,
    height: asset.height ?? null,
  });
}

// Aufgeraeumt wird ueber die generische POLICIES-Liste in lib/cache-cleanup.js
// (`last_used_at`, 90 Tage) — kein eigener Prune-Pfad hier, sonst gaebe es zwei
// Stellen mit zwei Fristen.

module.exports = { getCachedDiagram, putCachedDiagram };
