// buchlandkarteMethods — Buchlandkarte: die Seiten des Buchs als Punktwolke über
// dem Embedding-Index. Rein rückwärtsgewandt (liest den Index, schreibt nie in
// den Buchtext). Die Projektion und alle Kennzahlen rechnet der Server als Job
// (POST /jobs/book-map, Mathematik in lib/book-map.js); diese Methoden triggern
// ihn, pollen und zeichnen. Gespreadet in cards/buchlandkarte-card.js.
//
// WAS DIE KARTE ZEIGT: Nähe. Zwei Punkte nebeneinander heissen „diese zwei Seiten
// reden über dasselbe" — und damit werden drei Dinge sichtbar, die eine
// Trefferliste nicht zeigen kann: übereinanderliegende Kapitel-Wolken (zwei
// Kapitel erzählen dasselbe), ein in zwei Wolken zerfallendes Kapitel (ein
// Teilungsvorschlag) und die Seite weit draussen (der Exkurs, der Blindtext).
//
// WAS DIE ACHSEN NICHT SIND: sie haben keine Bedeutung und bekommen darum keine
// Beschriftung — nur die relative Lage zählt. Wieviel von der Wolke das Bild
// überhaupt zeigt, sagt `explainedVariance`; das wird ausgewiesen statt
// verschwiegen (gleiche Ehrlichkeitsregel wie beim Einmalwort-Deckel des
// Wortschatzes).
//
// SEITEN- UND KAPITELNAMEN kommen aus der ohnehin geladenen Navigationsliste
// (`$store.nav.pages`), nie aus dem Job-Ergebnis: ein Name dort wäre ein
// Snapshot, der nach einer Umbenennung falsch dasteht.

import { loadChart } from '../lazy-libs.js';
import { BOOK_COLORS } from '../cards/my-stats-chart-methods.js';

const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// Ausserhalb von Alpine gehalten, damit der Reaktivitäts-Proxy die Chart.js-
// Instanz nicht beschädigt (gleiche Begründung wie in book/bookstats.js).
let _mapChart = null;
let _themeObserver = null;

// Punkt-Radius: Grundgrösse plus ein wenig für die Länge der Seite (Chunk-Zahl).
// Bewusst flach gedeckelt — die Karte soll Lage zeigen, nicht Umfang, und grosse
// Scheiben verdecken ihre Nachbarn.
const R_BASE = 3;
const R_MAX_BONUS = 4;

// Unter drei Punkten gibt `project2d` keine Projektion zurueck (alle Koordinaten
// 0) — dieselbe Untergrenze wie dort. Ein Bild mit zwei Punkten in der Mitte und
// „0% der Streuung" darunter waere kein Ergebnis, sondern eine Irritation.
const MIN_MAP_POINTS = 3;

/** Vom destroy() der Karte gerufen: Modul-State freigeben. */
export function _destroyBookMapChart() {
  if (_mapChart) { _mapChart.destroy(); _mapChart = null; }
}
export function _disconnectBookMapThemeObserver() {
  if (_themeObserver) { _themeObserver.disconnect(); _themeObserver = null; }
}

