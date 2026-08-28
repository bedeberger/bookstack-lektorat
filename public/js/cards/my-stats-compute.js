// Pure Compute-Funktionen fuer „Meine Statistik" (my-stats-card.js).
// Bewusst frei von Alpine/DOM → unit-testbar (tests/unit/my-stats-compute.test.mjs).
// Quelle ist die Schreibzeit-Zeitreihe `writing` aus /me/profile-stats-history:
// Rows { book_id, date (YYYY-MM-DD), seconds }, ggf. mehrere Buecher pro Tag.

import { localIsoDate, localIsoDaysAgo } from '../utils.js';
import { buildStreakGrid } from '../streak-grid.js';

const WEEKS = 52;

// Reine Tages-Arithmetik auf ISO-Strings (YYYY-MM-DD), TZ-frei via UTC, damit
// DST-Spruenge die Kalendertage nicht verschieben.
export function isoAddDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

// Tages-ISO → Bucket-Schluessel je Granularitaet. Der Schluessel ist selbst ein
// sortierbares ISO-Datum (Monday-of-week bzw. Monatserster), damit X-Achse +
// Label-Formatierung dieselbe Datumslogik wie der Tagesfall nutzen koennen.
//   'day'   → das Datum selbst
//   'week'  → Montag der Kalenderwoche
//   'month' → erster Tag des Monats
export function bucketizeIso(iso, gran) {
  if (gran === 'month') return iso.slice(0, 7) + '-01';
  if (gran === 'week') {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    const dow = (dt.getUTCDay() + 6) % 7; // Mo=0 .. So=6
    dt.setUTCDate(dt.getUTCDate() - dow);
    return dt.toISOString().slice(0, 10);
  }
  return iso;
}

// Zeitreihe { date, value } auf Buckets verdichten. mode='sum' summiert die
// Werte je Bucket (Tages-Deltas wie Schreibminuten), mode='last' nimmt den Wert
// des juengsten Tages je Bucket (kumulative Snapshot-Groessen wie Zeichen).
// Liefert eine nach Bucket sortierte [{ bucket, value }]-Liste.
export function aggregateByBucket(points, gran, mode) {
  if (gran === 'day') {
    return points.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      .map(p => ({ bucket: p.date, value: p.value }));
  }
  const buckets = new Map(); // bucket → { sum, lastDate, lastVal }
  for (const p of points) {
    const key = bucketizeIso(p.date, gran);
    const cur = buckets.get(key);
    if (!cur) {
      buckets.set(key, { sum: p.value, lastDate: p.date, lastVal: p.value });
    } else {
      cur.sum += p.value;
      if (p.date >= cur.lastDate) { cur.lastDate = p.date; cur.lastVal = p.value; }
    }
  }
  return [...buckets.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([bucket, v]) => ({ bucket, value: mode === 'last' ? v.lastVal : v.sum }));
}

// Rows auf ein Zeitfenster [from, to] (inklusive, ISO-Strings) einschraenken.
// from/to je null = unbegrenzt. dateField ist der Feldname mit dem Tagesdatum
// (writing/lektorat: 'date', book_stats_history: 'recorded_at').
export function filterByWindow(rows, dateField, from, to) {
  return (rows || []).filter(r => {
    const d = r[dateField];
    if (!d) return false;
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  });
}

