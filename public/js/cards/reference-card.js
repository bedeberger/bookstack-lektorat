// Alpine.data('referenceCard') — Referenz-Slot: read-only Begleitpanel neben dem
// Notebook-Editor (Companion, Mutex mit Seiten-Chat + Ideen im 420px-Slot).
// Tabs — Figuren · Orte · Szenen · Ereignisse · Recherche · Quellen · Verwandt —
// wahlweise auf den aktuellen Kontext (Seite/Kapitel) oder das ganze Buch. Nie
// schreibend (rückwärtsgewandt — nie generativ in den Buchtext).
//
// Datenquellen: Figuren/Orte/Szenen/globalZeitstrahl aus Alpine.store('catalog');
// Figuren-Kontext bevorzugt aus $app.chapterFigures (server-geladene Kapitel-
// Figuren, gleiche Quelle wie der Editor-Highlighter), sonst Namens-Treffer im
// Seitentext; Szenen-Kontext aus selectScenesForView (geteilt mit dem Highlighter);
// Recherche lazy via /research; Quellen lazy via /sources + /sources/citations
// (Gruppierung pure in sources/cited-index.js). Löst das alte „Auf dieser Seite"-
// Panel ab; die Inline-Highlights + Popover bleiben im editorEntitiesCard.

import { fetchJson } from '../utils.js';
import { EVT } from '../events.js';
import { setupCardLifecycle } from './card-lifecycle.js';
import { selectScenesForView } from '../editor/notebook/entities.js';
import { groupCitedSources } from '../sources/cited-index.js';
import { primaryPersonLabel } from '../sources/fields.js';

const TABS = ['figuren', 'orte', 'szenen', 'ereignisse', 'recherche', 'quellen', 'verwandt'];

