'use strict';
// Plot-Werkstatt (Beat-Board): Brainstorm + Consistency als Job-Queue-Operationen.
// Beide Jobs operieren auf dem Board (plot_acts + plot_beats). Rein planend /
// überwachend — es wird NIE Text ins Manuskript geschrieben.

const express = require('express');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  aiCall, getPrompts, getBookPrompts, getFiguren,
  loadOrderedBookContents,
  tps, createJob, enqueueJob, findActiveJobId, jsonBody, _modelName,
} = require('./shared');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');
const { requireBookAccess, sendACLError } = require('../../lib/acl');
const { getContextConfigFor, resolveProvider } = require('../../lib/ai');
const { db } = require('../../db/connection');
const plotDb = require('../../db/plot');
const draftFiguresDb = require('../../db/draft-figures');
const { extractPsychologie } = require('../../lib/draft-mindmap-extract');
const { getLatestContinuityCheck } = require('../../db/schema');

const plotRouter = express.Router();

const SEVERITY = ['kritisch', 'stark', 'mittel', 'schwach', 'niedrig'];

// ── Kontext-Loader ────────────────────────────────────────────────────────────

// Wandelt einen echten Lade-/DB-Fehler aus einem Kontext-Loader in einen
// i18n-Job-Fehler um (Original-Fehler als `cause` für den Log). So failt der Job
// sauber über failJob, statt mit halbem/falschem Board-Bild weiterzulaufen — ein
// leeres Ergebnis (keine Stränge/Figuren) ist kein Fehler und kommt regulär als
// [] zurück, nur ein geworfener Fehler landet hier.
function _plotContextError(source, cause) {
  const err = i18nError('job.error.plot.contextLoadFailed', { source });
  err.cause = cause;
  return err;
}

// Sync-Kontext-Loader in ein einheitliches try/catch wickeln: ein echter Lade-/
// DB-Fehler wird source-annotiert zum i18n-Job-Fehler (statt mit halbem Board-Bild
// weiterzulaufen). Ein leeres Ergebnis (keine Orte/Szenen/…) ist kein Fehler und
// kommt regulär durch. `_anchorContext` (loggt + liefert null) und `_kapitelContext`
// (async) bleiben bewusst mit eigenem Handling.
function _loadCtx(source, fn) {
  try { return fn(); }
  catch (e) { throw _plotContextError(source, e); }
}

// Figuren-Ensemble als Grundierung für beide Jobs — der volle reiche Kontext aus
// getFiguren: Rollen-Meta, Tags, Beschreibung, Beziehungen (Soziogramm) und
// Lebensereignisse (Figuren-Zeitstrahl). getFiguren liefert Beziehungspartner als
// TEXT-fig_id (`mit`); hier auf Namen aufgelöst (id→name aus derselben Liste),
// damit die reinen, frontend-geteilten Prompt-Builder namensbasiert bleiben.
function _figurenContext(bookId, userEmail) {
  const figuren = getFiguren(bookId, userEmail);
  const nameById = {};
  for (const f of figuren) nameById[f.id] = f.name;
  return figuren.map(f => ({
    name: f.name,
    typ: f.typ || null,
    kurzname: f.kurzname || null,
    beschreibung: f.beschreibung || null,
    beruf: f.beruf || null,
    geschlecht: f.geschlecht || null,
    tags: Array.isArray(f.eigenschaften) ? f.eigenschaften : [],
    beziehungen: Array.isArray(f.beziehungen)
      ? f.beziehungen
          .map(b => ({ mit: nameById[b.mit] || null, typ: b.typ || null, beschreibung: b.beschreibung || null }))
          .filter(b => b.mit)
      : [],
    lebensereignisse: Array.isArray(f.lebensereignisse)
      ? f.lebensereignisse.map(e => ({ datum: e.datum || null, ereignis: e.ereignis || null, typ: e.typ || null, kapitel: e.kapitel || null }))
      : [],
  }));
}

