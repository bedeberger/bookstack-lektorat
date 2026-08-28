// Tests fuer die pure Compute-Funktionen von „Meine Statistik".
// Quelle ist die writing-Zeitreihe (Rows { book_id, date, seconds }).
import test from 'node:test';
import assert from 'node:assert/strict';

// utils/date.js liest window.__app fuer Timezone — minimal stubben.
globalThis.window = { __app: { uiLocale: 'de' } };

const { computeWritingTimeStreak, computeWeekdayPattern, computeDerived, computeMilestones, secondsByDate,
        computeReadability, computeWeeklyDelta, computePerBookTime, computeEffortSplit,
        computeVolumeDelta, computeHourPattern, computeGoalAttainment, computeBookGoals,
        filterByWindow } =
  await import('../../public/js/cards/my-stats-compute.js');
const { computeVolumeByCategory } = await import('../../public/js/cards/my-stats-category.js');

import { localIsoDaysAgo } from '../../public/js/utils.js';
const isoDaysAgo = (n) => localIsoDaysAgo(n);

test('secondsByDate summiert mehrere Buecher pro Tag', () => {
  const rows = [
    { book_id: 1, date: '2026-06-01', seconds: 600 },
    { book_id: 2, date: '2026-06-01', seconds: 300 },
    { book_id: 1, date: '2026-06-02', seconds: 120 },
  ];
  const m = secondsByDate(rows);
  assert.equal(m.get('2026-06-01'), 900);
  assert.equal(m.get('2026-06-02'), 120);
});

test('computeWritingTimeStreak: aktuelle Serie endet heute', () => {
  const rows = [
    { book_id: 1, date: isoDaysAgo(0), seconds: 600 },
    { book_id: 1, date: isoDaysAgo(1), seconds: 600 },
    { book_id: 1, date: isoDaysAgo(2), seconds: 600 },
  ];
  const r = computeWritingTimeStreak(rows);
  assert.equal(r.currentStreak, 3);
  assert.equal(r.longestStreak, 3);
  assert.equal(r.totalActiveDays, 3);
  assert.equal(r.weeksCount, 52);
  assert.equal(r.weeks.length, 52);
});

test('computeWritingTimeStreak: heute offen bricht die Serie nicht', () => {
  const rows = [
    { book_id: 1, date: isoDaysAgo(1), seconds: 600 },
    { book_id: 1, date: isoDaysAgo(2), seconds: 600 },
  ];
  const r = computeWritingTimeStreak(rows);
  assert.equal(r.currentStreak, 2, 'gestern + vorgestern zaehlen, heute leer unschaedlich');
});

test('computeWritingTimeStreak: Luecke bricht die aktuelle Serie', () => {
  const rows = [
    { book_id: 1, date: isoDaysAgo(0), seconds: 600 },
    // Luecke bei isoDaysAgo(1)
    { book_id: 1, date: isoDaysAgo(2), seconds: 600 },
    { book_id: 1, date: isoDaysAgo(3), seconds: 600 },
  ];
  const r = computeWritingTimeStreak(rows);
  assert.equal(r.currentStreak, 1);
  assert.equal(r.longestStreak, 2);
  assert.equal(r.totalActiveDays, 3);
});

test('computeWritingTimeStreak: leere Eingabe → alles 0', () => {
  const r = computeWritingTimeStreak([]);
  assert.equal(r.currentStreak, 0);
  assert.equal(r.longestStreak, 0);
  assert.equal(r.totalActiveDays, 0);
});

test('computeWeekdayPattern: 7 Eintraege Mo..So, pct relativ zum Max', () => {
  // 2026-06-01 ist ein Montag.
  const rows = [
    { book_id: 1, date: '2026-06-01', seconds: 3600 }, // Mo
    { book_id: 1, date: '2026-06-03', seconds: 1800 }, // Mi
  ];
  const wd = computeWeekdayPattern(rows);
  assert.equal(wd.length, 7);
  assert.equal(wd[0].minutes, 60, 'Mo = 60 min');
  assert.equal(wd[0].pct, 100, 'Mo ist Maximum');
  assert.equal(wd[2].minutes, 30, 'Mi = 30 min');
  assert.equal(wd[2].pct, 50);
  assert.equal(wd[1].minutes, 0, 'Di leer');
});

test('computeDerived: Tagesschnitt, bester Tag, Tempo', () => {
  const data = { chars: 36000, writing_seconds: 7200 }; // 2 h reine Schreibzeit
  const rows = [
    { book_id: 1, date: '2026-06-01', seconds: 5400 }, // 90 min — bester Tag
    { book_id: 1, date: '2026-06-02', seconds: 1800 }, // 30 min
  ];
  const d = computeDerived(data, rows);
  assert.equal(d.activeDays, 2);
  assert.equal(d.dailyAvgMin, 60, '(90+30)/2');
  assert.equal(d.bestDayMin, 90);
  assert.equal(d.bestDayDate, '2026-06-01');
  assert.equal(d.paceCharsPerHour, 18000, '36000 / 2h');
});

