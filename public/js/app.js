import { escHtml } from './utils.js';

import { historyMethods } from './book/history.js';
import { treeMethods } from './book/tree.js';
import { treeContextMenuMethods } from './book/tree-context-menu.js';
import { diaryCalendarMethods } from './book/diary-calendar.js';
import { lektoratMethods } from './editor/lektorat.js';
// readNormalSnapshot/clearNormalSnapshot werden in editor-notebook-card.js via
// notebook/card.js konsumiert (Restore-Lifecycle dort).
import { kapitelReviewMethods } from './book/kapitel-review.js';
import { figurenMethods } from './book/figuren.js';
import { ereignisseMethods } from './book/ereignisse.js';
import { writingTimeMethods } from './book/writing-time.js';
import { sttTimeMethods } from './book/stt-time.js';
import { lektoratTimeMethods } from './book/lektorat-time.js';
import { szenenMethods } from './book/szenen.js';
import { orteMethods } from './book/orte.js';
import { songsMethods } from './book/songs.js';
import { i18nMethods } from './i18n.js';
import { pageViewMethods } from './book/page-view.js';
import { notebookTrampoline } from './editor/notebook/trampoline.js';
import { focusMethods } from './editor/focus.js';
import { sttDictationMethods } from './editor/notebook/stt-dictation.js';
import { ttsProofMethods } from './editor/notebook/tts-proof.js';
import { synonymMethods } from './editor/synonyme.js';
import { figurLookupMethods } from './editor/figur-lookup.js';
import { shortcutsMethods } from './editor/shortcuts.js';
import { featuresUsageMethods } from './features-usage.js';
import { initialLektoratState } from './app/app-state.js';
import { appUiMethods } from './app/app-ui.js';
import { appChromeMethods } from './app/app-chrome.js';
import { appKomplettMethods } from './app/app-komplett.js';
import { appJobsCoreMethods } from './app/app-jobs-core.js';
import { appCollabMethods } from './app/app-collab.js';
import { appOutboxMethods } from './app/app-outbox.js';
import { appViewMethods } from './app/app-view.js';
import { appNavigationMethods } from './app/app-navigation.js';
import { appHashRouterMethods } from './app/app-hash-router.js';
import { appOnboardingMethods } from './app/app-onboarding.js';
import { rootGetterDescriptors } from './app/app-root-getters.js';
import { appInitMethods } from './app/app-init.js';
import { installFetchGuard } from './app/boot/fetch-guard.js';
import { registerServiceWorker } from './app/boot/sw-register.js';
import { setupInternalLinkA11y } from './app/boot/internal-links.js';
import { registerAppMagics, registerAllCards } from './app/register-cards.js';

// ── Boot (vor alpine:init) ───────────────────────────────────────────────────
installFetchGuard();
registerServiceWorker();
setupInternalLinkA11y();

