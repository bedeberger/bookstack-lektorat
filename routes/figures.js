const express = require('express');
const { db, saveFigurenToDb, saveZeitstrahlEvents, saveCharacterArcs } = require('../db/schema');

const router = express.Router();
const jsonBody = express.json();

// Konsolidierten Zeitstrahl eines Buchs laden (vor /:book_id definiert um Konflikte zu vermeiden)
router.get('/zeitstrahl/:book_id', (req, res) => {
  const bookId = parseInt(req.params.book_id);
  const userEmail = req.session?.user?.email || null;
  const rows = db.prepare(
    'SELECT datum, ereignis, typ, bedeutung, kapitel, seiten, figuren FROM zeitstrahl_events WHERE book_id = ? AND user_email = ? ORDER BY sort_order'
  ).all(bookId, userEmail || '');
  if (!rows.length) return res.json({ ereignisse: null });
  const ereignisse = rows.map(r => ({
    datum:     r.datum,
    ereignis:  r.ereignis,
    typ:       r.typ || 'persoenlich',
    bedeutung: r.bedeutung || '',
    kapitel:   r.kapitel ? JSON.parse(r.kapitel) : [],
    seiten:    r.seiten  ? JSON.parse(r.seiten)  : [],
    figuren:   r.figuren ? JSON.parse(r.figuren) : [],
  }));
  res.json({ ereignisse });
});

// Konsolidierten Zeitstrahl löschen (z.B. nach neuer Extraktion)
router.delete('/zeitstrahl/:book_id', (req, res) => {
  const bookId = parseInt(req.params.book_id);
  const userEmail = req.session?.user?.email || null;
  db.prepare('DELETE FROM zeitstrahl_events WHERE book_id = ? AND user_email = ?').run(bookId, userEmail || '');
  res.json({ ok: true });
});

// Szenen eines Buchs laden (vor /:book_id definiert um Konflikte zu vermeiden)
router.get('/scenes/:book_id', (req, res) => {
  const bookId = parseInt(req.params.book_id);
  const userEmail = req.session?.user?.email || null;

  const rows = db.prepare(`
    SELECT id, kapitel, seite, titel, wertung, kommentar, updated_at
    FROM figure_scenes
    WHERE book_id = ? AND user_email = ?
    ORDER BY sort_order
  `).all(bookId, userEmail);

  const sceneIds = rows.map(r => r.id);
  const sfRows = sceneIds.length
    ? db.prepare(`SELECT scene_id, fig_id FROM scene_figures WHERE scene_id IN (${sceneIds.map(() => '?').join(',')})`).all(...sceneIds)
    : [];
  const sfMap = {};
  for (const sf of sfRows) (sfMap[sf.scene_id] ??= []).push(sf.fig_id);

  const slRows = sceneIds.length
    ? db.prepare(`SELECT sl.scene_id, l.loc_id FROM scene_locations sl JOIN locations l ON sl.location_id = l.id WHERE sl.scene_id IN (${sceneIds.map(() => '?').join(',')})`).all(...sceneIds)
    : [];
  const slMap = {};
  for (const sl of slRows) (slMap[sl.scene_id] ??= []).push(sl.loc_id);

  const szenen = rows.map(s => ({
    id:        s.id,
    kapitel:   s.kapitel,
    seite:     s.seite,
    titel:     s.titel,
    wertung:   s.wertung,
    kommentar: s.kommentar,
    fig_ids:   sfMap[s.id] || [],
    ort_ids:   slMap[s.id] || [],
  }));

  const updated_at = rows.length ? rows[0].updated_at : null;
  res.json({ szenen, updated_at });
});

// Szenen eines Buchs löschen
router.delete('/scenes/:book_id', (req, res) => {
  const bookId = parseInt(req.params.book_id);
  const userEmail = req.session?.user?.email || null;
  db.prepare('DELETE FROM figure_scenes WHERE book_id = ? AND user_email = ?').run(bookId, userEmail);
  res.json({ ok: true });
});

// Figurenentwicklungsbögen laden (vor /:book_id definiert um Konflikte zu vermeiden)
router.get('/character-arcs/:book_id', (req, res) => {
  const bookId = parseInt(req.params.book_id);
  const userEmail = req.session?.user?.email || null;

  const arcRows = db.prepare(`
    SELECT id, fig_id, arc_typ, ausgangszustand, endzustand, gesamtbogen, updated_at
    FROM character_arcs
    WHERE book_id = ? AND user_email = ?
    ORDER BY rowid
  `).all(bookId, userEmail);

  if (!arcRows.length) return res.json(null);

  const arcIds = arcRows.map(r => r.id);
  const stageRows = arcIds.length
    ? db.prepare(
        `SELECT arc_id, sort_order, kapitel, soziale_position, innere_haltung, beziehungsstatus, wendepunkt
         FROM arc_stages WHERE arc_id IN (${arcIds.map(() => '?').join(',')})
         ORDER BY arc_id, sort_order`
      ).all(...arcIds)
    : [];

  const stageMap = {};
  for (const s of stageRows) {
    (stageMap[s.arc_id] ??= []).push({
      sort_order:       s.sort_order,
      kapitel:          s.kapitel,
      soziale_position: s.soziale_position,
      innere_haltung:   s.innere_haltung,
      beziehungsstatus: s.beziehungsstatus,
      wendepunkt:       s.wendepunkt,
    });
  }

  const entwicklungsboegen = arcRows.map(a => ({
    fig_id:          a.fig_id,
    arc_typ:         a.arc_typ,
    ausgangszustand: a.ausgangszustand,
    endzustand:      a.endzustand,
    gesamtbogen:     a.gesamtbogen,
    etappen:         stageMap[a.id] || [],
  }));

  res.json({ entwicklungsboegen, updated_at: arcRows[0]?.updated_at || null });
});

