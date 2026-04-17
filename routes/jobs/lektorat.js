'use strict';
const express = require('express');
const { db, getBookLocale, getChapterFigures } = require('../../db/schema');
const {
  makeJobLogger, updateJob, completeJob, failJob,
  aiCall, getPrompts, getBookPrompts,
  htmlToText, bsGet, bsGetAll, jobAbortControllers,
  _modelName, fmtTok, tps,
  jobs, runningJobs, createJob, enqueueJob, jobKey,
  jsonBody,
} = require('./shared');

// Gültige Fehlertypen und Validierung für Lektorat-Ergebnisse
const VALID_TYPEN = new Set(['rechtschreibung', 'grammatik', 'stil', 'wiederholung', 'schwaches_verb', 'fuellwort', 'show_vs_tell', 'passiv', 'perspektivbruch', 'tempuswechsel']);

// Erklärungs-Phrasen die darauf hindeuten, dass der Eintrag kein echter Fehler ist.
// Lokale Modelle (Ollama/Llama) ignorieren die FILTER-PFLICHT im Prompt häufig
// und liefern Einträge mit «Korrektur entfällt – Satz ist korrekt» o.Ä. als Erklärung.
const NON_ERROR_RE = /korrektur entfällt|kein fehler|kein mangel|ist korrekt\b|nicht falsch|eintrag entfällt|im schweizer kontext|vertretbar|akzeptabel|möglicherweise/i;

function validateLektoratFehler(fehler, locale) {
  const isCH = locale === 'de-CH';
  return fehler
    .map(f => ({ ...f, typ: f.typ?.toLowerCase?.() }))
    .filter(f => VALID_TYPEN.has(f.typ))
    .filter(f => f.typ !== 'stil' || (f.korrektur?.trim() && f.korrektur.trim() !== f.original?.trim()))
    // Einträge deren Erklärung verrät, dass es kein echter Fehler ist
    .filter(f => !NON_ERROR_RE.test(f.erklaerung || ''))
    // de-CH: Einträge filtern, deren einziger Unterschied ss↔ß ist
    .filter(f => {
      if (!isCH || !f.original || !f.korrektur) return true;
      return f.original.replace(/ß/g, 'ss') !== f.korrektur.replace(/ß/g, 'ss');
    })
    // de-CH: verbleibende Korrekturen bereinigen – ß→ss
    .map(f => {
      if (isCH && f.korrektur) f.korrektur = f.korrektur.replace(/ß/g, 'ss');
      return f;
    });
}

const lektoratRouter = express.Router();

// ── Job: Seiten-Lektorat ──────────────────────────────────────────────────────
async function runCheckJob(jobId, pageId, bookId, userEmail, userToken) {
  const logger = makeJobLogger(jobId);
  const { buildLektoratPrompt, SCHEMA_LEKTORAT } = await getPrompts();
  const { SYSTEM_LEKTORAT, STOPWORDS: lektoratStopwords, ERKLAERUNG_RULE: lektoratErklaerungRule, KORREKTUR_REGELN: lektoratKorrekturRegeln } = await getBookPrompts(bookId);
  const locale = bookId ? getBookLocale(bookId) : 'de-CH';
  try {
    logger.info(`Start: Seite #${pageId} (book=${bookId || '-'})`);
    updateJob(jobId, { statusText: 'Lade Seiteninhalt…', progress: 5 });

    const pd = await bsGet('pages/' + pageId, userToken);

    const html = pd.html;
    const text = htmlToText(html);
    if (!text.trim()) { completeJob(jobId, { empty: true }); return; }

    // Figuren des Kapitels laden (falls Komplettanalyse gelaufen ist)
    const figuren = getChapterFigures(bookId, pd.chapter_id, userEmail);

    const tok = { in: 0, out: 0, ms: 0 };
    updateJob(jobId, { statusText: 'KI analysiert…', progress: 10 });

    const result = await aiCall(jobId, tok,
      buildLektoratPrompt(text, { stopwords: lektoratStopwords, erklaerungRule: lektoratErklaerungRule, korrekturRegeln: lektoratKorrekturRegeln, figuren }),
      SYSTEM_LEKTORAT,
      10, 97, 5000, 0.2, null, undefined, SCHEMA_LEKTORAT,
    );

    if (!Array.isArray(result?.fehler)) throw new Error('fehler-Array fehlt');
    result.fehler = validateLektoratFehler(result.fehler, locale);

    const model = _modelName(process.env.API_PROVIDER || 'claude');
    const szenen = Array.isArray(result?.szenen) ? result.szenen : [];

    const info = db.prepare(`INSERT INTO page_checks
      (page_id, page_name, book_id, chapter_id, checked_at, error_count, errors_json, szenen_json, stilanalyse, fazit, model, user_email)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(parseInt(pageId), pd.name, parseInt(bookId) || null, pd.chapter_id || null,
        new Date().toISOString(), result.fehler.length, JSON.stringify(result.fehler),
        szenen.length > 0 ? JSON.stringify(szenen) : null,
        result.stilanalyse || null, result.fazit || null, model, userEmail || null);

    completeJob(jobId, {
      fehler: result.fehler,
      szenen,
      stilanalyse: result.stilanalyse || null,
      fazit: result.fazit || null,
      originalHtml: html,
      updatedAt: pd.updated_at || null,
      pageName: pd.name,
      checkId: info.lastInsertRowid,
      tokensIn: tok.in,
      tokensOut: tok.out,
    }, tps(tok));
    logger.info(`«${pd.name}» fertig (page=${pageId}, book=${bookId || '-'}, chap=${pd.chapter_id || '-'}, ${result.fehler.length} Beanstandungen, ${fmtTok(tok.in)}↑ ${fmtTok(tok.out)}↓ Tokens)`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Fehler (page=${pageId}, book=${bookId || '-'}): ${e.message}`);
    failJob(jobId, e);
  }
}

