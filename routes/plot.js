'use strict';
// Plot-Werkstatt (Beat-Board): CRUD für Akte (Spalten) + Beats (Karten) +
// Drag-&-Drop-Reordering. Pro Buch + User skopiert; ACL-Guard via
// requireBookAccess('editor') — planendes Welt-/Plot-Werkzeug, kein Lesezugang.
//
// KI-Assistenz (Brainstorm + Consistency) läuft separat über die Job-Queue
// (routes/jobs/plot.js), nicht hier.

const express = require('express');
const { getDraftFigure } = require('../db/schema');
const plotDb = require('../db/plot');
const { toIntId } = require('../lib/validate');
const { resolveChapterBookId } = require('../lib/content-ownership');
const { setContext } = require('../lib/log-context');
const { requireBookAccess, sendACLError, sessionEmail } = require('../lib/acl');
const appSettings = require('../lib/app-settings');
const logger = require('../logger');

const router = express.Router();
const jsonBody = express.json();

// Status ist die binäre Realisierungsachse (Idee ↔ eingearbeitet). „Verworfen" ist
// ein eigenes Flag (verworfen 0/1), keine Status-Stufe.
const STATUSES = ['geplant', 'im_buch'];
const MAX_TITEL = 200;
const MAX_BESCHREIBUNG = 4000;
const MAX_ACT_NAME = 120;
const MAX_THREAD_NAME = 120;

function _guard(req, res, bookId, minRole = 'editor') {
  setContext({ book: bookId });
  try { requireBookAccess(req, bookId, minRole); return true; }
  catch (e) { return !sendACLError(res, e); }
}

// Entity per :id laden + Owner (user_email) + Buch-ACL prüfen. Gibt die Entity
// zurück oder null (die passende Fehler-Response wurde dann bereits gesendet).
// SSoT für die sonst in jedem :id-Handler (Akt/Beat/Thread/Run) wiederholte
// Login-/ID-/Owner-/Guard-Kette.
function _loadOwned(req, res, getFn, notFoundCode) {
  const userEmail = sessionEmail(req);
  if (!userEmail) { res.status(401).json({ error_code: 'LOGIN_REQ' }); return null; }
  const id = toIntId(req.params.id);
  if (!id) { res.status(400).json({ error_code: 'INVALID_ID' }); return null; }
  const row = getFn(id);
  if (!row || row.user_email !== userEmail) { res.status(404).json({ error_code: notFoundCode }); return null; }
  if (!_guard(req, res, row.book_id)) return null;
  return row;
}

// Book-skopierte Collection-Handler (kein :id): Login + book_id + ACL-Guard in
// einem Schritt. Gibt { userEmail, bookId } zurück oder null (die passende
// Fehler-Response wurde dann bereits gesendet). Pendant zu _loadOwned für die
// :id-Handler — SSoT für die sonst in jedem GET-Collection-Handler wiederholte
// Login-/book_id-/Guard-Kette. Der Guard läuft VOR handler-spezifischen
// Zusatz-Validierungen (z.B. draft_id) — kein Leak an nicht-autorisierte Aufrufer.
function _requireBook(req, res) {
  const userEmail = sessionEmail(req);
  if (!userEmail) { res.status(401).json({ error_code: 'LOGIN_REQ' }); return null; }
  const bookId = toIntId(req.query.book_id);
  if (!bookId) { res.status(400).json({ error_code: 'INVALID_ID' }); return null; }
  if (!_guard(req, res, bookId)) return null;
  return { userEmail, bookId };
}

// chapter_id muss zum Buch gehören, sonst NULL (kein Fremd-Verweis).
function _validChapterId(bookId, chapterId) {
  if (!chapterId) return null;
  return resolveChapterBookId(chapterId) === bookId ? parseInt(chapterId, 10) : null;
}

// Ein Akt passt zu einem Strang, wenn er GETEILT ist (thread_id NULL) ODER genau
// diesem Strang gehört (Hybrid-Akte). Verhindert, dass ein Beat in den eigenen Akt
// eines FREMDEN Strangs (oder in die „ohne Strang"-Lane auf einem eigenen Akt) wandert.
function _actFitsThread(act, threadId) {
  return act.thread_id == null || act.thread_id === (threadId ?? null);
}

