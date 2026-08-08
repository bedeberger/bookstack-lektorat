'use strict';
// Geteilte Helfer der Share-Link-Routes (routes/share/reader.js + api.js):
// Konstanten/Regexes, SSR-Template-Laden, Content-Rendering (Manuskript-Stream),
// data-bid-Backfill + Auflösung, Leser-sichere Kommentar-Serialisierung.

const express = require('express');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const contentStore = require('./content-store');
const { loadContents } = require('./load-contents');
const { stripActiveContent } = require('./html-clean');
const { htmlToPlainText } = require('./html-text');
const { getBookSettings } = require('../db/schema');
const headline = require('./headline-render');
const { tServer } = require('./i18n-server');
const logger = require('../logger');

// ── Body-Parser-Middleware (von Reader- + API-Routen geteilt) ────────────────
const jsonBody = express.json();
const formBody = express.urlencoded({ extended: false });
const commentBody = (req, res, next) => {
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  if (ct.startsWith('application/x-www-form-urlencoded')) return formBody(req, res, next);
  return jsonBody(req, res, next);
};

const TEMPLATE_OK   = fs.readFileSync(path.join(__dirname, '..', 'public', 'share.html'), 'utf8');
const TEMPLATE_GONE = fs.readFileSync(path.join(__dirname, '..', 'public', 'share.gone.html'), 'utf8');

// Buchtypen, die als Sach-/Web-Text gelesen werden: Absatz-Modell bleibt der
// Web-Artikel-Stil (Leerzeile zwischen Absätzen, kein Einzug). Alle übrigen Typen
// (Roman, Krimi, Erzählung …) sowie null/„andere" sind Prosa → Buch-Stil mit
// Erstzeilen-Einzug (Klasse share-content--prose). Lyrik bleibt Web-Stil, weil
// Verse über das .poem-Markup eigene Formatierung tragen.
const NON_PROSE_BUCHTYPEN = new Set(['blog', 'sachbuch', 'wissenschaft', 'essay', 'lyrik']);
function articleStyleClass(bookId) {
  try {
    const { buchtyp } = getBookSettings(bookId);
    return NON_PROSE_BUCHTYPEN.has(buchtyp) ? '' : 'share-content--prose';
  } catch {
    return 'share-content--prose';
  }
}

const READER_NAME_MAX = 80;
const READER_EMAIL_MAX = 200;
const BODY_MAX = 4000;
const INTRO_MAX = 2000;
const ANCHOR_QUOTE_MAX = 600;
const ANCHOR_BID_RE = /^[0-9a-f]{6,32}$/i;
const READER_TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;
// Pragmatische Mail-Validierung (kein RFC-Vollparser): nicht-leer, ein @,
// kein Whitespace. Leere Eingabe = Mail entfernen (kein Fehler).
const READER_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,32}$/;

// Leser-sichere Serialisierung eines share_comments-Rows. Gibt NIE author_email,
// reader_token oder ip_hash preis; `mine` wird gegen den Token des anfragenden
// Lesers berechnet (Self-Erkennung ohne andere Tokens zu leaken).
function serializeCommentForReader(row, readerToken) {
  const isAuthor = !!row.author_email;
  return {
    id: row.id,
    parent_id: row.parent_id || null,
    name: isAuthor ? (row.author_display_name || null) : (row.reader_name || null),
    is_author: isAuthor,
    mine: !isAuthor && !!readerToken && row.reader_token === readerToken,
    body: row.body,
    created_at: row.created_at,
    edited_at: row.edited_at || null,
    resolved: !!row.resolved_at,
    // Nur für eigene Beiträge: ob eine Mail hinterlegt ist (→ Reply-
    // Benachrichtigung aktiv). Fremde Mailadressen werden NIE preisgegeben.
    email_set: !isAuthor && !!readerToken && row.reader_token === readerToken ? !!row.reader_email : undefined,
    anchor: row.anchor_bid
      ? { bid: row.anchor_bid, quote: row.anchor_quote || '', start: row.anchor_start, end: row.anchor_end }
      : null,
  };
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function detectLang(req) {
  const accept = String(req.headers['accept-language'] || '').toLowerCase();
  if (accept.startsWith('en')) return 'en';
  return 'de';
}

function isExpired(link) {
  if (link.revoked_at) return 'revoked';
  if (link.expires_at && new Date(link.expires_at) <= new Date()) return 'expired';
  return null;
}

function fillTemplate(tpl, vars) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : ''));
}

