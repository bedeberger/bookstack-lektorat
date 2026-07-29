const path = require('path');
const { pathToFileURL } = require('url');
const { parseHTML } = require('linkedom');
const { cleanPageHtml } = require('./html-clean');
const {
  BIBLIOGRAPHY_MARKER_CLASS, BIBLIOGRAPHY_MARKER_SEL,
  bibliographyVisible, bibliographySectionHtml,
} = require('./bibliography');

const WP_COMMENT_RE = /<!--\s*\/?\s*wp:[^>]*-->/g;

// Nicht round-trip-faehige Einbettungen: werden bei Import wie Export verworfen.
// Bilder (`img`/`figure`) sind bewusst NICHT hier — die bleiben erhalten.
const _DROP_EMBEDS = 'video, audio, iframe, embed, object, picture, source';
// Auf `<img>` erhaltene Attribute (Rest wird gestrippt: srcset/sizes/width/height/
// loading/decoding/style… bleiben WP ueberlassen).
const _IMG_KEEP_ATTRS = new Set(['src', 'alt', 'class']);

// Chip-Selektoren kommen aus der SSoT public/js/sources/cite-html.js (ESM, per
// dynamic import wie in lib/cite-index.js / lib/bibliography.js) — deshalb ist
// wpToAppHtml async. Bewusst KEINE Selektor-Kopie hier: eine dritte Kopie waere
// eine dritte Driftstelle, und der Import-Weg ist auf dem Server frei (das Modul
// muss nur im Browser pre-auth-tauglich bleiben, nicht hier).
let _citePromise = null;
function _citeModule() {
  if (!_citePromise) {
    const file = path.resolve(__dirname, '..', 'public', 'js', 'sources', 'cite-html.js');
    _citePromise = import(pathToFileURL(file).href);
  }
  return _citePromise;
}

function _parseRoot(html) {
  const wrapped = `<!DOCTYPE html><html><body><div id="r">${html}</div></body></html>`;
  const { document } = parseHTML(wrapped);
  return document.getElementById('r');
}

function _escAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// WP-Attachment-ID eines <img>: explizit via data-wp-id, sonst aus der
// `wp-image-<n>`-Klasse (bleibt beim Import erhalten, siehe _filterClasses).
function _imgId(img) {
  const explicit = img.getAttribute('data-wp-id');
  if (explicit && /^\d+$/.test(explicit)) return Number(explicit);
  const cls = img.getAttribute('class') || '';
  const m = /\bwp-image-(\d+)\b/.exec(cls);
  return m ? Number(m[1]) : null;
}

/** Quellen-Chip ohne `data-src` zu reinem Text degradieren.
 *
 *  WordPress' KSES entfernt `data-*`-Attribute, wenn der verbundene Benutzer die
 *  Capability `unfiltered_html` nicht hat (bei Multisite haben sie auch Admins
 *  nicht). Dann kommt vom Pull ein `<span class="cite">(Müller, 2020, S. 44)</span>`
 *  ohne Zeiger zurueck: eine Quellenangabe, die auf nichts zeigt.
 *
 *  Wir raten NIE auf eine Quelle — nicht ueber den Chip-Text, nicht ueber die
 *  Quellenliste des Buchs. Der Text ist ausdruecklich nur ein Cache
 *  (public/js/sources/cite-html.js), zwei Quellen desselben Autors im selben Jahr
 *  sind darin nicht unterscheidbar, und ein falscher Zeiger waere schlimmer als
 *  gar keiner: er landete unbemerkt im Verzeichnis. Also bleibt der lesbare Text
 *  als Klartext im Satz stehen und der Fall wird gezaehlt. */
