// Buch-Übersicht: Default-Landing beim Öffnen eines Buchs.
// Aggregiert ohne neuen KI-Job aus existierenden Endpoints:
//   /history/book-stats/:book_id    → Snapshot-Verlauf (Wortzahl-Sparkline + Last-Snapshot)
//   /history/coverage/:book_id      → Lektorat-Abdeckung
//   /history/fehler-heatmap/:book_id → Top-Fehlertypen (mode=open)
//   /history/review/:book_id        → letzte Bewertung
//   /usage/page/recent              → zuletzt geöffnete Seiten
import { fetchJson } from './utils.js';

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
      this.overviewLastReview = (Array.isArray(reviews) && reviews.length > 0) ? reviews[0] : null;
      this.overviewRecent = Array.isArray(recent) ? recent : [];
      this.overviewFigurenCount = Array.isArray(figuren?.figuren) ? figuren.figuren.length : 0;
      const sz = Array.isArray(szenen?.szenen) ? szenen.szenen : [];
      this.overviewSzenenCount = sz.length;
      this.overviewSzenenStark = sz.filter(s => s.wertung === 'stark').length;
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
    this.overviewRecent = [];
    this.overviewFigurenCount = 0;
    this.overviewSzenenCount = 0;
    this.overviewSzenenStark = 0;
    this.overviewBookId = null;
  },

  // Zeichen-Delta letzte 7 Tage. Liest aus book_stats_history.
  // Sucht den jüngsten Snapshot mit recorded_at <= today-7; falls keiner
  // existiert, fallback auf den ältesten Snapshot. Liefert null bei <2 Snapshots.
  get overview7DayCharDelta() {
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

  // Letzter Snapshot oder null. UI prüft auf null und zeigt Empty-State.
  get overviewLatest() {
    const a = this.overviewStats;
    return (a && a.length) ? a[a.length - 1] : null;
  },

  // Sparkline-Pfad für Wortzahl-Verlauf der letzten 30 Tage. Inline-SVG —
  // kein Chart.js-Lazy-Load nötig (Overview soll instant sichtbar sein).
  // Liefert { d, last, first, deltaPct } — d ist `null`, wenn zu wenig Daten.
  get overviewSparkline() {
    const W = 240, H = 40, PAD = 2;
    const data = (this.overviewStats || []).slice(-30).map(s => Number(s.words) || 0);
    if (data.length < 2) return { d: null, last: 0, first: 0, deltaPct: 0 };
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
    const first = data[0];
    const last = data[data.length - 1];
    const deltaPct = first > 0 ? Math.round(((last - first) / first) * 100) : 0;
    return { d, last, first, deltaPct, w: W, h: H };
  },

  // Top-3 Fehlertypen aus der Heatmap. Sortiert nach Total absteigend.
  get overviewTopFehler() {
    const totals = this.overviewHeat?.totals || {};
    const arr = Object.entries(totals)
      .map(([typ, count]) => ({ typ, count }))
      .filter(e => e.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);
    return arr;
  },

  // Recente Seiten in {id, name, chapter}-Form für die Liste.
  get overviewRecentPages() {
    const ids = (this.overviewRecent || []).map(r => r.page_id);
    const byId = new Map((window.__app?.pages || []).map(p => [p.id, p]));
    return ids.map(id => byId.get(id)).filter(Boolean);
  },

  // Lokalisierte Zahl. de-CH = Apostroph als Tausender-Separator.
  _fmtNum(n) {
    const tag = window.__app?.uiLocale === 'en' ? 'en-US' : 'de-CH';
    return Number(n || 0).toLocaleString(tag);
  },
};
