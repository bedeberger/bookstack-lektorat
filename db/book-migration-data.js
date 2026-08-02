'use strict';

// Optionale Extra-Daten fuer die Buch-Migration (.swbook v2): Komplettanalyse-
// Entities, gespeicherte Lektorats-Checks und Chat-Verlaeufe. Kernformat
// (Pages/Kapitel/Settings) bleibt in lib/book-bundle.js — hier liegt nur das,
// was direkten DB-Zugriff braucht (zu viele Tabellen fuer eine pure Facade).
//
//   collectExtras(bookId, { analysis, lektorat, chats })  → plain JSON
//   restoreExtras(bookId, extras, maps, importerEmail)    → counts
//
// `maps` = { pageIdMap: Map<srcPageId,newPageId>, chapterIdMap: Map<...> } —
// gefuellt vom Import-Worker beim Anlegen der Seiten/Kapitel. Alle uebrigen
// Entity-IDs (figures/locations/scenes/songs/storylines/events/checks/issues)
// werden hier waehrend des Inserts remapped. `user_email` aller Zeilen wird auf
// den importierenden User gesetzt — Owner nach Import = Importer, und es haelt
// die app_users-FK gueltig (Quell-User existiert auf der Zielinstanz evtl. nicht).

const { db } = require('./connection');
// Bundles aus fremden Instanzen können Alt-Zeilen mit 0-Platzhaltern statt NULL
// in den Datumsspalten tragen (siehe lib/datum-parse#normalizeDatumFields) —
// beim Import bereinigen, sonst wandert der Defekt mit dem Buch mit.
const { normalizeDatumFields } = require('../lib/datum-parse');

function _now() { return new Date().toISOString(); }

// ── Collect ───────────────────────────────────────────────────────────────────

function _all(sql, ...args) { return db.prepare(sql).all(...args); }

// JOIN-Scoping auf book_id fuer Bridge-/Kind-Tabellen ohne eigene book_id-Spalte.
function collectAnalysis(bookId) {
  return {
    figures:               _all('SELECT * FROM figures WHERE book_id = ?', bookId),
    figureTags:            _all('SELECT ft.* FROM figure_tags ft JOIN figures f ON f.id = ft.figure_id WHERE f.book_id = ?', bookId),
    figureRelations:       _all('SELECT * FROM figure_relations WHERE book_id = ?', bookId),
    figureAppearances:     _all('SELECT fa.* FROM figure_appearances fa JOIN figures f ON f.id = fa.figure_id WHERE f.book_id = ?', bookId),
    figureEvents:          _all('SELECT fe.* FROM figure_events fe JOIN figures f ON f.id = fe.figure_id WHERE f.book_id = ?', bookId),
    pageFigureMentions:    _all('SELECT pfm.* FROM page_figure_mentions pfm JOIN figures f ON f.id = pfm.figure_id WHERE f.book_id = ?', bookId),
    locations:             _all('SELECT * FROM locations WHERE book_id = ?', bookId),
    locationFigures:       _all('SELECT lf.* FROM location_figures lf JOIN locations l ON l.id = lf.location_id WHERE l.book_id = ?', bookId),
    locationChapters:      _all('SELECT lc.* FROM location_chapters lc JOIN locations l ON l.id = lc.location_id WHERE l.book_id = ?', bookId),
    scenes:                _all('SELECT * FROM figure_scenes WHERE book_id = ?', bookId),
    sceneFigures:          _all('SELECT sf.* FROM scene_figures sf JOIN figure_scenes s ON s.id = sf.scene_id WHERE s.book_id = ?', bookId),
    sceneLocations:        _all('SELECT sl.* FROM scene_locations sl JOIN figure_scenes s ON s.id = sl.scene_id WHERE s.book_id = ?', bookId),
    songs:                 _all('SELECT * FROM songs WHERE book_id = ?', bookId),
    songFigures:           _all('SELECT sf.* FROM song_figures sf JOIN songs s ON s.id = sf.song_id WHERE s.book_id = ?', bookId),
    songChapters:          _all('SELECT sc.* FROM song_chapters sc JOIN songs s ON s.id = sc.song_id WHERE s.book_id = ?', bookId),
    songScenes:            _all('SELECT ss.* FROM song_scenes ss JOIN songs s ON s.id = ss.song_id WHERE s.book_id = ?', bookId),
    worldFacts:            _all('SELECT * FROM world_facts WHERE book_id = ?', bookId),
    worldFactChapters:     _all('SELECT wfc.* FROM world_fact_chapters wfc JOIN world_facts wf ON wf.id = wfc.fact_id WHERE wf.book_id = ?', bookId),
    storylines:            _all('SELECT * FROM storylines WHERE book_id = ?', bookId),
    zeitstrahlEvents:      _all('SELECT * FROM zeitstrahl_events WHERE book_id = ?', bookId),
    zeitstrahlEventChapters: _all('SELECT zec.* FROM zeitstrahl_event_chapters zec JOIN zeitstrahl_events ze ON ze.id = zec.event_id WHERE ze.book_id = ?', bookId),
    zeitstrahlEventPages:  _all('SELECT zep.* FROM zeitstrahl_event_pages zep JOIN zeitstrahl_events ze ON ze.id = zep.event_id WHERE ze.book_id = ?', bookId),
    zeitstrahlEventFigures: _all('SELECT zef.* FROM zeitstrahl_event_figures zef JOIN zeitstrahl_events ze ON ze.id = zef.event_id WHERE ze.book_id = ?', bookId),
    continuityChecks:      _all('SELECT * FROM continuity_checks WHERE book_id = ?', bookId),
    continuityIssues:      _all('SELECT * FROM continuity_issues WHERE book_id = ?', bookId),
    continuityIssueFigures: _all('SELECT cif.* FROM continuity_issue_figures cif JOIN continuity_issues ci ON ci.id = cif.issue_id WHERE ci.book_id = ?', bookId),
    continuityIssueChapters: _all('SELECT cic.* FROM continuity_issue_chapters cic JOIN continuity_issues ci ON ci.id = cic.issue_id WHERE ci.book_id = ?', bookId),
    ideen:                 _all('SELECT * FROM ideen WHERE book_id = ?', bookId),
  };
}