async function _degradeCitesWithoutPointer(root, stats) {
  const { CITE_CLASS, CITE_ATTR_SRC, isCiteEl } = await _citeModule();
  let degraded = 0;
  for (const el of Array.from(root.querySelectorAll(`span.${CITE_CLASS}`))) {
    if (isCiteEl(el)) continue;              // Zeiger intakt — nichts zu tun.
    if (!el.hasAttribute(CITE_ATTR_SRC)) degraded++;
    el.replaceWith(...Array.from(el.childNodes));
  }
  if (degraded && stats && typeof stats === 'object') {
    stats.citesDegraded = (stats.citesDegraded || 0) + degraded;
  }
  return degraded;
}

/** WordPress-Post-HTML → App-Seiten-HTML.
 *
 *  `stats` ist ein optionales Out-Objekt: `citesDegraded` zaehlt die Chips, die
 *  ohne Zeiger zurueckkamen (siehe _degradeCitesWithoutPointer). Der Pull-Job
 *  reicht es an den User weiter — stumm waere es die schlechteste Variante, weil
 *  der Verlust erst Wochen spaeter im Verzeichnis auffaellt. */
async function wpToAppHtml(raw, stats = null) {
  if (!raw || typeof raw !== 'string') return '';
  const html = raw.replace(WP_COMMENT_RE, '');
  const root = _parseRoot(html);
  if (!root) return '';

  // Ein vom Push angehaengtes Quellenverzeichnis ist ein Render-Artefakt und darf
  // NIE als Seitentext zurueckkommen (siehe BIBLIOGRAPHY_MARKER_CLASS): sonst
  // steht es nach dem Pull im Manuskript und der naechste Push haengt ein zweites
  // an. Muss vor dem Klassenfilter laufen, der `wp-block-group` entfernt — die
  // Marker-Klasse selbst ueberlebt ihn, aber die Reihenfolge soll nicht davon
  // abhaengen.
  root.querySelectorAll(BIBLIOGRAPHY_MARKER_SEL).forEach(n => n.remove());

  await _degradeCitesWithoutPointer(root, stats);

  root.querySelectorAll(_DROP_EMBEDS).forEach(n => n.remove());
  // <img> auf ein schlankes Attribut-Set reduzieren (src/alt/class).
  root.querySelectorAll('img').forEach(img => {
    for (const attr of Array.from(img.attributes)) {
      if (!_IMG_KEEP_ATTRS.has(attr.name.toLowerCase())) img.removeAttribute(attr.name);
    }
  });
  // Figuren ohne Bild (z.B. ehemalige Video-/Embed-Wrapper) fallen weg.
  root.querySelectorAll('figure').forEach(fig => {
    if (!fig.querySelector('img')) fig.remove();
  });
  root.querySelectorAll('[style]').forEach(n => n.removeAttribute('style'));
  root.querySelectorAll('[class]').forEach(n => {
    const keep = (n.getAttribute('class') || '')
      .split(/\s+/)
      // `wp-image-<n>` bleibt: traegt die Attachment-ID fuer einen sauberen
      // Push-Round-Trip. Uebrige wp-/has-/is-style-Utility-Klassen fliegen raus.
      .filter(c => c && (/^wp-image-\d+$/.test(c) || (!/^wp-/.test(c) && !/^has-/.test(c) && !/^is-style-/.test(c))))
      .join(' ');
    if (keep) n.setAttribute('class', keep);
    else n.removeAttribute('class');
  });

  return cleanPageHtml(root.innerHTML);
}

function _serializeInline(node) {
  return node.innerHTML;
}

// Gutenberg-`wp:image`-Block aus einem <img> (evtl. in <figure> mit <figcaption>).
function _imageBlock(img, caption) {
  const src = img && img.getAttribute('src');
  if (!src) return '';
  const id = _imgId(img);
  const alt = img.getAttribute('alt') || '';
  const attrs = id ? ` {"id":${id},"sizeSlug":"full"}` : '';
  const imgClass = id ? ` class="wp-image-${id}"` : '';
  const cap = caption && caption.trim()
    ? `<figcaption class="wp-element-caption">${caption}</figcaption>`
    : '';
  return `<!-- wp:image${attrs} -->\n<figure class="wp-block-image size-full"><img src="${_escAttr(src)}" alt="${_escAttr(alt)}"${imgClass}/>${cap}</figure>\n<!-- /wp:image -->`;
}

