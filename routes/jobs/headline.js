'use strict';
// Titel-Varianten für einen Beitrag (Titel-Werkstatt).
//
// Der einzige generative Pfad des journalistischen Apparats — und auch er
// schreibt nicht in den Text: die Vorschläge landen als Varianten neben dem
// geltenden Stand (`page_headline_variants`, Herkunft `ki`) und werden von Hand
// übernommen. Ein Titel ist eine redaktionelle Entscheidung.
//
// Ein Beitrag pro Lauf, kein Buch-weiter Modus. Titelarbeit ist Einzelstückarbeit
// — ein Stapellauf über vierzig Beiträge produziert vierzig Listen, die niemand
// durchsieht, und kostet dafür vierzig Calls.

const express = require('express');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  aiCall, getPrompts, getBookPrompts,
  tps,
  createJob, enqueueJob, findActiveJobId,
  jsonBody,
  contentHttpError, htmlToTextForPrompt,
} = require('./shared');
const contentStore = require('../../lib/content-store');
const { getBookSettings } = require('../../db/schema');
const { isJournalisticBook } = require('../../lib/buchtyp');
const { effectiveTextsorte } = require('../../db/textsorte');
const {
  HEADLINE_FIELDS, isValidHeadlineField, getHeadline, listVariants, addVariant,
} = require('../../db/headline');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');
const { requireBookAccess, sendACLError } = require('../../lib/acl');
const { resolvePageBookId } = require('../../lib/content-ownership');

const headlineRouter = express.Router();

// Kürzere Beiträge tragen keinen eigenen Titelapparat — für eine Bildlegende
// braucht niemand fünf Teaser-Varianten.
const MIN_CHARS = 200;
// Deckel je Feld und Lauf. Mehr als fünf Varianten liest niemand durch; die
// Auswahl wird dadurch nicht besser, nur länger.
const MAX_ANZAHL = 5;

/**
 * Bestand für den Prompt: geltender Stand PLUS vorhandene Varianten. Ohne das
 * liefert der zweite Lauf dieselben naheliegenden Formulierungen wie der erste.
 */
function _bestand(pageId, felder) {
  const cur = getHeadline(pageId) || {};
  const vars = listVariants(pageId);
  const out = {};
  for (const f of felder) {
    out[f] = [cur[f] || null, ...(vars[f] || []).map(v => v.text)].filter(Boolean);
  }
  return out;
}

async function runHeadlineJob(jobId, bookId, pageId, userEmail, userToken, felder, anzahl) {
  const logger = makeJobLogger(jobId);
  const prompts = await getPrompts(userEmail);
  const { buildHeadlineVariantsPrompt, buildHeadlineVariantsSchema } = prompts;
  const { SYSTEM_HEADLINE } = await getBookPrompts(bookId, userEmail);

  try {
    updateJob(jobId, { statusText: 'job.phase.loadingPages', progress: 5 });
    const pd = await contentStore.loadPage(pageId, userToken)
      .catch(e => { throw contentHttpError(e); });
    const text = htmlToTextForPrompt(pd?.html || '');
    if (text.length < MIN_CHARS) {
      completeJob(jobId, { zuKurz: true, angelegt: 0 });
      return;
    }

    const bookSettings = getBookSettings(bookId, userEmail);
    const ts = effectiveTextsorte(pageId, bookSettings);

    updateJob(jobId, { statusText: 'job.phase.headlineDrafting', progress: 20 });
    const tok = { in: 0, out: 0, ms: 0 };
    const raw = await aiCall(jobId, tok,
      buildHeadlineVariantsPrompt(text, {
        felder, anzahl, textsorte: ts, bestand: _bestand(pageId, felder),
      }),
      SYSTEM_HEADLINE,
      null, null, 2000, 0.8, null, undefined, buildHeadlineVariantsSchema({ felder }),
    );
    if (!raw || !Array.isArray(raw.varianten)) throw i18nError('job.error.headlineArrayMissing');

    // Was das Modell ausserhalb der angeforderten Felder liefert, faellt weg —
    // sonst legt ein Lauf „nur Titel" nebenbei Teaser an, die niemand wollte.
    let angelegt = 0, verworfen = 0;
    for (const v of raw.varianten) {
      if (!felder.includes(v?.feld)) { verworfen++; continue; }
      const row = addVariant(pageId, bookId, {
        feld: v.feld, text: v.text, herkunft: 'ki', userEmail,
      });
      if (row) angelegt++; else verworfen++;
    }

    updateJob(jobId, { progress: 95 });
    logger.info(`Titel-Varianten fertig: ${angelegt} angelegt, ${verworfen} verworfen (Felder: ${felder.join(',')}).`);
    completeJob(jobId,
      { angelegt, verworfen, felder, varianten: listVariants(pageId), tokensIn: tok.in, tokensOut: tok.out },
      tps(tok), `Titel-Werkstatt: ${angelegt} Varianten`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Fehler Titel-Varianten Seite #${pageId}: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

headlineRouter.post('/headline-variants', jsonBody, (req, res) => {
  const page_id = toIntId(req.body?.page_id);
  if (!page_id) return res.status(400).json({ error_code: 'PAGE_ID_REQUIRED' });
  // Buch IMMER aus der Seite ableiten, nie aus einer behaupteten book_id.
  const book_id = resolvePageBookId(page_id);
  if (!book_id) return res.status(404).json({ error_code: 'PAGE_NOT_FOUND' });
  setContext({ book: book_id });
  try { requireBookAccess(req, book_id, 'editor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }

  const userEmail = req.session?.user?.email || null;
  if (!isJournalisticBook(getBookSettings(book_id, userEmail))) {
    return res.status(400).json({ error_code: 'NOT_JOURNALISTIC_BOOK' });
  }

  const felder = Array.isArray(req.body?.felder)
    ? req.body.felder.filter(isValidHeadlineField)
    : HEADLINE_FIELDS.slice();
  if (!felder.length) {
    return res.status(400).json({ error_code: 'INVALID_VALUE', params: { field: 'felder' } });
  }
  const anzahl = Math.min(MAX_ANZAHL, Math.max(1, parseInt(req.body?.anzahl) || 4));

  const entityId = `p${page_id}`;
  const existing = findActiveJobId('headline-variants', entityId, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const jobId = createJob('headline-variants', book_id, userEmail,
    'job.label.headlineVariants', null, entityId);
  enqueueJob(jobId, () => runHeadlineJob(jobId, book_id, page_id, userEmail, null, felder, anzahl));
  res.json({ jobId });
});

module.exports = { headlineRouter, runHeadlineJob };
