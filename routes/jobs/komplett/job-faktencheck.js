'use strict';
// Weltfakten-Realitätscheck (eigenständiger Job): prüft die extrahierten Welt-Fakten
// eines Buchs gegen die REALE Faktenlage — mit Anthropics serverseitigem `web_search`
// als Grundlage (nicht Modellgedächtnis). Anders als der Anachronismus-Check (nur
// Zeitpunkt) urteilt er über die inhaltliche Korrektheit einer Tatsachenbehauptung.
//
// Bewusst getrennt vom Kontinuitäts-Job: (a) teuer (eine Web-Suche je Kandidat) → opt-in
// pro Klick statt in jeder Komplettanalyse; (b) gated auf book_settings.weltfakten_real_pruefen
// (bei bewusst fiktiven Welten sinnlos) UND ai.komplett.factcheck (Instanz-Kill-Switch);
// (c) Claude-only (web_search ist ein Anthropic-Server-Tool).
//
// Rein rückwärtsgewandt: liest world_facts/chapters/figures, schreibt NIE Buchtext.
// Befunde landen als typ='faktenfehler' in continuity_issues (mit Beleg-URL in `quelle`)
// und erscheinen so in der bestehenden Kontinuitäts-Karte.
const {
  db,
  getBookSettings, saveFaktencheckIssues,
} = require('../../../db/schema');
const {
  makeJobLogger, updateJob, completeJob, failJob,
  getPrompts,
  jobAbortControllers, settledAll, tps,
} = require('../shared');
const { callAIWithTools, parseJSON } = require('../../../lib/ai');
const appSettings = require('../../../lib/app-settings');
const { setContext } = require('../../../lib/log-context');
const { makePhaseTimer } = require('./utils');
const { _komplettAiOverrides } = require('./job-shared');

// Modellname für den Cost-Ledger / Check-Zeile (parallel zu _modelName in remap.js).
function _factcheckModelName(provider) {
  if (provider === 'ollama') return appSettings.get('ai.ollama.model') || 'llama3.2';
  if (provider === 'openai-compat') return appSettings.get('ai.openai-compat.model') || 'llama3.2';
  return appSettings.get('ai.claude.model.komplett') || appSettings.get('ai.claude.model') || 'claude-sonnet-4-6';
}

// Anthropics serverseitiges Web-Such-Tool (dieselbe Version wie im Recherche-Chat).
// max_uses moderat je Kandidat — meist reicht 1–2 Suchen, um ein Datum/eine Angabe zu belegen.
const WEB_SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 4 };

// Nur welt-externe, überprüfbare Kategorien. figur/objekt/organisation/regel/soziolekt/zeit
// sind entweder fiktions-intern oder keine prüfbaren Tatsachenbehauptungen über die reale Welt.
const FACTCHECK_CATEGORIES = ['historie', 'ereignis', 'technik', 'kultur', 'ort'];
const _FACTCHECK_CANDIDATE_CAP = 20;
// Server-Tool-Turns, die die API pausiert (langlaufende Suche) → begrenzte Fortsetzung.
const _MAX_JUDGE_TURNS = 3;

/** Globale Erzählzeit-Spanne (aus dem konsolidierten Zeitstrahl, Fallback figure_events) —
 *  optionaler Kontext-Hinweis für den Judge (Wissensstand der Erzählzeit). null, wenn keine
 *  sicher datierten Ereignisse vorliegen. Unabhängig von zeitlinie_real (nur ein Hinweis). */
function _narrativeYearSpan(bookIdInt, email) {
  const hasZeitstrahl = !!db.prepare(
    'SELECT 1 FROM zeitstrahl_events WHERE book_id = ? AND user_email IS ? LIMIT 1'
  ).get(bookIdInt, email);
  const row = hasZeitstrahl
    ? db.prepare(`SELECT MIN(datum_year) AS minY, MAX(COALESCE(datum_ende_year, datum_year)) AS maxY
                    FROM zeitstrahl_events WHERE book_id = ? AND user_email IS ? AND datum_unsicher = 0 AND datum_year IS NOT NULL`).get(bookIdInt, email)
    : db.prepare(`SELECT MIN(fe.datum_year) AS minY, MAX(COALESCE(fe.datum_ende_year, fe.datum_year)) AS maxY
                    FROM figure_events fe JOIN figures f ON f.id = fe.figure_id
                   WHERE f.book_id = ? AND f.user_email IS ? AND fe.datum_unsicher = 0 AND fe.datum_year IS NOT NULL`).get(bookIdInt, email);
  if (!row || row.minY == null) return null;
  return row.minY === row.maxY ? String(row.minY) : `${row.minY}–${row.maxY}`;
}

