'use strict';

// Manuskript-Meilensteine: ganze-Buch-Snapshots („Fassung 1/2/3").
// Capture spiegelt den swbook-Export (routes/book-migration.js), legt das
// Ergebnis aber als selbsttragende Zeile in book_snapshots ab statt als ZIP:
//   content_json = buildBookJson({ book, settings, tree })   (Seiten-HTML inline)
//   extras_json  = collectExtras(bookId, { analysis, lektorat })
// v1 ist Lese-/Diff-only: kein ganz-Buch-Restore. extras_json wird gespeichert
// (fuer spaeteren Restore), aber nie an den Client geliefert.

const express = require('express');
const logger = require('../logger');
const contentStore = require('../lib/content-store');
const { getBookSettings, saveBookSettings, setBookEntitiesEnabled } = require('../db/schema');
const { treeToNodes, buildBookJson, validateBookJson, planFromNodes } = require('../lib/book-bundle');
const { collectExtras } = require('../db/book-migration-data');
const { htmlToPlainText } = require('../lib/html-text');
const { snapshotToBundle, snapshotPublication } = require('../lib/snapshot-export');
const { FORMATS } = require('../lib/export-builders');
const { buildExportMeta, sendExportBuffer } = require('../lib/export-send');
const { buildExportFilename } = require('../lib/filenames');
const { toIntId } = require('../lib/validate');
const { setContext } = require('../lib/log-context');
const { requireBookAccess, sendACLError } = require('../lib/acl');
const bookOrder = require('../db/book-order');
const snapshots = require('../db/book-snapshots');
const pagePresence = require('../db/page-presence');

const router = express.Router();

const LABEL_MAX = 120;
const DESC_MAX = 1000;

// Label der automatischen Sicherung, die ein Restore anlegt. Persistiert als
// __i18n:-Marker, damit der spaetere Betrachter die Bezeichnung in seiner
// eigenen Locale sieht (Frontend loest via t() auf).
const AUTO_BACKUP_LABEL = '__i18n:snapshots.autoBackupLabel__';

function _err(code) { const e = new Error(code); e.code = code; return e; }

function _clip(s, max) {
  if (s == null) return null;
  const t = String(s).trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max) : t;
}

// Alle Seiten-Metas (Top-Pages + rekursiv aus Kapiteln) flach einsammeln.
function _collectMetas(tree) {
  const metas = [];
  for (const p of (tree.topPages || [])) metas.push(p);
  (function walk(chapters) {
    for (const c of (chapters || [])) {
      for (const p of (c.pages || [])) metas.push(p);
      walk(c.subchapters || []);
    }
  })(tree.chapters || []);
  return metas;
}

// Kompakte Zaehl-Uebersicht des eingefrorenen Analyse-/Lektorat-Stands
// (extras_json). Publikations-Nachweis „so sah der Weltaufbau/das Lektorat zum
// Zeitpunkt der Fassung aus" — ohne die MB-grossen Rohdaten auszuliefern. Nur
// Bloecke mit >0 Zeilen erscheinen. Defekt/leer → null.
function _extrasSummary(extrasJson) {
  if (!extrasJson) return null;
  let parsed;
  try { parsed = JSON.parse(extrasJson); } catch { return null; }
  const a = parsed?.analysis || {};
  const len = (x) => (Array.isArray(x) ? x.length : 0);
  const out = {
    figures: len(a.figures),
    locations: len(a.locations),
    scenes: len(a.scenes),
    events: len(a.zeitstrahlEvents),
    worldFacts: len(a.worldFacts),
    continuityIssues: len(a.continuityIssues),
    ideen: len(a.ideen),
    lektoratFindings: len(parsed?.lektorat?.pageChecks),
  };
  const has = Object.values(out).some((n) => n > 0);
  return has ? out : null;
}

// Kapitel (inkl. Sub-Kapitel) im node-Tree zaehlen.
function _countChapters(nodes) {
  let n = 0;
  (function walk(list) {
    for (const node of (list || [])) {
      if (node && node.type === 'chapter') { n += 1; walk(node.children); }
    }
  })(nodes);
  return n;
}