// Im Zeitfenster produzierter Umfang (Zeichen/Woerter/Seiten) als Delta der
// kumulierten book_stats_history-Snapshots: Endstand (letzter Snapshot <= to,
// bzw. juengster falls to null) minus Basis (letzter Snapshot STRIKT vor from).
// Buecher, die erst im Fenster angelegt wurden, haben keine Basis → voller
// Zuwachs zaehlt. Net-Wert (kann bei Loeschungen negativ sein), analog Wochen-Delta.
export function computeVolumeDelta(historyRows, fromIso, toIso) {
  const end = toIso ? snapshotPerBookOnOrBefore(historyRows, toIso) : latestSnapshotPerBook(historyRows);
  const base = fromIso ? snapshotPerBookOnOrBefore(historyRows, isoAddDays(fromIso, -1)) : new Map();
  let chars = 0, words = 0, pages = 0;
  for (const [bid, snap] of end) {
    const b = base.get(bid);
    chars += (Number(snap.chars) || 0)      - (Number(b?.chars) || 0);
    words += (Number(snap.words) || 0)      - (Number(b?.words) || 0);
    pages += (Number(snap.page_count) || 0) - (Number(b?.page_count) || 0);
  }
  return { chars, words, pages };
}

// Schreib-Sekunden pro Tag ueber alle Buecher summieren → Map(date → seconds).
export function secondsByDate(writingRows) {
  const m = new Map();
  for (const r of (writingRows || [])) {
    const d = r.date;
    if (!d) continue;
    m.set(d, (m.get(d) || 0) + (Number(r.seconds) || 0));
  }
  return m;
}

// Streak-Heatmap (52 Wochen × 7 Tage, GitHub-Stil) auf Basis aktiver Schreibtage
// (seconds > 0). Raster, Einfaerbung und Serien-Zaehlung liegen in
// [public/js/streak-grid.js] — geteilt mit der Zeichen-Heatmap der
// Buch-Uebersicht; hier bleibt nur der Tageswert (Schreibsekunden) und die
// Minuten-Aufbereitung der Zelle.
//
// Heisst bewusst NICHT `computeWritingStreak`: today-ring.js exportiert eine
// gleichnamige Funktion mit anderer Signatur und anderer Datenquelle (Zeichen
// statt Sekunden), und beide liegen gleichzeitig im Modulgraph.
export function computeWritingTimeStreak(writingRows, todayLocal = new Date()) {
  const secByDate = secondsByDate(writingRows);
  return buildStreakGrid({
    valueForIso: (iso) => secByDate.get(iso) || 0,
    todayLocal,
    weeks: WEEKS,
    decorate: (cell) => cell.future
      ? { seconds: null, minutes: null }
      : { seconds: cell.value, minutes: Math.round(cell.value / 60), active: cell.value > 0 },
  });
}

// Wochentags-Muster: Summe Schreibminuten je Wochentag (Mo..So).
// pct = Anteil am Maximum (fuer Balkenhoehe). days = Anzahl aktiver Tage je Dow.
export function computeWeekdayPattern(writingRows) {
  const secByDate = secondsByDate(writingRows);
  const sec = [0, 0, 0, 0, 0, 0, 0];   // Index 0 = Mo ... 6 = So
  const days = [0, 0, 0, 0, 0, 0, 0];
  for (const [iso, s] of secByDate) {
    if (s <= 0) continue;
    const dow = new Date(iso + 'T12:00:00').getDay(); // 0=So..6=Sa
    const idx = (dow + 6) % 7;                          // → Mo=0..So=6
    sec[idx] += s;
    days[idx] += 1;
  }
  const minutes = sec.map(s => Math.round(s / 60));
  const max = Math.max(1, ...minutes);
  return minutes.map((m, i) => ({
    dow: i,
    minutes: m,
    days: days[i],
    pct: Math.round((m / max) * 100),
  }));
}

// Abgeleitete Kennzahlen: Tagesschnitt, bester Tag, Schreibtempo.
export function computeDerived(data, writingRows) {
  const secByDate = secondsByDate(writingRows);
  let activeDays = 0, bestSec = 0, bestDate = null, totalSec = 0;
  for (const [iso, s] of secByDate) {
    if (s <= 0) continue;
    activeDays += 1;
    totalSec += s;
    if (s > bestSec) { bestSec = s; bestDate = iso; }
  }
  const writingSeconds = Number(data?.writing_seconds) || 0;
  const chars = Number(data?.chars) || 0;
  return {
    activeDays,
    dailyAvgMin: activeDays > 0 ? Math.round((totalSec / 60) / activeDays) : 0,
    bestDayMin:  Math.round(bestSec / 60),
    bestDayDate: bestDate,
    // Schreibtempo: Zeichen pro Stunde reiner Schreibzeit (gesamt, nicht pro Tag).
    paceCharsPerHour: writingSeconds > 0 ? Math.round(chars / (writingSeconds / 3600)) : 0,
  };
}

