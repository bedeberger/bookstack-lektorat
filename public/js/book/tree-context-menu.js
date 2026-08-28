import { EVT } from '../events.js';
import { contentRepo } from '../repo/content.js';
import { localIsoDate } from '../utils.js';
// Pagetree-Rechtsklick-Menü. Aktionen pro Node-Typ:
//   page    → Öffnen, Editieren (Notebook), Teilen, Exportieren, Neues Kapitel,
//             Löschen (danger)
//   chapter → Öffnen (Header-Activate = Toggle + ggf. Kapitel-Review), Teilen,
//             Exportieren, Neues Kapitel, Neue Seite, Aus-/Einschliessen
//   Neues Kapitel wird hinter dem Ziel-Kapitel (bzw. dem Kapitel der Ziel-Seite)
//   eingefügt, sonst ans Ende — createChapter positioniert nur Top-Level.
//
// SCHREIBENDE EINTRAEGE SIND `canEdit()`-GEGATET — Neue Seite, Neues Kapitel,
// Aus-/Einschliessen und Loeschen. Die Sichtbarkeit im Partial und der Guard in
// der Methode gehoeren zusammen: ohne den Guard bliebe der Pfad ueber Tastatur
// oder einen veralteten Rollen-Stand erreichbar, ohne die Sichtbarkeit saehe ein
// viewer/lektor Eintraege, die serverseitig mit 403 enden. Lesende Eintraege
// (Oeffnen, Teilen, Exportieren) bleiben ungegated — sie brauchen nur `viewer`.
//
// State lebt im Root (`pageTreeMenuOpen`/`Pos`/`Target`, deklariert in
// app-state.js#navigationState). Render-HTML in public/partials/sidebar.html.
// Methoden hier werden über `treeContextMenuMethods` in den Root gespreadet —
// `this` ist die Alpine-Root-Komponente.

// Erst-Schaetzung fuer die Position, bevor das Menue gerendert ist. Die
// tatsaechliche Groesse haengt am Node-Typ (Seite vs. Kapitel) und am Edit-Recht
// und wird nach dem Render gemessen (`_remeasurePagetreeMenu`) — geraten wird
// hier nur der erste Frame.
const MENU_W_EST = 240;
const MENU_H_EST = 340;
const MENU_GAP = 8;

const MENU_ITEM_SEL = '.context-menu-item:not([hidden])';