// Selbsttragende Momentaufnahme des aktuellen Buchstands bauen (content_json +
// extras_json + Stats). Gemeinsame Basis fuer „Fassung speichern" und die
// automatische Sicherung vor einem Restore. Wirft typisierte Fehler:
//   BOOK_EMPTY     — Buch hat keine Seiten
//   CAPTURE_FAILED — Load der Inhalte fehlgeschlagen
async function _buildSnapshotPayload(bookId, req) {
  let book, tree;
  try {
    [book, tree] = await Promise.all([
      contentStore.loadBook(bookId, req),
      contentStore.bookTree(bookId, req),
    ]);
  } catch (e) {
    if (e.status === 404) throw _err('NOT_FOUND');
    throw _err('CAPTURE_FAILED');
  }

  const metas = _collectMetas(tree);
  if (!metas.length) throw _err('BOOK_EMPTY');

  let details;
  try {
    details = await contentStore.loadPagesBatch(metas, req, { batchSize: 15, onError: () => null });
  } catch (e) {
    throw _err('CAPTURE_FAILED');
  }
  const htmlById = new Map();
  for (const d of details) if (d && d.id) htmlById.set(d.id, d.html || '');

  // Manuskript-Bild-BLOBs mitziehen, damit sie einen Restore ueberleben
  // (Restore wiped Seiten → CASCADE loescht page_images, neue page_ids).
  const { collectReferencedImages } = require('../db/page-images');
  const imagesByPage = collectReferencedImages(htmlById);
  const nodes = treeToNodes(tree, htmlById, imagesByPage);
  const settings = (() => { try { return getBookSettings(bookId); } catch { return null; } })();
  const content = buildBookJson({ book, settings, nodes });

  // Stats aus dem inline-HTML (gleiche Normalisierung wie page_stats).
  let chars = 0; let words = 0;
  for (const html of htmlById.values()) {
    const text = htmlToPlainText(html);
    chars += text.length;
    if (text) words += text.split(/\s+/).filter(Boolean).length;
  }

  // Extras (Analyse + Lektorat) synchron einsammeln — reiner DB-Read, kein KI-Call.
  // Aus den eingefrorenen page_checks gleich die verdichtete Fehler-Kennzahl
  // (offen/angenommen/alle je Typ) ableiten → Basis für den Fehlerdichte-Trend
  // über die Fassungen, ohne den extras_json-Blob ausliefern zu müssen.
  let extrasJson = null;
  let lektoratMetrics = null;
  try {
    const extras = collectExtras(bookId, { analysis: true, lektorat: true });
    if (extras && (extras.analysis || extras.lektorat)) extrasJson = JSON.stringify(extras);
    const checks = extras?.lektorat?.pageChecks;
    if (Array.isArray(checks) && checks.length) {
      const { computeLektoratMetrics } = require('../lib/lektorat-metrics');
      lektoratMetrics = JSON.stringify(computeLektoratMetrics(checks));
    }
  } catch (e) {
    logger.warn(`Snapshot-Extras fehlgeschlagen (book=${bookId}): ${e.message}`);
  }

  // Publikations-Metadaten selbsttragend einfrieren (Titelei/epub_*-Optionen +
  // Cover/Autorfoto als base64), damit ein Fassungs-Export den Stand zum Capture-
  // Zeitpunkt nutzt statt der Live-book_publication. Nur wenn eine echte Zeile
  // existiert (getMeta.created_at) — sonst faellt der Export auf die Live-Defaults.
  let publicationJson = null;
  try {
    const bp = require('../db/book-publication');
    const meta = bp.getMeta(bookId);
    if (meta && meta.created_at) {
      const pub = { meta };
      if (meta.has_cover) {
        const c = bp.getCover(bookId);
        if (c && c.image) pub.cover = { b64: c.image.toString('base64'), mime: c.mime || 'image/jpeg' };
      }
      if (meta.has_author_image) {
        const a = bp.getAuthorImage(bookId);
        if (a && a.image) pub.authorImage = { b64: a.image.toString('base64'), mime: a.mime || 'image/jpeg' };
      }
      publicationJson = JSON.stringify(pub);
    }
  } catch (e) {
    logger.warn(`Snapshot-Publikation fehlgeschlagen (book=${bookId}): ${e.message}`);
  }

  return { content, extrasJson, publicationJson, lektoratMetrics, chars, words, pages: htmlById.size, chapters: _countChapters(nodes) };
}