// Meilenstein-Stufen pro Kategorie. Achieved = hoechste erreichte Stufe je
// Kategorie (ein Badge). Next = die naechste unerreichte Stufe insgesamt mit
// kleinstem relativem Abstand (Fortschrittsbalken).
const MILESTONE_TIERS = {
  chars:      [50000, 100000, 250000, 500000, 1000000],
  words:      [10000, 25000, 50000, 100000, 250000],
  activeDays: [10, 30, 100, 365],
  books:      [1, 3, 5, 10],
};

export function computeMilestones(data, derived) {
  const values = {
    chars:      Number(data?.chars) || 0,
    words:      Number(data?.words) || 0,
    activeDays: Number(derived?.activeDays) || 0,
    books:      Number(data?.books) || 0,
  };
  const achieved = [];
  let next = null; // { category, target, value, progress }
  for (const [cat, tiers] of Object.entries(MILESTONE_TIERS)) {
    const v = values[cat];
    let top = null, upcoming = null;
    for (const t of tiers) {
      if (v >= t) top = t;
      else { upcoming = t; break; }
    }
    if (top != null) achieved.push({ category: cat, target: top });
    if (upcoming != null) {
      const progress = Math.min(100, Math.round((v / upcoming) * 100));
      if (!next || progress > next.progress) next = { category: cat, target: upcoming, value: v, progress };
    }
  }
  return { achieved, next };
}

// ── Snapshot-Helfer (book_stats_history) ────────────────────────────────────
// Letzter Snapshot je Buch (max recorded_at).
export function latestSnapshotPerBook(historyRows) {
  const m = new Map();
  for (const r of (historyRows || [])) {
    const prev = m.get(r.book_id);
    if (!prev || r.recorded_at > prev.recorded_at) m.set(r.book_id, r);
  }
  return m;
}

// Letzter Snapshot je Buch mit recorded_at <= cutoff (ISO YYYY-MM-DD).
export function snapshotPerBookOnOrBefore(historyRows, cutoffIso) {
  const m = new Map();
  for (const r of (historyRows || [])) {
    if (r.recorded_at > cutoffIso) continue;
    const prev = m.get(r.book_id);
    if (!prev || r.recorded_at > prev.recorded_at) m.set(r.book_id, r);
  }
  return m;
}

// Chars-gewichteter Mittelwert eines Feldes ueber eine Snapshot-Map.
function weightedAvg(snapMap, field) {
  let num = 0, den = 0;
  for (const r of snapMap.values()) {
    const v = r[field];
    const w = Number(r.chars) || 0;
    if (v == null || w <= 0) continue;
    num += Number(v) * w;
    den += w;
  }
  return den > 0 ? num / den : null;
}

// Lesbarkeit (chars-gewichtet ueber das letzte Snapshot je Buch) + Trend
// gegenueber ~30 Tagen zuvor. Trend ∈ {-1,0,1} (richtungsneutral, keine
// Gut/Schlecht-Wertung — Flesch hoeher = leichter, LIX hoeher = schwerer).
export function computeReadability(historyRows, todayLocal = new Date()) {
  const latest = latestSnapshotPerBook(historyRows);
  const today = new Date(todayLocal); today.setHours(12, 0, 0, 0);
  const past = snapshotPerBookOnOrBefore(historyRows, localIsoDaysAgo(30, today));

  const flesch = weightedAvg(latest, 'avg_flesch_de');
  const lix = weightedAvg(latest, 'avg_lix');
  const sentenceLen = weightedAvg(latest, 'avg_sentence_len');
  const hasData = flesch != null || lix != null || sentenceLen != null;

  const trend = (cur, field, eps) => {
    if (cur == null) return 0;
    const before = weightedAvg(past, field);
    if (before == null) return 0;
    const d = cur - before;
    return d > eps ? 1 : d < -eps ? -1 : 0;
  };

  return {
    hasData,
    flesch, lix, sentenceLen,
    fleschTrend:      trend(flesch, 'avg_flesch_de', 1),
    lixTrend:         trend(lix, 'avg_lix', 1),
    sentenceLenTrend: trend(sentenceLen, 'avg_sentence_len', 0.3),
  };
}

