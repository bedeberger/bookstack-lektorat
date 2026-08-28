// Fehler-Heatmap: aggregiert Fehlertypen × Kapitel aus jüngstem page_check pro Seite.
// Daten kommen live aus /history/fehler-heatmap/:book_id — kein KI-Call, keine Sync-Phase.
// Methoden werden in Alpine.data('fehlerHeatmapCard') gespreadet; Root-Zugriffe via window.__app.

import { fetchJson, formatNumber, heatmapCellVars, minMaxBy, tzOpts } from '../utils.js';
import { loadChart } from '../lazy-libs.js';

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// Chart.js-Instanz + Theme-Observer als Modul-State (ausserhalb Alpines Proxy,
// der die Chart-Instanz sonst beschädigt) — analog bookstats.js.
let _trendChart = null;
let _trendThemeObserver = null;

function _ensureTrendThemeObserver(component) {
  if (_trendThemeObserver) return;
  _trendThemeObserver = new MutationObserver(() => {
    if (!_trendChart || !window.__app.showFehlerHeatmapCard) return;
    component.renderFehlerTrendChart();
  });
  _trendThemeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
}

export function _disconnectFehlerTrendThemeObserver() {
  if (_trendThemeObserver) { _trendThemeObserver.disconnect(); _trendThemeObserver = null; }
}

export function _destroyFehlerTrendChart() {
  if (_trendChart) { _trendChart.destroy(); _trendChart = null; }
}

// Cluster-Gruppierung der Typen-Spalten. Reihenfolge in den Cluster-Arrays = Spalten-Reihenfolge.
// Muss alle Typen aus ALLE_LEKTORAT_TYPEN (public/js/prompts/lektorat-typen.js) abdecken —
// die Heatmap zeigt alle Spalten, unabhängig vom Buchtyp des Buchs: bei einem Roman
// bleiben die Fach-Spalten leer, bei einer wissenschaftlichen Arbeit die Erzähl-Spalten.
// Vollständigkeit gegated durch tests/unit/lektorat-typen-drift.test.mjs.
const FEHLER_CLUSTERS = [
  { key: 'sprache',    typen: ['rechtschreibung', 'grammatik', 'dialogformat'] },
  { key: 'wort',       typen: ['wiederholung', 'schwaches_verb', 'fuellwort', 'filterwort'] },
  { key: 'stil',       typen: ['stil', 'satzbau', 'pleonasmus', 'klischee', 'ki_geruch', 'passiv'] },
  { key: 'erzaehlung', typen: ['show_vs_tell', 'perspektivbruch', 'tempuswechsel'] },
  { key: 'fach',       typen: ['unbelegt', 'begriffsinkonsistenz', 'autorenform', 'hedging'] },
  { key: 'journal',    typen: ['konjunktiv', 'zuschreibung', 'wertung', 'amtsdeutsch'] },
  { key: 'welt',       typen: ['namenskonsistenz', 'figurenmerkmal', 'schauplatzmerkmal', 'anrede'] },
];
const FEHLER_TYPEN = FEHLER_CLUSTERS.flatMap(c => c.typen);

// Spalten-Indizes der jeweils ersten Spalte eines Clusters (fuer Trennlinien).
// Das erste Cluster startet bei 0 und faellt raus — links aussen keine Linie.
// Modul-Konstante, kein Getter: das Template fragt sie einmal PRO ZELLE ab
// (26 Typen x N Kapiteln), und ein Getter haette dabei jedes Mal zwei Arrays
// gebaut. Set statt Array, weil der Zugriff ein Enthaltensein-Test ist.
const FEHLER_CLUSTER_STARTS = new Set(FEHLER_CLUSTERS.reduce((acc, c) => {
  acc.push(acc.at(-1) + c.typen.length);
  return acc;
}, [0]).slice(0, -1).slice(1));

const MODES = ['open', 'applied', 'all'];

