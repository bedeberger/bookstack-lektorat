'use strict';
// Gemeinsame Helpers fuer Format-Builder. Halten XML/HTML-Escape, Scope-aware
// Titel und die Quellen-Vorbereitung.

const { resolveCitesInGroups, bibliographyVisible } = require('../bibliography');
const { buildEndnotes } = require('../endnotes');
const { resolveDiagramsInGroups } = require('../diagram-export');
const { pageTitle } = require('../headline-render');

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
 *  Publikation mit eigenem Apparat.
 *
 *  DIAGRAMME laufen im selben Aufruf mit (`opts.diagramMode`, siehe
 *  lib/diagram-export.js). Sie gehoeren fachlich nicht zu den Quellen, teilen
 *  aber genau die Eigenschaft, die diesen Helper begruendet: sie stehen als
 *  Rohform im Manuskript und muessen von JEDEM Ausgabeweg vor seinem Walker
 *  aufgeloest werden. Ein zweiter Helper daneben waere ein zweiter Ort, den man
 *  bei einem neuen Builder vergessen kann.
 *
 *  Default ist `'code'` — also nichts tun, Quelltext stehen lassen. Ein Builder,
 *  der Bilder tragen kann, waehlt aktiv `'svg'` (HTML/EPUB) oder `'png'`
 *  (Word). Bewusst diese Richtung: ein vergessenes Opt-in kostet ein Bild, ein
 *  falsches Opt-out ein kaputtes Dokument. */
async function prepareCitations(bundle, opts = {}) {
  const bib = opts.bibliography || null;
  const withDiagrams = await resolveDiagramsInGroups(bundle?.groups || [], {
    mode: opts.diagramMode || 'code',
  });
  if (!bib) return { groups: withDiagrams, bib: null, showBibliography: false, notes: false };

  // Zwei Belegdarstellungen, nie beide: entweder traegt der Chip den Kurzbeleg
  // (inline) oder eine Notenziffer (endnotes, lib/endnotes.js). Hintereinander
  // ausgefuehrt wuerde der Anmerkungspass den frisch gesetzten Kurzbeleg gleich
  // wieder ueberschreiben. Im Anmerkungsmodus traegt jede Gruppe zusaetzlich
  // `notes` — die Notenliste ihres Kapitels, leer bei allen ausser der letzten
  // Gruppe des Kapitels.
  // `footnotes` zaehlt hier wie `endnotes`: EPUB, HTML, Markdown, Plaintext und
  // Substack haben keine Seiten, an deren Fuss ein Apparat stehen koennte. Der
  // Kapitelapparat ist dort die richtige Entsprechung — und die einzige, die den
  // Beleg ueberhaupt sichtbar laesst. Seitenfuss kann nur der PDF-Renderer; Word
  // macht es ueber seinen eigenen Fussnoten-Mechanismus (export-builders/docx.js).
  const notes = bib.notesMode === 'endnotes' || bib.notesMode === 'footnotes';
  const groups = notes
    ? (await buildEndnotes(withDiagrams, bib)).groups
    : await resolveCitesInGroups(withDiagrams, bib);
  const scope = opts.scope || bundle?.scope || 'book';
  // `bibliographyVisible` ist die geteilte Grundregel (aktiv + nicht leer, siehe
  // lib/bibliography.js); der Buch-Scope kommt als Datei-Export-Bedingung dazu.
  // Der Blog-Push nutzt dieselbe Grundregel ohne die Scope-Bedingung — dort IST
  // die Seite die Publikationseinheit.
  return {
    groups,
    bib,
    notes,
    showBibliography: bibliographyVisible(bib) && scope === 'book',
  };
}

/** Ueberschrift des Anmerkungsapparats in der Sprache des BUCHS.
 *
 *  Anders als der Verzeichnistitel ist sie nicht konfigurierbar: der Apparat
 *  steht mehrfach im Buch (einmal pro Kapitel) und traegt darum eine
 *  Standard-Ueberschrift, keine Werk-eigene.
 *
 *  Der Wert kommt aus der Label-SSoT und liegt in `bib.notesTitle`
 *  (buildBibliography laedt das ESM-Format-Modul ohnehin) — hier steht bewusst
 *  KEINE zweite Sprach-Map, die davon abdriften koennte. Der Fallback greift nur
 *  bei einem handgebauten Kontext ohne Sprachdaten (Tests, Vorschau). */
function notesTitleFor(bib) {
  return bib?.notesTitle || (bib?.lang === 'en' ? 'Notes' : 'Anmerkungen');
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
//
// Beim Seiten-Export gewinnt der Beitragstitel aus der Titel-Werkstatt ueber den
// Seitennamen (lib/headline-render.js#pageTitle) — bei einem einzeln
// exportierten Artikel ist die Schlagzeile der Dokumenttitel, nicht der
// Ordnungsname aus dem Buchorganizer. Der SLUG bleibt bewusst am Seitennamen
// (resolveSlug): der Dateiname ist eine Adresse, die sich nicht aendern soll,
// weil jemand den Titel umformuliert hat.
function resolveTitle({ scope, book, chapter, page }) {
  if (scope === 'chapter' && chapter) return chapter.name || book?.name || 'Chapter';
  if (scope === 'page' && page) return pageTitle(page) || book?.name || 'Page';
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

// Traegt die erste Seite eines Kapitels denselben Namen wie das Kapitel selbst,
// stuenden im Export zwei identische Ueberschriften direkt untereinander (der
// haeufige Fall beim einseitigen Kapitel, wo Kapitel- und Seitenname aus
// derselben Anlage stammen). Gross-/Kleinschreibung und Mehrfach-Whitespace
// sind hier keine Unterscheidung. SSoT fuer PDF (lib/pdf-render/coalesce.js) und
// Word — beide Wege muessen dieselbe Doppelung erkennen, sonst zeigt derselbe
// Buchstand je Format eine andere Gliederung.
function sameStructureTitle(a, b) {
  const norm = v => String(v ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const na = norm(a);
  return !!na && na === norm(b);
}

module.exports = { escXml, resolveTitle, resolveSlug, chapterDepth, buildChaptersById, ancestorInSet, sameStructureTitle, prepareCitations, notesTitleFor };
