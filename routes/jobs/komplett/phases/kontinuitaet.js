'use strict';
// Block 2 der Komplettanalyse: Zeitstrahl (P6) und Kontinuitätsprüfung (P8)
// zusammen mit dem ergänzenden Attribut-Widerspruchs-Detektor (F4) und dem
// Persistieren des Ergebnisses.
//
// Beide Phasen sind read-only Endphasen — Figuren/Orte/Szenen liegen zu diesem
// Zeitpunkt bereits gültig in der DB. Darum darf hier NICHTS den Job über
// failJob kippen: jeder Zweig kapselt seine Fehler selbst und sammelt eine
// Warnung, nur AbortError (User-Abbruch) schlägt durch.
const { getBookSettings } = require('../../../../db/schema');
const appSettings = require('../../../../lib/app-settings');
const { toSystemBlocks, updateJob, retryOnTransientAi } = require('../../shared');
const { narrativeLabels } = require('../../narrative-labels');
const { buildBookSystemBlockText } = require('../utils');
const { saveKontinuitaetResult } = require('../remap');
const { verifyKontinuitaetProbleme, runAttributeContradictionCheck } = require('../job-shared');
// Direkt aus dem Phasen-Modul statt über die phases.js-Facade — die Facade lädt
// diese Datei mit und der Umweg wäre ein Zirkular-Import.
const { runZeitstrahl } = require('./beziehungen-zeitstrahl');
const { komplettMaxTokens } = require('./tokens');
const { COST_LABEL, costTier } = require('../cost-labels');

// P8-Call. Single-Pass (voller Buchtext im 1h-Cache) nur bei Cloud-Klasse, sonst
// Fakten-Multi-Pass. Fehler werden hier abgefangen: ein gescheiterter P8 (Trunkierung
// bei zu vielen Befunden, Parse-Fehler, erschöpfter Retry) darf den Katalog NICHT als
// „fehlgeschlagen" verwerfen — Kontinuität überspringen, vorheriges Ergebnis bleibt.
async function _runP8(ctx, { kontMultiPass, figKompakt, orteKompakt, chapterFakten, anachronismus }) {
  const { jobId, bookIdInt, bookName, email, call, tok, log, effectiveProvider,
    prompts, sys, pageContents, fullBookText, warnings } = ctx;
  try {
    if (!kontMultiPass) {
      log.info(`Kontinuität Single-Pass: ${fullBookText.length} Zeichen, ${figKompakt.length} Figuren, ${orteKompakt.length} Orte`);
      const bookSystemBlock = { text: buildBookSystemBlockText(bookName, pageContents.length, fullBookText), ttl: '1h' };
      return await retryOnTransientAi(() => call(jobId, tok,
        prompts.buildKontinuitaetSinglePassPrompt(bookName, null, figKompakt, orteKompakt, narrativeLabels(getBookSettings(bookIdInt, email)), anachronismus),
        [bookSystemBlock, ...toSystemBlocks(sys.SYSTEM_KONTINUITAET_BLOCKS, '1h')],
        82, 97, komplettMaxTokens(effectiveProvider), 0.2, null, prompts.SCHEMA_KONTINUITAET_PROBLEME,
        costTier(COST_LABEL.kontinuitaet),
      ), { log, label: 'Kontinuität Single-Pass (P8)' });
    }
    log.info(`Kontinuität facts-basiert: ${chapterFakten.length} Kapitel, ${figKompakt.length} Figuren`);
    return await retryOnTransientAi(() => call(jobId, tok,
      prompts.buildKontinuitaetCheckPrompt(bookName, chapterFakten, figKompakt, orteKompakt, anachronismus),
      sys.SYSTEM_KONTINUITAET_BLOCKS, 82, 97, komplettMaxTokens(effectiveProvider), 0.2, null, prompts.SCHEMA_KONTINUITAET_PROBLEME,
      costTier(COST_LABEL.kontinuitaet),
    ), { log, label: 'Kontinuität facts-basiert (P8)' });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    log.warn(`Kontinuitätsprüfung fehlgeschlagen (Katalog bleibt erhalten): ${e.message}`);
    warnings.push({ key: 'job.warn.continuityFailed' });
    return null;
  }
}

// P6 (Zeitstrahl) non-critical kapseln: ein Fehler im Zeitstrahl-DB-Save (oder im
// Konsolidierungs-Call, der im Fallback synchron speichert) darf den bereits gültig
// gespeicherten Katalog NICHT verwerfen — P6 ist Endphase, kein kritischer Pfad.
// AbortError (User-Cancel) muss aber durchschlagen → eigene Kapselung statt
// runNonCritical (das AbortError schluckt). _runP8 ist intern bereits so abgesichert;
// damit kann keiner der beiden Promise.all-Zweige den Job über failJob kippen.
async function _runZeitstrahlSafe(ctx, opts) {
  try { await runZeitstrahl(ctx, opts); }
  catch (e) {
    if (e.name === 'AbortError') throw e;
    ctx.log.warn(`Zeitstrahl-Phase fehlgeschlagen (Katalog bleibt erhalten): ${e.message}`);
    ctx.warnings.push({ key: 'job.warn.timelineFailed' });
  }
}

/** Zeitstrahl + Kontinuität + Attribut-Detektor, inklusive Persistenz.
 *  `skipContinuity` waehlt P8 (und mit ihm den Attribut-Detektor) ab — der Zeitstrahl
 *  ist Kern-Katalog und laeuft weiter. Schreibt selbst in die DB; liefert nichts. */
