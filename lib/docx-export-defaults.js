'use strict';
// Default-Config für neue Word-Export-Profile + Schema-Validator. Pendant zu
// lib/pdf-export-defaults.js, aber schlanker: Word ist ein reflowbares Format
// (kein Druck/Cover/PDF-A). Die Titelei-Texte (Titel/Untertitel/Autor/Widmung/
// Impressum/Copyright/Frontmatter/Bio/ISBN/Jahr) kommen buch-weit aus
// book_publication (SSoT, geteilt mit PDF + EPUB) — das Profil hält nur Layout/
// Typografie/Struktur + Toggles, welche Titelei-Bausteine eingebunden werden.
//
// Strikte Validierung: unbekannte Top-Level-Keys werden verworfen, Werte gegen
// Allow-Lists/Ranges geklemmt (sauber bei manueller JSON-Bearbeitung).

// Schriftfamilien-Whitelist: gängige, in Word/LibreOffice vorhandene System-
// fonts (kein Embedding — DOCX referenziert den Font, der Empfänger hat ihn).
const FONT_FAMILIES = [
  'Times New Roman', 'Calibri', 'Courier New', 'Georgia',
  'Arial', 'Garamond', 'Cambria', 'Book Antiqua', 'Palatino Linotype',
];
const PAGE_SIZES     = ['A4', 'A5', 'Letter'];
const LINE_SPACING   = ['single', 'oneAndHalf', 'double'];
const PARAGRAPH_STYLE = ['indent', 'spaced'];
const HEADER_MODE    = ['none', 'title', 'manuscript'];
const PAGE_NUMBER    = ['none', 'footer', 'headerRight'];
const TITLE_MODE     = ['generated', 'none'];
const IMPRINT_POS    = ['front', 'back'];
const TOC_MODE       = ['none', 'field', 'static'];
const TOC_DEPTH      = [1, 2, 3];
const NUMBERING      = ['none', 'arabic', 'roman', 'word'];
const NUMBERING_MODE = ['flat', 'nested'];
const PAGE_STRUCTURE = ['flatten', 'nested'];
const SCENE_SEP      = ['line', 'asterism', 'stars', 'blank'];

const DEFAULT_CONFIG = {
  page: {
    size: 'A4',
    marginsMm: { top: 25, right: 25, bottom: 25, left: 25 },
  },
  font: {
    family: 'Times New Roman',
    sizePt: 12,
    lineSpacing: 'double',          // Einreich-Manuskript-Konvention
    paragraphStyle: 'indent',       // Belletristik: Erstzeilen-Einzug; 'spaced' = Leerzeile (Sachbuch)
    indentMm: 12.7,                 // ~0.5in, klassischer Manuskript-Einzug
    justify: false,                 // Manuskript: linksbündig (flatterrechts), kein Blocksatz
  },
  header: {
    mode: 'manuscript',             // 'none' | 'title' (Buchtitel) | 'manuscript' (Nachname / TITEL)
    pageNumber: 'headerRight',      // 'none' | 'footer' (zentriert) | 'headerRight' (Shunn)
    skipFirstPage: true,            // Kopf-/Fusszeile nicht auf der Titelseite
  },
  title: {
    mode: 'generated',              // generierte Titelseite aus book_publication
    wordCount: true,                // ungefähre Wortzahl (auf 100 gerundet) auf der Titelseite
  },
  // Welche book_publication-Bausteine eingebunden werden. Inhalt kommt aus der
  // Publikations-Tabelle; hier nur die Inklusions-Toggles + Impressum-Position.
  frontmatter: {
    dedication: false,
    imprint: false,
    copyright: false,
    frontMatter: false,
    authorBio: false,
    imprintPosition: 'front',       // 'front' = nach Titelseite, 'back' = ans Buchende
  },
  // field = echtes Word-Inhaltsverzeichnis-Feld (aktualisiert sich in Word via
  // F9 / "Felder aktualisieren"); static = ausgeschriebene Liste ohne Feld.
  // depth zaehlt ausschliesslich KAPITELEBENEN (1..3). Seiten haengen an einer
  // eigenen Achse (includePages) — sonst wuerde eine Seite in einem
  // Sub-Sub-Kapitel (Ebene 4) von jeder erlaubten Kapiteltiefe mitgeschnitten.
  // Gleiche Aufteilung wie im PDF (lib/pdf-export-defaults.js).
  toc: {
    mode: 'none',
    depth: 3,
    // Seiten als eigene Verzeichnis-Ebene unter ihrem Kapitel. Greift nur bei
    // chapter.pageStructure='nested' — nur dann traegt eine Seite ueberhaupt eine
    // Ueberschrift, an die ein Verzeichnis-Eintrag anknuepfen kann.
    includePages: true,
  },
  chapter: {
    numbering: 'none',
    numberingMode: 'nested',        // 'flat' = 1, 2, 3; 'nested' = 1, 1.1, 1.1.1
    unnumberedChapterIds: [],       // Vorwort/Prolog/Epilog ohne Nummer (Cascade auf Sub-Kapitel)
    pageBreakBefore: true,          // Seitenumbruch vor jedem Top-Kapitel
    // Sub-Kapitel beginnen wie Top-Kapitel auf einer neuen Seite (Pendant zum
    // PDF). Sonst haelt die Zusage „jede Seite beginnt neu" in einer Hierarchie
    // nicht: die ERSTE Seite eines Sub-Kapitels folgt seiner Ueberschrift, und
    // die stuende inline unter dem Text der vorigen Seite.
    breakBeforeSubchapter: true,
    // Die Seite ist ein Strukturelement, kein beliebiger Textbrocken: eigene
    // Ueberschrift (Word-Heading-4, vierte Stufe unter den drei Kapitelebenen),
    // eigener Seitenumbruch, eigener Verzeichnis-Eintrag. 'flatten' bleibt fuer
    // Werke, deren Seiten reine Fliesstext-Portionen sind.
    pageStructure: 'nested',        // 'flatten' = Seiten ohne eigene Überschrift; 'nested' = Heading-4 pro Seite
    pageBreakBetweenPages: true,    // Seitenumbruch vor jeder weiteren Seite im Kapitel (nur bei 'nested')
    sceneSeparator: 'line',         // klassenlose <hr> → 'line' | 'asterism' (✻) | 'stars' (* * *) | 'blank'
  },
};

