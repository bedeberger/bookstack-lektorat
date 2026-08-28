import { fetchJson } from '../../utils.js';
import { contentRepo } from '../../repo/content.js';
import { EVT } from '../../events.js';

// Buch-/Seiten-Laden + Tree-Build, Buchwahl-Combobox, Kapitel-Anlage,
// Token-Estimate-Backfill (Server-Push + IntersectionObserver-Lazy).
// `this` = die Alpine-Komponente.

// Ordnungs-Invariante von nav.tree: flach, aber DEPTH-FIRST — Solo-Seiten
// zuerst, dann Kapitel in Lese-Reihenfolge, Sub-Kapitel direkt hinter ihrem
// Parent. Die Sidebar (app.js#filteredTree) filtert nur und rendert in
// Array-Reihenfolge. Deshalb wird der Tree NIE global nach `priority` sortiert:
// priority ist die Position INNERHALB des Parents und wuerde Sub-Kapitel aus
// ihrem Parent herausreissen. Neue Items werden stattdessen an der berechneten
// Stelle eingefuegt.
//
// `afterChapterId` → direkt hinter dieses Kapitel UND seinen kompletten Subtree.
// `beforeChapterId` → an dessen Position (Fallback, wenn es kein Vorgaenger-
// Kapitel gibt). Ohne beides → ans Ende (neues Top-Level-Kapitel ist
// depth-first das letzte Item).
export function insertChapterItem(tree, item, { afterChapterId = null, beforeChapterId = null } = {}) {
  const idxOf = (id) => tree.findIndex(
    i => i.type === 'chapter' && !i.solo && String(i.id) === String(id));
  if (afterChapterId != null) {
    const at = idxOf(afterChapterId);
    if (at >= 0) {
      const anchorDepth = tree[at].depth || 1;
      let end = at + 1;
      while (end < tree.length && (tree[end].depth || 1) > anchorDepth) end++;
      const next = [...tree];
      next.splice(end, 0, item);
      return next;
    }
  }
  if (beforeChapterId != null) {
    const at = idxOf(beforeChapterId);
    if (at >= 0) {
      const next = [...tree];
      next.splice(at, 0, item);
      return next;
    }
  }
  return [...tree, item];
}

