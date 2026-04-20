'use strict';
const express = require('express');
const { db, getBookSettings } = require('../../db/schema');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  aiCall, getPrompts, getBookPrompts,
  loadPageContents, groupByChapter, buildSinglePassBookText,
  bsGetAll, SINGLE_PASS_LIMIT, BATCH_SIZE, jobAbortControllers, settledAll,
  _modelName, fmtTok, tps,
  jobs, runningJobs, createJob, enqueueJob, jobKey,
  jsonBody,
} = require('./shared');
const { narrativeLabels } = require('./narrative-labels');

const reviewRouter = express.Router();

// ── Job: Buchbewertung ────────────────────────────────────────────────────────
async function runReviewJob(jobId, bookId, bookName, userEmail, userToken) {
  const logger = makeJobLogger(jobId);
  const { buildBookReviewSinglePassPrompt, buildChapterAnalysisPrompt, buildBookReviewMultiPassPrompt, SCHEMA_REVIEW, SCHEMA_CHAPTER_ANALYSIS } = await getPrompts();
  const { SYSTEM_BUCHBEWERTUNG, SYSTEM_KAPITELANALYSE } = await getBookPrompts(bookId, userEmail);
  const narrative = narrativeLabels(getBookSettings(bookId, userEmail));
  try {
    updateJob(jobId, { statusText: 'job.phase.loadingPages', progress: 0 });
    const [chaptersData, pages] = await Promise.all([
      bsGetAll('chapters?filter[book_id]=' + bookId, userToken),
      bsGetAll('pages?filter[book_id]=' + bookId, userToken),
    ]);

    if (!pages.length) { completeJob(jobId, { empty: true }); return; }

    const chMap = Object.fromEntries(chaptersData.map(c => [c.id, c.name]));
    const tok = { in: 0, out: 0, ms: 0 }; // akkumulierte Token über alle KI-Calls
    logger.info(`Start: «${bookName}» (book=${bookId}, ${pages.length} Seiten)`);
    const pageContents = await loadPageContents(pages, chMap, 50, (i, total) => {
      updateJob(jobId, {
        progress: Math.round((i / total) * 60),
        statusText: 'job.phase.readingPages',
        statusParams: { from: i + 1, to: Math.min(i + BATCH_SIZE, total), total },
      });
    }, userToken, jobAbortControllers.get(jobId)?.signal);

    updateJob(jobId, { progress: 65 });
    const { groupOrder, groups } = groupByChapter(pageContents);
    const totalChars = pageContents.reduce((s, p) => s + p.text.length, 0);
    let r;

    if (totalChars <= SINGLE_PASS_LIMIT) {
      updateJob(jobId, { progress: 65, statusText: 'job.phase.aiBookReview' });
      const bookText = buildSinglePassBookText(groups, groupOrder);

      r = await aiCall(jobId, tok,
        buildBookReviewSinglePassPrompt(bookName, pageContents.length, bookText, narrative),
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
          statusText: 'job.phase.analyzing',
          statusParams: { current: gi + 1, total: groupOrder.length, name: group.name },
        });
        const chText = group.pages.map(p => `### ${p.title}\n${p.text}`).join('\n\n---\n\n');
        const ca = await aiCall(jobId, tok,
          buildChapterAnalysisPrompt(group.name, bookName, group.pages.length, chText, narrative),
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
        statusText: 'job.phase.finalReview',
      });
      r = await aiCall(jobId, tok,
        buildBookReviewMultiPassPrompt(bookName, chapterAnalyses, pageContents.length, narrative),
        SYSTEM_BUCHBEWERTUNG,
        90, 97, 5000, 0.2, null, undefined, SCHEMA_REVIEW,
      );
    }

    if (r?.gesamtnote == null) throw i18nError('job.error.gesamtnoteMissing');

    const model = _modelName(process.env.API_PROVIDER || 'claude');
    db.prepare('INSERT INTO book_reviews (book_id, book_name, reviewed_at, review_json, model, user_email) VALUES (?, ?, ?, ?, ?, ?)')
      .run(parseInt(bookId), bookName || null, new Date().toISOString(), JSON.stringify(r), model, userEmail || null);

    completeJob(jobId, { review: r, pageCount: pageContents.length, tokensIn: tok.in, tokensOut: tok.out }, tps(tok));
    logger.info(`«${bookName}» fertig (book=${bookId}, ${pageContents.length} Seiten, Note ${r.gesamtnote}, ${fmtTok(tok.in)}↑ ${fmtTok(tok.out)}↓ Tokens)`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Fehler (book=${bookId}): ${e.message}`);
    failJob(jobId, e);
  }
}

// ── Route ─────────────────────────────────────────────────────────────────────
reviewRouter.post('/review', jsonBody, (req, res) => {
  const { book_id, book_name } = req.body;
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  const userEmail = req.session?.user?.email || null;
  const userToken = req.session?.bookstackToken ? { id: req.session.bookstackToken.id, pw: req.session.bookstackToken.pw } : null;
  const existing = runningJobs.get(jobKey('review', book_id, userEmail));
  if (existing && jobs.has(existing)) return res.json({ jobId: existing, existing: true });
  const label = book_name ? 'job.label.reviewBook' : 'job.label.review';
  const labelParams = book_name ? { name: book_name } : null;
  const jobId = createJob('review', book_id, userEmail, label, labelParams);
  enqueueJob(jobId, () => runReviewJob(jobId, book_id, book_name || '', userEmail, userToken));
  res.json({ jobId });
});

module.exports = { reviewRouter };
