'use strict';
const express = require('express');
const { listWorldFacts, worldFactsScanState } = require('../db/schema');
const { toIntId } = require('../lib/validate');
const { aclParamGuard, sessionEmail } = require('../lib/acl');

const router = express.Router();
router.param('book_id', aclParamGuard('editor'));

// Welt-Fakten eines Buchs laden (read-only; Schreibpfad ist die Komplettanalyse).
// `scanned` unterscheidet „nie analysiert" von „analysiert, nichts gefunden" — ohne
// das fordert die leere Karte eine Komplettanalyse, die langst gelaufen ist.
router.get('/:book_id', (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  const userEmail = sessionEmail(req);

  const fakten = listWorldFacts(bookId, userEmail);
  const { scanned } = worldFactsScanState(bookId, userEmail);
  const updated_at = fakten.reduce((max, f) => (f.updated_at > max ? f.updated_at : max), '');

  res.json({
    fakten: fakten.map(({ updated_at: _u, ...f }) => f),
    scanned,
    updated_at: updated_at || null,
  });
});

module.exports = router;
