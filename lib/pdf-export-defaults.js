'use strict';
// Default-Config für neue PDF-Export-Profile + Schema-Validator. Wird bei
// Profile-Erstellung als Vorlage gemerged und beim Speichern strikt geprüft —
// unbekannte Top-Level-Keys werden verworfen, Werte gegen Allow-Lists/Ranges
// gevalidiert. So bleiben User-Inputs sauber bei manueller JSON-Bearbeitung.

const PAGE_SIZES = ['A4', 'A5', 'A6', 'Letter', 'custom'];
const COLUMNS    = [1, 2];
const BREAK_BEFORE = ['always', 'right-page', 'none'];
const NUMBERING    = ['none', 'arabic', 'roman', 'word'];
const TITLE_STYLE  = ['centered-large', 'left-rule', 'minimal'];
const PAGE_STRUCTURE = ['flatten', 'nested'];
const COVER_FIT    = ['cover', 'contain'];
const OVERLAY_POS  = ['top', 'center', 'bottom'];
const TOC_DEPTH    = [1, 2];
const PDFA_CONF    = ['B'];

const DEFAULT_CONFIG = {
  layout: {
    pageSize: 'A4',
    customWidthMm: 210,
    customHeightMm: 297,
    marginsMm: { top: 25, right: 22, bottom: 25, left: 22 },
    columns: 1,
    columnGapMm: 6,
    headerLeft: '', headerCenter: '{title}', headerRight: '',
    footerLeft: '', footerCenter: '{page}',  footerRight: '',
    showHeaderOnChapterStart: false,
    pageNumberStart: 1,
  },
  font: {
    body:     { family: 'Lora',             weight: 400, sizePt: 11, lineHeight: 1.45 },
    heading:  { family: 'Playfair Display', weight: 700, sizes: { h1: 24, h2: 18, h3: 14 } },
    title:    { family: 'Playfair Display', weight: 700, sizePt: 38 },
    subtitle: { family: 'Playfair Display', weight: 400, sizePt: 18 },
    byline:   { family: 'Lora',             weight: 400, sizePt: 12 },
  },
  chapter: {
    breakBefore: 'always',
    blankPageAfter: false,
    numbering: 'none',
    titleStyle: 'centered-large',
    dropCap: false,
    spaceBeforeMm: 60,
    pageStructure: 'flatten',
    pageBreakBetweenPages: false,
  },
  cover: {
    enabled: false,
    showTitleOverlay: true,
    overlayPosition: 'bottom',
    fit: 'cover',
  },
  toc: { enabled: true, depth: 2, title: 'Inhalt' },
  extras: { dedication: '', imprint: '', subtitle: '', year: '' },
  pdfa: { enabled: true, conformance: 'B' },
};

function _isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function _num(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}
function _str(v, max = 200) {
  if (typeof v !== 'string') return '';
  return v.slice(0, max);
}
function _enum(v, allowed, fallback) {
  return allowed.includes(v) ? v : fallback;
}
function _bool(v, fallback) {
  if (typeof v === 'boolean') return v;
  return fallback;
}

function _validateLayout(src) {
  const d = DEFAULT_CONFIG.layout;
  if (!_isObj(src)) return { ...d };
  const m = _isObj(src.marginsMm) ? src.marginsMm : d.marginsMm;
  return {
    pageSize:        _enum(src.pageSize, PAGE_SIZES, d.pageSize),
    customWidthMm:   _num(src.customWidthMm, 50, 500, d.customWidthMm),
    customHeightMm:  _num(src.customHeightMm, 50, 700, d.customHeightMm),
    marginsMm: {
      top:    _num(m.top,    5, 80, d.marginsMm.top),
      right:  _num(m.right,  5, 80, d.marginsMm.right),
      bottom: _num(m.bottom, 5, 80, d.marginsMm.bottom),
      left:   _num(m.left,   5, 80, d.marginsMm.left),
    },
    columns:    _enum(parseInt(src.columns), COLUMNS, d.columns),
    columnGapMm: _num(src.columnGapMm, 0, 30, d.columnGapMm),
    headerLeft:   _str(src.headerLeft,   200),
    headerCenter: _str(src.headerCenter, 200),
    headerRight:  _str(src.headerRight,  200),
    footerLeft:   _str(src.footerLeft,   200),
    footerCenter: _str(src.footerCenter, 200),
    footerRight:  _str(src.footerRight,  200),
    showHeaderOnChapterStart: _bool(src.showHeaderOnChapterStart, d.showHeaderOnChapterStart),
    pageNumberStart: _num(src.pageNumberStart, 1, 9999, d.pageNumberStart),
  };
}

