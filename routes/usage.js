'use strict';
// Feature-Usage-Tracking pro User. Quick-Pills + Command-Palette lesen daraus
// die zuletzt genutzten Features (Recency-Sort). Allowlist verhindert Pollution
// durch beliebige Keys.

const express = require('express');
const { db } = require('../db/schema');
const logger = require('../logger');

const router = express.Router();
const jsonBody = express.json();

// Erlaubte Feature-Keys — synchron mit public/js/cards/feature-registry.js.
// Erweitern bei neuen Features; unbekannte Keys werden 400-abgelehnt.
const ALLOWED_KEYS = new Set([
  'review',
  'stil',
  'fehlerHeatmap',
  'kontinuitaet',
  'figuren',
  'szenen',
  'orte',
  'ereignisse',
  'bookchat',
  'stats',
  'bookSettings',
  'finetuneExport',
]);

function userEmailOrNull(req) {
  return req.session?.user?.email || null;
}

router.post('/track', jsonBody, (req, res) => {
  const userEmail = userEmailOrNull(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const key = (req.body?.key || '').toString();
  if (!ALLOWED_KEYS.has(key)) {
    return res.status(400).json({ error_code: 'INVALID_KEY' });
  }
  const now = Date.now();
  try {
    db.prepare(`
      INSERT INTO user_feature_usage (user_email, feature_key, last_used, use_count)
      VALUES (?, ?, ?, 1)
      ON CONFLICT(user_email, feature_key) DO UPDATE SET
        last_used = excluded.last_used,
        use_count = use_count + 1
    `).run(userEmail, key, now);
    res.json({ ok: true });
  } catch (e) {
    logger.error('[usage/track] DB-Fehler: ' + e.message);
    res.status(500).json({ error_code: 'DB_ERROR' });
  }
});

router.get('/recent', (req, res) => {
  const userEmail = userEmailOrNull(req);
  if (!userEmail) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const limit = Math.max(1, Math.min(20, parseInt(req.query.limit, 10) || 3));
  try {
    const rows = db.prepare(`
      SELECT feature_key, last_used, use_count
      FROM user_feature_usage
      WHERE user_email = ?
      ORDER BY last_used DESC
      LIMIT ?
    `).all(userEmail, limit);
    res.json(rows);
  } catch (e) {
    logger.error('[usage/recent] DB-Fehler: ' + e.message);
    res.status(500).json({ error_code: 'DB_ERROR' });
  }
});

module.exports = router;
