// Persist-Slice: Snapshot-Aufbau, _runMutation, _persistOrder, Workstate-Clone.
import { contentRepo } from '../repo/content.js';
import { EVT } from '../events.js';

export const persistMethods = {
  async _rerender() {
    this._destroySortables();
    this._snapshotFromNav();
    await this.$nextTick();
    this._initSortables();
    this._refreshSortableDisabled();
  },

  // Baut den genesteten Edit-Tree (workTree/soloPages) aus dem Sidebar-Store.
  // `nav.tree` ist flach, enthaelt aber ALLE Kapitel jeder Tiefe mit `depth`
  // und `parent_id` (tree/load.js#loadPages, depth-first) — das Nesting laesst
  // sich daraus verlustfrei rekonstruieren, ein eigener Tree-Fetch ist unnoetig.
  // Erst-Render vor abgeschlossenem loadPages liefert einen leeren Snapshot;
  // das anschliessende `pages:loaded` triggert den echten (Card-Listener).
  _snapshotFromNav() {
    const nav = Alpine.store('nav');
    const nodes = [];
    const byId = new Map();
    for (const it of (nav.tree || [])) {
      if (it.type !== 'chapter' || it.solo) continue;
      const node = {
        id: it.id,
        name: it.name,
        depth: it.depth || 1,
        parent_id: it.parent_id ?? null,
        pages: (it.pages || []).map(p => ({ id: p.id, name: p.name, chapter_id: it.id })),
        subchapters: [],
      };
      nodes.push(node);
      byId.set(it.id, node);
    }
    // Zweiter Pass: verlinken. Array-Reihenfolge liefert die Geschwister-
    // Reihenfolge, `parent_id` das Nesting — bewusst zwei Paesse, damit die
    // Rekonstruktion nicht von depth-first-Sortierung des Stores abhaengt.
    const roots = [];
    for (const node of nodes) {
      const parent = node.parent_id != null ? byId.get(node.parent_id) : null;
      if (parent) parent.subchapters.push(node);
      else roots.push(node);
    }
    // depth aus dem rekonstruierten Nesting neu ableiten statt dem Store zu
    // vertrauen (haelt promote/demote-Mirror und Snapshot konsistent).
    for (const r of roots) this._setSubtreeDepth(r, 1);
    this.workTree = roots;
    this.soloPages = (nav.pages || [])
      .filter(p => !p.chapter_id)
      .map(p => ({ id: p.id, name: p.name, chapter_id: 0 }));
    this._recomputeInitialOpenState();
  },

  // Deep-Clone von workTree+soloPages für History-Records. JSON-Roundtrip
  // entpackt Alpine-Proxys zum Plain-Object — structuredClone wirft auf
  // Proxies, daher JSON.
  _snapshotWorkstate() {
    return {
      workTree: JSON.parse(JSON.stringify(this.workTree)),
      soloPages: JSON.parse(JSON.stringify(this.soloPages)),
    };
  },

  async _runMutation(fn, errKey = 'bookOrganizer.saveFailed') {
    const root = window.__app;
    this.organizerSaving = true;
    let ok = false;
    try {
      await fn();
      ok = true;
    } catch (e) {
      root.setStatus(root.t(errKey, { detail: e.message }));
      // Bei Fehler einmal voll resynchronisieren — Server-Zustand könnte
      // partiell mutiert sein. loadPages feuert `pages:loaded`, der Card-
      // Listener zieht den Snapshot nach.
      await root.loadPages();
    } finally {
      this.organizerSaving = false;
      this.organizerStatus = '';
    }
    // Jede Organizer-Mutation verschiebt die Ziele von Querverweisen: Umsortieren
    // aendert die Kapitelnummern, Umbenennen den Titel im Ziel-Picker, Loeschen
    // die Verfuegbarkeit. Der Picker cacht die Zielliste je Buch — ohne dieses
    // Signal zeigte er bis zum Buchwechsel veraltete Nummern.
    // Bewusst HIER und nicht bei `pages:loaded`: das feuert auch bei jeder
    // Navigation und wuerde den Cache sinnlos machen.
    if (ok) {
      const bookId = window.Alpine?.store('nav')?.selectedBookId ?? null;
      window.dispatchEvent(new CustomEvent(EVT.XREFS_CHANGED, { detail: { bookId } }));
    }
    return ok;
  },

  // Single-Tree-PUT. Statt per-Item update fuer alle veraenderten Items wird
  // der vollstaendige Tree atomar an /content/books/:id/order geschickt.
  // Server validiert + materialisiert chapters.position/parent_chapter_id/
  // pages.position/pages.chapter_id in einer Transaction.
  _buildTreeFromWorkstate() {
    function buildChapter(c) {
      const children = [];
      for (const sub of (c.subchapters || [])) children.push(buildChapter(sub));
      for (const p of (c.pages || [])) children.push({ type: 'page', id: p.id });
      return { type: 'chapter', id: c.id, children };
    }
    // Seiten ohne Kapitel zuerst (UI-Invariante), dann Kapitel in workTree-Order.
    const tree = [];
    for (const p of this.soloPages) tree.push({ type: 'page', id: p.id });
    for (const c of this.workTree) tree.push(buildChapter(c));
    return tree;
  },

  // `mirror` waehlt, wie der Sidebar-Store nachgezogen wird:
  //   'chapters' — Kapitel-Struktur (Order/Tiefe/Parent) hat sich geaendert.
  //   'pages'    — Seiten-Zugehoerigkeit/-Reihenfolge; `affectedChapters` grenzt
  //                den Rebuild der treeCh.pages-Arrays ein (null = alle).
  //   'both'     — beides (History-Replay: Snapshot kann alles enthalten).
  //   'reload'   — voller loadPages. Nur noetig, wenn ein Kapitel NEU ist und
  //                seine Einsortierungsposition im flachen Store nicht aus dem
  //                Workstate ableitbar ist (createSubchapter).
  async _persistOrder({ mirror = 'chapters', affectedChapters = null } = {}) {
    const root = window.__app;
    const bookId = parseInt(Alpine.store('nav').selectedBookId, 10);
    if (!bookId) return false;
    const tree = this._buildTreeFromWorkstate();
    return await this._runMutation(async () => {
      this.organizerStatus = root.t('bookOrganizer.savingOrder');
      await contentRepo.saveOrder(bookId, tree);
      await this._applyMirror(mirror, affectedChapters);
    });
  },

  async _applyMirror(mirror, affectedChapters = null) {
    if (mirror === 'reload') {
      await window.__app.loadPages?.();
      return;
    }
    if (mirror === 'pages') {
      this._mirrorPageMembershipInRoot(affectedChapters);
      return;
    }
    this._mirrorChapterOrderInRoot();
    if (mirror === 'both') this._mirrorPageMembershipInRoot(null);
  },
};
