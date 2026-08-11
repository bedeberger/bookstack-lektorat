'use strict';
const express = require('express');
const {
  deleteChapterExtractCache,
  deleteCheckpoint,
  getLatestContinuityCheck,
  getContinuityIssueBookId,
  setContinuityIssueResolved,
  getChapterNarrativeProfile,
  } = require('../../../db/schema');
const { getNarrativeReport, getAutorenBefund } = require('../../../db/narrative-report');
const { getBookSettings } = require('../../../db/schema');
const { toIntId } = require('../../../lib/validate');
const { resolveProvider, effectiveProviderClass } = require('../../../lib/ai');
const appSettings = require('../../../lib/app-settings');
const { setContext } = require('../../../lib/log-context');
const { aclParamGuard, requireBookAccess, sendACLError, sessionEmail } = require('../../../lib/acl');
const { jsonBody, createJob, enqueueJob, findActiveJobId } = require('../shared');
const { runKomplettAnalyseJob, runKontinuitaetJob, runErzaehlprofilJob, runFaktencheckJob, runKomplettAnalyseAll } = require('./job');

const komplettRouter = express.Router();
// :book_id-Routes (GET kontinuitaet, DELETE chapter-cache) sind viewer+ resp. editor+.
komplettRouter.param('book_id', aclParamGuard('viewer'));

