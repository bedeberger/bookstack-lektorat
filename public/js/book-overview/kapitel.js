// Kapitel-Tiles: Verteilung (Zeichen), Findings (Lektorat), Lektoratszeit.
// Alle drei nutzen dasselbe Diverging-Bar-Layout um den Median — die Mechanik
// (Median, Ausschlag-Skalierung, Extrem-Marker) liegt in ./diverging.js, hier
// bleibt nur das Einsammeln der jeweiligen Kennzahl pro Wurzel-Kapitel.
//
// Gemeinsame Regel aller drei: Sub-Kapitel werden auf ihr Wurzel-Kapitel
// aggregiert (siehe _chapterRollup in ./load.js).
import { fmtExactDuration, charsToNormseiten } from '../utils.js';
import { divergingRows } from './diverging.js';

// Registry der beiden Tiles im Kapitel-Qualitäts-Partial. Beide rendern über
// dasselbe Fragment (partials/bookoverview-chapter-bars.html), das nur einen
// `kind`-String bekommt und für Daten + Beschriftung hierher zurückruft.
// Die Verteilungs-Tile ist bewusst NICHT dabei: sie ist klickbar pro Zeile und
// zeigt vier zusätzliche Meta-Spalten — gleiches Bar-Layout, anderes Tile.
const CHAPTER_BAR_KINDS = {
  findings: {
    compute: 'overviewChapterFindings',
    median: (ctx, row) => ctx._fmtNum(row.median) + ' ' + window.__app.t('overview.unit.findings'),
    value: (ctx, row) => ctx._fmtNum(row.count) + ' ' + window.__app.t('overview.unit.findings'),
  },
  lektoratTime: {
    compute: 'overviewChapterLektoratTime',
    median: (_ctx, row) => row.medianLabel,
    value: (_ctx, row) => row.durationLabel,
  },
};