// Ein Canvas kann keine CSS-Custom-Properties auflösen — beim Theme-Wechsel muss
// darum neu gezeichnet werden (gleiche Regel wie im Figuren-Graph, siehe
// graph-kit.js#observeThemeChange).
function _ensureThemeObserver(component) {
  if (_themeObserver) return;
  _themeObserver = new MutationObserver(() => {
    if (!_mapChart || !window.__app?.showBuchlandkarteCard) return;
    _destroyBookMapChart();
    component.renderBookMap();
  });
  _themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

export const buchlandkarteMethods = {
  // ── Namen aus der Navigationsliste ────────────────────────────────────────

  bookMapPageName(pageId) {
    const p = (Alpine.store('nav').pages || []).find(x => String(x.id) === String(pageId));
    return p?.name || window.__app?.t?.('buchlandkarte.pageFallback', { id: pageId }) || ('#' + pageId);
  },

  bookMapChapterName(chapterId) {
    if (chapterId == null) return window.__app?.t?.('buchlandkarte.noChapter') || '';
    const p = (Alpine.store('nav').pages || []).find(x => String(x.chapter_id) === String(chapterId));
    return p?.chapterName || window.__app?.t?.('buchlandkarte.chapterFallback', { id: chapterId }) || ('#' + chapterId);
  },

  bookMapGotoPage(pageId) {
    window.__app?.gotoPageById?.(Number(pageId));
  },

  // ── Index-Frische ─────────────────────────────────────────────────────────

  async loadBookMapIndexStatus() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || !this.$store.config?.semanticSearchEnabled) { this.bookMapIndexInfo = null; return; }
    try {
      const r = await fetch('/search/semantic/status?book_id=' + encodeURIComponent(bookId), { credentials: 'same-origin' });
      if (!r.ok) { this.bookMapIndexInfo = null; return; }
      const j = await r.json();
      this.bookMapIndexInfo = j.enabled ? j : null;
    } catch { this.bookMapIndexInfo = null; }
  },

  // ── Lauf ──────────────────────────────────────────────────────────────────

  // Kein Auto-Run beim Öffnen: die Projektion ist der teuerste Teil und soll
  // eine bewusste Handlung bleiben (wie beim Redundanz-Radar).
  async runBookMap() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || this.bookMapLoading) return;
    this.bookMapLoading = true;
    this.bookMapProgress = 0;
    this.bookMapResult = null;
    _destroyBookMapChart();
    this.bookMapStatus = window.__app?.t?.('buchlandkarte.running') || '';
    try {
      const r = await fetch('/jobs/book-map', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.jobId) {
        this.bookMapLoading = false;
        this.bookMapStatus = window.__app?.t?.(
          j.error_code === 'EMBED_DISABLED' ? 'buchlandkarte.needBackend' : 'buchlandkarte.error',
        ) || 'Fehler';
        return;
      }
      this._pollBookMap(j.jobId);
    } catch (e) {
      this.bookMapLoading = false;
      this.bookMapStatus = e.message || 'error';
    }
  },

  _pollBookMap(jobId) {
    const tick = async () => {
      try {
        const r = await fetch('/jobs/' + encodeURIComponent(jobId), { credentials: 'same-origin' });
        const j = await r.json().catch(() => ({}));
        if (j.status === 'done') {
          this.bookMapLoading = false;
          this.bookMapProgress = 100;
          this.bookMapResult = j.result || { pages: [], chapters: [], outliers: [] };
          this.bookMapStatus = '';
          // Canvas existiert erst, wenn das Ergebnis-Template gerendert ist.
          this.$nextTick(() => this.renderBookMap());
          return;
        }
        if (j.status === 'error' || j.status === 'cancelled') {
          this.bookMapLoading = false;
          this.bookMapStatus = window.__app?.t?.('buchlandkarte.error') || 'Fehler';
          return;
        }
        this.bookMapProgress = j.progress || 0;
        this._bookMapPollTimer = setTimeout(tick, 1000);
      } catch {
        this._bookMapPollTimer = setTimeout(tick, 2000);
      }
    };
    tick();
  },

  // ── Zeichnen ──────────────────────────────────────────────────────────────

  /**
   * Punkte nach Kapitel in Chart.js-Datasets gruppieren. Reihenfolge = Buch-
   * Reihenfolge (aus der Navigationsliste), damit die Legende der Gliederung
   * folgt und die Farbe eines Kapitels über Läufe hinweg dieselbe bleibt.
   * Seiten ohne Kapitel kommen als letzte, neutral gefärbte Gruppe.
   */
  _bookMapDatasets(pages) {
    const order = [];
    const seen = new Set();
    for (const p of (Alpine.store('nav').pages || [])) {
      const key = p.chapter_id == null ? '' : String(p.chapter_id);
      if (seen.has(key)) continue;
      seen.add(key);
      order.push(p.chapter_id ?? null);
    }
    // Kapitel, die die Navigationsliste nicht kennt (Seite verschoben, Liste
    // noch nicht neu geladen), hinten anhängen statt verschweigen.
    for (const pt of pages) {
      const key = pt.chapterId == null ? '' : String(pt.chapterId);
      if (!seen.has(key)) { seen.add(key); order.push(pt.chapterId ?? null); }
    }

    const groups = new Map();
    for (const pt of pages) {
      const key = pt.chapterId == null ? '' : String(pt.chapterId);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(pt);
    }

    const muted = cssVar('--color-muted');
    const out = [];
    let colorIx = 0;
    for (const chapterId of order) {
      const key = chapterId == null ? '' : String(chapterId);
      const pts = groups.get(key);
      if (!pts?.length) continue;
      const color = chapterId == null ? muted : BOOK_COLORS[colorIx++ % BOOK_COLORS.length];
      out.push({
        label: this.bookMapChapterName(chapterId),
        data: pts.map(pt => ({
          x: pt.x, y: pt.y, pageId: pt.id,
          r: R_BASE + Math.min(R_MAX_BONUS, Math.max(0, (pt.chunks || 1) - 1)),
        })),
        backgroundColor: color + 'cc',
        borderColor: color,
        borderWidth: 1,
        pointRadius: ctx => ctx.raw?.r ?? R_BASE,
        pointHoverRadius: ctx => (ctx.raw?.r ?? R_BASE) + 3,
      });
    }
    return out;
  },

  async renderBookMap() {
    const res = this.bookMapResult;
    if (!this.bookMapHasMap()) return;
    const canvas = document.getElementById('bookMapCanvas');
    if (!canvas) return;
    try { await loadChart(); } catch { return; }
    _destroyBookMapChart();
    _ensureThemeObserver(this);

    const muted = cssVar('--color-muted');
    const gridLine = cssVar('--color-border');
    const t = (k, p) => window.__app?.t?.(k, p) || k;

    _mapChart = new Chart(canvas, {
      type: 'scatter',
      data: { datasets: this._bookMapDatasets(res.pages) },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { color: muted, boxWidth: 10, font: { size: 11 } } },
          tooltip: {
            callbacks: {
              label: ctx => ` ${this.bookMapPageName(ctx.raw?.pageId)} — ${ctx.dataset.label}`,
            },
          },
        },
        onClick: (_evt, elements) => {
          const el = elements?.[0];
          if (!el) return;
          const pt = _mapChart?.data?.datasets?.[el.datasetIndex]?.data?.[el.index];
          if (pt?.pageId) this.bookMapGotoPage(pt.pageId);
        },
        scales: {
          // FESTER Wertebereich auf BEIDEN Achsen, nicht Chart.js' Auto-Fit.
          // `project2d` skaliert x und y mit DEMSELBEN Faktor in die Box [-1,1];
          // liesse man Chart.js selbst skalieren, streckte es eine schmale
          // y-Streuung auf die volle Canvas-Höhe — und genau die Verzerrung,
          // die die Projektion vermeidet, käme in der Anzeige zurück.
          // Zusammen mit dem quadratischen Rahmen (--> buchlandkarte.css,
          // aspect-ratio: 1) ergibt das gleiche Einheiten auf beiden Achsen.
          //
          // Zahlenwerte sind bedeutungslos → keine Ticks. Das Gitter bleibt als
          // Orientierung für Abstände.
          x: { min: -1, max: 1, grid: { color: gridLine }, ticks: { display: false }, title: { display: false } },
          y: { min: -1, max: 1, grid: { color: gridLine }, ticks: { display: false }, title: { display: false } },
        },
      },
    });
    // Für Screenreader und als Titel-Attribut: das Canvas selbst ist stumm.
    canvas.setAttribute('aria-label', t('buchlandkarte.canvasAria', { n: res.pages.length }));
  },

  // ── Kennzahlen-Zeilen fürs Template ───────────────────────────────────────

  /** Kapitel-Zeilen mit aufgelösten Namen (sortableTable rendert `sorted`). */
  bookMapChapterRows() {
    const rows = this.bookMapResult?.chapters || [];
    return rows.map(c => ({
      ...c,
      name: this.bookMapChapterName(c.chapterId),
      nearestName: c.nearestChapterId == null ? '' : this.bookMapChapterName(c.nearestChapterId),
      cohesionPct: c.cohesion == null ? null : Math.round(c.cohesion * 100),
      spreadPct: c.spread == null ? null : Math.round(c.spread * 100),
      nearestPct: c.nearestScore == null ? null : Math.round(c.nearestScore * 100),
    }));
  },

  bookMapOutlierRows() {
    const rows = this.bookMapResult?.outliers || [];
    return rows.map(o => ({
      ...o,
      name: this.bookMapPageName(o.id),
      chapterName: this.bookMapChapterName(o.chapterId),
      distancePct: Math.round((o.distance ?? 0) * 100),
    }));
  },

  /** Reicht die Datenlage fuer eine Karte? Sonst nur die Kennzahlen darunter. */
  bookMapHasMap() {
    return (this.bookMapResult?.pages?.length || 0) >= MIN_MAP_POINTS;
  },

  /**
   * Aussagekraft der Projektion als Band für den Hinweistext. Unter einem
   * Drittel erklärter Streuung ist das Bild eine schwache Skizze und darf keine
   * Nähe behaupten — der Hinweis sagt das, statt es dem Betrachter zu überlassen.
   */
  bookMapVarianceBand() {
    const v = this.bookMapResult?.explainedVariance ?? 0;
    if (v >= 0.5) return 'strong';
    if (v >= 0.3) return 'ok';
    return 'weak';
  },

  bookMapVariancePct() {
    return Math.round((this.bookMapResult?.explainedVariance ?? 0) * 100);
  },
};