/** Deterministische Kandidatenliste (KEIN KI-Call). Leer, wenn das Opt-in-Flag aus ist —
 *  dann entfällt der ganze Job. Jeder Kandidat trägt seine Kapitel-Namen (aus
 *  world_fact_chapters → chapters) für die Kontinuitäts-Verlinkung. Auf _FACTCHECK_CANDIDATE_CAP
 *  gedeckelt (Web-Suche ist teuer); Überhang wird als Warnung gemeldet. */
function buildFactCheckCandidates(bookIdInt, email) {
  const { weltfakten_real_pruefen } = getBookSettings(bookIdInt, email);
  if (!weltfakten_real_pruefen) return { candidates: [], total: 0 };
  const rows = db.prepare(`
    SELECT wf.id, wf.kategorie, wf.subjekt, wf.fakt, c.chapter_name
      FROM world_facts wf
      LEFT JOIN world_fact_chapters wfc ON wfc.fact_id = wf.id
      LEFT JOIN chapters c ON c.chapter_id = wfc.chapter_id
     WHERE wf.book_id = ? AND wf.user_email IS ?
       AND wf.kategorie IN (${FACTCHECK_CATEGORIES.map(() => '?').join(',')})
     ORDER BY wf.sort_order, wf.id
  `).all(bookIdInt, email, ...FACTCHECK_CATEGORIES);
  // Bridge-Zeilen (1 je Kapitel) zu einem Kandidaten je Fakt gruppieren.
  const byId = new Map();
  for (const r of rows) {
    let e = byId.get(r.id);
    if (!e) { e = { id: r.id, kategorie: r.kategorie, subjekt: r.subjekt || '', fakt: r.fakt || '', kapitel: [] }; byId.set(r.id, e); }
    if (r.chapter_name && !e.kapitel.includes(r.chapter_name)) e.kapitel.push(r.chapter_name);
  }
  const all = [...byId.values()].filter(c => c.fakt.trim());
  return { candidates: all.slice(0, _FACTCHECK_CANDIDATE_CAP), total: all.length };
}

// Ein Judge-Call mit Web-Suche. Server-Tool-Turns können pausieren (`pause_turn`) → begrenzt
// fortsetzen. Gibt den finalen Text zurück (JSON, ggf. mit Zitat-Prosa davor → parseJSON-Fallback).
async function _judgeOneFact(tok, userPrompt, systemPrompt, signal) {
  let messages = [{ role: 'user', content: userPrompt }];
  let text = '';
  for (let turn = 0; turn < _MAX_JUDGE_TURNS; turn++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const r = await callAIWithTools(messages, systemPrompt, [WEB_SEARCH_TOOL], null, null, signal, 'claude');
    tok.in += r.tokensIn || 0;
    tok.out += r.tokensOut || 0;
    if (r.text) text = r.text;
    if (r.stopReason === 'pause_turn') {
      messages.push({ role: 'assistant', content: r.rawContentBlocks });
      continue;
    }
    break;
  }
  return text;
}