function collectLektorat(bookId) {
  return {
    pageChecks: _all('SELECT pc.* FROM page_checks pc JOIN pages p ON p.page_id = pc.page_id WHERE p.book_id = ?', bookId),
  };
}

function collectChats(bookId) {
  return {
    sessions: _all('SELECT * FROM chat_sessions WHERE book_id = ?', bookId),
    messages: _all('SELECT cm.* FROM chat_messages cm JOIN chat_sessions cs ON cs.id = cm.session_id WHERE cs.book_id = ?', bookId),
  };
}

// Liefert nur die angeforderten Bloecke; nicht angeforderte bleiben weg.
function collectExtras(bookId, { analysis = false, lektorat = false, chats = false } = {}) {
  const out = {};
  if (analysis) out.analysis = collectAnalysis(bookId);
  if (lektorat) out.lektorat = collectLektorat(bookId);
  if (chats)    out.chats = collectChats(bookId);
  return out;
}

// ── Restore ─────────────────────────────────────────────────────────────────

// Sorgt fuer eindeutige Natural-Keys (fig_id/loc_id/song_uid), falls beim
// Kollabieren des user_email zwei Quell-Zeilen kollidieren wuerden.
function _uniqueKey(used, key) {
  const base = key || '';
  if (!used.has(base)) { used.add(base); return base; }
  let i = 2;
  while (used.has(`${base}__${i}`)) i += 1;
  const nk = `${base}__${i}`;
  used.add(nk);
  return nk;
}

