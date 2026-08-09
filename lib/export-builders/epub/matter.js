'use strict';
// Titelei und Backmatter des EPUB: Titelseite, Impressum, Widmung, Motto,
// Quellenverzeichnis, Autor-Bio und die freien Vor-/Nachsatz-Seiten. Alle
// Eintraege sind gewoehnliche epub-gen-memory-Kapitel; `__toc:false` haelt sie
// aus dem Inhaltsverzeichnis, `beforeToc` sortiert sie davor.

const { escXml } = require('../shared');
const { bibliographyItemHtml } = require('../../bibliography');

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

module.exports = {
  _proseToXhtml,
  _buildFrontmatter,
  _buildImprintBackmatter,
  _bibliographySection,
  _buildBackmatter,
  _buildExtraSections,
};
