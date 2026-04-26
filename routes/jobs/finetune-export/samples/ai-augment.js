'use strict';

// AI-Augmentation für den Finetune-Export.
//
// Drei opt-in-Phasen, alle mit DB-Cache (finetune_ai_cache):
//   1) reverse-prompts: pro Seite N natürliche User-Instructions, Assistant
//      bleibt der Originaltext der Seite (Stil-Schutz).
//   2) fact-qa: pro Figur/Ort/Ereignis N Q&A-Paare, gegroundet im strukturierten
//      JSON aus der DB.
//   3) reasoning-backfill: für bestehende Korrekturen ohne erklaerung-Feld
//      eine einsätzige Begründung nachziehen.
//
// Cache-Key-Konzept:
//   sig = sha1(payload-inputs + modelName)
//   Der Sig ändert sich, sobald sich Quell-Daten oder Modell ändern → Cache-Miss.
//   PROMPTS_VERSION steckt zusätzlich im version-Feld, damit ein Schema-Bump
//   alte Einträge automatisch invalidiert.

const crypto = require('crypto');
const {
  loadFinetuneAiCache, saveFinetuneAiCache,
} = require('../../../../db/schema');
const { aiCall, _modelName, getPrompts } = require('../../shared');
const { extractName } = require('../lib/names');

const REVERSE_PROMPTS_PER_PAGE_DEFAULT = 4;
const FACT_QA_PER_ENTITY_DEFAULT = 4;
const AUGMENT_CONCURRENCY = 4;

function sha1(s) {
  return crypto.createHash('sha1').update(typeof s === 'string' ? s : JSON.stringify(s)).digest('hex');
}

