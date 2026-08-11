'use strict';
// Geocode-Resolve-Job (KI-first): normalisiert beschreibende/fiktive Schauplatz-
// Labels der Orte-Karte auf eine praezise reale Anfrage (Toponym + Laendercode)
// und geocodet diese. Laeuft VOR dem externen Geocoder, weil dieser auf rohe
// Labels («Badi Olten») oft Fehltreffer liefert. Rein rueckwaertsgewandt (liest
// bestehende Ortslabels, kein Buchtext-Generieren). KI-Call laeuft als Job →
// Token-/Statistik-Tracking via aiCall.
//
// Kontext fuers Disambiguieren (alles optional): Buch-Land (schauplatz_land),
// Buch-Kontext-Freitext (buch_kontext) und die Wohnadressen der mit dem Ort
// verknuepften Figuren (location_figures → figures.wohnadresse).
const express = require('express');
const { db, getBookSettings } = require('../../db/schema');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  aiCall, getPrompts, tps,
  createJob, enqueueJob, findActiveJobId, jsonBody,
  jobAbortControllers,
} = require('./shared');
const { geocode } = require('../../lib/geocode');
const { NOW_ISO_SQL } = require('../../db/now');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');
const { sessionEmail } = require('../../lib/acl');

const geocodeRouter = express.Router();
const MAX_ITEMS = 200;
const BOOK_CONTEXT_MAX = 400;
const MAX_HINTS_PER_ITEM = 3;

// KI-Resultat → Map(idStr → { ort, land }). `ort` leer = kein realer Anker (rein
// fiktiv) — bewusst BEHALTEN, damit der Cache (geo_query='') die KI bei einem
// Re-Run nicht erneut nach demselben fiktiven Label fragt; der Geocode-Schritt
// ueberspringt leere Anker. land nur als gueltiger ISO-2-Code.
function _parseResolved(result) {
  const map = new Map();
  const arr = Array.isArray(result?.orte) ? result.orte : [];
  for (const r of arr) {
    if (!r || r.id == null) continue;
    const ort = String(r.ort || '').trim();
    const land = /^[A-Za-z]{2}$/.test(String(r.land || '').trim()) ? String(r.land).trim().toLowerCase() : null;
    map.set(String(r.id), { ort, land });
  }
  return map;
}

