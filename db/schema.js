'use strict';
// Facade ueber die db/-Domaenen-Module: buendelt die Schreib-/Lesepfade, die
// Jobs und Routen brauchen, unter einem Import.
//
// Diese Datei enthaelt selbst KEINE Logik — jede Domaene hat ihr eigenes Modul
// (Konvention der uebrigen db/-Dateien). Neue Funktion also im passenden
// Domaenen-Modul anlegen und hier nur re-exportieren; wer eine neue Domaene
// aufmacht, legt ein neues Modul an statt hier Code abzulegen.
//
// Ladereihenfolge matters: `migrations` muss vor allen Modulen laufen, die
// Prepared Statements auf migrierten Spalten anlegen (die Domaenen-Module
// requiren es zusaetzlich selbst, damit sie auch einzeln importierbar bleiben).
const { db } = require('./connection');
require('./migrations');

// Domaenen dieser Facade
const jobRuns = require('./job-runs');
const jobCheckpoints = require('./job-checkpoints');
const zeitstrahl = require('./zeitstrahl');
const locationsWrite = require('./locations-write');
const worldFacts = require('./world-facts');
const aiCaches = require('./ai-caches');
const rueckblick = require('./rueckblick');
const bookSettings = require('./book-settings');
const continuity = require('./continuity');
const songs = require('./songs');
const narrativeProfiles = require('./narrative-profiles');

// Domaenen mit eigenem Modul, die hier nur durchgereicht werden
const figures = require('./figures');
const pages = require('./pages');
const pdfExport = require('./pdf-export');
const fonts = require('./fonts');
const books = require('./books');
const tokenUsage = require('./token-usage');
const draftFigures = require('./draft-figures');
const sources = require('./sources');
const motifs = require('./motifs');

