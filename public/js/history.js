import { SYSTEM_STILKORREKTUR, buildStilkorrekturPrompt } from './prompts.js';

// History-Methoden (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.

const SAFETY_HTML_RATIO = 0.5;

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

    this.setStatus('Lade aktuelle Seite…', true);
    try {
      const page = await this.bsGet('pages/' + this.currentPage.id);
      let finalHtml = this._applyCorrections(page.html, selectedErrors);

      if (selectedStyles.length > 0) {
        this.setStatus('KI überarbeitet Stil… (0 Zeichen)', true);
        try {
          const result = await this.callAI(
            buildStilkorrekturPrompt(finalHtml, selectedStyles),
            SYSTEM_STILKORREKTUR,
            (chars) => this.setStatus(`KI überarbeitet Stil… (${chars} Zeichen)`, true),
          );
          if (Array.isArray(result?.korrekturen) && result.korrekturen.length > 0) {
            finalHtml = this._applyCorrections(finalHtml, result.korrekturen.map(k => ({ original: k.original, korrektur: k.ersatz })));
          }
        } catch (e) {
          console.error('[applyHistoryCheck] Stil-Call fehlgeschlagen:', e);
          this.setStatus('Stilkorrektur fehlgeschlagen – speichere übrige Korrekturen…', true);
          // finalHtml bleibt ohne Stilkorrekturen, der Rest wird trotzdem gespeichert
        }
      }

      if (finalHtml.length < page.html.length * SAFETY_HTML_RATIO) {
        this.setStatus('Fehler: Ergebnis wirkt unvollständig – Speichern abgebrochen.');
        return;
      }

      this.setStatus('Speichere in BookStack…', true);
      await this.bsPut('pages/' + this.currentPage.id, { html: finalHtml, name: this.currentPage.name });

      const mergeByOriginal = (existing, newItems) => {
        const set = new Set((existing || []).map(e => e.original));
        return [...(existing || []), ...newItems.filter(e => !set.has(e.original))];
      };
      const mergedApplied = mergeByOriginal(entry.applied_errors_json, selectedErrors);
      const mergedSelected = mergeByOriginal(entry.selected_errors_json, allSelected);

      await fetch('/history/check/' + entry.id + '/saved', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          applied_errors_json: mergedApplied,
          selected_errors_json: mergedSelected,
        }),
      });

      entry.saved = true;
      entry.saved_at = new Date().toISOString();
      entry.applied_errors_json = mergedApplied;
      entry.selected_errors_json = mergedSelected;
      delete this.historySelections[entry.id];
      this.initHistorySelection(entry);
      this.setStatus('✓ Korrekturen gespeichert.', false, 5000);
    } catch (e) {
      console.error('[applyHistoryCheck]', e);
      this.setStatus('Fehler: ' + e.message);
    }
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
