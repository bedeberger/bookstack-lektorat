'use strict';
const express = require('express');
const {
  getBookSettings, saveBookSettings, setBookEntitiesEnabled,
  setBookCitationSettings, VALID_CITATION_STYLES, VALID_BIBLIOGRAPHY_SCOPES, VALID_CITATION_NOTES,
  setBookXrefSettings,
} = require('../db/schema');
const { aclParamGuard } = require('../lib/acl');
const logger = require('../logger');
const { captureSnapshot } = require('./snapshots');

const router = express.Router();
const jsonBody = express.json();

// Label der Fassung, die beim Fertig-Markieren automatisch entsteht (Publikations-
// Meilenstein). __i18n:-Marker → Betrachter sieht die Bezeichnung in seiner Locale.
const AUTO_FINISH_LABEL = '__i18n:snapshots.autoFinishLabel__';

const VALID_LANGUAGES = ['de', 'en'];
const VALID_REGIONS   = ['CH', 'DE', 'US', 'GB'];
const VALID_BUCHTYPEN = ['roman', 'kurzgeschichten', 'gesellschaft', 'krimi', 'historisch', 'fantasy_scifi', 'erotik', 'jugend', 'autobiografie', 'tagebuch', 'sachbuch', 'wissenschaft', 'lyrik', 'essay', 'blog', 'satire', 'andere'];
const VALID_POV     = ['ich', 'er_sie_personal', 'er_sie_auktorial', 'du', 'wir', 'gemischt'];
const VALID_TEMPUS  = ['praeteritum', 'praesens', 'gemischt'];
const BUCH_KONTEXT_MAX = 1000;
// Stilprofil: KI-destilliert ~1-2k Zeichen; 6000 als grosszuegige Obergrenze
// gegen versehentliches Einfuegen ganzer Kapitel.
const STILPROFIL_MAX = 6000;
// Tagesziel: 100 Zeichen ≈ kurzer Tweet (Untergrenze gegen Tippfehler),
// 50 000 ≈ 33 Normseiten als praktisches Maximum.
const DAILY_GOAL_MIN = 100;
const DAILY_GOAL_MAX = 50000;
// Schreibziel (gesamt): 1 000 Zeichen Untergrenze, 20 Mio (~13 000 Normseiten)
// als praktisches Maximum gegen Tippfehler.
const GOAL_TARGET_MIN = 1000;
const GOAL_TARGET_MAX = 20000000;
// Verzeichnis-Ueberschrift ("Literaturverzeichnis", "Quellen", …). Leer =
// Sprach-Default des Renderers.
const BIBLIOGRAPHY_TITLE_MAX = 200;

/** Gibt Sprache, Region, Buchtyp und Buchkontext für ein Buch zurück. */
router.get('/:book_id', aclParamGuard('viewer'), (req, res) => {
  const bookId = req.bookId;
  const settings = getBookSettings(bookId, req.session?.user?.email || null);
  res.json(settings);
});