function _validateFontRole(src, defs) {
  if (!_isObj(src)) return { ...defs };
  return {
    family:     _str(src.family, 80) || defs.family,
    weight:     _num(src.weight, 100, 900, defs.weight),
    sizePt:     _num(src.sizePt, 6, 72, defs.sizePt),
    ...(defs.lineHeight !== undefined ? { lineHeight: _num(src.lineHeight, 0.8, 3, defs.lineHeight) } : {}),
  };
}

function _validateFont(src) {
  const d = DEFAULT_CONFIG.font;
  if (!_isObj(src)) return JSON.parse(JSON.stringify(d));
  const heading = _isObj(src.heading) ? src.heading : {};
  const headingSizes = _isObj(heading.sizes) ? heading.sizes : {};
  return {
    body:     _validateFontRole(src.body,     d.body),
    heading: {
      family: _str(heading.family, 80) || d.heading.family,
      weight: _num(heading.weight, 100, 900, d.heading.weight),
      sizes: {
        h1: _num(headingSizes.h1, 10, 60, d.heading.sizes.h1),
        h2: _num(headingSizes.h2,  9, 48, d.heading.sizes.h2),
        h3: _num(headingSizes.h3,  8, 36, d.heading.sizes.h3),
      },
    },
    title:    _validateFontRole(src.title,    d.title),
    subtitle: _validateFontRole(src.subtitle, d.subtitle),
    byline:   _validateFontRole(src.byline,   d.byline),
  };
}

function _validateChapter(src) {
  const d = DEFAULT_CONFIG.chapter;
  if (!_isObj(src)) return { ...d };
  return {
    breakBefore:    _enum(src.breakBefore, BREAK_BEFORE, d.breakBefore),
    blankPageAfter: _bool(src.blankPageAfter, d.blankPageAfter),
    numbering:      _enum(src.numbering, NUMBERING, d.numbering),
    titleStyle:     _enum(src.titleStyle, TITLE_STYLE, d.titleStyle),
    dropCap:        _bool(src.dropCap, d.dropCap),
    spaceBeforeMm:  _num(src.spaceBeforeMm, 0, 200, d.spaceBeforeMm),
    pageStructure:  _enum(src.pageStructure, PAGE_STRUCTURE, d.pageStructure),
    pageBreakBetweenPages: _bool(src.pageBreakBetweenPages, d.pageBreakBetweenPages),
  };
}

function _validateCover(src) {
  const d = DEFAULT_CONFIG.cover;
  if (!_isObj(src)) return { ...d };
  return {
    enabled:          _bool(src.enabled, d.enabled),
    showTitleOverlay: _bool(src.showTitleOverlay, d.showTitleOverlay),
    overlayPosition:  _enum(src.overlayPosition, OVERLAY_POS, d.overlayPosition),
    fit:              _enum(src.fit, COVER_FIT, d.fit),
  };
}

function _validateToc(src) {
  const d = DEFAULT_CONFIG.toc;
  if (!_isObj(src)) return { ...d };
  return {
    enabled: _bool(src.enabled, d.enabled),
    depth:   _enum(parseInt(src.depth), TOC_DEPTH, d.depth),
    title:   _str(src.title, 80) || d.title,
  };
}

function _validateExtras(src) {
  const d = DEFAULT_CONFIG.extras;
  if (!_isObj(src)) return { ...d };
  return {
    dedication: _str(src.dedication, 1000),
    imprint:    _str(src.imprint, 4000),
    subtitle:   _str(src.subtitle, 200),
    year:       _str(src.year, 20),
  };
}

function _validatePdfa(src) {
  const d = DEFAULT_CONFIG.pdfa;
  if (!_isObj(src)) return { ...d };
  return {
    enabled:     _bool(src.enabled, d.enabled),
    conformance: _enum(src.conformance, PDFA_CONF, d.conformance),
  };
}

/** Tiefe Validierung gegen Defaults. Unbekannte Keys werden verworfen. */
function validateConfig(src) {
  const s = _isObj(src) ? src : {};
  return {
    layout:  _validateLayout(s.layout),
    font:    _validateFont(s.font),
    chapter: _validateChapter(s.chapter),
    cover:   _validateCover(s.cover),
    toc:     _validateToc(s.toc),
    extras:  _validateExtras(s.extras),
    pdfa:    _validatePdfa(s.pdfa),
  };
}

function defaultConfig() {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

module.exports = { DEFAULT_CONFIG, validateConfig, defaultConfig };