function paragraphifyIntro(text) {
  if (!text) return '';
  const blocks = text.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
  return blocks.map(b => `<p>${escHtml(b).replace(/\n/g, '<br>')}</p>`).join('');
}

// Geteilter Manuskript-Stream-Renderer (public/js/, ESM) lazy + gecacht laden,
// Muster wie lib/prompts-loader.js. SSoT für den Stream-Look von Bucheditor,
// Fassungen-Reader und Share.
let _streamPromise = null;
function getStream() {
  if (_streamPromise) return _streamPromise;
  _streamPromise = (async () => {
    const base = path.join(__dirname, '..', 'public', 'js');
    const [render, model] = await Promise.all([
      import(pathToFileURL(path.join(base, 'manuscript-render.js')).href),
      import(pathToFileURL(path.join(base, 'manuscript-stream.js')).href),
    ]);
    return { renderStreamHtml: render.renderStreamHtml, fromGroups: model.fromGroups };
  })();
  return _streamPromise;
}

// Verankerte Leser-Kommentare + die schwebende Kommentar-Leiste haengen an
// data-bid auf den Bloecken (share-anchor.js). data-bid entsteht sonst nur am
// Editor-Write-Chokepoint — Legacy-/Import-Seiten haben keine. Die betroffenen
// Seiten des Link-Scopes einmalig nachziehen: additiv, ohne updated_at-Bump/
// Revision (backfillBlockIds ist idempotent: Seiten mit data-bid sind No-op).
// Best-effort — ein Fehler darf das Teilen/Lesen nie abbrechen. Wird sowohl beim
// Anlegen des Links als auch lazy beim Reader-GET aufgerufen, damit auch Links,
// die vor diesem Backfill angelegt wurden, beim ersten Aufruf repariert werden.
async function backfillScopeBlockIds(link) {
  try {
    let pageIds;
    if (link.kind === 'page') {
      pageIds = [link.page_id];
    } else {
      const pages = await contentStore.listPages(link.book_id);
      pageIds = (link.kind === 'chapter' ? pages.filter(p => p.chapter_id === link.chapter_id) : pages).map(p => p.id);
    }
    let n = 0;
    for (const pid of pageIds) {
      try { if ((await contentStore.backfillBlockIds(pid)).changed) n++; } catch { /* per-page best-effort */ }
    }
    if (n) logger.info(`[share/backfill] data-bid backfill auf ${n}/${pageIds.length} Seiten (kind=${link.kind} book=${link.book_id})`);
  } catch (e) {
    logger.warn('[share/backfill] data-bid backfill fehlgeschlagen: ' + e.message);
  }
}

// Manuskript-Bild-Refs im oeffentlichen Reader-HTML von der auth-geschuetzten
// /content/page-image/:id-URL auf den token-gebundenen Share-Endpoint umschreiben
// (der Reader laeuft ohne Session; /content/* wuerde 401/Redirect liefern).
function _rewriteShareImageSrc(html, token) {
  if (!html || html.indexOf('/content/page-image/') === -1) return html || '';
  return html.replace(/\/content\/page-image\/(\d+)/g, (m, id) => `/share/${token}/page-image/${id}`);
}

// Einziger Chokepoint fuer HTML, das in die OEFFENTLICHE Reader-View geht: erst
// aktive Inhalte entfernen, dann Bild-Refs auf den token-gebundenen Endpoint
// umschreiben.
//
// Why der Strip hier, obwohl `cleanPageHtml` ihn schon am Schreibweg macht: der
// Schreibweg raeumt nur, was NEU gespeichert wird. Zeilen, die vor dieser
// Regel in die DB kamen (Alt-Bestand, Blog-Import, wiederhergestellte Fassung),
// tragen ihr HTML unveraendert weiter — und diese View ist die einzige Stelle,
// an der es ohne Login und ohne Editor-Dazwischen an Fremde ausgeliefert wird.
// Der Fast-Path in stripActiveContent parst dafuer im Normalfall nicht.
function _publicShareHtml(html, token) {
  return _rewriteShareImageSrc(stripActiveContent(html || ''), token);
}

// Titel-Kopf je Seite fuer den Manuskript-Stream (Buch-/Kapitel-Share).
// Reicht den Kopf aus lib/headline-render.js als fertiges Markup weiter — der
// Stream-Adapter kennt die Titel-Werkstatt bewusst nicht (er ist ESM + pure,
// die Markup-SSoT ist CJS).
const _streamPageHead = (p) => headline.needsOwnHead(p)
  ? { name: headline.pageTitle(p), before: headline.kickerHtml(p), after: headline.leadHtml(p) }
  : null;

