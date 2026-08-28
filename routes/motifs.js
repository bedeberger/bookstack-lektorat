'use strict';
// CRUD-Routen der Motiv-Werkstatt (Themen & Motive, Beziehungen, Soll-Links).
// Pro Buch + User skopiert; ACL-Check pro Handler (analog routes/plot.js).
// Die KI-Motiverkennung (Ist-Index) läuft NICHT hier, sondern als Job unter
// /jobs/motif-scan. Rein planend/überwachend, nie generativ in den Text.

const express = require('express');
const motifsDb = require('../db/motifs');
const contentStore = require('../lib/content-store');
const { computeMotifFindings } = require('../lib/motif-consistency');
const embed = require('../lib/embed');
const appSettings = require('../lib/app-settings');
const semanticChunks = require('../db/semantic-chunks');
const { toIntId } = require('../lib/validate');
const { guardBook, sessionEmail } = require('../lib/acl');
const logger = require('../logger');

const router = express.Router();
const jsonBody = express.json();

const MAX_NAME = 200;
const MAX_BESCHREIBUNG = 4000;
const MAX_TYP = 60;
const MAX_TERM = 80;
const MAX_TERMS = 40;

// Entity per :id laden + Owner (user_email) + Buch-ACL prüfen. SSoT für :id-Handler.
function _loadOwned(req, res, getFn, notFoundCode) {
  const userEmail = sessionEmail(req);
  if (!userEmail) { res.status(401).json({ error_code: 'LOGIN_REQ' }); return null; }
  const id = toIntId(req.params.id);
  if (!id) { res.status(400).json({ error_code: 'INVALID_ID' }); return null; }
  const row = getFn(id);
  if (!row || row.user_email !== userEmail) { res.status(404).json({ error_code: notFoundCode }); return null; }
  if (!guardBook(req, res, row.book_id, 'editor')) return null;
  return row;
}

function _str(v, max) {
  const s = (v == null ? '' : String(v)).trim();
  return s ? s.slice(0, max) : '';
}
function _optStr(v, max) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}
function _colorOrNull(v) {
  return v == null ? null : String(v).slice(0, 32);
}
function _terms(v) {
  if (!Array.isArray(v)) return null;
  const clean = v.map(s => _str(s, MAX_TERM)).filter(Boolean).slice(0, MAX_TERMS);
  return clean.length ? clean : null;
}

// Frische des Embedding-Index fürs Buch (für den „Index aktualisieren"-Hinweis
// im Panel). Server-gestützt statt Session-Flag: `stale` ist true, wenn kein
// Index existiert oder Quell-Entitäten seit dem letzten Lauf geändert wurden
// (billige updated_at-Heuristik in semanticChunks.indexStatus, ohne Re-Hashing).
// Embedding-Backend aus → kein Hinweis (Panel warnt separat via semanticActive()).
function _embedIndexInfo(bookId) {
  if (!embed.isEnabled()) return { enabled: false, stale: false };
  const { model } = embed.getConfig();
  const st = semanticChunks.indexStatus(bookId, model);
  return { enabled: true, indexed: st.indexed, staleCount: st.staleCount, stale: !st.indexed || st.staleCount > 0 };
}

// Cosinus-Floor für die Ist-Fundstellen (App-Setting; 0 = alle zeigen). Blendet
// unwahrscheinliche semantische Treffer aus Liste + Ist-Dichte; wörtliche bleiben.
function _motifFloor() {
  return Number(appSettings.get('motif.scan.min_score')) || 0;
}

// ── Graph-Payload (Themen + Motive mit Soll-Links & Ist-Count + Beziehungen) ──

router.get('/', (req, res) => {
  const userEmail = sessionEmail(req);
  const bookId = toIntId(req.query.book_id);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  if (!guardBook(req, res, bookId, 'viewer')) return;
  const graph = motifsDb.getGraph(bookId, userEmail, _motifFloor());
  graph.embedIndex = _embedIndexInfo(bookId);
  res.json(graph);
});

// ── Konsistenz-Befunde (deterministisch, kein KI-Call) ──────────────────────
// Misst die vom Autor gezogenen Motiv-Kanten gegen den Ist-Index. Reines Lesen;
// die Rechnung selbst liegt pur in lib/motif-consistency.js. Vor /:id registriert
// (literales Segment, kein Konflikt). Ab `viewer` — ein Lektor darf die Befunde
// sehen, ohne am Katalog schreiben zu dürfen.
//
// Kapitel-Reihenfolge über die Content-Store-Facade (kein Direkt-SQL auf chapters);
// ausgeschlossene Kapitel bleiben drin — sie tragen trotzdem Fundstellen, und der
// Buchbogen ist eine Positions-, keine Auswahlfrage.
function _chapterOrder(tree) {
  const out = [];
  (function walk(chapters) {
    for (const c of chapters || []) {
      out.push(c.id);
      walk(c.subchapters);
    }
  })(tree?.chapters);
  return out;
}

