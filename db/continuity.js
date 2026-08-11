'use strict';
// Kontinuitaetspruefung + Faktencheck: eine Zeile pro Issue
// (`continuity_issues`) plus Bruecken-Tabellen fuer Figuren-/Kapitel-Referenzen.
// Vorbild: figure_scenes mit scene_figures/scene_locations.

const { db } = require('./connection');
// Prepared Statements dieses Moduls sitzen auf migrierten Spalten — die
// Migrationen muessen vor dem Anlegen gelaufen sein.
require('./migrations');
const { NOW_ISO_SQL } = require('./now');
const { toRefString: _toRefString } = require('./write-helpers');

// Eine Zeile pro Issue (continuity_issues) plus Bridge-Tabellen für Figuren-/
// Kapitel-Referenzen. Vorbild: figure_scenes mit scene_figures/scene_locations.

const _insContinuityCheck = db.prepare(
  `INSERT INTO continuity_checks (book_id, user_email, checked_at, summary, model)
   VALUES (?, ?, ${NOW_ISO_SQL}, ?, ?)`
);
const _insContinuityIssue = db.prepare(
  `INSERT INTO continuity_issues
   (check_id, book_id, user_email, schwere, typ, beschreibung, stelle_a, stelle_b, empfehlung, quelle, sort_order, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL})`
);
const _insContinuityIssueFig = db.prepare(
  `INSERT INTO continuity_issue_figures (issue_id, figure_id, figur_name, sort_order) VALUES (?, ?, ?, ?)`
);
const _insContinuityIssueCh = db.prepare(
  `INSERT INTO continuity_issue_chapters (issue_id, chapter_id, sort_order) VALUES (?, ?, ?)`
);

/** Speichert einen Kontinuitäts-Check mit allen Issues als eigene Zeilen.
 *  issues: [{schwere, typ, beschreibung, stelle_a, stelle_b, empfehlung,
 *            figuren:[Namen], kapitel:[Namen]}]
 *  figNameToId / chNameToId: Auflösungs-Maps (Name → fig_id / chapter_id).
 *  Gibt { checkId, normalizedIssues } zurück, wobei normalizedIssues die
 *  Frontend-Form mit fig_ids/chapter_ids enthält (kompatibel zur alten Antwort). */
// Eine Issue-Zeile + Figuren-/Kapitel-Bridges anlegen und die Frontend-Normalform
// zurückgeben. Geteilt von saveContinuityCheck (Voll-Check) und saveFaktencheckIssues
// (Anhang an bestehenden Check). figIdToRowId: TEXT-fig_id → INTEGER figures.id.
function _persistOneContinuityIssue(cid, bookIdInt, email, it, sortIndex, figNameToId, figIdToRowId, chNameToId) {
  const { lastInsertRowid: issueId } = _insContinuityIssue.run(
    cid, bookIdInt, email,
    it.schwere || null, it.typ || null, it.beschreibung || null,
    it.stelle_a || null, it.stelle_b || null, it.empfehlung || null,
    it.quelle || null,
    sortIndex,
  );
  const figNames = Array.isArray(it.figuren) ? it.figuren.map(_toRefString).filter(Boolean) : [];
  const fig_ids = [];
  const seenFig = new Set();
  figNames.forEach((name, j) => {
    const fid = figNameToId?.[name] || null;
    const key = (fid || '') + '|' + name;
    if (seenFig.has(key)) return;
    seenFig.add(key);
    if (fid) fig_ids.push(fid);
    const figureRowId = fid ? (figIdToRowId[fid] ?? null) : null;
    _insContinuityIssueFig.run(issueId, figureRowId, name, j);
  });
  const chNames = Array.isArray(it.kapitel) ? it.kapitel.map(_toRefString).filter(Boolean) : [];
  const chapter_ids = [];
  const seenCh = new Set();
  chNames.forEach((name, j) => {
    const cidCh = chNameToId?.[name] ?? null;
    const key = (cidCh ?? '') + '|' + name;
    if (seenCh.has(key)) return;
    seenCh.add(key);
    if (cidCh != null) chapter_ids.push(cidCh);
    if (cidCh != null) _insContinuityIssueCh.run(issueId, cidCh, j);
  });
  return {
    id: issueId,
    schwere: it.schwere || null, typ: it.typ || null,
    beschreibung: it.beschreibung || null,
    stelle_a: it.stelle_a || null, stelle_b: it.stelle_b || null,
    empfehlung: it.empfehlung || null,
    quelle: it.quelle || null,
    figuren: figNames, fig_ids,
    kapitel: chNames, chapter_ids,
  };
}