export function registerReferenceCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('referenceCard', () => ({
    referenceTab: 'figuren',
    referenceScope: 'page',            // 'page' (aktueller Kontext) | 'book'
    referenceRecherche: [],
    referenceRechercheLoading: false,
    // Quellen-Tab: die Quellen des Buchs (Anzeigedaten) + der Fund-Index
    // (welche Quelle steht auf welcher Seite). Beides buchweit geladen, die
    // Scope-Umschaltung filtert clientseitig.
    referenceSources: [],
    referenceCitations: [],
    referenceSourcesLoading: false,
    referenceSourcesError: '',
    // Verwandt-Tab (Semantik): auf Knopfdruck ähnliche bestehende Seiten zur
    // ganzen Seite (like-Modus, embedding-frei) oder zum markierten Absatz
    // (Freitext-q, Live-Embedding). Read-only, rückwärtsgewandt.
    verwandtBasis: 'page',            // 'page' (ganze Seite) | 'absatz' (Auswahl/Absatz)
    verwandtHits: [],
    verwandtLoading: false,
    verwandtError: '',
    verwandtSearched: false,
    verwandtNotIndexed: false,
    verwandtKey: null,                // _pageKey() zum Suchzeitpunkt (Staleness)
    _verwandtAbort: null,
    _verwandtSelText: '',             // zuletzt in .page-content-view erfasste Auswahl/Absatz
    _refPageText: '',
    _refPageTextKey: null,
    _memos: {},
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        showFlag: 'showReferenceCard',
        onShow: () => this._onVisibleReference(),
        onBookChanged: () => this._resetReference(),
        onViewReset: () => this._resetReference(),
        // Quelle angelegt/entfernt/geändert (Quellen-Karte oder Beleg-Picker im
        // Editor): das Tab zeigt sonst den Stand von vorhin.
        extraListeners: [
          {
            type: EVT.SOURCES_CHANGED,
            handler: () => { if (window.__app?.showReferenceCard) this._loadReferenceSources(); },
          },
        ],
      });
      // Verwandt-Tab: „Ganze Seite" verhält sich wie die Geschwister-Tabs und
      // sucht automatisch beim Öffnen bzw. beim Seitenwechsel (embedding-frei).
      this.$watch('referenceTab', (tab) => { if (tab === 'verwandt') this._maybeAutoVerwandt(); });
      // Basis-Wechsel: Treffer stammen aus dem anderen Modus → hart zurücksetzen
      // (kein Stehenbleiben alter Ergebnisse), dann „ganze Seite" neu suchen.
      this.$watch('verwandtBasis', () => {
        if (this.referenceTab !== 'verwandt') return;
        this._resetVerwandt();
        this._maybeAutoVerwandt();
      });
      this.$watch(() => window.__app?.currentPage?.id, () => {
        // Auswahl der alten Seite verwerfen; „ganze Seite" ggf. neu suchen.
        this._verwandtSelText = '';
        if (this.referenceTab === 'verwandt') this._maybeAutoVerwandt();
      });
      // Der Fund-Index wird serverseitig bei jedem Seiten-Write neu gebaut. Eine
      // neue `updated_at` heisst also: gerade gespeichert, ein eben eingefügter
      // Quellennachweis ist jetzt im Index. Nur die Fundstellen nachladen (die
      // Quellenliste selbst ändert ein Seiten-Save nicht) und nur mit offenem Tab.
      this.$watch(() => window.__app?.currentPage?.updated_at, () => {
        if (this.referenceTab === 'quellen' && this.referenceSources.length) {
          this._loadReferenceCitations();
        }
      });
      // Auswahl/Absatz laufend mitschreiben, solange der Cursor im Editor-Text
      // steht. Beim Klick auf den Suchen-Button ist die Live-Selection bereits
      // verloren (Fokus-Steal) — darum den zuletzt erfassten Text puffern.
      document.addEventListener('selectionchange', () => this._captureVerwandtSel(),
        { signal: this._lifecycle.signal });
    },

    destroy() { this._verwandtAbort?.abort(); this._lifecycle?.destroy(); },

    _resetReference() {
      this.referenceRecherche = [];
      this.referenceSources = [];
      this.referenceCitations = [];
      this.referenceSourcesError = '';
      this._resetVerwandt();
      this._verwandtSelText = '';
      this._refPageText = '';
      this._refPageTextKey = null;
      this._memos = {};
    },

    _resetVerwandt() {
      this._verwandtAbort?.abort();
      this.verwandtHits = [];
      this.verwandtLoading = false;
      this.verwandtError = '';
      this.verwandtSearched = false;
      this.verwandtNotIndexed = false;
      this.verwandtKey = null;
    },

    // Beim Sichtbarwerden: Katalog-Daten defensiv nachladen (der Slot lebt
    // eigenständig neben dem Editor — die Fach-Karten wurden evtl. nie geöffnet)
    // + Recherche fetchen.
    _onVisibleReference() {
      const app = window.__app;
      const bookId = Alpine.store('nav').selectedBookId;
      if (!bookId) return;
      const cat = Alpine.store('catalog');
      if (!(cat.figuren || []).length) app.loadFiguren?.(bookId);
      if (!(cat.orte || []).length) app.loadOrte?.(bookId);
      if (!(cat.szenen || []).length) app.loadSzenen?.(bookId);
      if (!(cat.globalZeitstrahl || []).length) app._reloadZeitstrahl?.();
      this._loadReferenceRecherche();
      this._loadReferenceSources();
    },

    async _loadReferenceRecherche() {
      const bookId = Alpine.store('nav').selectedBookId;
      if (!bookId) { this.referenceRecherche = []; return; }
      this.referenceRechercheLoading = true;
      try {
        const rows = await fetchJson(`/research?book_id=${bookId}`);
        this.referenceRecherche = Array.isArray(rows) ? rows : [];
      } catch { this.referenceRecherche = []; }
      finally { this.referenceRechercheLoading = false; }
    },

    // ── Quellen-Tab ─────────────────────────────────────────────────────────
    // Zwei Roundtrips pro Buch: die Quellen (Anzeigedaten) und der Fund-Index
    // (wo sie belegt sind). Archivierte kommen mit — eine archivierte Quelle
    // kann im Text weiter belegt sein, und dann gehört sie in die Liste.
    // Ohne Quellen entfällt der zweite Aufruf: ein Roman hat keine, und das Tab
    // bleibt dann ohnehin verborgen.
    async _loadReferenceSources() {
      const bookId = Alpine.store('nav').selectedBookId;
      if (!bookId) { this.referenceSources = []; this.referenceCitations = []; return; }
      this.referenceSourcesLoading = true;
      this.referenceSourcesError = '';
      try {
        const list = await fetchJson(`/sources?book_id=${encodeURIComponent(bookId)}&archived=1`);
        this.referenceSources = Array.isArray(list) ? list : [];
        if (this.referenceSources.length) await this._loadReferenceCitations();
        else this.referenceCitations = [];
      } catch {
        this.referenceSources = [];
        this.referenceCitations = [];
        this.referenceSourcesError = window.__app.t('reference.quellen.loadError');
      } finally {
        this.referenceSourcesLoading = false;
      }
    },

    /** Nur den Fund-Index nachladen — nach einem Seiten-Save hat sich die
     *  Quellenliste nicht geändert, wohl aber, wo belegt wird. */
    async _loadReferenceCitations() {
      const bookId = Alpine.store('nav').selectedBookId;
      if (!bookId) { this.referenceCitations = []; return; }
      try {
        const rows = await fetchJson(`/sources/citations?book_id=${encodeURIComponent(bookId)}`);
        this.referenceCitations = Array.isArray(rows) ? rows : [];
      } catch {
        this.referenceCitations = [];
        this.referenceSourcesError = window.__app.t('reference.quellen.loadError');
      }
    },

    // Tab-Sichtbarkeit: ohne Quellen im Buch gibt es nichts zu zeigen (analog
    // zum Verwandt-Tab, das an der Semantik-Konfiguration hängt).
    referenceHasSources() { return this.referenceSources.length > 0; },

    referenceQuellen() {
      const app = window.__app;
      const pages = Alpine.store('nav').pages || [];
      const pid = app?.currentPage?.id ?? null;
      const cid = app?.currentPage?.chapter_id ?? null;
      const scope = this._contextActive() ? 'page' : 'book';
      return this._memo('quellen',
        [scope, pid, cid, this.referenceSources, this.referenceCitations, pages],
        () => groupCitedSources({
          sources: this.referenceSources,
          citations: this.referenceCitations,
          pages, scope, pageId: pid, chapterId: cid,
        }));
    },

    referenceQuelleTitle(row) {
      return row?.source?.title || window.__app.t('sources.untitled');
    },

    /** Urheber · Jahr · Gattung — dieselben Angaben, an denen der Autor die
     *  Quelle im Verzeichnis wiedererkennt. */
    referenceQuelleMeta(row) {
      const s = row?.source;
      if (!s) return '';
      const app = window.__app;
      const type = s.csl_type ? app.t(`sources.type.${s.csl_type}`) : '';
      return [primaryPersonLabel(s), s.year, type].filter(Boolean).join(' · ');
    },

    referenceQuelleCount(row) {
      return window.__app.t('sources.citedN', { n: row?.count || 0 });
    },

    /** Wo im Ausschnitt belegt. Auf der offenen Seite belegte Quellen sagen das
     *  ausdrücklich — alles andere sind Seitennamen (zwei ausgeschrieben, der
     *  Rest gezählt; die vollständige Liste steht im Quellenverzeichnis). */
    referenceQuelleWhere(row) {
      const app = window.__app;
      if (row?.onPage) return app.t('reference.quellen.onPage');
      const names = (row?.pages || []).map(p => p.name || `#${p.pageId}`);
      if (names.length <= 2) return names.join(', ');
      return app.t('reference.quellen.morePages', {
        pages: names.slice(0, 2).join(', '), n: names.length - 2,
      });
    },

    /** Sprung ins Quellenverzeichnis auf genau diesen Eintrag. Deep-Link-Hash als
     *  SSoT — der Hash-Router öffnet die Karte, setzt Exklusivität und fokussiert
     *  die Quelle (analog openRechercheItem). */
    openReferenceSource(row) {
      const bookId = Alpine.store('nav').selectedBookId;
      const id = row?.source?.id;
      if (!bookId || id == null) return;
      location.hash = `#book/${bookId}/quellen/${id}`;
    },

    // ── Tabs + Scope ────────────────────────────────────────────────────────
    referenceTabs() { return TABS; },
    setReferenceTab(tab) { if (TABS.includes(tab)) this.referenceTab = tab; },
    toggleReferenceScope() {
      this.referenceScope = this.referenceScope === 'page' ? 'book' : 'page';
    },
    referenceHasContext() { return !!window.__app?.currentPage; },
    // Kontext-Filter greift nur, wenn Scope='page' UND eine Seite offen ist —
    // sonst wird immer das ganze Buch gezeigt (nichts zu filtern).
    _contextActive() { return this.referenceScope === 'page' && this.referenceHasContext(); },

    // ── Memo (ein Helper pro Modul, Array-Deps mit ===) ──────────────────────
    _memo(key, deps, fn) {
      const prev = this._memos[key];
      if (prev && prev.deps.length === deps.length && prev.deps.every((d, i) => d === deps[i])) {
        return prev.val;
      }
      const val = fn();
      this._memos[key] = { deps, val };
      return val;
    },

    _pageKey() {
      const p = window.__app?.currentPage;
      return p ? (p.id + ':' + (p.updated_at || '')) : '';
    },

    // Plaintext der aktuellen Seite (Namens-Treffer für Figuren/Orte im Kontext).
    _pageText() {
      const app = window.__app;
      if (!app?.currentPage) return '';
      const key = this._pageKey();
      if (this._refPageTextKey === key) return this._refPageText;
      const html = app.originalHtml || '';
      this._refPageText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').toLowerCase();
      this._refPageTextKey = key;
      return this._refPageText;
    },

    _nameInPage(names) {
      const txt = this._pageText();
      if (!txt) return false;
      return names.some(n => n && txt.includes(String(n).toLowerCase()));
    },

    _currentChapterName() {
      const cid = window.__app?.currentPage?.chapter_id;
      if (!cid) return '';
      const ch = (Alpine.store('nav').tree || []).find(c => c.id === cid);
      return ch?.name || '';
    },

    // ── Gefilterte Listen (memoized — im Template + in referenceCount genutzt) ─
    referenceFiguren() {
      const app = window.__app;
      const all = Alpine.store('catalog').figuren || [];
      const chapterFigs = app?.chapterFigures || [];
      return this._memo('figuren', [this.referenceScope, this._pageKey(), all, chapterFigs], () => {
        if (!this._contextActive()) return all;
        if (chapterFigs.length) return chapterFigs;
        return all.filter(f => this._nameInPage([f.name, f.kurzname]));
      });
    },

    referenceOrte() {
      const all = Alpine.store('catalog').orte || [];
      return this._memo('orte', [this.referenceScope, this._pageKey(), all], () => {
        if (!this._contextActive()) return all;
        return all.filter(o => this._nameInPage([o.name]));
      });
    },

    referenceSzenen() {
      const all = Alpine.store('catalog').szenen || [];
      const app = window.__app;
      const pid = app?.currentPage?.id;
      const cid = app?.currentPage?.chapter_id;
      return this._memo('szenen', [this.referenceScope, pid, cid, all], () => {
        if (!this._contextActive()) return all;
        const v = selectScenesForView(all, pid, cid);
        return [...v.onPage, ...v.inChapter];
      });
    },

    referenceEreignisse() {
      const all = Alpine.store('catalog').globalZeitstrahl || [];
      const chapName = this._currentChapterName();
      return this._memo('ereignisse', [this.referenceScope, chapName, all], () => {
        if (!this._contextActive() || !chapName) return all;
        const cl = chapName.toLowerCase();
        return all.filter(ev => {
          const kap = Array.isArray(ev.kapitel) ? ev.kapitel : (ev.kapitel ? [ev.kapitel] : []);
          return kap.some(k => String(k).toLowerCase() === cl);
        });
      });
    },

    referenceRechercheItems() {
      const all = this.referenceRecherche || [];
      const app = window.__app;
      const pid = app?.currentPage?.id;
      const cid = app?.currentPage?.chapter_id;
      return this._memo('recherche', [this.referenceScope, pid, cid, all], () => {
        if (!this._contextActive()) return all;
        return all.filter(it => (it.links || []).some(l =>
          (l.target_kind === 'page' && l.target_id === pid) ||
          (l.target_kind === 'chapter' && cid != null && l.target_id === cid)));
      });
    },

    referenceCount(tab) {
      switch (tab) {
        case 'figuren':    return this.referenceFiguren().length;
        case 'orte':       return this.referenceOrte().length;
        case 'szenen':     return this.referenceSzenen().length;
        case 'ereignisse': return this.referenceEreignisse().length;
        case 'recherche':  return this.referenceRechercheItems().length;
        case 'quellen':    return this.referenceQuellen().length;
        case 'verwandt':   return this.verwandtResults().length;
        default:           return 0;
      }
    },

    // ── Verwandt-Tab (Semantik) ───────────────────────────────────────────────
    // Ergebnisse sind seiten-spezifisch: bei Seitenwechsel gaten wir über den
    // _pageKey() (keine Watcher — konsistent mit dem Memo-Pattern der Karte).
    verwandtResults() {
      if (this.verwandtKey && this.verwandtKey !== this._pageKey()) return [];
      return this.verwandtHits;
    },
    verwandtStale() {
      return this.verwandtSearched && !!this.verwandtKey && this.verwandtKey !== this._pageKey();
    },
    verwandtScoreLabel(hit) {
      return Math.round((hit?.score || 0) * 100) + '%';
    },
    activateVerwandt(hit) {
      if (hit?.entity_id != null) window.__app?.gotoPageById?.(hit.entity_id);
    },

    // Text der aktuellen Auswahl bzw. des Absatzes am Cursor — nur innerhalb des
    // Notebook-Editor-Textkörpers (.page-content-view, view + edit teilen die Klasse).
    // Puffer: der Suchen-Button stiehlt beim Klick den Fokus und kollabiert die
    // Live-Selection, darum liefern wir den zuletzt erfassten Text.
    _verwandtSelectionText() {
      return this._verwandtSelText;
    },
    // Läuft auf jedem `selectionchange`: steht der Cursor/die Auswahl im Editor-
    // Text, den Absatz-/Auswahltext puffern; sonst den letzten Wert behalten
    // (Fokuswechsel auf die Karte darf ihn nicht löschen).
    _captureVerwandtSel() {
      const sel = window.getSelection?.();
      if (!sel || !sel.anchorNode) return;
      const startEl = sel.anchorNode.nodeType === 3 ? sel.anchorNode.parentElement : sel.anchorNode;
      if (!startEl?.closest?.('.page-content-view')) return;
      const selText = sel.toString().replace(/\s+/g, ' ').trim();
      if (!sel.isCollapsed && selText) { this._verwandtSelText = selText; return; }
      const block = startEl.closest('p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,div.poem');
      this._verwandtSelText = (block?.textContent || '').replace(/\s+/g, ' ').trim();
    },

    // Auto-Suche für „Ganze Seite" (embedding-frei) — beim Tab-Öffnen bzw.
    // Seitenwechsel. Absatz-Modus braucht eine Auswahl und bleibt manuell.
    _maybeAutoVerwandt() {
      if (this.verwandtBasis !== 'page') return;
      if (!Alpine.store('config')?.semanticSearchEnabled) return;
      if (!window.__app?.currentPage?.id) return;
      if (this.verwandtLoading) return;
      if (this.verwandtSearched && this.verwandtKey === this._pageKey()) return;
      this.runVerwandt();
    },

    async runVerwandt() {
      const app = window.__app;
      const bookId = Alpine.store('nav').selectedBookId;
      const pageId = app?.currentPage?.id;
      if (!Alpine.store('config')?.semanticSearchEnabled || !bookId || !pageId) return;

      const params = new URLSearchParams({ book_id: String(bookId), kind: 'page', limit: '10' });
      if (this.verwandtBasis === 'absatz') {
        const text = this._verwandtSelectionText();
        if (!text) {
          this._verwandtAbort?.abort();
          this.verwandtLoading = false;
          this.verwandtHits = [];
          this.verwandtSearched = true;
          this.verwandtNotIndexed = false;
          this.verwandtKey = this._pageKey();
          this.verwandtError = app.t('reference.verwandt.noSelection');
          return;
        }
        params.set('q', text.slice(0, 500));
      } else {
        params.set('like_kind', 'page');
        params.set('like_id', String(pageId));
      }

      this._verwandtAbort?.abort();
      const ctrl = new AbortController();
      this._verwandtAbort = ctrl;
      // Alte Treffer sofort leeren — während des Ladens bleibt nur der
      // Ladeindikator sichtbar (keine stehengebliebenen Ergebnisse).
      this.verwandtHits = [];
      this.verwandtLoading = true;
      this.verwandtError = '';
      this.verwandtNotIndexed = false;
      this.verwandtSearched = true;
      const key = this._pageKey();

      try {
        const r = await fetch('/search/semantic?' + params.toString(), { credentials: 'same-origin', signal: ctrl.signal });
        if (ctrl.signal.aborted) return;
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          this.verwandtError = j.error_code === 'EMBED_UNAVAILABLE'
            ? app.t('search.semantic.unavailable')
            : String(r.status);
          this.verwandtHits = []; this.verwandtKey = key;
          return;
        }
        const data = await r.json();
        if (data.notIndexed) {
          this.verwandtNotIndexed = true;
          this.verwandtHits = []; this.verwandtKey = key;
          return;
        }
        // Freitext-Modus schliesst die Quellseite nicht serverseitig aus.
        this.verwandtHits = (Array.isArray(data.hits) ? data.hits : [])
          .filter(h => !(h.kind === 'page' && String(h.entity_id) === String(pageId)));
        this.verwandtKey = key;
      } catch (e) {
        if (e.name === 'AbortError' || ctrl.signal.aborted) return;
        this.verwandtError = e.message || 'error';
        this.verwandtHits = []; this.verwandtKey = key;
      } finally {
        if (!ctrl.signal.aborted) this.verwandtLoading = false;
      }
    },

    // ── Render-Helfer ─────────────────────────────────────────────────────────
    referenceEventDate(ev) {
      if (ev?.datum_label) return ev.datum_label;
      if (ev?.datum_year != null) return String(ev.datum_year);
      return '';
    },
    referenceRechercheKind(item) {
      const app = window.__app;
      return item?.kind ? app.t('recherche.kind.' + item.kind) : '';
    },
    referenceRechercheText(item) {
      return item?.title || item?.body || '';
    },
    // Klick auf einen Recherche-Schnipsel im Referenz-Slot: zur Recherche-Karte
    // springen und das Item öffnen. Deep-Link-Hash als SSoT — der Hash-Router
    // öffnet die Karte, setzt Exklusivität und fokussiert das Item (analog gotoLink).
    openRechercheItem(item) {
      const bookId = Alpine.store('nav').selectedBookId;
      if (!bookId || item?.id == null) return;
      location.hash = `#book/${bookId}/recherche/${item.id}`;
    },
  }));
}
