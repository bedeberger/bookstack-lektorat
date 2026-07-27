// Buchorganizer: Snapshot-Rebuild, Mirror-Ordnung, Struktur-Helper, Length-Dist.
//
// Der Fokus liegt auf der Ordnungs-Invariante von nav.tree: flach, aber
// DEPTH-FIRST (Solo-Seiten zuerst, Sub-Kapitel direkt hinter ihrem Parent).
// Die Sidebar rendert in Array-Reihenfolge (app.js#filteredTree filtert nur) —
// ein globaler Sort nach `priority` (Position INNERHALB des Parents) reisst
// Sub-Kapitel aus ihrem Parent und war die Ursache scrambelnder Sidebars.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Alpine/window-Stubs vor dem Import der Slices — die Module lesen beides erst
// zur Aufrufzeit, ein globaler Stub genuegt.
const navStore = { tree: [], pages: [], books: [], selectedBookId: 7 };
const rootStub = {
  tokEsts: {},
  _chapterOrderMap: null,
  _pageOrderMap: null,
  _pageIdOrderMap: null,
  t: (k) => k,
  setStatus() {},
  _refreshChapterStats() {},
};
globalThis.Alpine = { store: (n) => (n === 'nav' ? navStore : { uiLocale: 'de' }) };
globalThis.window = { __app: rootStub };

const { persistMethods } = await import('../../public/js/book-organizer/persist.js');
const { mirrorMethods } = await import('../../public/js/book-organizer/mirror.js');
const { dndMethods } = await import('../../public/js/book-organizer/dnd.js');
const { viewMethods, _computeChapterLengthDist } = await import('../../public/js/book-organizer/view.js');
const { MAX_CHAPTER_DEPTH } = await import('../../public/js/book-organizer/constants.js');
const { insertChapterItem } = await import('../../public/js/book/tree/load.js');

// Minimale Card-Instanz: die Slice-Methoden brauchen nur `this` + $nextTick.
function makeCard() {
  return Object.assign({
    workTree: [],
    soloPages: [],
    chapterOpen: {},
    organizerSearch: '',
    organizerSaving: false,
    _sortables: [],
    _memos: {},
    async $nextTick() {},
  }, persistMethods, mirrorMethods, dndMethods, viewMethods);
}

// nav.tree-Fixture: Kapitel 1 „Eins" mit Sub 11 „Eins.A", Kapitel 2 „Zwei".
// Plus eine kapitellose Seite. Reihenfolge = depth-first, wie tree/load.js baut.
function seedNav() {
  const pages = [
    { id: 900, name: 'Solo', chapter_id: 0, priority: 1, chapterName: null },
    { id: 901, name: 'S1', chapter_id: 1, priority: 1, chapterName: 'Eins' },
    { id: 902, name: 'S2', chapter_id: 1, priority: 2, chapterName: 'Eins' },
    { id: 911, name: 'Sub1', chapter_id: 11, priority: 1, chapterName: 'Eins.A' },
    { id: 920, name: 'Z1', chapter_id: 2, priority: 1, chapterName: 'Zwei' },
  ];
  const byChapter = (id) => pages.filter(p => p.chapter_id === id);
  navStore.pages = pages;
  navStore.tree = [
    { type: 'chapter', id: 'solo-900', name: 'Solo', priority: 1, depth: 1, parent_id: null, solo: true, pages: [pages[0]] },
    { type: 'chapter', id: 1, name: 'Eins', priority: 1, depth: 1, parent_id: null, solo: false, hasChildren: true, pages: byChapter(1) },
    { type: 'chapter', id: 11, name: 'Eins.A', priority: 1, depth: 2, parent_id: 1, solo: false, hasChildren: false, pages: byChapter(11) },
    { type: 'chapter', id: 2, name: 'Zwei', priority: 2, depth: 1, parent_id: null, solo: false, hasChildren: false, pages: byChapter(2) },
  ];
}

const treeIds = () => navStore.tree.map(it => it.id);

test('_snapshotFromNav rekonstruiert das Nesting aus dem flachen Store', () => {
  seedNav();
  const card = makeCard();
  card._snapshotFromNav();

  assert.deepEqual(card.workTree.map(c => c.id), [1, 2]);
  assert.deepEqual(card.workTree[0].subchapters.map(c => c.id), [11]);
  assert.equal(card.workTree[0].depth, 1);
  assert.equal(card.workTree[0].subchapters[0].depth, 2);
  assert.equal(card.workTree[0].subchapters[0].parent_id, 1);
  assert.deepEqual(card.workTree[0].pages.map(p => p.id), [901, 902]);
  assert.deepEqual(card.workTree[0].subchapters[0].pages.map(p => p.id), [911]);
  assert.deepEqual(card.soloPages.map(p => p.id), [900]);
});

