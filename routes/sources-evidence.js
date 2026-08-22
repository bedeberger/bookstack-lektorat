'use strict';
// Belegvorschlag: zu einer unbelegten Behauptung aus dem Buchtext die passende
// Stelle in der eigenen Quellen-Bibliothek finden. Eigener Router, in
// routes/sources.js unter demselben Mount eingehaengt (wie sources-doc.js) — der
// CRUD-Teil ist ohne ihn schon nah am LOC-Limit.
//
// WARUM DAS HIER LIEGT UND NICHT IN routes/search.js: die semantische Suche ueber
// die Bibliothek gibt es dort schon (`GET /search/sources-semantic`) — sie
// beantwortet aber die Frage des SUCHENDEN („welches PDF spricht ueber X").
// Hier ist die Frage die des BELEGENDEN: „mit welcher meiner Quellen kann ich
// GENAU DIESEN Satz stuetzen, und ist sie diesem Buch ueberhaupt zugeordnet".
// Darum kommt zu jedem Treffer der vollstaendige Quellen-Datensatz (das Frontend
// baut daraus den Kurzbeleg des Chips, ohne zweiten Roundtrip) plus `linked`.
//
// `linked` ist keine Zierde: ein `data-src`-Marker erzeugt nur dann eine
// Fundstelle, wenn die Quelle dem Buch der Seite zugeordnet ist
// (db/sources.js#replacePageCitations). Ein Vorschlag aus einer anderen Arbeit
// muss also zuerst durch `POST /sources/:id/link` — das Frontend sieht an diesem
// Flag, ob es den Schritt braucht.
//
// KEIN KI-CALL: der Query-Vektor kommt aus dem Embedding-Endpunkt, gesucht wird
// per Cosinus ueber die schon liegenden `source_semantic_chunks`. Darum eine
// synchrone Route und keine Job-Queue — dieselbe Einordnung wie
// `GET /search/semantic`. Nie generativ: der Vorschlag fasst den Buchtext nicht
// an, das Einsetzen des Chips macht der Editor auf Klick des Autors.

const express = require('express');
const { getSource, isSourceLinked } = require('../db/schema');
const { toIntId } = require('../lib/validate');
const { guardBook, sessionEmail } = require('../lib/acl');
const { setContext } = require('../lib/log-context');
const embed = require('../lib/embed');
const semanticRetrieval = require('../lib/semantic-retrieval');
const logger = require('../logger');

const router = express.Router();

// Die Behauptung ist ein ganzer Satz (Span-Typ `satz` fuer `unbelegt`/
// `zuschreibung`, siehe public/js/prompts/lektorat-typen.js#SPAN_KIND) — das
// Fenster ist darum groesser als bei einer Suchanfrage, aber nicht unbegrenzt:
// mehr als ein Satz ist keine einzelne Behauptung mehr.
const MIN_CLAIM = 12;
const MAX_CLAIM = 600;
// Wer mehr als eine Handvoll Vorschlaege durchsieht, hat keinen Beleg, sondern
// ein Rechercheproblem — dafuer ist die Quellen-Karte da.
const DEFAULT_TOPK = 5;
const MAX_TOPK = 15;
// Der Beleg-Ausschnitt dient dem Wiedererkennen, nicht dem Lesen. Laenger
// gemacht als der Such-Snippet (300), weil hier die Frage „stuetzt das meinen
// Satz wirklich?" beantwortet werden muss.
const SNIPPET_CHARS = 600;

// GET /sources/evidence?book_id=&q=&limit=
// Rolle `viewer`: die Antwort zeigt ausschliesslich die EIGENE Bibliothek des
// Anfragenden (semanticSourceQuery ist user-skopiert), das Buch liefert nur den
// Zuordnungs-Kontext. Das Einsetzen selbst laeuft ueber den Seiten-Write und das
// Zuordnen ueber `POST /:id/link` — beide verlangen dort ihre eigene Rolle.
router.get('/evidence', async (req, res) => {
  const email = sessionEmail(req);
  if (!email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });

  const bookId = toIntId(req.query.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  setContext({ book: bookId });
  if (!guardBook(req, res, bookId, 'viewer')) return;

  if (!embed.isEnabled()) return res.status(400).json({ error_code: 'EMBED_DISABLED' });

  const q = String(req.query.q || '').trim();
  if (q.length < MIN_CLAIM) return res.status(400).json({ error_code: 'CLAIM_TOO_SHORT' });
  if (q.length > MAX_CLAIM) return res.status(400).json({ error_code: 'CLAIM_TOO_LONG' });

  const topK = Math.min(Math.max(parseInt(req.query.limit, 10) || DEFAULT_TOPK, 1), MAX_TOPK);

  try {
    const raw = await semanticRetrieval.semanticSourceQuery(email, q, { topK });
    // Der volle Datensatz mit BUCH-Sicht (`getSource(id, bookId)`) — die
    // Kennzahlen einer Quelle sind buch-skopiert, sobald ein Buch im Spiel ist.
    // Faellt eine Quelle zwischen Query und Nachladen weg, fliegt sie still
    // heraus statt die ganze Antwort zu kippen.
    const hits = [];
    for (const h of raw) {
      const src = getSource(h.source_id, bookId);
      if (!src) continue;
      hits.push({
        source_id: h.source_id,
        snippet: String(h.text || '').slice(0, SNIPPET_CHARS),
        score: Math.round(h.score * 1000) / 1000,
        linked: isSourceLinked(bookId, h.source_id),
        source: src,
      });
    }
    logger.info(`[quellen] evidence book=${bookId} q=${q.length}z treffer=${hits.length}`);
    res.json({ hits });
  } catch (e) {
    logger.error(`[quellen] GET /sources/evidence failed: ${e.message}`);
    res.status(503).json({ error_code: 'EMBED_UNAVAILABLE', detail: e.message });
  }
});

module.exports = router;