// Persistierte Aufloesungen (geo_query/geo_land) der angefragten Orte laden →
// Map(loc_idStr → { ort, land }). Nur Rows mit gesetztem geo_query (NULL = nie
// aufgeloest). `ort` kann '' sein (fiktiv, kein Anker). Per Umbenennung wird der
// Cache im Schreibpfad genullt, daher ist ein Treffer hier fuer das aktuelle
// Label gueltig.
function _loadResolved(locIds, bookId, userEmail) {
  const map = new Map();
  if (!locIds.length || !bookId) return map;
  const emailCond = userEmail ? 'user_email = ?' : 'user_email IS NULL';
  const emailVal = userEmail ? [userEmail] : [];
  const ph = locIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT loc_id, geo_query, geo_land FROM locations
      WHERE book_id = ? AND ${emailCond} AND loc_id IN (${ph}) AND geo_query IS NOT NULL`
  ).all(bookId, ...emailVal, ...locIds);
  for (const r of rows) {
    const land = /^[A-Za-z]{2}$/.test(String(r.geo_land || '').trim()) ? String(r.geo_land).trim().toLowerCase() : null;
    map.set(String(r.loc_id), { ort: String(r.geo_query || ''), land });
  }
  return map;
}

// Frisch aufgeloeste Toponyme zuruckschreiben (Cache fuer den naechsten Lauf).
function _persistResolved(entries, bookId, userEmail) {
  if (!entries.length || !bookId) return;
  const emailCond = userEmail ? 'user_email = ?' : 'user_email IS NULL';
  const emailVal = userEmail ? [userEmail] : [];
  const stmt = db.prepare(
    `UPDATE locations SET geo_query = ?, geo_land = ?
      WHERE book_id = ? AND ${emailCond} AND loc_id = ?`
  );
  db.transaction(() => {
    for (const { id, ort, land } of entries) stmt.run(ort, land || null, bookId, ...emailVal, String(id));
  })();
}

// Gefundene Koordinaten direkt persistieren — der Job ist die SSoT der Verortung,
// NICHT der Client. Analog _persistResolved (gleiches user_email/loc_id-Scope).
// Why: lat/lng nur als Job-Result zurueckzugeben und auf einen Frontend-saveOrte
// zu vertrauen ist fragil — ein fehlender/fehlgeschlagener Save (ACL: Geocoden
// braucht 'lektor', saveOrte 'editor'; Wegnavigieren bei langem Batch; still
// geschluckter PUT-Fehler) liesse die gefundene Verortung verschwinden, obwohl
// der teure KI- + Geocoder-Lauf schon gelaufen ist. Das Frontend spiegelt die
// Werte nur noch in-memory und darf KEIN saveOrte mehr ausloesen (ein Full-Replace
// mit dem alten coord-losen Array wuerde diese Coords via clearedCoords-Heuristik
// in saveOrteToDb sofort wieder nullen).
function _persistCoords(entries, bookId, userEmail) {
  if (!entries.length || !bookId) return;
  const emailCond = userEmail ? 'user_email = ?' : 'user_email IS NULL';
  const emailVal = userEmail ? [userEmail] : [];
  const stmt = db.prepare(
    `UPDATE locations SET lat = ?, lng = ?, updated_at = ${NOW_ISO_SQL}
      WHERE book_id = ? AND ${emailCond} AND loc_id = ?`
  );
  db.transaction(() => {
    for (const { id, lat, lng } of entries) stmt.run(lat, lng, bookId, ...emailVal, String(id));
  })();
}

// Wohnadressen der mit den Orten verknuepften Figuren → Map(loc_id → [adr]).
// Soft-Hinweis fuers Disambiguieren (z.B. gleichnamige Orte); die KI gewichtet,
// der geografische Anker des Labels selbst hat im Prompt Vorrang.
// Das Frontend identifiziert Orte ueber loc_id (TEXT); location_figures.location_id
// referenziert aber den Integer-PK locations.id → erst loc_id → id mappen.
function _figureHints(locIds, bookId, userEmail) {
  const byLoc = new Map();
  if (!locIds.length || !bookId) return byLoc;
  const emailCond = userEmail ? 'user_email = ?' : 'user_email IS NULL';
  const emailVal = userEmail ? [userEmail] : [];
  const locPlaceholders = locIds.map(() => '?').join(',');
  const locRows = db.prepare(
    `SELECT id, loc_id FROM locations
      WHERE book_id = ? AND ${emailCond} AND loc_id IN (${locPlaceholders})`
  ).all(bookId, ...emailVal, ...locIds);
  if (!locRows.length) return byLoc;
  const pkToLocId = new Map(locRows.map(r => [r.id, r.loc_id]));
  const pks = locRows.map(r => r.id);
  const placeholders = pks.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT lf.location_id AS lid, f.wohnadresse AS wohn
       FROM location_figures lf JOIN figures f ON f.id = lf.figure_id
      WHERE lf.location_id IN (${placeholders})
        AND f.wohnadresse IS NOT NULL AND TRIM(f.wohnadresse) != ''`
  ).all(...pks);
  for (const r of rows) {
    const locId = pkToLocId.get(r.lid);
    if (!locId) continue;
    if (!byLoc.has(locId)) byLoc.set(locId, []);
    const list = byLoc.get(locId);
    const v = String(r.wohn).trim();
    if (list.length < MAX_HINTS_PER_ITEM && !list.includes(v)) list.push(v);
  }
  return byLoc;
}