// Schauplätze des Buchs (Orte). locations ist keine pages/chapters/books →
// Direkt-SQL erlaubt. Ein Buch ohne Orte liefert regulär []; ein echter DB-Fehler
// failt den Job source-annotiert (statt stillschweigend ohne Orte weiterzulaufen).
function _orteContext(bookId, userEmail) {
  return _loadCtx('orte', () => db.prepare(`
    SELECT name, typ, beschreibung, stimmung
      FROM locations
     WHERE book_id = ? AND user_email = ?
     ORDER BY sort_order, id
  `).all(parseInt(bookId), userEmail).map(o => ({
    name: o.name,
    typ: o.typ || null,
    beschreibung: o.beschreibung || null,
    stimmung: o.stimmung || null,
  })));
}

// Buchweiter Figuren-Zeitstrahl (figure_events, chronologisch nach sort_order)
// mit aufgelöster Figur + Kapitel. figure_events/figures sind keine pages/
// chapters/books → Direkt-SQL erlaubt; chapter_name via JOIN (Anzeige zur Lesezeit).
function _zeitstrahlContext(bookId, userEmail) {
  return _loadCtx('zeitstrahl', () => db.prepare(`
    SELECT fe.datum, fe.ereignis, fe.typ, f.name AS figur, c.chapter_name AS kapitel
      FROM figure_events fe
      JOIN figures f ON f.id = fe.figure_id
      LEFT JOIN chapters c ON c.chapter_id = fe.chapter_id
     WHERE f.book_id = ? AND f.user_email = ?
     ORDER BY fe.sort_order, fe.id
     LIMIT 300
  `).all(parseInt(bookId), userEmail).map(e => ({
    datum: e.datum || null,
    ereignis: e.ereignis,
    typ: e.typ || null,
    figur: e.figur || null,
    kapitel: e.kapitel || null,
  })));
}

// Offene Kontinuitäts-Befunde aus dem letzten Continuity-Check (nur Consistency).
// Erdet den Plot-Check auf bereits bekannte Brüche, statt sie neu zu erfinden.
// Kein Check vorhanden → regulär []; echter DB-Fehler failt den Job.
function _kontinuitaetContext(bookId, userEmail) {
  return _loadCtx('kontinuitaet', () => {
    const check = getLatestContinuityCheck(bookId, userEmail);
    if (!check || !Array.isArray(check.issues)) return [];
    return check.issues
      .filter(i => !i.resolved)
      .map(i => ({
        schwere: i.schwere || null,
        typ: i.typ || null,
        beschreibung: i.beschreibung || null,
        figuren: Array.isArray(i.figuren) ? i.figuren : [],
        kapitel: Array.isArray(i.kapitel) ? i.kapitel : [],
        empfehlung: i.empfehlung || null,
      }));
  });
}

