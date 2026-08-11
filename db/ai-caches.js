'use strict';
// Delta-Caches der KI-Pfade: Phase-1-Extraktion, Buch-/Kapitel-Review,
// Kapitel-Makro-Review, Synonym-Suche, Seiten-Lektorat und
// Finetune-Augmentation.
//
// Alle folgen demselben Muster: `provider` ist Teil des PRIMARY KEY (verhindert
// Cross-Provider-Bleeding), eine Signatur (pagesSig/ctxSig/keyHash) traegt den
// Inhalts-Hash, und der Schreibpfad verlangt einen echten User
// (`_requireUserEmail`), weil user_email FK auf app_users(email) ist.
// Der Rueckblick-Cache liegt bei seiner Historie in db/rueckblick.js.

const { db } = require('./connection');
// Prepared Statements dieses Moduls sitzen auf migrierten Spalten — die
// Migrationen muessen vor dem Anlegen gelaufen sein.
require('./migrations');
const { requireUserEmail: _requireUserEmail } = require('./write-helpers');

// ── Delta-Cache: Phase-1-Extraktion pro Kapitel + Buch-Level ──────────────────
// pages_sig: sortierter String aus "page_id:updated_at"-Paaren aller Seiten.
// Ändert sich irgendeine Seite, ändert sich die Signatur → Cache-Miss → Neu-Extraktion.
//
// chapter_extract_cache: pro Kapitel (FK auf chapters.chapter_id, Mig 75).
//   PK (book_id, user_email, chapter_id, phase). phase ∈
//     '' (full chunk), 'figuren'/'orte' (Lokal split-Pässe),
//     'sub<N>'(:figuren|:orte)? (sub-chunk wenn Kapitel zu lang).
// book_extract_cache: Buch-Level-Single-Pass (Mig 75, kein FK-Target — book_id extern).
//
// chapterKey-Format (Legacy-API): <chapter_id>(__sub<N>)?(:phase)? oder '__singlepass__'.

function _parseChapterKey(key) {
  if (key === '__singlepass__') return { book: true };
  const m = String(key).match(/^(\d+)(__sub\d+)?(?::(.+))?$/);
  if (!m) return null;
  const chapterId = parseInt(m[1]);
  const sub = m[2] ? m[2].slice(2) : '';
  const phaseSuffix = m[3] || '';
  const phase = sub ? (phaseSuffix ? `${sub}:${phaseSuffix}` : sub) : phaseSuffix;
  return { chapterId, phase };
}

