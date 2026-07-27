// Sub-Komponenten-Methoden für Alpine.data('editorFocusCard').
//
// State-Machine: idle → entering → active → exiting → idle.
// Re-Entry während entering/exiting wird hart geblockt; ein Generation-Zähler
// (_focusGen) invalidiert asynchrone Nachzügler (RAFs, die nach einem schnellen
// exit noch feuern wollen).
//
// Hier wohnt nur der Lifecycle. Das Listener-/Observer-Setup liegt in
// listeners.js, die Recenter-Schritte (Block-Auflösung, Markierung, Typewriter)
// in recenter.js.
//
// `this` zeigt auf Alpine.data('editorFocusCard'). Root-Zugriff läuft
// ausschliesslich über `editorHost()` (../shared/editor-host.js) — in der SPA
// der reaktive `window.__app`-Proxy, in einer fremden Schale ein injizierter Host.

import { reportError } from './constants.js';
import {
  removeAutoAddedParagraph, jumpToTrailingParagraph, getScrollContainer,
} from './dom-blocks.js';
import { clearSentenceHighlight } from './sentence.js';
import { publishAnchorRatio, clearAnchorRatio } from './typewriter.js';
import {
  resolveActiveBlock, applyBlockMarks, syncSentenceMarks, repairBlockMarks,
  runTypewriter, scrollEntryTargetToAnchor,
} from './recenter.js';
import { installFocusListeners } from './listeners.js';
import { writeFocusSnapshot, clearFocusSnapshot } from './storage.js';
import { editorHost } from '../shared/editor-host.js';
import { installEditCounter } from '../shared/edit-counter.js';

const GRANULARITY_CLASSES = [
  'focus-mode--paragraph', 'focus-mode--sentence',
  'focus-mode--window-3', 'focus-mode--typewriter-only',
];

// Overlay-Chrome an: body-Klasse, Host-Karte, Granularitäts-Klasse und der
// Anker als CSS-Variable (Kopf-/Tail-Puffer leiten sich daraus ab — deshalb VOR
// dem ersten Render des Focus-Containers).
//
// `is-active` wird synchron gesetzt, damit `getActiveEditorContainer` im
// folgenden $nextTick den Focus-Container findet: Alpine's
// `:class="{'is-active': focusActive}"` flushed erst danach und liesse das
// Listener-Setup sonst auf den Normal-Container greifen (alle Listener am
// falschen Element → Typewriter/Highlight/Counter/Cursor-Hide tot).
function markFocusChrome(granularity, anchorRatio) {
  document.body.classList.add('focus-mode');
  document.getElementById('editor-card')?.classList.add('focus-host');
  publishAnchorRatio(anchorRatio);
  const el = document.querySelector('.focus-editor');
  if (!el) return;
  el.classList.remove(...GRANULARITY_CLASSES);
  el.classList.add('focus-mode--' + (granularity || 'paragraph'));
  el.classList.add('is-active');
}

function unmarkFocusChrome() {
  document.body.classList.remove('focus-mode');
  document.getElementById('editor-card')?.classList.remove('focus-host');
  document.querySelector('.focus-editor')?.classList.remove(
    'is-active', 'focus-cursor-hidden', ...GRANULARITY_CLASSES);
  clearAnchorRatio();
  document.documentElement.style.removeProperty('--focus-vh');
  document.documentElement.style.removeProperty('--focus-vh-top');
}

