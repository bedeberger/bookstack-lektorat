// Standalone-Bootstrap für den Focus-Editor — der Einstiegspunkt, den eine
// fremde Schale (nativer Mac-Focus-Writer in einer WKWebView, ohne Alpine/SPA)
// lädt. Mountet die Focus-Engine auf ein einzelnes contenteditable und treibt
// Laden/Speichern über eine injizierte `bridge` statt über die SPA-Root.
//
// Wiederverwendung statt Fork: die visuelle Engine (_focusInstall /
// _focusUpdateActive / _focusTeardown + enterFocusMode-Setup) kommt unverändert
// aus focus/card.js (focusCardMethods). Der einzige Unterschied zur SPA ist der
// Host (hier bridge-gestützt statt window.__app) und die Escape-Semantik:
// standalone gibt es keinen Lese-Modus zum „Zurückfallen", Escape speichert nur.
//
// Bridge-Vertrag (von der Schale/Stub bereitzustellen):
//   loadPage(): Promise<{ id, name, html }>     — aktuelle Seite + Body
//   savePage({ id, name, html }): Promise<any>  — lokal persistieren + Sync-Queue
//   granularity?: string                        — initiale Fokus-Granularität
//   typewriterAnchor?: number                   — vertikaler Typewriter-Anker
//                                                 0–1 (0.5 Mitte, 0.33 oberes Drittel)
//   locale?: string                             — Sprache des Textes ('de'/'en'),
//                                                 speist die Satz-Segmentierung
//
// Der Bridge-Host erfüllt denselben Vertrag wie window.__app (siehe
// shared/editor-host.js): die Engine merkt keinen Unterschied.

import { focusCardMethods } from './card.js';
import { normGranularity } from './chrome.js';
import { setEditorHost } from '../shared/editor-host.js';
import { isNoChange } from '../shared/save-pipeline.js';
import { stripLektoratMarks } from '../shared/html-clean.js';
import { handleEditorPastePlain, handleEditorCopy, handleEditorCut } from '../shared/paste.js';

const DEFAULT_AUTOSAVE_MS = 1500;

// Baut die DOM-Schicht, die die Engine erwartet: ein `.focus-editor` mit
// `.focus-editor__content[contenteditable]`. Idempotent — vorhandene Struktur
// wird wiederverwendet.
function ensureScaffold(mount) {
  let focusEl = mount.querySelector('.focus-editor');
  if (!focusEl) {
    focusEl = document.createElement('div');
    focusEl.className = 'focus-editor';
    const content = document.createElement('div');
    content.className = 'focus-editor__content';
    content.setAttribute('contenteditable', 'true');
    focusEl.appendChild(content);
    mount.appendChild(focusEl);
  }
  return focusEl.querySelector('.focus-editor__content');
}

// Bridge-gestützter Host. Erfüllt den editor-host-Vertrag; alles, was der
// Standalone-Modus nicht kennt (Synonyme, Figur-Lookup, Online-Retry,
// Normal-Editor-Roundtrip), ist no-op.
function makeHost(bridge, scheduleSave) {
  return {
    // Lesefelder
    editMode: true,
    showEditorCard: true,
    focusActive: false,        // enterFocusMode setzt true
    editDirty: false,
    editSaving: false,
    focusGranularity: normGranularity(bridge.granularity),
    // Vertikaler Typewriter-Anker (0–1). Roh durchgereicht — typewriter.js
    // normalisiert ungültige/fehlende Werte auf 0.5 (Mitte).
    typewriterAnchor: bridge.typewriterAnchor,
    // Roh durchgereicht — sentence.js fällt ohne Wert auf DEFAULT_LOCALE zurück.
    contentLocale: bridge.locale,
    currentPage: null,
    renderedPageHtml: null,
    originalHtml: null,
    _figurLookupOpen: false,
    _synonymMenuOpen: false,
    _synonymPickerOpen: false,
    _editCounterCtx: null,
    // Counter-Anzeigefelder (von installEditCounter befüllt; UI optional)
    focusCountChars: 0,
    focusCountWords: 0,
    focusCountWordsDelta: '',
    focusCountCharsDelta: '',
    // Schreibmarkierung → debounced Save über die Bridge.
    _markEditDirty() { this.editDirty = true; scheduleSave(); },
    async quickSave() {
      if (!this.currentPage) return;
      const content = document.querySelector('.focus-editor.is-active .focus-editor__content');
      // stripLektoratMarks wie im Notebook-Editor (saveEdit): transiente
      // Fokus-Markup (`focus-paragraph-active`, leerer Auto-Trailing-<p>) raus,
      // bevor verglichen + persistiert wird.
      const html = content ? stripLektoratMarks(content.innerHTML) : this.originalHtml;
      // Inhaltsgleich → kein PUT. quickSave feuert auch bei Escape/Seitenwechsel/
      // destroy, nicht nur beim Tippen; die Fokus-Engine normalisiert das DOM
      // beim Mount (Block-Wrap, Schluss-<p>), sodass roher innerHTML nie
      // byte-gleich zum geladenen Stand ist. Ohne diesen Gate bumpt jeder
      // Öffnen/Wechsel updated_at unnötig. isNoChange bringt beide Seiten via
      // normalizeForCompare auf dieselbe Normalform.
      if (isNoChange(html, this.originalHtml)) { this.editDirty = false; return; }
      this.editSaving = true;
      try {
        await bridge.savePage({ id: this.currentPage.id, name: this.currentPage.name, html });
        this.originalHtml = html;
        this.editDirty = false;
      } finally {
        this.editSaving = false;
      }
    },
    // cancelEdit (Verwerfen) existiert standalone nicht: es gibt keinen
    // Lese-Modus zum Zurückfallen. Escape läuft über exitFocusMode, das der
    // Controller unten überschreibt (speichern, im Editor bleiben).
    startEdit() {},
    _flushDraftSaveNow() {},
    _stopAutosave() {},
    _uninstallOnlineRetry() {},
    closeSynonymMenu() {},
    closeSynonymPicker() {},
    closeFigurLookup() {},
    _syncPageStatsAfterSave() {},
    updatePageView() {},
  };
}

