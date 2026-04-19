// Fehler-Heatmap: aggregiert Fehlertypen × Kapitel aus jüngstem page_check pro Seite.
// Daten kommen live aus /history/fehler-heatmap/:book_id — kein KI-Call, keine Sync-Phase.
// `this` zeigt auf die Alpine-Komponente.

import { fetchJson, formatNumber, heatmapCellBg, minMaxBy } from './utils.js';

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

  async toggleFehlerHeatmapCard() {
    if (this.showFehlerHeatmapCard) { this.showFehlerHeatmapCard = false; return; }
    this._closeOtherMainCards('fehlerHeatmap');
    this.showFehlerHeatmapCard = true;
    await this.loadFehlerHeatmap();
  },

  async loadFehlerHeatmap() {
    if (!this.selectedBookId) return;
    this.fehlerHeatmapLoading = true;
    this.fehlerHeatmapStatus = '';
    try {
      const mode = MODES.includes(this.fehlerHeatmapMode) ? this.fehlerHeatmapMode : 'all';
      const data = await fetchJson(`/history/fehler-heatmap/${this.selectedBookId}?mode=${mode}`);
      this.fehlerHeatmapData = data;
    } catch (e) {
      console.error('[loadFehlerHeatmap]', e);
      this.fehlerHeatmapStatus = this.t('common.errorColon') + (e.message || '');
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
    return ch.chapter_name || this.t('fehlerHeatmap.unassigned');
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

  fehlerHeatmapCellStyle(chapterKey, typ, coveragePct) {
    const value = this.fehlerHeatmapCellValue(chapterKey, typ);
    // Ungeprüfte / teilgeprüfte Zelle: Opazität reduzieren.
    if (value == null) {
      if (coveragePct === 0) {
        return 'background: repeating-linear-gradient(45deg, var(--color-border) 0, var(--color-border) 2px, transparent 2px, transparent 6px); opacity: 0.6;';
      }
      return '';
    }
    const { min, max } = this.fehlerHeatmapRange(typ);
    const opacity = coveragePct < 100 ? (0.5 + (coveragePct / 200)) : 1;
    if (max === min) return coveragePct < 100 ? `opacity: ${opacity};` : '';
    const t = (value - min) / (max - min);
    return `${heatmapCellBg(t)} opacity: ${opacity};`;
  },

  fehlerHeatmapCellTooltip(chapterKey, typ) {
    const cell = this.fehlerHeatmapData?.matrix?.[chapterKey]?.[typ];
    if (!cell || !cell.count) return '';
    return this.t('fehlerHeatmap.cellTooltip', {
      count: cell.count,
      pages: cell.pages,
      per1k: formatNumber(cell.per1k, this.uiLocale, 1),
    });
  },

  fehlerHeatmapCellLabel(chapterKey, typ) {
    const cell = this.fehlerHeatmapData?.matrix?.[chapterKey]?.[typ];
    if (!cell || !cell.count) return '–';
    return formatNumber(cell.per1k, this.uiLocale, 1);
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
    const page = (this.pages || []).find(p => p.id === pageId);
    if (!page) return;
    this.showFehlerHeatmapCard = false;
    this.activeFehlerDetailKey = null;
    await this.selectPage(page);
    // Jüngsten Lektorat-Eintrag öffnen, damit die Findings direkt sichtbar sind.
    // Wenn gerade ein Check-Job läuft, ist pageHistory evtl. leer – dann nichts tun.
    const latest = (this.pageHistory || [])[0];
    if (latest && this.activeHistoryEntryId !== latest.id) {
      await this.loadHistoryEntry(latest);
    }
  },
};
