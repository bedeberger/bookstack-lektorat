'use strict';
// CRUD für draft_figures (Figuren-Werkstatt). Owner-Check pro Operation.
// Default-Mindmap-Knoten als i18n-Marker persistiert; Frontend löst via t() auf,
// damit die Locale-Wahl des späteren Betrachters gilt (CLAUDE.md-Pattern).

const express = require('express');
const {
  listDraftFigures, getDraftFigureBySource,
  createDraftFigure, updateDraftFigure, deleteDraftFigure,
  listImportableFigures, listWerkstattRuns, deleteWerkstattRun,
  getFigureWithDetails,
} = require('../db/schema');
const { scopedDraft, scopedRun } = require('./draft-figures-acl');
const { buildMindmapFromFigure, mapArchetype } = require('../lib/draft-mindmap-builder');
const { toIntId } = require('../lib/validate');
const { aclParamGuard, sessionEmail } = require('../lib/acl');
const logger = require('../logger');

const router = express.Router();
// ACL: jede :book_id-Route erfordert mind. viewer-Rolle (drafts user-scoped,
// aber Anlage auf fremden Büchern sonst möglich → IDOR). Setzt zugleich den
// ALS-Logging-Context (book) + req.bookId/req.bookRole.
//
// Weil der Guard hier haengt, sind Login UND Buch-Id in jedem :book_id-Handler
// bereits geprueft: dort steht deshalb KEIN zweites sessionEmail()+401 und kein
// eigenes toIntId(req.params.book_id) — das waere toter Code mit einem zweiten
// error_code fuer dieselbe Lage. Die Buch-Id kommt als `req.bookId`.
router.param('book_id', aclParamGuard('viewer'));
const jsonBody = express.json({ limit: '1mb' });

const MAX_NAME_LEN = 200;
const MAX_NOTES_LEN = 8000;
const MAX_MINDMAP_BYTES = 256 * 1024;

function defaultMindmap(name) {
  return {
    meta: { name: 'figur-werkstatt', version: '1' },
    format: 'node_tree',
    data: {
      id: 'root',
      topic: name,
      children: [
        { id: 'steckbrief', topic: '__i18n:werkstatt.tree.steckbrief__', expanded: true, children: [
          { id: 'aussehen',        topic: '__i18n:werkstatt.tree.aussehen__' },
          { id: 'persoenlichkeit', topic: '__i18n:werkstatt.tree.persoenlichkeit__' },
          { id: 'hintergrund',     topic: '__i18n:werkstatt.tree.hintergrund__' },
          { id: 'beziehungen',     topic: '__i18n:werkstatt.tree.beziehungen__' },
          { id: 'konflikt',        topic: '__i18n:werkstatt.tree.konflikt__' },
          { id: 'bogen',           topic: '__i18n:werkstatt.tree.bogen__' },
          { id: 'musikgeschmack',  topic: '__i18n:werkstatt.tree.musikgeschmack__' },
        ]},
        { id: 'stimme', topic: '__i18n:werkstatt.tree.stimme__', expanded: true, children: [
          { id: 'sprechweise', topic: '__i18n:werkstatt.tree.sprechweise__' },
          { id: 'phrasen',     topic: '__i18n:werkstatt.tree.phrasen__' },
          { id: 'verben',      topic: '__i18n:werkstatt.tree.verben__' },
        ]},
        { id: 'subtext', topic: '__i18n:werkstatt.tree.subtext__', expanded: true, children: [
          { id: 'want',  topic: '__i18n:werkstatt.tree.want__' },
          { id: 'need',  topic: '__i18n:werkstatt.tree.need__' },
          { id: 'wound', topic: '__i18n:werkstatt.tree.wound__' },
          { id: 'lie',   topic: '__i18n:werkstatt.tree.lie__' },
        ]},
        { id: 'custom', topic: '__i18n:werkstatt.tree.custom__', children: [] },
      ],
    },
  };
}

function _validateMindmap(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (!obj.data || typeof obj.data !== 'object') return false;
  if (typeof obj.data.id !== 'string' || typeof obj.data.topic !== 'string') return false;
  const json = JSON.stringify(obj);
  if (json.length > MAX_MINDMAP_BYTES) return false;
  return true;
}

// Werkstatt-Runs: KI-Lauf-Historie pro Draft (Brainstorm + Consistency).
// Routen müssen VOR /:book_id stehen, sonst frisst der numerische Param-Match
// das Wort "runs" und Express liefert 400 INVALID_ID.
// Liste ohne result_json (spart bei vielen Einträgen); Detail liefert vollen
// JSON. Owner-Check via user_email auf draft (List) bzw. run (Get/Delete).
router.get('/by-id/:id/runs', (req, res) => {
  const draft = scopedDraft(req, res, req.params.id);
  if (!draft) return;
  res.json(listWerkstattRuns(draft.id, draft.user_email));
});

router.get('/runs/:run_id', (req, res) => {
  const run = scopedRun(req, res, req.params.run_id);
  if (!run) return;
  res.json(run);
});

router.delete('/runs/:run_id', (req, res) => {
  const run = scopedRun(req, res, req.params.run_id);
  if (!run) return;
  deleteWerkstattRun(run.id, run.user_email);
  res.json({ ok: true });
});

// Liste aller Werkstatt-Figuren eines Buchs (per User).
router.get('/:book_id', (req, res) => {
  res.json(listDraftFigures(req.bookId, sessionEmail(req)));
});

