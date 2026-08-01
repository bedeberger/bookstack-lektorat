// Alpine.data('bookEditorCard') — Bucheditor (Facade).
//
// Rendert alle Kapitel + Seiten eines Buchs in Lesereihenfolge als Sequenz
// separater contenteditable-Blöcke. Hier liegen State, Lifecycle, Laden und
// die Block-Interaktion; die Fachteile in cards/book-editor/:
//   save.js    — Save-Queue, Konflikte, Status-Ableitung
//   find.js    — Find/Replace über den ganzen Stream
//   outline.js — Inhaltsverzeichnis + IntersectionObserver
// Kommentar-Leiste: editor/book-editor-comments.js.
//
// Click-aktiviert-Block: Default contenteditable=false; Klick setzt aktive
// pageId, Caret aus Mousedown-Position. Verlassen flusht Save bei dirty.

import { setupCardLifecycle } from './card-lifecycle.js';
import { attachFullscreenSync, toggleWrapFullscreen } from '../fullscreen.js';
import { fromPages } from '../manuscript-stream.js';
import { bookEditorCommentsMethods } from '../editor/book-editor-comments.js';
import { bookEditorFindMethods, clearHighlights } from './book-editor/find.js';
import { bookEditorOutlineMethods } from './book-editor/outline.js';
import { bookEditorSaveMethods } from './book-editor/save.js';
import { stripFocusArtefacts, fetchJson } from '../utils.js';
import { handleEditorPaste, handleEditorCopy, handleEditorCut } from '../editor/shared/paste.js';
import { createAutosaveTimers } from '../editor/shared/autosave.js';
import { createTimerBag } from '../editor/shared/timers.js';
import { renderDiagramsIn, clearRenderedDiagrams } from '../diagram/mermaid-view.js';
import { EVT } from '../events.js';

// Re-Export für Tests/Konsumenten: die Facade ist der Einstieg.
export { applySaveOutcome } from './book-editor/save.js';

const CLIPBOARD_HANDLERS = { paste: handleEditorPaste, cut: handleEditorCut };

// Zustand, der an ein Buch bzw. eine Ansicht gebunden ist. EINE Deklaration für
// Initial-State und `resetState` des Lifecycles — zwei Listen driften sonst
// auseinander (neues Feld im Init vergessen → überlebt den Buchwechsel).
// Bewusst NICHT dabei: Präferenzen, die über den Buchwechsel hinaus gelten
// (outlineOpen, findCaseSensitive/-WholeWord, bookEditorFullscreen).
const sessionState = () => ({
  blocks: [],
  loading: false,
  loadError: '',
  activePageId: null,
  saveQueue: [],
  saveAllRunning: false,
  // Pages, die der laufende Save-All-Durchgang abarbeitet — Quelle für die
  // Fortschrittsanzeige (siehe saveAllTotal/saveAllDone).
  saveAllIds: [],

  findOpen: false,
  findTerm: '',
  findReplace: '',
  findMatches: [],
  findIndex: -1,

  // Outline (Inhaltsverzeichnis): aktuell sichtbarer Page-Block via
  // IntersectionObserver. collapsedChapters: Set<chapterId> für eingeklappte
  // Kapitel-Gruppen.
  visiblePageId: null,
  collapsedChapters: {},

  // Kommentar-Leiste (verankerte Leser-Kommentare des ganzen Buchs) —
  // Methoden in editor/book-editor-comments.js.
  bookComments: [],
  commentThreads: [],
  commentGeneralThreads: [],
  commentSelectedRootId: null,
  commentReplyDrafts: {},
  commentSavingReply: null,
  commentSavingResolve: null,
  commentRailVisible: false,
  // Triage-Filter: 'all' | 'open' | 'resolved' + Reviewer-Name ('' = alle).
  commentFilterStatus: 'all',
  commentFilterReviewer: '',
  commentStackHeight: 0,   // Höhe des verankerten Karten-Stapels (px), treibt --comments-stack-height
  _pendingGotoBid: null,

  _memos: {},
});

