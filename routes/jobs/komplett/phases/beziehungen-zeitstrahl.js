'use strict';
// Phase 3b: kapitelübergreifende Beziehungen (Multi-Pass) · Phase 6: Zeitstrahl.
const { db, addFigurenBeziehungen, saveZeitstrahlEvents } = require('../../../../db/schema');
const { updateJob } = require('../../shared');
const { komplettMaxTokens } = require('./tokens');
const { providerClass } = require('../../../../lib/ai');
const appSettings = require('../../../../lib/app-settings');
const { COST_LABEL, costTier } = require('../cost-labels');

/**
 * Phase 3b: Kapitelübergreifende Beziehungen (nur Multi-Pass).
 * Single-Pass: Phase 1 hat den vollständigen Text gesehen → Beziehungen bereits erfasst.
 * Multi-Pass: Kapitel wurden isoliert analysiert → Beziehungen zwischen Figuren
 * verschiedener Kapitel hier nachträglich identifiziert.
 */
async function runPhase3b(ctx, figuren) {
  const { jobId, bookIdInt, email, call, tok, log, prompts, sys, singlePassLimit, bookName, fullBookText, pageContents, effectiveProvider } = ctx;

  updateJob(jobId, { progress: 56, statusText: 'job.phase.crossChapterRelations' });

  // Welle 3 · Co-Occurrence-basierter Textauswahl: Statt fullBookText zu trunkieren
  // (was bei lokalen Modellen bis zu 2/3 des Buchs verwirft), zielen wir auf
  // die Seiten ab, wo mindestens zwei Figuren aus verschiedenen Kapiteln gemeinsam
  // vorkommen. Das liefert dichtere Evidenz bei viel kleinerem Token-Budget.
  let textForPrompt = null;

  try {
    const { computeFigureMentions } = require('../../../../lib/page-index');
    const figInput = figuren.map(f => ({ id: f.id, name: f.name, kurzname: f.kurzname || '' }));
    const figPages = new Map();
    for (let pi = 0; pi < pageContents.length; pi++) {
      const mentions = computeFigureMentions(pageContents[pi].text, figInput);
      for (const m of mentions) {
        if (!figPages.has(m.figure_id)) figPages.set(m.figure_id, new Set());
        figPages.get(m.figure_id).add(pi);
      }
      // Event-Loop freigeben: bei grossen Büchern (Multi-Pass-Fall, viele Seiten × Figuren)
      // ist dieser synchrone Scan sonst sekundenlang blockierend für den Job-Worker.
      if (pi % 50 === 49) await new Promise(r => setImmediate(r));
    }
    const figToHome = Object.fromEntries(figuren.map(f => [f.id, (f.kapitel || [])[0]?.name || null]));
    const existingPairs = new Set();
    for (const f of figuren) {
      for (const b of (f.beziehungen || [])) {
        const [a, c] = f.id < b.figur_id ? [f.id, b.figur_id] : [b.figur_id, f.id];
        existingPairs.add(`${a}|${c}`);
      }
    }
    const candidatePageIdx = new Set();
    const figIds = figuren.map(f => f.id);
    for (let i = 0; i < figIds.length; i++) {
      for (let j = i + 1; j < figIds.length; j++) {
        const a = figIds[i], b = figIds[j];
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (existingPairs.has(key)) continue;
        if (figToHome[a] && figToHome[b] && figToHome[a] === figToHome[b]) continue;
        const pa = figPages.get(a), pb = figPages.get(b);
        if (!pa || !pb) continue;
        // Schnittmenge über das KLEINERE Set iterieren (O(min) statt O(|pa|)).
        const [small, big] = pa.size <= pb.size ? [pa, pb] : [pb, pa];
        for (const pi of small) if (big.has(pi)) candidatePageIdx.add(pi);
      }
      // O(F²)-Paarschleife in Mikro-Batches: Worker-Event-Loop nicht sekundenlang blockieren.
      if (i % 25 === 24) await new Promise(r => setImmediate(r));
    }
    if (candidatePageIdx.size > 0) {
      const sortedIdx = [...candidatePageIdx].sort((x, y) => x - y);
      const parts = [];
      let total = 0;
      for (const pi of sortedIdx) {
        const p = pageContents[pi];
        const chunk = `## ${p.chapter || 'Sonstige'}\n### ${p.title}\n${p.text}`;
        if (total + chunk.length > singlePassLimit) break;
        parts.push(chunk);
        total += chunk.length;
      }
      if (parts.length > 0) {
        textForPrompt = parts.join('\n\n---\n\n');
        log.info(`Phase 3b Co-Occurrence – ${parts.length} Seiten (${total} Zeichen) aus ${candidatePageIdx.size} Kandidaten.`);
      }
    }
  } catch (e) {
    log.warn(`Phase 3b Co-Occurrence-Auswahl fehlgeschlagen, Fallback auf Trunkierung: ${e.message}`);
  }

  if (!textForPrompt) {
    textForPrompt = fullBookText.length <= singlePassLimit ? fullBookText : fullBookText.slice(0, singlePassLimit);
  }

  const bzResult = await call(jobId, tok,
    prompts.buildKapiteluebergreifendeBeziehungenPrompt(bookName, figuren, textForPrompt),
    sys.SYSTEM_FIGUREN_BLOCKS, 56, 58, komplettMaxTokens(effectiveProvider), 0.2, null, prompts.SCHEMA_BEZIEHUNGEN,
    costTier(COST_LABEL.figuren),
  );
  const newBz = Array.isArray(bzResult?.beziehungen) ? bzResult.beziehungen : [];
  if (newBz.length > 0) addFigurenBeziehungen(bookIdInt, newBz, email, ctx.idMaps);
  log.info(`Phase 3b – ${newBz.length} kapitelübergreifende Beziehungen.`);
}

