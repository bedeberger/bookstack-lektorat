'use strict';
// Facade-Re-Export: alle bisherigen `module.exports`-Keys von `shared.js`
// stehen weiterhin als `require('./shared')` zur Verfügung.
const express = require('express');
const { getPrompts, getPromptConfig } = require('../../../lib/prompts-loader');

const state    = require('./state');
const queue    = require('./queue');
const jobsMod  = require('./jobs');
const model    = require('./model');
const ai       = require('./ai');
const loader   = require('./loader');
const queries  = require('./queries');
const router   = require('./router');

const { getBookSettings } = require('../../../db/schema');

// Buch-Locale-Prompts mit Buchtyp + Buchkontext augmentieren. Liest
// book_settings, fallback auf User-Defaults wenn `userEmail` gesetzt.
async function getBookPrompts(bookId, userEmail = null) {
  const { getLocalePromptsForBook } = await getPrompts();
  const settings = bookId
    ? getBookSettings(bookId, userEmail)
    : { language: 'de', region: 'CH', buchtyp: null, buch_kontext: null, is_finished: 0, schauplatz_land: null, zeitlinie_real: 0 };
  const locale = `${settings.language}-${settings.region}`;
  return getLocalePromptsForBook(locale, settings.buchtyp || null, settings.buch_kontext || null, !!settings.is_finished, settings.schauplatz_land || null, settings.stilprofil || null, !!settings.zeitlinie_real);
}

// Rückwärtskompatibler Export – einige Module lesen _promptConfig direkt.
const _promptConfig = getPromptConfig();

const jsonBody = express.json();
const jsonBodyLarge = express.json({ limit: '5mb' });

module.exports = {
  _promptConfig,
  jobs: state.jobs,
  runningJobs: state.runningJobs,
  jobAbortControllers: state.jobAbortControllers,
  jobQueue: state.jobQueue,
  jobKey: state.jobKey,

  makeJobLogger: jobsMod.makeJobLogger,
  enqueueJob: queue.enqueueJob,
  createJob: jobsMod.createJob,
  updateJob: jobsMod.updateJob,
  tps: jobsMod.tps,
  completeJob: jobsMod.completeJob,
  failJob: jobsMod.failJob,
  cancelJob: jobsMod.cancelJob,
  findActiveJobId: jobsMod.findActiveJobId,
  fmtTok: jobsMod.fmtTok,
  i18nError: jobsMod.i18nError,
  contentHttpError: jobsMod.contentHttpError,

  _modelName: model._modelName,
  settledAll: ai.settledAll,
  retryOnTransientAi: ai.retryOnTransientAi,

  htmlToText: ai.htmlToText,
  htmlToTextForPrompt: ai.htmlToTextForPrompt,
  cleanPageTextForClaude: ai.cleanPageTextForClaude,

  loadOrderedBookContents: loader.loadOrderedBookContents,
  loadPageContents: loader.loadPageContents,
  groupByChapter: loader.groupByChapter,
  buildSinglePassBookText: loader.buildSinglePassBookText,
  splitGroupsIntoChunks: loader.splitGroupsIntoChunks,

  aiCall: ai.aiCall,
  toSystemBlocks: ai.toSystemBlocks,
  summarizeCostByPhase: ai.summarizeCostByPhase,
  formatCostByPhase: ai.formatCostByPhase,

  getPrompts,
  getBookPrompts,

  getFiguren: queries.getFiguren,
  getLatestReview: queries.getLatestReview,
  getLatestPageCheck: queries.getLatestPageCheck,
  getOpenIdeen: queries.getOpenIdeen,
  buildChatMessageHistory: queries.buildChatMessageHistory,

  SINGLE_PASS_LIMIT: loader.SINGLE_PASS_LIMIT,
  PER_CHUNK_LIMIT: loader.PER_CHUNK_LIMIT,
  BATCH_SIZE: loader.BATCH_SIZE,
  chunkLimitsFor: loader.chunkLimitsFor,
  resolveExtractSinglePassLimit: loader.resolveExtractSinglePassLimit,

  jsonBody, jsonBodyLarge,
  sharedRouter: router.sharedRouter,
};