export const kapitelMethods = {
  // ── Dispatcher fürs geteilte Balken-Fragment ─────────────────────────────
  overviewChapterBars(kind) {
    const cfg = CHAPTER_BAR_KINDS[kind];
    return cfg ? this[cfg.compute]() : [];
  },

  // Median-Beschriftung (Tile-Kopf + Tick-Tooltip). Leer, solange zu wenige
  // Kapitel für einen aussagekräftigen Median vorliegen.
  overviewChapterBarMedian(kind) {
    const cfg = CHAPTER_BAR_KINDS[kind];
    const first = this.overviewChapterBars(kind)[0];
    if (!cfg || !first?.showMedian) return '';
    return cfg.median(this, first);
  },

  overviewChapterBarValue(kind, row) {
    const cfg = CHAPTER_BAR_KINDS[kind];
    return cfg ? cfg.value(this, row) : '';
  },

  // Buckets über alle Wurzel-Kapitel in Lese-Reihenfolge anlegen. `seed` liefert
  // die Zähl-Felder; `fill` bekommt die Bucket-Map und trägt die Rohdaten ein.
  _chapterBuckets(seed, fill) {
    const { roots } = this._chapterRollup();
    const buckets = new Map();
    for (const r of roots) buckets.set(Number(r.id), { id: r.id, name: r.name, ...seed() });
    fill(buckets);
    const out = [];
    for (const r of roots) {
      const b = buckets.get(Number(r.id));
      if (b) out.push(b);
    }
    return out;
  },

  // Kapitel-Verteilung: Zeichen + Wörter + Seiten pro Top-Level-Kapitel.
  // Liest tree (Lese-Reihenfolge) und tokEsts (Live-Metriken pro Seite).
  // Sortierung: Lese-Reihenfolge der Roots — hier ist die Position im Buch
  // die Information, nicht das Ranking.
  overviewChapterDistribution() {
    const app = window.__app;
    if (!app) return [];
    const tree = Alpine.store('nav').tree || [];
    const tokEsts = app.tokEsts || {};
    return this._memo('chapterDist', [tree, tokEsts],
      () => this._computeChapterDistribution(tree, tokEsts));
  },

  _computeChapterDistribution(tree, tokEsts) {
    const { rootOf } = this._chapterRollup();
    const out = this._chapterBuckets(
      () => ({ pages: 0, words: 0, chars: 0 }),
      (buckets) => {
        for (const item of tree) {
          if (item.type !== 'chapter' || item.solo) continue;
          const root = rootOf(item.id);
          if (!root) continue;
          const b = buckets.get(Number(root.id));
          if (!b) continue;
          const pages = item.pages || [];
          b.pages += pages.length;
          for (const p of pages) {
            const est = tokEsts[p.id];
            if (!est) continue;
            b.words += Number(est.words) || 0;
            b.chars += Number(est.chars) || 0;
          }
        }
      },
    ).map(b => ({ ...b, normseiten: charsToNormseiten(b.chars) }));

    return divergingRows(out, { valueOf: c => c.chars });
  },

  // Lektorat-Findings pro Top-Level-Kapitel: aus overviewHeat.matrix (mode=open).
  // Median, Diverging-Bar und Sort basieren auf der absoluten Anzahl Findings —
  // direkt ablesbar, ohne mentalen Umweg über Findings/1k Wörter. per1k bleibt
  // als sekundärer Wert in der Zeilen-Meta erhalten. Ungeprüfte Kapitel
  // (pages_checked = 0) erscheinen nicht: ohne Prüfung ist „0 Findings" keine
  // Aussage über die Textqualität und würde den Median nach unten ziehen.
  overviewChapterFindings() {
    const heat = this.overviewHeat;
    if (!heat || !Array.isArray(heat.chapters) || !heat.matrix) return [];
    const tree = Alpine.store('nav').tree || [];
    return this._memo('chapterFindings', [heat, tree], () => this._computeChapterFindings(heat));
  },

  _computeChapterFindings(heat) {
    const { rootOf, rootOfName } = this._chapterRollup();
    const out = this._chapterBuckets(
      () => ({ count: 0, words: 0, pages_total: 0, pages_checked: 0 }),
      (buckets) => {
        for (const ch of heat.chapters) {
          if (ch.chapter_id == null) continue;
          const root = rootOf(ch.chapter_id) || rootOfName(ch.chapter_name);
          if (!root) continue;
          const b = buckets.get(Number(root.id));
          if (!b) continue;
          const typen = heat.matrix[ch.chapter_id] || {};
          let count = 0;
          for (const t of Object.values(typen)) count += Number(t.count) || 0;
          b.count += count;
          b.words += Number(ch.words) || 0;
          b.pages_total += Number(ch.pages_total) || 0;
          b.pages_checked += Number(ch.pages_checked) || 0;
        }
      },
    )
      .filter(b => b.pages_checked > 0)
      .map(b => ({ ...b, per1k: b.words > 0 ? Math.round((b.count / b.words) * 1000 * 10) / 10 : 0 }));

    return divergingRows(out, {
      valueOf: c => c.count,
      minForMedian: 3,
      roundMedian: true,
      extremesNeedTwo: true,
    }).sort((a, b) => b.count - a.count);
  },

  // Lektoratszeit pro Top-Level-Kapitel. /history/lektorat-time/:book_id liefert
  // per_chapter pro direktem chapter_id. Kapitel ohne erfasste Zeit erscheinen
  // nicht — analog zu ungeprüften Kapiteln in der Findings-Tile.
  // Sort: Sekunden desc.
  overviewChapterLektoratTime() {
    const tree = Alpine.store('nav').tree || [];
    const lt = this.overviewLektoratTime;
    return this._memo('chapterLektoratTime', [tree, lt], () => this._computeChapterLektoratTime(lt));
  },

  _computeChapterLektoratTime(lt) {
    const { rootOf, rootOfName } = this._chapterRollup();
    const out = this._chapterBuckets(
      () => ({ seconds: 0, pages_count: 0 }),
      (buckets) => {
        for (const row of (lt?.per_chapter || [])) {
          const sec = Number(row.seconds) || 0;
          if (sec <= 0) continue;
          const root = (row.chapter_id != null ? rootOf(row.chapter_id) : null)
                     || rootOfName(row.chapter_name);
          if (!root) continue;
          const b = buckets.get(Number(root.id));
          if (!b) continue;
          b.seconds += sec;
          b.pages_count += Number(row.pages_count) || 0;
        }
      },
    ).filter(b => b.seconds > 0);

    return divergingRows(out, {
      valueOf: c => c.seconds,
      minForMedian: 3,
      roundMedian: true,
      extremesNeedTwo: true,
    })
      .map(c => ({ ...c, medianLabel: fmtExactDuration(c.median), durationLabel: fmtExactDuration(c.seconds) }))
      .sort((a, b) => b.seconds - a.seconds);
  },
};