async function runKontinuitaetPhase(ctx, {
  skipContinuity, isCloudModel, kontMultiPass,
  figKompakt, orteKompakt, chapterFakten, anachronismus, figNameToId,
}) {
  const { jobId, bookIdInt, email, log, effectiveProvider, idMaps, fullBookText, warnings } = ctx;
  let kontResult;
  if (skipContinuity) {
    // Teil-Lauf: P8 abgewählt. Das vorherige Kontinuitäts-Ergebnis bleibt unangetastet
    // (P8 ist read-only). Die Bar muss über den P8-Bereich (82..97) hinweg selbst
    // vorrücken — sonst hängt sie bei 82, bis completeJob auf 100 springt.
    // Kein eigener statusText: runZeitstrahl (nicht-silent) setzt seinen eigenen.
    log.info('Kontinuitätsprüfung (P8) auf Wunsch übersprungen – bestehendes Ergebnis bleibt.');
    await _runZeitstrahlSafe(ctx);
    updateJob(jobId, { progress: 97 });
    kontResult = null;
  } else if (isCloudModel) {
    // Parallel: P6 silent, P8 ownt Bar (82..97).
    updateJob(jobId, { progress: 82, statusText: 'job.phase.checkContinuity' });
    const [, p8Out] = await Promise.all([
      _runZeitstrahlSafe(ctx, { silent: true }),
      _runP8(ctx, { kontMultiPass, figKompakt, orteKompakt, chapterFakten, anachronismus }),
    ]);
    kontResult = p8Out;
  } else {
    // Kontinuitätsprüfung (P8) ist Cloud-only — für lokale Provider übersprungen:
    // ohne Single-Pass/Verify-Filter/Attribut-Check produziert der Fakten-Multi-Pass
    // zu viele False Positives. Der Zeitstrahl (P6) ist Kern-Katalog und läuft weiter.
    await _runZeitstrahlSafe(ctx);
    kontResult = null;
  }
  // Pflichtfeld-Check als Degradierung (P8 read-only → kein throw): ein schema-valides
  // Ergebnis ohne «zusammenfassung» würde saveKontinuitaetResult wortlos null liefern
  // (kein Befund, kein Hinweis) → der User hielte die Prüfung für sauber durchgelaufen.
  if (kontResult && typeof kontResult.zusammenfassung === 'undefined') {
    log.warn('Kontinuitätsprüfung: Pflichtfeld «zusammenfassung» fehlt – Ergebnis verworfen, Warnung gesammelt.');
    warnings.push({ key: 'job.warn.continuityFailed' });
    kontResult = null;
  }
  if (kontResult) {
    // Multi-Pass-Befunde gegen den Originaltext verifizieren (False-Positive-Filter).
    if (kontMultiPass && isCloudModel) {
      kontResult = await verifyKontinuitaetProbleme(ctx, kontResult, 96, 97);
    }
  }

  // ── F4: Attribut-Widerspruchs-Detektor (non-critical, nur Cloud-Klasse) ──────
  // Deterministisch gefundene Cross-Chapter-Widersprüche (Lebensereignis-Jahre, Welt-Fakten),
  // die der fakten-basierte P8 pro Kapitel übersieht; das Modell (Konsolidierungs-Tier) urteilt.
  // Bereits geurteilt → NICHT durch die verify-Stufe schleusen, sondern nach ihr einmischen.
  // Mit abgewähltem P8 entfällt er mit: er ist ein ERGÄNZENDER Kontinuitäts-Detektor
  // (seine Befunde werden in denselben Check geschrieben) — ihn allein laufen zu
  // lassen würde den bestehenden Check mit einem fast leeren neuen überschreiben.
  let attrFindings = [];
  if (!skipContinuity && isCloudModel && appSettings.get('ai.komplett.attribute_check') === true) {
    try {
      attrFindings = await runAttributeContradictionCheck(ctx, 97, 98);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      log.warn(`Attribut-Widerspruchs-Detektor fehlgeschlagen (ignoriert): ${e.message}`);
      warnings.push({ key: 'job.warn.attributeCheckFailed' });
    }
  }

  if (kontResult) {
    if (attrFindings.length) {
      kontResult = { ...kontResult, probleme: [...(kontResult.probleme || []), ...attrFindings] };
    }
    // Single-Pass (Cloud, voller Buchtext im Prompt): Beleg-Zitate gegen den Text
    // prüfen. Multi-Pass hat die separate verify-Stufe; der Fakten-Pfad zitiert
    // paraphrasiert → requireQuoteEvidence dort aus (false negatives sonst). Die
    // F4-Befunde tragen keine «»-Zitate → von der Beleg-Prüfung unberührt.
    saveKontinuitaetResult(bookIdInt, email, kontResult, figNameToId, idMaps.chNameToId, effectiveProvider, log,
      { fullBookText, requireQuoteEvidence: !kontMultiPass });
  } else if (attrFindings.length) {
    // P8 selbst fehlgeschlagen/leer, aber der Attribut-Detektor fand Cross-Chapter-Widersprüche:
    // eigenständig als Kontinuitäts-Check persistieren (nicht verlieren).
    saveKontinuitaetResult(bookIdInt, email, { zusammenfassung: '', probleme: attrFindings },
      figNameToId, idMaps.chNameToId, effectiveProvider, log, { requireQuoteEvidence: false });
  }
}

module.exports = { runKontinuitaetPhase };
