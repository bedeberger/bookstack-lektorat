// Swimlane-Layout des Figurengraphen — reine Berechnung, kein DOM, kein vis.
// Getrennt vom Renderer, damit die Positionslogik (gewichteter Kapitel-Schwerpunkt,
// Greedy-Stapelung, Tier-Höhen) ohne Browser testbar ist.

import { FIGUR_TYPEN } from '../book/figur-typen.js';

// Tier-Achse (Y). Reihenfolge ist die Anzeigereihenfolge von oben nach unten;
// alles ausserhalb landet in 'andere'. Dieselbe Reihenfolge ordnet die
// Figurenlisten der Karte — SSoT ist ../book/figur-typen.js, hier steht nur der
// sprechende Name fuer die Y-Achse.
export const TIER_ORDER = FIGUR_TYPEN;

export const ROW_H = 50;          // Vertikaler Abstand zweier Stapelzeilen im selben Tier
export const TIER_BASE_GAP = 80;  // Zusatz-Luft zwischen zwei Tiers
export const MIN_DX = 130;        // Minimaler horizontaler Abstand in derselben Zeile

// Spaltenbreite skaliert mit Container-Breite / Kapitelzahl. Bei vielen Kapiteln
// (z.B. 37 Spalten in 900 px Container) würde 440 px/Spalte eine 16k-Canvas erzeugen,
// in die fit() winzige Nodes hineinzoomt. Floor 160 hält die Presence-Bar lesbar.
export function columnWidth(containerW, chapterCount) {
  return Math.max(160, Math.min(440, (containerW || 900) / Math.max(chapterCount, 4)));
}

// Häufige Auftritte ziehen den Schwerpunkt stärker (überlinear, damit ein Kapitel
// mit vielen Nennungen nicht von vielen Streifzügen überstimmt wird).
const weight = k => Math.pow(k.haeufigkeit || 1, 1.5);

const tierOf = f => (TIER_ORDER.includes(f.typ) ? f.typ : 'andere');

// Pro Figur: gewichteter Kapitel-Index (X), Ersterscheinung, Tier, Wichtigkeit.
// Figuren ohne verortbares Kapitel landen in der Mitte der Achse.
export function figureInfo(figuren, chapterOrder) {
  const N = chapterOrder.length;
  const chapIdx = {};
  chapterOrder.forEach((c, i) => { chapIdx[c] = i; });

  const info = {};
  for (const f of figuren) {
    const kaps = (f.kapitel || []).filter(k => chapIdx[k.name] !== undefined);
    let xIdx = N > 1 ? (N - 1) / 2 : 0;
    let firstCh = Number.POSITIVE_INFINITY;
    if (kaps.length) {
      const total = kaps.reduce((s, k) => s + weight(k), 0);
      let sum = 0;
      for (const k of kaps) {
        sum += chapIdx[k.name] * (weight(k) / total);
        if (chapIdx[k.name] < firstCh) firstCh = chapIdx[k.name];
      }
      xIdx = sum;
    }
    const importance = (f.kapitel || []).reduce((s, k) => s + (k.haeufigkeit || 0), 0);
    info[f.id] = { xIdx, firstCh, tier: tierOf(f), importance };
  }
  return info;
}

// Vollständiges Layout: Tier-Buckets, Greedy-Stapelung innerhalb des Tiers,
// kumulative Tier-Höhen und die fertigen Knoten-Positionen.
//
// Greedy-Stapelung: jede Figur sitzt an ihrem tatsächlichen narrativen Schwerpunkt
// (xIdx * COL_W) und kommt in die oberste Zeile, in der sie zur zuletzt platzierten
// Figur dieser Zeile mindestens MIN_DX Abstand hat. Kein Binning → keine Clumps an
// den Kapitelrändern. Jedes Tier reserviert nur so viel Höhe, wie es Stapelzeilen
// hat — ein Nebenfiguren-Stapel ragt nie ins nächste Tier.
export function computeSwimlaneLayout(figuren, chapterOrder, containerW) {
  const COL_W = columnWidth(containerW, chapterOrder.length);
  const info = figureInfo(figuren, chapterOrder);

  const byTier = {};
  for (const t of TIER_ORDER) byTier[t] = [];
  for (const f of figuren) byTier[info[f.id].tier].push(f);
  const tiersUsed = TIER_ORDER.filter(t => byTier[t].length > 0);

  // Deterministische Reihenfolge: Schwerpunkt, dann Ersterscheinung, dann Name.
  const sortFigs = arr => arr.slice().sort((a, b) => {
    const ax = info[a.id].xIdx, bx = info[b.id].xIdx;
    if (ax !== bx) return ax - bx;
    const af = info[a.id].firstCh, bf = info[b.id].firstCh;
    if (af !== bf) return af - bf;
    return (a.name || '').localeCompare(b.name || '');
  });

  const layoutPerTier = {};
  for (const t of tiersUsed) {
    const rowLastX = []; // row → x der zuletzt platzierten Figur
    const items = [];
    for (const f of sortFigs(byTier[t])) {
      const x = info[f.id].xIdx * COL_W;
      let row = 0;
      while (row < rowLastX.length && x - rowLastX[row] < MIN_DX) row++;
      rowLastX[row] = x;
      items.push({ f, x, row });
    }
    layoutPerTier[t] = { items, maxRows: Math.max(1, rowLastX.length) };
  }

  const tierY = {};
  let yCursor = 0;
  for (const t of tiersUsed) {
    tierY[t] = yCursor;
    yCursor += (layoutPerTier[t].maxRows - 1) * ROW_H + TIER_BASE_GAP;
  }

  const nodePositions = [];
  for (const t of tiersUsed) {
    for (const { f, x, row } of layoutPerTier[t].items) {
      nodePositions.push({ f, x, y: tierY[t] + row * ROW_H });
    }
  }

  const lastTier = tiersUsed[tiersUsed.length - 1];
  const lastTierY = lastTier
    ? tierY[lastTier] + (layoutPerTier[lastTier].maxRows - 1) * ROW_H
    : 0;

  return { COL_W, info, tiersUsed, layoutPerTier, tierY, nodePositions, lastTierY };
}

// Border-Stärke als Wichtigkeits-Signal (Summe der Auftritts-Häufigkeiten).
export function importanceBorderWidth(importance) {
  return Math.min(4, 1 + Math.round(Math.log2(Math.max(1, importance))));
}
