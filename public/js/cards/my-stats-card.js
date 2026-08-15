// Alpine.data('myStatsCard') — Sub-Komponente „Meine Statistik": aggregierte
// Schreib-Kennzahlen + Entwicklungs-Chart ueber ALLE eigenen Buecher
// (role='owner'). User-bound, nicht buch-bound — `showMyStatsCard` +
// `toggleMyStatsCard` leben im Root (generiert aus EXCLUSIVE_CARDS). Daten:
// `GET /me/profile-stats` (Tiles) + `GET /me/profile-stats-history` (Chart).

import { tzOpts, localIsoDate, localIsoDaysAgo } from '../utils.js';
import { EVT } from '../events.js';
import { computeWritingStreak, computeWeekdayPattern, computeDerived, computeMilestones,
         computeReadability, computeWeeklyDelta, computePerBookTime, computeEffortSplit,
         computeVolumeDelta, computeHourPattern, computeGoalAttainment, computeBookGoals,
         filterByWindow } from './my-stats-compute.js';
import { computeVolumeByCategory } from './my-stats-category.js';
import { myStatsTrendMethods } from './my-stats-trends-methods.js';
import { myStatsChartMethods, BOOK_COLORS } from './my-stats-chart-methods.js';

// Meilenstein-Label-Keys pro Kategorie (Wert via {n} interpoliert).
const MILESTONE_LABELS = {
  chars:      'mystats.milestone.chars',
  words:      'mystats.milestone.words',
  activeDays: 'mystats.milestone.activeDays',
  books:      'mystats.milestone.books',
};

