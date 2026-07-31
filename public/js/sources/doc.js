// Fachmodul der Quellen-Karte: PDF-Anhang und semantische Bibliothekssuche.
// Pendant zu public/js/sources/manage.js — würde dessen 600-LOC-Cap
// überschreiten, darum in eigenem Modul. Wird in Alpine.data('sourcesCard')
// gespreadet (public/js/cards/sources-card.js).
//
// Nomenklatur: „doc" auf allen Schichten — Route `/sources/:id/doc`, Spalten
// `doc_*`, State `srcDoc*`. Dasselbe Wort wie beim Recherche-Anhang; „pdf"
// steht nur dort, wo es wirklich um das Dateiformat geht.
//
// PDF: das Original liegt als BLOB an `sources.doc`; Upload/Entfernen sind
// Pool-Hoheit (nur Besitzer, Server setzt die 403-Grenze nochmals). Upload
// triggert asynchron den Embedding-Index-Job (user-skopiert, s. routes/jobs/
// source-embed-index.js) und liefert dessen `index_job_id` zurück, damit die
// Karte den Fortschritt zeigen kann statt „wird gebaut" einzufrieren.
//
// Bibliothekssuche: Sinn-Query über die Quellen-PDFs des Users (Pool-Scope).
// Endpoint: GET /search/sources-semantic (user-skopiert, kein book_id).

import { fetchJson } from '../utils.js';
import { checkPdfFile, uploadPdf } from '../upload-pdf.js';

// Index-Job-Polling nach dem Upload: der Job läuft über die ganze Bibliothek
// und braucht bei einem frischen Werk je nach Backend Sekunden bis Minuten.
const INDEX_POLL_MS = 3000;
const INDEX_POLL_MAX = 100; // ~5 min, dann gibt die Karte die Anzeige auf

