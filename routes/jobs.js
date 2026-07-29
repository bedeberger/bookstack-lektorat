'use strict';
const express = require('express');
const router = express.Router();

const { enforceBudget } = require('../lib/budget');
const { sharedRouter } = require('./jobs/shared');
const { lektoratRouter } = require('./jobs/lektorat');
const { reviewRouter } = require('./jobs/review');
const { kapitelRouter } = require('./jobs/kapitel');
const { komplettRouter, runKomplettAnalyseAll } = require('./jobs/komplett');
const { chatRouter } = require('./jobs/chat');
const { synonymeRouter } = require('./jobs/synonyme');
const { stilprofilRouter } = require('./jobs/stilprofil');
const { rueckblickRouter } = require('./jobs/rueckblick');
const { finetuneExportRouter } = require('./jobs/finetune-export');
const { pdfExportRouter } = require('./jobs/pdf-export');
const { epubExportRouter } = require('./jobs/epub-export');
const { docxExportRouter } = require('./jobs/docx-export');
const { figurWerkstattRouter } = require('./jobs/figur-werkstatt');
const { plotRouter } = require('./jobs/plot');
const { folderImportRouter } = require('./jobs/folder-import');
const { geocodeRouter } = require('./jobs/geocode');
const { researchLinkRouter } = require('./jobs/research-link');
const { bookImportRouter } = require('./jobs/book-import');
const { blogSyncRouter } = require('./jobs/blog-sync');
const { hubspotSyncRouter } = require('./jobs/hubspot-sync');
const { embedIndexRouter } = require('./jobs/embed-index');
const { motifScanRouter } = require('./jobs/motif-scan');
const { motifBrainstormRouter } = require('./jobs/motif-brainstorm');
const { beatAnchorRouter } = require('./jobs/beat-anchor');
const { redundancyRouter } = require('./jobs/redundancy');
const { sourceDetectRouter } = require('./jobs/source-detect');

// Budget-Enforcement greift VOR allen Sub-Routern, sonst lassen sich
// die Job-POSTs unter /jobs/* nicht mit einer einzigen Middleware kapseln.
// enforceBudget skipped non-POST und non-Claude-Provider intern.
router.use((req, res, next) => {
  if (req.method !== 'POST') return next();
  return enforceBudget(req, res, next);
});

// Feature-Router zuerst mounten – sharedRouter zuletzt, weil GET /:id und DELETE /:id
// als Catch-All wirken und sonst spezifischere Routen (z.B. DELETE /book-chat-cache,
// GET /kontinuitaet/:book_id) abfangen würden.
router.use('/', lektoratRouter);
router.use('/', reviewRouter);
router.use('/', kapitelRouter);
router.use('/', komplettRouter);
router.use('/', chatRouter);
router.use('/', synonymeRouter);
router.use('/', stilprofilRouter);
router.use('/', rueckblickRouter);
router.use('/', finetuneExportRouter);
router.use('/', pdfExportRouter);
router.use('/', epubExportRouter);
router.use('/', docxExportRouter);
router.use('/', figurWerkstattRouter);
router.use('/', plotRouter);
router.use('/', folderImportRouter);
router.use('/', geocodeRouter);
router.use('/', researchLinkRouter);
router.use('/', bookImportRouter);
router.use('/', blogSyncRouter);
router.use('/', hubspotSyncRouter);
router.use('/', embedIndexRouter);
router.use('/', motifScanRouter);
router.use('/', motifBrainstormRouter);
router.use('/', beatAnchorRouter);
router.use('/', redundancyRouter);
router.use('/', sourceDetectRouter);
router.use('/', sharedRouter);

module.exports = { router, runKomplettAnalyseAll };
