// Chart-Rendering der Karte „Meine Statistik" — in myStatsCard gespreadet
// (`...myStatsChartMethods`). Ausgelagert, damit my-stats-card.js unter dem
// 600-LOC-Cap bleibt. Zugriff auf Card-State via `this` (Spread teilt den
// Alpine-Scope): this.myStatsMetric, this.myStatsHistory, this.myStatsWindow(), …
//
// Chart.js-Instanz + Theme-Observer liegen bewusst als Modul-State AUSSERHALB
// von Alpine: der Reaktivitaets-Proxy beschaedigt die Chart-Instanz (analog
// bookstats.js). Sie sind darum an dieses Modul gebunden und werden nur ueber
// die hier exportierten Methoden angefasst.
import { loadChart } from '../lazy-libs.js';
import { tzOpts } from '../utils.js';
import { bucketizeIso, aggregateByBucket } from './my-stats-compute.js';

const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// Chart-Metriken: content aus book_stats_history (Summe pro Tag), writing aus
// writing_time. Label-Keys werden zur Render-Zeit via t() aufgeloest (Locale-live).
const METRIC_KEYS = {
  chars:         'mystats.metric.chars',
  normseiten:    'mystats.metric.normseiten',
  words:         'mystats.metric.words',
  unique_words:  'mystats.metric.uniqueWords',
  page_count:    'mystats.metric.pages',
  chapter_count: 'mystats.metric.chapters',
  writing:       'mystats.metric.writing',
  lektorat:      'mystats.metric.lektorat',
};

// Farbpalette fuer Pro-Buch-Linien — mittlere Saettigung, lesbar auf Light+Dark.
// Auch von der Kategorie-Kachel der Karte genutzt, darum exportiert.
export const BOOK_COLORS = [
  '#5b6ee1', '#e08a3c', '#3fae6e', '#c45fa0',
  '#c9a93a', '#46a7bd', '#d05a5a', '#8f7ae0',
  '#6aaf4e', '#b06ad0', '#d98f5e', '#4e8fd0',
];

let _chart = null;
let _themeObserver = null;

