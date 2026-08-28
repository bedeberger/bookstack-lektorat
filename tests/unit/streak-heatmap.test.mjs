// Tests für Streak-Heatmap und Heute-Ring (book-overview.js).
// Methoden lesen this.overviewStats; wir bauen ein synthetisches Stats-Array
// mit definierten Tages-Snapshots (recorded_at = ISO-Datum, chars = kumuliert).
import test from 'node:test';
import assert from 'node:assert/strict';

// book-overview.js liest die UI-Locale aus Alpine.store('shell').uiLocale
// (Wochentag-Labels) und nav-Daten aus Alpine.store('nav'). In Node ohne DOM
// stubben wir window + Alpine minimal vor dem Import; 'nav' delegiert an
// window.__app (Tests setzen dort tokEsts), 'shell' liefert die Locale.
globalThis.window = { __app: { uiLocale: 'de' } };
globalThis.Alpine = { store: (n) => (n === 'nav' ? (globalThis.window?.__app || {}) : (n === 'shell' ? { uiLocale: 'de' } : {})) };

const { bookOverviewMethods } = await import('../../public/js/book-overview.js');

// Tests verwenden den gleichen Helper wie Production-Code (lokales Datum,
// kein UTC). Sentinel gegen das alte UTC-Datum-Problem in
// tests/unit/local-date.test.mjs.
import { localIsoDaysAgo, localIsoDate } from '../../public/js/utils.js';
import { computeWeekBars } from '../../public/js/today-ring.js';
function isoDaysAgo(n) { return localIsoDaysAgo(n); }

function makeCtx(stats = [], tokEsts = null) {
  if (tokEsts !== null) globalThis.window.__app.tokEsts = tokEsts;
  else globalThis.window.__app.tokEsts = {};
  // Ganze Facade spreaden statt Methoden einzeln durchzureichen: die Stats-
  // Methoden greifen quer auf Helper anderer Submodule zu (_memo aus load,
  // _uiLocale/_numFmt/_dateFmt aus format).
  return {
    overviewStats: stats,
    _memos: {},
    ...bookOverviewMethods,
  };
}

test('overviewStreakHeatmap: leere Daten → Streak 0', () => {
  const ctx = makeCtx([]);
  const out = ctx.overviewStreakHeatmap();
  assert.equal(out.currentStreak, 0);
  assert.equal(out.longestStreak, 0);
  assert.equal(out.totalActiveDays, 0);
  assert.equal(out.weeks.length, 52);
});

test('overviewStreakHeatmap: drei aufeinanderfolgende Tage mit Wachstum → currentStreak 3', () => {
  // gestern, vorgestern, vor-vorgestern jeweils +500 Zeichen vs Vortag
  const stats = [
    { recorded_at: isoDaysAgo(4), chars: 1000 },
    { recorded_at: isoDaysAgo(3), chars: 1500 },
    { recorded_at: isoDaysAgo(2), chars: 2000 },
    { recorded_at: isoDaysAgo(1), chars: 2500 },
  ];
  const ctx = makeCtx(stats);
  const out = ctx.overviewStreakHeatmap();
  assert.ok(out.currentStreak >= 3, `currentStreak = ${out.currentStreak}`);
  assert.ok(out.totalActiveDays >= 3);
});

test('overviewStreakHeatmap: Lücke zwischen Schreibtagen bricht aktuellen Streak', () => {
  // Vor 5 Tagen, vor 4 Tagen geschrieben; vor 3 + 2 + 1 nichts mehr.
  const stats = [
    { recorded_at: isoDaysAgo(6), chars: 1000 },
    { recorded_at: isoDaysAgo(5), chars: 1500 },
    { recorded_at: isoDaysAgo(4), chars: 2000 },
    { recorded_at: isoDaysAgo(3), chars: 2000 },
    { recorded_at: isoDaysAgo(2), chars: 2000 },
    { recorded_at: isoDaysAgo(1), chars: 2000 },
  ];
  const ctx = makeCtx(stats);
  const out = ctx.overviewStreakHeatmap();
  assert.equal(out.currentStreak, 0, 'aktueller Streak gebrochen');
  assert.ok(out.longestStreak >= 2, 'longest dokumentiert die früheren 2 Tage');
});