// Geschriebene Zeichen diese Woche vs. letzte Woche (Mo-Start, lokal).
// chars im Snapshot ist die Gesamtgroesse → Zuwachs = Differenz der
// Wochengrenz-Snapshots. Basis je Buch = letzter Snapshot vor Wochenbeginn.
export function computeWeeklyDelta(historyRows, todayLocal = new Date()) {
  const today = new Date(todayLocal); today.setHours(12, 0, 0, 0);
  const dowMon = (today.getDay() + 6) % 7;            // Mo=0 ... So=6
  const cThisBase = localIsoDaysAgo(dowMon + 1, today); // Sonntag vor dieser Woche
  const cLastBase = localIsoDaysAgo(dowMon + 8, today); // Sonntag vor letzter Woche

  const cur = latestSnapshotPerBook(historyRows);
  const thisBase = snapshotPerBookOnOrBefore(historyRows, cThisBase);
  const lastBase = snapshotPerBookOnOrBefore(historyRows, cLastBase);
  const charsOf = (map, id) => Number(map.get(id)?.chars) || 0;

  let thisWeek = 0, lastWeek = 0;
  for (const id of cur.keys()) {
    thisWeek += charsOf(cur, id) - charsOf(thisBase, id);
    lastWeek += charsOf(thisBase, id) - charsOf(lastBase, id);
  }
  return { thisWeek, lastWeek };
}

// Schreibzeit je Buch (absteigend) fuer das „wo deine Zeit hinfloss"-Ranking.
// pct relativ zum Spitzenbuch. Namen werden im Card via _bookName aufgeloest.
export function computePerBookTime(writingRows) {
  const secByBook = new Map();
  for (const r of (writingRows || [])) {
    secByBook.set(r.book_id, (secByBook.get(r.book_id) || 0) + (Number(r.seconds) || 0));
  }
  const rows = [...secByBook.entries()]
    .map(([book_id, seconds]) => ({ book_id, seconds, minutes: Math.round(seconds / 60) }))
    .filter(r => r.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds);
  const max = rows.length ? rows[0].seconds : 1;
  return rows.map(r => ({ ...r, pct: Math.round((r.seconds / max) * 100) }));
}

// Tageszeit-Muster: Schreibminuten je Stunde (0..23) aus dem lebenslangen
// writing_hour-Histogramm. Liefert immer 24 Buckets (auch leere) plus pct
// (Anteil am Maximum, fuer die Balkenhoehe). Rows: [{ hour, seconds }].
export function computeHourPattern(byHourRows) {
  const sec = new Array(24).fill(0);
  for (const r of (byHourRows || [])) {
    const h = Number(r.hour);
    if (!Number.isInteger(h) || h < 0 || h > 23) continue;
    sec[h] += Number(r.seconds) || 0;
  }
  const minutes = sec.map(s => Math.round(s / 60));
  const max = Math.max(1, ...minutes);
  let peakHour = -1, peakMin = 0, total = 0;
  const hours = minutes.map((m, h) => {
    total += sec[h];
    if (m > peakMin) { peakMin = m; peakHour = h; }
    return { hour: h, seconds: sec[h], minutes: m, pct: Math.round((m / max) * 100) };
  });
  return { hours, peakHour: peakMin > 0 ? peakHour : null, totalSeconds: total, hasData: total > 0 };
}

