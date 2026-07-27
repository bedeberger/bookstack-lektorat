// Aufrufer-Seite: Buch-Locale laden, passende Normalize-Variante fahren.
// Gemeinsam genutzt von Notebook-Slash, Bubble-Selection und Focus-Topbar.

import { resolveQuoteStyle } from './styles.js';
import { normalizeQuotes, normalizeQuotesInRange, normalizeQuotesInHtml } from './walk.js';

async function _loadStyle(bookId) {
  const r = await fetch(`/booksettings/${bookId}`, { credentials: 'same-origin' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  return resolveQuoteStyle(data.language, data.region);
}

export async function runQuoteNormalize({ bookId, rootEl, range = null }) {
  if (!bookId || !rootEl) return { ok: false, count: 0 };
  let style;
  try {
    style = await _loadStyle(bookId);
  } catch (e) {
    console.error('[quote-normalize] booksettings fetch failed', e);
    return { ok: false, count: 0 };
  }
  const count = range
    ? normalizeQuotesInRange(range, style)
    : normalizeQuotes(rootEl, style);
  return { ok: true, count };
}

export async function runQuoteNormalizeHtml({ bookId, html }) {
  if (!bookId || !html) return { ok: false, html };
  try {
    const style = await _loadStyle(bookId);
    return { ok: true, html: normalizeQuotesInHtml(html, style) };
  } catch (e) {
    console.error('[quote-normalize] booksettings fetch failed', e);
    return { ok: false, html };
  }
}