export function registerMyStatsCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('myStatsCard', () => ({
    ...myStatsTrendMethods,
    ...myStatsChartMethods,
    myStatsData: null,
    myStatsHistory: [],
    myStatsWriting: [],
    myStatsLektorat: [],
    myStatsSessions: [],
    myStatsMetric: 'chars',
    myStatsStreakMode: 'activity', // 'activity' | 'goal' — Streak-Heatmap-Faerbung
    // Globaler Zeitraum-Filter (steuert die ganze Karte). Preset-Tage
    // (30/90/365, 0 = alles) ODER freie Von/Bis-ISO-Daten — Custom hat Vorrang.
    myStatsRangeDays: 0,
    myStatsFrom: '',
    myStatsTo: '',
    myStatsChartMode: 'total', // 'total' | 'byBook'
    myStatsChartGran: 'day',   // 'day' | 'week' | 'month' — Zeitachsen-Granularitaet
    myStatsCumulative: false,  // nur fuer Metrik 'writing' (kumulierte Schreibzeit)
    myStatsLoading: false,
    myStatsError: '',
    _myStatsMemos: {},

    init() {
      this.$watch(() => window.__app.showMyStatsCard, (visible) => {
        if (visible) this.loadMyStats();
        else this._destroyChart();
      });
      this._onRefresh = (ev) => {
        if (ev?.detail?.name === 'myStats') this.loadMyStats();
      };
      window.addEventListener(EVT.CARD_REFRESH, this._onRefresh);
    },

    destroy() {
      if (this._onRefresh) window.removeEventListener(EVT.CARD_REFRESH, this._onRefresh);
      this._destroyChart();
      this._disconnectMyStatsThemeObserver();
    },

    async loadMyStats() {
      this.myStatsLoading = true;
      this.myStatsError = '';
      this._myStatsMemos = {};
      try {
        const [statsR, histR] = await Promise.all([
          fetch('/me/profile-stats', { credentials: 'same-origin' }),
          fetch('/me/profile-stats-history', { credentials: 'same-origin' }),
        ]);
        if (!statsR.ok) throw new Error('HTTP ' + statsR.status);
        this.myStatsData = await statsR.json();
        const hist = histR.ok ? await histR.json() : { history: [], writing: [], lektorat: [] };
        this.myStatsHistory = Array.isArray(hist.history) ? hist.history : [];
        this.myStatsWriting = Array.isArray(hist.writing) ? hist.writing : [];
        this.myStatsLektorat = Array.isArray(hist.lektorat) ? hist.lektorat : [];
        this.myStatsSessions = Array.isArray(hist.sessions) ? hist.sessions : [];
      } catch (e) {
        console.error('[myStats load]', e);
        this.myStatsError = window.__app.t('mystats.loadError');
        this.myStatsData = null;
        this.myStatsHistory = [];
        this.myStatsWriting = [];
        this.myStatsLektorat = [];
        this.myStatsSessions = [];
      } finally {
        this.myStatsLoading = false;
      }
      // rAF in $nextTick: Canvas erst nach Layout-Pass vermessen (sonst 0×0).
      this.$nextTick(() => requestAnimationFrame(() => this.renderMyStatsChart()));
    },

    get myStatsHasChart() {
      return this.myStatsHistory.length > 0 || this.myStatsWriting.length > 0;
    },

    // Ein Memo-Helper pro Modul (CLAUDE.md): Aggregat-Getter werden im Template
    // mehrfach pro Render aufgerufen → Cache mit shallow-Array-Deps. Reset bei
    // jedem Daten-Reload via this._myStatsMemos = {} in loadMyStats().
    _memo(key, deps, fn) {
      const prev = this._myStatsMemos[key];
      if (prev && prev.deps.length === deps.length && prev.deps.every((d, i) => d === deps[i])) {
        return prev.val;
      }
      const val = fn();
      this._myStatsMemos[key] = { deps, val };
      return val;
    },

    // ── Zeitraum-Filter (steuert die ganze Karte) ──────────────────────────
    // Aktives Fenster { active, from, to } (ISO, inklusive; null = unbegrenzt).
    // Custom Von/Bis hat Vorrang vor dem Tages-Preset; kein Filter aktiv = alles.
    myStatsWindow() {
      if (this.myStatsFrom || this.myStatsTo) {
        return { active: true, from: this.myStatsFrom || null, to: this.myStatsTo || null };
      }
      if (this.myStatsRangeDays > 0) {
        return { active: true, from: localIsoDaysAgo(this.myStatsRangeDays), to: localIsoDate() };
      }
      return { active: false, from: null, to: null };
    },
    get myStatsWindowActive() { return this.myStatsWindow().active; },

    // Auf das Fenster gefilterte Zeitreihen (memoized; deps inkl. from/to).
    _winWriting() {
      const w = this.myStatsWindow();
      return this._memo('winWriting', [this.myStatsWriting, w.from, w.to], () =>
        filterByWindow(this.myStatsWriting, 'date', w.from, w.to));
    },
    _winLektorat() {
      const w = this.myStatsWindow();
      return this._memo('winLektorat', [this.myStatsLektorat, w.from, w.to], () =>
        filterByWindow(this.myStatsLektorat, 'date', w.from, w.to));
    },
    _sumSeconds(rows) {
      return (rows || []).reduce((s, r) => s + (Number(r.seconds) || 0), 0);
    },

    // Preset waehlen → Custom-Felder leeren. Custom setzen → Preset auf 0.
    myStatsSetPreset(days) {
      this.myStatsRangeDays = days;
      this.myStatsFrom = '';
      this.myStatsTo = '';
      this._onRangeChange();
    },
    _onRangeChange() {
      // Memos haengen an from/to → aktualisieren sich selbst; nur Chart neu zeichnen.
      this.$nextTick(() => requestAnimationFrame(() => this.renderMyStatsChart()));
    },

    // Im Zeitraum produzierter Umfang (Zeichen/Woerter/Seiten). Ohne Filter:
    // Live-Gesamtstand aus page_stats; mit Filter: Snapshot-Delta aus der Historie.
    myStatsVolume() {
      const w = this.myStatsWindow();
      if (!w.active) {
        const d = this.myStatsData || {};
        return { chars: d.chars || 0, words: d.words || 0, pages: d.pages || 0 };
      }
      return this._memo('volume', [this.myStatsHistory, w.from, w.to], () =>
        computeVolumeDelta(this.myStatsHistory, w.from, w.to));
    },

    // ── Schreibrhythmus (aus der gefilterten writing-Zeitreihe) ────────────
    myStatsStreak() {
      const win = this._winWriting();
      return this._memo('streak', [win], () => computeWritingStreak(win));
    },
    myStatsWeekdays() {
      const win = this._winWriting();
      return this._memo('weekdays', [win], () => computeWeekdayPattern(win));
    },
    myStatsDerived() {
      const win = this._winWriting();
      // Tempo = Zeichen pro Schreibstunde IM Zeitraum: Volumen-Delta / gefilterte Sekunden.
      const data = this.myStatsWindowActive
        ? { chars: this.myStatsVolume().chars, writing_seconds: this._sumSeconds(win) }
        : this.myStatsData;
      return this._memo('derived', [data?.chars, data?.writing_seconds, win], () =>
        computeDerived(data, win));
    },
    // Meilensteine sind Lifetime-Achievements → immer ueber ALLE Daten, nie gefiltert.
    myStatsMilestones() {
      return this._memo('milestones', [this.myStatsData, this.myStatsWriting], () =>
        computeMilestones(this.myStatsData, computeDerived(this.myStatsData, this.myStatsWriting)));
    },

    get myStatsHasRhythm() {
      return (this.myStatsWriting || []).length > 0;
    },

    // Wochentags-Kurzlabels Mo..So (Locale-aware, TZ-bereinigt).
    myStatsWeekdayLabels() {
      const tag = Alpine.store('shell').uiLocale === 'en' ? 'en-US' : 'de-CH';
      const fmt = new Intl.DateTimeFormat(tag, tzOpts({ weekday: 'short' }));
      const monRef = new Date(2027, 0, 4); // 2027-01-04 ist ein Montag
      return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(monRef.getTime() + i * 86400000)));
    },

    // Datum eines Streak-/Bestleistungs-Tages lesbar formatieren.
    myStatsDateLabel(iso) {
      if (!iso) return '';
      const tag = Alpine.store('shell').uiLocale === 'en' ? 'en-US' : 'de-CH';
      return new Date(iso + 'T12:00:00').toLocaleDateString(tag, tzOpts({ day: 'numeric', month: 'short', year: 'numeric' }));
    },

    // Minuten kompakt: „2 h 10 min" / „45 min".
    myStatsMinFmt(min) {
      const total = Math.max(0, Math.round(Number(min) || 0));
      const h = Math.floor(total / 60), m = total % 60;
      const t = window.__app.t;
      return h > 0 ? t('mystats.hm', { h: this._myStatsFmt(h), m }) : t('mystats.m', { m });
    },

    myStatsMilestoneLabel(category, target) {
      return window.__app.t(MILESTONE_LABELS[category] || 'mystats.milestone.chars', { n: this._myStatsFmt(target) });
    },

    // ── Lesbarkeit (1), Aufwand (2), Pro-Buch-Zeit (3), Wochen-Delta (4) ────
    myStatsReadability() {
      return this._memo('readability', [this.myStatsHistory], () => computeReadability(this.myStatsHistory));
    },
    myStatsWeekDelta() {
      return this._memo('weekDelta', [this.myStatsHistory], () => computeWeeklyDelta(this.myStatsHistory));
    },
    myStatsEffort() {
      if (!this.myStatsWindowActive) {
        return this._memo('effort', [this.myStatsData], () =>
          computeEffortSplit(this.myStatsData?.writing_seconds, this.myStatsData?.lektorat_seconds));
      }
      const win = this._winWriting(), winL = this._winLektorat();
      return this._memo('effortWin', [win, winL], () =>
        computeEffortSplit(this._sumSeconds(win), this._sumSeconds(winL)));
    },
    myStatsPerBookTime() {
      const win = this._winWriting();
      return this._memo('perBook', [win], () =>
        computePerBookTime(win).map(r => ({ ...r, name: this._bookName(r.book_id) })));
    },

    // ── Lektorat-Qualitaet (Fundstellen-Dichte + 30-Tage-Trend) ─────────────
    // Server liefert vorab aggregiert (myStatsData.lektorat) — Lifetime-Befund,
    // kein Zeitraum-Filter (analog Lesbarkeit).
    myStatsQuality() { return this.myStatsData?.lektorat || null; },
    get myStatsHasQuality() { return !!this.myStatsData?.lektorat; },

    get myStatsHasReadability() { return this.myStatsReadability().hasData; },
    get myStatsHasPerBook() { return this.myStatsPerBookTime().length > 1; },

    // ── Tageszeit-Muster (lebenslanges writing_hour-Histogramm, 24 Buckets) ──
    myStatsHours() {
      return this._memo('hours', [this.myStatsData?.by_hour], () =>
        computeHourPattern(this.myStatsData?.by_hour));
    },
    get myStatsHasHours() { return this.myStatsHours().hasData; },

    // Stundenlabel: nur jede dritte Stunde beschriften (0,3,…21) — sonst zu dicht.
    myStatsHourLabel(h) { return (h % 3 === 0) ? String(h) : ''; },
    // Tooltip: „07:00–08:00 · 25 min gesamt". Das „gesamt" ist Pflicht, nicht
    // Kosmetik: der Balken ist die lebenslange Summe dieser Stunde (writing_hour
    // hat keine Datums-Dimension), sieht aber wie ein Tageswert aus. Ohne den
    // Qualifier liest man einen 10-h-Balken als „10 h an einem Tag geschrieben".
    // Gleiche Konvention wie `mystats.weekdayTip`.
    myStatsHourTip(h, min) {
      const from = String(h).padStart(2, '0'), to = String((h + 1) % 24).padStart(2, '0');
      return window.__app.t('mystats.hourTip', { from, to, time: this.myStatsMinFmt(min) });
    },

    // ── Tagesziel (Minuten/Tag) ─────────────────────────────────────────────
    myStatsGoal() {
      return this._memo('goal',
        [this.myStatsWriting, this.myStatsData?.daily_goal_minutes, this.myStatsData?.today_writing_seconds],
        () => computeGoalAttainment(this.myStatsWriting, this.myStatsData?.daily_goal_minutes,
                                    this.myStatsData?.today_writing_seconds));
    },
    get myStatsHasGoal() { return this.myStatsGoal().active; },

    // ── Pro-Buch-Ziele: geschriebener Umfang + Gesamtziel-Erreichung ─────────
    // Lifetime-Bestand (kein Zeitraum-Filter): zeigt den aktuellen Stand pro
    // Buch gegen das gesetzte Gesamtziel, daher aus dem Live-books_detail.
    myStatsBookGoals() {
      return this._memo('bookGoals', [this.myStatsData?.books_detail, this.myStatsHistory], () =>
        computeBookGoals(this.myStatsData?.books_detail, this.myStatsHistory)
          .map(r => ({ ...r, name: this._bookName(r.book_id) })));
    },
    get myStatsHasBookGoals() { return this.myStatsBookGoals().length > 0; },

    // ── Umfang nach Kategorie ────────────────────────────────────────────────
    // Lifetime-Bestand pro Kategorie (Live-Umfang aus books_detail; kein
    // Zeitraum-Filter, analog Pro-Buch-Zielen). Sammel-Bucket „Ohne Kategorie"
    // bekommt das Default-Label, Gruppen ohne eigene Farbe eine Palettenfarbe.
    myStatsByCategory() {
      return this._memo('byCategory', [this.myStatsData?.books_detail], () =>
        computeVolumeByCategory(this.myStatsData?.books_detail).map((r, i) => ({
          ...r,
          name: r.categoryId == null ? window.__app.t('mystats.category.none') : r.name,
          color: r.color || BOOK_COLORS[i % BOOK_COLORS.length],
        })));
    },
    // Mindestens zwei Gruppen ODER eine echte Kategorie → Aufschluesselung lohnt.
    get myStatsHasCategories() {
      const g = this.myStatsByCategory();
      return g.length > 1 || (g.length === 1 && g[0].categoryId != null);
    },

    // Frist lesbar (oder Gedankenstrich, wenn keine gesetzt).
    myStatsDeadlineLabel(iso) { return iso ? this.myStatsDateLabel(iso) : '–'; },

    // Status-Klartext pro Buch (erreicht / überfällig / Tage übrig / offen / kein Ziel).
    myStatsGoalStatusLabel(row) {
      const t = window.__app.t;
      if (row.status === 'reached') return t('mystats.bookGoals.reached');
      if (row.status === 'overdue') return t('mystats.bookGoals.overdue');
      if (row.status === 'due')     return t('mystats.bookGoals.due', { n: row.daysRemaining });
      if (row.status === 'open')    return t('mystats.bookGoals.open');
      return t('mystats.bookGoals.none');
    },

    // Fertigstellungs-Prognose in Klartext: „fertig ~ 12. Aug 2026" bzw. bei
    // fehlendem/zu langsamem Tempo der Stillstand-Hinweis.
    myStatsForecastLabel(row) {
      const t = window.__app.t;
      if (row.forecastStalled) return t('mystats.bookGoals.forecastStalled');
      if (row.forecastDate) return t('mystats.bookGoals.forecast', { date: this.myStatsDateLabel(row.forecastDate) });
      return '';
    },

    // Zahl mit einer Nachkommastelle (Lesbarkeitswerte), Locale-aware.
    myStatsDec(n) {
      if (n == null) return '–';
      const loc = Alpine.store('shell').uiLocale === 'de' ? 'de-CH' : 'en-US';
      return Number(n).toLocaleString(loc, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    },

    // Flesch-DE in Klartext-Band (4 Stufen).
    myStatsFleschLabel(v) {
      if (v == null) return '';
      const key = v >= 70 ? 'easy' : v >= 50 ? 'medium' : v >= 30 ? 'hard' : 'veryHard';
      return window.__app.t('mystats.flesch.' + key);
    },

    // Trend-Richtung → Sprite-Icon (richtungsneutral, ohne Wertung).
    myStatsTrendIcon(dir) {
      return dir > 0 ? 'arrow-up' : dir < 0 ? 'arrow-down' : 'minus';
    },


    // Locale-aware Tausender-Trennung (Swiss: de-CH = Apostroph).
    _myStatsFmt(n) {
      const loc = Alpine.store('shell').uiLocale === 'de' ? 'de-CH' : 'en-US';
      return Number(n || 0).toLocaleString(loc);
    },

    // Normseite = 1500 Zeichen (primaere Umfangs-Kennzahl) — zeitraum-bewusst.
    myStatsNormpages() {
      return this._myStatsFmt(Math.round((this.myStatsVolume().chars || 0) / 1500));
    },

    // Schreibzeit kompakt: „12 h 30 min" bzw. „45 min" — im Zeitraum bzw. gesamt.
    myStatsWritingTime() {
      const sec = this.myStatsWindowActive
        ? this._sumSeconds(this._winWriting())
        : (this.myStatsData?.writing_seconds || 0);
      const total = Math.max(0, Math.round(sec / 60));
      const h = Math.floor(total / 60);
      const m = total % 60;
      const t = window.__app.t;
      if (h > 0) return t('mystats.hm', { h: this._myStatsFmt(h), m });
      return t('mystats.m', { m });
    },

    get myStatsIsEmpty() {
      return !this.myStatsLoading && !this.myStatsError && (!this.myStatsData || this.myStatsData.books === 0);
    },
  }));
}