test('overviewStreakHeatmap: Levels 1..4 nach Quartilen', () => {
  // Sechs Tage mit unterschiedlich grossen Deltas
  const stats = [
    { recorded_at: isoDaysAgo(7), chars: 0 },
    { recorded_at: isoDaysAgo(6), chars: 100 },
    { recorded_at: isoDaysAgo(5), chars: 300 },
    { recorded_at: isoDaysAgo(4), chars: 700 },
    { recorded_at: isoDaysAgo(3), chars: 1500 },
    { recorded_at: isoDaysAgo(2), chars: 3000 },
    { recorded_at: isoDaysAgo(1), chars: 6000 },
  ];
  const ctx = makeCtx(stats);
  const out = ctx.overviewStreakHeatmap();
  // Mindestens drei verschiedene Levels in den Cells
  const levels = new Set();
  for (const w of out.weeks) for (const c of w) if (c && c.level > 0) levels.add(c.level);
  assert.ok(levels.size >= 3, `nur ${levels.size} Levels gefunden: ${[...levels]}`);
});

test('overviewTodayRing: kein Snapshot, keine tokEsts → 0 chars, 0 pct', () => {
  const ctx = makeCtx([], {});
  const r = ctx.overviewTodayRing(1500);
  assert.equal(r.chars, 0);
  assert.equal(r.pct, 0);
  assert.equal(r.active, false);
});

test('overviewTodayRing: heute +500 (cron-Snapshot) / Ziel 1500 → ~33%', () => {
  // tokEsts leer → fallback auf Cron-Snapshot
  const stats = [
    { recorded_at: isoDaysAgo(1), chars: 1000 },
    { recorded_at: isoDaysAgo(0), chars: 1500 },
  ];
  const ctx = makeCtx(stats, {});
  const r = ctx.overviewTodayRing(1500);
  assert.equal(r.chars, 500);
  assert.equal(r.pct, 33);
  assert.equal(r.active, true);
  assert.equal(r.reached, false);
});

test('overviewTodayRing: Ziel überschritten → pct gekappt auf 100, reached=true', () => {
  const stats = [
    { recorded_at: isoDaysAgo(1), chars: 1000 },
    { recorded_at: isoDaysAgo(0), chars: 5000 },
  ];
  const ctx = makeCtx(stats, {});
  const r = ctx.overviewTodayRing(1500);
  assert.equal(r.pct, 100);
  assert.equal(r.reached, true);
});

test('overviewTodayRing: Lösch-Edits (negative Delta) → 0 chars, nicht aktiv', () => {
  const stats = [
    { recorded_at: isoDaysAgo(1), chars: 5000 },
    { recorded_at: isoDaysAgo(0), chars: 4000 },
  ];
  const ctx = makeCtx(stats, {});
  const r = ctx.overviewTodayRing(1500);
  assert.equal(r.chars, 0);
  assert.equal(r.active, false);
});

test('overviewTodayRing: Lücke (gestern fehlt) → Fallback auf vor-vorgestern', () => {
  // Bug-Fix-Sentinel: User schrieb gestern nicht, heute synced → vor-2-Tagen
  // ist jüngster prior Snapshot. Vorher zählte das als „erste Messung" → 0.
  const stats = [
    { recorded_at: isoDaysAgo(2), chars: 1000 },
    { recorded_at: isoDaysAgo(0), chars: 1750 },
  ];
  const ctx = makeCtx(stats, {});
  const r = ctx.overviewTodayRing(1500);
  assert.equal(r.chars, 750);
  assert.equal(r.active, true);
});

test('overviewTodayRing: Live-tokEsts überschreiben Cron-Snapshot', () => {
  // Cron-Snapshot heute = 1500, Live-tokEsts addieren 800 mehr drauf →
  // Frontend zeigt sofort Delta vom prior Snapshot zu Live-Stand.
  const stats = [
    { recorded_at: isoDaysAgo(1), chars: 1000 },
    { recorded_at: isoDaysAgo(0), chars: 1500 },
  ];
  const tokEsts = { 1: { chars: 1500 }, 2: { chars: 800 } };
  const ctx = makeCtx(stats, tokEsts);
  const r = ctx.overviewTodayRing(1500);
  assert.equal(r.chars, 1300); // 2300 (live) - 1000 (gestern)
  assert.equal(r.active, true);
});

test('overviewTodayRing: nur Live-tokEsts, kein Snapshot → 0 (kein Vergleich möglich)', () => {
  // Erstaufruf vor erstem Sync: tokEsts vorhanden, history leer.
  // Cumulative-Stand wäre falsche Anzeige, daher 0.
  const tokEsts = { 1: { chars: 5000 } };
  const ctx = makeCtx([], tokEsts);
  const r = ctx.overviewTodayRing(1500);
  assert.equal(r.chars, 0);
  assert.equal(r.active, false);
});

