'use strict';
// Phase «Erzählprofil»: pro Kapitel Erzählperspektive/-zeit + Erzähler-/Fokusfigur,
// POV-Konfidenz/Beleg, Spannungs-Intensität (Pacing) und dominante Themen/Motive/Symbole.
// Single-Pass (Claude, ganzes Buch → ein Call gegen den gecachten Buchtext-Block wie P8) bzw.
// Multi-Pass (lokal/grosses Buch → ein Call pro Kapitel, concurrency wie Coverage-Audit).
// Non-critical, read-only Endphase: ein Fehler darf den bereits gespeicherten Katalog nicht
// kippen (Kapselung im Aufrufer via runNonCritical).
const { saveChapterNarrativeProfiles, getBookSettings } = require('../../../../db/schema');
const { getNarrativeReport, saveAutorenBefund } = require('../../../../db/narrative-report');
const { updateJob, toSystemBlocks, retryOnTransientAi, settledAll } = require('../../shared');
const { buildBookSystemBlockText } = require('../utils');
const { komplettMaxTokens } = require('./tokens');
const { providerClass } = require('../../../../lib/ai');

/** @returns {number} Anzahl gespeicherter Kapitel-Profile (0 wenn nichts erzeugt). */
async function runErzaehlprofil(ctx, opts = {}) {
  const {
    jobId, bookIdInt, bookName, email, call, tok, log, effectiveProvider,
    singlePassLimit, totalChars, fullBookText, pageContents, groups, groupOrder, idMaps, prompts, sys,
  } = ctx;
  const { figNameToId = {}, fromPct = 98, toPct = 99 } = opts;
  if (!groupOrder?.length) return 0;

  const cap = komplettMaxTokens(effectiveProvider);
  const singlePass = totalChars <= singlePassLimit && providerClass(effectiveProvider) === 'cloud';
  updateJob(jobId, { progress: fromPct, statusText: 'job.phase.narrativeProfile' });

  let profiles = [];
  if (singlePass) {
    // Ein Call über das ganze Buch → Array pro Kapitel. Buchtext im gecachten
    // System-Block (identisch zu P8/P1 → 1h-Cache-Read statt Neuübertragung).
    const bookSystemBlock = { text: buildBookSystemBlockText(bookName, pageContents.length, fullBookText), ttl: '1h' };
    const res = await retryOnTransientAi(() => call(jobId, tok,
      prompts.buildErzaehlprofilSinglePassPrompt(bookName, null),
      [bookSystemBlock, ...toSystemBlocks(sys.SYSTEM_KOMPLETT_EXTRAKTION_BLOCKS, '1h')],
      fromPct, toPct, cap, 0.2, null, prompts.SCHEMA_ERZAEHLPROFIL,
    ), { log, label: 'Erzählprofil Single-Pass' });
    profiles = Array.isArray(res?.kapitel) ? res.kapitel : [];
  } else {
    // Ein Call pro Kapitel, parallel (concurrency 3 wie Coverage-Audit). Kapitelname
    // ist bekannt → Schema ohne kapitel-Feld; wir hängen den Namen selbst an.
    const results = await settledAll(groupOrder.map((key, gi) => () => {
      const group = groups.get(key);
      const chText = group.pages.map(p => `### ${p.title}\n${p.text}`).join('\n\n---\n\n');
      const fp = fromPct + Math.round(((gi) / groupOrder.length) * (toPct - fromPct));
      const tp = fromPct + Math.round(((gi + 1) / groupOrder.length) * (toPct - fromPct));
      return retryOnTransientAi(() => call(jobId, tok,
        prompts.buildErzaehlprofilChapterPrompt(bookName, group.name, chText),
        toSystemBlocks(sys.SYSTEM_KOMPLETT_EXTRAKTION_BLOCKS),
        fp, tp, cap, 0.2, null, prompts.SCHEMA_ERZAEHLPROFIL_CHAPTER,
      ), { log, label: `Erzählprofil «${group.name}»` })
        .then(r => (r ? { ...r, kapitel: group.name } : null));
    }), { concurrency: 3 });
    profiles = results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
    const failed = results.filter(r => r.status === 'rejected').length;
    if (failed) log.warn(`Erzählprofil: ${failed}/${groupOrder.length} Kapitel übersprungen.`);
  }

  if (!profiles.length) { log.warn('Erzählprofil: keine auswertbaren Kapitel.'); return 0; }
  const bs = getBookSettings(bookIdInt, email);
  const declared = { erzaehlperspektive: bs?.erzaehlperspektive || null, erzaehlzeit: bs?.erzaehlzeit || null };
  const saved = saveChapterNarrativeProfiles(bookIdInt, email, profiles, idMaps.chNameToId, figNameToId, declared);
  log.info(`Erzählprofil gespeichert: ${saved} Kapitel${singlePass ? ' (Single-Pass)' : ' (Multi-Pass)'}.`);

  // KI-Dach-Befund (Autoren-Befund) über die jetzt frisch berechenbaren, DETERMINISTISCHEN
  // Struktur-Befunde. Nur Cloud-Klasse, non-critical (Fehler kippt das Kapitel-Profil nicht).
  if (saved > 0 && providerClass(effectiveProvider) === 'cloud') {
    try {
      await runAutorenBefund(ctx, { declared, fromPct: toPct, toPct });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      log.warn(`Autoren-Befund übersprungen: ${e.message}`);
    }
  }
  return saved;
}

/** Verdichtet die deterministischen Struktur-Befunde zu einer priorisierten
 *  Autoren-Einschätzung (ein Claude-Call, non-critical). Persistiert in narrative_report. */
async function runAutorenBefund(ctx, { declared, fromPct, toPct }) {
  const { jobId, bookIdInt, bookName, email, call, tok, log, effectiveProvider, prompts, sys } = ctx;
  const befund = getNarrativeReport(bookIdInt, email);
  if (!befund || !befund.chapterCount) return;
  updateJob(jobId, { progress: fromPct, statusText: 'job.phase.narrativeProfile' });
  const cap = komplettMaxTokens(effectiveProvider);
  const res = await retryOnTransientAi(() => call(jobId, tok,
    prompts.buildAutorenBefundPrompt(bookName, befund, declared),
    toSystemBlocks(sys.SYSTEM_KOMPLETT_EXTRAKTION_BLOCKS),
    fromPct, toPct, 4000, 0.5, null, prompts.SCHEMA_AUTOREN_BEFUND,
  ), { log, label: 'Autoren-Befund' });
  const befunde = Array.isArray(res?.befunde) ? res.befunde : [];
  saveAutorenBefund(bookIdInt, email, { zusammenfassung: res?.zusammenfassung || '', befunde });
  log.info(`Autoren-Befund gespeichert: ${befunde.length} Einträge.`);
}

module.exports = { runErzaehlprofil };