module.exports = {
  db,
  // job-runs / checkpoints
  insertJobRun:        jobRuns.insertJobRun,
  startJobRun:         jobRuns.startJobRun,
  endJobRun:           jobRuns.endJobRun,
  cleanupStuckJobRuns: jobRuns.cleanupStuckJobRuns,
  saveCheckpoint:   jobCheckpoints.saveCheckpoint,
  loadCheckpoint:   jobCheckpoints.loadCheckpoint,
  deleteCheckpoint: jobCheckpoints.deleteCheckpoint,
  // zeitstrahl
  saveZeitstrahlEvents: zeitstrahl.saveZeitstrahlEvents,
  // locations
  planOrteMatch:  locationsWrite.planOrteMatch,
  saveOrteToDb:   locationsWrite.saveOrteToDb,
  patchOrtCoords: locationsWrite.patchOrtCoords,
  backfillLocationChaptersFromScenes: locationsWrite.backfillLocationChaptersFromScenes,
  getChapterLocations: locationsWrite.getChapterLocations,
  // welt-fakten
  saveFaktenToDb: worldFacts.saveFaktenToDb,
  // songs
  saveSongsToDb: songs.saveSongsToDb,
  // kontinuitaet / faktencheck
  saveContinuityCheck:       continuity.saveContinuityCheck,
  saveFaktencheckIssues:     continuity.saveFaktencheckIssues,
  getLatestContinuityCheck:  continuity.getLatestContinuityCheck,
  getContinuityIssueBookId:  continuity.getContinuityIssueBookId,
  setContinuityIssueResolved: continuity.setContinuityIssueResolved,
  // erzaehlprofil
  saveChapterNarrativeProfiles: narrativeProfiles.saveChapterNarrativeProfiles,
  getChapterNarrativeProfile:   narrativeProfiles.getChapterNarrativeProfile,
  // buch-einstellungen
  getBookSettings:         bookSettings.getBookSettings,
  getBookLocale:           bookSettings.getBookLocale,
  saveBookSettings:        bookSettings.saveBookSettings,
  setBookEntitiesEnabled:  bookSettings.setBookEntitiesEnabled,
  setBookStilprofil:       bookSettings.setBookStilprofil,
  setBookTextsorte:        bookSettings.setBookTextsorte,
  setBookCitationSettings: bookSettings.setBookCitationSettings,
  setBookXrefSettings:     bookSettings.setBookXrefSettings,
  VALID_CITATION_STYLES:     bookSettings.VALID_CITATION_STYLES,
  VALID_CITATION_NOTES:      bookSettings.VALID_CITATION_NOTES,
  VALID_BIBLIOGRAPHY_SCOPES: bookSettings.VALID_BIBLIOGRAPHY_SCOPES,
  // delta-caches
  loadChapterExtractCache:   aiCaches.loadChapterExtractCache,
  saveChapterExtractCache:   aiCaches.saveChapterExtractCache,
  deleteChapterExtractCache: aiCaches.deleteChapterExtractCache,
  loadChapterReviewCache:    aiCaches.loadChapterReviewCache,
  saveChapterReviewCache:    aiCaches.saveChapterReviewCache,
  loadBookReviewCache:       aiCaches.loadBookReviewCache,
  saveBookReviewCache:       aiCaches.saveBookReviewCache,
  deleteReviewCache:         aiCaches.deleteReviewCache,
  loadChapterMacroReviewCache:   aiCaches.loadChapterMacroReviewCache,
  saveChapterMacroReviewCache:   aiCaches.saveChapterMacroReviewCache,
  deleteChapterMacroReviewCache: aiCaches.deleteChapterMacroReviewCache,
  loadSynonymCache:   aiCaches.loadSynonymCache,
  saveSynonymCache:   aiCaches.saveSynonymCache,
  deleteSynonymCache: aiCaches.deleteSynonymCache,
  loadLektoratCache:   aiCaches.loadLektoratCache,
  saveLektoratCache:   aiCaches.saveLektoratCache,
  deleteLektoratCache: aiCaches.deleteLektoratCache,
  loadFinetuneAiCache:   aiCaches.loadFinetuneAiCache,
  saveFinetuneAiCache:   aiCaches.saveFinetuneAiCache,
  deleteFinetuneAiCache: aiCaches.deleteFinetuneAiCache,
  // rueckblick (Cache + Historie)
  loadRueckblickCache:   rueckblick.loadRueckblickCache,
  saveRueckblickCache:   rueckblick.saveRueckblickCache,
  deleteRueckblickCache: rueckblick.deleteRueckblickCache,
  insertRueckblick:          rueckblick.insertRueckblick,
  touchRueckblickEntryCount: rueckblick.touchRueckblickEntryCount,
  latestRueckblickJson:      rueckblick.latestRueckblickJson,
  listRueckblicke:           rueckblick.listRueckblicke,
  deleteRueckblick:          rueckblick.deleteRueckblick,
  // figures
  saveFigurenToDb:          figures.saveFigurenToDb,
  addFigurenBeziehungen:    figures.addFigurenBeziehungen,
  updateFigurenEvents:      figures.updateFigurenEvents,
  updateFigurenSoziogramm:  figures.updateFigurenSoziogramm,
  cleanupDuplicateFiguren:  figures.cleanupDuplicateFiguren,
  getChapterFigures:        figures.getChapterFigures,
  getChapterFigureRelations: figures.getChapterFigureRelations,
  getFigureWithDetails:     figures.getFigureWithDetails,
  rebuildFigureAppearances: figures.rebuildFigureAppearances,
  // motifs (Soll-Kontext fürs Lektorat)
  getPageMotifs:            motifs.getPageMotifs,
  // pages
  reconcilePageIds:   pages.reconcilePageIds,
  pruneStaleBookData: pages.pruneStaleBookData,
  // books
  upsertBook:         books.upsertBook,
  upsertBookByName:   books.upsertBookByName,
  getBookName:        books.getBookName,
  pruneStaleByAge:    books.pruneStaleByAge,
  // token-usage
  getDailyTokenUsage:    tokenUsage.getDailyTokenUsage,
  getDailyTotalsByUser:  tokenUsage.getDailyTotalsByUser,
  // pdf-export profiles
  listPdfExportProfiles:  pdfExport.listProfiles,
  getPdfExportProfile:    pdfExport.getProfile,
  createPdfExportProfile: pdfExport.createProfile,
  updatePdfExportProfile: pdfExport.updateProfile,
  deletePdfExportProfile: pdfExport.deleteProfile,
  setPdfExportProfileBackCover:   pdfExport.setBackCover,
  clearPdfExportProfileBackCover: pdfExport.clearBackCover,
  getPdfExportProfileBackCover:   pdfExport.getBackCover,
  setPdfExportProfileSpineImage:   pdfExport.setSpineImage,
  clearPdfExportProfileSpineImage: pdfExport.clearSpineImage,
  getPdfExportProfileSpineImage:   pdfExport.getSpineImage,
  setPdfExportProfileDefault: pdfExport.setDefault,
  // fonts
  getCachedFont: fonts.getCachedFont,
  cacheFont:     fonts.cacheFont,
  // draft figures (Figuren-Werkstatt)
  listDraftFigures:        draftFigures.listDraftFigures,
  getDraftFigure:          draftFigures.getDraftFigure,
  getDraftFigureBySource:  draftFigures.getDraftFigureBySource,
  createDraftFigure:       draftFigures.createDraftFigure,
  updateDraftFigure:       draftFigures.updateDraftFigure,
  deleteDraftFigure:       draftFigures.deleteDraftFigure,
  insertWerkstattRun:      draftFigures.insertWerkstattRun,
  listWerkstattRuns:       draftFigures.listWerkstattRuns,
  getWerkstattRun:         draftFigures.getWerkstattRun,
  deleteWerkstattRun:      draftFigures.deleteWerkstattRun,
  // Quellen-Bibliothek (User-Pool `sources` + Bruecke `book_source_links`
  // + abgeleiteter Fund-Index `source_citations`)
  CSL_TYPES:              sources.CSL_TYPES,
  normalizeSourcePersons: sources.normalizePersons,
  listSources:            sources.listSources,
  listPoolSources:        sources.listPoolSources,
  getSource:              sources.getSource,
  countSources:           sources.countSources,
  findSourceByUrl:        sources.findSourceByUrl,
  findImportDuplicate:    sources.findImportDuplicate,
  findSimilarSource:      sources.findSimilarSource,
  createSource:           sources.createSource,
  updateSource:           sources.updateSource,
  deleteSource:           sources.deleteSource,
  linkSource:             sources.linkSource,
  unlinkSource:           sources.unlinkSource,
  isSourceLinked:         sources.isSourceLinked,
  listSourceBooks:        sources.listSourceBooks,
  replacePageCitations:   sources.replacePageCitations,
  listBookCitations:      sources.listBookCitations,
  listPageCitations:      sources.listPageCitations,
  listSourceCitations:    sources.listSourceCitations,
  getBookQuoteStats:      sources.getBookQuoteStats,
  setSourceDoc:           sources.setSourceDoc,
  clearSourceDoc:         sources.clearSourceDoc,
  getSourceDocMeta:       sources.getSourceDocMeta,
  getSourceDocBlob:       sources.getSourceDocBlob,
  getSourceDocText:       sources.getSourceDocText,
  markSourceIndexed:      sources.markSourceIndexed,
};
