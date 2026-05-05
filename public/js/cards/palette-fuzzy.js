// Fuzzy-Match für Command-Palette. Subsequence-Score (fzf-light).
// Unicode-tolerant via toLowerCase + NFD-Diacritic-Strip.
//
// match(query, target) → { score, indices } | null
//   score: kleiner ist besser. 0 ist exakter Präfix-Match.
//   indices: Array von Match-Positionen im (originalen) target-String.
//
// highlight(target, indices) → escaped HTML mit <mark>-Tags um Treffer.

import { escHtml } from '../utils.js';

const COMBINING = /[̀-ͯ]/g;

function normalize(s) {
  return s.normalize('NFD').replace(COMBINING, '').toLowerCase();
}

const WORD_BOUNDARY = /[\s\-_/.,:;()[\]{}]/;

export function fuzzyMatch(query, target) {
  if (!query) return { score: 0, indices: [] };
  if (!target) return null;
  const q = normalize(query);
  const t = normalize(target);
  if (!q.length) return { score: 0, indices: [] };

  // Greedy-Scan ab Startposition `start`. Greedy ist nach dem ersten Match ok —
  // problematisch ist nur die Wahl des ersten q[0]: ein früheres q[0] mitten im
  // Wort verbaut die spätere Word-Boundary + Consecutive-Kette. Darum probieren
  // wir alle q[0]-Positionen und nehmen das beste Ergebnis.
  function scanFrom(start) {
    const indices = [];
    let qi = 0;
    let prevMatch = -2;
    let score = 0;
    let firstMatch = -1;
    for (let ti = start; ti < t.length && qi < q.length; ti++) {
      if (t[ti] !== q[qi]) continue;
      indices.push(ti);
      if (firstMatch < 0) firstMatch = ti;
      if (prevMatch === ti - 1) score -= 5;
      else score += (ti - prevMatch - 1);
      const before = ti === 0 ? '' : t[ti - 1];
      if (ti === 0 || WORD_BOUNDARY.test(before)) score -= 3;
      prevMatch = ti;
      qi++;
    }
    if (qi < q.length) return null;
    score += firstMatch * 0.5;
    score += t.length * 0.05;
    return { score, indices };
  }

  let best = null;
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== q[0]) continue;
    const r = scanFrom(i);
    if (!r) break; // ab hier keine vollständige Sequenz mehr möglich
    if (!best || r.score < best.score) best = r;
  }
  return best;
}

export function highlight(target, indices) {
  if (!indices || !indices.length) return escHtml(target);
  let out = '';
  let last = 0;
  const idxSet = new Set(indices);
  for (let i = 0; i < target.length; i++) {
    if (!idxSet.has(i)) continue;
    if (i > last) out += escHtml(target.slice(last, i));
    let j = i;
    while (j < target.length && idxSet.has(j)) j++;
    out += '<mark class="palette-mark">' + escHtml(target.slice(i, j)) + '</mark>';
    last = j;
    i = j - 1;
  }
  if (last < target.length) out += escHtml(target.slice(last));
  return out;
}
