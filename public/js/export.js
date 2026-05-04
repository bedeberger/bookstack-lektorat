// Buch-Export. Methoden werden in Alpine.data('exportCard') gespreadet;
// Root-Zugriffe via window.__app.

export const exportMethods = {
  // Blob-Download mit Loading-Indicator. Plain-Anchor wäre einfacher, lässt aber
  // keinen Spinner zu — BookStack-PDF-Render kann 30-60 s brauchen, da soll der
  // User sehen, dass etwas läuft.
  async bookExport(fmt) {
    const bookId = window.__app.selectedBookId;
    if (!bookId || this.bookExportLoading) return;
    this.bookExportLoading = fmt;
    this.bookExportError = '';
    try {
      const r = await fetch(`/export/book/${encodeURIComponent(bookId)}/${encodeURIComponent(fmt)}`);
      if (!r.ok) {
        let data = null;
        try { data = await r.json(); } catch (_) {}
        throw new Error(data ? window.__app.tError(data) : `HTTP ${r.status}`);
      }
      const cd = r.headers.get('content-disposition') || '';
      const m = /filename="?([^";]+)"?/i.exec(cd);
      const filename = m ? m[1] : `book.${fmt}`;
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e) {
      this.bookExportError = e.message || String(e);
    } finally {
      this.bookExportLoading = null;
    }
  },
};
