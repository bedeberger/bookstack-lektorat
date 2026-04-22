// Stil-Heatmap: deterministische Stil-Metriken pro Kapitel (kein KI-Call).
// Greift auf page_stats zu (gefüllt vom Sync-Job über lib/page-index.js).
// Methoden werden in Alpine.data('stilCard') gespreadet; Root-Zugriffe via window.__app.

import { fetchJson, formatNumber, heatmapCellVars, localeTag, minMaxBy } from './utils.js';

// Metrik-Schlüssel → i18n-Label. Reihenfolge = Spaltenreihenfolge in der Heatmap.
// sampleBucket: Schlüssel im pro-Seite `style_samples`-Objekt bzw. 'repetition'
// für die Top-Wörter aus repetition_data. null → keine Drilldown-Beispiele.
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

// Pro-Seite-Zählung, die für die Sortierung der Drilldown-Treffer dient.
const STIL_COUNT_FIELD = { filler: 'filler_count', passive: 'passive_count', adverb: 'adverb_count' };

// Erwartete METRICS_VERSION aus lib/page-index.js. Muss mitgepflegt werden, damit
// _stilNeedsSync bei einem Backend-Bump auto-resynct.
const EXPECTED_METRICS_VERSION = 5;

export const stilMethods = {
  get stilMetricDefs() { return STIL_METRICS; },

  _stilNeedsSync() {
    const pages = this.stilData?.pages || [];
    if (pages.length === 0) return true;
    // Als "unvollständig" gilt: lix leer trotz words>0, oder metrics_version < EXPECTED.
    return pages.some(p => (p.words > 0) && (p.lix == null || (p.metrics_version ?? 0) < EXPECTED_METRICS_VERSION));
  },

  async loadStilStats(bookId) {
    this.stilLoading = true;
    try {
      const data = await fetchJson('/history/style-stats/' + bookId);
      this.stilData = data;
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
      const result = await fetchJson('/sync/book/' + window.__app.selectedBookId, { method: 'POST' });
      if (result.error) throw new Error(result.error);
      await this.loadStilStats(window.__app.selectedBookId);
      this.stilStatus = '';
    } catch (e) {
      this.stilStatus = window.__app.t('common.errorColon') + (e.message || '');
    } finally {
      this.stilSyncing = false;
    }
  },

  // Aggregiert die Seiten zu Kapiteln. Liefert Array mit pro-Kapitel-Metriken.
  // Gewichtete Durchschnitte über die Wortzahl — dominierende Seiten zählen mehr.
  stilChaptersAggregated() {
    const pages = this.stilData?.pages || [];
    if (!pages.length) return [];
    const groups = new Map();
    const unassignedLabel = window.__app.t('stil.unassigned');
    for (const p of pages) {
      const key = p.chapter_id ?? '__uncat__';
      const name = p.chapter_name || unassignedLabel;
      if (!groups.has(key)) groups.set(key, { key, name, pages: [] });
      groups.get(key).pages.push(p);
    }
    const out = [];
    for (const g of groups.values()) {
      const totalWords    = g.pages.reduce((s, p) => s + (p.words || 0), 0);
      const totalChars    = g.pages.reduce((s, p) => s + (p.chars || 0), 0);
      const totalDialog   = g.pages.reduce((s, p) => s + (p.dialog_chars || 0), 0);
      const fillerSum     = g.pages.reduce((s, p) => s + (p.filler_count || 0), 0);
      const passiveSum    = g.pages.reduce((s, p) => s + (p.passive_count || 0), 0);
      const adverbSum     = g.pages.reduce((s, p) => s + (p.adverb_count || 0), 0);
      const wAvg = (field) => {
        let num = 0, den = 0;
        for (const p of g.pages) {
          const v = p[field];
          if (v == null || !p.words) continue;
          num += v * p.words;
          den += p.words;
        }
        return den > 0 ? Math.round((num / den) * 10) / 10 : null;
      };
      // Wiederholungs-Score: repetition_data.score ist pro Seite → gewichtet mitteln.
      let repNum = 0, repDen = 0;
      const topRepMap = new Map();
      for (const p of g.pages) {
        if (p.repetition_data?.score != null && p.words) {
          repNum += p.repetition_data.score * p.words;
          repDen += p.words;
        }
        for (const r of (p.repetition_data?.top || [])) {
          topRepMap.set(r.word, (topRepMap.get(r.word) || 0) + r.count);
        }
      }
      const topRepetitions = [...topRepMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([word, count]) => ({ word, count }));
      out.push({
        key: g.key,
        name: g.name,
        pageCount: g.pages.length,
        words: totalWords,
        filler_per1k:     totalWords > 0 ? Math.round((fillerSum  / totalWords) * 1000 * 10) / 10 : 0,
        passive_per1k:    totalWords > 0 ? Math.round((passiveSum / totalWords) * 1000 * 10) / 10 : 0,
        adverb_per1k:     totalWords > 0 ? Math.round((adverbSum  / totalWords) * 1000 * 10) / 10 : 0,
        avg_sentence_len: wAvg('avg_sentence_len'),
        sentence_len_p90: (() => { const v = wAvg('sentence_len_p90'); return v != null ? Math.round(v) : null; })(),
        dialog_ratio:     totalChars > 0 ? Math.round((totalDialog / totalChars) * 1000) / 10 : 0,
        repetition_score: repDen > 0 ? Math.round((repNum / repDen) * 10) / 10 : 0,
        lix:              wAvg('lix'),
        flesch_de:        wAvg('flesch_de'),
        topRepetitions,
      });
    }
    return out;
  },

  // Pro Metrik: min/max über alle Kapitel, für Farbskala.
  // Cached im Trägerobjekt (wird bei jedem Aufruf frisch berechnet — günstig, <100 Kapitel).
  stilMetricRange(metricKey, chapters) {
    return minMaxBy(chapters, (c) => c[metricKey]);
  },

  // Liefert eine CSS-Hintergrundfarbe für eine Zelle: 0..1 normalisiert, Richtung je nach higherIsWorse.
  // higherIsWorse=null → neutrale Skala (Gradient vom blasseren zum kräftigeren Primary-Ton).
  // higherIsWorse=true → hohe Werte rot, niedrige grün.
  // higherIsWorse=false → umgekehrt.
  // Zelltyp (→ CSS-Klasse) separat vom Variablen-Style, damit keine Inline-
  // Style-Strings im DOM landen. Varianten: 'neutral' (kein Tint),
  // 'primary' (primary-fade über --heatmap-t), 'tinted' (grün→rot über --heatmap-t).
  stilCellKind(value, metricKey, chapters) {
    if (typeof value !== 'number' || !isFinite(value)) return 'neutral';
    const def = STIL_METRICS.find(m => m.key === metricKey);
    if (!def) return 'neutral';
    const { min, max } = this.stilMetricRange(metricKey, chapters);
    if (max === min) return 'neutral';
    return def.higherIsWorse === null ? 'primary' : 'tinted';
  },

  stilCellVars(value, metricKey, chapters) {
    if (typeof value !== 'number' || !isFinite(value)) return {};
    const def = STIL_METRICS.find(m => m.key === metricKey);
    if (!def) return {};
    const { min, max } = this.stilMetricRange(metricKey, chapters);
    if (max === min) return {};
    let t = (value - min) / (max - min);
    if (def.higherIsWorse === false) t = 1 - t;
    if (def.higherIsWorse === null) {
      const alpha = 0.12 + (0.55 * t);
      return { '--heatmap-t': Math.round(alpha * 100) + '%' };
    }
    return heatmapCellVars(t);
  },

  // Formatiert den last_updated-ISO-Timestamp lokalisiert (Datum + Uhrzeit ohne Sekunden).
  stilLastUpdatedLabel() {
    const iso = this.stilData?.last_updated;
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const tag = localeTag(window.__app.uiLocale);
    const date = d.toLocaleDateString(tag, { year: 'numeric', month: '2-digit', day: '2-digit' });
    const time = d.toLocaleTimeString(tag, { hour: '2-digit', minute: '2-digit' });
    return window.__app.t('stil.lastUpdated', { date, time });
  },

  stilFormat(value, metricKey) {
    const def = STIL_METRICS.find(m => m.key === metricKey);
    return formatNumber(value, window.__app.uiLocale, def?.decimals ?? 1);
  },

  // Drilldown: welche Metrik-Spalten zeigen Beispiele, wenn man auf die Zelle klickt.
  stilIsClickableMetric(metricKey) {
    const def = STIL_METRICS.find(m => m.key === metricKey);
    return !!def?.sampleBucket;
  },

  toggleStilDetail(chapterKey, metricKey) {
    if (!this.stilIsClickableMetric(metricKey)) return;
    const key = `${chapterKey}:${metricKey}`;
    this.activeStilDetailKey = (this.activeStilDetailKey === key) ? null : key;
  },

  stilMetricLabel(metricKey) {
    const def = STIL_METRICS.find(m => m.key === metricKey);
    return def ? window.__app.t(def.label) : metricKey;
  },

  // Baut das Detail-Objekt für die aktive Zelle: Seiten-Liste mit Samples bzw.
  // Top-Wörtern (Wiederholungs-Drilldown).
  stilActiveDetail() {
    const key = this.activeStilDetailKey;
    if (!key) return null;
    const [chapterKey, metricKey] = key.split(':');
    const def = STIL_METRICS.find(m => m.key === metricKey);
    if (!def?.sampleBucket) return null;

    const pages = this.stilData?.pages || [];
    const inChapter = pages.filter(p => String(p.chapter_id ?? '__uncat__') === chapterKey);
    const unassignedLabel = window.__app.t('stil.unassigned');
    const chapterName = inChapter[0]?.chapter_name || unassignedLabel;

    const entries = [];
    if (def.sampleBucket === 'repetition') {
      for (const p of inChapter) {
        const top = p.repetition_data?.top || [];
        if (!top.length) continue;
        entries.push({
          page_id: p.page_id,
          page_name: p.page_name || String(p.page_id),
          count: top.reduce((s, r) => s + (r.count || 0), 0),
          words: top.map(r => ({ token: r.word, count: r.count })),
        });
      }
    } else {
      const bucket = def.sampleBucket;
      const countField = STIL_COUNT_FIELD[bucket];
      for (const p of inChapter) {
        const samples = p.style_samples?.[bucket] || [];
        if (!samples.length) continue;
        entries.push({
          page_id: p.page_id,
          page_name: p.page_name || String(p.page_id),
          count: (countField && p[countField]) || samples.length,
          samples,
        });
      }
    }
    entries.sort((a, b) => b.count - a.count);

    return {
      key,
      chapterKey,
      metricKey,
      metricLabel: this.stilMetricLabel(metricKey),
      chapterName,
      entries,
    };
  },

  // Gruppiert Samples nach Token, damit im Detail-Panel jedes Token einmal als
  // Badge erscheint und die Beispielsätze darunter eingerückt stehen.
  stilGroupSamplesByToken(samples) {
    const groups = [];
    const byToken = new Map();
    for (const s of samples || []) {
      const token = s.token || '';
      if (!byToken.has(token)) {
        const group = { token, sentences: [] };
        byToken.set(token, group);
        groups.push(group);
      }
      byToken.get(token).sentences.push(s.sentence);
    }
    return groups;
  },

  async stilJumpToPage(pageId) {
    const page = (window.__app.pages || []).find(p => p.id === pageId);
    if (!page) return;
    window.__app.showStilCard = false;
    this.activeStilDetailKey = null;
    await window.__app.selectPage(page);
  },
};
