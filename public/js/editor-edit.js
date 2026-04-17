import { htmlToText } from './utils.js';
import { sortByPosition } from './page-view.js';

// Manuelle Inline-Bearbeitung der Seite. Preview wird contenteditable,
// Findings-Marks werden für die Dauer der Bearbeitung ausgeblendet.
// Speichern → bsPut mit rohem DOM-HTML; bestehende Findings werden auf
// diejenigen gefiltert, deren `original` im neuen HTML noch vorhanden ist.

export const editorEditMethods = {
  _getEditEl() {
    return document.querySelector('#editor-card .page-content-view--editing');
  },

  startEdit() {
    if (!this.currentPage || !this.originalHtml) return;
    if (this.checkLoading || this.saveApplying != null) return;
    this.editMode = true;
    this.editDirty = false;
    this.editSaving = false;
    const el = this._getEditEl();
    if (el) el.innerHTML = this.originalHtml;
    setTimeout(() => this._getEditEl()?.focus(), 0);
  },

  cancelEdit() {
    if (this.editDirty && !confirm('Ungespeicherte Bearbeitung verwerfen?')) return;
    this.editMode = false;
    this.editDirty = false;
    this.editSaving = false;
  },

  async saveEdit() {
    if (!this.currentPage) return;
    const el = this._getEditEl();
    if (!el) return;
    const newHtml = el.innerHTML;
    if (newHtml === this.originalHtml) { this.cancelEdit(); return; }

    const newText = htmlToText(newHtml).trim();
    if (!newText) {
      this.setStatus('Leerer Text – Speichern abgebrochen.', false, 5000);
      return;
    }
    const origText = htmlToText(this.originalHtml || '').trim();
    if (origText.length > 50 && newText.length < origText.length * 0.2) {
      if (!confirm(`Der neue Text ist deutlich kürzer (${newText.length} statt ${origText.length} Zeichen). Trotzdem speichern?`)) return;
    }

    this.editSaving = true;
    this.setStatus('Speichere Bearbeitung…', true);
    try {
      await this.bsPut('pages/' + this.currentPage.id, {
        html: newHtml,
        name: this.currentPage.name,
      });

      this.originalHtml = newHtml;
      const rawPreview = htmlToText(newHtml).trim() || null;
      if (this.currentPage) this.currentPage.previewText = rawPreview;
      this.currentPageEmpty = !rawPreview;

      // Findings filtern: nur die behalten, deren original-Text noch im neuen HTML steht.
      if (this.lektoratFindings.length > 0) {
        const survivors = [];
        const prevSelected = new Map();
        for (let i = 0; i < this.lektoratFindings.length; i++) {
          const f = this.lektoratFindings[i];
          if (f.original && newHtml.indexOf(f.original) !== -1) {
            survivors.push(f);
            prevSelected.set(f, !!this.selectedFindings[i]);
          }
        }
        this.lektoratFindings = sortByPosition(newHtml, survivors);
        this.selectedFindings = this.lektoratFindings.map(f => prevSelected.get(f) ?? false);
        this.appliedOriginals = this.appliedOriginals.filter(o => newHtml.indexOf(o) !== -1);
        if (this.lektoratFindings.length === 0) {
          this.checkDone = false;
          this.correctedHtml = null;
          this.hasErrors = false;
        } else {
          this._recomputeCorrectedHtml();
        }
      }

      this.editMode = false;
      this.editDirty = false;
      this.updatePageView();
      this.setStatus('✓ Änderungen gespeichert.', false, 5000);
    } catch (e) {
      console.error('[saveEdit]', e);
      this.setStatus('Fehler: ' + e.message);
    } finally {
      this.editSaving = false;
    }
  },

  _markEditDirty() {
    if (this.editMode) this.editDirty = true;
  },
};
