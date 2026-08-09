'use strict';
// Umschlagseite + der Post-Step an der fertigen ZIP. Beides laeuft bewusst AM
// Content-Sanitizer von epub-gen-memory vorbei (der lowercased Attribute und
// zerstoert damit die SVG-viewBox der Cover-Seite).

// Fuer das Nachtraegliche Injizieren der Cover-Seite in die fertige ZIP (gleiche
// Lib, die epub-gen-memory intern nutzt).
const JSZip = require('jszip');
const { escXml } = require('../shared');

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

module.exports = { _coverExt, _buildCoverXhtml, _finalizeEpub };
