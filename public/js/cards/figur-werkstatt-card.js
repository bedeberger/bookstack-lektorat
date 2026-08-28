// Alpine.data('figurWerkstattCard') — Sub-Komponente der Figuren-Werkstatt-Karte.
// CRUD + jsMind-Editor + KI-Brainstorm + Konsistenz-Check.
// Root behält showFigurWerkstattCard, selectedBookId, t, appConfirm.

import { figurWerkstattMethods } from '../figur-werkstatt.js';
import { setupCardLifecycle } from './card-lifecycle.js';
import { attachFullscreenSync } from '../fullscreen.js';

export function registerFigurWerkstattCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('figurWerkstattCard', () => ({
    drafts: [],
    selectedDraftId: null,
    selectedKnotenId: null,
    creating: false,
    newName: '',
    editName: '',
    editArchetype: '',
    editNotes: '',
    loading: false,
    busy: false,
    errorMessage: '',
    // Overflow-"⋯"-Menü der Detail-Header-Leiste (Brainstorm + Konsistenz).
    werkstattMenuOpen: false,
    brainstormLoading: false,
    brainstormProgress: 0,
    brainstormStatus: '',
    brainstormResult: null,
    consistencyLoading: false,
    consistencyProgress: 0,
    consistencyStatus: '',
    consistencyResult: null,
    mindmapFullscreen: false,
    contextMenuOpen: false,
    contextMenuNodeId: null,
    contextMenuPos: { left: 0, top: 0 },
    importing: false,
    importables: [],
    importablesLoading: false,
    selectedImportFigureId: '',
    runs: { brainstorm: [], consistency: [] },
    runsLoadedDraftId: null,
    runsLoading: false,
    // Cross-Feature: Plot-Beteiligung der ausgewählten Figur ({ beatCount,
    // activeBeatCount, threads }) fürs „in N Beats geplant"-Badge → Navigation Plot.
    plotUsage: null,
    selectedRunId: null,
    selectedKonfliktIdx: null,
    _runsLoadDraftId: null,
    _mindmapDirty: false,
    _jm: null,
    _jmDraftId: null,
    _mindmapEl: null,
    _topicMarkers: null,
    _brainstormJobId: null,
    _brainstormJobDraftId: null,
    _consistencyJobId: null,
    _consistencyJobDraftId: null,
    _brainstormPollTimer: null,
    _consistencyPollTimer: null,
    _ctxOutsideHandler: null,
    _ctxEscHandler: null,
    _pendingDraftId: null,
    _pendingKnotenId: null,
    _lifecycle: null,

    init() {
      // Sub → Store spiegeln: Hash-Router liest werkstattDraftId aus
      // Alpine.store('nav'). selectedDraftId bleibt SSoT in der Sub; jede Mutation
      // (selectDraft, resetState bei book:changed/view:reset, _doDelete) wird via
      // Watcher in den Store durchgereicht.
      this.$watch('selectedDraftId', (id) => {
        if (window.Alpine) window.Alpine.store('nav').werkstattDraftId = id || null;
      });
      // Drafts-Liste in den Store spiegeln, damit die Command-Palette
      // (figuren-Provider) auch werkstatt-Drafts findet, ohne selbst zu fetchen,
      // sobald die Karte mindestens einmal geladen hat.
      this.$watch('drafts', (list) => {
        if (window.Alpine) window.Alpine.store('nav').werkstattDrafts = Array.isArray(list) ? list : [];
      });

      // Hash-Router → Sub: Permalink `#book/:b/werkstatt/:draftId` dispatcht
      // `figur-werkstatt:select`. Drafts evtl. noch nicht geladen → ID parken,
      // loadDrafts() wendet sie nach dem Fetch an.
      const onSelectDraft = (e) => {
        const id = parseInt(e.detail?.draftId);
        if (!id) return;
        const knotenId = e.detail?.knotenId || null;
        if (!this.drafts.length) {
          this._pendingDraftId = id;
          this._pendingKnotenId = knotenId;
          return;
        }
        if (!this.drafts.some(d => d.id === id)) return;
        if (this.selectedDraftId !== id) {
          this._pendingKnotenId = knotenId;
          this.selectDraft(id);
        } else if (knotenId) {
          this._selectNodeQuiet(knotenId);
        }
      };

      this._lifecycle = setupCardLifecycle(this, {
        name: 'figurWerkstatt',
        showFlag: 'showFigurWerkstattCard',
        timerKeys: ['_brainstormPollTimer', '_consistencyPollTimer'],
        // Kein resetState-Literal: der Reset dieser Karte muss die jsMind-
        // Instanz abraeumen, die Poll-Timer stoppen und ein offenes Vollbild
        // verlassen — das kann nur resetDrafts() (crud.js), und zwei Fassungen
        // desselben Resets driften. onBookChanged uebernimmt darum auch das
        // Nachladen, das der Default-Pfad sonst anhaengt.
        onBookChanged: async () => {
          this.resetDrafts();
          if (!window.__app?.showFigurWerkstattCard) return;
          if (!window.Alpine?.store('nav').selectedBookId) return;
          await this.loadDrafts();
        },
        onViewReset: () => this.resetDrafts(),
        load: () => this.loadDrafts(),
        onCardRefresh: async () => {
          if (this.isDirty()) {
            const ok = await window.__app.appConfirm({
              message: window.__app.t('werkstatt.confirmReload'),
              confirmLabel: window.__app.t('edit.discardEdit'),
              danger: true,
            });
            if (!ok) return;
          }
          this._mindmapDirty = false;
          await this.loadDrafts();
        },
        extraListeners: [{
          type: 'keydown',
          handler: (e) => {
            if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
            if ((e.key || '').toLowerCase() !== 's') return;
            if (!window.__app?.showFigurWerkstattCard) return;
            if (!this.selectedDraftId) return;
            e.preventDefault();
            this.saveDraft();
          },
        }, {
          // Browser-Reload (F5/Cmd+R) und Tab-Close: native Prompt zeigen,
          // wenn Werkstatt geöffnet ist und ungespeicherte Änderungen vorliegen.
          // Custom appConfirm geht hier nicht — Browser blockiert Modals in
          // beforeunload. Pendant zum Editor-beforeunload in app.js.
          type: 'beforeunload',
          handler: (e) => {
            if (!window.__app?.showFigurWerkstattCard) return;
            if (!this.isDirty()) return;
            e.preventDefault();
            e.returnValue = '';
          },
        }, {
          type: 'figur-werkstatt:select',
          handler: onSelectDraft,
        }],
      });

      // Native Fullscreen-API: State spiegeln, jsMind resize bei Enter/Exit.
      attachFullscreenSync({
        resolveWrap: () => document.querySelector('.werkstatt-detail'),
        signal: this._lifecycle.signal,
        onChange: (active) => {
          this.mindmapFullscreen = active;
          if (this._jm) {
            try { this._jm.resize(); } catch {}
          }
        },
      });
    },

    destroy() {
      this._destroyMindmap();
      this._lifecycle?.destroy();
    },

    ...figurWerkstattMethods,
  }));
}
