// Stil-Heatmap: Anzeige des Kapitel-Rasters, das der Server liefert (kein KI-Call).
// Gerechnet wird in lib/stil-heatmap.js — hier entstehen nur noch Beschriftung,
// Farbskala und der Drilldown. Methoden werden in Alpine.data('stilCard')
// gespreadet; Root-Zugriffe via window.__app.
//
// Warum die Zell-Darstellung EINMAL pro Datenstand vorberechnet wird (`stilRows`)
// und nicht pro Zelle im Template: Alpine memoisiert Methodenaufrufe in Bindings
// nicht. Ein Aufruf in `:class`/`:style` laeuft bei jedem Render erneut — bei
// Kapiteln x 9 Metriken x 2 Bindings sind das tausende Durchlaeufe, und wenn
// darin die Min/Max-Skala ueber alle Kapitel steckt, wird daraus O(Kapitel^2).
// Das Template liest darum ausschliesslich fertige Eigenschaften.

import { fetchJson, formatNumber, heatmapCellVars, localeTag, minMaxBy, tzOpts } from '../utils.js';

// Metrik-Schlüssel → i18n-Label. Reihenfolge = Spaltenreihenfolge in der Heatmap.
// sampleBucket: Eimer im Drilldown-Endpunkt (/history/style-samples) bzw.
// 'repetition' für die Top-Wörter. null → keine Drilldown-Beispiele.
const STIL_METRICS = [
  { key: 'filler_per1k',     label: 'stil.metric.filler',     decimals: 1, higherIsWorse: true,  sampleBucket: 'filler'     },
  { key: 'passive_per1k',    label: 'stil.metric.passive',    decimals: 1, higherIsWorse: true,  sampleBucket: 'passive'    },
  { key: 'adverb_per1k',     label: 'stil.metric.adverb',     decimals: 1, higherIsWorse: true,  sampleBucket: 'adverb'     },
  { key: 'avg_sentence_len', label: 'stil.metric.avgSentence', decimals: 1, higherIsWorse: null, sampleBucket: null         },
  { key: 'sentence_len_p90', label: 'stil.metric.sentP90',    decimals: 0, higherIsWorse: null,  sampleBucket: null         },
  { key: 'dialog_ratio',     label: 'stil.metric.dialog',     decimals: 1, higherIsWorse: null,  sampleBucket: null         },
  { key: 'repetition_score', label: 'stil.metric.repetition', decimals: 1, higherIsWorse: true,  sampleBucket: 'repetition' },
  { key: 'lix',              label: 'stil.metric.lix',        decimals: 1, higherIsWorse: true,  sampleBucket: null         },
  { key: 'flesch_de',        label: 'stil.metric.flesch',     decimals: 1, higherIsWorse: false, sampleBucket: null         },
];

// Lookup statt linearem Scan — die Metrik-Definition wird pro Zelle gebraucht.
const STIL_METRIC_BY_KEY = new Map(STIL_METRICS.map(m => [m.key, m]));

/** Zelltyp (→ CSS-Klasse) für einen Wert. Getrennt vom Variablen-Style, damit
 *  keine Inline-Style-Strings im DOM landen. Varianten: 'neutral' (kein Tint),
 *  'primary' (primary-fade über --heatmap-t), 'tinted' (grün→rot über --heatmap-t). */
function _cellKind(value, def, range) {
  if (typeof value !== 'number' || !isFinite(value)) return 'neutral';
  if (!def || range.max === range.min) return 'neutral';
  return def.higherIsWorse === null ? 'primary' : 'tinted';
}

/** CSS-Custom-Properties für eine Zelle: 0..1 normalisiert, Richtung je nach
 *  higherIsWorse. null → neutrale Skala (blasser bis kräftiger Primary-Ton),
 *  true → hohe Werte rot, false → umgekehrt. */
function _cellVars(value, def, range) {
  if (typeof value !== 'number' || !isFinite(value)) return {};
  if (!def || range.max === range.min) return {};
  let t = (value - range.min) / (range.max - range.min);
  if (def.higherIsWorse === false) t = 1 - t;
  if (def.higherIsWorse === null) {
    const alpha = 0.12 + (0.55 * t);
    return { '--heatmap-t': Math.round(alpha * 100) + '%' };
  }
  return heatmapCellVars(t);
}

