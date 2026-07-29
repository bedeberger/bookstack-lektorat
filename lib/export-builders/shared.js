'use strict';
// Gemeinsame Helpers fuer Format-Builder. Halten XML/HTML-Escape, Scope-aware
// Titel und die Quellen-Vorbereitung.

const { resolveCitesInGroups, bibliographyVisible } = require('../bibliography');

/** Quellenangaben fuer einen Export-Builder vorbereiten.
 *
 *  Jeder Builder ruft das als ERSTES und rendert danach `groups` statt
 *  `bundle.groups` — sonst steht im Export der Chip-Text vom Einfuege-Zeitpunkt
 *  statt des aktuellen Kurzbelegs (im numerischen Stil also die Autor-Jahr-Form
 *  statt der Nummer; siehe lib/bibliography.js).
 *
 *  Ohne `opts.bibliography` (Fassungs-Vorschau, Tests, Aufrufer ohne Buchbezug)
 *  passiert nichts und die Eingabe-`groups` kommen unveraendert zurueck — ein
 *  Builder braucht also keinen Sonderpfad fuer „keine Quellen".
 *
 *  `showBibliography` ist die gemeinsame Sichtbarkeitsregel ALLER Builder: das
 *  Verzeichnis erscheint nur beim ganzen Buch. Bei Kapitel-/Seiten-Export werden
 *  die Chips zwar aufgeloest (die Nummern folgen dann dieser Einheit), aber
 *  hinten kein Verzeichnis angehaengt — ein einzelnes Kapitel ist keine
 *  Publikation mit eigenem Apparat. */
async function prepareCitations(bundle, opts = {}) {
  const bib = opts.bibliography || null;
  if (!bib) return { groups: bundle?.groups || [], bib: null, showBibliography: false };
  const groups = await resolveCitesInGroups(bundle.groups, bib);
  const scope = opts.scope || bundle?.scope || 'book';
  // `bibliographyVisible` ist die geteilte Grundregel (aktiv + nicht leer, siehe
  // lib/bibliography.js); der Buch-Scope kommt als Datei-Export-Bedingung dazu.
  // Der Blog-Push nutzt dieselbe Grundregel ohne die Scope-Bedingung — dort IST
  // die Seite die Publikationseinheit.
  return {
    groups,
    bib,
    showBibliography: bibliographyVisible(bib) && scope === 'book',
  };
}

function escXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Scope-aware Dokument-Titel fuer Filename-Slug + Title-Page.
function resolveTitle({ scope, book, chapter, page }) {
  if (scope === 'chapter' && chapter) return chapter.name || book?.name || 'Chapter';
  if (scope === 'page' && page) return page.name || book?.name || 'Page';
  return book?.name || 'Book';
}

function resolveSlug({ scope, book, chapter, page }) {
  if (scope === 'chapter' && chapter) return chapter.slug || chapter.name || book?.slug || 'chapter';
  if (scope === 'page' && page) return page.slug || page.name || book?.slug || 'page';
  return book?.slug || book?.name || 'book';
}

// Berechnet die Tiefe eines Kapitels durch Aufstieg via parent_chapter_id.
// Cap bei 3. Map kommt vom Caller (alle Kapitel des Buchs als chapterId-Lookup).
function chapterDepth(chapter, byId, max = 3) {
  if (!chapter) return 1;
  let d = 1;
  let cur = chapter;
  const seen = new Set();
  while (cur && cur.parent_chapter_id) {
    if (seen.has(cur.parent_chapter_id)) break;
    seen.add(cur.parent_chapter_id);
    const parent = byId.get(cur.parent_chapter_id);
    if (!parent) break;
    d += 1;
    if (d >= max) return max;
    cur = parent;
  }
  return d;
}

// Baut den chapterId → chapter Lookup aus einem `groups`-Array.
function buildChaptersById(groups) {
  const m = new Map();
  for (const g of groups || []) {
    if (g.chapter?.id != null) m.set(g.chapter.id, g.chapter);
  }
  return m;
}

// True, wenn das Kapitel selbst oder ein Vorfahr (via parent_chapter_id) in `set`
// (Kapitel-IDs) liegt. Cascade-Semantik: ein markiertes Top-Kapitel zieht alle
// Sub-Kapitel mit. Pendant zu _ancestorInSet im PDF-Renderer (coalesce.js).
function ancestorInSet(chapter, byId, set) {
  let cur = chapter;
  const seen = new Set();
  while (cur) {
    if (set.has(cur.id)) return true;
    if (!cur.parent_chapter_id || seen.has(cur.parent_chapter_id)) return false;
    seen.add(cur.parent_chapter_id);
    cur = byId.get(cur.parent_chapter_id);
  }
  return false;
}

module.exports = { escXml, resolveTitle, resolveSlug, chapterDepth, buildChaptersById, ancestorInSet, prepareCitations };
