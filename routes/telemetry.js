'use strict';
// Block-Level-Merge-Telemetrie. Frontend meldet Auto-Merge-/Konflikt-Events;
// persistiert als kumulierte Counter (db/merge-telemetry), gescraped via /metrics.
// Session-authed (Mount nach Auth-Guard). Fire-and-forget aus dem Client.

const express = require('express');
const { bumpMergeCounter } = require('../db/merge-telemetry');
const { insertJsError } = require('../db/js-errors');
const logger = require('../logger');
const { sessionEmail } = require('../lib/acl');

const router = express.Router();
const jsonBody = express.json();
// 'resource' = Script/Stylesheet nicht ladbar, 'boot' = Ausfall des ESM-Graphen
// (public/js/failsafe-reveal.js). Beide benennen die URSACHE eines Boot-Ausfalls,
// waehrend 'error' dabei nur die Folgefehler jeder x-data-Expression einsammelt.
const JS_ERROR_KINDS = new Set(['error', 'unhandledrejection', 'resource', 'boot']);
function _toInt(v) { const n = parseInt(v, 10); return Number.isInteger(n) ? n : null; }

// Erlaubte Basis-Events. 'conflict_resolved' fuehrt zusaetzlich einen
// Auflösungs-Mix (local/remote/both) als getrennte Counter.
const ALLOWED_EVENTS = new Set([
  'silent_success',
  'conflict_shown',
  'conflict_resolved',
  'fallback_overwrite',
]);
const RESOLVE_CHOICES = ['local', 'remote', 'both'];

router.post('/merge', jsonBody, (req, res) => {
  if (!sessionEmail(req)) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const event = (req.body?.event || '').toString();
  if (!ALLOWED_EVENTS.has(event)) {
    return res.status(400).json({ error_code: 'INVALID_EVENT' });
  }
  try {
    if (event === 'conflict_resolved') {
      const mix = req.body?.mix && typeof req.body.mix === 'object' ? req.body.mix : {};
      for (const choice of RESOLVE_CHOICES) {
        const n = parseInt(mix[choice], 10);
        if (n > 0) bumpMergeCounter(`conflict_resolved_${choice}`, n);
      }
    } else {
      bumpMergeCounter(event, 1);
    }
    res.json({ ok: true });
  } catch (e) {
    logger.error('[telemetry/merge] DB-Fehler: ' + e.message);
    res.status(500).json({ error_code: 'DB_ERROR' });
  }
});

// ── POST /telemetry/js-error ──────────────────────────────────────────────────
// Fire-and-forget Meldung eines client-seitigen JS-Fehlers. Session-authed
// (Mount nach Auth-Guard). Felder werden in db/js-errors.js gekappt; hier nur
// Pflichtfeld + Enum pruefen. Best-effort: DB-Fehler werden geschluckt.
router.post('/js-error', jsonBody, (req, res) => {
  if (!sessionEmail(req)) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const message = (req.body?.message || '').toString().trim();
  if (!message) return res.status(400).json({ error_code: 'NO_MESSAGE' });
  const kind = JS_ERROR_KINDS.has(req.body?.kind) ? req.body.kind : 'error';
  try {
    insertJsError({
      user_email: req.session.user.email,
      kind,
      message,
      stack: req.body?.stack ?? null,
      source: req.body?.source ?? null,
      line: _toInt(req.body?.line),
      col: _toInt(req.body?.col),
      page_url: req.body?.pageUrl ?? null,
      user_agent: req.headers['user-agent'] || null,
    });
    res.json({ ok: true });
  } catch (e) {
    logger.error('[telemetry/js-error] DB-Fehler: ' + e.message);
    res.status(500).json({ error_code: 'DB_ERROR' });
  }
});

// ── POST /telemetry/tts-log ───────────────────────────────────────────────────
// Fire-and-forget: das Vorlese-Frontend (public/js/editor/notebook/tts-proof.js)
// meldet reine Client-Events (Start/Stop/Skip, uebersprungene Segmente,
// Audio-Fehler), die der Server sonst nicht sieht — der /tts/speak-Proxy loggt
// nur die einzelnen Synthese-Calls. Landet im selben [tts|user|book]-Child-
// Logger wie routes/tts.js, mit [client]-Marker. Session-authed, best-effort.
const TTS_LOG_MAX = 500;
router.post('/tts-log', jsonBody, (req, res) => {
  const userEmail = sessionEmail(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const msg = (req.body?.msg || '').toString().trim().slice(0, TTS_LOG_MAX);
  if (!msg) return res.status(400).json({ error_code: 'NO_MESSAGE' });
  const level = req.body?.level === 'warn' ? 'warn' : 'info';
  const bookId = _toInt(req.body?.bookId);
  const log = logger.child({ job: 'tts', user: userEmail, book: bookId || '-' });
  log[level](`[client] ${msg}`);
  res.json({ ok: true });
});

module.exports = router;