// ── Job: Batch-Lektorat ───────────────────────────────────────────────────────
async function runBatchCheckJob(jobId, bookId, userEmail, userToken) {
  const logger = makeJobLogger(jobId);
  const { buildBatchLektoratPrompt, SCHEMA_LEKTORAT } = await getPrompts();
  const { SYSTEM_LEKTORAT, STOPWORDS: batchStopwords, ERKLAERUNG_RULE: batchErklaerungRule, KORREKTUR_REGELN: batchKorrekturRegeln } = await getBookPrompts(bookId);
  const locale = getBookLocale(bookId);
  try {
    updateJob(jobId, { statusText: 'Lade Seiten…', progress: 0 });
    const pages = await bsGetAll('pages?book_id=' + bookId, userToken);
    if (!pages.length) { completeJob(jobId, { empty: true }); return; }
    logger.info(`Start: ${pages.length} Seiten (book=${bookId})`);

    const tok = { in: 0, out: 0, ms: 0 };
    const model = _modelName(process.env.API_PROVIDER || 'claude');
    let done = 0, totalErrors = 0;

    for (let i = 0; i < pages.length; i++) {
      if (jobAbortControllers.get(jobId)?.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const p = pages[i];
      const fromPct = Math.round((i / pages.length) * 95);
      const toPct   = Math.round(((i + 1) / pages.length) * 95);
      updateJob(jobId, {
        progress: fromPct,
        statusText: `${i + 1}/${pages.length}: ${p.name}…`,
      });

      try {
        const pd = await bsGet('pages/' + p.id, userToken);
        const text = htmlToText(pd.html).trim();
        if (!text) continue;

        const batchFiguren = getChapterFigures(bookId, pd.chapter_id, userEmail);
        const result = await aiCall(jobId, tok,
          buildBatchLektoratPrompt(text, { stopwords: batchStopwords, erklaerungRule: batchErklaerungRule, korrekturRegeln: batchKorrekturRegeln, figuren: batchFiguren }),
          SYSTEM_LEKTORAT,
          fromPct, toPct, 2000, 0.2, null, undefined, SCHEMA_LEKTORAT,
        );

        if (!Array.isArray(result?.fehler)) throw new Error('fehler-Array fehlt');
        const fehler = validateLektoratFehler(result.fehler, locale);
        totalErrors += fehler.length;

        const szenenBatch = Array.isArray(result?.szenen) ? result.szenen : [];
        db.prepare(`INSERT INTO page_checks
          (page_id, page_name, book_id, chapter_id, checked_at, error_count, errors_json, szenen_json, stilanalyse, fazit, model, user_email)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(p.id, p.name, parseInt(bookId), p.chapter_id || null, new Date().toISOString(),
            fehler.length, JSON.stringify(fehler),
            szenenBatch.length > 0 ? JSON.stringify(szenenBatch) : null,
            result.stilanalyse || null, result.fazit || null, model, userEmail || null);
        logger.info(`[${i + 1}/${pages.length}] «${pd.name}» fertig (page=${p.id}, chap=${p.chapter_id || '-'}, ${fehler.length} Beanstandungen)`);
        done++;
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        logger.warn(`[${i + 1}/${pages.length}] «${p.name}» übersprungen (page=${p.id}, chap=${p.chapter_id || '-'}): ${e.message}`);
      }
    }

    completeJob(jobId, { pageCount: pages.length, done, totalErrors, tokensIn: tok.in, tokensOut: tok.out }, tps(tok));
    logger.info(`Fertig: ${done}/${pages.length} Seiten (book=${bookId}), ${totalErrors} Beanstandungen, ${fmtTok(tok.in)}↑ ${fmtTok(tok.out)}↓ Tokens`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Fehler (book=${bookId}): ${e.message}`);
    failJob(jobId, e);
  }
}

// ── Routen ────────────────────────────────────────────────────────────────────
lektoratRouter.post('/check', jsonBody, (req, res) => {
  const { page_id, book_id, page_name } = req.body;
  if (!page_id) return res.status(400).json({ error: 'page_id fehlt' });
  const userEmail = req.session?.user?.email || null;
  const userToken = req.session?.bookstackToken
    ? { id: req.session.bookstackToken.id, pw: req.session.bookstackToken.pw }
    : null;
  const existing = runningJobs.get(jobKey('check', page_id, userEmail));
  if (existing && jobs.has(existing)) return res.json({ jobId: existing, existing: true });
  const label = page_name ? `Lektorat · ${page_name}` : `Lektorat · Seite #${page_id}`;
  const jobId = createJob('check', page_id, userEmail, label);
  enqueueJob(jobId, () => runCheckJob(jobId, page_id, book_id || null, userEmail, userToken));
  res.json({ jobId });
});

lektoratRouter.post('/batch-check', jsonBody, (req, res) => {
  const { book_id, book_name } = req.body;
  if (!book_id) return res.status(400).json({ error: 'book_id fehlt' });
  const userEmail = req.session?.user?.email || null;
  const userToken = req.session?.bookstackToken
    ? { id: req.session.bookstackToken.id, pw: req.session.bookstackToken.pw }
    : null;
  const existing = runningJobs.get(jobKey('batch-check', book_id, userEmail));
  if (existing && jobs.has(existing)) return res.json({ jobId: existing, existing: true });
  const label = book_name ? `Serien-Lektorat · ${book_name}` : `Serien-Lektorat`;
  const jobId = createJob('batch-check', book_id, userEmail, label);
  enqueueJob(jobId, () => runBatchCheckJob(jobId, book_id, userEmail, userToken));
  res.json({ jobId });
});

module.exports = { lektoratRouter };