export const fehlerHeatmapMethods = {
  get fehlerHeatmapTypen() { return FEHLER_TYPEN; },
  get fehlerHeatmapClusters() { return FEHLER_CLUSTERS; },
  // Beginnt an dieser Spalte ein neues Cluster? (→ Trennlinie)
  fehlerHeatmapIsClusterStart(idx) { return FEHLER_CLUSTER_STARTS.has(idx); },

  // Ein Memo-Helper pro Modul (CLAUDE.md): Cache mit shallow-Array-Deps-
  // Vergleich (`===`). Reset ueber this._memos = {} im Lade-Pfad.
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

  async loadFehlerHeatmap() {
    if (!Alpine.store('nav').selectedBookId) return;
    this.fehlerHeatmapLoading = true;
    this.fehlerHeatmapStatus = '';
    this._memos = {};
    try {
      const mode = MODES.includes(this.fehlerHeatmapMode) ? this.fehlerHeatmapMode : 'open';
      const data = await fetchJson(`/history/fehler-heatmap/${Alpine.store('nav').selectedBookId}?mode=${mode}`);
      this.fehlerHeatmapData = data;
    } catch (e) {
      console.error('[loadFehlerHeatmap]', e);
      this.fehlerHeatmapStatus = window.__app.t('common.errorColon') + (e.message || '');
    } finally {
      this.fehlerHeatmapLoading = false;
    }
  },

  async setFehlerHeatmapMode(mode) {
    if (!MODES.includes(mode)) return;
    if (this.fehlerHeatmapMode === mode) return;
    this.fehlerHeatmapMode = mode;
    this.activeFehlerDetailKey = null;
    await this.loadFehlerHeatmap();
    // Trend-Daten tragen alle drei Modi — kein Refetch, nur neu zeichnen.
    this.renderFehlerTrendChart();
  },

  // ── Fehlerdichte-Trend über die Fassungen ─────────────────────────────────
  async loadFehlerTrend() {
    if (!Alpine.store('nav').selectedBookId) return;
    try {
      const data = await fetchJson(`/history/fehler-trend/${Alpine.store('nav').selectedBookId}`);
      this.fehlerTrendData = data?.versions || [];
    } catch (e) {
      console.error('[loadFehlerTrend]', e);
      this.fehlerTrendData = [];
    }
    this.$nextTick(() => requestAnimationFrame(() => this.renderFehlerTrendChart()));
  },

  // Fassungen mit Lektorat-Kennzahl + gültigem Wörter-Nenner — nur diese tragen
  // einen Dichte-Punkt. Reihenfolge aus dem Backend (seq aufsteigend).
  _fehlerTrendPoints() {
    return (this.fehlerTrendData || []).filter(v => v.metrics && v.words > 0);
  },

  // Genug Datenpunkte für einen sichtbaren Verlauf? Sonst Hinweis statt Chart.
  fehlerTrendHasData() {
    return this._fehlerTrendPoints().length >= 2;
  },

  // Fehler pro 1000 Wörter für eine Fassung im aktuellen Modus.
  _fehlerTrendPer1k(v) {
    const total = v.metrics?.[this.fehlerHeatmapMode]?.total;
    if (total == null || !(v.words > 0)) return null;
    return Math.round((total / v.words) * 1000 * 10) / 10;
  },

  async renderFehlerTrendChart() {
    const canvas = document.getElementById('fehler-trend-chart');
    if (!canvas) return;
    if (!this.fehlerTrendHasData()) { _destroyFehlerTrendChart(); return; }

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

    // Immer frisch aufbauen (Update-Pfad liest keine neuen Canvas-Dimensionen
    // nach einem display:none↔block-Wechsel — bliebe sonst leer).
    _destroyFehlerTrendChart();

    const points = this._fehlerTrendPoints();
    const localeTag = (Alpine.store('shell').uiLocale === 'en') ? 'en-US' : 'de-CH';
    const labels = points.map(v => v.label || window.__app.t('fehlerHeatmap.trend.versionLabel', { n: v.seq }));
    const data = points.map(v => this._fehlerTrendPer1k(v));

    const accent = cssVar('--color-primary');
    const muted = cssVar('--color-muted');
    const gridLine = cssVar('--color-border');

    _ensureTrendThemeObserver(this);

    _trendChart = new window.Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: window.__app.t('fehlerHeatmap.trend.yLabel'),
          data,
          borderColor: accent,
          backgroundColor: accent + '12',
          borderWidth: 2,
          tension: 0.35,
          pointRadius: 4,
          pointHoverRadius: 6,
          pointBackgroundColor: accent,
          fill: true,
          spanGaps: true,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => {
                const v = points[items[0]?.dataIndex];
                if (!v) return '';
                const when = v.created_at ? new Date(v.created_at).toLocaleDateString(localeTag, tzOpts({ day: '2-digit', month: '2-digit', year: '2-digit' })) : '';
                return when ? `${items[0].label} · ${when}` : items[0].label;
              },
              label: (ctx) => {
                const y = ctx.parsed.y;
                if (y == null) return '';
                return ` ${formatNumber(y, Alpine.store('shell').uiLocale, 1)} ${window.__app.t('fehlerHeatmap.trend.per1kUnit')}`;
              },
            },
          },
        },
        scales: {
          x: { grid: { color: gridLine }, ticks: { font: { size: 11 }, color: muted } },
          y: {
            grid: { color: gridLine },
            beginAtZero: true,
            ticks: {
              font: { size: 11 },
              color: muted,
              callback: (v) => formatNumber(v, Alpine.store('shell').uiLocale, 1),
            },
          },
        },
      },
    });
  },

  fehlerHeatmapChapterKey(ch) {
    return ch.chapter_id == null ? '__uncat__' : String(ch.chapter_id);
  },

  fehlerHeatmapChapterName(ch) {
    return ch.chapter_name || window.__app.t('fehlerHeatmap.unassigned');
  },

  fehlerHeatmapCoveragePct(ch) {
    if (!ch.pages_total) return 0;
    return Math.round((ch.pages_checked / ch.pages_total) * 100);
  },

  fehlerHeatmapCellValue(chapterKey, typ) {
    const cell = this.fehlerHeatmapData?.matrix?.[chapterKey]?.[typ];
    return cell ? cell.count : null;
  },

  fehlerHeatmapCellCount(chapterKey, typ) {
    const cell = this.fehlerHeatmapData?.matrix?.[chapterKey]?.[typ];
    return cell ? cell.count : 0;
  },

  // Skala pro Typ über alle Kapitel. Rot = hoch, Grün = niedrig.
  // Memoisiert pro Typ: das Template ruft die Skala ZWEIMAL pro Zelle ab
  // (Zell-Variante + CSS-Variablen), und jeder Aufruf laeuft ueber alle
  // Kapitel — ungecacht ist ein Render O(Typen x Kapitel²), und schon das
  // Auf-/Zuklappen des Detail-Panels loest ihn komplett neu aus (das :class
  // jeder Zelle liest activeFehlerDetailKey). Deps = die Datenreferenz; ein
  // neuer Ladevorgang tauscht sie und verwirft damit alle Typ-Slots.
  fehlerHeatmapRange(typ) {
    const data = this.fehlerHeatmapData;
    return this._memo(`range:${typ}`, [data], () => minMaxBy(data?.chapters || [], (ch) => {
      const key = this.fehlerHeatmapChapterKey(ch);
      return data?.matrix?.[key]?.[typ]?.count;
    }));
  },

  // Welche Zell-Variante (→ CSS-Klasse) und welche CSS-Variablen. Split,
  // damit Alpine das :class separat vom :style binden kann und keine
  // Inline-Style-Strings ins DOM landen.
  fehlerHeatmapCellKind(chapterKey, typ, coveragePct) {
    const value = this.fehlerHeatmapCellValue(chapterKey, typ);
    if (value == null) return coveragePct === 0 ? 'empty' : 'neutral';
    const { min, max } = this.fehlerHeatmapRange(typ);
    if (max === min) return coveragePct < 100 ? 'faded' : 'neutral';
    return 'tinted';
  },

  fehlerHeatmapCellVars(chapterKey, typ, coveragePct) {
    const value = this.fehlerHeatmapCellValue(chapterKey, typ);
    if (value == null) return {};
    const opacity = coveragePct < 100 ? (0.5 + (coveragePct / 200)) : 1;
    const { min, max } = this.fehlerHeatmapRange(typ);
    if (max === min) return coveragePct < 100 ? { '--heatmap-opacity': String(opacity) } : {};
    const t = (value - min) / (max - min);
    return heatmapCellVars(t, opacity);
  },

  fehlerHeatmapCellTooltip(chapterKey, typ) {
    const cell = this.fehlerHeatmapData?.matrix?.[chapterKey]?.[typ];
    if (!cell || !cell.count) return '';
    return window.__app.t('fehlerHeatmap.cellTooltip', {
      count: cell.count,
      pages: cell.pages,
      per1k: formatNumber(cell.per1k, Alpine.store('shell').uiLocale, 1),
    });
  },

  fehlerHeatmapCellLabel(chapterKey, typ) {
    const cell = this.fehlerHeatmapData?.matrix?.[chapterKey]?.[typ];
    if (!cell || !cell.count) return '–';
    return formatNumber(cell.count, Alpine.store('shell').uiLocale, 0);
  },

  // Eine Zelle ohne Befunde hat kein Detail-Panel — sie darf weder
  // Klick-Cursor noch Tastatur-Fokus anbieten. SSoT fuer die :class-Bindung
  // und den Handler darunter, damit die Optik nicht mehr verspricht als der
  // Klick einloest.
  fehlerHeatmapCellClickable(chapterKey, typ) {
    return this.fehlerHeatmapCellCount(chapterKey, typ) > 0;
  },

  toggleFehlerHeatmapDetail(chapterKey, typ) {
    const key = `${chapterKey}:${typ}`;
    if (!this.fehlerHeatmapCellClickable(chapterKey, typ)) return;
    this.activeFehlerDetailKey = (this.activeFehlerDetailKey === key) ? null : key;
  },

  fehlerHeatmapActiveDetail() {
    const key = this.activeFehlerDetailKey;
    if (!key) return null;
    const [chapterKey, typ] = key.split(':');
    const pages = this.fehlerHeatmapData?.details?.[key] || [];
    const chapter = (this.fehlerHeatmapData?.chapters || []).find(c => this.fehlerHeatmapChapterKey(c) === chapterKey);
    return {
      key,
      chapterKey,
      typ,
      chapterName: chapter ? this.fehlerHeatmapChapterName(chapter) : '',
      pages,
    };
  },

  fehlerHeatmapTotal(typ) {
    return this.fehlerHeatmapData?.totals?.[typ] || 0;
  },

  async fehlerHeatmapJumpToPage(pageId) {
    const page = (Alpine.store('nav').pages || []).find(p => p.id === pageId);
    if (!page) return;
    window.__app.showFehlerHeatmapCard = false;
    this.activeFehlerDetailKey = null;
    await window.__app.selectPage(page);
    // Jüngsten Lektorat-Eintrag öffnen, damit die Findings direkt sichtbar sind.
    // Wenn gerade ein Check-Job läuft, ist pageHistory evtl. leer – dann nichts tun.
    const latest = (window.__app.pageHistory || [])[0];
    if (latest && window.__app.activeHistoryEntryId !== latest.id) {
      await window.__app.loadHistoryEntry(latest);
    }
  },

  async fehlerHeatmapJumpToChapter(ch) {
    if (!ch || ch.chapter_id == null) return;
    const root = window.__app;
    const chapterId = ch.chapter_id;
    const opts = root.kapitelReviewChapterOptions ? root.kapitelReviewChapterOptions() : [];
    this.activeFehlerDetailKey = null;
    if (opts.some(c => String(c.id) === String(chapterId))) {
      root.showFehlerHeatmapCard = false;
      await root.openKapitelReviewForChapter(chapterId);
      return;
    }
    const chapterNode = (Alpine.store('nav').tree || []).find(i => i.type === 'chapter' && String(i.id) === String(chapterId));
    const firstPage = chapterNode?.pages?.[0];
    if (firstPage) {
      root.showFehlerHeatmapCard = false;
      await root.selectPage(firstPage);
    }
  },
};