// Build-Funktion getrennt für Unit-Tests.
// Baut die Render-Blockliste über das geteilte Stream-Modell (fromPages) und
// wrappt jeden Page-Entry mit dem Editor-State (dirty/saving/_rev/originalHtml).
// stripFocusArtefacts bleibt hier (browser-only) statt im pure Modell.
// originalUpdatedAt kommt aus der Quell-Page (das Modell trägt kein updated_at).
export function buildBlocksFromPages(pages) {
  const byId = new Map();
  for (const p of (pages || [])) byId.set(p.pageId, p);
  return fromPages(pages).map((e) => {
    if (e.kind === 'chapter') return { kind: 'chapter', chapterId: e.chapterId, name: e.name };
    const src = byId.get(e.id) || {};
    const html = stripFocusArtefacts(e.html || '');
    return {
      kind: 'page',
      pageId: e.id,
      name: e.name,
      chapterId: e.chapterId,
      html,
      originalHtml: html,
      originalUpdatedAt: src.updated_at || null,
      dirty: false,
      saving: false,
      saveError: '',
      conflict: null,
      savedAt: null,
      _rev: 0,
    };
  });
}

export function registerBookEditorCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('bookEditorCard', () => ({
    ...sessionState(),

    // Persistente Präferenzen (überleben Buch-/View-Wechsel).
    outlineOpen: true,
    findCaseSensitive: false,
    findWholeWord: false,
    // Native-Fullscreen-Status (gespiegelt vom fullscreenchange-Listener) — mehr
    // Platz für den Manuskript-Stream. Toggle in toggleBookEditorFullscreen.
    bookEditorFullscreen: false,

    // Interna ohne Reset-Bedarf: Timer-/Observer-Handles, Re-Entry-Guards.
    _autosave: null,          // createAutosaveTimers, Key = pageId
    _savedFlash: null,        // createTimerBag, nullt savedAt nach SAVED_FLASH_MS
    _queueRun: null,          // Promise des laufenden Queue-Durchlaufs
    _loadToken: 0,            // Re-Entry-Guard gegen überholende _load-Responses
    _pendingMousedown: null,
    _findRecomputeTimer: null,
    _outlineObserver: null,
    _commentLoadingBookId: null,
    _commentRecomputeRaf: null,
    _commentLayoutRaf: null,
    _commentResizeObs: null,
    _commentObserved: null,
    _commentResizeHandler: null,
    _lifecycle: null,

    init() {
      this._autosave = createAutosaveTimers((pageId) => this._enqueueSave(pageId));
      this._savedFlash = createTimerBag();

      this._lifecycle = setupCardLifecycle(this, {
        name: 'bookEditor',
        showFlag: 'showBookEditorCard',
        timerKeys: [],
        resetState: sessionState,
        load: () => this._load(Alpine.store('nav').selectedBookId),
      });

      // Vertikale Verankerung der Kommentar-Karten: Observer für Stream-Reflow +
      // Viewport-Resize (Re-Layout). Methoden in editor/book-editor-comments.js.
      this._initCommentLayout();

      window.addEventListener('beforeunload', (e) => {
        if (this.dirtyCount > 0 || this.savingCount > 0) {
          e.preventDefault();
          e.returnValue = '';
        }
      }, { signal: this._lifecycle.signal });

      // Cmd/Ctrl+F-Routing via editor-find-card: dispatcht hierher, wenn die
      // Karte sichtbar ist (statt BookStack-Search zu fokussieren).
      window.addEventListener(EVT.BOOK_EDITOR_OPEN_FIND, () => {
        if (window.__app?.showBookEditorCard) this.openFind();
      }, { signal: this._lifecycle.signal });

      // Sprung aus der „Geteilte Links"-Karte (Buch-/Kapitel-Share): zur
      // kommentierten Stelle im Stream + Thread in der Leiste öffnen.
      window.addEventListener(EVT.BOOK_EDITOR_GOTO_COMMENT, (e) => {
        this.commentRailVisible = true;
        this._pendingGotoBid = e.detail?.bid || null;
        if (this.blocks.length) this._scheduleCommentRecompute();
      }, { signal: this._lifecycle.signal });

      // Klick ausserhalb des offenen Threads (Manuskript-Stream, Chrome) schliesst
      // ihn wieder; Klicks in der Leiste oder auf eine markierte Stelle bleiben aktiv.
      document.addEventListener('click', (e) => this._railDeselectOutside(e), { signal: this._lifecycle.signal });

      // Native Fullscreen-API: Status spiegeln (Toggle-Button + Esc-Exit).
      // $root = die Karten-Wurzel (.card--bookeditor), unabhängig vom Klick-Kontext.
      attachFullscreenSync({
        resolveWrap: () => this.$root,
        signal: this._lifecycle.signal,
        onChange: (active) => { this.bookEditorFullscreen = active; },
      });
    },

    destroy() {
      this._autosave?.clearAll();
      this._savedFlash?.clearAll();
      this._teardownOutlineObserver();
      if (this._commentRecomputeRaf) { cancelAnimationFrame(this._commentRecomputeRaf); this._commentRecomputeRaf = null; }
      this._teardownCommentLayout();
      this._clearCommentHL();
      clearHighlights();
      this._lifecycle?.destroy();
    },

    // ── Laden ──────────────────────────────────────────────────────────────
    async _load(bookId) {
      if (!bookId) return;
      // Buchwechsel und showFlag-Watch können beide laden; ohne Token gewinnt
      // die langsamere Response und schreibt das alte Buch in die Karte.
      const token = ++this._loadToken;
      this._autosave.clearAll();
      this._savedFlash.clearAll();
      this.loading = true;
      this.loadError = '';
      this.blocks = [];
      this.activePageId = null;
      this._memos = {};
      try {
        const data = await fetchJson('/book-editor/' + bookId + '/contents');
        if (token !== this._loadToken) return;
        this.blocks = buildBlocksFromPages(data.pages || []);
        this.loading = false;
        if (data.missing > 0) {
          const app = window.__app;
          app?.setStatus?.(app.t('bookEditor.missingPages', { n: data.missing }), false, 5000);
        }
        // Outline-IntersectionObserver nach Render bauen + Scroll-Fade-Scrollbar
        // am Inhaltsverzeichnis (gleiches Auto-Hide-Pattern wie der Sidebar-Tree).
        this.$nextTick(() => {
          this._initOutlineObserver();
          window.__app?._bindScrollFade?.(this.$root.querySelector('.book-editor-outline'));
        });
        // Verankerte Leser-Kommentare des Buchs laden + über den Stream auflösen.
        this._loadBookComments();
      } catch (e) {
        if (token !== this._loadToken) return;
        this.loading = false;
        this.loadError = e.message || 'Load failed';
      }
    },

    ...bookEditorCommentsMethods,
    ...bookEditorSaveMethods,
    ...bookEditorFindMethods,
    ...bookEditorOutlineMethods,

    // Cache hit nur, wenn ALLE Source-Refs (deps) identisch zur letzten Compute
    // sind. Reset über this._memos = {} im Lade-Pfad.
    _memo(key, deps, compute) {
      const memos = (this._memos ||= {});
      const hit = memos[key];
      if (hit && hit.deps.length === deps.length && hit.deps.every((d, i) => d === deps[i])) {
        return hit.value;
      }
      const value = compute();
      memos[key] = { deps: [...deps], value };
      return value;
    },

    // pageId → Page-Block. Index statt blocks.find() an fünf Stellen: bei einem
    // Buch mit hunderten Blöcken läuft der Linearscan sonst auch pro Save-
    // Queue-Schritt und pro Replace-Treffer.
    _blockById(pageId) {
      return this._memo('blockIndex', [this.blocks], () => {
        const map = new Map();
        for (const b of this.blocks) if (b.kind === 'page') map.set(b.pageId, b);
        return map;
      }).get(pageId) || null;
    },

    // ── Aggregate ─────────────────────────────────────────────────────────
    // Abgeleitet statt handgepflegt: Zähler, die an sechs Stellen inkrementiert
    // und dekrementiert werden, driften irgendwann gegen die Wahrheit in
    // `blocks` (die Math.max(0, …)-Pflaster waren genau dieses Symptom).
    get dirtyCount() {
      let n = 0;
      for (const b of this.blocks) if (b.dirty) n++;
      return n;
    },

    get savingCount() {
      let n = 0;
      for (const b of this.blocks) if (b.saving) n++;
      return n;
    },

    get saveAllTotal() { return this.saveAllIds.length; },

    get saveAllDone() {
      let n = 0;
      for (const id of this.saveAllIds) if (!this._blockById(id)?.dirty) n++;
      return n;
    },

    // ── Rendering-Sync ────────────────────────────────────────────────────
    // Initialer Mount-Hook (x-init). Setzt rev-Marker + Initial-Body imperativ.
    _mountBlockEl(el, block) {
      if (!el) return;
      el.innerHTML = block.html;
      el.dataset.rev = String(block._rev || 0);
      this._syncBlockDiagrams(el, block);
    },

    // Diagramme im Stream: inaktive Blöcke zeigen das Bild, der aktive den
    // Quelltext.
    //
    // Warum der aktive Block das SVG NICHT behalten darf: `_onBlockInput` liest
    // `el.innerHTML` in `block.html` — ein gerenderter Fremdknoten im aktiven
    // Block landete beim ersten Tastendruck im Manuskript. Der Quelltext ist die
    // Wahrheit, das Bild ein Artefakt (siehe public/js/diagram/mermaid-html.js).
    //
    // Bearbeitet wird der Code hier nur als Text — die geführte Eingabe mit
    // Vorschau ist notebook-only (harte Regel „Editor-Spezifikation").
    _syncBlockDiagrams(el, block) {
      if (!el) return;
      if (this.activePageId === block.pageId) {
        clearRenderedDiagrams(el);
        return;
      }
      renderDiagramsIn(el, { errorLabel: window.__app?.t?.('editor.diagram.invalid') })
        .catch(() => {});
    },

    // Schreibt block.html in DOM-Container; läuft NICHT auf dem aktiven Block
    // (DOM gehört dort dem User). Per-Block-_rev triggert Re-Hydrate bei
    // externen Mutationen (Find/Replace, Reload).
    _maybeRehydrate(el, block) {
      if (!el) return;
      if (this.activePageId === block.pageId) return;
      const seen = parseInt(el.dataset.rev || '-1', 10);
      if (seen === block._rev) return;
      // Trusted Source: HTML kommt vom Content-Store (server-cleant).
      el.innerHTML = block.html;
      el.dataset.rev = String(block._rev);
      this._syncBlockDiagrams(el, block);
    },

    // ── Klick-aktiviert-Block ─────────────────────────────────────────────
    // Alle Block-Handler hängen im Template unter x-if="block.kind === 'page'"
    // — kein kind-Guard nötig (Invariante 2 in docs/book-editor.md).
    _onBlockMousedown(block, event) {
      if (this.activePageId === block.pageId) return;
      this._pendingMousedown = { x: event.clientX, y: event.clientY, pageId: block.pageId };
    },

    async activateBlock(block) {
      if (this.activePageId === block.pageId) return;
      const prevId = this.activePageId;
      if (prevId != null) {
        const prev = this._blockById(prevId);
        if (prev?.dirty) this._enqueueSave(prevId);
      }
      this.activePageId = block.pageId;
      this.$nextTick(() => {
        // Verlassener Block bekommt sein Bild zurück, der neue seinen Quelltext.
        // Reihenfolge: erst räumen, dann Caret setzen — das Entfernen des SVG
        // verschiebt die Höhe.
        if (prevId != null) {
          const prevEl = this.$root.querySelector(`[data-book-editor-page="${prevId}"]`);
          const prevBlock = this._blockById(prevId);
          if (prevEl && prevBlock) this._syncBlockDiagrams(prevEl, prevBlock);
        }
        // $root, nicht $el: in einer aus @click gerufenen Methode zeigt $el auf
        // das auslösende Element (den Block-Body), $root auf die Karten-Wurzel.
        const el = this.$root.querySelector(`[data-book-editor-page="${block.pageId}"]`);
        if (!el) return;
        clearRenderedDiagrams(el);
        el.focus({ preventScroll: true });
        const md = this._pendingMousedown?.pageId === block.pageId ? this._pendingMousedown : null;
        this._pendingMousedown = null;
        this._placeCaret(el, md);
      });
    },

    // Caret nach der Aktivierung setzen. Beim Mousedown war der Block noch
    // nicht editierbar — der Browser platziert also weder Fokus noch Caret
    // selbst, beides muss hier nachgeholt werden.
    //
    // Fallback ist Pflicht, nicht Kür: ohne Caret ist der Block zwar fokussiert,
    // aber Tastatureingaben laufen ins Leere (der User klickt, tippt, nichts
    // passiert). Das trifft jeden Klick, der kein Textnode erwischt — Padding,
    // Zeilenabstand, Rand — und Browser ohne caretRangeFromPoint.
    _placeCaret(el, md) {
      const sel = window.getSelection();
      if (!sel) return;
      try {
        const range = md && document.caretRangeFromPoint
          ? document.caretRangeFromPoint(md.x, md.y)
          : null;
        if (range && el.contains(range.startContainer)) {
          sel.removeAllRanges();
          sel.addRange(range);
          return;
        }
      } catch { /* fällt unten auf den Blockanfang zurück */ }
      // Kein Treffer → Caret an den Anfang des ersten Kindblocks.
      try {
        const fallback = document.createRange();
        fallback.selectNodeContents(el.firstElementChild || el);
        fallback.collapse(true);
        sel.removeAllRanges();
        sel.addRange(fallback);
      } catch { /* noop */ }
    },

    _onBlockInput(block, event) {
      block.html = event.currentTarget.innerHTML;
      this._markBlockDirty(block);
    },

    // Copy/Cut/Paste über einen Pfad — die drei unterscheiden sich nur im
    // Handler und darin, ob sie den Block-Inhalt verändern.
    onBlockClipboard(block, e, kind) {
      if (kind === 'copy') { handleEditorCopy(e); return; }
      if (this.activePageId !== block.pageId) return;
      // execCommand triggert kein input-Event in allen Browsern → manuell.
      if (!CLIPBOARD_HANDLERS[kind](e)) return;
      block.html = e.currentTarget.innerHTML;
      this._markBlockDirty(block);
    },

    // Shift+Enter = weicher Zeilenumbruch (<br>). Safari/WebKit splittet sonst
    // den Absatz in zwei <p>. execCommand('insertLineBreak') setzt cross-browser
    // konsistent ein <br> — gleicher Pfad wie Notebook-Editor.
    onBlockKeydown(block, event) {
      if (event.key === 'Enter' && event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        document.execCommand('insertLineBreak');
        this._markBlockDirty(block);
      }
    },

    // ── Save-Queue ────────────────────────────────────────────────────────
    // _markBlockDirty / _enqueueSave / _processQueue / _saveBlock /
    // saveAllDirty / Konflikt-Auflösung / Status: cards/book-editor/save.js.

    // ── Outline / TOC ─────────────────────────────────────────────────────
    // Liste der Outline-Items, abgeleitet aus blocks: pro Kapitel ein Knoten mit
    // seinen Pages, Pages vor dem ersten Kapitel in einem `solos`-Bucket. Beide
    // Knoten-Typen tragen dieselbe `pages`-Liste, damit das Template EINEN
    // Zweig hat. Memoized auf die Block-Liste — Namen/Struktur ändern sich nur
    // beim Laden, der Per-Item-Status kommt reaktiv über `outlinePageStatus`.
    get outlineNodes() {
      return this._memo('outlineNodes', [this.blocks], () => {
        const out = [];
        let currentChapter = null;
        let solos = [];
        for (const b of this.blocks) {
          if (b.kind === 'chapter') {
            if (solos.length) { out.push({ kind: 'solos', chapterId: null, pages: solos }); solos = []; }
            currentChapter = { kind: 'chapter', chapterId: b.chapterId, name: b.name, pages: [] };
            out.push(currentChapter);
          } else {
            const item = { kind: 'page', pageId: b.pageId, name: b.name, block: b };
            if (currentChapter) currentChapter.pages.push(item);
            else solos.push(item);
          }
        }
        if (solos.length) out.push({ kind: 'solos', chapterId: null, pages: solos });
        return out;
      });
    },

    onFindKeydown(event) {
      if (event.key === 'Escape') { event.preventDefault(); this.closeFind(); return; }
      if (event.key === 'Enter') {
        event.preventDefault();
        if (event.shiftKey) this.findPrev();
        else this.findNext();
      }
    },

    // Cmd/Ctrl+F läuft global über editor-find-card → book-editor:open-find.
    // Hier nur Cmd/Ctrl+S für Save-All.
    onCardKeydown(event) {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && !event.shiftKey && !event.altKey && (event.key === 's' || event.key === 'S')) {
        event.preventDefault();
        this.saveAllDirty();
      }
    },

    // Ganze Bucheditor-Karte ins Native-Vollbild — mehr Platz für den Stream.
    // Status-Sync via fullscreenchange-Listener in init() (bookEditorFullscreen).
    async toggleBookEditorFullscreen() {
      try {
        await toggleWrapFullscreen(this.$root);
      } catch {
        const app = window.__app;
        app?.setStatus?.(app.t('bookEditor.error.fullscreen'), true, 4000);
      }
    },

  }));
}
