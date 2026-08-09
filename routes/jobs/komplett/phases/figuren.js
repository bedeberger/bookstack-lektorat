'use strict';
// Phase 2: Figuren konsolidieren + Soziogramm + Name→ID-Lookup.
const { saveFigurenToDb, updateFigurenSoziogramm } = require('../../../../db/schema');
const { planFigurenMatch } = require('../../../../db/figures');
const { judgeEntityPairs } = require('../entity-reconcile');
const { recomputeBookFigureMentions } = require('../../../../lib/page-index');
const { i18nError, updateJob } = require('../../shared');
const { buildFigNameLookup } = require('../utils');
const {
  preMergeChapterFiguren, applySozialschichtModeVote, mergeDuplicateFiguren,
  validateBeziehungenDescriptions, backfillFiguren, ensureUniqueFigIds, applyAliasClusters,
} = require('../figuren-merge');
const { komplettMaxTokens } = require('./tokens');
const { providerClass } = require('../../../../lib/ai');

/** Phase 2: Figuren konsolidieren + Soziogramm + Name→ID Lookup.
 *  Single-Pass-Optimierung: Wenn Phase 1 im Single-Pass-Modus lief (ein „Kapitel"
 *  namens Gesamtbuch), sind die Figuren bereits holistisch extrahiert – eine
 *  weitere KI-Konsolidierung fügt nichts hinzu und kostet ~8K Tokens extra.
 *  Stattdessen übernehmen wir die P1-Figuren direkt (IDs werden normalisiert). */
