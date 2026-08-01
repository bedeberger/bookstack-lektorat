// Anhang-Ebene der Recherche-Karte: Bild- und PDF-Upload eines Fundstuecks.

import { fetchJson } from '../../utils.js';
import { checkPdfFile, uploadPdf } from '../../upload-pdf.js';

export const rechercheMediaMethods = {
  // ── Bild-Upload ──────────────────────────────────────────────────────────
  async uploadImage(item, file) {
    const app = window.__app;
    if (!file) return;
    this.busy = true;
    try {
      const buf = await file.arrayBuffer();
      const row = await fetchJson(`/research/${item.id}/image`, {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: buf,
      });
      this._replaceItem(row);
    } catch { this.errorMessage = app.t('recherche.error.image'); }
    finally { this.busy = false; }
  },
  onImagePick(item, ev) {
    const file = ev?.target?.files?.[0];
    if (file) this.uploadImage(item, file);
    if (ev?.target) ev.target.value = '';
  },
  imageUrl(item) { return `/research/${item.id}/image`; },

  // ── Dokument-Upload (PDF) ──────────────────────────────────────────────────
  // Mechanik (Typ-/Groessenpruefung, Body, Fehleruebersetzung) kommt aus
  // public/js/upload-pdf.js — dasselbe Modul bedient den Quellen-Anhang.
  async uploadDoc(item, file) {
    if (!file) return;
    const bad = checkPdfFile(file);
    if (bad) { this.errorMessage = bad; return; }
    this.busy = true;
    try {
      this._replaceItem(await uploadPdf(`/research/${item.id}/doc`, file));
    } catch (e) {
      // Die Server-Meldung ist praeziser als „Upload fehlgeschlagen" (zu gross /
      // kein PDF / unlesbar) — sie hat den Vorrang.
      this.errorMessage = e?.message || window.__app.t('recherche.error.doc');
    } finally { this.busy = false; }
  },
  onDocPick(item, ev) {
    const file = ev?.target?.files?.[0];
    if (file) this.uploadDoc(item, file);
    if (ev?.target) ev.target.value = '';
  },
  docUrl(item) { return `/research/${item.id}/doc`; },
  async removeDoc(item) {
    const app = window.__app;
    if (!await app.appConfirm({
      message: app.t('recherche.doc.confirmRemove'),
      confirmLabel: app.t('common.delete'), danger: true,
    })) return;
    try {
      const row = await fetchJson(`/research/${item.id}/doc`, { method: 'DELETE' });
      this._replaceItem(row);
    } catch { this.errorMessage = app.t('recherche.error.doc'); }
    this.menuOpenId = null;
  },
};
