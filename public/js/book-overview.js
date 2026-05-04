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
import { fetchJson, fmtExactDuration } from './utils.js';

// Retry once mit kurzem Backoff: bei 9 parallelen Endpoints fängt das
// 5xx-/Netzwerk-Blips ab, ohne dass das Tile stumm leer rendert.
async function fetchJsonRetry(url) {
  try { return await fetchJson(url); }
  catch (e1) {
    await new Promise(r => setTimeout(r, 250));
    try { return await fetchJson(url); }
    catch (e2) {
      console.warn('[bookOverview] fetch failed twice', url, e2);
      throw e2;
    }
  }
}

export const bookOverviewMethods = {
  async loadBookOverview(bookId) {
    if (!bookId) return;
    // Dedupe: laufender Load fürs gleiche Buch wird ignoriert. Buchwechsel
    // setzt _loadingBookId auf die neue ID; In-flight-Antworten fürs alte
    // Buch fallen unten durch den overviewBookId-Guard raus.
    if (this._loadingBookId === bookId) return;
    this._loadingBookId = bookId;
    this.overviewLoading = true;
    this.overviewBookId = bookId;
    try {
      const [stats, coverage, heat, reviews, recent, figuren, szenen, orte, lektoratTime] = await Promise.all([
        fetchJsonRetry(`/history/book-stats/${bookId}`).catch(() => []),
        fetchJsonRetry(`/history/coverage/${bookId}`).catch(() => null),
        fetchJsonRetry(`/history/fehler-heatmap/${bookId}?mode=open`).catch(() => null),
        fetchJsonRetry(`/history/review/${bookId}`).catch(() => []),
        fetchJsonRetry(`/usage/page/recent?book_id=${bookId}&limit=5`).catch(() => []),
        fetchJsonRetry(`/figures/${bookId}`).catch(() => null),
        fetchJsonRetry(`/figures/scenes/${bookId}`).catch(() => null),
        fetchJsonRetry(`/locations/${bookId}`).catch(() => null),
        fetchJsonRetry(`/history/lektorat-time/${bookId}`).catch(() => null),
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
      this.overviewOrte = Array.isArray(orte?.orte) ? orte.orte : [];
      this.overviewLektoratTime = lektoratTime || null;
      this._memos = {};
    } catch (e) {
      console.error('[loadBookOverview]', e);
    } finally {
      if (this._loadingBookId === bookId) this._loadingBookId = null;
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
    this.overviewOrte = [];
    this.overviewLektoratTime = null;
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

  // Multi-Source-Variante: Cache hit nur wenn ALLE Source-Refs identisch.
  // Wichtig für Tiles, die zusätzlich zu `overviewXxx` auch `app.tree`/
  // `app.figuren` lesen — sonst wird ein Compute mit leerem `tree` (während
  // loadPages noch läuft) als `null` cached und Tile bleibt aus, obwohl
  // tree danach befüllt wird (Hauptquelle-Ref unverändert).
  _memoN(key, sources, compute) {
    const memos = (this._memos ||= {});
    const hit = memos[key];
    if (hit && hit.sources.length === sources.length
        && hit.sources.every((s, i) => s === sources[i])) {
      return hit.value;
    }
    const value = compute();
    memos[key] = { sources: [...sources], value };
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

  // Top-6 Figuren nach Szenen-Präsenz (gleiche Quelle wie figurenpräsenz-matrix:
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
      .slice(0, 6);
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
  // Liefert { d, area, color, deltaPct, endX, endY, w, h, points } oder { d:null, ... } bei <2 Punkten.
  // `points`: pro Datenpunkt { chars, iso, label } für Hover-Overlay mit Datum + exaktem Wert.
  overviewSparkline() {
    const stats = this.overviewStats || [];
    return this._memo('sparkline', stats, () => {
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
      const color = deltaPct > 0 ? 'var(--color-success, #4caf50)'
                  : deltaPct < 0 ? 'var(--color-danger, #d32f2f)'
                  :                'var(--color-accent)';
      const endX = pts[pts.length - 1][0];
      const endY = pts[pts.length - 1][1];
      const tag = window.__app?.uiLocale === 'en' ? 'en-US' : 'de-CH';
      const dateFmt = new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'short', year: 'numeric' });
      const numFmt = (n) => Number(n || 0).toLocaleString(tag);
      const unit = window.__app?.t?.('bookstats.unit.z') || 'Z';
      const points = slice.map((s, i) => {
        const iso = s.recorded_at;
        let label;
        if (iso) {
          const dt = new Date(iso + 'T00:00:00');
          label = dateFmt.format(dt) + ': ' + numFmt(data[i]) + ' ' + unit;
        } else {
          label = numFmt(data[i]) + ' ' + unit;
        }
        return { chars: data[i], iso, label };
      });
      return { d, area, color, deltaPct, endX, endY, w: W, h: H, points };
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
  // Sortierung: Lese-Reihenfolge aus tree (= Buch-Sortierung der Kapitel).
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
    return withDelta.map(c => {
      const halfPct = (Math.abs(c.deltaPct) / maxAbsDelta) * HALF;
      return {
        ...c,
        median,
        barWidthPct: halfPct,
        barLeftPct: c.deltaPct >= 0 ? 50 : 50 - halfPct,
        isPositive: c.deltaPct >= 0,
      };
    });
  },

  // Lektorat-Findings pro Kapitel: aus overviewHeat.matrix (mode=open).
  // per1k = Findings pro 1000 Wörter (normalisiert; kurze Kapitel mit vielen
  // Findings werden so sichtbar).
  // Diverging-Bar um Median analog Kapitellänge: rechts vom Tick = mehr
  // Befunde als typisches Kapitel (warnfarbe), links = weniger (gemutet).
  // Bar-Länge = |deltaPct| / maxAbsDelta * 48% (cap, damit Bars nicht an
  // Track-Rand stossen). Median nur aus geprüften Kapiteln; ungeprüfte
  // Zeilen behalten den Tick als Referenz, zeigen aber keinen Bar.
  // Schwelle ≥3 geprüfte Kapitel für Median — darunter zu instabil.
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
    const checked = out.filter(c => c.pages_checked > 0);
    const showMedian = checked.length >= 3;
    let median = 0;
    if (showMedian) {
      const sorted = checked.map(c => c.per1k).sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      median = sorted.length % 2 === 0
        ? Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 10) / 10
        : sorted[mid];
    }
    const withDelta = out.map(c => {
      const noCheck = c.pages_checked === 0;
      const deltaPct = !noCheck && median > 0
        ? Math.round(((c.per1k - median) / median) * 100)
        : 0;
      return { ...c, noCheck, deltaPct };
    });
    const HALF = 48;
    const deltas = withDelta.filter(c => !c.noCheck).map(c => Math.abs(c.deltaPct));
    const maxAbsDelta = Math.max(1, ...deltas);
    const enriched = withDelta.map(c => {
      const halfPct = showMedian && !c.noCheck
        ? (Math.abs(c.deltaPct) / maxAbsDelta) * HALF
        : 0;
      return {
        ...c,
        median,
        showMedian,
        barWidthPct: halfPct,
        barLeftPct: c.deltaPct >= 0 ? 50 : 50 - halfPct,
        isAbove: c.deltaPct > 0,
      };
    });
    enriched.sort((a, b) => b.per1k - a.per1k);
    return enriched;
  },

  // Lektoratszeit pro Kapitel: aus /history/lektorat-time/:book_id (per_chapter).
  // Anzeige in absoluten Sekunden (exakt formatiert h/min/s). Diverging-Bar um
  // Median der Sekunden — zeigt, ob ein Kapitel über/unter dem typischen
  // Zeitaufwand liegt. Sort: Sekunden desc.
  // Schwelle ≥3 Kapitel mit seconds > 0 für Median.
  overviewChapterLektoratTime() {
    const lt = this.overviewLektoratTime;
    if (!lt || !Array.isArray(lt.per_chapter) || lt.per_chapter.length === 0) return [];
    const out = lt.per_chapter.map(row => ({
      id: row.chapter_id ?? null,
      name: row.chapter_name || '—',
      seconds: Number(row.seconds) || 0,
      pages_count: Number(row.pages_count) || 0,
    }));
    const showMedian = out.length >= 3;
    let median = 0;
    if (showMedian) {
      const sorted = out.map(c => c.seconds).sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      median = sorted.length % 2 === 0
        ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
        : sorted[mid];
    }
    const withDelta = out.map(c => {
      const deltaPct = median > 0
        ? Math.round(((c.seconds - median) / median) * 100)
        : 0;
      return { ...c, deltaPct };
    });
    const HALF = 48;
    const deltas = withDelta.map(c => Math.abs(c.deltaPct));
    const maxAbsDelta = Math.max(1, ...deltas);
    const enriched = withDelta.map(c => {
      const halfPct = showMedian
        ? (Math.abs(c.deltaPct) / maxAbsDelta) * HALF
        : 0;
      return {
        ...c,
        median,
        medianLabel: fmtExactDuration(median),
        durationLabel: fmtExactDuration(c.seconds),
        showMedian,
        barWidthPct: halfPct,
        barLeftPct: c.deltaPct >= 0 ? 50 : 50 - halfPct,
        isAbove: c.deltaPct > 0,
      };
    });
    enriched.sort((a, b) => b.seconds - a.seconds);
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
    const tree = window.__app?.tree || [];
    return this._memoN('figPresence', [figs, sz, tree],
      () => this._computeFigurePresence(figs, sz));
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
    // Globaler Max über alle Cells: einziger Skala-Bezug. Spalten-Normierung
    // verworfen, weil Figuren oft nur in 1 Kapitel auftauchen → col-pct 100 %
    // selbst bei Wert 1, wodurch sparse Cells fälschlich „voll" wirkten.
    let globalMax = 0;
    for (const c of selected) {
      for (const ch of chapters) {
        const v = lookup(c.m, ch);
        if (v > globalMax) globalMax = v;
      }
    }
    globalMax = Math.max(1, globalMax);

    const rows = chapters.map(ch => ({
      id: ch.id,
      name: ch.name,
      cells: selected.map((c) => {
        const v = lookup(c.m, ch);
        return {
          figureId: c.id,
          figureName: c.name,
          value: v,
          pct: v > 0 ? Math.max(8, Math.round((v / globalMax) * 100)) : 0,
        };
      }),
    }));
    return { figures, rows };
  },

  // ── Schauplätze ──────────────────────────────────────────────────────────
  // Datenquelle: /locations/:book_id liefert pro Ort `kapitel: [{name, haeufigkeit}]`
  // (sortiert haeufigkeit desc) und `figuren: [fig_id]`. Kein Geo, keine Koordinaten.
  // Ranking: Summe der Kapitel-Häufigkeiten = Gesamt-Präsenz im Buch.

  overviewOrteCount() { return (this.overviewOrte || []).length; },

  overviewTopOrte() {
    const orte = this.overviewOrte || [];
    return this._memo('topOrte', orte, () => {
      return orte
        .map(o => {
          const kap = Array.isArray(o.kapitel) ? o.kapitel : [];
          const total = kap.reduce((s, k) => s + (Number(k.haeufigkeit) || 0), 0);
          return { id: o.id, name: o.name, typ: o.typ || 'andere', total };
        })
        .filter(o => o.total > 0 || (this.overviewOrte || []).length <= 6)
        .sort((a, b) => b.total - a.total)
        .slice(0, 6);
    });
  },

  // Schauplatz-Präsenz-Matrix: Kapitel (Zeilen) × Top-Schauplätze (Spalten).
  // Cell-Wert = location_chapters.haeufigkeit. Match primär per chapter_id
  // (stabil), Fallback auf chapter_name (Backfill-Lücken: alte Einträge ohne
  // aufgelöste ID). Skalierung pro Spalte (max der Spalte über alle Kapitel).
  overviewOrtPresence() {
    const orte = this.overviewOrte || [];
    const tree = window.__app?.tree || [];
    return this._memoN('ortPresence', [orte, tree], () => {
      const app = window.__app;
      if (!app || orte.length === 0) return null;
      const tree = app.tree || [];
      const chapters = tree
        .filter(i => i.type === 'chapter')
        .map(c => ({ id: c.id, name: c.name }));
      if (chapters.length === 0) return null;

      const MAX_COLS = 20;

      const candidates = orte.map(o => {
        const kap = Array.isArray(o.kapitel) ? o.kapitel : [];
        const byId = new Map();
        const byName = new Map();
        for (const k of kap) {
          const h = Number(k?.haeufigkeit) || 0;
          if (k?.chapter_id != null) byId.set(Number(k.chapter_id), (byId.get(Number(k.chapter_id)) || 0) + h);
          if (k?.name) byName.set(k.name, (byName.get(k.name) || 0) + h);
        }
        let total = 0;
        for (const v of byName.values()) total += v;
        return { id: o.id, name: o.name, typ: o.typ || 'andere', byId, byName, total };
      }).filter(c => c.total > 0);

      if (candidates.length === 0) return null;
      candidates.sort((a, b) => b.total - a.total);
      const selected = candidates.slice(0, MAX_COLS);

      const lookup = (c, ch) => c.byId.get(Number(ch.id)) ?? c.byName.get(ch.name) ?? 0;

      const places = selected.map(c => ({ id: c.id, name: c.name, typ: c.typ }));
      let globalMax = 0;
      for (const c of selected) {
        for (const ch of chapters) {
          const v = lookup(c, ch);
          if (v > globalMax) globalMax = v;
        }
      }
      globalMax = Math.max(1, globalMax);
      const rows = chapters.map(ch => ({
        id: ch.id,
        name: ch.name,
        cells: selected.map((c) => {
          const v = lookup(c, ch);
          return {
            ortId: c.id,
            ortName: c.name,
            value: v,
            pct: v > 0 ? Math.max(8, Math.round((v / globalMax) * 100)) : 0,
          };
        }),
      }));
      return { places, rows };
    });
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

  _fmtDuration(sec) {
    return fmtExactDuration(sec);
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
