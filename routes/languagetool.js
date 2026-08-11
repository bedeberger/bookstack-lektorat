'use strict';
// LanguageTool-Proxy (self-hosted).
// Frontend ruft POST /languagetool/check; Server holt URL aus app_settings,
// forwarded an `${url}/v2/check`. Credentials/URL verlassen den Server nicht.
//
// Disabled / no-URL -> 404 { error: 'languagetool_disabled' } (Frontend
// behandelt als "Feature aus", kein Retry).
//
// Chunking: Texte > CHUNK_MAX (50KB) werden in lib/languagetool-chunk.js an
// Paragraph-/Satz-Boundaries gesplittet, parallel mit Pool 4 an LT geschickt
// und mit zurueckgeschobenen Offsets gemerged.
//
// Body-Cap 600 KB (text bis TEXT_MAX 500 KB, JSON-Overhead). LT-Timeout 10s
// pro Chunk; bei Abbruch eines Chunks bricht der gesamte Request mit 408 ab.
// Upstream-Fehler -> 502 mit erstem-fehlerhaften upstream-Status.

const express = require('express');
const logger = require('../logger');
const appSettings = require('../lib/app-settings');
const { toIntId } = require('../lib/validate');
const { setContext } = require('../lib/log-context');
const { getBookLocale } = require('../db/schema');
const { chunkText, adjustMatches, CHUNK_MAX } = require('../lib/languagetool-chunk');
const ltCache = require('../db/languagetool-cache');
const dict = require('../db/user-dictionary');
const { sessionEmail } = require('../lib/acl');

const router = express.Router();
const TEXT_MAX = 500_000;
const PARALLEL = 4;
const UPSTREAM_TIMEOUT_MS = 10_000;