/** P6: Zeitstrahl aus gespeicherten Events konsolidieren. */
async function runZeitstrahl(ctx, opts = {}) {
  const { jobId, bookIdInt, email, call, tok, log, prompts, sys, idMaps, effectiveProvider } = ctx;
  // silent: keine Progress-/Status-Updates; nötig wenn parallel zu P8 (Claude),
  // damit P8 die Bar exklusiv kontrolliert.
  const silent = !!opts.silent;

  if (!silent) updateJob(jobId, { progress: 78, statusText: 'job.phase.consolidatingTimeline' });
  const rawEvtRows = db.prepare(`
    SELECT f.fig_id, f.name AS fig_name, f.typ AS fig_typ,
           fe.datum, fe.datum_label,
           fe.datum_year, fe.datum_month, fe.datum_day,
           fe.datum_ende_year, fe.datum_ende_month, fe.datum_ende_day,
           fe.story_tag, fe.datum_unsicher, fe.subtyp,
           fe.ereignis, fe.typ AS evt_typ, fe.bedeutung,
           c.chapter_name AS kapitel, p.page_name AS seite
    FROM figure_events fe
    JOIN figures f ON f.id = fe.figure_id
    LEFT JOIN chapters c ON c.chapter_id = fe.chapter_id
    LEFT JOIN pages    p ON p.page_id    = fe.page_id
    WHERE f.book_id = ? AND f.user_email IS ?
    ORDER BY
      COALESCE(fe.datum_year,  9999),
      COALESCE(fe.datum_month, 99),
      COALESCE(fe.datum_day,   99),
      COALESCE(fe.story_tag,   99999),
      f.sort_order
  `).all(bookIdInt, email);
  if (!rawEvtRows.length) return;

  const evtGroupMap = new Map();
  for (const row of rawEvtRows) {
    const key = `${row.datum}||${(row.ereignis || '').trim().toLowerCase()}`;
    if (!evtGroupMap.has(key)) {
      evtGroupMap.set(key, {
        datum: row.datum,
        datum_label:      row.datum_label,
        datum_year:       row.datum_year,
        datum_month:      row.datum_month,
        datum_day:        row.datum_day,
        datum_ende_year:  row.datum_ende_year,
        datum_ende_month: row.datum_ende_month,
        datum_ende_day:   row.datum_ende_day,
        story_tag:        row.story_tag,
        datum_unsicher:   row.datum_unsicher ? true : false,
        subtyp:           row.subtyp || 'sonstiges',
        ereignis: row.ereignis, typ: row.evt_typ,
        bedeutung: row.bedeutung || '',
        kapitel: row.kapitel ? [row.kapitel] : [],
        seiten:  row.seite   ? [row.seite]   : [],
        figuren: [],
      });
    }
    const ev = evtGroupMap.get(key);
    // Sicheres Datum gewinnt: ist eine der zusammengeführten Figuren-Zeilen
    // explizit belegt (datum_unsicher=0), gilt das Gruppen-Event als sicher.
    if (!row.datum_unsicher) ev.datum_unsicher = false;
    if (!ev.figuren.some(f => f.id === row.fig_id))
      ev.figuren.push({ id: row.fig_id, name: row.fig_name, typ: row.fig_typ || 'andere' });
    if (row.kapitel && !ev.kapitel.includes(row.kapitel)) ev.kapitel.push(row.kapitel);
    if (row.seite   && !ev.seiten.includes(row.seite))   ev.seiten.push(row.seite);
  }

  // Strukturierte Sortierung — Events ohne Jahr ans Ende.
  const _sortKey = ev => [
    ev.datum_year  ?? 9999,
    ev.datum_month ?? 99,
    ev.datum_day   ?? 99,
    ev.story_tag   ?? 99999,
  ];
  const zeitstrahlEvents = [...evtGroupMap.values()].sort((a, b) => {
    const ka = _sortKey(a), kb = _sortKey(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return 0;
  });

  // Bei wenigen pre-gegroupeten Events bringt die KI-Konsolidierung fast nichts
  // (Dedup-Chance klein, kanonische Formulierung marginal) – direkt speichern spart
  // einen KI-Call (~2K Input + 3K Output).
  // Obergrenze für die lokale Klasse: die Konsolidierung ist rein kosmetisch (Dedup +
  // kanonische Formulierung), ihr Output wächst aber linear mit der Ereigniszahl. Bei
  // 20-30 tok/s kostet sie ab ein paar hundert Ereignissen zweistellige Minuten für
  // einen Gewinn, den der Fallback-Pfad (pre-gruppierte Events direkt persistieren) fast
  // vollständig mitliefert — und je grösser die Liste, desto wahrscheinlicher reisst sie
  // ohnehin am Output-Cap. Die Cloud-Klasse läuft weiter ohne Deckel (dort ist der Call
  // schnell, parallel zu P8 und günstig). 0 = kein Deckel.
  const localEventCap = providerClass(effectiveProvider) !== 'cloud'
    ? Math.max(0, parseInt(appSettings.get('ai.komplett.timeline_consolidate_max'), 10) || 0)
    : 0;
  const tooMany = localEventCap > 0 && zeitstrahlEvents.length > localEventCap;
  if (zeitstrahlEvents.length < 5 || tooMany) {
    saveZeitstrahlEvents(bookIdInt, email, zeitstrahlEvents, idMaps.chNameToId, idMaps.pageNameToIdByChapter);
    if (tooMany) {
      log.info(`${zeitstrahlEvents.length} Zeitstrahl-Ereignisse direkt gespeichert `
        + `(über dem Deckel ai.komplett.timeline_consolidate_max=${localEventCap} für lokale Modelle) `
        + '– spart einen langen KI-Call, die Ereignisse sind vollständig.');
      ctx.warnings?.push({ key: 'job.warn.timelineConsolidationSkipped', params: { count: zeitstrahlEvents.length } });
    } else {
      log.info(`${zeitstrahlEvents.length} Zeitstrahl-Ereignisse direkt gespeichert (unter Konsolidierungs-Schwelle) – spart einen KI-Call.`);
    }
    if (!silent) updateJob(jobId, { progress: 82 });
    return;
  }

  let ztResult;
  try {
    ztResult = await call(jobId, tok,
      prompts.buildZeitstrahlConsolidationPrompt(zeitstrahlEvents),
      sys.SYSTEM_ZEITSTRAHL_BLOCKS,
      silent ? null : 78, silent ? null : 82,
      komplettMaxTokens(effectiveProvider), 0.2, null, prompts.SCHEMA_ZEITSTRAHL, costTier(COST_LABEL.zeitstrahl),
    );
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    // Die Konsolidierung ist rein kosmetisch (Dedup + kanonische Formulierung) – die
    // Events sind in `zeitstrahlEvents` bereits gruppiert und vollständig. Ein Fehler hier
    // (typisch: aiTruncated bei vielen Events + kleinem lokalem Output-Cap, Parse-Fehler,
    // erschöpfter Retry) darf den gesamten Katalog NICHT verwerfen – Figuren/Orte/Szenen
    // sind längst gespeichert. Fallback: pre-gruppierte Events direkt persistieren.
    log.warn(`Zeitstrahl-Konsolidierung fehlgeschlagen, speichere ${zeitstrahlEvents.length} pre-gruppierte Events direkt: ${e.message}`);
    // Degradierung user-sichtbar machen (wie Soziogramm/Orte/Songs/P3b/P8) — sonst sieht
    // der User nur „done" und kann holistisch-konsolidiert nicht von roh-durchgereicht
    // unterscheiden. Kein Datenverlust (Events bleiben gruppiert + persistiert).
    ctx.warnings?.push({ key: 'job.warn.zeitstrahlDegraded' });
    saveZeitstrahlEvents(bookIdInt, email, zeitstrahlEvents, idMaps.chNameToId, idMaps.pageNameToIdByChapter);
    if (!silent) updateJob(jobId, { progress: 82 });
    return;
  }
  if (Array.isArray(ztResult?.ereignisse)) {
    saveZeitstrahlEvents(bookIdInt, email, ztResult.ereignisse, idMaps.chNameToId, idMaps.pageNameToIdByChapter);
    log.info(`${ztResult.ereignisse.length} Zeitstrahl-Ereignisse gespeichert.`);
  }
  if (!silent) updateJob(jobId, { progress: 82 });
}

module.exports = { runPhase3b, runZeitstrahl };
