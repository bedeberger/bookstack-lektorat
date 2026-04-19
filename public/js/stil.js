// Stil-Heatmap: deterministische Stil-Metriken pro Kapitel (kein KI-Call).
// Greift auf page_stats zu (gefüllt vom Sync-Job über lib/page-index.js).
// `this` zeigt auf die Alpine-Komponente.

import { fetchJson } from './utils.js';

// Metrik-Schlüssel → i18n-Label. Reihenfolge = Spaltenreihenfolge in der Heatmap.
const STIL_METRICS = [
  { key: 'filler_per1k',     label: 'stil.metric.filler',     decimals: 1, higherIsWorse: true  },
  { key: 'passive_per1k',    label: 'stil.metric.passive',    decimals: 1, higherIsWorse: true  },
  { key: 'adverb_per1k',     label: 'stil.metric.adverb',     decimals: 1, higherIsWorse: true  },
  { key: 'avg_sentence_len', label: 'stil.metric.avgSentence', decimals: 1, higherIsWorse: null },
  { key: 'sentence_len_p90', label: 'stil.metric.sentP90',    decimals: 0, higherIsWorse: null },
  { key: 'dialog_ratio',     label: 'stil.metric.dialog',     decimals: 1, higherIsWorse: null },
  { key: 'repetition_score', label: 'stil.metric.repetition', decimals: 1, higherIsWorse: true  },
  { key: 'lix',              label: 'stil.metric.lix',        decimals: 1, higherIsWorse: true  },
  { key: 'flesch_de',        label: 'stil.metric.flesch',     decimals: 1, higherIsWorse: false },
];

export const stilMethods = {
  get stilMetricDefs() { return STIL_METRICS; },

  async toggleStilCard() {
    if (this.showStilCard) { this.showStilCard = false; return; }
    this._closeOtherMainCards('stil');
    this.showStilCard = true;
    await this.loadStilStats(this.selectedBookId);
    if (this._stilNeedsSync()) {
      // Automatischer First-Time-Sync: Seiten ohne metrics_version=2 vorhanden → berechnen lassen.
      await this.runStilSync();
    }
  },

  _stilNeedsSync() {
    const pages = this.stilData?.pages || [];
    if (pages.length === 0) return true;
    // Als "unvollständig" gilt: lix leer trotz words>0, oder metrics_version<2.
    return pages.some(p => (p.words > 0) && (p.lix == null || (p.metrics_version ?? 0) < 2));
  },

  async loadStilStats(bookId) {
    this.stilLoading = true;
    try {
      const data = await fetchJson('/history/style-stats/' + bookId);
      this.stilData = data;
    } catch (e) {
      console.error('[loadStilStats]', e);
      this.stilStatus = this.t('common.errorColon') + (e.message || '');
    } finally {
      this.stilLoading = false;
    }
  },

  async runStilSync() {
    if (this.stilSyncing) return;
    this.stilSyncing = true;
    this.stilStatus = `<span class="spinner"></span>${this.t('stil.computing')}`;
    try {
      const result = await fetchJson('/sync/book/' + this.selectedBookId, { method: 'POST' });
      if (result.error) throw new Error(result.error);
      await this.loadStilStats(this.selectedBookId);
      this.stilStatus = '';
    } catch (e) {
      this.stilStatus = this.t('common.errorColon') + (e.message || '');
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
    const unassignedLabel = this.t('stil.unassigned');
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
    let min = Infinity, max = -Infinity;
    for (const c of chapters) {
      const v = c[metricKey];
      if (typeof v !== 'number') continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (min === Infinity) return { min: 0, max: 0 };
    return { min, max };
  },

  // Liefert eine CSS-Hintergrundfarbe für eine Zelle: 0..1 normalisiert, Richtung je nach higherIsWorse.
  // higherIsWorse=null → neutrale Skala (Gradient vom blasseren zum kräftigeren Primary-Ton).
  // higherIsWorse=true → hohe Werte rot, niedrige grün.
  // higherIsWorse=false → umgekehrt.
  stilCellStyle(value, metricKey, chapters) {
    if (typeof value !== 'number' || !isFinite(value)) return '';
    const def = STIL_METRICS.find(m => m.key === metricKey);
    if (!def) return '';
    const { min, max } = this.stilMetricRange(metricKey, chapters);
    if (max === min) return '';
    let t = (value - min) / (max - min); // 0..1
    if (def.higherIsWorse === false) t = 1 - t;
    // Neutral: Primary-Fade; direktional: rot ↔ grün.
    // CSS-Variablen bleiben im Theme konsistent.
    if (def.higherIsWorse === null) {
      const alpha = 0.12 + (0.55 * t);
      return `background: color-mix(in srgb, var(--color-primary) ${Math.round(alpha * 100)}%, transparent);`;
    }
    // t=0 → grün, t=1 → rot. color-mix zwischen success und danger.
    const pct = Math.round(t * 100);
    return `background: color-mix(in srgb, var(--color-danger, #c0392b) ${pct}%, var(--color-success, #27ae60));`;
  },

  // Formatiert den last_updated-ISO-Timestamp lokalisiert (Datum + Uhrzeit ohne Sekunden).
  stilLastUpdatedLabel() {
    const iso = this.stilData?.last_updated;
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const localeTag = (this.uiLocale === 'en') ? 'en-US' : 'de-CH';
    const date = d.toLocaleDateString(localeTag, { year: 'numeric', month: '2-digit', day: '2-digit' });
    const time = d.toLocaleTimeString(localeTag, { hour: '2-digit', minute: '2-digit' });
    return this.t('stil.lastUpdated', { date, time });
  },

  stilFormat(value, metricKey) {
    if (value == null || !isFinite(value)) return '–';
    const def = STIL_METRICS.find(m => m.key === metricKey);
    const decimals = def?.decimals ?? 1;
    const localeTag = (this.uiLocale === 'en') ? 'en-US' : 'de-CH';
    return value.toLocaleString(localeTag, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  },
};