router.get('/consistency', async (req, res) => {
  const userEmail = sessionEmail(req);
  const bookId = toIntId(req.query.book_id);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  if (!guardBook(req, res, bookId, 'viewer')) return;
  try {
    const graph = motifsDb.getGraph(bookId, userEmail, _motifFloor());
    // scanned=false ⇒ die Ist-Seite fehlt komplett. Dann meldet die Messung nichts,
    // statt jede Kante als „Motiv kommt nicht vor" zu markieren (ungescannt ist
    // ungeprüft, nicht abwesend) — das Frontend weist den Zustand aus.
    const scanned = motifsDb.hasOccurrences(bookId, userEmail);
    const chapterOrder = _chapterOrder(await contentStore.bookTree(bookId, req));
    const befunde = computeMotifFindings({
      motifs: graph.motifs, relations: graph.relations, chapterOrder, scanned,
    });
    res.json({ befunde, scanned, motifs: graph.motifs.length, relations: graph.relations.length });
  } catch (e) {
    logger.error(`[motifs] Konsistenz-Befunde fehlgeschlagen book=${bookId}: ${e.message}`, { stack: e.stack });
    res.status(500).json({ error_code: 'MOTIF_CONSISTENCY_FAILED' });
  }
});

// Manuelle Knoten-Positionen der Konstellation speichern (reine View-Präferenz).
// node_id → {x,y}; Keys/Zahlen defensiv validiert + gedeckelt (Frontend liefert
// vis-network getPositions()). Vor /:id registriert (literales Segment, kein Konflikt).
const MAX_LAYOUT_NODES = 5000;
function _validPositions(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (n >= MAX_LAYOUT_NODES) break;
    if (!k || typeof k !== 'string' || k.length > 64) continue;
    if (!v || typeof v !== 'object') continue;
    const x = Number(v.x), y = Number(v.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out[k] = { x: Math.round(x), y: Math.round(y) };
    n++;
  }
  return out;
}

router.put('/layout', jsonBody, (req, res) => {
  const userEmail = sessionEmail(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const bookId = toIntId(req.body?.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'BOOKID_REQ' });
  if (!guardBook(req, res, bookId, 'editor')) return;
  motifsDb.saveLayout(bookId, userEmail, _validPositions(req.body?.positions));
  res.json({ ok: true });
});

// ── Themen ─────────────────────────────────────────────────────────────────

router.post('/themes', jsonBody, (req, res) => {
  const userEmail = sessionEmail(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const bookId = toIntId(req.body?.book_id);
  const name = _str(req.body?.name, MAX_NAME);
  if (!bookId) return res.status(400).json({ error_code: 'BOOKID_REQ' });
  if (!name) return res.status(400).json({ error_code: 'NAME_REQ' });
  if (!guardBook(req, res, bookId, 'editor')) return;
  const theme = motifsDb.createTheme(bookId, userEmail, {
    name, beschreibung: _optStr(req.body?.beschreibung, MAX_BESCHREIBUNG), farbe: _colorOrNull(req.body?.farbe),
  });
  logger.info(`[motiv] theme create id=${theme.id} book=${bookId}`);
  res.json(theme);
});

router.patch('/themes/:id', jsonBody, (req, res) => {
  const theme = _loadOwned(req, res, motifsDb.getTheme, 'THEME_NOT_FOUND');
  if (!theme) return;
  const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, MAX_NAME) : theme.name;
  if (!name) return res.status(400).json({ error_code: 'NAME_REQ' });
  const beschreibung = req.body?.beschreibung === undefined ? theme.beschreibung : _optStr(req.body?.beschreibung, MAX_BESCHREIBUNG);
  const farbe = req.body?.farbe === undefined ? theme.farbe : _colorOrNull(req.body?.farbe);
  res.json(motifsDb.updateTheme(theme.id, { name, beschreibung, farbe }));
});

router.delete('/themes/:id', (req, res) => {
  const theme = _loadOwned(req, res, motifsDb.getTheme, 'THEME_NOT_FOUND');
  if (!theme) return;
  motifsDb.deleteTheme(theme.id);
  logger.info(`[motiv] theme delete id=${theme.id} book=${theme.book_id}`);
  res.json({ ok: true });
});

router.put('/themes/order', jsonBody, (req, res) => {
  const userEmail = sessionEmail(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const bookId = toIntId(req.body?.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'BOOKID_REQ' });
  if (!Array.isArray(req.body?.order)) return res.status(400).json({ error_code: 'ORDER_REQ' });
  if (!guardBook(req, res, bookId, 'editor')) return;
  motifsDb.reorderThemes(bookId, userEmail, req.body.order);
  res.json({ ok: true });
});