test('computeDerived: ohne Schreibzeit kein Tempo (keine Division durch 0)', () => {
  const d = computeDerived({ chars: 1000, writing_seconds: 0 }, []);
  assert.equal(d.paceCharsPerHour, 0);
  assert.equal(d.dailyAvgMin, 0);
});

test('computeMilestones: hoechste erreichte Stufe je Kategorie + naechstes Ziel', () => {
  const data = { chars: 120000, words: 12000, books: 2 };
  const derived = { activeDays: 35 };
  const m = computeMilestones(data, derived);
  const byCat = Object.fromEntries(m.achieved.map(a => [a.category, a.target]));
  assert.equal(byCat.chars, 100000);
  assert.equal(byCat.words, 10000);
  assert.equal(byCat.activeDays, 30);
  assert.equal(byCat.books, 1);
  assert.ok(m.next, 'es gibt ein naechstes Ziel');
  assert.ok(m.next.progress >= 0 && m.next.progress <= 100);
});

test('computeMilestones: nichts erreicht → leere Badges, aber naechstes Ziel', () => {
  const m = computeMilestones({ chars: 0, words: 0, books: 0 }, { activeDays: 0 });
  assert.equal(m.achieved.length, 0);
  assert.ok(m.next);
});

test('computeReadability: chars-gewichteter Mittelwert ueber letztes Snapshot je Buch', () => {
  const rows = [
    // Buch 1: zwei Snapshots, letzter zaehlt; Buch 2: ein Snapshot.
    { book_id: 1, recorded_at: '2026-06-01', chars: 1000, avg_flesch_de: 50, avg_lix: 40, avg_sentence_len: 12 },
    { book_id: 1, recorded_at: '2026-06-10', chars: 3000, avg_flesch_de: 60, avg_lix: 45, avg_sentence_len: 14 },
    { book_id: 2, recorded_at: '2026-06-09', chars: 1000, avg_flesch_de: 80, avg_lix: 35, avg_sentence_len: 10 },
  ];
  const r = computeReadability(rows);
  assert.ok(r.hasData);
  // (60*3000 + 80*1000) / 4000 = 65
  assert.equal(r.flesch, 65);
  assert.equal(r.lix, (45 * 3000 + 35 * 1000) / 4000);
});

test('computeReadability: ohne Werte → hasData false, Trends 0', () => {
  const r = computeReadability([{ book_id: 1, recorded_at: '2026-06-01', chars: 1000, avg_flesch_de: null, avg_lix: null, avg_sentence_len: null }]);
  assert.equal(r.hasData, false);
  assert.equal(r.fleschTrend, 0);
});

test('computeReadability: Trend vergleicht mit ~30 Tagen zuvor', () => {
  const rows = [
    { book_id: 1, recorded_at: isoDaysAgo(40), chars: 1000, avg_flesch_de: 50, avg_lix: 50, avg_sentence_len: 12 },
    { book_id: 1, recorded_at: isoDaysAgo(0),  chars: 1000, avg_flesch_de: 60, avg_lix: 45, avg_sentence_len: 12 },
  ];
  const r = computeReadability(rows);
  assert.equal(r.fleschTrend, 1, 'Flesch gestiegen');
  assert.equal(r.lixTrend, -1, 'LIX gesunken');
  assert.equal(r.sentenceLenTrend, 0, 'Satzlaenge unveraendert');
});

test('computeWeeklyDelta: Zuwachs diese Woche vs. letzte Woche', () => {
  // chars = kumulierte Gesamtgroesse. Basis je Woche = letzter Snapshot davor.
  const rows = [
    { book_id: 1, recorded_at: isoDaysAgo(20), chars: 1000 }, // vor letzter Woche
    { book_id: 1, recorded_at: isoDaysAgo(9),  chars: 1500 }, // Basis letzte Woche-Ende grob
    { book_id: 1, recorded_at: isoDaysAgo(0),  chars: 2200 }, // jetzt
  ];
  const r = computeWeeklyDelta(rows);
  assert.equal(typeof r.thisWeek, 'number');
  assert.equal(typeof r.lastWeek, 'number');
  assert.ok(r.thisWeek >= 0);
});

