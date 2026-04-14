// History-Methoden (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.

import { escHtml } from './utils.js';

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
      if (this.selectedHistoryId === id) this.selectedHistoryId = null;
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

  // Prüft ob noch nicht umgesetzte Korrekturen für einen Eintrag vorhanden sind.
  historyHasUnapplied(entry) {
    if (!entry.saved) return entry.error_count > 0;
    // Wenn saved aber keine Tracking-Daten → unklar, alles als offen behandeln
    if (!entry.applied_errors_json && !entry.selected_errors_json) return entry.error_count > 0;
    const errors = this.historyErrors(entry);
    const styles = this.historyStyles(entry);
    const appliedSet = new Set((entry.applied_errors_json || []).map(e => e.original));
    const selectedSet = new Set((entry.selected_errors_json || []).map(e => e.original));
    return errors.some(e => !appliedSet.has(e.original)) || styles.some(s => !selectedSet.has(s.original));
  },

  // Selektionsstate für einen History-Eintrag initialisieren (beim Aufklappen).
  initHistorySelection(entry) {
    if (this.historySelections[entry.id]) return;
    const errors = (entry.errors_json || []).filter(f => f.typ !== 'stil');
    const styles = (entry.errors_json || []).filter(f => f.typ === 'stil');
    if (entry.saved && (entry.applied_errors_json || entry.selected_errors_json)) {
      // Nur noch nicht angewandte Korrekturen vorauswählen
      const appliedSet = new Set((entry.applied_errors_json || []).map(e => e.original));
      const selectedSet = new Set((entry.selected_errors_json || []).map(e => e.original));
      this.historySelections[entry.id] = {
        errors: errors.map(e => !appliedSet.has(e.original)),
        styles: styles.map(s => !selectedSet.has(s.original)),
      };
    } else {
      this.historySelections[entry.id] = {
        errors: errors.map(() => true),
        styles: styles.map(() => false),
      };
    }
  },

  toggleHistoryError(entryId, i) {
    const sel = this.historySelections[entryId];
    if (!sel) return;
    sel.errors[i] = !sel.errors[i];
  },

  toggleHistoryStyle(entryId, i) {
    const sel = this.historySelections[entryId];
    if (!sel) return;
    sel.styles[i] = !sel.styles[i];
  },

  historyErrors(entry) {
    return (entry.errors_json || []).filter(f => f.typ !== 'stil');
  },

  historyStyles(entry) {
    return (entry.errors_json || []).filter(f => f.typ === 'stil');
  },

  async applyHistoryCheck(entry) {
    if (!this.currentPage) return;
    const sel = this.historySelections[entry.id];
    if (!sel) return;

    const errors = this.historyErrors(entry);
    const styles = this.historyStyles(entry);
    const selectedErrors = errors.filter((_, i) => sel.errors[i]);
    const selectedStyles = styles.filter((_, i) => sel.styles[i]);
    const allSelected = [...selectedErrors, ...selectedStyles];

    if (allSelected.length === 0) {
      this.setStatus('Keine Korrekturen ausgewählt.');
      return;
    }

    try {
      const finalHtml = await this._loadApplyAndSave(selectedErrors, selectedStyles, (pct, text) => {
        this.historyApplying = { ...this.historyApplying, [entry.id]: pct };
        if (text) this.setStatus(text, true);
      });
      // Seitenansicht mit gespeichertem HTML aktualisieren
      if (finalHtml) {
        this.originalHtml = finalHtml;
        this.renderedPageHtml = finalHtml;
      }

      const mergeByOriginal = (existing, newItems) => {
        const set = new Set((existing || []).map(e => e.original));
        return [...(existing || []), ...newItems.filter(e => !set.has(e.original))];
      };

      await fetch('/history/check/' + entry.id + '/saved', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          applied_errors_json: mergeByOriginal(entry.applied_errors_json, selectedErrors),
          selected_errors_json: mergeByOriginal(entry.selected_errors_json, allSelected),
        }),
      });

      entry.saved = true;
      entry.saved_at = new Date().toISOString();
      entry.applied_errors_json = mergeByOriginal(entry.applied_errors_json, selectedErrors);
      entry.selected_errors_json = mergeByOriginal(entry.selected_errors_json, allSelected);
      delete this.historySelections[entry.id];
      this.initHistorySelection(entry);
      const _h = { ...this.historyApplying };
      delete _h[entry.id];
      this.historyApplying = _h;
      this.setStatus('✓ Korrekturen gespeichert.', false, 5000);
    } catch (e) {
      console.error('[applyHistoryCheck]', e);
      const _h = { ...this.historyApplying };
      delete _h[entry.id];
      this.historyApplying = _h;
      this.setStatus('Fehler: ' + e.message);
    }
  },

  /** History-Fehler in der Seitenansicht mit Inline-Highlights anzeigen */
  async showHistoryInEditor(entry) {
    if (!this.currentPage || !entry.errors_json?.length) return;

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
    const errors = entry.errors_json.filter(f => f.typ !== 'stil');
    const styles = entry.errors_json.filter(f => f.typ === 'stil');

    this.lektoratErrors = errors;
    this.lektoratStyles = styles;

    // Selektion aus History-State übernehmen (falls vorhanden)
    const sel = this.historySelections[entry.id];
    if (sel) {
      this.selectedErrors = sel.errors;
      this.selectedStyles = sel.styles;
    } else {
      this.selectedErrors = errors.map(f => !SOFT_TYPEN.has(f.typ));
      this.selectedStyles = styles.map(() => false);
    }

    const hardErrors = errors.filter(f => !SOFT_TYPEN.has(f.typ));
    this.hasErrors = hardErrors.length > 0;
    this.correctedHtml = hardErrors.length > 0
      ? this._applyCorrections(this.originalHtml, hardErrors)
      : this.originalHtml;

    this.checkDone = true;
    this.lastCheckId = entry.id;
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
    this.selectedHistoryId = null;
    this.setStatus(`Verlaufseintrag vom ${this.formatDate(entry.checked_at)} angezeigt.`, false, 4000);

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
