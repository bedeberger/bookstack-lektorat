'use strict';
// Single-File-HTML-Export. Verpackt Buch/Kapitel/Seite mit Print-CSS-Wrapper.
// Page-HTML wird unveraendert eingebettet (BookStack-WYSIWYG-Markup ist bereits
// gueltiges HTML5). XSS-Schutz erfolgt bei Eingang ueber lib/html-clean#
// cleanPageHtml; Builder schreibt nichts dazu, was nicht aus Schema/Body kommt.

const { escXml, resolveTitle, chapterDepth, buildChaptersById, prepareCitations, notesTitleFor } = require('./shared');
const { buildXrefContext, applyXrefsInGroups } = require('../xref-render');
const { directoryHtml } = require('../anchor-directory');
const { bibliographyItemHtml } = require('../bibliography');
const { endnoteItemHtml } = require('../endnotes');
const headline = require('../headline-render');

const STYLE = `
:root { color-scheme: light; }
body {
  font-family: 'Lora', Georgia, serif;
  line-height: 1.55;
  max-width: 72ch;
  margin: 2rem auto;
  padding: 0 1rem;
  color: #1a1a1a;
}
h1, h2, h3 { font-family: 'Playfair Display', Georgia, serif; }
h1 { font-size: 2.2em; margin-top: 0; }
h2 { font-size: 1.6em; margin-top: 2em; border-top: 1px solid #ddd; padding-top: 1em; }
h3 { font-size: 1.2em; margin-top: 1.6em; }
p { margin: 0 0 0.8em; }
blockquote { border-left: 3px solid #888; margin: 1em 0; padding-left: 1em; color: #555; }
/* Belegtes Blockzitat (<blockquote data-src>, Markup-SSoT
   public/js/sources/cite-html.js): woertliches Zitat, darum kleiner und aufrecht. */
blockquote[data-src] { font-size: 0.95em; font-style: normal; }
img { max-width: 100%; height: auto; }
/* Tabellen (Markup-SSoT public/js/table/table-html.js). data-align ist der
   Traeger der Spaltenausrichtung — die Kopfzelle ist fuer ihre Spalte
   autoritativ, das Markup traegt sie aber an jeder Zelle, weil CSS
   text-align nicht aus einer Spaltenangabe ableiten kann.
   Kein overflow-x-Wrapper: eine Einzeldatei wird gelesen, nicht in einem
   Layout-Slot dargestellt — breite Tabellen duerfen den Textkoerper
   ueberragen statt intern zu scrollen. */
/* Abbildungs-/Tabellenverzeichnis (Render-Artefakt, lib/anchor-directory.js):
   haengender Einzug, damit die Nummern eine Spalte bilden. Ohne Seitenzahlen —
   die hat eine HTML-Datei nicht. */
.anchor-dir { margin-top: 2em; }
.anchor-dir p { padding-left: 5em; text-indent: -5em; margin: 0 0 0.25em; font-size: 0.95em; }
.anchor-dir__num { font-weight: 600; }
table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: 0.95em; }
th, td { border: 1px solid #ccc; padding: 0.35em 0.6em; text-align: left; vertical-align: top;
         font-variant-numeric: lining-nums tabular-nums; }
th { background: #f4f2ee; font-weight: 700; }
[data-align="center"] { text-align: center; }
[data-align="right"] { text-align: right; }
caption { caption-side: bottom; margin-top: 0.4em; font-size: 0.9em; font-style: italic; color: #555; text-align: left; }
.poem { white-space: pre-wrap; font-style: italic; }
hr { border: 0; border-top: 1px solid #ddd; margin: 2em 0; }
/* Quellenverzeichnis (Render-Artefakt, lib/bibliography.js): haengender Einzug,
   damit Urheber bzw. die [n]-Spalte des numerischen Stils links stehen bleiben. */
.bibliography p { padding-left: 2em; text-indent: -2em; font-size: 0.95em; }
/* Anmerkungsapparat pro Kapitel (lib/endnotes.js): kleiner als der Fliesstext,
   mit haengendem Einzug, damit die Notenziffern eine Spalte bilden. */
.endnotes { font-size: 0.9em; margin-top: 2em; }
.endnotes h3 { font-size: 1em; text-transform: uppercase; letter-spacing: 0.06em; }
.endnotes p { padding-left: 2em; text-indent: -2em; margin: 0 0 0.35em; }
/* Titel-Kopf eines Beitrags (lib/headline-render.js): Dachzeile ueber, Lead
   unter der Ueberschrift. Das <strong>/<em> im Markup ist der Fallback fuer
   Ausgabewege ohne Stylesheet — hier wird es zurueckgenommen und durch die
   redaktionelle Auszeichnung ersetzt. */
.ms-head__kicker { margin: 2em 0 0.15em; font-size: 0.8em; letter-spacing: 0.09em; text-transform: uppercase; color: #6a6a6a; }
.ms-head__kicker strong { font-weight: 600; }
.ms-head__kicker + h2, .ms-head__kicker + h3, .ms-head__kicker + h4,
.ms-head__kicker + h5, .ms-head__kicker + h6 { margin-top: 0; border-top: 0; padding-top: 0; }
.ms-head__lead { margin: 0.2em 0 1.1em; font-size: 1.1em; line-height: 1.45; color: #333; }
.ms-head__lead em { font-style: normal; font-weight: 500; }
@media print {
  body { max-width: none; margin: 0; }
  h2 { page-break-before: always; border-top: 0; }
}
`.trim();

