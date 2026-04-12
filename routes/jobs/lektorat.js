'use strict';
const express = require('express');
const { db } = require('../../db/schema');
const {
  makeJobLogger, updateJob, completeJob, failJob,
  aiCall, getPrompts, getBookPrompts,
  htmlToText, bsGetAll, jobAbortControllers,
  _modelName, fmtTok, tps, BS_URL,
  jobs, runningJobs, createJob, enqueueJob, jobKey,
  jsonBody,
} = require('./shared');

const lektoratRouter = express.Router();

// ── Job: Seiten-Lektorat ──────────────────────────────────────────────────────
async function runCheckJob(jobId, pageId, bookId, userEmail, userToken) {
  const logger = makeJobLogger(jobId);
  const { buildLektoratPrompt } = await getPrompts();
  const { SYSTEM_LEKTORAT, STOPWORDS: lektoratStopwords, ERKLAERUNG_RULE: lektoratErklaerungRule } = await getBookPrompts(bookId);
  try {
    logger.info(`Start: Seite #${pageId} (book=${bookId || '-'})`);
    updateJob(jobId, { statusText: 'Lade Seiteninhalt…', progress: 5 });

    const authHeader = userToken
      ? `Token ${userToken.id}:${userToken.pw}`
      : `Token ${process.env.TOKEN_ID || ''}:${process.env.TOKEN_KENNWORT || ''}`;
    const pdResp = await fetch(`${BS_URL}/api/pages/${pageId}`, {
      headers: { Authorization: authHeader },
      signal: AbortSignal.timeout(30000),
    });
    if (!pdResp.ok) throw new Error(`BookStack ${pdResp.status}: ${await pdResp.text()}`);
    const pd = await pdResp.json();

    const html = pd.html;
    const text = htmlToText(html);
    if (!text.trim()) { completeJob(jobId, { empty: true }); return; }

    const tok = { in: 0, out: 0, ms: 0 };
    updateJob(jobId, { statusText: 'KI analysiert…', progress: 10 });

    const result = await aiCall(jobId, tok,
      buildLektoratPrompt(text, { stopwords: lektoratStopwords, erklaerungRule: lektoratErklaerungRule }),
      SYSTEM_LEKTORAT,
      10, 97, 5000,
    );

    if (!Array.isArray(result?.fehler)) throw new Error('fehler-Array fehlt');
    const _validTypen = new Set(['rechtschreibung', 'grammatik', 'stil', 'wiederholung']);
    result.fehler = result.fehler
      .map(f => ({ ...f, typ: f.typ?.toLowerCase?.() }))
      .filter(f => _validTypen.has(f.typ))
      .filter(f => f.typ !== 'stil' || (f.korrektur?.trim() && f.korrektur.trim() !== f.original?.trim()));

    const model = _modelName(process.env.API_PROVIDER || 'claude');
    const szenen = Array.isArray(result?.szenen) ? result.szenen : [];

    const info = db.prepare(`INSERT INTO page_checks
      (page_id, page_name, book_id, chapter_id, checked_at, error_count, errors_json, szenen_json, stilanalyse, fazit, model, user_email)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(parseInt(pageId), pd.name, parseInt(bookId) || null, pd.chapter_id || null,
        new Date().toISOString(), result.fehler.length, JSON.stringify(result.fehler),
        szenen.length > 0 ? JSON.stringify(szenen) : null,
        result.stilanalyse || null, result.fazit || null, model, userEmail || null);

    completeJob(jobId, {
      fehler: result.fehler,
      szenen,
      stilanalyse: result.stilanalyse || null,
      fazit: result.fazit || null,
      originalHtml: html,
      updatedAt: pd.updated_at || null,
      pageName: pd.name,
      checkId: info.lastInsertRowid,
      tokensIn: tok.in,
      tokensOut: tok.out,
    }, tps(tok));
    logger.info(`«${pd.name}» fertig (page=${pageId}, book=${bookId || '-'}, chap=${pd.chapter_id || '-'}, ${result.fehler.length} Beanstandungen, ${fmtTok(tok.in)}↑ ${fmtTok(tok.out)}↓ Tokens)`);
  } catch (e) {
    logger.error(`Fehler (page=${pageId}, book=${bookId || '-'}): ${e.message}`);
    failJob(jobId, e);
  }
}

// ── Job: Batch-Lektorat ───────────────────────────────────────────────────────
async function runBatchCheckJob(jobId, bookId, userEmail, userToken) {
  const logger = makeJobLogger(jobId);
  const { buildBatchLektoratPrompt } = await getPrompts();
  const { SYSTEM_LEKTORAT, STOPWORDS: batchStopwords, ERKLAERUNG_RULE: batchErklaerungRule } = await getBookPrompts(bookId);
  try {
    updateJob(jobId, { statusText: 'Lade Seiten…', progress: 0 });
    const pages = await bsGetAll('pages?book_id=' + bookId, userToken);
    if (!pages.length) { completeJob(jobId, { empty: true }); return; }
    logger.info(`Start: ${pages.length} Seiten (book=${bookId})`);

    const authHeader = userToken
      ? `Token ${userToken.id}:${userToken.pw}`
      : `Token ${process.env.TOKEN_ID || ''}:${process.env.TOKEN_KENNWORT || ''}`;
    const tok = { in: 0, out: 0, ms: 0 };
    const model = _modelName(process.env.API_PROVIDER || 'claude');
    let done = 0, totalErrors = 0;

    for (let i = 0; i < pages.length; i++) {
      if (jobAbortControllers.get(jobId)?.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const p = pages[i];
      const fromPct = Math.round((i / pages.length) * 95);
      const toPct   = Math.round(((i + 1) / pages.length) * 95);
      updateJob(jobId, {
        progress: fromPct,
        statusText: `${i + 1}/${pages.length}: ${p.name}…`,
      });

      try {
        const pdResp = await fetch(`${BS_URL}/api/pages/${p.id}`, {
          headers: { Authorization: authHeader },
          signal: AbortSignal.timeout(30000),
        });
        if (!pdResp.ok) throw new Error(`BookStack ${pdResp.status}: ${await pdResp.text()}`);
        const pd = await pdResp.json();
        const text = htmlToText(pd.html).trim();
        if (!text) continue;

        const result = await aiCall(jobId, tok,
          buildBatchLektoratPrompt(text, { stopwords: batchStopwords, erklaerungRule: batchErklaerungRule }),
          SYSTEM_LEKTORAT,
          fromPct, toPct, 2000,
        );

        if (!Array.isArray(result?.fehler)) throw new Error('fehler-Array fehlt');
        const _validTypen = new Set(['rechtschreibung', 'grammatik', 'stil', 'wiederholung']);
        const fehler = result.fehler
          .map(f => ({ ...f, typ: f.typ?.toLowerCase?.() }))
          .filter(f => _validTypen.has(f.typ))
          .filter(f => f.typ !== 'stil' || (f.korrektur?.trim() && f.korrektur.trim() !== f.original?.trim()));
        totalErrors += fehler.length;

        const szenenBatch = Array.isArray(result?.szenen) ? result.szenen : [];
        db.prepare(`INSERT INTO page_checks
          (page_id, page_name, book_id, chapter_id, checked_at, error_count, errors_json, szenen_json, stilanalyse, fazit, model, user_email)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(p.id, p.name, parseInt(bookId), p.chapter_id || null, new Date().toISOString(),
            fehler.length, JSON.stringify(fehler),
            szenenBatch.length > 0 ? JSON.stringify(szenenBatch) : null,
            result.stilanalyse || null, result.fazit || null, model, userEmail || null);
        logger.info(`[${i + 1}/${pages.length}] «${pd.name}» fertig (page=${p.id}, chap=${p.chapter_id || '-'}, ${fehler.length} Beanstandungen)`);
        done++;
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        logger.warn(`[${i + 1}/${pages.length}] «${p.name}» übersprungen (page=${p.id}, chap=${p.chapter_id || '-'}): ${e.message}`);
      }
    }

    completeJob(jobId, { pageCount: pages.length, done, totalErrors, tokensIn: tok.in, tokensOut: tok.out }, tps(tok));
    logger.info(`Fertig: ${done}/${pages.length} Seiten (book=${bookId}), ${totalErrors} Beanstandungen, ${fmtTok(tok.in)}↑ ${fmtTok(tok.out)}↓ Tokens`);
  } catch (e) {
    logger.error(`Fehler (book=${bookId}): ${e.message}`);
    failJob(jobId, e);
  }
}

