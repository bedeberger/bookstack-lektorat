'use strict';
// POST /capture — Erfassen einer Webseite aus dem Browser (Chrome-Erweiterung,
// schreibwerkstatt-browser-extension).
//
// Warum ein eigener Endpunkt statt der drei bestehenden Aufrufe (POST /research,
// POST /sources, POST /sources/:id/link):
//   1) EIN Roundtrip aus einem Popup, das der User zuklappt, sobald es
//      quittiert. Bei drei Requests hinterlaesst ein Abbruch nach dem zweiten
//      eine Quelle, die in keinem Buch liegt — sichtbar nur in der Bibliothek,
//      also genau da, wo der User sie nicht sucht.
//   2) IDEMPOTENZ. Ein Doppelklick auf „erfassen" ist der Normalfall, nicht der
//      Ausnahmefall; die Entscheidung „ist das schon drin" kann nur der Server
//      treffen, weil er den Bestand kennt.
//   3) Ein Ort, an dem die Erfassungs-Semantik steht: eine Quelle darf pro
//      Dokument nur einmal existieren, ein Fundstueck pro Dokument beliebig oft
//      (zwei Zitate aus derselben Seite sind zwei Funde).
//
// Rein kuratierend wie seine beiden Ziele: schreibt NIE in den Manuskripttext.
// Kein callAI — hier wird nichts erschlossen, nur abgelegt, was der Client
// mitbringt.

const express = require('express');
const { getSource, createSource, linkSource, isSourceLinked, findSourceByUrl } = require('../db/schema');
const { db } = require('../db/connection');
const { createItem, emitItem } = require('../db/research-items');
const { toIntId } = require('../lib/validate');
const { guardBook, sessionEmail } = require('../lib/acl');
const { validateSourceBody, hasSourceIdentity } = require('../lib/source-validate');
const { normalizeUrl } = require('../lib/url-normalize');
const { localIsoDate } = require('../lib/local-date');
const {
  RESEARCH_KINDS, TITLE_MAX, BODY_MAX, SOURCE_MAX, cleanStr,
} = require('../lib/research-validate');
const logger = require('../logger');

const router = express.Router();
// Der Client schickt den lesbaren Haupttext der Seite mit (auf BODY_MAX
// gekuerzt) — dasselbe Limit wie beim Fundstueck-CRUD reicht.
const jsonBody = express.json({ limit: '256kb' });

const MODES = new Set(['research', 'source', 'both']);

// Fenster, in dem ein wortgleicher Fund als Doppel-Klick gilt statt als zweiter
// Fund. Bewusst kurz: nach zehn Minuten ist ein identisch aussehender Fund eine
// Entscheidung des Users, kein verrutschter Mausklick.
const REDUNDANT_WINDOW_MIN = 10;

/** Wortgleicher Fund im selben Buch aus dem Doppelklick-Fenster, oder null.
 *  Verglichen wird der ganze Inhalt (kind + Titel + Text + URL), nicht nur die
 *  URL: zwei verschiedene Zitate aus derselben Seite sind zwei Fundstuecke und
 *  duerfen sich nicht gegenseitig verschlucken. */
function _recentTwin(bookId, { kind, title, body, url }) {
  const rows = db.prepare(
    `SELECT id FROM research_items
      WHERE book_id = ?
        AND kind = ?
        AND IFNULL(title, '') = IFNULL(?, '')
        AND IFNULL(body,  '') = IFNULL(?, '')
        AND archived = 0
        AND datetime(created_at) > datetime('now', ?)
      ORDER BY id DESC`
  ).all(bookId, kind, title, body, `-${REDUNDANT_WINDOW_MIN} minutes`);
  if (!rows.length) return null;
  const target = normalizeUrl(url);
  if (!target) return rows[0].id;
  const urlOf = db.prepare(
    'SELECT url FROM research_item_urls WHERE item_id = ? ORDER BY position, id'
  );
  for (const r of rows) {
    if (urlOf.all(r.id).some(u => normalizeUrl(u.url) === target)) return r.id;
  }
  return null;
}