// Spannungswert (1–5) für den Spannungsbogen, sonst NULL. Out-of-Range / Müll → NULL.
function _validIntensitaet(raw) {
  if (raw === null || raw === '' || typeof raw === 'undefined') return null;
  const n = parseInt(raw);
  return (Number.isInteger(n) && n >= 1 && n <= 5) ? n : null;
}

// Figuren-Bindung eines Strangs auflösen + aufs (Buch, User)-Subset validieren.
// figure_id kommt als TEXT-fig_id (Frontend-Identität) → INTEGER figures.id;
// draft_figure_id ist bereits INTEGER draft_figures.id. Fremd/leer → null.
function _resolveThreadFigure(bookId, userEmail, rawFigId) {
  return rawFigId ? (plotDb.resolveFigureIds(bookId, userEmail, [rawFigId])[0] || null) : null;
}
function _resolveThreadDraftFigure(bookId, userEmail, rawDraftId) {
  return rawDraftId ? (plotDb.resolveDraftFigureIds(bookId, userEmail, [rawDraftId])[0] || null) : null;
}

// ── Board laden ──────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const ctx = _requireBook(req, res);
  if (!ctx) return;
  const { userEmail, bookId } = ctx;
  // Ist-Index der Beat-Verankerung an jeden Beat hängen (count + Top-Fundstellen)
  // → Drift-Badge + Fundstellen-Popover im Frontend (Soll `status` vs. Ist). Kein
  // Extra-Call. navigableOnly: nur anspringbare Fundstellen (Szene ohne Seite fällt
  // raus); minScore: konfigurierbarer Score-Floor blendet schwache Treffer aus.
  const minScore = Number(appSettings.get('plot.anchor.min_score')) || 0;
  const occMap = plotDb.beatOccurrenceMap(bookId, userEmail, { minScore, navigableOnly: true });
  const beats = plotDb.listBeats(bookId, userEmail).map(b => {
    const occ = occMap.get(b.id);
    return { ...b, occ_count: occ ? occ.count : 0, occ_top: occ ? occ.top : [] };
  });
  // Geplante Beats werden nur verankert, wenn die Promotion-Erkennung an ist — dann
  // zählen sie auch für die Stale-Heuristik (sonst würde ein geänderter geplanter
  // Beat fälschlich zum „Verankerung aktualisieren"-Angebot führen).
  const promoteOn = (Number(appSettings.get('plot.anchor.promote_min_score')) || 0) > 0;
  const staleStatuses = promoteOn ? ['im_buch', 'geplant'] : ['im_buch'];
  res.json({
    acts: plotDb.listActs(bookId, userEmail),
    threads: plotDb.listThreads(bookId, userEmail),
    beats,
    relations: plotDb.listBeatRelations(bookId, userEmail),
    beatAnchor: { stale: plotDb.beatAnchorStale(bookId, userEmail, staleStatuses) },
  });
});

// Map page_id → Anzahl nicht-verworfener Beats im Kapitel der Seite. Speist den
// Plot-Verknüpfungs-Indikator im Notebook-Editor (wie /ideen/counts,
// /research/page-counts). Pro Buch + User skopiert.
router.get('/page-beat-counts', (req, res) => {
  const ctx = _requireBook(req, res);
  if (!ctx) return;
  res.json(plotDb.pageBeatCounts(ctx.bookId, ctx.userEmail));
});

