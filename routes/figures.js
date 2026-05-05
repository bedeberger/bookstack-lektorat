const express = require('express');
const { db, saveFigurenToDb, saveZeitstrahlEvents, getChapterFigures, cleanupDuplicateFiguren } = require('../db/schema');
const { recomputeBookFigureMentions } = require('../lib/page-index');
const { toIntId, inClause } = require('../lib/validate');
const logger = require('../logger');

const router = express.Router();
const jsonBody = express.json();

// Konsolidierten Zeitstrahl eines Buchs laden (vor /:book_id definiert um Konflikte zu vermeiden)
router.get('/zeitstrahl/:book_id', (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  const userEmail = req.session?.user?.email || null;
  const rows = db.prepare(
    'SELECT datum, ereignis, typ, bedeutung, kapitel, chapter_ids, seiten, page_ids, figuren FROM zeitstrahl_events WHERE book_id = ? AND user_email = ? ORDER BY sort_order'
  ).all(bookId, userEmail || '');
  if (!rows.length) return res.json({ ereignisse: null });

  // Backward-Compat: alte Rows speicherten figuren als ["Name", ...]-Strings.
  // Neue Rows speichern {id, name, typ}-Objekte. Beim Laden Strings via figures-
  // Tabelle (Name → fig_id, typ) anreichern, damit Klick-Link + Badge-Farbe wieder
  // funktionieren.
  const figLookup = new Map();
  const figRows = db.prepare(
    'SELECT fig_id, name, kurzname, typ FROM figures WHERE book_id = ? AND user_email IS ?'
  ).all(bookId, userEmail);
  for (const f of figRows) {
    const keys = [f.name, f.kurzname].filter(Boolean).map(s => s.toLowerCase());
    for (const k of keys) figLookup.set(k, { id: f.fig_id, typ: f.typ || 'andere' });
  }
  const enrichFigur = (f) => {
    if (f == null) return null;
    if (typeof f === 'string') {
      const name = f.trim();
      if (!name) return null;
      const hit = figLookup.get(name.toLowerCase());
      return hit ? { id: hit.id, name, typ: hit.typ } : { name };
    }
    if (typeof f === 'object') {
      const name = (f.name || f.kurzname || '').trim();
      if (!name) return null;
      const out = { name };
      if (f.id) out.id = String(f.id);
      if (f.typ) out.typ = String(f.typ);
      if (!out.id || !out.typ) {
        const hit = figLookup.get(name.toLowerCase());
        if (hit) {
          if (!out.id)  out.id  = hit.id;
          if (!out.typ) out.typ = hit.typ;
        }
      }
      return out;
    }
    return null;
  };

  const ereignisse = rows.map(r => ({
    datum:       r.datum,
    ereignis:    r.ereignis,
    typ:         r.typ || 'persoenlich',
    bedeutung:   r.bedeutung || '',
    kapitel:     r.kapitel     ? JSON.parse(r.kapitel)     : [],
    chapter_ids: r.chapter_ids ? JSON.parse(r.chapter_ids) : [],
    seiten:      r.seiten      ? JSON.parse(r.seiten)      : [],
    page_ids:    r.page_ids    ? JSON.parse(r.page_ids)    : [],
    figuren:     r.figuren ? (JSON.parse(r.figuren) || []).map(enrichFigur).filter(Boolean) : [],
  }));
  res.json({ ereignisse });
});

// Konsolidierten Zeitstrahl löschen (z.B. nach neuer Extraktion)
router.delete('/zeitstrahl/:book_id', (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  const userEmail = req.session?.user?.email || null;
  db.prepare('DELETE FROM zeitstrahl_events WHERE book_id = ? AND user_email = ?').run(bookId, userEmail || '');
  res.json({ ok: true });
});

// Szenen eines Buchs laden (vor /:book_id definiert um Konflikte zu vermeiden)
router.get('/scenes/:book_id', (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  const userEmail = req.session?.user?.email || null;

  const rows = db.prepare(`
    SELECT fs.id, c.chapter_name AS kapitel, p.page_name AS seite,
           fs.titel, fs.wertung, fs.kommentar, fs.chapter_id, fs.page_id, fs.updated_at
    FROM figure_scenes fs
    LEFT JOIN chapters c ON c.chapter_id = fs.chapter_id
    LEFT JOIN pages    p ON p.page_id    = fs.page_id
    WHERE fs.book_id = ? AND fs.user_email = ?
    ORDER BY fs.sort_order
  `).all(bookId, userEmail);

  const sceneIds = rows.map(r => r.id);
  const { sql: sceneSql, values: sceneVals } = inClause(sceneIds);
  const sfRows = sceneIds.length
    ? db.prepare(`SELECT scene_id, fig_id FROM scene_figures WHERE scene_id IN ${sceneSql}`).all(...sceneVals)
    : [];
  const sfMap = {};
  for (const sf of sfRows) (sfMap[sf.scene_id] ??= []).push(sf.fig_id);

  const slRows = sceneIds.length
    ? db.prepare(`SELECT sl.scene_id, l.loc_id FROM scene_locations sl JOIN locations l ON sl.location_id = l.id WHERE sl.scene_id IN ${sceneSql}`).all(...sceneVals)
    : [];
  const slMap = {};
  for (const sl of slRows) (slMap[sl.scene_id] ??= []).push(sl.loc_id);

  const szenen = rows.map(s => ({
    id:         s.id,
    kapitel:    s.kapitel,
    seite:      s.seite,
    titel:      s.titel,
    wertung:    s.wertung,
    kommentar:  s.kommentar,
    chapter_id: s.chapter_id,
    page_id:    s.page_id,
    fig_ids:    sfMap[s.id] || [],
    ort_ids:    slMap[s.id] || [],
  }));

  const updated_at = rows.length ? rows[0].updated_at : null;
  res.json({ szenen, updated_at });
});

