// Create/Rename/Delete-Slice. Server-Calls via contentRepo + In-Place-Mirror
// in nav.tree/nav.pages. History-Push pro erfolgreichem Schritt.
import { contentRepo } from '../repo/content.js';
import { localIsoDate } from '../utils.js';
import { MAX_CHAPTER_DEPTH } from './constants.js';

export const crudMethods = {
  onRenameChapter(id, ev) {
    const newName = (ev?.target?.value || '').trim();
    const ch = this._findChapter(id)?.node;
    if (!ch || !newName || ch.name === newName) {
      if (ch && ev?.target) ev.target.value = ch.name;
      return;
    }
    const oldName = ch.name;
    this._doRenameChapter(id, newName, ev.target).then(ok => {
      if (ok) this._recordRenameChapter(id, oldName, newName);
    });
  },

  async _doRenameChapter(id, newName, inputEl) {
    const root = window.__app;
    try {
      await contentRepo.updateChapter(id, { name: newName });
      const ch = this._findChapter(id)?.node;
      if (ch) ch.name = newName;
      // In-place mirror: Kapitel-Eintrag in nav.tree (enthaelt alle Tiefen)
      // + _chapterOrderMap (keyt auf den Namen).
      for (const it of Alpine.store('nav').tree) {
        if (it.type === 'chapter' && !it.solo && it.id === id) it.name = newName;
      }
      this._rebuildChapterOrderMap();
      return true;
    } catch (e) {
      root.setStatus(root.t('bookOrganizer.saveFailed', { detail: e.message }));
      const ch = this._findChapter(id)?.node;
      if (ch && inputEl) inputEl.value = ch.name;
      return false;
    }
  },

  onRenamePage(id, ev) {
    const newName = (ev?.target?.value || '').trim();
    const page = this._findPage(id);
    if (!page || !newName || page.name === newName) {
      if (page && ev?.target) ev.target.value = page.name;
      return;
    }
    const oldName = page.name;
    this._doRenamePage(id, newName, ev.target).then(ok => {
      if (ok) this._recordRenamePage(id, oldName, newName);
    });
  },

  async _doRenamePage(id, newName, inputEl) {
    const root = window.__app;
    const nav = Alpine.store('nav');
    try {
      await contentRepo.updatePage(id, { name: newName });
      const page = this._findPage(id);
      if (page) page.name = newName;
      // In-place mirror: Page in nav.pages + ggf. solo-Tree-Entry.
      const rp = nav.pages.find(p => p.id === id);
      if (rp) rp.name = newName;
      for (const it of nav.tree) {
        if (it.type === 'chapter' && it.solo && it.pages?.[0]?.id === id) it.name = newName;
      }
      // Pages-Maps neu aufbauen (Reihenfolge unverändert, aber Name-Index drin).
      this._rebuildPageOrderMaps();
      this._invalidateDiaryCache();
      return true;
    } catch (e) {
      root.setStatus(root.t('bookOrganizer.saveFailed', { detail: e.message }));
      const page = this._findPage(id);
      if (page && inputEl) inputEl.value = page.name;
      return false;
    }
  },

  async createChapter() {
    const root = window.__app;
    const name = await root.appPrompt({
      message: root.t('bookOrganizer.promptChapterName'),
      placeholder: root.t('bookOrganizer.placeholderChapterName'),
      confirmLabel: root.t('bookOrganizer.create'),
    });
    if (!name) return;
    let createdId = null;
    const ok = await this._runMutation(async () => {
      const created = await contentRepo.createChapter({
        book_id: parseInt(Alpine.store('nav').selectedBookId, 10),
        name,
      });
      if (!created?.id) return;
      createdId = created.id;
      this._mirrorCreatedChapter(created, name);
      await this._rerender();
    }, 'bookOrganizer.createFailed');
    if (ok && createdId != null) this._recordCreateChapter(createdId, name);
  },

  async createPage(chapterId) {
    const root = window.__app;
    const isDiary = typeof root.isTagebuch === 'function' && root.isTagebuch();
    const name = await root.appPrompt({
      message: root.t('bookOrganizer.promptPageName'),
      placeholder: root.t('bookOrganizer.placeholderPageName'),
      defaultValue: isDiary ? localIsoDate() : '',
      confirmLabel: root.t('bookOrganizer.create'),
    });
    if (!name) return;
    let createdId = null;
    const ok = await this._runMutation(async () => {
      const created = await this._createPageRaw({ name, chapterId });
      if (!created?.id) return;
      createdId = created.id;
    }, 'bookOrganizer.createFailed');
    if (ok && createdId != null) this._recordCreatePage(createdId, chapterId || 0, name);
  },

  // Reine Create-Operation ohne Prompt — auch von History-Redo nutzbar.
  async _createPageRaw({ name, chapterId }) {
    const body = {
      book_id: parseInt(Alpine.store('nav').selectedBookId, 10),
      name,
      // Server (routes/content.js) defaultet HTML auf '<p></p>' wenn leer —
      // notwendig, weil sonst ein Draft angelegt wird, der nicht in GET /pages
      // auftaucht. Explizit hier setzen schadet nicht.
      html: '<p></p>',
    };
    if (chapterId) body.chapter_id = chapterId;
    const created = await contentRepo.createPage(body);
    if (!created?.id) return null;
    this._mirrorCreatedPage(created, chapterId);
    // Kapitel aufklappen, damit die neue Seite sichtbar ist (frisch erstellte
    // Kapitel sind im Organizer per Default zu). Vor _rerender setzen:
    // _recomputeInitialOpenState behält bekannte Keys, danach bindet
    // _initSortables die jetzt sichtbare Pages-UL.
    if (chapterId) this.chapterOpen = { ...this.chapterOpen, [chapterId]: true };
    await this._rerender();
    return created;
  },

  _mirrorCreatedChapter(created, name) {
    const nav = Alpine.store('nav');
    // Neues Top-Level-Kapitel steht in Depth-First-Reihenfolge am Ende — push
    // trifft die richtige Position, kein Re-Sort (der wuerde Sub-Kapitel aus
    // ihrem Parent reissen, siehe mirror.js Ordnungs-Invariante).
    nav.tree.push({
      type: 'chapter',
      id: created.id,
      name: created.name || name,
      priority: created.priority ?? Number.MAX_SAFE_INTEGER,
      depth: 1,
      parent_id: null,
      hasChildren: false,
      open: true,
      solo: false,
      pages: [],
    });
    this._rebuildChapterOrderMap();
    this._refreshChapterStats();
  },

  _mirrorCreatedPage(created, chapterId) {
    const nav = Alpine.store('nav');
    const findChapterEntry = (id) => nav.tree.find(
      it => it.type === 'chapter' && !it.solo && String(it.id) === String(id));
    const newPage = { ...created, chapterName: chapterId ? (findChapterEntry(chapterId)?.name || null) : null };
    nav.pages.push(newPage);
    if (chapterId) {
      const treeCh = findChapterEntry(chapterId);
      if (treeCh) {
        // Reassignment statt push: Alpine-Reaktivität greift bei nested
        // Arrays nicht immer zuverlässig, wenn das Parent-Item kürzlich
        // selbst gepusht wurde (neu erstelltes Kapitel). Property-Set
        // auf `.pages` triggert die Watcher in jedem Fall.
        treeCh.pages = [...treeCh.pages, newPage];
        treeCh.open = true;
      }
      // nav.pages haengt die neue Seite hinten an, obwohl sie hinter die Seiten
      // ihres Kapitels gehoert → nach Kapitel-Rang neu sortieren.
      this._resortRootPages();
    } else {
      // Solo-Entry direkt hinter den bestehenden Solo-Items einsetzen (die
      // stehen per Invariante vor allen Kapiteln).
      let lastSolo = -1;
      for (let i = 0; i < nav.tree.length; i++) {
        if (nav.tree[i].type === 'chapter' && nav.tree[i].solo) lastSolo = i;
      }
      nav.tree.splice(lastSolo + 1, 0, this._buildSoloEntry(newPage));
    }
    window.__app.tokEsts[newPage.id] = { tok: 0, words: 0, chars: 0 };
    this._rebuildPageOrderMaps();
    this._invalidateDiaryCache();
    this._refreshChapterStats();
  },

  async deleteChapter(id) {
    const root = window.__app;
    const ch = this._findChapter(id)?.node;
    if (!ch) return;
    if (ch.pages.length > 0) {
      root.setStatus(root.t('bookOrganizer.chapterNotEmpty', { name: ch.name, n: ch.pages.length }));
      return;
    }
    if ((ch.subchapters?.length || 0) > 0) {
      root.setStatus(root.t('bookOrganizer.chapterHasSubchapters', { name: ch.name }));
      return;
    }
    if (root.currentPage && root.currentPage.chapter_id === id) {
      root.setStatus(root.t('bookOrganizer.pageInEditorWarn'));
      return;
    }
    const ok = await root.appConfirm({
      message: root.t('bookOrganizer.confirmDeleteChapter', { name: ch.name }),
      confirmLabel: root.t('common.delete'),
      cancelLabel: root.t('common.cancel'),
      danger: true,
    });
    if (!ok) return;
    await this._deleteChapterRaw(id);
    this._clearHistory();
  },

  // Loescht ein LEERES Kapitel (Vorbedingung beider Aufrufer: deleteChapter
  // prueft pages/subchapters, Create-Undo betrifft ein frisch erstelltes).
  async _deleteChapterRaw(id) {
    const nav = Alpine.store('nav');
    const found = this._findChapter(id);
    if (!found) return false;
    return await this._runMutation(async () => {
      await contentRepo.deleteChapter(id);
      for (let i = nav.tree.length - 1; i >= 0; i--) {
        const it = nav.tree[i];
        if (it.type === 'chapter' && !it.solo && it.id === id) nav.tree.splice(i, 1);
      }
      found.parentList.splice(found.index, 1);
      // Struktur-Mirror zieht priority/depth/parent_id/hasChildren der
      // verbleibenden Kapitel nach (der Parent verliert ggf. sein letztes Kind).
      this._mirrorChapterOrderInRoot();
      this._invalidateDiaryCache();
      await this._reattachSortables();
    }, 'bookOrganizer.deleteFailed');
  },

  // Neues Sub-Kapitel unter einem bestehenden Kapitel anlegen.
  async createSubchapter(parentChapterId) {
    const root = window.__app;
    const parent = this._findChapter(parentChapterId)?.node;
    if (!parent) return;
    if (parent.depth >= MAX_CHAPTER_DEPTH) {
      root.setStatus(root.t('bookOrganizer.maxDepthReached'));
      return;
    }
    const name = await root.appPrompt({
      message: root.t('bookOrganizer.promptChapterName'),
      placeholder: root.t('bookOrganizer.placeholderChapterName'),
      confirmLabel: root.t('bookOrganizer.create'),
    });
    if (!name) return;
    let createdId = null;
    const ok = await this._runMutation(async () => {
      const created = await contentRepo.createChapter({
        book_id: parseInt(Alpine.store('nav').selectedBookId, 10),
        name,
        parent_chapter_id: parentChapterId,
      });
      if (!created?.id) return;
      createdId = created.id;
      this.chapterOpen = { ...this.chapterOpen, [parent.id]: true, [created.id]: true };
      // Einziger verbleibende fullReload-Pfad: das neue Kapitel existiert im
      // Workstate noch nicht, seine Einsortierungsposition im flachen nav.tree
      // ist daraus nicht ableitbar. pages:loaded triggert anschliessend
      // _rerender via Card-Listener und befuellt workTree.
      await this._applyMirror('reload');
    }, 'bookOrganizer.createFailed');
    if (ok && createdId != null) this._recordCreateChapter(createdId, name);
  },

  async deletePage(id) {
    const root = window.__app;
    if (root.currentPage && root.currentPage.id === id) {
      root.setStatus(root.t('bookOrganizer.pageInEditorWarn'));
      return;
    }
    const page = this._findPage(id);
    if (!page) return;
    const ok = await root.appConfirm({
      message: root.t('bookOrganizer.confirmDeletePage', { name: page.name }),
      confirmLabel: root.t('common.delete'),
      cancelLabel: root.t('common.cancel'),
      danger: true,
    });
    if (!ok) return;
    await this._deletePageRaw(id);
    // Delete ist nicht reversibel → History invalidieren.
    this._clearHistory();
  },

  async _deletePageRaw(id) {
    return await this._runMutation(async () => {
      await contentRepo.deletePage(id);
      this._forgetPageLocally(id);
      await this._reattachSortables();
    }, 'bookOrganizer.deleteFailed');
  },

  // Entfernt eine Seite aus dem lokalen Store/Tree + Maps, OHNE Server-Call.
  // Geteilt von _deletePageRaw (Seite geloescht) und movePageToBook (Seite hat
  // dieses Buch verlassen). Rebuild der Maps + Chapter-Stats inklusive.
  _forgetPageLocally(id) {
    const nav = Alpine.store('nav');
    const pi = nav.pages.findIndex(p => p.id === id);
    if (pi >= 0) nav.pages.splice(pi, 1);
    for (let i = nav.tree.length - 1; i >= 0; i--) {
      const it = nav.tree[i];
      if (it.type !== 'chapter') continue;
      if (it.solo && it.pages?.[0]?.id === id) {
        nav.tree.splice(i, 1);
      } else if (!it.solo) {
        const j = it.pages.findIndex(p => p.id === id);
        if (j >= 0) it.pages.splice(j, 1);
      }
    }
    // Rekursiv durch workTree.subchapters — sonst bleiben Sub-Kapitel-Pages sichtbar.
    const removeFromTree = (list) => {
      for (const c of list) {
        const j = c.pages.findIndex(p => p.id === id);
        if (j >= 0) { c.pages.splice(j, 1); return true; }
        if (removeFromTree(c.subchapters || [])) return true;
      }
      return false;
    };
    if (!removeFromTree(this.workTree)) {
      const si = this.soloPages.findIndex(p => p.id === id);
      if (si >= 0) this.soloPages.splice(si, 1);
    }
    this._rebuildPageOrderMaps();
    this._invalidateDiaryCache();
    this._refreshChapterStats();
  },

  // Seite in ein anderes Buch verschieben. Bestaetigung mit Warnung (Buchwelt-
  // Analyse der Seite wird gekappt), dann Server-Move + lokale Entfernung aus
  // diesem Buch. Die Seite landet im Zielbuch top-level — Einsortierung in ein
  // Kapitel erfolgt dort im Organizer. Nicht via History rueckgaengig.
  async movePageToBook(pageId, targetBookIdRaw) {
    const root = window.__app;
    const nav = Alpine.store('nav');
    if (this.organizerSaving) return;
    const targetBookId = parseInt(targetBookIdRaw, 10);
    if (!targetBookId) return;
    const page = this._findPage(pageId);
    if (!page) return;
    if (root.currentPage && root.currentPage.id === pageId) {
      root.setStatus(root.t('bookOrganizer.pageInEditorWarn'));
      return;
    }
    const book = (nav.books || []).find(b => String(b.id) === String(targetBookId));
    const bookName = book?.name || ('#' + targetBookId);
    const ok = await root.appConfirm({
      message: root.t('bookOrganizer.moveToBookConfirm', { page: page.name, book: bookName }),
      confirmLabel: root.t('bookOrganizer.moveToBookConfirmLabel'),
      cancelLabel: root.t('common.cancel'),
      danger: true,
    });
    if (!ok) return;
    const sourceBookId = parseInt(nav.selectedBookId, 10);
    const pageName = page.name;
    const done = await this._runMutation(async () => {
      await contentRepo.movePage(pageId, { target_book_id: targetBookId }, { sourceBookId });
      this._forgetPageLocally(pageId);
      await this._reattachSortables();
    }, 'bookOrganizer.moveToBookFailed');
    if (done) {
      // Cross-Book-Move ist nicht reversibel → History invalidieren.
      this._clearHistory();
      root.setStatus(root.t('bookOrganizer.moveToBookSuccess', { page: pageName, book: bookName }));
    }
  },
};
