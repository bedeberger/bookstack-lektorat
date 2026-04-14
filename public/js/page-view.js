// Seitenansicht-Methoden: Formatierte HTML-Ansicht mit Inline-Fehlermarkierung
// und Figurenkontext-Panel. `this` bezieht sich auf die Alpine-Komponente.

import { escHtml } from './utils.js';

const TYP_LABELS = { rechtschreibung:'Rechtschreibung', grammatik:'Grammatik', wiederholung:'Wdh.', schwaches_verb:'schw. Verb', fuellwort:'Füllwort', show_vs_tell:'Show/Tell', passiv:'Passiv', perspektivbruch:'Perspektive', tempuswechsel:'Tempus', stil:'Stil' };

/**
 * Baut eine HTML-Version mit <mark>-Tags um Fehlerstellen.
 * Iteriert von hinten nach vorne, damit Offsets stabil bleiben.
 */
export function buildHighlightedHtml(html, errors, selected) {
  if (!html || !errors?.length) return html || '';

  const positions = [];
  for (let i = 0; i < errors.length; i++) {
    const f = errors[i];
    if (!f.original) continue;
    const idx = html.indexOf(f.original);
    if (idx !== -1) {
      positions.push({ idx, len: f.original.length, errIdx: i });
    }
  }

  positions.sort((a, b) => b.idx - a.idx);

  const seen = new Set();
  const unique = positions.filter(p => {
    for (const s of seen) {
      if (p.idx < s.end && p.idx + p.len > s.start) return false;
    }
    seen.add({ start: p.idx, end: p.idx + p.len });
    return true;
  });

  let result = html;
  for (const p of unique) {
    const sel = selected[p.errIdx] ? ' lektorat-mark--selected' : '';
    const originalText = result.slice(p.idx, p.idx + p.len);
    const markOpen = `<mark class="lektorat-mark${sel}" data-error-idx="${p.errIdx}">`;
    result = result.slice(0, p.idx) + markOpen + originalText + '</mark>' + result.slice(p.idx + p.len);
  }

  return result;
}

// ── Singleton-Tooltip ──────────────────────────────────────────────────────

let tipEl = null;
let activeMark = null;

function ensureTipEl() {
  if (tipEl) return tipEl;
  tipEl = document.createElement('div');
  tipEl.className = 'lektorat-tip';
  document.body.appendChild(tipEl);
  // Tooltip bleibt offen wenn die Maus drauf wandert
  tipEl.addEventListener('mouseleave', () => hideTip());
  return tipEl;
}

function showTip(mark, errors) {
  const idx = parseInt(mark.dataset.errorIdx);
  if (isNaN(idx)) return;
  const allErrors = errors;
  if (!allErrors[idx]) return;
  const f = allErrors[idx];

  activeMark = mark;
  const tip = ensureTipEl();

  const typLabel = TYP_LABELS[f.typ] || f.typ;
  const isHard = { rechtschreibung:1, grammatik:1, tempuswechsel:1 }[f.typ];
  const badgeCls = isHard ? 'badge-err' : 'badge-warn';
  tip.innerHTML =
    `<span class="badge ${badgeCls}">${escHtml(typLabel)}</span>`
    + `<span class="lektorat-tip-korrektur">${escHtml(f.korrektur)}</span>`
    + (f.erklaerung ? `<span class="lektorat-tip-erkl">${escHtml(f.erklaerung)}</span>` : '');

  // Positionierung: erst messen, dann platzieren
  tip.style.left = '-9999px';
  tip.style.top = '0';
  tip.classList.add('lektorat-tip--visible');

  const tipRect = tip.getBoundingClientRect();
  const markRect = mark.getBoundingClientRect();
  const GAP = 6;

  let left = markRect.left + markRect.width / 2 - tipRect.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));

  let top;
  if (markRect.top - tipRect.height - GAP >= 4) {
    top = markRect.top - tipRect.height - GAP;
  } else {
    top = markRect.bottom + GAP;
  }

  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}

function hideTip() {
  if (tipEl) tipEl.classList.remove('lektorat-tip--visible');
  activeMark = null;
}

// ── Exportierte Methoden ───────────────────────────────────────────────────

export const pageViewMethods = {
  // State-Defaults (in app.js eingebunden)
  // renderedPageHtml: '',
  // chapterFigures: [],
  // showChapterFigures: false,

  /** Aktualisiert die gerenderte Seitenansicht (mit oder ohne Highlights) */
  updatePageView() {
    if (!this.originalHtml) {
      this.renderedPageHtml = '';
      return;
    }
    const allErrors = [...(this.lektoratErrors || []), ...(this.lektoratStyles || [])];
    const allSelected = [...(this.selectedErrors || []), ...(this.selectedStyles || [])];
    if (allErrors.length > 0) {
      this.renderedPageHtml = buildHighlightedHtml(this.originalHtml, allErrors, allSelected);
    } else {
      this.renderedPageHtml = this.originalHtml;
    }
  },

  /** Lädt Figurenkontext für das aktuelle Kapitel */
  async loadChapterFigures() {
    if (!this.currentPage?.chapter_id || !this.selectedBookId) {
      this.chapterFigures = [];
      return;
    }
    try {
      const data = await fetch(`/figures/chapter/${this.selectedBookId}/${this.currentPage.chapter_id}`).then(r => r.json());
      this.chapterFigures = data?.figuren || [];
    } catch (e) {
      console.error('[loadChapterFigures]', e);
      this.chapterFigures = [];
    }
  },

  /** Click-Handler für Inline-Marks → scrollt zur Fehlerliste */
  handleMarkClick(e) {
    const mark = e.target.closest('.lektorat-mark');
    if (!mark) return;
    const idx = parseInt(mark.dataset.errorIdx);
    if (isNaN(idx)) return;

    const checkboxes = document.querySelectorAll('#editor-card .finding-checkbox');
    if (checkboxes[idx]) {
      checkboxes[idx].closest('.finding')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const finding = checkboxes[idx].closest('.finding');
      if (finding) {
        finding.classList.add('finding--flash');
        setTimeout(() => finding.classList.remove('finding--flash'), 1500);
      }
    }
  },

  /** Pointer-Handler auf page-content-view: Tooltip zeigen/verstecken */
  handleMarkPointer(e) {
    const mark = e.target.closest('.lektorat-mark');
    if (mark === activeMark) return; // gleiche Mark, nichts tun
    if (!mark) { hideTip(); return; }
    const allErrors = [...(this.lektoratErrors || []), ...(this.lektoratStyles || [])];
    showTip(mark, allErrors);
  },

  handleMarkPointerLeave(e) {
    // Nicht schliessen wenn die Maus in den Tooltip wandert
    const related = e.relatedTarget;
    if (related && tipEl?.contains(related)) return;
    hideTip();
  },
};