test('computePerBookTime: absteigend sortiert, pct relativ zum Spitzenbuch', () => {
  const rows = [
    { book_id: 1, date: '2026-06-01', seconds: 600 },
    { book_id: 2, date: '2026-06-01', seconds: 1800 },
    { book_id: 1, date: '2026-06-02', seconds: 600 },
  ];
  const r = computePerBookTime(rows);
  assert.equal(r.length, 2);
  assert.equal(r[0].book_id, 2, 'Buch 2 fuehrt (1800s)');
  assert.equal(r[0].pct, 100);
  assert.equal(r[1].book_id, 1);
  assert.equal(r[1].minutes, 20);
  assert.equal(r[1].pct, Math.round((1200 / 1800) * 100));
});

test('computePerBookTime: Buecher ohne Zeit fallen raus', () => {
  const r = computePerBookTime([{ book_id: 1, date: '2026-06-01', seconds: 0 }]);
  assert.equal(r.length, 0);
});

test('computeEffortSplit: Prozente summieren grob zu 100', () => {
  const e = computeEffortSplit(7200, 1800); // 2h schreiben, 30min lektorat
  assert.ok(e.hasData);
  assert.equal(e.writingPct, 80);
  assert.equal(e.lektoratPct, 20);
});

test('computeEffortSplit: ohne Daten → hasData false', () => {
  const e = computeEffortSplit(0, 0);
  assert.equal(e.hasData, false);
  assert.equal(e.writingPct, 0);
});

test('filterByWindow: from/to inklusive, null = unbegrenzt', () => {
  const rows = [
    { date: '2026-06-01', seconds: 1 },
    { date: '2026-06-05', seconds: 2 },
    { date: '2026-06-10', seconds: 3 },
    { date: null,         seconds: 9 },
  ];
  assert.deepEqual(filterByWindow(rows, 'date', '2026-06-05', '2026-06-10').map(r => r.seconds), [2, 3]);
  assert.deepEqual(filterByWindow(rows, 'date', null, '2026-06-05').map(r => r.seconds), [1, 2]);
  assert.deepEqual(filterByWindow(rows, 'date', '2026-06-05', null).map(r => r.seconds), [2, 3]);
  assert.equal(filterByWindow(rows, 'date', null, null).length, 3, 'Rows ohne Datum fallen raus');
});

test('computeVolumeDelta: Zuwachs = Endstand minus Basis vor Fensterbeginn', () => {
  const rows = [
    { book_id: 1, recorded_at: '2026-05-31', chars: 1000, words: 200, page_count: 2 }, // Basis (Tag vor from)
    { book_id: 1, recorded_at: '2026-06-15', chars: 1800, words: 360, page_count: 3 }, // im Fenster
    { book_id: 1, recorded_at: '2026-06-30', chars: 2500, words: 500, page_count: 4 }, // Endstand <= to
    { book_id: 1, recorded_at: '2026-07-05', chars: 9999, words: 999, page_count: 9 }, // nach to → ignoriert
  ];
  const v = computeVolumeDelta(rows, '2026-06-01', '2026-06-30');
  assert.equal(v.chars, 1500, '2500 - 1000');
  assert.equal(v.words, 300);
  assert.equal(v.pages, 2);
});

test('computeVolumeDelta: Buch ohne Basis-Snapshot → voller Zuwachs', () => {
  const rows = [
    { book_id: 2, recorded_at: '2026-06-10', chars: 800, words: 100, page_count: 1 }, // erst im Fenster angelegt
  ];
  const v = computeVolumeDelta(rows, '2026-06-01', '2026-06-30');
  assert.equal(v.chars, 800);
});

test('computeVolumeDelta: to=null → juengster Snapshot als Endstand', () => {
  const rows = [
    { book_id: 1, recorded_at: '2026-05-31', chars: 1000, words: 200, page_count: 2 },
    { book_id: 1, recorded_at: '2026-06-20', chars: 1700, words: 340, page_count: 3 },
  ];
  const v = computeVolumeDelta(rows, '2026-06-01', null);
  assert.equal(v.chars, 700);
});

test('computeHourPattern: 24 Buckets, Minuten + pct relativ zum Max, Peak-Stunde', () => {
  const rows = [
    { hour: 9, seconds: 1200 },   // 20 min
    { hour: 9, seconds: 600 },    // +10 min → 30 min gesamt
    { hour: 22, seconds: 900 },   // 15 min
  ];
  const r = computeHourPattern(rows);
  assert.equal(r.hours.length, 24);
  assert.equal(r.hasData, true);
  assert.equal(r.hours[9].minutes, 30);
  assert.equal(r.hours[9].pct, 100);     // Max
  assert.equal(r.hours[22].minutes, 15);
  assert.equal(r.hours[22].pct, 50);     // 15/30
  assert.equal(r.hours[0].minutes, 0);
  assert.equal(r.peakHour, 9);
});

