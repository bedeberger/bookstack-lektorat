'use strict';
const crypto = require('crypto');
const express = require('express');
const {
  db, getBookLocale, getBookSettings, getChapterFigures, getChapterFigureRelations, getChapterLocations,
  getPageMotifs,
  loadLektoratCache, saveLektoratCache,
} = require('../../db/schema');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError, contentHttpError,
  aiCall, getPrompts, getBookPrompts,
  htmlToTextForPrompt, jobAbortControllers,
  _modelName, tps,
  jobs, runningJobs, createJob, enqueueJob, jobKey, findActiveJobId,
  jsonBody,
} = require('./shared');
const contentStore = require('../../lib/content-store');

function _sigHash(obj) {
  return crypto.createHash('sha1').update(JSON.stringify(obj ?? null)).digest('hex').slice(0, 12);
}

// ctx_sig deckt alle Inputs ab, die den Lektorat-Output beeinflussen:
// page-Text (updated_at) + Kapitelkontext + Stil-/Regel-Strings + Vorseite + cacheVersion.
function buildLektoratCtxSig(parts) {
  return _sigHash(parts);
}

const { narrativeLabels } = require('./narrative-labels');

// Traegt die Seite Quellennachweise? Steuert den Beleg-Schutzblock im Prompt
// (siehe prompts/blocks.js#_buildBelegBlock). Indizierter Lookup auf dem
// abgeleiteten Fund-Index — in Buechern ohne Quellen kostenlos.
const _stmtHasCites = db.prepare('SELECT 1 AS x FROM source_citations WHERE page_id = ? LIMIT 1');
function _pageHasCitations(pageId) {
  try { return !!_stmtHasCites.get(parseInt(pageId, 10)); }
  catch { return false; }
}
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');
const { requireBookAccess, sendACLError } = require('../../lib/acl');
const { resolvePageBookId } = require('../../lib/content-ownership');
const appSettings = require('../../lib/app-settings');
const { resolveProvider } = require('../../lib/ai');
const { lektoratAnalyze, objektivRuns, splitEnabled } = require('./lektorat-split');

// Lokale Provider (ollama/llama) bekommen einen deutlich abgespeckten Lektorat-Prompt:
// kein Vorseiten-Kontext (BookStack-Roundtrip gespart), keine Figuren-Beziehungen,
// kein POV-/Tempus-Block. Alle Einsparungen auch in public/js/prompts.js (_isLocal).
const _isLocalProvider = () => {
  const p = appSettings.get('ai.provider') || 'claude';
  return p === 'ollama' || p === 'openai-compat';
};

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
    .sort((a, b) => (a.position || 0) - (b.position || 0));
  const idx = pool.findIndex(p => String(p.id) === String(currentPageId));
  if (idx > 0) return pool[idx - 1];
  // Fallback: falls die aktuelle Seite nicht in der Liste ist, letzte Seite vor ihr im Buch nehmen
  if (idx === -1 && currentChapterId && sameChapter.length === 0) {
    const allSorted = pages.slice().sort((a, b) => (a.position || 0) - (b.position || 0));
    const i2 = allSorted.findIndex(p => String(p.id) === String(currentPageId));
    return i2 > 0 ? allSorted[i2 - 1] : null;
  }
  return null;
}

