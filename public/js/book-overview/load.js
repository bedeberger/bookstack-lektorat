// Load-Pipeline + Memo-Helper.
// `loadBookOverview` holt alle voneinander unabhängigen Tile-Endpoints parallel
// und schreibt das Resultat in den State. `_checkBookStatsStaleness` läuft
// anschliessend silent im Hintergrund; `resetBookOverview` setzt State + Memos
// beim Buchwechsel auf den Initialstand zurück.
import { fetchJsonRetry as fetchJsonRetryBase } from '../utils.js';
import { komplettHiddenFor } from '../cards/feature-registry.js';

const fetchJsonRetry = (url, opts) => fetchJsonRetryBase(url, opts, 'bookOverview');

// Initialer Tile-State der Karte. SSoT für BEIDE Seiten: die Card-Registrierung
// spreadet das Objekt als Startzustand, `resetBookOverview` weist es beim
// Buchwechsel erneut zu. Vorher waren das zwei handgepflegte Listen mit je 19
// Feldern, die synchron bleiben mussten.
export function initialOverviewState() {
  return {
    overviewLoading: false,
    overviewBookId: null,
    overviewStats: [],
    overviewCoverage: null,
    overviewHeat: null,
    overviewLastReview: null,
    overviewPrevReview: null,
    overviewRecent: [],
    overviewFiguren: [],
    overviewSzenen: [],
    overviewOrte: [],
    overviewSongs: [],
    overviewLektoratTime: null,
    overviewIsFinished: false,
    overviewDailyGoalChars: null,
    overviewGoalTargetChars: null,
    overviewGoalDeadline: null,
    overviewBuchtyp: null,
    overviewRueckblickCoverage: null,
    overviewPlot: null,
    overviewMotifs: null,
    overviewLoadErrors: [],
  };
}