async function buildHtml(bundle, opts = {}) {
  const { scope, book, chapter, page } = bundle;
  // SVG statt PNG: eine HTML-Datei traegt Vektorgrafik direkt, sie skaliert
  // mit der Schriftgroesse und ist ein Bruchteil so gross wie ein Screenshot.
  const prepared = await prepareCitations(bundle, { ...opts, diagramMode: 'svg' });
  const { bib, showBibliography } = prepared;
  // Querverweise aufloesen — vor der Ausgabe, aus demselben Grund wie die
  // Quellen-Chips: der Text im Marker ist ein Cache vom Einfuege-Zeitpunkt, die
  // Nummer eine Eigenschaft DIESER gerenderten Einheit (siehe
  // public/js/xrefs/xref-html.js). Ohne `chapterLabels`: dieser Builder
  // nummeriert seine Ueberschriften nicht, also gilt die nested-arabische
  // Vorgabe.
  const xrefCtx = await buildXrefContext({ bookId: book?.book_id, groups: prepared.groups });
  const xrefApplied = await applyXrefsInGroups(prepared.groups, xrefCtx);
  const groups = xrefApplied.groups;
  const title = resolveTitle({ scope, book, chapter, page });
  const parts = [];
  parts.push('<!DOCTYPE html>');
  parts.push(`<html lang="de"><head><meta charset="UTF-8"><title>${escXml(title)}</title>`);
  parts.push(`<style>${STYLE}</style>`);
  parts.push('</head><body>');
  parts.push(`<h1>${escXml(title)}</h1>`);
  // Tiefen-Lookup: Kapitel kennen parent_chapter_id. Top-Level → h2, Sub → h3,
  // Sub-Sub → h4. Page-Headings darunter eine Stufe (max h6).
  const byId = buildChaptersById(groups);
  for (const g of groups) {
    const ch = g.chapter;
    if (ch && (scope === 'book' || scope === 'chapter')) {
      const d = chapterDepth(ch, byId);
      const tag = `h${Math.min(6, d + 1)}`;
      parts.push(`<${tag}>${escXml(ch.name)}</${tag}>`);
    }
    const includePageHeadings = scope === 'book' && ch && g.pages.length > 1;
    for (const x of g.pages) {
      const tag = `h${Math.min(6, chapterDepth(ch, byId) + 2)}`;
      if (includePageHeadings) {
        // Ueberschrift ist der Beitragstitel, wo es einen gibt; Dachzeile darueber,
        // Lead darunter (lib/headline-render.js).
        parts.push(headline.kickerHtml(x.p));
        parts.push(`<${tag}>${escXml(headline.pageTitle(x.p))}</${tag}>`);
        parts.push(headline.leadHtml(x.p));
      } else if (headline.needsOwnHead(x.p)) {
        // Hier schreibt der Builder sonst keine Seitenueberschrift — ein Beitrag
        // mit eigener Schlagzeile bekommt sie trotzdem, sonst faellt sie weg.
        parts.push(headline.headHtml(x.p, { titleTag: tag }));
      }
      parts.push(x.pd.html || '');
    }
    // Anmerkungen ans Kapitelende, vor das naechste Kapitel.
    if (g.notes && g.notes.length) {
      parts.push('<section class="endnotes">');
      parts.push(`<h3>${escXml(notesTitleFor(bib))}</h3>`);
      parts.push(endnoteItemHtml(g.notes));
      parts.push('</section>');
    }
  }
  // Abbildungs- und Tabellenverzeichnis. Sichtbarkeitsregel wie beim
  // Quellenverzeichnis: nur beim ganzen Buch — ein einzelnes Kapitel ist keine
  // Publikation mit eigenem Apparat. Leer, wenn die Nummerierung des Typs im
  // Buch aus ist (dann gibt es keine Nummern, auf die man zeigen koennte).
  if (showBibliography) {
    for (const kind of ['figure', 'table']) {
      const dir = directoryHtml(xrefCtx, kind, { lang: xrefCtx.lang, headingLevel: 2 });
      if (dir) parts.push(dir);
    }
  }
  if (showBibliography) {
    parts.push('<section class="bibliography">');
    parts.push(`<h2>${escXml(bib.title)}</h2>`);
    parts.push(bibliographyItemHtml(bib));
    parts.push('</section>');
  }
  parts.push('</body></html>');
  return Buffer.from(parts.join('\n'), 'utf8');
}

module.exports = { buildHtml };
