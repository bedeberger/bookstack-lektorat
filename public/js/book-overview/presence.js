// Geteilte Mechanik der drei Präsenz-Matrizen der Buch-Übersicht
// (Figuren, Schauplätze, Motive). Alle drei zeigen dasselbe Bild — Kapitel als
// Zeilen, die Top-N Entitäten als Spalten, Zellwert = Fundstellen im Kapitel —
// und unterscheiden sich nur darin, WOHER die Zählung kommt. Die Fachmodule
// liefern deshalb nur noch ihre `byRootId`-Aufschlüsselung; Auswahl der Spalten,
// Skalierung und Zeilen-Aufbau leben hier.
//
// Pure Funktionen (Alpine-/DOM-frei) → direkt unit-testbar, siehe
// tests/unit/book-overview-presence.test.mjs.
import { rankPreferRecurring } from './ranking.js';

// Spalten-Obergrenze. Mehr Spalten passen nicht sinnvoll in die Kachel und
// die Matrix wird zur Tapete.
export const PRESENCE_MAX_COLS = 20;

// Mindest-Füllung einer nicht-leeren Zelle in Prozent: eine 1 in einem Buch mit
// Maximum 40 wäre sonst optisch nicht von „leer" zu unterscheiden.
const MIN_VISIBLE_PCT = 8;

/**
 * Zähl-Einträge auf ihre Wurzel-Kapitel aggregieren.
 * @param {Iterable<{chapterId?:number|string, chapterName?:string, n:number}>} entries
 * @param {(chapterId, chapterName) => ({id:number|string}|null)} resolveRoot
 * @returns {{byRootId: Map<number, number>, total: number}}
 */
export function bucketByRoot(entries, resolveRoot) {
  const byRootId = new Map();
  let total = 0;
  for (const e of entries || []) {
    const n = Number(e?.n) || 0;
    if (n <= 0) continue;
    const root = resolveRoot(e.chapterId, e.chapterName);
    if (!root) continue;
    const rid = Number(root.id);
    byRootId.set(rid, (byRootId.get(rid) || 0) + n);
    total += n;
  }
  return { byRootId, total };
}

/**
 * Präsenz-Matrix aus vor-aggregierten Kandidaten bauen.
 *
 * Spaltenauswahl über die geteilte Regel aus ./ranking.js: nach Fundstellen
 * absteigend, bevorzugt mehrfach belegte Entitäten. Einmal-Treffer würden die
 * Top-Spalten sonst fluten und die wiederkehrenden verdrängen — sie kommen
 * nur als Fallback zum Zug, wenn gar nichts mehrfach vorkommt.
 *
 * Skalierung: ein globales Maximum über alle Zellen. Spalten-Normierung wurde
 * verworfen, weil Entitäten oft nur in einem Kapitel auftauchen → 100 % selbst
 * bei Wert 1, wodurch sparse Zellen fälschlich „voll" wirkten.
 *
 * @param {Array<{id, name, byRootId: Map<number, number>, total: number}>} candidates
 * @param {Array<{id, name}>} chapters  Wurzel-Kapitel in Lese-Reihenfolge.
 * @returns {{cols: Array<{id, name}>, rows: Array<{id, name, cells: Array}>}}
 */
export function buildPresenceMatrix(candidates, chapters, { maxCols = PRESENCE_MAX_COLS } = {}) {
  const empty = { cols: [], rows: [] };
  if (!chapters?.length) return empty;
  const withHits = (candidates || []).filter(c => c && c.total > 0);
  if (!withHits.length) return empty;

  const selected = rankPreferRecurring(withHits, { valueOf: c => c.total, limit: maxCols });

  const at = (c, ch) => c.byRootId.get(Number(ch.id)) ?? 0;

  let globalMax = 0;
  for (const c of selected) {
    for (const ch of chapters) {
      const v = at(c, ch);
      if (v > globalMax) globalMax = v;
    }
  }
  globalMax = Math.max(1, globalMax);

  return {
    cols: selected.map(c => ({ id: c.id, name: c.name })),
    rows: chapters.map(ch => ({
      id: ch.id,
      name: ch.name,
      cells: selected.map(c => {
        const v = at(c, ch);
        return {
          id: c.id,
          name: c.name,
          value: v,
          pct: v > 0 ? Math.max(MIN_VISIBLE_PCT, Math.round((v / globalMax) * 100)) : 0,
        };
      }),
    })),
  };
}

// Registry der drei Matrix-Varianten. Das geteilte Partial-Fragment
// (partials/bookoverview-presence-matrix.html) bekommt nur einen `kind`-String
// aus dem umgebenden x-data und geht für alles Weitere über die Dispatcher
// unten — so bleibt das Markup wirklich identisch statt „fast identisch".
const PRESENCE_KINDS = {
  figuren: {
    compute: 'overviewFigurePresence',
    tipKey: 'overview.figPresenceOpen',
    tipVar: 'figur',
    open: (app, cell, row) => app.openFigurMitKapitel(cell.id, row.name),
  },
  orte: {
    compute: 'overviewOrtPresence',
    tipKey: 'overview.ortPresenceOpen',
    tipVar: 'ort',
    open: (app, cell, row) => app.openOrtMitKapitel(cell.id, row.name),
  },
  motive: {
    compute: 'overviewMotifPresence',
    tipKey: 'overview.motifPresenceOpen',
    tipVar: 'motiv',
    open: (app, cell) => app.openMotifById(cell.id),
  },
};

const EMPTY_MATRIX = { cols: [], rows: [] };

export const presenceMethods = {
  // Matrix einer Variante ('figuren' | 'orte' | 'motive'). Einstiegspunkt des
  // geteilten Fragments; die Memoisierung sitzt weiterhin in den Fachmodulen.
  overviewPresence(kind) {
    const cfg = PRESENCE_KINDS[kind];
    return cfg ? this[cfg.compute]() : EMPTY_MATRIX;
  },

  // Tooltip einer belegten Zelle („<Entität> in <Kapitel> öffnen").
  overviewPresenceTip(kind, cell, row) {
    const cfg = PRESENCE_KINDS[kind];
    if (!cfg) return '';
    return window.__app.t(cfg.tipKey, { [cfg.tipVar]: cell.name, kapitel: row.name });
  },

  overviewOpenPresence(kind, cell, row) {
    const cfg = PRESENCE_KINDS[kind];
    if (cfg) cfg.open(window.__app, cell, row);
  },

  // Gemeinsamer Kapitel-Kontext der drei Matrizen: Wurzel-Kapitel als Zeilen
  // plus ein Resolver, der eine Fundstelle (chapter_id, ersatzweise Name) auf
  // ihr Wurzel-Kapitel abbildet. Der Name-Fallback deckt Server-Rows ab, die
  // nur `chapter_name` ohne aufgelöste ID liefern (Backfill-Lücken).
  _presenceContext() {
    const { roots, rootOf, rootOfName } = this._chapterRollup();
    return {
      chapters: roots.map(c => ({ id: c.id, name: c.name })),
      resolveRoot: (chapterId, chapterName) =>
        (chapterId != null ? rootOf(chapterId) : null)
        || (chapterName ? rootOfName(chapterName) : null),
    };
  },
};
