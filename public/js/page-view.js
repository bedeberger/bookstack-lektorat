// Seitenansicht-Methoden: Formatierte HTML-Ansicht mit Inline-Fehlermarkierung
// und Figurenkontext-Panel. `this` bezieht sich auf die Alpine-Komponente.

import { escHtml, htmlToText } from './utils.js';
import { tRaw } from './i18n.js';

// Weiche Typen: standardmässig nicht vorausgewählt (User entscheidet pro Finding)
export const SOFT_TYPEN = new Set(['wiederholung', 'schwaches_verb', 'fuellwort', 'show_vs_tell', 'passiv', 'perspektivbruch', 'tempuswechsel']);

/** Sortiert Fehler nach Position im HTML. Nicht gefundene ans Ende. */
export function sortByPosition(html, fehler) {
  return [...fehler].sort((a, b) => {
    const posA = a.original ? html.indexOf(a.original) : -1;
    const posB = b.original ? html.indexOf(b.original) : -1;
    if (posA === -1 && posB === -1) return 0;
    if (posA === -1) return 1;
    if (posB === -1) return -1;
    return posA - posB;
  });
}

/**
 * Baut eine HTML-Version mit <mark>-Tags um Fehlerstellen und optional
 * Chat-Änderungsvorschläge. Iteriert von hinten nach vorne, damit Offsets
 * stabil bleiben. Bei Überschneidung gewinnt die höhere Position; Lektorat
 * und Chat teilen sich denselben Overlap-Filter.
 */