/** Speichert Sprache, Region, Buchtyp und Buchkontext für ein Buch. */
router.put('/:book_id', aclParamGuard('editor'), jsonBody, (req, res) => {
  const bookId = req.bookId;

  const { language, region, buchtyp, buch_kontext, stilprofil, erzaehlperspektive, erzaehlzeit, is_finished, allow_lektor_book_chat, daily_goal_chars, goal_target_chars, goal_deadline, orte_real, schauplatz_land, zeitlinie_real, weltfakten_real_pruefen, exclude_from_stats } = req.body || {};
  if (!language || !region) {
    return res.status(400).json({ error_code: 'LANGUAGE_REGION_REQUIRED' });
  }
  if (!VALID_LANGUAGES.includes(language)) {
    return res.status(400).json({ error_code: 'INVALID_LANGUAGE', params: { allowed: VALID_LANGUAGES.join(', ') } });
  }
  if (!VALID_REGIONS.includes(region)) {
    return res.status(400).json({ error_code: 'INVALID_REGION', params: { allowed: VALID_REGIONS.join(', ') } });
  }
  if (buchtyp && !VALID_BUCHTYPEN.includes(buchtyp)) {
    return res.status(400).json({ error_code: 'INVALID_BUCHTYP', params: { allowed: VALID_BUCHTYPEN.join(', ') } });
  }
  if (buch_kontext && buch_kontext.length > BUCH_KONTEXT_MAX) {
    return res.status(400).json({ error_code: 'BUCH_KONTEXT_TOO_LONG', params: { max: BUCH_KONTEXT_MAX } });
  }
  if (stilprofil && String(stilprofil).length > STILPROFIL_MAX) {
    return res.status(400).json({ error_code: 'STILPROFIL_TOO_LONG', params: { max: STILPROFIL_MAX } });
  }
  if (erzaehlperspektive && !VALID_POV.includes(erzaehlperspektive)) {
    return res.status(400).json({ error_code: 'INVALID_POV', params: { allowed: VALID_POV.join(', ') } });
  }
  if (erzaehlzeit && !VALID_TEMPUS.includes(erzaehlzeit)) {
    return res.status(400).json({ error_code: 'INVALID_TEMPUS', params: { allowed: VALID_TEMPUS.join(', ') } });
  }
  let dailyGoal = null;
  if (daily_goal_chars !== undefined && daily_goal_chars !== null && daily_goal_chars !== '') {
    const n = Number(daily_goal_chars);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < DAILY_GOAL_MIN || n > DAILY_GOAL_MAX) {
      return res.status(400).json({ error_code: 'INVALID_VALUE', params: { field: 'daily_goal_chars', allowed: `${DAILY_GOAL_MIN}–${DAILY_GOAL_MAX}` } });
    }
    dailyGoal = n;
  }

  // Schreibziel: Zielzeichenzahl (gesamt). NULL/leer = kein Ziel.
  let goalTarget = null;
  if (goal_target_chars !== undefined && goal_target_chars !== null && goal_target_chars !== '') {
    const n = Number(goal_target_chars);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < GOAL_TARGET_MIN || n > GOAL_TARGET_MAX) {
      return res.status(400).json({ error_code: 'INVALID_VALUE', params: { field: 'goal_target_chars', allowed: `${GOAL_TARGET_MIN}–${GOAL_TARGET_MAX}` } });
    }
    goalTarget = n;
  }

  // Abgabedatum: striktes ISO YYYY-MM-DD. NULL/leer = keine Deadline.
  let goalDeadline = null;
  if (goal_deadline !== undefined && goal_deadline !== null && goal_deadline !== '') {
    const s = String(goal_deadline);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) {
      return res.status(400).json({ error_code: 'INVALID_VALUE', params: { field: 'goal_deadline', allowed: 'YYYY-MM-DD' } });
    }
    goalDeadline = s;
  }

  let schauplatzLand = null;
  if (schauplatz_land !== undefined && schauplatz_land !== null && schauplatz_land !== '') {
    if (!/^[A-Za-z]{2}$/.test(String(schauplatz_land))) {
      return res.status(400).json({ error_code: 'INVALID_VALUE', params: { field: 'schauplatz_land', allowed: 'ISO-3166-1-alpha-2' } });
    }
    schauplatzLand = String(schauplatz_land).toLowerCase();
  }

  const finished = is_finished ? 1 : 0;
  const lektorBookChat = allow_lektor_book_chat ? 1 : 0;
  const orteReal = orte_real ? 1 : 0;
  const zeitlinieReal = zeitlinie_real ? 1 : 0;
  const weltfaktenRealPruefen = weltfakten_real_pruefen ? 1 : 0;
  const excludeStats = exclude_from_stats ? 1 : 0;

  // Vorheriger Fertig-Status fuer die Auto-Fassung beim 0→1-Uebergang.
  const wasFinished = getBookSettings(bookId, req.session?.user?.email || null)?.is_finished ? 1 : 0;

  saveBookSettings(bookId, language, region, buchtyp || null, buch_kontext || null, erzaehlperspektive || null, erzaehlzeit || null, finished, lektorBookChat, dailyGoal, orteReal, schauplatzLand, goalTarget, goalDeadline, stilprofil || null, zeitlinieReal, excludeStats, weltfaktenRealPruefen);

  // Publikations-Meilenstein: Buch frisch als fertig markiert (0→1) → automatisch
  // eine Fassung festhalten (dedup gegen die juengste, damit kein Duplikat
  // entsteht, falls der Stand bereits festgehalten wurde). Best-effort und
  // fire-and-forget — blockiert das Settings-Speichern nicht und darf nie werfen.
  if (finished && !wasFinished) {
    captureSnapshot(bookId, req, {
      label: AUTO_FINISH_LABEL, dedup: true, userEmail: req.session?.user?.email || null,
    }).catch((e) => logger.warn(`Auto-Fassung beim Fertig-Markieren fehlgeschlagen (book=${bookId}): ${e.message}`));
  }

  res.json({
    ok: true, language, region,
    buchtyp: buchtyp || null, buch_kontext: buch_kontext || null,
    stilprofil: stilprofil || null,
    erzaehlperspektive: erzaehlperspektive || null,
    erzaehlzeit: erzaehlzeit || null,
    is_finished: finished,
    allow_lektor_book_chat: lektorBookChat,
    daily_goal_chars: dailyGoal,
    goal_target_chars: goalTarget,
    goal_deadline: goalDeadline,
    orte_real: orteReal,
    schauplatz_land: schauplatzLand,
    zeitlinie_real: zeitlinieReal,
    weltfakten_real_pruefen: weltfaktenRealPruefen,
    exclude_from_stats: excludeStats,
    locale: `${language}-${region}`,
  });
});

