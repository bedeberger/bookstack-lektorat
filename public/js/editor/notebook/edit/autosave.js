// Teil von notebookEditMethods (siehe Facade edit.js).
//
// Timer liegen BEWUSST am Host (Root, deklariert im notebookState-Slice von
// app-state.js), nicht an der Karte: `_stopAutosave` wird auch aus Root-Kontext
// gerufen (app-view/page.js#resetPage via Trampoline) und muss dieselben Timer
// treffen. Der card-lokale `_undoTimer` (history.js) ist die Ausnahme, weil Undo
// card-only ist — daher kein Widerspruch.
//
// Die idle+max-Regel selbst liegt in editor/shared/autosave.js, geteilt mit dem
// Bucheditor: die beiden Editoren dürfen nicht mit unterschiedlichem Rhythmus
// speichern. Der Notebook-Editor bearbeitet immer nur EINE Seite, darum ein
// fester Key statt einer pageId — `_stopAutosave` läuft beim Seitenwechsel und
// kennt die alte Seite dann schon nicht mehr.
import { AUTOSAVE_KEY, DRAFT_DEBOUNCE_MS, clearDraft, createAutosaveTimers, createTimerBag, editorHost, isNoChange, stripLektoratMarks, writeDraft } from './_shared.js';

// Lazy, weil dieses Modul keinen eigenen init-Hook hat und der Host beim ersten
// Tastendruck sicher steht.
function autosaveTimers(app) {
  if (!app._autosaveTimers) app._autosaveTimers = createAutosaveTimers();
  return app._autosaveTimers;
}

function draftTimers(app) {
  if (!app._draftTimers) app._draftTimers = createTimerBag();
  return app._draftTimers;
}

export const autosaveMethods = {

  _scheduleDraftSave() {
    const app = editorHost();
    if (!app) return;
    draftTimers(app).set(AUTOSAVE_KEY, () => this._flushDraftSaveNow(), DRAFT_DEBOUNCE_MS);
  },


  // Schreibt den aktuellen Editor-Inhalt sofort als Draft – unabhängig vom
  // Debounce-Timer. Aufruf vor jedem Zustandsübergang, der den Editor-Inhalt
  // nicht mehr einfängt (Focus-Mode-Entry) oder ihn riskieren könnte zu
  // verlieren.
  _flushDraftSaveNow() {
    const app = editorHost();
    if (!app) return;
    draftTimers(app).clear(AUTOSAVE_KEY);
    if (!app.editMode || !app.currentPage) return;
    const el = this._getEditEl();
    if (!el) return;
    const html = stripLektoratMarks(el.innerHTML);
    if (isNoChange(html, app.originalHtml)) {
      clearDraft(app.currentPage.id);
      app.lastDraftSavedAt = null;
      app.draftPersistFailed = false;
      return;
    }
    const ok = writeDraft(app.currentPage.id, html, app.originalHtml, app.currentPage.updated_at);
    app.draftPersistFailed = !ok;
    if (ok) app.lastDraftSavedAt = Date.now();
  },


  _startAutosave() {
    const app = editorHost();
    if (!app) return;
    this._clearAutosaveTimers();
    if (app.editDirty) this._scheduleAutosave();
  },


  _stopAutosave() {
    const app = editorHost();
    if (!app) return;
    this._clearAutosaveTimers();
    draftTimers(app).clear(AUTOSAVE_KEY);
  },


  _clearAutosaveTimers() {
    const app = editorHost();
    if (!app) return;
    autosaveTimers(app).clear(AUTOSAVE_KEY);
  },


  // Idle-Timer wird bei jedem Edit zurückgesetzt → speichert erst nach
  // AUTOSAVE_IDLE_MS Tipp-Pause. Max-Timer läuft ab erstem Dirty-Mark
  // weiter und greift bei Dauer-Tippen, sodass spätestens AUTOSAVE_MAX_MS
  // nach der ersten Änderung ein Save ausgelöst wird.
  //
  // Auslöser wird pro Aufruf übergeben statt beim Bau des Bags eingefangen: der
  // Bag lebt am Host und überlebt ein Neu-Mounten der Karte, ein eingefangenes
  // `this` zeigte danach auf eine tote Instanz.
  _scheduleAutosave() {
    const app = editorHost();
    if (!app) return;
    autosaveTimers(app).schedule(AUTOSAVE_KEY, () => this._fireAutosave());
  },


  _fireAutosave() {
    const app = editorHost();
    if (!app) return;
    this._clearAutosaveTimers();
    if (app.editMode && app.editDirty && !app.editSaving) this.quickSave();
  },


  _installOnlineRetry() {
    const app = editorHost();
    if (!app || app._onlineHandler) return;
    // Retry-Trigger fuer einen haengengebliebenen Offline-Save. Das `online`-Event
    // allein genuegt nicht: es feuert nur bei einem echten Offline→Online-Wechsel,
    // nicht bei einem transienten Server-Blip oder einem faelschlichen
    // navigator.onLine-`false`. Tab-Refokus (visibilitychange/focus) ist der
    // zuverlaessige zweite Anlass, den Netzwerkversuch erneut zu wagen.
    const retry = () => {
      if (app.editMode && app.editDirty && app.saveOffline && !app.editSaving) {
        this.quickSave();
      }
    };
    app._onlineHandler = retry;
    app._onlineVisHandler = () => { if (document.visibilityState === 'visible') retry(); };
    window.addEventListener('online', app._onlineHandler);
    window.addEventListener('focus', app._onlineHandler);
    document.addEventListener('visibilitychange', app._onlineVisHandler);
  },


  _uninstallOnlineRetry() {
    const app = editorHost();
    if (!app || !app._onlineHandler) return;
    window.removeEventListener('online', app._onlineHandler);
    window.removeEventListener('focus', app._onlineHandler);
    if (app._onlineVisHandler) {
      document.removeEventListener('visibilitychange', app._onlineVisHandler);
      app._onlineVisHandler = null;
    }
    app._onlineHandler = null;
  },
};
