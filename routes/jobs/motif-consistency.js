'use strict';
// Motiv-Werkstatt: Consistency-Job (KI-Schicht ueber der Messung).
//
// Zwei Schichten, deren Trennung der Sinn des Features ist:
//   1. lib/motif-consistency.js rechnet deterministisch, was rechenbar ist
//      (Kanten gegen Ist-Verteilung) — kein Modell, keine Kosten, laeuft mit
//      jedem Board-Load ueber GET /motifs/consistency.
//   2. Dieser Job urteilt ueber das, was sich NICHT messen laesst: traegt eine
//      behauptete Beziehung in den Belegstellen? Meinen zwei Motive dasselbe?
//      Greifen die trigger_terms daneben?
// Die Messbefunde gehen als VORBEFUND in den Prompt („verwenden, nicht
// wiederholen") — dieselbe Rahmung wie der Struktur-Check in der Buchbewertung.
//
// Rein rueckwaertsgewandt: liest Katalog + Ist-Index, schreibt NIE in den
// Buchtext und NIE in den Katalog. Ergebnis ist ein Befund fuer die Autorin.

const express = require('express');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  createJob, enqueueJob, findActiveJobId, jsonBody, jobAbortControllers,
  aiCall, getPrompts, getBookPrompts, loadOrderedBookContents,
  tps, _modelName,
} = require('./shared');
const motifsDb = require('../../db/motifs');
const { getBookSettings } = require('../../db/schema');
const { computeMotifFindings } = require('../../lib/motif-consistency');
const { tServerParams } = require('../../lib/i18n-server');
const appSettings = require('../../lib/app-settings');
const { resolveProvider } = require('../../lib/ai');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');
const { requireBookAccess, sendACLError, sessionEmail } = require('../../lib/acl');

const SEVERITY = ['kritisch', 'stark', 'mittel', 'schwach', 'niedrig'];

// Belegstellen pro Motiv. Wenige und starke: listOccurrences liefert nach Score
// sortiert, die ersten sind die tragfaehigsten. Der Deckel haelt den Prompt klein —
// drei wortgetreue Stellen sagen ueber ein Motiv mehr als dreissig.
const BELEGE_PRO_MOTIV = 3;
const BELEG_MAX_CHARS = 240;

function _belegeFor(motifs, floor) {
  const belege = {};
  for (const m of motifs) {
    if (!m.occurrenceCount) continue;
    const rows = motifsDb.listOccurrences(m.id, floor).slice(0, BELEGE_PRO_MOTIV);
    const clean = rows
      .map(r => ({
        kapitel: r.chapter_name || null,
        snippet: String(r.snippet || '').replace(/\s+/g, ' ').trim().slice(0, BELEG_MAX_CHARS),
      }))
      .filter(r => r.snippet);
    if (clean.length) belege[m.id] = clean;
  }
  return belege;
}

// Sprungziel je Motiv: die staerkste Fundstelle mit einer Seite. Deterministisch
// aus dem Index gebaut, NICHT aus dem Modelltext — ein Befund soll an eine echte
// Stelle springen, und ein halluziniertes Sprungziel faellt niemandem auf.
function _belegZiele(motifs, floor) {
  const ziele = {};
  for (const m of motifs) {
    if (!m.occurrenceCount) continue;
    const row = motifsDb.listOccurrences(m.id, floor)
      .find(r => r.page_id || r.scene_page_id);
    if (row) {
      ziele[m.id] = {
        page_id: row.page_id || row.scene_page_id,
        page_name: row.page_name || null,
      };
    }
  }
  return ziele;
}

const _norm = (s) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');

