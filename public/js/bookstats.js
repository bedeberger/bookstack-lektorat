// Buchschreibungsentwicklung – Zeitliniendiagramm
// `this` zeigt auf die Alpine-Komponente (via spread in app.js)

const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const METRIC_LABELS = {
  words:             'Wörter',
  chars:             'Zeichen',
  page_count:        'Seiten',
  tok:               'Tokens',
  unique_words:      'Einzigartige Wörter',
  delta_words:       'Δ Wörter/Tag',
  avg_sentence_len:  'Ø Satzlänge (Wörter)',
  pages_per_chapter: 'Ø Seiten/Kapitel',
};

// Ausserhalb von Alpine gespeichert, damit die Chart.js-Instanz nicht durch
// Alpines Reaktivitäts-Proxy beschädigt wird.
let _statsChart = null;

export const bookstatsMethods = {
  async toggleBookStatsCard() {
    if (this.showBookStatsCard) {
      this.showBookStatsCard = false;
      if (_statsChart) { _statsChart.destroy(); _statsChart = null; }
      return;
    }
    this._closeOtherMainCards('bookStats');
    this.showBookStatsCard = true;
    await this.loadBookStats(this.selectedBookId);
  },

  async loadBookStats(bookId) {
    try {
      const [rows, coverage] = await Promise.all([
        fetch('/history/book-stats/' + bookId).then(r => r.json()),
        fetch('/history/coverage/' + bookId).then(r => r.json()),
      ]);
      this.bookStatsData = rows;
      this.bookStatsCoverage = coverage;
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
    this.bookStatsSyncStatus = '<span class="spinner"></span>Synchronisiere…';
    try {
      const result = await fetch('/sync/book/' + this.selectedBookId, { method: 'POST' })
        .then(r => r.json());
      if (result.error) throw new Error(result.error);
      const now = new Date().toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
      this.bookStatsSyncStatus = `Sync um ${now} abgeschlossen`;
      await this.loadBookStats(this.selectedBookId);
      // page_stats-Cache in tokEsts übernehmen, falls Seiten geladen
      if (this.pages.length) {
        const cache = await fetch('/history/page-stats/' + this.selectedBookId).then(r => r.json());
        for (const p of this.pages) {
          const c = cache[p.id];
          if (c && c.updated_at === p.updated_at) {
            this.tokEsts[p.id] = { tok: c.tok, words: c.words, chars: c.chars };
          }
        }
      }
    } catch (e) {
      this.bookStatsSyncStatus = 'Fehler: ' + e.message;
    } finally {
      this.bookStatsLoading = false;
    }
  },

  renderStatsChart() {
    const canvas = document.getElementById('book-stats-chart');
    if (!canvas) return;

    if (!this.bookStatsData.length) {
      if (_statsChart) { _statsChart.destroy(); _statsChart = null; }
      return;
    }

    // Zeitraum-Filter
    let rows = this.bookStatsData;
    if (this.bookStatsRange > 0) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - this.bookStatsRange);
      const cutoffStr = cutoff.toISOString().slice(0, 10);
      rows = rows.filter(r => r.recorded_at >= cutoffStr);
    }

    const metric = this.bookStatsMetric;
    const labels = rows.map(r => {
      const [y, m, d] = r.recorded_at.split('-');
      return `${d}.${m}.${y.slice(2)}`;
    });

    const isDelta = metric === 'delta_words';
    const isPpc   = metric === 'pages_per_chapter';
    const data = isDelta ? rows.map((r, i) => i === 0 ? null : r.words - rows[i - 1].words)
      : isPpc  ? rows.map(r => r.chapter_count > 0 ? Math.round((r.page_count / r.chapter_count) * 10) / 10 : null)
      : rows.map(r => r[metric] ?? null);

    const metricLabel = METRIC_LABELS[metric] || metric;

    const isDecimal = isPpc || metric === 'avg_sentence_len';
    const fmt = v => isDecimal ? v.toLocaleString('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
      : Math.round(v).toLocaleString('de-CH');
    const makeTick = () => v => {
      if (v === null) return '';
      return (isDelta && v >= 0 ? '+' : '') + fmt(v);
    };
    const makeTooltip = () => ctx => {
      const v = ctx.parsed.y;
      if (v === null) return '';
      return ` ${ctx.dataset.label}: ${isDelta && v >= 0 ? '+' : ''}${fmt(v)}`;
    };

    if (_statsChart) {
      _statsChart.data.labels = labels;
      _statsChart.data.datasets[0].data = data;
      _statsChart.data.datasets[0].label = metricLabel;
      _statsChart.options.scales.y.ticks.callback = makeTick();
      _statsChart.options.scales.y.ticks.stepSize = metric === 'page_count' ? 1 : undefined;
      _statsChart.options.plugins.tooltip.callbacks.label = makeTooltip();
      _statsChart.update();
      return;
    }

    const primary  = cssVar('--color-primary');
    const muted    = cssVar('--color-muted');
    const gridLine = cssVar('--color-border');

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
