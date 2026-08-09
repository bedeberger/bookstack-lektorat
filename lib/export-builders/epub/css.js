'use strict';
// EPUB-Stylesheet: statisches Grundgeruest + die reflow-/typografie-abhaengigen
// Regeln aus den Publikations-Optionen. Einziger Konsument ist ./build.js.

const headline = require('../../headline-render');

// Statisches CSS-Grundgeruest (Titelei/Backmatter/Umbruch-Marker). Die
// reflow-/typografie-abhaengigen Regeln baut _buildCss(meta) dynamisch dazu.
// Ein eigenes `css`-Feld ersetzt das epub-gen-memory-Default-Stylesheet
// vollstaendig — darum die Lib-Defaults (Author/TOC/hr) hier mitfuehren.
const EPUB_CSS_BASE = `.epub-author { color: #555; }
.epub-link { margin-bottom: 30px; }
.epub-link a { color: #666; font-size: 90%; }
.toc-author { font-size: 90%; color: #555; }
.toc-link { color: #999; font-size: 85%; display: block; }
blockquote { margin: 1em 2em; }
/* Belegtes Blockzitat (<blockquote data-src>, Markup-SSoT
   public/js/sources/cite-html.js): woertliches Zitat — kleiner und aufrecht, die
   Einrueckung traegt die Auszeichnung. text-indent muss hier explizit auf 0,
   weil der Erstzeilen-Einzug des Profils sonst in den Zitatabsatz durchschlaegt.
   Der Selektor greift auf die KLASSE, nicht auf data-src: die epub-Lib filtert
   data-*-Attribute gegen ihre Allowlist weg (siehe _applyDataClasses, das die
   Klasse dafuer setzt). */
blockquote.cited-quote { font-size: 95%; font-style: normal; }
blockquote.cited-quote p { text-indent: 0; }
li { text-indent: 0; }
/* Tabellen (Markup-SSoT public/js/table/table-html.js). text-indent 0 an der
   Zelle ist Pflicht, nicht Kosmetik: der Erstzeilen-Einzug des Profils schlaegt
   sonst in jede Zelle durch und schiebt den Inhalt aus der Spalte.
   width auto statt 100%: E-Reader-Spalten sind schmal, eine auf volle Breite
   gezwungene Tabelle mit zwei Spalten sieht dort auseinandergerissen aus.
   caption-side bottom, weil die Beschriftung im Buchsatz unter der Tabelle
   steht — die Nummer setzt der Export davor (lib/xref-render.js). */
table { border-collapse: collapse; width: auto; max-width: 100%; margin: 1em 0; font-size: 95%; }
th, td { border: 1px solid #ccc; padding: 0.3em 0.5em; text-align: left; vertical-align: top; text-indent: 0; }
th { font-weight: bold; }
/* Ausrichtung ueber Klassen, nicht ueber data-align: die epub-Lib filtert
   data-*-Attribute weg (siehe _applyDataClasses). */
.ta-center { text-align: center; }
.ta-right { text-align: right; }
caption { caption-side: bottom; text-align: left; font-size: 90%; font-style: italic; color: #555; margin-top: 0.3em; text-indent: 0; }
hr.pagebreak { border: 0; margin: 0; height: 0; page-break-after: always; break-after: page; }
div.blankpage { margin: 0; height: 0; page-break-before: always; page-break-after: always; break-before: page; break-after: page; }
.scene-sep { text-align: center; text-indent: 0; margin: 1.6em 0; color: #555; }
hr.scene-line { border: 0; border-bottom: 1px solid #dedede; margin: 2em 10%; }
hr.scene-blank { border: 0; margin: 2em 0; }
.titlepage { text-align: center; margin-top: 25%; }
.titlepage h1 { font-size: 2.2em; margin: 0 0 0.3em; }
.titlepage .subtitle { font-size: 1.2em; font-style: italic; color: #555; margin: 0 0 2em; }
.titlepage .author { font-size: 1.1em; margin: 0; }
.titlepage .year { color: #777; margin-top: 2em; }
.titlepage p { text-indent: 0; }
.dedication { margin-top: 30%; text-align: center; font-style: italic; }
.dedication p { text-indent: 0; }
.imprint { font-size: 0.85em; color: #444; }
.imprint p { text-indent: 0; margin: 0 0 0.6em; }
.authorpage h2 { margin-bottom: 1em; }
.authorpage img { max-width: 45%; height: auto; display: block; margin: 0 0 1em; }
.cover-page { margin: 0; padding: 0; text-align: center; page-break-after: always; break-after: page; }
.cover-page svg { width: 100%; height: 100%; }
.cover-page img { max-width: 100%; height: auto; }
.epub-chapter-title--numbered { margin: 2.4em 0 2.2em; line-height: 1.3; }
.epub-chapter-title--numbered .epub-chapter-num { display: block; font-size: 0.62em; font-weight: normal; letter-spacing: 0.12em; color: #555; margin: 0 0 0.9em; }
.epub-chapter-title--numbered .epub-chapter-rule { display: block; font-size: 0.5em; font-weight: normal; letter-spacing: 0.3em; color: #999; margin: 0 0 0.9em; }
.epub-chapter-title--numbered .epub-chapter-name { display: block; }
.epub-chapter-head--ts-centered-large > h1 { text-align: center; }
.epub-chapter-head--ts-left-rule > h1 { text-align: left; }
.epub-chapter-head--ts-minimal > h1 { text-align: left; font-size: 1.5em; }
.epub-title-rule { border: 0; border-bottom: 2px solid currentColor; width: 2.4em; margin: 0.2em 0 1.4em; opacity: 0.45; }
.epub-chapter-head--ts-centered-large .epub-title-rule { margin-left: auto; margin-right: auto; }
hr.epub-page-rule { border: 0; border-bottom: 1px solid #dedede; margin: 0.3em 0 1em; }
.cover-page--cover img { object-fit: cover; width: 100%; height: 100%; }
.extra-section h2 { margin-bottom: 1em; }
.extra-section p { text-indent: 0; }
.extra-section .cta { text-align: center; margin: 1.6em 0; }`;