async function runMotifConsistencyJob(jobId, bookId, userEmail) {
  const logger = makeJobLogger(jobId);
  const prompts = await getPrompts(userEmail);
  const { buildMotivSystemPrompt, buildMotivConsistencyPrompt, SCHEMA_MOTIV_CONSISTENCY } = prompts;
  try {
    const provider = resolveProvider({ userEmail });

    // Score-Floor wie die Konstellation (routes/motifs.js#_motifFloor): die KI muss
    // ueber DIESELBEN Zahlen urteilen, die die Autorin im Graph sieht — sonst meldet
    // sie eine Luecke, die auf dem Bildschirm keine ist.
    const floor = Number(appSettings.get('motif.scan.min_score')) || 0;

    updateJob(jobId, { statusText: 'job.phase.motivConsistencyCollect', progress: 5 });
    const graph = motifsDb.getGraph(bookId, userEmail, floor);
    if (!graph.motifs.length) throw i18nError('job.error.motivKatalogLeer');

    // Kapitel in echter Buchorganizer-Reihenfolge (ueber die Content-Store-Facade).
    const { chaptersFlat } = await loadOrderedBookContents(bookId, null);
    const kapitel = (chaptersFlat || []).map(c => ({ id: c.id, name: c.name }));

    // Ist der Index ueberhaupt befuellt? Ungescannt heisst ungeprueft, nicht
    // abwesend — der Prompt bekommt das ausdruecklich gesagt, sonst meldet das
    // Modell fuer jedes Motiv „kommt im Text nicht vor".
    const scanned = motifsDb.hasOccurrences(bookId, userEmail);

    // Deterministische Vorbefunde, in der Buchsprache gerendert. Der Server
    // uebersetzt hier ausnahmsweise selbst: der Text geht in den Prompt, nicht an
    // einen Betrachter — die Locale ist die des Buchs, nicht die des Browsers.
    const settings = getBookSettings(bookId, userEmail);
    const locale = settings?.language || 'de';
    const messbefunde = computeMotifFindings({
      motifs: graph.motifs, relations: graph.relations,
      chapterOrder: kapitel.map(k => k.id), scanned,
    });
    const vorbefunde = messbefunde.map(f => tServerParams(`motiv.check.${f.code}`, {
      motiv: f.motiv || '', partner: f.partner || '',
      typ: f.typ ? tServerParams(`motiv.relation.type.${f.typ}`, null, locale) : '',
      ...(f.params || {}),
    }, locale));

    const belege = _belegeFor(graph.motifs, floor);
    const { BUCH_KONTEXT } = await getBookPrompts(bookId, userEmail);

    logger.info(`Motiv-Consistency Start: book=${bookId} motive=${graph.motifs.length} themen=${graph.themes.length} kanten=${graph.relations.length} kapitel=${kapitel.length} belege=${Object.keys(belege).length} vorbefunde=${vorbefunde.length} gescannt=${scanned}`);
    updateJob(jobId, { statusText: 'job.phase.motivConsistencyAi', progress: 12 });

    const tok = { in: 0, out: 0, ms: 0 };
    const result = await aiCall(jobId, tok,
      buildMotivConsistencyPrompt(
        graph.themes, graph.motifs, graph.relations, kapitel, belege,
        vorbefunde, BUCH_KONTEXT, { scanned },
      ),
      buildMotivSystemPrompt(),
      12, 95, 4000, 0.3, 8000, undefined, SCHEMA_MOTIV_CONSISTENCY,
    );

    if (!Array.isArray(result?.konflikte)) throw i18nError('job.error.motivKonflikteMissing');
    if (typeof result.fazit !== 'string') throw i18nError('job.error.motivFazitMissing');

    // Modell-Output aufs eigene Motiv-Subset validieren: die ID aus dem [#…]-Marker
    // gilt nur, wenn es sie in diesem Buch gibt; sonst ueber den Namen aufloesen
    // (Modelle, die den Marker nicht zurueckgeben) — und sonst uebergreifend.
    const validIds = new Set(graph.motifs.map(m => m.id));
    const idByName = new Map(graph.motifs.map(m => [_norm(m.name), m.id]));
    const ziele = _belegZiele(graph.motifs, floor);

    const konflikte = result.konflikte
      .filter(k => k && typeof k.problem === 'string' && k.problem.trim())
      .map(k => {
        const motiv = typeof k.motiv === 'string' && k.motiv.trim() ? k.motiv.trim() : '—';
        const rawId = k.motiv_id != null ? parseInt(k.motiv_id) : null;
        let motivId = Number.isInteger(rawId) && validIds.has(rawId) ? rawId : null;
        if (motivId == null && motiv !== '—') {
          const byName = idByName.get(_norm(motiv));
          if (byName != null) motivId = byName;
        }
        return {
          motiv,
          motiv_id: motivId,
          quelle: 'ki',
          schwere: SEVERITY.includes(k.schwere) ? k.schwere : 'mittel',
          problem: k.problem.trim(),
          vorschlag: typeof k.vorschlag === 'string' ? k.vorschlag.trim() : '',
          fundstelle: (motivId != null ? ziele[motivId] : null) || null,
        };
      });
    const fazit = result.fazit.trim();

    // Lauf historisieren (best-effort — ein DB-Fehler darf das Ergebnis nicht
    // verschlucken). runId geht in den Payload, damit das Frontend den frischen
    // Lauf ohne Round-Trip als ausgewaehlt markieren kann.
    let runId = null;
    try {
      runId = motifsDb.insertConsistencyRun({
        bookId, userEmail, konfliktCount: konflikte.length,
        result: { konflikte, fazit, scanned }, model: _modelName(provider),
      });
    } catch (e) {
      logger.warn(`Motiv-Consistency-Run-Insert fehlgeschlagen book=${bookId}: ${e.message}`);
    }

    completeJob(jobId, { konflikte, fazit, scanned, runId, tokensIn: tok.in, tokensOut: tok.out },
      tps(tok), `${konflikte.length} Befunde`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Motiv-Consistency Fehler book=${bookId}: ${e.message}`, { stack: e.cause?.stack || e.stack });
    failJob(jobId, e);
  }
}

const motifConsistencyRouter = express.Router();

motifConsistencyRouter.post('/motif-consistency', jsonBody, (req, res) => {
  const book_id = toIntId(req.body?.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: book_id });
  try { requireBookAccess(req, book_id, 'lektor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }
  const userEmail = sessionEmail(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const existing = findActiveJobId('motif-consistency', book_id, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const jobId = createJob('motif-consistency', book_id, userEmail, 'job.label.motivConsistency', null, book_id);
  enqueueJob(jobId, () => runMotifConsistencyJob(jobId, book_id, userEmail));
  res.json({ jobId });
});

module.exports = { motifConsistencyRouter, runMotifConsistencyJob };