// Tagesziel-Erreichung (Minuten/Tag). Quelle ist die Schreibzeit-Reihe; ein Tag
// gilt als erreicht, wenn seine Schreibminuten >= Ziel sind. `todaySeconds` ist
// der LIVE-Stand von heute (vom Server separat geliefert) und ueberschreibt den
// ggf. noch nicht geflushten Reihen-Wert. Aktueller Streak: konsekutive
// erreichte Tage endend HEUTE oder GESTERN — ein heute noch nicht erreichtes
// Ziel bricht NICHT (Tag laeuft noch), analog computeWritingTimeStreak.
export function computeGoalAttainment(writingRows, goalMinutes, todaySeconds = null, todayLocal = new Date()) {
  const goalMin = Math.max(0, Math.round(Number(goalMinutes) || 0));
  if (goalMin <= 0) return { active: false };
  const goalSec = goalMin * 60;

  const secByDate = secondsByDate(writingRows);
  const today = new Date(todayLocal); today.setHours(12, 0, 0, 0);
  const isoToday = localIsoDate(today);
  if (todaySeconds != null) secByDate.set(isoToday, Number(todaySeconds) || 0);

  const todaySec = secByDate.get(isoToday) || 0;
  const todayMin = Math.round(todaySec / 60);
  const progressPct = Math.min(100, Math.round((todaySec / goalSec) * 100));
  const reachedToday = todaySec >= goalSec;

  // Alle erreichten Tage + laengster Streak ueber die gesamte Reihe.
  let daysHit = 0, longest = 0, run = 0;
  const isos = [...secByDate.keys()].sort();
  for (const iso of isos) {
    if ((secByDate.get(iso) || 0) >= goalSec) { daysHit++; run++; if (run > longest) longest = run; }
    else run = 0;
  }

  // Aktueller Streak: ab heute rueckwaerts. Heute offen (noch nicht erreicht)
  // wird uebersprungen, nicht als Bruch gewertet.
  let current = 0;
  for (let off = 0; off <= 4000; off++) {
    const iso = localIsoDaysAgo(off, today);
    const hit = (secByDate.get(iso) || 0) >= goalSec;
    if (off === 0 && !hit) continue;
    if (hit) current++;
    else break;
  }

  return {
    active: true,
    goalMinutes: goalMin,
    todayMinutes: todayMin,
    progressPct,
    reachedToday,
    daysHit,
    currentStreak: current,
    longestStreak: longest,
  };
}