test('overviewTodayRing: nur prior Snapshot, kein heute, kein Live → 0', () => {
  const stats = [{ recorded_at: isoDaysAgo(3), chars: 1000 }];
  const ctx = makeCtx(stats, {});
  const r = ctx.overviewTodayRing(1500);
  assert.equal(r.chars, 0);
  assert.equal(r.active, false);
});

test('overviewTodayRing: SVG-Math konsistent (dash + gap = circumference)', () => {
  const ctx = makeCtx([]);
  const r = ctx.overviewTodayRing(1500);
  const sum = r.dash + r.gap;
  assert.ok(Math.abs(sum - r.c) < 0.001, `dash+gap=${sum}, c=${r.c}`);
});

// ── Konsistenz-Sentinels: Donut, 7-Tage-Bar (today), 7-Tage-Total
//    MÜSSEN dieselbe Zahl für „heute" zeigen. Vorher drifteten die Methoden
//    auseinander (Math.max in Bar/Total liess Cron-Snapshot bei Lösch-Edits
//    gewinnen, Donut zeigte raw live → 3'004 vs 1'212-Bug).
test('Konsistenz: Donut == 7-Tage-Bar today (User schreibt nach Sync)', () => {
  // Cron lief heute @ +500 chars vs gestern. User schrieb dann +800 mehr.
  const stats = [
    { recorded_at: isoDaysAgo(1), chars: 1000 },
    { recorded_at: isoDaysAgo(0), chars: 1500 },
  ];
  const tokEsts = { 1: { chars: 2300 } }; // live = 2300 → delta = 1300
  const ctx = makeCtx(stats, tokEsts);
  const donut = ctx.overviewTodayRing(1500).chars;
  const days = ctx.overviewLast7Days();
  const todayBar = days[days.length - 1].delta;
  assert.equal(donut, todayBar, `Donut ${donut} != Bar ${todayBar}`);
  assert.equal(donut, 1300);
});

test('Konsistenz: Donut == 7-Tage-Bar today (User löscht nach Sync)', () => {
  // Bug-Fix-Sentinel: cron snapshot zeigt heute +3000, aber User hat
  // gelöscht → live = +1212. Vorher: Bar zeigte 3000, Donut 1212.
  const stats = [
    { recorded_at: isoDaysAgo(1), chars: 17828 },
    { recorded_at: isoDaysAgo(0), chars: 20832 }, // cron: +3004
  ];
  const tokEsts = { 1: { chars: 19040 } }; // live: +1212 (gelöscht)
  const ctx = makeCtx(stats, tokEsts);
  const donut = ctx.overviewTodayRing(1500).chars;
  const days = ctx.overviewLast7Days();
  const todayBar = days[days.length - 1].delta;
  assert.equal(donut, todayBar, `Donut ${donut} != Bar ${todayBar} (Math.max-Bug)`);
  assert.equal(donut, 1212);
});

test('Konsistenz: Donut == Tagesbilanz von heute (makeDayDelta)', () => {
  // Single source of truth: der Ring und jede Tages-Kachel lesen dieselbe
  // Tagesbilanz-Funktion aus today-ring.js.
  const stats = [
    { recorded_at: isoDaysAgo(2), chars: 1000 },
    { recorded_at: isoDaysAgo(0), chars: 1500 },
  ];
  const ctx = makeCtx(stats, {});
  const donut = ctx.overviewTodayRing(1500).chars;
  const viaDayDelta = ctx._dayDelta()(localIsoDate());
  assert.equal(donut, viaDayDelta);
  assert.equal(donut, 500);
});

test('Streak: heute-Cell colored auch nach reassign von tokEsts (Memo-Invalidate-Sentinel)', () => {
  // Bug-Fix-Sentinel: book-overview Auto-Sync nutzt index-assign auf tokEsts;
  // _memoN cached aber per Ref-Identität. Index-Assign hält dieselbe Referenz
  // → Cache-Hit → stale Streak. Fix: reassign nach Sync.
  // Test simuliert: erster Render mit leerem tokEsts (cache speichern), dann
  // tokEsts mit neuer Ref ersetzen, zweiter Render muss recomputen.
  const stats = [
    { recorded_at: isoDaysAgo(2), chars: 1000 },
    { recorded_at: isoDaysAgo(0), chars: 2200 },
  ];
  const ctx = makeCtx(stats, {}); // erst leer
  ctx.overviewStreakHeatmap(); // primed cache
  // tokEsts-Ref ändern (reassign)
  globalThis.window.__app.tokEsts = { 1: { chars: 2500 } };
  const out = ctx.overviewStreakHeatmap();
  // Cache muss invalidieren — wenn nicht, Streak hätte alte Werte
  let coloredCells = 0;
  for (const w of out.weeks) for (const c of w) if (c?.level > 0) coloredCells++;
  assert.ok(coloredCells >= 1, `nach reassign mind. 1 colored cell, hatte ${coloredCells}`);
});