// Verknüpfte Recherche-Fundstücke: alle (nicht archivierten) Recherche-Items, die
// der Autor an einen Plot-Beat ODER Handlungsstrang geknüpft hat — mit aufgelösten
// Beat-Titeln / Strang-Namen für die Prompt-Annotation. research_*/plot_* sind keine
// pages/chapters/books → Direkt-SQL erlaubt. Ein Item kann an mehrere Beats/Stränge
// hängen (M:N), darum gruppiert pro Item. body fällt auf doc_text zurück (Dokument
// ohne eigenen Notiztext). Kein Link/keine Recherche → regulär []; echter DB-Fehler
// failt den Job (statt der KI stillschweigend das gesammelte Material zu unterschlagen).
function _rechercheContext(bookId, userEmail) {
  return _loadCtx('recherche', () => {
    const rows = db.prepare(`
      SELECT ri.id, ri.title, ri.body, ri.source, ri.doc_text,
             ril.target_kind, ril.beat_id, ril.thread_id,
             pb.titel AS beat_titel, pt.name AS thread_name
        FROM research_item_links ril
        JOIN research_items ri ON ri.id = ril.item_id
        LEFT JOIN plot_beats   pb ON pb.id = ril.beat_id
        LEFT JOIN plot_threads pt ON pt.id = ril.thread_id
       WHERE ri.book_id = ? AND ri.user_email = ?
         AND ri.archived = 0
         AND ril.target_kind IN ('beat', 'thread')
       ORDER BY ri.pinned DESC, ri.updated_at DESC, ri.id
    `).all(parseInt(bookId), userEmail);
    const byItem = new Map();
    for (const r of rows) {
      let it = byItem.get(r.id);
      if (!it) {
        it = {
          id: r.id,
          title: r.title || null,
          body: (r.body && r.body.trim()) ? r.body : (r.doc_text || null),
          source: r.source || null,
          beats: [], beatIds: [], threads: [], threadIds: [],
        };
        byItem.set(r.id, it);
      }
      if (r.target_kind === 'beat' && r.beat_id != null) {
        it.beatIds.push(r.beat_id);
        if (r.beat_titel) it.beats.push(r.beat_titel);
      } else if (r.target_kind === 'thread' && r.thread_id != null) {
        it.threadIds.push(r.thread_id);
        if (r.thread_name) it.threads.push(r.thread_name);
      }
    }
    return [...byItem.values()];
  });
}

// Adaptives Kontext-Budget: kleine (lokale) Modelle bekommen knappere Listen,
// damit der Plot-Prompt das Eingabe-Budget nicht sprengt (Truncation-Schutz);
// Claude (200k+) bekommt den vollen Kontext. Schwelle grob am Input-Budget in
// Zeichen des effektiven Providers (Per-User-Override berücksichtigt).
function _ctxLimits(userEmail) {
  let budgetChars = 600000;
  try {
    budgetChars = getContextConfigFor(resolveProvider({ userEmail })).inputBudgetChars || budgetChars;
  } catch { /* Default = grosszügig */ }
  if (budgetChars < 80000) {
    return { figuren: 25, relPerFig: 4, evtPerFig: 0, kapitel: 40, szenen: 30, orte: 15, zeitstrahl: 0, kontinuitaet: 8, recherche: 8 };
  }
  if (budgetChars < 250000) {
    return { figuren: 45, relPerFig: 6, evtPerFig: 4, kapitel: 80, szenen: 70, orte: 30, zeitstrahl: 60, kontinuitaet: 15, recherche: 25 };
  }
  return { figuren: 120, relPerFig: 12, evtPerFig: 10, kapitel: 200, szenen: 150, orte: 60, zeitstrahl: 200, kontinuitaet: 40, recherche: 60 };
}

// Wendet die Figuren-Limits an: Figurenzahl kappen, Beziehungen/Ereignisse pro
// Figur kürzen (auf knappen Modellen Ereignisse ganz weglassen).
function _trimFiguren(figuren, limits) {
  return figuren.slice(0, limits.figuren).map(f => ({
    ...f,
    beziehungen: (f.beziehungen || []).slice(0, limits.relPerFig),
    lebensereignisse: limits.evtPerFig ? (f.lebensereignisse || []).slice(0, limits.evtPerFig) : [],
  }));
}

// Werkstatt-Figuren (Figuren-Werkstatt-Drafts): vorwärts-entwickelte Figuren,
// evtl. noch nicht im Manuskript. Brainstorm kann sie als Beat-Figuren vorschlagen;
// Consistency darf sie als legitime Beat-Referenz erkennen statt sie als
// „unbekannte Figur" zu beanstanden. Angereichert um die psychologischen Kerne der
// Mindmap (Want/Need/Wound/Lie + Bogen + Konflikt) — so kann der Plot Beats
// vorschlagen/prüfen, die den inneren Konflikt der Figur bedienen, statt nur ihren
// Namen zu kennen. Echter DB-Fehler → Job failen (nicht stillschweigend ohne
// Werkstatt-Figuren weiterlaufen).
function _werkstattFigurenContext(bookId, userEmail) {
  return _loadCtx('werkstattFiguren', () => draftFiguresDb.listDraftFigures(bookId, userEmail)
    .map(d => ({ name: d.name, archetype: d.archetype || null, psychologie: extractPsychologie(d.mindmap) })));
}

