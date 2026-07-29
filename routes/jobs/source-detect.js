'use strict';
// Quellen-Erkennung: die KI liest den Buchtext und meldet WERKE, die darin lose
// erwaehnt werden, ohne dass ein Quellennachweis gesetzt waere. Der Autor
// uebernimmt die Funde einzeln in seine Bibliothek (→ POST /sources).
//
// ZWEI SCHICHTEN, BEWUSST GETRENNT:
//   1. Das Modell EXTRAHIERT, was im Text steht (Titel, Person, Jahr). Es
//      bekommt kein Schema-Feld fuer Verlag, ISBN oder DOI — siehe Modulkopf
//      von public/js/prompts/sources.js.
//   2. Der Register-Lookup (lib/source-lookup.js#searchWork) BESTAETIGT den Fund
//      und liefert die kanonischen Felder. Kein Treffer heisst nicht „verwerfen",
//      sondern „unbestaetigt" — der Entwurf bleibt, der Autor entscheidet.
//
// KEIN SCHREIBZUGRIFF AUF DEN BUCHTEXT, auch keine Quellen-Marker: wo belegt
// wird, entscheidet allein der Autor im Editor. Der Job liefert stattdessen zu
// jedem Fund die Fundstelle (Seite + woertlicher Satz), damit der Sprung dorthin
// ein Klick ist.

const express = require('express');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  createJob, enqueueJob, findActiveJobId, jsonBody, jobAbortControllers,
  aiCall, getPrompts, getBookPrompts,
  loadOrderedBookContents, loadPageContents,
  groupByChapter, splitGroupsIntoChunks, buildSinglePassBookText,
  SINGLE_PASS_LIMIT, PER_CHUNK_LIMIT, tps,
} = require('./shared');
const { listPoolSources, listSources } = require('../../db/sources');
const { getBookSettings } = require('../../db/schema');
const { parsePersonName } = require('../../lib/bib-parse');
const { searchWork } = require('../../lib/source-lookup');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');
const { requireBookAccess, sendACLError } = require('../../lib/acl');

// Obergrenze fuer die Register-Abfragen eines Laufs. Zwei oeffentliche, kostenlose
// Dienste (Crossref/OpenLibrary) mit bis zu zwei Requests pro Kandidat — ein
// Lauf ueber ein Buch mit hunderten Erwaehnungen darf daraus keinen Sturm machen.
// Was darueber liegt, bleibt unbestaetigt statt ungemeldet (kein stiller Cap:
// die Zahl geht als `lookupSkipped` ans Frontend).
const MAX_LOOKUPS = 40;
// Pause zwischen zwei Register-Abfragen — Hoeflichkeit gegenueber Fremd-Diensten.
const LOOKUP_GAP_MS = 120;
// Laenge des Snippets, mit dem die Fundstelle gesucht wird. Kurz genug, dass
// kleine Abweichungen des Modells nicht schaden, lang genug fuer Eindeutigkeit.
const LOCATE_PROBE_CHARS = 48;

const _sleep = ms => new Promise(r => setTimeout(r, ms));

