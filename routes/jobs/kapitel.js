'use strict';
const crypto = require('crypto');
const express = require('express');
const {
  db, getBookSettings, upsertBookByName,
  loadChapterMacroReviewCache, saveChapterMacroReviewCache,
} = require('../../db/schema');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError, contentHttpError,
  aiCall, getPrompts, getBookPrompts,
  jobAbortControllers,
  htmlToText, splitGroupsIntoChunks, loadOrderedBookContents,
  _modelName, tps,
  jobs, runningJobs, createJob, enqueueJob, jobKey, findActiveJobId,
  jsonBody, BATCH_SIZE, chunkLimitsFor,
} = require('./shared');
const contentStore = require('../../lib/content-store');
const { narrativeLabels } = require('./narrative-labels');
const { loadChapterReviewKomplettContext, loadStrukturContext } = require('./review-context');
const { applyQuoteVerification, belegHaystack } = require('../../lib/quote-verify');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');
const appSettings = require('../../lib/app-settings');
const { resolveProvider } = require('../../lib/ai');
const { getDescendantChapterIds } = require('../../db/book-order');
const { sessionEmail } = require('../../lib/acl');

function _sigHash(obj) {
  return crypto.createHash('sha1').update(JSON.stringify(obj ?? null)).digest('hex').slice(0, 12);
}

const kapitelRouter = express.Router();