export function buildHighlightedHtml(html, errors, selected, chatProposals = []) {
  if (!html || (!errors?.length && !chatProposals.length)) return html || '';

  const positions = [];
  for (let i = 0; i < (errors?.length || 0); i++) {
    const f = errors[i];
    if (!f.original) continue;
    const idx = html.indexOf(f.original);
    if (idx !== -1) {
      positions.push({ idx, len: f.original.length, kind: 'lektorat', errIdx: i });
    }
  }
  for (let i = 0; i < chatProposals.length; i++) {
    const p = chatProposals[i];
    if (!p.original) continue;
    const idx = html.indexOf(p.original);
    if (idx !== -1) {
      positions.push({ idx, len: p.original.length, kind: 'chat', propIdx: i });
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
    const originalText = result.slice(p.idx, p.idx + p.len);
    if (p.kind === 'lektorat') {
      const f = errors[p.errIdx];
      const isSel = selected[p.errIdx];
      const sel = isSel ? ' lektorat-mark--selected' : '';
      const markOpen = `<mark class="lektorat-mark${sel}" data-error-idx="${p.errIdx}">`;
      const ins = isSel && f.korrektur ? `<ins class="lektorat-ins">${escHtml(f.korrektur)}</ins>` : '';
      result = result.slice(0, p.idx) + markOpen + originalText + '</mark>' + ins + result.slice(p.idx + p.len);
    } else {
      const prop = chatProposals[p.propIdx];
      const markOpen = `<mark class="chat-mark" data-chat-msg-idx="${prop.msgIdx}" data-chat-v-idx="${prop.vIdx}">`;
      const ins = `<ins class="chat-mark-ins">${escHtml(prop.ersatz)}</ins>`;
      result = result.slice(0, p.idx) + markOpen + originalText + '</mark>' + ins + result.slice(p.idx + p.len);
    }
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

  const typLabel = tRaw('finding.' + f.typ);
  const isHard = { rechtschreibung:1, grammatik:1, tempuswechsel:1 }[f.typ];
  const badgeCls = isHard ? 'badge-err' : 'badge-warn';
  tip.innerHTML =
    `<span class="badge ${badgeCls}">${escHtml(typLabel)}</span>`
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

// ── Split-Modus: Hover-Sync ───────────────────────────────────────────────

const splitMQ = window.matchMedia('(min-width: 1100px)');

function flashEl(el) {
  el.classList.remove('hover-sync-flash');
  void el.offsetWidth; // reflow → Animation neu starten
  el.classList.add('hover-sync-flash');
}

// ── Exportierte Methoden ───────────────────────────────────────────────────

export const pageViewMethods = {
  // State-Defaults (in app.js eingebunden)
  // renderedPageHtml: '',
  // chapterFigures: [],
  // showChapterFigures: false,

  /** Berechnet max-height für die Seitenansicht basierend auf Textlänge */
  _updatePageViewHeight() {
    // Nach Edits ist tokEsts stale → aktuellen Text aus originalHtml ableiten,
    // sonst auf Cache fallback (bevor die Seite geladen ist).
    let words = 0;
    if (this.originalHtml) {
      const text = htmlToText(this.originalHtml).trim();
      words = text ? text.split(/\s+/).length : 0;
    } else {
      words = this.tokEsts?.[this.currentPage?.id]?.words || 0;
    }
    // ~12 Wörter pro Zeile, ~1.8em Zeilenhöhe ≈ 28px
    const estLines = Math.ceil(words / 12);
    const vh = Math.min(75, Math.max(15, Math.round(estLines * 28 / window.innerHeight * 100)));
    document.documentElement.style.setProperty('--pcv-max-h', vh + 'vh');
  },

  /** Aktualisiert die gerenderte Seitenansicht (mit oder ohne Highlights) */
  updatePageView() {
    if (!this.originalHtml) {
      this.renderedPageHtml = '';
      return;
    }
    const allErrors = this.lektoratFindings || [];
    const allSelected = this.selectedFindings || [];
    const chatProposals = [];
    // Nur die letzte Assistant-Nachricht als Quelle für Inline-Marks: sonst
    // mischen sich frische Vorschläge mit denen aus der Historie und das
    // Ergebnis ist unübersichtlich. Ältere Vorschläge bleiben in den
    // Chat-Bubbles sichtbar.
    const msgs = this.chatMessages || [];
    let lastAsstIdx = -1;
    for (let mi = msgs.length - 1; mi >= 0; mi--) {
      if (msgs[mi].role === 'assistant') { lastAsstIdx = mi; break; }
    }
    if (lastAsstIdx !== -1 && Array.isArray(msgs[lastAsstIdx].vorschlaege)) {
      const lastMsg = msgs[lastAsstIdx];
      for (let vi = 0; vi < lastMsg.vorschlaege.length; vi++) {
        const v = lastMsg.vorschlaege[vi];
        if (v._applied || !v.original || !v.ersatz) continue;
        chatProposals.push({ msgIdx: lastAsstIdx, vIdx: vi, original: v.original, ersatz: v.ersatz });
      }
    }
    if (allErrors.length > 0 || chatProposals.length > 0) {
      this.renderedPageHtml = buildHighlightedHtml(this.originalHtml, allErrors, allSelected, chatProposals);
    } else {
      this.renderedPageHtml = this.originalHtml;
    }
    this._updatePageViewHeight();
  },

  /** Lädt Figurenkontext für das aktuelle Kapitel (nur bei >1 Seite im Kapitel) */
  async loadChapterFigures() {
    if (!this.currentPage?.chapter_id || !this.selectedBookId) {
      this.chapterFigures = [];
      return;
    }
    // Bei nur einer Seite pro Kapitel liefert der Endpoint alle Buchfiguren → nicht hilfreich
    const chapter = this.tree?.find(c => c.id === this.currentPage.chapter_id);
    if (chapter && chapter.pages?.length <= 1) {
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

  /** Click-Handler für Inline-Marks → togglet Selektion */
  handleMarkClick(e) {
    const mark = e.target.closest('.lektorat-mark');
    if (!mark) return;
    const idx = parseInt(mark.dataset.errorIdx);
    if (isNaN(idx)) return;
    this.toggleFinding(idx);
  },

  /** Pointer-Handler auf page-content-view: Im Split → Hover-Sync, sonst → Tooltip */
  handleMarkPointer(e) {
    if (e.pointerType !== 'mouse') return;
    const mark = e.target.closest('.lektorat-mark');
    if (mark === activeMark) return;
    if (!mark) { hideTip(); return; }

    if (splitMQ.matches && this.checkDone) {
      // Split-Modus: Finding-Panel mitscrollen
      activeMark = mark;
      const idx = parseInt(mark.dataset.errorIdx);
      if (isNaN(idx)) return;
      const finding = document.querySelector(`.lektorat-split-findings [data-finding-idx="${idx}"]`);
      if (finding) {
        finding.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        flashEl(finding);
      }
    } else {
      // Kein Split: Tooltip wie bisher
      showTip(mark, this.lektoratFindings || []);
    }
  },

  handleMarkPointerLeave(e) {
    if (splitMQ.matches && this.checkDone) return;
    const related = e.relatedTarget;
    if (related && tipEl?.contains(related)) return;
    hideTip();
  },

  /** Hover auf Finding → Preview-Panel zur entsprechenden Markierung scrollen */
  handleFindingPointer(idx) {
    if (!splitMQ.matches || !this.checkDone) return;
    const mark = document.querySelector(`.lektorat-split-preview .lektorat-mark[data-error-idx="${idx}"]`);
    if (mark) {
      mark.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      flashEl(mark);
    }
  },
};