// Kapitelnamen in echter Buchorganizer-Reihenfolge (über die Content-Store-
// Facade — kein Direkt-SQL auf chapters). Ein Buch ohne Kapitel liefert regulär
// []; ein echter Lade-Fehler failt den Job (statt der KI stillschweigend den
// Kapitel-Kontext zu unterschlagen).
async function _kapitelContext(bookId) {
  try {
    const { chaptersFlat } = await loadOrderedBookContents(bookId, null);
    return (chaptersFlat || []).map(c => c.name);
  } catch (e) {
    throw _plotContextError('kapitel', e);
  }
}

// „Buchrealität" für den Consistency-Check: extrahierte Szenen mit Kapitel +
// beteiligten Figuren. figure_scenes/scene_figures sind keine pages/chapters/
// books → Direkt-SQL erlaubt; chapter_name via JOIN (Anzeige-Wert zur Lesezeit).
function _szenenContext(bookId, userEmail) {
  return _loadCtx('szenen', () => {
    const scenes = db.prepare(`
      SELECT fs.id, fs.titel, c.chapter_name AS kapitel
        FROM figure_scenes fs
        LEFT JOIN chapters c ON c.chapter_id = fs.chapter_id
       WHERE fs.book_id = ? AND fs.user_email = ?
       ORDER BY fs.sort_order, fs.id
       LIMIT 150
    `).all(parseInt(bookId), userEmail);
    if (!scenes.length) return [];
    const figRows = db.prepare(`
      SELECT sf.scene_id, f.name
        FROM scene_figures sf
        JOIN figure_scenes fs ON fs.id = sf.scene_id
        JOIN figures f ON f.id = sf.figure_id
       WHERE fs.book_id = ? AND fs.user_email = ?
    `).all(parseInt(bookId), userEmail);
    const byScene = {};
    for (const r of figRows) (byScene[r.scene_id] = byScene[r.scene_id] || []).push(r.name);
    return scenes.map(s => ({ titel: s.titel, kapitel: s.kapitel, figuren: byScene[s.id] || [] }));
  });
}

// Handlungsstränge (Swimlanes) mit aufgelöster Hauptfigur. Katalog-Bindung über
// die TEXT-fig_id (figures), Werkstatt-Bindung über draft_figures.id. Ein Board
// ohne Stränge liefert regulär [] (flaches Board, opt-in); ein echter DB-Fehler
// failt den Job — sonst würde die KI mit falschem (flachem) statt Strang-Raster-
// Kontext brainstormen/prüfen und der User bekäme stillschweigend schlechtere
// Vorschläge. Der figures-/draft-Lookup ist Anreicherung, schlägt aber auf
// denselben echten Fehler ebenfalls durch (keine stille Teil-Auflösung).
function _threadContext(bookId, userEmail) {
  const { threads, figByFigId, draftById } = _loadCtx('threads', () => {
    const threads = plotDb.listThreads(bookId, userEmail);
    const figByFigId = {}, draftById = {};
    if (threads.length) {
      for (const r of db.prepare('SELECT fig_id, name FROM figures WHERE book_id = ? AND user_email = ?').all(parseInt(bookId), userEmail)) {
        figByFigId[r.fig_id] = r.name;
      }
      for (const d of draftFiguresDb.listDraftFigures(bookId, userEmail)) draftById[d.id] = d.name;
    }
    return { threads, figByFigId, draftById };
  });
  if (!threads.length) return [];
  return threads.map(t => ({
    id: t.id,
    name: t.name,
    figur: t.fig_id ? (figByFigId[t.fig_id] || null)
      : (t.draft_figure_id ? (draftById[t.draft_figure_id] || null) : null),
    // Beats der Lane erben dieses Kapitel implizit, sofern sie kein eigenes haben.
    kapitel: t.chapter_name || null,
  }));
}