// POST /capture
// Body: { book_id, mode: 'research'|'source'|'both',
//         url, title, body, kind, tags, source,
//         authors, editors, container_title, publisher, place, year,
//         doi, isbn, csl_type, accessed_at, note }
//
// Antwort: { research_item, research_created, source, source_created,
//            source_linked } — jeder Teil sagt einzeln, ob er neu entstanden
// ist. Ein Client, der nur „ok" braucht, ignoriert die Flags; einer, der dem
// User „war schon drin" zeigen will, hat die Information ohne zweiten Request.
router.post('/', jsonBody, (req, res) => {
  const bookId = toIntId(req.body?.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'BOOKID_REQ' });
  // 'editor' wie POST /research: Erfassen ist eine Aenderung am Buch. Die 401
  // (`NOT_LOGGED_IN`) kommt aus dem Guard — keine zweite Login-Pruefung davor.
  if (!guardBook(req, res, bookId, 'editor')) return;
  const userEmail = sessionEmail(req);

  const mode = req.body?.mode === undefined ? 'research' : String(req.body.mode);
  if (!MODES.has(mode)) {
    return res.status(400).json({
      error_code: 'INVALID_VALUE',
      params: { field: 'mode', allowed: [...MODES].join(', ') },
    });
  }

  const rawUrl = String(req.body?.url || '').trim();
  if (rawUrl && !normalizeUrl(rawUrl)) return res.status(400).json({ error_code: 'INVALID_URL' });

  const kind = RESEARCH_KINDS.has(req.body?.kind) ? req.body.kind : (rawUrl ? 'link' : 'note');
  const title = cleanStr(req.body?.title, TITLE_MAX);
  const body = cleanStr(req.body?.body, BODY_MAX);
  const source = cleanStr(req.body?.source, SOURCE_MAX);

  const wantsResearch = mode === 'research' || mode === 'both';
  const wantsSource = mode === 'source' || mode === 'both';

  // Ein Fundstueck ohne Titel, Text und Link waere ein leerer Zettel.
  if (wantsResearch && !title && !body && !rawUrl) {
    return res.status(400).json({ error_code: 'EMPTY' });
  }

  // Der Quellen-Entwurf traegt dieselben Regeln wie ueber POST /sources: der
  // Client soll nicht ueber diesen Weg an der Feldpruefung vorbeikommen.
  let srcDraft = null;
  if (wantsSource) {
    srcDraft = {
      csl_type: req.body?.csl_type || 'website',
      title: req.body?.title ?? null,
      authors: req.body?.authors ?? [],
      editors: req.body?.editors ?? [],
      container_title: req.body?.container_title ?? null,
      publisher: req.body?.publisher ?? null,
      place: req.body?.place ?? null,
      year: req.body?.year ?? null,
      doi: req.body?.doi ?? null,
      isbn: req.body?.isbn ?? null,
      url: rawUrl || null,
      // Zugriffsdatum ist bei einer Webseite Teil des Belegs — der Client darf
      // es setzen, sonst gilt heute (Server-Zeitzone, wie ueberall sonst).
      accessed_at: req.body?.accessed_at || localIsoDate(),
      note: req.body?.note ?? null,
    };
    const bad = validateSourceBody(srcDraft);
    if (bad) return res.status(400).json(bad);
    if (!hasSourceIdentity(srcDraft)) return res.status(400).json({ error_code: 'SOURCE_IDENTITY_REQ' });
  }

  const out = {
    research_item: null, research_created: false,
    source: null, source_created: false, source_linked: false,
  };

  // Beides in EINER Transaktion: bei einem Fehler in der zweiten Haelfte darf
  // nicht die erste stehen bleiben — sonst ist genau der Zustand da, den dieser
  // Endpunkt verhindern soll (Quelle ohne Buch, Fund ohne Quelle).
  const run = db.transaction(() => {
    if (wantsResearch) {
      const twinId = _recentTwin(bookId, { kind, title, body, url: rawUrl });
      if (twinId) {
        out.research_item = emitItem(twinId);
      } else {
        const id = createItem({
          bookId, userEmail, kind, title, body, source,
          urls: rawUrl ? [{ url: rawUrl, label: title || '' }] : [],
          tags: req.body?.tags,
        });
        out.research_item = emitItem(id);
        out.research_created = true;
      }
    }

    if (wantsSource) {
      // Eine Quelle pro Dokument, buchuebergreifend: die Bibliothek ist der
      // Ort, an dem dieselbe Literatur EINMAL steht (siehe db/sources.js).
      const existing = rawUrl ? findSourceByUrl(userEmail, rawUrl, bookId) : null;
      if (existing) {
        out.source = existing;
        if (!isSourceLinked(bookId, existing.id)) {
          linkSource(bookId, existing.id, userEmail);
          out.source_linked = true;
          out.source = getSource(existing.id, bookId);
        }
      } else {
        const created = createSource(userEmail, srcDraft);
        linkSource(bookId, created.id, userEmail);
        out.source = getSource(created.id, bookId);
        out.source_created = true;
        out.source_linked = true;
      }
    }
  });

  try {
    run();
  } catch (e) {
    // Der Entwurf traegt bewusst KEINEN citekey — den Zitierschluessel vergibt
    // der Autor, nicht die Erweiterung —, ein UNIQUE(owner_email, citekey) ist
    // hier also nicht zu erwarten. Faellt er trotzdem, ist 409 dieselbe Antwort
    // wie bei POST /sources und kein 500.
    if (/UNIQUE/i.test(e.message || '')) return res.status(409).json({ error_code: 'CITEKEY_TAKEN' });
    throw e;
  }

  logger.info(
    `[capture] mode=${mode} fund=${out.research_created ? 'neu' : (out.research_item ? 'bekannt' : '-')} `
    + `quelle=${out.source_created ? 'neu' : (out.source ? 'bekannt' : '-')}`
  );
  res.json(out);
});

module.exports = router;
