'use strict';
// Struktur-Check journalistischer Beiträge.
//
// Prüft jeden Beitrag gegen den Soll-Katalog seiner Textsorte
// (public/js/prompts/textsorten.js) und legt das Urteil in
// `page_structure_checks` ab — ein Datensatz pro Seite, Full-Replace pro Lauf.
//
// Abgrenzung zum Lektorat: das Lektorat prüft die SPRACHE einer Textspanne und
// liefert `original`/`korrektur` zum Einsetzen. Der Struktur-Check prüft die
// FORM des ganzen Beitrags und liefert nichts zum Einsetzen — er sagt „der Lead
// beantwortet nicht, wann es passiert ist". Beides ist rückwärtsgewandt und
// schreibt nie in den Text.
//
// Delta-Skip über `content_sig`: unveränderte Beiträge mit gleicher Textsorte
// werden übersprungen. Ein Textsorten-Wechsel invalidiert (die Signatur trägt
// sie mit), ebenso eine Prompt-Änderung (PROMPTS_VERSION).

const express = require('express');
const crypto = require('crypto');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  aiCall, getPrompts, getBookPrompts,
  tps,
  createJob, enqueueJob, findActiveJobId,
  jsonBody,
  contentHttpError, htmlToTextForPrompt,
  _modelName,
} = require('./shared');
const contentStore = require('../../lib/content-store');
const { getBookSettings } = require('../../db/schema');
const { effectiveTextsorte, saveStructureCheck, getStructureCheck } = require('../../db/textsorte');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');
const { requireBookAccess, sendACLError } = require('../../lib/acl');
const { pageBookGuard, journalisticBookSettings } = require('../../lib/page-guard');
const { resolveProvider } = require('../../lib/ai');

const strukturRouter = express.Router();

// Beiträge unter dieser Länge haben keine prüfbare Form (Bildlegende, Stub).
const MIN_CHARS = 200;

function _sig(text, textsorte, cacheVersion) {
  return crypto.createHash('sha1')
    .update(`${textsorte}|${cacheVersion}|${text}`)
    .digest('hex')
    .slice(0, 24);
}

/**
 * Ergebnis des Modells gegen den Katalog abgleichen. Das Modell liefert
 * Regel-Nummern; fehlende Nummern werden ergänzt, unbekannte verworfen. Ohne
 * diesen Abgleich zeigt die Karte Lücken oder Geister-Zeilen, je nachdem wie
 * vollständig das Modell geantwortet hat.
 *
 * `vok` ist das Befund-Vokabular aus prompts/textsorten.js — dieselben Listen,
 * aus denen das Schema gebaut wird. Hereingereicht statt hier nachgebaut: eine
 * eigene Kopie würde einen neuen Status stillschweigend abwerten, obwohl das
 * Schema ihn erlaubt.
 */
function _normalizeResult(raw, regelnCount, vok) {
  const {
    STRUKTUR_STATUS, STRUKTUR_STATUS_FALLBACK, STRUKTUR_STATUS_OFFEN,
    STRUKTUR_URTEILE, W_FRAGEN,
  } = vok;
  const byNr = new Map();
  for (const e of (Array.isArray(raw?.regeln) ? raw.regeln : [])) {
    const nr = parseInt(e?.nr);
    if (!Number.isFinite(nr) || nr < 1 || nr > regelnCount || byNr.has(nr)) continue;
    const status = STRUKTUR_STATUS.includes(e?.status) ? e.status : STRUKTUR_STATUS_FALLBACK;
    byNr.set(nr, {
      nr,
      status,
      befund: String(e?.befund || '').trim(),
      // Massnahme nur dort, wo etwas zu tun ist — sonst schleppt die Karte
      // Handlungsanweisungen zu erfuellten Regeln mit.
      massnahme: STRUKTUR_STATUS_OFFEN.includes(status) ? String(e?.massnahme || '').trim() : '',
    });
  }
  const regeln = [];
  for (let nr = 1; nr <= regelnCount; nr++) {
    regeln.push(byNr.get(nr)
      || { nr, status: STRUKTUR_STATUS_FALLBACK, befund: '', massnahme: '' });
  }
  const wfragen = Array.isArray(raw?.fehlendeWFragen)
    ? raw.fehlendeWFragen.filter(w => W_FRAGEN.includes(w))
    : [];
  const gesamturteil = STRUKTUR_URTEILE.includes(raw?.gesamturteil)
    ? raw.gesamturteil
    // Kein Urteil vom Modell → aus den Einzelbefunden ableiten, statt „traegt"
    // zu unterstellen.
    : (regeln.some(r => r.status === 'fehlt') ? 'lueckenhaft' : 'traegt');
  return {
    gesamturteil,
    regeln,
    fehlendeWFragen: [...new Set(wfragen)],
    zusammenfassung: String(raw?.zusammenfassung || '').trim(),
  };
}

/**
 * @param {number|null} onlyPageId  nur diese Seite prüfen (sonst das ganze Buch)
 */
