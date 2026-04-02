// Buchschreibungsentwicklung – Zeitliniendiagramm
// `this` zeigt auf die Alpine-Komponente (via spread in app.js)

const METRIC_LABELS = {
  words:      'Wörter',
  chars:      'Zeichen',
  page_count: 'Seiten',
  tok:        'Tokens',
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
    this.showBookStatsCard = true;
    await this.loadBookStats(this.selectedBookId);
  },

  async loadBookStats(bookId) {
    try {
      const rows = await fetch('/history/book-stats/' + bookId).then(r => r.json());
      this.bookStatsData = rows;
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
    const data = rows.map(r => r[metric]);
    const metricLabel = METRIC_LABELS[metric] || metric;

    // Ganzzahlige Achsenbeschriftung für Seiten; k-Formatierung für grosse Werte
    const makeTick = m => v => {
      if (m === 'page_count') return Number.isInteger(v) ? v : null;
      return v >= 1000 ? '~' + Math.round(v / 1000) + 'k' : v;
    };
    const makeTooltip = m => ctx => {
      const v = ctx.parsed.y;
      const fmt = (m !== 'page_count' && v >= 1000)
        ? '~' + Math.round(v / 1000) + 'k'
        : String(Math.round(v));
      return ` ${ctx.dataset.label}: ${fmt}`;
    };

    if (_statsChart) {
      _statsChart.data.labels = labels;
      _statsChart.data.datasets[0].data = data;
      _statsChart.data.datasets[0].label = metricLabel;
      _statsChart.options.scales.y.ticks.callback = makeTick(metric);
      _statsChart.options.plugins.tooltip.callbacks.label = makeTooltip(metric);
      _statsChart.update();
      return;
    }

    _statsChart = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: metricLabel,
          data,
          borderColor: '#4A90D9',
          backgroundColor: 'rgba(74,144,217,0.07)',
          borderWidth: 2,
          tension: 0.35,
          pointRadius: 4,
          pointHoverRadius: 6,
          pointBackgroundColor: '#4A90D9',
          fill: true,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: makeTooltip(metric),
            },
          },
        },
        scales: {
          x: {
            grid: { color: 'rgba(0,0,0,0.05)' },
            ticks: { font: { size: 11 }, color: '#888' },
          },
          y: {
            grid: { color: 'rgba(0,0,0,0.05)' },
            beginAtZero: false,
            ticks: {
              font: { size: 11 },
              color: '#888',
              callback: makeTick(metric),
            },
          },
        },
      },
    });
  },
};
