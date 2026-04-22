// Buchbewertungs-Render-Helper. Der Job-Flow (Start, Poll, Render) lebt in
// Alpine.data('bookReviewCard'); hier nur das HTML-Rendering.

import { escHtml } from './utils.js';

export function renderReviewHtml(r, translate) {
  const note = parseInt(r.gesamtnote, 10) || 0;
  const stars = '★'.repeat(Math.min(6, Math.max(0, note))) + '☆'.repeat(Math.max(0, 6 - note));
  let html = `
      <div class="bewertung-header">
        <span class="bewertung-stars">${stars}</span>
        <span class="bewertung-header-note">${escHtml(r.gesamtnote_begruendung || '')}</span>
      </div>
      <div class="stilbox stilbox--review-summary">${escHtml(r.zusammenfassung || '')}</div>`;
  if (r.struktur) html += `
      <div class="bewertung-section">
        <div class="bewertung-section-title">${escHtml(translate('review.section.struktur'))}</div>
        <p class="bewertung-section-text">${escHtml(r.struktur)}</p>
      </div>`;
  if (r.stil) html += `
      <div class="bewertung-section">
        <div class="bewertung-section-title">${escHtml(translate('review.section.stil'))}</div>
        <p class="bewertung-section-text">${escHtml(r.stil)}</p>
      </div>`;
  if (r.staerken?.length) html += `
      <div class="bewertung-section">
        <div class="bewertung-section-title">${escHtml(translate('review.strengths'))}</div>
        <ul class="bullet-list pos">${r.staerken.map(s => `<li>${escHtml(s)}</li>`).join('')}</ul>
      </div>`;
  if (r.schwaechen?.length) html += `
      <div class="bewertung-section">
        <div class="bewertung-section-title">${escHtml(translate('review.weaknesses'))}</div>
        <ul class="bullet-list neg">${r.schwaechen.map(s => `<li>${escHtml(s)}</li>`).join('')}</ul>
      </div>`;
  if (r.empfehlungen?.length) html += `
      <div class="bewertung-section">
        <div class="bewertung-section-title">${escHtml(translate('review.section.empfehlungen'))}</div>
        <ul class="bullet-list">${r.empfehlungen.map(s => `<li>${escHtml(s)}</li>`).join('')}</ul>
      </div>`;
  if (r.fazit) html += `<div class="fazit fazit--review">${escHtml(r.fazit)}</div>`;
  return html;
}
