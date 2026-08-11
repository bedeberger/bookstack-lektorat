'use strict';
// Kategorie-Pool-Routen.
// Mount: app.use('/local/categories', router).
//
// GET    /         — alle User: Pool lesen.
// POST   /         — admin: Kategorie anlegen.
// PUT    /:id      — admin: umbenennen / Parent / Farbe / Position.
// DELETE /:id      — admin: Kategorie loeschen (books.category_id SET NULL via FK).

const express = require('express');
const categories = require('../db/book-categories');
const { requireAdmin } = require('../lib/admin-mw');
const logger = require('../logger');
const { sessionEmail } = require('../lib/acl');

const router = express.Router();
const jsonBody = express.json();

router.get('/', (_req, res) => {
  res.json({ categories: categories.list() });
});

router.post('/', requireAdmin, jsonBody, (req, res) => {
  const { name, parent_id = null, color = null, position = 0 } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error_code: 'NAME_REQUIRED' });
  }
  try {
    const created = categories.create({
      name,
      parentId: parent_id,
      color,
      position,
      createdBy: sessionEmail(req),
    });
    logger.info(`Kategorie angelegt id=${created.id} name="${created.name}" by=${req.session.user.email}`);
    res.json({ category: created });
  } catch (e) {
    if (/too long/.test(e.message)) {
      return res.status(400).json({ error_code: 'NAME_TOO_LONG' });
    }
    logger.error(`POST /local/categories: ${e.message}`);
    res.status(500).json({ error_code: 'CREATE_FAILED', detail: e.message });
  }
});

router.put('/:id', requireAdmin, jsonBody, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error_code: 'INVALID_ID' });
  try {
    const updated = categories.update(id, {
      name: req.body?.name,
      parentId: req.body?.parent_id,
      color: req.body?.color,
      position: req.body?.position,
    });
    if (!updated) return res.status(404).json({ error_code: 'CATEGORY_NOT_FOUND' });
    res.json({ category: updated });
  } catch (e) {
    if (/too long/.test(e.message)) return res.status(400).json({ error_code: 'NAME_TOO_LONG' });
    if (/self-parent/.test(e.message)) return res.status(400).json({ error_code: 'SELF_PARENT' });
    logger.error(`PUT /local/categories/:id: ${e.message}`);
    res.status(500).json({ error_code: 'UPDATE_FAILED', detail: e.message });
  }
});

router.delete('/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error_code: 'INVALID_ID' });
  const ok = categories.remove(id);
  if (!ok) return res.status(404).json({ error_code: 'CATEGORY_NOT_FOUND' });
  logger.info(`Kategorie geloescht id=${id} by=${req.session.user.email}`);
  res.json({ ok: true });
});

module.exports = router;
