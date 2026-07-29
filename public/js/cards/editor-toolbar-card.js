// Alpine.data('editorToolbarCard') — Sub-Komponente für Bubble-Toolbar
// (Inline-Formate auf Selektion) und Slash-Menü (Block-Transforms).
//
// Eigener State: bubbleShow, bubbleX/Y, slashShow, slashX/Y/slashMaxH, slashIdx,
//   _slashBlock, _slashLabels (Label-Cache), _slashFilterCache (Filter-Memo).
// Root behält: editMode, focusActive, _markEditDirty (→ $app / window.__app).
//
// Die Sub installiert globale Listener (selectionchange, scroll) und
// delegierte keydown/input-Listener auf das contenteditable, damit der Root
// keine Toolbar-spezifischen Handler mehr benötigt.

import { toolbarCardMethods } from '../editor/notebook/toolbar.js';
import { TODO_LIST_SEL } from '../editor/shared/todo-html.js';
import { invalidateSourceCache } from '../sources/source-cache.js';
import { closestCiteEl } from '../sources/cite-html.js';
import { invalidateXrefTargetCache } from '../editor/notebook/toolbar/xref.js';
import { EVT } from '../events.js';

export function registerEditorToolbarCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('editorToolbarCard', () => ({
    bubbleShow: false,
    bubbleSingleWord: false,
    bubbleX: 0,
    bubbleY: 0,
    slashShow: false,
    slashX: 0,
    slashY: 0,
    slashMaxH: 360,
    slashIdx: 0,
    slashQuery: '',
    _slashBlock: null,
    _slashLabels: null,
    _slashFilterCache: null,
    linkShow: false,
    linkX: 0,
    linkY: 0,
    linkUrl: '',
    linkCanRemove: false,
    _linkRange: null,
    // Quellen-Picker (Quellenverzeichnis) — Inline-Insert am Caret, Aufbau wie
    // die Link-Bar. citeSources ist die Quellenliste des Buchs (gecacht im
    // Modul), citeLoc die Stellenangabe („44", „Kap. 3").
    citeShow: false,
    citeX: 0,
    citeY: 0,
    citeQuery: '',
    citeLoc: '',
    // Zitat-Art des Panels: 'quote' | 'block' | 'paraphrase' (siehe
    // editor/notebook/toolbar/cite.js). `citeBlockOk` sperrt 'block', wenn der
    // Caret nicht in einem umhuellbaren Absatz steht.
    citeKind: 'quote',
    citeBlockOk: false,
    citeIdx: 0,
    citeSources: [],
    citeHits: [],
    citeLoading: false,
    citeError: false,
    _citeRange: null,
    // Bearbeiten statt Einfügen: `_citeEditEl` ist der angeklickte Chip (null =
    // Einfügen), `citeEditing` dasselbe als reaktive Flag fürs Template
    // (Panel-Titel + „Beleg entfernen"-Button).
    citeEditing: false,
    _citeEditEl: null,
    // Querverweis-Picker (Kapitel + Abbildungen) — Aufbau wie der Beleg-Picker.
    // `xrefTargets` ist die Zielliste des Buchs (gecacht im Modul), `xrefFmt`
    // die Anzeigeform des Verweises ('label' | 'number' | 'title').
    xrefShow: false,
    xrefX: 0,
    xrefY: 0,
    xrefQuery: '',
    xrefFmt: 'label',
    xrefIdx: 0,
    xrefTargets: [],
    xrefHits: [],
    xrefLoading: false,
    xrefError: false,
    _xrefRange: null,
    _toolbarAbort: null,

    init() {
      const abort = new AbortController();
      this._toolbarAbort = abort;
      const signal = abort.signal;

      document.addEventListener('selectionchange', () => this._updateBubble(), { signal });
      // Capture-Phase, damit auch Scroll-Events in internen Containern
      // (editor-preview-wrap) mitbekommen werden.
      window.addEventListener('scroll', () => {
        if (this.bubbleShow) this._updateBubble();
        if (this.slashShow) this._updateSlashPosition();
      }, { capture: true, signal });

      // Mobile-Tastatur: sie schrumpft/verschiebt den visualViewport, ohne dass
      // ein window-scroll/resize feuert — das Slash-Menü positioniert sich aber
      // gegen dieses sichtbare Band und muss deshalb hier nachziehen.
      const vvSync = () => { if (this.slashShow) this._updateSlashPosition(); };
      window.visualViewport?.addEventListener('resize', vvSync, { signal });
      window.visualViewport?.addEventListener('scroll', vvSync, { signal });

      // Filtern ändert die Menühöhe. Da das Menü mit seiner Oberkante gesetzt
      // wird, muss es nach jedem Query-Wechsel neu gemessen werden — sonst löst
      // es sich beim Schrumpfen vom Trigger-Block.
      this.$watch('slashQuery', () => {
        if (this.slashShow) this._schedSlashPosition();
      });

      // Quellen-Picker: Trefferliste einmal pro Query neu berechnen statt bei
      // jedem Render dreimal im Template (x-for + zwei Leer-Zustände).
      this.$watch('citeQuery', () => {
        if (this.citeShow) this._recomputeCiteHits();
      });

      // Querverweis-Picker: dieselbe Begründung wie beim Beleg-Picker.
      this.$watch('xrefQuery', () => {
        if (this.xrefShow) this._recomputeXrefHits();
      });

      // Quellenliste des Quellen-Pickers ist modulweit gecacht (ein Fetch pro
      // Buch). Die Quellen-Karte dispatcht `sources:changed`, wenn sie eine
      // Quelle anlegt/ändert/löscht — sonst zeigt der Picker die alte Liste,
      // bis der User das Buch wechselt.
      window.addEventListener(EVT.SOURCES_CHANGED, (e) => {
        invalidateSourceCache(e?.detail?.bookId ?? null);
      }, { signal });
      window.addEventListener(EVT.BOOK_CHANGED, () => invalidateSourceCache(), { signal });

      // Beleg-Picker aus der Seiten-Toolbar (Root-Scope → Trampoline-Event, wie
      // der Fokus-Modus). Der Einstieg über die Bubble-Toolbar setzt eine
      // Selektion voraus; dieser hier arbeitet am blossen Caret.
      window.addEventListener(EVT.EDITOR_CITE_OPEN, () => this.openCiteInput(), { signal });

      // Zielliste des Querverweis-Pickers ebenso modulweit gecacht: Umbauten im
      // Buchorganizer und neue Abbildungen verschieben die Nummern.
      window.addEventListener(EVT.XREFS_CHANGED, (e) => {
        invalidateXrefTargetCache(e?.detail?.bookId ?? null);
      }, { signal });
      window.addEventListener(EVT.BOOK_CHANGED, () => invalidateXrefTargetCache(), { signal });

      // Delegierter Keydown-Listener auf dem contenteditable — filtert per
      // closest() auf Normal- bzw. Focus-Container, damit wir nur im Edit-
      // Bereich reagieren. Beide Container haben getrennte Klassen
      // (entkoppelt), Selektor matcht beide.
      document.addEventListener('keydown', (e) => {
        const target = e.target;
        if (!target?.closest?.('.page-content-view--editing, .focus-editor__content')) return;
        this._onEditKeydown(e);
      }, { signal });

      // Checkbox-Toggle in todo-Listen: contenteditable schluckt den nativen
      // Toggle. Attribut (nicht nur Property) setzen, damit Serialisierung
      // den State persistiert.
      document.addEventListener('click', (e) => {
        const t = e.target;
        if (!t || t.tagName !== 'INPUT' || t.type !== 'checkbox') return;
        if (!t.closest(`.page-content-view--editing ${TODO_LIST_SEL}, .focus-editor__content ${TODO_LIST_SEL}`)) return;
        if (t.hasAttribute('checked')) t.removeAttribute('checked');
        else t.setAttribute('checked', '');
        window.__app?._markEditDirty?.();
      }, { signal });

      // Klick auf einen Quellen-Chip öffnet den Beleg-Picker auf diesem Chip
      // (Quelle wechseln, Stelle korrigieren, Beleg entfernen). Chips sind
      // `contenteditable="false"`, ein Klick würde sonst gar nichts tun — es gäbe
      // keinen Weg, einen gesetzten Beleg zu korrigieren.
      //
      // Nur im Notebook-Edit-Container (`.page-content-view--editing`): Quellen-
      // Handling ist notebook-only, Focus-Editor und Bucheditor stellen Chips nur
      // dar. Der Aufruf läuft bewusst deferred — das `@click.outside` des Panels
      // hängt am selben document-Klick und würde ein direkt geöffnetes Panel
      // sofort wieder schliessen (Chip B anklicken, während Chip A offen ist).
      document.addEventListener('click', (e) => {
        const app = window.__app;
        if (!app?.editMode || app.focusActive) return;
        const editEl = e.target?.closest?.('.page-content-view--editing');
        if (!editEl) return;
        const chip = closestCiteEl(e.target, editEl);
        if (!chip) return;
        setTimeout(() => this.openCiteForChip(chip), 0);
      }, { signal });

      // <hr> ist ein void-Element ohne Caret-Slot — per Klick als
      // ".hr-selected" markieren, damit Backspace/Delete (in
      // toolbarCardMethods._onEditKeydown) es entfernen kann. Nur im
      // Notebook-Edit-Container; Klick irgendwo sonst hebt die Markierung auf.
      document.addEventListener('click', (e) => {
        const editEl = e.target?.closest?.('.page-content-view--editing');
        editEl?.querySelectorAll('hr.hr-selected').forEach((h) => {
          if (h !== e.target) h.classList.remove('hr-selected');
        });
        if (editEl && e.target.tagName === 'HR') e.target.classList.toggle('hr-selected');
      }, { signal });

      // Void-<hr> hat keinen Caret-Slot: geht eine Text-Selektion über eine <hr>
      // hinweg, rendert der Browser den Caret schräg zwischen Linie und
      // Folgeabsatz. Solange die Selektion eine <hr> berührt, denselben
      // caret-color-Guard wie beim Klick setzen (siehe page-view.css). Klasse am
      // Edit-Container; kollabierte Selektion wird nicht behandelt (dort greift
      // die hr-selected-Klick-Logik).
      document.addEventListener('selectionchange', () => {
        // Ohne Edit-Session nichts zu tun: der Handler liefe sonst bei JEDER
        // Selektionsänderung der App (Chat, Suche, Findings) mit DOM-Scan mit.
        // Die Klasse wirkt nur im `--editing`-Scope, ein Rest im Lesemodus ist
        // wirkungslos und wird beim nächsten Edit-Selektionswechsel geräumt.
        if (!window.__app?.editMode) return;
        document.querySelectorAll('.page-content-view--editing.hr-in-selection')
          .forEach((el) => el.classList.remove('hr-in-selection'));
        const sel = document.getSelection();
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
        const range = sel.getRangeAt(0);
        const anchor = range.commonAncestorContainer;
        const editEl = (anchor.nodeType === 1 ? anchor : anchor.parentElement)
          ?.closest?.('.page-content-view--editing');
        if (!editEl) return;
        const touchesHr = Array.from(editEl.querySelectorAll('hr'))
          .some((hr) => range.intersectsNode(hr));
        if (touchesHr) editEl.classList.add('hr-in-selection');
      }, { signal });
    },

    destroy() {
      this._toolbarAbort?.abort();
    },

    ...toolbarCardMethods,
  }));
}