// Plot-Beteiligung einer Werkstatt-Figur: Anzahl Beats (gesamt + aktiv) + die
// Stränge, an die die Figur als Hauptfigur gebunden ist. Speist das „in N Beats
// geplant"-Badge in der Figuren-Werkstatt (Navigation Werkstatt → Plot). draft_id
// Pflicht; die Katalog-Quellfigur (source_figure_id) wird serverseitig aus dem
// Owner-geprüften Draft gezogen, nicht vom Client geliefert (kein Cross-Figur-Leak).
router.get('/figure-usage', (req, res) => {
  const ctx = _requireBook(req, res);
  if (!ctx) return;
  const { userEmail, bookId } = ctx;
  const draftId = toIntId(req.query.draft_id);
  if (!draftId) return res.status(400).json({ error_code: 'DRAFT_ID_REQ' });
  const draft = getDraftFigure(draftId);
  if (!draft || draft.user_email !== userEmail || draft.book_id !== bookId) {
    return res.json({ beatCount: 0, activeBeatCount: 0, threads: [] });
  }
  const usage = plotDb.figurePlotUsage(bookId, userEmail, {
    draftFigureId: draft.id, sourceFigureId: draft.source_figure_id,
  });
  res.json({
    beatCount: usage.beats.length,
    activeBeatCount: usage.beats.filter(b => !b.verworfen).length,
    threads: usage.threads,
  });
});

// Map chapter_id → Anzahl nicht-verworfener Beats im Kapitel. Speist den
// Plot-Verknüpfungs-Indikator in der Kapitelansicht.
router.get('/chapter-beat-counts', (req, res) => {
  const ctx = _requireBook(req, res);
  if (!ctx) return;
  res.json(plotDb.chapterBeatCounts(ctx.bookId, ctx.userEmail));
});