test('computeHourPattern: leere/ungueltige Eingabe → hasData false, peakHour null', () => {
  const r = computeHourPattern([{ hour: 99, seconds: 100 }, { hour: -1, seconds: 50 }]);
  assert.equal(r.hasData, false);
  assert.equal(r.peakHour, null);
  assert.equal(r.hours.length, 24);
});

test('computeGoalAttainment: ohne Ziel → active false', () => {
  assert.equal(computeGoalAttainment([], 0).active, false);
  assert.equal(computeGoalAttainment([], null).active, false);
});

test('computeGoalAttainment: heute live gegen Ziel, Fortschritt + erreicht', () => {
  const rows = [{ book_id: 1, date: isoDaysAgo(0), seconds: 0 }];
  // Ziel 30 min, heute 1200s = 20 min live → 67% (gerundet), noch nicht erreicht
  const r = computeGoalAttainment(rows, 30, 1200);
  assert.equal(r.active, true);
  assert.equal(r.goalMinutes, 30);
  assert.equal(r.todayMinutes, 20);
  assert.equal(r.progressPct, 67);
  assert.equal(r.reachedToday, false);
});

test('computeGoalAttainment: erreichte Tage + Serie (heute offen bricht nicht)', () => {
  const rows = [
    { book_id: 1, date: isoDaysAgo(1), seconds: 2400 }, // 40 min ≥ 30
    { book_id: 1, date: isoDaysAgo(2), seconds: 1800 }, // 30 min ≥ 30
    { book_id: 1, date: isoDaysAgo(3), seconds: 600 },  // 10 min < 30 (Bruch)
  ];
  // heute noch 0 → offen, darf die Serie aus gestern/vorgestern nicht brechen
  const r = computeGoalAttainment(rows, 30, 0);
  assert.equal(r.daysHit, 2);
  assert.equal(r.currentStreak, 2);
  assert.equal(r.longestStreak, 2);
  assert.equal(r.reachedToday, false);
});

test('computeGoalAttainment: heute erreicht zaehlt in die Serie', () => {
  const rows = [
    { book_id: 1, date: isoDaysAgo(0), seconds: 1800 }, // 30 min heute
    { book_id: 1, date: isoDaysAgo(1), seconds: 2400 }, // 40 min gestern
  ];
  const r = computeGoalAttainment(rows, 30, 1800);
  assert.equal(r.reachedToday, true);
  assert.equal(r.currentStreak, 2);
  assert.equal(r.progressPct, 100);
});

// ── computeBookGoals (Pro-Buch-Ziel-Übersicht) ──────────────────────────────
test('computeBookGoals: Fortschritt, erreicht, gedeckelter Balken', () => {
  const rows = computeBookGoals([
    { book_id: 1, chars: 60000, words: 9000, pages: 40, goal_target_chars: 50000, goal_deadline: null, daily_goal_chars: null },
  ]);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.hasGoal, true);
  assert.equal(r.reached, true);
  assert.equal(r.pctRaw, 120);   // ungedeckelt für die Zahl
  assert.equal(r.pct, 100);      // gedeckelt für den Balken
  assert.equal(r.remainingChars, 0);
  assert.equal(r.status, 'reached');
});

test('computeBookGoals: Frist in der Zukunft → due mit daysRemaining', () => {
  const today = new Date('2026-06-26T12:00:00');
  const rows = computeBookGoals([
    { book_id: 1, chars: 10000, goal_target_chars: 50000, goal_deadline: '2026-07-06' },
  ], [], today);
  const r = rows[0];
  assert.equal(r.status, 'due');
  assert.equal(r.daysRemaining, 10);
  assert.equal(r.remainingChars, 40000);
  assert.equal(r.pctRaw, 20);
});

test('computeBookGoals: abgelaufene Frist + Ziel verfehlt → overdue', () => {
  const today = new Date('2026-06-26T12:00:00');
  const rows = computeBookGoals([
    { book_id: 1, chars: 10000, goal_target_chars: 50000, goal_deadline: '2026-06-20' },
  ], [], today);
  assert.equal(rows[0].status, 'overdue');
  assert.equal(rows[0].daysRemaining, -6);
});

test('computeBookGoals: Ziel ohne Frist → open; Ziel erreicht schlägt Frist', () => {
  const today = new Date('2026-06-26T12:00:00');
  const rows = computeBookGoals([
    { book_id: 1, chars: 10000, goal_target_chars: 50000, goal_deadline: null },
    { book_id: 2, chars: 60000, goal_target_chars: 50000, goal_deadline: '2026-06-20' },
  ], [], today);
  const byId = Object.fromEntries(rows.map(r => [r.book_id, r]));
  assert.equal(byId[1].status, 'open');
  assert.equal(byId[2].status, 'reached'); // erreicht, obwohl Frist abgelaufen
});

