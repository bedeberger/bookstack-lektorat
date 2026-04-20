// Buchschreibungsentwicklung – Zeitliniendiagramm
// `this` zeigt auf die Alpine-Komponente (via spread in app.js)

import { fetchJson } from './utils.js';

const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// Chart-Labels kommen zur Render-Zeit über t() (siehe _metricLabel()), damit sie
// bei Sprachwechsel live nachgezogen werden.
const METRIC_KEYS = {
  words:              'bookstats.metric.words',
  chars:              'bookstats.metric.chars',
  page_count:         'bookstats.metric.pages',
  tok:                'bookstats.metric.tok',
  unique_words:       'bookstats.metric.unique',
  delta_words:        'bookstats.metric.delta',
  avg_sentence_len:   'bookstats.metric.avgSentence',
  pages_per_chapter:  'bookstats.metric.pagesPerChapter',
  avg_lix:            'bookstats.metric.lix',
  avg_flesch_de:      'bookstats.metric.flesch',
  writing_minutes:    'bookstats.metric.writingMinutes',
  writing_cumulative: 'bookstats.metric.writingCumulative',
};

const WRITING_METRICS = new Set(['writing_minutes', 'writing_cumulative']);

// Ausserhalb von Alpine gespeichert, damit die Chart.js-Instanz nicht durch
// Alpines Reaktivitäts-Proxy beschädigt wird.
let _statsChart = null;
let _themeObserver = null;

function _ensureThemeObserver(component) {
  if (_themeObserver) return;
  _themeObserver = new MutationObserver(() => {
    if (!_statsChart || !component.showBookStatsCard) return;
    _statsChart.destroy();
    _statsChart = null;
    component.renderStatsChart();
  });
  _themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
}

