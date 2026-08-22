'use strict';
const { db } = require('../../../db/schema');
const { INPUT_BUDGET_CHARS, getContextConfigFor } = require('../../../lib/ai');
const contentStore = require('../../../lib/content-store');
const { inClause } = require('../../../lib/validate');
const { i18nError } = require('./jobs');
const { htmlToText } = require('./ai');

// Multi-Pass-Grenzen skalieren mit dem Input-Budget (context_window − max_tokens_out).
// SINGLE_PASS_LIMIT: Schwelle, ab der in Chunks zerlegt wird. 70% des Budgets für
//   Buchtext, 30% für System-Prompt + Schema + Output-Reserve.
// PER_CHUNK_LIMIT:   Max-Grösse eines einzelnen Chunks. Kleinere lokale Modelle
//   (Mistral Small u.ä.) verlieren bei grossen Inputs Extraktionsqualität;
//   Obergrenze 200K Zeichen kappt absurde Werte bei grossen Kontextfenstern.
// Untergrenzen (20K/10K Zeichen) verhindern zu kleine Pässe bei Misconfig.
// Boot-Konstanten lesen Claude-Defaults; per-Job-Pfade nutzen `chunkLimitsFor(provider)`,
// damit Ollama/Llama mit eigenen Kontextfenstern korrekt skaliert werden.
// SINGLE_PASS_CHAR_CEILING: Obergrenze hoch genug, dass Claudes 1M-Kontextfenster
//   (≈1.96M Zeichen Input-Budget) voll für Single-Pass genutzt wird – dann fährt
//   selbst ein dicker Gesellschaftsroman in einem Pass (voller auflösender Kontext,
//   keine Fakten-basierten False-Positives). Bei 200K-Kontext greift die 0.70-Formel
//   ohnehin lange vorher. Schützt nur gegen absurde Misconfig.
const SINGLE_PASS_CHAR_CEILING = 2000000;
const SINGLE_PASS_LIMIT = Math.max(20000, Math.min(SINGLE_PASS_CHAR_CEILING, Math.floor(INPUT_BUDGET_CHARS * 0.70)));
const PER_CHUNK_LIMIT   = Math.max(10000, Math.min(200000, Math.floor(INPUT_BUDGET_CHARS * 0.35)));
const BATCH_SIZE = 15;

// `maxTokensOut`: das Output-Cap, gegen das gerechnet wird. Ohne Angabe das provider-weite
// `ai.<p>.max_tokens_out` (= cfg.inputBudgetChars, bisheriges Verhalten). Ein Job, der seine
// Calls TIEFER deckelt, MUSS sein eigenes Cap einsetzen — sonst chunkt er gegen ein
// Input-Budget, das seine Calls nie reservieren, und zerlegt das Buch feiner als nötig.
// Konkret die Komplettanalyse: sie deckelt jeden Call auf `ai.komplett.extract_max_tokens`
// (phases/tokens.js#komplettMaxTokens), und genau dieser Wert landet als `maxTokensOut` im
// Preflight (routes/jobs/shared/ai.js#aiCall) — Chunk-Grenze und Preflight müssen dieselbe
// Rechnung machen. Für die Cloud-Klasse sind beide Werte identisch (komplettMaxTokens
// liefert dort das Provider-Ceiling) → dort keine Verhaltensänderung.
function chunkLimitsFor(provider, { maxTokensOut } = {}) {
  const cfg = getContextConfigFor(provider);
  const out = Number(maxTokensOut) > 0 ? Number(maxTokensOut) : cfg.maxTokensOut;
  // Floor identisch zu getContextConfigFor: ein inkonsistentes Cap darf das Budget nicht
  // negativ werden lassen.
  const budget = Math.max(2000, cfg.contextWindow - out - cfg.safetyMargin) * cfg.charsPerToken;
  return {
    singlePass: Math.max(20000, Math.min(SINGLE_PASS_CHAR_CEILING, Math.floor(budget * 0.70))),
    perChunk:   Math.max(10000, Math.min(200000, Math.floor(budget * 0.35))),
  };
}

