'use strict';
// Lädt Kapitel + Seiten eines BookStack-Buchs und gruppiert sie für Export-/
// Render-Pipelines. Ergibt eine Liste von { chapterId, chapter, pages }.
// Ursprünglich Teil von routes/export.js — extrahiert, damit der PDF-Renderer
// (lib/pdf-render.js) die gleiche Datenstruktur konsumieren kann.

const { bsGet, bsGetAll } = require('./bookstack');

async function loadBookContents(bookId, token) {
  const [chapters, pages] = await Promise.all([
    bsGetAll('chapters?filter[book_id]=' + bookId, token),
    bsGetAll('pages?filter[book_id]=' + bookId, token),
  ]);
  if (!pages.length) {
    const err = new Error('BOOK_EMPTY');
    err.code = 'BOOK_EMPTY';
    throw err;
  }

  const sortedChapters = [...chapters].sort((a, b) => a.priority - b.priority);
  const chapterOrder = Object.fromEntries(sortedChapters.map((c, i) => [c.id, i]));
  const sortedPages = [...pages].sort((a, b) => {
    const aO = a.chapter_id ? (chapterOrder[a.chapter_id] ?? 999) : -1;
    const bO = b.chapter_id ? (chapterOrder[b.chapter_id] ?? 999) : -1;
    if (aO !== bO) return aO - bO;
    return a.priority - b.priority;
  });

  const pageDetails = await Promise.all(
    sortedPages.map(p => bsGet('pages/' + p.id, token).catch(() => null))
  );
  const valid = sortedPages
    .map((p, i) => ({ p, pd: pageDetails[i] }))
    .filter(x => x.pd && x.pd.html);
  if (!valid.length) {
    const err = new Error('BOOK_EMPTY');
    err.code = 'BOOK_EMPTY';
    throw err;
  }

  const groups = [];
  let cur = null;
  for (const x of valid) {
    if (x.p.chapter_id) {
      if (!cur || cur.chapterId !== x.p.chapter_id) {
        cur = {
          chapterId: x.p.chapter_id,
          chapter: sortedChapters.find(c => c.id === x.p.chapter_id) || null,
          pages: [],
        };
        groups.push(cur);
      }
      cur.pages.push(x);
    } else {
      groups.push({ chapterId: null, chapter: null, pages: [x] });
      cur = null;
    }
  }
  return { groups };
}

module.exports = { loadBookContents };
