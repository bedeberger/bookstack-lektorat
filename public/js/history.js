// History-Methoden (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.

import { escHtml, stripFocusArtefacts, fetchJson } from './utils.js';
import { sortByPosition, SOFT_TYPEN } from './page-view.js';

export const historyMethods = {
  async loadPageHistory(pageId) {
    try {
      this.pageHistory = await fetchJson('/history/page/' + pageId);
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
      this.refreshPageAges();
    } catch (e) {
      console.error('[toggleHistoryEntrySaved]', e);
    }
  },

  async deletePageCheck(id) {
    try {
      await fetch('/history/check/' + id, { method: 'DELETE' });
      this.pageHistory = this.pageHistory.filter(e => e.id !== id);
      this.refreshPageAges();
      // Aktiven Eintrag gelöscht → Vorschau zurücksetzen
      if (this.activeHistoryEntryId === id) {
        this.activeHistoryEntryId = null;
        this.lektoratFindings = [];
        this.selectedFindings = [];
        this.appliedOriginals = [];
        this.appliedHistoricCorrections = [];
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
      this.bookReviewHistory = await fetchJson('/history/review/' + bookId);
    } catch (e) {
      console.error('[loadBookReviewHistory]', e);
    }
  },

  /** History-Eintrag in die Vorschau laden (Toggle: erneuter Klick setzt zurück) */
  async loadHistoryEntry(entry) {
    // Toggle: Klick auf aktiven Eintrag → Vorschau zurücksetzen
    if (this.activeHistoryEntryId === entry.id) {
      this.activeHistoryEntryId = null;
      this.lektoratFindings = [];
      this.selectedFindings = [];
      this.appliedOriginals = [];
      this.appliedHistoricCorrections = [];
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
        this.originalHtml = stripFocusArtefacts(pd.html || '');
      } catch (e) {
        this.setStatus(this.t('chat.pageLoadFailed'));
        return;
      }
    }

    const findings = sortByPosition(this.originalHtml, entry.errors_json || []);
    this.lektoratFindings = findings;

    // Vereinigung aller übernommenen Originals (Fehler + Stil) für Per-Vorschlag-Status
    const appliedEntries = entry.saved
      ? [...(entry.applied_errors_json || []), ...(entry.selected_errors_json || [])]
      : [];
    const appliedUnion = appliedEntries.map(e => e.original);
    this.appliedOriginals = [...new Set(appliedUnion)];
    const appliedSet = new Set(this.appliedOriginals);

    // Bereits eingearbeitete Korrekturen, deren Original nicht mehr im Text steht
    // (wurde durch die Korrektur ersetzt) → separate, kompakte Sektion in der Fehlerliste.
    const stillVisible = new Set(findings.map(f => f.original));
    const seenOriginals = new Set();
    this.appliedHistoricCorrections = appliedEntries.filter(e => {
      if (!e.original || stillVisible.has(e.original) || seenOriginals.has(e.original)) return false;
      seenOriginals.add(e.original);
      return true;
    });

    // Selection: bereits angewendete Korrekturen + weiche Typen + Stil default unselected
    this.selectedFindings = findings.map(f => !appliedSet.has(f.original) && !SOFT_TYPEN.has(f.typ) && f.typ !== 'stil');

    const hardErrors = findings.filter(f => !SOFT_TYPEN.has(f.typ) && f.typ !== 'stil');
    this.hasErrors = hardErrors.length > 0;
    this.correctedHtml = hardErrors.length > 0
      ? this._applyCorrections(this.originalHtml, hardErrors)
      : this.originalHtml;

    this.checkDone = true;
    if (this.showChatCard) { this.showChatCard = false; this._checkDoneBeforeChat = false; }
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