test('computeBookGoals: Tagesziel = Live-Stand minus Vortags-Snapshot, geklemmt', () => {
  const today = new Date('2026-06-26T12:00:00');
  const history = [
    { book_id: 1, recorded_at: '2026-06-24', chars: 11000 }, // älter
    { book_id: 1, recorded_at: '2026-06-25', chars: 12000 }, // letzter Snapshot vor heute
  ];
  // Live 13500 − Vortags-Snapshot 12000 = 1500 heute geschrieben, Tagesziel 2000.
  const rows = computeBookGoals([
    { book_id: 1, chars: 13500, goal_target_chars: 50000, daily_goal_chars: 2000 },
  ], history, today);
  const r = rows[0];
  assert.equal(r.charsToday, 1500);
  assert.equal(r.hasDailyGoal, true);
  assert.equal(r.dailyGoalChars, 2000);
  assert.equal(r.dailyReached, false);
  assert.equal(r.dailyPct, 75);
});

test('computeBookGoals: Tagesziel erreicht', () => {
  const today = new Date('2026-06-26T12:00:00');
  const history = [{ book_id: 1, recorded_at: '2026-06-25', chars: 12000 }];
  const rows = computeBookGoals([
    { book_id: 1, chars: 15000, daily_goal_chars: 2000 },
  ], history, today);
  assert.equal(rows[0].charsToday, 3000);
  assert.equal(rows[0].dailyReached, true);
  assert.equal(rows[0].dailyPct, 100);
});

test('computeBookGoals: ohne Vortags-Snapshot → charsToday 0 (nicht optimistisch)', () => {
  const today = new Date('2026-06-26T12:00:00');
  const rows = computeBookGoals([
    { book_id: 1, chars: 15000, daily_goal_chars: 2000 },
  ], [], today);
  assert.equal(rows[0].charsToday, 0);
  assert.equal(rows[0].dailyReached, false);
});

test('computeBookGoals: Lösch-Edit heute → charsToday auf 0 geklemmt', () => {
  const today = new Date('2026-06-26T12:00:00');
  const history = [{ book_id: 1, recorded_at: '2026-06-25', chars: 12000 }];
  const rows = computeBookGoals([
    { book_id: 1, chars: 11000, daily_goal_chars: 2000 }, // live < Vortag
  ], history, today);
  assert.equal(rows[0].charsToday, 0);
});

test('computeBookGoals: kein Tagesziel → hasDailyGoal false, charsToday trotzdem berechnet', () => {
  const today = new Date('2026-06-26T12:00:00');
  const history = [{ book_id: 1, recorded_at: '2026-06-25', chars: 12000 }];
  const rows = computeBookGoals([
    { book_id: 1, chars: 12800, goal_target_chars: 50000, daily_goal_chars: null },
  ], history, today);
  assert.equal(rows[0].hasDailyGoal, false);
  assert.equal(rows[0].dailyGoalChars, null);
  assert.equal(rows[0].dailyPct, null);
  assert.equal(rows[0].charsToday, 800); // informativ auch ohne Tagesziel
});

test('computeBookGoals: ohne Ziel → none, kein Fortschritt', () => {
  const rows = computeBookGoals([
    { book_id: 1, chars: 12000, goal_target_chars: null, goal_deadline: null },
  ]);
  const r = rows[0];
  assert.equal(r.hasGoal, false);
  assert.equal(r.status, 'none');
  assert.equal(r.pct, null);
  assert.equal(r.goal, null);
  assert.equal(r.normpages, 8); // 12000 / 1500
});

test('computeBookGoals: leere Bücher ohne Ziel fallen raus, Ziel-Bücher zuerst', () => {
  const rows = computeBookGoals([
    { book_id: 1, chars: 0, goal_target_chars: null, goal_deadline: null },          // leer, kein Ziel → raus
    { book_id: 2, chars: 30000, goal_target_chars: null, goal_deadline: null },      // Inhalt, kein Ziel
    { book_id: 3, chars: 10000, goal_target_chars: 50000, goal_deadline: null },     // Ziel 20%
    { book_id: 4, chars: 40000, goal_target_chars: 50000, goal_deadline: null },     // Ziel 80%
  ]);
  assert.deepEqual(rows.map(r => r.book_id), [4, 3, 2]); // Ziele zuerst (nach %), dann Rest
});

test('computeBookGoals: is_finished wird als isFinished durchgereicht', () => {
  const rows = computeBookGoals([
    { book_id: 1, chars: 20000, goal_target_chars: null, goal_deadline: null, is_finished: 1 },
    { book_id: 2, chars: 20000, goal_target_chars: null, goal_deadline: null },
  ]);
  const byId = Object.fromEntries(rows.map(r => [r.book_id, r]));
  assert.equal(byId[1].isFinished, true);
  assert.equal(byId[2].isFinished, false);
});