/** Vergleichsform fuer Titel-Dedup und Fundstellensuche. */
function _norm(s) {
  return String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Ein Modell-Fund → Kandidat in `sources`-naher Form. null, wenn er nichts
 *  benennt (weder Titel noch Person) — das waere ein Verzeichniseintrag ohne
 *  Gegenstand, dieselbe Grenze wie _hasIdentity in routes/sources.js. */
function _normalizeWerk(v, typeMap) {
  if (!v || typeof v !== 'object') return null;
  const title = typeof v.titel === 'string' ? v.titel.replace(/\s+/g, ' ').trim().slice(0, 500) : '';
  const authors = (Array.isArray(v.autoren) ? v.autoren : [])
    .filter(s => typeof s === 'string' && s.trim())
    .slice(0, 20)
    .map(s => parsePersonName(s.trim().slice(0, 200), { natural: true }))
    .filter(Boolean);
  if (!title && !authors.length) return null;

  // Jahr nur als Jahreszahl uebernehmen — das Modell schreibt gelegentlich
  // „1962/1970" oder „um 1962" in das Feld.
  const yearHit = /\b(1[0-9]{3}|2[0-9]{3})\b/.exec(String(v.jahr ?? ''));
  return {
    csl_type: typeMap[v.typ] || 'other',
    title: title || null,
    authors,
    container_title: typeof v.container === 'string' && v.container.trim()
      ? v.container.replace(/\s+/g, ' ').trim().slice(0, 500) : null,
    year: yearHit ? yearHit[1] : null,
    erwaehnung: typeof v.erwaehnung === 'string'
      ? v.erwaehnung.replace(/\s+/g, ' ').trim().slice(0, 300) : '',
  };
}

/** Dedup-Schluessel: Titel + Jahr, ersatzweise Nachname + Jahr (Funde ohne Titel). */
function _dedupKey(c) {
  if (c.title) return `t:${_norm(c.title)}|${c.year || ''}`;
  const fam = c.authors.map(a => _norm(a.family || a.literal)).sort().join('+');
  return `a:${fam}|${c.year || ''}`;
}

/** Fundstelle bestimmen: die Seite, deren Text den woertlichen Satz enthaelt.
 *  Rein deterministisch — das Modell nennt keine Seiten-ID, es zitiert nur, und
 *  ein Zitat laesst sich nachschlagen. Kein Treffer → null (die Erwaehnung wird
 *  trotzdem angezeigt, nur ohne Sprungziel). */
function _locatePage(snippet, pageContents) {
  const probe = _norm(snippet).slice(0, LOCATE_PROBE_CHARS);
  if (probe.length < 12) return null;
  for (const p of pageContents) {
    if (_norm(p.text).includes(probe)) {
      return { page_id: p.id, page_name: p.title || null, chapter_name: p.chapter || null };
    }
  }
  return null;
}

/** Kandidat gegen die Bibliothek des Users abgleichen. Trifft er einen
 *  vorhandenen Eintrag, wird er nicht verworfen, sondern markiert — die Karte
 *  zeigt „steht schon in der Bibliothek" statt ihn stillschweigend zu schlucken
 *  (der Autor sieht dann, dass die Stelle belegbar waere). */
function _matchExisting(c, poolIndex) {
  const byTitle = c.title ? poolIndex.get(`t:${_norm(c.title)}`) : null;
  return byTitle || null;
}

async function runSourceDetectJob(jobId, bookId, userEmail, { chapterId = null } = {}) {
  const logger = makeJobLogger(jobId);
  const prompts = await getPrompts();
  const {
    buildSourceDetectSystemPrompt, buildSourceDetectPrompt,
    SCHEMA_SOURCE_DETECT, SOURCE_DETECT_TYPES,
  } = prompts;
  try {
    const signal = () => jobAbortControllers.get(jobId)?.signal;

    updateJob(jobId, { statusText: 'job.phase.sourceDetectCollect', progress: 5 });
    const { chMap, chaptersFlat, pages } = await loadOrderedBookContents(bookId, null);

    // Kapitel-Scope schliesst Unterkapitel ein — dieselbe Lesart wie beim
    // Kapitel-Review; ein Kapitel ohne seine Unterkapitel ist kein Kapitel.
    let scopePages = pages;
    if (chapterId != null) {
      const wanted = new Set([chapterId]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const c of chaptersFlat) {
          if (!wanted.has(c.id) && c.parent_id != null && wanted.has(c.parent_id)) { wanted.add(c.id); grew = true; }
        }
      }
      scopePages = pages.filter(p => p.chapter_id != null && wanted.has(p.chapter_id));
      if (!scopePages.length) throw i18nError('job.error.sourceDetectNoChapterText');
    }

    const pageContents = await loadPageContents(scopePages, chMap, 1, null, null, signal());
    if (!pageContents.some(p => p.text)) throw i18nError('job.error.sourceDetectNoText');

    // Bibliothek des Users: liefert die „nicht erneut melden"-Liste fuer den
    // Prompt UND den Abgleich danach. Der Pool, nicht die Buchliste — eine
    // Quelle, die in einer anderen Arbeit liegt, ist trotzdem schon erfasst;
    // sie muss dann nur noch diesem Buch zugeordnet werden.
    const pool = listPoolSources(userEmail, { includeArchived: true });
    const poolIndex = new Map();
    for (const s of pool) if (s.title) poolIndex.set(`t:${_norm(s.title)}`, s);
    const bekannteTitel = pool.map(s => s.title).filter(Boolean);
    // Erfasst heisst nicht zugeordnet: liegt das Werk in einer anderen Arbeit
    // des Users, fehlt hier nur die Bruecke — dann ist die richtige Handlung
    // „zuordnen", nicht „neu anlegen" (das gaebe eine Dublette im Pool).
    const linkedIds = new Set(listSources(bookId, { includeArchived: true }).map(s => s.id));

    const settings = getBookSettings(bookId, userEmail);
    const { BUCH_KONTEXT } = await getBookPrompts(bookId, userEmail);
    const systemPrompt = buildSourceDetectSystemPrompt();

    const tok = { in: 0, out: 0, ms: 0 };
    const kandidaten = [];
    // Nur Dedup INNERHALB des Laufs (dasselbe Werk in mehreren Kapiteln). Gegen
    // die Bibliothek wird NICHT vorgefiltert: ein bereits erfasstes Werk wird
    // markiert und angezeigt (_matchExisting) statt geschluckt — die Aussage
    // „diese Stelle waere belegbar" ist der eigentliche Wert des Fundes.
    const seen = new Set();

    function consume(werke) {
      for (const w of Array.isArray(werke) ? werke : []) {
        const c = _normalizeWerk(w, SOURCE_DETECT_TYPES);
        if (!c) continue;
        const key = _dedupKey(c);
        if (seen.has(key)) continue;
        seen.add(key);
        kandidaten.push(c);
      }
    }

    async function detectChunk(text, from, to) {
      const result = await aiCall(jobId, tok,
        buildSourceDetectPrompt(text, bekannteTitel, BUCH_KONTEXT, settings?.buchtyp || null),
        systemPrompt, from, to, 2000, 0.15, 2000, undefined, SCHEMA_SOURCE_DETECT,
      );
      // Pflichtfeld: fehlt `werke`, hat der Provider nicht geantwortet wie
      // verlangt — das ist ein Fehler, kein leeres Ergebnis. Ein leeres ARRAY
      // dagegen ist gueltig (Text ohne Werkerwaehnungen).
      if (!Array.isArray(result?.werke)) throw i18nError('job.error.sourceDetectMissing');
      consume(result.werke);
    }

    const totalChars = pageContents.reduce((s, p) => s + (p.text ? p.text.length : 0), 0);
    const { groupOrder, groups } = groupByChapter(pageContents);
    const AI_TO = 85;

    if (totalChars <= SINGLE_PASS_LIMIT) {
      logger.info(`Quellen-Erkennung Single-Pass: book=${bookId} text=${totalChars} Zeichen, Bibliothek=${pool.length}`);
      updateJob(jobId, { statusText: 'job.phase.sourceDetectScan', progress: 12 });
      await detectChunk(buildSinglePassBookText(groups, groupOrder), 12, AI_TO);
    } else {
      const { chunkOrder, chunks } = splitGroupsIntoChunks(groups, groupOrder, PER_CHUNK_LIMIT);
      logger.info(`Quellen-Erkennung Multi-Pass: book=${bookId} text=${totalChars} Zeichen, ${chunkOrder.length} Chunks`);
      for (let i = 0; i < chunkOrder.length; i++) {
        if (signal()?.aborted) break;
        const key = chunkOrder[i];
        const from = 12 + Math.floor((i / chunkOrder.length) * (AI_TO - 12));
        const to = 12 + Math.floor(((i + 1) / chunkOrder.length) * (AI_TO - 12));
        updateJob(jobId, {
          statusText: 'job.phase.sourceDetectChunk',
          statusParams: { done: i + 1, total: chunkOrder.length },
          progress: from,
        });
        await detectChunk(buildSinglePassBookText(new Map([[key, chunks.get(key)]]), [key]), from, to);
      }
    }

    // ── Anreicherung: Fundstelle + Register ──────────────────────────────────
    let verified = 0, lookupSkipped = 0, lookupsDone = 0;
    const vorschlaege = [];
    for (let i = 0; i < kandidaten.length; i++) {
      if (signal()?.aborted) break;
      const c = kandidaten[i];
      const existing = _matchExisting(c, poolIndex);
      const item = {
        ...c,
        ...( _locatePage(c.erwaehnung, pageContents) || { page_id: null, page_name: null, chapter_name: null }),
        publisher: null, place: null, edition: null, volume: null, issue: null, pages: null,
        doi: null, isbn: null, issn: null, url: null,
        verified: false, register: null,
        existing_source_id: existing ? existing.id : null,
        existing_linked: existing ? linkedIds.has(existing.id) : false,
      };

      // Bereits erfasste Werke brauchen keinen Register-Request — sie werden
      // nicht uebernommen, sondern nur gemeldet.
      if (!existing) {
        if (lookupsDone >= MAX_LOOKUPS) {
          lookupSkipped++;
        } else {
          lookupsDone++;
          updateJob(jobId, {
            statusText: 'job.phase.sourceDetectLookup',
            statusParams: { done: i + 1, total: kandidaten.length },
            progress: AI_TO + Math.floor(((i + 1) / Math.max(1, kandidaten.length)) * (98 - AI_TO)),
          });
          try {
            const hit = await searchWork(c);
            if (hit) {
              // Registerdaten gewinnen ueber die Textlesart — aber nur, wo sie
              // etwas liefern: ein leeres Registerfeld darf die Angabe aus dem
              // Text nicht loeschen.
              for (const [k, v] of Object.entries(hit.draft)) {
                if (v != null && !(Array.isArray(v) && !v.length)) item[k] = v;
              }
              item.verified = true;
              item.register = hit.register;
              verified++;
            }
          } catch (e) {
            // Register nicht erreichbar → unbestaetigt weiterreichen. Non-fatal,
            // dieselbe Haltung wie beim Geocoding und bei veraPDF.
            logger.warn(`Register-Lookup fehlgeschlagen (${c.title || '?'}): ${e.message}`);
          }
          await _sleep(LOOKUP_GAP_MS);
        }
      }
      vorschlaege.push(item);
    }

    const scopeName = chapterId != null ? (chMap[chapterId] || null) : null;
    logger.info(
      `Quellen-Erkennung fertig: book=${bookId}${scopeName ? ` kapitel="${scopeName}"` : ''} `
      + `funde=${vorschlaege.length} bestaetigt=${verified} `
      + `bekannt=${vorschlaege.filter(v => v.existing_source_id).length} lookupSkipped=${lookupSkipped}`,
    );

    completeJob(jobId, {
      vorschlaege, verified, lookupSkipped, scopeName,
      tokensIn: tok.in, tokensOut: tok.out,
    }, tps(tok), `${vorschlaege.length} Funde`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Quellen-Erkennung Fehler book=${bookId}: ${e.message}`, { stack: e.cause?.stack || e.stack });
    failJob(jobId, e);
  }
}

const sourceDetectRouter = express.Router();

sourceDetectRouter.post('/source-detect', jsonBody, (req, res) => {
  const book_id = toIntId(req.body?.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: book_id });
  // 'editor' statt 'lektor': das Ergebnis fuehrt zu Schreibzugriffen auf die
  // Buch-Quellenzuordnung (POST /sources), und genau die verlangt /sources auch.
  try { requireBookAccess(req, book_id, 'editor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }
  const userEmail = req.session?.user?.email || null;
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });

  const chapterId = req.body?.chapter_id == null || req.body.chapter_id === ''
    ? null : toIntId(req.body.chapter_id);
  if (req.body?.chapter_id && !chapterId) return res.status(400).json({ error_code: 'INVALID_ID' });

  const existing = findActiveJobId('source-detect', book_id, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });

  const jobId = createJob('source-detect', book_id, userEmail, 'job.label.sourceDetect', null, book_id);
  enqueueJob(jobId, () => runSourceDetectJob(jobId, book_id, userEmail, { chapterId }));
  res.json({ jobId });
});

module.exports = { sourceDetectRouter, runSourceDetectJob };