/** Baut die render-fertigen Zeilen aus dem Kapitel-Raster des Servers.
 *  Ein Durchlauf für die Min/Max-Skala je Metrik, einer für die Zellen — statt
 *  einer Skala-Berechnung pro Zelle. Pure Funktion (kein `this`), damit sie ohne
 *  Alpine testbar ist. */
export function buildStilRows(chapters, uiLocale) {
  const rows = [];
  if (!Array.isArray(chapters) || !chapters.length) return rows;

  const ranges = new Map();
  for (const m of STIL_METRICS) ranges.set(m.key, minMaxBy(chapters, (c) => c[m.key]));

  for (const c of chapters) {
    const cells = {};
    for (const m of STIL_METRICS) {
      const value = c[m.key];
      const range = ranges.get(m.key);
      const clickable = !!m.sampleBucket && (value || 0) > 0;
      cells[m.key] = {
        text: formatNumber(value, uiLocale, m.decimals ?? 1),
        cls: `heatmap-cell--${_cellKind(value, m, range)}${clickable ? ' heatmap-cell--clickable' : ''}`,
        vars: _cellVars(value, m, range),
        clickable,
        detailKey: `${c.key}:${m.key}`,
      };
    }
    rows.push({ ...c, cells, wordsLabel: formatNumber(c.words || 0, uiLocale, 0) });
  }
  return rows;
}