// Wiederverwendbarer Capture-Einstieg fuer Auto-Sicherungen aus anderen Routen
// (z.B. „Buch als fertig markiert" in routes/booksettings.js). Baut denselben
// selbsttragenden Payload wie „Fassung speichern" und legt eine Zeile an.
// dedup=true → ueberspringt, wenn die juengste Fassung denselben (chars/pages/
// chapters)-Stand hat (kein Auto-Duplikat). Wirft NICHT — liefert null bei leerem
// Buch, Dedup-Treffer oder Fehler (Aufrufer sind best-effort).
async function captureSnapshot(bookId, req, { label = null, description = null, dedup = false, userEmail = null } = {}) {
  let payload;
  try {
    payload = await _buildSnapshotPayload(bookId, req);
  } catch (e) {
    if (e.code !== 'BOOK_EMPTY') logger.warn(`Auto-Capture fehlgeschlagen (book=${bookId}): ${e.message}`);
    return null;
  }
  if (dedup) {
    const sig = snapshots.latestSignature(bookId);
    if (sig && sig.chars === payload.chars && sig.pages === payload.pages && sig.chapters === payload.chapters) {
      return null;
    }
  }
  try {
    return snapshots.createSnapshot({
      bookId, label, description,
      contentJson: JSON.stringify(payload.content), extrasJson: payload.extrasJson,
      publicationJson: payload.publicationJson, lektoratMetrics: payload.lektoratMetrics,
      chars: payload.chars, words: payload.words, pages: payload.pages, chapters: payload.chapters,
      userEmail,
    });
  } catch (e) {
    logger.warn(`Auto-Capture-Insert fehlgeschlagen (book=${bookId}): ${e.message}`);
    return null;
  }
}