function restoreAnalysis(bookId, data, ctx) {
  if (!data || typeof data !== 'object') return {};
  const { pageOf, chapterOf, email } = ctx;
  const counts = {};
  const arr = (k) => (Array.isArray(data[k]) ? data[k] : []);

  const figMap = new Map();      // srcFigureId  → newId
  const locMap = new Map();      // srcLocationId → newId
  const sceneMap = new Map();    // srcSceneId   → newId
  const songMap = new Map();     // srcSongId    → newId
  const slMap = new Map();       // srcStorylineId → newId
  const evMap = new Map();       // srcEventId   → newId
  const factMap = new Map();     // srcFactId    → newId
  const checkMap = new Map();    // srcCheckId   → newId
  const issueMap = new Map();    // srcIssueId   → newId

  // 1) storylines
  const insSl = db.prepare('INSERT INTO storylines (book_id,name,farbe,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?)');
  for (const r of arr('storylines')) {
    const res = insSl.run(bookId, r.name, r.farbe ?? null, r.sort_order ?? 0, r.created_at || _now(), r.updated_at || _now());
    slMap.set(r.id, res.lastInsertRowid);
  }

  // 2) figures
  const usedFig = new Set();
  const insFig = db.prepare(`INSERT INTO figures
    (book_id,fig_id,name,kurzname,typ,geburtstag,geschlecht,beruf,beschreibung,sort_order,meta,updated_at,user_email,
     sozialschicht,praesenz,rolle,motivation,konflikt,entwicklung,erste_erwaehnung,erste_erwaehnung_page_id,
     schluesselzitate,wohnadresse,aeusseres,stimme,hintergrund,arc)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const r of arr('figures')) {
    const res = insFig.run(
      bookId, _uniqueKey(usedFig, r.fig_id), r.name, r.kurzname ?? null, r.typ ?? null, r.geburtstag ?? null,
      r.geschlecht ?? null, r.beruf ?? null, r.beschreibung ?? null, r.sort_order ?? 0, r.meta ?? null,
      r.updated_at || _now(), email, r.sozialschicht ?? null, r.praesenz ?? null, r.rolle ?? null,
      r.motivation ?? null, r.konflikt ?? null, r.entwicklung ?? null, r.erste_erwaehnung ?? null,
      pageOf(r.erste_erwaehnung_page_id), r.schluesselzitate ?? null, r.wohnadresse ?? null,
      r.aeusseres ?? null, r.stimme ?? null, r.hintergrund ?? null, r.arc ?? null,
    );
    figMap.set(r.id, res.lastInsertRowid);
  }

  const insTag = db.prepare('INSERT OR IGNORE INTO figure_tags (figure_id,tag) VALUES (?,?)');
  for (const r of arr('figureTags')) {
    const fid = figMap.get(r.figure_id);
    if (fid) insTag.run(fid, r.tag);
  }

  const insRel = db.prepare(`INSERT OR IGNORE INTO figure_relations
    (book_id,from_fig_id,to_fig_id,typ,beschreibung,user_email,machtverhaltnis,belege)
    VALUES (?,?,?,?,?,?,?,?)`);
  for (const r of arr('figureRelations')) {
    const from = figMap.get(r.from_fig_id); const to = figMap.get(r.to_fig_id);
    if (from && to) insRel.run(bookId, from, to, r.typ, r.beschreibung ?? null, email, r.machtverhaltnis ?? null, r.belege ?? null);
  }

  const insApp = db.prepare('INSERT OR IGNORE INTO figure_appearances (figure_id,chapter_id,haeufigkeit) VALUES (?,?,?)');
  for (const r of arr('figureAppearances')) {
    const fid = figMap.get(r.figure_id); const cid = chapterOf(r.chapter_id);
    if (fid && cid) insApp.run(fid, cid, r.haeufigkeit ?? 1);
  }

  const insEv = db.prepare(`INSERT INTO figure_events
    (figure_id,datum,datum_label,datum_year,datum_month,datum_day,datum_ende_year,datum_ende_month,datum_ende_day,
     story_tag,ereignis,bedeutung,typ,subtyp,storyline_id,manually_edited,sort_order,chapter_id,page_id,datum_unsicher)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const r of arr('figureEvents')) {
    const fid = figMap.get(r.figure_id);
    if (!fid) continue;
    const d = normalizeDatumFields(r);
    insEv.run(fid, r.datum, r.datum_label ?? null, d.datum_year, d.datum_month, d.datum_day,
      d.datum_ende_year, d.datum_ende_month, d.datum_ende_day, d.story_tag,
      r.ereignis, r.bedeutung ?? null, r.typ ?? 'persoenlich', r.subtyp ?? 'sonstiges',
      r.storyline_id == null ? null : (slMap.get(r.storyline_id) ?? null),
      r.manually_edited ?? 0, r.sort_order ?? 0, chapterOf(r.chapter_id), pageOf(r.page_id), r.datum_unsicher ?? 0);
  }

  const insPfm = db.prepare('INSERT OR IGNORE INTO page_figure_mentions (page_id,figure_id,count,first_offset) VALUES (?,?,?,?)');
  for (const r of arr('pageFigureMentions')) {
    const pid = pageOf(r.page_id); const fid = figMap.get(r.figure_id);
    if (pid && fid) insPfm.run(pid, fid, r.count ?? 0, r.first_offset ?? null);
  }

  // 3) locations
  const usedLoc = new Set();
  const insLoc = db.prepare(`INSERT INTO locations
    (book_id,loc_id,name,typ,beschreibung,erste_erwaehnung,erste_erwaehnung_page_id,stimmung,sort_order,user_email,
     updated_at,lat,lng,land,geo_query,geo_land)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const r of arr('locations')) {
    const res = insLoc.run(bookId, _uniqueKey(usedLoc, r.loc_id), r.name, r.typ ?? null, r.beschreibung ?? null,
      r.erste_erwaehnung ?? null, pageOf(r.erste_erwaehnung_page_id), r.stimmung ?? null, r.sort_order ?? 0, email,
      r.updated_at || _now(), r.lat ?? null, r.lng ?? null, r.land ?? null, r.geo_query ?? null, r.geo_land ?? null);
    locMap.set(r.id, res.lastInsertRowid);
  }

  const insLf = db.prepare('INSERT OR IGNORE INTO location_figures (location_id,figure_id) VALUES (?,?)');
  for (const r of arr('locationFigures')) {
    const lid = locMap.get(r.location_id); const fid = figMap.get(r.figure_id);
    if (lid && fid) insLf.run(lid, fid);
  }
  const insLc = db.prepare('INSERT OR IGNORE INTO location_chapters (location_id,chapter_id,haeufigkeit) VALUES (?,?,?)');
  for (const r of arr('locationChapters')) {
    const lid = locMap.get(r.location_id); const cid = chapterOf(r.chapter_id);
    if (lid && cid) insLc.run(lid, cid, r.haeufigkeit ?? 1);
  }

  // 4) scenes
  const insScene = db.prepare(`INSERT INTO figure_scenes
    (book_id,user_email,titel,wertung,kommentar,sort_order,chapter_id,page_id,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  for (const r of arr('scenes')) {
    const res = insScene.run(bookId, email, r.titel, r.wertung ?? null, r.kommentar ?? null, r.sort_order ?? 0,
      chapterOf(r.chapter_id), pageOf(r.page_id), r.updated_at || _now());
    sceneMap.set(r.id, res.lastInsertRowid);
  }
  const insSf = db.prepare('INSERT OR IGNORE INTO scene_figures (scene_id,figure_id) VALUES (?,?)');
  for (const r of arr('sceneFigures')) {
    const sid = sceneMap.get(r.scene_id); const fid = figMap.get(r.figure_id);
    if (sid && fid) insSf.run(sid, fid);
  }
  const insSloc = db.prepare('INSERT OR IGNORE INTO scene_locations (scene_id,location_id) VALUES (?,?)');
  for (const r of arr('sceneLocations')) {
    const sid = sceneMap.get(r.scene_id); const lid = locMap.get(r.location_id);
    if (sid && lid) insSloc.run(sid, lid);
  }

  // 5) songs
  const usedSong = new Set();
  const insSong = db.prepare(`INSERT INTO songs
    (book_id,song_uid,titel,interpret,genre,kontext_typ,beschreibung,stimmung,erste_erwaehnung,erste_erwaehnung_page_id,
     sort_order,user_email,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const r of arr('songs')) {
    const res = insSong.run(bookId, _uniqueKey(usedSong, r.song_uid), r.titel, r.interpret ?? null, r.genre ?? null,
      r.kontext_typ ?? null, r.beschreibung ?? null, r.stimmung ?? null, r.erste_erwaehnung ?? null,
      pageOf(r.erste_erwaehnung_page_id), r.sort_order ?? 0, email, r.updated_at || _now());
    songMap.set(r.id, res.lastInsertRowid);
  }
  const insSongFig = db.prepare('INSERT OR IGNORE INTO song_figures (song_id,figure_id,kontext_typ) VALUES (?,?,?)');
  for (const r of arr('songFigures')) {
    const sid = songMap.get(r.song_id); const fid = figMap.get(r.figure_id);
    if (sid && fid) insSongFig.run(sid, fid, r.kontext_typ ?? null);
  }
  const insSongCh = db.prepare('INSERT OR IGNORE INTO song_chapters (song_id,chapter_id,haeufigkeit) VALUES (?,?,?)');
  for (const r of arr('songChapters')) {
    const sid = songMap.get(r.song_id); const cid = chapterOf(r.chapter_id);
    if (sid && cid) insSongCh.run(sid, cid, r.haeufigkeit ?? 1);
  }
  const insSongScene = db.prepare('INSERT OR IGNORE INTO song_scenes (scene_id,song_id) VALUES (?,?)');
  for (const r of arr('songScenes')) {
    const scid = sceneMap.get(r.scene_id); const sid = songMap.get(r.song_id);
    if (scid && sid) insSongScene.run(scid, sid);
  }

  // 6) world_facts
  const insWf = db.prepare(`INSERT INTO world_facts
    (book_id,kategorie,subjekt,fakt,seite_label,sort_order,user_email,updated_at) VALUES (?,?,?,?,?,?,?,?)`);
  for (const r of arr('worldFacts')) {
    const res = insWf.run(bookId, r.kategorie ?? null, r.subjekt ?? null, r.fakt, r.seite_label ?? null,
      r.sort_order ?? 0, email, r.updated_at || _now());
    factMap.set(r.id, res.lastInsertRowid);
  }
  const insWfc = db.prepare('INSERT OR IGNORE INTO world_fact_chapters (fact_id,chapter_id) VALUES (?,?)');
  for (const r of arr('worldFactChapters')) {
    const fid = factMap.get(r.fact_id); const cid = chapterOf(r.chapter_id);
    if (fid && cid) insWfc.run(fid, cid);
  }

  // 7) zeitstrahl_events
  const insZe = db.prepare(`INSERT INTO zeitstrahl_events
    (book_id,user_email,datum,datum_label,datum_year,datum_month,datum_day,datum_ende_year,datum_ende_month,datum_ende_day,
     story_tag,ereignis,typ,subtyp,bedeutung,storyline_id,manually_edited,sort_order,updated_at,datum_unsicher)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const r of arr('zeitstrahlEvents')) {
    const d = normalizeDatumFields(r);
    const res = insZe.run(bookId, email, r.datum, r.datum_label ?? null, d.datum_year, d.datum_month,
      d.datum_day, d.datum_ende_year, d.datum_ende_month, d.datum_ende_day,
      d.story_tag, r.ereignis, r.typ ?? 'persoenlich', r.subtyp ?? 'sonstiges', r.bedeutung ?? null,
      r.storyline_id == null ? null : (slMap.get(r.storyline_id) ?? null), r.manually_edited ?? 0, r.sort_order ?? 0,
      r.updated_at ?? null, r.datum_unsicher ?? 0);
    evMap.set(r.id, res.lastInsertRowid);
  }
  const insZec = db.prepare('INSERT INTO zeitstrahl_event_chapters (event_id,chapter_id,sort_order) VALUES (?,?,?)');
  for (const r of arr('zeitstrahlEventChapters')) {
    const eid = evMap.get(r.event_id);
    if (eid) insZec.run(eid, chapterOf(r.chapter_id), r.sort_order ?? 0);
  }
  const insZep = db.prepare('INSERT INTO zeitstrahl_event_pages (event_id,page_id,sort_order) VALUES (?,?,?)');
  for (const r of arr('zeitstrahlEventPages')) {
    const eid = evMap.get(r.event_id);
    if (eid) insZep.run(eid, pageOf(r.page_id), r.sort_order ?? 0);
  }
  const insZef = db.prepare('INSERT INTO zeitstrahl_event_figures (event_id,figure_id,figur_name,sort_order) VALUES (?,?,?,?)');
  for (const r of arr('zeitstrahlEventFigures')) {
    const eid = evMap.get(r.event_id);
    if (eid) insZef.run(eid, r.figure_id == null ? null : (figMap.get(r.figure_id) ?? null), r.figur_name ?? null, r.sort_order ?? 0);
  }

  // 8) continuity
  const insCc = db.prepare('INSERT INTO continuity_checks (book_id,user_email,checked_at,summary,model) VALUES (?,?,?,?,?)');
  for (const r of arr('continuityChecks')) {
    const res = insCc.run(bookId, email, r.checked_at || _now(), r.summary ?? null, r.model ?? null);
    checkMap.set(r.id, res.lastInsertRowid);
  }
  const insCi = db.prepare(`INSERT INTO continuity_issues
    (check_id,book_id,user_email,schwere,typ,beschreibung,stelle_a,stelle_b,empfehlung,sort_order,updated_at,resolved,resolved_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const r of arr('continuityIssues')) {
    const cid = checkMap.get(r.check_id);
    if (!cid) continue;
    const res = insCi.run(cid, bookId, email, r.schwere ?? null, r.typ ?? null, r.beschreibung ?? null,
      r.stelle_a ?? null, r.stelle_b ?? null, r.empfehlung ?? null, r.sort_order ?? 0, r.updated_at ?? null,
      r.resolved ?? 0, r.resolved_at ?? null);
    issueMap.set(r.id, res.lastInsertRowid);
  }
  const insCif = db.prepare('INSERT INTO continuity_issue_figures (issue_id,figure_id,figur_name,sort_order) VALUES (?,?,?,?)');
  for (const r of arr('continuityIssueFigures')) {
    const iid = issueMap.get(r.issue_id);
    if (iid) insCif.run(iid, r.figure_id == null ? null : (figMap.get(r.figure_id) ?? null), r.figur_name ?? null, r.sort_order ?? 0);
  }
  const insCic = db.prepare('INSERT INTO continuity_issue_chapters (issue_id,chapter_id,sort_order) VALUES (?,?,?)');
  for (const r of arr('continuityIssueChapters')) {
    const iid = issueMap.get(r.issue_id);
    if (iid) insCic.run(iid, chapterOf(r.chapter_id), r.sort_order ?? 0);
  }

  // 9) ideen (XOR page/chapter — die remappte Referenz muss gesetzt bleiben)
  const insIdee = db.prepare(`INSERT INTO ideen
    (book_id,page_id,chapter_id,user_email,content,erledigt,erledigt_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  for (const r of arr('ideen')) {
    let pid = null; let cid = null;
    if (r.page_id != null) { pid = pageOf(r.page_id); if (!pid) continue; }
    else if (r.chapter_id != null) { cid = chapterOf(r.chapter_id); if (!cid) continue; }
    else continue;
    insIdee.run(bookId, pid, cid, email, r.content, r.erledigt ?? 0, r.erledigt_at ?? null,
      r.created_at || _now(), r.updated_at || _now());
  }

  counts.figures = figMap.size;
  counts.locations = locMap.size;
  counts.scenes = sceneMap.size;
  counts.songs = songMap.size;
  counts.events = evMap.size + arr('figureEvents').length;
  counts.continuityIssues = issueMap.size;
  counts.ideen = arr('ideen').length;
  return counts;
}

function restoreLektorat(bookId, data, ctx) {
  if (!data || typeof data !== 'object') return { pageChecks: 0 };
  const { pageOf, chapterOf, email } = ctx;
  const ins = db.prepare(`INSERT INTO page_checks
    (page_id,book_id,checked_at,error_count,errors_json,stilanalyse,fazit,model,saved,saved_at,applied_errors_json,
     user_email,selected_errors_json,szenen_json,chapter_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let n = 0;
  for (const r of (Array.isArray(data.pageChecks) ? data.pageChecks : [])) {
    const pid = pageOf(r.page_id);
    if (!pid) continue;
    ins.run(pid, bookId, r.checked_at || _now(), r.error_count ?? 0, r.errors_json ?? null, r.stilanalyse ?? null,
      r.fazit ?? null, r.model ?? null, r.saved ?? 0, r.saved_at ?? null, r.applied_errors_json ?? null,
      email, r.selected_errors_json ?? null, r.szenen_json ?? null, chapterOf(r.chapter_id));
    n += 1;
  }
  return { pageChecks: n };
}

function restoreChats(bookId, data, ctx) {
  if (!data || typeof data !== 'object') return { sessions: 0, messages: 0 };
  const { pageOf, email } = ctx;
  const sessionMap = new Map();
  const insSession = db.prepare(`INSERT INTO chat_sessions
    (book_id,kind,page_id,user_email,title,created_at,last_message_at,opening_page_text) VALUES (?,?,?,?,?,?,?,?)`);
  for (const r of (Array.isArray(data.sessions) ? data.sessions : [])) {
    let pid = null;
    if (r.kind === 'page') { pid = pageOf(r.page_id); if (!pid) continue; } // CHECK: page-Session braucht page_id
    const res = insSession.run(bookId, r.kind === 'book' ? 'book' : 'page', pid, email, r.title ?? null,
      r.created_at || _now(), r.last_message_at || r.created_at || _now(), r.opening_page_text ?? null);
    sessionMap.set(r.id, res.lastInsertRowid);
  }
  const insMsg = db.prepare(`INSERT INTO chat_messages
    (session_id,role,content,vorschlaege,context_info,provider,model,tokens_in,tokens_out,cache_read_in,
     cache_creation_in,tps,created_at,client_msg_id,job_id,cache_creation_1h_in)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let n = 0;
  for (const r of (Array.isArray(data.messages) ? data.messages : [])) {
    const sid = sessionMap.get(r.session_id);
    if (!sid) continue;
    insMsg.run(sid, r.role, r.content, r.vorschlaege ?? null, r.context_info ?? null, r.provider ?? null,
      r.model ?? null, r.tokens_in ?? null, r.tokens_out ?? null, r.cache_read_in ?? 0, r.cache_creation_in ?? 0,
      r.tps ?? null, r.created_at || _now(), r.client_msg_id ?? null, r.job_id ?? null, r.cache_creation_1h_in ?? 0);
    n += 1;
  }
  return { sessions: sessionMap.size, messages: n };
}

// Schreibt alle vorhandenen Extra-Bloecke in einer Transaktion. `maps` traegt
// die vom Import-Worker gefuellten pageIdMap/chapterIdMap (srcId → neue ID).
function restoreExtras(bookId, extras, maps, importerEmail) {
  if (!extras || typeof extras !== 'object') return {};
  const pageIdMap = maps?.pageIdMap instanceof Map ? maps.pageIdMap : new Map();
  const chapterIdMap = maps?.chapterIdMap instanceof Map ? maps.chapterIdMap : new Map();
  const ctx = {
    email: importerEmail,
    pageOf: (src) => (src == null ? null : (pageIdMap.get(src) ?? null)),
    chapterOf: (src) => (src == null ? null : (chapterIdMap.get(src) ?? null)),
  };
  const result = {};
  const run = db.transaction(() => {
    if (extras.analysis) result.analysis = restoreAnalysis(bookId, extras.analysis, ctx);
    if (extras.lektorat) result.lektorat = restoreLektorat(bookId, extras.lektorat, ctx);
    if (extras.chats)    result.chats = restoreChats(bookId, extras.chats, ctx);
  });
  run();
  return result;
}

module.exports = {
  collectExtras, collectAnalysis, collectLektorat, collectChats,
  restoreExtras,
};
