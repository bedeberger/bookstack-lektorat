'use strict';
const express = require('express');
const { db } = require('../../db/schema');
const {
  makeJobLogger, updateJob, completeJob, failJob,
  aiCall, getPrompts, getBookPrompts,
  loadPageContents, groupByChapter, buildSinglePassBookText,
  bsGetAll, SINGLE_PASS_LIMIT, BATCH_SIZE, jobAbortControllers, settledAll,
  _modelName, fmtTok, tps,
  jobs, runningJobs, createJob, enqueueJob, jobKey,
  jsonBody,
} = require('./shared');

const reviewRouter = express.Router();

// ── Job: Buchbewertung ────────────────────────────────────────────────────────
async function runReviewJob(jobId, bookId, bookName, userEmail, userToken) {
  const logger = makeJobLogger(jobId);
  const { buildBookReviewSinglePassPrompt, buildChapterAnalysisPrompt, buildBookReviewMultiPassPrompt, SCHEMA_REVIEW, SCHEMA_CHAPTER_ANALYSIS } = await getPrompts();
  const { SYSTEM_BUCHBEWERTUNG, SYSTEM_KAPITELANALYSE } = await getBookPrompts(bookId);
  try {
    updateJob(jobId, { statusText: 'Lade Seiten…', progress: 0 });
    const [chaptersData, pages] = await Promise.all([
      bsGetAll('chapters?book_id=' + bookId, userToken),
      bsGetAll('pages?book_id=' + bookId, userToken),
    ]);

    if (!pages.length) { completeJob(jobId, { empty: true }); return; }

    const chMap = Object.fromEntries(chaptersData.map(c => [c.id, c.name]));
    const tok = { in: 0, out: 0, ms: 0 }; // akkumulierte Token über alle KI-Calls
    logger.info(`Start: «${bookName}» (book=${bookId}, ${pages.length} Seiten)`);
    const pageContents = await loadPageContents(pages, chMap, 50, (i, total) => {
      updateJob(jobId, {
        progress: Math.round((i / total) * 60),
        statusText: `Lese ${i + 1}–${Math.min(i + BATCH_SIZE, total)} von ${total} Seiten…`,
      });
    }, userToken, jobAbortControllers.get(jobId)?.signal);

    updateJob(jobId, { progress: 65 });
    const { groupOrder, groups } = groupByChapter(pageContents);
    const totalChars = pageContents.reduce((s, p) => s + p.text.length, 0);
    let r;

    if (totalChars <= SINGLE_PASS_LIMIT) {
      updateJob(jobId, { progress: 65, statusText: 'KI analysiert das Buch…' });
      const bookText = buildSinglePassBookText(groups, groupOrder);

      r = await aiCall(jobId, tok,
        buildBookReviewSinglePassPrompt(bookName, pageContents.length, bookText),
        SYSTEM_BUCHBEWERTUNG,
        65, 97, 5000, 0.2, null, undefined, SCHEMA_REVIEW,
      );
    } else {
      const chapterAnalyses = [];
      let completed = 0;

      const thunks = groupOrder.map((key, gi) => async () => {
        if (jobAbortControllers.get(jobId)?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const group = groups.get(key);
        const fromPct = 65 + Math.round((gi / groupOrder.length) * 25);
        const toPct   = 65 + Math.round(((gi + 1) / groupOrder.length) * 25);
        updateJob(jobId, {
          progress: fromPct,
          statusText: `Analysiere ${gi + 1}/${groupOrder.length}: «${group.name}»…`,
        });
        const chText = group.pages.map(p => `### ${p.title}\n${p.text}`).join('\n\n---\n\n');
        const ca = await aiCall(jobId, tok,
          buildChapterAnalysisPrompt(group.name, bookName, group.pages.length, chText),
          SYSTEM_KAPITELANALYSE,
          fromPct, toPct, 1500, 0.2, null, undefined, SCHEMA_CHAPTER_ANALYSIS,
        );
        completed++;
        logger.info(`[${completed}/${groupOrder.length}] «${group.name}» analysiert (${group.pages.length} Seiten)`);
        return { name: group.name, pageCount: group.pages.length, ...ca };
      });

      const results = await settledAll(thunks);
      for (const result of results) {
        if (result.status === 'rejected') throw result.reason;
        chapterAnalyses.push(result.value);
      }

      updateJob(jobId, {
        progress: 90,
        statusText: `KI erstellt Gesamtbewertung…`,
      });
      r = await aiCall(jobId, tok,
        buildBookReviewMultiPassPrompt(bookName, chapterAnalyses, pageContents.length),
        SYSTEM_BUCHBEWERTUNG,
        90, 97, 5000, 0.2, null, undefined, SCHEMA_REVIEW,
      );
    }

    if (r?.gesamtnote == null) throw new Error('KI-Antwort ungültig: gesamtnote fehlt');

    const model = _modelName(process.env.API_PROVIDER || 'claude');
    db.prepare('INSERT INTO book_reviews (book_id, book_name, reviewed_at, review_json, model, user_email) VALUES (?, ?, ?, ?, ?, ?)')
      .run(parseInt(bookId), bookName || null, new Date().toISOString(), JSON.stringify(r), model, userEmail || null);

    completeJob(jobId, { review: r, pageCount: pageContents.length, tokensIn: tok.in, tokensOut: tok.out }, tps(tok));
    logger.info(`«${bookName}» fertig (book=${bookId}, ${pageContents.length} Seiten, Note ${r.gesamtnote}, ${fmtTok(tok.in)}↑ ${fmtTok(tok.out)}↓ Tokens)`);
  } catch (e) {
    logger.error(`Fehler (book=${bookId}): ${e.message}`);
    failJob(jobId, e);
  }
}

// ── Route ─────────────────────────────────────────────────────────────────────
reviewRouter.post('/review', jsonBody, (req, res) => {
  const { book_id, book_name } = req.body;
  if (!book_id) return res.status(400).json({ error: 'book_id fehlt' });
  const userEmail = req.session?.user?.email || null;
  const userToken = req.session?.bookstackToken ? { id: req.session.bookstackToken.id, pw: req.session.bookstackToken.pw } : null;
  const existing = runningJobs.get(jobKey('review', book_id, userEmail));
  if (existing && jobs.has(existing)) return res.json({ jobId: existing, existing: true });
  const label = book_name ? `Buchbewertung · ${book_name}` : `Buchbewertung`;
  const jobId = createJob('review', book_id, userEmail, label);
  enqueueJob(jobId, () => runReviewJob(jobId, book_id, book_name || '', userEmail, userToken));
  res.json({ jobId });
});

module.exports = { reviewRouter };
