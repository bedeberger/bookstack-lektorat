// Schreibstatistik-Tiles: Hero-Snapshot, Sparkline, 7-Tage-Bars, Heute-Ring,
// Streak-Heatmap. Visualisierungen als reines Inline-SVG (kein Chart.js) —
// Overview soll instant beim Buchwechsel sichtbar sein, ohne Lazy-Lib-Load.
//
// Memos, die lokalisierte Strings (Wochentage, Datums-Labels, Tooltips) mit
// backen, führen `this._uiLocale()` in ihren Deps — sonst bleiben die Labels
// nach einem Sprachwechsel auf der alten Sprache stehen.
import { localIsoDate, localIsoDaysAgo, aggregateLiveBookStats, CHARS_PER_NORMSEITE } from '../utils.js';
import { computeTodayRing, computeCharsTodayDelta, makeDayDelta } from '../today-ring.js';
import { buildStreakGrid } from '../streak-grid.js';

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

  // Tagesbilanz-Funktion des aktuellen Buchs. SSoT ist makeDayDelta in
  // [public/js/today-ring.js] — dieselbe Regel, aus der das Header-Popover
  // seine 7-Tage-Balken und seine Schreib-Serie zieht. Die Kachel und der
  // Header lesen ohnehin dieselbe /history/book-stats-Antwort; eine eigene
  // Delta-Regel hier hiesse, fuer denselben Tag zwei Zahlen zu zeigen.
  _dayDelta() {
    const a = this.overviewStats || [];
    const tokEsts = window.__app?.tokEsts || {};
    return this._memo('dayDelta', [a, tokEsts], () => makeDayDelta({ stats: a, tokEsts }));
  },

  // Letzte 7 Kalendertage. Pro Tag die Netto-Zeichenbilanz aus _dayDelta().
  // Anders als der Header-Balken (Ziel-Fortschritt) behaelt die Kachel das
  // VORZEICHEN: ein Tag, an dem mehr geloescht als geschrieben wurde, ist hier
  // eine Aussage und bekommt einen Balken nach unten.
  overviewLast7Days() {
    const a = this.overviewStats || [];
    const tokEsts = window.__app?.tokEsts || {};
    return this._memo('last7Days', [a, tokEsts, this._uiLocale()], () => {
      const dayDelta = this._dayDelta();
      const fmt = this._dateFmt({ weekday: 'short' });
      const days = [];
      for (let i = 6; i >= 0; i--) {
        const noon = new Date();
        noon.setHours(12, 0, 0, 0);
        noon.setDate(noon.getDate() - i);
        const iso = localIsoDate(noon);
        days.push({ iso, label: fmt.format(noon), delta: dayDelta(iso) ?? 0 });
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
      // Konsistent zum Heute-Ring (computeCharsTodayDelta).
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
  // (rechte untere Ecke = heute, links = vor 1 Jahr). Raster, Einfaerbung und
  // Serien-Zaehlung liegen in [public/js/streak-grid.js] — geteilt mit der
  // Schreibzeit-Heatmap in „Meine Statistik"; hier bleibt nur der Tageswert
  // (Zeichenbilanz) und der Zell-Tooltip.
  //
  // Der Tooltip wird hier einmal gebaut, nicht im Template: 364 Zellen ×
  // Formatter + t() pro Reactive-Tick waere die teuerste Schleife der Karte.
  // Er unterscheidet drei Lagen, und darum ist `null` als Tageswert nicht
  // dasselbe wie `0`: nichts geschrieben vs. gar keine Datenlage.
  overviewStreakHeatmap() {
    const a = this.overviewStats || [];
    const tokEsts = window.__app?.tokEsts || {};
    return this._memo('streakHeatmap', [a, tokEsts, this._uiLocale()], () => {
      const dayDelta = this._dayDelta();
      const t = window.__app?.t || ((k) => k);
      const numFmt = this._numFmt();
      return buildStreakGrid({
        valueForIso: dayDelta,
        decorate: (cell) => {
          if (cell.future) return { delta: null, tip: null };
          const delta = cell.value;
          const tip = delta != null && delta > 0
            ? t('overview.streak.cellTip', { date: cell.iso, chars: numFmt.format(delta) })
            : delta != null
              ? t('overview.streak.cellTipNoChange', { date: cell.iso })
              : t('overview.streak.cellTipNone', { date: cell.iso });
          // `delta` bleibt als sprechender Alias am Zell-Objekt: die Kachel
          // spricht von Zeichen, nicht von einem generischen `value`.
          return { delta, tip };
        },
      });
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