export const focusCardMethods = {
  // Page-View-Direkteinstieg: Edit-Mode hochfahren (falls nicht bereits aktiv)
  // und dann in Fokus eintreten. Quelle: Focus-Button im Page-View-Header und
  // Hotkey Cmd/Ctrl+Shift+E aus dem Lesemodus.
  enterFocusFromPageview() {
    const app = editorHost();
    if (!app) return;
    if (!app.editMode) {
      app.startEdit?.();
      if (!app.editMode) return;
    }
    this.$nextTick(() => this.enterFocusMode());
  },

  enterFocusMode() {
    const app = editorHost();
    if (!app) return;
    if (this._focusState !== 'idle') return;
    if (!app.showEditorCard || !app.editMode) return;

    // Übergang edit-mode → focus-mode: offenen Debounce-Draft jetzt flushen,
    // damit bei Offline-Sessions kein getippter Inhalt verloren geht, falls
    // der User später im Focus-Mode abbricht oder Crashs auftreten.
    app._flushDraftSaveNow?.();

    this._focusState = 'entering';
    const gen = ++this._focusGen;

    app.focusActive = true;
    markFocusChrome(app.focusGranularity, app.typewriterAnchor);

    this.$nextTick(() => {
      // Wenn in der Zwischenzeit jemand exit() gerufen oder schneller
      // re-entered hat → abbrechen.
      if (gen !== this._focusGen || this._focusState !== 'entering') return;
      try {
        // DOM-Roundtrip Normal → Focus: Inhalt aus dem Normal-Container in
        // den Focus-Container klonen (kein innerHTML — XSS-Trust kommt vom
        // eigenen contenteditable; cloneNode bleibt strukturidentisch ohne
        // Re-Parsing). Container-Klassen sind entkoppelt: Normal-Editor nutzt
        // `.page-content-view--editing`, Focus-Editor `.focus-editor__content`.
        const normalC = document.querySelector('#editor-card .page-content-view--editing');
        const focusC = document.querySelector('.focus-editor .focus-editor__content');
        if (normalC && focusC && focusC !== normalC) {
          const clones = Array.from(normalC.childNodes).map(n => n.cloneNode(true));
          focusC.replaceChildren(...clones);
        }
        // Live-Counter ist Container-gebunden — beim Mode-Wechsel teardown
        // und am neuen aktiven Container (Smart-Switch via shared/active-
        // editor.js) neu installieren. Andernfalls misst der Counter den
        // alten (jetzt versteckten) Normal-Container.
        app._editCounterCtx?.teardown?.();
        installEditCounter(app);

        this._focusInstall();
        this._focusState = 'active';
        this._focusUpdateActive(true);
        writeFocusSnapshot(app.currentPage?.id);
      } catch (err) {
        reportError('enterFocusMode', err);
        this._focusTeardown();
        clearFocusSnapshot();
        app.focusActive = false;
        unmarkFocusChrome();
        this._focusState = 'idle';
      }
    });
  },

  _focusInstall() {
    const container = getScrollContainer();
    if (!container) throw new Error('focus: no scroll container');

    // Der Fokusmodus ist ein fixed Overlay; ein mitgeschleppter Dokument-Scroll
    // würde darunter stehenbleiben und beim Exit sichtbar.
    window.scrollTo(0, 0);

    const ctx = installFocusListeners({ ctrl: this, container });
    this._focusListeners = ctx;
    this._focusVisibleBlocks = ctx.visibleBlocks;

    // container ist via shared/active-editor.js: bei aktiver Focus-Karte der
    // Focus-Cardroot, sonst der Normal-Editor-Container.
    container?.focus?.({ preventScroll: true });
    this._focusAutoAddedP = jumpToTrailingParagraph(container);
    // Schreib-Slot auf den Anker holen — dieselbe Geometrie wie der Typewriter
    // danach (siehe scrollEntryTargetToAnchor). `lastElementChild` ist in beiden
    // Fällen der Slot: jumpToTrailingParagraph recycelt den letzten leeren <p>
    // oder hängt einen neuen an.
    scrollEntryTargetToAnchor(container, container.lastElementChild, ctx);
  },

  _focusTeardown() {
    const ctx = this._focusListeners;
    if (ctx) {
      ctx.abort?.abort();
      ctx.io?.disconnect();
      ctx.mo?.disconnect();
      clearTimeout(ctx.pointerTimer);
      clearTimeout(ctx.vvTimer);
      clearTimeout(ctx.cursorTimer);
      this._focusListeners = null;
    }
    this._focusVisibleBlocks = null;
    if (this._focusRaf) { cancelAnimationFrame(this._focusRaf); this._focusRaf = null; }
  },

  async exitFocusMode() {
    const app = editorHost();
    if (!app) return;
    if (this._focusState !== 'active') return;
    this._focusState = 'exiting';
    const gen = ++this._focusGen;

    // Auto-Slot vom Focus-Entry abräumen, falls User nichts reingeschrieben
    // hat. Sonst würde der leere `<p>` als „Änderung" gespeichert und bei jedem
    // Focus-Open eine Phantom-Revision erzeugen.
    removeAutoAddedParagraph(this._focusAutoAddedP);
    this._focusAutoAddedP = null;

    // Immer speichern beim Verlassen. UI bleibt optisch bis Save durch,
    // Event-Handler sind via _focusState='exiting' bereits stumm-geschaltet.
    // Bei Offline/Fehler bleibt editDirty true + Draft im LocalStorage →
    // User bleibt im Edit-Modus und kann manuell retten.
    if (app.editMode && app.editDirty && !app.editSaving) {
      try { await app.quickSave?.(); }
      catch (e) { reportError('exitFocusMode:save', e); }
    }
    // Race: jemand hat während await enter() gerufen → abbrechen.
    if (gen !== this._focusGen) return;

    this._focusTeardown();
    clearFocusSnapshot();

    // DOM-Roundtrip Focus → Normal: aktuellen Focus-Inhalt zurück in den
    // Normal-Container klonen, bevor focusActive=false greift und Alpine den
    // Focus-Cardroot via x-show ausblendet. Smart-Switch springt mit
    // `focusActive=false` automatisch zurück auf den Normal-Container.
    const focusC = document.querySelector('.focus-editor.is-active .focus-editor__content');
    const normalC = document.querySelector('#editor-card .page-editor-wrap .page-content-view--editing');
    if (focusC && normalC && focusC !== normalC) {
      const clones = Array.from(focusC.childNodes).map(n => n.cloneNode(true));
      normalC.replaceChildren(...clones);
    }
    // Counter wechselt zurück auf den Normal-Container.
    app._editCounterCtx?.teardown?.();

    app.focusActive = false;
    unmarkFocusChrome();

    // Restklassen defensiv abräumen (document-weit, nicht container-scoped: der
    // Focus-Container ist zu diesem Zeitpunkt schon ausgeblendet, die Klassen
    // können auch im Normal-Container-Klon stecken).
    document.querySelectorAll('.focus-paragraph-active, .focus-paragraph-near')
      .forEach(el => {
        el.classList.remove('focus-paragraph-active');
        el.classList.remove('focus-paragraph-near');
        if (el.classList.length === 0) el.removeAttribute('class');
      });
    clearSentenceHighlight();

    // Nichts Ungespeichertes → zurück in die Ansicht (Save im Fokus impliziert
    // Ende der Edit-Session; unsaubere Exits behalten den Edit-Modus).
    if (app.editMode && !app.editDirty) {
      app._stopAutosave?.();
      app._uninstallOnlineRetry?.();
      app._editCounterCtx?.teardown?.();
      app.editMode = false;
      app.editSaving = false;
      app.saveOffline = false;
      app.lastDraftSavedAt = null;
      app.closeSynonymMenu?.();
      app.closeSynonymPicker?.();
      app.closeFigurLookup?.();
    } else if (app.editMode) {
      // Unsauberer Exit (Save fehlgeschlagen, editDirty bleibt) — User landet
      // wieder im Normal-Editor. Counter neu am Normal-Container installieren,
      // damit Live-Anzeige + Tagesdelta weiterzählen.
      installEditCounter(app);
    }

    // View-Mode + Kennzahlen (Wörter/Zeichen/Token) immer auffrischen, egal
    // ob Save erfolgte, no-op war oder fehlschlug. Garantie: beim Verlassen
    // des Fokusmodus reflektieren View-Mode-HTML und tokEsts-Badges den
    // aktuellen originalHtml. Idempotent zu den Save-Pfaden, die diese
    // Calls ohnehin bereits feuern.
    if (app.currentPage && app.originalHtml != null) {
      app._syncPageStatsAfterSave?.(app.currentPage, app.originalHtml);
    }
    app.updatePageView?.();

    this._focusState = 'idle';
  },

  // Ein Recenter-Tick, gecancelt-gerafft: Burst-Inputs (Paste, Auto-Korrektur,
  // IME) kollabieren auf einen Frame.
  //
  // `opts.preferCenter` — User-Scroll: aktiver Block kommt aus der Viewport-Mitte
  // statt vom Caret. `opts.imeSafe` — Composition läuft: das DOM wird im
  // Normalfall NICHT angefasst (weder Block-Klassen noch Satz-Highlight), weil
  // beides das Kandidatenfenster versetzen bzw. die Eingabe abbrechen würde.
  // Einzige Ausnahme ist der Repair-Pfad: ist die Markierung nachweislich kaputt
  // (der markierte Block wurde weggelöscht/gemerged), wird sie wiederhergestellt
  // — Attribut-Toggle statt Struktur-Eingriff, und der Alternativzustand wäre ein
  // komplett gedimmter Text bis zum `compositionend` (Gboard hält die Composition
  // über ganze Wörter/Sätze offen). Der Typewriter läuft als Notnagel weiter
  // (siehe runTypewriter). `opts.force` — Recompute des Satz-Highlights
  // erzwingen, auch wenn der Block gleich blieb (`compositionend`).
  _focusUpdateActive(scroll, opts = {}) {
    if (this._focusState !== 'active') return;
    if (this._focusRaf) cancelAnimationFrame(this._focusRaf);
    const preferCenter = opts.preferCenter === true;
    const imeSafe = opts.imeSafe === true;
    const force = opts.force === true;
    const gen = this._focusGen;
    this._focusRaf = requestAnimationFrame(() => {
      this._focusRaf = null;
      // try/catch um den gesamten RAF-Body: ein DOM-Edge-Case (Selection über
      // Shadow-Root, obskurer Range-Fehler) darf den Editor nicht stillstellen.
      // Fehler → loggen, nächster Event-Tick versucht neu (Invariante 8).
      try {
        if (gen !== this._focusGen || this._focusState !== 'active') return;
        const ctx = this._focusListeners;
        const container = ctx?.container;
        if (!container) return;

        const sel = document.getSelection();
        const granularity = editorHost()?.focusGranularity || 'paragraph';
        const block = resolveActiveBlock({
          container, sel, granularity, preferCenter,
          visibleBlocks: ctx.visibleBlocks,
          lastBlock: ctx._lastBlock,
        });

        if (imeSafe) {
          if (repairBlockMarks(container, block, granularity)) {
            syncSentenceMarks({ block, sel, granularity, recompute: true });
            ctx._lastBlock = block;
            ctx._lastGranularity = granularity;
          }
        } else {
          const recompute = force
            || block !== ctx._lastBlock
            || granularity !== ctx._lastGranularity
            || granularity === 'sentence';
          applyBlockMarks(container, block, granularity);
          syncSentenceMarks({ block, sel, granularity, recompute });
          ctx._lastBlock = block;
          ctx._lastGranularity = granularity;
        }

        // Aktive Textmarkierung: nicht recentern, sonst springt der Viewport
        // während der User die Auswahl aufzieht oder an ihr arbeitet.
        const hasSelection = sel && sel.rangeCount > 0 && !sel.isCollapsed;
        if (scroll && !hasSelection) runTypewriter({ container, block, ctx, imeSafe });
      } catch (err) {
        reportError('updateActive', err);
      }
    });
  },
};
