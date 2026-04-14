// History-Methoden (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.

import { escHtml } from './utils.js';
import { sortByPosition } from './page-view.js';

export const historyMethods = {
  async loadPageHistory(pageId) {
    try {
      this.pageHistory = await fetch('/history/page/' + pageId).then(r => r.json());
    } catch (e) {
      console.error('[loadPageHistory]', e);
    }
  },

  async toggleHistoryEntrySaved(entry) {
    const newSaved = !entry.saved;
    try {
      await fetch('/history/check/' + entry.id + '/saved', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ saved: newSaved }),
      });
      entry.saved = newSaved;
      entry.saved_at = newSaved ? new Date().toISOString() : null;
    } catch (e) {
      console.error('[toggleHistoryEntrySaved]', e);
    }
  },

  async deletePageCheck(id) {
    try {
      await fetch('/history/check/' + id, { method: 'DELETE' });
      this.pageHistory = this.pageHistory.filter(e => e.id !== id);
      // Aktiven Eintrag gelöscht → Vorschau zurücksetzen
      if (this.activeHistoryEntryId === id) {
        this.activeHistoryEntryId = null;
        this.lektoratErrors = [];
        this.lektoratStyles = [];
        this.selectedErrors = [];
        this.selectedStyles = [];
        this.correctedHtml = null;
        this.hasErrors = false;
        this.checkDone = false;
        this.analysisOut = '';
        this.lastCheckId = null;
        this.updatePageView();
      }
    } catch (e) {
      console.error('[deletePageCheck]', e);
    }
  },

  async loadBookReviewHistory(bookId) {
    try {
      this.bookReviewHistory = await fetch('/history/review/' + bookId).then(r => r.json());
    } catch (e) {
      console.error('[loadBookReviewHistory]', e);
    }
  },

  /** History-Eintrag in die Vorschau laden (Toggle: erneuter Klick setzt zurück) */
  async loadHistoryEntry(entry) {
    // Toggle: Klick auf aktiven Eintrag → Vorschau zurücksetzen
    if (this.activeHistoryEntryId === entry.id) {
      this.activeHistoryEntryId = null;
      this.lektoratErrors = [];
      this.lektoratStyles = [];
      this.selectedErrors = [];
      this.selectedStyles = [];
      this.correctedHtml = null;
      this.hasErrors = false;
      this.checkDone = false;
      this.analysisOut = '';
      this.lastCheckId = null;
      this.updatePageView();
      return;
    }

    if (!this.currentPage) return;

    // Aktuelles Seiten-HTML laden falls nötig
    if (!this.originalHtml) {
      try {
        const pd = await this.bsGet('pages/' + this.currentPage.id);
        this.originalHtml = pd.html || '';
      } catch (e) {
        this.setStatus('Seiteninhalt konnte nicht geladen werden.');
        return;
      }
    }

    const SOFT_TYPEN = new Set(['wiederholung', 'schwaches_verb', 'fuellwort', 'show_vs_tell', 'passiv', 'perspektivbruch', 'tempuswechsel']);
    const errors = sortByPosition(this.originalHtml, (entry.errors_json || []).filter(f => f.typ !== 'stil'));
    const styles = sortByPosition(this.originalHtml, (entry.errors_json || []).filter(f => f.typ === 'stil'));

    this.lektoratErrors = errors;
    this.lektoratStyles = styles;

    // Selection: bereits angewendete Korrekturen abwählen
    if (entry.saved && entry.applied_errors_json) {
      const appliedSet = new Set(entry.applied_errors_json.map(e => e.original));
      this.selectedErrors = errors.map(f => !appliedSet.has(f.original) && !SOFT_TYPEN.has(f.typ));
    } else {
      this.selectedErrors = errors.map(f => !SOFT_TYPEN.has(f.typ));
    }
    if (entry.saved && entry.selected_errors_json) {
      const selectedSet = new Set(entry.selected_errors_json.map(e => e.original));
      this.selectedStyles = styles.map(s => !selectedSet.has(s.original));
    } else {
      this.selectedStyles = styles.map(() => false);
    }

    const hardErrors = errors.filter(f => !SOFT_TYPEN.has(f.typ));
    this.hasErrors = hardErrors.length > 0;
    this.correctedHtml = hardErrors.length > 0
      ? this._applyCorrections(this.originalHtml, hardErrors)
      : this.originalHtml;

    this.checkDone = true;
    this.lastCheckId = entry.id;
    this.activeHistoryEntryId = entry.id;

    // Szenen, Stilanalyse, Fazit in analysisOut rendern
    let out = '';
    const szenen = entry.szenen_json || [];
    if (szenen.length > 0) {
      const wertungBadge = w => {
        if (w === 'stark')   return '<span class="badge badge-ok">stark</span>';
        if (w === 'schwach') return '<span class="badge badge-err">schwach</span>';
        return '<span class="badge badge-warn">mittel</span>';
      };
      const rows = szenen.map(s =>
        `<div class="szene-item">
          <div class="szene-header">${wertungBadge(s.wertung)} <span class="szene-titel">${escHtml(s.titel)}</span></div>
          ${s.kommentar ? `<div class="szene-kommentar">${escHtml(s.kommentar)}</div>` : ''}
        </div>`
      ).join('');
      out += `<div class="stilbox"><div class="bewertung-section-title">Szenen</div>${rows}</div>`;
    }
    if (entry.stilanalyse) out += `<div class="stilbox"><div class="bewertung-section-title">Stilanalyse</div>${escHtml(entry.stilanalyse)}</div>`;
    if (entry.fazit) out += `<div class="fazit">${escHtml(entry.fazit)}</div>`;
    this.analysisOut = out;

    this.updatePageView();
    this.setStatus(`Verlaufseintrag vom ${this.formatDate(entry.checked_at)} geladen.`, false, 4000);

    // Nach oben zur Seitenansicht scrollen
    document.getElementById('editor-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  },

  async deleteBookReview(id) {
    try {
      await fetch('/history/review/' + id, { method: 'DELETE' });
      this.bookReviewHistory = this.bookReviewHistory.filter(e => e.id !== id);
      if (this.selectedBookReviewId === id) this.selectedBookReviewId = null;
    } catch (e) {
      console.error('[deleteBookReview]', e);
    }
  },
};