function _wrapBlock(el) {
  const tag = el.tagName ? el.tagName.toLowerCase() : '';
  switch (tag) {
    case 'p':
      return `<!-- wp:paragraph -->\n<p>${_serializeInline(el)}</p>\n<!-- /wp:paragraph -->`;
    case 'h1':
      return `<!-- wp:heading {"level":1} -->\n<h1 class="wp-block-heading">${_serializeInline(el)}</h1>\n<!-- /wp:heading -->`;
    case 'h2':
      return `<!-- wp:heading -->\n<h2 class="wp-block-heading">${_serializeInline(el)}</h2>\n<!-- /wp:heading -->`;
    case 'h3':
      return `<!-- wp:heading {"level":3} -->\n<h3 class="wp-block-heading">${_serializeInline(el)}</h3>\n<!-- /wp:heading -->`;
    case 'h4':
      return `<!-- wp:heading {"level":4} -->\n<h4 class="wp-block-heading">${_serializeInline(el)}</h4>\n<!-- /wp:heading -->`;
    case 'ul':
    case 'ol': {
      const ordered = tag === 'ol';
      const attrs = ordered ? ' {"ordered":true}' : '';
      const itemHtml = Array.from(el.children)
        .filter(c => c.tagName && c.tagName.toLowerCase() === 'li')
        .map(li => `<!-- wp:list-item -->\n<li>${_serializeInline(li)}</li>\n<!-- /wp:list-item -->`)
        .join('\n');
      const wrap = ordered ? `<ol>\n${itemHtml}\n</ol>` : `<ul>\n${itemHtml}\n</ul>`;
      return `<!-- wp:list${attrs} -->\n${wrap}\n<!-- /wp:list -->`;
    }
    case 'blockquote': {
      // `data-src` (belegtes Blockzitat, Markup-SSoT public/js/sources/cite-html.js)
      // wandert mit in den Gutenberg-Block. Nicht der Optik wegen — WordPress
      // stylet nach eigenem Theme —, sondern weil der Blog-Sync zurueckliest
      // (LWW-Pull): ohne den Zeiger im Post-HTML verliert das Blockzitat beim
      // naechsten Pull seine Quelle und faellt aus dem Zitat-Anteil heraus.
      const src = el.getAttribute('data-src');
      const srcAttr = /^\d+$/.test(String(src || '')) ? ` data-src="${src}"` : '';
      return `<!-- wp:quote -->\n<blockquote class="wp-block-quote"${srcAttr}>${el.innerHTML}</blockquote>\n<!-- /wp:quote -->`;
    }
    case 'pre':
      return `<!-- wp:code -->\n<pre class="wp-block-code">${_serializeInline(el)}</pre>\n<!-- /wp:code -->`;
    case 'hr':
      return `<!-- wp:separator -->\n<hr class="wp-block-separator has-alpha-channel-opacity"/>\n<!-- /wp:separator -->`;
    case 'figure': {
      const img = el.querySelector('img');
      const figcap = el.querySelector('figcaption');
      return _imageBlock(img, figcap ? figcap.innerHTML : '');
    }
    case 'img':
      return _imageBlock(el, '');
    case 'video':
    case 'audio':
    case 'iframe':
    case 'embed':
    case 'object':
    case 'picture':
      return '';
    default: {
      const text = (el.textContent || '').trim();
      if (!text) return '';
      return `<!-- wp:paragraph -->\n<p>${_serializeInline(el)}</p>\n<!-- /wp:paragraph -->`;
    }
  }
}

