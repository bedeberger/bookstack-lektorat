'use strict';
// EPUB-Export via epub-gen-memory. Funktioniert fuer alle Scopes: Buch (Multi-
// Kapitel-Hierarchie), Kapitel (Single-Parent mit Pages als Kinder oder Flach),
// Seite (Einzel-Entry).

const { EPub } = require('epub-gen-memory');
// Fuer das Nachtraegliche Injizieren der Cover-Seite in die fertige ZIP (gleiche
// Lib, die epub-gen-memory intern nutzt).
const JSZip = require('jszip');
// Lib-eigenes EPUB3-OPF-Template zur Laufzeit ziehen (statt kopieren) — bleibt
// driftfest bei Lib-Updates. Wir injizieren nur zusaetzliche dc:subject/Reihen-
// Metadaten vor </metadata>; die ejs-Platzhalter der Lib bleiben unberuehrt.
const EPUB3_OPF_TEMPLATE = require('epub-gen-memory/dist/lib/templates/epub3/content.opf.ejs').default;
const logger = require('../../logger');
// Provenienz-Stempel fuer den OPF-generator-Tag (womit das EPUB erzeugt wurde).
// Das "wann" traegt bereits das Lib-gepflegte dcterms:modified (EPUB3-Pflichtfeld,
// Build-Zeitstempel) — hier ueberschreiben wir nur den App-Identitaets-Teil.
const APP_GENERATOR = `Schreibwerkstatt ${require('../version').getVersion()}`;
const { escXml, resolveTitle, chapterDepth, buildChaptersById, ancestorInSet, prepareCitations } = require('./shared');
const { bibliographyItemHtml } = require('../bibliography');
// Cover-Normalisierung (mittiger Crop auf Buch-Hochformat + sRGB-JPEG) — teilt
// sich die sharp-Pipeline mit dem PDF-Export.
const { prepareCoverPortrait } = require('../cover-prepare');
// Reine Kapitel-Label-Logik (arabic/roman/word, flat/nested) — geteilt mit dem
// PDF-Renderer, damit EPUB- und PDF-Numerierung identisch bleiben.
const { _chapterLabelNested } = require('../pdf-render/layout');

// Loest Autor/Sprache/TOC-Titel aus den Build-Optionen (vom Export-Aufrufer
// befuellt: Autor = Buch-Owner-Anzeigename, lang = book_settings.language) mit
// Fallback auf das Domain-Shape bzw. Sprach-Default. Pure + exportiert fuer Tests.
function _resolveEpubMeta(book, opts = {}) {
  const lang = opts.lang || 'de';
  return {
    lang,
    tocTitle: opts.tocTitle || (lang.startsWith('en') ? 'Contents' : 'Inhalt'),
    author: opts.author || book?.created_by?.name || book?.owned_by?.name || '',
  };
}

