'use strict';
const express = require('express');
const { db } = require('../../../db/schema');
const { toIntId, inClause } = require('../../../lib/validate');
const { jobs, jobQueue } = require('./state');
const {
  cancelJob, findActiveJobId, fmtTok, fmtDuration,
  JOB_TYPE_LABELS, STATS_EXCLUDED_TYPES,
} = require('./jobs');

// ── Shared-Router: Job-Status, Queue, Statistiken ─────────────────────────────
// Diese Routen sind job-typ-übergreifend und müssen NACH allen Feature-Routen gemountet werden,
// weil GET /:id und DELETE /:id als Catch-All wirken.
const sharedRouter = express.Router();

sharedRouter.get('/queue', (req, res) => {
  const userEmail = req.session?.user?.email || null;
  const result = [];
  for (const [, job] of jobs) {
    if (job.userEmail !== userEmail) continue;
    if (job.status !== 'queued' && job.status !== 'running') continue;
    let statusText = job.statusText;
    let statusParams = job.statusParams;
    if (job.status === 'queued') {
      const pos = jobQueue.findIndex(e => e.jobId === job.id) + 1;
      statusText = pos > 0 ? 'job.queuedPos' : 'job.queued';
      statusParams = pos > 0 ? { pos } : null;
    }
    result.push({
      id: job.id,
      type: job.type,
      bookId: job.bookId,
      dedupId: job.dedupId,
      label: job.label || job.type,
      labelParams: job.labelParams || null,
      status: job.status,
      progress: job.progress,
      statusText,
      statusParams,
      tokensIn: job.tokensIn || 0,
      tokensOut: job.tokensOut || 0,
      maxTokensOut: job.maxTokensOut || 0,
      tokensPerSec: job.tokensPerSec || 0,
      canCancel: true,
    });
  }
  res.json(result);
});

sharedRouter.get('/stats', (req, res) => {
  const userEmail = req.session?.user?.email || null;
  const { sql: excludedSql, values: excludedVals } = inClause(STATS_EXCLUDED_TYPES);
  const bookId = toIntId(req.query.book_id);
  const bookClause = bookId ? ' AND book_id = ?' : '';
  const params = bookId
    ? [userEmail, bookId, ...excludedVals]
    : [userEmail, ...excludedVals];
  const rows = db.prepare(`
    SELECT
      type,
      SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS count,
      AVG(CASE WHEN status = 'done' AND started_at IS NOT NULL AND ended_at IS NOT NULL
          THEN (julianday(ended_at) - julianday(started_at)) * 86400 ELSE NULL END) AS avgDuration,
      MAX(CASE WHEN status = 'done' THEN ended_at ELSE NULL END) AS lastRun,
      AVG(CASE WHEN status = 'done' THEN tokens_in  ELSE NULL END) AS avgTokensIn,
      AVG(CASE WHEN status = 'done' THEN tokens_out ELSE NULL END) AS avgTokensOut,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errorCount
    FROM job_runs
    WHERE user_email = ?${bookClause} AND type NOT IN ${excludedSql}
    GROUP BY type
    ORDER BY lastRun IS NULL, lastRun DESC
  `).all(...params);

  const result = rows.map(r => ({
    type:         r.type,
    typeLabel:    JOB_TYPE_LABELS[r.type] || r.type,
    count:        r.count || 0,
    errorCount:   r.errorCount || 0,
    avgDurationFmt: fmtDuration(r.avgDuration),
    lastRun:      r.lastRun || null,
    avgTokensIn:  r.avgTokensIn != null ? Math.round(r.avgTokensIn) : null,
    avgTokensOut: r.avgTokensOut != null ? Math.round(r.avgTokensOut) : null,
    avgTokensFmt: r.avgTokensIn != null
      ? fmtTok(Math.round((r.avgTokensIn || 0) + (r.avgTokensOut || 0)))
      : '—',
  }));
  res.json(result);
});

sharedRouter.get('/last-run', (req, res) => {
  const { type } = req.query;
  const bookId = toIntId(req.query.book_id);
  if (!type || !bookId) return res.status(400).json({ error_code: 'TYPE_BOOKID_REQUIRED' });
  const userEmail = req.session?.user?.email || null;
  const row = db.prepare(`
    SELECT ended_at FROM job_runs
    WHERE type = ? AND book_id = ? AND user_email = ? AND status = 'done'
    ORDER BY ended_at DESC LIMIT 1
  `).get(type, bookId, userEmail);
  res.json({ lastRun: row?.ended_at || null });
});

