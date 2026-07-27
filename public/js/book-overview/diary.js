// Tagebuch-Tiles der Buch-Overview (nur bei buchtyp 'tagebuch'): Lücken &
// Konsistenz, Wochentag-Rhythmus, Rückblick-Heatmap. Alles rückwärtsgewandt/
// auswertend (kein generatives Schreiben). Die ersten beiden Tiles rechnen rein
// clientseitig aus `Alpine.store('nav').pages` (Seitenname = ISO-Datum) + `tokEsts`;
// die Heatmap liest die serverseitig aggregierte `overviewRueckblickCoverage`.
//
// Compute-Bodies sind als pure `_computeXxx` extrahiert (Alpine-frei testbar);
// die memoizierten Wrapper nutzen den gemeinsamen `this._memo` aus load.js.
import { localIsoDate } from '../utils.js';
import { quartileLevelFor, currentMonthKey } from '../book/ymheatmap.js';

// Tagebuch-Seitennamen sind 'YYYY-MM-DD' (gleiche Mechanik wie diary-calendar).
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})\b/;

// Datums-Arithmetik über Mittags-Anker (lokal), DST-sicher beim ±n Tage.
function _isoToNoon(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}
function _dayDiff(isoFrom, isoTo) {
  return Math.round((_isoToNoon(isoTo) - _isoToNoon(isoFrom)) / 86400000);
}
function _addDays(iso, n) {
  const d = _isoToNoon(iso);
  d.setDate(d.getDate() + n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
function _prevMonthKey(monthKey) {
  let [y, m] = monthKey.split('-').map(Number);
  m -= 1;
  if (m < 1) { m = 12; y -= 1; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

export const diaryMethods = {
  // Sortierte, auf Tagesebene deduplizierte ISO-Datums-Liste (ein Tag = ein
  // Eintrag — analog Diary-Kalender bei Seitennamen-Kollisionen).
  _diaryEntryDates(pages) {
    const set = new Set();
    for (const p of (pages || [])) {
      const m = ISO_DATE_RE.exec(p?.name || '');
      if (m) set.add(`${m[1]}-${m[2]}-${m[3]}`);
    }
    return [...set].sort();
  },

  diaryHasEntries() {
    const pages = Alpine.store('nav').pages || [];
    return this._memo('diaryHasEntries', [pages], () => this._diaryEntryDates(pages).length > 0);
  },

  // ── Lücken & Konsistenz ────────────────────────────────────────────────────
  _computeDiaryGapsConsistency(dates, todayIso) {
    if (!dates.length) {
      return { daysSinceLast: null, longestGap: 0, currentStreak: 0, entriesThisMonth: 0, entriesPrevMonth: 0 };
    }
    const last = dates[dates.length - 1];
    const daysSinceLast = Math.max(0, _dayDiff(last, todayIso));

    let longestGap = 0;
    for (let i = 1; i < dates.length; i++) {
      const g = _dayDiff(dates[i - 1], dates[i]);
      if (g > longestGap) longestGap = g;
    }

    // Aktuelle Streak: konsekutive Tage mit Eintrag, endend heute oder gestern
    // (heute ohne Eintrag bricht nicht — der Tag ist noch nicht vorbei).
    const set = new Set(dates);
    let cursor = todayIso;
    if (!set.has(cursor)) cursor = _addDays(todayIso, -1);
    let currentStreak = 0;
    while (set.has(cursor)) {
      currentStreak++;
      cursor = _addDays(cursor, -1);
    }

    const curMonth = todayIso.slice(0, 7);
    const prevMonth = _prevMonthKey(curMonth);
    let entriesThisMonth = 0, entriesPrevMonth = 0;
    for (const ds of dates) {
      const mk = ds.slice(0, 7);
      if (mk === curMonth) entriesThisMonth++;
      else if (mk === prevMonth) entriesPrevMonth++;
    }
    return { daysSinceLast, longestGap, currentStreak, entriesThisMonth, entriesPrevMonth };
  },

  diaryGapsConsistency() {
    const pages = Alpine.store('nav').pages || [];
    return this._memo('diaryGaps', [pages], () =>
      this._computeDiaryGapsConsistency(this._diaryEntryDates(pages), localIsoDate()));
  },

  // ── Wochentag-Rhythmus ─────────────────────────────────────────────────────
  // entries: [{ iso, chars }]. weekStartMon: Mo-first (de) vs Sun-first (en).
  // Liefert geordnete Buckets [{ jsDay, count, chars, pct }] (jsDay: 0=So..6=Sa).
  _computeDiaryWeekdayRhythm(entries, weekStartMon = true) {
    const counts = new Array(7).fill(0);
    const chars = new Array(7).fill(0);
    for (const e of (entries || [])) {
      const jsDay = _isoToNoon(e.iso).getDay();
      counts[jsDay]++;
      chars[jsDay] += Number(e.chars || 0);
    }
    const order = weekStartMon ? [1, 2, 3, 4, 5, 6, 0] : [0, 1, 2, 3, 4, 5, 6];
    const maxCount = Math.max(1, ...counts);
    return order.map(jsDay => ({
      jsDay,
      count: counts[jsDay],
      chars: chars[jsDay],
      pct: Math.round((counts[jsDay] / maxCount) * 100),
    }));
  },

  diaryWeekdayRhythm() {
    const app = window.__app;
    const pages = Alpine.store('nav').pages || [];
    const tokEsts = app?.tokEsts || {};
    return this._memo('diaryWeekday', [pages, tokEsts, this._uiLocale()], () => {
      const entries = [];
      for (const p of pages) {
        const m = ISO_DATE_RE.exec(p?.name || '');
        if (!m) continue;
        entries.push({ iso: `${m[1]}-${m[2]}-${m[3]}`, chars: Number(tokEsts[p.id]?.chars || 0) });
      }
      const en = this._uiLocale() === 'en';
      const rows = this._computeDiaryWeekdayRhythm(entries, !en);
      const fmt = this._dateFmt({ weekday: 'short' });
      // 2024-01-01 ist ein Montag — daraus jsDay → Label-Map ableiten.
      const labelByDay = {};
      for (let i = 0; i < 7; i++) {
        const dt = new Date(2024, 0, 1 + i, 12);
        labelByDay[dt.getDay()] = fmt.format(dt);
      }
      return rows.map(r => ({ ...r, weekday: labelByDay[r.jsDay] }));
    });
  },

  // ── Rückblick-Heatmap ──────────────────────────────────────────────────────
  // coverage: { months: { 'YYYY-MM': { entries, rueckblick } }, years: {...},
  //             minYear, maxYear }. Quartil-Bucketing (Level 1..4) über die
  //             positiven Monats-Eintragszahlen — analog overviewStreakHeatmap.
  _computeRueckblickHeatmap(coverage) {
    const empty = { years: [], maxEntries: 0 };
    if (!coverage || coverage.minYear == null || coverage.maxYear == null) return empty;
    const months = coverage.months || {};
    const years = coverage.years || {};

    const counts = [];
    for (const k of Object.keys(months)) {
      const e = months[k]?.entries || 0;
      if (e > 0) counts.push(e);
    }
    const levelFor = quartileLevelFor(counts);
    const todayKey = currentMonthKey();
    const maxEntries = counts.length ? Math.max(...counts) : 0;

    const rows = [];
    for (let y = coverage.maxYear; y >= coverage.minYear; y--) {
      const yKey = String(y);
      const yCov = years[yKey] || null;
      const mArr = [];
      for (let mi = 1; mi <= 12; mi++) {
        const key = `${yKey}-${String(mi).padStart(2, '0')}`;
        const mc = months[key] || null;
        const rb = mc?.rueckblick || null;
        mArr.push({
          key,
          monthIdx: mi,
          entries: mc?.entries || 0,
          level: levelFor(mc?.entries || 0),
          isCurrent: key === todayKey,
          hasRueckblick: !!rb,
          createdAt: rb?.created_at || null,
        });
      }
      rows.push({
        year: y,
        hasRueckblick: !!(yCov && yCov.rueckblick),
        yearCreatedAt: yCov?.rueckblick?.created_at || null,
        months: mArr,
      });
    }
    return { years: rows, maxEntries };
  },

  overviewRueckblickHeatmap() {
    const cov = this.overviewRueckblickCoverage;
    return this._memo('rueckblickHeatmap', [cov], () => this._computeRueckblickHeatmap(cov));
  },

  // 12 lokalisierte Kurz-Monatsnamen (Spaltenköpfe + Tooltip-Zeitraum).
  rueckblickMonthLabels() {
    return this._memo('rbMonthLabels', [this._uiLocale()], () => {
      const fmt = this._dateFmt({ month: 'short' });
      const out = [];
      for (let m = 0; m < 12; m++) out.push(fmt.format(new Date(2024, m, 15, 12)));
      return out;
    });
  },

  rueckblickCreatedLabel(iso) {
    if (!iso) return '';
    try {
      return this._dateFmt({ day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(iso));
    } catch { return ''; }
  },

  // Tooltip einer Heatmap-Monatszelle: Zeitraum, Eintragszahl, Rückblick-Status.
  rueckblickCellTip(cell) {
    const app = window.__app;
    const period = `${this.rueckblickMonthLabels()[cell.monthIdx - 1]} ${cell.key.slice(0, 4)}`;
    const entriesPart = app.t('overview.rueckblickHeatmap.tooltip.entries', { n: this._fmtNum(cell.entries) });
    const rbPart = cell.hasRueckblick
      ? app.t('overview.rueckblickHeatmap.tooltip.hasRueckblick', { date: this.rueckblickCreatedLabel(cell.createdAt) })
      : app.t('overview.rueckblickHeatmap.tooltip.noRueckblick');
    return `${period}: ${entriesPart} · ${rbPart}`;
  },
};
