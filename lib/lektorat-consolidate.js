'use strict';
// Konsolidierung von Lektorat-Findings über Span-Overlap-Clustering. Gemeinsame
// Basis für zwei Operationen:
//   1. Konsens-Voting über mehrere Läufe DESSELBEN Passes (Claude, K Läufe):
//      behalte nur Funde, auf die sich ≥ threshold unabhängige Läufe einigen –
//      filtert die lauf-zu-lauf-instabilen Einzelgänger (Rausch-Verdacht) heraus.
//   2. Cross-Pass-Dedup (Objektiv-Konsens + Stil-Pass): überlappende Funde aus
//      verschiedenen Pässen zu je einem Eintrag verschmelzen, spezifischster Typ
//      gewinnt.
// Beide sind dasselbe Clustering mit unterschiedlicher Keep-Schwelle. Pure –
// kein AI/DB. Finding-Form: { typ, original, korrektur, erklaerung, ... }.

// Typ-Priorität: spezifisch schlägt generisch. CJS-Spiegel von TYP_PRIORITAET in
// public/js/prompts/lektorat-typen.js, damit die Anti-Doppelungs-Regel im Prompt und
// das Clustering hier dieselbe Rangfolge verwenden. Enthält die Union über alle
// Buchtyp-Profile (die profilfremden Typen tauchen im Input einfach nie auf).
// Drift gegated durch tests/unit/lektorat-typen-drift.test.mjs.
const TYP_PRIORITY = [
  'dialogformat', 'rechtschreibung', 'konjunktiv', 'grammatik',
  'namenskonsistenz', 'figurenmerkmal', 'schauplatzmerkmal', 'anrede',
  'begriffsinkonsistenz', 'autorenform', 'zuschreibung', 'unbelegt', 'wertung',
  'pleonasmus', 'wiederholung', 'perspektivbruch', 'tempuswechsel',
  'klischee', 'amtsdeutsch', 'ki_geruch', 'passiv', 'show_vs_tell',
  'hedging', 'filterwort', 'schwaches_verb', 'fuellwort', 'satzbau', 'stil',
];

function _prio(typ) {
  const i = TYP_PRIORITY.indexOf(typ);
  return i < 0 ? TYP_PRIORITY.length : i;
}

function _norm(s) {
  return (s || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// Span eines Findings im Text lokalisieren (erstes Vorkommen von `original`).
// → { start, end } oder null, wenn `original` nicht wörtlich im Text steht
// (z.B. weil das Modell normalisiert hat) – solche Funde clustern über
// normalisierte String-Gleichheit statt über Position.
function _locate(finding, text) {
  const orig = finding && finding.original;
  if (!orig || !text) return null;
  const idx = text.indexOf(orig);
  if (idx < 0) return null;
  return { start: idx, end: idx + orig.length };
}

// Lokalisierte Einträge zu Clustern verschmelzen: nach Start sortieren, dann
// überlappende (auch transitiv verkettete) Intervalle zu einer Gruppe. Zwei Spans
// überlappen, wenn a.start < b.end && b.start < a.end.
function _clusterLocated(entries) {
  const sorted = entries.slice().sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end);
  const clusters = [];
  let cur = null, curEnd = -1;
  for (const e of sorted) {
    if (cur && e.span.start < curEnd) {
      cur.push(e);
      curEnd = Math.max(curEnd, e.span.end);
    } else {
      cur = [e];
      clusters.push(cur);
      curEnd = e.span.end;
    }
  }
  return clusters;
}

// Nicht-lokalisierte Einträge über normalisierte `original`-Gleichheit gruppieren.
// Leeres original → eigener Singleton (kann nicht matchen).
function _clusterUnlocated(entries) {
  const byKey = new Map();
  const singletons = [];
  for (const e of entries) {
    const k = _norm(e.finding.original);
    if (!k) { singletons.push([e]); continue; }
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(e);
  }
  return [...byKey.values(), ...singletons];
}

// Repräsentanten eines Clusters wählen: spezifischster Typ zuerst; bei Gleichstand
// die häufigste (typ|original|korrektur)-Kombination; dann kürzestes `original`
// (präziseste Span). Gibt genau ein Finding zurück (unverändert).
function _pickRepresentative(cluster) {
  const freq = new Map();
  for (const e of cluster) {
    const k = `${e.finding.typ}|${_norm(e.finding.original)}|${_norm(e.finding.korrektur)}`;
    freq.set(k, (freq.get(k) || 0) + 1);
  }
  return cluster.slice().sort((a, b) => {
    const pa = _prio(a.finding.typ), pb = _prio(b.finding.typ);
    if (pa !== pb) return pa - pb;
    const ka = `${a.finding.typ}|${_norm(a.finding.original)}|${_norm(a.finding.korrektur)}`;
    const kb = `${b.finding.typ}|${_norm(b.finding.original)}|${_norm(b.finding.korrektur)}`;
    const fa = freq.get(ka), fb = freq.get(kb);
    if (fa !== fb) return fb - fa;
    return (a.finding.original || '').length - (b.finding.original || '').length;
  })[0].finding;
}

// Kern: N Fund-Listen (Läufe oder Pässe) zu einer deduplizierten Liste
// konsolidieren. Ein Cluster wird behalten, wenn ihn ≥ threshold verschiedene
// Listen-Indizes speisen. Ausgabe nach Textposition sortiert (nicht-lokalisierte
// Funde ans Ende, alphabetisch nach original).
function _consolidate(lists, text, threshold) {
  const entries = [];
  lists.forEach((list, idx) => {
    (list || []).forEach((finding) => {
      entries.push({ finding, list: idx, span: _locate(finding, text) });
    });
  });
  const located = entries.filter(e => e.span);
  const unlocated = entries.filter(e => !e.span);
  const clusters = [..._clusterLocated(located), ..._clusterUnlocated(unlocated)];

  const kept = [];
  for (const cluster of clusters) {
    const distinctLists = new Set(cluster.map(e => e.list)).size;
    if (distinctLists < threshold) continue;
    const rep = _pickRepresentative(cluster);
    const span = _locate(rep, text);
    kept.push({ finding: rep, sortStart: span ? span.start : Number.MAX_SAFE_INTEGER, orig: rep.original || '' });
  }
  kept.sort((a, b) => a.sortStart - b.sortStart || a.orig.localeCompare(b.orig));
  return kept.map(k => k.finding);
}

// Konsens über K Läufe desselben Passes. threshold wird auf die Lauf-Anzahl
// geklemmt, damit K=1 (lokale Provider: genau ein Lauf) alle Funde behält und
// nur dedupliziert.
function consensusFindings(runs, text, { threshold = 2 } = {}) {
  const eff = Math.max(1, Math.min(threshold, runs.length || 1));
  return _consolidate(runs, text, eff);
}

// Cross-Pass-Merge: alle Cluster behalten (threshold 1), überlappende Funde
// verschmelzen, spezifischster Typ gewinnt.
function mergePasses(lists, text) {
  return _consolidate(lists, text, 1);
}

module.exports = {
  TYP_PRIORITY,
  consensusFindings,
  mergePasses,
  _prio,
  _norm,
  _locate,
};
