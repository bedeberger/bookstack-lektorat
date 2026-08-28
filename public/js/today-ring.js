// Shared Math fuer Tages-Schreibziel und Tagesbilanzen eines Buchs.
// Konsumenten:
//   - Header-Donut links neben Avatar: headerTodayRing (r=14), headerWeekBars,
//     headerStreak (app-view/bookscope.js)
//   - Buch-Overview-Karte: overviewTodayRing (r=28), overviewLast7Days
//     und die Streak-Heatmap (book-overview/stats.js)
//
// `makeDayDelta` ist die SSoT der Frage „wie viele Zeichen entfallen auf diesen
// Kalendertag". Jede Oberflaeche, die Tagesbalken, eine Schreib-Serie oder eine
// Heatmap zeichnet, geht durch sie — sonst zeigen Header-Popover und
// Uebersichts-Kachel fuer denselben Tag verschiedene Zahlen, obwohl beide
// dieselbe /history/book-stats-Antwort und dasselbe tokEsts lesen.
//
// Live-Delta fuer heute = Σ-chars aus tokEsts − letzter Snapshot strikt vor
// heute. Negativ wird auf 0 geklemmt (Lösch-Edits zählen nicht zurück). Fehlt
// einer der beiden Werte (z.B. neues Buch ohne Vortagssnapshot), wird 0
// geliefert — Donut bleibt leer statt falsch optimistisch zu fuellen.
import { aggregateLiveBookStats, localIsoDate, CHARS_PER_NORMSEITE } from './utils.js';

// Reine Zahl: heute geschriebene Zeichen (Live-Σ minus Vortagssnapshot).
// Wird sowohl vom Donut als auch von 7-Tage-Bar/Total konsumiert, damit alle
// drei nie auseinander driften.
export function computeCharsTodayDelta(stats = [], tokEsts = {}) {
  const todayIso = localIsoDate();
  const liveChars = aggregateLiveBookStats(tokEsts).chars;
  let cronTodayChars = null;
  let prevChars = null;
  const a = Array.isArray(stats) ? stats : [];
  for (let i = a.length - 1; i >= 0; i--) {
    const row = a[i];
    if (!row?.recorded_at) continue;
    if (row.recorded_at === todayIso && cronTodayChars == null) {
      cronTodayChars = Number(row.chars) || 0;
      continue;
    }
    if (row.recorded_at < todayIso && prevChars == null) {
      prevChars = Number(row.chars) || 0;
      break;
    }
  }
  const curChars = liveChars > 0 ? liveChars : cronTodayChars;
  if (curChars == null || prevChars == null) return 0;
  return Math.max(0, curChars - prevChars);
}

// Kalendertag `n` Tage vor `iso` — reine Kalenderarithmetik ueber einen
// UTC-Mittag-Anker, damit kein DST-/TZ-Drift entsteht. Der `iso`-Startpunkt
// kommt TZ-korrekt aus localIsoDate().
function isoMinusDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// Kumulativ-Zeichen am letzten Snapshot <= iso (Snapshots sind kumulative
// Tagesstaende; fehlt ein Tag, gilt der letzte davor). Dieses Nachziehen ist
// der Grund, warum ein ausgefallener Cron-Lauf nur den Tag selbst als Nulltag
// zeigt und nicht zusaetzlich den FOLGETAG verschluckt: dessen Vortagswert
// waere ohne Nachziehen unbekannt, und die an dem Tag geschriebenen Zeichen
// fielen aus jeder Bilanz.
function cumOnOrBefore(sortedIsos, cumByIso, iso) {
  let val = null;
  for (const k of sortedIsos) { if (k <= iso) val = cumByIso.get(k); else break; }
  return val;
}

function buildCumMap(stats) {
  const cumByIso = new Map();
  for (const r of (Array.isArray(stats) ? stats : [])) {
    if (r?.recorded_at) cumByIso.set(r.recorded_at, Number(r.chars) || 0);
  }
  return { cumByIso, sortedIsos: [...cumByIso.keys()].sort() };
}

