// Quote-Styles je Buch-Locale + die Zeichenklassen, die Klassifikation und
// Walk gemeinsam benutzen.

// Als Escape, nicht als Literal — ein unsichtbares NBSP in der Quelle
// überlebt Copy-Paste und Editor-Trimming nicht zuverlässig.
const NB = '\u00a0';

const STYLES = {
  // Schweiz / Liechtenstein: Guillemets aussen, Single-Guillemets innen
  'de-CH': { ldquo: '«', rdquo: '»', lsquo: '‹', rsquo: '›', apostrophe: '’' },
  'de-LI': { ldquo: '«', rdquo: '»', lsquo: '‹', rsquo: '›', apostrophe: '’' },
  // Deutschland / Österreich: „…“ aussen, ‚…‘ innen
  'de-DE': { ldquo: '„', rdquo: '“', lsquo: '‚', rsquo: '‘', apostrophe: '’' },
  'de-AT': { ldquo: '„', rdquo: '“', lsquo: '‚', rsquo: '‘', apostrophe: '’' },
  // English modern (en-US: Chicago/AP/MLA; en-GB: Oxford 2014+/Cambridge/Guardian/
  // BBC): outer double curly, inner single curly. Apostroph U+2019.
  'en':    { ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', apostrophe: '’', lang: 'en' },
  'en-US': { ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', apostrophe: '’', lang: 'en' },
  'en-GB': { ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', apostrophe: '’', lang: 'en' },
  // Französisch: « … », ‹ … ›  (NBSP U+00A0 innen — schmal-fest, kein Umbruch)
  'fr':    { ldquo: '«'+NB, rdquo: NB+'»', lsquo: '‹'+NB, rsquo: NB+'›', apostrophe: '’' },
  // Italienisch (Italien): «…» aussen, “…” innen
  'it-IT': { ldquo: '«', rdquo: '»', lsquo: '“', rsquo: '”', apostrophe: '’' },
};

const DEFAULT_STYLE = STYLES['de-CH'];

export function resolveQuoteStyle(language, region) {
  const l = (language || '').toLowerCase();
  const r = (region || '').toUpperCase();
  if (l && r) {
    const tag = `${l}-${r}`;
    if (STYLES[tag]) return STYLES[tag];
  }
  if (l && STYLES[l]) return STYLES[l];
  if (l === 'it') return STYLES['it-IT'];
  return DEFAULT_STYLE;
}

export function isEnglish(style) {
  return !!(style && style.lang === 'en');
}

// Regulärer Space + NBSP zählen als Innen-Abstand.
export const SPACES = new Set([' ', NB]);

export const LETTER_DIGIT = /[\p{L}\p{N}]/u;

// Satzende — steht innerhalb der Rede direkt vor dem Schliesser (`Wohnung?»`).
export const END_PUNCT = /[.!?…]/;
// Darf einem Schliesser folgen (`»,` `».` `»)`).
export const CLOSE_PUNCT = /[,.;:!?)\]}»›”’]/;
// Darf einem Öffner vorangehen (Klammer, Gedankenstrich, anderes offenes Quote).
export const OPEN_PUNCT = /[([{\-–—/«„“‹‚‘]/;
// Redeeinleitung vor dem Öffner (`sagte: «` / `so, «`).
export const INTRO_PUNCT = /[,:;]/;

const DOUBLE_GLYPHS = new Set(['"', '„', '“', '”', '«', '»']);
const SINGLE_GLYPHS = new Set(["'", '‚', '‘', '’', '‹', '›']);

export function isDoubleQuote(c) { return DOUBLE_GLYPHS.has(c); }
export function isSingleQuote(c) { return SINGLE_GLYPHS.has(c); }
export function isQuoteGlyph(c) { return DOUBLE_GLYPHS.has(c) || SINGLE_GLYPHS.has(c); }

export { STYLES, DEFAULT_STYLE };