// ── List ──────────────────────────────────────────────────────────────────────
router.get('/:bookId', (req, res) => {
  const bookId = toIntId(req.params.bookId);
  if (!bookId) return res.status(400).json({ error_code: 'ID_REQUIRED' });
  setContext({ book: bookId });
  try { requireBookAccess(req, bookId, 'viewer'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }

  try {
    return res.json({ snapshots: snapshots.listSnapshots(bookId) });
  } catch (e) {
    logger.error(`Snapshot-Liste fehlgeschlagen (book=${bookId}): ${e.message}`);
    return res.status(500).json({ error_code: 'LIST_FAILED' });
  }
});

// ── Drift (lohnt sich eine neue Fassung?) ───────────────────────────────────────
// Vergleicht den aktuellen Buchstand mit der juengsten Fassung, OHNE eine anzulegen:
//   text  — Anteil des editierten Wort-Volumens (0% unveraendert, ~100% Umschrieb)
//   publication/settings — geaenderte Titelei-/Einstellungs-Felder
// `worthwhile` = Text-Drift >= Schwelle ODER Publikation/Einstellungen geaendert.
// Baut den aktuellen Payload wie der Capture (reiner DB-Read, kein KI-Call).
router.get('/:bookId/drift', async (req, res) => {
  const bookId = toIntId(req.params.bookId);
  if (!bookId) return res.status(400).json({ error_code: 'ID_REQUIRED' });
  setContext({ book: bookId });
  try { requireBookAccess(req, bookId, 'viewer'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }

  const baseline = snapshots.getLatestSnapshot(bookId);
  if (!baseline) return res.json({ hasBaseline: false });

  let baselineContent, baselineSettings;
  try {
    baselineContent = JSON.parse(baseline.content_json);
    baselineSettings = baselineContent?.book?.settings || null;
  } catch {
    return res.status(422).json({ error_code: 'CORRUPT_SNAPSHOT' });
  }
  const basePub = snapshotPublication(baseline.publication_json);
  const baselinePubMeta = basePub ? basePub.meta : null;

  let payload;
  try {
    payload = await _buildSnapshotPayload(bookId, req);
  } catch (e) {
    if (e.code === 'BOOK_EMPTY') return res.json({ hasBaseline: false, empty: true });
    logger.error(`Drift-Check fehlgeschlagen (book=${bookId}): ${e.message}`);
    return res.status(502).json({ error_code: 'DRIFT_FAILED' });
  }
  const currentSettings = payload.content?.book?.settings || null;
  const curPub = snapshotPublication(payload.publicationJson);
  const currentPubMeta = curPub ? curPub.meta : null;

  const { computeDrift } = require('../lib/snapshot-drift');
  const drift = computeDrift({
    baselineContent, currentContent: payload.content,
    baselinePubMeta, currentPubMeta,
    baselineSettings, currentSettings,
  });

  return res.json({
    hasBaseline: true,
    baseline: {
      id: baseline.id, seq: baseline.seq, label: baseline.label,
      created_at: baseline.created_at,
    },
    drift,
  });
});

// ── Get (content only, fuer Diff) ──────────────────────────────────────────────
router.get('/:bookId/:id', (req, res) => {
  const bookId = toIntId(req.params.bookId);
  const id = toIntId(req.params.id);
  if (!bookId || !id) return res.status(400).json({ error_code: 'ID_REQUIRED' });
  setContext({ book: bookId });
  try { requireBookAccess(req, bookId, 'viewer'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }

  const row = snapshots.getSnapshot(bookId, id);
  if (!row) return res.status(404).json({ error_code: 'NOT_FOUND' });

  let content;
  try { content = JSON.parse(row.content_json); }
  catch { return res.status(500).json({ error_code: 'CORRUPT_SNAPSHOT' }); }

  // extras_json (MB-gross) nicht roh mitliefern — nur eine kompakte Zaehl-
  // Uebersicht (Publikations-Nachweis: Weltaufbau-/Lektorat-Stand zum Capture-
  // Zeitpunkt). Publikations-Metadaten als TEXT-Meta (ohne Cover/Foto-BLOBs) fuer
  // den Metadaten-Diff im Vergleich.
  const publication = snapshotPublication(row.publication_json);
  return res.json({
    snapshot: {
      id: row.id, seq: row.seq, label: row.label, description: row.description,
      chars: row.chars, words: row.words, pages: row.pages, chapters: row.chapters,
      user_email: row.user_email, created_at: row.created_at, published_at: row.published_at || null,
      has_publication: row.publication_json ? 1 : 0,
      publication: publication ? publication.meta : null,
      extras_summary: _extrasSummary(row.extras_json),
      content,
    },
  });
});

// ── Export (Fassung in pdf/html/txt/md/epub/docx) ───────────────────────────────
// Exportiert den selbsttragenden Stand der Fassung — unabhaengig vom aktuellen
// Buchinhalt. PDF laeuft NICHT hier, sondern als Job (routes/jobs/pdf-export.js
// mit snapshotId), wegen Render-Dauer + Profil-Auswahl. Synchroner Pfad wie
// routes/export.js (reiner DB-Read + Build).
router.get('/:bookId/:id/export/:fmt', async (req, res) => {
  const bookId = toIntId(req.params.bookId);
  const id = toIntId(req.params.id);
  const fmt = String(req.params.fmt || '').toLowerCase();
  if (!bookId || !id) return res.status(400).json({ error_code: 'ID_REQUIRED' });
  setContext({ book: bookId });
  try { requireBookAccess(req, bookId, 'viewer'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }

  // PDF laeuft ausschliesslich ueber den Job-Pfad (Custom-Profile) — hier nicht.
  const spec = fmt === 'pdf' ? null : FORMATS[fmt];
  if (!spec) return res.status(400).json({ error_code: 'BAD_FORMAT' });

  const row = snapshots.getSnapshot(bookId, id);
  if (!row) return res.status(404).json({ error_code: 'SNAPSHOT_NOT_FOUND' });

  let bundle;
  try {
    const content = JSON.parse(row.content_json);
    validateBookJson(content);
    bundle = snapshotToBundle(content, { bookId });
    if (!bundle.groups.length) throw _err('CORRUPT_SNAPSHOT');
  } catch (e) {
    logger.error(`Fassungs-Export: Fassung defekt (book=${bookId}, id=${id}): ${e.message}`);
    return res.status(422).json({ error_code: 'CORRUPT_SNAPSHOT' });
  }

  // Eingefrorene Publikation der Fassung bevorzugen (fmt='epub' konsumiert sie);
  // fehlt sie, faellt buildExportMeta auf die Live-book_publication zurueck.
  const publication = snapshotPublication(row.publication_json);

  // Quellen-Fundstellen der FASSUNG aus deren eingefrorenem HTML, nicht aus
  // `source_citations`: der Fund-Index beschreibt den heutigen Seitenstand, die
  // Fassung aber einen alten — sonst traegt ein Chip im numerischen Stil eine
  // Nummer, die zum Verzeichnis dieser Fassung nicht passt. Die Quellen-Stammdaten
  // bleiben bewusst live (eine korrigierte ISBN soll auch hier stimmen).
  let citations = null;
  try {
    const { citationsFromGroups } = require('../lib/bibliography');
    citations = await citationsFromGroups(bundle.groups);
  } catch (e) {
    logger.warn(`Fassungs-Export: Fundstellen nicht lesbar (book=${bookId}, id=${id}): ${e.message}`);
  }

  let buf;
  try {
    buf = await spec.build(bundle, await buildExportMeta(bookId, fmt, {
      publication, citations, userEmail: req.session?.user?.email || null,
    }));
  } catch (e) {
    logger.error(`Fassungs-Export-Build fehlgeschlagen (book=${bookId}, id=${id}, fmt=${fmt}): ${e.message}`);
    return res.status(502).json({ error_code: 'EXPORT_FAILED' });
  }

  const { resolveSlug } = require('../lib/export-builders/shared');
  const slug = `${resolveSlug(bundle)}-fassung-${row.seq}`;
  const filename = buildExportFilename({ prefix: 'fassung', slug, ext: spec.ext || fmt, date: new Date() });
  const sizeKb = Math.round((Buffer.isBuffer(buf) ? buf.length : Buffer.byteLength(buf)) / 1024);
  logger.info(`Fassungs-Export «${filename}» (${sizeKb} KB, book=${bookId}, seq=${row.seq}, fmt=${fmt})`);
  return sendExportBuffer(res, { spec, buf, filename });
});

// ── Create (Fassung speichern) ──────────────────────────────────────────────────
router.post('/:bookId', express.json({ limit: '1mb' }), async (req, res) => {
  const bookId = toIntId(req.params.bookId);
  if (!bookId) return res.status(400).json({ error_code: 'ID_REQUIRED' });
  setContext({ book: bookId });
  try { requireBookAccess(req, bookId, 'editor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }

  const label = _clip(req.body?.label, LABEL_MAX);
  const description = _clip(req.body?.description, DESC_MAX);

  let payload;
  try {
    payload = await _buildSnapshotPayload(bookId, req);
  } catch (e) {
    if (e.code === 'NOT_FOUND') return res.status(404).json({ error_code: 'NOT_FOUND' });
    if (e.code === 'BOOK_EMPTY') return res.status(400).json({ error_code: 'BOOK_EMPTY' });
    logger.error(`Snapshot-Capture fehlgeschlagen (book=${bookId}): ${e.message}`);
    return res.status(502).json({ error_code: 'CAPTURE_FAILED' });
  }

  const userEmail = req.session?.user?.email || null;
  let created;
  try {
    created = snapshots.createSnapshot({
      bookId, label, description,
      contentJson: JSON.stringify(payload.content), extrasJson: payload.extrasJson,
      publicationJson: payload.publicationJson, lektoratMetrics: payload.lektoratMetrics,
      chars: payload.chars, words: payload.words, pages: payload.pages, chapters: payload.chapters,
      userEmail,
    });
  } catch (e) {
    logger.error(`Snapshot-Insert fehlgeschlagen (book=${bookId}): ${e.message}`);
    return res.status(500).json({ error_code: 'CAPTURE_FAILED' });
  }

  logger.info(`Snapshot «Fassung ${created.seq}» angelegt (book=${bookId}, pages=${payload.pages}, chars=${payload.chars}).`);
  return res.json({
    snapshot: {
      id: created.id, seq: created.seq, label, description,
      chars: payload.chars, words: payload.words, pages: payload.pages, chapters: payload.chapters,
      user_email: userEmail,
      created_at: new Date().toISOString(), published_at: null,
      has_extras: payload.extrasJson ? 1 : 0,
      has_publication: payload.publicationJson ? 1 : 0,
    },
  });
});

// ── Restore (Buch auf eine Fassung zuruecksetzen) ───────────────────────────────
// Destruktiv: ersetzt den GESAMTEN aktuellen Buchinhalt (Kapitel + Seiten) durch
// den Stand der Ziel-Fassung. Vorher wird automatisch eine Sicherung des
// aktuellen Stands als neue Fassung abgelegt → der Schritt ist umkehrbar.
// Synchroner Pfad wie der Capture (reiner DB-Read/-Write, kein KI-/Netz-Call).
router.post('/:bookId/:id/restore', express.json({ limit: '1mb' }), async (req, res) => {
  const bookId = toIntId(req.params.bookId);
  const id = toIntId(req.params.id);
  if (!bookId || !id) return res.status(400).json({ error_code: 'ID_REQUIRED' });
  setContext({ book: bookId });
  try { requireBookAccess(req, bookId, 'editor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }

  // Ziel-Fassung laden + zu Op-Liste planen.
  const row = snapshots.getSnapshot(bookId, id);
  if (!row) return res.status(404).json({ error_code: 'NOT_FOUND' });
  let plan;
  try {
    const content = JSON.parse(row.content_json);
    validateBookJson(content);
    plan = planFromNodes(content.tree);
    if (!plan.ops.length) throw _err('CORRUPT_SNAPSHOT');
    plan.settings = content.book?.settings || null;
  } catch (e) {
    logger.error(`Restore: Ziel-Fassung defekt (book=${bookId}, id=${id}): ${e.message}`);
    return res.status(422).json({ error_code: 'CORRUPT_SNAPSHOT' });
  }

  const userEmail = req.session?.user?.email || null;

  // 0) Lock: ein Voll-Restore ersetzt das GANZE Buch. Editiert gerade ein
  //    ANDERER User am Buch (Live-Presence, stale-gefiltert >90s), gehen seine
  //    parallelen Writes waehrend Wipe/Recreate verloren → blocken. Die eigene
  //    Presence (auch auf anderen Geraeten) zaehlt nicht. Der User kann mit
  //    ?force=1 uebersteuern (Frontend zeigt vorher eine staerkere Bestaetigung
  //    mit den aktiven Namen).
  const force = req.query.force === '1' || req.query.force === 'true';
  if (!force) {
    const selfLc = (userEmail || '').toLowerCase();
    let others = [];
    try {
      others = pagePresence.listForBook(bookId)
        .filter((r) => String(r.user_email || '').toLowerCase() !== selfLc);
    } catch (e) { logger.warn(`Restore-Presence-Check fehlgeschlagen (book=${bookId}): ${e.message}`); }
    if (others.length) {
      const editors = [...new Set(others.map((r) => r.user_display_name || r.user_email).filter(Boolean))];
      logger.info(`Restore blockiert: Buch ${bookId} wird von ${editors.length} anderen editiert.`);
      return res.status(409).json({ error_code: 'BOOK_BUSY', editors });
    }
  }

  // 1) Automatische Sicherung des aktuellen Stands → Restore bleibt umkehrbar.
  //    BOOK_EMPTY (Buch hat gerade keine Seiten) ist ok — dann gibt es nichts zu
  //    sichern. Jeder andere Fehler bricht ab, bevor wir etwas loeschen.
  try {
    const cur = await _buildSnapshotPayload(bookId, req);
    snapshots.createSnapshot({
      bookId, label: AUTO_BACKUP_LABEL, description: null,
      contentJson: JSON.stringify(cur.content), extrasJson: cur.extrasJson,
      publicationJson: cur.publicationJson, lektoratMetrics: cur.lektoratMetrics,
      chars: cur.chars, words: cur.words, pages: cur.pages, chapters: cur.chapters,
      userEmail,
    });
  } catch (e) {
    if (e.code !== 'BOOK_EMPTY') {
      logger.error(`Restore-Sicherung fehlgeschlagen (book=${bookId}): ${e.message}`);
      return res.status(500).json({ error_code: 'BACKUP_FAILED' });
    }
  }

  // 2) Aktuellen Inhalt komplett entfernen. pages.chapter_id und
  //    chapters.parent_chapter_id sind ON DELETE SET NULL → Loeschen eines
  //    Kapitels entfernt weder Seiten noch Sub-Kapitel; darum beides explizit
  //    abraeumen. Order-Overlay loeschen, sonst zeigt es auf alte IDs.
  try {
    for (const p of await contentStore.listPages(bookId, req)) {
      await contentStore.deletePage(p.id, req);
    }
    for (const c of await contentStore.listChapters(bookId, req)) {
      await contentStore.deleteChapter(c.id, req);
    }
    bookOrder.clearOrder(bookId);
  } catch (e) {
    logger.error(`Restore-Wipe fehlgeschlagen (book=${bookId}): ${e.message}`);
    return res.status(500).json({ error_code: 'RESTORE_FAILED' });
  }

  // 3) Inhalt der Ziel-Fassung neu anlegen (gleiche Op-Reihenfolge wie Buch-Import).
  const chapterIdByTemp = new Map();
  let pagesCreated = 0; let chaptersCreated = 0;
  for (const o of plan.ops) {
    const parentChapterId = o.parentTempId == null ? null : (chapterIdByTemp.get(o.parentTempId) ?? null);
    try {
      if (o.op === 'chapter') {
        const ch = await contentStore.createChapter(
          { book_id: bookId, name: o.name || '', parent_chapter_id: parentChapterId }, req);
        chapterIdByTemp.set(o.tempId, ch.id);
        chaptersCreated += 1;
      } else if (o.op === 'page') {
        const created = await contentStore.createPage(
          { book_id: bookId, chapter_id: parentChapterId, name: o.name || '', html: o.html || '' }, req);
        pagesCreated += 1;
        // Mitgefuehrte Bild-BLOBs unter der neuen page_id neu einfuegen + die
        // /content/page-image/<oldId>-Refs im HTML auf die neuen IDs umschreiben.
        if (created?.id && o.images?.length) {
          const { restorePageImages } = require('../db/page-images');
          const rewritten = restorePageImages(created.id, o.html || '', o.images);
          if (rewritten != null) {
            try { await contentStore.savePage(created.id, { html: rewritten, source: 'import' }, req); }
            catch (e) { logger.warn(`Restore Bild-Rewrite «${o.name}» fehlgeschlagen (book=${bookId}): ${e.message}`); }
          }
        }
      }
    } catch (e) {
      logger.warn(`Restore createXxx «${o.name}» fehlgeschlagen (book=${bookId}): ${e.message}`);
    }
  }

  // 4) Buch-Settings der Fassung uebernehmen (best-effort). allow_lektor_book_chat
  //    bewusst 0 lassen — ACL-relevant, nicht Teil der Inhalts-Fassung.
  const s = plan.settings;
  if (s && typeof s === 'object') {
    try {
      saveBookSettings(
        bookId, s.language || 'de', s.region || 'CH', s.buchtyp || null, s.buch_kontext || null,
        s.erzaehlperspektive || null, s.erzaehlzeit || null, s.is_finished ? 1 : 0, 0,
        Number.isFinite(s.daily_goal_chars) ? s.daily_goal_chars : null,
        s.orte_real ? 1 : 0, s.schauplatz_land || null,
      );
      if (s.entities_enabled) setBookEntitiesEnabled(bookId, 1);
    } catch (e) { logger.warn(`Restore-Settings fehlgeschlagen (book=${bookId}): ${e.message}`); }
  }

  // 4b) Eingefrorene Publikation zurueckschreiben (best-effort, Voll-Replace wie
  //     upsertMeta). Cover/Autorfoto auf den Fassungs-Stand setzen — fehlt das
  //     BLOB in der Fassung, wird das Live-Bild geloescht (Restore = auf den
  //     eingefrorenen Stand setzen). Die Auto-Sicherung oben hat den vorherigen
  //     Publikations-Stand mitgefroren → umkehrbar.
  const pub = snapshotPublication(row.publication_json);
  if (pub) {
    try {
      const bp = require('../db/book-publication');
      bp.upsertMeta(bookId, pub.meta);
      if (pub.cover) bp.setCover(bookId, pub.cover.image, pub.cover.mime);
      else bp.clearCover(bookId);
      if (pub.authorImage) bp.setAuthorImage(bookId, pub.authorImage.image, pub.authorImage.mime);
      else bp.clearAuthorImage(bookId);
    } catch (e) { logger.warn(`Restore-Publikation fehlgeschlagen (book=${bookId}): ${e.message}`); }
  }

  // 5) Statistik neu syncen (Tages-Donut, Buch-Stats).
  try {
    const { syncBook } = require('./sync');
    await syncBook(bookId, req);
  } catch (e) { logger.warn(`Restore-Sync fehlgeschlagen (book=${bookId}): ${e.message}`); }

  logger.info(`Buch auf «Fassung ${row.seq}» zurueckgesetzt (book=${bookId}, pages=${pagesCreated}, chapters=${chaptersCreated}).`);
  return res.json({ ok: true, seq: row.seq, pagesCreated, chaptersCreated });
});

// ── Publish (Fassung als veroeffentlichte Auflage markieren) ────────────────────
// Kennzeichnet die Fassung, die als Auflage erschienen ist (Publikations-Anker).
// Body { published: bool }. Mehrere Fassungen duerfen markiert sein.
router.post('/:bookId/:id/publish', express.json({ limit: '4kb' }), (req, res) => {
  const bookId = toIntId(req.params.bookId);
  const id = toIntId(req.params.id);
  if (!bookId || !id) return res.status(400).json({ error_code: 'ID_REQUIRED' });
  setContext({ book: bookId });
  try { requireBookAccess(req, bookId, 'editor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }

  const published = !!req.body?.published;
  try {
    const ok = snapshots.setPublished(bookId, id, published);
    if (!ok) return res.status(404).json({ error_code: 'NOT_FOUND' });
    const row = snapshots.getSnapshot(bookId, id);
    logger.info(`Fassung ${row?.seq} ${published ? 'als veroeffentlicht markiert' : 'Markierung entfernt'} (book=${bookId}).`);
    return res.json({ ok: true, published_at: row?.published_at || null });
  } catch (e) {
    logger.error(`Snapshot-Publish fehlgeschlagen (book=${bookId}, id=${id}): ${e.message}`);
    return res.status(500).json({ error_code: 'PUBLISH_FAILED' });
  }
});

// ── Delete ──────────────────────────────────────────────────────────────────────
// Veroeffentlichte Fassungen sind schreibgeschuetzt: Loeschen verlangt ?force=1
// (Frontend zeigt eine staerkere Bestaetigung), damit ein Publikations-Anker nicht
// versehentlich verloren geht.
router.delete('/:bookId/:id', (req, res) => {
  const bookId = toIntId(req.params.bookId);
  const id = toIntId(req.params.id);
  if (!bookId || !id) return res.status(400).json({ error_code: 'ID_REQUIRED' });
  setContext({ book: bookId });
  try { requireBookAccess(req, bookId, 'editor'); }
  catch (e) { if (sendACLError(res, e)) return; throw e; }

  const force = req.query.force === '1' || req.query.force === 'true';
  const row = snapshots.getSnapshot(bookId, id);
  if (!row) return res.status(404).json({ error_code: 'NOT_FOUND' });
  if (row.published_at && !force) {
    return res.status(409).json({ error_code: 'SNAPSHOT_PUBLISHED' });
  }

  try {
    const ok = snapshots.deleteSnapshot(bookId, id);
    if (!ok) return res.status(404).json({ error_code: 'NOT_FOUND' });
    return res.json({ ok: true });
  } catch (e) {
    logger.error(`Snapshot-Delete fehlgeschlagen (book=${bookId}, id=${id}): ${e.message}`);
    return res.status(500).json({ error_code: 'DELETE_FAILED' });
  }
});

module.exports = router;
module.exports.captureSnapshot = captureSnapshot;