async function loadContentForLink(link) {
  if (link.kind === 'page') {
    try {
      const pd = await contentStore.loadPage(link.page_id);
      // Seiten-Share hat keinen Manuskript-Stream: der Kopf wird hier gesetzt,
      // und seine drei Teile stehen bewusst NICHT beieinander im Fliesstext.
      // Der Titel ist die H1 der Leseansicht; die Dachzeile gehoert direkt
      // darueber (sie qualifiziert die Schlagzeile — getrennt gelesen ist sie
      // nur eine Zeile in Versalien), der Lead an den Anfang des Beitrags, den
      // er eroeffnet. Als schlichte Absaetze uebereinander im Body waren die
      // beiden von ersten Textabsaetzen nicht zu unterscheiden — genau die
      // Verwechslung, gegen die die Titel-Werkstatt die Felder trennt.
      headline.attachPageHeadline(pd, link.book_id);
      const lead = headline.leadHtml(pd);
      return {
        title: headline.pageTitle(pd),
        kicker: headline.kickerHtml(pd),
        html: _publicShareHtml((lead ? lead + '\n' : '') + (pd.html || ''), link.token),
        toc: [],
      };
    } catch {
      return null;
    }
  }
  if (link.kind === 'book') {
    // Ganzes Buch in Reihenfolge: Kapitel-Ueberschrift (h2) + Seiten (h3),
    // inkl. Sub-Kapitel (loadContents liefert alle Seiten chapter-geordnet).
    try {
      const { book, groups } = await loadContents({ scope: 'book', id: link.book_id });
      const { renderStreamHtml, fromGroups } = await getStream();
      const { html, toc } = renderStreamHtml(fromGroups(groups, { pageHead: _streamPageHead }));
      return { title: book.name || '', html: _publicShareHtml(html, link.token), toc };
    } catch {
      return null;
    }
  }
  // chapter — alle Seiten des Kapitels (ohne Sub-Kapitel, MVP). Kapitelname
  // steht bereits im Seiten-Header (h1), darum kein Kapitel-Heading im Body
  // (omitChapterHeaders) und Seiten als h2.
  try {
    const chapter = await contentStore.loadChapter(link.chapter_id);
    const pages = await contentStore.listPages(link.book_id);
    const chapterPages = pages
      .filter(p => p.chapter_id === link.chapter_id)
      .sort((a, b) => (a.position || 0) - (b.position || 0));
    const groupPages = [];
    for (const meta of chapterPages) {
      const pd = await contentStore.loadPage(meta.id);
      // Dieser Zweig laeuft nicht ueber loadContents, haengt den Titel-Kopf also
      // selbst an (Gate + Lookup sitzen in lib/headline-render.js).
      headline.attachPageHeadline(pd, link.book_id);
      groupPages.push({ p: pd, pd });
    }
    const { renderStreamHtml, fromGroups } = await getStream();
    const entries = fromGroups([{ chapterId: link.chapter_id, chapter, pages: groupPages }], { pageHead: _streamPageHead });
    const { html, toc } = renderStreamHtml(entries, { pageTag: 'h2', omitChapterHeaders: true });
    return {
      title: chapter.name || chapter.chapter_name || '',
      html: _publicShareHtml(html, link.token),
      toc,
    };
  } catch {
    return null;
  }
}

// Inhaltsverzeichnis fuer Buch-/Kapitel-Shares (nur wenn show_toc aktiv und
// mehr als ein Eintrag vorhanden — ein Single-Eintrag-TOC bringt nichts).
// Gerendert als linke Leiste (Pendant zur Bucheditor-Outline): im Grid sticky
// links, gestapelt (mobil) als Box ueber dem Inhalt.
function buildTocBlock(content, lang) {
  if (!content?.toc || content.toc.length < 2) return '';
  const items = content.toc.map(e =>
    `<li class="share-toc__item share-toc__item--l${e.level}"><a class="share-toc__link" href="#${escHtml(e.anchor)}">${escHtml(e.label)}</a></li>`
  ).join('');
  const heading = escHtml(tServer('share.reader.toc_heading', lang));
  return `<aside class="share-toc">
    <nav class="share-toc__inner" aria-label="${heading}">
      <h2 class="share-toc__heading">${heading}</h2>
      <ol class="share-toc__list">${items}</ol>
    </nav>
  </aside>`;
}

