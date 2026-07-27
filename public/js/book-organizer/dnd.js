// DnD- + Struktur-Slice: Sortable-Setup, Page-/Chapter-Drop-Handler und die
// tastatur-/button-getriebenen Struktur-Moves (promote/demote, Combobox-Move).
//
// Geteilter SortableJS-Kern (Patch, Revert, Tuning, x-ignore) liegt in
// [public/js/sortable-dnd.js] — beim Sortable-Bump dort verifizieren.

import {
  patchSortableOnce,
  revertSortable,
  markDragIgnore,
  unmarkDragIgnore,
  BASE_SORTABLE_OPTS,
} from '../sortable-dnd.js';
import { MAX_CHAPTER_DEPTH } from './constants.js';

export const dndMethods = {
  _destroySortables() {
    for (const s of this._sortables) { try { s.destroy(); } catch {} }
    this._sortables = [];
  },

  // Sortable-Instanzen frisch an das aktuelle DOM binden. Alpine-x-for
  // rekonziliert nach Workstate-Mutationen und kann Container-Elemente
  // austauschen — Sortable-Refs zeigen sonst auf stale Nodes und folgende Drops
  // verschieben Items in unsichtbaren alten Listen. Einziger zugelassener Weg
  // zum Re-Init: enthaelt zwingend `_refreshSortableDisabled` (Such-Invariante).
  async _reattachSortables() {
    this._destroySortables();
    await this.$nextTick();
    this._initSortables();
    this._refreshSortableDisabled();
  },

  _initSortables() {
    const Sortable = window.Sortable;
    if (!Sortable) return;
    patchSortableOnce(Sortable);
    this._destroySortables();
    // Geteiltes Präzisions-Tuning aus BASE_SORTABLE_OPTS (forceFallback-Ghost,
    // swapThreshold 0.65 gegen Nachbar-Flackern, invertSwap für stabile Backward-
    // Drops in nested Listen, revertOnSpill gegen Item-Loss). Board-spezifisch:
    // - emptyInsertThreshold 8: restriktiverer Trefferradius als das Plot-Board.
    // - scroll false: Organizer-Listen scrollen nicht beim Drag am Rand.
    // - chosenClass/ghostClass/dragClass: eigene CSS-Klassen für klares
    //   visuelles Feedback (Pickup-Highlight, Ghost-Slot, Hover-Karte).
    const baseOpts = {
      ...BASE_SORTABLE_OPTS,
      emptyInsertThreshold: 8,
      scroll: false,
      chosenClass: 'organizer-chosen',
      ghostClass: 'organizer-ghost',
      dragClass: 'organizer-drag-active',
    };
    // Eine Chapter-Liste pro Tiefe — alle teilen die `chapters`-Gruppe, damit
    // Kapitel zwischen Levels per DnD wandern koennen. Drop-Ziel-Validierung
    // (max-depth, kein-eigener-Subtree) im onMove-Hook.
    const chapterLists = this.$root.querySelectorAll('[data-organizer="chapter-list"]');
    for (const el of chapterLists) {
      this._sortables.push(new Sortable(el, {
        ...baseOpts,
        handle: '.organizer-drag-handle--chapter',
        draggable: '.organizer-chapter',
        group: { name: 'chapters', pull: true, put: ['chapters'] },
        onChoose: markDragIgnore,
        onUnchoose: unmarkDragIgnore,
        onMove: (evt) => this._validateChapterMove(evt),
        onEnd: (evt) => { unmarkDragIgnore(evt); this._onChapterDrop(evt); },
      }));
    }
    const pageLists = this.$root.querySelectorAll('[data-organizer="page-list"]');
    for (const el of pageLists) {
      this._sortables.push(new Sortable(el, {
        ...baseOpts,
        handle: '.organizer-drag-handle',
        draggable: '.organizer-page',
        group: { name: 'pages', pull: true, put: ['pages'] },
        onChoose: markDragIgnore,
        onUnchoose: unmarkDragIgnore,
        onEnd: (evt) => { unmarkDragIgnore(evt); this._onPageDrop(evt); },
      }));
    }
  },

  // Sortable.onMove: blockt Drops, die max-depth verletzen oder ein Kapitel in
  // seinen eigenen Subtree (oder sich selbst) ziehen wuerden. Return false →
  // Drop wird nicht akzeptiert.
  _validateChapterMove(evt) {
    const movedId = parseInt(evt.dragged?.dataset?.chapterId, 10);
    if (!Number.isFinite(movedId)) return true;
    const toEl = evt.to;
    const targetDepth = parseInt(toEl?.dataset?.organizerDepth, 10) || 1;
    const targetParentId = parseInt(toEl?.dataset?.parentChapterId, 10) || null;
    // Kein Drop in sich selbst.
    if (targetParentId === movedId) return false;
    const found = this._findChapter(movedId);
    if (!found) return true;
    // Kein Drop in eigenen Subtree.
    const descIds = this._descendantIdsOf(found.node);
    if (targetParentId != null && descIds.has(targetParentId)) return false;
    // Max-Depth-Check: targetDepth + (subtreeDepth - 1) darf MAX nicht sprengen.
    return targetDepth + this._subtreeDepth(found.node) - 1 <= MAX_CHAPTER_DEPTH;
  },

  _parseChapterIdAttr(el) {
    const raw = el?.dataset?.chapterId;
    if (raw == null || raw === '' || raw === 'null' || raw === '0') return 0;
    return parseInt(raw, 10) || 0;
  },

  // Tiefe (und optional parent_id) eines Subtrees neu setzen. `parentId`
  // weglassen laesst die Parent-Referenz des Wurzelknotens unberuehrt.
  _setSubtreeDepth(node, depth, parentId) {
    node.depth = depth;
    if (parentId !== undefined) node.parent_id = parentId;
    for (const sub of (node.subchapters || [])) {
      this._setSubtreeDepth(sub, depth + 1, node.id);
    }
  },

  async _onChapterDrop(evt) {
    if (this.organizerSaving) return;
    const sameBucket = evt.from === evt.to;
    if (sameBucket && evt.oldIndex === evt.newIndex) return;
    const movedId = parseInt(evt.item?.dataset?.chapterId, 10);
    if (!Number.isFinite(movedId)) return;
    const before = this._snapshotWorkstate();

    revertSortable(evt);

    const toParentId = parseInt(evt.to?.dataset?.parentChapterId, 10) || null;
    const targetDepth = parseInt(evt.to?.dataset?.organizerDepth, 10) || 1;
    const newIndex = Number.isFinite(evt.newIndex) ? evt.newIndex : 0;

    const found = this._findChapter(movedId);
    if (!found) return;
    const node = found.node;
    found.parentList.splice(found.index, 1);

    let targetList;
    if (toParentId == null) {
      targetList = this.workTree;
    } else {
      const parent = this._findChapter(toParentId)?.node;
      if (!parent) { found.parentList.splice(found.index, 0, node); return; } // Rollback
      if (!parent.subchapters) parent.subchapters = [];
      targetList = parent.subchapters;
    }
    this._setSubtreeDepth(node, targetDepth, toParentId);
    targetList.splice(Math.max(0, Math.min(newIndex, targetList.length)), 0, node);

    const ok = await this._persistOrder({ mirror: 'chapters' });
    if (ok) this._recordReorder(before);
    // Kapitel kann den Container gewechselt haben (x-if-gated Subchapter-Divs
    // erscheinen/verschwinden) → Sortable neu binden.
    if (!sameBucket) await this._reattachSortables();
  },

  async _onPageDrop(evt) {
    if (this.organizerSaving) return;
    if (evt.from === evt.to && evt.oldIndex === evt.newIndex) return;
    const before = this._snapshotWorkstate();
    const fromChapId = this._parseChapterIdAttr(evt.from);
    const toChapId = this._parseChapterIdAttr(evt.to);
    const pageId = parseInt(evt.item.dataset.pageId, 10);

    revertSortable(evt);

    const pageObj = this._removePageFromBucket(fromChapId, pageId);
    if (!pageObj) return;
    pageObj.chapter_id = toChapId;
    const bucket = this._pagesBucket(toChapId);
    if (!bucket) { this._pagesBucket(fromChapId)?.push(pageObj); return; } // Rollback
    // Ziel-Index aus Sortable-Event (Position unter .organizer-page), nicht aus
    // dem DOM lesen — DOM wurde gerade revertet und ist nicht mehr massgeblich.
    const targetIdx = Number.isFinite(evt.newIndex) ? evt.newIndex : bucket.length;
    bucket.splice(Math.max(0, Math.min(targetIdx, bucket.length)), 0, pageObj);
    const ok = await this._persistOrder({
      mirror: 'pages',
      affectedChapters: [toChapId, fromChapId],
    });
    if (ok) this._recordReorder(before);
  },

  _pagesBucket(chapId) {
    if (chapId === 0) return this.soloPages;
    return this._findChapter(chapId)?.node?.pages || null;
  },

  _removePageFromBucket(chapId, pageId) {
    const bucket = this._pagesBucket(chapId);
    if (!bucket) return null;
    const idx = bucket.findIndex(p => p.id === pageId);
    return idx >= 0 ? bucket.splice(idx, 1)[0] : null;
  },

  _findPage(id) {
    function walk(list) {
      for (const c of list) {
        const p = c.pages.find(pp => pp.id === id);
        if (p) return p;
        const deep = walk(c.subchapters || []);
        if (deep) return deep;
      }
      return null;
    }
    return walk(this.workTree) || this.soloPages.find(p => p.id === id) || null;
  },

  // Move-Pfad ohne Drag — Combobox „Verschieben nach …". Nutzt dieselbe
  // Mutations- und Persist-Sequenz wie _onPageDrop, inklusive History-Push.
  async movePageToChapter(pageId, targetChIdRaw) {
    if (this.organizerSaving) return;
    const targetChId = parseInt(targetChIdRaw, 10) || 0;
    const page = this._findPage(pageId);
    if (!page) return;
    const fromChapId = page.chapter_id || 0;
    if (fromChapId === targetChId) return;
    const before = this._snapshotWorkstate();
    const removed = this._removePageFromBucket(fromChapId, pageId);
    if (!removed) return;
    removed.chapter_id = targetChId;
    const bucket = this._pagesBucket(targetChId);
    if (!bucket) { this._pagesBucket(fromChapId)?.push(removed); return; } // Rollback
    bucket.push(removed);
    const ok = await this._persistOrder({
      mirror: 'pages',
      affectedChapters: [fromChapId, targetChId],
    });
    if (ok) this._recordReorder(before);
  },

  // Promote: Kapitel ein Level hoeher (rueckt aus dem Eltern-Kapitel raus,
  // wird Geschwister des bisherigen Elternteils). Top-Level: no-op.
  async promoteChapter(id) {
    if (this.organizerSaving) return;
    const found = this._findChapter(id);
    if (!found || found.node.depth <= 1) return;
    const before = this._snapshotWorkstate();
    const node = found.node;
    found.parentList.splice(found.index, 1);
    // Elternteil suchen → in dessen Liste direkt hinter ihm eintragen.
    const parentLoc = this._findChapter(found.parent.id);
    if (!parentLoc) {
      found.parentList.splice(found.index, 0, node); // Rollback
      return;
    }
    parentLoc.parentList.splice(parentLoc.index + 1, 0, node);
    this._setSubtreeDepth(node, node.depth - 1, parentLoc.parent ? parentLoc.parent.id : null);
    const ok = await this._persistOrder({ mirror: 'chapters' });
    if (ok) this._recordReorder(before);
    await this._reattachSortables();
  },

  // Demote: Kapitel ein Level tiefer (wird Sub-Kapitel des Vor-Geschwisters).
  async demoteChapter(id) {
    if (this.organizerSaving) return;
    if (!this.canDemoteChapter(id)) return;
    const found = this._findChapter(id);
    if (!found) return;
    const before = this._snapshotWorkstate();
    const node = found.node;
    const newParent = found.parentList[found.index - 1];
    found.parentList.splice(found.index, 1);
    newParent.subchapters = [...(newParent.subchapters || []), node];
    this._setSubtreeDepth(node, newParent.depth + 1, newParent.id);
    this.chapterOpen = { ...this.chapterOpen, [newParent.id]: true };
    const ok = await this._persistOrder({ mirror: 'chapters' });
    if (ok) this._recordReorder(before);
    await this._reattachSortables();
  },
};
