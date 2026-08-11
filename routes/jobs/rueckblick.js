'use strict';
// Tagebuch-Rückblick: rückwärtsgewandte KI-Verdichtung datierter Einträge eines
// Zeitraums (Monat 'YYYY-MM' oder Jahr 'YYYY'). Liest nur, schreibt NIE in den
// Buchtext (App-Philosophie). Single-Pass über alle Einträge; Map-Reduce über
// Monate, wenn der Zeitraum das Input-Budget sprengt. Endergebnis-Cache pro
// (Buch, User, Zeitraum, Provider). Vorlage: routes/jobs/review.js.
const express = require('express');
const {
  db,
  loadRueckblickCache, saveRueckblickCache, insertRueckblick, latestRueckblickJson,
  touchRueckblickEntryCount,
} = require('../../db/schema');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError, contentHttpError,
  aiCall, getPrompts, getBookPrompts,
  loadOrderedBookContents, loadPageContents,
  chunkLimitsFor, BATCH_SIZE, jobAbortControllers,
  _modelName, tps, getFiguren,
  createJob, enqueueJob, findActiveJobId,
  jsonBody,
} = require('./shared');
const { parseZeitraum: _parseZeitraum, entryDate: _entryDate, matchesZeitraum: _matchesZeitraum, previousZeitraum: _previousZeitraum } = require('./rueckblick-dates');
const crypto = require('crypto');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');
const { sessionEmail } = require('../../lib/acl');

const rueckblickRouter = express.Router();

// Teilt die (nach Datum sortierten) Einträge in Map-Gruppen für den Reduce-Pass.
// Deckt ein Jahres-Zeitraum mehrere Monate ab, ist jede Gruppe ein Monat. Fällt
// alles in einen Monat (Monats-Zeitraum oder Jahr mit nur einem belegten Monat),
// werden die Einträge größenbasiert gechunkt — so bleibt auch ein einzelner
// überlanger Monat unter dem Per-Chunk-Budget (byMonth.size == 1 → kein Split).
// Ein für sich zu großer Einzeleintrag bildet notfalls eine eigene Gruppe.
function _chunkGroups(entries, z, perChunkLimit) {
  const byMonth = new Map();
  for (const e of entries) {
    const key = e.monthKey || String(z.year);
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(e);
  }
  if (byMonth.size > 1) {
    return [...byMonth.keys()].sort().map(key => ({ label: key, entries: byMonth.get(key) }));
  }
  const groups = [];
  let cur = [], curChars = 0;
  for (const e of entries) {
    const len = e.text.length;
    if (cur.length && curChars + len > perChunkLimit) { groups.push(cur); cur = []; curChars = 0; }
    cur.push(e); curChars += len;
  }
  if (cur.length) groups.push(cur);
  return groups.map(es => ({
    label: es.length === 1 ? es[0].datum : `${es[0].datum}…${es[es.length - 1].datum}`,
    entries: es,
  }));
}

