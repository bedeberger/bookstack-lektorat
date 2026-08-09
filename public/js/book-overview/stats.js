// Schreibstatistik-Tiles: Hero-Snapshot, Sparkline, 7-Tage-Bars, Heute-Ring,
// Streak-Heatmap. Visualisierungen als reines Inline-SVG (kein Chart.js) —
// Overview soll instant beim Buchwechsel sichtbar sein, ohne Lazy-Lib-Load.
//
// Memos, die lokalisierte Strings (Wochentage, Datums-Labels, Tooltips) mit
// backen, führen `this._uiLocale()` in ihren Deps — sonst bleiben die Labels
// nach einem Sprachwechsel auf der alten Sprache stehen.
import { localIsoDate, localIsoDaysAgo, aggregateLiveBookStats, CHARS_PER_NORMSEITE } from '../utils.js';
import { computeTodayRing, computeCharsTodayDelta } from '../today-ring.js';

export const statsMethods = {
  // Hero-Snapshot: live-aggregiert aus `tokEsts` (gleiche Quelle wie Sidebar-Σ),
  // damit Hero und Sidebar nach jedem Save sofort identisch sind. Cron-Snapshot
  // (book_stats_history) wird nur als Fallback genutzt, wenn tokEsts noch nicht
  // bereit ist (Buch eben gewechselt, Background-Estimate noch unterwegs).
  // Sparkline + 7-Tage-Balken lesen weiterhin overviewStats direkt — die
  // brauchen den historischen Verlauf.
  overviewLatest() {
    const app = window.__app;
    const tokEsts = app?.tokEsts || {};
    const pages = Alpine.store('nav').pages || [];
    const stats = this.overviewStats || [];
    // `tree` gehört in die Deps, weil chapter_count über _chapterRollup daraus
    // kommt: ein Umhängen/Umbenennen im Buchorganizer ändert den Tree, ohne
    // dass `pages` neu zugewiesen wird.
    const tree = Alpine.store('nav').tree || [];
    return this._memo('latest', [stats, tokEsts, pages, tree], () => {
      const ids = Object.keys(tokEsts);
      const histLast = stats.length ? stats[stats.length - 1] : null;
      if (!ids.length) return histLast;
      const { chars, words, tok } = aggregateLiveBookStats(tokEsts);
      const page_count = pages.length || ids.length;
      // chapter_count zählt nur Top-Level-Kapitel — Sub-Kapitel rollen auf Root.
      const { rootOf } = this._chapterRollup();
      const rootIds = new Set();
      for (const p of pages) {
        if (!p.chapter_id) continue;
        const root = rootOf(p.chapter_id);
        if (root) rootIds.add(Number(root.id));
      }
      const chapter_count = rootIds.size;
      return { ...(histLast || {}), chars, words, tok, page_count, chapter_count };
    });
  },

  // Single source of truth für „heute geschrieben". Nutzt Live-tokEsts wenn
  // vorhanden, sonst heutigen Cron-Snapshot. Vergleicht gegen jüngsten
  // Snapshot strikt vor heute (egal wie alt — verkraftet Wochenenden/Lücken).
  // Negative Deltas (Lösch-Edits) werden auf 0 geklemmt. Wird von Heute-Ring,
  // 7-Tage-Bar (heutige Spalte) und 7-Tage-Total konsumiert, damit alle drei
  // exakt dieselbe Zahl zeigen.
  _charsTodayDelta() {
    const a = this.overviewStats || [];
    const tokEsts = window.__app?.tokEsts || {};
    return this._memo('charsTodayDelta', [a, tokEsts], () =>
      computeCharsTodayDelta(a, tokEsts)
    );
  },

  // Letzte 7 Kalendertage. Pro Tag: Zeichen-Delta zum Vortags-Snapshot.
  // Vergangenheits-Tage strict (cur/prev exakte Kalendertage). Heute liest
  // _charsTodayDelta() — selbe Quelle wie Heute-Ring, damit Bar und Donut
  // nie auseinander driften.
  overviewLast7Days() {
    const a = this.overviewStats || [];
    const tokEsts = window.__app?.tokEsts || {};
    return this._memo('last7Days', [a, tokEsts, this._uiLocale()], () => {
      const charsByDate = new Map();
      for (const s of a) charsByDate.set(s.recorded_at, Number(s.chars) || 0);
      const fmt = this._dateFmt({ weekday: 'short' });
      const todayIso = localIsoDate();
      const todayDelta = this._charsTodayDelta();
      const days = [];
      for (let i = 6; i >= 0; i--) {
        const noon = new Date();
        noon.setHours(12, 0, 0, 0);
        noon.setDate(noon.getDate() - i);
        const iso = localIsoDate(noon);
        let delta;
        if (iso === todayIso) {
          delta = todayDelta;
        } else {
          const prevIso = localIsoDaysAgo(i + 1);
          const cur = charsByDate.get(iso);
          const prev = charsByDate.get(prevIso);
          delta = (cur != null && prev != null) ? (cur - prev) : 0;
        }
        days.push({ iso, label: fmt.format(noon), delta });
      }
      return days;
    });
  },

  // Skalierungs-Maximum für 7-Tage-Bars (abs, mind. 1 um Division-by-zero zu vermeiden).
  overviewLast7Max() {
    const days = this.overviewLast7Days();
    return this._memo('last7Max', [days], () =>
      Math.max(1, ...days.map(d => Math.abs(d.delta))));
  },

  overview7DayCharDelta() {
    const a = this.overviewStats;
    if (!a || a.length < 2) return null;
    const tokEsts = window.__app?.tokEsts || {};
    return this._memo('sevenDayDelta', [a, tokEsts], () => {
      // Latest = Live-Summe wenn vorhanden (raw, kein Math.max — sonst
      // gewinnt Cron-Snapshot bei Lösch-Edits und überzeichnet net-Delta).
      // Konsistent zu Heute-Ring (_charsTodayDelta).
      const liveChars = aggregateLiveBookStats(tokEsts).chars;
      const latestSnapshot = a[a.length - 1];
      const latestChars = liveChars > 0 ? liveChars : (Number(latestSnapshot.chars) || 0);
      const cutoff = localIsoDaysAgo(7);
      let earlier = null;
      for (let i = a.length - 2; i >= 0; i--) {
        if (a[i].recorded_at <= cutoff) { earlier = a[i]; break; }
      }
      if (!earlier) earlier = a[0];
      return latestChars - (Number(earlier.chars) || 0);
    });
  },

  // Sparkline-Daten + Polygon-Fläche darunter (Gradient-Fill).
  // Liefert { d, area, color, deltaPct, endX, endY, w, h, points } oder { d:null, ... } bei <2 Punkten.
  // `points`: pro Datenpunkt { chars, iso, label } für Hover-Overlay mit Datum + exaktem Wert.
  overviewSparkline() {
    const stats = this.overviewStats || [];
    return this._memo('sparkline', [stats, this._uiLocale()], () => {
      const W = 240, H = 48, PAD = 3;
      const slice = stats.slice(-30);
      const data = slice.map(s => Number(s.chars) || 0);
      if (data.length < 2) return { d: null, area: null, color: 'currentColor', deltaPct: 0, endX: 0, endY: 0, w: W, h: H, points: [] };
      const min = Math.min(...data);
      const max = Math.max(...data);
      const span = Math.max(1, max - min);
      const stepX = (W - 2 * PAD) / (data.length - 1);
      const pts = data.map((v, i) => {
        const x = PAD + i * stepX;
        const y = H - PAD - ((v - min) / span) * (H - 2 * PAD);
        return [x, y];
      });
      const d = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
      const area = d
        + ` L ${pts[pts.length - 1][0].toFixed(1)},${(H - PAD).toFixed(1)}`
        + ` L ${pts[0][0].toFixed(1)},${(H - PAD).toFixed(1)} Z`;
      const first = data[0];
      const last = data[data.length - 1];
      const deltaPct = first > 0 ? Math.round(((last - first) / first) * 100) : 0;
      const color = deltaPct > 0 ? 'var(--color-success)'
                  : deltaPct < 0 ? 'var(--color-err-border)'
                  :                'var(--color-accent)';
      const endX = pts[pts.length - 1][0];
      const endY = pts[pts.length - 1][1];
      const dateFmt = this._dateFmt({ day: 'numeric', month: 'short', year: 'numeric' });
      const numFmt = this._numFmt();
      const unit = window.__app?.t?.('bookstats.unit.z') || 'Z';
      const points = slice.map((s, i) => {
        const iso = s.recorded_at;
        let label;
        if (iso) {
          // Mittags-Anker: der Formatter rendert in appTimezone, ein
          // Mitternachts-Anker könnte dort auf den Vortag kippen.
          const dt = new Date(iso + 'T12:00:00');
          label = dateFmt.format(dt) + ': ' + numFmt.format(data[i]) + ' ' + unit;
        } else {
          label = numFmt.format(data[i]) + ' ' + unit;
        }
        return { chars: data[i], iso, label };
      });
      return { d, area, color, deltaPct, endX, endY, w: W, h: H, points };
    });
  },

  // Streak-Heatmap: 52 Wochen × 7 Tage GitHub-Stil, ausgehend von HEUTE
  // (rechte untere Ecke = heute, links = vor 1 Jahr). Pro Zelle Delta-Zeichen
  // zum Vortag aus overviewStats. Cells ohne Snapshot oder Future-Tage =
  // null (gerendert als leere Box, kein Tile). Level 0..4 nach Quartilen
  // der positiven Deltas; 0 = inactive (kein Schreiben), 1..4 = wachsende
  // Intensität. Der Zell-Tooltip wird hier einmal gebaut, nicht im Template:
  // 364 Zellen × Formatter + t() pro Reactive-Tick wäre die teuerste Schleife
  // der ganzen Karte.
  // Streak: konsekutive Tage mit positivem Delta endend HEUTE oder GESTERN
  // (heute ohne Eintrag bricht den Streak nicht — User hat nur noch nicht
  // geschrieben). Longest = Max-Run im Fenster.
  overviewStreakHeatmap() {
    const a = this.overviewStats || [];
    const tokEsts = window.__app?.tokEsts || {};
    return this._memo('streakHeatmap', [a, tokEsts, this._uiLocale()], () => {
      const WEEKS = 52;
      const charsByDate = new Map();
      for (const s of a) charsByDate.set(s.recorded_at, Number(s.chars) || 0);

      // Heute lokal — getDay() ist auf lokaler Mitternacht-Basis OK; isoToday
      // bewusst lokal, damit Lookup zu Server-Snapshots stimmt (Server muss
      // ebenfalls lokal schreiben — TZ env in docker).
      const todayLocal = new Date();
      todayLocal.setHours(12, 0, 0, 0); // Mittag → DST-Drift-sicher beim ±n*86_400_000
      const todayDow = todayLocal.getDay(); // 0 = So, 1 = Mo, ..., 6 = Sa
      const dowMon = (todayDow + 6) % 7; // Mo=0 ... So=6
      const startOffset = (WEEKS - 1) * 7 + dowMon;
      const isoToday = localIsoDate(todayLocal);
      const todayDelta = this._charsTodayDelta();

      const t = window.__app?.t || ((k) => k);
      const numFmt = this._numFmt();
      const tipFor = (iso, delta, hasSnapshot) => {
        if (delta != null && delta > 0) return t('overview.streak.cellTip', { date: iso, chars: numFmt.format(delta) });
        return hasSnapshot
          ? t('overview.streak.cellTipNoChange', { date: iso })
          : t('overview.streak.cellTipNone', { date: iso });
      };

      const grid = []; // weeks[col][row]
      const positive = [];
      for (let w = 0; w < WEEKS; w++) grid.push([null, null, null, null, null, null, null]);

      for (let i = 0; i < WEEKS * 7; i++) {
        const col = Math.floor(i / 7);
        const row = i % 7;
        const daysFromTodayCol = (WEEKS - 1) - col;
        const daysFromTodayRow = dowMon - row;
        const offsetDays = daysFromTodayCol * 7 + daysFromTodayRow;
        if (offsetDays < 0) {
          grid[col][row] = { iso: null, delta: null, level: 0, future: true, tip: null };
          continue;
        }
        const iso = localIsoDaysAgo(offsetDays, todayLocal);
        const prevIso = localIsoDaysAgo(offsetDays + 1, todayLocal);
        const cur = charsByDate.get(iso);
        const prev = charsByDate.get(prevIso);
        const hasSnapshot = cur != null;
        let delta;
        if (iso === isoToday) {
          delta = todayDelta > 0 ? todayDelta : (hasSnapshot && prev != null ? cur - prev : null);
        } else {
          delta = (hasSnapshot && prev != null) ? (cur - prev) : (hasSnapshot ? 0 : null);
        }
        const snap = hasSnapshot || (iso === isoToday && todayDelta > 0);
        const cell = { iso, delta, level: 0, future: false, hasSnapshot: snap, tip: tipFor(iso, delta, snap) };
        if (delta != null && delta > 0) positive.push(delta);
        grid[col][row] = cell;
      }

      // Quartil-Bucketing für Level 1..4 auf positiven Deltas
      const sorted = [...positive].sort((a, b) => a - b);
      const q = (p) => sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
      const t1 = q(0.25), t2 = q(0.5), t3 = q(0.75);
      for (let w = 0; w < WEEKS; w++) {
        for (let r = 0; r < 7; r++) {
          const c = grid[w][r];
          if (!c || c.delta == null || c.delta <= 0) { if (c) c.level = 0; continue; }
          if (c.delta <= t1) c.level = 1;
          else if (c.delta <= t2) c.level = 2;
          else if (c.delta <= t3) c.level = 3;
          else c.level = 4;
        }
      }

      // Streaks: lineare Tagesreihe in chronologischer Reihenfolge bauen
      // (älteste links). Aktuelle Streak = Tail-Run > 0; ein heutiges
      // Null-Delta (noch nicht geschrieben) bricht NICHT, gestriges Null
      // schon. Heute-Eintrag nutzt todayDelta (Live-aware), sonst nur snapshots.
      const linear = [];
      for (let off = startOffset; off >= 0; off--) {
        const iso = localIsoDaysAgo(off, todayLocal);
        const prevIso = localIsoDaysAgo(off + 1, todayLocal);
        const cur = charsByDate.get(iso);
        const prev = charsByDate.get(prevIso);
        let delta;
        if (iso === isoToday) {
          delta = todayDelta > 0 ? todayDelta : (cur != null && prev != null ? cur - prev : null);
        } else {
          delta = (cur != null && prev != null) ? (cur - prev) : null;
        }
        linear.push({ iso, delta });
      }

      let longest = 0, run = 0;
      for (const x of linear) {
        if (x.delta != null && x.delta > 0) { run++; if (run > longest) longest = run; }
        else run = 0;
      }
      // Aktueller Streak: vom Ende rückwärts; heutiges null überspringen
      let current = 0;
      for (let i = linear.length - 1; i >= 0; i--) {
        const x = linear[i];
        if (i === linear.length - 1 && (x.delta == null || x.delta === 0)) continue;
        if (x.delta != null && x.delta > 0) current++;
        else break;
      }
      const totalActiveDays = linear.filter(x => x.delta != null && x.delta > 0).length;

      const dayFmt = this._dateFmt({ weekday: 'short' });
      const dayLabels = [];
      // Wochenstart Mo: nehme einen Mo als Referenz (z.B. 4. Jan 2027 ist Mo)
      const monRef = new Date(2027, 0, 4); // 2027-01-04 ist Mo
      for (let i = 0; i < 7; i++) {
        dayLabels.push(dayFmt.format(new Date(monRef.getTime() + i * 86400000)));
      }

      return {
        weeks: grid,
        weeksCount: WEEKS,
        currentStreak: current,
        longestStreak: longest,
        totalActiveDays,
        dayLabels,
      };
    });
  },

  // Heute-Ring: Donut-Math für Tagesziel. Shared Compute mit dem Header-Donut
  // ueber [public/js/today-ring.js] — beide bleiben deckungsgleich. Memo
  // verhindert Re-Compute pro Render (Tile ruft die Methode 6× pro Render).
  overviewTodayRing(goalChars) {
    const a = this.overviewStats || [];
    const tokEsts = window.__app?.tokEsts || {};
    // Goal: expliziter Buch-Wert (book_settings.daily_goal_chars) vor
    // Default = eine Normseite/Tag. Auflösung hier statt im Template, damit
    // das Charts-Partial die Methode argumentlos aufrufen kann.
    const goal = Math.max(1, Number(goalChars) || this.overviewDailyGoalChars || CHARS_PER_NORMSEITE);
    return this._memo('todayRing:' + goal, [a, tokEsts], () =>
      computeTodayRing({ stats: a, tokEsts, goalChars: goal, r: 28 })
    );
  },
};