// EXTRAKTIONS-Single-Pass-Schwelle, ENTKOPPELT von der Kontinuitäts-Schwelle
// (singlePassLimit). Ein grosses Kontextfenster (Opus 4.8 + 1M) lässt fast jedes Buch
// Single-Pass laufen — für die KONTINUITÄTSPRÜFUNG erwünscht (Cross-Chapter-Kontext im
// 1M-Fenster), für die EXTRAKTION aber recall-schädlich (ein Call soll ALLE Entitäten aus
// 700K+ Tokens aufzählen; kapitelweise Chunks + Gap-Pässe + Alias-Cluster erwischen den
// Long-Tail zuverlässiger). `extractCapChars` (ai.komplett.extract_single_pass_cap) kappt die
// Extraktion tiefer: 0 = keine Entkopplung (folgt singlePassLimit). Nie unter den
// 20000-Zeichen-Floor. Pure, testbar. */
function resolveExtractSinglePassLimit(singlePassLimit, extractCapChars) {
  const cap = Math.max(0, Number(extractCapChars) || 0);
  if (cap <= 0) return singlePassLimit;
  return Math.max(20000, Math.min(cap, singlePassLimit));
}

// Lädt Buch-Tree (book_order-Overlay angewandt) und liefert chMap mit
// hierarchischem Pfad ("Teil 1 › Kapitel 1"), chNameToId-Lookup (sowohl raw
// chapter_name als auch Pfad → id) und pages[] in echter Buchorganizer-
// Reihenfolge (depth-first). Ersetzt parallele listChapters+listPages-Pfade,
// die bucket-lokale pages.position interpretieren (Cross-Chapter-Order kaputt)
// und Sub-Kapitel als Geschwister flachen.
async function loadOrderedBookContents(bookId, userToken, { includeExcluded = false } = {}) {
  const tree = await contentStore.bookTree(bookId, userToken);
  const chMap = {};        // id → "Vorfahre › … › Kapitel"
  const chNameToId = {};   // raw chapter_name UND voller Pfad → id (AI-Output toleranter Lookup)
  const chaptersFlat = []; // [{ id, name, parent_id, path }] depth-first
  const pages = [];
  function walk(chapters, prefix, parentId) {
    for (const c of chapters) {
      // Ausgeschlossene Kapitel (chapters.excluded) komplett ueberspringen — inkl.
      // ihrer Unterkapitel (kein rekursiver walk). Betrifft Buchbewertung +
      // Komplettanalyse + Kontinuitaetscheck. Fassungen/Snapshots laufen nicht
      // ueber diesen Loader und behalten ausgeschlossene Kapitel.
      // Ausnahme: includeExcluded=true (Kapitel-Review) laedt den vollen Baum,
      // sodass ein direkt bewertetes Kapitel auch dann bewertbar ist, wenn es
      // (oder ein Vorfahre) ausgeschlossen ist — der Aufrufer filtert danach
      // auf die explizit angeforderten chapter_ids.
      if (c.excluded && !includeExcluded) continue;
      const path = prefix ? `${prefix} › ${c.name}` : c.name;
      chMap[c.id] = path;
      chNameToId[c.name] = c.id;
      chNameToId[path] = c.id;
      chaptersFlat.push({ id: c.id, name: c.name, parent_id: parentId, path });
      for (const p of (c.pages || [])) pages.push({ ...p, chapter_id: c.id });
      walk(c.subchapters || [], path, c.id);
    }
  }
  walk(tree.chapters || [], '', null);
  for (const p of (tree.topPages || [])) pages.push({ ...p, chapter_id: null });
  return { chMap, chNameToId, chaptersFlat, pages };
}