async function runStrukturJob(jobId, bookId, userEmail, userToken, onlyPageId = null) {
  const logger = makeJobLogger(jobId);
  const prompts = await getPrompts(userEmail);
  const {
    buildStrukturCheckPrompt, buildStrukturSchema, textsorte: textsorteDef,
    PROMPTS_VERSION, STRUKTUR_VOKABULAR_SIGNATUR,
  } = prompts;
  const { SYSTEM_STRUKTUR } = await getBookPrompts(bookId, userEmail);
  const effectiveProvider = resolveProvider({ userEmail });
  // Das Befund-Vokabular steckt nur im Struktur-Schema und in dieser Validierung,
  // nicht im Locale-Snapshot — es erreicht PROMPTS_VERSION also nicht. Ohne die
  // eigene Signatur laege nach einem neuen Status weiter der alte Befund neben
  // jedem Beitrag. Bewusst HIER und nicht im globalen Prompt-Hash: eine
  // Vokabular-Aenderung soll die Struktur-Befunde neu erheben, nicht die teuren
  // Lektorat- und Komplettanalyse-Caches wegwerfen.
  const cacheVersion = `${_modelName(effectiveProvider)}:${PROMPTS_VERSION || ''}:${STRUKTUR_VOKABULAR_SIGNATUR}`;

  try {
    updateJob(jobId, { statusText: 'job.phase.loadingPages', progress: 0 });
    const bookSettings = getBookSettings(bookId, userEmail);
    const allPages = await contentStore.listPages(bookId, userToken)
      .catch(e => { throw contentHttpError(e); });
    const pages = onlyPageId
      ? allPages.filter(p => String(p.id) === String(onlyPageId))
      : allPages;
    if (!pages.length) { completeJob(jobId, { empty: true }); return; }

    const chapterNameById = {};
    for (const ch of await contentStore.listChapters(bookId, userToken).catch(() => [])) {
      chapterNameById[String(ch.id)] = ch.name;
    }

    const tok = { in: 0, out: 0, ms: 0 };
    let geprueft = 0, uebersprungen = 0, ohneTextsorte = 0, zuKurz = 0;

    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      const ts = effectiveTextsorte(p.id, bookSettings);
      if (!ts) { ohneTextsorte++; continue; }
      const def = textsorteDef(ts);
      if (!def) { ohneTextsorte++; continue; }

      const pd = await contentStore.loadPage(p.id, userToken).catch(() => null);
      if (!pd) continue;
      const text = htmlToTextForPrompt(pd.html || '');
      if (text.length < MIN_CHARS) { zuKurz++; continue; }

      const sig = _sig(text, ts, cacheVersion);
      // Delta-Skip: unveraenderter Text + unveraenderte Textsorte + unveraenderter
      // Prompt-Stand → der gespeicherte Befund gilt weiter.
      if (getStructureCheck(p.id)?.content_sig === sig) { uebersprungen++; continue; }

      updateJob(jobId, {
        statusText: 'job.phase.strukturChecking',
        statusParams: { from: i + 1, total: pages.length, name: p.name || '' },
        progress: Math.round((i / pages.length) * 95),
      });

      const raw = await aiCall(jobId, tok,
        buildStrukturCheckPrompt(text, {
          textsorte: ts,
          pageName: p.name || null,
          chapterName: p.chapter_id ? (chapterNameById[String(p.chapter_id)] || null) : null,
        }),
        SYSTEM_STRUKTUR,
        null, null, 3000, 0.2, null, undefined, buildStrukturSchema(),
      );
      if (!raw || !Array.isArray(raw.regeln)) throw i18nError('job.error.strukturArrayMissing');

      const result = _normalizeResult(raw, def.regeln.length, prompts);
      saveStructureCheck(p.id, bookId, {
        textsorte: ts,
        gesamturteil: result.gesamturteil,
        result,
        contentSig: sig,
      });
      geprueft++;
    }

    logger.info(`Struktur-Check fertig: ${geprueft} geprüft, ${uebersprungen} unverändert, ${ohneTextsorte} ohne Textsorte, ${zuKurz} zu kurz.`);
    completeJob(jobId,
      { geprueft, uebersprungen, ohneTextsorte, zuKurz, tokensIn: tok.in, tokensOut: tok.out },
      tps(tok), `Struktur-Check: ${geprueft} Beiträge geprüft`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Fehler Struktur-Check Buch #${bookId}: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

strukturRouter.post('/struktur-check', jsonBody, (req, res) => {
  const page_id = toIntId(req.body?.page_id);
  let book_id;
  if (page_id) {
    // Seiten-Lauf: Buch IMMER aus der Seite ableiten, nie aus einer vom Client
    // behaupteten book_id — sonst prüfte der ACL-Guard das falsche Buch.
    const g = pageBookGuard(req, res, {
      minRole: 'editor', journalistic: true, pageId: page_id,
    });
    if (!g) return;
    book_id = g.bookId;
  } else {
    // Buch-Lauf: dasselbe Gate von Hand, weil es hier keine Seite gibt, aus der
    // sich das Buch ableiten liesse.
    book_id = toIntId(req.body?.book_id);
    if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
    setContext({ book: book_id });
    try { requireBookAccess(req, book_id, 'editor'); }
    catch (e) { if (sendACLError(res, e)) return; throw e; }
    if (!journalisticBookSettings(req, book_id)) {
      return res.status(400).json({ error_code: 'NOT_JOURNALISTIC_BOOK' });
    }
  }

  const userEmail = req.session?.user?.email || null;
  const entityId = page_id ? `p${page_id}` : String(book_id);
  const existing = findActiveJobId('struktur-check', entityId, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const jobId = createJob('struktur-check', book_id, userEmail,
    'job.label.strukturCheck', null, entityId);
  enqueueJob(jobId, () => runStrukturJob(jobId, book_id, userEmail, null, page_id || null));
  res.json({ jobId });
});

module.exports = { strukturRouter, runStrukturJob, _normalizeResult };
