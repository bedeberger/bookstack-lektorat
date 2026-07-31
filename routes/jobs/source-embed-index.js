'use strict';
// Quellen-PDF Embedding-Index-Job (semantische Suche über die Quellen-PDFs des
// Users). Pendant zu routes/jobs/embed-index.js, aber **user-skopiert**: Quellen
// gehören dem User (`sources.owner_email`), keinem Buch, und die Vektoren
// liegen in `source_semantic_chunks` (vgl. db/source-semantic-chunks.js).
//
// Rein rückwärts­gewandt — liest `sources.doc_text`, schreibt NIE in den Buch-
// text. Kein AI-Prompt: der Embedding-Endpunkt (embed.*, self-hosted) liefert
// reine Vektoren. Delta-Cache: pro Chunk ein `content_hash`; unveränderte
// Chunks behalten ihren Vektor (kein erneuter Embedding-Call). `model` steht
// im Chunk-Key — ein Modellwechsel erzwingt vollständiges Neu-Embedden, alte
// Modell-Chunks bleiben liegen bis clearOwner/pruneMissing sie räumt.
//
// Zwei Eingänge:
//   - reindexUserSources(userEmail)      → Job-Queue (User-Klick in der Karte)
//   - enqueueSourceEmbedIndexJob(email)  → Trigger nach Upload (s. routes/sources.js)
//   - reindexAllUserSources()            → Nacht-Cron: alle User mit Quellen-PDFs

const express = require('express');
const { db } = require('../../db/schema');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  createJob, enqueueJob, findActiveJobId, jsonBody, jobAbortControllers,
} = require('./shared');
const embed = require('../../lib/embed');
const { chunkText, contentHash } = require('../../lib/embed-chunk');
const sourceSemanticChunks = require('../../db/source-semantic-chunks');
const { markSourceIndexed, getSource } = require('../../db/schema');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');
const logger = require('../../logger');

const sourceEmbedIndexRouter = express.Router();

const JOB_TYPE = 'source-embed-index';
const JOB_LABEL = 'job.label.sourceEmbedIndex';
// Dedup-Id ist die userEmail — die Indexierung ist pro User, und ein laufender
// Lauf nimmt via Delta-Cache jede frisch hochgeladene PDF im nächsten Schritt
// mit. Statt pro Upload einen separaten Job zu erzeugen, wird ein laufender
// User-Job reused (sonst würde ein Mehrfach-Hochladen den Worker überfluten).
function _dedupKey(userEmail) { return `user:${userEmail}`; }

// Alle Quellen des Users mit PDF laden → [{ id, doc_text, owner_email }].
// Text leer? skip (Quelle ohne indizierbaren Text — pruneMissing tut den Rest).
async function _collectCandidates(userEmail) {
  const rows = sourceSemanticChunks.listIndexedCandidates(userEmail);
  return rows.map(r => ({ id: r.id, owner_email: userEmail, text: String(r.doc_text || '') }))
    .filter(x => x.text.trim());
}

