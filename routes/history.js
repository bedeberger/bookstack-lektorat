'use strict';
// Verlauf-Endpunkte (Lektorats-Laeufe, Bewertungen, Statistik, Heatmap,
// Zeit-Tracking) — Facade ueber routes/history/.
//
// Aufteilung (Submodule registrieren auf denselben Router):
//   history/checks.js        — Lektorats-Laeufe (`page_checks`): Historie einer
//                               Seite, Detail-JSON, Speichern/Loeschen, dazu
//                               Seiten-Alter + Abdeckung.
//   history/reviews.js       — Buch-/Kapitel-Bewertungen + Tagebuch-Rueckblicke,
//                               inkl. History-Reset eines Buchs.
//   history/stats.js         — Seiten-Stats-Cache (lesen + Batch-Write),
//                               Buchstatistik-Verlauf, Staleness, Stil-Metriken.
//   history/heatmap.js       — Fehler-Heatmap + Fehlerdichte-Trend.
//   history/time-tracking.js — die drei Heartbeat-Zaehler (Schreibzeit, Diktat,
//                               Lektoratszeit), aus einer Spec generiert.
//   history/shared.js        — geteilte Body-Parser.
//
// Routen-Pfade sind ueber die Module hinweg disjunkt (literale erste Segmente
// /check · /page · /page-ages · /coverage · /review · /chapter-review(s) ·
// /rueckblick* · /book · /page-stats · /book-stats · /stats-stale ·
// /style-stats · /fehler-* · /writing-time · /stt-time · /lektorat-time)
// → die Registrierungs-Reihenfolge aendert das Matching nicht.

const express = require('express');
const { aclParamGuard } = require('../lib/acl');

const router = express.Router();
// Reads (Lektoratverlauf, Reviews, Stats, Heatmap) sind viewer+. Der Guard
// laeuft automatisch vor jedem `:book_id`-Handler und setzt `req.bookId` —
// in diesen Handlern darum KEINE zweite Login-/ACL-Pruefung. Buch-Guard fuer
// die Body-Routen kommt aus lib/acl.js#guardBook.
router.param('book_id', aclParamGuard('viewer'));

require('./history/checks').register(router);
require('./history/reviews').register(router);
require('./history/stats').register(router);
require('./history/heatmap').register(router);
require('./history/time-tracking').register(router);

module.exports = router;
