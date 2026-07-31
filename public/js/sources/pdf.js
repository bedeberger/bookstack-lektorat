// Fachmodul der Quellen-Karte: PDF-Anhang und semantische Bibliothekssuche.
// Pendant zu public/js/sources/manage.js — würde dessen 600-LOC-Cap
// überschreiten, darum in eigenem Modul. Wird in Alpine.data('sourcesCard')
// gespreadet (public/js/cards/sources-card.js).
//
// PDF: das Original liegt als BLOB an `sources.doc`; Upload/Entfernen sind
// Pool-Hoheit (nur Besitzer, Server setzt die 403-Grenze nochmals). Upload
// triggert asynchron den Embedding-Index-Job (user-skopiert, s. routes/jobs/
// source-embed-index.js). Der extrahierte Plain-Text wird via _contentHash()
// delta-cached: unveränderte Chunks behalten ihren Vektor.
//
// Bibliothekssuche: Sinn-Query über die Quellen-PDFs des Users (Pool-Scope).
// Endpoint: GET /search/sources-semantic (user-skopiert, kein book_id).

import { fetchJson } from '../utils.js';

const PDF_MAX_BYTES = 25 * 1024 * 1024;

export const sourcesPdfMethods = {
  // ── Quellen-PDF (Upload/Download/Löschen) ────────────────────────────────
  async uploadSourcePdf(evt) {
    if (this.srcPdfBusy || this.srcEditingId == null || this.srcEditingId === 'new') return;
    const file = evt?.target?.files?.[0];
    if (!file) return;
    if (file.type && file.type !== 'application/pdf') {
      this.srcPdfError = window.__app.t('sources.pdf.errType');
      return;
    }
    if (file.size > PDF_MAX_BYTES) {
      this.srcPdfError = window.__app.t('sources.pdf.errSize');
      return;
    }
    this.srcPdfBusy = true;
    this.srcPdfError = '';
    try {
      const buf = await file.arrayBuffer();
      const r = await fetch(`/sources/${this.srcEditingId}/pdf?name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/pdf' },
        body: new Uint8Array(buf),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(window.__app.tError(d) || `HTTP ${r.status}`);
      }
      const updated = await r.json().catch(() => ({}));
      // Sichtbarer Form-State folgt dem Server; die Tabellen-Zeile spiegeln wir
      // ebenfalls, damit ein Toggle/Zuklappen konsistent bleibt (kein Flackern).
      this.srcDraft.has_pdf = !!updated.has_pdf;
      this.srcDraft.doc_name = updated.doc_name || '';
      this.srcDraft.doc_pages = updated.doc_pages ?? null;
      this.srcDraft.doc_indexed_at = updated.doc_indexed_at || null;
      const row = this.sources.find(s => s.id === this.srcEditingId);
      if (row) {
        row.has_pdf = !!updated.has_pdf;
        row.doc_name = updated.doc_name || null;
        row.doc_pages = updated.doc_pages ?? null;
        row.doc_indexed_at = updated.doc_indexed_at || null;
      }
      this.sourcesNotice = window.__app.t('sources.pdf.uploaded');
      this._flashSourcesNotice();
    } catch (e) {
      this.srcPdfError = e.message;
    } finally {
      this.srcPdfBusy = false;
      if (evt?.target) evt.target.value = ''; // Reset, sonst ist derselbe File nicht neu wählbar.
    }
  },

  downloadSourcePdf(id) {
    if (id == null) return;
    // Owner oder Viewer auf verlinktem Buch — die Route prüft beides.
    window.open(`/sources/${id}/pdf`, '_blank', 'noopener');
  },

  async removeSourcePdf() {
    if (this.srcPdfBusy || this.srcEditingId == null || this.srcEditingId === 'new') return;
    const app = window.__app;
    const ok = await app.appConfirm({
      message: app.t('sources.pdf.removeConfirm'),
      confirmLabel: app.t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    this.srcPdfBusy = true;
    this.srcPdfError = '';
    try {
      const r = await fetch(`/sources/${this.srcEditingId}/pdf`, { method: 'DELETE' });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(app.tError(d) || `HTTP ${r.status}`);
      }
      const updated = await r.json().catch(() => ({}));
      void updated;
      this.srcDraft.has_pdf = false;
      this.srcDraft.doc_name = '';
      this.srcDraft.doc_pages = null;
      this.srcDraft.doc_indexed_at = null;
      const row = this.sources.find(s => s.id === this.srcEditingId);
      if (row) {
        row.has_pdf = false;
        row.doc_name = null;
        row.doc_pages = null;
        row.doc_indexed_at = null;
      }
    } catch (e) {
      this.srcPdfError = e.message;
    } finally {
      this.srcPdfBusy = false;
    }
  },

  /** Index-Stand für die Form-Anzeige. Entweder „steht" (doc_indexed_at gesetzt)
   *  oder „wird gebaut"/„fehlt" — wir unterscheiden nicht, ob der Nacht-Cron
   *  gerade läuft (das wäre ein separater Status-Poll). Genug für die Anzeige. */
  srcPdfIndexLabel() {
    const app = window.__app;
    if (!this.srcDraft.has_pdf) return '';
    return this.srcDraft.doc_indexed_at
      ? app.t('sources.pdf.indexReady')
      : app.t('sources.pdf.indexPending');
  },

  // ── Semantische Bibliothekssuche ──────────────────────────────────────────
  // retrieves PDF-Volltexte des Users nach Sinn (Pool-Scope, kein book_id).
  // Treffer: { source_id, title, citekey, snippet, score }. Klick auf Treffer
  // öffnet die Quelle im Form (falls sie diesem Buch zugeordnet) oder lädt sie
  // frisch für die read-only-Anzeige (Route prüft Besitz/Viewer-Recht).
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
      const r = await fetch(`/sources/${h.source_id}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const src = await r.json();
      this.startEditSource(src);
    } catch (e) {
      this.srcLibError = window.__app.tError(e) || e.message;
    }
  },
};