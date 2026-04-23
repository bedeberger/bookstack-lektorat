'use strict';
const express = require('express');
const router = express.Router();

const { sharedRouter } = require('./jobs/shared');
const { lektoratRouter } = require('./jobs/lektorat');
const { reviewRouter } = require('./jobs/review');
const { kapitelRouter } = require('./jobs/kapitel');
const { komplettRouter, runKomplettAnalyseAll } = require('./jobs/komplett');
const { chatRouter } = require('./jobs/chat');
const { synonymeRouter } = require('./jobs/synonyme');
const { finetuneExportRouter } = require('./jobs/finetune-export');

// Feature-Router zuerst mounten – sharedRouter zuletzt, weil GET /:id und DELETE /:id
// als Catch-All wirken und sonst spezifischere Routen (z.B. DELETE /book-chat-cache,
// GET /kontinuitaet/:book_id) abfangen würden.
router.use('/', lektoratRouter);
router.use('/', reviewRouter);
router.use('/', kapitelRouter);
router.use('/', komplettRouter);
router.use('/', chatRouter);
router.use('/', synonymeRouter);
router.use('/', finetuneExportRouter);
router.use('/', sharedRouter);

module.exports = { router, runKomplettAnalyseAll };
