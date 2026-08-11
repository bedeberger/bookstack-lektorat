'use strict';
// CRUD für draft_figures (Figuren-Werkstatt). Owner-Check pro Operation.
// Default-Mindmap-Knoten als i18n-Marker persistiert; Frontend löst via t() auf,
// damit die Locale-Wahl des späteren Betrachters gilt (CLAUDE.md-Pattern).

const express = require('express');
const {
  listDraftFigures, getDraftFigure, getDraftFigureBySource,
  createDraftFigure, updateDraftFigure, deleteDraftFigure,
  listWerkstattRuns, getWerkstattRun, deleteWerkstattRun,
  getFigureWithDetails, db,
} = require('../db/schema');
const { toIntId } = require('../lib/validate');
const { aclParamGuard, sessionEmail } = require('../lib/acl');
const logger = require('../logger');

const router = express.Router();
// ACL: jede :book_id-Route erfordert mind. viewer-Rolle (drafts user-scoped,
// aber Anlage auf fremden Büchern sonst möglich → IDOR). Setzt zugleich den
// ALS-Logging-Context (book) + req.bookId/req.bookRole.
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
  const userEmail = sessionEmail(req);
  const id = toIntId(req.params.id);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  if (!id)        return res.status(400).json({ error_code: 'INVALID_ID' });
  const draft = getDraftFigure(id);
  if (!draft) return res.status(404).json({ error_code: 'NOT_FOUND' });
  if (draft.user_email !== userEmail) return res.status(403).json({ error_code: 'FORBIDDEN' });
  res.json(listWerkstattRuns(id, userEmail));
});

router.get('/runs/:run_id', (req, res) => {
  const userEmail = sessionEmail(req);
  const id = toIntId(req.params.run_id);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  if (!id)        return res.status(400).json({ error_code: 'INVALID_ID' });
  const run = getWerkstattRun(id);
  if (!run) return res.status(404).json({ error_code: 'NOT_FOUND' });
  if (run.user_email !== userEmail) return res.status(403).json({ error_code: 'FORBIDDEN' });
  res.json(run);
});

router.delete('/runs/:run_id', (req, res) => {
  const userEmail = sessionEmail(req);
  const id = toIntId(req.params.run_id);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  if (!id)        return res.status(400).json({ error_code: 'INVALID_ID' });
  const changes = deleteWerkstattRun(id, userEmail);
  if (!changes) return res.status(404).json({ error_code: 'NOT_FOUND' });
  res.json({ ok: true });
});

// Liste aller Werkstatt-Figuren eines Buchs (per User).
router.get('/:book_id', (req, res) => {
  const userEmail = sessionEmail(req);
  const bookId = toIntId(req.params.book_id);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  if (!bookId)    return res.status(400).json({ error_code: 'INVALID_ID' });
  res.json(listDraftFigures(bookId, userEmail));
});

// Einzelne Werkstatt-Figur per id.
router.get('/by-id/:id', (req, res) => {
  const userEmail = sessionEmail(req);
  const id = toIntId(req.params.id);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  if (!id)        return res.status(400).json({ error_code: 'INVALID_ID' });
  const draft = getDraftFigure(id);
  if (!draft) return res.status(404).json({ error_code: 'NOT_FOUND' });
  if (draft.user_email !== userEmail) return res.status(403).json({ error_code: 'FORBIDDEN' });
  res.json(draft);
});

// Neue Werkstatt-Figur. Body: { name, archetype?, notes?, mindmap? }.
// Ohne mindmap → Default-Tree (Steckbrief + Stimme + Subtext + Eigene Aspekte).
router.post('/:book_id', jsonBody, (req, res) => {
  const userEmail = sessionEmail(req);
  const bookId = toIntId(req.params.book_id);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  if (!bookId)    return res.status(400).json({ error_code: 'INVALID_ID' });

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
  const userEmail = sessionEmail(req);
  const id = toIntId(req.params.id);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  if (!id)        return res.status(400).json({ error_code: 'INVALID_ID' });
  const draft = getDraftFigure(id);
  if (!draft) return res.status(404).json({ error_code: 'NOT_FOUND' });
  if (draft.user_email !== userEmail) return res.status(403).json({ error_code: 'FORBIDDEN' });

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

  const updated = updateDraftFigure(id, { name, archetype, mindmap, notes });
  res.json(updated);
});