// ── Motiv-Beziehungen (Motiv ↔ Motiv) ──────────────────────────────────────
// Vor /:id registriert (zweisegmentig, kollidiert nicht mit /:id).

router.post('/relations', jsonBody, (req, res) => {
  const userEmail = sessionEmail(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const fromId = toIntId(req.body?.from_motif_id);
  const toId = toIntId(req.body?.to_motif_id);
  const typ = _str(req.body?.typ, MAX_TYP);
  if (!fromId || !toId) return res.status(400).json({ error_code: 'MOTIF_ID_REQ' });
  if (fromId === toId) return res.status(400).json({ error_code: 'SELF_RELATION' });
  if (!typ) return res.status(400).json({ error_code: 'TYP_REQ' });
  const from = motifsDb.getMotif(fromId);
  const to = motifsDb.getMotif(toId);
  if (!from || !to || from.user_email !== userEmail || to.user_email !== userEmail || from.book_id !== to.book_id) {
    return res.status(404).json({ error_code: 'MOTIF_NOT_FOUND' });
  }
  if (!guardBook(req, res, from.book_id, 'editor')) return;
  const id = motifsDb.createRelation(fromId, toId, typ);
  res.json({ id, from_motif_id: fromId, to_motif_id: toId, typ });
});

router.delete('/relations/:id', (req, res) => {
  const userEmail = sessionEmail(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const owner = motifsDb.getRelationOwner(id);
  if (!owner || owner.user_email !== userEmail) return res.status(404).json({ error_code: 'RELATION_NOT_FOUND' });
  if (!guardBook(req, res, owner.book_id, 'editor')) return;
  motifsDb.deleteRelation(id);
  res.json({ ok: true });
});

// ── KI-Brainstorm-Lauf-Historie ─────────────────────────────────────────────
// Persistierte Läufe pro (Buch, User). Kein POST — der Insert passiert job-seitig
// beim Complete. Zweisegmentig (/brainstorm-runs[/:id]) → kollidiert nicht mit den
// einsegmentigen /:id-Motiv-Routen; trotzdem vor ihnen registriert (Konvention).

router.get('/brainstorm-runs', (req, res) => {
  const userEmail = sessionEmail(req);
  const bookId = toIntId(req.query.book_id);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  if (!guardBook(req, res, bookId, 'viewer')) return;
  res.json(motifsDb.listBrainstormRuns(bookId, userEmail));
});

router.get('/brainstorm-runs/:id', (req, res) => {
  const run = _loadOwned(req, res, motifsDb.getBrainstormRun, 'RUN_NOT_FOUND');
  if (!run) return;
  res.json(run);
});

router.delete('/brainstorm-runs/:id', (req, res) => {
  const userEmail = sessionEmail(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const run = motifsDb.getBrainstormRun(id);
  if (!run || run.user_email !== userEmail) return res.status(404).json({ error_code: 'RUN_NOT_FOUND' });
  if (!guardBook(req, res, run.book_id, 'editor')) return;
  motifsDb.deleteBrainstormRun(id, userEmail);
  res.json({ ok: true });
});

// ── KI-Consistency-Lauf-Historie ────────────────────────────────────────────
// Nur die KI-Laeufe (Job `motif-consistency`) haben eine Historie. Die
// deterministischen Befunde liefert `GET /consistency` bei jedem Aufruf frisch.

router.get('/consistency-runs', (req, res) => {
  const userEmail = sessionEmail(req);
  const bookId = toIntId(req.query.book_id);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  if (!guardBook(req, res, bookId, 'viewer')) return;
  res.json(motifsDb.listConsistencyRuns(bookId, userEmail));
});

router.get('/consistency-runs/:id', (req, res) => {
  const run = _loadOwned(req, res, motifsDb.getConsistencyRun, 'RUN_NOT_FOUND');
  if (!run) return;
  res.json(run);
});

router.delete('/consistency-runs/:id', (req, res) => {
  const userEmail = sessionEmail(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const id = toIntId(req.params.id);
  if (!id) return res.status(400).json({ error_code: 'INVALID_ID' });
  const run = motifsDb.getConsistencyRun(id);
  if (!run || run.user_email !== userEmail) return res.status(404).json({ error_code: 'RUN_NOT_FOUND' });
  if (!guardBook(req, res, run.book_id, 'editor')) return;
  motifsDb.deleteConsistencyRun(id, userEmail);
  res.json({ ok: true });
});

// ── Motive ───────────────────────────────────────────────────────────────

router.post('/', jsonBody, (req, res) => {
  const userEmail = sessionEmail(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const bookId = toIntId(req.body?.book_id);
  const name = _str(req.body?.name, MAX_NAME);
  if (!bookId) return res.status(400).json({ error_code: 'BOOKID_REQ' });
  if (!name) return res.status(400).json({ error_code: 'NAME_REQ' });
  if (!guardBook(req, res, bookId, 'editor')) return;
  // theme_id (falls gesetzt) muss dem User im selben Buch gehören.
  let themeId = toIntId(req.body?.theme_id);
  if (themeId) {
    const t = motifsDb.getTheme(themeId);
    if (!t || t.book_id !== bookId || t.user_email !== userEmail) themeId = null;
  }
  const motif = motifsDb.createMotif(bookId, userEmail, {
    themeId, name,
    beschreibung: _optStr(req.body?.beschreibung, MAX_BESCHREIBUNG),
    triggerTerms: _terms(req.body?.trigger_terms),
    farbe: _colorOrNull(req.body?.farbe),
  });
  logger.info(`[motiv] motif create id=${motif.id} book=${bookId}`);
  res.json(motif);
});

router.put('/order', jsonBody, (req, res) => {
  const userEmail = sessionEmail(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const bookId = toIntId(req.body?.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'BOOKID_REQ' });
  if (!Array.isArray(req.body?.order)) return res.status(400).json({ error_code: 'ORDER_REQ' });
  if (!guardBook(req, res, bookId, 'editor')) return;
  motifsDb.reorderMotifs(bookId, userEmail, req.body.order);
  res.json({ ok: true });
});

// Soll-Verknüpfungen setzen (Full-Replace aller fünf Brücken). figures als fig_id,
// draftFigures als INTEGER draft_figures.id (Werkstatt-Figuren).
router.put('/:id/links', jsonBody, (req, res) => {
  const motif = _loadOwned(req, res, motifsDb.getMotif, 'MOTIF_NOT_FOUND');
  if (!motif) return;
  const b = motif.book_id;
  const userEmail = motif.user_email;
  if (req.body?.figures !== undefined) {
    motifsDb.setMotifFigures(motif.id, motifsDb.resolveFigureIds(b, req.body.figures));
  }
  if (req.body?.draftFigures !== undefined) {
    motifsDb.setMotifDraftFigures(motif.id, motifsDb.validDraftFigureIds(b, userEmail, req.body.draftFigures));
  }
  if (req.body?.beats !== undefined) {
    motifsDb.setMotifBeats(motif.id, motifsDb.validBeatIds(b, userEmail, req.body.beats));
  }
  if (req.body?.chapters !== undefined) {
    motifsDb.setMotifChapters(motif.id, motifsDb.validChapterIds(b, req.body.chapters));
  }
  if (req.body?.pages !== undefined) {
    motifsDb.setMotifPages(motif.id, motifsDb.validPageIds(b, req.body.pages));
  }
  res.json({ ok: true });
});

// Fundstellen-Detail eines Motivs (Ist-Index, Seiten-/Szenen-Kontext via JOIN).
router.get('/:id/occurrences', (req, res) => {
  const motif = _loadOwned(req, res, motifsDb.getMotif, 'MOTIF_NOT_FOUND');
  if (!motif) return;
  res.json({ occurrences: motifsDb.listOccurrences(motif.id, _motifFloor()) });
});

router.patch('/:id', jsonBody, (req, res) => {
  const motif = _loadOwned(req, res, motifsDb.getMotif, 'MOTIF_NOT_FOUND');
  if (!motif) return;
  const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, MAX_NAME) : motif.name;
  if (!name) return res.status(400).json({ error_code: 'NAME_REQ' });
  const beschreibung = req.body?.beschreibung === undefined ? motif.beschreibung : _optStr(req.body?.beschreibung, MAX_BESCHREIBUNG);
  const triggerTerms = req.body?.trigger_terms === undefined ? motif.trigger_terms : _terms(req.body?.trigger_terms);
  const farbe = req.body?.farbe === undefined ? motif.farbe : _colorOrNull(req.body?.farbe);
  let themeId = motif.theme_id;
  if (req.body?.theme_id !== undefined) {
    themeId = toIntId(req.body?.theme_id) || null;
    if (themeId) {
      const t = motifsDb.getTheme(themeId);
      if (!t || t.book_id !== motif.book_id || t.user_email !== motif.user_email) themeId = null;
    }
  }
  res.json(motifsDb.updateMotif(motif.id, { themeId, name, beschreibung, triggerTerms, farbe }));
});

router.delete('/:id', (req, res) => {
  const motif = _loadOwned(req, res, motifsDb.getMotif, 'MOTIF_NOT_FOUND');
  if (!motif) return;
  motifsDb.deleteMotif(motif.id);
  logger.info(`[motiv] motif delete id=${motif.id} book=${motif.book_id}`);
  res.json({ ok: true });
});

module.exports = router;