// ── Chart-Granularitaet: bucketizeIso + aggregateByBucket ────────────────────
const { bucketizeIso, aggregateByBucket } = await import('../../public/js/cards/my-stats-compute.js');

test('bucketizeIso: day = Identitaet', () => {
  assert.equal(bucketizeIso('2026-06-29', 'day'), '2026-06-29');
});

test('bucketizeIso: week = Montag der Kalenderwoche', () => {
  // 2026-06-29 ist ein Montag → bleibt; 2026-07-05 ist ein Sonntag → Montag 2026-06-29
  assert.equal(bucketizeIso('2026-06-29', 'week'), '2026-06-29');
  assert.equal(bucketizeIso('2026-07-05', 'week'), '2026-06-29');
  assert.equal(bucketizeIso('2026-06-30', 'week'), '2026-06-29');
});

test('bucketizeIso: month = Monatserster', () => {
  assert.equal(bucketizeIso('2026-06-29', 'month'), '2026-06-01');
  assert.equal(bucketizeIso('2026-12-01', 'month'), '2026-12-01');
});

test('aggregateByBucket: day reicht sortiert durch', () => {
  const pts = [{ date: '2026-06-02', value: 5 }, { date: '2026-06-01', value: 3 }];
  assert.deepEqual(aggregateByBucket(pts, 'day', 'sum'), [
    { bucket: '2026-06-01', value: 3 },
    { bucket: '2026-06-02', value: 5 },
  ]);
});

test('aggregateByBucket: sum addiert Tageswerte im Bucket (Schreibzeit)', () => {
  const pts = [
    { date: '2026-06-29', value: 10 }, // Mo
    { date: '2026-06-30', value: 20 }, // Di → selbe Woche
    { date: '2026-07-06', value: 7 },  // Mo → naechste Woche
  ];
  assert.deepEqual(aggregateByBucket(pts, 'week', 'sum'), [
    { bucket: '2026-06-29', value: 30 },
    { bucket: '2026-07-06', value: 7 },
  ]);
});

test('aggregateByBucket: last nimmt juengsten Tageswert im Bucket (Snapshot)', () => {
  const pts = [
    { date: '2026-06-05', value: 1000 },
    { date: '2026-06-20', value: 1800 }, // juengster im Juni → maßgeblich
    { date: '2026-07-02', value: 2100 },
  ];
  assert.deepEqual(aggregateByBucket(pts, 'month', 'last'), [
    { bucket: '2026-06-01', value: 1800 },
    { bucket: '2026-07-01', value: 2100 },
  ]);
});

// ── Fertigstellungs-Prognose in computeBookGoals ─────────────────────────────
test('computeBookGoals: Prognose aus 30-Tage-Tempo', () => {
  const today = new Date('2026-06-29T12:00:00');
  // 1000 Zeichen/Tag: vor 30 Tagen 20000, heute 50000 → +30000/30. Ziel 110000 →
  // remaining 60000 → 60 Tage → fertig 2026-08-28.
  const history = [
    { book_id: 1, recorded_at: localIsoDaysAgo(30, today), chars: 20000 },
    { book_id: 1, recorded_at: localIsoDaysAgo(0, today), chars: 50000 },
  ];
  const rows = computeBookGoals(
    [{ book_id: 1, chars: 50000, goal_target_chars: 110000, goal_deadline: null }],
    history, today);
  const r = rows[0];
  assert.equal(r.recentDailyChars, 1000);
  assert.equal(r.forecastDays, 60);
  assert.equal(r.forecastDate, '2026-08-28');
  assert.equal(r.forecastStalled, false);
  assert.equal(r.onTrack, null); // keine Frist
});

test('computeBookGoals: onTrack false wenn Prognose nach Frist liegt + requiredPerDay', () => {
  const today = new Date('2026-06-29T12:00:00');
  const history = [
    { book_id: 1, recorded_at: localIsoDaysAgo(30, today), chars: 20000 },
    { book_id: 1, recorded_at: localIsoDaysAgo(0, today), chars: 50000 }, // 1000/Tag
  ];
  const rows = computeBookGoals(
    [{ book_id: 1, chars: 50000, goal_target_chars: 110000, goal_deadline: '2026-07-29' }],
    history, today);
  const r = rows[0];
  assert.equal(r.onTrack, false);            // fertig erst Ende August, Frist Ende Juli
  assert.equal(r.daysRemaining, 30);
  assert.equal(r.requiredPerDay, 2000);      // 60000 / 30
});