// Differenz b - a in Kalendertagen (ISO YYYY-MM-DD), TZ-frei via UTC.
export function isoDayDiff(aIso, bIso) {
  const [ay, am, ad] = aIso.split('-').map(Number);
  const [by, bm, bd] = bIso.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

// Pro-Buch-Ziel-Uebersicht: „auf welchem Buch wie viel geschrieben + Ziel erreicht?".
// `booksDetail` (aus /me/profile-stats): pro eigenem Buch der live geschriebene
// Umfang (chars/words/pages) + die Ziel-Felder aus book_settings
// (goal_target_chars = Gesamtziel, goal_deadline = Frist, daily_goal_chars =
// Tagesziel) + `is_finished` (Buch als fertig markiert → Badge in der Tabelle). `historyRows` (book_stats_history, aus /me/profile-stats-history)
// liefert die Vortags-Snapshots fuer den Tagesziel-Fortschritt: heute
// geschrieben = Live-Stand minus letzter Snapshot strikt vor heute, auf >= 0
// geklemmt (gleiche Regel wie der Heute-Ring der Buch-Uebersicht, today-ring.js).
// Es zaehlt nur, was Inhalt ODER ein gesetztes Gesamtziel hat — leere Buecher
// ohne Ziel sind kein Ueberblick-Signal. Gesamtziel-Status pro Buch:
//   'reached'  Gesamtziel erfuellt (chars >= Ziel)
//   'overdue'  Frist abgelaufen, Ziel nicht erreicht
//   'due'      Frist laeuft noch (daysRemaining >= 0)
//   'open'     Ziel gesetzt, keine Frist
//   'none'     kein Gesamtziel gesetzt
// Namen werden im Card via _bookName aufgeloest (Content-Store-Regel).
// Fenster (Tage) fuer die Tempo-Schaetzung der Fertigstellungs-Prognose: juengster
// Snapshot je Buch minus Snapshot ~30 Tage zuvor → Zeichen-Zuwachs pro Kalendertag.
const FORECAST_PACE_DAYS = 30;
// Prognose nur ausweisen, wenn sie nicht ins Absurde laeuft (~14 Jahre).
const FORECAST_MAX_DAYS = 5000;

export function computeBookGoals(booksDetail, historyRows = [], todayLocal = new Date()) {
  const isoToday = localIsoDate(todayLocal);
  // Basis-Snapshot je Buch = letzter Snapshot strikt vor heute (= on-or-before
  // gestern). Aelter-als-gestern ist okay (verkraftet Luecken/Wochenenden),
  // analog computeCharsTodayDelta.
  const isoYesterday = localIsoDaysAgo(1, todayLocal);
  const baseSnap = snapshotPerBookOnOrBefore(historyRows, isoYesterday);

  // Tempo-Basis fuer die Prognose: pro Buch der juengste Snapshot + der letzte
  // Snapshot on-or-before (heute − FORECAST_PACE_DAYS). Daraus Zeichen/Tag.
  const paceLatest = latestSnapshotPerBook(historyRows);
  const pacePast = snapshotPerBookOnOrBefore(historyRows, localIsoDaysAgo(FORECAST_PACE_DAYS, todayLocal));

  const rows = (booksDetail || []).map((b) => {
    const chars = Number(b.chars) || 0;
    const goal = Number(b.goal_target_chars) || 0;
    const hasGoal = goal > 0;
    const deadline = b.goal_deadline || null;
    const reached = hasGoal && chars >= goal;
    const daysRemaining = deadline ? isoDayDiff(isoToday, deadline) : null;

    let status;
    if (!hasGoal) status = 'none';
    else if (reached) status = 'reached';
    else if (deadline && daysRemaining < 0) status = 'overdue';
    else if (deadline) status = 'due';
    else status = 'open';

    // Tagesziel: heute geschriebene Zeichen vs. daily_goal_chars.
    const dailyGoal = Number(b.daily_goal_chars) || 0;
    const hasDailyGoal = dailyGoal > 0;
    const prevChars = baseSnap.has(b.book_id) ? (Number(baseSnap.get(b.book_id).chars) || 0) : null;
    // Ohne Vortags-Snapshot kein verlaesslicher Tagesstand → 0 (nicht optimistisch
    // den vollen Bestand als „heute" zaehlen), analog today-ring.js.
    const charsToday = prevChars == null ? 0 : Math.max(0, chars - prevChars);

    // ── Fertigstellungs-Prognose ─────────────────────────────────────────────
    // Aktuelles Schreibtempo (Zeichen/Kalendertag) aus dem juengsten Snapshot
    // gegen den ~30-Tage-Snapshot. Hat das Buch keinen so alten Snapshot, wird
    // der aelteste verfuegbare als Basis genommen (kuerzeres Fenster). Daraus:
    //   forecastDate     prognostiziertes Ziel-Erreichungs-Datum (ISO)
    //   forecastStalled  Ziel offen, aber kein/negatives Tempo → keine Prognose
    //   requiredPerDay   bei Frist: Zeichen/Tag, die ab heute noetig sind
    //   onTrack          Prognose-Datum liegt am/vor der Frist
    const latestSnap = paceLatest.get(b.book_id);
    const pastSnap = pacePast.get(b.book_id);
    let recentDailyChars = 0;
    if (latestSnap && pastSnap && latestSnap.recorded_at > pastSnap.recorded_at) {
      const span = Math.max(1, isoDayDiff(pastSnap.recorded_at, latestSnap.recorded_at));
      recentDailyChars = Math.max(0, ((Number(latestSnap.chars) || 0) - (Number(pastSnap.chars) || 0)) / span);
    }
    const remainingChars = hasGoal ? Math.max(0, goal - chars) : 0;
    let forecastDate = null, forecastStalled = false, forecastDays = null, onTrack = null;
    if (hasGoal && !reached) {
      if (recentDailyChars > 0) {
        const days = Math.ceil(remainingChars / recentDailyChars);
        if (days <= FORECAST_MAX_DAYS) {
          forecastDays = days;
          forecastDate = isoAddDays(isoToday, days);
          if (deadline) onTrack = forecastDate <= deadline;
        } else {
          forecastStalled = true;
        }
      } else {
        forecastStalled = true;
      }
    }
    // Bei laufender Frist: noetiges Tempo, um sie noch zu halten (>= 1 Tag).
    const requiredPerDay = (hasGoal && !reached && deadline && daysRemaining != null && daysRemaining >= 0)
      ? Math.ceil(remainingChars / Math.max(1, daysRemaining))
      : null;

    return {
      book_id: b.book_id,
      isFinished: !!b.is_finished,
      category: b.category || null,
      chars,
      words: Number(b.words) || 0,
      pages: Number(b.pages) || 0,
      normpages: Math.round(chars / 1500),
      goal: hasGoal ? goal : null,
      goalNormpages: hasGoal ? Math.round(goal / 1500) : null,
      hasGoal,
      reached,
      remainingChars: hasGoal ? Math.max(0, goal - chars) : null,
      // Fortschritt fuer den Balken auf 100 gedeckelt; pctRaw fuer die Zahl.
      pct: hasGoal ? Math.min(100, Math.round((chars / goal) * 100)) : null,
      pctRaw: hasGoal ? Math.round((chars / goal) * 100) : null,
      deadline,
      daysRemaining,
      status,
      // Fertigstellungs-Prognose.
      recentDailyChars: Math.round(recentDailyChars),
      forecastDate,
      forecastDays,
      forecastStalled,
      requiredPerDay,
      onTrack,
      // Tagesziel-Block.
      charsToday,
      dailyGoalChars: hasDailyGoal ? dailyGoal : null,
      hasDailyGoal,
      dailyReached: hasDailyGoal && charsToday >= dailyGoal,
      dailyPct: hasDailyGoal ? Math.min(100, Math.round((charsToday / dailyGoal) * 100)) : null,
    };
  }).filter(r => r.chars > 0 || r.hasGoal);

  // Default: Buecher mit Ziel zuerst (nach Fortschritt absteigend), dann der
  // Rest nach Umfang. sortableTable kann im UI umsortieren.
  rows.sort((a, b) => {
    if (a.hasGoal !== b.hasGoal) return a.hasGoal ? -1 : 1;
    if (a.hasGoal) return (b.pctRaw || 0) - (a.pctRaw || 0);
    return b.chars - a.chars;
  });
  return rows;
}

// Aufwands-Aufteilung Schreiben vs. Ueberarbeiten (Sekunden → Prozent).
export function computeEffortSplit(writingSeconds, lektoratSeconds) {
  const w = Math.max(0, Number(writingSeconds) || 0);
  const l = Math.max(0, Number(lektoratSeconds) || 0);
  const total = w + l;
  return {
    writingSeconds: w,
    lektoratSeconds: l,
    hasData: total > 0,
    writingPct: total > 0 ? Math.round((w / total) * 100) : 0,
    lektoratPct: total > 0 ? Math.round((l / total) * 100) : 0,
  };
}