export const treeContextMenuMethods = {
  _openPagetreeContextMenu(ev, target) {
    if (!target || !target.kind || target.id == null) return;
    ev.preventDefault();
    ev.stopPropagation();
    this.pageTreeMenuTarget = target;
    // Roh-Koordinaten merken: das Nachmessen klemmt gegen dieselbe Cursor-
    // Position, nicht gegen die bereits geklemmte Schaetzung (sonst wandert das
    // Menue bei jeder Messung ein Stueck weiter nach oben/links).
    this._pageTreeMenuAnchor = { x: ev.clientX, y: ev.clientY };
    this._pageTreeMenuReturnFocus = document.activeElement;
    this.pageTreeMenuPos = this._clampPagetreeMenuPos(ev.clientX, ev.clientY, MENU_W_EST, MENU_H_EST);
    this.pageTreeMenuOpen = true;
    // Erst nach dem Render steht die echte Groesse fest (Seiten-Menue hat andere
    // Eintraege als das Kapitel-Menue, `canEdit` blendet weitere aus). Ohne das
    // Nachmessen schiebt die zu grosse Schaetzung das Menue unnoetig weit vom
    // Cursor weg. rAF statt reinem $nextTick: die x-if-Bloecke im Partial haben
    // eigene Effects, die in einem einzelnen Tick noch nicht gerendert sind.
    this.$nextTick(() => requestAnimationFrame(() => {
      this._remeasurePagetreeMenu();
      this._focusFirstPagetreeMenuItem();
    }));
    if (!this._pageTreeMenuOutsideHandler) {
      this._pageTreeMenuOutsideHandler = (e) => {
        const menu = document.querySelector('.pagetree-context-menu');
        if (menu && !menu.contains(e.target)) this._hidePagetreeContextMenu();
      };
      document.addEventListener('mousedown', this._pageTreeMenuOutsideHandler, true);
    }
    if (!this._pageTreeMenuKeyHandler) {
      this._pageTreeMenuKeyHandler = (e) => this._onPagetreeMenuKeydown(e);
      document.addEventListener('keydown', this._pageTreeMenuKeyHandler);
    }
    // Das Menue ist position:fixed und cursor-verankert — es scrollt nicht mit
    // seinem Ziel mit. Beim Scrollen (im Tree oder in der Seite) stuende es
    // sonst ueber einem fremden Eintrag und wuerde dessen Aktionen suggerieren.
    // Gleiches Argument fuer Resize.
    if (!this._pageTreeMenuDismissHandler) {
      this._pageTreeMenuDismissHandler = () => this._hidePagetreeContextMenu();
      window.addEventListener('scroll', this._pageTreeMenuDismissHandler, { capture: true, passive: true });
      window.addEventListener('resize', this._pageTreeMenuDismissHandler);
      // Ein Buchwechsel oder Tree-Reload macht `pageTreeMenuTarget` ungueltig:
      // die ID zeigt danach auf eine Seite, die es in diesem Buch nicht gibt.
      window.addEventListener(EVT.BOOK_CHANGED, this._pageTreeMenuDismissHandler);
      window.addEventListener(EVT.PAGES_LOADED, this._pageTreeMenuDismissHandler);
      window.addEventListener(EVT.VIEW_RESET, this._pageTreeMenuDismissHandler);
    }
  },

  _clampPagetreeMenuPos(x, y, w, h) {
    return {
      left: Math.max(MENU_GAP, Math.min(window.innerWidth - w - MENU_GAP, x)),
      top: Math.max(MENU_GAP, Math.min(window.innerHeight - h - MENU_GAP, y)),
    };
  },

  // Reale Groesse des gerenderten Menues messen und neu klemmen.
  _remeasurePagetreeMenu() {
    if (!this.pageTreeMenuOpen) return;
    const menu = document.querySelector('.pagetree-context-menu');
    const anchor = this._pageTreeMenuAnchor;
    if (!menu || !anchor) return;
    const r = menu.getBoundingClientRect();
    if (!r.height) return;
    this.pageTreeMenuPos = this._clampPagetreeMenuPos(anchor.x, anchor.y, r.width, r.height);
  },

  _pagetreeMenuItems() {
    const menu = document.querySelector('.pagetree-context-menu');
    if (!menu) return [];
    return [...menu.querySelectorAll(MENU_ITEM_SEL)].filter(el => el.offsetParent !== null);
  },

  // Fokus in das `role="menu"` ziehen. Ohne das bleibt er im Baum stehen: ein
  // Screenreader kuendigt das Menue an, findet aber keinen Eintrag darin.
  _focusFirstPagetreeMenuItem() {
    // preventScroll: das Menue ist position:fixed und liegt bereits im Bild —
    // ein Fokus-Scroll wuerde nur den Baum darunter verschieben.
    this._pagetreeMenuItems()[0]?.focus({ preventScroll: true });
  },

  // Roving-Fokus im offenen Menue (Pfeile/Home/End) + Escape.
  _onPagetreeMenuKeydown(e) {
    if (!this.pageTreeMenuOpen) return;
    if (e.key === 'Escape') { this._hidePagetreeContextMenu(); return; }
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    const items = this._pagetreeMenuItems();
    if (!items.length) return;
    e.preventDefault();
    const cur = items.indexOf(document.activeElement);
    let next;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else if (e.key === 'ArrowDown') next = cur < 0 ? 0 : (cur + 1) % items.length;
    else next = cur < 0 ? items.length - 1 : (cur - 1 + items.length) % items.length;
    items[next].focus({ preventScroll: true });
  },

  _hidePagetreeContextMenu() {
    const wasOpen = this.pageTreeMenuOpen;
    this.pageTreeMenuOpen = false;
    this.pageTreeMenuTarget = null;
    this._pageTreeMenuAnchor = null;
    if (this._pageTreeMenuOutsideHandler) {
      document.removeEventListener('mousedown', this._pageTreeMenuOutsideHandler, true);
      this._pageTreeMenuOutsideHandler = null;
    }
    if (this._pageTreeMenuKeyHandler) {
      document.removeEventListener('keydown', this._pageTreeMenuKeyHandler);
      this._pageTreeMenuKeyHandler = null;
    }
    if (this._pageTreeMenuDismissHandler) {
      window.removeEventListener('scroll', this._pageTreeMenuDismissHandler, { capture: true });
      window.removeEventListener('resize', this._pageTreeMenuDismissHandler);
      window.removeEventListener(EVT.BOOK_CHANGED, this._pageTreeMenuDismissHandler);
      window.removeEventListener(EVT.PAGES_LOADED, this._pageTreeMenuDismissHandler);
      window.removeEventListener(EVT.VIEW_RESET, this._pageTreeMenuDismissHandler);
      this._pageTreeMenuDismissHandler = null;
    }
    // Fokus zurueck auf den Baum-Eintrag, von dem aus geoeffnet wurde — aber nur,
    // wenn er noch im Dokument haengt (nach „Loeschen" ist er weg) und der Fokus
    // noch im Menue steht (eine Folgeaktion wie selectPage darf ihn behalten).
    const back = this._pageTreeMenuReturnFocus;
    this._pageTreeMenuReturnFocus = null;
    if (!wasOpen || !back?.isConnected) return;
    const active = document.activeElement;
    if (active && active !== document.body && !active.closest?.('.pagetree-context-menu')) return;
    back.focus?.({ preventScroll: true });
  },

  // Sucht das Chapter-Item im Tree. `nav.tree` ist FLACH + depth-annotiert
  // (Invariante in tree/load.js) — Sub-Kapitel stehen als eigene Items darin,
  // nicht in einem `subchapters`-Array. Ein `find` trifft daher alle Ebenen.
  _findTreeChapter(id) {
    return (this.$store.nav.tree || []).find(
      it => it.type === 'chapter' && String(it.id) === String(id)) || null;
  },

  _findTreePage(id) {
    return (this.$store.nav.pages || []).find(p => String(p.id) === String(id)) || null;
  },

  pagetreeCtxOpen() {
    const target = this.pageTreeMenuTarget;
    this._hidePagetreeContextMenu();
    if (!target) return;
    if (target.kind === 'page') {
      const page = this._findTreePage(target.id);
      if (page) this.selectPage(page);
    } else {
      const item = this._findTreeChapter(target.id);
      if (item) this._onChapterHeaderActivate(item);
    }
  },

  async pagetreeCtxEdit() {
    const target = this.pageTreeMenuTarget;
    this._hidePagetreeContextMenu();
    if (!target || target.kind !== 'page') return;
    const page = this._findTreePage(target.id);
    if (!page) return;
    await this.selectPage(page);
    // selectPage öffnet die Editor-Karte im View-Mode; Notebook-Edit-Trampoline
    // setzt editMode=true und installiert Autosave.
    this.startEdit?.();
  },

  async pagetreeCtxLektorieren() {
    const target = this.pageTreeMenuTarget;
    this._hidePagetreeContextMenu();
    if (!target || target.kind !== 'page') return;
    const page = this._findTreePage(target.id);
    if (!page) return;
    await this.selectPage(page);
    this.runCheck?.();
  },

  pagetreeCtxShare() {
    const target = this.pageTreeMenuTarget;
    this._hidePagetreeContextMenu();
    if (!target) return;
    if (target.kind === 'page') this.openShareLinksForPage(target.id);
    else this.openShareLinksForChapter(target.id);
  },

  // Kapitel aus Export/Bewertung/Komplettanalyse aus- bzw. wieder einschliessen.
  // Lektorat + Fassungen bleiben unberuehrt. In-Place-Mirror auf nav.tree (flach,
  // inkl. Sub-Kapitel) fuer sofortiges Greying. Geteilt zwischen Sidebar-Kontext-
  // menue und Kapitelbewertungs-Meatball.
  async setChapterExcluded(chapterId, next) {
    if (chapterId == null) return;
    try {
      await contentRepo.updateChapter(chapterId, { excluded: !!next });
      for (const it of (this.$store.nav.tree || [])) {
        if (it.type === 'chapter' && !it.solo && String(it.id) === String(chapterId)) it.excluded = !!next;
      }
    } catch (e) {
      this.setStatus?.(this.t('bookOrganizer.saveFailed', { detail: e.message }));
    }
  },

  pagetreeCtxToggleExclude() {
    const target = this.pageTreeMenuTarget;
    this._hidePagetreeContextMenu();
    if (!target || target.kind !== 'chapter' || !this.canEdit()) return;
    this.setChapterExcluded(target.id, !target.excluded);
  },

  // Seite aus dem Kontextmenü löschen (danger, bestätigungspflichtig).
  async pagetreeCtxDeletePage() {
    const target = this.pageTreeMenuTarget;
    this._hidePagetreeContextMenu();
    if (!target || target.kind !== 'page' || !this.canEdit()) return;
    const page = this._findTreePage(target.id);
    if (!page) return;
    // Offene Seite: ueber `deleteCurrentPage`, damit der Kapitel-Rueckfall
    // greift (sonst stuende der User nach dem Loeschen vor einer leeren
    // Ansicht). Der eigentliche Loeschvorgang liegt in beiden Faellen in
    // `deletePageById` — Rueckfrage, Server-Call und Tree-Pflege inklusive.
    if (this.currentPage && this.currentPage.id === page.id) {
      await this.deleteCurrentPage();
      return;
    }
    await this.deletePageById(page.id, { name: page.name });
  },

  // Neue Seite direkt im angeklickten Kapitel anlegen: Titel per appPrompt,
  // dann Baum + Flat-Liste lokal einhängen und zur neuen Seite springen.
  async pagetreeCtxNewPage() {
    const target = this.pageTreeMenuTarget;
    this._hidePagetreeContextMenu();
    if (!target || target.kind !== 'chapter' || !this.canEdit()) return;
    const item = this._findTreeChapter(target.id);
    if (!item || item.solo) return;
    const isDiary = typeof this.isTagebuch === 'function' && this.isTagebuch();
    const name = await this.appPrompt({
      message: this.t('pagetreeCtx.newPagePrompt'),
      placeholder: this.t('pagetreeCtx.newPagePlaceholder'),
      defaultValue: isDiary ? localIsoDate() : '',
      confirmLabel: this.t('pagetreeCtx.newPageConfirm'),
    });
    if (!name) return;
    try {
      const created = await contentRepo.createPage({
        chapter_id: parseInt(target.id, 10),
        name,
        html: '<p></p>',
      });
      if (!created?.id) return;
      const newPage = {
        ...created,
        priority: created.position, // Sort-Alias wie decoratePage
        chapterName: item.name,
      };
      this.$store.nav.pages = [...this.$store.nav.pages, newPage];
      // Reassignment statt push: Property-Set auf `.pages` triggert die
      // Alpine-Watcher zuverlässig — nested-Array-push tut das nicht immer.
      item.pages = [...(item.pages || []), newPage];
      item.open = true;
      // Ebenfalls Reassignment: der `tokTotals`-Memo haengt an der Identitaet
      // von `tokEsts` (app/app-root-getters.js).
      this.tokEsts = { ...this.tokEsts, [newPage.id]: { tok: 0, words: 0, chars: 0 } };
      await this.selectPage(newPage);
    } catch (e) {
      this.setStatus?.(this.t('bookOrganizer.saveFailed', { detail: e.message }));
    }
  },

  // Neues Kapitel direkt aus dem Kontextmenü. Position: hinter dem
  // angeklickten Kapitel bzw. hinter dem Kapitel der angeklickten Seite
  // (nur Top-Level-Kapitel positionierbar — Sub-Kapitel/kein Match → ans Ende,
  // wie createChapter fallback). createChapter liest `newChapterTitle`.
  async pagetreeCtxNewChapter() {
    const target = this.pageTreeMenuTarget;
    this._hidePagetreeContextMenu();
    if (!target || !this.canEdit()) return;
    let afterChapterId = null;
    if (target.kind === 'chapter') {
      afterChapterId = target.id;
    } else if (target.kind === 'page') {
      afterChapterId = this._findTreePage(target.id)?.chapter_id ?? null;
    }
    const name = await this.appPrompt({
      message: this.t('bookOrganizer.promptChapterName'),
      placeholder: this.t('bookOrganizer.placeholderChapterName'),
      confirmLabel: this.t('bookOrganizer.create'),
    });
    if (!name) return;
    this.newChapterTitle = name;
    // createChapter hängt das Kapitel (open:true) lokal in den Tree — es
    // erscheint sofort in der Sidebar; keine Karte aufreissen.
    await this.createChapter({ afterChapterId });
  },

  async pagetreeCtxExport() {
    const target = this.pageTreeMenuTarget;
    this._hidePagetreeContextMenu();
    if (target?.kind === 'page' || target?.kind === 'chapter') {
      await this.openExportFor(target.kind, target.id);
    } else {
      await this.openExportFor();
    }
  },

  // Export-Karte öffnen, optional mit Seiten-/Kapitel-Preset. Geteilt zwischen
  // Sidebar-Kontextmenue und den Meatball-Menues (Notebook-Seitenaktionen +
  // Kapitelbewertung).
  async openExportFor(kind, id) {
    const preset = (kind === 'page' || kind === 'chapter') && id != null
      ? { kind, id }
      : null;
    if (preset) {
      this.__exportPreset = preset;
      window.dispatchEvent(new CustomEvent(EVT.EXPORT_PRESET, { detail: preset }));
    }
    if (!this.showExportCard) await this.toggleExportCard();
    else this._scrollToCardByKey('export');
  },
};