test('computeBookGoals: kein/negatives Tempo → forecastStalled', () => {
  const today = new Date('2026-06-29T12:00:00');
  const history = [{ book_id: 1, recorded_at: isoDaysAgo(0), chars: 50000 }]; // nur ein Snapshot
  const rows = computeBookGoals(
    [{ book_id: 1, chars: 50000, goal_target_chars: 110000, goal_deadline: null }],
    history, today);
  const r = rows[0];
  assert.equal(r.recentDailyChars, 0);
  assert.equal(r.forecastStalled, true);
  assert.equal(r.forecastDate, null);
});

test('computeBookGoals: erreichtes Ziel → keine Prognose', () => {
  const today = new Date('2026-06-29T12:00:00');
  const history = [
    { book_id: 1, recorded_at: isoDaysAgo(30), chars: 20000 },
    { book_id: 1, recorded_at: isoDaysAgo(0), chars: 50000 },
  ];
  const rows = computeBookGoals(
    [{ book_id: 1, chars: 50000, goal_target_chars: 40000, goal_deadline: null }],
    history, today);
  const r = rows[0];
  assert.equal(r.reached, true);
  assert.equal(r.forecastDate, null);
  assert.equal(r.forecastStalled, false);
});

// ── computeVolumeByCategory (Umfang nach Buch-Kategorie) ─────────────────────
test('computeVolumeByCategory: gruppiert + summiert je Kategorie, absteigend', () => {
  const groups = computeVolumeByCategory([
    { book_id: 1, chars: 30000, words: 5000, pages: 20, category: { id: 7, name: 'Krimi', color: '#f00' } },
    { book_id: 2, chars: 15000, words: 2000, pages: 10, category: { id: 7, name: 'Krimi', color: '#f00' } },
    { book_id: 3, chars: 60000, words: 9000, pages: 40, category: { id: 9, name: 'Sachbuch', color: null } },
  ]);
  assert.equal(groups.length, 2);
  // Sachbuch (60k) vor Krimi (45k).
  assert.equal(groups[0].categoryId, 9);
  assert.equal(groups[0].chars, 60000);
  assert.equal(groups[0].bookCount, 1);
  assert.equal(groups[1].categoryId, 7);
  assert.equal(groups[1].chars, 45000);
  assert.equal(groups[1].bookCount, 2);
  assert.equal(groups[1].normpages, 30); // 45000 / 1500
  assert.equal(groups[0].pct, 100);      // Spitzenreiter
});

test('computeVolumeByCategory: Sammel-Bucket ohne Kategorie steht zuletzt', () => {
  const groups = computeVolumeByCategory([
    { book_id: 1, chars: 10000, category: null },
    { book_id: 2, chars: 50000, category: { id: 3, name: 'Lyrik', color: '#0f0' } },
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].categoryId, 3);
  assert.equal(groups[1].categoryId, null);
});

test('computeVolumeByCategory: leere Bücher (chars=0) zählen nicht', () => {
  const groups = computeVolumeByCategory([
    { book_id: 1, chars: 0, category: { id: 1, name: 'X', color: null } },
    { book_id: 2, chars: 5000, category: { id: 1, name: 'X', color: null } },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].bookCount, 1);
  assert.equal(groups[0].chars, 5000);
});

test('computeBookGoals: reicht category durch', () => {
  const rows = computeBookGoals([
    { book_id: 1, chars: 5000, category: { id: 2, name: 'Krimi', color: '#abc' } },
  ]);
  assert.deepEqual(rows[0].category, { id: 2, name: 'Krimi', color: '#abc' });
});

// ── Trend-/Session-/Prognose-Funktionen (my-stats-trends.js) ─────────────────
const { computePeriodComparison, computeSessionStats, computeOverallForecast,
        computeVocabTrend } =
  await import('../../public/js/cards/my-stats-trends.js');

test('computeSessionStats: Anzahl, Durchschnitt, laengste, pro aktivem Tag', () => {
  const s = computeSessionStats([
    { book_id: 1, date: '2026-06-01', seconds: 600 },
    { book_id: 1, date: '2026-06-01', seconds: 1800 }, // laengste, selber Tag
    { book_id: 2, date: '2026-06-02', seconds: 300 },
    { book_id: 2, date: '2026-06-03', seconds: 0 },    // 0s faellt raus
  ]);
  assert.equal(s.hasData, true);
  assert.equal(s.count, 3);
  assert.equal(s.avgSeconds, Math.round((600 + 1800 + 300) / 3));
  assert.equal(s.longestSeconds, 1800);
  assert.equal(s.longestDate, '2026-06-01');
  assert.equal(s.activeDays, 2);
  assert.equal(s.perActiveDay, 1.5);
});

test('computeSessionStats: leer → hasData false', () => {
  assert.equal(computeSessionStats([]).hasData, false);
  assert.equal(computeSessionStats([{ book_id: 1, date: '2026-06-01', seconds: 0 }]).hasData, false);
});