// Szenen eines Buchs löschen
router.delete('/scenes/:book_id', (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  const userEmail = req.session?.user?.email || null;
  db.prepare('DELETE FROM figure_scenes WHERE book_id = ? AND user_email = ?').run(bookId, userEmail);
  res.json({ ok: true });
});

// Figuren eines Kapitels laden (für Kontext-Panel im Editor)
router.get('/chapter/:book_id/:chapter_id', (req, res) => {
  const bookId = toIntId(req.params.book_id);
  const chapterId = toIntId(req.params.chapter_id);
  if (!bookId || !chapterId) return res.status(400).json({ error_code: 'INVALID_ID' });
  const userEmail = req.session?.user?.email || null;
  const figuren = getChapterFigures(bookId, chapterId, userEmail);
  res.json({ figuren });
});

// Gespeicherte Figuren eines Buchs laden
router.get('/:book_id', (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  const userEmail = req.session?.user?.email || null;

  const figs = db.prepare(`
    SELECT * FROM figures
    WHERE book_id = ? AND user_email = ?
    ORDER BY sort_order, id
  `).all(bookId, userEmail);
  if (!figs.length) return res.json(null);

  const tags = db.prepare(`
    SELECT ft.figure_id, ft.tag FROM figure_tags ft
    JOIN figures f ON f.id = ft.figure_id
    WHERE f.book_id = ? AND f.user_email = ?`).all(bookId, userEmail);
  const apps = db.prepare(`
    SELECT fa.figure_id, fa.chapter_id, c.chapter_name, fa.haeufigkeit
    FROM figure_appearances fa
    JOIN figures f ON f.id = fa.figure_id
    LEFT JOIN chapters c ON c.chapter_id = fa.chapter_id
    WHERE f.book_id = ? AND f.user_email = ?`).all(bookId, userEmail);
  const evts = db.prepare(`
    SELECT fe.figure_id, fe.datum, fe.ereignis, fe.bedeutung, fe.typ,
           c.chapter_name AS kapitel, p.page_name AS seite
    FROM figure_events fe
    JOIN figures f ON f.id = fe.figure_id
    LEFT JOIN chapters c ON c.chapter_id = fe.chapter_id
    LEFT JOIN pages    p ON p.page_id    = fe.page_id
    WHERE f.book_id = ? AND f.user_email = ?
    ORDER BY fe.figure_id, fe.sort_order`).all(bookId, userEmail);
  const rels = db.prepare(
    'SELECT from_fig_id, to_fig_id, typ, beschreibung, machtverhaltnis, belege FROM figure_relations WHERE book_id = ? AND user_email = ?'
  ).all(bookId, userEmail);

  const tagMap = {};
  for (const t of tags) (tagMap[t.figure_id] ??= []).push(t.tag);
  const appMap = {};
  for (const a of apps) (appMap[a.figure_id] ??= []).push({ chapter_id: a.chapter_id ?? null, name: a.chapter_name, haeufigkeit: a.haeufigkeit });
  const evtMap = {};
  for (const e of evts) (evtMap[e.figure_id] ??= []).push({ datum: e.datum, ereignis: e.ereignis, bedeutung: e.bedeutung, typ: e.typ || 'persoenlich', kapitel: e.kapitel || null, seite: e.seite || null });
  const relMap = {};
  for (const r of rels) {
    let belege = [];
    if (r.belege) { try { belege = JSON.parse(r.belege) || []; } catch { belege = []; } }
    (relMap[r.from_fig_id] ??= []).push({
      figur_id: r.to_fig_id,
      typ: r.typ,
      beschreibung: r.beschreibung,
      machtverhaltnis: r.machtverhaltnis ?? null,
      belege: Array.isArray(belege) ? belege : [],
    });
  }

  const sceneFigRows = db.prepare(`
    SELECT c.chapter_name AS kapitel, p.page_name AS seite, sf.fig_id
    FROM figure_scenes fs
    JOIN scene_figures sf ON sf.scene_id = fs.id
    LEFT JOIN chapters c ON c.chapter_id = fs.chapter_id
    LEFT JOIN pages    p ON p.page_id    = fs.page_id
    WHERE fs.book_id = ? AND fs.user_email = ?
  `).all(bookId, userEmail);
  const seitenMap = {};
  for (const sc of sceneFigRows) {
    if (!seitenMap[sc.fig_id]) seitenMap[sc.fig_id] = [];
    const key = sc.kapitel + '::' + (sc.seite || '');
    if (!seitenMap[sc.fig_id].some(x => x.kapitel + '::' + x.seite === key)) {
      seitenMap[sc.fig_id].push({ kapitel: sc.kapitel, seite: sc.seite || '' });
    }
  }

  const figuren = figs.map(f => {
    let zitate = [];
    if (f.schluesselzitate) {
      try { zitate = JSON.parse(f.schluesselzitate) || []; } catch { zitate = []; }
    }
    return {
      id: f.fig_id,
      name: f.name,
      kurzname: f.kurzname,
      typ: f.typ,
      geburtstag: f.geburtstag,
      geschlecht: f.geschlecht,
      beruf: f.beruf,
      wohnadresse: f.wohnadresse || null,
      beschreibung: f.beschreibung,
      sozialschicht: f.sozialschicht || null,
      praesenz: f.praesenz || null,
      rolle: f.rolle || null,
      motivation: f.motivation || null,
      konflikt: f.konflikt || null,
      entwicklung: f.entwicklung || null,
      erste_erwaehnung: f.erste_erwaehnung || null,
      erste_erwaehnung_page_id: f.erste_erwaehnung_page_id || null,
      schluesselzitate: Array.isArray(zitate) ? zitate : [],
      eigenschaften: tagMap[f.id] || [],
      kapitel: appMap[f.id] || [],
      seiten: seitenMap[f.fig_id] || [],
      lebensereignisse: evtMap[f.id] || [],
      beziehungen: relMap[f.fig_id] || [],
    };
  });

  res.json({ figuren, updated_at: figs[0]?.updated_at || null });
});

