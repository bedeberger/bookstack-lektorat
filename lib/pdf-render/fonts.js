'use strict';
// Font-Bootstrapping + PDF/A-Glyph-Sanitizer. Lädt alle Rollen-Fonts (body,
// heading, title, subtitle, byline) inkl. Body-Bold/Italic-Variants und patcht
// doc.text, damit ungültige Codepoints (PDF/A-2 verbietet .notdef-Verweise)
// vor jedem Write gefiltert werden.

const { fetchFont } = require('../font-fetch');
const logger = require('../../logger');

// Lädt + registriert alle benötigten Font-Variants. Pdfkit erwartet einen
// eindeutigen Namen pro Variant. Body-Font wird zusätzlich in italic + bold
// vorgeladen (für strong/em im Fließtext).
async function _registerFonts(doc, font) {
  const tasks = [];
  const reg = (key, family, weight, style) => {
    tasks.push((async () => {
      const ttf = await fetchFont(family, weight, style);
      doc.registerFont(key, ttf);
    })());
  };

  // Body-Familie braucht Bold / Italic / BoldItalic für Inline-Style.
  reg('body',           font.body.family, font.body.weight, 'normal');
  // Bold/italic-Variants nur, wenn vom Family-Set unterstützt; sonst fallback
  // auf Body — das `_safeReg` regelt fallthrough.
  const safeReg = (key, family, weight, style) => {
    tasks.push((async () => {
      try {
        const ttf = await fetchFont(family, weight, style);
        doc.registerFont(key, ttf);
      } catch (e) {
        logger.warn(`pdf-render: font ${family} ${weight} ${style} unavailable (${e.message}); fallback registered`);
        // Fallback: dieselbe Font wie Body.
        const ttf = await fetchFont(font.body.family, font.body.weight, 'normal');
        doc.registerFont(key, ttf);
      }
    })());
  };
  // Heuristik für italic/bold-Verfügbarkeit: probieren, fallback in safeReg.
  safeReg('body-bold',        font.body.family, Math.min(900, font.body.weight + 300), 'normal');
  safeReg('body-italic',      font.body.family, font.body.weight, 'italic');
  safeReg('body-bolditalic',  font.body.family, Math.min(900, font.body.weight + 300), 'italic');

  reg('heading',  font.heading.family,  font.heading.weight,  'normal');
  reg('title',    font.title.family,    font.title.weight,    'normal');
  reg('subtitle', font.subtitle.family, font.subtitle.weight, 'normal');
  reg('byline',   font.byline.family,   font.byline.weight,   'normal');
  safeReg('dedication', font.dedication.family, font.dedication.weight, font.dedication.italic ? 'italic' : 'normal');
  // frontMatter/authorBio sind neuere Rollen; aeltere, nicht neu-gespeicherte
  // Profile haben sie evtl. nicht im config_json → Fallback auf dedication/body.
  const fmCfg = font.frontMatter || font.dedication;
  const abCfg = font.authorBio || font.body;
  safeReg('frontMatter', fmCfg.family, fmCfg.weight, fmCfg.italic ? 'italic' : 'normal');
  safeReg('authorBio',   abCfg.family, abCfg.weight, abCfg.italic ? 'italic' : 'normal');
  safeReg('imprint',    font.imprint.family,    font.imprint.weight,    font.imprint.italic ? 'italic' : 'normal');
  safeReg('year',       font.year.family,       font.year.weight,       font.year.italic ? 'italic' : 'normal');
  safeReg('toc',        font.toc.family,        font.toc.weight,        'normal');
  safeReg('toc-title',  font.tocTitle.family,   font.tocTitle.weight,   'normal');
  // header/footer sind neuere Rollen; ältere Profile ohne die Keys fallen auf
  // die Body-Familie zurück (safeReg regelt zusätzlich fehlende Weights).
  // Kopf-/Fusszeile trägt pro Slot optional bold/italic (siehe layout.hfStyle),
  // darum je Rolle alle vier Variants vorladen — analog zur Body-Familie.
  const hdrCfg = font.header || font.body;
  const ftrCfg = font.footer || font.body;
  // Rollen, deren Text Inline-Auszeichnung tragen kann (Kopf-/Fusszeile via
  // layout.hfStyle, Verzeichniseintraege via <em> im Titel), brauchen alle vier
  // Variants — analog zur Body-Familie. `_runFontKey(run, base)` waehlt daraus.
  const regVariants = (base, cfg) => {
    const ital = cfg.italic ? 'italic' : 'normal';
    safeReg(base,               cfg.family, cfg.weight,                      ital);
    safeReg(`${base}-bold`,     cfg.family, Math.min(900, cfg.weight + 300), ital);
    safeReg(`${base}-italic`,   cfg.family, cfg.weight,                     'italic');
    safeReg(`${base}-bolditalic`, cfg.family, Math.min(900, cfg.weight + 300), 'italic');
  };
  regVariants('header', hdrCfg);
  regVariants('footer', ftrCfg);
  // bibliography ist eine neuere Rolle; Profile ohne den Key fallen auf Body.
  regVariants('bibliography', font.bibliography || font.body);

  await Promise.all(tasks);
}