function _figIdToRowIdMap(bookIdInt, email) {
  // continuity_issue_figures.figure_id ist INTEGER (figures.id) seit Mig 73 —
  // figNameToId liefert TEXT-fig_id, zusaetzlicher Lookup TEXT → INT.
  const figRows = db.prepare(
    'SELECT id, fig_id FROM figures WHERE book_id = ? AND user_email IS ?'
  ).all(bookIdInt, email);
  return Object.fromEntries(figRows.map(r => [r.fig_id, r.id]));
}

function saveContinuityCheck(bookId, userEmail, summary, model, issues, figNameToId, chNameToId) {
  const bookIdInt = parseInt(bookId);
  const email = userEmail || null;
  const normalizedIssues = [];
  let checkId = null;
  const figIdToRowId = _figIdToRowIdMap(bookIdInt, email);
  db.transaction(() => {
    const { lastInsertRowid: cid } = _insContinuityCheck.run(
      bookIdInt, email, summary || '', model || null,
    );
    checkId = cid;
    const issuesArr = Array.isArray(issues) ? issues : [];
    for (let i = 0; i < issuesArr.length; i++) {
      const { id, ...rest } = _persistOneContinuityIssue(cid, bookIdInt, email, issuesArr[i] || {}, i, figNameToId, figIdToRowId, chNameToId);
      normalizedIssues.push(rest);
    }
  })();
  return { checkId, normalizedIssues };
}

// Faktencheck-Befunde (typ='faktenfehler') an den NEUESTEN Kontinuitäts-Check anhängen,
// statt einen konkurrierenden Check anzulegen (getLatestContinuityCheck zeigt nur den
// neuesten → ein eigener Check würde die Kontinuitäts-Befunde verdecken). Idempotent:
// vorhandene faktenfehler-Zeilen dieses Checks werden zuerst gelöscht (Bridges via CASCADE),
// dann die neuen eingefügt. Gibt es noch keinen Check (Faktencheck vor jeder Komplettanalyse),
// wird einer angelegt. summaryFallback nur für diesen Neuanlage-Fall. Die Kontinuitäts-Befunde
// (andere typ) des Checks bleiben unberührt. */
function saveFaktencheckIssues(bookId, userEmail, model, issues, figNameToId, chNameToId, summaryFallback = '') {
  const bookIdInt = parseInt(bookId);
  const email = userEmail || null;
  const figIdToRowId = _figIdToRowIdMap(bookIdInt, email);
  const issuesArr = Array.isArray(issues) ? issues : [];
  const normalizedIssues = [];
  db.transaction(() => {
    let row = db.prepare(
      'SELECT id FROM continuity_checks WHERE book_id = ? AND user_email IS ? ORDER BY checked_at DESC LIMIT 1'
    ).get(bookIdInt, email);
    let cid = row?.id;
    if (!cid) {
      ({ lastInsertRowid: cid } = _insContinuityCheck.run(bookIdInt, email, summaryFallback || '', model || null));
    } else {
      db.prepare("DELETE FROM continuity_issues WHERE check_id = ? AND typ = 'faktenfehler'").run(cid);
    }
    // Neue faktenfehler ans Ende einsortieren (sort_order nach den bestehenden Issues).
    const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM continuity_issues WHERE check_id = ?').get(cid).m;
    for (let i = 0; i < issuesArr.length; i++) {
      const { id, ...rest } = _persistOneContinuityIssue(cid, bookIdInt, email, issuesArr[i] || {}, maxSort + 1 + i, figNameToId, figIdToRowId, chNameToId);
      normalizedIssues.push(rest);
    }
  })();
  return { normalizedIssues };
}

/** Lädt den letzten Kontinuitäts-Check eines Buchs in Frontend-Form
 *  ({id, checked_at, issues:[{...}], summary, model}) oder null. */
