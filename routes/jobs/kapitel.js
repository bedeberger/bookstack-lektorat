'use strict';
const express = require('express');
const { db, getBookSettings } = require('../../db/schema');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  aiCall, getPrompts, getBookPrompts,
  bsGet, bsGetAll, jobAbortControllers,
  htmlToText,
  _modelName, fmtTok, tps,
  jobs, runningJobs, createJob, enqueueJob, jobKey,
  jsonBody, BATCH_SIZE,
} = require('./shared');
const { narrativeLabels } = require('./narrative-labels');

const kapitelRouter = express.Router();

// ── Job: Kapitel-Review (Makrobewertung eines einzelnen Kapitels) ────────────
async function runChapterReviewJob(jobId, bookId, chapterId, chapterName, bookName, userEmail, userToken) {
  const logger = makeJobLogger(jobId);
  const { buildChapterReviewPrompt, SCHEMA_CHAPTER_REVIEW } = await getPrompts();
  const { SYSTEM_KAPITELREVIEW } = await getBookPrompts(bookId, userEmail);
  const bookSettings = getBookSettings(bookId, userEmail);
  try {
    updateJob(jobId, { statusText: 'job.phase.loadingPages', progress: 0 });
    // Alle Buchseiten holen; Kapitel-Filter läuft clientseitig – BookStack
    // liefert in `/pages?filter[book_id]=` bereits `chapter_id` pro Seite.
    const allPages = await bsGetAll('pages?filter[book_id]=' + bookId, userToken);
    const pages = allPages
      .filter(p => String(p.chapter_id || '') === String(chapterId))
      .sort((a, b) => (a.priority || 0) - (b.priority || 0));

    if (!pages.length) { completeJob(jobId, { empty: true, chapterName }); return; }
    logger.info(`Start: Kapitel-Review «${chapterName}» (book=${bookId}, chap=${chapterId}, ${pages.length} Seiten)`);

    const tok = { in: 0, out: 0, ms: 0 };
    const signal = jobAbortControllers.get(jobId)?.signal;
    const contents = [];
    for (let i = 0; i < pages.length; i += BATCH_SIZE) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      updateJob(jobId, {
        progress: Math.round((i / pages.length) * 60),
        statusText: 'job.phase.readingPages',
        statusParams: { from: i + 1, to: Math.min(i + BATCH_SIZE, pages.length), total: pages.length },
      });
      const results = await Promise.allSettled(pages.slice(i, i + BATCH_SIZE).map(async p => {
        const pd = await bsGet('pages/' + p.id, userToken);
        const text = htmlToText(pd.html).trim();
        if (!text) return null;
        return { title: p.name, text };
      }));
      for (const r of results) if (r.status === 'fulfilled' && r.value) contents.push(r.value);
    }

    if (!contents.length) { completeJob(jobId, { empty: true, chapterName }); return; }

    const chText = contents.map(p => `### ${p.title}\n${p.text}`).join('\n\n---\n\n');

    updateJob(jobId, { progress: 65, statusText: 'job.phase.aiChapterReview' });
    const r = await aiCall(jobId, tok,
      buildChapterReviewPrompt(chapterName, bookName, contents.length, chText, narrativeLabels(bookSettings)),
      SYSTEM_KAPITELREVIEW,
      65, 97, 5000, 0.2, null, undefined, SCHEMA_CHAPTER_REVIEW,
    );

    if (r?.gesamtnote == null) throw i18nError('job.error.gesamtnoteMissing');

    const model = _modelName(process.env.API_PROVIDER || 'claude');
    db.prepare(`INSERT INTO chapter_reviews
      (book_id, book_name, chapter_id, chapter_name, reviewed_at, review_json, model, user_email)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(parseInt(bookId), bookName || null, parseInt(chapterId), chapterName || null,
        new Date().toISOString(), JSON.stringify(r), model, userEmail || null);

    completeJob(jobId, {
      review: r,
      chapterId: parseInt(chapterId),
      chapterName,
      pageCount: contents.length,
      tokensIn: tok.in,
      tokensOut: tok.out,
    }, tps(tok));
    logger.info(`«${chapterName}» fertig (book=${bookId}, chap=${chapterId}, ${contents.length} Seiten, Note ${r.gesamtnote}, ${fmtTok(tok.in)}↑ ${fmtTok(tok.out)}↓ Tokens)`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Fehler (book=${bookId}, chap=${chapterId}): ${e.message}`);
    failJob(jobId, e);
  }
}

// ── Route ─────────────────────────────────────────────────────────────────────
kapitelRouter.post('/chapter-review', jsonBody, (req, res) => {
  const { book_id, chapter_id, chapter_name, book_name } = req.body;
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  if (!chapter_id) return res.status(400).json({ error_code: 'CHAPTER_ID_REQUIRED' });
  const userEmail = req.session?.user?.email || null;
  const userToken = req.session?.bookstackToken
    ? { id: req.session.bookstackToken.id, pw: req.session.bookstackToken.pw }
    : null;
  // Dedup auf Kapitel-Ebene – parallele Reviews unterschiedlicher Kapitel sind ok.
  const existing = runningJobs.get(jobKey('chapter-review', chapter_id, userEmail));
  if (existing && jobs.has(existing)) return res.json({ jobId: existing, existing: true });
  const label = chapter_name ? 'job.label.chapterReviewChapter' : 'job.label.chapterReview';
  const labelParams = chapter_name ? { name: chapter_name } : null;
  const jobId = createJob('chapter-review', chapter_id, userEmail, label, labelParams);
  enqueueJob(jobId, () => runChapterReviewJob(
    jobId, book_id, chapter_id, chapter_name || '', book_name || '', userEmail, userToken,
  ));
  res.json({ jobId });
});

module.exports = { kapitelRouter };
