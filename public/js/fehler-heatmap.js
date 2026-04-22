// Fehler-Heatmap: aggregiert Fehlertypen × Kapitel aus jüngstem page_check pro Seite.
// Daten kommen live aus /history/fehler-heatmap/:book_id — kein KI-Call, keine Sync-Phase.
// Methoden werden in Alpine.data('fehlerHeatmapCard') gespreadet; Root-Zugriffe via window.__app.

import { fetchJson, formatNumber, heatmapCellVars, minMaxBy } from './utils.js';

// Reihenfolge der Typen-Spalten. Muss mit VALID_TYPEN in routes/jobs/lektorat.js kompatibel sein.
const FEHLER_TYPEN = [
  'rechtschreibung',
  'grammatik',
  'stil',
  'wiederholung',
  'schwaches_verb',
  'fuellwort',
  'show_vs_tell',
  'passiv',
  'perspektivbruch',
  'tempuswechsel',
];

const MODES = ['open', 'applied', 'all'];

export const fehlerHeatmapMethods = {
  get fehlerHeatmapTypen() { return FEHLER_TYPEN; },

  async loadFehlerHeatmap() {
    if (!window.__app.selectedBookId) return;
    this.fehlerHeatmapLoading = true;
    this.fehlerHeatmapStatus = '';
    try {
      const mode = MODES.includes(this.fehlerHeatmapMode) ? this.fehlerHeatmapMode : 'all';
      const data = await fetchJson(`/history/fehler-heatmap/${window.__app.selectedBookId}?mode=${mode}`);
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
    return cell ? cell.per1k : null;
  },

  fehlerHeatmapCellCount(chapterKey, typ) {
    const cell = this.fehlerHeatmapData?.matrix?.[chapterKey]?.[typ];
    return cell ? cell.count : 0;
  },

  // Skala pro Typ über alle Kapitel. Rot = hoch, Grün = niedrig.
  fehlerHeatmapRange(typ) {
    const chapters = this.fehlerHeatmapData?.chapters || [];
    return minMaxBy(chapters, (ch) => {
      const key = this.fehlerHeatmapChapterKey(ch);
      return this.fehlerHeatmapData?.matrix?.[key]?.[typ]?.per1k;
    });
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
      per1k: formatNumber(cell.per1k, window.__app.uiLocale, 1),
    });
  },

  fehlerHeatmapCellLabel(chapterKey, typ) {
    const cell = this.fehlerHeatmapData?.matrix?.[chapterKey]?.[typ];
    if (!cell || !cell.count) return '–';
    return formatNumber(cell.per1k, window.__app.uiLocale, 1);
  },

  toggleFehlerHeatmapDetail(chapterKey, typ) {
    const key = `${chapterKey}:${typ}`;
    const cell = this.fehlerHeatmapData?.matrix?.[chapterKey]?.[typ];
    if (!cell || !cell.count) return;
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
    const page = (window.__app.pages || []).find(p => p.id === pageId);
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
};
