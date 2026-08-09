'use strict';
// Navigation des EPUB: NCX-NavMap (EPUB2-Kompat), das nav.xhtml-Inhalts-
// verzeichnis und die EPUB3-Landmarks. Alle drei lesen dieselbe allChapters-
// Liste und respektieren `__toc` / `__level` / `__hasChildren`.

const { escXml } = require('../shared');

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

module.exports = { _buildNavMapXml, _buildTocXhtmlBody, _buildLandmarksNav };