// Zaehlt <img>-Tags, deren src weder http(s) noch data: ist — die kann
// epub-gen-memory nicht einbetten und verwirft sie still. Wir loggen das,
// statt es zu verschlucken.
function _countUnfetchableImages(chapters) {
  let n = 0;
  for (const c of chapters) {
    const all = c.content?.match(/<img\b[^>]*\bsrc\s*=\s*["'][^"']*["']/gi) || [];
    for (const tag of all) {
      if (!/\bsrc\s*=\s*["'](https?:|data:|file:)/i.test(tag)) n += 1;
    }
  }
  return n;
}

// Manuskript-Bilder für epub-gen-memory bereitstellen. Die Lib bettet ein Bild nur
// dann korrekt ein, wenn seine src (a) eine echte Bild-Endung trägt (media-type +
// Extension leitet sie via mime.getType aus dem URL-Suffix ab) UND (b) über
// file://- bzw. http(s)-Fetch ladbar ist. /content/page-image/:id (kein Suffix,
// auth-geschützt) und data:-URIs (Fassungs-Export) erfüllen beides nicht — die Lib
// legt sonst nur eine 0-Byte-Datei mit leerem media-type an. Darum: BLOB in eine
// Temp-Datei mit echter Endung schreiben und die src auf deren file://-URL umbiegen.
// Danach embeddet die Lib nativ (Bytes + media-type + OPF-Manifest + Spine). Die
// zurückgegebenen Temp-Pfade räumt der Aufrufer nach dem Build wieder ab.
function _stagePageImagesForEpub(chapters) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { pathToFileURL } = require('url');
  const { randomUUID } = require('crypto');
  const { getPageImage } = require('../../db/page-images');
  const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };
  const tmpDir = os.tmpdir();
  const tmpPaths = [];
  const cache = new Map(); // src → file://-URL (mehrfach referenzierte Bilder teilen eine Datei)

  const stage = (buffer, mime) => {
    const p = path.join(tmpDir, `epubimg-${randomUUID()}.${EXT[mime] || 'jpg'}`);
    fs.writeFileSync(p, buffer);
    tmpPaths.push(p);
    return pathToFileURL(p).href;
  };
  const urlFor = (src) => {
    if (cache.has(src)) return cache.get(src);
    let out = null;
    try {
      const pm = /^\/content\/page-image\/(\d+)/.exec(src);
      if (pm) {
        const row = getPageImage(parseInt(pm[1], 10));
        if (row && row.image) out = stage(row.image, row.mime);
      } else if (/^data:image\//i.test(src)) {
        const semi = src.indexOf(';'); const comma = src.indexOf(',');
        out = stage(Buffer.from(src.slice(comma + 1), 'base64'), src.slice(5, semi === -1 ? comma : semi));
      }
    } catch (e) { logger.warn(`epub: page-image staging fehlgeschlagen (${e.message})`); out = null; }
    cache.set(src, out);
    return out;
  };

  for (const c of chapters) {
    if (!c.content) continue;
    const hasPageImg = c.content.indexOf('/content/page-image/') !== -1;
    const hasData = c.content.indexOf('data:image/') !== -1;
    if (!hasPageImg && !hasData) continue;
    if (hasPageImg) c.content = c.content.replace(/\/content\/page-image\/(\d+)/g, (m) => urlFor(m) || m);
    if (hasData) {
      c.content = c.content
        .replace(/(src\s*=\s*")(data:image\/[^"]+)(")/gi, (m, a, s, z) => { const u = urlFor(s); return u ? a + u + z : m; })
        .replace(/(src\s*=\s*')(data:image\/[^']+)(')/gi, (m, a, s, z) => { const u = urlFor(s); return u ? a + u + z : m; });
    }
  }
  return tmpPaths;
}

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
   weil der Erstzeilen-Einzug des Profils sonst in den Zitatabsatz durchschlaegt. */
blockquote[data-src] { font-size: 95%; font-style: normal; }
blockquote[data-src] p { text-indent: 0; }
li { text-indent: 0; }
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
  return css;
}

// Prosa-Freitext (Widmung/Impressum/Bio) → XHTML. Escaped, Doppel-Zeilenumbruch
// = neuer Absatz, einfacher Umbruch = <br/>. Pflicht-Escape (x-html-Invariante).
function _proseToXhtml(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  return t.split(/\n{2,}/).map(par =>
    `<p>${escXml(par).replace(/\n/g, '<br/>')}</p>`
  ).join('\n');
}

// Impressum-Innen-HTML (Copyright + Impressum-Freitext + ISBN). Leer → ''.
// Geteilt zwischen Front- und Backmatter-Platzierung (epub_imprint_position).
function _imprintBody(m) {
  return [_proseToXhtml(m?.copyright), _proseToXhtml(m?.imprint), m?.isbn ? `<p>ISBN: ${escXml(m.isbn)}</p>` : '']
    .filter(Boolean).join('\n');
}

// Frontmatter-Entries (Titelseite, Impressum, Widmung, Motto) — als XHTML-
// Kapitel VOR dem Inhaltsverzeichnis (beforeToc), aus der custom-TOC
// ausgeschlossen (__toc:false). Reihenfolge: Titel → Impressum → Widmung → Motto.
// Das Impressum steht nur vorne, wenn epub_imprint_position !== 'back'.
function _buildFrontmatter(meta, { title, author, lang }) {
  const m = meta || {};
  const entries = [];
  const titleLabel = lang.startsWith('en') ? 'Title' : 'Titel';
  // Titelseiten-Modus: 'generated' = eigene XHTML-Titelseite (Default),
  // 'cover'/'none' = keine generierte Titelseite (bei 'cover' uebernimmt das
  // eingebettete Cover-Bild diese Rolle).
  if ((m.epub_titlepage_mode || 'generated') === 'generated') {
    let tp = `<div class="titlepage"><h1>${escXml(title)}</h1>`;
    if (m.subtitle) tp += `<p class="subtitle">${escXml(m.subtitle)}</p>`;
    if (author)     tp += `<p class="author">${escXml(author)}</p>`;
    if (m.year)     tp += `<p class="year">${escXml(m.year)}</p>`;
    tp += '</div>';
    entries.push({ title: titleLabel, content: tp, filename: 'front_title.xhtml', __level: 0, __toc: false, beforeToc: true });
  }

  const imprintBody = _imprintBody(m);
  if (imprintBody && (m.epub_imprint_position || 'front') !== 'back') {
    entries.push({ title: 'Impressum', content: `<div class="imprint">${imprintBody}</div>`, filename: 'front_imprint.xhtml', __level: 0, __toc: false, beforeToc: true });
  }
  const ded = _proseToXhtml(m.dedication);
  if (ded) entries.push({ title: lang.startsWith('en') ? 'Dedication' : 'Widmung', content: `<div class="dedication">${ded}</div>`, filename: 'front_dedication.xhtml', __level: 0, __toc: false, beforeToc: true });
  const motto = _proseToXhtml(m.frontmatter);
  if (motto) entries.push({ title: 'Motto', content: `<div class="frontmatter">${motto}</div>`, filename: 'front_motto.xhtml', __level: 0, __toc: false, beforeToc: true });
  return entries;
}

// Impressum als Backmatter (epub_imprint_position === 'back') — Colophon ans
// Buchende. Aus der TOC ausgeschlossen. Eigener Dateiname, damit es nicht mit der
// Frontmatter-Variante kollidiert.
function _buildImprintBackmatter(meta) {
  const m = meta || {};
  if ((m.epub_imprint_position || 'front') !== 'back') return [];
  const body = _imprintBody(m);
  if (!body) return [];
  return [{ title: 'Impressum', content: `<div class="imprint">${body}</div>`, filename: 'back_imprint.xhtml', __level: 0, __toc: false }];
}

// Quellenverzeichnis-Backmatter. Anders als Autor-Bio und Impressum steht es IM
// Inhaltsverzeichnis (__toc bleibt default) — ein Verzeichnis ist ein Abschnitt,
// den der Leser gezielt anspringt. Eintrags-Markup kommt aus der geteilten SSoT
// (lib/bibliography.js#bibliographyItemHtml), der haengende Einzug aus dem CSS.
function _bibliographySection(bib) {
  const items = bibliographyItemHtml(bib);
  if (!items) return [];
  return [{
    title: bib.title,
    content: `<div class="bibliography"><h1>${escXml(bib.title)}</h1>${items}</div>`,
    filename: 'back_bibliography.xhtml',
    __level: 0,
  }];
}

// Autor-Bio-Backmatter (mit optionalem Foto als data-URI). Aus der TOC
// ausgeschlossen, ans Buchende.
function _buildBackmatter(meta, { lang }, authorImage) {
  const bio = _proseToXhtml(meta?.author_bio);
  if (!bio) return [];
  const heading = lang.startsWith('en') ? 'About the Author' : 'Über den Autor';
  let img = '';
  if (authorImage?.image && authorImage.mime) {
    const b64 = Buffer.from(authorImage.image).toString('base64');
    img = `<img src="data:${escXml(authorImage.mime)};base64,${b64}" alt="${escXml(heading)}"/>`;
  }
  return [{
    title: heading,
    content: `<div class="authorpage"><h2>${escXml(heading)}</h2>${img}${bio}</div>`,
    filename: 'back_author.xhtml',
    __level: 0,
    __toc: false,
  }];
}

// Freie Vor-/Nachsatz-Seiten (Selfpublishing-Belletristik: Newsletter-CTA,
// Auch-von, Rezensions-Bitte, Leseprobe, Danksagung, Content-Warnungen). Jede
// Sektion: Titel (Heading + TOC-Label), Prosa-Body, optionaler CTA-Link. Alles
// escaped (x-html-Invariante). placement 'front' = beforeToc (vor dem Inhalts-
// verzeichnis), 'back' = ans Buchende. In die TOC nur, wenn ein Titel existiert
// (TOC braucht ein Label) UND toc !== false. Liefert getrennte front/back-Listen,
// damit buildEpub sie an der richtigen Stelle in allChapters einsortiert.
function _buildExtraSection(s, idx, lang) {
  const title = String(s?.title || '').trim();
  const body = _proseToXhtml(s?.body);
  const linkUrl = String(s?.link_url || '').trim();
  const linkLabel = String(s?.link_label || '').trim();
  if (!title && !body && !linkUrl) return null;
  const placement = s?.placement === 'front' ? 'front' : 'back';
  let inner = '';
  if (title) inner += `<h2>${escXml(title)}</h2>`;
  if (body) inner += body;
  // Nur http(s)/mailto-Links einbetten (alles andere wuerde der Reader ohnehin
  // nicht oeffnen / EPUBCheck monieren).
  if (linkUrl && /^(https?:|mailto:)/i.test(linkUrl)) {
    inner += `<p class="cta"><a href="${escXml(linkUrl)}">${escXml(linkLabel || linkUrl)}</a></p>`;
  }
  const fallbackTitle = lang.startsWith('en') ? 'Section' : 'Abschnitt';
  return {
    title: title || fallbackTitle,
    content: `<div class="extra-section">${inner}</div>`,
    filename: `${placement}_extra_${idx}.xhtml`,
    __level: 0,
    __toc: !!title && s?.toc !== false,
    __placement: placement,
    ...(placement === 'front' ? { beforeToc: true } : {}),
  };
}

function _buildExtraSections(meta, { lang }) {
  const list = Array.isArray(meta?.extra_sections) ? meta.extra_sections : [];
  const out = list.map((s, i) => _buildExtraSection(s, i, lang)).filter(Boolean);
  return {
    front: out.filter(e => e.__placement === 'front'),
    back: out.filter(e => e.__placement === 'back'),
  };
}

// Editor-Umbruchmarker (`<hr class="pagebreak">` / `<hr class="blankpage">`) in
// EPUB-Aequivalente uebersetzen: Pagebreak bleibt randloses hr mit erzwungenem
// Seitenumbruch danach; Blankpage wird ein leeres div (hr kann keinen Inhalt
// tragen) mit Umbruch davor + danach, damit eine bewusst leere Seite entsteht.
const _SCENE_MARKUP = {
  line: '<hr class="scene-line" />',
  blank: '<hr class="scene-blank" />',
  asterism: '<p class="scene-sep">⁂</p>',
  stars: '<p class="scene-sep">* * *</p>',
  fleuron: '<p class="scene-sep">❦</p>',
};

// Vom Autor gesetzte Leerzeile (leerer Absatz) im Belletristik-Satz =
// Szenentrenner: sichtbare Leerzeile + Folgeabsatz ohne Erstzeilen-Einzug
// (CSS `.scene-gap` / `.scene-gap + p`). Nur bei aktivem Einzug; im Sachbuch-
// Satz trennt bereits der Absatzabstand.
const _SCENE_GAP = '<p class="scene-gap">&#160;</p>';

// Strich-Trenner zwischen Kapitelnummer und Kapiteltitel bei gestapelter,
// numerierter Ueberschrift. Drei Geviertstriche; das CSS-letter-spacing zerlegt
// sie optisch in einzelne Striche.
const CHAPTER_RULE = '———';
function _applyBlankLines(html) {
  return html
    .replace(/<p\b[^>]*>(?:\s|&nbsp;|&#160;|<br\s*\/?>)*<\/p>/gi, _SCENE_GAP)
    .replace(/(?:<p class="scene-gap">&#160;<\/p>\s*){2,}/gi, _SCENE_GAP)
    .replace(/^\s*(?:<p class="scene-gap">&#160;<\/p>\s*)+/i, '')
    .replace(/(?:<p class="scene-gap">&#160;<\/p>\s*)+\s*$/i, '');
}

function _applyBreaks(html, sceneSep = 'line', indentActive = false) {
  if (!html) return html;
  const scene = _SCENE_MARKUP[sceneSep] || _SCENE_MARKUP.line;
  let out = html
    .replace(/<hr\b[^>]*\bclass="[^"]*\bpagebreak\b[^"]*"[^>]*>/gi, '<hr class="pagebreak" />')
    .replace(/<hr\b[^>]*\bclass="[^"]*\bblankpage\b[^"]*"[^>]*>/gi, '<div class="blankpage"> </div>')
    .replace(/<hr(?![^>]*\bclass=)[^>]*>/gi, scene);
  if (indentActive) out = _applyBlankLines(out);
  return out;
}

// EPUBCheck verlangt dokumentweit eindeutige id-Attribute (RSC-005 "Duplicate
// ID"). Editor-/Import-HTML kann doppelte Anker-IDs (BookStack `bkmrk-…`) und
// leere `id=""` enthalten. Pro XHTML-Datei deduplizieren: das erste Vorkommen
// behaelt die ID (bleibt Link-Ziel), spaetere Duplikate bekommen einen Zaehler-
// Suffix, leere IDs werden entfernt. Zwei-Pass, damit der synthetische Suffix
// keine andere echte ID im selben Dokument trifft.
function _dedupeIds(html) {
  if (!html || !/\sid\s*=/i.test(html)) return html;
  const existing = new Set(
    [...html.matchAll(/\sid\s*=\s*"([^"]*)"/gi)].map(m => m[1].trim()).filter(Boolean),
  );
  const used = new Set();
  return html.replace(/(\s)id\s*=\s*"([^"]*)"/gi, (full, sp, raw) => {
    const v = raw.trim();
    if (!v) return ''; // leere id ganz entfernen (inkl. fuehrendem Whitespace)
    if (!used.has(v)) { used.add(v); return `${sp}id="${v}"`; }
    let i = 2, nv;
    do { nv = `${v}-${i++}`; } while (used.has(nv) || existing.has(nv));
    used.add(nv);
    return `${sp}id="${nv}"`;
  });
}

// Buchhandels-Metadaten, die epub-gen-memory nicht nativ als Option kennt, als
// OPF-Metadata-Zeilen: Schlagwoerter → dc:subject (eins pro Term), Reihe →
// EPUB3-Collection + calibre-Legacy-Meta (von Calibre/vielen Readern gelesen).
function _buildOpfExtraMeta(meta) {
  const parts = [];
  // ISBN als zusaetzlicher dc:identifier (urn:isbn:) — der Buchhandel/Distributoren
  // (Tolino, Apple Books, ONIX) erkennen das Buch darueber. Der Package-eigene
  // unique-identifier bleibt die UUID; ISBN tritt als weiterer Identifier hinzu.
  // onix:codelist5 15 = ISBN-13, 02 = ISBN-10. Bindestriche/Spaces gestrippt.
  const isbn = String(meta?.isbn || '').replace(/[\s-]/g, '').trim();
  if (isbn) {
    const code = /^\d{13}$/.test(isbn) ? '15' : /^\d{9}[\dxX]$/.test(isbn) ? '02' : null;
    parts.push(`<dc:identifier id="isbn">urn:isbn:${escXml(isbn)}</dc:identifier>`);
    if (code) parts.push(`<meta refines="#isbn" property="identifier-type" scheme="onix:codelist5">${code}</meta>`);
  }
  const kw = String(meta?.keywords || '').split(',').map(s => s.trim()).filter(Boolean);
  for (const k of kw) parts.push(`<dc:subject>${escXml(k)}</dc:subject>`);
  const series = String(meta?.series || '').trim();
  if (series) {
    const idx = String(meta?.series_index || '').trim();
    parts.push(`<meta property="belongs-to-collection" id="series-collection">${escXml(series)}</meta>`);
    parts.push('<meta refines="#series-collection" property="collection-type">series</meta>');
    if (idx) parts.push(`<meta refines="#series-collection" property="group-position">${escXml(idx)}</meta>`);
    parts.push(`<meta name="calibre:series" content="${escXml(series)}"/>`);
    if (idx) parts.push(`<meta name="calibre:series_index" content="${escXml(idx)}"/>`);
  }
  const rights = String(meta?.epub_rights || '').trim();
  if (rights) parts.push(`<dc:rights>${escXml(rights)}</dc:rights>`);
  // Mitwirkende → dc:contributor + MARC-Relator-Rolle (trl/ill/edt). id refines
  // koppelt Rolle an den Eintrag (EPUB3).
  const contributors = [
    ['translator', 'trl', meta?.epub_translator],
    ['illustrator', 'ill', meta?.epub_illustrator],
    ['editor', 'edt', meta?.epub_editor_name],
  ];
  contributors.forEach(([key, role, raw]) => {
    const name = String(raw || '').trim();
    if (!name) return;
    parts.push(`<dc:contributor id="contrib-${key}">${escXml(name)}</dc:contributor>`);
    parts.push(`<meta refines="#contrib-${key}" property="role" scheme="marc:relators">${role}</meta>`);
  });
  // Hauptautor: MARC-Relator aut auf das Lib-#creator (file-as setzt
  // _buildContentOPF direkt im Template). Co-Autoren (Schreib-Duos) als
  // zusaetzliche dc:creator je eigener Identifier + Rolle aut + optional file-as.
  parts.push('<meta refines="#creator" property="role" scheme="marc:relators">aut</meta>');
  const coAuthors = Array.isArray(meta?.co_authors) ? meta.co_authors : [];
  coAuthors.forEach((c, i) => {
    const name = String(c?.name || '').trim();
    if (!name) return;
    const cid = `creator-co${i + 1}`;
    parts.push(`<dc:creator id="${cid}">${escXml(name)}</dc:creator>`);
    parts.push(`<meta refines="#${cid}" property="role" scheme="marc:relators">aut</meta>`);
    const fa = String(c?.file_as || '').trim();
    if (fa) parts.push(`<meta refines="#${cid}" property="file-as">${escXml(fa)}</meta>`);
  });
  return parts.join('\n        ');
}

// Barrierefreiheits-Metadaten (EPUB Accessibility 1.1 / schema.org). Pflicht-
// Discovery-Metadaten fuer den EU-Vertrieb (European Accessibility Act, seit
// 06/2025). Auto-generiert aus dem Inhalt: reflowierbarer Text mit struktureller
// Navigation + Inhaltsverzeichnis. accessMode `visual` nur, wenn Bilder vorhanden.
// Die conformsTo-Aussage ist eine Selbsteinschaetzung des sauber strukturierten
// Outputs; epubcheck validiert die strukturelle Konformitaet separat.
function _buildAccessibilityMeta({ hasImages, lang }) {
  const parts = [];
  parts.push('<meta property="schema:accessMode">textual</meta>');
  if (hasImages) parts.push('<meta property="schema:accessMode">visual</meta>');
  parts.push('<meta property="schema:accessModeSufficient">textual</meta>');
  parts.push('<meta property="schema:accessibilityFeature">tableOfContents</meta>');
  parts.push('<meta property="schema:accessibilityFeature">readingOrder</meta>');
  parts.push('<meta property="schema:accessibilityFeature">structuralNavigation</meta>');
  parts.push('<meta property="schema:accessibilityHazard">none</meta>');
  const summary = String(lang || '').startsWith('en')
    ? 'Reflowable text with structural navigation and a table of contents.'
    : 'Reflowierbarer Text mit struktureller Navigation und Inhaltsverzeichnis.';
  parts.push(`<meta property="schema:accessibilitySummary">${escXml(summary)}</meta>`);
  parts.push('<link rel="dcterms:conformsTo" href="http://www.idpf.org/epub/a11y/accessibility-20170105.html#wcag-aa"/>');
  return parts.join('\n        ');
}

// Custom-OPF immer bauen: der Lib-Default weist `epub-gen` als generator aus —
// wir ersetzen den Tag durch die App-Identitaet (Provenienz-Nachweis: womit
// erzeugt). Optionale Provenienz-Details: die Instanz-Domain wandert in den
// generator-Content (wo erzeugt), der exportierende User in ein eigenes
// generated-by-Meta (wer erzeugt). Das "wann" traegt das Lib-gepflegte
// dcterms:modified. Buchhandels-Extra-Metadaten werden zusaetzlich vor
// </metadata> injiziert (ejs-Platzhalter der Lib bleiben unberuehrt).
function _buildContentOPF(meta, provenance = {}, a11y = {}) {
  const instanceUrl = String(provenance.instanceUrl || '').trim();
  const exportedBy = String(provenance.exportedBy || '').trim();
  const genContent = instanceUrl ? `${APP_GENERATOR} (${instanceUrl})` : APP_GENERATOR;
  const genLines = [`<meta name="generator" content="${escXml(genContent)}" />`];
  if (exportedBy) genLines.push(`<meta name="generated-by" content="${escXml(exportedBy)}" />`);
  let opf = EPUB3_OPF_TEMPLATE.replace(
    '<meta name="generator" content="epub-gen" />',
    genLines.join('\n        '),
  );
  // EPUB3-konforme Cover-Kennzeichnung: properties="cover-image" am Bild-Item
  // (epub-gen-memory emittiert nur das Legacy-<meta name="cover">). Reader, die
  // EPUB3 bevorzugen, erkennen das Cover-Thumbnail dadurch zuverlaessig.
  opf = opf.replace(
    '<item id="image_cover" href="cover.<%= cover.extension %>" media-type="<%= cover.mediaType %>" />',
    '<item id="image_cover" href="cover.<%= cover.extension %>" media-type="<%= cover.mediaType %>" properties="cover-image" />',
  );
  // Legacy-Guide-Referenz auf die Cover-Seite (EPUB2-Reader-Kompat).
  opf = opf.replace(
    '<reference type="text" title="Table of Content" href="toc.xhtml"/>',
    '<% if(cover) { %><reference type="cover" title="Cover" href="front_cover.xhtml"/>\n        <% } %><reference type="text" title="Table of Content" href="toc.xhtml"/>',
  );
  // Leerer Verlag: das Lib-Template rendert sonst leere
  // <meta property="dcterms:publisher"/> + <dc:publisher/> (EPUBCheck RSC-005,
  // "character content … length at least 1"). Zeilen entfernen statt leer
  // emittieren; die Copyright-Default-Zeile verliert ihren "by …"-Zusatz.
  if (!String(meta?.publisher || '').trim()) {
    opf = opf
      .replace(/[ \t]*<meta property="dcterms:publisher"><%= publisher %><\/meta>\n/, '')
      .replace(/[ \t]*<dc:publisher><%= publisher %><\/dc:publisher>\n/, '')
      .replace(/ by <%= publisher %>/, '');
  }
  // Sortiername des Hauptautors (file-as, z.B. "Beispiel, Anna"): das Lib-Template
  // setzt file-as = Anzeigename → Katalog-/Reader-Bibliotheken sortieren unter dem
  // Vornamen. Ist author_file_as gesetzt, den file-as-Wert im Template ersetzen
  // (regex-robust gegen den ejs-Platzhalter dazwischen).
  const fileAs = String(meta?.author_file_as || '').trim();
  if (fileAs) {
    opf = opf.replace(
      /(<meta refines="#creator" property="file-as">)[\s\S]*?(<\/meta>)/,
      `$1${escXml(fileAs)}$2`,
    );
  }
  const injected = [_buildOpfExtraMeta(meta), _buildAccessibilityMeta(a11y)].filter(Boolean).join('\n        ');
  if (injected) opf = opf.replace('</metadata>', `        ${injected}\n    </metadata>`);
  return opf;
}

// depth: max Outline-Tiefe (epub_toc_depth). 1 = nur Top-Kapitel (Level-1-
// Eintraege ausgeblendet), 2 = volle zweistufige NavMap. Bei depth=1 werden
// Eltern als Blatt gerendert (kein leeres <navPoint>-Nesting).
function _buildNavMapXml(allChapters, depth = 2) {
  const chapters = allChapters.filter(c => c.__toc !== false && (c.__level || 0) < depth);
  let play = 0;
  let openParent = false;
  let out = '<navMap>\n';
  chapters.forEach((c, i) => {
    const lvl = c.__level || 0;
    const id = `np_${i}`;
    const file = c.filename;
    const title = escXml(c.title);
    const hasKids = c.__hasChildren && depth > 1;
    if (lvl === 0) {
      if (openParent) { out += '</navPoint>\n'; openParent = false; }
      const cls = hasKids ? 'part' : 'chapter';
      out += `<navPoint id="${id}" playOrder="${++play}" class="${cls}">\n`;
      out += `<navLabel><text>${title}</text></navLabel>\n`;
      out += `<content src="${file}"/>\n`;
      if (hasKids) openParent = true;
      else out += '</navPoint>\n';
    } else {
      out += `<navPoint id="${id}" playOrder="${++play}" class="chapter">\n`;
      out += `<navLabel><text>${title}</text></navLabel>\n`;
      out += `<content src="${file}"/>\n`;
      out += '</navPoint>\n';
    }
  });
  if (openParent) out += '</navPoint>\n';
  out += '</navMap>';
  return out;
}

function _buildTocXhtmlBody(allChapters, tocTitle, depth = 2) {
  const chapters = allChapters.filter(c => c.__toc !== false && (c.__level || 0) < depth);
  let openParent = false;
  let out = `<h1 class="h1">${escXml(tocTitle)}</h1>\n<nav id="toc" epub:type="toc">\n<ol style="list-style: none">\n`;
  chapters.forEach(c => {
    const lvl = c.__level || 0;
    const file = c.filename;
    const title = escXml(c.title);
    const hasKids = c.__hasChildren && depth > 1;
    if (lvl === 0) {
      if (openParent) { out += '</ol>\n</li>\n'; openParent = false; }
      if (hasKids) {
        out += `<li class="table-of-content"><a href="${file}">${title}</a>\n<ol style="list-style: none">\n`;
        openParent = true;
      } else {
        out += `<li class="table-of-content"><a href="${file}">${title}</a></li>\n`;
      }
    } else {
      out += `<li class="table-of-content"><a href="${file}">${title}</a></li>\n`;
    }
  });
  if (openParent) out += '</ol>\n</li>\n';
  out += '</ol>\n</nav>';
  return out;
}

// EPUB3-Landmarks-nav (Reader-Schnellnavigation: Inhaltsverzeichnis + Textbeginn).
// Versteckt (hidden), referenziert die Lib-toc.xhtml und die erste Inhalts-Datei
// (bodymatter). Cover ist bei epub-gen-memory nur ein Bild-Item ohne XHTML-Seite,
// darum kein Cover-Landmark.
function _buildLandmarksNav(bodyStartFile, lang, hasCover = false) {
  const en = String(lang || '').startsWith('en');
  const coverLabel = en ? 'Cover' : 'Umschlag';
  const tocLabel = en ? 'Table of Contents' : 'Inhaltsverzeichnis';
  const bodyLabel = en ? 'Begin Reading' : 'Textbeginn';
  let out = '<nav epub:type="landmarks" id="landmarks" hidden="">\n<ol>\n';
  if (hasCover) out += `<li><a epub:type="cover" href="front_cover.xhtml">${escXml(coverLabel)}</a></li>\n`;
  out += `<li><a epub:type="toc" href="toc.xhtml">${escXml(tocLabel)}</a></li>\n`;
  if (bodyStartFile) out += `<li><a epub:type="bodymatter" href="${bodyStartFile}">${escXml(bodyLabel)}</a></li>\n`;
  out += '</ol>\n</nav>';
  return out;
}

// Dateiendung wie epub-gen-memory sie aus dem MIME ableitet (mime.getExtension):
// image/jpeg → "jpeg", image/png → "png". Die Cover-XHTML-Seite MUSS denselben
// Dateinamen referenzieren wie die Lib das Bild ablegt (OEBPS/cover.<ext>).
function _coverExt(mime) { return /png/i.test(mime) ? 'png' : 'jpeg'; }

// Vollbild-Cover-Seite als komplettes XHTML-Dokument (wird direkt in die ZIP
// geschrieben, NICHT durch die Lib-Pipeline gewrappt — darum hier der volle
// html/head/body-Rahmen mit XHTML-Namespace). Bei bekannten Bildmaßen via
// SVG-viewBox (haelt das Seitenverhaeltnis verzerrungsfrei, EPUBCheck-konform);
// ohne Maße (Roh-Fallback) als einfaches zentriertes <img>.
function _buildCoverXhtml(coverData, lang = 'de', fit = 'contain') {
  const href = `cover.${_coverExt(coverData.mime)}`;
  // fit='cover' = randfuellend (Bild beschnitten), 'contain' = ganz sichtbar
  // (Letterbox). SVG: slice vs. meet; <img>-Fallback via .cover-page--cover (CSS).
  const par = fit === 'cover' ? 'xMidYMid slice' : 'xMidYMid meet';
  const cls = fit === 'cover' ? 'cover-page cover-page--cover' : 'cover-page';
  let body;
  if (coverData.width > 0 && coverData.height > 0) {
    const w = coverData.width, h = coverData.height;
    body = `<div class="${cls}"><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" width="100%" height="100%" viewBox="0 0 ${w} ${h}" preserveAspectRatio="${par}"><image width="${w}" height="${h}" xlink:href="${href}"/></svg></div>`;
  } else {
    body = `<div class="${cls}"><img src="${href}" alt="Cover"/></div>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escXml(lang)}" lang="${escXml(lang)}">
<head>
<meta charset="UTF-8" />
<title>Cover</title>
<link rel="stylesheet" type="text/css" href="style.css" />
</head>
<body>
${body}
</body>
</html>`;
}

// Post-Step an der fertigen EPUB-ZIP — am Content-Sanitizer von epub-gen-memory
// vorbei (der lowercased Attribute und damit SVG viewBox zerstoert). Erledigt
// zwei OPF-Patches, je nach Optionen:
//  - coverData: Vollbild-Cover-Seite (OEBPS/front_cover.xhtml) + Manifest-Item +
//    Spine-Position als erste Leseseite. Das Cover-Bild selbst hat die Lib bereits
//    eingebettet.
//  - removeTocFromSpine (epub_toc_enabled=false): den toc.xhtml-<itemref> aus der
//    linearen Lesereihenfolge entfernen. Das mandatory Nav-Dokument bleibt im
//    Manifest (properties="nav") fuer die Reader-Navigation erhalten.
// Ohne anstehende Patches wird der Buffer unveraendert (ohne Rezip) durchgereicht.
async function _finalizeEpub(buffer, { coverData = null, lang = 'de', coverFit = 'contain', removeTocFromSpine = false } = {}) {
  if (!coverData && !removeTocFromSpine) return buffer;
  const zip = await JSZip.loadAsync(buffer);
  const opfPath = Object.keys(zip.files).find(n => /content\.opf$/.test(n));
  if (!opfPath) return buffer; // defensiv: ohne OPF nichts patchen
  let opf = await zip.file(opfPath).async('string');
  if (coverData) {
    // Inline-SVG-Content-Dokumente MUESSEN properties="svg" am Manifest-Item tragen
    // (EPUBCheck OPF-014). Beim Roh-Fallback (<img>) entfaellt das.
    const usesSvg = coverData.width > 0 && coverData.height > 0;
    const coverItemProps = usesSvg ? ' properties="svg"' : '';
    // Manifest-Item nach dem CSS-Item einhaengen.
    opf = opf.replace(
      /(<item id="css"[^>]*\/>)/,
      `$1\n        <item id="cover-page" href="front_cover.xhtml" media-type="application/xhtml+xml"${coverItemProps} />`,
    );
    // Spine: Cover als allererste Leseseite.
    opf = opf.replace(/<spine([^>]*)>/, `<spine$1>\n        <itemref idref="cover-page" />`);
    const oebpsDir = opfPath.replace(/content\.opf$/, '');
    zip.file(`${oebpsDir}front_cover.xhtml`, _buildCoverXhtml(coverData, lang, coverFit));
  }
  if (removeTocFromSpine) {
    opf = opf.replace(/[ \t]*<itemref idref="toc"\s*\/>\s*\n?/, '');
  }
  zip.file(opfPath, opf);

  // mimetype MUSS unkomprimiert (STORE) und erste Entry bleiben (EPUB-OCF-Pflicht).
  // JSZip wuerde es beim Regenerieren sonst mit dem globalen DEFLATE packen — daher
  // explizit neu setzen (in-place, behaelt die Position als erste Entry).
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });

  return zip.generateAsync({
    type: 'nodebuffer',
    mimeType: 'application/epub+zip',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
}

async function buildEpub(bundle, opts = {}) {
  const { scope, book, chapter, page } = bundle;
  const { groups, bib, showBibliography } = await prepareCitations(bundle, opts);
  const { lang, tocTitle, author } = _resolveEpubMeta(book, opts);
  const meta = opts.meta || null;
  // Anzeige-Autorenstring fuer Titelseite + NCX-docAuthor: Hauptautor + Co-Autoren
  // (Schreib-Duos) mit "&" verbunden. Das Lib-OPF traegt nur den Hauptautor als
  // primaeren dc:creator; Co-Autoren werden in _buildOpfExtraMeta als eigene
  // dc:creator ergaenzt (semantisch korrekt: ein Element je Person).
  const coAuthorNames = (Array.isArray(meta?.co_authors) ? meta.co_authors : [])
    .map(c => String(c?.name || '').trim()).filter(Boolean);
  const displayAuthor = [author, ...coAuthorNames].filter(Boolean).join(' & ');
  const sceneSep = meta?.epub_scene_separator || 'line';
  // Belletristik-Satz (Erstzeilen-Einzug) → Leerzeilen als Szenentrenner.
  const indentActive = meta?.epub_paragraph_style !== 'spaced';
  // Kapiteltitel-Stil + dekorative Striche (Pendant zur PDF-Option). titleStyle
  // steuert Ausrichtung/Groesse via Wrapper-Klasse (CSS). pageRule = Strich unter
  // dem Seitentitel in Mehrseiten-Kapiteln.
  const titleStyle = meta?.epub_chapter_title_style || 'centered-large';
  const chapterRule = !!meta?.epub_chapter_rule;
  const pageRule = !!meta?.epub_page_rule;
  // Dekorativer Strich unter dem Kapiteltitel — nur Top-Level, bei Stil
  // 'left-rule' (impliziter Strich) oder explizit gesetztem epub_chapter_rule
  // (Sub-Kapitel mit Strich wirken zu schwer, wie beim PDF).
  const wantTitleRule = (level) => level === 0 && (titleStyle === 'left-rule' || chapterRule);
  // Strich-Trenner ——— zwischen Kapitelnummer und Titel in der gestapelten,
  // numerierten Ueberschrift. Default an; abschaltbar ueber die Reflow-Option.
  const numberDivider = meta?.epub_chapter_number_divider !== false;
  const titleRuleHtml = '<hr class="epub-title-rule" aria-hidden="true" />';
  const pageRuleHtml = '<hr class="epub-page-rule" aria-hidden="true" />';
  // Kapitelkopf-Wrapper: Klasse fuer den optionalen Seitenumbruch (CSS-Regel nur
  // aktiv bei epub_chapter_pagebreak [Top] bzw. epub_subchapter_pagebreak [Sub])
  // + titleStyle-Modifier (Ausrichtung). level 0 = Top, 1 = Sub-Kapitel.
  const headWrap = (html, level) =>
    `<div class="epub-chapter-head epub-chapter-head--${level === 0 ? 'top' : 'sub'} epub-chapter-head--ts-${titleStyle}">${html}</div>`;
  // Kapitelueberschrift als XHTML. Bei aktiver Numerierung dreistufig gestapelt
  // — Nummer → Strich-Trenner → Titel, mit grosszuegigen Abstaenden via CSS
  // (.epub-chapter-title--numbered). Ohne Label (numbering=none, unnumeriertes
  // Kapitel, Solo-Seite) schlichte einzeilige <h1> wie bisher (kein Stil-Drift).
  // withRule haengt den dekorativen Strich unter die Ueberschrift.
  const chapterHeadingHtml = (label, name, withRule) => {
    const safe = escXml(name);
    const rule = withRule ? titleRuleHtml : '';
    if (!label) return `<h1>${safe}</h1>${rule}`;
    const divider = numberDivider
      ? `<span class="epub-chapter-rule" aria-hidden="true">${CHAPTER_RULE}</span>`
      : '';
    return `<h1 class="epub-chapter-title epub-chapter-title--numbered">`
      + `<span class="epub-chapter-num">${escXml(label)}</span>`
      + divider
      + `<span class="epub-chapter-name">${safe}</span>`
      + `</h1>${rule}`;
  };
  // Seiten innerhalb eines Mehrseiten-Kapitels im Inhaltsverzeichnis zeigen?
  const nestPages = meta?.epub_nest_pages_in_toc !== false;
  // Kapitel-Numerierung (Pendant zur PDF-Option). Das Label wird dem
  // Kapiteltitel im Inhaltsverzeichnis UND der Kapitelueberschrift vorangestellt.
  // Nur echte Kapitel zaehlen; Solo-Seiten ohne Kapitel bleiben unnumeriert.
  const numbering = meta?.epub_chapter_numbering || 'none';
  const numberingMode = meta?.epub_chapter_numbering_mode || 'nested';
  // Kapitel, die ohne Nummer erscheinen sollen (Cascade auf Sub-Kapitel via
  // ancestorInSet). Wie beim PDF: unnumerierte Kapitel zaehlen NICHT mit, die
  // Numerierung laeuft ohne Luecke weiter; tiefere Counter werden trotzdem
  // zurueckgesetzt, damit nachfolgende Sub-Nummern stimmen.
  const excludedIds = new Set(Array.isArray(meta?.epub_unnumbered_chapter_ids) ? meta.epub_unnumbered_chapter_ids : []);
  const numCounters = [0, 0, 0]; // [topIdx, subIdx, subSubIdx]
  const chapterLabel = (depth, unnumbered) => {
    if (numbering === 'none') return null;
    const dd = Math.max(1, Math.min(3, depth));
    if (!unnumbered) numCounters[dd - 1] += 1;
    for (let k = dd; k < 3; k++) numCounters[k] = 0; // tiefere Counter zuruecksetzen
    return unnumbered ? null : _chapterLabelNested(numbering, numCounters, dd, numberingMode, lang);
  };
  const epubChapters = [];
  // NavMap kann nur 2 Ebenen; sub-sub-Kapitel werden auf Level 1 zusammengelegt
  // (Inhalt bleibt vollstaendig, nur die Outline ist flacher).
  const byId = buildChaptersById(groups);
  groups.forEach((g, gi) => {
    const ch = g.chapter;
    const d = ch ? chapterDepth(ch, byId) : 1;
    const level = Math.min(1, d - 1); // 0 = Top, 1 = nested.
    const unnumbered = ch ? ancestorInSet(ch, byId, excludedIds) : false;
    // Label vorab ziehen (mutiert die Counter in Dokumentreihenfolge) — sonst
    // springt die Numerierung. Solo-Seiten (kein ch) ziehen kein Label.
    const label = ch ? chapterLabel(d, unnumbered) : null;
    const withLabel = (name) => (label ? `${label}. ${name}` : name);
    if (ch && g.pages.length > 1) {
      const chTitle = withLabel(ch.name); // TOC/NavMap-Text: flaches "1. Name"
      epubChapters.push({
        title: chTitle,
        content: headWrap(chapterHeadingHtml(label, ch.name, wantTitleRule(level)), level),
        filename: `chap_${gi}.xhtml`,
        __level: level,
        __hasChildren: level === 0 && nestPages,
      });
      g.pages.forEach((x, pi) => {
        epubChapters.push({
          title: x.p.name,
          content: _dedupeIds(`<h2>${escXml(x.p.name)}</h2>${pageRule ? pageRuleHtml : ''}` + _applyBreaks(x.pd.html, sceneSep, indentActive)),
          filename: `chap_${gi}_p_${pi}.xhtml`,
          __level: 1,
          __toc: nestPages,
        });
      });
    } else {
      const x = g.pages[0];
      const title = ch ? withLabel(ch.name) : x.p.name; // TOC/NavMap-Text
      const headingName = ch ? ch.name : x.p.name;
      const content = _dedupeIds(headWrap(chapterHeadingHtml(label, headingName, wantTitleRule(level)), level) + _applyBreaks(x.pd.html, sceneSep, indentActive));
      epubChapters.push({
        title,
        content,
        filename: `entry_${gi}.xhtml`,
        __level: level,
        __hasChildren: false,
      });
    }
  });

  const title = resolveTitle({ scope, book, chapter, page });

  // Cover-Bild auf Buch-Hochformat (~1:1.6) zuschneiden, damit es im Reader-Regal
  // ein echtes Buch fuellt statt quadratisch zu schrumpfen. Schlaegt die
  // Normalisierung fehl (korruptes BLOB), faellt es non-fatal auf das Rohbild
  // zurueck — der Export soll nicht am Cover scheitern.
  let coverData = null;
  if (opts.cover?.image && opts.cover.mime) {
    try {
      coverData = await prepareCoverPortrait(opts.cover.image);
    } catch (e) {
      logger.warn(`epub: Cover-Normalisierung fehlgeschlagen (${e.message}) — verwende Rohbild`);
      coverData = { buffer: opts.cover.image, mime: opts.cover.mime, width: 0, height: 0 };
    }
  }
  // Frontmatter (Titelseite/Impressum/Widmung/Motto) vor, Autor-Bio nach dem
  // Inhalt. Alle aus der custom-TOC ausgeschlossen (__toc:false). Die Cover-Seite
  // laeuft NICHT durch diese Pipeline — epub-gen-memory lowercased Attribute
  // (zerstoert SVG viewBox) und schreibt <img src> um; sie wird stattdessen nach
  // genEpub direkt in die ZIP injiziert (siehe _injectCoverPage).
  // Freie Vor-/Nachsatz-Seiten: front zwischen Motto und Inhalt (beforeToc),
  // back nach der Autor-Bio. Reihenfolge innerhalb einer Platzierung = Array-
  // Reihenfolge (vom Autor gepflegt). Impressum-Backmatter (epub_imprint_position
  // === 'back') als Colophon ganz ans Ende.
  const extraSections = _buildExtraSections(meta, { lang });
  const allChapters = [
    ..._buildFrontmatter(meta, { title, author: displayAuthor, lang }),
    ...extraSections.front,
    ...epubChapters,
    ...(showBibliography ? _bibliographySection(bib) : []),
    ..._buildBackmatter(meta, { lang }, opts.authorImage),
    ...extraSections.back,
    ..._buildImprintBackmatter(meta),
  ];

  // Manuskript-Bilder in Temp-Dateien auslagern + src auf file://-URLs umbiegen,
  // damit epub-gen-memory sie nativ einbettet. Aufräumen nach genEpub (finally).
  const stagedImagePaths = _stagePageImagesForEpub(allChapters);

  const unfetchable = _countUnfetchableImages(allChapters);
  if (unfetchable > 0) {
    logger.warn(`epub: ${unfetchable} <img> mit nicht-einbettbarer src (weder http(s) noch data:) — werden vom Reader nicht angezeigt`);
  }

  // TOC-Tiefe (epub_toc_depth): 1 = nur Top-Kapitel, sonst zweistufig. Filtert die
  // NCX-NavMap UND das nav.xhtml. epub_toc_enabled steuert separat die Lese-
  // reihenfolge (Spine) via _finalizeEpub — die Eintraege bleiben fuers Reader-Menue.
  const tocDepth = meta?.epub_toc_depth === 1 ? 1 : 2;
  const navMapXml = _buildNavMapXml(allChapters, tocDepth);
  // bodymatter-Landmark zeigt auf die erste echte Inhalts-Datei (nach Frontmatter).
  const bodyStartFile = epubChapters[0]?.filename;
  const tocBody = `${_buildTocXhtmlBody(allChapters, tocTitle, tocDepth)}\n${_buildLandmarksNav(bodyStartFile, lang, !!coverData)}`;
  const tocNCX = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head>
<meta name="dtb:uid" content="<%= id %>"/>
<meta name="dtb:depth" content="2"/>
<meta name="dtb:totalPageCount" content="0"/>
<meta name="dtb:maxPageNumber" content="0"/>
</head>
<docTitle><text><%= title %></text></docTitle>
<docAuthor><text>${escXml(displayAuthor)}</text></docAuthor>
${navMapXml}
</ncx>`;
  const tocXHTML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="<%- lang %>" lang="<%- lang %>">
<head>
<title><%= title %></title>
<meta charset="UTF-8" />
<link rel="stylesheet" type="text/css" href="style.css" />
</head>
<body>
${tocBody}
</body>
</html>`;

  // Cover als File (epub-gen-memory akzeptiert string-URL oder File). Das bereits
  // hochformat-normalisierte coverData (sRGB-JPEG) wird in ein File gewickelt; die
  // Cover-XHTML-Seite oben referenziert dieselbe cover.jpg.
  let cover;
  if (coverData) {
    cover = new File([coverData.buffer], `cover.${_coverExt(coverData.mime)}`, { type: coverData.mime });
  }

  const css = _buildCss(meta);

  // Buchhandels-Metadaten bevorzugt aus book_publication, Description faellt auf
  // die Domain-Beschreibung zurueck. date: explizites Erscheinungsdatum
  // (epub_pubdate) vor dem Freitext-Jahr.
  const trimmed = v => { const t = String(v ?? '').trim(); return t || undefined; };
  const description = trimmed(meta?.description) || trimmed(book?.description);
  const publisher = trimmed(meta?.publisher);
  const date = trimmed(meta?.epub_pubdate) || trimmed(meta?.year);
  const id = trimmed(meta?.epub_uuid);
  // Bilder vorhanden? Cover, Autorfoto oder Inline-<img> → accessMode `visual`.
  const hasImages = !!cover || !!opts.authorImage?.image || allChapters.some(c => /<img\b/i.test(c.content || ''));
  const contentOPF = _buildContentOPF(
    meta,
    { instanceUrl: opts.instanceUrl, exportedBy: opts.exportedBy },
    { hasImages, lang },
  );

  const epub = new EPub(
    {
      title,
      author: author || undefined,
      description,
      publisher,
      // Eigener Identifier (URN/UUID) wenn gesetzt — sonst Lib-Auto-UUID.
      ...(id ? { id } : {}),
      // date NUR wenn gesetzt — die Lib ueberschreibt sonst ihren Default mit
      // undefined und `new Date(undefined).toISOString()` wirft.
      ...(date ? { date } : {}),
      ...(contentOPF ? { contentOPF } : {}),
      cover,
      lang,
      tocTitle,
      css,
      // Builder liefert eigene Headings (Kapitel-Intro bzw. Seitenname). Lib-
      // Default-Prepend wuerde sie verdoppeln + Seiten innerhalb eines Kapitels
      // ungewollt mit Per-Page-Heading versehen.
      prependChapterTitles: false,
      ignoreFailedDownloads: true,
      tocNCX,
      tocXHTML,
    },
    allChapters,
  );
  let buffer;
  try {
    buffer = await epub.genEpub();
  } finally {
    // Temp-Bilddateien immer aufräumen — auch wenn genEpub wirft.
    const fs = require('fs');
    for (const p of stagedImagePaths) { try { fs.unlinkSync(p); } catch { /* schon weg */ } }
  }
  // Post-Step: Cover-Seite injizieren (wenn Cover) + TOC-Seite aus der Spine
  // entfernen (wenn epub_toc_enabled=false). _finalizeEpub reicht ohne Patch
  // durch (kein Rezip).
  const coverFit = meta?.epub_cover_fit === 'cover' ? 'cover' : 'contain';
  const tocEnabled = meta?.epub_toc_enabled !== false;
  return _finalizeEpub(buffer, { coverData, lang, coverFit, removeTocFromSpine: !tocEnabled });
}

module.exports = { buildEpub, _resolveEpubMeta, _countUnfetchableImages, _buildFrontmatter, _buildBackmatter, _buildImprintBackmatter, _buildExtraSections, _proseToXhtml, _buildOpfExtraMeta, _buildAccessibilityMeta, _buildLandmarksNav, _buildContentOPF, _buildCoverXhtml, _buildCss, _applyBreaks, _dedupeIds };