/** Quick-Toggle aus Notebook-Toolbar — patcht nur entities_enabled,
 *  ohne dass der ganze Settings-Body uebertragen werden muss. */
router.put('/:book_id/entities-enabled', aclParamGuard('editor'), jsonBody, (req, res) => {
  const bookId = req.bookId;
  const enabled = req.body?.enabled ? 1 : 0;
  setBookEntitiesEnabled(bookId, enabled);
  res.json({ ok: true, entities_enabled: enabled });
});

/** Quellenverzeichnis-Einstellungen (Quellen-Tab). Eigener Endpunkt statt
 *  weiterer Felder im Haupt-Body: der Tab speichert unabhaengig, und der
 *  Zitierstil gilt buchweit fuer ALLE Ausgabewege (PDF, DOCX, WordPress,
 *  HubSpot) — er gehoert deshalb nicht in ein Exportprofil. */
router.put('/:book_id/citation', aclParamGuard('editor'), jsonBody, (req, res) => {
  const bookId = req.bookId;
  const b = req.body || {};

  if (b.citation_style !== undefined && !VALID_CITATION_STYLES.includes(b.citation_style)) {
    return res.status(400).json({ error_code: 'INVALID_VALUE', params: { field: 'citation_style', allowed: VALID_CITATION_STYLES.join(', ') } });
  }
  if (b.bibliography_scope !== undefined && !VALID_BIBLIOGRAPHY_SCOPES.includes(b.bibliography_scope)) {
    return res.status(400).json({ error_code: 'INVALID_VALUE', params: { field: 'bibliography_scope', allowed: VALID_BIBLIOGRAPHY_SCOPES.join(', ') } });
  }
  if (b.citation_notes !== undefined && !VALID_CITATION_NOTES.includes(b.citation_notes)) {
    return res.status(400).json({ error_code: 'INVALID_VALUE', params: { field: 'citation_notes', allowed: VALID_CITATION_NOTES.join(', ') } });
  }
  if (b.bibliography_title && String(b.bibliography_title).length > BIBLIOGRAPHY_TITLE_MAX) {
    return res.status(400).json({ error_code: 'INVALID_VALUE', params: { field: 'bibliography_title', allowed: `max ${BIBLIOGRAPHY_TITLE_MAX}` } });
  }

  // Vorwerte als Basis: der Tab darf einzelne Felder patchen, ohne die uebrigen
  // auf ihren Default zurueckzusetzen.
  const cur = getBookSettings(bookId, req.session?.user?.email || null);
  setBookCitationSettings(bookId, {
    citation_style:       b.citation_style       !== undefined ? b.citation_style       : cur.citation_style,
    bibliography_enabled: b.bibliography_enabled !== undefined ? b.bibliography_enabled : cur.bibliography_enabled,
    bibliography_title:   b.bibliography_title   !== undefined ? b.bibliography_title   : cur.bibliography_title,
    bibliography_scope:   b.bibliography_scope   !== undefined ? b.bibliography_scope   : cur.bibliography_scope,
    bibliography_in_blog: b.bibliography_in_blog !== undefined ? b.bibliography_in_blog : cur.bibliography_in_blog,
    citation_notes:       b.citation_notes       !== undefined ? b.citation_notes       : cur.citation_notes,
  });

  const next = getBookSettings(bookId, req.session?.user?.email || null);
  logger.info(`[quellen] settings book=${bookId} stil=${next.citation_style} verzeichnis=${next.bibliography_enabled} scope=${next.bibliography_scope} blog=${next.bibliography_in_blog} noten=${next.citation_notes}`);
  res.json({
    ok: true,
    citation_style: next.citation_style,
    bibliography_enabled: next.bibliography_enabled,
    bibliography_title: next.bibliography_title,
    bibliography_scope: next.bibliography_scope,
    bibliography_in_blog: next.bibliography_in_blog,
    citation_notes: next.citation_notes,
  });
});

/** Querverweis-Einstellungen. Eigener Endpunkt aus demselben Grund wie
 *  /citation: ob ein Werk seine Abbildungen nummeriert, gilt buchweit fuer alle
 *  Ausgabewege und gehoert deshalb nicht in ein Exportprofil. */
router.put('/:book_id/xrefs', aclParamGuard('editor'), jsonBody, (req, res) => {
  const bookId = req.bookId;
  const b = req.body || {};
  const cur = getBookSettings(bookId, req.session?.user?.email || null);

  setBookXrefSettings(bookId, {
    figure_numbering: b.figure_numbering !== undefined ? b.figure_numbering : cur.figure_numbering,
  });

  const next = getBookSettings(bookId, req.session?.user?.email || null);
  logger.info(`[querverweise] settings book=${bookId} abbNummerierung=${next.figure_numbering}`);
  res.json({ ok: true, figure_numbering: next.figure_numbering });
});

module.exports = router;