function getLatestContinuityCheck(bookId, userEmail) {
  const bookIdInt = parseInt(bookId);
  const email = userEmail || null;
  const row = db.prepare(`
    SELECT id, checked_at, summary, model
    FROM continuity_checks
    WHERE book_id = ? AND user_email IS ?
    ORDER BY checked_at DESC LIMIT 1
  `).get(bookIdInt, email);
  if (!row) return null;
  const issueRows = db.prepare(`
    SELECT id, schwere, typ, beschreibung, stelle_a, stelle_b, empfehlung, quelle, resolved
    FROM continuity_issues
    WHERE check_id = ?
    ORDER BY sort_order, id
  `).all(row.id);
  const figRows = db.prepare(`
    SELECT cif.issue_id, f.fig_id, cif.figur_name
    FROM continuity_issue_figures cif
    LEFT JOIN figures f ON f.id = cif.figure_id
    WHERE cif.issue_id IN (SELECT id FROM continuity_issues WHERE check_id = ?)
    ORDER BY cif.issue_id, cif.sort_order
  `).all(row.id);
  const chRows = db.prepare(`
    SELECT cic.issue_id, cic.chapter_id, c.chapter_name
    FROM continuity_issue_chapters cic
    LEFT JOIN chapters c ON c.chapter_id = cic.chapter_id
    WHERE cic.issue_id IN (SELECT id FROM continuity_issues WHERE check_id = ?)
    ORDER BY cic.issue_id, cic.sort_order
  `).all(row.id);
  const figByIssue = new Map();
  for (const r of figRows) {
    if (!figByIssue.has(r.issue_id)) figByIssue.set(r.issue_id, { figuren: [], fig_ids: [] });
    const bucket = figByIssue.get(r.issue_id);
    if (r.figur_name) bucket.figuren.push(r.figur_name);
    if (r.fig_id) bucket.fig_ids.push(r.fig_id);
  }
  const chByIssue = new Map();
  for (const r of chRows) {
    if (!chByIssue.has(r.issue_id)) chByIssue.set(r.issue_id, { kapitel: [], chapter_ids: [] });
    const bucket = chByIssue.get(r.issue_id);
    if (r.chapter_name) bucket.kapitel.push(r.chapter_name);
    if (r.chapter_id != null) bucket.chapter_ids.push(r.chapter_id);
  }
  const issues = issueRows.map(r => ({
    id: r.id,
    resolved: !!r.resolved,
    schwere: r.schwere, typ: r.typ, beschreibung: r.beschreibung,
    stelle_a: r.stelle_a, stelle_b: r.stelle_b, empfehlung: r.empfehlung,
    quelle: r.quelle || null,
    figuren: figByIssue.get(r.id)?.figuren || [],
    fig_ids: figByIssue.get(r.id)?.fig_ids || [],
    kapitel: chByIssue.get(r.id)?.kapitel || [],
    chapter_ids: chByIssue.get(r.id)?.chapter_ids || [],
  }));
  return { id: row.id, checked_at: row.checked_at, issues, summary: row.summary, model: row.model };
}

/** book_id eines Issues (fuer ACL/Log-Context vor der Mutation). null wenn unbekannt. */
function getContinuityIssueBookId(issueId) {
  const id = parseInt(issueId);
  if (!id) return null;
  const row = db.prepare('SELECT book_id FROM continuity_issues WHERE id = ?').get(id);
  return row ? row.book_id : null;
}

/** Setzt das resolved-Flag eines Kontinuitaets-Issues. resolved_at = jetzt bzw.
 *  null beim Wiederoeffnen. Gibt true zurueck, wenn eine Zeile betroffen war. */
function setContinuityIssueResolved(issueId, resolved) {
  const id = parseInt(issueId);
  if (!id) return false;
  const now = resolved ? new Date().toISOString() : null;
  const info = db.prepare(
    'UPDATE continuity_issues SET resolved = ?, resolved_at = ? WHERE id = ?'
  ).run(resolved ? 1 : 0, now, id);
  return info.changes > 0;
}

module.exports = {
  saveContinuityCheck,
  saveFaktencheckIssues,
  getLatestContinuityCheck,
  getContinuityIssueBookId,
  setContinuityIssueResolved,
};