// Liste der figures eines Buchs, die noch nicht importiert wurden.
// Ausgeschlossen: figures, für die der User bereits einen Werkstatt-Draft hat
// (per source_figure_id). Genutzt vom Import-Picker im Frontend.
//
// Pro Figur kommt Kontext mit (Hauptkapitel = häufigster Auftritt, Beruf,
// Geburtstag/Jahrgang), den der Picker als Zweitzeile anzeigt.
//
// Dedupe pro Name: der figures-Katalog kann durch Komplettanalyse-Merge-
// Kollisionen (fig_id `__2`-Suffix) zwei Rows mit demselben Namen enthalten.
// Im Picker pro Name nur die inhaltsreichste Row anbieten (meiste Auftritte,
// Tie-Break längere Beschreibung, dann höchste id = neuere Extraktion), damit
// dieselbe Figur nicht doppelt erscheint.
router.get('/:book_id/importable', (req, res) => {
  const userEmail = sessionEmail(req);
  const bookId = toIntId(req.params.book_id);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  if (!bookId)    return res.status(400).json({ error_code: 'INVALID_ID' });
  const rows = db.prepare(`
    SELECT f.id, f.name, f.kurzname, f.typ, f.beschreibung, f.beruf, f.geburtstag,
           (SELECT c.chapter_name
              FROM figure_appearances fa
              JOIN chapters c ON c.chapter_id = fa.chapter_id
             WHERE fa.figure_id = f.id
             ORDER BY fa.haeufigkeit DESC, c.position
             LIMIT 1) AS hauptkapitel,
           (SELECT COALESCE(SUM(fa.haeufigkeit), 0)
              FROM figure_appearances fa
             WHERE fa.figure_id = f.id) AS auftritte
      FROM figures f
      LEFT JOIN draft_figures d
        ON d.source_figure_id = f.id AND d.user_email = ?
     WHERE f.book_id = ? AND f.user_email IS ? AND d.id IS NULL
     ORDER BY f.sort_order, f.id
  `).all(userEmail, bookId, userEmail);

  const byName = new Map();
  for (const r of rows) {
    const key = r.name.trim().toLowerCase();
    const prev = byName.get(key);
    if (!prev || _figureRicher(r, prev)) byName.set(key, r);
  }
  const deduped = [...byName.values()]
    .sort((a, b) => (a.sort_order - b.sort_order) || (a.id - b.id))
    .map(({ auftritte, ...rest }) => rest);
  res.json(deduped);
});

// Welche von zwei gleichnamigen figures-Rows ist im Import-Picker zu bevorzugen?
function _figureRicher(a, b) {
  if ((a.auftritte || 0) !== (b.auftritte || 0)) return (a.auftritte || 0) > (b.auftritte || 0);
  const al = (a.beschreibung || '').length, bl = (b.beschreibung || '').length;
  if (al !== bl) return al > bl;
  return a.id > b.id;
}

// Werkstatt-Figur aus bestehender figures-Row importieren. Body: { figureId }.
// Idempotent gegenüber doppelten Klicks: bestehender Draft mit gleicher
// source_figure_id → 409 mit existingDraftId, damit das Frontend dorthin
// navigieren kann statt einen zweiten Draft anzulegen.
router.post('/:book_id/import', jsonBody, (req, res) => {
  const userEmail = sessionEmail(req);
  const bookId = toIntId(req.params.book_id);
  const figureId = toIntId(req.body?.figureId);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  if (!bookId)    return res.status(400).json({ error_code: 'INVALID_ID' });
  if (!figureId)  return res.status(400).json({ error_code: 'FIGURE_ID_REQ' });

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

  const { buildMindmapFromFigure, mapArchetype } = require('../lib/draft-mindmap-builder');
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
  const userEmail = sessionEmail(req);
  const id = toIntId(req.params.id);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  if (!id)        return res.status(400).json({ error_code: 'INVALID_ID' });
  const draft = getDraftFigure(id);
  if (!draft) return res.status(404).json({ error_code: 'NOT_FOUND' });
  if (draft.user_email !== userEmail) return res.status(403).json({ error_code: 'FORBIDDEN' });
  deleteDraftFigure(id);
  logger.info(`[werkstatt] delete id=${id}`);
  res.json({ ok: true });
});

module.exports = { router, defaultMindmap };
