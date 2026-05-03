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
  overviewLatest() {
    const a = this.overviewStats;
    return (a && a.length) ? a[a.length - 1] : null;
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

  // Top-3 Figuren nach Total-Erwähnungen über alle Kapitel.
  // figuren[].kapitel: [{ name, haeufigkeit }]
  overviewTopFiguren() {
    const figs = this.overviewFiguren || [];
    return this._memo('topFiguren', figs, () => figs
      .map(f => ({
        id: f.id,
        name: f.name,
        kurzname: f.kurzname,
        rolle: f.rolle || null,
        mentions: (f.kapitel || []).reduce((s, k) => s + (Number(k.haeufigkeit) || 0), 0),
      }))
      .sort((a, b) => b.mentions - a.mentions)
      .slice(0, 3));
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
      const data = stats.slice(-30).map(s => Number(s.words) || 0);
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

  // Word-Count-Badge pro Recent-Page (aus tokEsts oder pages-Cache).
  overviewPageWords(pageId) {
    const est = window.__app?.tokEsts?.[pageId];
    return est?.words ?? null;
  },

  // Kapitel-Verteilung: Seiten + Wörter + Zeichen pro Kapitel.
  // Liest tree (Lese-Reihenfolge) und tokEsts (Live-Wortzahlen pro Seite).
  // pct = Wörter relativ zum längsten Kapitel — für Bar-Width-Skalierung.
  // medianPct = Median-Position im Track (vertikaler Tick).
  // deltaPct = Abweichung gegen Median (±%, gerundet).
  // isMax/isMin markieren Top-/Schwächstes-Kapitel (Akzent-Highlight).
  // chapterSort: 'order' (Lese-Reihenfolge), 'wordsDesc', 'wordsAsc'.
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
    const maxWords = Math.max(1, ...out.map(c => c.words));
    const minWords = Math.min(...out.map(c => c.words));
    const sorted = [...out].map(c => c.words).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
    const enriched = out.map(c => ({
      ...c,
      pct: Math.max(2, Math.round((c.words / maxWords) * 100)),
      medianPct: Math.round((median / maxWords) * 100),
      deltaPct: median > 0 ? Math.round(((c.words - median) / median) * 100) : 0,
      isMax: c.words === maxWords && maxWords > 0,
      isMin: c.words === minWords && maxWords !== minWords,
    }));
    const sortMode = this.chapterSort || 'order';
    if (sortMode === 'wordsDesc') enriched.sort((a, b) => b.words - a.words);
    else if (sortMode === 'wordsAsc') enriched.sort((a, b) => a.words - b.words);
    else enriched.sort((a, b) => a.order - b.order);
    return enriched;
  },

  cycleChapterSort() {
    const seq = ['order', 'wordsDesc', 'wordsAsc'];
    const cur = this.chapterSort || 'order';
    this.chapterSort = seq[(seq.indexOf(cur) + 1) % seq.length];
  },

  chapterSortLabel() {
    const t = window.__app?.t;
    if (!t) return '';
    return t('overview.chapterSort.' + (this.chapterSort || 'order'));
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

  // Figuren-Präsenz-Matrix: Top-Figuren × Kapitel.
  // Auswahl-Strategie (Set-Cover): Top-5 nach Gesamt-haeufigkeit als Basis.
  // Danach für jedes nicht abgedeckte Kapitel die dort stärkste Figur
  // ergänzen (dedup), Cap bei MAX_ROWS Zeilen. Garantiert dass jede Spalte
  // mit Daten ≥1 Vertretung hat, solange Cap nicht erschöpft ist.
  // Cell-Wert = haeufigkeit aus figuren[].kapitel[]. Match primär per
  // chapter_id (stabil gegen Umbenennen), Fallback auf chapter_name (für
  // Alt-Daten ohne chapter_id). Skalierung pro Zeile (max der Figur).
  overviewFigurePresence() {
    const app = window.__app;
    const figs = this.overviewFiguren || [];
    if (!app || figs.length === 0) return null;
    const tree = app.tree || [];
    const chapters = tree
      .filter(i => i.type === 'chapter')
      .map(c => ({ id: c.id, name: c.name }));
    if (chapters.length === 0) return null;

    const MAX_ROWS = 8;

    // Pro Figur: Lookup-Maps für Kapitel-haeufigkeit (id + name).
    const candidates = figs.map(f => {
      const byId = new Map();
      const byName = new Map();
      for (const k of (f.kapitel || [])) {
        const h = Number(k.haeufigkeit) || 0;
        if (k.chapter_id != null) byId.set(Number(k.chapter_id), h);
        if (k.name) byName.set(k.name, h);
      }
      const total = (f.kapitel || []).reduce((s, k) => s + (Number(k.haeufigkeit) || 0), 0);
      return { id: f.id, name: f.kurzname || f.name, byId, byName, total };
    }).sort((a, b) => b.total - a.total);
    if (candidates.length === 0 || candidates[0].total === 0) return null;

    const lookup = (cand, ch) => cand.byId.get(Number(ch.id)) ?? cand.byName.get(ch.name) ?? 0;

    const selected = candidates.slice(0, 5);
    const selectedIds = new Set(selected.map(c => c.id));

    // Set-Cover-Erweiterung: pro unbedecktem Kapitel beste verfügbare Figur.
    for (const ch of chapters) {
      if (selected.length >= MAX_ROWS) break;
      const covered = selected.some(c => lookup(c, ch) > 0);
      if (covered) continue;
      let best = null;
      for (const cand of candidates) {
        if (selectedIds.has(cand.id)) continue;
        const h = lookup(cand, ch);
        if (h > 0 && (!best || h > best.h)) best = { cand, h };
      }
      if (best) {
        selected.push(best.cand);
        selectedIds.add(best.cand.id);
      }
    }

    const rows = selected.map((f, idx) => {
      const cells = chapters.map(ch => lookup(f, ch));
      const max = Math.max(1, ...cells);
      return {
        id: f.id,
        name: f.name,
        idx,
        cells: cells.map((v, i) => ({
          chapterId: chapters[i].id,
          chapterName: chapters[i].name,
          value: v,
          pct: v > 0 ? Math.max(15, Math.round((v / max) * 100)) : 0,
        })),
      };
    });
    return { chapters, rows };
  },

  // Fehler-Typ-Label: i18n-Key versuchen; Fallback humanisiert.
  overviewFehlerLabel(typ) {
    const key = 'fehlerHeatmap.typ.' + typ;
    const translated = window.__app?.t?.(key);
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
  _openWordsStats(range = 30, metric = 'words') {
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