export const treeLoadMethods = {
  async refreshPageAges() {
    const bookId = this.$store.nav.selectedBookId;
    if (!bookId) return;
    try {
      const map = await fetchJson('/history/page-ages/' + bookId);
      if (this.$store.nav.selectedBookId === bookId) this.pageLastChecked = map || {};
    } catch { /* ignore */ }
  },

  async loadBooks(opts = {}) {
    try {
      this.setStatus(this.t('tree.connecting'), true);
      this.$store.nav.books = await contentRepo.listBooks({ fresh: opts.fresh === true });
      // Wake-Refresh: Caller (_refreshAfterWake) triggert loadPages selbst mit source='wake'.
      // Hier weiterzureichen würde Tree erneut clearen (loadPages ohne source) → Flicker.
      // skipPages: für Metadaten-only-Refreshes (Kategorie/Tag/Rename) — Pagetree bleibt stehen.
      const skipLoadPages = opts.source === 'wake' || opts.skipPages === true;
      // Pool fuer Filter-Pills aus aktuellem Bestand ableiten.
      const catIds = new Set();
      for (const b of this.$store.nav.books) {
        if (b.category_id) catIds.add(b.category_id);
      }
      // Kategorie-Namen aus globalem Pool nachladen (kein Snapshot pro Buch).
      if (catIds.size > 0 && this.bookFilterCategoryPool.length === 0) {
        try {
          const r = await fetch('/local/categories');
          if (r.ok) this.bookFilterCategoryPool = (await r.json()).categories || [];
        } catch (_) {}
      }
      if (!this.$store.nav.selectedBookId || !this.$store.nav.books.some(b => String(b.id) === String(this.$store.nav.selectedBookId))) {
        let restored = '';
        try {
          const key = `sw:lastBookId:${this.$store.session.currentUser?.email || ''}`;
          const stored = localStorage.getItem(key);
          if (stored && this.$store.nav.books.some(b => String(b.id) === String(stored))) restored = String(stored);
        } catch (_) {}
        this.$store.nav.selectedBookId = restored || String(this.$store.nav.books[0]?.id || '');
      }
      this.showBookCard = true;
      this.booksLoaded = true;
      this.setStatus(this.t('tree.booksFound', { n: this.$store.nav.books.length }), false, 4000);
      if (this.$store.nav.selectedBookId) this._loadBookRole(this.$store.nav.selectedBookId);
      if (!skipLoadPages) await this.loadPages();
    } catch (e) {
      console.error('[loadBooks]', e);
      this.setStatus(this.t('common.errorColon') + e.message);
    }
  },

  // Optionen fuer die Buchwahl-Combobox. Existieren Kategorien, kriegt jedes Buch
  // ein `group`-Feld (= Kategoriename) → die Combobox rendert Gruppen-Header
  // (siehe combobox.js#groupedRows). Reihenfolge: kategorisierte Buecher zuerst
  // (alphabetisch nach Kategorie, dann Titel), unkategorisierte unter einer
  // eigenen "Ohne Kategorie"-Gruppe am Ende. Hat kein Buch eine Kategorie, bleibt
  // `group` leer → flache Liste (byte-gleich zum ungruppierten Verhalten).
  // Liest this.$store.nav.books + this.bookFilterCategoryPool im x-effect → reaktiv getrackt.
  bookComboOptions() {
    const names = new Map(this.bookFilterCategoryPool.map(c => [String(c.id), c.name]));
    const selected = String(this.$store.nav.selectedBookId || '');
    // Regal-Zustand aus der Karte „Meine Buecher" (book_shelf, pro User):
    // Archiviertes verschwindet aus der Buchwahl — genau dafuer archiviert man.
    // Ausnahme ist das aktuell gewaehlte Buch: es aus seiner eigenen Auswahl zu
    // entfernen liesse die Combobox leer aussehen, obwohl ein Buch offen ist.
    const source = this.$store.nav.books.filter(b => !b.archived || String(b.id) === selected);
    const hasCategories = source.some(b => b.category_id && names.has(String(b.category_id)));
    const uncategorized = hasCategories ? this.t('book.filter.uncategorized') : '';
    const opts = source.map(b => {
      const cat = b.category_id ? names.get(String(b.category_id)) : null;
      return { value: String(b.id), label: b.name, group: cat || uncategorized, pinned: !!b.pinned };
    });
    // Angeheftete zuerst — in beiden Varianten (mit und ohne Kategorien), sonst
    // haengt die Wirkung des Pins daran, ob Kategorien gepflegt sind. Ohne
    // Kategorien bleibt die Server-Reihenfolge darunter erhalten (stabil ueber
    // den Index): eine Alphabetisierung waere eine Verhaltensaenderung fuer
    // jeden, der nichts angeheftet hat.
    const byPin = (a, b) => (a.pinned === b.pinned ? 0 : a.pinned ? -1 : 1);
    if (!hasCategories) {
      const idx = new Map(opts.map((o, i) => [o, i]));
      return opts.sort((a, b) => byPin(a, b) || idx.get(a) - idx.get(b));
    }
    return opts.sort((a, b) => {
      const p = byPin(a, b);
      if (p) return p;
      const au = a.group === uncategorized, bu = b.group === uncategorized;
      if (au !== bu) return au ? 1 : -1; // Unkategorisierte ans Ende
      if (a.group !== b.group) return a.group.localeCompare(b.group);
      return a.label.localeCompare(b.label);
    });
  },

  async loadPages(opts = {}) {
    const bookId = this.$store.nav.selectedBookId;
    if (!bookId) return;
    // Laufenden Figuren-Job-Poll abbrechen (Buch könnte gewechselt haben).
    // checkPendingJobs am Ende reconnectet korrekt für das neue Buch.
    if (this._figuresPollTimer) { clearInterval(this._figuresPollTimer); this._figuresPollTimer = null; }
    this.$store.catalogUi.figurenLoading = false;
    this.$store.catalogUi.figurenProgress = 0;
    this.$store.catalogUi.figurenStatus = '';
    // Vorherigen Buch-Load abbrechen (Buchwechsel während laufendem bookTree
    // bei grossem Buch sonst: Request hängt 30s am Netz, Server verarbeitet
    // weiter, Browser-Slot blockiert). Stale-Guards verwerfen zwar Resultate,
    // brechen aber nichts ab. Re-Entry-Guard, nur in dieser Methode + dem
    // book-switch-Reset gelesen — daher keine Initial-Feld-Deklaration.
    this._bookLoadAbort?.abort(new DOMException('book switch', 'AbortError'));
    const loadCtrl = new AbortController();
    this._bookLoadAbort = loadCtrl;
    const signal = loadCtrl.signal;
    this.treeLoading = true;
    // Sidebar-Mode SYNCHRON vor dem Page-Fetch setzen: Tagebuch öffnet Kalender,
    // sonst Tree. Buchtyp ist aus der bereits geladenen `books`-Liste sofort
    // bekannt (currentBuchtyp), daher kein Warten auf den Fetch nötig — sonst
    // sieht der User für die Fetch-Dauer den Tree und es springt danach in den
    // Kalender. User-Auswahl überlebt Buchwechsel/Reload bewusst nicht, damit
    // Tagebuch-User den Kalender verlässlich beim Aufruf sehen.
    this.sidebarMode = this.isTagebuch() ? 'calendar' : 'tree';
    this.diaryCalendarYearMonth = null;
    this.diaryAnniversaryOpen = this._loadDiaryAnniversaryOpen();
    try {
      this.setStatus(this.t('tree.loadingPages'), true);
      // Tree/Pages werden NICHT vorab geleert — alter Tree bleibt sichtbar
      // (CSS dimmt + blockiert Klicks via .tree-card--loading), bis der neue
      // Tree da ist. Bei Fetch-Fail (Session, Timeout) räumt der catch-Block
      // explizit auf, statt einen Sackgassen-Tree mit Seiten aus dem alten
      // Buch stehen zu lassen. Wake-Refresh clear't ohnehin nichts.
      if (opts.source !== 'wake') {
        this.pageSearch = '';
        this.pageSearchActiveIndex = 0;
        this._pageSearchActiveId = null;
        this._filteredTreeMemo = null;
        this.tokEsts = {};
        this.pageLastChecked = {};
        const badges = this.$store.badges;
        badges.ideenCounts = {};
        badges.chapterIdeenCounts = {};
        badges.rechercheCounts = {};
        badges.chapterRechercheCounts = {};
        badges.plotBeatCounts = {};
        badges.chapterPlotBeatCounts = {};
        badges.shareCommentCounts = {};
        badges.shareLinkCounts = {};
      }
      this._tokenEstGen++;
      // Buchwechsel: SW-CONTENT_CACHE (SWR) kann stale Listen liefern, daher fresh.
      // Initialer Load greift normal aufs Cache (offline-resilient).
      const fresh = opts.source === 'bookSwitch';
      const tree = await contentRepo.bookTree(bookId, { fresh, signal });

      // Buch wurde gewechselt während die Anfrage lief → veraltete Daten verwerfen.
      if (this.$store.nav.selectedBookId !== bookId) return;

      // pages-Cache im Hintergrund aktualisieren (fire-and-forget)
      const qs = opts.source ? `?source=${encodeURIComponent(opts.source)}` : '';
      fetch('/sync/pages/' + bookId + qs, { method: 'POST', signal }).catch(() => {});

      // contentRepo.bookTree liefert Kapitel nested (subchapters[]) + topPages
      // fuer Seiten ohne Kapitel. UI-Items behalten internes `priority`-Feld
      // als Sort-Schluessel. Sidebar-Tree wird flach + depth-annotiert gebaut:
      // jedes Kapitel kennt seine Tiefe (1-3) und parent_id; Reihenfolge ist
      // Depth-First, damit Sub-Kapitel visuell unter ihrem Parent stehen.
      const sortedChapters = tree.chapters;
      const flatChapters = []; // [{ id, name, position, _depth, _parent_id, pages }]
      const walkChapters = (chapters, depth, parentId) => {
        for (const c of chapters) {
          flatChapters.push({
            id: c.id,
            name: c.name,
            position: c.position,
            excluded: !!c.excluded,
            pages: c.pages || [],
            _depth: depth,
            _parent_id: parentId,
          });
          walkChapters(c.subchapters || [], depth + 1, c.id);
        }
      };
      walkChapters(sortedChapters, 1, null);
      const chMap = Object.fromEntries(flatChapters.map(c => [c.id, c.name]));
      const childCountMap = new Map();
      for (const c of flatChapters) {
        if (c._parent_id) childCountMap.set(c._parent_id, (childCountMap.get(c._parent_id) || 0) + 1);
      }

      const decoratePage = (p) => ({
        ...p,
        priority: p.position, // legacy alias fuer UI-Sortierung + drag/drop
        chapterName: p.chapter_id ? (chMap[p.chapter_id] || this.t('tree.chapterFallback')) : null,
      });

      // Seiten ohne Kapitel immer zuerst — danach Kapitel in Tree-Reihenfolge.
      this.$store.nav.pages = [
        ...tree.topPages.map(decoratePage),
        ...flatChapters.flatMap(c => c.pages.map(decoratePage)),
      ];

      const openState = this._loadTreeOpenState(bookId);
      this.$store.nav.tree = [
        ...this.$store.nav.pages.filter(p => !p.chapter_id).map(p => ({
          type: 'chapter',
          id: 'solo-' + p.id,
          name: p.name,
          priority: p.priority,
          depth: 1,
          parent_id: null,
          open: true,
          solo: true,
          pages: [p],
        })),
        ...flatChapters.map(c => ({
          type: 'chapter',
          id: c.id,
          name: c.name,
          priority: c.position,
          depth: c._depth,
          parent_id: c._parent_id,
          excluded: c.excluded,
          open: Object.prototype.hasOwnProperty.call(openState, c.id) ? !!openState[c.id] : true,
          solo: false,
          hasChildren: (childCountMap.get(c.id) || 0) > 0,
          pages: this.$store.nav.pages.filter(p => p.chapter_id === c.id),
        })),
      ];

      // Persistent sort maps – built once per book load, used by all filter sorting
      this._chapterOrderMap = new Map();
      let chIdx = 0;
      for (const item of this.$store.nav.tree) {
        if (item.type === 'chapter' && !item.solo) this._chapterOrderMap.set(item.name, chIdx++);
      }
      this._pageOrderMap = new Map();
      this._pageIdOrderMap = new Map();
      for (let i = 0; i < this.$store.nav.pages.length; i++) {
        const p = this.$store.nav.pages[i];
        if (!this._pageOrderMap.has(p.name)) this._pageOrderMap.set(p.name, i);
        this._pageIdOrderMap.set(p.id, i);
      }
      this._refreshChapterStats();

      // Gecachte Stats + Page-Ages + Ideen-Counts (Page + Chapter) + Recherche-Counts laden
      try {
        const [statsCache, ageMap, ideenMap, chapterIdeenMap, rechercheMap, chapterRechercheMap, shareCommentMap, shareLinkMap, plotBeatMap, chapterPlotBeatMap] = await Promise.all([
          fetchJson('/history/page-stats/' + bookId, { signal }),
          fetchJson('/history/page-ages/' + bookId, { signal }),
          fetchJson('/ideen/counts?book_id=' + bookId, { signal }).catch(() => ({})),
          fetchJson('/ideen/counts?book_id=' + bookId + '&kind=chapter', { signal }).catch(() => ({})),
          fetchJson('/research/page-counts?book_id=' + bookId, { signal }).catch(() => ({})),
          fetchJson('/research/chapter-counts?book_id=' + bookId, { signal }).catch(() => ({})),
          fetchJson('/share/api/page-comment-counts?book_id=' + bookId, { signal }).catch(() => ({})),
          fetchJson('/share/api/page-link-counts?book_id=' + bookId, { signal }).catch(() => ({})),
          fetchJson('/plot/page-beat-counts?book_id=' + bookId, { signal }).catch(() => ({})),
          fetchJson('/plot/chapter-beat-counts?book_id=' + bookId, { signal }).catch(() => ({})),
        ]);
        this.pageLastChecked = ageMap || {};
        const badges = this.$store.badges;
        badges.ideenCounts = ideenMap || {};
        badges.chapterIdeenCounts = chapterIdeenMap || {};
        badges.rechercheCounts = rechercheMap || {};
        badges.chapterRechercheCounts = chapterRechercheMap || {};
        badges.shareCommentCounts = shareCommentMap || {};
        badges.shareLinkCounts = shareLinkMap || {};
        badges.plotBeatCounts = plotBeatMap || {};
        badges.chapterPlotBeatCounts = chapterPlotBeatMap || {};
        // Editor-Badge der offenen Seite mit frischer Map abgleichen (Race: Seite
        // kann vor dem Counts-Fetch via restoreLastPage geöffnet worden sein).
        if (this.currentPage?.id) {
          this.currentPageRechercheCount = badges.rechercheCounts[this.currentPage.id] || 0;
          this.currentPageShareCommentCount = badges.shareCommentCounts[this.currentPage.id] || 0;
          this.currentPageShareLinkCount = badges.shareLinkCounts[this.currentPage.id] || 0;
          this.currentPagePlotBeatCount = badges.plotBeatCounts[this.currentPage.id] || 0;
        }
        // Cache-Hits in einem Rutsch zuweisen (statt Index-Assign in der Loop),
        // damit der tokEsts-$watch in app.js#init feuert und die Kapitel-Stats
        // synchron mit dem ersten Tree-Render aktualisiert.
        const initialTokEsts = {};
        for (const p of this.$store.nav.pages) {
          const c = statsCache[p.id];
          if (c && c.updated_at === p.updated_at) {
            initialTokEsts[p.id] = { tok: c.tok, words: c.words, chars: c.chars };
          }
        }
        if (Object.keys(initialTokEsts).length) this.tokEsts = initialTokEsts;
      } catch { /* Cache-Fehler ignorieren, Fallback auf Live-Berechnung */ }

      this.showTreeCard = true;
      // sidebarMode + diaryCalendarYearMonth werden bereits synchron vor dem
      // Fetch gesetzt (siehe oben), damit der Kalender nicht erst nach dem
      // Page-Load aus dem Tree aufpoppt.
      this.setStatus('');
      // Geöffnete Seite frisch nachziehen (User klickt "Neuladen" → erwartet
      // auch im Editor den aktuellen Server-Stand). Aktive Edits nicht
      // überschreiben — gleiche Regel wie beim Re-Klick auf offene Seite.
      if (this.currentPage
          && String(this.currentPage.book_id) === String(bookId)
          && !this.editMode && !this.editDirty) {
        this._refetchCurrentPage();
      }
      await Promise.all([
        this.loadBookReviewHistory(bookId, { signal }),
        // loadKapitelReviewHistory lebt jetzt in Alpine.data('kapitelReviewCard')
        // und wird beim Öffnen der Karte (bzw. book:changed-Event) geladen.
        this.loadFiguren(bookId, { signal }),
        this.loadLastKomplettRun(bookId, { signal }),
      ]);
      this.checkPendingJobs(bookId); // Reconnect nach Tab-Schliessen, kein await
      this.loadTokenEstimates(this._tokenEstGen, signal); // Hintergrund, kein await
      // Karten, die einen frischen Tree brauchen (Buchorganizer), reagieren
      // explizit auf diesen Event statt auf einen $watch der Tree-Identität —
      // so können dieselben Karten auch In-Place-Mutationen am Tree machen,
      // ohne sich selbst rekursiv neu zu rendern.
      window.dispatchEvent(new CustomEvent(EVT.PAGES_LOADED, { detail: { bookId } }));
    } catch (e) {
      // AbortError = Buchwechsel hat laufenden Load gekillt — kein User-Fehler.
      // Nachfolge-Call managed treeLoading + Tree selbst, hier nichts touchen.
      if (e?.name === 'AbortError' || signal.aborted) return;
      console.error('[loadPages]', e);
      // Endgültiger Fail (Session expired, Timeout, Netz weg): alten Tree
      // verwerfen. Sonst sieht User Sackgassen-Tree mit Seiten aus dem alten
      // Buch und kann nicht navigieren (Klick → Page aus fremdem Buch).
      this.$store.nav.tree = [];
      this.$store.nav.pages = [];
      this.setStatus(this.t('common.errorColon') + e.message);
    } finally {
      // treeLoading freigeben, wenn dieser Call der aktuelle Owner ist ODER
      // niemand mehr Owner ist (Handle === null: _resetBookScopedState hat ihn
      // beim Abbruch genullt, ohne dass ein Folge-Load ihn übernommen hat).
      // Ohne diesen Failsafe bleibt die Sidebar bei verwaisten Abbrüchen (Wake-
      // Refresh, Buchwechsel-Ketten) dauerhaft gedimmt + klick-blockiert
      // (.tree-card--loading → pointer-events:none). Ein NEUERER Load (Handle
      // zeigt auf einen fremden Controller) besitzt das Flag weiter und setzt
      // es selbst zurück — den Fall bewusst NICHT anfassen.
      if (this._bookLoadAbort === loadCtrl) {
        this._bookLoadAbort = null;
        this.treeLoading = false;
      } else if (this._bookLoadAbort === null) {
        this.treeLoading = false;
      }
    }
  },

  // Sidebar-Empty-Book-CTA: fragt per appPrompt nach dem Namen und legt das
  // Kapitel an. createChapter() selbst liest newChapterTitle (vom Kapitel-Review-
  // Input gespeist) — ohne Input-Feld in der Sidebar wäre der Direktaufruf ein
  // No-op, darum hier der Prompt-Pfad.
  async createChapterPrompt() {
    const name = await this.appPrompt?.({
      message: this.t('bookOrganizer.promptChapterName'),
      placeholder: this.t('bookOrganizer.placeholderChapterName'),
      confirmLabel: this.t('bookOrganizer.create'),
    });
    if (!name) return null;
    this.newChapterTitle = name;
    return this.createChapter();
  },

  async createChapter({ afterChapterId } = {}) {
    const bookId = this.$store.nav.selectedBookId;
    const title = (this.newChapterTitle || '').trim();
    if (!bookId || !title || this.newChapterCreating) return null;
    this.newChapterCreating = true;
    this.newChapterError = '';
    try {
      const afterItem = afterChapterId
        ? this.$store.nav.tree.find(i => i.type === 'chapter' && !i.solo && String(i.id) === String(afterChapterId))
        : null;
      const body = { book_id: parseInt(bookId), name: title };
      if (afterItem && Number.isFinite(afterItem.priority)) body.position = afterItem.priority + 1;
      const created = await contentRepo.createChapter(body);
      this.newChapterTitle = '';
      if (!created?.id) return null;
      const localPriority = afterItem && Number.isFinite(afterItem.priority)
        ? afterItem.priority + 0.5
        : (created.position ?? Number.MAX_SAFE_INTEGER);
      const chapterItem = {
        type: 'chapter',
        id: created.id,
        name: created.name,
        priority: localPriority,
        depth: 1,
        parent_id: null,
        hasChildren: false,
        open: true,
        solo: false,
        pages: [],
      };
      this.$store.nav.tree = insertChapterItem(this.$store.nav.tree, chapterItem, {
        afterChapterId: afterItem?.id ?? null,
      });
      if (this._chapterOrderMap) this._chapterOrderMap.set(chapterItem.name, this._chapterOrderMap.size);
      this._persistTreeOpenState();
      return chapterItem;
    } catch (e) {
      console.error('[createChapter]', e);
      this.newChapterError = e.message || this.t('common.unknownError');
      return null;
    } finally {
      this.newChapterCreating = false;
    }
  },

  // Token-Estimates befüllen die Sidebar-Badges + Σ-Totals. Strategie:
  //   1) Server-Backfill (`POST /sync/page-stats/:bookId`) — ein einzelner
  //      Request, Server holt fehlende Stats parallel von BookStack und
  //      persistiert sie in `page_stats`. Erspart 429 Browser-Roundtrips bei
  //      einem grossen Buch.
  //   2) IntersectionObserver auf den Sidebar-Items — fehlende Stats für
  //      sichtbare Seiten werden bevorzugt nachgereicht (ids-Lazy-Pfad
  //      derselben Route), damit Badges ohne Warten auf den Vollabgleich
  //      erscheinen, sobald der User scrollt.
  // Beide Pfade sind idempotent; der Generations-Counter `_tokenEstGen`
  // verwirft Resultate aus alten Buch-Läufen.
  async loadTokenEstimates(gen, signal) {
    if (this._tokenEstGen !== gen) return;
    if (signal?.aborted) return;
    const bookId = this.$store.nav.selectedBookId;
    if (!bookId || !this.$store.nav.pages.length) return;
    const missing = this.$store.nav.pages.some(p => !this.tokEsts[p.id]);
    if (!missing) return;

    this._setupStatsObserver(bookId, gen);

    try {
      const r = await fetch('/sync/page-stats/' + bookId, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal,
      });
      if (!r.ok) return;
      const data = await r.json();
      if (this._tokenEstGen !== gen) return;
      if (data && data.stats) this.tokEsts = { ...this.tokEsts, ...data.stats };
    } catch { /* Observer-Pfad übernimmt sukzessive */ }
  },

  _setupStatsObserver(bookId, gen) {
    this._teardownStatsObserver();
    if (typeof IntersectionObserver === 'undefined' || typeof MutationObserver === 'undefined') return;

    const state = { queue: new Set(), flushTimer: null };

    const flush = async () => {
      state.flushTimer = null;
      if (this._tokenEstGen !== gen) return;
      if (!state.queue.size) return;
      const ids = [...state.queue];
      state.queue.clear();
      try {
        const r = await fetch('/sync/page-stats/' + bookId, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids }),
        });
        if (!r.ok) return;
        const data = await r.json();
        if (this._tokenEstGen !== gen) return;
        if (data && data.stats) this.tokEsts = { ...this.tokEsts, ...data.stats };
      } catch { /* einzelner Batch-Fail ist nicht kritisch */ }
    };

    const io = new IntersectionObserver((entries) => {
      if (this._tokenEstGen !== gen) return;
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const id = parseInt(e.target.dataset.pageId, 10);
        if (!id || this.tokEsts[id]) { io.unobserve(e.target); continue; }
        state.queue.add(id);
        io.unobserve(e.target);
      }
      if (state.queue.size && !state.flushTimer) state.flushTimer = setTimeout(flush, 200);
    }, { rootMargin: '200px 0px' });

    const observe = (node) => {
      if (!(node instanceof Element)) return;
      if (node.matches?.('.page-item[data-page-id]')) io.observe(node);
      node.querySelectorAll?.('.page-item[data-page-id]').forEach(n => io.observe(n));
    };
    // Auf `#partial-sidebar` einengen, damit der MutationObserver nicht auf
    // Editor-/Karten-Renderings reagiert. Fallback document.body falls Mount
    // (noch) nicht existiert.
    const root = document.getElementById('partial-sidebar') || document.body;
    observe(root);

    const mo = new MutationObserver(muts => {
      for (const m of muts) for (const node of m.addedNodes) observe(node);
    });
    mo.observe(root, { childList: true, subtree: true });

    this._statsObserver = io;
    this._statsObserverMutation = mo;
    this._statsObserverState = state;
  },

  _teardownStatsObserver() {
    if (this._statsObserver) { this._statsObserver.disconnect(); this._statsObserver = null; }
    if (this._statsObserverMutation) { this._statsObserverMutation.disconnect(); this._statsObserverMutation = null; }
    if (this._statsObserverState?.flushTimer) clearTimeout(this._statsObserverState.flushTimer);
    this._statsObserverState = null;
  },

  // Entfernt eine Seite aus dem Root-Tree + Seitenliste (z.B. Remote-Delete
  // aus dem Collab-Feed). Kein Server-Call. Feuert EVT.PAGE_REMOVED, damit
  // Karten mit eigener Edit-Repräsentation des Baums (Buchorganizer-
  // workTree/soloPages) ihren Snapshot nachziehen — `pages:loaded` feuert hier
  // nicht, weil kein Reload stattfindet.
  _removePageFromTree(pageId) {
    const id = Number(pageId);
    if (!Number.isFinite(id)) return;
    const nav = this.$store.nav;
    let removed = false;
    const pi = nav.pages.findIndex(p => p.id === id);
    if (pi >= 0) { nav.pages.splice(pi, 1); removed = true; }
    for (let i = nav.tree.length - 1; i >= 0; i--) {
      const it = nav.tree[i];
      if (it.type !== 'chapter') continue;
      if (it.solo && it.pages?.[0]?.id === id) {
        nav.tree.splice(i, 1);
        removed = true;
      } else {
        const j = it.pages.findIndex(p => p.id === id);
        if (j >= 0) { it.pages.splice(j, 1); removed = true; }
      }
    }
    if (!removed) return;
    if (this._pageIdOrderMap) this._pageIdOrderMap.delete(id);
    this._refreshChapterStats();
    window.dispatchEvent(new CustomEvent(EVT.PAGE_REMOVED, { detail: { pageId: id } }));
  },
};
