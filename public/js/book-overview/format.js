// Format-Helper + Tile-Click-Handler (Cross-Card-Routings).
//
// Alle Locale-abhängigen Formatierungen der Buch-Übersicht laufen über
// `_uiLocale()` und die gecachten Intl-Fabriken aus utils — nicht über
// `toLocaleString`. Grund: Tiles wie die Streak-Heatmap formatieren pro Render
// dreistellig viele Werte, und `Number#toLocaleString` baut bei jedem Aufruf
// intern einen neuen Formatter.
import { EVT } from '../events.js';
import { charsToNormseiten, numberFormat, dateTimeFormat } from '../utils.js';

export const formatMethods = {
  // Aktuelle UI-Sprache ('de' | 'en'). Eine Stelle, damit die
  // Store-Zugriffs-Kette nicht durch alle Overview-Module wandert.
  _uiLocale() {
    return Alpine.store('shell').uiLocale;
  },

  // Gecachter Zahlen-Formatter für die aktuelle UI-Sprache.
  _numFmt(opts) {
    return numberFormat(this._uiLocale(), opts);
  },

  // Gecachter Datums-Formatter für die aktuelle UI-Sprache (timeZone via tzOpts).
  _dateFmt(opts) {
    return dateTimeFormat(this._uiLocale(), opts);
  },

  // Zeichen → lokalisierte Normseiten-Zahl (1 Dezimale). Kapselt die
  // CHARS_PER_NORMSEITE-Umrechnung, damit die Formel nicht in jedem Tile
  // inline dupliziert wird.
  _fmtNormseiten(chars) {
    return this._numFmt({ minimumFractionDigits: 1, maximumFractionDigits: 1 })
      .format(charsToNormseiten(chars));
  },

  // Fehler-Typ-Label: i18n-Key versuchen; Fallback humanisiert.
  overviewFehlerLabel(typ) {
    const key = 'fehlerHeatmap.typ.' + typ;
    const app = window.__app;
    const translated = app?.t ? app.t(key) : null;
    if (translated && translated !== key) return translated;
    const s = String(typ || '').replace(/_/g, ' ').replace(/\bvs\b/, 'vs.');
    return s.charAt(0).toUpperCase() + s.slice(1);
  },

  // Initialen für Avatar-Chip: erste Buchstaben aus Vor-/Nachname.
  overviewInitials(name) {
    if (!name) return '?';
    const parts = String(name).trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  },

  _fmtNum(n) {
    return this._numFmt().format(Number(n) || 0);
  },

  // ── Tile-Click-Handler ───────────────────────────────────────────────────
  _openLengthStats(range = 30, metric = 'chars') {
    window.dispatchEvent(new CustomEvent(EVT.BOOK_STATS_SELECT, { detail: { metric, range } }));
    window.__app?.toggleBookStatsCard?.();
  },

  _openKapitelReview(chapterId) {
    const app = window.__app;
    if (!app) return;
    app.kapitelReviewChapterId = String(chapterId);
    if (!app.showKapitelReviewCard) app.toggleKapitelReviewCard();
  },
};