// Schriftfamilien-Stacks fuer epub_css_style — generische + verbreitete Familien
// (kein Embedding, Reader nutzt sie wenn vorhanden, sonst der Stack-Fallback).
const FONT_STACKS = {
  serif: 'serif',
  sans: 'sans-serif',
  georgia: 'Georgia, "Times New Roman", serif',
  palatino: '"Palatino Linotype", Palatino, "Book Antiqua", serif',
  garamond: '"EB Garamond", Garamond, Georgia, serif',
  times: '"Times New Roman", Times, serif',
  baskerville: '"Libre Baskerville", Baskerville, Georgia, serif',
  helvetica: 'Helvetica, Arial, sans-serif',
  verdana: 'Verdana, Geneva, sans-serif',
};

const _FONT_SIZE = { small: '0.9em', normal: '1em', large: '1.15em' };
const _LINE_HEIGHT = { tight: '1.3', normal: '1.45', relaxed: '1.7' };
const _INDENT = { small: '1em', medium: '1.5em', large: '2.5em' };
// Heading-Groessenskala (epub_heading_scale). 'normal' → kein Override (Reader-
// Default ~2/1.5/1.17em). Pendant zu font.heading.sizes (PDF), aber grob.
const _HEADING_SCALE = {
  small: { h1: '1.6em', h2: '1.3em', h3: '1.1em' },
  large: { h1: '2.6em', h2: '1.9em', h3: '1.4em' },
};

