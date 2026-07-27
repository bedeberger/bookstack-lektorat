'use strict';
// Liefert alle Kapitel + Seiten eines Buchs in Lesereihenfolge mit vollem HTML.
// Frontend rendert daraus den durchgehend scrollbaren Bucheditor.
//
// Server-Side-Aggregation statt N Client-Requests:
//   - Eine Anfrage statt 50+ → keine Browser-Concurrency-Limits.
//   - Batch-Loader (Concurrency 15) verteilt Last gegen Laravel-Throttle.
//
// Frische Reads: gleicher Vertrag wie selectPage(p) — Cache-Lieferung okay,
// Save-Pfad pro Block macht `_checkPageConflict`/`savePage` mit Stale-Schutz.

const express = require('express');
const contentStore = require('../lib/content-store');
const { aclParamGuard } = require('../lib/acl');
const { toIntId } = require('../lib/validate');
const logger = require('../logger');

const router = express.Router();
// Bucheditor liefert Volltext-Buch; viewer reicht.
router.param('book_id', aclParamGuard('viewer'));

router.get('/:book_id/contents', async (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });

  try {
    const tree = await contentStore.bookTree(bookId, req);

    // Flat-Liste in Lesereihenfolge: Seiten ohne Kapitel zuerst, dann Kapitel
    // depth-first (gleiche Reihenfolge wie pagetree, siehe public/js/book/tree.js).
    // _chapterName ist das direkt umschliessende Kapitel.
    const solos = [];
    const inChapters = [];
    for (const { page, chapterId, chapterName } of contentStore.flattenTree(tree)) {
      (chapterId == null ? solos : inChapters).push({ ...page, _chapterName: chapterName });
    }
    const flatMetas = [...solos, ...inChapters];

    const details = await contentStore.loadPagesBatch(flatMetas, req, { batchSize: 15 });

    // Reihenfolge erhalten: loadPagesBatch garantiert keine Ordnung (Promise.allSettled).
    // Feldliste bewusst schmal — bei einem grossen Buch geht jedes zusätzliche
    // Feld mal Seitenzahl über die Leitung. Konsumenten: Bucheditor
    // (public/js/cards/book-editor-card.js) und der Fassungen-Reader als
    // Diff-Basis (public/js/cards/snapshots-card.js, liest pageId + html).
    const byId = new Map(details.map(d => [d.id, d]));
    const ordered = flatMetas
      .map(meta => {
        const d = byId.get(meta.id);
        if (!d) return null;
        return {
          pageId: d.id,
          pageName: d.name,
          pagePriority: d.position,
          chapterId: d.chapter_id || null,
          chapterName: meta._chapterName,
          html: d.html || '',
          updated_at: d.updated_at,
        };
      })
      .filter(Boolean);

    res.json({
      bookId,
      pages: ordered,
      missing: flatMetas.length - ordered.length,
    });
  } catch (e) {
    logger.error(`[book-editor/contents] ${e.message}`);
    res.status(500).json({ error_code: 'LOAD_FAILED', message: e.message });
  }
});

module.exports = router;