// Erklärungs-Phrasen die darauf hindeuten, dass der Eintrag kein echter Fehler ist.
// Sprach-agnostisches letztes Sicherheitsnetz: Lokale Modelle (Ollama/Llama)
// ignorieren die FILTER-PFLICHT im Prompt häufig, und bei englischsprachigen
// Büchern formuliert auch Claude die Selbst-Widerrufung auf Englisch («is in fact
// correct», «this entry is withdrawn») – die rein deutschen Prompt-Filter greifen
// dann nicht. Beide Sprachräume hier abgedeckt.
const NON_ERROR_RE = /korrektur entfällt|kein fehler|kein mangel|ist korrekt\b|nicht falsch|eintrag entfällt|im schweizer kontext|vertretbar|akzeptabel|möglicherweise|\bwithdrawn\b|withdraw this entry|\bnot an error\b|\bno error\b|\bnot a mistake\b|\bnot wrong\b|is (?:in fact |actually |indeed |grammatically )?correct here|is (?:in fact|actually|indeed|grammatically) correct\b|correct as (?:written|is|it stands)|no correction (?:needed|necessary|required)|no change (?:needed|necessary|required)|leave (?:it |this )?as[- ]is|perfectly (?:fine|correct|acceptable|valid)/i;

// Identische Findings (gleicher typ + original + korrektur) entfernen.
// AI-Output enthält gelegentlich byte-gleiche Duplikate (insb. bei mehrfachem
// Vorkommen desselben Tokens). Da `original` für die Replace-Logik als
// Match-String dient, reicht ein Eintrag.
function dedupFehler(fehler) {
  const seen = new Set();
  return fehler.filter(f => {
    const k = `${f.typ ?? ''}|${f.original ?? ''}|${f.korrektur ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Subjektiv-stilistische Fehlertypen: exakt die Liste, für die der Prompt
// (SCHWERE-SCHWELLE-Block) eine Mengen-Obergrenze verhängt. Mechanische/objektive
// Fehler (rechtschreibung, grammatik inkl. Zeichensetzung, tempuswechsel,
// perspektivbruch, dialogformat) und Konsistenz-Befunde (namens-/figuren-/
// schauplatzmerkmal, anrede, begriffsinkonsistenz, autorenform, unbelegt) fehlen
// hier bewusst – sie werden NIE gekappt.
// CJS-Spiegel von STILISTISCHE_TYPEN in public/js/prompts/lektorat-typen.js (der
// Prompt-Text wird dort erzeugt); Drift ist durch
// tests/unit/lektorat-typen-drift.test.mjs gegated.
const STYLISTIC_TYPEN = new Set([
  'stil', 'satzbau', 'schwaches_verb', 'fuellwort', 'filterwort',
  'klischee', 'ki_geruch', 'show_vs_tell', 'passiv', 'pleonasmus', 'wiederholung',
  'hedging',
]);

const DEFAULT_STYLISTIC_CAP = 20;

// Deterministischer Backstop zur Prompt-Regel „max ~20 stilistische Findings".
// Modelle zählen und selbst-limitieren unzuverlässig – der Prompt bittet zwar um
// harte Priorisierung, aber wenn das Modell 40 schwache Stil-Findings zurückgibt,
// erzwingt dieser Handler-Filter die Grenze verlässlich. Objektive Fehler bleiben
// vollständig erhalten; nur die im STYLISTIC_TYPEN-Set gelisteten Typen werden
// nach Erreichen von `cap` verworfen. Reihenfolge bleibt erhalten (der Prompt hat
// nach Textposition sortiert). Pure Funktion – testbar ohne AI/DB.
function capStylisticFehler(fehler, cap = DEFAULT_STYLISTIC_CAP) {
  if (!Array.isArray(fehler)) return fehler;
  let kept = 0;
  return fehler.filter(f => {
    if (!STYLISTIC_TYPEN.has(f?.typ)) return true;   // objektiv/Konsistenz → nie kappen
    if (kept < cap) { kept++; return true; }
    return false;
  });
}

// Cap aus app_settings (Admin-tunebar), Default 20 – analog ai.lektorat_batch_concurrency.
function stylisticCap() {
  const n = parseInt(appSettings.get('ai.lektorat_stylistic_cap'), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STYLISTIC_CAP;
}

// Vollständige Nachbearbeitung eines rohen fehler-Arrays: validieren → dedupen →
// stilistischen Cap anwenden. Einziger Chokepoint für alle vier Aufruf-Stellen
// (fresh/cached × Einzel/Batch), damit die Pipeline nicht auseinanderdriftet.
// `validTypen` ist das Typ-Set des Buchtyp-Profils (siehe _validTypen) – Findings
// mit profilfremdem Typ werden verworfen. Greift auch auf dem Cache-Pfad: eine
// Buchtyp-Umstellung soll narrativ geprägte Alt-Findings nicht durchlassen.
function finalizeFehler(fehler, locale, validTypen) {
  return capStylisticFehler(dedupFehler(validateLektoratFehler(fehler, locale, validTypen)), stylisticCap());
}

// Erlaubte Fehlertypen für dieses Buch. SSoT ist das Buchtyp-Profil in
// public/js/prompts/lektorat-typen.js – dieselbe Funktion, die das Typ-Enum des
// Prompts baut. Damit kann der Server nie mehr Typen akzeptieren, als der Prompt
// überhaupt angefragt hat.
function _validTypen(prompts, buchtyp, local) {
  return new Set(prompts.lektoratTypen(buchtyp || null, { local }));
}

// Letzter History-Eintrag dieser Seite (für History-Insert-Dedup).
const _lastPageCheckStmt = db.prepare(`
  SELECT id, errors_json FROM page_checks
   WHERE page_id = ? AND user_email IS ?
   ORDER BY checked_at DESC, id DESC
   LIMIT 1
`);

function validateLektoratFehler(fehler, locale, validTypen) {
  const isCH = locale === 'de-CH';
  return fehler
    // `kontext` ist Legacy-Feld aus PROMPTS_VERSION <=15: nirgends gerendert,
    // AI halluzinierte oft (nicht-substring von `original`). Defensiv strippen,
    // damit alte Cache-Rows und vereinzelte AI-Antworten kein totes Feld mitschleppen.
    .map(f => { const { kontext, ...rest } = f; return { ...rest, typ: rest.typ?.toLowerCase?.() }; })
    .filter(f => validTypen.has(f.typ))
    // Vorschlag == Original (1:1, nach trim) ist kein Fehler – für alle Typen skippen
    .filter(f => !f.korrektur || f.korrektur.trim() !== f.original?.trim())
    // stil braucht zusätzlich eine nicht-leere Korrektur
    .filter(f => f.typ !== 'stil' || !!f.korrektur?.trim())
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
  const prompts = await getPrompts();
  const { PROMPTS_VERSION } = prompts;
  const { SYSTEM_LEKTORAT_BLOCKS: SYSTEM_LEKTORAT, STOPWORDS: lektoratStopwords, ERKLAERUNG_RULE: lektoratErklaerungRule, KORREKTUR_REGELN: lektoratKorrekturRegeln } = await getBookPrompts(bookId, userEmail);
  const locale = bookId ? getBookLocale(bookId, userEmail) : 'de-CH';
  const bookSettings = bookId ? getBookSettings(bookId, userEmail) : null;
  const effectiveProvider = resolveProvider({ userEmail });
  const cacheVersion = `${_modelName(effectiveProvider)}:${PROMPTS_VERSION || ''}`;
  try {
    logger.info(`Start: Seite #${pageId}`);
    updateJob(jobId, { statusText: 'job.phase.loadingPageContent', progress: 5 });

    const pd = await contentStore.loadPage(pageId, userToken).catch(e => { throw contentHttpError(e); });

    const html = pd.html;
    // Absatz-erhaltende Variante statt des kompakten `htmlToText`:
    // die Dialogformat-Regel „Sprecherwechsel → neuer Absatz" prüft gegen
    // Absatzgrenzen, die hier als `\n\n` sichtbar bleiben — die kompakte
    // Variante ebnet jede Grenze ein, so dass jeder Sprecherwechsel als
    // fehlender Umbruch gemeldet wird. Frontend findInHtml/replaceInHtml
    // normalisieren `\s+` → ' ' beim Match, so dass `\n\n` in `original`
    // sicher ist (und cross-block-Ersetzungen schon durch die Block-Grenze
    // des Merge-Guards abgewiesen werden).
    const text = htmlToTextForPrompt(html);
    if (!text.trim()) { completeJob(jobId, { empty: true }); return; }

    // Kapitelkontext laden: Figuren, Beziehungen, Schauplätze (falls Komplettanalyse gelaufen ist).
    // Lokale Provider: Beziehungen weglassen – der Prompt-Block wird für _isLocal ohnehin gedroppt.
    const local = _isLocalProvider();
    const figuren           = getChapterFigures(bookId, pd.chapter_id, userEmail);
    const figurenBeziehungen = (!local && bookId) ? getChapterFigureRelations(bookId, pd.chapter_id, userEmail) : [];
    const orte              = bookId ? getChapterLocations(bookId, pd.chapter_id, userEmail) : [];
    // Geplante Soll-Motive dieser Seite/dieses Kapitels als passiver Stil-Pass-Kontext
    // (nur Cloud – der Motiv-Block wird für _isLocal ohnehin gedroppt).
    const motive            = (!local && bookId) ? getPageMotifs(bookId, pd.chapter_id, pageId, userEmail) : [];
    // Quellennachweise: auch lokal relevant (kleine Modelle korrigieren
    // Klammer-Einschuebe besonders gern weg).
    const hatBelege         = _pageHasCitations(pageId);

    // Kapitelname: zuerst aus lokaler chapters-Tabelle (kein BookStack-Call nötig),
    // Fallback: null wenn Kapitel fehlt oder Buch noch nicht synchronisiert wurde.
    const chapterRow = (bookId && pd.chapter_id)
      ? db.prepare('SELECT chapter_name FROM chapters WHERE book_id = ? AND chapter_id = ?').get(parseInt(bookId), pd.chapter_id)
      : null;
    const chapterName = chapterRow?.chapter_name || null;

    // Vorseite ermitteln (letzter Absatz als Übergangskontext). Nur Buch-Seiten aus BookStack
    // ziehen – pages-Listing ist paginiert, aber typischerweise günstig (Metadaten).
    // Lokale Provider: komplett überspringen – wird für _isLocal im Prompt nicht verwendet
    // (dient nur Tempus-/Perspektiv-Prüfung, die lokal aus dem typ-Enum gedroppt ist).
    // `htmlToTextForPrompt` ist hier Pflicht, nicht Geschmack: `lastParagraph`
    // splittet auf `\n{2,}` – aus der einzeiligen Variante kann es keinen Absatz
    // schneiden und liefert stattdessen die letzten 600 Zeichen der Vorseite.
    // Gleiche Wahl wie im Batch-Pfad (runBatchCheckJob).
    let previousExcerpt = null;
    if (bookId && !local) {
      try {
        const allPages = await contentStore.listPages(bookId, userToken);
        const prev = findPreviousPage(allPages, pageId, pd.chapter_id);
        if (prev) {
          const prevPd = await contentStore.loadPage(prev.id, userToken);
          previousExcerpt = lastParagraph(htmlToTextForPrompt(prevPd.html));
        }
      } catch (e) {
        logger.warn(`Vorseiten-Kontext konnte nicht geladen werden (page=${pageId}): ${e.message}`);
      }
    }

    const tok = { in: 0, out: 0, ms: 0 };
    updateJob(jobId, { statusText: 'job.phase.aiAnalyzing', progress: 10 });

    // Cache nur wenn bookId vorhanden (FK auf books).
    const langCode = (locale || 'de-CH').split('-')[0];
    const ctxSig = bookId ? buildLektoratCtxSig({
      upd: pd.updated_at || '',
      text_sha: crypto.createHash('sha1').update(text).digest('hex').slice(0, 16),
      fig: figuren, ort: orte, bez: figurenBeziehungen, mot: motive,
      nar: narrativeLabels(bookSettings),
      sw: lektoratStopwords, er: lektoratErklaerungRule, kr: lektoratKorrekturRegeln,
      stp: bookSettings?.stilprofil || '',
      pe: previousExcerpt, cn: chapterName, pn: pd.name, cv: cacheVersion, lc: langCode,
      bl: hatBelege,
    }) : null;
    const cached = ctxSig ? loadLektoratCache(bookId, userEmail, pageId, ctxSig, effectiveProvider) : null;
    const validTypen = _validTypen(prompts, bookSettings?.buchtyp, local);

    let result;
    if (cached) {
      logger.info(`Cache-HIT (page=${pageId}) – spart Lektorat-Call.`);
      updateJob(jobId, { progress: 97 });
      result = cached;
      // Re-Validate + Dedup auf Cached-Path: ältere Cache-Rows können Duplikate,
      // das tote `kontext`-Feld oder 1:1-Vorschläge (== Original) enthalten.
      // validateLektoratFehler strippt `kontext` und filtert 1:1 mit.
      if (Array.isArray(result?.fehler)) {
        result.fehler = finalizeFehler(result.fehler, locale, validTypen);
      }
    } else {
      result = await lektoratAnalyze({
        jobId, tok, text, local, prompts, system: SYSTEM_LEKTORAT, single: true,
        buchtyp: bookSettings?.buchtyp || null,
        fromPct: 10, toPct: 97,
        promptOpts: {
          stopwords: lektoratStopwords,
          erklaerungRule: lektoratErklaerungRule,
          korrekturRegeln: lektoratKorrekturRegeln,
          figuren, figurenBeziehungen, orte, motive, hatBelege,
          pageName: pd.name, chapterName,
          ...narrativeLabels(bookSettings),
          previousExcerpt,
          langCode,
        },
      });

      result.fehler = finalizeFehler(result.fehler, locale, validTypen);

      if (ctxSig) saveLektoratCache(bookId, userEmail, pageId, ctxSig, result, effectiveProvider);
    }

    const model = _modelName(effectiveProvider);
    const szenen = Array.isArray(result?.szenen) ? result.szenen : [];
    const errorsJson = JSON.stringify(result.fehler);

    // History-Insert-Dedup: gleicher errors_json wie jüngster Eintrag → kein neuer Row.
    // Verhindert wiederholte "Prüfen"-Klicks ohne Page-Edit, die identische Findings
    // produzieren (typisch bei Cache-HIT).
    const lastCheck = _lastPageCheckStmt.get(parseInt(pageId), userEmail || null);
    const historyDedup = !!(lastCheck && lastCheck.errors_json === errorsJson);
    let checkId;
    if (historyDedup) {
      checkId = lastCheck.id;
      logger.info(`History-Dedup: identische Findings wie page_check #${lastCheck.id}, kein neuer Eintrag.`);
    } else {
      const info = db.prepare(`INSERT INTO page_checks
        (page_id, book_id, chapter_id, checked_at, error_count, errors_json, szenen_json, stilanalyse, fazit, model, user_email)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(parseInt(pageId), parseInt(bookId) || null, pd.chapter_id || null,
          new Date().toISOString(), result.fehler.length, errorsJson,
          szenen.length > 0 ? JSON.stringify(szenen) : null,
          result.stilanalyse || null, result.fazit || null, model, userEmail || null);
      checkId = info.lastInsertRowid;
    }

    completeJob(jobId, {
      fehler: result.fehler,
      szenen,
      stilanalyse: result.stilanalyse || null,
      fazit: result.fazit || null,
      originalHtml: html,
      updatedAt: pd.updated_at || null,
      pageName: pd.name,
      checkId,
      tokensIn: tok.in,
      tokensOut: tok.out,
    }, tps(tok), `«${pd.name}» page=${pageId}, chap=${pd.chapter_id || '-'}, ${result.fehler.length} Beanstandungen${historyDedup ? ' (dedup)' : ''}`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Fehler (page=${pageId}): ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

// ── Job: Batch-Lektorat ───────────────────────────────────────────────────────
async function runBatchCheckJob(jobId, bookId, userEmail, userToken) {
  const logger = makeJobLogger(jobId);
  const prompts = await getPrompts();
  const { PROMPTS_VERSION } = prompts;
  const effectiveProvider = resolveProvider({ userEmail });
  const cacheVersion = `${_modelName(effectiveProvider)}:${PROMPTS_VERSION || ''}`;
  const { SYSTEM_LEKTORAT_BLOCKS: SYSTEM_LEKTORAT, STOPWORDS: batchStopwords, ERKLAERUNG_RULE: batchErklaerungRule, KORREKTUR_REGELN: batchKorrekturRegeln } = await getBookPrompts(bookId, userEmail);
  const locale = getBookLocale(bookId, userEmail);
  const langCode = (locale || 'de-CH').split('-')[0];
  const bookSettings = getBookSettings(bookId, userEmail);
  // Kapitelname-Cache (chapter_id → name) aus lokaler DB, spart wiederholte Lookups pro Seite.
  const chapterRows = db.prepare('SELECT chapter_id, chapter_name FROM chapters WHERE book_id = ?').all(parseInt(bookId));
  const chapterNameById = Object.fromEntries(chapterRows.map(r => [String(r.chapter_id), r.chapter_name]));
  const local = _isLocalProvider();
  const validTypen = _validTypen(prompts, bookSettings?.buchtyp, local);
  try {
    updateJob(jobId, { statusText: 'job.phase.loadingPages', progress: 0 });
    const pages = await contentStore.listPages(bookId, userToken).catch(e => { throw contentHttpError(e); });
    if (!pages.length) { completeJob(jobId, { empty: true }); return; }
    logger.info(`Start: ${pages.length} Seiten`);

    // Cloud-Provider verträgt parallele Calls; lokale Provider (Ollama/llama.cpp) sind
    // bereits via Mutex in lib/ai.js serialisiert – Pool=1 verhindert pile-up im aiCall.
    // Split-Modus (Cloud): jede Seite fächert in K Objektiv-Läufe + 1 Stil-Lauf auf.
    // Damit die Gesamt-Concurrency (Seiten-Pool × Calls/Seite) im konfigurierten
    // Rahmen bleibt, den Seiten-Pool entsprechend teilen (Rate-Limit-Schutz).
    const rawConcurrency = local ? 1 : (parseInt(appSettings.get('ai.lektorat_batch_concurrency'), 10) || 4);
    const split = !local && splitEnabled();
    const callsPerPage = split ? objektivRuns() + 1 : 1;
    const concurrency = Math.max(1, Math.floor(rawConcurrency / callsPerPage));
    const tok = { in: 0, out: 0, ms: 0, inflight: new Map() };
    const model = _modelName(effectiveProvider);
    let done = 0, totalErrors = 0;

    // Letzten-Absatz-Cache pro page_id, damit die Vorseiten-Extraktion im Batch
    // nicht dieselbe Seite zweimal von BookStack holt.
    const lastParaCache = new Map();

    const processPage = async (p, i) => {
      if (jobAbortControllers.get(jobId)?.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      try {
        const pd = await contentStore.loadPage(p.id, userToken).catch(e => { throw contentHttpError(e); });
        const text = htmlToTextForPrompt(pd.html).trim();
        if (!text) return;

        const batchFiguren     = getChapterFigures(bookId, pd.chapter_id, userEmail);
        const batchBeziehungen = local ? [] : getChapterFigureRelations(bookId, pd.chapter_id, userEmail);
        const batchOrte        = getChapterLocations(bookId, pd.chapter_id, userEmail);
        const batchMotive      = local ? [] : getPageMotifs(bookId, pd.chapter_id, p.id, userEmail);
        const batchHatBelege   = _pageHasCitations(p.id);

        // Lokale Provider: Vorseiten-Kontext wird im Prompt nicht verwendet – kompletter
        // Block überspringen, spart einen BookStack-Fetch pro Seite.
        let previousExcerpt = null;
        if (!local) {
          const prev = findPreviousPage(pages, p.id, pd.chapter_id);
          if (prev) {
            if (lastParaCache.has(prev.id)) {
              previousExcerpt = lastParaCache.get(prev.id);
            } else {
              try {
                const prevPd = await contentStore.loadPage(prev.id, userToken);
                previousExcerpt = lastParagraph(htmlToTextForPrompt(prevPd.html));
                lastParaCache.set(prev.id, previousExcerpt);
              } catch (_) { /* Vorseite fehlschlägt → kein Kontext, nicht kritisch */ }
            }
          }
          lastParaCache.set(p.id, lastParagraph(text));
        }

        const chapterName = pd.chapter_id ? (chapterNameById[String(pd.chapter_id)] || null) : null;

        const ctxSig = buildLektoratCtxSig({
          upd: pd.updated_at || '',
          text_sha: crypto.createHash('sha1').update(text).digest('hex').slice(0, 16),
          fig: batchFiguren, ort: batchOrte, bez: batchBeziehungen, mot: batchMotive,
          ep: bookSettings?.erzaehlperspektive || null,
          ez: bookSettings?.erzaehlzeit || null,
          // Buchtyp wählt das Fehlertyp-Profil → gehört in die Signatur, sonst
          // liefert der Cache nach einer Buchtyp-Umstellung das alte Typ-Set.
          bt: bookSettings?.buchtyp || null,
          sw: batchStopwords, er: batchErklaerungRule, kr: batchKorrekturRegeln,
          stp: bookSettings?.stilprofil || '',
          pe: previousExcerpt, cn: chapterName, pn: p.name, cv: cacheVersion, lc: langCode,
          bl: batchHatBelege,
        });
        const cached = loadLektoratCache(bookId, userEmail, p.id, ctxSig, effectiveProvider);

        let result;
        if (cached) {
          logger.info(`[${i + 1}/${pages.length}] «${pd.name}» page=${p.id} – Cache-HIT`);
          result = cached;
          // Re-Validate (strippt `kontext`, filtert 1:1) + Dedup auf Cached-Path.
          if (Array.isArray(result?.fehler)) {
            result.fehler = finalizeFehler(result.fehler, locale, validTypen);
          }
        } else {
          // Bei Pool>1 sind feinere Pct-Ranges pro Item nicht sinnvoll
          // (mehrere Calls schreiben gleichzeitig den Job-Progress); progress wird
          // unten aus done/total nach jedem fertigen Item gesetzt.
          result = await lektoratAnalyze({
            jobId, tok, text, local, prompts, system: SYSTEM_LEKTORAT, single: false,
            buchtyp: bookSettings?.buchtyp || null,
            fromPct: null, toPct: null,
            promptOpts: {
              stopwords: batchStopwords,
              erklaerungRule: batchErklaerungRule,
              korrekturRegeln: batchKorrekturRegeln,
              figuren: batchFiguren,
              figurenBeziehungen: batchBeziehungen,
              orte: batchOrte,
              motive: batchMotive,
              hatBelege: batchHatBelege,
              pageName: p.name,
              chapterName,
              ...narrativeLabels(bookSettings),
              previousExcerpt,
              langCode,
            },
          });

          result.fehler = finalizeFehler(result.fehler, locale, validTypen);
          saveLektoratCache(bookId, userEmail, p.id, ctxSig, result, effectiveProvider);
        }
        const fehler = result.fehler || [];
        totalErrors += fehler.length;

        const szenenBatch = Array.isArray(result?.szenen) ? result.szenen : [];
        const errorsJson = JSON.stringify(fehler);
        const lastCheck = _lastPageCheckStmt.get(p.id, userEmail || null);
        if (lastCheck && lastCheck.errors_json === errorsJson) {
          logger.info(`[${i + 1}/${pages.length}] «${pd.name}» page=${p.id}, ${fehler.length} Beanstandungen (dedup, kein neuer Eintrag)`);
        } else {
          db.prepare(`INSERT INTO page_checks
            (page_id, book_id, chapter_id, checked_at, error_count, errors_json, szenen_json, stilanalyse, fazit, model, user_email)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(p.id, parseInt(bookId), p.chapter_id || null, new Date().toISOString(),
              fehler.length, errorsJson,
              szenenBatch.length > 0 ? JSON.stringify(szenenBatch) : null,
              result.stilanalyse || null, result.fazit || null, model, userEmail || null);
          logger.info(`[${i + 1}/${pages.length}] «${pd.name}» page=${p.id}, ${fehler.length} Beanstandungen`);
        }
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        logger.warn(`[${i + 1}/${pages.length}] «${p.name}» übersprungen (page=${p.id}): ${e.message}`);
        return;
      }
      done++;
      const pct = Math.round((done / pages.length) * 95);
      updateJob(jobId, {
        progress: pct,
        statusText: 'job.phase.pageProgress',
        statusParams: { current: done, total: pages.length, name: p.name },
      });
    };

    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(concurrency, pages.length) }, async () => {
      while (true) {
        const idx = nextIndex++;
        if (idx >= pages.length) return;
        if (jobAbortControllers.get(jobId)?.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        await processPage(pages[idx], idx);
      }
    });
    await Promise.all(workers);

    completeJob(jobId, { pageCount: pages.length, done, totalErrors, tokensIn: tok.in, tokensOut: tok.out },
      tps(tok), `${done}/${pages.length} Seiten, ${totalErrors} Beanstandungen`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Fehler: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

// ── Routen ────────────────────────────────────────────────────────────────────
lektoratRouter.post('/check', jsonBody, (req, res) => {
  const { page_name } = req.body;
  const page_id = toIntId(req.body?.page_id);
  let book_id = toIntId(req.body?.book_id);
  if (!page_id) return res.status(400).json({ error_code: 'PAGE_ID_REQUIRED' });
  if (!book_id) book_id = resolvePageBookId(page_id);
  if (!book_id) return res.status(404).json({ error_code: 'BOOK_NOT_FOUND' });
  setContext({ book: book_id });
  try { requireBookAccess(req, book_id, 'lektor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }
  const userEmail = req.session?.user?.email || null;
  const userToken = null;
  const existing = findActiveJobId('check', page_id, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const label = 'job.label.checkPage';
  const labelParams = { name: page_name || `#${page_id}` };
  const jobId = createJob('check', book_id || 0, userEmail, label, labelParams, page_id);
  enqueueJob(jobId, () => runCheckJob(jobId, page_id, book_id || null, userEmail, userToken));
  res.json({ jobId });
});

lektoratRouter.post('/batch-check', jsonBody, (req, res) => {
  const { book_name } = req.body;
  const book_id = toIntId(req.body?.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: book_id });
  try { requireBookAccess(req, book_id, 'lektor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }
  const userEmail = req.session?.user?.email || null;
  const userToken = null;
  const existing = findActiveJobId('batch-check', book_id, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const label = book_name ? 'job.label.batchCheckBook' : 'job.label.batchCheck';
  const labelParams = book_name ? { name: book_name } : null;
  const jobId = createJob('batch-check', book_id, userEmail, label, labelParams);
  enqueueJob(jobId, () => runBatchCheckJob(jobId, book_id, userEmail, userToken));
  res.json({ jobId });
});

module.exports = { lektoratRouter, runCheckJob, runBatchCheckJob, dedupFehler, validateLektoratFehler, capStylisticFehler, STYLISTIC_TYPEN };