function _isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function _num(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}
function _str(v, max = 200) { return typeof v === 'string' ? v.slice(0, max) : ''; }
function _enum(v, allowed, fallback) { return allowed.includes(v) ? v : fallback; }
function _bool(v, fallback) { return typeof v === 'boolean' ? v : fallback; }

function _validateIdList(src) {
  if (!Array.isArray(src)) return [];
  const out = [];
  const seen = new Set();
  for (const v of src) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n <= 0 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= 500) break;
  }
  return out;
}

function _validatePage(src) {
  const d = DEFAULT_CONFIG.page;
  if (!_isObj(src)) return structuredClone(d);
  const m = _isObj(src.marginsMm) ? src.marginsMm : d.marginsMm;
  return {
    size: _enum(src.size, PAGE_SIZES, d.size),
    marginsMm: {
      top:    _num(m.top,    5, 80, d.marginsMm.top),
      right:  _num(m.right,  5, 80, d.marginsMm.right),
      bottom: _num(m.bottom, 5, 80, d.marginsMm.bottom),
      left:   _num(m.left,   5, 80, d.marginsMm.left),
    },
  };
}

function _validateFont(src) {
  const d = DEFAULT_CONFIG.font;
  if (!_isObj(src)) return { ...d };
  return {
    family:         _enum(src.family, FONT_FAMILIES, d.family),
    sizePt:         _num(src.sizePt, 8, 18, d.sizePt),
    lineSpacing:    _enum(src.lineSpacing, LINE_SPACING, d.lineSpacing),
    paragraphStyle: _enum(src.paragraphStyle, PARAGRAPH_STYLE, d.paragraphStyle),
    indentMm:       _num(src.indentMm, 0, 30, d.indentMm),
    justify:        _bool(src.justify, d.justify),
  };
}

function _validateHeader(src) {
  const d = DEFAULT_CONFIG.header;
  if (!_isObj(src)) return { ...d };
  return {
    mode:          _enum(src.mode, HEADER_MODE, d.mode),
    pageNumber:    _enum(src.pageNumber, PAGE_NUMBER, d.pageNumber),
    skipFirstPage: _bool(src.skipFirstPage, d.skipFirstPage),
  };
}

function _validateTitle(src) {
  const d = DEFAULT_CONFIG.title;
  if (!_isObj(src)) return { ...d };
  return {
    mode:      _enum(src.mode, TITLE_MODE, d.mode),
    wordCount: _bool(src.wordCount, d.wordCount),
  };
}

function _validateFrontmatter(src) {
  const d = DEFAULT_CONFIG.frontmatter;
  if (!_isObj(src)) return { ...d };
  return {
    dedication:      _bool(src.dedication, d.dedication),
    imprint:         _bool(src.imprint, d.imprint),
    copyright:       _bool(src.copyright, d.copyright),
    frontMatter:     _bool(src.frontMatter, d.frontMatter),
    authorBio:       _bool(src.authorBio, d.authorBio),
    imprintPosition: _enum(src.imprintPosition, IMPRINT_POS, d.imprintPosition),
  };
}

function _validateToc(src) {
  const d = DEFAULT_CONFIG.toc;
  if (!_isObj(src)) return { ...d };
  return {
    mode:  _enum(src.mode, TOC_MODE, d.mode),
    depth: _enum(parseInt(src.depth), TOC_DEPTH, d.depth),
    includePages: _bool(src.includePages, d.includePages),
  };
}

function _validateChapter(src) {
  const d = DEFAULT_CONFIG.chapter;
  if (!_isObj(src)) return { ...d, unnumberedChapterIds: [] };
  return {
    numbering:            _enum(src.numbering, NUMBERING, d.numbering),
    numberingMode:        _enum(src.numberingMode, NUMBERING_MODE, d.numberingMode),
    unnumberedChapterIds: _validateIdList(src.unnumberedChapterIds),
    pageBreakBefore:      _bool(src.pageBreakBefore, d.pageBreakBefore),
    breakBeforeSubchapter: _bool(src.breakBeforeSubchapter, d.breakBeforeSubchapter),
    pageStructure:        _enum(src.pageStructure, PAGE_STRUCTURE, d.pageStructure),
    pageBreakBetweenPages: _bool(src.pageBreakBetweenPages, d.pageBreakBetweenPages),
    sceneSeparator:       _enum(src.sceneSeparator, SCENE_SEP, d.sceneSeparator),
  };
}

/** Tiefe Validierung gegen Defaults. Unbekannte Keys werden verworfen. */
function validateConfig(src) {
  const s = _isObj(src) ? src : {};
  return {
    page:        _validatePage(s.page),
    font:        _validateFont(s.font),
    header:      _validateHeader(s.header),
    title:       _validateTitle(s.title),
    frontmatter: _validateFrontmatter(s.frontmatter),
    toc:         _validateToc(s.toc),
    chapter:     _validateChapter(s.chapter),
  };
}

function defaultConfig() { return structuredClone(DEFAULT_CONFIG); }

module.exports = { DEFAULT_CONFIG, validateConfig, defaultConfig, FONT_FAMILIES };