export const loadMethods = {
  async loadBookOverview(bookId, opts = {}) {
    if (!bookId) return;
    // Dedupe: laufender Load fürs gleiche Buch wird ignoriert. Buchwechsel
    // setzt _loadingBookId auf die neue ID; In-flight-Antworten fürs alte
    // Buch fallen unten durch den overviewBookId-Guard raus.
    if (this._loadingBookId === bookId) return;
    this._loadingBookId = bookId;
    this.overviewLoading = true;
    this.overviewBookId = bookId;
    // Fehlgeschlagene Endpoints sammeln (nach dem einen Retry aus fetchJsonRetry),
    // statt sie still zu schlucken — die Overview zeigt danach einen dezenten
    // Hinweis + Retry, damit ein ausgefallenes Tile nicht als „keine Daten"
    // missverstanden wird.
    const failed = [];
    const guard = (key, fallback) => (e) => {
      failed.push(key);
      console.warn(`[bookOverview] ${key} fehlgeschlagen`, e);
      return fallback;
    };
    try {
      // Plot-Board + Motiv-Konstellation sind optionale Planungswerkzeuge (pro
      // Buch + User, editor-skopiert für Plot). Ihr Fehlen ist normal (nie geplant)
      // bzw. erwartbar (Reader ohne Editor-Recht → 403 auf /plot) — darum stiller
      // Catch statt `guard`, damit ein 403/leerer Payload NICHT den Fehler-Banner
      // auslöst. Das Tile bleibt bei fehlenden Daten via x-if einfach aus.
      const [shared, coverage, heat, reviews, recent, figuren, szenen, orte, songs, lektoratTime, plot, motifs] = await Promise.all([
        this._loadSharedBookStats(bookId, opts),
        fetchJsonRetry(`/history/coverage/${bookId}`).catch(guard('coverage', null)),
        fetchJsonRetry(`/history/fehler-heatmap/${bookId}?mode=open`).catch(guard('heat', null)),
        fetchJsonRetry(`/history/review/${bookId}`).catch(guard('review', [])),
        fetchJsonRetry(`/usage/page/recent?book_id=${bookId}&limit=5`).catch(guard('recent', [])),
        fetchJsonRetry(`/figures/${bookId}`).catch(guard('figuren', null)),
        fetchJsonRetry(`/figures/scenes/${bookId}`).catch(guard('szenen', null)),
        fetchJsonRetry(`/locations/${bookId}`).catch(guard('orte', null)),
        fetchJsonRetry(`/songs/${bookId}`).catch(guard('songs', null)),
        fetchJsonRetry(`/history/lektorat-time/${bookId}`).catch(guard('lektorat', null)),
        fetchJsonRetry(`/plot?book_id=${bookId}`).catch(() => null),
        fetchJsonRetry(`/motifs?book_id=${bookId}`).catch(() => null),
      ]);
      if (this.overviewBookId !== bookId) return;
      const settings = shared?.settings || null;
      failed.push(...(shared?.failed || []));
      this.overviewStats = Array.isArray(shared?.stats) ? shared.stats : [];
      this.overviewCoverage = coverage || null;
      this.overviewHeat = heat || null;
      const reviewArr = Array.isArray(reviews) ? reviews : [];
      this.overviewLastReview = reviewArr[0] || null;
      this.overviewPrevReview = reviewArr[1] || null;
      this.overviewRecent = Array.isArray(recent) ? recent : [];
      this.overviewFiguren = Array.isArray(figuren?.figuren) ? figuren.figuren : [];
      this.overviewSzenen = Array.isArray(szenen?.szenen) ? szenen.szenen : [];
      this.overviewOrte = Array.isArray(orte?.orte) ? orte.orte : [];
      this.overviewSongs = Array.isArray(songs?.songs) ? songs.songs : [];
      this.overviewLektoratTime = lektoratTime || null;
      this.overviewIsFinished = !!settings?.is_finished;
      this.overviewDailyGoalChars = settings?.daily_goal_chars != null ? Number(settings.daily_goal_chars) : null;
      this.overviewGoalTargetChars = settings?.goal_target_chars != null ? Number(settings.goal_target_chars) : null;
      this.overviewGoalDeadline = settings?.goal_deadline || null;
      this.overviewBuchtyp = settings?.buchtyp || null;
      this.overviewPlot = plot && Array.isArray(plot.beats) ? plot : null;
      this.overviewMotifs = motifs && Array.isArray(motifs.motifs) ? motifs : null;
      this._memos = {};
      // Rückblick-Heatmap-Coverage nur für Tagebücher laden — der Buchtyp steht
      // erst nach `settings` fest, daher sequenziell (non-Tagebuch fetcht nie).
      this.overviewRueckblickCoverage = null;
      if (this.overviewBuchtyp === 'tagebuch') {
        const cov = await fetchJsonRetry(`/history/rueckblick-coverage/${bookId}`).catch(guard('rueckblick', null));
        if (this.overviewBookId !== bookId) return;
        this.overviewRueckblickCoverage = cov || null;
      }
      this.overviewLoadErrors = failed;
    } catch (e) {
      console.error('[loadBookOverview]', e);
    } finally {
      if (this._loadingBookId === bookId) this._loadingBookId = null;
      if (this.overviewBookId === bookId) this.overviewLoading = false;
    }
    // Background-Auto-Sync: vergleiche pages[].updated_at gegen page_stats-Cache.
    // Wenn Seiten seit dem letzten Sync editiert wurden → /sync/book im Hintergrund,
    // danach Overview-Tiles refreshen. Silent (kein Spinner / Status).
    this._checkBookStatsStaleness(bookId);
  },

  // Snapshot-Verlauf + Buch-Einstellungen kommen aus dem GETEILTEN Loader
  // (app-view/bookscope.js#loadDailyProgress) — es sind exakt die zwei
  // Antworten, die auch der Header-Donut braucht. `reuse` beim normalen
  // Oeffnen, frisch beim ausdruecklichen Refresh (Knopf / Re-Klick auf die
  // Karte). Was sich waehrend der Sitzung am Umfang aendert, faengt ohnehin
  // der Staleness-Check unten ab, nicht ein erneuter Fetch derselben Liste.
  //
  // Fallback auf eigene Fetches, solange kein App-Root steht: die Karte darf
  // sich nicht darauf verlassen, und die Unit-Tests mounten die Methoden ohne
  // Wurzel.
  async _loadSharedBookStats(bookId, { fresh = false } = {}) {
    const app = typeof window !== 'undefined' ? window.__app : null;
    if (app?.loadDailyProgress) return app.loadDailyProgress(bookId, { reuse: !fresh });
    const failed = [];
    const grab = (key, fallback) => (e) => {
      failed.push(key);
      console.warn(`[bookOverview] ${key} fehlgeschlagen`, e);
      return fallback;
    };
    const [stats, settings] = await Promise.all([
      fetchJsonRetry(`/history/book-stats/${bookId}`).catch(grab('stats', [])),
      fetchJsonRetry(`/booksettings/${bookId}`).catch(grab('settings', null)),
    ]);
    return { stats: Array.isArray(stats) ? stats : [], settings: settings || null, failed };
  },

  // True, sobald die Karte zerstört wurde (Lifecycle-AbortController). Die
  // Hintergrund-Kette unten prüft das an jedem await-Punkt, damit ein Unmount
  // während des Wartens keinen /sync/book mehr nachschiebt.
  _overviewAborted() {
    return this._lifecycle?.signal?.aborted === true;
  },

  // Silent background staleness check + auto-sync. Re-Entry-sicher via _staleCheckBookId
  // und _statsSyncBookId. Während des Post-Sync-Reloads bleibt _statsSyncBookId gesetzt,
  // damit der rekursive Check sofort returnt (kein Loop).
  //
  // Das Stale-Urteil fällt der Server (`POST /history/stats-stale`) — SSoT über
  // page_stats + book_stats_history. Der Client liefert nur seine autoritative
  // Content-Store-Seitenliste ({ id, updated_at }).
  async _checkBookStatsStaleness(bookId) {
    if (!bookId) return;
    if (typeof window === 'undefined') return;
    const app = window.__app;
    if (!app) return;
    if (this._statsSyncBookId === bookId) return;
    if (this._staleCheckBookId === bookId) return;
    this._staleCheckBookId = bookId;
    try {
      // Nach Buchwechsel kann Alpine.store('nav').pages noch leer sein (loadPages async).
      // Kurz pollen, dann aufgeben.
      for (let i = 0; i < 30 && (!Alpine.store('nav').pages || !Alpine.store('nav').pages.length); i++) {
        await new Promise(r => setTimeout(r, 100));
        if (this._overviewAborted()) return;
        if (Alpine.store('nav').selectedBookId !== bookId) return;
      }
      const pages = Alpine.store('nav').pages || [];
      if (!pages.length) return;
      const payload = pages.map(p => ({ id: p.id, updated_at: p.updated_at }));
      const verdict = await fetchJsonRetry(`/history/stats-stale/${bookId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pages: payload }),
      }).catch(() => null);
      if (!verdict?.stale) return;
      if (this._overviewAborted()) return;
      if (Alpine.store('nav').selectedBookId !== bookId) return;
      this._statsSyncBookId = bookId;
      try {
        const res = await fetch(`/sync/book/${bookId}`, { method: 'POST' });
        if (!res.ok) return;
        if (this._overviewAborted()) return;
        if (!app.showBookOverviewCard || Alpine.store('nav').selectedBookId !== bookId) return;
        // Gezielter Reload: nur die stats-abhängigen Tiles + tokEsts, NICHT alle
        // Endpoints — Figuren/Orte/Szenen/Reviews/… ändert ein Stats-Sync nicht.
        await this._reloadStatsTiles(bookId, pages, app);
      } finally {
        if (this._statsSyncBookId === bookId) this._statsSyncBookId = null;
      }
    } catch (e) {
      console.warn('[bookOverview] staleness auto-sync failed', e);
    } finally {
      if (this._staleCheckBookId === bookId) this._staleCheckBookId = null;
    }
  },

  // Refresh nach Auto-Sync: nur Snapshot-Verlauf + Coverage neu holen und tokEsts
  // aktualisieren. tokEsts REASSIGN (nicht Index-Assign): book-overview-Methoden
  // memoizen mit der tokEsts-Ref als Source — dieselbe Referenz behalten hiesse
  // Cache-Hit → stale Compute (Streak-Heatmap: heutige Cell fehlt). Reassign
  // triggert Memo-Invalidate. Gleicher tokEsts-Pfad wie syncBookStats in bookstats.js.
  async _reloadStatsTiles(bookId, pages, app) {
    const [stats, coverage, fresh] = await Promise.all([
      fetchJsonRetry(`/history/book-stats/${bookId}`).catch(() => null),
      fetchJsonRetry(`/history/coverage/${bookId}`).catch(() => null),
      fetchJsonRetry(`/history/page-stats/${bookId}`).catch(() => null),
    ]);
    if (this._overviewAborted()) return;
    if (this.overviewBookId !== bookId || Alpine.store('nav').selectedBookId !== bookId) return;
    if (Array.isArray(stats)) {
      this.overviewStats = stats;
      // Der Header-Donut liest dieselbe Zeitreihe aus dem geteilten Store.
      // Ohne dieses Nachziehen zeigte er nach dem Hintergrund-Sync weiter den
      // Stand von davor, waehrend die Kachel daneben schon den neuen hatte.
      app.publishDailyProgressStats?.(bookId, stats);
    }
    if (coverage) this.overviewCoverage = coverage;
    if (fresh) {
      const updated = { ...app.tokEsts };
      for (const p of pages) {
        const c = fresh[p.id];
        if (c && c.updated_at === p.updated_at) {
          updated[p.id] = { tok: c.tok, words: c.words, chars: c.chars };
        }
      }
      app.tokEsts = updated;
    }
    this._memos = {};
  },

  // Tagebücher (buchtyp 'tagebuch') sind Ich-Perspektive + datierte Einträge ohne
  // Ensemble/Dramaturgie — die narrativen Analyse-Tiles (Figuren-/Schauplatz-Matrix,
  // Szenen-Wertung, Kapitel-Verteilung/-Findings) sind dort bedeutungslos und werden
  // ausgeblendet. Schreibstats/Streak, Lektorat, Bewertung, Recent und die
  // Figuren-/Orte-Top-Listen bleiben.
  overviewIsTagebuch() {
    return this.overviewBuchtyp === 'tagebuch';
  },

  // True, wenn das Buch Seiten hat, die Komplettanalyse (Figuren/Schauplätze/
  // Szenen) aber noch nie gelaufen ist — dann zeigt die Overview ein einzelnes
  // CTA-Tile statt drei leerer Zählkacheln kommentarlos auszublenden. Tagebücher
  // haben bewusst keine narrative Analyse und sind ausgenommen; Buchtypen, in
  // denen die Komplettanalyse gar nicht angeboten wird (Ressort), ebenfalls —
  // ein Handlungsaufruf ohne erreichbares Ziel wäre eine Sackgasse.
  overviewNeedsAnalysis() {
    if (this.overviewIsTagebuch()) return false;
    if (komplettHiddenFor(this.overviewBuchtyp)) return false;
    if (!(Alpine.store('nav').pages || []).length) return false;
    return this.overviewFigurenCount() === 0
      && this.overviewSzenenCount() === 0
      && this.overviewOrteCount() === 0;
  },

  resetBookOverview() {
    Object.assign(this, initialOverviewState());
    this._memos = {};
  },

  // Rollup-Helfer: alle per-Kapitel-Tiles aggregieren Sub-Kapitel auf ihr
  // Wurzel-Kapitel (Top-Level, depth=1). Tree ist flach + depth-annotiert
  // (siehe tree.js#loadPages). Solo-Wrapper (Spezialseiten ohne Kapitel)
  // ausgeklammert — verzerren sonst Median/Skalierung. Name-Map als
  // Fallback für Server-Rows, die nur `chapter_name` ohne `chapter_id`
  // liefern (Backfill-Lücken).
  _chapterRollup() {
    const tree = Alpine.store('nav').tree || [];
    return this._memo('rollup', [tree], () => {
      const chs = tree.filter(i => i.type === 'chapter' && !i.solo);
      const byId = new Map(chs.map(c => [Number(c.id), c]));
      const byName = new Map(chs.map(c => [c.name, c]));
      const rootCache = new Map();
      const rootOf = (id) => {
        if (id == null) return null;
        const key = Number(id);
        if (rootCache.has(key)) return rootCache.get(key);
        let cur = byId.get(key);
        const path = [key];
        while (cur?.parent_id != null) {
          const pid = Number(cur.parent_id);
          path.push(pid);
          cur = byId.get(pid);
        }
        for (const k of path) rootCache.set(k, cur || null);
        return cur || null;
      };
      const rootOfName = (name) => {
        if (!name) return null;
        const ch = byName.get(name);
        return ch ? rootOf(ch.id) : null;
      };
      // Root = ohne parent_id. Stabiler als depth===1 (legacy/tree-Fixtures
      // ohne depth-Annotation funktionieren weiter; Tree-Walker setzt depth=1
      // genau dann, wenn parent_id === null).
      const roots = chs.filter(c => c.parent_id == null);
      return { roots, rootOf, rootOfName, byId, byName };
    });
  },

  // Cache hit nur wenn ALLE Source-Refs (deps) identisch zur letzten Compute.
  // Wichtig für Tiles, die zusätzlich zu `overviewXxx` auch `Alpine.store('nav').tree`/
  // `app.figuren` lesen — sonst wird ein Compute mit leerem `tree` (während
  // loadPages noch läuft) als `null` cached und Tile bleibt aus, obwohl
  // tree danach befüllt wird (Haupt-Source-Ref unverändert). Memos, die
  // lokalisierte Strings backen, führen zusätzlich `_uiLocale()` in den Deps.
  _memo(key, deps, compute) {
    const memos = (this._memos ||= {});
    const hit = memos[key];
    if (hit && hit.deps.length === deps.length
        && hit.deps.every((d, i) => d === deps[i])) {
      return hit.value;
    }
    const value = compute();
    memos[key] = { deps: [...deps], value };
    return value;
  },
};