// Block-ID → Seite auflösen, mit Per-Buch-Memo. Verankerte Kommentare speichern
// nur die data-bid (keine page_id — Blöcke können zwischen Seiten wandern); die
// Zuordnung ergibt sich erst aus dem aktuellen Seiteninhalt. Da page-comment-counts
// bei jedem Tree-Refresh läuft, wird das Ergebnis pro Buch gecacht und über eine
// günstige Signatur (Seitenzahl + max updated_at, beides aus den Metadaten ohne
// HTML-Load) invalidiert. Nicht gefundene Bids werden als null gecacht (Block
// gelöscht / nie auf einer Seite); eine spätere Bearbeitung bumpt updated_at und
// verwirft den Cache. data-bid ist buchweit eindeutig → Scope = alle Buch-Seiten.
const _bidPageCache = new Map(); // bookId → { sig, map: { bid → pageId|null } }

async function resolveBidsToPages(bookId, bids) {
  const wanted = [...bids];
  if (!wanted.length) return {};
  const metas = await contentStore.listPages(bookId);
  let maxUpdated = '';
  for (const m of metas) { if (m.updated_at && m.updated_at > maxUpdated) maxUpdated = m.updated_at; }
  const sig = `${metas.length}:${maxUpdated}`;
  let entry = _bidPageCache.get(bookId);
  if (!entry || entry.sig !== sig) { entry = { sig, map: {} }; _bidPageCache.set(bookId, entry); }

  const remaining = new Set(wanted.filter(b => entry.map[b] === undefined));
  if (remaining.size) {
    for (const meta of metas) {
      if (!remaining.size) break; // alle gesuchten Bids gefunden → Scan abbrechen
      const pd = await contentStore.loadPage(meta.id);
      const html = pd.html || '';
      for (const b of [...remaining]) {
        if (html.includes(`data-bid="${b}"`)) { entry.map[b] = meta.id; remaining.delete(b); }
      }
    }
    for (const b of remaining) entry.map[b] = null; // nicht auffindbar
  }
  const out = {};
  for (const b of wanted) out[b] = entry.map[b] ?? null;
  return out;
}

function renderGone(req, res, kind) {
  const lang = detectLang(req);
  const html = fillTemplate(TEMPLATE_GONE, {
    lang,
    title: tServer('share.reader.gone.title', lang),
    heading: tServer(kind === 'revoked' ? 'share.reader.revoked_heading' : 'share.reader.expired_heading', lang),
    body: tServer(kind === 'revoked' ? 'share.reader.revoked_body' : 'share.reader.expired_body', lang),
  });
  res.status(410).type('html').send(html);
}

// Zeichenzahl des sichtbaren Textes eines Reader-Inhalts (fuer Umfang +
// Lesezeit-Schaetzung). Laeuft durch dieselbe SSoT wie die App-Statistik
// (lib/html-text.js, auch von routes/sync.js genutzt) statt durch eine eigene
// Regex-Kette — sonst driftet der dem Leser gezeigte Umfang gegen die Zahl im
// Buch: Diagramm-Quelltext zaehlte hier mit und dort nicht.
function htmlToPlainLength(html) {
  if (!html) return 0;
  // Titel-Kopf raus: Umfang und Lesezeit messen den BEITRAG. Dachzeile und Lead
  // sind Metadata und zaehlen nirgends als Prosa — genau dafuer stehen sie nicht
  // im Fliesstext (lib/headline-render.js#stripHeadBlocks).
  return htmlToPlainText(headline.stripHeadBlocks(html)).length;
}

module.exports = {
  jsonBody, formBody, commentBody,
  TEMPLATE_OK, TEMPLATE_GONE,
  NON_PROSE_BUCHTYPEN, articleStyleClass,
  READER_NAME_MAX, READER_EMAIL_MAX, BODY_MAX, INTRO_MAX, ANCHOR_QUOTE_MAX,
  ANCHOR_BID_RE, READER_TOKEN_RE, READER_EMAIL_RE, TOKEN_RE,
  serializeCommentForReader, escHtml, detectLang, isExpired, fillTemplate, paragraphifyIntro,
  getStream, backfillScopeBlockIds, loadContentForLink, buildTocBlock, resolveBidsToPages, renderGone,
  htmlToPlainLength,
};
