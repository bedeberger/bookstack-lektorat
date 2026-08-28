// Satzrhythmus-Band + Satzanfänge — zweiter Abschnitt der Stil-Karte.
//
// Reine Anzeige: gerechnet wird in lib/stil-rhythmus.js (Server), zusammengesetzt
// in lib/stil-heatmap.js. Die Antwort von /history/style-stats bringt `rhythm`
// (Polygon-Punkte + Kennzahlen pro Kapitel) und `openers` (buchweite Rangliste)
// fertig mit.
//
// Warum serverseitig: die Grundlage ist `page_stats.sentence_lens` — die
// Satzlängen-Sequenz in Leserichtung, bis zu 2000 Zahlen PRO SEITE. Bei einem
// Buch mit tausenden Seiten ist die Sequenz um Grössenordnungen grösser als das
// 120-Punkte-Band, das daraus wird; sie durch den Browser zu schleusen war der
// teuerste Teil dieser Karte.
//
// Warum das Band überhaupt neben der Heatmap steht: dort steht pro Kapitel EIN
// Wert je Metrik. „Durchschnittliche Satzlänge 14" entsteht aber sowohl aus
// lauter 14ern als auch aus dem Wechsel 3/25/3/25 — der Unterschied ist der
// Rhythmus, und er ist aus dem Mittelwert nicht rekonstruierbar.
//
// Methoden werden in Alpine.data('stilCard') gespreadet; Root-Zugriffe via
// window.__app.

import { formatNumber } from '../utils.js';

const EMPTY_RHYTHM = { rows: [], scaleMax: 0, cols: 120, height: 32, viewBox: '0 0 120 32' };
const EMPTY_OPENERS = { top: [], total: 0, repeats: 0, repeatRatio: null, distinct: 0 };

export const stilRhythmusMethods = {
  stilRhythmData() {
    return this.stilData?.rhythm || EMPTY_RHYTHM;
  },

  stilOpenerData() {
    return this.stilData?.openers || EMPTY_OPENERS;
  },

  // Das Band braucht die Sequenz-Felder aus page_stats. Bis der Sync durch ist
  // (oder bei Büchern, deren Seiten noch auf einer älteren metrics_version
  // stehen), gibt es nichts zu zeichnen — dann zeigt die Karte den Sync-Hinweis
  // statt eines leeren Rahmens.
  stilHasRhythm() {
    return this.stilRhythmData().rows.length > 0;
  },

  stilNum(value, decimals = 1) {
    if (value == null) return '–';
    return formatNumber(value, Alpine.store('shell').uiLocale, decimals);
  },

  stilPercent(ratio, decimals = 1) {
    if (ratio == null) return '–';
    return formatNumber(ratio * 100, Alpine.store('shell').uiLocale, decimals) + ' %';
  },

  // Einordnung des Wechsel-Werts in drei Stufen. Die Schwellen sind Erfahrungs-
  // werte aus deutscher Erzählprosa: unter 0,45 liest sich ein Abschnitt
  // gleichförmig, über 0,85 sprunghaft. Reine Anzeige-Hilfe — es gibt kein
  // „richtig", ein Sachtext DARF monoton sein.
  stilSwingKind(swing) {
    if (swing == null) return 'neutral';
    if (swing < 0.45) return 'low';
    if (swing > 0.85) return 'high';
    return 'mid';
  },

  stilSwingLabel(swing) {
    const kind = this.stilSwingKind(swing);
    if (kind === 'neutral') return '';
    return window.__app.t('stil.rhythm.swing.' + kind);
  },
};
