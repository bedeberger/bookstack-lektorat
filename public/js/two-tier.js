import { htmlToText } from './utils.js';

export const SINGLE_PASS_LIMIT = 60000;
const BATCH_SIZE = 5;

/**
 * Lädt die Beschreibungstexte aller Kapitel eines Buchs.
 *
 * @param {Function} bsGet     - BookStack-GET-Funktion (path → Promise<data>)
 * @param {Array}    chapters  - Kapitel-Objekte aus der BookStack-API (mind. id, name)
 * @param {number}   minLength - Mindestzeichenlänge; kürzere Einträge werden übersprungen
 * @returns {Promise<Array>}   { title, chapter_id, chapter, text, isChapterDesc: true }[]
 */
export async function loadChapterContents(bsGet, chapters, minLength) {
  const contents = [];
  for (const c of chapters) {
    try {
      const cd = await bsGet('chapters/' + c.id);
      const text = htmlToText(cd.description_html || '').trim();
      if (text.length < minLength) continue;
      contents.push({
        title: c.name,
        chapter_id: c.id,
        chapter: c.name,
        text,
        isChapterDesc: true,
      });
    } catch { /* ignorieren */ }
  }
  return contents;
}

/**
 * Fügt Kapitel-Beschreibungseinträge vor die Seiten des jeweiligen Kapitels ein.
 *
 * @param {Array} pageContents    - Ergebnis von loadPageContents
 * @param {Array} chapterDescs    - Ergebnis von loadChapterContents
 * @returns {Array}               Zusammengeführtes Array
 */
export function mergeWithChapterDescs(pageContents, chapterDescs) {
  const descMap = new Map(chapterDescs.map(c => [c.chapter_id, c]));
  const seen = new Set();
  const merged = [];
  for (const p of pageContents) {
    const cid = p.chapter_id;
    if (cid != null && !seen.has(cid) && descMap.has(cid)) {
      merged.push(descMap.get(cid));
      seen.add(cid);
    }
    merged.push(p);
  }
  // Kapitel ohne Seiten, die aber Text haben
  for (const [cid, cd] of descMap) {
    if (!seen.has(cid)) merged.push(cd);
  }
  return merged;
}

/**
 * Lädt alle Seiten eines Buchs als Textinhalt.
 *
 * @param {Function} bsGet        - BookStack-GET-Funktion (path → Promise<data>)
 * @param {Array}    pages        - Seitenliste aus der BookStack-API
 * @param {Object}   chMap        - chapter_id → Kapitelname
 * @param {number}   minLength    - Mindestzeichenlänge; kürzere Seiten werden übersprungen
 * @param {Function} onBatch      - Callback vor jedem Batch: (batchStartIndex, total)
 * @returns {Promise<Array>}      pageContents: { title, chapter_id, chapter, text }[]
 */
export async function loadPageContents(bsGet, pages, chMap, minLength, onBatch) {
  const contents = [];
  for (let i = 0; i < pages.length; i += BATCH_SIZE) {
    if (onBatch) onBatch(i, pages.length);
    const batch = pages.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(async p => {
      const pd = await bsGet('pages/' + p.id);
      const text = htmlToText(pd.html).trim();
      if (text.length < minLength) return null;
      return {
        title: p.name,
        chapter_id: p.chapter_id || null,
        chapter: p.chapter_id ? (chMap[p.chapter_id] || 'Kapitel') : null,
        text,
      };
    }));
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) contents.push(r.value);
    }
  }
  return contents;
}

/**
 * Gruppiert pageContents nach Kapitel für den Multi-Pass.
 *
 * @param {Array} pageContents
 * @returns {{ groupOrder: string[], groups: Map<string, {name, pages[]}> }}
 */
export function groupByChapter(pageContents) {
  const groupOrder = [];
  const groups = new Map();
  for (const p of pageContents) {
    const key = p.chapter_id != null ? String(p.chapter_id) : '__ungrouped__';
    if (!groups.has(key)) {
      groupOrder.push(key);
      groups.set(key, { name: p.chapter || 'Sonstige Seiten', pages: [] });
    }
    groups.get(key).pages.push(p);
  }
  return { groupOrder, groups };
}