// Quellenverzeichnis als Gutenberg-Blocks, umschlossen von einem `wp:group` mit
// der Marker-Klasse. Der Group-Wrapper ist der Anker fuer den Pull-Strip in
// wpToAppHtml — beides steht bewusst in DIESER Datei nebeneinander, damit die
// Akkumulations-Invariante nicht auf zwei Module verteilt ist.
//
// Gutenberg schreibt `className` in die Klassenliste des gerenderten `<div>`
// (`wp-block-group sw-bibliography`), sodass der Marker sowohl in `content.raw`
// als auch in `content.rendered` wiederzufinden ist.
//
// Ueberschrift und Eintraege kommen aus der geteilten SSoT
// (lib/bibliography.js#bibliographySectionHtml) und werden durch denselben
// Block-Emitter wie der Seitentext geschickt: h2 → wp:heading, ul → wp:list,
// p → wp:paragraph.
function _bibliographyBlocks(bib) {
  if (!bibliographyVisible(bib)) return '';
  const section = bibliographySectionHtml(bib, { list: true });
  const inner = _emitBlocks(_parseRoot(section));
  if (!inner) return '';
  return `<!-- wp:group {"className":"${BIBLIOGRAPHY_MARKER_CLASS}"} -->\n`
       + `<div class="wp-block-group ${BIBLIOGRAPHY_MARKER_CLASS}">\n${inner}\n</div>\n`
       + '<!-- /wp:group -->';
}

function _withBibliography(blocks, bib) {
  const bibBlocks = _bibliographyBlocks(bib);
  if (!bibBlocks) return blocks;
  return blocks ? `${blocks}\n\n${bibBlocks}` : bibBlocks;
}

function _emitBlocks(root) {
  const blocks = [];
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType !== 1) continue;
    const wrapped = _wrapBlock(child);
    if (wrapped) blocks.push(wrapped);
  }
  return blocks.join('\n\n');
}

/** App-Seiten-HTML → Gutenberg-Blocks.
 *
 *  `bibliography` (Rueckgabe von buildBibliography, Einheit = diese eine Seite)
 *  haengt das Quellenverzeichnis als markierten Block an. Nur uebergeben, wenn
 *  `bibliography_enabled && bibliography_in_blog` gilt — die Sichtbarkeitspruefung
 *  auf leere Eintraege macht bibliographyVisible. */
function appToWpHtml(html, { bibliography = null } = {}) {
  if (!html || typeof html !== 'string') return _withBibliography('', bibliography);
  const root = _parseRoot(html);
  if (!root) return _withBibliography('', bibliography);
  return _withBibliography(_emitBlocks(root), bibliography);
}

// Wie appToWpHtml, aber mit vorgelagertem async Media-Pass: jedes <img> wird
// durch `resolveImage(src)` geschleust. Rueckgabe `{ src, id }` ersetzt src (und
// setzt data-wp-id fuer den Block-Emitter); `null` entfernt das Bild. So laedt der
// Push-Job data-URIs / fremd-gehostete Bilder in die WP-Mediathek hoch, waehrend
// bereits blog-gehostete Bilder unangetastet bleiben (siehe lib/wp-media.js).
async function appToWpHtmlWithMedia(html, { resolveImage, bibliography = null } = {}) {
  if (!html || typeof html !== 'string') return _withBibliography('', bibliography);
  const root = _parseRoot(html);
  if (!root) return _withBibliography('', bibliography);
  if (typeof resolveImage === 'function') {
    for (const img of Array.from(root.querySelectorAll('img'))) {
      const src = img.getAttribute('src') || '';
      let resolved = null;
      try { resolved = await resolveImage(src); }
      catch { resolved = null; }
      if (!resolved || !resolved.src) { img.remove(); continue; }
      img.setAttribute('src', resolved.src);
      if (resolved.id != null) img.setAttribute('data-wp-id', String(resolved.id));
    }
    // Figuren, deren Bild verworfen wurde, fallen weg.
    root.querySelectorAll('figure').forEach(fig => {
      if (!fig.querySelector('img')) fig.remove();
    });
  }
  return _withBibliography(_emitBlocks(root), bibliography);
}

module.exports = { wpToAppHtml, appToWpHtml, appToWpHtmlWithMedia, WP_COMMENT_RE };
