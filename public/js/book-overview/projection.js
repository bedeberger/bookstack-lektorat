// Schreibziel-Deadline-Projektion (per Buch): Zielzeichenzahl + optionales
// Abgabedatum → "bei deinem Schnitt fertig am ...". Reine Compute-Funktion
// (frei von Alpine/DOM) → unit-testbar (tests/unit/deadline-projection.test.mjs).
// Quelle ist der book_stats_history-Snapshot-Verlauf (overviewStats) plus der
// Live-Zeichenstand aus tokEsts. Schnitt = Zeichen-Zuwachs der letzten 30 Tage
// geteilt durch die tatsaechliche Snapshot-Spanne.
import { localIsoDate, localIsoDaysAgo, aggregateLiveBookStats } from '../utils.js';

const PACE_WINDOW_DAYS = 30;

// Tages-Arithmetik auf ISO-Strings (YYYY-MM-DD), TZ-frei via UTC (DST-sicher).
function isoAddDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

// Ganztage-Differenz b - a (positiv = b liegt nach a).
function isoDaysBetween(aIso, bIso) {
  const [ay, am, ad] = aIso.split('-').map(Number);
  const [by, bm, bd] = bIso.split('-').map(Number);
  const a = Date.UTC(ay, am - 1, ad);
  const b = Date.UTC(by, bm - 1, bd);
  return Math.round((b - a) / 86400000);
}

/**
 * Deadline-Projektion fuer ein Buch.
 * @param {Array} stats   book_stats_history-Rows { recorded_at (YYYY-MM-DD), chars } aufsteigend.
 * @param {number} liveChars  Live-Gesamtzeichen (aus tokEsts); 0 = unbekannt → Fallback Snapshot.
 * @param {{targetChars:number, deadlineIso?:string, todayLocal?:Date}} opts
 * @returns {object} { active, ... } — bei fehlendem Ziel { active:false }.
 */
export function computeDeadlineProjection(stats, liveChars, { targetChars, deadlineIso = null, todayLocal = new Date() } = {}) {
  const target = Math.round(Number(targetChars) || 0);
  if (!target || target <= 0) return { active: false };

  const rows = Array.isArray(stats) ? stats : [];
  const latestSnap = rows.length ? (Number(rows[rows.length - 1].chars) || 0) : 0;
  const current = (Number(liveChars) || 0) > 0 ? Math.round(Number(liveChars)) : latestSnap;

  const today = new Date(todayLocal); today.setHours(12, 0, 0, 0);
  const isoToday = localIsoDate(today);

  // Basis-Snapshot fuer den Schnitt: letzter Snapshot am/vor (heute − 30 Tage).
  // Fehlt einer (Buch juenger als 30 Tage), nimm den aeltesten Snapshot.
  const cutoffIso = localIsoDaysAgo(PACE_WINDOW_DAYS, today);
  let baseChars = null, baseIso = null;
  for (const s of rows) {
    if (!s.recorded_at) continue;
    if (s.recorded_at <= cutoffIso) { baseChars = Number(s.chars) || 0; baseIso = s.recorded_at; }
  }
  if (baseIso == null && rows.length) {
    baseChars = Number(rows[0].chars) || 0;
    baseIso = rows[0].recorded_at || null;
  }

  let pace = 0; // Zeichen/Tag
  if (baseIso != null) {
    const spanDays = Math.max(1, isoDaysBetween(baseIso, isoToday));
    pace = (current - baseChars) / spanDays;
  }
  pace = Math.round(pace);

  const remaining = Math.max(0, target - current);
  const progressPct = Math.min(100, Math.round((current / target) * 100));
  const reached = current >= target;

  const result = {
    active: true,
    targetChars: target,
    currentChars: current,
    remainingChars: remaining,
    progressPct,
    reached,
    pace,                          // juengster Schnitt, Zeichen/Tag (kann 0/negativ)
    stalled: !reached && pace <= 0,
    deadlineIso: deadlineIso || null,
    daysNeeded: null,
    projectedFinishIso: null,
    daysUntilDeadline: null,
    requiredPace: null,
    daysBuffer: null,
    onTrack: null,
  };

  if (reached) {
    result.projectedFinishIso = isoToday;
    result.onTrack = true;
    result.daysNeeded = 0;
  } else if (pace > 0) {
    const daysNeeded = Math.ceil(remaining / pace);
    result.daysNeeded = daysNeeded;
    result.projectedFinishIso = isoAddDays(isoToday, daysNeeded);
  }

  if (deadlineIso) {
    const daysUntilDeadline = isoDaysBetween(isoToday, deadlineIso);
    result.daysUntilDeadline = daysUntilDeadline;
    // Noetiger Schnitt, um die Deadline zu treffen (Restzeichen / Resttage).
    result.requiredPace = (!reached && daysUntilDeadline > 0) ? Math.ceil(remaining / daysUntilDeadline) : null;
    if (result.projectedFinishIso) {
      // Puffer = Deadline − projiziertes Fertigdatum (positiv = vor der Deadline).
      result.daysBuffer = isoDaysBetween(result.projectedFinishIso, deadlineIso);
      result.onTrack = result.daysBuffer >= 0;
    } else {
      result.onTrack = false; // kein Fortschritt → Deadline unerreichbar
    }
  }

  return result;
}

export const projectionMethods = {
  // Card-Wrapper: liest overviewStats + Live-tokEsts + Buch-Ziel/Deadline.
  overviewGoalProjection() {
    const stats = this.overviewStats || [];
    const tokEsts = window.__app?.tokEsts || {};
    const target = this.overviewGoalTargetChars;
    const deadline = this.overviewGoalDeadline;
    return this._memo('goalProjection', [stats, tokEsts, target, deadline], () => {
      const liveChars = aggregateLiveBookStats(tokEsts).chars;
      return computeDeadlineProjection(stats, liveChars, { targetChars: target, deadlineIso: deadline });
    });
  },

  // Methode (kein Getter): bookOverviewMethods wird gespreadet — ein Getter
  // wuerde beim Spread evaluiert statt durchgereicht (window noch undefiniert).
  overviewHasGoal() {
    return this.overviewGoalProjection().active;
  },

  // Projiziertes Fertigdatum / Deadline lesbar formatieren. Mittags-Anker plus
  // Formatter in appTimezone (via _dateFmt → tzOpts): ein Mitternachts-Anker
  // würde bei abweichender App-Zeitzone auf den Vortag kippen.
  overviewGoalDateLabel(iso) {
    if (!iso) return '';
    return this._dateFmt({ day: 'numeric', month: 'short', year: 'numeric' })
      .format(new Date(iso + 'T12:00:00'));
  },
};