// ── Job: Kapitel-Review (Makrobewertung eines einzelnen Kapitels) ────────────
async function runChapterReviewJob(jobId, bookId, chapterId, chapterName, bookName, userEmail, userToken, { includeSubchapters = false } = {}) {
  const logger = makeJobLogger(jobId);
  const prompts = await getPrompts(userEmail);
  const {
    buildChapterReviewPrompt, buildChapterReviewMultiPassPrompt,
    buildChapterAnalysisPrompt,
    buildChapterReviewSchema, buildChapterAnalysisSchema, reviewProfil,
    getBuchtypReviewSchwerpunkt,
    PROMPTS_VERSION,
  } = prompts;
  const { SYSTEM_KAPITELREVIEW_BLOCKS: SYSTEM_KAPITELREVIEW, SYSTEM_KAPITELANALYSE_BLOCKS: SYSTEM_KAPITELANALYSE } = await getBookPrompts(bookId, userEmail);
  const bookSettings = getBookSettings(bookId, userEmail);
  const narrative = narrativeLabels(bookSettings);
  const locale = `${bookSettings?.language || 'de'}-${bookSettings?.region || 'CH'}`;
  const reviewSchwerpunkt = getBuchtypReviewSchwerpunkt(locale, bookSettings?.buchtyp || null);
  // Achsen-Set, Notenanker und Schema hängen am Bewertungsprofil des Buchtyps.
  const buchtyp = narrative.buchtyp || null;
  const profil = reviewProfil(buchtyp);
  const SCHEMA_CHAPTER_REVIEW = buildChapterReviewSchema({ buchtyp });
  const SCHEMA_CHAPTER_ANALYSIS = buildChapterAnalysisSchema({ buchtyp });

  const bookIdInt = parseInt(bookId);
  const chapterIdInt = parseInt(chapterId);
  const email = userEmail || '';
  const effectiveProvider = resolveProvider({ userEmail });
  const { singlePass: SINGLE_PASS_LIMIT, perChunk: PER_CHUNK_LIMIT } = chunkLimitsFor(effectiveProvider);
  const cacheVersion = `${_modelName(effectiveProvider)}:${PROMPTS_VERSION || ''}`;
  try {
    updateJob(jobId, { statusText: 'job.phase.loadingPages', progress: 0 });
    // Bei includeSubchapters: rekursiv alle Sub-Kapitel-IDs ermitteln und
    // Seiten aller Tiefen einbeziehen. Sonst nur direkte Kapitel-Seiten.
    const chapterIds = includeSubchapters
      ? new Set(getDescendantChapterIds(chapterIdInt, { includeSelf: true }).map(String))
      : new Set([String(chapterIdInt)]);
    // Tree-Walk liefert Pages in echter Buchorganizer-Reihenfolge (depth-first)
    // mit Sub-Kapitel-Pfad in chMap. Filter behält Tree-Order.
    // includeExcluded: ausgeschlossene Kapitel sind direkt in der Kapitel-
    // bewertung bewertbar (anders als Buch-/Komplettanalyse) — der Filter unten
    // beschränkt ohnehin auf die angeforderten chapterIds.
    const { chMap, pages: allPages } = await loadOrderedBookContents(bookId, userToken, { includeExcluded: true })
      .catch(e => { throw contentHttpError(e); });
    const pages = allPages.filter(p => chapterIds.has(String(p.chapter_id || '')));

    if (!pages.length) { completeJob(jobId, { empty: true, chapterName }); return; }
    logger.info(`Start: «${chapterName}» chap=${chapterId}${includeSubchapters ? ' (+Sub-Kapitel)' : ''}, ${pages.length} Seiten`);

    // Kapitelname aus dem Tree-Pfad (letztes Segment) – für Kontext-Scoping
    // (Kontinuität/Zeitstrahl filtern über Namen) und Nachbar-Anzeige.
    const _nameOf = (cid) => {
      const pth = chMap[cid] || chMap[Number(cid)] || '';
      return pth ? pth.split(' › ').pop() : '';
    };
    const chapterNames = [...new Set([...chapterIds].map(_nameOf).concat(chapterName).filter(Boolean))];

    // Buchwahrheit (Figuren/Beziehungen/Kontinuität/Zeitstrahl) auf die bewerteten
    // Kapitel gescopt: schärft die Achsen `figuren` und `kohaerenz` gegen die
    // Kartei, statt das Kapitel isoliert zu beurteilen.
    const komplettContext = loadChapterReviewKomplettContext(bookIdInt, email, {
      chapterIds: [...chapterIds], chapterNames,
    });

    // Ist-Befunde des Struktur-Checks, auf die Seiten dieses Kapitels gescopt
    // (nur journalistische Bücher; sonst null). Anders als in der Buchbewertung
    // wird hier jeder auffällige Beitrag einzeln gelistet — auf Kapitelebene ist
    // das die brauchbare Auflösung, und die Menge bleibt klein.
    const strukturContext = loadStrukturContext(bookIdInt, pages, { scope: 'chapter' });
    if (strukturContext) {
      logger.info(`Struktur-Befunde: ${strukturContext.geprueft}/${strukturContext.gesamt} Beiträge im Kapitel geprüft – fliessen in die Bewertung ein.`);
    }

    // Position in der Lesereihenfolge: erlaubt dem Modell, Dramaturgie/Pacing
    // relativ zur Funktion des Kapitels im Buch zu bewerten statt absolut.
    const chapterOrder = [];
    const seenCh = new Set();
    for (const p of allPages) {
      const cid = String(p.chapter_id || '');
      if (!cid || seenCh.has(cid)) continue;
      seenCh.add(cid);
      chapterOrder.push(cid);
    }
    const posIdxs = chapterOrder.map((c, i) => (chapterIds.has(c) ? i : -1)).filter(i => i >= 0);
    const position = posIdxs.length ? {
      index: Math.min(...posIdxs) + 1,
      total: chapterOrder.length,
      prevName: Math.min(...posIdxs) > 0 ? _nameOf(chapterOrder[Math.min(...posIdxs) - 1]) : '',
      nextName: Math.max(...posIdxs) < chapterOrder.length - 1 ? _nameOf(chapterOrder[Math.max(...posIdxs) + 1]) : '',
    } : null;

    // Stilprofil fliesst in SYSTEM_KAPITELREVIEW (Referenz-Framing) → Cache-Bust bei Profil-Änderung.
    // Komplettanalyse-Kontext + Position ebenfalls in die Sig, damit ein neuer
    // Kartei-/Kontinuitätsstand bzw. eine Umgruppierung den Cache invalidiert.
    const optionsSig = _sigHash({
      narrative, schwerpunkt: reviewSchwerpunkt, includeSubchapters,
      stilprofil: bookSettings?.stilprofil || '', komplettContext, position, strukturContext,
    });

    // pages_sig: jede Seite + ihr updated_at + Sub-Tree-Kapitelmenge inkl. deren
    // Pfade. Ändert sich eine Seite, ein Sub-Kapitel-Name/Pfad oder der Modus →
    // Cache-Miss. Sub-Pfad-Hash, damit Sub-Kapitel-Rename den Prompt-Text
    // invalidiert (sonst landet umbenanntes Sub-Kapitel im stale Cache-Result).
    const chaptersSig = [...chapterIds].sort().map(id => `${id}:${chMap[id] || ''}`).join(',');
    const pagesSig = pages.map(p => `${p.id}:${p.updated_at || ''}`).sort().join('|')
                     + `||${chapterName}||${bookName}||${optionsSig}||${chaptersSig}||${cacheVersion}`;
    const cached = loadChapterMacroReviewCache(bookIdInt, email, chapterIdInt, pagesSig, effectiveProvider);
    if (cached) {
      logger.info(`«${chapterName}» – Cache-HIT (pages_sig match) – spart Kapitel-Review-Call.`);
      updateJob(jobId, { progress: 97, statusText: 'job.phase.checkpointLoaded' });
      const model = _modelName(effectiveProvider);
      if (bookName) upsertBookByName(bookIdInt, bookName);
      db.prepare(`INSERT INTO chapter_reviews
        (book_id, chapter_id, reviewed_at, review_json, model, user_email)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(bookIdInt, chapterIdInt,
          new Date().toISOString(), JSON.stringify(cached), model, userEmail || null);
      completeJob(jobId, {
        review: cached,
        chapterId: chapterIdInt,
        chapterName,
        pageCount: pages.length,
        tokensIn: 0,
        tokensOut: 0,
        cached: true,
      }, null, `«${chapterName}» Cache-HIT, Note ${cached.gesamtnote}`);
      return;
    }

    const tok = { in: 0, out: 0, ms: 0 };
    const signal = jobAbortControllers.get(jobId)?.signal;
    const contents = [];
    for (let i = 0; i < pages.length; i += BATCH_SIZE) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      updateJob(jobId, {
        progress: Math.round((i / pages.length) * 60),
        statusText: 'job.phase.readingPages',
        statusParams: { from: i + 1, to: Math.min(i + BATCH_SIZE, pages.length), total: pages.length },
      });
      // Index-Map gegen Reorder durch Promise.allSettled.
      const batch = pages.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(batch.map(async p => {
        const pd = await contentStore.loadPage(p.id, userToken).catch(e => { throw contentHttpError(e); });
        const text = htmlToText(pd.html).trim();
        if (!text) return null;
        return { title: p.name, text, chapterId: p.chapter_id || null };
      }));
      for (const r of results) if (r.status === 'fulfilled' && r.value) contents.push(r.value);
    }

    if (!contents.length) { completeJob(jobId, { empty: true, chapterName }); return; }

    const totalChars = contents.reduce((s, p) => s + p.text.length, 0);
    // Bei includeSubchapters: Sub-Kapitel-Header zwischen Seiten verschiedener
    // chapter_ids einstreuen. Pfad relativ zum Top-Kapitel — Top-Pfad wegkürzen,
    // damit AI nicht den eh schon im Prompt benannten Kapitelnamen doppelt sieht.
    const topPath = chMap[chapterIdInt] || chapterName || '';
    function _relPath(chId) {
      const full = chMap[chId] || '';
      if (!full || full === topPath) return '';
      if (topPath && full.startsWith(topPath + ' › ')) return full.slice(topPath.length + 3);
      return full;
    }
    function _buildText(items) {
      const out = [];
      let lastChId = null;
      for (const p of items) {
        if (includeSubchapters && p.chapterId !== lastChId) {
          const rel = _relPath(p.chapterId);
          if (rel) out.push(`## ${rel}`);
          lastChId = p.chapterId;
        }
        out.push(`### ${p.title}\n${p.text}`);
      }
      return out.join('\n\n---\n\n');
    }
    let r;
    // Grundlage der Note: Volltext des Kapitels oder verdichtete Teil-Analysen.
    let basis;

    if (totalChars <= SINGLE_PASS_LIMIT) {
      const chText = _buildText(contents);
      updateJob(jobId, { progress: 65, statusText: 'job.phase.aiChapterReview' });
      r = await aiCall(jobId, tok,
        buildChapterReviewPrompt(chapterName, bookName, contents.length, chText, { ...narrative, reviewSchwerpunkt, komplettContext, position, strukturContext }),
        SYSTEM_KAPITELREVIEW,
        65, 97, 5000, 0.2, null, undefined, SCHEMA_CHAPTER_REVIEW,
      );
      const droppedQ = applyQuoteVerification(r, chText);
      if (droppedQ) logger.warn(`${droppedQ} Belegzitat(e) nicht im Kapiteltext gefunden – verworfen.`);
      basis = 'single';
    } else {
      // Kapitel sprengt Input-Budget → in Sub-Chunks zerlegen, je Analyse, dann synthetisieren.
      const groupKey = String(chapterId);
      const baseGroups = new Map([[groupKey, { name: chapterName, pages: contents }]]);
      const { chunkOrder, chunks } = splitGroupsIntoChunks(baseGroups, [groupKey], PER_CHUNK_LIMIT);
      logger.info(`Multi-Pass: ${chunkOrder.length} Teilabschnitte (${totalChars} chars > ${SINGLE_PASS_LIMIT})`);

      const subAnalyses = [];
      for (let i = 0; i < chunkOrder.length; i++) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const chunk = chunks.get(chunkOrder[i]);
        const fromPct = 65 + Math.round((i / chunkOrder.length) * 25);
        const toPct   = 65 + Math.round(((i + 1) / chunkOrder.length) * 25);
        updateJob(jobId, {
          progress: fromPct,
          statusText: 'job.phase.analyzing',
          statusParams: { current: i + 1, total: chunkOrder.length, name: chapterName },
        });
        const chunkText = _buildText(chunk.pages);
        const ca = await aiCall(jobId, tok,
          buildChapterAnalysisPrompt(chapterName, bookName, chunk.pages.length, chunkText, narrative),
          SYSTEM_KAPITELANALYSE,
          fromPct, toPct, 1500, 0.2, null, undefined, SCHEMA_CHAPTER_ANALYSIS,
        );
        // Vor der Synthese verifizieren: die Belegzitate der Teil-Analysen sind
        // ab hier die einzige Zitatquelle der Kapitelbewertung.
        const droppedQ = applyQuoteVerification(ca, chunkText, 'zitate');
        if (droppedQ) logger.warn(`Abschnitt ${i + 1}: ${droppedQ} Belegzitat(e) nicht im Text gefunden – verworfen.`);
        subAnalyses.push({ pageCount: chunk.pages.length, ...ca });
      }

      updateJob(jobId, { progress: 90, statusText: 'job.phase.finalReview' });
      r = await aiCall(jobId, tok,
        buildChapterReviewMultiPassPrompt(chapterName, bookName, subAnalyses, contents.length, { ...narrative, reviewSchwerpunkt, komplettContext, position, strukturContext }),
        SYSTEM_KAPITELREVIEW,
        90, 97, 5000, 0.2, null, undefined, SCHEMA_CHAPTER_REVIEW,
      );
      const droppedQ = applyQuoteVerification(r, belegHaystack(subAnalyses));
      if (droppedQ) logger.warn(`${droppedQ} Belegzitat(e) stammen nicht aus den Teil-Analysen – verworfen.`);
      basis = 'multi';
    }

    if (r?.gesamtnote == null) throw i18nError('job.error.gesamtnoteMissing');
    // Grundlage + Achsen-Profil ins Ergebnis (siehe routes/jobs/review.js).
    r.basis = basis;
    r.profil = profil;

    saveChapterMacroReviewCache(bookIdInt, email, chapterIdInt, pagesSig, r, effectiveProvider);

    const model = _modelName(effectiveProvider);
    if (bookName) upsertBookByName(parseInt(bookId), bookName);
    db.prepare(`INSERT INTO chapter_reviews
      (book_id, chapter_id, reviewed_at, review_json, model, user_email)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(parseInt(bookId), parseInt(chapterId),
        new Date().toISOString(), JSON.stringify(r), model, userEmail || null);

    completeJob(jobId, {
      review: r,
      chapterId: parseInt(chapterId),
      chapterName,
      pageCount: contents.length,
      tokensIn: tok.in,
      tokensOut: tok.out,
    }, tps(tok), `«${chapterName}» ${contents.length} Seiten, Note ${r.gesamtnote}`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Fehler (chap=${chapterId}): ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

// ── Route ─────────────────────────────────────────────────────────────────────
kapitelRouter.post('/chapter-review', jsonBody, (req, res) => {
  const { chapter_name, book_name } = req.body;
  const book_id = toIntId(req.body?.book_id);
  const chapter_id = toIntId(req.body?.chapter_id);
  const includeSubchapters = req.body?.include_subchapters === true;
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  if (!chapter_id) return res.status(400).json({ error_code: 'CHAPTER_ID_REQUIRED' });
  setContext({ book: book_id });
  const { requireBookAccess, sendACLError } = require('../../lib/acl');
  try { requireBookAccess(req, book_id, 'editor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }
  const userEmail = sessionEmail(req);
  const userToken = null;
  // Dedup auf Kapitel-Ebene – parallele Reviews unterschiedlicher Kapitel sind ok.
  const existing = findActiveJobId('chapter-review', chapter_id, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const label = chapter_name ? 'job.label.chapterReviewChapter' : 'job.label.chapterReview';
  const labelParams = chapter_name ? { name: chapter_name } : null;
  const jobId = createJob('chapter-review', book_id, userEmail, label, labelParams, chapter_id);
  enqueueJob(jobId, () => runChapterReviewJob(
    jobId, book_id, chapter_id, chapter_name || '', book_name || '', userEmail, userToken,
    { includeSubchapters },
  ));
  res.json({ jobId });
});

module.exports = { kapitelRouter, runChapterReviewJob };
