// Teil von appViewMethods (siehe Facade app-view.js).
import { EVT, clearDraft, contentRepo, decorateMentions, escHtml, fetchJson, getDeviceId, htmlToText, readDraft, setLastPageId } from './_shared.js';

export const pageMethods = {
  async selectPage(p) {
    if (this.currentPage && this.currentPage.id === p.id) {
      // Re-Klick auf bereits offene Seite: SW-Cache umgehen und frischen
      // Server-Stand laden. Aktive Edits nicht überschreiben.
      if (this.editMode || this.editDirty) return;
      this._scrollToEditorCard();
      await this._refetchCurrentPage();
      return;
    }
    if (this.editMode && this.editDirty) {
      // appConfirm statt native confirm(): gleicher Dialog wie cancelEdit /
      // discardDraft. Nicht `danger` — der Entwurf bleibt erhalten (resetPage
      // baut die Session mit `keepDraft` ab), es geht nichts verloren.
      const ok = await this.appConfirm({
        message: this.t('app.switchPageConfirm'),
        confirmLabel: this.t('app.switchPageConfirmBtn'),
      });
      if (!ok) return;
    }
    // Alle Buchkarten schliessen + Editor-State resetten – nur eine Ebene
    // (Buch oder Seite) aktiv. Helper deckt alle showXxxCard-Flags ab und
    // ruft resetPage(); kein Argument = nichts behalten.
    this._closeOtherMainCards();
    // Editor + Sub-Partials parallel laden. Sub-Karten (toolbar, find, synonyme,
    // figur-lookup, focus) sind Geschwister-Partials, keine nested children —
    // werden vom Cascade-Helper deshalb nicht automatisch mitgezogen.
    await Promise.all([
      this._ensurePartial('editor-notebook'),
      this._ensurePartial('editor-toolbar'),
      this._ensurePartial('editor-find'),
      this._ensurePartial('editor-figur-lookup'),
      this._ensurePartial('editor-synonyme'),
      this._ensurePartial('editor-focus'),
    ]);
    // Zweite Exklusivitäts-Runde: die Partial-Awaits oben sind Netz-Fetches und
    // können bei schlechter Verbindung hängen. In dieser Zeit kann ein parallel
    // laufender Landing-Pfad (`_maybeOpenBookOverview`) eine Buchkarte geöffnet
    // haben — ohne diesen Re-Assert stünden Übersicht und Editor gleichzeitig
    // offen. Kein `resetPage()`: das lief oben schon, ein zweiter Lauf würde die
    // gerade aufgebaute Editor-Session wieder abräumen.
    this._closeOtherMainCards(null, { resetPage: false });
    this.currentPage = p;
    this.showEditorCard = true;
    this.$nextTick(() => this._scrollToEditorCard());

    if (typeof this._trackPageUsage === 'function' && this.$store.nav.selectedBookId) {
      this._trackPageUsage(p.id, this.$store.nav.selectedBookId);
    }
    setLastPageId(this.$store.session.currentUser?.email, this.$store.nav.selectedBookId, p.id);
    // Eine geoeffnete Seite ist das staerkste „ich arbeite in DIESEM Buch"-Signal
    // (gedrosselt im Helfer). Es entscheidet, welches Buch der naechste Aufruf
    // der Stamm-URL zeigt.
    this._touchBookOpened?.(this.$store.nav.selectedBookId);

    this._loadPageBadgeCounts(p.id);

    // Seiteninhalt laden und als formatiertes HTML rendern. Fehler landen
    // nicht still in einer leeren Seite, sondern in einem Retry-Block
    // (pageLoadError) — inkl. einmaligem stillem Auto-Retry mit Cache-Bypass.
    this.analysisOut = '';
    await this._loadCurrentPageContent(p);

    // Prüfen ob ein Lektorat-Check-Job für diese Seite läuft (Server-seitig oder aus früherer Session)
    try {
      const { jobId: activeJobId } = await fetchJson(`/jobs/active?type=check&page_id=${p.id}`);
      if (activeJobId) {
        localStorage.setItem('lektorat_check_job_' + p.id, activeJobId);
        this.checkLoading = true;
        this.checkProgress = 0;
        this.analysisOut = '';
        this.checkStatus = `<span class="spinner"></span>${escHtml(this.t('app.lektoratRunning'))}`;
        this.startCheckPoll(activeJobId);
      } else {
        // Kein aktiver Job → stale localStorage-Eintrag bereinigen
        localStorage.removeItem('lektorat_check_job_' + p.id);
      }
    } catch (e) { console.error('[selectPage active-job check]', e); }

    // Figurenkontext für dieses Kapitel laden (parallel zur History)
    this.loadChapterFigures();
    await this.loadPageHistory(p.id);
  },


  // Lädt die aktuell offene Seite neu vom Server (SW-Cache umgangen). Wird
  // beim Re-Klick auf die offene Sidebar-Seite verwendet, damit nach externer
  // Änderung in BookStack kein veralteter Stand stehenbleibt.
  // Push-getriebenen „Zuletzt bearbeitet"-Hint aufbereiten. Zeigt nur, wenn das
  // letzte Save von einem ANDEREN eigenen Gerät kam: device_name ist serverseitig
  // schon user-scoped (kein Fremd-Leak), hier zusätzlich das AKTUELLE Gerät
  // ausfiltern (is_current_device → kein irritierender Selbst-Hinweis). Kein
  // Live-Signal: der Stand stammt aus dem letzten Save, refresht nur bei Reload.
  _resolvePageLastEditor(le) {
    if (!le || !le.device_name || !le.device_id) return null;
    if (le.device_id === getDeviceId()) return null;
    return { device_name: le.device_name, updated_at: le.updated_at || null };
  },


  // Page-Detail-Antwort in den Render-State übernehmen. Geteilt von
  // selectPage-Load und _refetchCurrentPage, damit beide Pfade exakt dieselben
  // Felder setzen (kein Drift). `p` ist die Page (currentPage).
  _applyPageData(p, pd) {
    const html = pd.html || '';
    this.originalHtml = html;
    this.renderedPageHtml = decorateMentions(html);
    this._updatePageViewHeight();
    // Listing-Cache kann stale sein (Page-Save aktualisiert ihn nicht).
    if (pd.updated_at) p.updated_at = pd.updated_at;
    this.currentPageEmpty = !htmlToText(html).trim();
    this.pageLastEditor = this._resolvePageLastEditor(pd.last_editor);
    this._refreshPendingDraft(p.id, html);
    return html;
  },


  // Seiteninhalt für `p` laden und rendern. Bei Ladefehler einmaliger stiller
  // Auto-Retry mit Cache-Bypass (`fresh`) — deckt transiente Netz-/SW-Cache-
  // Zustände ab (typisch direkt nach Deploy). Schlägt auch der Retry fehl,
  // wird `pageLoadError` gesetzt → View zeigt Retry-Block statt leerer Seite.
  // `auto`=false unterdrückt den stillen Retry (manueller Retry-Button).
  async _loadCurrentPageContent(p, { auto = true } = {}) {
    const pageId = p.id;
    this.pageLoadError = false;
    this.pageContentLoading = true;
    try {
      let pd = await contentRepo.loadPage(pageId);
      // Während des await kann der User weggewechselt haben → nichts anwenden.
      if (this.currentPage?.id !== pageId) return true;
      // Stale-Check: Wenn der Tree-Eintrag (`p.updated_at`, kann selbst aus
      // SW-Cache stammen) jünger ist als die Detail-Antwort, hat der SW eine
      // veraltete Version geliefert → einmalig mit `fresh` nachziehen.
      if (p.updated_at && pd.updated_at && new Date(pd.updated_at) < new Date(p.updated_at)) {
        pd = await contentRepo.loadPage(pageId, { fresh: true });
        if (this.currentPage?.id !== pageId) return true;
      }
      this._applyPageData(p, pd);
      return true;
    } catch (e) {
      console.error('[selectPage load-page]', e);
      if (this.currentPage?.id !== pageId) return false;
      if (auto) {
        try {
          const pd = await contentRepo.loadPage(pageId, { fresh: true });
          if (this.currentPage?.id !== pageId) return false;
          this._applyPageData(p, pd);
          return true;
        } catch (e2) {
          console.error('[selectPage load-page retry]', e2);
          if (this.currentPage?.id !== pageId) return false;
        }
      }
      this.pageLoadError = true;
      this.setStatus(this.t('chat.pageLoadFailed'));
      return false;
    } finally {
      // Skelett nur ausblenden, wenn dieser Load noch die aktuelle Seite betrifft —
      // bei schnellem Weiterwechsel besitzt der neuere Load das Flag.
      if (this.currentPage?.id === pageId) this.pageContentLoading = false;
    }
  },


  // Aus dem Retry-Block im View-Modus: Seiteninhalt erneut laden (Cache-Bypass
  // via `fresh` greift im stillen Auto-Retry-Zweig von _loadCurrentPageContent).
  async retryLoadPage() {
    if (!this.currentPage || this._retryingPageLoad) return;
    this._retryingPageLoad = true;
    try {
      await this._loadCurrentPageContent(this.currentPage);
    } finally {
      this._retryingPageLoad = false;
    }
  },


  async _refetchCurrentPage() {
    if (!this.currentPage) return;
    const pageId = this.currentPage.id;
    try {
      const pd = await contentRepo.loadPage(pageId, { fresh: true });
      if (this.currentPage?.id !== pageId) return;
      const html = this._applyPageData(this.currentPage, pd);
      // Findings/Marks erhalten: ohne Refilter würden Marks beim Refetch
      // (Re-Klick, Collab-Remote-Edit, Revision-Restore) verschwinden, obwohl
      // `checkDone` + `lektoratFindings` noch gesetzt sind.
      if (this.lektoratFindings?.length > 0) {
        this._filterFindingsAfterSave?.(html);
        this.updatePageView();
      }
    } catch (e) {
      console.error('[refetchCurrentPage]', e);
      this.setStatus(this.t('chat.pageLoadFailed'));
    }
  },


  // Inline-Rename des Seitentitels aus dem Editor-Card-Header. Spiegelt den
  // neuen Namen in currentPage, Alpine.store('nav').pages und Alpine.store('nav').tree (inkl. Solo-Wrapper +
  // Sub-Kapitel) — Buchorganizer-Pfade pflegen Order-Maps, hier nicht nötig.
  async renameCurrentPage(ev) {
    const newName = (ev?.target?.value || '').trim();
    const page = this.currentPage;
    if (!page || !newName || page.name === newName) {
      if (page && ev?.target) ev.target.value = page?.name || '';
      return;
    }
    const oldName = page.name;
    try {
      await contentRepo.updatePage(page.id, { name: newName });
      page.name = newName;
      const rp = this.$store.nav.pages.find(p => p.id === page.id);
      if (rp) rp.name = newName;
      const renameInTree = (items) => {
        for (const it of items) {
          if (it.type !== 'chapter') continue;
          if (it.solo && it.pages?.[0]?.id === page.id) it.name = newName;
          if (!it.solo) {
            const cp = it.pages?.find(p => p.id === page.id);
            if (cp) cp.name = newName;
          }
          if (it.subchapters?.length) renameInTree(it.subchapters);
        }
      };
      renameInTree(this.$store.nav.tree);
      // nav.pages-Identität neu setzen → invalidiert den identity-gateten
      // Diary-Kalender-Cache (er keyt auf den YYYY-MM-DD-Page-Namen).
      this.$store.nav.pages = [...this.$store.nav.pages];
    } catch (e) {
      this.setStatus(this.t('bookOrganizer.saveFailed', { detail: e.message }));
      if (ev?.target) ev.target.value = oldName;
    }
  },


  // EINZIGER Loeschweg einer Seite im Frontend — Sidebar-Kontextmenue, Editor
  // und Buchorganizer laufen alle hierher. Traegt Rueckfrage, Server-Call,
  // Entwurfs-Cleanup, Editor-Schliessung und das lokale Entfernen aus dem Store;
  // die Aufrufer behalten nur ihren eigenen Nachlauf (Editor: Kapitel-Rueckfall,
  // Organizer: History-Invalidierung).
  //
  // Kein `loadPages()`: entfernt wird in-place aus `nav.pages`/`nav.tree`
  // (`_removePageFromTree`, dieselbe SSoT wie der Remote-Delete des Collab-Feeds).
  // Ein Refetch wuerde den Sidebar-Tree leeren und neu aufbauen — sichtbares
  // Flackern fuer eine Information, die der Client schon hat.
  //
  // Liefert true, wenn die Seite wirklich weg ist (der Aufrufer haengt seinen
  // Nachlauf daran); false bei Abbruch in der Rueckfrage UND bei Serverfehler —
  // die Fehlermeldung steht dann schon im Status.
  //
  // `verify` laeuft NACH der Rueckfrage: der Dialog ist asynchron, waehrenddessen
  // kann eine andere Seite geoeffnet worden sein. Aufrufer, deren Ziel „die
  // aktuelle Seite" ist, pruefen darin, dass es noch dieselbe ist.
  async deletePageById(pageId, { name = '', confirm = true, verify = null } = {}) {
    if (!pageId || !this.canEdit()) return false;
    if (confirm) {
      const ok = await this.appConfirm({
        message: this.t('bookOrganizer.confirmDeletePage', { name }),
        confirmLabel: this.t('common.delete'),
        cancelLabel: this.t('common.cancel'),
        danger: true,
      });
      if (!ok) return false;
    }
    if (verify && !verify()) return false;
    try {
      await contentRepo.deletePage(pageId, { bookId: this.$store.nav.selectedBookId });
    } catch (e) {
      console.error('[deletePageById]', e);
      this.setStatus(this.t('bookOrganizer.deleteFailed', { detail: e.message }));
      return false;
    }
    try { clearDraft(pageId); } catch {}
    // Offene Seite: erst den Editor abbauen, dann die Zeile ziehen — gleiche
    // Reihenfolge wie der Remote-Delete-Pfad (app-collab.js), sonst rendert der
    // Editor kurz eine Seite, die es im Tree nicht mehr gibt.
    if (this.currentPage?.id === pageId) this.resetPage();
    this._removePageFromTree(pageId);
    // Loeschen aendert die Verfuegbarkeit von Querverweis-Zielen. Der Ziel-Picker
    // cacht seine Liste je Buch; ohne dieses Signal zeigte er die geloeschte
    // Seite bis zum Buchwechsel weiter an.
    window.dispatchEvent(new CustomEvent(EVT.XREFS_CHANGED,
      { detail: { bookId: this.$store.nav.selectedBookId ?? null } }));
    return true;
  },


  // Löscht die aktuell offene Seite. Zwei Aufrufer: der Knopf im Leer-Zustand
  // des Editors (nur bei `currentPageEmpty` gerendert) und das Sidebar-Kontext-
  // menü, wenn dessen Ziel die offene Seite ist. Eigener Nachlauf gegenüber
  // `deletePageById`: der Rückfall aufs Kapitel.
  async deleteCurrentPage() {
    const page = this.currentPage;
    if (!page || !this.canEdit()) return;
    // Kapitel der gelöschten Seite merken (deletePageById nullt currentPage) —
    // danach dorthin zurückfallen statt leere Ansicht zu zeigen.
    const chapterId = page.chapter_id;
    const ok = await this.deletePageById(page.id, {
      name: page.name,
      verify: () => this.currentPage?.id === page.id,
    });
    if (!ok) return;
    // Auf das Kapitel zurückfallen (wie ein Klick auf den Kapitel-Header):
    // leeres Kapitel → Kapitel-Review-Karte (neue Seite anlegbar), sonst
    // Review/Expand. Solo-Seiten (kein chapter_id) bleiben ohne Fallback.
    if (chapterId != null) {
      const item = this._findTreeChapter(chapterId);
      if (item) await this._onChapterHeaderActivate(item);
    }
  },


  // Draft-Recovery: nach Page-Load prüfen, ob lokaler Entwurf im localStorage
  // vom Server-HTML abweicht (z. B. nach Server-Crash mid-write + Tab-Reopen).
  // Wenn ja: `pendingDraft`-Banner zeigt User Wiederaufnahme-Option an. Im
  // editMode überspringen — `startEdit` hat den Draft bereits geladen.
  _refreshPendingDraft(pageId, originalHtml) {
    if (this.editMode) { this.pendingDraft = null; return; }
    const draft = readDraft(pageId);
    if (draft && draft.html && draft.html !== originalHtml) {
      this.pendingDraft = { savedAt: draft.savedAt || Date.now() };
    } else {
      // Stale-Draft (= identisch zu Server-HTML) räumen, damit alter Eintrag
      // bei nächster Visit nicht wieder triggert.
      if (draft) { try { clearDraft(pageId); } catch {} }
      this.pendingDraft = null;
    }
  },


  // Banner-Action „Weiterbearbeiten": Edit-Mode öffnen, startEdit lädt Draft
  // automatisch und setzt `editDirty=true`.
  resumeDraft() {
    if (!this.currentPage) return;
    this.pendingDraft = null;
    this.startEdit();
  },


  // Banner-Action „Verwerfen": lokalen Entwurf löschen, Banner schliessen.
  async discardDraft() {
    if (!this.currentPage) return;
    const ok = await this.appConfirm({
      message: this.t('edit.draftRecovery.discardConfirm'),
      confirmLabel: this.t('edit.draftRecovery.discard'),
      danger: true,
    });
    if (!ok) return;
    try { clearDraft(this.currentPage.id); } catch {}
    this.pendingDraft = null;
  },


  // Setzt allen Seiten-Level-State zurück (Editor, Lektorat, Chat, History).
  resetPage() {
    // `_checkPollTimer_<pageId>` bewusst NICHT clearen: Poll der verlassenen
    // Seite muss weiterlaufen, damit `onDone` → `markPageChecked` den
    // Sidebar-Status aktualisiert (siehe lektorat.js startCheckPoll). Poll
    // räumt sich nach Job-Abschluss in job-helpers.js selbst auf.
    this.closeSynonymMenu?.();
    this.closeSynonymPicker?.();
    this.closeFigurLookup?.();
    if (this.focusActive) this.exitFocusMode();
    // Volles Edit-Session-Teardown über die SSoT im Notebook-Card (Pflicht-
    // Invariante #11): Autosave, Online-Retry, Steuerzeichen-Overlay, Counter,
    // Presence-Heartbeat, Edit-Lock, Undo-Stack, Konflikt-State. Ein
    // Teilabbau hier liesse Lock-Heartbeat und Presence-Ping der verlassenen
    // Seite weiterlaufen — andere User sähen sie dauerhaft als „in Bearbeitung".
    // `keepDraft`: der localStorage-Entwurf ist beim Seitenwechsel die einzige
    // Kopie ungespeicherter Arbeit; der pendingDraft-Banner bietet sie wieder an.
    this._teardownEditSession?.({ keepDraft: true });
    // Defensiver Rest-Reset: greift, wenn die Notebook-Card (noch) nicht
    // gemountet ist und der Teardown oben ins Leere lief.
    this._stopAutosave?.();
    this._uninstallOnlineRetry?.();
    this.resetChat();
    this.showChatCard = false;
    // Ideen-Karte schliessen — gilt für beide Scopes. Page-Scope sitzt im
    // Editor-Slot, Chapter-Scope ist an Kapitelreview gekoppelt (das via
    // `_closeOtherMainCards` ebenfalls geschlossen wird).
    this.showIdeenCard = false;
    this.ideenChapterId = null;
    this.ideenScope = 'page';
    // Referenz-Slot sitzt im selben Editor-Slot (Mutex mit Chat + Ideen) →
    // beim Verlassen der Seite ebenfalls schliessen, sonst rendert er ohne
    // Editor-Split-Container auf voller Breite.
    this.showReferenceCard = false;
    this._checkDoneBeforeChat = false;
    this.currentPage = null;
    this.pageLastEditor = null;
    this.currentPageEmpty = false;
    this.pageLoadError = false;
    this.currentPageIdeenOpenCount = 0;
    this.currentPageRechercheCount = 0;
    this.currentPageShareCommentCount = 0;
    this.currentPageShareLinkCount = 0;
    this.currentPageChatSessionCount = 0;
    this.renderedPageHtml = '';
    this.chapterFigures = [];
    this.showChapterFigures = false;
    this.originalHtml = null;
    this.correctedHtml = null;
    this.hasErrors = false;
    this.editMode = false;
    this.editDirty = false;
    this.editSaving = false;
    this.saveOffline = false;
    this.draftPersistFailed = false;
    // Konflikt-State ist seiten-gebunden: der Banner hängt nicht an editMode und
    // würde sonst mit den Daten der verlassenen Seite weiterstehen.
    this.editConflict = null;
    this.conflictResolution = null;
    this.pendingDraft = null;
    this.lastAutosaveAt = null;
    this.lastDraftSavedAt = null;
    this.showEditorCard = false;
    this.analysisOut = '';
    this.status = '';
    this.statusSpinner = false;
    this.lastCheckId = null;
    this.pageHistory = [];
    this.activeHistoryEntryId = null;
    this.lektoratFindings = [];
    this.selectedFindings = [];
    this.appliedOriginals = [];
    this.appliedHistoricCorrections = [];
    this.checkDone = false;
    this.checkLoading = false;
    this.checkProgress = 0;
    this.checkStatus = '';
  },
};