async function loadPageContents(pages, chMap, minLength, onBatch, userToken, signal = null) {
  // Vor-Filter via preview_text aus dem pages-Cache: wenn ein gespeicherter
  // Preview kürzer als minLength ist, ist auch der Volltext zu kurz und wir
  // sparen den BookStack-Roundtrip (oft 100+ leere Stub-Pages pro Buch).
  // Nur sinnvoll wenn minLength <= PREVIEW_CHARS (800) — sonst ist der Preview
  // kein zuverlässiger Indikator.
  let skipped = 0;
  let filteredPages = pages;
  if (minLength > 0 && minLength <= 800 && pages.length > 0) {
    try {
      const ids = pages.map(p => p.id);
      const { sql, values } = inClause(ids);
      const rows = db.prepare(
        `SELECT page_id, preview_text FROM pages WHERE page_id IN ${sql}`
      ).all(...values);
      const previewMap = new Map(rows.map(r => [r.page_id, r.preview_text || '']));
      filteredPages = pages.filter(p => {
        const prev = previewMap.get(p.id);
        // Nur skippen wenn Preview existiert UND nachweislich zu kurz.
        // Fehlender Preview = nicht entscheidbar → fetchen.
        if (prev != null && prev.length > 0 && prev.length < minLength) {
          skipped++;
          return false;
        }
        return true;
      });
    } catch (e) {
      filteredPages = pages;
    }
  }
  return contentStore.loadPagesBatch(filteredPages, userToken, {
    batchSize: BATCH_SIZE,
    onBatch,
    signal,
    onError: (_p, e) => {
      if (e.status) throw i18nError('job.error.contentStore', { status: e.status, text: e.bodyText });
      throw e;
    },
  }).then(loaded => loaded
    .map(pd => {
      const text = htmlToText(pd.html).trim();
      if (text.length < minLength) return null;
      return {
        id: pd.id,
        updated_at: pd.updated_at || '',
        title: pd.name,
        chapter_id: pd.chapter_id || null,
        chapter: pd.chapter_id ? (chMap[pd.chapter_id] || 'Kapitel') : null,
        text,
      };
    })
    .filter(Boolean));
}

function groupByChapter(pageContents) {
  const groupOrder = [], groups = new Map();
  for (const p of pageContents) {
    const key = p.chapter_id != null ? String(p.chapter_id) : '__ungrouped__';
    if (!groups.has(key)) { groupOrder.push(key); groups.set(key, { name: p.chapter || 'Sonstige Seiten', pages: [] }); }
    groups.get(key).pages.push(p);
  }
  return { groupOrder, groups };
}

/**
 * Teilt Kapitel-Gruppen in kleinere Chunks auf, wenn sie perChunkLimit überschreiten.
 * Nicht aufzuteilende Kapitel behalten ihren Original-Key (bestehende Cache-Einträge bleiben gültig).
 * Sub-Chunks erhalten den Key "${chapterKey}__sub${idx}".
 * Gibt { chunkOrder, chunks } zurück – gleiche Struktur wie groupByChapter, drop-in verwendbar.
 */
function splitGroupsIntoChunks(groups, groupOrder, perChunkLimit) {
  const chunkOrder = [], chunks = new Map();
  for (const key of groupOrder) {
    const group = groups.get(key);
    const totalChars = group.pages.reduce((s, p) => s + p.text.length, 0);
    if (totalChars <= perChunkLimit) {
      chunkOrder.push(key);
      chunks.set(key, group);
      continue;
    }
    let currentPages = [], currentChars = 0, subIdx = 0;
    for (const page of group.pages) {
      if (currentChars + page.text.length > perChunkLimit && currentPages.length > 0) {
        chunkOrder.push(`${key}__sub${subIdx}`);
        chunks.set(`${key}__sub${subIdx}`, { name: group.name, pages: currentPages });
        currentPages = []; currentChars = 0; subIdx++;
      }
      currentPages.push(page);
      currentChars += page.text.length;
    }
    if (currentPages.length > 0) {
      chunkOrder.push(`${key}__sub${subIdx}`);
      chunks.set(`${key}__sub${subIdx}`, { name: group.name, pages: currentPages });
    }
  }
  return { chunkOrder, chunks };
}

// Formatiert den Buchtext für Single-Pass-KI-Calls mit klarer Kapitelstruktur:
// ## Kapitelname als Abschnittsmarker, ### Seitentitel innerhalb.
// Die KI kann so kapitel-Felder zuverlässig aus dem ## Header ableiten.
function buildSinglePassBookText(groups, groupOrder) {
  return groupOrder
    .map(key => {
      const group = groups.get(key);
      return `## ${group.name}\n\n` +
        group.pages.map(p => `### ${p.title}\n${p.text}`).join('\n\n---\n\n');
    })
    .join('\n\n===\n\n');
}

module.exports = {
  SINGLE_PASS_LIMIT, PER_CHUNK_LIMIT, BATCH_SIZE, chunkLimitsFor, resolveExtractSinglePassLimit,
  loadOrderedBookContents,
  loadPageContents, groupByChapter, splitGroupsIntoChunks, buildSinglePassBookText,
};
