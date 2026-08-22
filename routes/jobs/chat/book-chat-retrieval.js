'use strict';
// Semantisches Retrieval für die zwei Buch-Chat-Pfade. Beide gehen über dieselbe
// geteilte Pipeline lib/semantic-retrieval.js#semanticQuery (Cosinus + Hybrid-RRF +
// optional Rerank) — exakt die, die auch das agentische Tool `search_similar` und
// die Such-Karte benutzen. Sie unterscheiden sich nur darin, WAS sie damit füllen:
//
//   selectPassagesSemantic — klassischer Pfad: füllt das ganze Text-Budget des
//     System-Prompts (ein bester Chunk pro Seite, breite Streuung über das Buch).
//   preContextPassages     — agentischer Pfad: ein KLEINER Erst-Kontext (wenige
//     Chunks, harter Zeichendeckel), der die häufigste Frageform („wie alt war X",
//     „wann hat X …") schon in Iteration 1 beantwortbar macht. Ohne ihn beginnt der
//     Agent bei JEDER Frage bei null und lädt im Zweifel ganze Kapitel nach — die
//     paar Tausend Tokens hier sind billiger als eine einzige get_chapter_text-Runde.
//
// Rein rückwärtsgewandt: findet Bestehendes, schreibt nie in den Buchtext.

const contentStore = require('../../../lib/content-store');
const appSettings = require('../../../lib/app-settings');
const { semanticQuery } = require('../../../lib/semantic-retrieval');
const { resolveEntityTitle } = require('../book-chat-tools/shared');
const { i18nError } = require('../shared');

// Mini-RAG-Retrieval für den klassischen Buch-Chat: zieht die semantisch relevantesten
// Chunk-Auszüge (ein bester Chunk pro Seite) und füllt damit das Text-Budget. Seiten-
// Metadaten (Name/Slug) werden einmal via listPages aufgelöst; der Chunk-Text kommt aus
// dem Index, es werden KEINE Seiten-Volltexte geladen. Gibt null zurück, wenn kein Index
// existiert bzw. die Anfrage keine Treffer liefert (Caller fällt dann auf Keyword-Scoring
// über alle Seiten zurück). Wirft nur bei Abort/Backend-Fehler.
async function selectPassagesSemantic(bookId, query, budgetChars, signal, userToken) {
  const topK = parseInt(appSettings.get('jobs.book_chat.rag_top_k'), 10) || 40;
  const hits = await semanticQuery(bookId, query, { kinds: ['page'], topK, signal });
  if (!hits.length) return null;

  let pages;
  try { pages = await contentStore.listPages(bookId, userToken); }
  catch (e) {
    if (e?.status) throw i18nError('job.error.contentStorePageList', { status: e.status });
    throw e;
  }
  const metaById = new Map(pages.map(p => [p.id, p]));

  const selectedPages = [];
  const seen = new Set();
  let usedChars = 0;
  for (const h of hits) {
    if (usedChars >= budgetChars) break;
    if (h.kind !== 'page' || seen.has(h.entity_id)) continue;
    const meta = metaById.get(h.entity_id);
    if (!meta) continue; // Seite gelöscht, Chunk noch im Index
    const text = String(h.text || '').slice(0, budgetChars - usedChars);
    if (text.length < 50) continue;
    seen.add(h.entity_id);
    selectedPages.push({ name: meta.name, id: meta.id, slug: meta.slug, book_slug: meta.book_slug, text });
    usedChars += text.length;
  }
  if (!selectedPages.length) return null;
  return { selectedPages, usedChars, totalPages: pages.length };
}

// Erst-Kontext des agentischen Buch-Chats. Anders als beim klassischen Pfad ist das
// KEIN Budget-Füllen: `pre_rag_top_k` Treffer, hart auf `pre_rag_chars` gedeckelt.
// top_k = 0 schaltet den Erst-Kontext ab (dann verhält sich der Agent wie vorher).
// Mehrere Chunks derselben Seite sind hier erlaubt — bei einer Faktenfrage stehen
// Frage und Antwort oft in benachbarten Passagen einer Seite.
// Rückgabe: { hits, chars } oder null (kein Index / keine Treffer / abgeschaltet).
async function preContextPassages(bookId, query, { signal } = {}) {
  const topK = parseInt(appSettings.get('jobs.book_chat.pre_rag_top_k'), 10);
  const budget = parseInt(appSettings.get('jobs.book_chat.pre_rag_chars'), 10);
  if (!(topK > 0) || !(budget > 0)) return null;

  const raw = await semanticQuery(bookId, query, { kinds: ['page', 'scene', 'figure'], topK, signal });
  if (!raw.length) return null;

  const hits = [];
  let chars = 0;
  for (const h of raw) {
    if (chars >= budget) break;
    const title = resolveEntityTitle(h.kind, h.entity_id);
    if (title == null) continue; // Entität gelöscht, Chunk noch im Index
    const text = String(h.text || '').slice(0, budget - chars);
    if (text.length < 50) continue;
    hits.push({
      kind: h.kind,
      entity_id: h.entity_id,
      title,
      score: Math.round(h.score * 1000) / 1000,
      text,
    });
    chars += text.length;
  }
  if (!hits.length) return null;
  return { hits, chars };
}

module.exports = { selectPassagesSemantic, preContextPassages };
