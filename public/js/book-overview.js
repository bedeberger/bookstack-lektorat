// Buch-Übersicht: Default-Landing beim Öffnen eines Buchs.
// Aggregiert ohne neuen KI-Job aus existierenden Endpoints:
//   /history/book-stats/:book_id    → Snapshot-Verlauf (Wortzahl-Sparkline + Last-Snapshot)
//   /history/coverage/:book_id      → Lektorat-Abdeckung
//   /history/fehler-heatmap/:book_id → Top-Fehlertypen (mode=open)
//   /history/review/:book_id        → letzte Bewertung
//   /usage/page/recent              → zuletzt geöffnete Seiten
//   /figures/:book_id, /figures/scenes/:book_id → Figuren/Szenen-Counts + Top-Figuren
//
// Reaktivität / Memoization:
// Aggregat-Methoden (overviewSparkline, overviewSzenenWertung, …) werden im
// Template mehrfach pro Render aufgerufen. Sie cachen ihr Ergebnis in
// `_memos`, geschlüsselt auf die Source-Array-Referenz. `loadBookOverview`
// und `resetBookOverview` weisen neue Arrays zu → Cache-Miss → Recompute.
// Die Methoden touchen weiterhin `this.overviewXxx`, damit Alpine die
// Reaktivität auch beim Cache-Hit korrekt trackt.
//
// Visualisierungen sind reines Inline-SVG (kein Chart.js): Overview soll
// instant beim Buchwechsel sichtbar sein, ohne Lazy-Lib-Load.
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
      const reviewArr = Array.isArray(reviews) ? reviews : [];
      this.overviewLastReview = reviewArr[0] || null;
      this.overviewPrevReview = reviewArr[1] || null;
      this.overviewRecent = Array.isArray(recent) ? recent : [];
      this.overviewFiguren = Array.isArray(figuren?.figuren) ? figuren.figuren : [];
      const sz = Array.isArray(szenen?.szenen) ? szenen.szenen : [];
      this.overviewSzenen = sz;
      this._memos = {};
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
    this._memos = {};
  },

  _memo(key, source, compute) {
    const memos = (this._memos ||= {});
    const hit = memos[key];
    if (hit && hit.source === source) return hit.value;
    const value = compute();
    memos[key] = { source, value };
    return value;
  },

  // ── Aggregate ────────────────────────────────────────────────────────────
  // Hero-Snapshot: live-aggregiert aus `tokEsts` (gleiche Quelle wie Sidebar-Σ),
  // damit Hero und Sidebar nach jedem Save sofort identisch sind. Cron-Snapshot
  // (book_stats_history) wird nur als Fallback genutzt, wenn tokEsts noch nicht
  // bereit ist (Buch eben gewechselt, Background-Estimate noch unterwegs).
  // Sparkline + 7-Tage-Balken lesen weiterhin overviewStats direkt — die
  // brauchen den historischen Verlauf.
  overviewLatest() {
    const app = window.__app;
    const tokEsts = app?.tokEsts || {};
    const ids = Object.keys(tokEsts);
    const histLast = (this.overviewStats && this.overviewStats.length)
      ? this.overviewStats[this.overviewStats.length - 1] : null;
    if (!ids.length) return histLast;
    let chars = 0, words = 0, tok = 0;
    for (const id of ids) {
      const e = tokEsts[id];
      if (!e) continue;
      chars += Number(e.chars) || 0;
      words += Number(e.words) || 0;
      tok += Number(e.tok) || 0;
    }
    const pages = app?.pages || [];
    const page_count = pages.length || ids.length;
    const chapter_count = new Set(
      pages.map(p => p.chapter_id).filter(Boolean)
    ).size;
    return { ...(histLast || {}), chars, words, tok, page_count, chapter_count };
  },

  overviewFigurenCount() { return (this.overviewFiguren || []).length; },
  overviewSzenenCount()  { return (this.overviewSzenen || []).length; },

  overviewSzenenWertung() {
    const sz = this.overviewSzenen || [];
    return this._memo('szenenWertung', sz, () => {
      const out = { stark: 0, mittel: 0, schwach: 0, ohne: 0 };
      for (const s of sz) {
        if (s.wertung === 'stark') out.stark++;
        else if (s.wertung === 'mittel') out.mittel++;
        else if (s.wertung === 'schwach') out.schwach++;
        else out.ohne++;
      }
      return out;
    });
  },

  // Top-3 Figuren nach Szenen-Präsenz (gleiche Quelle wie figurenpräsenz-matrix:
  // overviewSzenen.fig_ids). figuren[].kapitel.haeufigkeit zählt nur namentliche
  // Treffer und unterzählt Hauptfiguren bei pronomenlastigen Texten systematisch.
  overviewTopFiguren() {
    const figs = this.overviewFiguren || [];
    const sz = this.overviewSzenen || [];
    const memos = (this._memos ||= {});
    const hit = memos.topFiguren;
    if (hit && hit.figs === figs && hit.sz === sz) return hit.value;
    const totals = new Map();
    for (const s of sz) {
      if (!Array.isArray(s.fig_ids)) continue;
      for (const fid of s.fig_ids) totals.set(fid, (totals.get(fid) || 0) + 1);
    }
    const value = figs
      .map(f => ({
        id: f.id,
        name: f.name,
        kurzname: f.kurzname,
        rolle: f.rolle || null,
        mentions: totals.get(f.id) || 0,
      }))
      .sort((a, b) => b.mentions - a.mentions)
      .slice(0, 3);
    memos.topFiguren = { figs, sz, value };
    return value;
  },

  // Letzte 7 Kalendertage. Pro Tag: Zeichen-Delta zum Vortags-Snapshot.
  // Tage ohne Snapshot bekommen 0. Locale-bewusste Wochentag-Labels (Mo/Di/...).
  overviewLast7Days() {
    const a = this.overviewStats || [];
    return this._memo('last7Days', a, () => {
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
        const delta = (cur != null && prev != null) ? (cur - prev) : 0;
        days.push({ iso, label: fmt.format(d), delta });
      }
      return days;
    });
  },

  // Skalierungs-Maximum für 7-Tage-Bars (abs, mind. 1 um Division-by-zero zu vermeiden).
  overviewLast7Max() {
    const days = this.overviewLast7Days();
    return this._memo('last7Max', days, () =>
      Math.max(1, ...days.map(d => Math.abs(d.delta))));
  },

  overview7DayCharDelta() {
    const a = this.overviewStats;
    if (!a || a.length < 2) return null;
    return this._memo('sevenDayDelta', a, () => {
      const latest = a[a.length - 1];
      const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      let earlier = null;
      for (let i = a.length - 2; i >= 0; i--) {
        if (a[i].recorded_at <= cutoff) { earlier = a[i]; break; }
      }
      if (!earlier) earlier = a[0];
      return (Number(latest.chars) || 0) - (Number(earlier.chars) || 0);
    });
  },

  // Sparkline-Daten + Polygon-Fläche darunter (Gradient-Fill).
  // Liefert { d, area, color, deltaPct, endX, endY, w, h } oder { d:null, ... } bei <2 Punkten.
  overviewSparkline() {
    const stats = this.overviewStats || [];
    return this._memo('sparkline', stats, () => {
      const W = 240, H = 48, PAD = 3;
      const data = stats.slice(-30).map(s => Number(s.chars) || 0);
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
    });
  },

  // Donut-Math für Coverage-Ring. Stroke-Dasharray-Approach: kein <path>-Arc nötig.
  // CIRC = 2π·r — 100% = vollständig sichtbarer Stroke.
  overviewCoverageRing() {
    const cov = this.overviewCoverage;
    return this._memo('coverageRing', cov, () => {
      const pct = Math.max(0, Math.min(100, cov?.pct ?? 0));
      const r = 28;
      const c = 2 * Math.PI * r;
      return { r, c, dash: (pct / 100) * c, gap: c - (pct / 100) * c, pct };
    });
  },

  overviewTopFehler() {
    const heat = this.overviewHeat;
    return this._memo('topFehler', heat, () => {
      const totals = heat?.totals || {};
      const arr = Object.entries(totals)
        .map(([typ, count]) => ({ typ, count }))
        .filter(e => e.count > 0)
        .sort((a, b) => b.count - a.count)
        .slice(0, 3);
      if (arr.length === 0) return arr;
      const max = arr[0].count;
      return arr.map(e => ({ ...e, pct: Math.max(8, Math.round((e.count / max) * 100)) }));
    });
  },

  // Sterne-Rendering: gesamtnote 0..6, Score in halbe Sterne aufgelöst.
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

  // ARIA-Label nur wenn `gesamtnote` numerisch — sonst kein Label (statt "– / 6").
  overviewStarsAriaLabel() {
    const n = Number(this.overviewLastReview?.review_json?.gesamtnote);
    return Number.isFinite(n) ? `${n} / 6` : null;
  },

  // Trend zur Vorbewertung: Delta in Sternen (für Pfeil ↑/↓).
  // Null bei keiner Vorbewertung ODER bei Gleichstand.
  overviewReviewTrend() {
    const cur = Number(this.overviewLastReview?.review_json?.gesamtnote);
    const prev = Number(this.overviewPrevReview?.review_json?.gesamtnote);
    if (!Number.isFinite(cur) || !Number.isFinite(prev)) return null;
    const delta = cur - prev;
    if (Math.abs(delta) < 0.05) return null;
    return { dir: delta > 0 ? 'up' : 'down', delta: Math.round(delta * 10) / 10 };
  },

  // Fertig formatierter Trend-String (statt Triple-Ternary im Template).
  // up: "↑ +0.5", down: "↓ 0.5". `null` wenn kein Trend → x-show greift.
  overviewReviewTrendDisplay() {
    const t = this.overviewReviewTrend();
    if (!t) return null;
    const arrow = t.dir === 'up' ? '↑ +' : '↓ ';
    return arrow + Math.abs(t.delta);
  },

  overviewRecentPages() {
    const ids = (this.overviewRecent || []).map(r => r.page_id);
    const byId = new Map((window.__app?.pages || []).map(p => [p.id, p]));
    return ids.map(id => byId.get(id)).filter(Boolean);
  },

  // Zeichen-Badge pro Recent-Page (aus tokEsts).
  overviewPageChars(pageId) {
    const est = window.__app?.tokEsts?.[pageId];
    return est?.chars ?? null;
  },

  // Kapitel-Verteilung: Zeichen + Wörter + Seiten pro Kapitel.
  // Liest tree (Lese-Reihenfolge) und tokEsts (Live-Metriken pro Seite).
  // Diverging-Bar um Median (Zeichen): Track-Mitte = Median, Bars wachsen rechts
  // (länger als Median) oder links (kürzer). Bar-Länge = |deltaPct| / maxAbsDelta
  // * 48% (cap bei 48%, damit Bars nicht an Track-Rand stossen).
  // deltaPct = Abweichung gegen Median (±%, gerundet).
  // isMax/isMin markieren Extrem-Kapitel (Border-Akzent).
  // chapterSort: 'order' (Lese-Reihenfolge), 'charsDesc', 'charsAsc'.
  overviewChapterDistribution() {
    const app = window.__app;
    if (!app) return [];
    const tree = app.tree || [];
    const tokEsts = app.tokEsts || {};
    const out = [];
    for (const item of tree) {
      if (item.type !== 'chapter') continue;
      const pages = item.pages || [];
      let words = 0, chars = 0;
      for (const p of pages) {
        const est = tokEsts[p.id];
        if (!est) continue;
        words += Number(est.words) || 0;
        chars += Number(est.chars) || 0;
      }
      out.push({
        id: item.id,
        name: item.name,
        pages: pages.length,
        words,
        chars,
        order: out.length,
      });
    }
    if (out.length === 0) return out;
    const maxChars = Math.max(1, ...out.map(c => c.chars));
    const minChars = Math.min(...out.map(c => c.chars));
    const sorted = [...out].map(c => c.chars).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
    const withDelta = out.map(c => ({
      ...c,
      deltaPct: median > 0 ? Math.round(((c.chars - median) / median) * 100) : 0,
      isMax: c.chars === maxChars && maxChars > 0,
      isMin: c.chars === minChars && maxChars !== minChars,
    }));
    const maxAbsDelta = Math.max(1, ...withDelta.map(c => Math.abs(c.deltaPct)));
    const HALF = 48; // % of full track
    const enriched = withDelta.map(c => {
      const halfPct = (Math.abs(c.deltaPct) / maxAbsDelta) * HALF;
      return {
        ...c,
        median,
        barWidthPct: halfPct,
        barLeftPct: c.deltaPct >= 0 ? 50 : 50 - halfPct,
        isPositive: c.deltaPct >= 0,
      };
    });
    const sortMode = this.chapterSort || 'order';
    if (sortMode === 'charsDesc') enriched.sort((a, b) => b.chars - a.chars);
    else if (sortMode === 'charsAsc') enriched.sort((a, b) => a.chars - b.chars);
    else enriched.sort((a, b) => a.order - b.order);
    return enriched;
  },

  cycleChapterSort() {
    const seq = ['order', 'charsDesc', 'charsAsc'];
    const cur = this.chapterSort || 'order';
    this.chapterSort = seq[(seq.indexOf(cur) + 1) % seq.length];
  },

  chapterSortLabel() {
    const app = window.__app;
    if (!app?.t) return '';
    return app.t('overview.chapterSort.' + (this.chapterSort || 'order'));
  },

  // Lektorat-Findings pro Kapitel: aus overviewHeat.matrix (mode=open).
  // per1k = Findings pro 1000 Wörter (normalisiert; kurze Kapitel mit vielen
  // Findings werden so sichtbar). Sortiert nach per1k desc.
  overviewChapterFindings() {
    const heat = this.overviewHeat;
    if (!heat || !Array.isArray(heat.chapters) || !heat.matrix) return [];
    const out = [];
    for (const ch of heat.chapters) {
      if (ch.chapter_id == null) continue;
      const typen = heat.matrix[ch.chapter_id] || {};
      let count = 0;
      for (const t of Object.values(typen)) count += Number(t.count) || 0;
      const per1k = ch.words > 0 ? Math.round((count / ch.words) * 1000 * 10) / 10 : 0;
      out.push({
        id: ch.chapter_id,
        name: ch.chapter_name || '—',
        count,
        per1k,
        words: ch.words,
        pages_total: ch.pages_total,
        pages_checked: ch.pages_checked,
      });
    }
    if (out.length === 0) return out;
    const maxPer1k = Math.max(1, ...out.map(c => c.per1k));
    const enriched = out.map(c => ({
      ...c,
      pct: Math.max(2, Math.round((c.per1k / maxPer1k) * 100)),
      noCheck: c.pages_checked === 0,
    }));
    enriched.sort((a, b) => b.per1k - a.per1k);
    return enriched;
  },

  // Figuren-Präsenz-Matrix: Kapitel (Zeilen) × Top-Figuren (Spalten).
  // Cell-Wert = Anzahl Szenen, in denen die Figur im Kapitel auftritt
  // (gezählt aus overviewSzenen.fig_ids). `figure_appearances.haeufigkeit`
  // wird nicht verwendet — bei pronomenlastigen Texten unterzählt die
  // KI-Phase-1-Extraktion Hauptfiguren systematisch (z.B. Ich-Erzähler
  // mit 0 namentlichen Treffern).
  // Auswahl: Top-MAX_COLS Figuren nach Gesamt-Szenen. Match Kapitel
  // primär per chapter_id (stabil), Fallback auf Name. Skalierung pro
  // Spalte (max der Figur über alle Kapitel).
  overviewFigurePresence() {
    const figs = this.overviewFiguren || [];
    const sz = this.overviewSzenen || [];
    const memos = (this._memos ||= {});
    const hit = memos.figPresence;
    if (hit && hit.figs === figs && hit.sz === sz) return hit.value;
    const value = this._computeFigurePresence(figs, sz);
    memos.figPresence = { figs, sz, value };
    return value;
  },

  _computeFigurePresence(figs, sz) {
    const app = window.__app;
    if (!app || figs.length === 0 || sz.length === 0) return null;
    const tree = app.tree || [];
    const chapters = tree
      .filter(i => i.type === 'chapter')
      .map(c => ({ id: c.id, name: c.name }));
    if (chapters.length === 0) return null;

    const MAX_COLS = 20;

    const figByFigId = new Map();
    for (const f of figs) figByFigId.set(f.id, f);

    const counts = new Map(); // fig_id -> { byId, byName, total }
    for (const s of sz) {
      if (!Array.isArray(s.fig_ids) || s.fig_ids.length === 0) continue;
      const chapId = s.chapter_id ?? null;
      const chapName = s.kapitel || '';
      for (const figId of s.fig_ids) {
        let m = counts.get(figId);
        if (!m) { m = { byId: new Map(), byName: new Map(), total: 0 }; counts.set(figId, m); }
        if (chapId != null) m.byId.set(Number(chapId), (m.byId.get(Number(chapId)) || 0) + 1);
        if (chapName) m.byName.set(chapName, (m.byName.get(chapName) || 0) + 1);
        m.total++;
      }
    }

    const lookup = (m, ch) => m.byId.get(Number(ch.id)) ?? m.byName.get(ch.name) ?? 0;

    const candidates = [];
    for (const [figId, m] of counts) {
      const f = figByFigId.get(figId);
      if (!f) continue;
      candidates.push({ id: figId, name: f.kurzname || f.name, m, total: m.total });
    }
    candidates.sort((a, b) => b.total - a.total);
    if (candidates.length === 0) return null;

    const selected = candidates.slice(0, MAX_COLS);

    const figures = selected.map(c => ({ id: c.id, name: c.name }));
    const colMaxes = selected.map(c => {
      let mx = 0;
      for (const ch of chapters) { const v = lookup(c.m, ch); if (v > mx) mx = v; }
      return Math.max(1, mx);
    });

    const rows = chapters.map(ch => ({
      id: ch.id,
      name: ch.name,
      cells: selected.map((c, i) => {
        const v = lookup(c.m, ch);
        return {
          figureId: c.id,
          figureName: c.name,
          value: v,
          pct: v > 0 ? Math.max(15, Math.round((v / colMaxes[i]) * 100)) : 0,
        };
      }),
    }));
    return { figures, rows };
  },

  // Fehler-Typ-Label: i18n-Key versuchen; Fallback humanisiert.
  overviewFehlerLabel(typ) {
    const key = 'fehlerHeatmap.typ.' + typ;
    const app = window.__app;
    const translated = app?.t ? app.t(key) : null;
    if (translated && translated !== key) return translated;
    const s = String(typ || '').replace(/_/g, ' ').replace(/\bvs\b/, 'vs.');
    return s.charAt(0).toUpperCase() + s.slice(1);
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

  // ── Tile-Click-Handler ───────────────────────────────────────────────────
  _openLengthStats(range = 30, metric = 'chars') {
    window.dispatchEvent(new CustomEvent('book-stats:select', { detail: { metric, range } }));
    window.__app?.toggleBookStatsCard?.();
  },

  _openKapitelReview(chapterId) {
    const app = window.__app;
    if (!app) return;
    app.kapitelReviewChapterId = String(chapterId);
    if (!app.showKapitelReviewCard) app.toggleKapitelReviewCard();
  },
};
