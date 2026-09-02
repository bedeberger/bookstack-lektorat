'use strict';
// POST /research/:id/scrape — den Link eines Fundstuecks serverseitig lesen und
// Titel/Text/Herkunft daraus uebernehmen.
//
// Warum es diesen Weg neben der Browser-Erweiterung gibt: die Erweiterung
// erfasst die Seite im Tab des Users (gerendert, angemeldet) und ist damit die
// bessere Quelle. Sie ist aber nur dort, wo ein Chrome mit Erweiterung offen
// ist. Ein aus der Android-App geteilter Link kommt als nackte URL an — das
// Fundstueck hat dann keinen Text, taucht in keiner Volltextsuche auf und
// bekommt keinen Chunk im Semantik-Index. Dieser Knopf holt das nach.
//
// Kein callAI: es wird nichts erschlossen und nichts zusammengefasst, nur
// abgelegt, was im Dokument steht (Modulkopf lib/url-scrape.js). Darum auch
// keine Job-Queue — ein Request, ein Fetch, ein Timeout, dieselbe Bauart wie
// GET /sources/lookup und /geocode.
//
// Rein kuratierend wie das ganze Board: schreibt NIE in den Manuskripttext.

const express = require('express');
const { db } = require('../db/connection');
const { emitItem, setUrlLabel } = require('../db/research-items');
const { toIntId } = require('../lib/validate');
const { sessionEmail } = require('../lib/acl');
const { scopedItem } = require('./research-acl');
const { NOW_ISO_SQL } = require('../db/now');
const searchIndex = require('../lib/search');
const { enqueueEmbedIndexJob } = require('./jobs/embed-index');
const { scrapeUrl } = require('../lib/url-scrape');
const {
  TITLE_MAX, BODY_MAX, SOURCE_MAX, URL_LABEL_MAX, cleanStr,
} = require('../lib/research-validate');
const logger = require('../logger');

const researchScrapeRouter = express.Router();
const jsonBody = express.json();

// Fehler des Lesevorgangs → Antwortform. Drei Klassen, die der Client
// unterscheiden MUSS, weil sie zu verschiedenen Handlungen fuehren:
//   400  die URL selbst ist untauglich  → der User muss sie korrigieren
//   422  erreicht, aber nichts zu holen → Erweiterung nehmen oder Hand anlegen
//   502/504 der Fremd-Server            → spaeter erneut versuchen
const ERROR_MAP = {
  SSRF_INVALID_URL:   { status: 400, code: 'INVALID_URL' },
  SSRF_BLOCKED_HOST:  { status: 400, code: 'SCRAPE_BLOCKED' },
  SSRF_DNS_FAILED:    { status: 502, code: 'SCRAPE_UNAVAILABLE' },
  SCRAPE_NOT_HTML:    { status: 400, code: 'SCRAPE_NOT_HTML' },
  SCRAPE_TIMEOUT:     { status: 504, code: 'SCRAPE_TIMEOUT' },
  SCRAPE_TOO_LARGE:   { status: 502, code: 'SCRAPE_TOO_LARGE' },
  SCRAPE_HTTP_ERROR:  { status: 502, code: 'SCRAPE_HTTP_ERROR' },
  SCRAPE_UNAVAILABLE: { status: 502, code: 'SCRAPE_UNAVAILABLE' },
};

