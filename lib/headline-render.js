'use strict';
// SSoT fuer den Titel-Kopf eines Beitrags auf JEDEM Ausgabeweg.
//
// Dachzeile, Titel und Lead liegen als Metadata der Seite in `page_headline`
// (db/headline.js) — das ist der Zweck der Titel-Werkstatt: als Spalten sind sie
// adressierbar, als erste Absaetze waeren sie fuer jede Maschine Prosa. Der
// Preis dafuer ist, dass sie kein Ausgabeweg von selbst sieht. Jeder muss sie
// aufloesen, bevor sein Walker laeuft — dieselbe Eigenschaft, die
// prepareCitations (Quellen) und applyXrefsInGroups (Querverweise) begruendet,
// und derselbe Grund, warum es genau EINE Stelle dafuer gibt.
//
// DER TITEL ERSETZT DEN SEITENNAMEN, er tritt nicht daneben. `pages.page_name`
// ist der Ordnungsname im Buchorganizer ("Beitrag 12"), der Titel die
// Schlagzeile; nebeneinander traegt jeder Beitrag zwei Ueberschriften. Ist kein
// Titel gesetzt, bleibt der Seitenname stehen — ein leerer Kopf waere schlimmer
// als ein technischer Name. Der Blog-Sync entscheidet seit jeher genau so
// (routes/jobs/blog-sync.js), das ist hier nur dieselbe Regel fuer alle
// uebrigen Wege.
//
// DER TEASER GEHOERT NICHT IN DEN BEITRAG. Er ist der Anreisser fuer
// Uebersichten und Vorschaukarten — im Beitrag selbst waere er die Wiederholung
// des Leads mit anderen Worten. Er verlaesst die App weiterhin nur als
// WordPress-`excerpt`.
//
// MARKUP-INVARIANTE: der Kopf traegt seine Klasse UND eine Auszeichnung
// (`<strong>`/`<em>`). Beides mit Absicht — die Wege mit eigenem Stylesheet
// (HTML, EPUB, Substack, Share-Reader) haengen sich an die Klasse, die Wege
// durch den HTML-Walker (PDF, Word, Markdown) kennen nur die Auszeichnung. Ohne
// sie waere eine Dachzeile im PDF ein Absatz wie jeder andere; ohne die Klasse
// koennte kein Stylesheit sie enger stellen. Nicht die eine gegen die andere
// eintauschen.

const { listBookHeadlines, getHeadline } = require('../db/headline');
const { isJournalisticBook } = require('./buchtyp');

const KICKER_CLASS = 'ms-head__kicker';
const LEAD_CLASS = 'ms-head__lead';

