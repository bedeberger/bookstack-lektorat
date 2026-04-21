'use strict';
const express = require('express');
const { db, getBookLocale, getBookSettings, getChapterFigures, getChapterFigureRelations, getChapterLocations, getTokenForRequest } = require('../../db/schema');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  aiCall, getPrompts, getBookPrompts,
  htmlToText, bsGet, bsGetAll, jobAbortControllers,
  _modelName, fmtTok, tps,
  jobs, runningJobs, createJob, enqueueJob, jobKey,
  jsonBody,
} = require('./shared');

const { narrativeLabels } = require('./narrative-labels');

// Letzten Absatz eines Texts extrahieren (max. maxChars Zeichen). Dient als
// Übergangskontext für den Lektorat-Prompt, damit Tempus-/Perspektivwechsel
// am Seitenanfang korrekt bewertet werden.
function lastParagraph(text, maxChars = 600) {
  const clean = (text || '').trim();
  if (!clean) return null;
  const paragraphs = clean.split(/\n{2,}|(?<=[.!?…])\s{2,}/).map(p => p.trim()).filter(Boolean);
  const last = paragraphs.length ? paragraphs[paragraphs.length - 1] : clean;
  if (last.length <= maxChars) return last;
  const tail = last.slice(-maxChars);
  const firstSentenceStart = tail.search(/[A-ZÄÖÜ]/);
  return firstSentenceStart > 0 ? tail.slice(firstSentenceStart) : tail;
}

