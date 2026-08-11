'use strict';
// Embedding-Index-Job (semantische Suche): embeddet Seiten, Szenen, Figuren und
// Recherche-Schnipsel eines Buches und legt die Vektoren in semantic_chunks ab
// (research: Titel + Inhalt + der extrahierte PDF-Volltext eines hochgeladenen
// Dokuments — damit ist eine lange PDF nicht nur über exakte Wörter auffindbar,
// sondern passagenweise über Bedeutung). Rein rückwärts-
// gewandt — liest bestehende Inhalte, schreibt NIE in den Buchtext. Kein KI-
// Prompt: der Embedding-Endpunkt (embed.*, self-hosted) liefert reine Vektoren.
//
// Delta-Cache: pro Chunk ein content_hash; unveränderte Chunks behalten ihren
// Vektor (kein erneuter Embedding-Call). model steht im Chunk-Key — ein Modell-
// wechsel im Admin-Tab führt beim nächsten Lauf zu vollständigem Neu-Embedden
// (alte Modell-Chunks bleiben liegen, bis clearBook/pruneMissing sie räumt).

const express = require('express');
const { db } = require('../../db/schema');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  createJob, enqueueJob, findActiveJobId, jsonBody, jobAbortControllers,
  loadOrderedBookContents, loadPageContents,
} = require('./shared');
const embed = require('../../lib/embed');
const { chunkText, contentHash } = require('../../lib/embed-chunk');
const semanticChunks = require('../../db/semantic-chunks');
const contentStore = require('../../lib/content-store');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');
const { requireBookAccess, sendACLError, sessionEmail } = require('../../lib/acl');
const logger = require('../../logger');

const embedIndexRouter = express.Router();

// Kinds, die indexiert werden. text() extrahiert den einbett­baren Rohtext je
// Entität; leerer Text → Entität wird übersprungen (und via pruneMissing später
// entfernt, falls sie mal Chunks hatte).
const KINDS = ['page', 'scene', 'figure', 'research'];

function _sceneText(r) {
  return [r.titel, r.kommentar].map(s => String(s || '').trim()).filter(Boolean).join('. ');
}
function _figureText(r) {
  return [r.name, r.beschreibung].map(s => String(s || '').trim()).filter(Boolean).join('. ');
}
// Recherche-Schnipsel: Titel + Inhalt + PDF-Volltext am Stück. chunkText schneidet
// daraus die Passagen — bei einem Dokument-Eintrag ist doc_text der weitaus
// grösste Anteil und damit das eigentliche Indexgut. Archivierte Einträge werden
// bewusst mitindexiert (der FTS5-Index tut es auch; sonst driftet die
// Hybrid-Fusion, die beide Ranglisten zusammenführt).
function _researchText(r) {
  return [r.title, r.body, r.doc_text].map(s => String(s || '').trim()).filter(Boolean).join('\n\n');
}

// Alle indexierbaren Entitäten eines Buches laden → { page:[{id,text}], ... }.
async function _collectEntities(bookId, userToken, signal) {
  const { chMap, pages } = await loadOrderedBookContents(bookId, userToken);
  const pageContents = await loadPageContents(pages, chMap, 1, null, userToken, signal);
  const pageItems = pageContents.map(p => ({ id: p.id, text: p.text }));

  const sceneRows = db.prepare('SELECT id, titel, kommentar FROM figure_scenes WHERE book_id = ?').all(bookId);
  const sceneItems = sceneRows.map(r => ({ id: r.id, text: _sceneText(r) })).filter(x => x.text);

  const figRows = db.prepare('SELECT id, name, beschreibung FROM figures WHERE book_id = ?').all(bookId);
  const figItems = figRows.map(r => ({ id: r.id, text: _figureText(r) })).filter(x => x.text);

  const resRows = db.prepare('SELECT id, title, body, doc_text FROM research_items WHERE book_id = ?').all(bookId);
  const resItems = resRows.map(r => ({ id: r.id, text: _researchText(r) })).filter(x => x.text);

  return { page: pageItems, scene: sceneItems, figure: figItems, research: resItems };
}