test('computePeriodComparison: Vorperiode gleich lang, davor liegend', () => {
  // 3-Tage-Fenster 2026-06-08..10; Vorperiode 06-05..07.
  const history = [
    { book_id: 1, recorded_at: '2026-06-04', chars: 1000, words: 100, page_count: 2 },
    { book_id: 1, recorded_at: '2026-06-07', chars: 1600, words: 160, page_count: 3 },
    { book_id: 1, recorded_at: '2026-06-10', chars: 2200, words: 220, page_count: 4 },
  ];
  const writing = [
    { book_id: 1, date: '2026-06-06', seconds: 1200 },
    { book_id: 1, date: '2026-06-09', seconds: 3600 },
  ];
  const c = computePeriodComparison(history, writing, '2026-06-08', '2026-06-10');
  assert.equal(c.available, true);
  assert.equal(c.days, 3);
  assert.equal(c.prevFrom, '2026-06-05');
  assert.equal(c.prevTo, '2026-06-07');
  // cur chars: end(<=06-10)=2200 minus base(< 06-08 → 06-07)=1600 → 600.
  assert.equal(c.chars.cur, 600);
  // prev chars: end(<=06-07)=1600 minus base(< 06-05 → 06-04)=1000 → 600.
  assert.equal(c.chars.prev, 600);
  assert.equal(c.chars.pct, 0);
  // Schreibzeit: cur = 3600 (06-09), prev = 1200 (06-06).
  assert.equal(c.writingSeconds.cur, 3600);
  assert.equal(c.writingSeconds.prev, 1200);
  assert.equal(c.writingSeconds.pct, 200);
  assert.equal(c.writingSeconds.dir, 1);
});

test('computePeriodComparison: pct null wenn Vorperiode leer', () => {
  const c = computePeriodComparison([], [{ book_id: 1, date: '2026-06-09', seconds: 600 }],
                                     '2026-06-08', '2026-06-10');
  assert.equal(c.writingSeconds.prev, 0);
  assert.equal(c.writingSeconds.pct, null);
  assert.equal(c.writingSeconds.dir, 1);
});

test('computePeriodComparison: unvollstaendiges Fenster → not available', () => {
  assert.equal(computePeriodComparison([], [], null, '2026-06-10').available, false);
  assert.equal(computePeriodComparison([], [], '2026-06-10', null).available, false);
});

test('computeOverallForecast: summiert Rest + Tempo, prognostiziert Datum', () => {
  const goals = [
    { hasGoal: true, reached: false, remainingChars: 30000, recentDailyChars: 1000 },
    { hasGoal: true, reached: false, remainingChars: 20000, recentDailyChars: 1000 },
    { hasGoal: true, reached: true,  remainingChars: 0,     recentDailyChars: 500 }, // erreicht → ignoriert
    { hasGoal: false },                                                              // kein Ziel → ignoriert
  ];
  const f = computeOverallForecast(goals, new Date('2026-06-10T12:00:00'));
  assert.equal(f.hasData, true);
  assert.equal(f.booksOpen, 2);
  assert.equal(f.remainingChars, 50000);
  assert.equal(f.dailyChars, 2000);
  assert.equal(f.stalled, false);
  assert.equal(f.forecastDays, 25); // 50000 / 2000
});

test('computeOverallForecast: kein Tempo → stalled', () => {
  const f = computeOverallForecast([
    { hasGoal: true, reached: false, remainingChars: 10000, recentDailyChars: 0 },
  ]);
  assert.equal(f.hasData, true);
  assert.equal(f.stalled, true);
  assert.equal(f.forecastDate, null);
});

test('computeOverallForecast: keine offenen Ziele → hasData false', () => {
  assert.equal(computeOverallForecast([]).hasData, false);
  assert.equal(computeOverallForecast([{ hasGoal: true, reached: true, remainingChars: 0 }]).hasData, false);
});

test('computeVocabTrend: Summe unique_words + Trend ggue. ~30 Tagen', () => {
  const history = [
    { book_id: 1, recorded_at: isoDaysAgo(40), chars: 1000, unique_words: 500 },
    { book_id: 1, recorded_at: isoDaysAgo(1),  chars: 2000, unique_words: 900 },
    { book_id: 2, recorded_at: isoDaysAgo(1),  chars: 1000, unique_words: 300 },
  ];
  const v = computeVocabTrend(history);
  assert.equal(v.hasData, true);
  assert.equal(v.total, 1200);   // 900 + 300 (juengstes je Buch)
  assert.equal(v.trend, 1);      // gegen 500 vor ~30 Tagen gestiegen
});

test('computeVocabTrend: kein Wortschatz → hasData false', () => {
  assert.equal(computeVocabTrend([]).hasData, false);
});