function trimInstr(s) {
  return String(s || '').trim().replace(/^["“”„«»‹›']+|["“”„«»‹›']+$/g, '').trim();
}

// ── Concurrency-limited map (kleiner Pool, damit grosse Bücher den Provider nicht überrennen) ──
async function pmap(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

async function buildAiAugmentSamples(ctx) {
  const { opts } = ctx;
  const ai = opts.ai || {};
  if (!ai.reversePrompts && !ai.factQA && !ai.reasoningBackfill) return;

  const prompts = await getPrompts();
  const subCtx = {
    ...ctx,
    prompts,
    augmentSystem: prompts.buildFinetuneAugmentSystem(ctx.langIsEn),
    versionTag: `${_modelName(undefined)}:${prompts.PROMPTS_VERSION || ''}`,
    tok: { in: 0, out: 0, ms: 0 },
  };

  if (ai.reversePrompts)     await buildReversePromptSamples(subCtx);
  if (ai.factQA)             await buildFactQASamples(subCtx);
  if (ai.reasoningBackfill)  await buildReasoningBackfillSamples(subCtx);
}

// ── 1) Reverse-Prompts ───────────────────────────────────────────────────────
async function buildReversePromptSamples(ctx) {
  const {
    samples, counts, opts, langIsEn, unifiedSys, bookName,
    bookIdInt, userEmail, pageContents, prompts, augmentSystem, versionTag, jobId, logger, tok,
  } = ctx;
  const { minChars, maxChars } = opts;
  const n = Math.max(1, Math.min(8, opts.ai.reversePromptsPerPage || REVERSE_PROMPTS_PER_PAGE_DEFAULT));

  // Eligible Pages: nur in der Längen-Range, sonst sind weder Original-Page-
  // Sample noch Reverse-Prompt-Variation sinnvoll.
  const eligible = pageContents.filter(p => p.text && p.text.length >= minChars);
  if (!eligible.length) return;

  let processed = 0;
  await pmap(eligible, AUGMENT_CONCURRENCY, async (p) => {
    const passage = p.text.length > maxChars ? p.text.slice(0, maxChars) : p.text;
    const sig = sha1(passage + '|n=' + n + '|lang=' + (langIsEn ? 'en' : 'de'));
    const scopeKey = `page:${p.id}`;

    let result = loadFinetuneAiCache(bookIdInt, userEmail, 'reverse-prompts', scopeKey, sig, versionTag);
    if (!result) {
      const prompt = prompts.buildFinetuneReversePromptsPrompt({
        passage,
        count: n,
        langIsEn,
        bookName,
        chapter: p.chapter || '',
        pageTitle: p.title || '',
      });
      try {
        result = await aiCall(jobId, tok, prompt, augmentSystem, null, null, 800, 0.25, 1500, undefined, prompts.SCHEMA_FT_REVERSE_PROMPTS);
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        logger.warn(`reverse-prompts: page=${p.id} fehlgeschlagen: ${err.message}`);
        return;
      }
      if (!result || !Array.isArray(result.instructions)) return;
      saveFinetuneAiCache(bookIdInt, userEmail, 'reverse-prompts', scopeKey, sig, versionTag, result);
    }

    const instrs = (result.instructions || [])
      .map(trimInstr)
      .filter(s => s.length >= 6 && s.length <= 240);
    const seen = new Set();
    let variantIdx = 0;
    for (const instr of instrs) {
      const key = instr.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      samples.push({
        id: `aiRev|${p.id}|${variantIdx++}`,
        type: 'aiAugment',
        messages: [
          { role: 'system', content: unifiedSys },
          { role: 'user', content: instr },
          { role: 'assistant', content: passage },
        ],
      });
      counts.aiAugment = (counts.aiAugment || 0) + 1;
    }
    processed++;
  });

  logger.info(`AI-Augment reverse-prompts: ${processed}/${eligible.length} Seiten verarbeitet, ${counts.aiAugment || 0} Samples bisher.`);
}

// ── 2) Fakten-Q&A ─────────────────────────────────────────────────────────────
async function buildFactQASamples(ctx) {
  const {
    samples, counts, opts, langIsEn, unifiedSys, bookName,
    bookIdInt, userEmail, prompts, augmentSystem, versionTag, jobId, logger, tok,
    figRows, locRows, eventsByFigPk, appearancesByFigPk, chaptersByLocPk, figsByLocPk, figById,
  } = ctx;
  const n = Math.max(2, Math.min(8, opts.ai.factQAPerEntity || FACT_QA_PER_ENTITY_DEFAULT));

  const entities = [];

  // Figuren — strukturiertes Profil mit Lebensereignissen + Kapitel-Auftritten.
  for (const f of figRows) {
    if (!f.name || !f.name.trim()) continue;
    const events = (eventsByFigPk.get(f.pk) || []).slice(0, 12);
    const chapters = (appearancesByFigPk.get(f.pk) || []).slice(0, 12);
    const json = {
      typ: 'figur',
      name: f.name,
      kurzname: f.kurzname || null,
      figurentyp: f.typ || null,
      beschreibung: f.beschreibung || null,
      beruf: f.beruf || null,
      geschlecht: f.geschlecht || null,
      sozialschicht: f.sozialschicht || null,
      tags: f.tags_csv ? f.tags_csv.split(',').filter(Boolean) : [],
      lebensereignisse: events,
      kapitel: chapters,
    };
    entities.push({
      scope: 'fact-qa',
      scopeKey: `figur:${f.fig_id || f.pk}`,
      kindLabel: langIsEn ? 'character' : 'Figur',
      json,
    });
  }

  // Orte
  for (const l of locRows) {
    if (!l.name || !l.name.trim()) continue;
    const figIds = figsByLocPk.get(l.pk) || [];
    const figNames = figIds.map(id => extractName(id, figById)).filter(Boolean).slice(0, 12);
    const chapters = (chaptersByLocPk.get(l.pk) || []).slice(0, 12);
    const json = {
      typ: 'ort',
      name: l.name,
      ortstyp: l.typ || null,
      beschreibung: l.beschreibung || null,
      stimmung: l.stimmung || null,
      erste_erwaehnung: l.erste_erwaehnung || null,
      figuren: figNames,
      kapitel: chapters,
    };
    entities.push({
      scope: 'fact-qa',
      scopeKey: `ort:${l.loc_id || l.pk}`,
      kindLabel: langIsEn ? 'location' : 'Ort',
      json,
    });
  }

  if (!entities.length) return;

  let processed = 0;
  await pmap(entities, AUGMENT_CONCURRENCY, async (ent) => {
    const sig = sha1(JSON.stringify(ent.json) + '|n=' + n + '|lang=' + (langIsEn ? 'en' : 'de'));

    let result = loadFinetuneAiCache(bookIdInt, userEmail, ent.scope, ent.scopeKey, sig, versionTag);
    if (!result) {
      const prompt = prompts.buildFinetuneFactQAPrompt({
        entityType: ent.kindLabel,
        entityJson: ent.json,
        count: n,
        langIsEn,
        bookName,
      });
      try {
        result = await aiCall(jobId, tok, prompt, augmentSystem, null, null, 1200, 0.3, 2000, undefined, prompts.SCHEMA_FT_FACT_QA);
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        logger.warn(`fact-qa: ${ent.scopeKey} fehlgeschlagen: ${err.message}`);
        return;
      }
      if (!result || !Array.isArray(result.qa)) return;
      saveFinetuneAiCache(bookIdInt, userEmail, ent.scope, ent.scopeKey, sig, versionTag, result);
    }

    const seen = new Set();
    let variantIdx = 0;
    for (const pair of result.qa || []) {
      const q = trimInstr(pair.frage);
      const a = (pair.antwort || '').trim();
      if (q.length < 6 || a.length < 20) continue;
      const key = q.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      samples.push({
        id: `aiQA|${ent.scopeKey}|${variantIdx++}`,
        type: 'aiAugment',
        messages: [
          { role: 'system', content: unifiedSys },
          { role: 'user', content: q },
          { role: 'assistant', content: a },
        ],
      });
      counts.aiAugment = (counts.aiAugment || 0) + 1;
    }
    processed++;
  });

  logger.info(`AI-Augment fact-qa: ${processed}/${entities.length} Entitäten verarbeitet, ${counts.aiAugment || 0} Samples bisher.`);
}

// ── 3) Reasoning-Backfill für Korrekturen ─────────────────────────────────────
async function buildReasoningBackfillSamples(ctx) {
  const {
    samples, counts, opts, langIsEn, unifiedSys,
    bookIdInt, userEmail, prompts, augmentSystem, versionTag, jobId, logger, tok,
  } = ctx;
  const { maxChars } = opts;
  const { db } = require('../../../../db/schema');

  const userPrefix   = langIsEn
    ? 'Rewrite this sentence in the author\'s style and explain the change in one sentence:\n\n'
    : 'Formuliere diesen Satz im Stil des Autors um und erkläre die Änderung in einem Satz:\n\n';
  const reasonLabel  = langIsEn ? 'Reason: ' : 'Grund: ';

  const checkRows = db.prepare(`
    SELECT errors_json FROM page_checks
    WHERE book_id = ? AND user_email = ? AND errors_json IS NOT NULL AND error_count > 0
    ORDER BY checked_at DESC
  `).all(bookIdInt, userEmail);

  const targets = [];
  const seenPair = new Set();
  for (const row of checkRows) {
    let errs = null;
    try { errs = JSON.parse(row.errors_json); } catch { continue; }
    if (!Array.isArray(errs)) continue;
    for (const e of errs) {
      const orig = (e.original || '').trim();
      const korr = (e.korrektur || '').trim();
      const erkl = (e.erklaerung || '').trim();
      if (orig.length < 8 || korr.length < 5) continue;
      if (orig.toLowerCase() === korr.toLowerCase()) continue;
      if (orig.length > maxChars || korr.length > maxChars) continue;
      if (erkl.length >= 15) continue; // bereits vorhanden — kein Backfill nötig
      const key = orig + '→' + korr;
      if (seenPair.has(key)) continue;
      seenPair.add(key);
      targets.push({ orig, korr, kontext: (e.kontext || '').trim() });
    }
  }
  if (!targets.length) return;

  let processed = 0;
  await pmap(targets, AUGMENT_CONCURRENCY, async (t) => {
    const sig = sha1(t.orig + '|' + t.korr + '|lang=' + (langIsEn ? 'en' : 'de'));
    const scopeKey = `corr:${sha1(t.orig + '|' + t.korr).slice(0, 16)}`;

    let result = loadFinetuneAiCache(bookIdInt, userEmail, 'reasoning-backfill', scopeKey, sig, versionTag);
    if (!result) {
      const prompt = prompts.buildFinetuneReasoningBackfillPrompt({
        original: t.orig, korrektur: t.korr, kontext: t.kontext, langIsEn,
      });
      try {
        result = await aiCall(jobId, tok, prompt, augmentSystem, null, null, 200, 0.2, 400, undefined, prompts.SCHEMA_FT_REASONING);
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        logger.warn(`reasoning-backfill: ${scopeKey} fehlgeschlagen: ${err.message}`);
        return;
      }
      if (!result || typeof result.begruendung !== 'string') return;
      saveFinetuneAiCache(bookIdInt, userEmail, 'reasoning-backfill', scopeKey, sig, versionTag, result);
    }

    const erkl = (result.begruendung || '').trim();
    if (erkl.length < 15 || erkl.length > 400) return;

    const idx = counts.aiAugment || 0;
    samples.push({
      id: `aiCorr|${scopeKey}|${idx}`,
      type: 'aiAugment',
      messages: [
        { role: 'system', content: unifiedSys },
        { role: 'user', content: userPrefix + t.orig },
        { role: 'assistant', content: t.korr + '\n\n' + reasonLabel + erkl },
      ],
    });
    counts.aiAugment = (counts.aiAugment || 0) + 1;
    processed++;
  });

  logger.info(`AI-Augment reasoning-backfill: ${processed}/${targets.length} Korrekturen ergänzt, ${counts.aiAugment || 0} Samples bisher.`);
}

module.exports = { buildAiAugmentSamples };
