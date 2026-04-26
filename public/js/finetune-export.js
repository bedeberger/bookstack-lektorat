// Fine-Tuning-Export: Methods werden in Alpine.data('finetuneExportCard')
// gespreadet. Root-Zugriffe via window.__app.

export const finetuneExportMethods = {
  finetuneDownload(kind) {
    if (!this.finetuneJobId) return;
    if (kind !== 'train' && kind !== 'val') return;
    const url = `/jobs/finetune-export/${encodeURIComponent(this.finetuneJobId)}/${kind}.jsonl`;
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  },

  finetuneAnyTypeSelected() {
    return !!(this.finetuneTypeStyle || this.finetuneTypeScene || this.finetuneTypeDialog || this.finetuneTypeAuthorChat || this.finetuneTypeCorrection);
  },

  finetuneFormatBytes(n) {
    if (n == null) return '';
    if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
    return n + ' B';
  },
};