// Einzelne Job-Läufe pro Typ — für Drill-Down in jobStats-Tabelle.
// Liefert die letzten N Runs (default 20) für (user, book, type).
sharedRouter.get('/runs', (req, res) => {
  const userEmail = req.session?.user?.email || null;
  const bookId = toIntId(req.query.book_id);
  const type = req.query.type;
  if (!type || !bookId) return res.status(400).json({ error_code: 'TYPE_BOOKID_REQUIRED' });
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  const rows = db.prepare(`
    SELECT job_id, status, queued_at, started_at, ended_at,
           tokens_in, tokens_out, error, error_params,
           CASE WHEN started_at IS NOT NULL AND ended_at IS NOT NULL
                THEN (julianday(ended_at) - julianday(started_at)) * 86400
                ELSE NULL END AS duration
    FROM job_runs
    WHERE user_email = ? AND book_id = ? AND type = ?
    ORDER BY COALESCE(ended_at, started_at, queued_at) DESC
    LIMIT ?
  `).all(userEmail, bookId, type, limit);
  res.json(rows.map(r => {
    let errorParams = null;
    if (r.error_params) {
      try { errorParams = JSON.parse(r.error_params); } catch { /* ignore corrupt JSON */ }
    }
    return {
      jobId:       r.job_id,
      status:      r.status,
      queuedAt:    r.queued_at,
      startedAt:   r.started_at,
      endedAt:     r.ended_at,
      durationFmt: fmtDuration(r.duration),
      tokensIn:    r.tokens_in || 0,
      tokensOut:   r.tokens_out || 0,
      tokensFmt:   fmtTok((r.tokens_in || 0) + (r.tokens_out || 0)),
      error:       r.error || null,
      errorParams,
    };
  }));
});

sharedRouter.get('/active', (req, res) => {
  const { type, book_id, page_id } = req.query;
  const entityId = page_id || book_id;
  if (!type || !entityId) return res.status(400).json({ error_code: 'TYPE_ENTITY_REQUIRED' });
  const userEmail = req.session?.user?.email || null;
  const jobId = findActiveJobId(type, entityId, userEmail);
  if (!jobId) return res.json({ jobId: null });
  const job = jobs.get(jobId);
  res.json({ jobId: job.id, status: job.status, progress: job.progress, statusText: job.statusText, statusParams: job.statusParams });
});

sharedRouter.delete('/:id', (req, res) => {
  const userEmail = req.session?.user?.email || null;
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error_code: 'JOB_NOT_FOUND' });
  const ok = cancelJob(req.params.id, userEmail);
  if (!ok) return res.status(400).json({ error_code: 'JOB_CANCEL_FAILED', params: { status: job.status } });
  res.json({ ok: true });
});

sharedRouter.get('/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error_code: 'JOB_NOT_FOUND' });
  let statusText = job.statusText;
  let statusParams = job.statusParams;
  if (job.status === 'queued') {
    const pos = jobQueue.findIndex(e => e.jobId === job.id) + 1;
    statusText = pos > 0 ? 'job.queuedPos' : 'job.queued';
    statusParams = pos > 0 ? { pos } : null;
  }
  res.json({
    id: job.id, type: job.type, status: job.status,
    bookId: job.bookId, dedupId: job.dedupId,
    progress: job.progress, statusText, statusParams,
    label: job.label, labelParams: job.labelParams,
    tokensIn: job.tokensIn, tokensOut: job.tokensOut,
    // tokensIn ist cache-inklusiv (lib/ai/claude.js) und im agentischen Tool-Loop
    // über alle Provider-Calls aufsummiert — ohne den Cache-Anteil ist die Zahl
    // im Live-Status nicht einzuordnen.
    cacheReadIn: job.cacheReadIn || 0,
    maxTokensOut: job.maxTokensOut,
    tokensPerSec: job.tokensPerSec,
    result: job.result, error: job.error, errorParams: job.errorParams,
    passMode: job.passMode ?? null,
  });
});

module.exports = { sharedRouter };