// Figuren eines Buchs speichern (überschreibt)
router.put('/:book_id', jsonBody, (req, res) => {
  const userEmail = req.session?.user?.email || null;
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  saveFigurenToDb(bookId, req.body.figuren || [], userEmail);
  // Response sofort – Mentions-Neuberechnung läuft im Hintergrund. Auf grossen Büchern
  // (>500 Seiten × >50 Figuren) braucht der Regex-Scan mehrere Sekunden.
  res.json({ ok: true });
  setImmediate(() => {
    try {
      const { figures, pagesProcessed } = recomputeBookFigureMentions(bookId, userEmail);
      logger.info(`Figuren-Mentions aktualisiert: Buch ${bookId}, ${figures} Figuren × ${pagesProcessed} Seiten.`);
    } catch (e) {
      logger.warn(`Figuren-Mentions-Neuberechnung für Buch ${bookId} fehlgeschlagen: ${e.message}`);
    }
  });
});

// Concurrency-Guard: zwei parallele Cleanups auf demselben Buch erzeugen
// nur Lock-Contention und doppelte Logs. Key = `${bookId}:${userEmail}`.
const _cleanupInflight = new Set();

// Post-Hoc-Cleanup: Namens-Duplikate mergen, Relations deduplizieren,
// verdächtige Beziehungs-Beschreibungen entfernen. Idempotent.
//
// Läuft synchron (better-sqlite3); frühere Implementation hielt eine einzige
// grosse Transaction über alle Duplikat-Gruppen, was den WAL-Writer-Lock
// minutenlang blockierte. Seit dem Per-Gruppen-Split (db/figures.js) wird
// der Lock zwischen Gruppen freigegeben — andere Requests können dazwischen
// progressen. Concurrency-Guard verhindert zusätzlich doppelte Aufrufe.
router.post('/cleanup/:book_id', (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'BOOK_ID_INVALID' });
  const userEmail = req.session?.user?.email || null;
  const guardKey = `${bookId}:${userEmail || ''}`;
  if (_cleanupInflight.has(guardKey)) return res.status(409).json({ error_code: 'CLEANUP_IN_PROGRESS' });
  _cleanupInflight.add(guardKey);
  try {
    const stats = cleanupDuplicateFiguren(bookId, userEmail);
    logger.info(`Figuren-Cleanup Buch ${bookId} (${userEmail || 'legacy'}): ${stats.figurenMerged} Figuren gemergt, ${stats.relationsRemoved} Beziehungen entfernt, ${stats.descriptionsCleared} Beschreibungen geleert.`);
    res.json({ ok: true, ...stats });
  } catch (e) {
    logger.error(`Figuren-Cleanup fehlgeschlagen: ${e.message}`, { stack: e.stack });
    res.status(500).json({ error: e.message });
  } finally {
    _cleanupInflight.delete(guardKey);
  }
});

module.exports = router;
