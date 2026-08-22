// Alpine.data('lektoratFindingsCard') — Sub-Komponente für das Findings-
// Panel (Prüf-Ergebnisse + Stilanalyse/Fazit).
//
// Bewusst wenig eigener State: lektoratFindings/selectedFindings/
// appliedOriginals/analysisOut/correctedHtml/hasErrors/checkDone leben in
// lektoratState am Root, weil sie mit editor-edit (Filter nach Save), history
// (History-Eintrag laden), chat-card (Chat-Proposals-Overlay) und page-view
// (rendering) eng gekoppelt sind. Die Sub bündelt nur UI-Methoden
// (`handleFindingPointer`, `_isHardFinding`) und das Partial-Scope für
// DOM-Isolation.

import { isHardFinding } from '../book/page-view.js';
import { lektoratEvidenceMethods, lektoratEvidenceState } from '../editor/lektorat-evidence.js';

// Split-Modus Media Query — dieselbe Schwelle wie page-view.js.
const splitMQ = typeof window !== 'undefined' ? window.matchMedia('(min-width: 1100px)') : null;

function flashEl(el) {
  el.classList.remove('hover-sync-flash');
  void el.offsetWidth; // reflow → Animation neu starten
  el.classList.add('hover-sync-flash');
}

export function registerLektoratFindingsCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('lektoratFindingsCard', () => ({
    // Inline-Edit eines Korrekturvorschlags: -1 = keine Zeile im Edit.
    // editDraft puffert den Input-Text bis Commit/Cancel.
    editingIdx: -1,
    editDraft: '',

    // Belegvorschlag (nur `unbelegt`-Befunde) — Panel-Zustand + Trefferliste.
    // Slice liegt beim Fachmodul, damit Reset und Feld-Liste eine Quelle haben.
    ...lektoratEvidenceState(),

    init() {
      // Neuer Prüflauf ersetzt das Findings-Array (neue Referenz) → offenen
      // Inline-Editor schliessen, sonst zeigt eine alte Index-Position Edit-UI.
      this.$watch(() => window.__app?.lektoratFindings, () => {
        this.editingIdx = -1;
        this.editDraft = '';
        // Gleiche Begruendung fuer den Belegvorschlag: `evidenceOpenIdx` ist eine
        // Index-Position in der ALTEN Liste und zeigte nach einem neuen Prueflauf
        // auf einen fremden Befund. `evidenceApplied` haengt dagegen am
        // Satz-Text und darf einen Prueflauf ueberleben.
        Object.assign(this, { ...lektoratEvidenceState(), evidenceApplied: this.evidenceApplied });
      });
    },

    _isHardFinding(typ) { return isHardFinding(typ); },

    ...lektoratEvidenceMethods,

    startEditKorrektur(idx) {
      const f = window.__app?.lektoratFindings?.[idx];
      if (!f) return;
      this.editDraft = f.korrektur || '';
      this.editingIdx = idx;
    },

    cancelEditKorrektur() {
      this.editingIdx = -1;
      this.editDraft = '';
    },

    // Übernimmt den Draft als f.korrektur. KI-Original wird beim ersten Edit in
    // f.korrekturKi gesnapshottet (für Reset). Anwendbarer Vorschlag → Befund
    // automatisch selektieren, damit er in Preview/Save landet. Apply-Pipeline
    // (_applyCorrections) liest f.korrektur unverändert weiter.
    commitEditKorrektur(idx) {
      const app = window.__app;
      const f = app?.lektoratFindings?.[idx];
      if (!f) return;
      const val = (this.editDraft || '').trim();
      if (f.korrekturKi === undefined) f.korrekturKi = f.korrektur || '';
      f.korrektur = val;
      f.userEdited = val !== (f.korrekturKi || '');
      if (val && val !== f.original) app.selectedFindings[idx] = true;
      this.editingIdx = -1;
      this.editDraft = '';
      app._recomputeCorrectedHtml();
    },

    resetKorrektur(idx) {
      const app = window.__app;
      const f = app?.lektoratFindings?.[idx];
      if (!f || f.korrekturKi === undefined) return;
      f.korrektur = f.korrekturKi;
      f.userEdited = false;
      app._recomputeCorrectedHtml();
    },

    // Hover auf Finding → Preview-Panel zur entsprechenden Markierung scrollen
    // (nur im Split-Modus, sonst zeigt page-view einen Tooltip).
    handleFindingPointer(idx) {
      const app = window.__app;
      if (!splitMQ?.matches || !app?.checkDone) return;
      const mark = document.querySelector(`.lektorat-split-preview .lektorat-mark[data-error-idx="${idx}"]`);
      if (mark) {
        mark.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        flashEl(mark);
      }
    },
  }));
}