// Gibt die Seite zurück, die unmittelbar vor `currentPageId` liegt – bevorzugt
// im selben Kapitel (BookStack-Priorität), sonst die vorhergehende Seite im Buch.
function findPreviousPage(pages, currentPageId, currentChapterId) {
  if (!Array.isArray(pages) || !pages.length) return null;
  const sameChapter = currentChapterId
    ? pages.filter(p => String(p.chapter_id || '') === String(currentChapterId))
    : pages;
  const pool = (sameChapter.length > 0 ? sameChapter : pages)
    .slice()
    .sort((a, b) => (a.priority || 0) - (b.priority || 0));
  const idx = pool.findIndex(p => String(p.id) === String(currentPageId));
  if (idx > 0) return pool[idx - 1];
  // Fallback: falls die aktuelle Seite nicht in der Liste ist, letzte Seite vor ihr im Buch nehmen
  if (idx === -1 && currentChapterId && sameChapter.length === 0) {
    const allSorted = pages.slice().sort((a, b) => (a.priority || 0) - (b.priority || 0));
    const i2 = allSorted.findIndex(p => String(p.id) === String(currentPageId));
    return i2 > 0 ? allSorted[i2 - 1] : null;
  }
  return null;
}

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
  const { SYSTEM_LEKTORAT, STOPWORDS: lektoratStopwords, ERKLAERUNG_RULE: lektoratErklaerungRule, KORREKTUR_REGELN: lektoratKorrekturRegeln } = await getBookPrompts(bookId, userEmail);
  const locale = bookId ? getBookLocale(bookId, userEmail) : 'de-CH';
  const bookSettings = bookId ? getBookSettings(bookId, userEmail) : null;
  try {
    logger.info(`Start: Seite #${pageId} (book=${bookId || '-'})`);
    updateJob(jobId, { statusText: 'job.phase.loadingPageContent', progress: 5 });

    const pd = await bsGet('pages/' + pageId, userToken);

    const html = pd.html;
    const text = htmlToText(html);
    if (!text.trim()) { completeJob(jobId, { empty: true }); return; }

    // Kapitelkontext laden: Figuren, Beziehungen, Schauplätze (falls Komplettanalyse gelaufen ist)
    const figuren           = getChapterFigures(bookId, pd.chapter_id, userEmail);
    const figurenBeziehungen = bookId ? getChapterFigureRelations(bookId, pd.chapter_id, userEmail) : [];
    const orte              = bookId ? getChapterLocations(bookId, pd.chapter_id, userEmail) : [];

    // Kapitelname: zuerst aus lokaler chapters-Tabelle (kein BookStack-Call nötig),
    // Fallback: null wenn Kapitel fehlt oder Buch noch nicht synchronisiert wurde.
    const chapterRow = (bookId && pd.chapter_id)
      ? db.prepare('SELECT chapter_name FROM chapters WHERE book_id = ? AND chapter_id = ?').get(parseInt(bookId), pd.chapter_id)
      : null;
    const chapterName = chapterRow?.chapter_name || null;

    // Vorseite ermitteln (letzter Absatz als Übergangskontext). Nur Buch-Seiten aus BookStack
    // ziehen – pages-Listing ist paginiert, aber typischerweise günstig (Metadaten).
    let previousExcerpt = null;
    if (bookId) {
      try {
        const allPages = await bsGetAll('pages?filter[book_id]=' + bookId, userToken);
        const prev = findPreviousPage(allPages, pageId, pd.chapter_id);
        if (prev) {
          const prevPd = await bsGet('pages/' + prev.id, userToken);
          previousExcerpt = lastParagraph(htmlToText(prevPd.html));
        }
      } catch (e) {
        logger.warn(`Vorseiten-Kontext konnte nicht geladen werden (page=${pageId}): ${e.message}`);
      }
    }

    const tok = { in: 0, out: 0, ms: 0 };
    updateJob(jobId, { statusText: 'job.phase.aiAnalyzing', progress: 10 });

    const result = await aiCall(jobId, tok,
      buildLektoratPrompt(text, {
        stopwords: lektoratStopwords,
        erklaerungRule: lektoratErklaerungRule,
        korrekturRegeln: lektoratKorrekturRegeln,
        figuren, figurenBeziehungen, orte,
        pageName: pd.name, chapterName,
        ...narrativeLabels(bookSettings),
        previousExcerpt,
      }),
      SYSTEM_LEKTORAT,
      10, 97, 5000, 0.2, null, undefined, SCHEMA_LEKTORAT,
    );

    if (!Array.isArray(result?.fehler)) throw i18nError('job.error.fehlerArrayMissing');
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
  const { SYSTEM_LEKTORAT, STOPWORDS: batchStopwords, ERKLAERUNG_RULE: batchErklaerungRule, KORREKTUR_REGELN: batchKorrekturRegeln } = await getBookPrompts(bookId, userEmail);
  const locale = getBookLocale(bookId, userEmail);
  const bookSettings = getBookSettings(bookId, userEmail);
  // Kapitelname-Cache (chapter_id → name) aus lokaler DB, spart wiederholte Lookups pro Seite.
  const chapterRows = db.prepare('SELECT chapter_id, chapter_name FROM chapters WHERE book_id = ?').all(parseInt(bookId));
  const chapterNameById = Object.fromEntries(chapterRows.map(r => [String(r.chapter_id), r.chapter_name]));
  try {
    updateJob(jobId, { statusText: 'job.phase.loadingPages', progress: 0 });
    const pages = await bsGetAll('pages?filter[book_id]=' + bookId, userToken);
    if (!pages.length) { completeJob(jobId, { empty: true }); return; }
    logger.info(`Start: ${pages.length} Seiten (book=${bookId})`);

    const tok = { in: 0, out: 0, ms: 0 };
    const model = _modelName(process.env.API_PROVIDER || 'claude');
    let done = 0, totalErrors = 0;

    // Letzten-Absatz-Cache pro page_id, damit die Vorseiten-Extraktion im Batch
    // nicht dieselbe Seite zweimal von BookStack holt.
    const lastParaCache = new Map();

    for (let i = 0; i < pages.length; i++) {
      if (jobAbortControllers.get(jobId)?.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const p = pages[i];
      const fromPct = Math.round((i / pages.length) * 95);
      const toPct   = Math.round(((i + 1) / pages.length) * 95);
      updateJob(jobId, {
        progress: fromPct,
        statusText: 'job.phase.pageProgress',
        statusParams: { current: i + 1, total: pages.length, name: p.name },
      });

      try {
        const pd = await bsGet('pages/' + p.id, userToken);
        const text = htmlToText(pd.html).trim();
        if (!text) continue;

        const batchFiguren        = getChapterFigures(bookId, pd.chapter_id, userEmail);
        const batchBeziehungen    = getChapterFigureRelations(bookId, pd.chapter_id, userEmail);
        const batchOrte           = getChapterLocations(bookId, pd.chapter_id, userEmail);

        const prev = findPreviousPage(pages, p.id, pd.chapter_id);
        let previousExcerpt = null;
        if (prev) {
          if (lastParaCache.has(prev.id)) {
            previousExcerpt = lastParaCache.get(prev.id);
          } else {
            try {
              const prevPd = await bsGet('pages/' + prev.id, userToken);
              previousExcerpt = lastParagraph(htmlToText(prevPd.html));
              lastParaCache.set(prev.id, previousExcerpt);
            } catch (_) { /* Vorseite fehlschlägt → kein Kontext, nicht kritisch */ }
          }
        }
        // Aktuelle Seite als zukünftige Vorseite vormerken (spart Fetch für die Folge-Iteration)
        lastParaCache.set(p.id, lastParagraph(text));

        const chapterName = pd.chapter_id ? (chapterNameById[String(pd.chapter_id)] || null) : null;

        const result = await aiCall(jobId, tok,
          buildBatchLektoratPrompt(text, {
            stopwords: batchStopwords,
            erklaerungRule: batchErklaerungRule,
            korrekturRegeln: batchKorrekturRegeln,
            figuren: batchFiguren,
            figurenBeziehungen: batchBeziehungen,
            orte: batchOrte,
            pageName: p.name,
            chapterName,
            erzaehlperspektive: bookSettings?.erzaehlperspektive || null,
            erzaehlzeit: bookSettings?.erzaehlzeit || null,
            previousExcerpt,
          }),
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
  if (!page_id) return res.status(400).json({ error_code: 'PAGE_ID_REQUIRED' });
  const userEmail = req.session?.user?.email || null;
  const userToken = getTokenForRequest(req);
  const existing = runningJobs.get(jobKey('check', page_id, userEmail));
  if (existing && jobs.has(existing)) return res.json({ jobId: existing, existing: true });
  const label = 'job.label.checkPage';
  const labelParams = { name: page_name || `#${page_id}` };
  const jobId = createJob('check', page_id, userEmail, label, labelParams);
  enqueueJob(jobId, () => runCheckJob(jobId, page_id, book_id || null, userEmail, userToken));
  res.json({ jobId });
});

lektoratRouter.post('/batch-check', jsonBody, (req, res) => {
  const { book_id, book_name } = req.body;
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  const userEmail = req.session?.user?.email || null;
  const userToken = getTokenForRequest(req);
  const existing = runningJobs.get(jobKey('batch-check', book_id, userEmail));
  if (existing && jobs.has(existing)) return res.json({ jobId: existing, existing: true });
  const label = book_name ? 'job.label.batchCheckBook' : 'job.label.batchCheck';
  const labelParams = book_name ? { name: book_name } : null;
  const jobId = createJob('batch-check', book_id, userEmail, label, labelParams);
  enqueueJob(jobId, () => runBatchCheckJob(jobId, book_id, userEmail, userToken));
  res.json({ jobId });
});

module.exports = { lektoratRouter };