// ── Routen ────────────────────────────────────────────────────────────────────
lektoratRouter.post('/check', jsonBody, (req, res) => {
  const { page_id, book_id, page_name } = req.body;
  if (!page_id) return res.status(400).json({ error: 'page_id fehlt' });
  const userEmail = req.session?.user?.email || null;
  const userToken = req.session?.bookstackToken
    ? { id: req.session.bookstackToken.id, pw: req.session.bookstackToken.pw }
    : null;
  const existing = runningJobs.get(jobKey('check', page_id, userEmail));
  if (existing && jobs.has(existing)) return res.json({ jobId: existing, existing: true });
  const label = page_name ? `Lektorat · ${page_name}` : `Lektorat · Seite #${page_id}`;
  const jobId = createJob('check', page_id, userEmail, label);
  enqueueJob(jobId, () => runCheckJob(jobId, page_id, book_id || null, userEmail, userToken));
  res.json({ jobId });
});

lektoratRouter.post('/batch-check', jsonBody, (req, res) => {
  const { book_id, book_name } = req.body;
  if (!book_id) return res.status(400).json({ error: 'book_id fehlt' });
  const userEmail = req.session?.user?.email || null;
  const userToken = req.session?.bookstackToken
    ? { id: req.session.bookstackToken.id, pw: req.session.bookstackToken.pw }
    : null;
  const existing = runningJobs.get(jobKey('batch-check', book_id, userEmail));
  if (existing && jobs.has(existing)) return res.json({ jobId: existing, existing: true });
  const label = book_name ? `Serien-Lektorat · ${book_name}` : `Serien-Lektorat`;
  const jobId = createJob('batch-check', book_id, userEmail, label);
  enqueueJob(jobId, () => runBatchCheckJob(jobId, book_id, userEmail, userToken));
  res.json({ jobId });
});

module.exports = { lektoratRouter };
