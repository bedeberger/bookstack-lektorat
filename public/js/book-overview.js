// Buch-Übersicht: Default-Landing beim Öffnen eines Buchs.
// Aggregiert ohne neuen KI-Job aus existierenden Endpoints:
//   /history/book-stats/:book_id    → Snapshot-Verlauf (Wortzahl-Sparkline + Last-Snapshot)
//   /history/coverage/:book_id      → Lektorat-Abdeckung
//   /history/fehler-heatmap/:book_id → Top-Fehlertypen (mode=open)
//   /history/review/:book_id        → letzte Bewertung
//   /usage/page/recent              → zuletzt geöffnete Seiten
//   /figures/:book_id, /figures/scenes/:book_id → Figuren/Szenen-Counts + Top-Figuren
import { fetchJson } from './utils.js';

// Sparkline-/Donut-/Bar-Visualisierungen sind reines Inline-SVG (kein Chart.js):
// Overview soll instant beim Buchwechsel sichtbar sein, ohne Lazy-Lib-Load.

export const bookOverviewMethods = {
  async loadBookOverview(bookId) {
    if (!bookId) return;
    this.overviewLoading = true;
    this.overviewBookId = bookId;
    try {
      const [stats, coverage, heat, reviews, recent, figuren, szenen] = await Promise.all([
        fetchJson(`/history/book-stats/${bookId}`).catch(() => []),
        fetchJson(`/history/coverage/${bookId}`).catch(() => null),
        fetchJson(`/history/fehler-heatmap/${bookId}?mode=open`).catch(() => null),
        fetchJson(`/history/review/${bookId}`).catch(() => []),
        fetchJson(`/usage/page/recent?book_id=${bookId}&limit=5`).catch(() => []),
        fetchJson(`/figures/${bookId}`).catch(() => null),
        fetchJson(`/figures/scenes/${bookId}`).catch(() => null),
      ]);
      if (this.overviewBookId !== bookId) return;
      this.overviewStats = Array.isArray(stats) ? stats : [];
      this.overviewCoverage = coverage || null;
      this.overviewHeat = heat || null;
      const reviewArr = Array.isArray(reviews) ? reviews : [];
      this.overviewLastReview = reviewArr[0] || null;
      this.overviewPrevReview = reviewArr[1] || null;
      this.overviewRecent = Array.isArray(recent) ? recent : [];
      this.overviewFiguren = Array.isArray(figuren?.figuren) ? figuren.figuren : [];
      const sz = Array.isArray(szenen?.szenen) ? szenen.szenen : [];
      this.overviewSzenen = sz;
    } catch (e) {
      console.error('[loadBookOverview]', e);
    } finally {
      if (this.overviewBookId === bookId) this.overviewLoading = false;
    }
  },

  resetBookOverview() {
    this.overviewStats = [];
    this.overviewCoverage = null;
    this.overviewHeat = null;
    this.overviewLastReview = null;
    this.overviewPrevReview = null;
    this.overviewRecent = [];
    this.overviewFiguren = [];
    this.overviewSzenen = [];
    this.overviewBookId = null;
  },

  // ── Aggregate ────────────────────────────────────────────────────────────
  // Methoden statt Getter: `Alpine.data({ ...methods })` würde Getter beim
  // Spread evaluieren (Object-Spread kopiert Werte, nicht Descriptors), und
  // alle Karten hätten den Initial-Eval-Wert eingefroren. Methoden werden im
  // Template mit `()` aufgerufen und greifen reaktiv auf this.overviewXxx zu.
  overviewLatest() {
    const a = this.overviewStats;
    return (a && a.length) ? a[a.length - 1] : null;
  },

  overviewFigurenCount() { return (this.overviewFiguren || []).length; },
  overviewSzenenCount()  { return (this.overviewSzenen || []).length; },

  overviewSzenenWertung() {
    const sz = this.overviewSzenen || [];
    const out = { stark: 0, mittel: 0, schwach: 0, ohne: 0 };
    for (const s of sz) {
      if (s.wertung === 'stark') out.stark++;
      else if (s.wertung === 'mittel') out.mittel++;
      else if (s.wertung === 'schwach') out.schwach++;
      else out.ohne++;
    }
    return out;
  },

  // Top-3 Figuren nach Total-Erwähnungen über alle Kapitel.
  // figuren[].kapitel: [{ name, haeufigkeit }]
  overviewTopFiguren() {
    const figs = this.overviewFiguren || [];
    return figs
      .map(f => ({
        id: f.id,
        name: f.name,
        kurzname: f.kurzname,
        rolle: f.rolle || null,
        mentions: (f.kapitel || []).reduce((s, k) => s + (Number(k.haeufigkeit) || 0), 0),
      }))
      .sort((a, b) => b.mentions - a.mentions)
      .slice(0, 3);
  },

  // Letzte 7 Kalendertage. Pro Tag: Zeichen-Delta zum Vortags-Snapshot.
  // Tage ohne Snapshot bekommen 0. Locale-bewusste Wochentag-Labels (Mo/Di/...).
  overviewLast7Days() {
    const a = this.overviewStats || [];
    // Map recorded_at → chars
    const charsByDate = new Map();
    for (const s of a) charsByDate.set(s.recorded_at, Number(s.chars) || 0);
    const tag = window.__app?.uiLocale === 'en' ? 'en-US' : 'de-CH';
    const fmt = new Intl.DateTimeFormat(tag, { weekday: 'short' });
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const iso = d.toISOString().slice(0, 10);
      const prevIso = new Date(d.getTime() - 86400000).toISOString().slice(0, 10);
      const cur = charsByDate.get(iso);
      const prev = charsByDate.get(prevIso);
      // Delta nur, wenn beide Snapshots existieren — sonst 0 (Sync-Lücke).
      const delta = (cur != null && prev != null) ? (cur - prev) : 0;
      days.push({ iso, label: fmt.format(d), delta });
    }
    return days;
  },

  // Skalierungs-Maximum für 7-Tage-Bars (abs, mind. 1 um Division-by-zero zu vermeiden).
  overviewLast7Max() {
    const days = this.overviewLast7Days();
    return Math.max(1, ...days.map(d => Math.abs(d.delta)));
  },

  overview7DayCharDelta() {
    const a = this.overviewStats;
    if (!a || a.length < 2) return null;
    const latest = a[a.length - 1];
    const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    let earlier = null;
    for (let i = a.length - 2; i >= 0; i--) {
      if (a[i].recorded_at <= cutoff) { earlier = a[i]; break; }
    }
    if (!earlier) earlier = a[0];
    return (Number(latest.chars) || 0) - (Number(earlier.chars) || 0);
  },

  // Sparkline-Daten + Polygon-Fläche darunter (Gradient-Fill).
  // Liefert { d, area, color, deltaPct, endX, endY, w, h } oder { d:null, ... } bei <2 Punkten.
  overviewSparkline() {
    const W = 240, H = 48, PAD = 3;
    const data = (this.overviewStats || []).slice(-30).map(s => Number(s.words) || 0);
    if (data.length < 2) return { d: null, area: null, color: 'currentColor', deltaPct: 0, endX: 0, endY: 0, w: W, h: H };
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
    // Geschlossener Polygon-Pfad für Gradient-Fläche unter der Linie.
    const area = d
      + ` L ${pts[pts.length - 1][0].toFixed(1)},${(H - PAD).toFixed(1)}`
      + ` L ${pts[0][0].toFixed(1)},${(H - PAD).toFixed(1)} Z`;
    const first = data[0];
    const last = data[data.length - 1];
    const deltaPct = first > 0 ? Math.round(((last - first) / first) * 100) : 0;
    const color = deltaPct > 0 ? 'var(--color-success, #4caf50)'
                : deltaPct < 0 ? 'var(--color-danger, #d32f2f)'
                :                'var(--color-accent)';
    const endX = pts[pts.length - 1][0];
    const endY = pts[pts.length - 1][1];
    return { d, area, color, deltaPct, endX, endY, w: W, h: H };
  },

  // Donut-Math für Coverage-Ring. Stroke-Dasharray-Approach: kein <path>-Arc nötig.
  // CIRC = 2π·r — 100% = vollständig sichtbarer Stroke.
  overviewCoverageRing() {
    const pct = Math.max(0, Math.min(100, this.overviewCoverage?.pct ?? 0));
    const r = 28;
    const c = 2 * Math.PI * r;
    return { r, c, dash: (pct / 100) * c, gap: c - (pct / 100) * c, pct };
  },

  overviewTopFehler() {
    const totals = this.overviewHeat?.totals || {};
    const arr = Object.entries(totals)
      .map(([typ, count]) => ({ typ, count }))
      .filter(e => e.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);
    if (arr.length === 0) return arr;
    const max = arr[0].count;
    return arr.map(e => ({ ...e, pct: Math.max(8, Math.round((e.count / max) * 100)) }));
  },

  // Sterne-Rendering: gesamtnote 0..6, Score in halbe Sterne aufgelöst.
  // Liefert Array von 6 Einträgen: {full, half, empty} (jeweils boolean).
  overviewStars(score) {
    const s = Math.max(0, Math.min(6, Number(score) || 0));
    const out = [];
    for (let i = 1; i <= 6; i++) {
      if (s >= i) out.push({ full: true });
      else if (s >= i - 0.5) out.push({ half: true });
      else out.push({ empty: true });
    }
    return out;
  },

  // Trend zur Vorbewertung: Delta in Sternen, klein (für Pfeil ↑/↓/→).
  overviewReviewTrend() {
    const cur = Number(this.overviewLastReview?.review_json?.gesamtnote);
    const prev = Number(this.overviewPrevReview?.review_json?.gesamtnote);
    if (!Number.isFinite(cur) || !Number.isFinite(prev)) return null;
    const delta = cur - prev;
    if (Math.abs(delta) < 0.05) return { dir: 'flat', delta: 0 };
    return { dir: delta > 0 ? 'up' : 'down', delta: Math.round(delta * 10) / 10 };
  },

  overviewRecentPages() {
    const ids = (this.overviewRecent || []).map(r => r.page_id);
    const byId = new Map((window.__app?.pages || []).map(p => [p.id, p]));
    return ids.map(id => byId.get(id)).filter(Boolean);
  },

  // Word-Count-Badge pro Recent-Page (aus tokEsts oder pages-Cache).
  overviewPageWords(pageId) {
    const est = window.__app?.tokEsts?.[pageId];
    return est?.words ?? null;
  },

  // Initialen für Avatar-Chip: erste Buchstaben aus Vor-/Nachname.
  overviewInitials(name) {
    if (!name) return '?';
    const parts = String(name).trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  },

  _fmtNum(n) {
    const tag = window.__app?.uiLocale === 'en' ? 'en-US' : 'de-CH';
    return Number(n || 0).toLocaleString(tag);
  },
};