async function runGeocodeResolveJob(jobId, items, bookId, userEmail) {
  const logger = makeJobLogger(jobId);
  try {
    logger.info(`Geocode-Resolve: ${items.length} Label(s)`);
    updateJob(jobId, { statusText: 'job.phase.geocodeResolving', progress: 10 });
    const settings = bookId ? getBookSettings(bookId, userEmail) : null;
    const language = settings?.language || 'de';
    const region = settings?.schauplatz_land || null;
    const bookContext = (settings?.buch_kontext || '').trim().slice(0, BOOK_CONTEXT_MAX) || null;

    // Schon aufgeloeste Labels aus dem Cache nehmen; nur die offenen an die KI.
    const resolved = _loadResolved(items.map(it => it.id), bookId, userEmail);
    const toResolve = items.filter(it => !resolved.has(String(it.id)));

    const tok = { in: 0, out: 0, ms: 0 };
    if (toResolve.length) {
      const hintsByLoc = _figureHints(toResolve.map(it => it.id), bookId, userEmail);
      const { buildSystemGeocodeResolve, buildGeocodeResolvePrompt, SCHEMA_GEOCODE_RESOLVE } = await getPrompts();
      const promptItems = toResolve.map(it => ({
        id: String(it.id),
        name: it.name,
        hints: hintsByLoc.get(it.id) || [],
      }));
      // Output skaliert mit der Label-Anzahl: pro Label ein { id, ort, land }-Objekt
      // (~30 Output-Tokens). Statischer Cap truncated sonst grosse Batches still.
      const maxOut = 800 + promptItems.length * 60;
      const expectedChars = Math.max(1200, promptItems.length * 70);
      const result = await aiCall(jobId, tok,
        buildGeocodeResolvePrompt(promptItems, { region, bookContext }),
        buildSystemGeocodeResolve(),
        10, 60, expectedChars, 0.3, maxOut, undefined, SCHEMA_GEOCODE_RESOLVE,
      );
      if (!Array.isArray(result?.orte)) throw i18nError('job.error.geocodeOrteMissing');
      const fresh = _parseResolved(result);
      const toPersist = [];
      for (const [id, v] of fresh) { resolved.set(id, v); toPersist.push({ id, ort: v.ort, land: v.land }); }
      _persistResolved(toPersist, bookId, userEmail);
    } else {
      logger.info('Alle Labels aus Cache aufgeloest — KI uebersprungen.');
    }

    updateJob(jobId, { statusText: 'job.phase.geocodeLookup', progress: 65 });
    const signal = jobAbortControllers.get(jobId)?.signal;
    // Identische (Toponym + effektive Region) nur EINMAL geocodieren — viele Szenen
    // teilen sich denselben realen Ort. Spart externe Calls (auf Public-Nominatim
    // je ≥1.1 s serialisiert).
    const lookupCache = new Map();
    const results = [];
    for (const it of items) {
      const r = resolved.get(String(it.id));
      // Kein Eintrag oder leerer Anker (rein fiktiv) → unverortet, kein Geocoder-Call.
      if (!r || !r.ort) { results.push({ id: it.id, lat: null, lng: null }); continue; }
      const effRegion = r.land || region;
      const key = `${r.ort} ${effRegion || ''}`;
      if (!lookupCache.has(key)) {
        // Abbruch (User-Cancel) nicht bis zum letzten Label durchlaufen.
        if (signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
        const cands = await geocode(r.ort, { lang: language, region: effRegion });
        const c = cands[0];
        lookupCache.set(key, c ? { lat: c.lat, lng: c.lng, displayName: c.displayName } : null);
      }
      const c = lookupCache.get(key);
      results.push(c
        ? { id: it.id, lat: c.lat, lng: c.lng, displayName: c.displayName, ort: r.ort, land: r.land || null }
        : { id: it.id, lat: null, lng: null, ort: r.ort, land: r.land || null });
    }

    // Treffer serverseitig persistieren (SSoT) — Frontend spiegelt nur noch.
    _persistCoords(
      results.filter(r => r.lat != null && r.lng != null).map(r => ({ id: r.id, lat: r.lat, lng: r.lng })),
      bookId, userEmail,
    );

    const hits = results.filter(r => r.lat != null).length;
    const cached = items.length - toResolve.length;
    completeJob(jobId, { results, tokensIn: tok.in, tokensOut: tok.out },
      tps(tok), `${hits}/${items.length} verortet${cached ? `, ${cached} aus Cache` : ''}`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Geocode-Resolve Fehler: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

geocodeRouter.post('/geocode-resolve', jsonBody, (req, res) => {
  const book_id = toIntId(req.body?.book_id);
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  // id ist die loc_id (TEXT, vom Frontend als o.id geliefert), KEIN Integer-PK.
  const items = (Array.isArray(req.body?.items) ? req.body.items : [])
    .map(it => ({ id: String(it?.id ?? '').trim(), name: String(it?.name || '').trim() }))
    .filter(it => it.id && it.name)
    .slice(0, MAX_ITEMS);
  if (!items.length) return res.status(400).json({ error_code: 'ITEMS_REQUIRED' });
  setContext({ book: book_id });
  {
    const { requireBookAccess, sendACLError } = require('../../lib/acl');
    try { requireBookAccess(req, book_id, 'lektor'); }
    catch (e) { if (sendACLError(res, e)) return; throw e; }
  }
  const userEmail = sessionEmail(req);
  const entityKey = `${book_id}|${items.map(i => i.id).sort().join(',')}`;
  const existing = findActiveJobId('geocode-resolve', entityKey, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const jobId = createJob('geocode-resolve', book_id, userEmail,
    'job.label.geocodeResolve', { count: items.length }, entityKey);
  enqueueJob(jobId, () => runGeocodeResolveJob(jobId, items, book_id, userEmail));
  res.json({ jobId });
});

module.exports = { geocodeRouter, runGeocodeResolveJob, _persistCoords };