// ── Routen ────────────────────────────────────────────────────────────────────
komplettRouter.post('/komplett-analyse', jsonBody, (req, res) => {
  const { book_name } = req.body;
  const book_id = toIntId(req.body?.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: book_id });
  try { requireBookAccess(req, book_id, 'editor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }
  const userEmail = sessionEmail(req);
  const userToken = null;
  const existing = findActiveJobId('komplett-analyse', book_id, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  // Optionale Teil-Läufe: Kontinuitätsprüfung (P8) und Erzählprofil sind read-only
  // Endphasen — wer nach einer Kapitel-Änderung nur den Katalog auffrischen will,
  // spart hier Zeit UND Geld, ohne an der Extraktionsqualität zu drehen. Beide
  // lassen sich einzeln nachziehen (POST /jobs/kontinuitaet, /jobs/erzaehlprofil).
  // Default = alles an (unverändertes Verhalten für bestehende Aufrufer).
  const skipContinuity = req.body?.skip_continuity === true;
  const skipNarrativeProfile = req.body?.skip_narrative_profile === true;
  const label = book_name ? 'job.label.komplettBook' : 'job.label.komplett';
  const labelParams = book_name ? { name: book_name } : null;
  const jobId = createJob('komplett-analyse', book_id, userEmail, label, labelParams);
  // provider bleibt undefined (Slot 6) — den setzt nur der Nacht-Cron; opts folgt dahinter.
  enqueueJob(jobId, () => runKomplettAnalyseJob(jobId, book_id, book_name || '', userEmail, userToken,
    undefined, { skipContinuity, skipNarrativeProfile }));
  res.json({ jobId });
});

komplettRouter.post('/kontinuitaet', jsonBody, (req, res) => {
  const { book_name } = req.body;
  const book_id = toIntId(req.body?.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: book_id });
  try { requireBookAccess(req, book_id, 'editor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }
  const userEmail = sessionEmail(req);
  // Kontinuitätsprüfung braucht die Cloud-KLASSE (Single-Pass, Verify-Filter,
  // Attribut-Check setzen ein faehiges Modell voraus — keine Anthropic-API-Faehigkeit).
  // Dieselbe Entscheidung wie `/config` komplett.continuity und das Ueberspringen der
  // Phase im Job; dieser Guard erzwingt sie serverseitig (Defense-in-depth).
  if (effectiveProviderClass({ userEmail }) !== 'cloud') return res.status(400).json({ error_code: 'CONTINUITY_PROVIDER_UNSUPPORTED' });
  const userToken = null;
  const existing = findActiveJobId('kontinuitaet', book_id, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const label = book_name ? 'job.label.kontinuitaetBook' : 'job.label.kontinuitaet';
  const labelParams = book_name ? { name: book_name } : null;
  const jobId = createJob('kontinuitaet', book_id, userEmail, label, labelParams);
  enqueueJob(jobId, () => runKontinuitaetJob(jobId, book_id, book_name || '', userEmail, userToken));
  res.json({ jobId });
});

komplettRouter.get('/kontinuitaet/:book_id', (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });
  const userEmail = sessionEmail(req);
  const result = getLatestContinuityCheck(bookId, userEmail);
  res.json(result);
});

// Issue als erledigt/offen markieren (editor+). book_id wird aus dem Issue
// aufgeloest, da kein :book_id-Param vorliegt -> manuelle ACL statt aclParamGuard.
komplettRouter.post('/kontinuitaet/issue/:issue_id/resolved', jsonBody, (req, res) => {
  const issueId = toIntId(req.params.issue_id);
  if (!issueId) return res.status(400).json({ error_code: 'INVALID_ISSUE_ID' });
  const bookId = getContinuityIssueBookId(issueId);
  if (!bookId) return res.status(404).json({ error_code: 'ISSUE_NOT_FOUND' });
  setContext({ book: bookId });
  try { requireBookAccess(req, bookId, 'editor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }
  const resolved = !!req.body?.resolved;
  setContinuityIssueResolved(issueId, resolved);
  res.json({ ok: true, resolved });
});

// Weltfakten-Realitätscheck eigenständig starten — editor+. Prüft die extrahierten
// Welt-Fakten mit Web-Suche gegen die reale Faktenlage. Claude-only (web_search ist
// Server-Tool), Instanz-Kill-Switch ai.komplett.factcheck, Buch-Opt-in weltfakten_real_pruefen.
komplettRouter.post('/faktencheck', jsonBody, (req, res) => {
  const { book_name } = req.body;
  const book_id = toIntId(req.body?.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: book_id });
  try { requireBookAccess(req, book_id, 'editor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }
  const userEmail = sessionEmail(req);
  if (resolveProvider({ userEmail }) !== 'claude') return res.status(400).json({ error_code: 'FACTCHECK_CLAUDE_ONLY' });
  if (appSettings.get('ai.komplett.factcheck') === false) return res.status(400).json({ error_code: 'FACTCHECK_DISABLED' });
  if (!getBookSettings(book_id, userEmail)?.weltfakten_real_pruefen) return res.status(400).json({ error_code: 'FACTCHECK_NOT_ENABLED_FOR_BOOK' });
  const userToken = null;
  const existing = findActiveJobId('faktencheck', book_id, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const label = book_name ? 'job.label.faktencheckBook' : 'job.label.faktencheck';
  const labelParams = book_name ? { name: book_name } : null;
  const jobId = createJob('faktencheck', book_id, userEmail, label, labelParams);
  enqueueJob(jobId, () => runFaktencheckJob(jobId, book_id, book_name || '', userEmail, userToken));
  res.json({ jobId });
});

// Erzählprofil eigenständig neu berechnen (nur die Phase «Erzählprofil», ohne die
// volle Extraktions-Pipeline) — editor+. Nutzt den vorhandenen Figuren-Katalog.
komplettRouter.post('/erzaehlprofil', jsonBody, (req, res) => {
  const { book_name } = req.body;
  const book_id = toIntId(req.body?.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: book_id });
  try { requireBookAccess(req, book_id, 'editor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }
  const userEmail = sessionEmail(req);
  // Erzählprofil braucht die Cloud-Klasse (Single-Pass). Serverseitiger Guard analog
  // Kontinuität (Defense-in-depth), gleiche Entscheidung wie `/config`.
  if (effectiveProviderClass({ userEmail }) !== 'cloud') return res.status(400).json({ error_code: 'NARRATIVE_PROFILE_PROVIDER_UNSUPPORTED' });
  const userToken = null;
  const existing = findActiveJobId('erzaehlprofil', book_id, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const label = book_name ? 'job.label.erzaehlprofilBook' : 'job.label.erzaehlprofil';
  const labelParams = book_name ? { name: book_name } : null;
  const jobId = createJob('erzaehlprofil', book_id, userEmail, label, labelParams);
  enqueueJob(jobId, () => runErzaehlprofilJob(jobId, book_id, book_name || '', userEmail, userToken));
  res.json({ jobId });
});

// Kapitel-Erzählprofil (aus der Komplettanalyse-Phase «Erzählprofil») – viewer+.
komplettRouter.get('/erzaehlprofil/:book_id', (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });
  const userEmail = sessionEmail(req);
  const profile = getChapterNarrativeProfile(bookId, userEmail);
  // Deterministischer Buch-Befund (read-time, pure Engine über die Katalog-Zeilen) +
  // gespeicherter KI-Dach-Befund (Autoren-Befund). Beides an dieselbe Antwort gehängt,
  // damit die Karte alles in einem Fetch bekommt.
  const befund = profile.chapters.length ? getNarrativeReport(bookId, userEmail) : null;
  const autorenBefund = getAutorenBefund(bookId, userEmail);
  res.json({ ...profile, befund, autorenBefund });
});

komplettRouter.delete('/chapter-cache/:book_id', (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });
  const userEmail = sessionEmail(req) || '';
  const deleted = deleteChapterExtractCache(bookId, userEmail);
  // F5: den Konsolidierungs-Checkpoint mitlöschen — sonst würde ein Re-Run nach dem Cache-Leeren
  // zwar Phase 1 neu extrahieren, aber (bei gleichem Inhalt) P2–P8 weiterhin überspringen.
  deleteCheckpoint('komplett-consolidation', bookId, userEmail);
  res.json({ ok: true, deleted });
});

module.exports = { komplettRouter, runKomplettAnalyseAll, runKomplettAnalyseJob, runKontinuitaetJob, runErzaehlprofilJob, runFaktencheckJob };