// ── Akte ─────────────────────────────────────────────────────────────────────
router.post('/acts', jsonBody, (req, res) => {
  const userEmail = sessionEmail(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const bookId = toIntId(req.body?.book_id);
  const name = (req.body?.name || '').toString().trim();
  const farbe = req.body?.farbe ? String(req.body.farbe).slice(0, 32) : null;
  if (!bookId) return res.status(400).json({ error_code: 'BOOKID_REQ' });
  if (!name)   return res.status(400).json({ error_code: 'NAME_REQ' });
  if (name.length > MAX_ACT_NAME) return res.status(400).json({ error_code: 'NAME_TOO_LONG' });
  if (!_guard(req, res, bookId)) return;
  // thread_id optional: gesetzt → strang-eigener Akt (Hybrid). Fremd/leer → NULL
  // (geteilter Akt). Validierung gegen (Buch, User) via _validThreadId.
  const threadId = plotDb._validThreadId(bookId, userEmail, toIntId(req.body?.thread_id));
  const act = plotDb.createAct(bookId, userEmail, { name, farbe, threadId });
  logger.info(`[plot] act create id=${act.id} book=${bookId} thread=${threadId ?? '-'}`);
  res.json(act);
});

router.patch('/acts/:id', jsonBody, (req, res) => {
  const act = _loadOwned(req, res, plotDb.getAct, 'ACT_NOT_FOUND');
  if (!act) return;
  const id = act.id;
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : act.name;
  if (!name) return res.status(400).json({ error_code: 'NAME_REQ' });
  if (name.length > MAX_ACT_NAME) return res.status(400).json({ error_code: 'NAME_TOO_LONG' });
  const farbe = typeof req.body?.farbe === 'string' ? req.body.farbe.slice(0, 32)
    : (req.body?.farbe === null ? null : act.farbe);
  res.json(plotDb.updateAct(id, { name, farbe }));
});

router.delete('/acts/:id', (req, res) => {
  const act = _loadOwned(req, res, plotDb.getAct, 'ACT_NOT_FOUND');
  if (!act) return;
  plotDb.deleteAct(act.id);
  logger.info(`[plot] act delete id=${act.id} book=${act.book_id}`);
  res.json({ ok: true });
});

router.put('/acts/order', jsonBody, (req, res) => {
  const userEmail = sessionEmail(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const bookId = toIntId(req.body?.book_id);
  const order = Array.isArray(req.body?.order) ? req.body.order : null;
  if (!bookId) return res.status(400).json({ error_code: 'BOOKID_REQ' });
  if (!order)  return res.status(400).json({ error_code: 'ORDER_REQ' });
  if (!_guard(req, res, bookId)) return;
  plotDb.reorderActs(bookId, userEmail, order);
  res.json({ ok: true });
});

// ── Handlungsstränge (Swimlanes) ───────────────────────────────────────────
router.post('/threads', jsonBody, (req, res) => {
  const userEmail = sessionEmail(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const bookId = toIntId(req.body?.book_id);
  const name = (req.body?.name || '').toString().trim();
  const farbe = req.body?.farbe ? String(req.body.farbe).slice(0, 32) : null;
  if (!bookId) return res.status(400).json({ error_code: 'BOOKID_REQ' });
  if (!name)   return res.status(400).json({ error_code: 'NAME_REQ' });
  if (name.length > MAX_THREAD_NAME) return res.status(400).json({ error_code: 'NAME_TOO_LONG' });
  if (!_guard(req, res, bookId)) return;
  const figureId = _resolveThreadFigure(bookId, userEmail, req.body?.figure_id);
  const draftFigureId = _resolveThreadDraftFigure(bookId, userEmail, req.body?.draft_figure_id);
  const chapterId = _validChapterId(bookId, toIntId(req.body?.chapter_id));
  const thread = plotDb.createThread(bookId, userEmail, { name, farbe, figureId, draftFigureId, chapterId });
  logger.info(`[plot] thread create id=${thread.id} book=${bookId}`);
  res.json(thread);
});

router.patch('/threads/:id', jsonBody, (req, res) => {
  const thread = _loadOwned(req, res, plotDb.getThread, 'THREAD_NOT_FOUND');
  if (!thread) return;
  const id = thread.id;
  const userEmail = thread.user_email;
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : thread.name;
  if (!name) return res.status(400).json({ error_code: 'NAME_REQ' });
  if (name.length > MAX_THREAD_NAME) return res.status(400).json({ error_code: 'NAME_TOO_LONG' });
  const farbe = typeof req.body?.farbe === 'string' ? req.body.farbe.slice(0, 32)
    : (req.body?.farbe === null ? null : thread.farbe);
  // Bindung nur ändern, wenn der Key explizit mitkommt — sonst Bestand behalten.
  let figureId = thread.figure_id;
  if (typeof req.body?.figure_id !== 'undefined') {
    figureId = _resolveThreadFigure(thread.book_id, userEmail, req.body.figure_id);
  }
  let draftFigureId = thread.draft_figure_id;
  if (typeof req.body?.draft_figure_id !== 'undefined') {
    draftFigureId = _resolveThreadDraftFigure(thread.book_id, userEmail, req.body.draft_figure_id);
  }
  // Kapitel-Bindung nur ändern, wenn der Key explizit mitkommt — sonst Bestand.
  let chapterId = thread.chapter_id;
  if (typeof req.body?.chapter_id !== 'undefined') {
    chapterId = _validChapterId(thread.book_id, toIntId(req.body.chapter_id));
  }
  res.json(plotDb.updateThread(id, { name, farbe, figureId, draftFigureId, chapterId }));
});

router.delete('/threads/:id', (req, res) => {
  const thread = _loadOwned(req, res, plotDb.getThread, 'THREAD_NOT_FOUND');
  if (!thread) return;
  plotDb.deleteThread(thread.id);
  logger.info(`[plot] thread delete id=${thread.id} book=${thread.book_id}`);
  res.json({ ok: true });
});

router.put('/threads/order', jsonBody, (req, res) => {
  const userEmail = sessionEmail(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const bookId = toIntId(req.body?.book_id);
  const order = Array.isArray(req.body?.order) ? req.body.order : null;
  if (!bookId) return res.status(400).json({ error_code: 'BOOKID_REQ' });
  if (!order)  return res.status(400).json({ error_code: 'ORDER_REQ' });
  if (!_guard(req, res, bookId)) return;
  plotDb.reorderThreads(bookId, userEmail, order);
  res.json({ ok: true });
});

// Eigene Aktstruktur für einen Strang aktivieren (Hybrid-Akte): die geteilten Akte
// werden in den Strang geklont, dessen Beats wandern auf die Klone. Braucht ≥1
// geteilten Akt (sonst NO_SHARED_ACTS). Idempotent (schon geforkt → ok).
router.post('/threads/:id/fork-acts', (req, res) => {
  const thread = _loadOwned(req, res, plotDb.getThread, 'THREAD_NOT_FOUND');
  if (!thread) return;
  try {
    plotDb.forkThreadActs(thread.book_id, thread.user_email, thread.id);
  } catch (e) {
    if (e.code === 'NO_SHARED_ACTS') return res.status(400).json({ error_code: 'NO_SHARED_ACTS' });
    throw e;
  }
  logger.info(`[plot] thread fork-acts id=${thread.id} book=${thread.book_id}`);
  res.json({ ok: true });
});

// Eigene Aktstruktur auflösen: Beats zurück auf die geteilten Akte umhängen
// (positionsweise) und die strang-eigenen Akte löschen.
router.delete('/threads/:id/fork-acts', (req, res) => {
  const thread = _loadOwned(req, res, plotDb.getThread, 'THREAD_NOT_FOUND');
  if (!thread) return;
  plotDb.unforkThreadActs(thread.book_id, thread.user_email, thread.id);
  logger.info(`[plot] thread unfork-acts id=${thread.id} book=${thread.book_id}`);
  res.json({ ok: true });
});

// ── Beats ──────────────────────────────────────────────────────────────────
router.post('/beats', jsonBody, (req, res) => {
  const userEmail = sessionEmail(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const bookId = toIntId(req.body?.book_id);
  const actId = toIntId(req.body?.act_id);
  const titel = (req.body?.titel || '').toString().trim();
  if (!bookId) return res.status(400).json({ error_code: 'BOOKID_REQ' });
  if (!actId)  return res.status(400).json({ error_code: 'ACTID_REQ' });
  if (!titel)  return res.status(400).json({ error_code: 'TITEL_REQ' });
  if (titel.length > MAX_TITEL) return res.status(400).json({ error_code: 'TITEL_TOO_LONG' });
  if (!_guard(req, res, bookId)) return;

  const act = plotDb.getAct(actId);
  if (!act || act.book_id !== bookId || act.user_email !== userEmail) {
    return res.status(400).json({ error_code: 'ACT_MISMATCH' });
  }
  const beschreibung = req.body?.beschreibung ? String(req.body.beschreibung).slice(0, MAX_BESCHREIBUNG) : null;
  const status = STATUSES.includes(req.body?.status) ? req.body.status : 'geplant';
  const verworfen = req.body?.verworfen ? 1 : 0;
  const chapterId = _validChapterId(bookId, toIntId(req.body?.chapter_id));
  const intensitaet = _validIntensitaet(req.body?.intensitaet);
  const threadId = plotDb._validThreadId(bookId, userEmail, toIntId(req.body?.thread_id));
  if (!_actFitsThread(act, threadId)) return res.status(400).json({ error_code: 'ACT_THREAD_MISMATCH' });
  const figureIds = plotDb.resolveFigureIds(bookId, userEmail, req.body?.figure_ids);
  const draftFigureIds = plotDb.resolveDraftFigureIds(bookId, userEmail, req.body?.draft_figure_ids);
  const motifIds = plotDb.resolveMotifIds(bookId, userEmail, req.body?.motif_ids);

  const beat = plotDb.createBeat(bookId, actId, userEmail, { titel, beschreibung, status, verworfen, chapterId, intensitaet, threadId, figureIds, draftFigureIds, motifIds });
  logger.info(`[plot] beat create id=${beat.id} act=${actId} book=${bookId}`);
  res.json(beat);
});

router.patch('/beats/:id', jsonBody, (req, res) => {
  const beat = _loadOwned(req, res, plotDb.getBeatMeta, 'BEAT_NOT_FOUND');
  if (!beat) return;
  const id = beat.id;
  const userEmail = beat.user_email;

  const fields = {};
  if (typeof req.body?.titel === 'string') {
    const t = req.body.titel.trim();
    if (!t) return res.status(400).json({ error_code: 'TITEL_REQ' });
    if (t.length > MAX_TITEL) return res.status(400).json({ error_code: 'TITEL_TOO_LONG' });
    fields.titel = t;
  }
  if (typeof req.body?.beschreibung === 'string') {
    fields.beschreibung = req.body.beschreibung.slice(0, MAX_BESCHREIBUNG) || null;
  }
  if (typeof req.body?.status !== 'undefined') {
    if (!STATUSES.includes(req.body.status)) return res.status(400).json({ error_code: 'INVALID_STATUS' });
    fields.status = req.body.status;
  }
  if (typeof req.body?.verworfen !== 'undefined') {
    fields.verworfen = req.body.verworfen ? 1 : 0;
  }
  if (typeof req.body?.chapter_id !== 'undefined') {
    fields.chapter_id = _validChapterId(beat.book_id, toIntId(req.body.chapter_id));
  }
  if (typeof req.body?.intensitaet !== 'undefined') {
    fields.intensitaet = _validIntensitaet(req.body.intensitaet);
  }
  // act_id-Move ohne Reorder (z.B. Detail-Edit): act muss zum Buch gehören.
  if (typeof req.body?.act_id !== 'undefined') {
    const act = plotDb.getAct(toIntId(req.body.act_id));
    if (!act || act.book_id !== beat.book_id || act.user_email !== userEmail) {
      return res.status(400).json({ error_code: 'ACT_MISMATCH' });
    }
    fields.act_id = act.id;
  }
  // thread_id-Zuordnung (Strang) — Fremd/leer → NULL („ohne Strang"-Lane).
  if (typeof req.body?.thread_id !== 'undefined') {
    fields.thread_id = plotDb._validThreadId(beat.book_id, userEmail, toIntId(req.body.thread_id));
  }
  // Akt-Strang-Kompatibilität des Resultats prüfen (Hybrid-Akte): der effektive
  // Akt darf kein eigener Akt eines anderen Strangs sein als der effektive Strang.
  if (typeof fields.act_id !== 'undefined' || typeof fields.thread_id !== 'undefined') {
    const effActId = typeof fields.act_id !== 'undefined' ? fields.act_id : beat.act_id;
    const effThreadId = typeof fields.thread_id !== 'undefined' ? fields.thread_id : (beat.thread_id ?? null);
    const effAct = plotDb.getAct(effActId);
    if (effAct && !_actFitsThread(effAct, effThreadId)) {
      return res.status(400).json({ error_code: 'ACT_THREAD_MISMATCH' });
    }
  }
  const figureIds = Array.isArray(req.body?.figure_ids)
    ? plotDb.resolveFigureIds(beat.book_id, userEmail, req.body.figure_ids)
    : undefined;
  const draftFigureIds = Array.isArray(req.body?.draft_figure_ids)
    ? plotDb.resolveDraftFigureIds(beat.book_id, userEmail, req.body.draft_figure_ids)
    : undefined;
  const motifIds = Array.isArray(req.body?.motif_ids)
    ? plotDb.resolveMotifIds(beat.book_id, userEmail, req.body.motif_ids)
    : undefined;

  if (!Object.keys(fields).length && typeof figureIds === 'undefined' && typeof draftFigureIds === 'undefined' && typeof motifIds === 'undefined') {
    return res.status(400).json({ error_code: 'NO_FIELDS' });
  }
  res.json(plotDb.updateBeat(id, fields, figureIds, draftFigureIds, motifIds));
});

router.delete('/beats/:id', (req, res) => {
  const beat = _loadOwned(req, res, plotDb.getBeatMeta, 'BEAT_NOT_FOUND');
  if (!beat) return;
  plotDb.deleteBeat(beat.id);
  logger.info(`[plot] beat delete id=${beat.id} book=${beat.book_id}`);
  res.json({ ok: true });
});

router.put('/beats/order', jsonBody, (req, res) => {
  const userEmail = sessionEmail(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const bookId = toIntId(req.body?.book_id);
  const order = Array.isArray(req.body?.order) ? req.body.order : null;
  if (!bookId) return res.status(400).json({ error_code: 'BOOKID_REQ' });
  if (!order)  return res.status(400).json({ error_code: 'ORDER_REQ' });
  if (!_guard(req, res, bookId)) return;
  plotDb.reorderBeats(bookId, userEmail, order);
  res.json({ ok: true });
});

// ── Beat-Beziehungen (Kausalität + Setup/Payoff) ────────────────────────────
// Gerichtete Kante from_beat --typ--> to_beat. Beide Beats werden serverseitig aufs
// (Buch, User)-Subset validiert; Selbst-Kanten + Fremd-Verweise sind unmöglich.
const _REL_ERR = { SELF_RELATION: 'SELF_RELATION', BEAT_MISMATCH: 'BEAT_MISMATCH', BEAT_REQUIRED: 'BEAT_REQUIRED', TYP_REQUIRED: 'TYP_REQUIRED' };
router.post('/beat-relations', jsonBody, (req, res) => {
  const userEmail = sessionEmail(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const bookId = toIntId(req.body?.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'BOOKID_REQ' });
  if (!_guard(req, res, bookId)) return;
  try {
    const rel = plotDb.createBeatRelation(bookId, userEmail, {
      fromBeatId: toIntId(req.body?.from_beat_id),
      toBeatId: toIntId(req.body?.to_beat_id),
      typ: req.body?.typ,
    });
    if (!rel) return res.status(400).json({ error_code: 'REL_FAILED' });
    logger.info(`[plot] beat-relation create id=${rel.id} from=${rel.from_beat_id} to=${rel.to_beat_id} book=${bookId}`);
    res.json(rel);
  } catch (e) {
    return res.status(400).json({ error_code: _REL_ERR[e.code] || 'REL_FAILED' });
  }
});

router.delete('/beat-relations/:id', (req, res) => {
  const rel = _loadOwned(req, res, plotDb.getBeatRelation, 'REL_NOT_FOUND');
  if (!rel) return;
  plotDb.deleteBeatRelation(rel.id, rel.user_email);
  logger.info(`[plot] beat-relation delete id=${rel.id} book=${rel.book_id}`);
  res.json({ ok: true });
});

// ── Konsistenz-Prüfungs-Historie ────────────────────────────────────────────
// Persistierte Plot-Consistency-Läufe pro (Buch, User), damit der User frühere
// Prüfungen später nochmal ansehen kann. Insert geschieht beim Job-Complete in
// routes/jobs/plot.js. Hier nur Lesen + Löschen.
router.get('/consistency-runs', (req, res) => {
  const ctx = _requireBook(req, res);
  if (!ctx) return;
  res.json(plotDb.listPlotConsistencyRuns(ctx.bookId, ctx.userEmail));
});

router.get('/consistency-runs/:id', (req, res) => {
  const run = _loadOwned(req, res, plotDb.getPlotConsistencyRun, 'RUN_NOT_FOUND');
  if (!run) return;
  res.json(run);
});

router.delete('/consistency-runs/:id', (req, res) => {
  const run = _loadOwned(req, res, plotDb.getPlotConsistencyRun, 'RUN_NOT_FOUND');
  if (!run) return;
  plotDb.deletePlotConsistencyRun(run.id, run.user_email);
  res.json({ ok: true });
});

// ── Brainstorm-Lauf-Historie ─────────────────────────────────────────────────
// Persistierte Plot-Brainstorm-Läufe pro (Buch, User), zusätzlich pro Akt/Strang.
// Insert geschieht beim Job-Complete in routes/jobs/plot.js. Hier nur Lesen +
// Löschen. Liste mit act_name/thread_name (JOIN, nullbar bei gelöschtem Akt/Strang).
router.get('/brainstorm-runs', (req, res) => {
  const ctx = _requireBook(req, res);
  if (!ctx) return;
  res.json(plotDb.listPlotBrainstormRuns(ctx.bookId, ctx.userEmail));
});

router.get('/brainstorm-runs/:id', (req, res) => {
  const run = _loadOwned(req, res, plotDb.getPlotBrainstormRun, 'RUN_NOT_FOUND');
  if (!run) return;
  res.json(run);
});

router.delete('/brainstorm-runs/:id', (req, res) => {
  const run = _loadOwned(req, res, plotDb.getPlotBrainstormRun, 'RUN_NOT_FOUND');
  if (!run) return;
  plotDb.deletePlotBrainstormRun(run.id, run.user_email);
  res.json({ ok: true });
});

module.exports = router;