export const bookstatsMethods = {
  async toggleBookStatsCard() {
    if (this.showBookStatsCard) { await this.loadBookStats(this.selectedBookId); return; }
    this._closeOtherMainCards('bookStats');
    this.showBookStatsCard = true;
    await this.loadBookStats(this.selectedBookId);
  },

  closeBookStatsCard() {
    this.showBookStatsCard = false;
    if (_statsChart) { _statsChart.destroy(); _statsChart = null; }
  },

  async loadBookStats(bookId) {
    try {
      const [rows, coverage, writing] = await Promise.all([
        fetchJson('/history/book-stats/' + bookId),
        fetchJson('/history/coverage/' + bookId),
        fetchJson('/history/writing-time/' + bookId),
      ]);
      this.bookStatsData = rows;
      this.bookStatsCoverage = coverage;
      this.writingTimeData = writing;
      const last = rows[rows.length - 1];
      const prev = rows[rows.length - 2];
      this.bookStatsDelta = (last && prev) ? last.words - prev.words : null;
      this.$nextTick(() => this.renderStatsChart());
    } catch (e) {
      console.error('[loadBookStats]', e);
    }
  },

  async syncBookStats() {
    if (this.bookStatsLoading) return;
    this.bookStatsLoading = true;
    this.bookStatsSyncStatus = `<span class="spinner"></span>${this.t('bookstats.syncing')}`;
    try {
      const result = await fetchJson('/sync/book/' + this.selectedBookId, { method: 'POST' });
      if (result.error) throw new Error(result.error);
      const localeTag = (this.uiLocale === 'en') ? 'en-US' : 'de-CH';
      const now = new Date().toLocaleTimeString(localeTag, { hour: '2-digit', minute: '2-digit' });
      this.bookStatsSyncStatus = this.t('bookstats.syncDone', { time: now });
      await this.loadBookStats(this.selectedBookId);
      // page_stats-Cache in tokEsts übernehmen, falls Seiten geladen
      if (this.pages.length) {
        const cache = await fetchJson('/history/page-stats/' + this.selectedBookId);
        for (const p of this.pages) {
          const c = cache[p.id];
          if (c && c.updated_at === p.updated_at) {
            this.tokEsts[p.id] = { tok: c.tok, words: c.words, chars: c.chars };
          }
        }
      }
    } catch (e) {
      this.bookStatsSyncStatus = this.t('common.errorColon') + e.message;
    } finally {
      this.bookStatsLoading = false;
    }
  },

  renderStatsChart() {
    const canvas = document.getElementById('book-stats-chart');
    if (!canvas) return;

    // Chart immer frisch aufbauen. Der Update-Pfad (chart.update) liest keine
    // neuen Canvas-Dimensionen ein — nach einem display:none↔block-Wechsel
    // (Buchwechsel: bookStatsData = [] → = rows) bleibt das Diagramm sonst
    // mit stale Dimensionen leer, bis ein Reflow nachzieht.
    if (_statsChart) { _statsChart.destroy(); _statsChart = null; }

    const metric = this.bookStatsMetric;
    const isWriting = WRITING_METRICS.has(metric);

    // Writing-Metriken laufen auf der writing_time-Zeitachse (nur aktive Tage),
    // nicht auf der book_stats_history-Timeline — sonst fehlen Tage ohne Sync,
    // und Snapshots ohne Schreibzeit würden als 0-Punkte erscheinen.
    let rows = isWriting
      ? (this.writingTimeData?.daily || []).map(d => ({ recorded_at: d.date, seconds: d.seconds }))
      : this.bookStatsData;
    if (!rows.length) return;

    // Zeitraum-Filter
    if (this.bookStatsRange > 0) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - this.bookStatsRange);
      const cutoffStr = cutoff.toISOString().slice(0, 10);
      rows = rows.filter(r => r.recorded_at >= cutoffStr);
    }

    const labels = rows.map(r => {
      const [y, m, d] = r.recorded_at.split('-');
      return `${d}.${m}.${y.slice(2)}`;
    });

    const isDelta = metric === 'delta_words';
    const isPpc   = metric === 'pages_per_chapter';
    const isWritMin = metric === 'writing_minutes';
    const isWritCum = metric === 'writing_cumulative';
    let data;
    if (isDelta) data = rows.map((r, i) => i === 0 ? null : r.words - rows[i - 1].words);
    else if (isPpc) data = rows.map(r => r.chapter_count > 0 ? Math.round((r.page_count / r.chapter_count) * 10) / 10 : null);
    else if (isWritMin) data = rows.map(r => Math.round(r.seconds / 60));
    else if (isWritCum) { let sum = 0; data = rows.map(r => { sum += r.seconds; return Math.round(sum / 360) / 10; }); }
    else data = rows.map(r => r[metric] ?? null);

    const metricLabel = METRIC_KEYS[metric] ? this.t(METRIC_KEYS[metric]) : metric;

    const localeTag = (this.uiLocale === 'en') ? 'en-US' : 'de-CH';
    const isDecimal = isPpc || isWritCum || metric === 'avg_sentence_len' || metric === 'avg_lix' || metric === 'avg_flesch_de';
    const fmt = v => isDecimal ? v.toLocaleString(localeTag, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
      : Math.round(v).toLocaleString(localeTag);
    const makeTick = () => v => {
      if (v === null) return '';
      return (isDelta && v >= 0 ? '+' : '') + fmt(v);
    };
    const makeTooltip = () => ctx => {
      const v = ctx.parsed.y;
      if (v === null) return '';
      return ` ${ctx.dataset.label}: ${isDelta && v >= 0 ? '+' : ''}${fmt(v)}`;
    };

    const primary  = cssVar('--color-primary');
    const muted    = cssVar('--color-muted');
    const gridLine = cssVar('--color-border');

    _ensureThemeObserver(this);

    _statsChart = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: metricLabel,
          data,
          borderColor: primary,
          backgroundColor: primary + '12',
          borderWidth: 2,
          tension: 0.35,
          pointRadius: 4,
          pointHoverRadius: 6,
          pointBackgroundColor: primary,
          fill: true,
          spanGaps: false,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: makeTooltip(),
            },
          },
        },
        scales: {
          x: {
            grid: { color: gridLine },
            ticks: { font: { size: 11 }, color: muted },
          },
          y: {
            grid: { color: gridLine },
            beginAtZero: false,
            ticks: {
              font: { size: 11 },
              color: muted,
              callback: makeTick(),
              stepSize: metric === 'page_count' ? 1 : undefined,
            },
          },
        },
      },
    });
  },
};