/**
 * Tagesbilanz-Funktion fuer ein Buch: `iso` → Zeichen dieses Kalendertags.
 *
 * `null` heisst „keine Datenlage" (der Tag liegt vor dem ersten Snapshot) und
 * ist bewusst von `0` („gemessen, nichts geschrieben") unterschieden: die
 * Streak-Heatmap zeichnet das eine als leere Zelle und das andere als Nulltag,
 * und die Zell-Tooltips sagen Verschiedenes.
 *
 * Der Wert ist VORZEICHENBEHAFTET — ein Loesch-Edit ergibt ein negatives Delta.
 * Oberflaechen mit Ziel-Semantik (Donut, Fortschrittsbalken) klemmen selbst auf
 * 0; die Netto-Bilanz der Uebersicht zeigt das Minus bewusst an.
 *
 * @param {object} opts
 * @param {Array}  opts.stats     /history/book-stats-Rows { recorded_at, chars }.
 * @param {object} opts.tokEsts   Live-Zeichenstand pro Seite.
 * @param {string} [opts.todayIso] Heutiger Kalendertag (TZ-aware).
 * @returns {(iso: string) => number|null}
 */
export function makeDayDelta({ stats = [], tokEsts = {}, todayIso = localIsoDate() } = {}) {
  const { cumByIso, sortedIsos } = buildCumMap(stats);
  const todayDelta = computeCharsTodayDelta(stats, tokEsts);
  return (iso) => {
    // Heute zaehlt der Live-Stand, sobald er etwas hergibt — er ist frischer
    // als jeder Cron-Snapshot. Sonst faellt der Tag auf den Snapshot-Vergleich
    // zurueck (Buch heute noch nicht geoeffnet, tokEsts leer).
    if (iso === todayIso && todayDelta > 0) return todayDelta;
    const cur = cumOnOrBefore(sortedIsos, cumByIso, iso);
    if (cur == null) return null;
    const prev = cumOnOrBefore(sortedIsos, cumByIso, isoMinusDays(iso, 1));
    if (prev == null) return null;
    return cur - prev;
  };
}

// Ziel-Semantik: unbekannt und negativ sind beide „heute nichts geschafft".
function clampDay(dayDelta, iso) {
  return Math.max(0, dayDelta(iso) ?? 0);
}

// Letzte `days` Kalendertage (aeltester zuerst) als Balken-Daten fuer das
// Header-Popover. Heute-Balken = Live-Delta, deckt sich mit dem Donut.
export function computeWeekBars({ stats = [], tokEsts = {}, days = 7, goalChars = CHARS_PER_NORMSEITE, todayIso = localIsoDate() } = {}) {
  const goal = Math.max(1, Number(goalChars) || CHARS_PER_NORMSEITE);
  const dayDelta = makeDayDelta({ stats, tokEsts, todayIso });
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const iso = isoMinusDays(todayIso, i);
    const chars = clampDay(dayDelta, iso);
    out.push({
      iso,
      chars,
      pct: Math.max(0, Math.min(100, Math.round((chars / goal) * 100))),
      reached: chars >= goal,
      isToday: iso === todayIso,
    });
  }
  return out;
}

// Aktuelle Schreib-Serie: aufeinanderfolgende Tage mit Zeichen > 0, rueckwaerts
// ab heute. Ist heute noch 0 geschrieben, bricht das die Serie nicht sofort
// (Kulanz) — gezaehlt wird dann ab gestern.
export function computeWritingStreak({ stats = [], tokEsts = {}, maxLookback = 400, todayIso = localIsoDate() } = {}) {
  const dayDelta = makeDayDelta({ stats, tokEsts, todayIso });
  const todayChars = clampDay(dayDelta, todayIso);
  let streak = 0;
  for (let i = (todayChars === 0 ? 1 : 0); i < maxLookback; i++) {
    const iso = isoMinusDays(todayIso, i);
    if (clampDay(dayDelta, iso) > 0) streak++;
    else break;
  }
  return streak;
}

// Donut-Geometrie + Flags. Caller waehlt Radius r (28 fuer Overview-Tile,
// 14 fuer Header-Donut).
export function computeTodayRing({ stats = [], tokEsts = {}, goalChars = CHARS_PER_NORMSEITE, r = 28 } = {}) {
  const goal = Math.max(1, Number(goalChars) || CHARS_PER_NORMSEITE);
  const chars = computeCharsTodayDelta(stats, tokEsts);
  const pct = Math.max(0, Math.min(100, Math.round((chars / goal) * 100)));
  const circ = 2 * Math.PI * r;
  const dash = (pct / 100) * circ;
  const gap = circ - dash;
  return {
    chars,
    goal,
    pct,
    r,
    c: circ,
    dash,
    gap,
    reached: chars >= goal,
    active: chars > 0,
  };
}