// PDF/A-2 verbietet Verweise auf das .notdef-Glyph (ISO 19005-2 6.2.11.8).
// Pdfkit emittiert diesen Verweis, sobald ein Codepoint nicht in der Font
// liegt. Wir filtern Strings vor jedem doc.text-Call gegen die aktuell
// aktive Font: bekannte Substitutionen (Soft-Hyphen → drop), NFKD-Fallback
// für Diakritika ohne Glyph (ḿ → m, ń → n), als letztes silent-drop.
const _GLYPH_SUBSTITUTE = new Map();

function _sanitizeAgainstFont(doc, s) {
  if (typeof s !== 'string' || !s) return s;
  const f = doc._font && doc._font.font;
  if (!f || typeof f.glyphForCodePoint !== 'function') return s;
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    // SHY (U+00AD) MUSS bis zur LineWrapper durchkommen — sonst keine
    // Silbentrennung. Verbleibende SHYs nach Wrap entfernt `_patchSoftHyphenStripper`.
    if (cp === 0x00AD) { out += ch; continue; }
    if (cp < 0x80) { out += ch; continue; }
    const g = f.glyphForCodePoint(cp);
    if (g && g.id !== 0) { out += ch; continue; }
    if (_GLYPH_SUBSTITUTE.has(cp)) { out += _GLYPH_SUBSTITUTE.get(cp); continue; }
    // NFKD: Basiszeichen + Combining Marks; Marks droppen, Basis behalten falls vorhanden
    const decomp = ch.normalize('NFKD');
    let any = '';
    for (const dc of decomp) {
      const dcp = dc.codePointAt(0);
      if (dcp >= 0x0300 && dcp <= 0x036F) continue;
      const dg = f.glyphForCodePoint(dcp);
      if (dg && dg.id !== 0) any += dc;
    }
    out += any;
  }
  return out;
}

function _patchDocTextSanitizer(doc) {
  const orig = doc.text.bind(doc);
  doc.text = function patchedText(text, ...rest) {
    if (typeof text === 'string') text = _sanitizeAgainstFont(doc, text);
    return orig(text, ...rest);
  };
}

// Strippt verbleibende Soft-Hyphens VOR dem Encode-Step. pdfkit's LineWrapper
// nutzt SHY als Break-Marker und ersetzt trailing-SHY durch HYPHEN '-' am
// Zeilenumbruch — SHYs innerhalb nicht gebrochener Zeilen würden sonst als
// Codepoint im PDF landen (PDF/A: .notdef-Verstoss bei Fonts ohne SHY-Glyph).
function _patchSoftHyphenStripper(doc) {
  const orig = doc._fragment.bind(doc);
  doc._fragment = function patchedFragment(text, x, y, options) {
    if (typeof text === 'string' && text.indexOf('­') >= 0) text = text.replace(/­/g, '');
    return orig(text, x, y, options);
  };
}

// OpenType-Features für alle doc.text-Calls injizieren. pdfkit reicht
// options.features unverändert an fontkit weiter; fontkit aktiviert ohne
// User-Liste nur die scriptweise Pflicht-Features — `liga`/`clig`/`kern`
// sind im OpenType-Spec „common", aber bei fontkit-Layout via pdfkit nicht
// automatisch an. Ohne diese Injektion fehlen fi/fl-Ligaturen und Kerning.
// Numerale (onum/lnum) sind stilistische Alternativen — wenn Body-Numerale
// 'oldstyle'/'lining', kommt sie in dieselbe globale Liste (Buchweite Wahl).
function _patchOpenTypeFeatures(doc, baseFeatures) {
  if (!Array.isArray(baseFeatures) || baseFeatures.length === 0) return;
  const features = baseFeatures.slice();
  // Für den manuellen Blocksatz-Layouter (justify.js): Messung via
  // widthOfString muss dieselben Features (kern/liga/…) sehen wie der Render,
  // sonst driften Zeilenumbruch + Rand-Justierung. widthOfString erbt die
  // globalen doc.text-Features NICHT automatisch — darum hier deponieren.
  doc._otFeatures = features;
  const orig = doc.text.bind(doc);
  const inject = (opts) => {
    if (!opts) return { features };
    if (Array.isArray(opts.features) && opts.features.length) return opts;
    return { ...opts, features };
  };
  doc.text = function patchedText(text, a, b, c) {
    if (typeof a === 'object' && a !== null) return orig(text, inject(a));
    if (typeof c === 'object' && c !== null) return orig(text, a, b, inject(c));
    if (typeof b === 'object' && b !== null) return orig(text, a, inject(b));
    if (a === undefined && b === undefined && c === undefined) return orig(text, inject(null));
    return orig(text, a, b, inject(null));
  };
}

function _buildFeatureList(fontConfig) {
  const features = ['liga', 'clig', 'kern'];
  const numerals = fontConfig?.body?.numerals;
  if (numerals === 'oldstyle') features.push('onum');
  else if (numerals === 'lining') features.push('lnum');
  return features;
}

// Font-Key eines Inline-Runs. `base` ist die Rollen-Familie, gegen die die vier
// Variants registriert sind (Default 'body'; der Body-Renderer setzt für
// Verzeichniseinträge 'bibliography').
function _runFontKey(run, base = 'body') {
  if (run.bold && run.italic) return `${base}-bolditalic`;
  if (run.bold)   return `${base}-bold`;
  if (run.italic) return `${base}-italic`;
  return base;
}

module.exports = { _registerFonts, _sanitizeAgainstFont, _patchDocTextSanitizer, _patchSoftHyphenStripper, _patchOpenTypeFeatures, _buildFeatureList, _runFontKey };