async function runEmbedIndexJob(jobId, bookId, userEmail, userToken) {
  const logger = makeJobLogger(jobId);
  try {
    if (!embed.isEnabled()) throw i18nError('job.error.embedDisabled');
    const { model, dim, passagePrefix } = embed.getConfig();
    const signal = () => jobAbortControllers.get(jobId)?.signal;
    const throwIfAborted = () => {
      if (signal()?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    };

    updateJob(jobId, { statusText: 'job.phase.embedCollect', progress: 5 });
    const entities = await _collectEntities(bookId, userToken, signal());

    // Pro Entität die Soll-Chunks bestimmen und gegen den Delta-Cache abgleichen.
    // pending[]: { kind, id, ix, text, hash } — die neu zu embettenden Chunks.
    // reuseRows: Map `${kind}:${id}` → [{chunk_ix, content_hash, vector, text}]
    // (bereits fertige Zeilen, aus Cache übernommen). Nach dem Embedden werden
    // pending in dieselbe Map einsortiert und die Entität am Stück ersetzt.
    const rowsByEntity = new Map();
    const pending = [];
    const presentIds = { page: [], scene: [], figure: [], research: [] };
    let totalChunks = 0;

    for (const kind of KINDS) {
      for (const ent of entities[kind]) {
        presentIds[kind].push(ent.id);
        const chunks = chunkText(ent.text);
        if (!chunks.length) continue;
        const key = `${kind}:${ent.id}`;
        rowsByEntity.set(key, []);
        const existing = semanticChunks.getEntityChunks(kind, ent.id, model);
        chunks.forEach((text, ix) => {
          totalChunks++;
          // Was tatsächlich embeddet wird (inkl. passage_prefix für asymmetrische
          // Modelle). Der Hash deckt den Präfix ab → Präfixwechsel invalidiert den
          // Delta-Cache und erzwingt Reindex. Der gespeicherte text bleibt roh
          // (Snippet-Quelle).
          const embedInput = passagePrefix ? passagePrefix + text : text;
          const hash = contentHash(embedInput);
          const prev = existing.get(ix);
          if (prev && prev.content_hash === hash && prev.vector.length === dim) {
            rowsByEntity.get(key).push({ chunk_ix: ix, content_hash: hash, vector: prev.vector, text });
          } else {
            pending.push({ kind, id: ent.id, ix, text, embedInput, hash });
          }
        });
      }
    }

    logger.info(`Index ${bookId}: ${totalChunks} Chunks, davon ${pending.length} neu (${totalChunks - pending.length} aus Cache).`);
    updateJob(jobId, { statusText: 'job.phase.embedding', statusParams: { done: 0, total: pending.length }, progress: 15 });

    // Offene Chunk-Zahl pro Entität → eine Entität wird persistiert, sobald ihr
    // letzter pending-Chunk embeddet ist. So überlebt ein Backend-Tod mitten im
    // Lauf: bereits fertige Entitäten sind in der DB, der Delta-Cache übernimmt
    // sie beim nächsten Lauf (nur der Rest wird neu embeddet).
    const pendingByEntity = new Map();
    for (const p of pending) {
      const k = `${p.kind}:${p.id}`;
      pendingByEntity.set(k, (pendingByEntity.get(k) || 0) + 1);
    }
    const persistEntity = (key) => {
      const rows = rowsByEntity.get(key);
      const [kind, idStr] = key.split(':');
      rows.sort((a, b) => a.chunk_ix - b.chunk_ix);
      semanticChunks.replaceEntity(kind, Number(idStr), bookId, model, dim, rows);
      rowsByEntity.delete(key);
    };

    // Neue Chunks in Batches embetten (embedBatch chunkt intern auf MAX_BATCH).
    const BATCH = 64;
    for (let i = 0; i < pending.length; i += BATCH) {
      throwIfAborted();
      const slice = pending.slice(i, i + BATCH);
      const vecs = await embed.embedBatch(slice.map(p => p.embedInput), { signal: signal() });
      const touched = new Set();
      slice.forEach((p, j) => {
        const k = `${p.kind}:${p.id}`;
        rowsByEntity.get(k).push({ chunk_ix: p.ix, content_hash: p.hash, vector: vecs[j], text: p.text });
        pendingByEntity.set(k, pendingByEntity.get(k) - 1);
        touched.add(k);
      });
      for (const k of touched) {
        if (pendingByEntity.get(k) === 0) { persistEntity(k); pendingByEntity.delete(k); }
      }
      const done = Math.min(i + BATCH, pending.length);
      updateJob(jobId, {
        statusText: 'job.phase.embedding', statusParams: { done, total: pending.length },
        progress: 15 + Math.round((done / Math.max(pending.length, 1)) * 75),
      });
    }

    // Verbleibende Entitäten (nur aus Cache-Chunks, kein pending) atomar schreiben,
    // dann Orphans räumen.
    for (const key of [...rowsByEntity.keys()]) persistEntity(key);
    let pruned = 0;
    for (const kind of KINDS) pruned += semanticChunks.pruneMissing(bookId, model, kind, presentIds[kind]);

    updateJob(jobId, { progress: 98 });
    const stats = semanticChunks.bookStats(bookId, model);
    completeJob(jobId, {
      model, dim, totalChunks: stats.total, embedded: pending.length,
      reused: totalChunks - pending.length, pruned, byKind: stats.byKind,
    }, null, `${stats.total} Chunks (${pending.length} neu, ${totalChunks - pending.length} aus Cache${pruned ? `, ${pruned} verwaist entfernt` : ''})`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Embedding-Index Fehler: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

// Trigger nach einem Recherche-PDF-Upload (s. routes/research.js): reiht einen
// Buch-Index-Job ein, damit der frische Volltext nicht bis zum Nacht-Cron nur
// per Wortmatch auffindbar bleibt. Ein bereits laufender Job des Buchs wird
// wiederverwendet (er nimmt die neue PDF im selben Lauf mit); der Delta-Cache
// macht den Ein-Dokument-Fall so billig wie einen Einzel-Index.
function enqueueEmbedIndexJob(bookId, userEmail = null) {
  if (!embed.isEnabled()) return null;
  const existing = findActiveJobId('embed-index', bookId, userEmail);
  if (existing) return existing;
  const jobId = createJob('embed-index', bookId, userEmail, 'job.label.embedIndex', null, bookId);
  enqueueJob(jobId, () => runEmbedIndexJob(jobId, bookId, userEmail, null));
  return jobId;
}

// Nacht-Cron: hält die Embedding-Indizes aller Bücher frisch. Reiht pro Buch
// einen embed-index-Job ein (Dedup gegen laufende Jobs). Der Delta-Cache im Job
// embeddet nur seit gestern geänderte Chunks neu — bereits indizierte Bücher
// sind dadurch billig, nie-indizierte bekommen ihren Erst-Index.
async function reindexAllBooks() {
  if (!embed.isEnabled()) return { enqueued: 0, skipped: 0, disabled: true };
  const books = await contentStore.listBooks(null);
  let enqueued = 0, skipped = 0;
  for (const { id: bookId } of books) {
    if (findActiveJobId('embed-index', bookId, null)) { skipped++; continue; }
    const jobId = createJob('embed-index', bookId, null, 'job.label.embedIndex', null, bookId);
    enqueueJob(jobId, () => runEmbedIndexJob(jobId, bookId, null, null));
    enqueued++;
  }
  logger.info(`Embedding-Reindex (Cron): ${enqueued} Buch/Bücher eingereiht, ${skipped} übersprungen (Job läuft bereits).`);
  return { enqueued, skipped };
}

embedIndexRouter.post('/embed-index', jsonBody, (req, res) => {
  const book_id = toIntId(req.body?.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: book_id });
  try { requireBookAccess(req, book_id, 'lektor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }
  if (!embed.isEnabled()) return res.status(400).json({ error_code: 'EMBED_DISABLED' });
  const userEmail = sessionEmail(req);
  const existing = findActiveJobId('embed-index', book_id, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const jobId = createJob('embed-index', book_id, userEmail, 'job.label.embedIndex', null, book_id);
  enqueueJob(jobId, () => runEmbedIndexJob(jobId, book_id, userEmail, null));
  res.json({ jobId });
});

module.exports = { embedIndexRouter, runEmbedIndexJob, reindexAllBooks, enqueueEmbedIndexJob };