// Figurenentwicklungsbögen speichern (manuelle Bearbeitungen)
router.put('/character-arcs/:book_id', jsonBody, (req, res) => {
  const userEmail = req.session?.user?.email || null;
  saveCharacterArcs(parseInt(req.params.book_id), userEmail, req.body.entwicklungsboegen || []);
  res.json({ ok: true });
});

// Figurenentwicklungsbögen löschen
router.delete('/character-arcs/:book_id', (req, res) => {
  const bookId = parseInt(req.params.book_id);
  const userEmail = req.session?.user?.email || null;
  db.prepare('DELETE FROM character_arcs WHERE book_id = ? AND user_email = ?').run(bookId, userEmail);
  res.json({ ok: true });
});

// Gespeicherte Figuren eines Buchs laden
router.get('/:book_id', (req, res) => {
  const bookId = parseInt(req.params.book_id);
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
    SELECT fa.figure_id, fa.chapter_name, fa.haeufigkeit FROM figure_appearances fa
    JOIN figures f ON f.id = fa.figure_id
    WHERE f.book_id = ? AND f.user_email = ?`).all(bookId, userEmail);
  const evts = db.prepare(`
    SELECT fe.figure_id, fe.datum, fe.ereignis, fe.bedeutung, fe.typ, fe.kapitel, fe.seite FROM figure_events fe
    JOIN figures f ON f.id = fe.figure_id
    WHERE f.book_id = ? AND f.user_email = ?
    ORDER BY fe.figure_id, fe.sort_order`).all(bookId, userEmail);
  const rels = db.prepare(
    'SELECT from_fig_id, to_fig_id, typ, beschreibung, machtverhaltnis FROM figure_relations WHERE book_id = ? AND user_email = ?'
  ).all(bookId, userEmail);

  const tagMap = {};
  for (const t of tags) (tagMap[t.figure_id] ??= []).push(t.tag);
  const appMap = {};
  for (const a of apps) (appMap[a.figure_id] ??= []).push({ name: a.chapter_name, haeufigkeit: a.haeufigkeit });
  const evtMap = {};
  for (const e of evts) (evtMap[e.figure_id] ??= []).push({ datum: e.datum, ereignis: e.ereignis, bedeutung: e.bedeutung, typ: e.typ || 'persoenlich', kapitel: e.kapitel || null, seite: e.seite || null });
  const relMap = {};
  for (const r of rels) (relMap[r.from_fig_id] ??= []).push({ figur_id: r.to_fig_id, typ: r.typ, beschreibung: r.beschreibung, machtverhaltnis: r.machtverhaltnis ?? null });

  const sceneFigRows = db.prepare(
    'SELECT fs.kapitel, fs.seite, sf.fig_id FROM figure_scenes fs JOIN scene_figures sf ON sf.scene_id = fs.id WHERE fs.book_id = ? AND fs.user_email = ?'
  ).all(bookId, userEmail);
  const seitenMap = {};
  for (const sc of sceneFigRows) {
    if (!seitenMap[sc.fig_id]) seitenMap[sc.fig_id] = [];
    const key = sc.kapitel + '::' + (sc.seite || '');
    if (!seitenMap[sc.fig_id].some(x => x.kapitel + '::' + x.seite === key)) {
      seitenMap[sc.fig_id].push({ kapitel: sc.kapitel, seite: sc.seite || '' });
    }
  }

  const figuren = figs.map(f => ({
    id: f.fig_id,
    name: f.name,
    kurzname: f.kurzname,
    typ: f.typ,
    geburtstag: f.geburtstag,
    geschlecht: f.geschlecht,
    beruf: f.beruf,
    beschreibung: f.beschreibung,
    sozialschicht: f.sozialschicht || null,
    eigenschaften: tagMap[f.id] || [],
    kapitel: appMap[f.id] || [],
    seiten: seitenMap[f.fig_id] || [],
    lebensereignisse: evtMap[f.id] || [],
    beziehungen: relMap[f.fig_id] || [],
  }));

  res.json({ figuren, updated_at: figs[0]?.updated_at || null });
});

// Figuren eines Buchs speichern (überschreibt)
router.put('/:book_id', jsonBody, (req, res) => {
  const userEmail = req.session?.user?.email || null;
  saveFigurenToDb(parseInt(req.params.book_id), req.body.figuren || [], userEmail);
  res.json({ ok: true });
});

module.exports = router;