// Vergleichsform fuer „steht die Beschreibung schon im Haupttext". Bewusst grob
// (Kleinschreibung, nur Buchstaben und Ziffern): og:description ist auf vielen
// Seiten der erste Satz des Artikels mit anderer Interpunktion, und der soll
// nicht zweimal im Fundstueck stehen.
function _cmp(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Beschreibung + Haupttext zu EINEM Feldwert. Die Beschreibung fuehrt, wenn sie
 *  etwas beitraegt, das der Haupttext nicht schon sagt — sonst faellt sie weg. */
function composeBody(description, text) {
  const desc = String(description || '').trim();
  const main = String(text || '').trim();
  if (!desc) return main;
  if (!main) return desc;
  const d = _cmp(desc);
  // Kurze Beschreibungen sind zu unspezifisch fuer einen Enthaltensein-Test
  // („Startseite") — sie gelten nur als Dublette, wenn der Text sie wirklich fuehrt.
  if (d && (_cmp(main).includes(d) || _cmp(main).startsWith(d.slice(0, 60)))) return main;
  return `${desc}\n\n${main}`;
}

// POST /research/:id/scrape
// Body: { url_id?, overwrite? }
//
// `url_id` waehlt GEZIELT einen der Links des Fundstuecks — dieselbe Ueberlegung
// wie bei POST /sources/from-research: ein Fundstueck sammelt beliebig viele
// URLs, und welche davon der Artikel ist, weiss nur der User. Ohne Angabe gilt
// der erste.
//
// `overwrite` fehlt oder false → es wird NUR gefuellt, was leer ist. Der Text im
// Fundstueck ist womoeglich handgeschrieben; ein Knopf, der ihn ohne Rueckfrage
// durch Fremdtext ersetzt, ist kein Knopf, den man zweimal drueckt. Die Antwort
// sagt in `skipped`, was deshalb stehen blieb — der Aufrufer kann dann fragen
// und mit overwrite wiederkommen.
researchScrapeRouter.post('/:id/scrape', jsonBody, async (req, res) => {
  const scope = scopedItem(req, res);
  if (!scope) return;
  const { id, bookId } = scope;

  const item = db.prepare('SELECT title, body, source FROM research_items WHERE id = ?').get(id);
  if (!item) return res.status(404).json({ error_code: 'ITEM_NOT_FOUND' });

  const wantUrlId = req.body?.url_id === undefined ? null : toIntId(req.body.url_id);
  if (req.body?.url_id !== undefined && !wantUrlId) {
    return res.status(400).json({ error_code: 'INVALID_ID' });
  }
  const urlRow = wantUrlId
    ? db.prepare('SELECT id, url, label FROM research_item_urls WHERE id = ? AND item_id = ?').get(wantUrlId, id)
    : db.prepare('SELECT id, url, label FROM research_item_urls WHERE item_id = ? ORDER BY position, id LIMIT 1').get(id);
  // Kein Link heisst: hier ist nichts zu lesen. Eigener Code, weil es die
  // haeufigste Fehlbedienung ist (Notiz ohne Link) und keine Stoerung.
  if (!urlRow) return res.status(400).json({ error_code: 'NO_URL' });

  let scraped;
  try {
    scraped = await scrapeUrl(urlRow.url);
  } catch (e) {
    const mapped = ERROR_MAP[e.code] || { status: 502, code: 'SCRAPE_FAILED' };
    logger.warn(`[research] scrape id=${id} url=${urlRow.url} fehlgeschlagen: ${e.code || '-'} (${e.message})`);
    return res.status(mapped.status).json({ error_code: mapped.code });
  }

  const nextBody = composeBody(scraped.description, scraped.text);
  if (!scraped.title && !nextBody) {
    // Erreicht, aber leer: typischerweise eine Seite, die ihren Text erst im
    // Browser zusammensetzt. Das ist eine Aussage ueber das Verfahren, kein
    // Serverfehler — und der Hinweis, die Erweiterung zu nehmen.
    logger.info(`[research] scrape id=${id} ohne Inhalt (url=${urlRow.url})`);
    return res.status(422).json({ error_code: 'SCRAPE_EMPTY' });
  }

  const overwrite = !!req.body?.overwrite;
  const filled = [];
  const skipped = [];
  const sets = [];
  const vals = [];

  // Ein Feld wird uebernommen, wenn es etwas zu uebernehmen gibt UND das Feld
  // leer ist (oder der User ausdruecklich ueberschreiben will).
  const take = (field, value, current) => {
    if (!value) return;
    if (String(current || '').trim() && !overwrite) { skipped.push(field); return; }
    if (String(current || '').trim() === value) return;
    sets.push(`${field} = ?`);
    vals.push(value);
    filled.push(field);
  };
  take('title', cleanStr(scraped.title, TITLE_MAX), item.title);
  take('body', cleanStr(nextBody, BODY_MAX), item.body);
  take('source', cleanStr(scraped.siteName, SOURCE_MAX), item.source);

  if (sets.length) {
    sets.push(`updated_at = ${NOW_ISO_SQL}`);
    vals.push(id);
    db.prepare(`UPDATE research_items SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  // Die Bezeichnung des Links selbst: eine nackte URL aus der Teilen-Funktion
  // ist im Board nicht lesbar, und POST /sources/from-research braucht sie als
  // Namen der Quelle. Gezieltes UPDATE statt replaceUrls — das vergibt neue
  // url_ids, und die halten Frontend (x-for-key) und Aufrufer in der Hand.
  const label = cleanStr(scraped.title, URL_LABEL_MAX);
  if (label && (!String(urlRow.label || '').trim() || overwrite)) {
    if (setUrlLabel(id, urlRow.id, label)) filled.push('url_label');
  }

  searchIndex.upsertResearch(id);
  // Semantik-Index nachziehen (non-fatal, wie beim PDF-Upload): der frische
  // Volltext waere sonst bis zum Nacht-Cron nur ueber exakten Wortmatch zu finden.
  try { enqueueEmbedIndexJob(bookId, sessionEmail(req)); }
  catch (e) { logger.warn(`[research] embed-index enqueue fehlgeschlagen: ${e.message}`); }

  logger.info(
    `[research] scrape id=${id} url_id=${urlRow.id} uebernommen=${filled.join(',') || '-'} `
    + `stehengelassen=${skipped.join(',') || '-'} zeichen=${nextBody.length}`
  );
  res.json({
    item: emitItem(id),
    filled,
    skipped,
    // Ausgewiesen statt verschwiegen (Regel wie doc_truncated): der Rest des
    // Artikels ist nicht im Fundstueck und damit auch nicht im Index. Nur wenn
    // der Text auch WIRKLICH uebernommen wurde — sonst behauptete die Meldung
    // eine Kappung an einem Feld, das unberuehrt blieb.
    truncated: filled.includes('body') && nextBody.length > BODY_MAX,
    final_url: scraped.finalUrl || urlRow.url,
  });
});

module.exports = { researchScrapeRouter, composeBody };
