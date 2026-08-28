// Alpine.data('kapitelReviewCard') — Sub-Komponente der Kapitel-Bewertung.
// Per-Kapitel-Job-State: jeder Run/Reconnect schreibt in seinen eigenen Slot.
// Getter (`kapitelReviewLoading/Progress/Status/Out`) lesen den Slot des
// aktuell angezeigten Kapitels — beim Wechsel auf ein anderes Kapitel sieht
// der User dort sein eigenes Loading/Output, nicht den Status eines parallel
// laufenden Reviews.

import { fetchJson, escHtml, renderStars, noteTip } from '../utils.js';
import { renderReviewHtml, chapterReviewAxesFor } from '../book/review.js';
import { startPoll, runningJobStatus } from './job-helpers.js';
import { setupCardLifecycle } from './card-lifecycle.js';
import { contentRepo } from '../repo/content.js';

function emptySlot() {
  return { loading: false, progress: 0, status: '', out: '', jobId: null, pollTimer: null };
}

export function registerKapitelReviewCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('kapitelReviewCard', () => ({
    // kapitelReviewChapterId lebt am Root (Hash-Router + Sidebar lesen es).
    kapitelReviewHistory: {},
    selectedKapitelReviewId: null,
    _kapitelReviewByChapter: {}, // { [chapterId]: emptySlot() }
    // Per-Kapitel-Flag „Sub-Kapitel mitbewerten" (default true wenn Subs vorhanden).
    _includeSubchaptersByChapter: {},
    // Per-Sub-Kapitel Collapse-State in der Sub-Kapitel-Section
    // (default offen, User kann pro Sub zuklappen).
    _subOpenByChapter: {},
    _lifecycle: null,

    init() {
      // Backstop für Done-Events ohne lokalen per-Slot-Poller (z.B. Job lief in
      // anderem Tab oder Slot wurde durch Buchwechsel zerstört). Lädt History
      // neu, damit der Eintrag in der Card auftaucht.
      const onJobFinished = (e) => {
        const d = e.detail;
        if (d?.type !== 'chapter-review' || d.job?.status !== 'done') return;
        const root = window.__app;
        if (!Alpine.store('nav').selectedBookId || String(d.bookId) !== String(Alpine.store('nav').selectedBookId)) return;
        this.loadKapitelReviewHistory(Alpine.store('nav').selectedBookId);
      };

      const onJobReconnect = (e) => {
        const d = e.detail;
        if (d?.type !== 'kapitel-review') return;
        const chapterId = d.extra?.chapterId;
        if (!chapterId) return;
        const root = window.__app;
        const slot = this._ensureSlot(chapterId);
        slot.loading = true;
        slot.progress = d.job.progress || 0;
        slot.out = '';
        slot.status = this._formatStatus(
          d.job.statusText ? root.t(d.job.statusText, d.job.statusParams) : root.t('common.analysisRunning'),
          true,
        );
        // Reconnect zeigt das wiedergefundene Kapitel auch an.
        root.kapitelReviewChapterId = String(chapterId);
        this.startKapitelReviewPoll(d.jobId, chapterId);
      };

      const reset = (ctx) => {
        ctx._clearAllPollTimers();
        ctx._kapitelReviewByChapter = {};
        window.__app.kapitelReviewChapterId = '';
        ctx.selectedKapitelReviewId = null;
        ctx.kapitelReviewHistory = {};
      };

      this._lifecycle = setupCardLifecycle(this, {
        name: 'kapitelReview',
        showFlag: 'showKapitelReviewCard',
        timerKeys: [],
        showNeedsBookId: false,
        onShow: () => this._openKapitelReview(),
        load: (root) => this.loadKapitelReviewHistory(Alpine.store('nav').selectedBookId),
        onBookChanged: (e, ctx) => reset(ctx),
        onViewReset:   (e, ctx) => reset(ctx),
        extraListeners: [
          { type: 'job:reconnect',         handler: onJobReconnect },
          { type: 'job:finished',          handler: onJobFinished },
        ],
      });
    },

    destroy() {
      this._clearAllPollTimers();
      this._lifecycle?.destroy();
    },

    // --- Per-Kapitel-Slot-Zugriff ----------------------------------------

    _slotFor(chapterId) {
      const id = String(chapterId || '');
      return id ? (this._kapitelReviewByChapter[id] || null) : null;
    },
    _ensureSlot(chapterId) {
      const id = String(chapterId || '');
      if (!id) return null;
      if (!this._kapitelReviewByChapter[id]) this._kapitelReviewByChapter[id] = emptySlot();
      return this._kapitelReviewByChapter[id];
    },
    _currentSlot() {
      // Read-only: kein Slot anlegen beim Lesen (würde Render-Side-Effects erzeugen).
      return this._slotFor(window.__app.kapitelReviewChapterId) || emptySlot();
    },
    _clearAllPollTimers() {
      for (const slot of Object.values(this._kapitelReviewByChapter || {})) {
        if (slot.pollTimer) { clearInterval(slot.pollTimer); slot.pollTimer = null; }
      }
    },
    _formatStatus(msg, spinner = false) {
      const safe = escHtml(msg);
      return spinner ? `<span class="spinner"></span>${safe}` : safe;
    },

    get kapitelReviewLoading()  { return this._currentSlot().loading; },
    get kapitelReviewProgress() { return this._currentSlot().progress; },
    get kapitelReviewStatus()   { return this._currentSlot().status; },
    get kapitelReviewOut()      { return this._currentSlot().out; },

    _lsKeyKapitelReview(chapterId) {
      return `lektorat_chapter_review_job_${Alpine.store('nav').selectedBookId}_${chapterId}`;
    },

    renderStars(note) { return renderStars(note); },
    noteTip(note) { return noteTip(note); },

    _renderKapitelReviewHtml(r) {
      return renderReviewHtml(r, chapterReviewAxesFor(r), (k, p) => window.__app.t(k, p));
    },

    startKapitelReviewPoll(jobId, chapterId) {
      const root = window.__app;
      const slot = this._ensureSlot(chapterId);
      if (!slot) return;
      slot.jobId = jobId;
      startPoll(slot, {
        timerProp: 'pollTimer',
        jobId,
        lsKey: this._lsKeyKapitelReview(chapterId),
        progressProp: 'progress',
        onProgress: (job) => {
          slot.status = runningJobStatus(
            (k, p) => root.t(k, p),
            job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut,
            job.progress, job.tokensPerSec, job.statusParams,
          );
        },
        onNotFound: () => {
          slot.loading = false;
          slot.status = this._formatStatus(root.t('job.interrupted'));
        },
        onError: (job) => {
          slot.loading = false;
          slot.out = `<span class="error-msg">${root.t('common.errorColon')}${escHtml(root.t(job.error, job.errorParams))}</span>`;
          slot.status = '';
        },
        onDone: async (job) => {
          slot.loading = false;
          if (job.result?.empty) {
            slot.status = this._formatStatus(root.t('kapitelReview.noPages'));
            return;
          }
          const r = job.result?.review;
          if (r) {
            slot.out = this._renderKapitelReviewHtml(r);
            setTimeout(() => { slot.progress = 0; }, 400);
            slot.status = this._formatStatus(root.t('kapitelReview.pagesAnalyzed', { n: job.result.pageCount || '?' }));
            if (Alpine.store('nav').selectedBookId) await this.loadKapitelReviewHistory(Alpine.store('nav').selectedBookId);
          }
        },
      });
    },

    async loadKapitelReviewHistory(bookId) {
      try {
        this.kapitelReviewHistory = await fetchJson('/history/chapter-reviews/' + bookId) || {};
      } catch (e) {
        console.error('[loadKapitelReviewHistory]', e);
        this.kapitelReviewHistory = {};
      }
    },

    // Wird beim Öffnen der Karte (über den $watch) aufgerufen — setzt ein
    // Default-Kapitel und lädt die History.
    async _openKapitelReview() {
      const root = window.__app;
      const current = root.kapitelReviewChapterId;
      // Gültig = irgendein Kapitel im Tree (auch 0-seitige), damit ein per
      // Sidebar/Hash gezielt gewähltes neues Kapitel nicht überschrieben wird.
      const tree = Alpine.store('nav').tree || [];
      const stillValid = current && tree.some(i =>
        i.type === 'chapter' && !i.solo && String(i.id) === String(current)
      );
      if (!stillValid) {
        const eligible = this.kapitelReviewChapterOptions();
        root.kapitelReviewChapterId = eligible.length ? String(eligible[0].id) : '';
      }
      if (Alpine.store('nav').selectedBookId) {
        await this.loadKapitelReviewHistory(Alpine.store('nav').selectedBookId);
      }
    },

    async runKapitelReview() {
      const root = window.__app;
      const bookId = Alpine.store('nav').selectedBookId;
      const bookName = root.selectedBookName;
      const chapterId = root.kapitelReviewChapterId;
      if (!chapterId) return;
      const chapter = (Alpine.store('nav').tree || []).find(i => i.type === 'chapter' && String(i.id) === String(chapterId));
      const chapterName = chapter?.name || '';
      const includeSubchapters = this.kapitelReviewIncludeSubchapters(chapterId);
      const slot = this._ensureSlot(chapterId);
      slot.loading = true;
      slot.progress = 0;
      slot.out = '';
      slot.status = this._formatStatus(root.t('kapitelReview.starting'), true);
      root.showKapitelReviewCard = true;
      try {
        const { jobId } = await fetchJson('/jobs/chapter-review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            book_id: parseInt(bookId),
            chapter_id: parseInt(chapterId),
            chapter_name: chapterName,
            book_name: bookName,
            include_subchapters: includeSubchapters,
          }),
        });
        localStorage.setItem(this._lsKeyKapitelReview(chapterId), jobId);
        this.startKapitelReviewPoll(jobId, chapterId);
      } catch (e) {
        console.error('[runKapitelReview]', e);
        slot.out = `<span class="error-msg">${root.t('common.errorColon')}${escHtml(e.message)}</span>`;
        slot.status = '';
        slot.loading = false;
      }
    },

    // True wenn das Kapitel mindestens ein direktes Sub-Kapitel hat. Liest
    // den `hasChildren`-Flag aus dem Tree (tree.js setzt ihn aus childCountMap).
    kapitelReviewHasSubchapters(chapterId) {
      if (!chapterId) return false;
      const tree = Alpine.store('nav').tree || [];
      const ch = tree.find(it =>
        it.type === 'chapter' && !it.solo && String(it.id) === String(chapterId),
      );
      return !!ch?.hasChildren;
    },

    // Liefert alle Nachfahren-Kapitel-IDs (inkl. Self), basierend auf
    // Alpine.store('nav').tree-parent_id-Kette. Genutzt fuer Stats-Aggregation und Default-Flag.
    _kapitelReviewDescendantIds(chapterId) {
      const tree = Alpine.store('nav').tree || [];
      const ids = new Set([String(chapterId)]);
      let added = true;
      while (added) {
        added = false;
        for (const it of tree) {
          if (it.type !== 'chapter' || it.solo) continue;
          if (ids.has(String(it.parent_id)) && !ids.has(String(it.id))) {
            ids.add(String(it.id));
            added = true;
          }
        }
      }
      return ids;
    },

    // Per-Kapitel-Flag mit Auto-Default: hat Kapitel Sub-Kapitel → true, sonst false.
    kapitelReviewIncludeSubchapters(chapterId) {
      const key = String(chapterId || '');
      if (!key) return false;
      if (key in this._includeSubchaptersByChapter) return this._includeSubchaptersByChapter[key];
      return this.kapitelReviewHasSubchapters(chapterId);
    },

    setKapitelReviewIncludeSubchapters(chapterId, value) {
      const key = String(chapterId || '');
      if (!key) return;
      this._includeSubchaptersByChapter = {
        ...this._includeSubchaptersByChapter,
        [key]: !!value,
      };
    },

    // Page-Count fuers Run-Label: direkte Seiten oder inkl. Sub-Kapitel.
    kapitelReviewEffectivePageCount(chapterId) {
      const id = chapterId || window.__app.kapitelReviewChapterId;
      if (!id) return 0;
      const tree = Alpine.store('nav').tree || [];
      if (!this.kapitelReviewIncludeSubchapters(id)) {
        const ch = tree.find(i => i.type === 'chapter' && !i.solo && String(i.id) === String(id));
        return ch?.pages?.length || 0;
      }
      const ids = this._kapitelReviewDescendantIds(id);
      let n = 0;
      for (const it of tree) {
        if (it.type !== 'chapter' || it.solo) continue;
        if (ids.has(String(it.id))) n += it.pages?.length || 0;
      }
      return n;
    },

    async deleteKapitelReview(id) {
      try {
        await fetchJson('/history/chapter-review/' + id, { method: 'DELETE' });
        if (Alpine.store('nav').selectedBookId) await this.loadKapitelReviewHistory(Alpine.store('nav').selectedBookId);
      } catch (e) {
        console.error('[deleteKapitelReview]', e);
      }
    },

    // Sobald mindestens ein Kapitel mehrere Seiten hat, lohnt sich das Kapitel-
    // Review für alle Kapitel des Buchs – auch für solche mit nur einer Seite.
    // Bücher aus lauter Ein-Seiten-Kapiteln bzw. reinen Solo-Seiten deckt das
    // Seiten-Lektorat ab.
    _bookQualifiesForChapterReview() {
      const chapters = (Alpine.store('nav').tree || []).filter(i => i.type === 'chapter' && !i.solo);
      return chapters.some(c => c.pages.length > 1);
    },

    // Liste der Kapitel, die fürs Kapitel-Review anklickbar sind. Parent-Kapitel
    // ohne direkte Pages, aber mit Sub-Kapiteln, sind ebenfalls eligible — der
    // Job lädt bei include_subchapters=true alle Descendant-Pages.
    kapitelReviewChapterOptions() {
      if (!this._bookQualifiesForChapterReview()) return [];
      return (Alpine.store('nav').tree || [])
        .filter(i => i.type === 'chapter' && !i.solo
          && (i.pages.length > 0 || this.kapitelReviewHasSubchapters(i.id)))
        .map(c => ({ id: c.id, name: c.name, pageCount: this.kapitelReviewEffectivePageCount(c.id) }));
    },

    // Direkte + transitiv geerbte Sub-Kapitel des aktiven Kapitels, in Tree-
    // Order (DFS), jedes mit `depthOffset` relativ zum Parent (1, 2, …) und
    // den eigenen Pages aus Alpine.store('nav').tree.
    kapitelReviewSubchapterTree(chapterId) {
      const id = chapterId || window.__app.kapitelReviewChapterId;
      if (!id) return [];
      const tree = Alpine.store('nav').tree || [];
      const byParent = new Map();
      for (const it of tree) {
        if (it.type !== 'chapter' || it.solo) continue;
        const pk = String(it.parent_id || '');
        if (!byParent.has(pk)) byParent.set(pk, []);
        byParent.get(pk).push(it);
      }
      const result = [];
      const walk = (parentKey, depthOffset) => {
        const kids = byParent.get(parentKey) || [];
        for (const k of kids) {
          result.push({
            id: k.id,
            name: k.name,
            depthOffset,
            pages: k.pages || [],
            hasChildren: !!byParent.get(String(k.id))?.length,
          });
          walk(String(k.id), depthOffset + 1);
        }
      };
      walk(String(id), 1);
      return result;
    },

    isSubchapterOpen(subId) {
      const k = String(subId || '');
      if (!k) return false;
      return k in this._subOpenByChapter ? !!this._subOpenByChapter[k] : true;
    },

    toggleSubchapterOpen(subId) {
      const k = String(subId || '');
      if (!k) return;
      const current = this.isSubchapterOpen(k);
      this._subOpenByChapter = { ...this._subOpenByChapter, [k]: !current };
    },

    kapitelReviewSelectedChapter() {
      if (!window.__app.kapitelReviewChapterId) return null;
      return (Alpine.store('nav').tree || []).find(i =>
        i.type === 'chapter' && !i.solo && String(i.id) === String(window.__app.kapitelReviewChapterId)
      ) || null;
    },

    kapitelReviewLastEditAt() {
      const ch = this.kapitelReviewSelectedChapter();
      if (!ch?.pages?.length) return null;
      let max = 0;
      for (const p of ch.pages) {
        const t = p.updated_at ? new Date(p.updated_at).getTime() : 0;
        if (t > max) max = t;
      }
      return max ? new Date(max).toISOString() : null;
    },

    kapitelReviewChapterStats() {
      const ch = this.kapitelReviewSelectedChapter();
      if (!ch) return null;
      const root = window.__app;
      const ests = root.tokEsts || {};
      const tree = Alpine.store('nav').tree || [];
      const includeSubs = this.kapitelReviewIncludeSubchapters(ch.id);
      const chapterIds = includeSubs
        ? this._kapitelReviewDescendantIds(ch.id)
        : new Set([String(ch.id)]);
      let chars = 0, words = 0, tok = 0, any = false;
      for (const it of tree) {
        if (it.type !== 'chapter' || it.solo) continue;
        if (!chapterIds.has(String(it.id))) continue;
        for (const p of it.pages || []) {
          const e = ests[p.id];
          if (!e) continue;
          any = true;
          chars += e.chars || 0;
          words += e.words || 0;
          tok   += e.tok   || 0;
        }
      }
      return any ? { chars, words, tok } : null;
    },

    kapitelReviewCurrentHistory() {
      if (!window.__app.kapitelReviewChapterId) return [];
      return this.kapitelReviewHistory?.[String(window.__app.kapitelReviewChapterId)] || [];
    },

    // Notendifferenz eines History-Eintrags gegenüber dem chronologisch
    // vorherigen Run desselben Kapitels. Die Liste ist newest-first, der
    // Vorgänger liegt also bei index+1. null, wenn kein Vorgänger existiert,
    // eine Note fehlt oder die Note unverändert ist.
    kapitelReviewNoteDelta(index) {
      const list = this.kapitelReviewCurrentHistory();
      const cur = list[index]?.review_json?.gesamtnote;
      const prev = list[index + 1]?.review_json?.gesamtnote;
      if (typeof cur !== 'number' || typeof prev !== 'number') return null;
      const d = Math.round((cur - prev) * 100) / 100;
      return d === 0 ? null : d;
    },

    // Schnell eine Seite im aktuellen Kapitel anlegen — Baum + Flat-Liste lokal
    // einhängen, dann zur neuen Seite springen.
    async createKapitelPage() {
      const root = window.__app;
      const chapter = this.kapitelReviewSelectedChapter();
      const title = (root.newPageTitle || '').trim();
      if (!chapter || !title || root.newPageCreating) return;
      root.newPageCreating = true;
      root.newPageError = '';
      try {
        const created = await contentRepo.createPage({
          chapter_id: parseInt(chapter.id),
          name: title,
          html: '<p></p>',
        });
        root.newPageTitle = '';
        if (!created?.id) return;
        const newPage = {
          ...created,
          priority: created.position, // legacy Sort-Alias wie decoratePage
          chapterName: chapter.name,
        };
        Alpine.store('nav').pages = [...Alpine.store('nav').pages, newPage];
        const chapterItem = Alpine.store('nav').tree.find(i =>
          i.type === 'chapter' && !i.solo && String(i.id) === String(chapter.id)
        );
        if (chapterItem) {
          // Reassignment statt push: Property-Set auf `.pages` triggert die
          // Alpine-Watcher zuverlässig — nested-Array-push tut das nicht immer
          // (Sidebar-Tree würde die neue Seite sonst erst nach Reload zeigen).
          chapterItem.pages = [...chapterItem.pages, newPage];
          chapterItem.open = true;
        }
        // Reassignment statt Index-Assign: der `tokTotals`-Memo haengt an der
        // Identitaet von `tokEsts` (app/app-root-getters.js).
        root.tokEsts = { ...root.tokEsts, [newPage.id]: { tok: 0, words: 0, chars: 0 } };
        await root.selectPage(newPage);
      } catch (e) {
        console.error('[createKapitelPage]', e);
        root.newPageError = e.message || root.t('common.unknownError');
      } finally {
        root.newPageCreating = false;
      }
    },

    // Neues Kapitel direkt unter dem aktuell angezeigten Kapitel einhängen
    // und sofort zum neuen Kapitel navigieren, damit der User dort eine
    // erste Seite anlegen kann.
    async createSiblingChapter() {
      const root = window.__app;
      const current = this.kapitelReviewSelectedChapter();
      if (!current || root.newChapterCreating) return;
      const created = await root.createChapter({ afterChapterId: current.id });
      if (!created) return;
      root.kapitelReviewChapterId = String(created.id);
    },
  }));
}
