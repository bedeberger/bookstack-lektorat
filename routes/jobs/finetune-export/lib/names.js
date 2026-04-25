'use strict';

const { createHash } = require('crypto');

function hashSplit(id, seed) {
  const h = createHash('sha1').update(String(seed || 0) + '|' + id).digest();
  return ((h[0] << 8) | h[1]) / 0xffff;
}

// Robustes Label aus einem Listenelement extrahieren. Akzeptiert:
//   - String-Namen ("Renate")
//   - String-IDs (in `byMap` aufgelöst)
//   - Objekte ({ name, id, fig_id, loc_id, … }) — Name direkt oder via byMap-Lookup
// Verhindert "[object Object]" im Output, wenn KI strukturierte Refs liefert
// statt blanker Strings.
function extractName(v, byMap = null) {
  if (v == null) return '';
  if (typeof v === 'string') {
    if (byMap && byMap.has(v)) return byMap.get(v).name || v;
    return v.trim();
  }
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') {
    const id = v.fig_id || v.loc_id || v.id;
    if (id && byMap && byMap.has(id)) return byMap.get(id).name || '';
    return (v.name || v.titel || v.label || '').toString().trim();
  }
  return '';
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function findSpeaker(text, quoteStart, quoteEnd, figureNames) {
  const ctx = text.slice(Math.max(0, quoteStart - 120), quoteStart)
    + ' ' + text.slice(quoteEnd, quoteEnd + 120);
  for (const name of figureNames) {
    const re = new RegExp('\\b' + escapeRe(name) + '\\b', 'i');
    if (re.test(ctx)) return name;
  }
  return null;
}

module.exports = { hashSplit, extractName, escapeRe, findSpeaker };