async function runPhase2(ctx, chapterFiguren, chapterAssignments, chapterSzenen) {
  const { jobId, bookIdInt, bookName, email, call, tok, log, prompts, sys, idMaps, effectiveProvider } = ctx;

  const isSinglePass = chapterFiguren.length === 1 && chapterFiguren[0].kapitel === 'Gesamtbuch';
  let figuren;
  // Alias-Cluster (F3, nur Multi-Pass): alias→kanonisch-Map hält Szenen/Events, die einen
  // Alias-Namen tragen, im Remap auflösbar. null = kein Aliasing gelaufen.
  let aliasMap = null;

  if (isSinglePass) {
    updateJob(jobId, { progress: 30, statusText: 'job.phase.consolidatingFiguren' });
    const raw = chapterFiguren[0].figuren || [];
    figuren = raw.map((f, i) => ({ ...f, id: f.id || ('fig_' + (i + 1)) }));
    log.info(`Phase 2 übersprungen (Single-Pass, ${figuren.length} Figuren aus P1 übernommen) – spart einen KI-Call.`);
    updateJob(jobId, { progress: providerClass(effectiveProvider) === 'cloud' ? 40 : 43 });
  } else {
    updateJob(jobId, { progress: 30, statusText: 'job.phase.consolidatingFiguren' });
    // Welle 3 · Rollierender Dedup: Duplikate regelbasiert VOR dem KI-Call entfernen.
    // Spart Eingabetokens und verhindert, dass Phase 2 aus Bequemlichkeit doppelte Figuren durchlässt.
    const { chapterFiguren: preMerged, dupesRemoved } = preMergeChapterFiguren(chapterFiguren);
    if (dupesRemoved > 0) log.info(`Rollierender Pre-Merge – ${dupesRemoved} Figuren-Duplikate regelbasiert zusammengeführt.`);

    // ── Alias-Cluster (F3, nur Cloud-Klasse): Namensvarianten derselben Figur (Epitheta/Spitznamen/
    // Umbenennungen) VOR der Konsolidierung auf einen kanonischen Namen vereinheitlichen, damit
    // die Konsolidierung sie zusammenführt statt als Dubletten zu behalten. Smart-Tier (das
    // job-weite Komplett-Modell, kein extractTier-Override). Non-critical: bei Fehler bleibt
    // die Konsolidierung wie bisher. Nur sinnvoll ab genügend Kandidaten. */
    if (providerClass(effectiveProvider) === 'cloud') {
      const candidates = preMerged.flatMap(cf => (cf.figuren || []).map(f => ({
        name: f.name,
        beschreibung: (f.beschreibung || '').slice(0, 160),
        kapitel: cf.kapitel,
      }))).filter(c => c.name);
      if (candidates.length >= 3) {
        try {
          updateJob(jobId, { statusText: 'job.phase.aliasCluster' });
          const aliasRes = await call(jobId, tok,
            prompts.buildAliasClusterPrompt(bookName, candidates),
            sys.SYSTEM_FIGUREN_BLOCKS, 30, 30, komplettMaxTokens(effectiveProvider), 0.2, null, prompts.SCHEMA_FIGUREN_ALIAS_CLUSTER,
          );
          const { renamed, aliasMap: am } = applyAliasClusters(preMerged, aliasRes?.cluster || [], log);
          if (renamed > 0) aliasMap = am;
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          log.warn(`Alias-Cluster übersprungen (${e.message}) – Konsolidierung unverändert.`);
          ctx.warnings?.push({ key: 'job.warn.aliasClusterDegraded' });
        }
      }
    }

    const figProgressEnd = providerClass(effectiveProvider) === 'cloud' ? 40 : 43;
    let figResult;
    try {
      figResult = await call(jobId, tok,
        prompts.buildFiguresBasisConsolidationPrompt(bookName, preMerged, sys.BUCH_KONTEXT || ''),
        sys.SYSTEM_FIGUREN_BLOCKS, 30, figProgressEnd, komplettMaxTokens(effectiveProvider), 0.2, null, prompts.SCHEMA_FIGUREN_KONSOL,
      );
      if (!Array.isArray(figResult?.figuren)) throw i18nError('job.error.figurenMissing');
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      // Konsolidierungs-Call fehlgeschlagen (typisch: aiTruncated, wenn ein kleines lokales Modell
      // viele Figuren in einen Output packen müsste). Statt den gesamten Job – inkl. mehrstündiger
      // Phase-1-Arbeit – zu verwerfen, auf die bereits regelbasiert pre-gemergten Figuren zurückfallen.
      // mergeDuplicateFiguren + backfill unten laufen ohnehin noch; das Soziogramm wird sparser
      // (kapitel-lokale Beziehungs-Refs filtert die Soziogramm-Stufe via validIds heraus).
      // Kapitel-lokale fig_ids sind NICHT global eindeutig (jedes Kapitel beginnt bei fig_1);
      // normalerweise vergibt Phase 2 eindeutige IDs. Im Fallback selbst neu durchnummerieren,
      // sonst kollidieren gleiche Kapitel-Indizes verschiedener Figuren im
      // UNIQUE(book_id, fig_id, user_email) von saveFigurenToDb.
      const fallback = preMerged.flatMap(c => c.figuren || []).map((f, i) => ({ ...f, id: 'fig_' + (i + 1) }));
      log.warn(`Phase-2-Figuren-Konsolidierung übersprungen (${e.message}) – Fallback auf ${fallback.length} pre-gemergte Figuren.`);
      ctx.warnings?.push({ key: 'job.warn.figurenKonsolidierungDegraded' });
      figResult = { figuren: fallback };
      updateJob(jobId, { progress: figProgressEnd });
    }
    figuren = figResult.figuren.map((f, i) => ({ ...f, id: f.id || ('fig_' + (i + 1)) }));
  }
  const { figuren: mergedFiguren, mergedCount, stage1Saved, stage2Saved, idRemap } = mergeDuplicateFiguren(figuren);
  if (mergedCount > 0) log.info(`${mergedCount} Figuren-Duplikate zusammengeführt (exakt: ${stage1Saved}, Teilname+Indizien: ${stage2Saved}).`);
  figuren = mergedFiguren;
  // Beziehungs-Beschreibungs-Rescue ist pure + billig und hilft jedem Provider:
  // auch Claude attribuiert gelegentlich eine Beschreibung der falschen Figur zu.
  const { cleared, moved } = validateBeziehungenDescriptions(figuren);
  if (cleared > 0 || moved > 0) log.info(`Beziehungs-Beschreibungen bereinigt – ${moved} verschoben, ${cleared} geleert.`);
  // Sozialschicht-Mehrheitsvotum nur für lokale Modelle: die Cloud-Klasse läuft durch
  // den holistischen Soziogramm-Refine-Call und braucht das nicht.
  if (effectiveProvider && providerClass(effectiveProvider) !== 'cloud') {
    const schichtChanges = applySozialschichtModeVote(chapterFiguren, figuren);
    if (schichtChanges > 0) log.info(`Sozialschicht per Mehrheitsvotum korrigiert (${schichtChanges} Figuren).`);
  }
  const backfilled = backfillFiguren(figuren, chapterSzenen, chapterAssignments, log);
  if (backfilled > 0) log.info(`${backfilled} Figur(en) aus Szenen/Events nachgetragen (Phase-1-Recall-Lücke).`);
  const reassignedIds = ensureUniqueFigIds(figuren, log);
  if (reassignedIds > 0) log.warn(`${reassignedIds} kollidierende/leere Figuren-IDs neu vergeben (Schutz vor UNIQUE-Verletzung beim Speichern).`);
  // Reconcile statt Full-Replace: bestehende figures.id per Name/Indizien-Match
  // beibehalten, damit FK-Referenzen (Plot-Beats, Recherche, manuell editierte
  // Events …) die Re-Analyse überleben. Verschwundene Figuren werden stale-markiert,
  // nicht gelöscht.
  // Graubereich des Cross-Run-Matchings vom Judge beurteilen lassen, BEVOR gespeichert
  // wird: die Schreibfunktion darf keinen KI-Call machen, und ohne Urteil bliebe eine
  // Namensvariante als zweiter Eintrag stehen (und die alte Zeile als stale-Dublette).
  let figHint = null;
  try {
    const plan = planFigurenMatch(bookIdInt, figuren, email);
    if (plan.unsure.length) {
      figHint = await judgeEntityPairs(ctx, 'figur', { incoming: figuren, existing: plan.existing, unsure: plan.unsure });
    }
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    log.warn(`Figuren-Match-Judge übersprungen (${e.message}) – Matching bleibt regelbasiert.`);
  }
  saveFigurenToDb(bookIdInt, figuren, email, idMaps, {
    reconcile: true, onMissing: 'stale',
    matchHint: figHint && figHint.size ? figHint : null,
  });
  log.info(`${figuren.length} Figuren gespeichert (reconciled, id-stabil).`);
  try {
    const { figures: figCount, pagesProcessed } = recomputeBookFigureMentions(bookIdInt, email);
    log.info(`Figuren-Mentions aktualisiert (${figCount} Figuren × ${pagesProcessed} Seiten).`);
  } catch (e) {
    log.warn(`Figuren-Mentions-Neuberechnung fehlgeschlagen: ${e.message}`);
  }

  // Soziogramm: preliminary-Werte aus P2-Ergebnis als Fallback
  if (figuren.length >= 4) {
    let sozFiguren = figuren.map(f => ({ fig_id: f.id, sozialschicht: f.sozialschicht || 'andere' }));
    let sozBeziehungen = figuren.flatMap(f =>
      (f.beziehungen || [])
        .filter(bz => bz.machtverhaltnis && bz.figur_id)
        .map(bz => ({ from_fig_id: f.id, to_fig_id: bz.figur_id, machtverhaltnis: bz.machtverhaltnis }))
    );

    // Cloud-Klasse + Multi-Pass: holistische Soziogramm-Konsolidierung (sozialschicht + machtverhaltnis)
    // Bei Single-Pass hat das Modell das ganze Buch gesehen → preliminary-Werte sind bereits
    // holistisch, der Refine-Call fügt nichts hinzu und kostet ~3K Tokens extra.
    if (providerClass(effectiveProvider) === 'cloud' && !isSinglePass) {
      updateJob(jobId, { progress: 40, statusText: 'job.phase.refiningSoziogramm' });
      try {
        const sozResult = await call(jobId, tok,
          prompts.buildSoziogrammConsolidationPrompt(bookName, figuren, sys.BUCH_KONTEXT || ''),
          sys.SYSTEM_FIGUREN_BLOCKS, 40, 43, komplettMaxTokens(effectiveProvider), 0.2, null, prompts.SCHEMA_SOZIOGRAMM_KONSOL,
        );
        const validIds = new Set(figuren.map(f => f.id));
        const prelimSchichtById = Object.fromEntries(sozFiguren.map(s => [s.fig_id, s.sozialschicht]));
        const prelimPairs = new Set(sozBeziehungen.map(bz => `${bz.from_fig_id}|${bz.to_fig_id}`));
        const schichtOverride = {};
        for (const f of (sozResult?.figuren || [])) {
          if (f && validIds.has(f.id) && f.sozialschicht) schichtOverride[f.id] = f.sozialschicht;
        }
        sozFiguren = figuren.map(f => ({
          fig_id: f.id,
          sozialschicht: schichtOverride[f.id] || prelimSchichtById[f.id] || 'andere',
        }));
        const refinedBz = (sozResult?.beziehungen || [])
          .filter(bz => bz && validIds.has(bz.from_fig_id) && validIds.has(bz.to_fig_id)
            && bz.from_fig_id !== bz.to_fig_id
            && Number.isFinite(bz.machtverhaltnis)
            && prelimPairs.has(`${bz.from_fig_id}|${bz.to_fig_id}`));
        if (refinedBz.length > 0) sozBeziehungen = refinedBz;
        const changedSchichten = Object.keys(schichtOverride).filter(id => schichtOverride[id] !== prelimSchichtById[id]).length;
        log.info(`Soziogramm-Konsolidierung: ${changedSchichten} Schicht-Korrekturen, ${refinedBz.length}/${prelimPairs.size} Machtbeziehungen verfeinert.`);
      } catch (e) {
        log.warn(`Soziogramm-Konsolidierung fehlgeschlagen, nutze preliminary-Werte: ${e.message}`);
        ctx.warnings?.push({ key: 'job.warn.soziogrammDegraded' });
        updateJob(jobId, { progress: 43 });
      }
    }

    updateFigurenSoziogramm(bookIdInt, sozFiguren, sozBeziehungen, email);
    log.info(`Soziogramm: ${sozFiguren.length} Figuren, ${sozBeziehungen.length} Machtbeziehungen.`);
  }

  const figurenKompakt = figuren.map(f => ({ id: f.id, name: f.name, typ: f.typ || 'andere' }));
  const { figNameToId, figNameToIdLower } = buildFigNameLookup(figuren, chapterFiguren, chapterAssignments, chapterSzenen, log, jobId, aliasMap);

  return { figuren, figNameToId, figNameToIdLower, figurenKompakt, idRemap, isSinglePass };
}

module.exports = { runPhase2 };