// ── Job: Tagebuch-Rückblick ─────────────────────────────────────────────────────
async function runRueckblickJob(jobId, bookId, userEmail, userToken, zeitraum) {
  const logger = makeJobLogger(jobId);
  const z = _parseZeitraum(zeitraum);
  const bookIdInt = parseInt(bookId);
  const email = userEmail || '';
  try {
    if (!z) throw i18nError('job.error.rueckblickEmpty');
    const prompts = await getPrompts(userEmail);
    const {
      buildRueckblickPrompt, buildRueckblickReducePrompt, mergeRueckblickFacets,
      SCHEMA_RUECKBLICK, SCHEMA_RUECKBLICK_SYNTH, PROMPTS_VERSION,
    } = prompts;
    const { SYSTEM_RUECKBLICK_BLOCKS: SYSTEM_RUECKBLICK } = await getBookPrompts(bookId, userEmail);

    const { resolveProvider } = require('../../lib/ai');
    const effectiveProvider = resolveProvider({ userEmail });
    const { singlePass: SINGLE_PASS_LIMIT, perChunk: PER_CHUNK_LIMIT } = chunkLimitsFor(effectiveProvider);
    const cacheVersion = `${_modelName(effectiveProvider)}:${PROMPTS_VERSION || ''}`;

    // Optionaler Entitäts-Kontext (verbessert Personen-/Orts-Verknüpfung, kein Muss).
    // Pro Entität Name + kompakte Info (Rolle/Beruf/Alias bzw. Typ/Land) — hilft
    // dem Modell, Erwähnungen korrekt der kanonischen Schreibweise zuzuordnen.
    const ENTITY_CAP = 80;
    let figuren = [], orte = [];
    try {
      const allFig = (getFiguren(bookIdInt, email) || []).filter(f => f.name);
      const allOrt = db.prepare('SELECT name, typ, land FROM locations WHERE book_id = ? AND user_email = ?')
        .all(bookIdInt, email).filter(r => r.name);
      if (allFig.length > ENTITY_CAP) logger.info(`Entitäts-Kontext: ${allFig.length - ENTITY_CAP} von ${allFig.length} Figuren abgeschnitten (Cap ${ENTITY_CAP}).`);
      if (allOrt.length > ENTITY_CAP) logger.info(`Entitäts-Kontext: ${allOrt.length - ENTITY_CAP} von ${allOrt.length} Orten abgeschnitten (Cap ${ENTITY_CAP}).`);
      figuren = allFig.slice(0, ENTITY_CAP).map(f => {
        const info = [f.typ, f.beruf, (f.kurzname && f.kurzname !== f.name) ? `auch: ${f.kurzname}` : null]
          .filter(Boolean).join(', ');
        return { name: f.name, info };
      });
      orte = allOrt.slice(0, ENTITY_CAP).map(r => ({ name: r.name, info: [r.typ, r.land].filter(Boolean).join(', ') }));
    } catch (e) { logger.warn(`Entitäts-Kontext übersprungen: ${e.message}`); }

    // Vorangegangener Rückblick (Vor-Monat bzw. Vorjahr), falls vorhanden — gibt
    // dem Modell Kontext für Entwicklungen über die Zeit. Nur verdichtet (ohne
    // Belege), keine Faktenübernahme (Constraint im Prompt).
    let vorblick = null, vorblickSig = '';
    try {
      const prevZeitraum = _previousZeitraum(zeitraum);
      const prevJson = prevZeitraum ? latestRueckblickJson(bookIdInt, email, prevZeitraum) : null;
      if (prevJson) {
        vorblick = { zeitraum: prevZeitraum, result: JSON.parse(prevJson) };
        vorblickSig = `${prevZeitraum}:${crypto.createHash('sha1').update(prevJson).digest('hex').slice(0, 12)}`;
      }
    } catch (e) { logger.warn(`Vorblick-Kontext übersprungen: ${e.message}`); }

    updateJob(jobId, { statusText: 'job.phase.loadingPages', progress: 0 });
    const { chMap, pages } = await loadOrderedBookContents(bookId, userToken)
      .catch(e => { throw contentHttpError(e); });

    // Vorfilter auf den Zeitraum anhand des Seitennamens (Datum) — spart das Laden
    // des ganzen Buchs. Nur datierte Seiten im gewählten Zeitraum werden geladen.
    const datedPages = pages.filter(p => _matchesZeitraum(_entryDate(p.name), z));
    if (!datedPages.length) { completeJob(jobId, { empty: true, zeitraum }); return; }

    const tok = { in: 0, out: 0, ms: 0 };
    logger.info(`Start Rückblick «${zeitraum}»: ${datedPages.length} datierte Einträge`);
    const pageContents = await loadPageContents(datedPages, chMap, 1, (i, total) => {
      updateJob(jobId, {
        progress: Math.round((i / total) * 50),
        statusText: 'job.phase.readingPages',
        statusParams: { from: i + 1, to: Math.min(i + BATCH_SIZE, total), total },
      });
    }, userToken, jobAbortControllers.get(jobId)?.signal);

    if (!pageContents.length) { completeJob(jobId, { empty: true, zeitraum }); return; }

    // Einträge mit normalisiertem Datum + nach Datum sortiert.
    const entries = pageContents
      .map(p => {
        const ed = _entryDate(p.title);
        return { datum: ed?.iso || p.title, titel: p.title, text: p.text, monthKey: ed?.monthKey || null, id: p.id, updated_at: p.updated_at };
      })
      .sort((a, b) => a.datum.localeCompare(b.datum));

    // vorblickSig fliesst in den Cache-Key: wird der Vor-Zeitraum neu generiert,
    // ändert sich dieser Rückblick (Entwicklungs-Kontext) → Cache-Miss erzwingen.
    const pagesSig = entries.map(e => `${e.id}:${e.updated_at || ''}`).sort().join('|') + `||${zeitraum}||${cacheVersion}||${vorblickSig}`;
    let r = loadRueckblickCache(bookIdInt, email, zeitraum, pagesSig, effectiveProvider);
    const fromCache = !!r;

    if (fromCache) {
      logger.info('Rückblick – Cache-HIT (pages_sig match) – spart KI-Call.');
      updateJob(jobId, { progress: 97, statusText: 'job.phase.checkpointLoaded' });
    } else {
      const totalChars = entries.reduce((s, e) => s + e.text.length, 0);

      if (totalChars <= SINGLE_PASS_LIMIT) {
        updateJob(jobId, { progress: 55, statusText: 'job.phase.rueckblickConsolidating' });
        r = await aiCall(jobId, tok,
          buildRueckblickPrompt(entries, { zeitraum, figuren, orte, vorblick }),
          SYSTEM_RUECKBLICK, 55, 97, 3000, 0.25, null, effectiveProvider, SCHEMA_RUECKBLICK,
        );
      } else {
        // Über Budget → Map-Reduce. Bevorzugt an Monatsgrenzen (Jahres-Zeitraum);
        // bei einem einzelnen überlangen Monat greift Größen-Chunking, damit der
        // Call nie das Input-Budget sprengt (byMonth.size == 1 → kein Monats-Split).
        const groups = _chunkGroups(entries, z, PER_CHUNK_LIMIT);
        logger.info(`Rückblick «${zeitraum}»: ${totalChars} Zeichen > Budget → Map-Reduce über ${groups.length} Gruppe(n).`);
        const partResults = [];
        for (let gi = 0; gi < groups.length; gi++) {
          if (jobAbortControllers.get(jobId)?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
          const g = groups[gi];
          const fromPct = 55 + Math.round((gi / groups.length) * 30);
          const toPct = 55 + Math.round(((gi + 1) / groups.length) * 30);
          updateJob(jobId, {
            progress: fromPct, statusText: 'job.phase.rueckblickAnalyzingMonth',
            statusParams: { monat: g.label, current: gi + 1, total: groups.length },
          });
          // Vorblick bewusst NICHT an die Teil-Calls — der Entwicklungs-Kontext
          // gehört in den Reduce, sonst bläht er jeden Teil-Call auf.
          const mr = await aiCall(jobId, tok,
            buildRueckblickPrompt(g.entries, { zeitraum: g.label, figuren, orte }),
            SYSTEM_RUECKBLICK, fromPct, toPct, 2000, 0.25, null, effectiveProvider, SCHEMA_RUECKBLICK,
          );
          partResults.push({ ...mr, monat: g.label });
        }
        updateJob(jobId, { progress: 88, statusText: 'job.phase.rueckblickConsolidating' });
        // Facetten deterministisch mergen (kein KI-Zählen), Synthese-Call liefert
        // nur bemerkenswerteTage + zusammenfassung.
        const merged = mergeRueckblickFacets(partResults);
        const synth = await aiCall(jobId, tok,
          buildRueckblickReducePrompt(partResults, { zeitraum, vorblick, merged }),
          SYSTEM_RUECKBLICK, 88, 97, 3000, 0.25, null, effectiveProvider, SCHEMA_RUECKBLICK_SYNTH,
        );
        r = {
          ...merged,
          bemerkenswerteTage: Array.isArray(synth?.bemerkenswerteTage) ? synth.bemerkenswerteTage : [],
          zusammenfassung: typeof synth?.zusammenfassung === 'string' ? synth.zusammenfassung : '',
        };
      }

      if (!r || typeof r.zusammenfassung !== 'string' || !r.zusammenfassung.trim()) {
        throw i18nError('job.error.rueckblickEmpty');
      }
      saveRueckblickCache(bookIdInt, email, zeitraum, pagesSig, r, effectiveProvider);
    }

    // History-Zeile nur bei inhaltlich neuem Ergebnis → re-öffenbar. Identische
    // Re-Runs / Cache-HITs (gleicher Zeitraum, gleiches result_json) erzeugen
    // keine Duplikat-Zeile — aktualisieren aber den entry_count-Snapshot der
    // jüngsten Zeile, damit die Client-Neugenerierungs-Sperre nach einem reinen
    // Lösch-Vorgang (Zusammenfassung unverändert, Eintrag aber weg) wieder greift
    // statt dauerhaft „nicht aktuell" anzuzeigen.
    const model = _modelName(effectiveProvider);
    if (JSON.stringify(r) !== latestRueckblickJson(bookIdInt, email, zeitraum)) {
      insertRueckblick(bookIdInt, email, zeitraum, r, model, entries.length);
    } else {
      touchRueckblickEntryCount(bookIdInt, email, zeitraum, entries.length);
    }

    completeJob(jobId, { rueckblick: r, zeitraum, entryCount: entries.length, fromCache, tokensIn: tok.in, tokensOut: tok.out },
      fromCache ? null : tps(tok), `«${zeitraum}» ${entries.length} Einträge${fromCache ? ' (Cache)' : ''}`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Fehler: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

// ── Route ─────────────────────────────────────────────────────────────────────
rueckblickRouter.post('/rueckblick', jsonBody, (req, res) => {
  const book_id = toIntId(req.body?.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  const zeitraum = String(req.body?.zeitraum || '').trim();
  if (!_parseZeitraum(zeitraum)) return res.status(400).json({ error_code: 'ZEITRAUM_REQUIRED' });
  setContext({ book: book_id });
  const { requireBookAccess, sendACLError } = require('../../lib/acl');
  try { requireBookAccess(req, book_id, 'editor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }
  const userEmail = sessionEmail(req);
  // dedupId mischt den Zeitraum ein, damit Monat ≠ Jahr nicht gegeneinander dedupen.
  const dedupId = `${book_id}:${zeitraum}`;
  const existing = findActiveJobId('rueckblick', dedupId, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const jobId = createJob('rueckblick', book_id, userEmail, 'job.label.rueckblick', { zeitraum }, dedupId);
  enqueueJob(jobId, () => runRueckblickJob(jobId, book_id, userEmail, null, zeitraum));
  res.json({ jobId });
});

module.exports = { rueckblickRouter, runRueckblickJob };