async function runSourceEmbedIndexJob(jobId, userEmail) {
  const l = makeJobLogger(jobId);
  try {
    if (!embed.isEnabled()) throw i18nError('job.error.embedDisabled');
    const { model, dim, passagePrefix } = embed.getConfig();
    const signal = () => jobAbortControllers.get(jobId)?.signal;
    const throwIfAborted = () => {
      if (signal()?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    };

    updateJob(jobId, { statusText: 'job.phase.sourceEmbedCollect', progress: 5 });
    const candidates = await _collectCandidates(userEmail);

    const rowsBySource = new Map();
    const pending = [];
    const presentIds = [];
    let totalChunks = 0;

    for (const c of candidates) {
      presentIds.push(c.id);
      const chunks = chunkText(c.text);
      if (!chunks.length) continue;
      rowsBySource.set(c.id, []);
      const existing = sourceSemanticChunks.getSourceChunks(c.id, model);
      chunks.forEach((text, ix) => {
        totalChunks++;
        const embedInput = passagePrefix ? passagePrefix + text : text;
        const hash = contentHash(embedInput);
        const prev = existing.get(ix);
        if (prev && prev.content_hash === hash && prev.vector.length === dim) {
          rowsBySource.get(c.id).push({ chunk_ix: ix, content_hash: hash, vector: prev.vector, text });
        } else {
          pending.push({ sourceId: c.id, ix, text, embedInput, hash });
        }
      });
    }

    l.info(`Source-Index ${userEmail}: ${totalChunks} Chunks, davon ${pending.length} neu (${totalChunks - pending.length} aus Cache).`);
    updateJob(jobId, { statusText: 'job.phase.sourceEmbedding', statusParams: { done: 0, total: pending.length }, progress: 15 });

    const pendingBySource = new Map();
    for (const p of pending) {
      pendingBySource.set(p.sourceId, (pendingBySource.get(p.sourceId) || 0) + 1);
    }
    const persistSource = (sourceId) => {
      const rows = rowsBySource.get(sourceId);
      rows.sort((a, b) => a.chunk_ix - b.chunk_ix);
      sourceSemanticChunks.replaceSource(sourceId, userEmail, model, dim, rows);
      // Index-Stand verzeichnen (fürs Stale-Heuristic in der Karte). updated_at
      // darf dadurch nicht springen — der Trigger nur `doc_indexed_at`.
      markSourceIndexed(sourceId, new Date().toISOString());
      rowsBySource.delete(sourceId);
    };

    const BATCH = 64;
    for (let i = 0; i < pending.length; i += BATCH) {
      throwIfAborted();
      const slice = pending.slice(i, i + BATCH);
      const vecs = await embed.embedBatch(slice.map(p => p.embedInput), { signal: signal() });
      const touched = new Set();
      slice.forEach((p, j) => {
        rowsBySource.get(p.sourceId).push({ chunk_ix: p.ix, content_hash: p.hash, vector: vecs[j], text: p.text });
        pendingBySource.set(p.sourceId, pendingBySource.get(p.sourceId) - 1);
        touched.add(p.sourceId);
      });
      for (const sid of touched) {
        if (pendingBySource.get(sid) === 0) { persistSource(sid); pendingBySource.delete(sid); }
      }
      const done = Math.min(i + BATCH, pending.length);
      updateJob(jobId, {
        statusText: 'job.phase.sourceEmbedding', statusParams: { done, total: pending.length },
        progress: 15 + Math.round((done / Math.max(pending.length, 1)) * 75),
      });
    }

    for (const sid of [...rowsBySource.keys()]) persistSource(sid);
    let pruned = sourceSemanticChunks.pruneMissing(userEmail, model, presentIds);

    updateJob(jobId, { progress: 98 });
    const stats = sourceSemanticChunks.indexStatus(userEmail, model);
    completeJob(jobId, {
      model, dim, totalChunks: stats.total, embedded: pending.length,
      reused: totalChunks - pending.length, pruned, indexedSources: presentIds.length,
    }, null, `${stats.total} Chunks (${pending.length} neu, ${totalChunks - pending.length} aus Cache${pruned ? `, ${pruned} verwaist entfernt` : ''}) bei ${presentIds.length} Quellen`);
  } catch (e) {
    if (e.name !== 'AbortError') l.error(`Quellen-Embedding-Index Fehler: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

// Nacht-Cron-Pendant: reindex pro User, der PDFs hat (Dedup gegen laufende Jobs).
// Billig für indizierte User (Delta-Cache), Erst-Index für frisch hochgeladene.
async function reindexAllUserSources() {
  if (!embed.isEnabled()) return { enqueued: 0, skipped: 0, disabled: true };
  const users = db.prepare(
    `SELECT DISTINCT owner_email FROM sources
      WHERE doc_text IS NOT NULL AND doc_text <> ''`
  ).all();
  let enqueued = 0, skipped = 0;
  for (const { owner_email: userEmail } of users) {
    if (findActiveJobId(JOB_TYPE, _dedupKey(userEmail), userEmail)) { skipped++; continue; }
    const jobId = createJob(JOB_TYPE, null, userEmail, JOB_LABEL, null, _dedupKey(userEmail));
    enqueueJob(jobId, () => runSourceEmbedIndexJob(jobId, userEmail));
    enqueued++;
  }
  logger.info(`Quellen-Embedding-Reindex (Cron): ${enqueued} User eingereiht, ${skipped} übersprungen (Job läuft bereits).`);
  return { enqueued, skipped };
}

// Trigger nach Upload: erzeugt den Job (dedup gegen laufende User-Jobs).
// Läuft schon einer → kein zweiter (Delta-Cache nimmt die neue PDF mit).
function enqueueSourceEmbedIndexJob(userEmail, _sourceId) {
  if (!embed.isEnabled()) return null;
  const existing = findActiveJobId(JOB_TYPE, _dedupKey(userEmail), userEmail);
  if (existing) return existing;
  const jobId = createJob(JOB_TYPE, null, userEmail, JOB_LABEL, null, _dedupKey(userEmail));
  enqueueJob(jobId, () => runSourceEmbedIndexJob(jobId, userEmail));
  return jobId;
}

sourceEmbedIndexRouter.post('/source-embed-index', jsonBody, (req, res) => {
  const userEmail = req.session?.user?.email || null;
  if (!userEmail) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  setContext({ user: userEmail });
  if (!embed.isEnabled()) return res.status(400).json({ error_code: 'EMBED_DISABLED' });
  // Optional: nur eine Quelle reindiziern (?source_id=N). Aktuell: Full-User-Job;
  // der Delta-Cache macht den Ein-PDF-Fall identisch billig.
  if (req.body?.source_id) toIntId(req.body.source_id); // nur Validierung, kein Effekt
  const existing = findActiveJobId(JOB_TYPE, _dedupKey(userEmail), userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const jobId = enqueueSourceEmbedIndexJob(userEmail);
  res.json({ jobId });
});

module.exports = {
  sourceEmbedIndexRouter, runSourceEmbedIndexJob, reindexAllUserSources,
  enqueueSourceEmbedIndexJob, JOB_TYPE,
};