export const stilMethods = {
  get stilMetricDefs() { return STIL_METRICS; },

  // Einziger Memo-Helper der Karte (siehe CLAUDE.md „Memo-Pattern"). Deps werden
  // flach per === verglichen; `_memos` wird beim Reset der Karte geleert.
  _memo(key, deps, compute) {
    const memos = (this._memos ||= {});
    const hit = memos[key];
    if (hit && hit.deps.length === deps.length && hit.deps.every((d, i) => d === deps[i])) {
      return hit.value;
    }
    const value = compute();
    memos[key] = { deps: [...deps], value };
    return value;
  },

  // Der Server entscheidet, ob nachgerechnet werden muss — er kennt
  // lib/page-index.js#METRICS_VERSION. Das Frontend hält bewusst keine Kopie
  // davon (an genau so einer Kopie ist diese Karte schon einmal gedriftet).
  _stilNeedsSync() {
    return this.stilData?.needsSync !== false;
  },

  stilHasData() {
    return (this.stilData?.chapters?.length || 0) > 0;
  },

  // Kapitelname der Zeile; `null` heisst „keinem Kapitel zugeordnet" — das Label
  // dafür ist UI-Text und kommt darum nicht aus der Antwort.
  stilChapterName(name) {
    return name || window.__app.t('stil.unassigned');
  },

  // Render-fertige Zeilen inkl. Zell-Klassen und -Variablen. Memoized über den
  // Datenstand und die Anzeigesprache (beide gehen in die Zahlen ein).
  stilRows() {
    const chapters = this.stilData?.chapters || [];
    const locale = Alpine.store('shell').uiLocale;
    return this._memo('rows', [chapters, locale], () => buildStilRows(chapters, locale));
  },

  async loadStilStats(bookId) {
    this.stilLoading = true;
    try {
      const data = await fetchJson('/history/style-stats/' + bookId);
      this.stilData = data;
      this.activeStilDetailKey = null;
      this.stilDetail = null;
    } catch (e) {
      console.error('[loadStilStats]', e);
      this.stilStatus = window.__app.t('common.errorColon') + (e.message || '');
    } finally {
      this.stilLoading = false;
    }
  },

  async runStilSync() {
    if (this.stilSyncing) return;
    this.stilSyncing = true;
    this.stilStatus = `<span class="spinner"></span>${window.__app.t('stil.computing')}`;
    try {
      const result = await fetchJson('/sync/book/' + Alpine.store('nav').selectedBookId, { method: 'POST' });
      if (result.error) throw new Error(result.error);
      await this.loadStilStats(Alpine.store('nav').selectedBookId);
      this.stilStatus = '';
    } catch (e) {
      this.stilStatus = window.__app.t('common.errorColon') + (e.message || '');
    } finally {
      this.stilSyncing = false;
    }
  },

  // Formatiert den lastUpdated-ISO-Timestamp lokalisiert (Datum + Uhrzeit ohne Sekunden).
  stilLastUpdatedLabel() {
    const iso = this.stilData?.lastUpdated;
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const tag = localeTag(Alpine.store('shell').uiLocale);
    const date = d.toLocaleDateString(tag, tzOpts({ year: 'numeric', month: '2-digit', day: '2-digit' }));
    const time = d.toLocaleTimeString(tag, tzOpts({ hour: '2-digit', minute: '2-digit' }));
    return window.__app.t('stil.lastUpdated', { date, time });
  },

  stilMetricLabel(metricKey) {
    const def = STIL_METRIC_BY_KEY.get(metricKey);
    return def ? window.__app.t(def.label) : metricKey;
  },

  // Drilldown. Die Beispielsätze liegen NICHT im Kapitel-Raster (sie sind der
  // grösste Posten der Rohdaten und werden immer nur für eine Zelle gebraucht) —
  // sie werden pro aufgeklappter Zelle nachgeladen.
  async toggleStilDetail(chapterKey, metricKey) {
    const def = STIL_METRIC_BY_KEY.get(metricKey);
    if (!def?.sampleBucket) return;
    const key = `${chapterKey}:${metricKey}`;
    if (this.activeStilDetailKey === key) {
      this.activeStilDetailKey = null;
      this.stilDetail = null;
      return;
    }
    this.activeStilDetailKey = key;
    this.stilDetail = null;
    this.stilDetailLoading = true;
    // Re-Entry-Guard: bei schnellen Klicks darf nur die zuletzt geöffnete Zelle
    // ihr Ergebnis setzen, sonst überholt eine ältere Antwort die neuere.
    const seq = ++this._stilDetailSeq;
    try {
      const bookId = Alpine.store('nav').selectedBookId;
      const qs = new URLSearchParams({ chapter: String(chapterKey), bucket: def.sampleBucket });
      const data = await fetchJson(`/history/style-samples/${bookId}?${qs}`);
      if (seq !== this._stilDetailSeq) return;
      this.stilDetail = {
        key,
        metricLabel: this.stilMetricLabel(metricKey),
        chapterName: this.stilChapterName(data.chapterName),
        entries: data.entries || [],
      };
    } catch (e) {
      if (seq !== this._stilDetailSeq) return;
      console.error('[toggleStilDetail]', e);
      this.stilDetail = { key, metricLabel: this.stilMetricLabel(metricKey), chapterName: '', entries: [] };
    } finally {
      if (seq === this._stilDetailSeq) this.stilDetailLoading = false;
    }
  },

  closeStilDetail() {
    this.activeStilDetailKey = null;
    this.stilDetail = null;
    this.stilDetailLoading = false;
    this._stilDetailSeq++;
  },

  async stilJumpToPage(pageId) {
    const page = (Alpine.store('nav').pages || []).find(p => p.id === pageId);
    if (!page) return;
    window.__app.showStilCard = false;
    this.closeStilDetail();
    await window.__app.selectPage(page);
  },

  async stilJumpToChapter(chapterKey) {
    if (!chapterKey || chapterKey === '__uncat__') return;
    const root = window.__app;
    const opts = root.kapitelReviewChapterOptions ? root.kapitelReviewChapterOptions() : [];
    this.closeStilDetail();
    if (opts.some(c => String(c.id) === String(chapterKey))) {
      root.showStilCard = false;
      await root.openKapitelReviewForChapter(chapterKey);
      return;
    }
    const chapterNode = (Alpine.store('nav').tree || []).find(i => i.type === 'chapter' && String(i.id) === String(chapterKey));
    const firstPage = chapterNode?.pages?.[0];
    if (firstPage) {
      root.showStilCard = false;
      await root.selectPage(firstPage);
    }
  },
};