document.addEventListener('alpine:init', () => {
  registerAppMagics();
  registerAllCards();

  Alpine.data('lektorat', () => {
    // Root-Getter (z.B. tokTotals) leben in app/app-root-getters.js als
    // Property-Descriptors. Object-Spread würde Getter zur Spread-Zeit
    // einmalig auswerten und als statischen Wert kopieren — darum
    // descriptor-basiertes Object.defineProperties auf dem fertigen Objekt.
    const obj = ({
    // ── State ────────────────────────────────────────────────────────────────
    ...initialLektoratState(),

    // Navigations-State (books, selectedBookId, pages, tree) lebt in
    // Alpine.store('nav') (cards/nav-store.js) und wird direkt via $store.nav /
    // this.$store.nav gelesen (kein Root-Proxy — wie catalog/tts/jobs).

    // ── Computed ─────────────────────────────────────────────────────────────
    // Admin-only View: Globaler Admin (global_role='admin') bekommt eine
    // reduzierte Oberfläche — keine Sidebar, keine Buchwahl, nur Admin-Tiles
    // als Landing. Dev-Mode-Admin (LOCAL_DEV_MODE) bleibt davon ausgenommen,
    // damit lokale Entwicklung mit Admin-Konto die volle UI behält.
    get isAdminOnly() {
      return !!this.$store.session.currentUser?.isAdmin && !this.$store.session.devMode;
    },
    // O(1)-Lookup-Maps für Figuren/Orte. Rebuild nur bei Referenz-Wechsel
    // (loadFiguren/loadOrte reassignen, pushen nie). In Render-Loops
    // (figuren.html, orte.html, szenen.html) ersetzen diese ein vielfaches
    // `.find(x => x.id === id)` pro Zeile durch einen Map-Lookup.
    get figurenById() {
      if (this._figMapRef !== this.$store.catalog.figuren) {
        this._figMapRef = this.$store.catalog.figuren;
        this._figMap = new Map((this.$store.catalog.figuren || []).map(f => [f.id, f]));
      }
      return this._figMap;
    },
    get orteById() {
      if (this._ortMapRef !== this.$store.catalog.orte) {
        this._ortMapRef = this.$store.catalog.orte;
        this._ortMap = new Map((this.$store.catalog.orte || []).map(o => [o.id, o]));
      }
      return this._ortMap;
    },
    get szenenById() {
      if (this._szeneMapRef !== this.$store.catalog.szenen) {
        this._szeneMapRef = this.$store.catalog.szenen;
        this._szeneMap = new Map((this.$store.catalog.szenen || []).map(s => [s.id, s]));
      }
      return this._szeneMap;
    },

    get szenenNachKapitel() {
      const map = new Map();
      for (const s of this.$store.catalog.szenen) {
        if (!s.kapitel) continue;
        if (!map.has(s.kapitel)) map.set(s.kapitel, { total: 0, stark: 0, mittel: 0, schwach: 0 });
        const e = map.get(s.kapitel);
        e.total++;
        if (s.wertung === 'stark')        e.stark++;
        else if (s.wertung === 'mittel')  e.mittel++;
        else if (s.wertung === 'schwach') e.schwach++;
      }
      return [...map.entries()].map(([name, c]) => ({ name, ...c }))
        .sort((a, b) => this._chapterIdx(a.name) - this._chapterIdx(b.name));
    },
    get szenenNachSeite() {
      const map = new Map();
      for (const s of this.$store.catalog.szenen) {
        if (!s.seite) continue;
        if (!map.has(s.seite)) map.set(s.seite, { total: 0, kapitel: s.kapitel });
        map.get(s.seite).total++;
      }
      return [...map.entries()].map(([name, d]) => ({ name, total: d.total, kapitel: d.kapitel }))
        .sort((a, b) => {
          const c = this._chapterIdx(a.kapitel) - this._chapterIdx(b.kapitel);
          return c !== 0 ? c : this._pageIdx(a.name) - this._pageIdx(b.name);
        });
    },
    // Szenen-Anzahl pro Figur (nur Figuren mit ≥1 Szene), in Figuren-Reihenfolge.
    // `wenig` markiert unterrepräsentierte Figuren (< 3 Szenen) für die
    // Übersichts-Badges. Ersetzt die doppelte Inline-Filterung im Template.
    get szenenNachFigur() {
      const counts = new Map();
      for (const s of this.$store.catalog.szenen) {
        for (const id of (s.fig_ids || [])) counts.set(id, (counts.get(id) || 0) + 1);
      }
      const out = [];
      for (const f of this.$store.catalog.figuren) {
        const total = counts.get(f.id) || 0;
        if (total === 0) continue;
        out.push({ id: f.id, name: f.kurzname || f.name, total, wenig: total < 3 });
      }
      return out;
    },
    // Szenen-Anzahl pro Wertung (Default 'mittel' bei fehlender Wertung) für die
    // Filter-Tabs. Ein Scan statt 6 Inline-Filter-Durchläufen pro Render.
    get szenenWertungCounts() {
      const c = { stark: 0, mittel: 0, schwach: 0 };
      for (const s of this.$store.catalog.szenen) {
        const w = s.wertung || 'mittel';
        if (w in c) c[w]++;
      }
      return c;
    },
    get songsByFigurId() {
      const map = new Map();
      for (const s of (this.$store.catalog.songs || [])) {
        for (const f of (s.figuren || [])) {
          const id = f.fig_id || f;
          if (!id) continue;
          if (!map.has(id)) map.set(id, []);
          map.get(id).push(s);
        }
      }
      return map;
    },
    get statusHtml() {
      if (!this.status) return '';
      const safe = escHtml(this.status);
      return this.statusSpinner
        ? `<span class="spinner"></span>${safe}`
        : safe;
    },

    // Zielseiten/-kapitel für Ideen-Verschieben-Combobox.
    // Scope 'page': Seiten gleichen Kapitels, aktuelle Seite ausgeschlossen.
    // Scope 'chapter': andere Kapitel des Buches, aktuelles Kapitel ausgeschlossen.
    // Liegt am Root, weil x-effect der Combobox-Sub-x-data nur $app/Magics,
    // nicht Karten-Methoden sieht.
    ideenMovePickerOptions() {
      const tree = this.$store.nav.tree || [];
      if (this.ideenScope === 'chapter') {
        const curCid = this.ideenChapterId;
        return tree
          .filter(it => it.type === 'chapter' && !it.solo && it.id !== curCid)
          .map(it => ({ value: it.id, label: it.name }));
      }
      const cur = this.currentPage;
      if (!cur?.id) return [];
      const pages = cur.chapter_id
        ? (tree.find(it => it.type === 'chapter' && !it.solo && it.id === cur.chapter_id)?.pages || [])
            .filter(p => p.id !== cur.id)
        : tree
            .filter(it => it.type === 'chapter' && it.solo && it.pages[0]?.id !== cur.id)
            .map(it => it.pages[0])
            .filter(Boolean);
      return pages.map(p => ({ value: p.id, label: p.name }));
    },

    get selectedBookName() {
      const book = this.$store.nav.books.find(b => String(b.id) === String(this.$store.nav.selectedBookId));
      return book?.name || '';
    },

    get _numLocale() {
      const region = this.$store.shell.defaultRegion || (this.$store.shell.uiLocale === 'en' ? 'US' : 'CH');
      const lang = this.$store.shell.uiLocale || 'de';
      return `${lang}-${region}`;
    },

    get selectedBookUrl() {
      return null;
    },

    get filteredTree() {
      const tree = this.$store.nav.tree;
      if (!this.pageSearch) {
        // BEWUSST NICHT memoisiert — anders als der Search-Branch unten.
        // Dieser Zweig haengt an `item.open`, und das wird IN PLACE mutiert
        // (tree/open-state.js, tree-context-menu.js, book-organizer/crud.js),
        // ohne dass `tree` seine Identitaet wechselt. Ein Ref-Vergleich-Memo
        // wie unten (`memo.tree === tree`) waere hier also ein Cache-Hit auf
        // veraltete Sichtbarkeit → das Auf-/Zuklappen von Kapiteln in der
        // Sidebar wuerde nichts mehr tun. Ein korrekter Cache-Key muesste den
        // open-Zustand aller Items einbeziehen und kostete damit denselben
        // O(n)-Durchlauf, den er sparen soll. Kein Problem in der Praxis:
        // sidebar.html liest `filteredTree` zweimal pro Render (x-for +
        // Leer-Check), nicht pro Page-Row.
        const byId = new Map(tree.map(it => [it.id, it]));
        const isVisible = (item) => {
          let cur = item;
          while (cur.parent_id) {
            const parent = byId.get(cur.parent_id);
            if (!parent) break;
            if (!parent.open) return false;
            cur = parent;
          }
          return true;
        };
        return tree.filter(isVisible);
      }
      const q = this.pageSearch.toLowerCase();
      // Memo: Search-Branch ist N²-Gefahr (filteredTree wird pro Page-Row
      // gelesen). Ref-Vergleich `tree` + identische Query → Cache-Hit.
      const memo = this._filteredTreeMemo;
      if (memo && memo.tree === tree && memo.q === q) return memo.val;
      // Erste Pass: Kapitel mit matchenden Seiten finden.
      const matched = new Map(); // chapter-id -> filtered-pages[]
      for (const item of tree) {
        if (item.solo) {
          if (item.name.toLowerCase().includes(q) || item.pages[0]?.name?.toLowerCase().includes(q)) {
            matched.set(item.id, item.pages);
          }
          continue;
        }
        const pages = item.pages.filter(p => p.name.toLowerCase().includes(q));
        if (pages.length) matched.set(item.id, pages);
      }
      // Zweite Pass: Vorfahren matchender Kapitel auch aufnehmen (mit leerem
      // Page-Filter), damit nested-Subchapter-Treffer ihren Eltern-Header zeigen.
      const itemById = new Map(tree.map(it => [it.id, it]));
      const addAncestors = (id) => {
        const it = itemById.get(id);
        if (!it?.parent_id) return;
        if (!matched.has(it.parent_id)) matched.set(it.parent_id, []);
        addAncestors(it.parent_id);
      };
      for (const id of [...matched.keys()]) addAncestors(id);
      const val = tree
        .filter(item => matched.has(item.id))
        .map(item => ({ ...item, pages: matched.get(item.id), open: true }));
      this._filteredTreeMemo = { tree, q, val };
      return val;
    },

    // ── Methoden aus Modulen ─────────────────────────────────────────────────
    // init() + destroy() (Root-Lifecycle) leben in app/app-init.js.
    ...appInitMethods,
    ...historyMethods,
    ...treeMethods,
    ...treeContextMenuMethods,
    ...diaryCalendarMethods,
    ...lektoratMethods,
    ...kapitelReviewMethods,
    ...figurenMethods,
    ...ereignisseMethods,
    // writingTimeMethods bleiben im Root: Schreibzeit-Heartbeat lauscht auf
    // editMode/focusActive, läuft unabhängig von der bookStatsCard-Sichtbarkeit.
    ...writingTimeMethods,
    // lektoratTimeMethods analog: lauscht auf checkDone (Prüfmodus) +
    // currentPage.id + selectedBookId; bucht Sekunden pro (User, Buch, Seite, Tag).
    ...lektoratTimeMethods,
    // sttTimeMethods: lauscht auf sttRecording (Mic aktiv); bucht Diktat-Sekunden
    // + diktierte Zeichen pro (User, Buch, Tag). _trackSttChars wird aus
    // stt-dictation.js beim Einfügen jedes Transkript-Segments aufgerufen.
    ...sttTimeMethods,
    ...szenenMethods,
    ...orteMethods,
    ...songsMethods,
    ...i18nMethods,
    ...pageViewMethods,
    ...notebookTrampoline,
    ...focusMethods,
    ...sttDictationMethods,
    ...ttsProofMethods,
    ...synonymMethods,
    ...figurLookupMethods,
    ...shortcutsMethods,
    ...appUiMethods,
    ...appChromeMethods,
    ...appKomplettMethods,
    ...appJobsCoreMethods,
    ...appCollabMethods,
    ...appOutboxMethods,
    ...appViewMethods,
    ...appNavigationMethods,
    ...appHashRouterMethods,
    ...appOnboardingMethods,
    ...featuresUsageMethods,
    });
    Object.defineProperties(obj, rootGetterDescriptors);
    return obj;
  });
});