export const sourcesDocMethods = {
  // ── Quellen-Dokument (Upload/Download/Löschen) ───────────────────────────
  async uploadSourceDoc(evt) {
    if (this.srcDocBusy || this.srcEditingId == null || this.srcEditingId === 'new') return;
    const file = evt?.target?.files?.[0];
    const input = evt?.target || null;
    if (!file) return;
    const bad = checkPdfFile(file);
    if (bad) {
      this.srcDocError = bad;
      if (input) input.value = '';
      return;
    }
    this.srcDocBusy = true;
    this.srcDocError = '';
    try {
      const updated = await uploadPdf(`/sources/${this.srcEditingId}/doc`, file);
      this._applySourceDoc(updated);
      this.sourcesNotice = window.__app.t(
        updated.doc_unchanged ? 'sources.doc.unchanged' : 'sources.doc.uploaded'
      );
      this._flashSourcesNotice();
      if (updated.index_job_id) this._pollSourceIndexJob(updated.index_job_id);
    } catch (e) {
      this.srcDocError = e.message;
    } finally {
      this.srcDocBusy = false;
      if (input) input.value = ''; // Reset, sonst ist derselbe File nicht neu wählbar.
    }
  },

  downloadSourceDoc(id) {
    if (id == null) return;
    // Owner oder Viewer auf verlinktem Buch — die Route prüft beides.
    window.open(`/sources/${id}/doc`, '_blank', 'noopener');
  },

  async removeSourceDoc() {
    if (this.srcDocBusy || this.srcEditingId == null || this.srcEditingId === 'new') return;
    const app = window.__app;
    const ok = await app.appConfirm({
      message: app.t('sources.doc.removeConfirm'),
      confirmLabel: app.t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    this.srcDocBusy = true;
    this.srcDocError = '';
    try {
      const r = await fetch(`/sources/${this.srcEditingId}/doc`, { method: 'DELETE' });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(app.tError(d) || `HTTP ${r.status}`);
      }
      this._applySourceDoc(await r.json().catch(() => ({})));
      this._stopSourceIndexPoll();
    } catch (e) {
      this.srcDocError = e.message;
    } finally {
      this.srcDocBusy = false;
    }
  },

  /** Server-Antwort in Form-State UND Tabellenzeile spiegeln — sonst zeigt die
   *  Liste beim Zuklappen noch den alten Stand (Flackern beim nächsten Öffnen). */
  _applySourceDoc(src) {
    const fields = {
      has_doc: !!src?.has_doc,
      doc_name: src?.doc_name || '',
      doc_pages: src?.doc_pages ?? null,
      doc_chars: src?.doc_chars ?? null,
      doc_truncated: !!src?.doc_truncated,
      doc_indexed_at: src?.doc_indexed_at || null,
    };
    Object.assign(this.srcDraft, fields);
    const row = this.sources.find(s => s.id === this.srcEditingId);
    if (row) Object.assign(row, fields, { doc_name: fields.doc_name || null });
  },

  // ── Index-Fortschritt ─────────────────────────────────────────────────────
  // Der Upload stösst den Job an; ohne Polling bliebe „Index wird gebaut" bis
  // zum nächsten Öffnen des Formulars stehen, obwohl er längst durch ist.
  _pollSourceIndexJob(jobId) {
    this._stopSourceIndexPoll();
    this.srcDocIndexing = true;
    let ticks = 0;
    this._srcIndexTimer = setInterval(async () => {
      if (++ticks > INDEX_POLL_MAX) { this._stopSourceIndexPoll(); return; }
      try {
        const j = await fetchJson(`/jobs/${jobId}`);
        if (j?.status === 'done' || j?.status === 'error' || j?.status === 'cancelled') {
          this._stopSourceIndexPoll();
          if (j.status === 'done') await this._refreshSourceDocMeta();
        }
      } catch {
        this._stopSourceIndexPoll(); // Job weg / Session abgelaufen — nicht endlos weiterfragen
      }
    }, INDEX_POLL_MS);
  },

  _stopSourceIndexPoll() {
    if (this._srcIndexTimer) clearInterval(this._srcIndexTimer);
    this._srcIndexTimer = null;
    this.srcDocIndexing = false;
  },

  /** `doc_indexed_at` nachladen, wenn der Job fertig ist (Form ggf. schon zu). */
  async _refreshSourceDocMeta() {
    if (this.srcEditingId == null || this.srcEditingId === 'new') return;
    try { this._applySourceDoc(await fetchJson(`/sources/${this.srcEditingId}`)); }
    catch { /* Anzeige-Detail — ein Fehlschlag darf das Formular nicht stören */ }
  },

  /** Index-Stand für die Form-Anzeige: läuft gerade / steht / fehlt noch. */
  srcDocIndexLabel() {
    const app = window.__app;
    if (!this.srcDraft.has_doc) return '';
    if (this.srcDocIndexing) return app.t('sources.doc.indexRunning');
    return this.srcDraft.doc_indexed_at
      ? app.t('sources.doc.indexReady')
      : app.t('sources.doc.indexPending');
  },

  // ── Semantische Bibliothekssuche ──────────────────────────────────────────
  // Durchsucht die PDF-Volltexte der eigenen Quellen nach Sinn (Pool-Scope, kein
  // book_id). Treffer: { source_id, title, citekey, snippet, score }. Klick auf
  // einen Treffer öffnet die Quelle im Form (falls sie diesem Buch zugeordnet
  // ist) oder lädt sie frisch (Route prüft Besitz/Viewer-Recht).
  async searchSourceLibrary() {
    const q = String(this.srcLibQuery || '').trim();
    if (q.length < 2 || this.srcLibSearching) return;
    if (!window.Alpine?.store('config')?.semanticSearchEnabled) {
      this.srcLibError = window.__app.t('sources.libSearch.disabled');
      return;
    }
    this.srcLibSearching = true;
    this.srcLibError = '';
    this.srcLibHits = [];
    try {
      const r = await fetchJson(`/search/sources-semantic?q=${encodeURIComponent(q)}&limit=20`);
      this.srcLibHits = Array.isArray(r?.hits) ? r.hits : [];
      this.srcLibRan = true;
    } catch (e) {
      this.srcLibError = window.__app.tError(e) || e?.message || 'HTTP error';
    } finally {
      this.srcLibSearching = false;
    }
  },

  async openLibraryHit(h) {
    if (!h?.source_id) return;
    // Liegt die Quelle in diesem Buch? Dann direkt Form öffnen (Owner oder
    // Co-Editor). Sonst laden wir sie frisch als read-only-Anzeige; die Route
    // prüft Besitz oder Viewer-Recht auf verlinktem Buch. Im Form haben Nicht-
    // Besitzer nur Metadaten-Anzeige — `owner_email` entscheidet am Server.
    const local = this.sources.find(s => s.id === h.source_id);
    if (local) { this.startEditSource(local); return; }
    try {
      this.startEditSource(await fetchJson(`/sources/${h.source_id}`));
    } catch (e) {
      this.srcLibError = window.__app.tError(e) || e.message;
    }
  },
};