// provider in PK. Caller MUSS den resolvten Provider durchreichen,
// sonst landet Claude-Output unter '' (Backfill-Default) und Ollama-User
// kriegt es ausgeliefert.
const _loadChapterCache = db.prepare(
  `SELECT extract_json FROM chapter_extract_cache
   WHERE book_id = ? AND user_email = ? AND chapter_id = ? AND phase = ? AND provider = ? AND pages_sig = ?`
);
const _saveChapterCache = db.prepare(
  `INSERT OR REPLACE INTO chapter_extract_cache
   (book_id, user_email, chapter_id, phase, provider, pages_sig, extract_json, cached_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);
const _loadBookCache = db.prepare(
  `SELECT extract_json FROM book_extract_cache
   WHERE book_id = ? AND user_email = ? AND provider = ? AND pages_sig = ?`
);
const _saveBookCache = db.prepare(
  `INSERT OR REPLACE INTO book_extract_cache
   (book_id, user_email, provider, pages_sig, extract_json, cached_at)
   VALUES (?, ?, ?, ?, ?, ?)`
);

function loadChapterExtractCache(bookId, userEmail, chapterKey, pagesSig, provider = '') {
  const parsed = _parseChapterKey(chapterKey);
  if (!parsed) return null;
  const row = parsed.book
    ? _loadBookCache.get(parseInt(bookId), userEmail || '', provider || '', pagesSig)
    : _loadChapterCache.get(parseInt(bookId), userEmail || '', parsed.chapterId, parsed.phase, provider || '', pagesSig);
  if (!row) return null;
  try { return JSON.parse(row.extract_json); } catch { return null; }
}

function saveChapterExtractCache(bookId, userEmail, chapterKey, pagesSig, extract, provider = '') {
  const parsed = _parseChapterKey(chapterKey);
  if (!parsed) return;
  const email = _requireUserEmail(userEmail, 'saveChapterExtractCache');
  const json = JSON.stringify(extract);
  const now = new Date().toISOString();
  if (parsed.book) {
    _saveBookCache.run(parseInt(bookId), email, provider || '', pagesSig, json, now);
  } else {
    _saveChapterCache.run(parseInt(bookId), email, parsed.chapterId, parsed.phase, provider || '', pagesSig, json, now);
  }
}

const _deleteChapterCache = db.prepare(
  `DELETE FROM chapter_extract_cache WHERE book_id = ? AND user_email = ?`
);
const _deleteBookCache = db.prepare(
  `DELETE FROM book_extract_cache WHERE book_id = ? AND user_email = ?`
);

function deleteChapterExtractCache(bookId, userEmail) {
  const c = _deleteChapterCache.run(parseInt(bookId), userEmail || '').changes;
  const b = _deleteBookCache.run(parseInt(bookId), userEmail || '').changes;
  return c + b;
}

// ── Delta-Cache: Buch-Review (Kapitelanalyse + Single-Pass-Review) ────────────
// Spart bei grossen Büchern den Kapitelanalyse-Call, wenn pages_sig identisch
// (page_id:updated_at + Prompt-Vars). chapterKey-Format identisch zum Extract-
// Cache: '<chapter_id>(__sub<N>)?' oder '__singlepass__'.
const _loadChapterReviewCache = db.prepare(
  `SELECT review_json FROM chapter_review_cache
   WHERE book_id = ? AND user_email = ? AND chapter_id = ? AND phase = ? AND provider = ? AND pages_sig = ?`
);
const _saveChapterReviewCache = db.prepare(
  `INSERT OR REPLACE INTO chapter_review_cache
   (book_id, user_email, chapter_id, phase, provider, pages_sig, review_json, cached_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);
const _loadBookReviewCache = db.prepare(
  `SELECT review_json FROM book_review_cache
   WHERE book_id = ? AND user_email = ? AND provider = ? AND pages_sig = ?`
);
const _saveBookReviewCache = db.prepare(
  `INSERT OR REPLACE INTO book_review_cache
   (book_id, user_email, provider, pages_sig, review_json, cached_at)
   VALUES (?, ?, ?, ?, ?, ?)`
);

function loadChapterReviewCache(bookId, userEmail, chapterKey, pagesSig, provider = '') {
  const parsed = _parseChapterKey(chapterKey);
  if (!parsed || parsed.book) return null;
  const row = _loadChapterReviewCache.get(
    parseInt(bookId), userEmail || '', parsed.chapterId, parsed.phase, provider || '', pagesSig
  );
  if (!row) return null;
  try { return JSON.parse(row.review_json); } catch { return null; }
}

function saveChapterReviewCache(bookId, userEmail, chapterKey, pagesSig, review, provider = '') {
  const parsed = _parseChapterKey(chapterKey);
  if (!parsed || parsed.book) return;
  const email = _requireUserEmail(userEmail, 'saveChapterReviewCache');
  _saveChapterReviewCache.run(
    parseInt(bookId), email, parsed.chapterId, parsed.phase, provider || '',
    pagesSig, JSON.stringify(review), new Date().toISOString(),
  );
}

function loadBookReviewCache(bookId, userEmail, pagesSig, provider = '') {
  const row = _loadBookReviewCache.get(parseInt(bookId), userEmail || '', provider || '', pagesSig);
  if (!row) return null;
  try { return JSON.parse(row.review_json); } catch { return null; }
}

function saveBookReviewCache(bookId, userEmail, pagesSig, review, provider = '') {
  const email = _requireUserEmail(userEmail, 'saveBookReviewCache');
  _saveBookReviewCache.run(
    parseInt(bookId), email, provider || '', pagesSig,
    JSON.stringify(review), new Date().toISOString(),
  );
}

const _deleteChapterReviewCache = db.prepare(
  `DELETE FROM chapter_review_cache WHERE book_id = ? AND user_email = ?`
);
const _deleteBookReviewCache = db.prepare(
  `DELETE FROM book_review_cache WHERE book_id = ? AND user_email = ?`
);

function deleteReviewCache(bookId, userEmail) {
  const c = _deleteChapterReviewCache.run(parseInt(bookId), userEmail || '').changes;
  const b = _deleteBookReviewCache.run(parseInt(bookId), userEmail || '').changes;
  return c + b;
}

// ── Delta-Cache: Kapitel-Makro-Review (kapitel.js) ────────────────────────────
// Single-Row pro Kapitel (Endergebnis). Sub-Chunk-Caches der Multi-Pass-Variante
// werden bewusst NICHT gecached (sehr seltener Fall, eigene Tabelle wäre Overhead).
const _loadChapterMacroReviewCache = db.prepare(
  `SELECT review_json FROM chapter_macro_review_cache
   WHERE book_id = ? AND user_email = ? AND chapter_id = ? AND provider = ? AND pages_sig = ?`
);
const _saveChapterMacroReviewCache = db.prepare(
  `INSERT OR REPLACE INTO chapter_macro_review_cache
   (book_id, user_email, chapter_id, provider, pages_sig, review_json, cached_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);
const _deleteChapterMacroReviewCache = db.prepare(
  `DELETE FROM chapter_macro_review_cache WHERE book_id = ? AND user_email = ?`
);

function loadChapterMacroReviewCache(bookId, userEmail, chapterId, pagesSig, provider = '') {
  const row = _loadChapterMacroReviewCache.get(
    parseInt(bookId), userEmail || '', parseInt(chapterId), provider || '', pagesSig
  );
  if (!row) return null;
  try { return JSON.parse(row.review_json); } catch { return null; }
}

function saveChapterMacroReviewCache(bookId, userEmail, chapterId, pagesSig, review, provider = '') {
  const email = _requireUserEmail(userEmail, 'saveChapterMacroReviewCache');
  _saveChapterMacroReviewCache.run(
    parseInt(bookId), email, parseInt(chapterId), provider || '',
    pagesSig, JSON.stringify(review), new Date().toISOString(),
  );
}

function deleteChapterMacroReviewCache(bookId, userEmail) {
  return _deleteChapterMacroReviewCache.run(parseInt(bookId), userEmail || '').changes;
}

// ── Delta-Cache: Synonym-Suche (synonyme.js) ──────────────────────────────────
// Key-Hash deckt wort + satz + buchtyp + locale + cacheVersion ab. Pro User.
const _loadSynonymCache = db.prepare(
  `SELECT result_json FROM synonym_cache WHERE user_email = ? AND provider = ? AND key_hash = ?`
);
const _saveSynonymCache = db.prepare(
  `INSERT OR REPLACE INTO synonym_cache (user_email, provider, key_hash, result_json, cached_at)
   VALUES (?, ?, ?, ?, ?)`
);
const _deleteSynonymCache = db.prepare(`DELETE FROM synonym_cache WHERE user_email = ?`);

function loadSynonymCache(userEmail, keyHash, provider = '') {
  const row = _loadSynonymCache.get(userEmail || '', provider || '', keyHash);
  if (!row) return null;
  try { return JSON.parse(row.result_json); } catch { return null; }
}

function saveSynonymCache(userEmail, keyHash, result, provider = '') {
  const email = _requireUserEmail(userEmail, 'saveSynonymCache');
  _saveSynonymCache.run(email, provider || '', keyHash, JSON.stringify(result), new Date().toISOString());
}

function deleteSynonymCache(userEmail) {
  return _deleteSynonymCache.run(userEmail || '').changes;
}

// ── Delta-Cache: Seiten-Lektorat (lektorat.js Single + Batch) ─────────────────
// Single-Row pro Seite. ctx_sig deckt updated_at, Kapitelkontext (figuren/orte/
// beziehungen), narrative, Stopwords/Regeln und cacheVersion ab.
const _loadLektoratCache = db.prepare(
  `SELECT result_json FROM lektorat_cache
   WHERE book_id = ? AND user_email = ? AND page_id = ? AND provider = ? AND ctx_sig = ?`
);
const _saveLektoratCache = db.prepare(
  `INSERT OR REPLACE INTO lektorat_cache
   (book_id, user_email, page_id, provider, ctx_sig, result_json, cached_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);
const _deleteLektoratCache = db.prepare(
  `DELETE FROM lektorat_cache WHERE book_id = ? AND user_email = ?`
);

function loadLektoratCache(bookId, userEmail, pageId, ctxSig, provider = '') {
  const row = _loadLektoratCache.get(
    parseInt(bookId), userEmail || '', parseInt(pageId), provider || '', ctxSig
  );
  if (!row) return null;
  try { return JSON.parse(row.result_json); } catch { return null; }
}

function saveLektoratCache(bookId, userEmail, pageId, ctxSig, result, provider = '') {
  const email = _requireUserEmail(userEmail, 'saveLektoratCache');
  _saveLektoratCache.run(
    parseInt(bookId), email, parseInt(pageId), provider || '',
    ctxSig, JSON.stringify(result), new Date().toISOString(),
  );
}

function deleteLektoratCache(bookId, userEmail) {
  return _deleteLektoratCache.run(parseInt(bookId), userEmail || '').changes;
}

// ── Delta-Cache: Finetune-AI-Augmentation ─────────────────────────────────────
// Cache-Key: (book_id, user_email, scope, scope_key, version).
// scope: 'reverse-prompts' | 'fact-qa' | 'reasoning-backfill'
// scope_key: stabile Entität (z.B. 'page:42', 'figure:alice', 'corr:hash')
// sig: Inhalts-Signatur (z.B. content-Hash + Modellname). Bei sig-Mismatch wird
// der Eintrag verworfen — das verhindert Stale-Augmentations bei Textänderung.
const _loadFtAiCache = db.prepare(
  `SELECT result_json, sig FROM finetune_ai_cache
   WHERE book_id = ? AND user_email = ? AND scope = ? AND scope_key = ? AND version = ?`
);
const _saveFtAiCache = db.prepare(
  `INSERT OR REPLACE INTO finetune_ai_cache
   (book_id, user_email, scope, scope_key, sig, version, result_json, cached_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);
const _deleteFtAiCache = db.prepare(
  `DELETE FROM finetune_ai_cache WHERE book_id = ? AND user_email = ?`
);

function loadFinetuneAiCache(bookId, userEmail, scope, scopeKey, sig, version) {
  const row = _loadFtAiCache.get(parseInt(bookId), userEmail || '', scope, scopeKey, version);
  if (!row) return null;
  if (row.sig !== sig) return null;
  try { return JSON.parse(row.result_json); } catch { return null; }
}

function saveFinetuneAiCache(bookId, userEmail, scope, scopeKey, sig, version, result) {
  const email = _requireUserEmail(userEmail, `saveFinetuneAiCache(${scope})`);
  _saveFtAiCache.run(
    parseInt(bookId), email, scope, scopeKey, sig, version,
    JSON.stringify(result), new Date().toISOString(),
  );
}

function deleteFinetuneAiCache(bookId, userEmail) {
  return _deleteFtAiCache.run(parseInt(bookId), userEmail || '').changes;
}

module.exports = {
  loadChapterExtractCache,
  saveChapterExtractCache,
  deleteChapterExtractCache,
  loadChapterReviewCache,
  saveChapterReviewCache,
  loadBookReviewCache,
  saveBookReviewCache,
  deleteReviewCache,
  loadChapterMacroReviewCache,
  saveChapterMacroReviewCache,
  deleteChapterMacroReviewCache,
  loadSynonymCache,
  saveSynonymCache,
  deleteSynonymCache,
  loadLektoratCache,
  saveLektoratCache,
  deleteLektoratCache,
  loadFinetuneAiCache,
  saveFinetuneAiCache,
  deleteFinetuneAiCache,
};