// Einzelne Werkstatt-Figur per id.
router.get('/by-id/:id', (req, res) => {
  const draft = scopedDraft(req, res, req.params.id);
  if (!draft) return;
  res.json(draft);
});

// Neue Werkstatt-Figur. Body: { name, archetype?, notes?, mindmap? }.
// Ohne mindmap → Default-Tree (Steckbrief + Stimme + Subtext + Eigene Aspekte).
router.post('/:book_id', jsonBody, (req, res) => {
  const userEmail = sessionEmail(req);
  const bookId = req.bookId;

  const name = (req.body?.name || '').toString().trim();
  if (!name) return res.status(400).json({ error_code: 'NAME_REQ' });
  if (name.length > MAX_NAME_LEN) return res.status(400).json({ error_code: 'NAME_TOO_LONG' });

  const archetype = req.body?.archetype ? String(req.body.archetype).trim().slice(0, 50) : null;
  const notes = req.body?.notes ? String(req.body.notes).slice(0, MAX_NOTES_LEN) : null;
  const mindmap = req.body?.mindmap || defaultMindmap(name);
  if (!_validateMindmap(mindmap)) return res.status(400).json({ error_code: 'MINDMAP_INVALID' });

  const created = createDraftFigure(bookId, userEmail, { name, archetype, mindmap, notes });
  logger.info(`[werkstatt] create id=${created.id} book=${bookId} name="${name}"`);
  res.json(created);
});

// Update. Body: { name?, archetype?, mindmap?, notes? }.
router.put('/:id', jsonBody, (req, res) => {
  const draft = scopedDraft(req, res, req.params.id);
  if (!draft) return;

  const name = req.body?.name != null
    ? String(req.body.name).trim()
    : draft.name;
  if (!name) return res.status(400).json({ error_code: 'NAME_REQ' });
  if (name.length > MAX_NAME_LEN) return res.status(400).json({ error_code: 'NAME_TOO_LONG' });

  const archetype = req.body?.archetype != null
    ? (req.body.archetype ? String(req.body.archetype).trim().slice(0, 50) : null)
    : draft.archetype;
  const notes = req.body?.notes != null
    ? (req.body.notes ? String(req.body.notes).slice(0, MAX_NOTES_LEN) : null)
    : draft.notes;
  const mindmap = req.body?.mindmap != null ? req.body.mindmap : draft.mindmap;
  if (!_validateMindmap(mindmap)) return res.status(400).json({ error_code: 'MINDMAP_INVALID' });

  const updated = updateDraftFigure(draft.id, { name, archetype, mindmap, notes });
  res.json(updated);
});

// Liste der figures eines Buchs, die noch nicht importiert wurden (per User,
// dedupliziert pro Name, mit Kontext-Zweitzeile). Abfrage samt Dedupe-Regel:
// db/draft-figures.js#listImportableFigures.
router.get('/:book_id/importable', (req, res) => {
  res.json(listImportableFigures(req.bookId, sessionEmail(req)));
});

// Werkstatt-Figur aus bestehender figures-Row importieren. Body: { figureId }.
// Idempotent gegenüber doppelten Klicks: bestehender Draft mit gleicher
// source_figure_id → 409 mit existingDraftId, damit das Frontend dorthin
// navigieren kann statt einen zweiten Draft anzulegen.
router.post('/:book_id/import', jsonBody, (req, res) => {
  const userEmail = sessionEmail(req);
  const bookId = req.bookId;
  const figureId = toIntId(req.body?.figureId);
  if (!figureId) return res.status(400).json({ error_code: 'FIGURE_ID_REQ' });

  const fig = getFigureWithDetails(figureId);
  if (!fig) return res.status(404).json({ error_code: 'FIGURE_NOT_FOUND' });
  if (fig.book_id !== bookId) return res.status(400).json({ error_code: 'FIGURE_BOOK_MISMATCH' });
  // Owner-Check: figures sind per User skopiert (ON DELETE pro User getrennt
  // via saveFigurenToDb). Nur eigene Figuren importierbar; Komplettanalyse-
  // Figuren mit user_email=NULL (Pre-Migration-Daten) bleiben verboten, sonst
  // entstünden Drafts ohne reverse-Owner-Pfad bei späterer figure-Mutation.
  if (fig.user_email !== userEmail) return res.status(403).json({ error_code: 'FORBIDDEN' });

  const existing = getDraftFigureBySource(bookId, userEmail, figureId);
  if (existing) {
    return res.status(409).json({ error_code: 'ALREADY_IMPORTED', existingDraftId: existing.id });
  }

  const mindmap = buildMindmapFromFigure(fig);
  if (!_validateMindmap(mindmap)) return res.status(500).json({ error_code: 'MINDMAP_INVALID' });
  const archetype = mapArchetype(fig.typ);
  const now = new Date().toISOString().slice(0, 10);
  const notes = `Importiert aus Figur "${fig.name}" am ${now}.`;

  const created = createDraftFigure(bookId, userEmail, {
    name: fig.name,
    archetype,
    mindmap,
    notes,
    sourceFigureId: figureId,
  });
  logger.info(`[werkstatt] import draft=${created.id} from figure=${figureId} ("${fig.name}")`);
  res.json(created);
});

router.delete('/:id', (req, res) => {
  const draft = scopedDraft(req, res, req.params.id);
  if (!draft) return;
  deleteDraftFigure(draft.id);
  logger.info(`[werkstatt] delete id=${draft.id}`);
  res.json({ ok: true });
});

module.exports = { router, defaultMindmap };
