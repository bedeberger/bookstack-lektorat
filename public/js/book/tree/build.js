import { fetchJson } from '../../utils.js';

// Tree-Aufbau aus der `contentRepo.bookTree`-Antwort + Nachladen der
// Sidebar-Plaketten. Beides aus `loadPages` (tree/load.js) herausgeloest, das
// sonst Abbruch-Verwaltung, Sidebar-Modus, State-Clearing, Tree-Bau,
// Plaketten-Fetch und vier Folge-Loads in einer Funktion fuehrt.
// `this` = die Alpine-Komponente.

export const treeBuildMethods = {
  // contentRepo.bookTree liefert Kapitel nested (subchapters[]) + topPages fuer
  // Seiten ohne Kapitel. Daraus entstehen hier drei Dinge:
  //   1. `nav.pages` — flache Seitenliste, Solo-Seiten zuerst, mit `priority`
  //      (Sort-Alias auf `position`) und aufgeloestem `chapterName`.
  //   2. `nav.tree`  — FLACH + depth-annotiert (Ordnungs-Invariante siehe
  //      tree/load.js). Solo-Seiten werden als Pseudo-Kapitel gewrappt.
  //   3. die drei Sortier-Indexe (`_chapterOrderMap`/`_pageOrderMap`/
  //      `_pageIdOrderMap`), die Filter- und Listen-Sortierungen ausserhalb der
  //      Sidebar benutzen (app/app-ui.js#_chapterIdx/_pageIdx/_pageIdIdx).
  // Kein Fetch, kein await — reiner Aufbau aus der bereits geholten Antwort.
  _buildTreeFromResponse(tree, bookId) {
    const flatChapters = []; // [{ id, name, position, excluded, _depth, _parent_id, pages }]
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
    walkChapters(tree.chapters, 1, null);

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
    const pages = [
      ...tree.topPages.map(decoratePage),
      ...flatChapters.flatMap(c => c.pages.map(decoratePage)),
    ];
    this.$store.nav.pages = pages;

    const openState = this._loadTreeOpenState(bookId);
    this.$store.nav.tree = [
      ...pages.filter(p => !p.chapter_id).map(p => ({
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
        pages: pages.filter(p => p.chapter_id === c.id),
      })),
    ];

    this._rebuildTreeOrderMaps();
    this._refreshChapterStats();
  },

  // Sortier-Indexe aus dem aktuellen `nav.tree`/`nav.pages` neu aufbauen.
  // Eigene Methode, weil auch Pfade, die den Baum punktuell aendern
  // (_removePageFromTree), die Maps konsistent halten muessen — ein
  // uebriggebliebener Eintrag zeigt sonst auf eine tote Position.
  _rebuildTreeOrderMaps() {
    const chapterMap = new Map();
    let chIdx = 0;
    for (const item of this.$store.nav.tree) {
      if (item.type === 'chapter' && !item.solo) chapterMap.set(item.name, chIdx++);
    }
    const nameMap = new Map();
    const idMap = new Map();
    const pages = this.$store.nav.pages;
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      if (!nameMap.has(p.name)) nameMap.set(p.name, i);
      idMap.set(p.id, i);
    }
    this._chapterOrderMap = chapterMap;
    this._pageOrderMap = nameMap;
    this._pageIdOrderMap = idMap;
  },

  // Gecachte Seiten-Stats, Lektorats-Alter und die sechs Plaketten-Zaehler.
  //
  // Bewusst acht getrennte Endpunkte statt eines gebuendelten: sie haben vier
  // verschiedene Zugriffsmodelle — Ideen sind buch- UND user-skopiert und
  // verlangen `editor`, Recherche ist buchweit geteilt ohne User-Filter, die
  // Share-Zaehler haengen an `share_links.owner_email` ganz ohne Buch-Guard,
  // die Plot-Zaehler an Buch + User. Ein Sammel-Endpunkt muesste alle vier
  // nachbauen, und ein Fehler darin gaebe fremde Daten heraus. Die acht laufen
  // parallel, kosten also eine Roundtrip-Latenz, nicht acht.
  //
  // Jeder Zaehler faellt einzeln auf `{}` zurueck: eine fehlende Plakette darf
  // den Baum nicht kosten. Stats/Ages tun das nicht — sie liegen im gemeinsamen
  // try/catch des Aufrufers.
  async _loadSidebarBadges(bookId, signal) {
    const [
      statsCache, ageMap,
      ideenMap, chapterIdeenMap,
      rechercheMap, chapterRechercheMap,
      shareCommentMap, shareLinkMap,
      plotBeatMap, chapterPlotBeatMap,
    ] = await Promise.all([
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

    // Cache-Hits in einem Rutsch zuweisen (statt Index-Assign in der Loop):
    // der `tokTotals`-Memo (app/app-root-getters.js) haengt an der Identitaet
    // von `tokEsts` — eine Schleife voller In-Place-Schreibzugriffe liesse
    // die Sidebar-Σ-Zeile auf dem Vorzustand stehen.
    const initialTokEsts = {};
    for (const p of this.$store.nav.pages) {
      const c = statsCache[p.id];
      if (c && c.updated_at === p.updated_at) {
        initialTokEsts[p.id] = { tok: c.tok, words: c.words, chars: c.chars };
      }
    }
    if (Object.keys(initialTokEsts).length) this.tokEsts = initialTokEsts;
  },
};