async function runFaktencheckJob(jobId, bookId, bookName, userEmail, userToken, provider = undefined) {
  const bookIdInt = parseInt(bookId);
  const email = userEmail || null;
  const log = makeJobLogger(jobId);
  const pt = makePhaseTimer(log);
  const effectiveProvider = provider || appSettings.get('ai.provider') || 'claude';
  const overrides = _komplettAiOverrides(effectiveProvider);
  if (overrides) setContext(overrides);

  try {
    const prompts = await getPrompts(userEmail);
    // Judge nutzt einen schlanken statischen System-Prompt (der Fakt steht vollständig
    // im User-Prompt) — bewusst NICHT der teure SYSTEM_KONTINUITAET_BLOCKS mit
    // eingebettetem Buchtext.
    const systemPrompt = prompts.SYSTEM_FAKTENCHECK;

    updateJob(jobId, { statusText: 'job.phase.factcheckCandidates', progress: 5 });
    const { candidates, total } = buildFactCheckCandidates(bookIdInt, email);
    const warnings = [];
    if (total > candidates.length) {
      warnings.push({ key: 'job.warn.factcheckCapped', params: { checked: candidates.length, total } });
      log.info(`Faktencheck: ${candidates.length}/${total} Welt-Fakten geprüft (Cap ${_FACTCHECK_CANDIDATE_CAP}).`);
    }
    if (!candidates.length) {
      completeJob(jobId, { count: 0, issues: [], zusammenfassung: '', warnings, tokensIn: 0, tokensOut: 0 }, null, '0 Kandidaten');
      return;
    }

    const spanne = _narrativeYearSpan(bookIdInt, email);
    // Auflösungs-Maps für saveFaktencheckIssues (Kapitel-Namen → chapter_id; figNameToId ungenutzt, da Faktenfehler keine Figuren tragen).
    const chNameToId = Object.fromEntries(
      db.prepare('SELECT chapter_name, chapter_id FROM chapters WHERE book_id = ?').all(bookIdInt)
        .map(r => [r.chapter_name, r.chapter_id])
    );
    const figNameToId = Object.fromEntries(
      db.prepare('SELECT name, fig_id FROM figures WHERE book_id = ? AND user_email IS ?').all(bookIdInt, email)
        .map(r => [r.name, r.fig_id])
    );

    const signal = jobAbortControllers.get(jobId)?.signal;
    const tok = { in: 0, out: 0, ms: 0, inflight: new Map() };
    // Concurrency-Cap + Warmup wie die Verify-Stufe: Web-Such-Calls sind teuer und einzeln
    // langsam; ein paar parallel, aber kein TPM-Burst über Dutzende Fakten.
    const concurrency = Math.max(1, parseInt(appSettings.get('ai.claude.phase1_concurrency'), 10) || 4);
    updateJob(jobId, { statusText: 'job.phase.factcheckJudge', progress: 10 });
    let done = 0;
    const settled = await settledAll(candidates.map((cand) => async () => {
      const text = await _judgeOneFact(tok,
        prompts.buildWeltfaktRealityJudgePrompt(bookName, cand, { spanne }),
        systemPrompt, signal);
      done++;
      updateJob(jobId, { progress: Math.min(92, 10 + Math.round((done / candidates.length) * 80)) });
      let v;
      try { v = parseJSON(text); }
      catch (e) { log.warn(`Faktencheck-Urteil nicht parsebar (Fakt #${cand.id}): ${e.message}`); return null; }
      // Nur echte Fehlurteile MIT belegender Quelle. «unklar»/«korrekt» → kein Befund.
      if (!v || v.urteil !== 'falsch') return null;
      const quelle = String(v.quelle || '').trim();
      if (!/^https?:\/\//i.test(quelle)) {
        log.info(`Faktencheck: «falsch» ohne belastbare Quelle verworfen (Fakt #${cand.id}).`);
        return null;
      }
      return {
        schwere: ['kritisch', 'mittel', 'niedrig'].includes(v.schwere) ? v.schwere : 'mittel',
        typ: 'faktenfehler',
        beschreibung: String(v.beschreibung || '').trim() || `${cand.subjekt ? cand.subjekt + ': ' : ''}${cand.fakt}`,
        // stelle_a = die geprüfte Aussage (KEIN «»-Zitat → requireQuoteEvidence unberührt); stelle_b leer.
        stelle_a: `${cand.subjekt ? cand.subjekt + ': ' : ''}${cand.fakt}`,
        stelle_b: '',
        empfehlung: String(v.empfehlung || '').trim(),
        quelle,
        figuren: [],
        kapitel: cand.kapitel || [],
      };
    }), { concurrency, warmup: true });
    // AbortError gezielt re-raisen (settledAll fängt Rejects ab).
    const aborted = settled.find(r => r.status === 'rejected' && r.reason?.name === 'AbortError');
    if (aborted) throw aborted.reason;
    const probleme = settled.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
    pt.mark('Judge');

    // An den neuesten Kontinuitäts-Check anhängen (idempotent, ersetzt frühere faktenfehler);
    // die zuvor gefundenen Kontinuitäts-Befunde bleiben unberührt und weiter sichtbar.
    const summaryFallback = probleme.length ? '__i18n:kontinuitaet.faktencheck.summaryFound__' : '__i18n:kontinuitaet.faktencheck.summaryClean__';
    const { normalizedIssues } = saveFaktencheckIssues(
      bookIdInt, email, _factcheckModelName(effectiveProvider), probleme, figNameToId, chNameToId, summaryFallback);
    log.info(`Faktencheck gespeichert (${normalizedIssues.length} Faktenfehler von ${candidates.length} geprüften Fakten).`);
    log.info(`Phasen-Timing: ${pt.summary()}`);
    completeJob(jobId, {
      count: normalizedIssues.length,
      checked: candidates.length,
      issues: normalizedIssues,
      warnings,
      tokensIn: tok.in, tokensOut: tok.out,
    }, tps(tok), `${normalizedIssues.length} Faktenfehler / ${candidates.length} geprüft${warnings.length ? ` warn=${warnings.length}` : ''}`);
  } catch (e) {
    if (e.name !== 'AbortError') log.error(`Faktencheck-Fehler: ${e.message}`);
    failJob(jobId, e);
  }
}

module.exports = { runFaktencheckJob, buildFactCheckCandidates, _narrativeYearSpan, FACTCHECK_CATEGORIES, _FACTCHECK_CANDIDATE_CAP };