test('Streak: heute-Cell colored auch wenn nur Live-tokEsts (kein heutiger Snapshot)', () => {
  // Bug-Fix-Sentinel: Streak war leer wenn heute kein Cron-Snapshot, obwohl
  // tokEsts > prior snapshot. currentStreak musste 0 sein.
  const stats = [
    { recorded_at: isoDaysAgo(1), chars: 1000 },
    // kein heutiger snapshot
  ];
  const tokEsts = { 1: { chars: 2500 } }; // live: +1500 vs gestern
  const ctx = makeCtx(stats, tokEsts);
  const out = ctx.overviewStreakHeatmap();
  assert.ok(out.currentStreak >= 1, `currentStreak = ${out.currentStreak}, sollte ≥ 1`);
  assert.ok(out.totalActiveDays >= 1);
  // Heute-Cell hat positives Delta → in positive[] → mind. ein Level > 0
  let coloredCells = 0;
  for (const w of out.weeks) for (const c of w) if (c?.level > 0) coloredCells++;
  assert.ok(coloredCells >= 1, 'mindestens eine Cell colored');
});

test('Ausgefallener Cron-Tag verschluckt den Folgetag nicht (Carry-Forward)', () => {
  // Regressions-Sentinel: Snapshots fuer d-4 und d-2, d-3 fehlt (Cron lief
  // nicht). Ohne Nachziehen des letzten Standes war der Vortagswert von d-2
  // unbekannt und die an dem Tag geschriebenen 2000 Zeichen fielen aus jeder
  // Bilanz — waehrend das Header-Popover sie zeigte.
  const stats = [
    { recorded_at: isoDaysAgo(4), chars: 1000 },
    { recorded_at: isoDaysAgo(2), chars: 3000 },
  ];
  const ctx = makeCtx(stats, {});
  const byIso = new Map(ctx.overviewLast7Days().map(d => [d.iso, d.delta]));
  assert.equal(byIso.get(isoDaysAgo(3)), 0, 'Lueckentag: gemessener Nulltag');
  assert.equal(byIso.get(isoDaysAgo(2)), 2000, 'Folgetag behaelt seine Zeichen');
});

test('Konsistenz: 7-Tage-Kachel == Header-Popover-Balken (gleiche Datenquelle)', () => {
  // Beide lesen dieselbe /history/book-stats-Antwort und dasselbe tokEsts.
  // Der Header klemmt auf 0 (Ziel-Semantik), die Kachel behaelt das Vorzeichen
  // (Netto-Bilanz) — abgesehen davon MUESSEN sie Tag fuer Tag uebereinstimmen.
  const stats = [
    { recorded_at: isoDaysAgo(6), chars: 500 },
    { recorded_at: isoDaysAgo(5), chars: 1800 },
    { recorded_at: isoDaysAgo(3), chars: 4000 },
    { recorded_at: isoDaysAgo(2), chars: 3200 },
    { recorded_at: isoDaysAgo(1), chars: 5000 },
  ];
  const tokEsts = { 1: { chars: 6400 } };
  const ctx = makeCtx(stats, tokEsts);
  const tile = ctx.overviewLast7Days();
  const header = computeWeekBars({ stats, tokEsts, days: 7 });
  assert.equal(tile.length, header.length);
  for (let i = 0; i < tile.length; i++) {
    assert.equal(tile[i].iso, header[i].iso, `Tag ${i}: gleicher Kalendertag`);
    assert.equal(Math.max(0, tile[i].delta), header[i].chars,
      `Tag ${tile[i].iso}: Kachel ${tile[i].delta} vs. Header ${header[i].chars}`);
  }
  // Der Loesch-Tag ist in der Kachel negativ und im Header 0 — genau der
  // beabsichtigte Unterschied, nicht Drift.
  const del = tile.find(d => d.iso === isoDaysAgo(2));
  assert.equal(del.delta, -800);
});