export const myStatsChartMethods = {
  // Vom destroy() der Karte gerufen: Modul-State freigeben, sonst ueberlebt der
  // Observer das Unmount und rendert in ein totes Canvas.
  _disconnectMyStatsThemeObserver() {
    if (_themeObserver) { _themeObserver.disconnect(); _themeObserver = null; }
  },

  _destroyChart() {
    if (_chart) { _chart.destroy(); _chart = null; }
  },

  _ensureThemeObserver() {
    if (_themeObserver) return;
    _themeObserver = new MutationObserver(() => {
      if (!_chart || !window.__app.showMyStatsCard) return;
      _chart.destroy();
      _chart = null;
      this.renderMyStatsChart();
    });
    _themeObserver.observe(document.documentElement, {
      attributes: true, attributeFilter: ['data-theme'],
    });
  },

  // Buchname aus der bereits geladenen Root-Buchliste (id → name).
  _bookName(bookId) {
    const b = (Alpine.store('nav').books || []).find(x => String(x.id) === String(bookId));
    return b?.name || (window.__app.t('mystats.unknownBook') + ' ' + bookId);
  },

  async renderMyStatsChart() {
    const canvas = document.getElementById('my-stats-chart');
    if (!canvas) return;
    if (typeof window.Chart === 'undefined') {
      try { await loadChart(); }
      catch (e) {
        const ph = document.createElement('div');
        ph.className = 'muted-msg muted-msg--block';
        ph.textContent = e.message;
        canvas.replaceWith(ph);
        return;
      }
    }
    // Immer frisch aufbauen (Update-Pfad liest keine neuen Canvas-Dimensionen).
    if (_chart) { _chart.destroy(); _chart = null; }

    const metric = this.myStatsMetric;
    // Zeit-Metriken (Schreib- bzw. Lektoratszeit) sind Tages-Deltas in Sekunden;
    // Inhalts-Metriken sind kumulative book_stats_history-Snapshots.
    const isTime = metric === 'writing' || metric === 'lektorat';
    const timeSrc = metric === 'lektorat' ? this.myStatsLektorat : this.myStatsWriting;
    const byBook = this.myStatsChartMode === 'byBook';

    // Quelle vereinheitlichen auf { book_id, date, raw }.
    const src = isTime ? timeSrc : this.myStatsHistory;
    let rows = src.map(r => ({ book_id: r.book_id, date: r.recorded_at || r.date, raw: r }));
    if (!rows.length) return;

    const win = this.myStatsWindow();
    if (win.from) rows = rows.filter(r => r.date >= win.from);
    if (win.to)   rows = rows.filter(r => r.date <= win.to);
    if (!rows.length) return;

    // Nur bis zum letzten vollständigen Sync zeigen: book_stats_history bekommt
    // pro Buch eine Tageszeile vom Nacht-Cron. Ein manueller Einzelbuch-Sync
    // mitten am Tag (oder ein noch ausstehender Nachtlauf) erzeugt sonst einen
    // Teil-Tages-Punkt mit weniger Büchern als der Vortag — als künstlicher
    // Einbruch sichtbar. Darum jüngste Tage abschneiden, solange ihre Buch-Zahl
    // unter der des Vortags liegt. Nur für Content-Historie — Zeit-Metriken sind
    // naturgemäss dünn (nur aktive Tage) und kennen kein „vollständiges" Tagesbild.
    if (!isTime) {
      const allDates = [...new Set(rows.map(r => r.date))].sort();
      const booksOn = new Map();
      for (const r of rows) {
        if (!booksOn.has(r.date)) booksOn.set(r.date, new Set());
        booksOn.get(r.date).add(r.book_id);
      }
      let last = allDates.length - 1;
      while (last > 0 && booksOn.get(allDates[last]).size < booksOn.get(allDates[last - 1]).size) last--;
      const lastDate = allDates[last];
      rows = rows.filter(r => r.date <= lastDate);
    }

    const valOf = (raw) => {
      if (metric === 'normseiten') return Math.round(((Number(raw.chars) || 0) / 1500) * 10) / 10;
      if (isTime)                 return Math.round((Number(raw.seconds) || 0) / 60);
      return Number(raw[metric]) || 0;
    };

    // Zeitachsen-Granularitaet: Tag/Woche/Monat. Schreibzeit-Tageswerte werden
    // im Bucket summiert ('sum'); Inhalts-Snapshots (kumulative Groessen) nehmen
    // den juengsten Tageswert je Bucket ('last').
    const gran = this.myStatsChartGran;
    const aggMode = isTime ? 'sum' : 'last';

    // X-Achse = sortierte eindeutige Buckets über alle Bücher.
    const buckets = [...new Set(rows.map(r => bucketizeIso(r.date, gran)))].sort();

    const localeTag = (Alpine.store('shell').uiLocale === 'en') ? 'en-US' : 'de-CH';
    const labels = buckets.map(b => {
      if (gran === 'month') return new Date(b + 'T12:00:00').toLocaleDateString(localeTag, tzOpts({ month: 'short', year: '2-digit' }));
      const [y, m, dd] = b.split('-');
      return `${dd}.${m}.${y.slice(2)}`;
    });

    const metricLabel = window.__app.t(METRIC_KEYS[metric] || metric);
    const isDecimal = metric === 'normseiten';
    const fmt = v => (v == null) ? '' : (isDecimal
      ? v.toLocaleString(localeTag, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
      : Math.round(v).toLocaleString(localeTag));

    const primary  = cssVar('--color-primary');
    const muted    = cssVar('--color-muted');
    const gridLine = cssVar('--color-border');

    let datasets;
    if (byBook) {
      // Eine Linie pro Buch (Reihenfolge nach erstem Auftreten = stabile Farbe).
      const order = [];
      const perBook = new Map(); // book_id → [{ date, value }]
      for (const r of rows) {
        if (!perBook.has(r.book_id)) { perBook.set(r.book_id, []); order.push(r.book_id); }
        perBook.get(r.book_id).push({ date: r.date, value: valOf(r.raw) });
      }
      datasets = order.map((bid, i) => {
        const color = BOOK_COLORS[i % BOOK_COLORS.length];
        const bmap = new Map(aggregateByBucket(perBook.get(bid), gran, aggMode).map(x => [x.bucket, x.value]));
        return {
          label: this._bookName(bid),
          data: buckets.map(b => bmap.has(b) ? bmap.get(b) : null),
          borderColor: color,
          backgroundColor: color,
          pointBackgroundColor: color,
          borderWidth: 2,
          tension: 0.3,
          pointRadius: 2,
          pointHoverRadius: 5,
          fill: false,
          spanGaps: true,
        };
      });
    } else {
      // Gesamt: erst Summe pro Tag über alle Bücher, dann auf Buckets verdichten.
      const totalByDate = new Map();
      for (const r of rows) totalByDate.set(r.date, (totalByDate.get(r.date) || 0) + valOf(r.raw));
      const points = [...totalByDate.entries()].map(([date, value]) => ({ date, value }));
      const bmap = new Map(aggregateByBucket(points, gran, aggMode).map(x => [x.bucket, x.value]));
      let series = buckets.map(b => bmap.has(b) ? bmap.get(b) : 0);
      // Kumuliert nur fuer Zeit-Metriken sinnvoll (Bucket-Deltas aufsummiert →
      // total investierte Zeit). Inhaltsmetriken sind bereits kumulative
      // Snapshot-Groessen, daher dort kein Cumulative-Toggle im UI.
      if (this.myStatsCumulative && isTime) {
        let acc = 0;
        series = series.map(v => (acc += v));
      }
      datasets = [{
        label: metricLabel,
        data: series,
        borderColor: primary,
        backgroundColor: primary + '12',
        pointBackgroundColor: primary,
        borderWidth: 2,
        tension: 0.35,
        pointRadius: 3,
        pointHoverRadius: 6,
        fill: true,
        spanGaps: false,
      }];
    }

    this._ensureThemeObserver();

    _chart = new window.Chart(canvas, {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            display: byBook,
            position: 'bottom',
            labels: { boxWidth: 12, boxHeight: 12, font: { size: 11 }, color: muted, usePointStyle: true },
          },
          tooltip: { callbacks: { label: ctx => ctx.parsed.y == null ? null : ` ${ctx.dataset.label}: ${fmt(ctx.parsed.y)}` } },
        },
        scales: {
          x: { grid: { color: gridLine }, ticks: { font: { size: 11 }, color: muted, maxTicksLimit: 12 } },
          y: {
            grid: { color: gridLine },
            beginAtZero: isTime || byBook,
            ticks: {
              font: { size: 11 }, color: muted,
              callback: v => fmt(v),
              stepSize: (metric === 'page_count' || metric === 'chapter_count') ? 1 : undefined,
            },
          },
        },
      },
    });
  },
};