test('_snapshotFromNav ist unabhaengig von der Store-Reihenfolge des Parents', () => {
  seedNav();
  // Sub-Kapitel vor seinem Parent — darf trotzdem korrekt einhaengen.
  navStore.tree = [navStore.tree[0], navStore.tree[2], navStore.tree[1], navStore.tree[3]];
  const card = makeCard();
  card._snapshotFromNav();
  assert.deepEqual(card.workTree.map(c => c.id), [1, 2]);
  assert.deepEqual(card.workTree[0].subchapters.map(c => c.id), [11]);
});

test('_mirrorChapterOrderInRoot haelt nav.tree depth-first (Sub bleibt beim Parent)', () => {
  seedNav();
  const card = makeCard();
  card._snapshotFromNav();
  // Top-Level-Reorder: „Zwei" vor „Eins" (wie ein DnD-Drop im Organizer).
  card.workTree.reverse();
  card._mirrorChapterOrderInRoot();

  // Solo zuerst, dann Zwei, dann Eins mit seinem Sub direkt dahinter.
  assert.deepEqual(treeIds(), ['solo-900', 2, 1, 11]);
  // priority ist die Position INNERHALB des Parents.
  const byId = new Map(navStore.tree.map(it => [it.id, it]));
  assert.equal(byId.get(2).priority, 1);
  assert.equal(byId.get(1).priority, 2);
  assert.equal(byId.get(11).priority, 1);
});

test('_mirrorChapterOrderInRoot spiegelt Tiefe/Parent/hasChildren nach promote', () => {
  seedNav();
  const card = makeCard();
  card._snapshotFromNav();
  // Sub-Kapitel 11 aus „Eins" herausziehen (promote).
  const sub = card.workTree[0].subchapters.pop();
  card._setSubtreeDepth(sub, 1, null);
  card.workTree.splice(1, 0, sub);
  card._mirrorChapterOrderInRoot();

  assert.deepEqual(treeIds(), ['solo-900', 1, 11, 2]);
  const byId = new Map(navStore.tree.map(it => [it.id, it]));
  assert.equal(byId.get(11).depth, 1);
  assert.equal(byId.get(11).parent_id, null);
  assert.equal(byId.get(1).hasChildren, false, 'Parent hat sein letztes Kind verloren');
});

test('_mirrorPageMembershipInRoot spiegelt auch Seiten in Sub-Kapiteln', () => {
  seedNav();
  const card = makeCard();
  card._snapshotFromNav();
  // Seite aus dem Sub-Kapitel nach vorn in Kapitel 1 ziehen.
  const moved = card.workTree[0].subchapters[0].pages.pop();
  moved.chapter_id = 1;
  card.workTree[0].pages.unshift(moved);
  card._mirrorPageMembershipInRoot([1, 11]);

  const p911 = navStore.pages.find(p => p.id === 911);
  assert.equal(p911.chapter_id, 1);
  assert.equal(p911.priority, 1);
  assert.equal(p911.chapterName, 'Eins');
  const byId = new Map(navStore.tree.map(it => [it.id, it]));
  assert.deepEqual(byId.get(1).pages.map(p => p.id), [911, 901, 902]);
  assert.deepEqual(byId.get(11).pages.map(p => p.id), []);
});

test('_mirrorPageMembershipInRoot(null) deckt alle Kapitel ab (History-Replay)', () => {
  seedNav();
  const card = makeCard();
  card._snapshotFromNav();
  // Reihenfolge innerhalb des Sub-Kapitels und in Kapitel 2 aendern.
  card.workTree[0].pages.reverse();
  card._mirrorPageMembershipInRoot(null);
  const byId = new Map(navStore.tree.map(it => [it.id, it]));
  assert.deepEqual(byId.get(1).pages.map(p => p.id), [902, 901]);
  assert.equal(navStore.pages.find(p => p.id === 902).priority, 1);
});

test('_resortRootPages ordnet nav.pages nach Kapitel-Depth-First, Solo zuerst', () => {
  seedNav();
  const card = makeCard();
  card._snapshotFromNav();
  card.workTree.reverse(); // Zwei vor Eins
  card._resortRootPages();
  assert.deepEqual(navStore.pages.map(p => p.id), [900, 920, 901, 902, 911]);
});