// Lokal statt Import aus export-builders/shared.js: dieses Modul wird auch vom
// Share-Reader und vom PDF-Renderer geladen, die mit den Export-Buildern sonst
// nichts zu tun haben.
function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function _val(p, feld) {
  const v = p && p.hl ? p.hl[feld] : null;
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Haengt den geltenden Titelstand an die Seiten eines loadContents-Bundles.
 *
 * Einziger Aufrufer ist lib/load-contents.js — damit tragen ALLE Export-Wege
 * und der Buch-/Kapitel-Share den Kopf, ohne dass ein Builder ihn nachladen
 * muesste. Gehaengt wird an die Seiten-METADATEN (`x.p`), weil `resolveTitle`
 * und die Builder-Ueberschriften ohnehin von dort lesen.
 *
 * Non-fatal: faellt der Lookup aus, exportiert das Buch ohne Koepfe statt gar
 * nicht — ein Titelapparat ist Zutat, kein Inhalt.
 */
function attachHeadlines(bundle) {
  if (!bundle || !bundle.book) return bundle;
  try {
    if (!isJournalisticBook(bundle.book.id)) return bundle;
    const byPage = listBookHeadlines(bundle.book.id);
    for (const g of bundle.groups || []) {
      for (const x of g.pages || []) {
        if (x && x.p) x.p.hl = byPage[String(x.p.id)] || null;
      }
    }
    // Bei scope='page' sind `bundle.page` und `groups[0].pages[0].p` dasselbe
    // Objekt (lib/load-contents.js#_loadPageGroup) — die Zuweisung oben deckt
    // es also mit ab. Defensiv trotzdem, falls das je entkoppelt wird.
    if (bundle.page && bundle.page.hl === undefined) {
      bundle.page.hl = byPage[String(bundle.page.id)] || null;
    }
  } catch { /* non-fatal */ }
  return bundle;
}

/** Einzelne Seite nachziehen (Share-Seiten-Link — der laeuft nicht ueber loadContents). */
function attachPageHeadline(page, bookId) {
  if (!page) return page;
  try {
    if (isJournalisticBook(bookId)) page.hl = getHeadline(page.id) || null;
  } catch { /* non-fatal */ }
  return page;
}

/** Die Ueberschrift, unter der dieser Beitrag erscheint. */
function pageTitle(p) {
  return _val(p, 'titel') || (p && p.name) || '';
}

function kickerText(p) { return _val(p, 'dachzeile'); }
function leadText(p) { return _val(p, 'lead'); }

/** Traegt die Seite ueberhaupt etwas, das oberhalb/unterhalb der Ueberschrift steht? */
function hasHead(p) {
  return !!(kickerText(p) || leadText(p));
}

/**
 * Muss ein Ausgabeweg hier einen Kopf setzen, obwohl er an dieser Stelle
 * normalerweise KEINE Seitenueberschrift schreibt?
 *
 * Die Builder lassen die Seitenueberschrift bewusst weg, wo sie nichts
 * beitraegt (Kapitel mit genau einer Seite, Kapitel-/Seiten-Scope) — dort steht
 * der Kapitelname darueber. Bei einem Beitrag mit eigener Schlagzeile stimmt
 * das nicht mehr: der Ressortname ist nicht der Titel des Artikels. Fuer diese
 * Seiten liefert `headHtml` die fehlende Ueberschrift mit.
 */
function needsOwnHead(p) {
  return hasHead(p) || !!_val(p, 'titel');
}

/** Dachzeile — steht UEBER der Ueberschrift. '' wenn nicht gesetzt. */
function kickerHtml(p) {
  const t = kickerText(p);
  return t ? `<p class="${KICKER_CLASS}"><strong>${_esc(t)}</strong></p>` : '';
}

/** Lead — steht UNTER der Ueberschrift. '' wenn nicht gesetzt. */
function leadHtml(p) {
  const t = leadText(p);
  return t ? `<p class="${LEAD_CLASS}"><em>${_esc(t)}</em></p>` : '';
}

/**
 * Vollstaendiger Kopf inklusive Ueberschrift — fuer Ausgabewege, die an dieser
 * Stelle KEINE eigene Ueberschrift setzen (PDF im flatten-Modus, Seiten ohne
 * Kapitel, Share-Seiten-Link). Ohne diesen Weg verschwaende der Beitragstitel
 * dort ersatzlos.
 *
 * `titleTag: null` laesst die Ueberschrift weg (der Aufrufer setzt sie selbst).
 */
function headHtml(p, { titleTag = null } = {}) {
  const parts = [kickerHtml(p)];
  if (titleTag) {
    const t = pageTitle(p);
    if (t) parts.push(`<${titleTag}>${_esc(t)}</${titleTag}>`);
  }
  parts.push(leadHtml(p));
  return parts.filter(Boolean).join('\n');
}

// Kopf-Bloecke aus fertig gerendertem Ausgabe-HTML wieder herausschneiden.
//
// Braucht jede Schicht, die den Umfang eines Beitrags MISST statt ihn anzeigt —
// der Titelapparat ist Metadata und zaehlt nirgends als Prosa (dieselbe Regel,
// die `page_stats`, Wortschatz und Lektorat von ihm fernhaelt; er steht ja
// gerade deshalb nicht im Fliesstext). Aus `pages.content` muss nichts
// geschnitten werden — dort kommt er nie an; betroffen ist nur HTML, das dieses
// Modul selbst erzeugt hat.
const _HEAD_BLOCK_RE = new RegExp(
  `<p\\b[^>]*\\bclass\\s*=\\s*("[^"]*\\b(?:${KICKER_CLASS}|${LEAD_CLASS})\\b[^"]*"|'[^']*\\b(?:${KICKER_CLASS}|${LEAD_CLASS})\\b[^']*')[^>]*>[\\s\\S]*?<\\/p>`,
  'gi',
);

function stripHeadBlocks(html) {
  return String(html || '').replace(_HEAD_BLOCK_RE, ' ');
}

module.exports = {
  KICKER_CLASS, LEAD_CLASS, stripHeadBlocks,
  attachHeadlines, attachPageHeadline,
  pageTitle, hasHead, needsOwnHead,
  kickerText, leadText, kickerHtml, leadHtml, headHtml,
};
