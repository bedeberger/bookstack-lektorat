// Alpine.data('lektoratFindingsCard') — Sub-Komponente für das Findings-
// Panel (Prüf-Ergebnisse + Stilanalyse/Fazit).
//
// Bewusst wenig eigener State: lektoratFindings/selectedFindings/
// appliedOriginals/analysisOut/correctedHtml/checkDone bleiben am Root, weil
// sie mit editor-edit (Filter nach Save), history (History-Eintrag laden),
// chat-card (Chat-Proposals-Overlay) und page-view (rendering) eng gekoppelt
// sind. Die Sub bündelt nur UI-Methoden (`handleFindingPointer`,
// `_isHardFinding`) und das Partial-Scope für DOM-Isolation.

import { isHardFinding } from '../page-view.js';

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
    _isHardFinding(typ) { return isHardFinding(typ); },

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
