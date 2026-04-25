'use strict';

const express = require('express');
const { getTokenForRequest, getBookSettings } = require('../../../db/schema');
const {
  makeJobLogger, updateJob, completeJob, failJob,
  bsGetAll, loadPageContents,
  jobs, createJob, enqueueJob, findActiveJobId,
  jobAbortControllers, BATCH_SIZE,
  jsonBody,
} = require('../shared');

const { loadFinetuneData } = require('./data-loader');
const { finalizeFinetuneSamples } = require('./finalize');
const { finetuneResultStore } = require('./lib/store');

const { buildStyleSamples } = require('./samples/style');
const { buildSceneSamples } = require('./samples/scene');
const { buildDialogSamples } = require('./samples/dialog');
const { buildCorrectionSamples } = require('./samples/correction');
const { buildAuthorChatSamples } = require('./samples/author-chat');

const finetuneExportRouter = express.Router();

async function runFinetuneExportJob(jobId, bookId, bookName, userEmail, userToken, opts) {
  const logger = makeJobLogger(jobId);
  try {
    logger.info(`Start Finetune-Export «${bookName}» (book=${bookId}, types=${Object.entries(opts.types).filter(([,v]) => v).map(([k]) => k).join(',')})`);
    updateJob(jobId, { statusText: 'job.phase.loadingPages', progress: 0 });
    const [chaptersData, pages] = await Promise.all([
      bsGetAll('chapters?filter[book_id]=' + bookId, userToken),
      bsGetAll('pages?filter[book_id]=' + bookId, userToken),
    ]);
    if (!pages.length) { completeJob(jobId, { empty: true }); return; }

    const chMap = Object.fromEntries(chaptersData.map(c => [c.id, c.name]));
    const pageContents = await loadPageContents(pages, chMap, 30, (i, total) => {
      updateJob(jobId, {
        progress: Math.round((i / total) * 40),
        statusText: 'job.phase.readingPages',
        statusParams: { from: i + 1, to: Math.min(i + BATCH_SIZE, total), total },
      });
    }, userToken, jobAbortControllers.get(jobId)?.signal);

    updateJob(jobId, { progress: 45, statusText: 'finetune.phase.loadMetadata' });

    const bookIdInt = parseInt(bookId);
    const settings = getBookSettings(bookIdInt, userEmail);
    const langIsEn = (settings.language || 'de') === 'en';

    const data = loadFinetuneData({ bookIdInt, userEmail, pageContents, langIsEn });

    const minChars = Math.max(80, opts.minChars | 0);
    const maxChars = Math.max(minChars + 100, opts.maxChars | 0);
    const valSplit = Math.max(0, Math.min(0.5, Number.isFinite(opts.valSplit) ? opts.valSplit : 0.1));
    const seed = Number.isFinite(opts.valSeed) ? opts.valSeed : 0;
    // `maxSeqTokens`: hartes Token-Limit nach Chat-Template-Wrapping. 0/null =
    // kein Filter (alles durch, Token-Stats trotzdem berechnen). Defaults:
    // 4096 ist Sweet-Spot für Mistral-Small-3.2-24B-QLoRA auf 20-GB-Karten.
    const maxSeqTokens = Math.max(0, Number(opts.maxSeqTokens) || 0);
    const emitText = !!opts.emitText;

    // Einheitliche Identität über alle Sample-Typen: Modell soll *eine* Stimme
    // lernen — die des Buchs — statt mehrerer Personae (Lektor, Dialogschreiber,
    // literarischer Assistent etc.). Task-Variation steckt im User-Message,
    // nicht im System-Prompt.
    const displayName = bookName || (langIsEn ? 'this book' : 'diesem Buch');
    const unifiedSys = langIsEn
      ? `You are the voice of «${displayName}». Write, continue, and answer in the author's style and from within this book's world.`
      : `Du bist die Stimme von «${displayName}». Schreibe, setze fort und antworte im Stil des Autors und aus der Welt dieses Buchs heraus.`;

    const samples = [];
    const counts = { style: 0, scene: 0, dialog: 0, authorChat: 0, correction: 0 };

    // Normalised opts mit übernommenen Defaults — wird in alle Sub-Module gereicht.
    const optsNorm = { ...opts, minChars, maxChars, valSplit, valSeed: seed, maxSeqTokens, emitText };

    const ctx = {
      jobId, logger,
      bookId, bookIdInt, bookName, userEmail, userToken,
      opts: optsNorm,
      langIsEn, displayName, unifiedSys,
      counts, samples,
      pageContents,
      ...data,
    };

    if (opts.types.style) {
      updateJob(jobId, { progress: 55, statusText: 'finetune.phase.style' });
      buildStyleSamples(ctx);
    }

    if (opts.types.scene) {
      updateJob(jobId, { progress: 70, statusText: 'finetune.phase.scene' });
      buildSceneSamples(ctx);
    }

    // Dialog-Sammlung läuft immer, wenn Figuren bekannt sind — `dialogsByFigure`
    // füttert auch den authorChat-Block (Zitatsammlung pro Figur). Der eigentliche
    // dialog-Typ ist davon unabhängig per Checkbox steuerbar.
    if (data.figNamesSorted.length) {
      if (opts.types.dialog) {
        updateJob(jobId, { progress: 85, statusText: 'finetune.phase.dialog' });
      }
      buildDialogSamples(ctx);
    }

    if (opts.types.correction) {
      updateJob(jobId, { progress: 88, statusText: 'finetune.phase.correction' });
      buildCorrectionSamples(ctx);
    }

    if (opts.types.authorChat) {
      updateJob(jobId, { progress: 90, statusText: 'finetune.phase.authorChat' });
      buildAuthorChatSamples(ctx);
    }

    updateJob(jobId, { progress: 95, statusText: 'finetune.phase.building' });

    const stats = finalizeFinetuneSamples(jobId, ctx);
    completeJob(jobId, { stats });
    logger.info(`Finetune-Export fertig: ${stats.total} Samples (${counts.style} style / ${counts.scene} scene / ${counts.dialog} dialog / ${counts.authorChat} authorChat / ${counts.correction} correction) → ${stats.train} train, ${stats.val} val, dropped=${stats.dropped}, p95=${stats.tokensP95} tok, max=${stats.tokensMax} tok, recSeq=${stats.recommendedSeqLen}.`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Fehler Finetune-Export (book=${bookId}): ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

finetuneExportRouter.post('/finetune-export', jsonBody, (req, res) => {
  const { book_id, book_name, types, min_chars, max_chars, val_split, val_seed,
          max_seq_tokens, emit_text } = req.body || {};
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  const opts = {
    types: {
      style:      !!(types && types.style),
      scene:      !!(types && types.scene),
      dialog:     !!(types && types.dialog),
      authorChat: !!(types && types.authorChat),
      correction: !!(types && types.correction),
    },
    minChars: Number(min_chars) || 200,
    maxChars: Number(max_chars) || 4000,
    valSplit: Number.isFinite(Number(val_split)) ? Number(val_split) : 0.1,
    valSeed:  Number(val_seed)  || 0,
    maxSeqTokens: Number(max_seq_tokens) || 0,
    emitText: !!emit_text,
  };
  if (!Object.values(opts.types).some(v => v)) {
    return res.status(400).json({ error_code: 'FINETUNE_NO_TYPES' });
  }
  const userEmail = req.session?.user?.email || null;
  const userToken = getTokenForRequest(req);
  const existing = findActiveJobId('finetune-export', book_id, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const label = book_name ? 'job.label.finetuneExportBook' : 'job.label.finetuneExport';
  const labelParams = book_name ? { name: book_name } : null;
  const jobId = createJob('finetune-export', book_id, userEmail, label, labelParams);
  enqueueJob(jobId, () => runFinetuneExportJob(jobId, book_id, book_name || '', userEmail, userToken, opts));
  res.json({ jobId });
});

finetuneExportRouter.get('/finetune-export/:id/:kind.jsonl', (req, res) => {
  const userEmail = req.session?.user?.email || null;
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error_code: 'JOB_NOT_FOUND' });
  if (job.userEmail !== userEmail) return res.status(403).json({ error_code: 'FORBIDDEN' });
  if (job.type !== 'finetune-export') return res.status(400).json({ error_code: 'JOB_TYPE_MISMATCH' });
  if (job.status !== 'done') return res.status(409).json({ error_code: 'JOB_NOT_DONE' });
  const kind = req.params.kind;
  if (kind !== 'train' && kind !== 'val') return res.status(400).json({ error_code: 'INVALID_KIND' });
  const payload = finetuneResultStore.get(req.params.id);
  if (!payload) return res.status(410).json({ error_code: 'JSONL_EXPIRED' });
  const content = kind === 'train' ? payload.trainJsonl : payload.valJsonl;
  if (!content) return res.status(404).json({ error_code: 'JSONL_EMPTY' });
  const filename = `finetune-${kind}-book${job.bookId}.jsonl`;
  res.setHeader('Content-Type', 'application/jsonl; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(content);
});

module.exports = { finetuneExportRouter };