// Vollstaendiges Stylesheet aus Basis + reflow-/typografie-Optionen der Meta.
function _buildCss(meta) {
  const m = meta || {};
  const fontFamily = FONT_STACKS[m.epub_css_style] || FONT_STACKS.serif;
  const fontSize = _FONT_SIZE[m.epub_font_size] || _FONT_SIZE.normal;
  const lineHeight = _LINE_HEIGHT[m.epub_line_height] || _LINE_HEIGHT.normal;
  const spaced = m.epub_paragraph_style === 'spaced';
  const indent = _INDENT[m.epub_indent_size] || _INDENT.medium;

  let css = EPUB_CSS_BASE;
  css += `\nbody { font-family: ${fontFamily}; font-size: ${fontSize}; }`;
  if (spaced) {
    // Sachbuch-Satz: Absatzabstand statt Erstzeilen-Einzug.
    css += `\np { margin: 0 0 0.8em; text-indent: 0; line-height: ${lineHeight}; }`;
  } else {
    // Belletristik-Satz: Erstzeilen-Einzug, kein Absatzabstand. Erster Absatz
    // nach Ueberschrift/Trenner ohne Einzug.
    css += `\np { margin: 0; text-indent: ${indent}; line-height: ${lineHeight}; }`;
    css += `\np:first-of-type, h1 + p, h2 + p, h3 + p, h4 + p, h5 + p, h6 + p,`;
    css += `\nblockquote + p, hr + p, figure + p, .scene-sep + p, .scene-gap + p { text-indent: 0; }`;
    // Leerzeile als Szenentrenner: eine sichtbare Leerzeile, Folgeabsatz ohne Einzug.
    css += `\n.scene-gap { text-indent: 0; margin: 0; }`;
  }
  if (m.epub_justify !== false) css += `\np { text-align: justify; }`;
  if (m.epub_hyphenation) css += `\np { -webkit-hyphens: auto; -epub-hyphens: auto; hyphens: auto; }`;
  if (m.epub_chapter_pagebreak) css += `\n.epub-chapter-head--top { page-break-before: always; break-before: page; }`;
  if (m.epub_subchapter_pagebreak) css += `\n.epub-chapter-head--sub { page-break-before: always; break-before: page; }`;
  if (m.epub_drop_caps) {
    css += `\nh1 + p::first-letter, h2 + p::first-letter {`
      + ` float: left; font-size: 3.2em; line-height: 0.8; padding: 0.05em 0.08em 0 0; font-weight: bold; }`;
  }
  // Separater Heading-Font (epub_heading_font) — 'match' laesst die Ueberschriften
  // den Fliesstext-Font erben (Default, kein Drift). Sonst eigener Stack.
  if (m.epub_heading_font && m.epub_heading_font !== 'match') {
    const hf = FONT_STACKS[m.epub_heading_font] || fontFamily;
    css += `\nh1, h2, h3, h4, h5, h6, .epub-chapter-title { font-family: ${hf}; }`;
  }
  // Heading-Groessenskala (epub_heading_scale) — 'normal' = Reader-Default (kein
  // Override). small/large skalieren h1/h2/h3 proportional; die gestapelte
  // numerierte Ueberschrift erbt ueber ihre relativen em-Groessen mit.
  const hs = _HEADING_SCALE[m.epub_heading_scale];
  if (hs) css += `\nh1 { font-size: ${hs.h1}; }\nh2 { font-size: ${hs.h2}; }\nh3 { font-size: ${hs.h3}; }`;
  // Ziffernstil (epub_numerals) — oldstyle/lining via font-variant-numeric.
  // 'default' laesst die Reader-Font entscheiden. Wirkt nur, wenn die Font das
  // OpenType-Feature mitbringt.
  if (m.epub_numerals === 'oldstyle') css += `\nbody { font-variant-numeric: oldstyle-nums; }`;
  else if (m.epub_numerals === 'lining') css += `\nbody { font-variant-numeric: lining-nums; }`;
  // Quellenverzeichnis: haengender Einzug (Urheber bzw. die [n]-Spalte des
  // numerischen Stils bleiben links stehen), kein Blocksatz und kein
  // Erstzeilen-Einzug — ein Verzeichnis ist keine Prosa. Steht bewusst als
  // LETZTES: die Belletristik-Regeln oben setzen `p { text-indent }` global, und
  // hier soll die Verzeichnis-Form gewinnen.
  css += `\n.bibliography p { margin: 0 0 0.5em 1.5em; text-indent: -1.5em; text-align: left; }`;
  // Anmerkungsapparat: wie das Verzeichnis gesetzt, nur kleiner — er steht
  // mehrfach im Buch und soll den Kapitelfluss nicht dominieren.
  css += `\n.endnotes { font-size: 0.9em; }`;
  css += `\n.endnotes p { margin: 0 0 0.4em 1.5em; text-indent: -1.5em; text-align: left; }`;
  // Titel-Kopf eines Beitrags (lib/headline-render.js). Wie das Verzeichnis am
  // Ende, damit die globale `p { text-indent }`-Regel der Belletristik-Vorgaben
  // ihn nicht einrueckt — Dachzeile und Lead sind kein Fliesstext.
  css += `\n.${headline.KICKER_CLASS} { margin: 0 0 0.2em; text-indent: 0; text-align: left; font-size: 0.8em; letter-spacing: 0.08em; text-transform: uppercase; }`;
  css += `\n.${headline.KICKER_CLASS} strong { font-weight: 600; }`;
  css += `\n.${headline.LEAD_CLASS} { margin: 0.3em 0 1.2em; text-indent: 0; text-align: left; font-size: 1.05em; }`;
  css += `\n.${headline.LEAD_CLASS} em { font-style: normal; font-weight: 500; }`;
  return css;
}

module.exports = { EPUB_CSS_BASE, FONT_STACKS, _buildCss };
