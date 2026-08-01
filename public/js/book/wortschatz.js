// wortschatzMethods — Wortschatz-Analyse (quantitative Stilistik pro Buch).
// Rein rückwärtsgewandt: liest den abgeleiteten Index (GET /lexicon/:book_id),
// stösst den Scan als Job an (POST /jobs/lexicon-scan) und schreibt nie in den
// Buchtext. Gespreadet in cards/wortschatz-card.js.
//
// Die Analyse-Version kommt vom Server (`thresholds.version`) — hier steht KEINE
// Kopie davon. Genau an so einer Frontend-Kopie driftet die Stil-Heatmap gegen
// lib/page-index.js.

import { formatNumber, localeTag, tzOpts } from '../utils.js';

// Kein `get x()` in diesem gespreadeten Modul — Spread würde Getter beim Mount
// mit falschem `this` auslösen. Reine Getter leben inline im Karten-Literal.
export const wortschatzMethods = {
  async loadWortschatz() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) { this.wortschatzData = null; return; }
    this.wortschatzLoadError = false;
    try {
      const r = await fetch('/lexicon/' + encodeURIComponent(bookId), { credentials: 'same-origin' });
      if (!r.ok) { this.wortschatzData = null; this.wortschatzLoadError = true; return; }
      this.wortschatzData = await r.json();
    } catch {
      this.wortschatzData = null;
      this.wortschatzLoadError = true;
    }
  },

  // Scan anstossen. Manuell ausgelöst heisst „ich will jetzt eine Zahl sehen" —
  // der Server überspringt in diesem Pfad seinen Delta-Skip.
  async runWortschatzScan() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || this.wortschatzLoading) return;
    this.wortschatzLoading = true;
    this.wortschatzStatus = window.__app?.t?.('wortschatz.running') || '';
    try {
      const r = await fetch('/jobs/lexicon-scan', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.jobId) {
        this.wortschatzLoading = false;
        this.wortschatzStatus = window.__app?.t?.('wortschatz.error') || 'Fehler';
        return;
      }
      this._pollWortschatz(j.jobId);
    } catch (e) {
      this.wortschatzLoading = false;
      this.wortschatzStatus = e.message || 'error';
    }
  },

  _pollWortschatz(jobId) {
    const tick = async () => {
      try {
        const r = await fetch('/jobs/' + encodeURIComponent(jobId), { credentials: 'same-origin' });
        const j = await r.json().catch(() => ({}));
        if (j.status === 'done') {
          this.wortschatzLoading = false;
          this.wortschatzStatus = '';
          await this.loadWortschatz();
          return;
        }
        if (j.status === 'error' || j.status === 'cancelled') {
          this.wortschatzLoading = false;
          this.wortschatzStatus = window.__app?.t?.('wortschatz.error') || 'Fehler';
          return;
        }
        this.wortschatzProgress = j.progress || 0;
        this._wortschatzPollTimer = setTimeout(tick, 1000);
      } catch {
        this._wortschatzPollTimer = setTimeout(tick, 2000);
      }
    };
    tick();
  },

  // ── Formatierung ──────────────────────────────────────────────────────────
  // `null` wird zu „–", nicht zu „0". Der Unterschied ist fachlich: 0 heisst
  // „gemessen, Ergebnis null", null heisst „nicht messbar" (Text zu kurz für
  // MTLD/Heaps). Zahlen über die geteilte SSoT, nicht handgerollt.
  wsNum(v, decimals = 0) {
    return formatNumber(v == null ? null : Number(v), window.__app?.uiLocale, decimals);
  },

  wsPercent(v, decimals = 1) {
    if (v == null || !Number.isFinite(Number(v))) return '–';
    return this.wsNum(Number(v) * 100, decimals) + '%';
  },

  // Vergleichszeile „dein Median ist X" — nur wenn es überhaupt andere gescannte
  // Bücher gibt und die Kennzahl dort messbar war.
  wsPeer(key, decimals = 2, asPercent = false) {
    const p = this.wortschatzData?.peers;
    const v = p ? p[key] : null;
    if (v == null) return '';
    const shown = asPercent ? this.wsPercent(v, decimals) : this.wsNum(v, decimals);
    return window.__app?.t?.('wortschatz.peerMedian', { value: shown, books: p.books }) || '';
  },

  // MATTR ist nur längenrobust, wenn das Fenster voll war. War der Text kürzer,
  // liefert der Server die einfache TTR — das muss sichtbar sein, sonst hält der
  // Autor eine nicht vergleichbare Zahl für vergleichbar.
  wsMattrIsRobust() {
    const s = this.wortschatzData?.stats;
    const win = this.wortschatzData?.thresholds?.mattrWindow;
    if (!s || !win) return true;
    return (s.mattr_window || 0) >= win;
  },

  // Datums-Display Pflicht über tzOpts() (App-Zeitzone, nicht Browser-TZ).
  wsScannedAt() {
    const at = this.wortschatzData?.stats?.scanned_at;
    if (!at) return '';
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString(localeTag(window.__app?.uiLocale), tzOpts({
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }));
  },

  // Offenlegung des Deckels der Einmalwort-Liste: „300 von 4812". Ohne diese Zeile
  // liest sich ein Ausschnitt als Vollständigkeit — rund die Hälfte aller
  // Wortformen eines Buchs kommt genau einmal vor. Leerstring, solange die Liste
  // wirklich vollständig ist (dann gibt es nichts offenzulegen).
  wsHapaxCapped() {
    const total = this.wortschatzData?.stats?.hapax_listed;
    const shown = this.wortschatzHapax.length;
    if (total == null || !shown || total <= shown) return '';
    return window.__app?.t?.('wortschatz.hapax.capped', {
      shown: this.wsNum(shown), total: this.wsNum(total),
    }) || '';
  },

  // Keyness-Band für die Badge-Färbung. Positiv = in diesem Buch auffällig
  // häufig, negativ = auffällig gemieden.
  wsKeynessClass(v) {
    if (v == null) return '';
    if (v >= 15) return 'wortschatz-keyness--high';
    if (v > 0) return 'wortschatz-keyness--mid';
    return 'wortschatz-keyness--neg';
  },

  wsGotoPage(pageId) {
    if (pageId == null) return;
    window.__app?.gotoPageById?.(Number(pageId));
  },
};