test('_rebuildSoloEntries + _reorderNavTree halten Solo-Items vor den Kapiteln', () => {
  seedNav();
  const card = makeCard();
  card._snapshotFromNav();
  // Zweite Solo-Seite hinzufuegen (wie ein Move aus einem Kapitel heraus).
  const p = navStore.pages.find(x => x.id === 920);
  p.chapter_id = 0;
  card.soloPages.push({ id: 920, name: 'Z1', chapter_id: 0 });
  card.workTree[1].pages = [];
  card._rebuildSoloEntries();
  card._reorderNavTree();
  assert.deepEqual(treeIds(), ['solo-900', 'solo-920', 1, 11, 2]);
});

test('_buildTreeFromWorkstate serialisiert Solo-Seiten zuerst, dann nested', () => {
  seedNav();
  const card = makeCard();
  card._snapshotFromNav();
  assert.deepEqual(card._buildTreeFromWorkstate(), [
    { type: 'page', id: 900 },
    { type: 'chapter', id: 1, children: [
      { type: 'chapter', id: 11, children: [{ type: 'page', id: 911 }] },
      { type: 'page', id: 901 },
      { type: 'page', id: 902 },
    ] },
    { type: 'chapter', id: 2, children: [{ type: 'page', id: 920 }] },
  ]);
});

test('_findChapter liefert Geschwister-Liste + Index auf jeder Tiefe', () => {
  seedNav();
  const card = makeCard();
  card._snapshotFromNav();
  const top = card._findChapter(2);
  assert.equal(top.index, 1);
  assert.equal(top.parent, null);
  assert.equal(top.parentList, card.workTree);
  const sub = card._findChapter(11);
  assert.equal(sub.parent.id, 1);
  assert.equal(sub.parentList, card.workTree[0].subchapters);
  assert.equal(card._findChapter(4711), null);
});

test('promote/demote-Validierung respektiert MAX_CHAPTER_DEPTH', () => {
  seedNav();
  const card = makeCard();
  card._snapshotFromNav();
  assert.equal(card.canPromoteChapter(1), false, 'Top-Level hat keinen Parent');
  assert.equal(card.canPromoteChapter(11), true);
  assert.equal(card.canDemoteChapter(1), false, 'kein Vor-Geschwister');
  assert.equal(card.canDemoteChapter(2), true);

  // Kapitel 2 mit zwei Ebenen Subtree → demote wuerde Tiefe 4 erzeugen.
  card.workTree[1].subchapters = [
    { id: 21, name: 'a', depth: 2, parent_id: 2, pages: [], subchapters: [
      { id: 211, name: 'b', depth: 3, parent_id: 21, pages: [], subchapters: [] },
    ] },
  ];
  assert.equal(card._subtreeDepth(card.workTree[1]), MAX_CHAPTER_DEPTH);
  assert.equal(card.canDemoteChapter(2), false);
});

test('_setSubtreeDepth zieht Tiefe rekursiv nach, parent_id nur wenn angegeben', () => {
  const card = makeCard();
  const node = { id: 1, depth: 1, parent_id: null, subchapters: [
    { id: 2, depth: 2, parent_id: 1, subchapters: [{ id: 3, depth: 3, parent_id: 2, subchapters: [] }] },
  ] };
  card._setSubtreeDepth(node, 2, 9);
  assert.equal(node.depth, 2);
  assert.equal(node.parent_id, 9);
  assert.equal(node.subchapters[0].depth, 3);
  assert.equal(node.subchapters[0].parent_id, 1);
  assert.equal(node.subchapters[0].subchapters[0].depth, 4);

  const keep = { id: 1, depth: 5, parent_id: 42, subchapters: [] };
  card._setSubtreeDepth(keep, 1);
  assert.equal(keep.parent_id, 42, 'ohne parentId-Argument unberuehrt');
});

test('Suchfilter zeigt Kapitel bei Treffer in der Tiefe', () => {
  seedNav();
  const card = makeCard();
  card._snapshotFromNav();
  card.organizerSearch = 'Sub1';
  const res = card.filteredWorkTree();
  assert.deepEqual(res.map(c => c.id), [1]);
  assert.deepEqual(res[0].pages, [], 'Parent-Seiten ohne Treffer ausgefiltert');
  assert.deepEqual(res[0].subchapters[0].pages.map(p => p.id), [911]);
  assert.deepEqual(card.filteredSoloPages(), []);

  card.organizerSearch = 'Eins';
  const byName = card.filteredWorkTree();
  assert.deepEqual(byName.map(c => c.id), [1]);
  assert.equal(byName[0].pages.length, 2, 'Name-Match zeigt alle Seiten des Kapitels');
});