// Mountet den Standalone-Focus-Editor. Liefert ein Handle:
//   { host, controller, save(), destroy() }
export async function mountStandaloneFocus({ mount, bridge, autosaveMs = DEFAULT_AUTOSAVE_MS }) {
  if (!mount) throw new Error('mountStandaloneFocus: mount element required');
  if (!bridge || typeof bridge.loadPage !== 'function' || typeof bridge.savePage !== 'function') {
    throw new Error('mountStandaloneFocus: bridge mit loadPage/savePage erforderlich');
  }

  const content = ensureScaffold(mount);

  let saveTimer = 0;
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { host.quickSave().catch(() => {}); }, autosaveMs);
  };

  const host = makeHost(bridge, scheduleSave);
  setEditorHost(host);

  // Seite laden + Body rendern. Local-Store-Inhalt ist eigenes, server-seitig
  // bereits sanitisiertes Buch-HTML → innerHTML ist hier der natürliche Render-
  // Pfad (kein fremder Input).
  const page = await bridge.loadPage();
  content.innerHTML = (page && page.html) || '<p><br></p>';
  host.currentPage = page ? { id: page.id, name: page.name } : null;
  host.renderedPageHtml = content.innerHTML;
  host.originalHtml = content.innerHTML;

  // Controller = Engine-Methoden (wie die SPA-Karte / Test-Harness) + Sub-State.
  // exitFocusMode standalone-überschrieben: kein Lese-Modus → Escape speichert.
  const controller = {
    ...focusCardMethods,
    _focusState: 'idle',
    _focusGen: 0,
    _focusListeners: null,
    _focusRaf: null,
    _focusAutoAddedP: null,
    $nextTick: (fn) => Promise.resolve().then(fn),
    async exitFocusMode() {
      try { await host.quickSave(); } catch (_) {}
    },
  };

  // Eingaben markieren dirty (Engine ruft _markEditDirty nur bei Inline-Format).
  content.addEventListener('input', () => host._markEditDirty());

  // Einfügen immer als reiner Text — Formatierung aus der Zwischenablage wird
  // im ablenkungsfreien Focus-Editor grundsätzlich verworfen.
  content.addEventListener('paste', (e) => {
    if (handleEditorPastePlain(e)) host._markEditDirty();
  });
  // Kopieren/Ausschneiden schreiben analog nur text/plain ins Clipboard.
  content.addEventListener('copy', (e) => { handleEditorCopy(e); });
  content.addEventListener('cut', (e) => { if (handleEditorCut(e)) host._markEditDirty(); });

  controller.enterFocusMode();

  return {
    host,
    controller,
    // Inhalt OHNE Speichern austauschen — für fremde Schalen, die die Seite
    // wechseln (nativer Picker) oder einen frischeren Server-Stand still
    // einspielen (Sync-Pull der sauberen offenen Seite). Bewusst KEIN Save:
    // der neue Stand IST bereits die Quelle der Wahrheit; ein Save würde ihn
    // mit dem alten Inhalt überschreiben. Fokus-Engine wird neu aufgesetzt.
    setPage(next) {
      clearTimeout(saveTimer);
      controller._focusTeardown();
      controller._focusState = 'idle';
      content.innerHTML = (next && next.html) || '<p><br></p>';
      host.currentPage = next ? { id: next.id, name: next.name } : null;
      host.renderedPageHtml = content.innerHTML;
      host.originalHtml = content.innerHTML;
      host.editDirty = false;
      controller.enterFocusMode();
    },
    // Fokus-Granularität live umschalten — für fremde Schalen (nativer
    // macOS-Client), die die Stufe zur Laufzeit ändern. Spiegelt das
    // $watch-Verhalten der SPA-Karte: Host-Feld setzen, die `focus-mode--`-
    // Klasse tauschen (wie enterFocusMode sie initial setzt) und das
    // Fokus-Overlay neu rechnen. Kapselt den internen `_focusUpdateActive`-
    // Aufruf, damit die Schale nicht auf Engine-Interna zugreifen muss.
    setGranularity(g) {
      const gran = normGranularity(g);
      host.focusGranularity = gran;
      try { controller.applyFocusGranularity(gran, mount); } catch (_) {}
    },
    // Sofort speichern (z.B. vor Fenster-Schliessen / Seitenwechsel).
    async save() {
      clearTimeout(saveTimer);
      await host.quickSave();
    },
    // Sauberes Herunterfahren: speichern, Engine-Listener abräumen, Host lösen.
    async destroy() {
      clearTimeout(saveTimer);
      try { await host.quickSave(); } catch (_) {}
      controller._focusTeardown();
      controller._focusState = 'idle';
      setEditorHost(null);
    },
  };
}