// Textbeleg-Verankerung als Consistency-Kontext: der persistierte Ist-Index
// (plot_beat_occurrences, aus dem beat-anchor-Job) als plain object beat_id →
// { count, top[] }. NUR wenn der Index befüllt ist (occTotal > 0) — ein leerer
// Index bedeutet „nie verankert", nicht „nichts im Buch"; dann liefern wir
// anchorMap=null und die Consistency prüft wie bisher gegen den Szenen-Index.
// Best-effort: ein Fehler hier darf den Check nicht failen (Belege sind Beilage).
function _anchorContext(bookId, userEmail) {
  try {
    const map = plotDb.beatOccurrenceMap(bookId, userEmail);
    let occTotal = 0;
    const obj = {};
    for (const [beatId, e] of map) { obj[beatId] = e; occTotal += e.count; }
    if (occTotal === 0) return { anchorMap: null, anchorInfo: {} };
    return { anchorMap: obj, anchorInfo: { stale: plotDb.beatAnchorStale(bookId, userEmail) } };
  } catch (e) {
    require('../../logger').warn(`[plot-consistency] Textbeleg-Kontext übersprungen: ${e.message}`);
    return { anchorMap: null, anchorInfo: {} };
  }
}

// Gemeinsamer Kontext-Block beider Jobs (Brainstorm + Consistency): Buch-Kontext,
// Kontext-Budget und die grundierenden Listen (Figuren, Werkstatt-Figuren, Kapitel,
// Orte, Zeitstrahl, Stränge), bereits auf `limits` gekappt. Recherche bleibt
// job-spezifisch (Brainstorm filtert auf die Zielzelle, Consistency nimmt alles);
// Consistency lädt zusätzlich Szenen/Kontinuität/Textbelege separat.
async function _commonPlotContext(bookId, userEmail) {
  const { BUCH_KONTEXT } = await getBookPrompts(bookId, userEmail);
  const limits = _ctxLimits(userEmail);
  return {
    BUCH_KONTEXT,
    limits,
    figuren: _trimFiguren(_figurenContext(bookId, userEmail), limits),
    werkstattFiguren: _werkstattFigurenContext(bookId, userEmail),
    kapitel: (await _kapitelContext(bookId)).slice(0, limits.kapitel),
    orte: _orteContext(bookId, userEmail).slice(0, limits.orte),
    zeitstrahl: limits.zeitstrahl ? _zeitstrahlContext(bookId, userEmail).slice(0, limits.zeitstrahl) : [],
    threads: _threadContext(bookId, userEmail),
  };
}

// ── Brainstorm-Job ────────────────────────────────────────────────────────────

