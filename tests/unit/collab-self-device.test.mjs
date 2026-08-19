// Collab-Meldungen: eigenes Zweit-Geraet (Mac-Client, zweiter Laptop, Android)
// darf nie als „anderer User" formuliert werden. Deckt die drei Faelle des
// Toasts + den Tree-Tooltip ab.

import test from 'node:test';
import assert from 'node:assert/strict';
import { appCollabMethods } from '../../public/js/app/app-collab.js';

// Minimal-Kontext: nur was die getesteten Methoden anfassen. `t` gibt den Key
// samt Params zurueck, damit der Test die Key-Wahl prueft statt Wortlaut.
function makeCtx({ currentPage = null, editMode = false, editDirty = false } = {}) {
  return {
    currentPage,
    editMode,
    editDirty,
    editConflict: null,
    statusCalls: [],
    refetched: 0,
    $store: {
      collab: {
        recentRemoteEdits: new Map(),
        collabToast: null,
        _collabToastTimer: null,
      },
    },
    t: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key),
    setStatus(msg) { this.statusCalls.push(msg); },
    _refetchCurrentPage() { this.refetched++; return Promise.resolve(); },
    ...appCollabMethods,
  };
}

const change = (id, over = {}) => ({
  page_id: id,
  page_name: 'Seite ' + id,
  updated_at: '2026-07-26T10:00:00.000Z',
  last_editor_email: 'me@example.com',
  last_editor_name: 'Ich',
  is_self: true,
  device_label: 'MacBook',
  ...over,
});

test('Batch von eigenen Geraeten meldet Geraete-Variante', () => {
  const ctx = makeCtx();
  ctx._applyCollabChanges([change(1), change(2), change(3)]);
  assert.equal(ctx.$store.collab.collabToast.isSelf, true);
  assert.match(ctx.collabToastText(), /^collab\.toast\.batchSelf:/);
  assert.match(ctx.collabToastText(), /"count":3/);
});

test('Gemischter Batch bleibt bei der neutralen Fremd-Formulierung', () => {
  const ctx = makeCtx();
  ctx._applyCollabChanges([
    change(1),
    change(2, { is_self: false, last_editor_email: 'alice@example.com', last_editor_name: 'Alice', device_label: null }),
  ]);
  assert.equal(ctx.$store.collab.collabToast.isSelf, false);
  assert.match(ctx.collabToastText(), /^collab\.toast\.batch:/);
});

test('Einzelne fremde Seite nennt den User, eigene das Geraet', () => {
  const own = makeCtx();
  own._applyCollabChanges([change(7)]);
  assert.match(own.collabToastText(), /^collab\.toast\.otherPageSelf:/);
  assert.match(own.collabToastText(), /MacBook/);

  const foreign = makeCtx();
  foreign._applyCollabChanges([
    change(7, { is_self: false, last_editor_email: 'alice@example.com', last_editor_name: 'Alice', device_label: null }),
  ]);
  assert.match(foreign.collabToastText(), /^collab\.toast\.otherPage:/);
  assert.match(foreign.collabToastText(), /Alice/);
});

test('Offene Seite vom eigenen Geraet: Refetch + Geraete-Toast', () => {
  const ctx = makeCtx({ currentPage: { id: 42 } });
  ctx._applyCollabChanges([change(42)]);
  assert.equal(ctx.refetched, 1);
  assert.match(ctx.collabToastText(), /^collab\.toast\.currentPageSelf:/);
  // Offene Seite landet nicht im Tree-Marker.
  assert.equal(ctx.$store.collab.recentRemoteEdits.size, 0);
});

test('Dirty-Editor: Konflikt-State traegt Self-Flag + Geraet', () => {
  const ctx = makeCtx({ currentPage: { id: 42 }, editMode: true, editDirty: true });
  ctx._applyCollabChanges([change(42)]);
  assert.equal(ctx.refetched, 0);
  assert.equal(ctx.editConflict.remoteIsSelf, true);
  assert.equal(ctx.editConflict.remoteDevice, 'MacBook');
  assert.match(ctx.statusCalls[0], /^edit\.conflict\.unsavedHintSelf:/);
});

test('Tree-Tooltip unterscheidet Geraet und Fremd-User', () => {
  const ctx = makeCtx();
  ctx._applyCollabChanges([
    change(1),
    change(2, { is_self: false, last_editor_email: 'alice@example.com', device_label: null }),
  ]);
  assert.match(ctx.remoteEditTip(1), /^collab\.tree\.remoteEditTipSelf:/);
  assert.equal(ctx.remoteEditTip(2), 'collab.tree.remoteEditTip');
  assert.equal(ctx.remoteEditTip(999), null);
});

test('Fehlendes Geraete-Label faellt auf den Unbekannt-Key zurueck', () => {
  const ctx = makeCtx();
  ctx._applyCollabChanges([change(3, { device_label: null })]);
  assert.match(ctx.collabToastText(), /presence\.device\.unknown/);
});

const del = (id, over = {}) => ({
  kind: 'delete',
  page_id: id,
  page_name: 'Seite ' + id,
  updated_at: '2026-07-26T10:00:00.000Z',
  last_editor_email: 'me@example.com',
  last_editor_name: 'Ich',
  is_self: true,
  device_label: 'MacBook',
  ...over,
});

test('Delete einer anderen Seite entfernt sie aus dem Tree + zeigt Delete-Toast', () => {
  const ctx = makeCtx();
  ctx.$store.nav = { pages: [{ id: 1, name: 'Seite 1' }], tree: [{ type: 'chapter', solo: true, pages: [{ id: 1, name: 'Seite 1' }] }] };
  ctx._removePageFromTree = function (id) {
    const nav = this.$store.nav;
    const pi = nav.pages.findIndex(p => p.id === id);
    if (pi >= 0) nav.pages.splice(pi, 1);
    for (let i = nav.tree.length - 1; i >= 0; i--) {
      const it = nav.tree[i];
      if (it.type !== 'chapter') continue;
      if (it.solo && it.pages?.[0]?.id === id) nav.tree.splice(i, 1);
      else {
        const j = it.pages.findIndex(p => p.id === id);
        if (j >= 0) it.pages.splice(j, 1);
      }
    }
  };
  ctx._applyCollabChanges([del(1)]);
  assert.equal(ctx.$store.nav.pages.length, 0);
  assert.equal(ctx.$store.nav.tree.length, 0);
  assert.match(ctx.collabToastText(), /^collab\.toast\.otherPageDeletedSelf:/);
});

test('Delete der aktuell offenen Seite schliesst den Editor + entfernt sie', () => {
  const ctx = makeCtx({ currentPage: { id: 5 } });
  let reset = false;
  let removed = null;
  ctx.resetPage = () => { reset = true; };
  ctx._removePageFromTree = function (id) { removed = id; };
  ctx._applyCollabChanges([del(5)]);
  assert.equal(reset, true);
  assert.equal(removed, 5);
  assert.match(ctx.collabToastText(), /^collab\.toast\.currentPageDeletedSelf:/);
});

test('Delete durch fremden User nennt den User', () => {
  const ctx = makeCtx();
  ctx.$store.nav = { pages: [{ id: 2 }], tree: [{ type: 'chapter', solo: true, pages: [{ id: 2 }] }] };
  ctx._removePageFromTree = function () {};
  ctx._applyCollabChanges([del(2, { is_self: false, last_editor_email: 'alice@example.com', last_editor_name: 'Alice', device_label: null })]);
  assert.match(ctx.collabToastText(), /^collab\.toast\.otherPageDeleted:/);
  assert.match(ctx.collabToastText(), /Alice/);
});