test('_chapterOptions ruecken nach Tiefe ein, chapterMoveOptions schliesst self aus', () => {
  seedNav();
  const card = makeCard();
  card._snapshotFromNav();
  assert.deepEqual(card.jumpChapterOptions(), [
    { value: 1, label: 'Eins' },
    { value: 11, label: '— Eins.A' },
    { value: 2, label: 'Zwei' },
  ]);
  const opts = card.chapterMoveOptions(11);
  assert.equal(opts[0].value, 0, 'Solo-Ziel zuerst');
  assert.deepEqual(opts.slice(1).map(o => o.value), [1, 2]);
  assert.deepEqual(card.chapterMoveOptions(0).map(o => o.value), [1, 11, 2],
    'kapitellose Seite braucht kein Solo-Ziel');
});

test('_recomputeInitialOpenState: Threshold beim ersten, User-State danach', () => {
  seedNav();
  const card = makeCard();
  card._snapshotFromNav();
  assert.deepEqual(card.chapterOpen, { 1: true, 11: true, 2: true });

  card.chapterOpen = { 1: false, 11: true, 2: true };
  card._snapshotFromNav();
  assert.equal(card.chapterOpen[1], false, 'User-Zustand bleibt');

  // Verschwundene ID wird entfernt, neue kommt zu.
  card.chapterOpen = { 1: true, 11: true, 2: true, 99: true };
  card._recomputeInitialOpenState();
  assert.equal('99' in card.chapterOpen, false);
});

test('insertChapterItem haelt die Depth-First-Ordnung des flachen Trees', () => {
  seedNav();
  const item = { type: 'chapter', id: 3, name: 'Drei', priority: 2, depth: 1, parent_id: null, solo: false, pages: [] };

  // Hinter Kapitel 1 → hinter dessen kompletten Subtree, nicht direkt dahinter.
  assert.deepEqual(
    insertChapterItem(navStore.tree, item, { afterChapterId: 1 }).map(i => i.id),
    ['solo-900', 1, 11, 3, 2]);
  // Vor Kapitel 1 (Fallback ohne Vorgaenger) → hinter die Solo-Items.
  assert.deepEqual(
    insertChapterItem(navStore.tree, item, { beforeChapterId: 1 }).map(i => i.id),
    ['solo-900', 3, 1, 11, 2]);
  // Ohne Anker → ans Ende.
  assert.deepEqual(
    insertChapterItem(navStore.tree, item, {}).map(i => i.id),
    ['solo-900', 1, 11, 2, 3]);
  // Unbekannter Anker faellt auf „Ende" zurueck.
  assert.deepEqual(
    insertChapterItem(navStore.tree, item, { afterChapterId: 4711 }).map(i => i.id),
    ['solo-900', 1, 11, 2, 3]);
});

test('_computeChapterLengthDist: Median, Diverging-Bar, Min/Max-Flags', () => {
  const rows = _computeChapterLengthDist([
    { id: 1, name: 'A', stats: { chars: 1000, words: 150, count: 2, normseiten: 0.6 } },
    { id: 2, name: 'B', stats: { chars: 2000, words: 300, count: 3, normseiten: 1.2 } },
    { id: 3, name: 'C', stats: { chars: 3000, words: 450, count: 4, normseiten: 1.8 } },
    { id: 4, name: 'leer', stats: { chars: 0 } },
  ]);
  assert.deepEqual(rows.map(r => r.id), [1, 2, 3], 'Kapitel ohne Zeichen fallen raus');
  assert.equal(rows[0].median, 2000);
  assert.deepEqual(rows.map(r => r.deltaPct), [-50, 0, 50]);
  assert.equal(rows[0].isMin, true);
  assert.equal(rows[2].isMax, true);
  assert.equal(rows[1].isMin, false);
  // Negativer Delta waechst nach links, positiver nach rechts ab der Mitte.
  assert.equal(rows[0].barLeftPct, 2);
  assert.equal(rows[0].barWidthPct, 48);
  assert.equal(rows[1].barLeftPct, 50);
  assert.equal(rows[1].barWidthPct, 0);
  assert.equal(rows[2].barLeftPct, 50);
  assert.equal(rows[2].isPositive, true);

  assert.deepEqual(_computeChapterLengthDist([]), []);
  assert.deepEqual(_computeChapterLengthDist([{ id: 1, name: 'x', stats: { chars: 0 } }]), []);
});

test('_memo cached auf Array-Deps und invalidiert bei Aenderung', () => {
  const card = makeCard();
  let calls = 0;
  const compute = () => { calls++; return { n: calls }; };
  const a = card._memo('k', ['sig'], compute);
  const b = card._memo('k', ['sig'], compute);
  assert.equal(a, b);
  assert.equal(calls, 1);
  card._memo('k', ['other'], compute);
  assert.equal(calls, 2);
});