async function runPlotBrainstormJob(jobId, bookId, actId, threadId, userEmail) {
  const logger = makeJobLogger(jobId);
  const { buildPlotSystemPrompt, buildPlotBrainstormPrompt, SCHEMA_PLOT_BRAINSTORM } = await getPrompts(userEmail);

  try {
    const acts = plotDb.listActs(bookId, userEmail);
    const act = acts.find(a => a.id === actId);
    if (!act) throw i18nError('job.error.plot.actMissing');
    const beats = plotDb.listBeats(bookId, userEmail);

    const { BUCH_KONTEXT, limits, figuren, werkstattFiguren, kapitel, orte, zeitstrahl, threads } =
      await _commonPlotContext(bookId, userEmail);
    const threadInfo = threadId != null ? (threads.find(t => t.id === threadId) || null) : null;
    // Recherche nur für die Zielzelle: Material, das an einen Beat dieses Akts ODER
    // an den Ziel-Strang geknüpft ist — so erden neue Beats auf bereits gesammelte
    // Fakten/Quellen genau zu diesem Abschnitt, ohne fremde Akte einzuschleppen.
    const actBeatIds = new Set(beats.filter(b => b.act_id === actId).map(b => b.id));
    const recherche = _rechercheContext(bookId, userEmail)
      .filter(r => r.beatIds.some(id => actBeatIds.has(id))
        || (threadId != null && r.threadIds.includes(threadId)))
      .slice(0, limits.recherche);

    logger.info(`Plot-Brainstorm Start: book=${bookId} akt="${act.name}"${threadInfo ? ` strang="${threadInfo.name}"` : ''} beats=${beats.length} figuren=${figuren.length} orte=${orte.length} zeitstrahl=${zeitstrahl.length} werkstatt=${werkstattFiguren.length} recherche=${recherche.length}`);
    updateJob(jobId, { statusText: 'job.plot.brainstorm.aiReply', progress: 10 });

    const tok = { in: 0, out: 0, ms: 0 };
    const result = await aiCall(jobId, tok,
      buildPlotBrainstormPrompt(act.name, acts, beats, BUCH_KONTEXT, figuren, kapitel, werkstattFiguren, threads, threadInfo, orte, zeitstrahl, recherche),
      buildPlotSystemPrompt(),
      10, 95, 1500, 0.3, 1500, undefined, SCHEMA_PLOT_BRAINSTORM,
    );

    if (!Array.isArray(result?.vorschlaege)) throw i18nError('job.error.plot.vorschlaegeMissing');
    const vorschlaege = result.vorschlaege
      .filter(v => v && typeof v.label === 'string' && v.label.trim())
      .map(v => ({
        label: v.label.trim(),
        begruendung: typeof v.begruendung === 'string' ? v.begruendung.trim() : '',
      }));

    // Lauf historisieren (nur bei echten Vorschlägen), damit der User frühere
    // Brainstorms später nochmal ansehen + anwenden kann. Best-effort: ein DB-
    // Fehler hier darf das Job-Resultat nicht verschlucken.
    let runId = null;
    if (vorschlaege.length) {
      try {
        runId = plotDb.insertPlotBrainstormRun({
          bookId, userEmail, actId, threadId: threadId ?? null,
          vorschlagCount: vorschlaege.length,
          result: { vorschlaege }, model: _modelName(),
        });
      } catch (e) {
        logger.warn(`Plot-Brainstorm-Run-Insert fehlgeschlagen book=${bookId}: ${e.message}`);
      }
    }

    completeJob(jobId, { vorschlaege, actId, threadId: threadId ?? null, runId, tokensIn: tok.in, tokensOut: tok.out },
      tps(tok), `${vorschlaege.length} Vorschläge für "${act.name}"`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Plot-Brainstorm-Fehler book=${bookId}: ${e.message}${e.cause ? ` (${e.cause.message})` : ''}`, { stack: e.cause?.stack || e.stack });
    failJob(jobId, e);
  }
}

// ── Consistency-Job ───────────────────────────────────────────────────────────

async function runPlotConsistencyJob(jobId, bookId, userEmail) {
  const logger = makeJobLogger(jobId);
  const { buildPlotSystemPrompt, buildPlotConsistencyPrompt, SCHEMA_PLOT_CONSISTENCY } = await getPrompts(userEmail);

  try {
    const acts = plotDb.listActs(bookId, userEmail);
    const beats = plotDb.listBeats(bookId, userEmail);
    if (!beats.length) throw i18nError('job.error.plot.boardEmpty');

    const { BUCH_KONTEXT, limits, figuren, werkstattFiguren, kapitel, orte, zeitstrahl, threads } =
      await _commonPlotContext(bookId, userEmail);
    const szenen = _szenenContext(bookId, userEmail).slice(0, limits.szenen);
    const kontinuitaet = _kontinuitaetContext(bookId, userEmail).slice(0, limits.kontinuitaet);
    // Buchweiter Check: alles an Beats/Stränge geknüpfte Recherche-Material, damit
    // die Prüfung Beats gegen das gesammelte Material abgleichen kann.
    const recherche = _rechercheContext(bookId, userEmail).slice(0, limits.recherche);

    // Textbeleg-Verankerung (Ist-Index gegen das echte Manuskript, aus dem
    // beat-anchor-Job persistiert). Nur mitgeben, wenn der Index BEFÜLLT ist —
    // sonst hiesse „KEIN Textbeleg" bloss „nie gescannt" statt „nicht im Buch"
    // (falsche Drift-Flut). Kein Embedding-Aufwand: reine Wiederverwendung.
    const { anchorMap, anchorInfo } = _anchorContext(bookId, userEmail);
    // Explizite Beat-zu-Beat-Kanten (Kausalität + Setup/Payoff) als Prompt-Kontext,
    // damit die KI Setup/Payoff und Kausalketten strukturell prüfen kann statt sie
    // nur aus der Prosa zu raten. Best-effort — leere Liste ist kein Fehler.
    const relations = _loadCtx('relations', () => plotDb.listBeatRelations(bookId, userEmail));

    logger.info(`Plot-Consistency Start: book=${bookId} beats=${beats.length} szenen=${szenen.length} kapitel=${kapitel.length} orte=${orte.length} zeitstrahl=${zeitstrahl.length} kontinuitaet=${kontinuitaet.length} werkstatt=${werkstattFiguren.length} straenge=${threads.length} recherche=${recherche.length} relationen=${relations.length} textbelege=${anchorMap ? Object.keys(anchorMap).length : 'aus'}`);
    updateJob(jobId, { statusText: 'job.plot.consistency.aiReply', progress: 10 });

    // maxTokens grosszuegig: ein schonungsloser Check ueber alle Beats/Szenen/
    // Straenge produziert leicht 15–40 Konflikte (je beat+schwere+problem+vorschlag).
    // 3000 schnitt die JSON-Antwort regelmaessig mitten im Array ab → Truncation.
    const tok = { in: 0, out: 0, ms: 0 };
    const result = await aiCall(jobId, tok,
      buildPlotConsistencyPrompt(acts, beats, kapitel, szenen, figuren, BUCH_KONTEXT, werkstattFiguren, threads, orte, zeitstrahl, kontinuitaet, recherche, anchorMap, anchorInfo, relations),
      buildPlotSystemPrompt(),
      10, 95, 6000, 0.3, 12000, undefined, SCHEMA_PLOT_CONSISTENCY,
    );

    if (!Array.isArray(result?.konflikte)) throw i18nError('job.error.plot.konflikteMissing');
    if (typeof result.fazit !== 'string') throw i18nError('job.error.plot.fazitMissing');

    // Klickbare Fundstelle je Befund: deterministisch aus dem Verankerungs-Index
    // (nicht aus dem KI-Text), gematcht über den Beat-Titel (gleiche normTitle-
    // Basis wie Frontend + Prompt). Die stärkste Fundstelle des benannten Beats
    // (occ_top[0], vorsortiert nach Score) mit einer page_id → { page_id, page_name }.
    // So springt die Autorin aus dem Befund direkt an die belegende Textstelle.
    const _norm = (s) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
    // Stabile Beat-ID als primärer Anker (überlebt Umbenennungen), Titel als
    // Fallback für Modelle, die den [#…]-Marker nicht zurückgeben, und für Alt-Läufe.
    const validBeatIds = new Set(beats.map(b => b.id));
    const idByTitle = new Map(beats.map(b => [_norm(b.titel), b.id]));
    const belegById = {};
    if (anchorMap) {
      for (const b of beats) {
        const top = (anchorMap[b.id]?.top || []).find(t => t.page_id);
        if (top) belegById[b.id] = { page_id: top.page_id, page_name: top.page_name || null };
      }
    }
    const konflikte = result.konflikte
      .filter(k => k && typeof k.problem === 'string')
      .map(k => {
        const beat = typeof k.beat === 'string' ? k.beat.trim() : '—';
        // beat_id bevorzugen (aufs Board-Subset validiert), sonst Titel → id auflösen.
        const rawId = k.beat_id != null ? parseInt(k.beat_id) : null;
        let beatId = Number.isInteger(rawId) && validBeatIds.has(rawId) ? rawId : null;
        if (beatId == null && beat !== '—') {
          const byTitle = idByTitle.get(_norm(beat));
          if (byTitle != null) beatId = byTitle;
        }
        return {
          beat,
          beat_id: beatId,
          schwere: SEVERITY.includes(k.schwere) ? k.schwere : 'mittel',
          problem: k.problem.trim(),
          vorschlag: typeof k.vorschlag === 'string' ? k.vorschlag.trim() : '',
          fundstelle: (beatId != null ? belegById[beatId] : null) || null,
        };
      });
    const fazit = result.fazit.trim();

    // Lauf historisieren, damit der User die Prüfung später nochmal ansehen kann.
    // Best-effort: ein DB-Fehler hier darf das Job-Resultat nicht verschlucken.
    let runId = null;
    try {
      runId = plotDb.insertPlotConsistencyRun({
        bookId, userEmail, konfliktCount: konflikte.length,
        result: { konflikte, fazit }, model: _modelName(),
      });
    } catch (e) {
      logger.warn(`Plot-Consistency-Run-Insert fehlgeschlagen book=${bookId}: ${e.message}`);
    }

    completeJob(jobId, { konflikte, fazit, runId, tokensIn: tok.in, tokensOut: tok.out },
      tps(tok), `${konflikte.length} Konflikte`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Plot-Consistency-Fehler book=${bookId}: ${e.message}${e.cause ? ` (${e.cause.message})` : ''}`, { stack: e.cause?.stack || e.stack });
    failJob(jobId, e);
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

plotRouter.post('/plot-brainstorm', jsonBody, (req, res) => {
  const bookId = toIntId(req.body?.book_id);
  const actId = toIntId(req.body?.act_id);
  if (!bookId) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  if (!actId)  return res.status(400).json({ error_code: 'ACT_ID_REQUIRED' });
  const userEmail = req.session?.user?.email || null;
  if (!userEmail) return res.status(401).json({ error_code: 'UNAUTHORIZED' });

  setContext({ book: bookId });
  try { requireBookAccess(req, bookId, 'editor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }

  const act = plotDb.getAct(actId);
  if (!act || act.book_id !== bookId || act.user_email !== userEmail) {
    return res.status(404).json({ error_code: 'ACT_NOT_FOUND' });
  }
  // Optionaler Strang (Grid): aufs (Buch, User)-Subset validieren, Fremd/leer → null.
  const threadId = plotDb._validThreadId(bookId, userEmail, toIntId(req.body?.thread_id));

  const entityKey = `${bookId}|brainstorm|${actId}|${threadId || 'none'}`;
  const existing = findActiveJobId('plot-brainstorm', entityKey, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });

  const jobId = createJob('plot-brainstorm', bookId, userEmail, 'job.label.plotBrainstorm', { akt: act.name }, entityKey);
  enqueueJob(jobId, () => runPlotBrainstormJob(jobId, bookId, actId, threadId, userEmail));
  res.json({ jobId });
});

plotRouter.post('/plot-consistency', jsonBody, (req, res) => {
  const bookId = toIntId(req.body?.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  const userEmail = req.session?.user?.email || null;
  if (!userEmail) return res.status(401).json({ error_code: 'UNAUTHORIZED' });

  setContext({ book: bookId });
  try { requireBookAccess(req, bookId, 'editor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }

  const existing = findActiveJobId('plot-consistency', bookId, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });

  const jobId = createJob('plot-consistency', bookId, userEmail, 'job.label.plotConsistency', {}, bookId);
  enqueueJob(jobId, () => runPlotConsistencyJob(jobId, bookId, userEmail));
  res.json({ jobId });
});

module.exports = { plotRouter, runPlotBrainstormJob, runPlotConsistencyJob };