router.post('/check', express.json({ limit: '600kb' }), async (req, res) => {
  const enabled = appSettings.get('languagetool.enabled') === true;
  const url = String(appSettings.get('languagetool.url') || '').replace(/\/$/, '').replace(/\/v2$/i, '');
  if (!enabled || !url) {
    return res.status(404).json({ error: 'languagetool_disabled' });
  }

  const body = req.body || {};
  const text = typeof body.text === 'string' ? body.text : '';
  if (!text) return res.json({ matches: [] });
  if (text.length > TEXT_MAX) {
    return res.status(413).json({ error: 'text_too_large', max: TEXT_MAX });
  }

  const bookId = toIntId(body.bookId);
  if (bookId) setContext({ book: bookId });
  const userEmail = sessionEmail(req);

  // Book ist SSoT fuer Locale: bookId vorhanden -> getBookLocale gewinnt.
  // Body.language nur als Fallback (Aufrufe ohne Buchscope).
  let language = null;
  if (bookId) {
    try { language = getBookLocale(bookId, userEmail); } catch { /* noop */ }
  }
  if (!language) {
    const raw = typeof body.language === 'string' ? body.language.trim() : '';
    language = raw && raw !== 'auto' ? raw : 'auto';
  }

  // Per-Request-Override: Client kann picky:true/false schicken und damit den
  // serverseitigen Default fuer genau diesen Request uebersteuern. Ohne Feld im
  // Body bleibt der globale app_settings-Wert massgeblich (Default = heute).
  const bodyPicky = typeof body.picky === 'boolean' ? body.picky : null;
  const picky = bodyPicky !== null ? bodyPicky : (appSettings.get('languagetool.picky') === true);
  const pageId = toIntId(body.pageId);
  const log = logger.child({ job: 'lt', user: userEmail || '-', book: bookId || '-' });

  // Cache-Lookup: nur wenn pageId gesetzt. Bucheditor (Block-Scope) sendet
  // pageId weiterhin, aber Hash basiert auf dem Block-Text -- d.h. Notebook-
  // und Bucheditor-Caches kollidieren nicht (unterschiedliche Hashes).
  //
  // Dict-Re-Filter auf Cache-Hits: der body_html-basierte Purge in
  // user-dictionary.js#_purgeCacheForWord erwischt Faelle nicht, in denen
  // das Wort beim Add noch nicht in der gespeicherten body_html stand
  // (ungespeicherte Edits im Notebook-Editor: User tippt "Kantifest", LT
  // cached den Match unfilterted, User fuegt Wort zum Dict hinzu BEVOR
  // Autosave gelaufen ist -> Purge findet die Seite nicht -> Cache-Eintrag
  // mit unfiltered Match bleibt fuer immer auf diesem content_hash). Re-Filter
  // ist idempotent: gecached sind bereits gefilterte Matches, ein zweiter Lauf
  // entfernt nur, was seit dem Cache-Write ins Dict gewandert ist.
  const contentHash = pageId ? ltCache.hashText(text) : null;
  if (pageId && contentHash) {
    const cached = ltCache.getCached({ pageId, contentHash, lang: language, picky });
    if (cached) {
      let result = cached;
      if (userEmail) {
        try {
          const dictSet = dict.getCheckSet(userEmail, bookId, language);
          if (dictSet.size) result = dict.filterMatches(cached, dictSet);
        } catch (e) { log.warn(`dict filter on cache hit failed: ${e.message}`); }
      }
      return res.json({ matches: result, language: null, chunks: 0, cached: true });
    }
  }

  const chunks = chunkText(text, CHUNK_MAX);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  const t0 = Date.now();

  try {
    const allMatches = [];
    let languageMeta = null;
    let cursor = 0;
    async function worker() {
      while (cursor < chunks.length) {
        const idx = cursor++;
        const c = chunks[idx];
        const matches = await _callLT(url, c.text, language, picky, ctrl.signal);
        if (idx === 0 && matches.language) languageMeta = matches.language;
        for (const m of adjustMatches(c.offset, matches.matches)) allMatches.push(m);
      }
    }
    const workers = Array.from({ length: Math.min(PARALLEL, chunks.length) }, () => worker());
    await Promise.all(workers);
    allMatches.sort((a, b) => (a.offset || 0) - (b.offset || 0));

    // Custom-Dictionary-Filter: User-Woerter aus den Matches entfernen.
    let filtered = allMatches;
    if (userEmail) {
      try {
        const dictSet = dict.getCheckSet(userEmail, bookId, language);
        if (dictSet.size) filtered = dict.filterMatches(allMatches, dictSet);
      } catch (e) { log.warn(`dict filter failed: ${e.message}`); }
    }

    if (pageId && contentHash) {
      try { ltCache.setCached({ pageId, contentHash, lang: language, picky, matches: filtered }); }
      catch (e) { log.warn(`cache set failed: ${e.message}`); }
    }
    res.json({ matches: filtered, language: languageMeta, chunks: chunks.length });
  } catch (err) {
    const isAbort = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
    if (err && err.upstreamStatus) {
      log.warn(`upstream ${err.upstreamStatus} latency=${Date.now() - t0}ms`);
      return res.status(502).json({ error: 'languagetool_upstream', upstream_status: err.upstreamStatus });
    }
    log.warn(`fetch ${isAbort ? 'TIMEOUT' : err.message} latency=${Date.now() - t0}ms`);
    return res.status(isAbort ? 408 : 502).json({ error: isAbort ? 'languagetool_timeout' : 'languagetool_fetch_failed' });
  } finally {
    clearTimeout(timer);
  }
});

async function _callLT(url, text, language, picky, signal) {
  const params = new URLSearchParams();
  params.set('text', text);
  params.set('language', language);
  if (picky) params.set('level', 'picky');
  const upstream = await fetch(`${url}/v2/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: params.toString(),
    signal,
  });
  if (!upstream.ok) {
    const err = new Error('upstream_error');
    err.upstreamStatus = upstream.status;
    throw err;
  }
  const json = await upstream.json();
  return {
    matches: Array.isArray(json?.matches) ? json.matches : [],
    language: json?.language || null,
  };
}

module.exports = router;
