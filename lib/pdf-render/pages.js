'use strict';
// Spezial-Seiten: Cover (Vollbild + optional Title-Overlay), Title-Page, Widmung,
// Impressum, TOC. TOC liefert Two-Pass-Positionen — der Body-Render schreibt
// die Pagenummern später an diese Anker.

const sharp = require('sharp');
const { MM_TO_PT, _currentPageIdx } = require('./layout');
const { drawEan13, isValidEan13 } = require('../pdf-barcode');

const _TOC_DEFAULT_TITLE = {
  de: 'Inhaltsverzeichnis',
  en: 'Table of Contents',
};

const _AUTHOR_PAGE_TITLE = {
  de: 'Über den Autor',
  en: 'About the Author',
};

// Fallback fuer den reservierten Platz rechts in der TOC-Zeile (in pt), falls
// kein Config-Wert vorliegt (~14 mm).
const TOC_PAGENUM_RESERVE_FALLBACK_PT = 14 * MM_TO_PT;

// Bricht `text` auf die verfügbare Breite `maxW` (pt) um (greedy Word-Wrap).
// Deterministische Alternative zu pdfkit's Wrapper: der ignoriert
// `lineBreak:false`, sobald `width` gesetzt ist, und truncated nur mit
// zusätzlichem `height` — das wiederum bricht die Auto-Seitenumbrüche. Darum
// wickeln wir selbst und setzen jede Zeile positioniert. Ein Wort, das breiter
// als die Spalte ist, wird hart nach Zeichen getrennt (Notfallpfad für lange
// Komposita/URLs). Setzt voraus, dass Font + fontSize am `doc` bereits gesetzt
// sind (widthOfString misst mit dem aktuellen Font). Liefert immer ≥ 1 Zeile.
function _wrapTocLines(doc, text, maxW) {
  const s = String(text ?? '').trim();
  if (!s || maxW <= 0) return [s];
  if (doc.widthOfString(s) <= maxW) return [s];
  const lines = [];
  let cur = '';
  const push = (l) => { if (l) lines.push(l); };
  for (const word of s.split(/\s+/)) {
    const trial = cur ? `${cur} ${word}` : word;
    if (doc.widthOfString(trial) <= maxW) { cur = trial; continue; }
    push(cur);
    if (doc.widthOfString(word) > maxW) {
      let part = '';
      for (const ch of word) {
        if (part && doc.widthOfString(part + ch) > maxW) { push(part); part = ch; }
        else part += ch;
      }
      cur = part;
    } else {
      cur = word;
    }
  }
  push(cur);
  return lines.length ? lines : [s];
}

async function _renderCover(doc, cover, coverImageBuf) {
  if (!cover.enabled || !coverImageBuf) return false;
  // Vollbild — wir fügen eine Page ohne Margins ein.
  const oldMargins = doc.page.margins;
  doc.page.margins = { top: 0, right: 0, bottom: 0, left: 0 };
  const pageW = doc.page.width;
  const pageH = doc.page.height;
  const meta = await sharp(coverImageBuf).metadata();
  const fitCover = cover.fit === 'cover';
  const imgRatio = meta.width / meta.height;
  const pageRatio = pageW / pageH;
  let drawW, drawH, drawX, drawY;
  if (fitCover ? imgRatio > pageRatio : imgRatio < pageRatio) {
    drawH = pageH; drawW = drawH * imgRatio;
  } else {
    drawW = pageW; drawH = drawW / imgRatio;
  }
  drawX = (pageW - drawW) / 2;
  drawY = (pageH - drawH) / 2;
  doc.image(coverImageBuf, drawX, drawY, { width: drawW, height: drawH });
  doc.page.margins = oldMargins;
  return true;
}

function _renderTitlePage(doc, book, config, overrides = {}) {
  doc.addPage();
  const f = config.font;
  const pageW = doc.page.width;
  const left = doc.page.margins.left;
  const usableW = pageW - left - doc.page.margins.right;
  const startY = doc.page.height * 0.30;
  doc.y = startY;
  const title = overrides.title ?? (book.name || '');
  const subtitle = overrides.subtitle ?? config.extras.subtitle ?? '';
  doc.font('title').fontSize(f.title.sizePt).fillColor(f.title.color || '#000000')
     .text(title, left, doc.y, { width: usableW, align: 'center' });
  if (subtitle) {
    doc.moveDown(0.6);
    doc.font('subtitle').fontSize(f.subtitle.sizePt).fillColor(f.subtitle.color || '#000000')
       .text(subtitle, left, doc.y, { width: usableW, align: 'center' });
  }
  doc.moveDown(2);
  const author = String(config.extras?.authorName || '').trim()
    || book.created_by?.name || book.owned_by?.name || '';
  if (author) {
    doc.font('byline').fontSize(f.byline.sizePt).fillColor(f.byline.color || '#000000')
       .text(author, left, doc.y, { width: usableW, align: 'center' });
  }
  const year = config.extras.year;
  if (year) {
    doc.moveDown(0.4);
    doc.font('year').fontSize(f.year.sizePt).fillColor(f.year.color || '#000000')
       .text(year, left, doc.y, { width: usableW, align: 'center' });
  }
}

// Widmung-Seite: zentriert, kursiv, kleiner Text, ~40 %-Höhe.
function _renderDedicationPage(doc, config) {
  if (!config.extras.dedication) return;
  doc.addPage();
  const f = config.font;
  const pageW = doc.page.width;
  const left = doc.page.margins.left;
  const usableW = pageW - left - doc.page.margins.right;
  doc.y = doc.page.height * 0.40;
  doc.font('dedication').fontSize(f.dedication.sizePt).fillColor(f.dedication.color || '#000000');
  doc.text(config.extras.dedication, left, doc.y, {
    width: usableW, align: 'center',
    lineGap: (f.body.lineHeight - 1) * f.dedication.sizePt,
  });
}

function _imprintHasContent(config) {
  const e = config.extras;
  return !!(e.copyright || e.imprint || e.isbn);
}

// Impressum-/Copyright-Seite: linksbündig, Impressum-Schrift, mehrzeilig.
// Reihenfolge: Copyright-Zeile, Impressum-Freitext, ISBN. Position (Frontmatter
// auf der Titelseiten-Rückseite vs. ans Buchende) steuert der Aufrufer über
// extras.imprintPosition. Der Block wird am Seitenfuss verankert (Buchkonvention:
// Impressum sitzt unten, nicht oben beginnend). Gibt true zurück, wenn eine Seite
// gerendert wurde.
function _renderImprintPage(doc, config) {
  if (!_imprintHasContent(config)) return false;
  doc.addPage();
  const f = config.font;
  const e = config.extras;
  const left = doc.page.margins.left;
  const usableW = doc.page.width - left - doc.page.margins.right;
  const lineGap = (f.body.lineHeight - 1) * f.imprint.sizePt;
  doc.font('imprint').fontSize(f.imprint.sizePt).fillColor(f.imprint.color || '#000000');
  // Blockhöhe vormessen und Startpunkt so setzen, dass der Text am unteren
  // Satzspiegel endet. Bei ISBN-Barcode sitzt der Text über dem Barcode-Band.
  const hasBarcode = e.barcode && e.isbn && isValidEan13(e.isbn);
  const gap = 0.8 * doc.currentLineHeight();
  const parts = [];
  if (e.copyright) parts.push(e.copyright);
  if (e.imprint) parts.push(e.imprint);
  if (e.isbn) parts.push(`ISBN ${e.isbn}`);
  let blockH = 0;
  parts.forEach((p, i) => {
    blockH += doc.heightOfString(p, { width: usableW, lineGap });
    if (i < parts.length - 1) blockH += gap;
  });
  const bottomLimit = hasBarcode
    ? doc.page.height - doc.page.margins.bottom - (32 + 8) * MM_TO_PT
    : doc.page.height - doc.page.margins.bottom;
  doc.y = Math.max(doc.page.margins.top, bottomLimit - blockH);
  if (e.copyright) {
    doc.text(e.copyright, left, doc.y, { width: usableW, align: 'left', lineGap });
    doc.moveDown(0.8);
  }
  if (e.imprint) {
    doc.text(e.imprint, left, doc.y, { width: usableW, align: 'left', lineGap });
    doc.moveDown(0.8);
  }
  if (e.isbn) {
    // "ISBN" ist ein internationaler Standard-Präfix (sprachunabhängig).
    doc.text(`ISBN ${e.isbn}`, left, doc.y, { width: usableW, align: 'left', lineGap });
  }
  // EAN-13-Barcode aus der ISBN unten links auf der Impressum-Seite. Nur bei
  // gültiger Nummer; menschenlesbare Ziffern in der Impressum-Schrift.
  if (hasBarcode) {
    // Absolut am Seitenfuss positioniert. 32 mm reservieren, damit die
    // menschenlesbare Ziffern-Zeile (Symbolhöhe @ SC2 ~28 mm) komplett über dem
    // Bodenrand bleibt — sonst löst doc.text einen Auto-Seitenumbruch aus.
    const bottom = doc.page.height - doc.page.margins.bottom;
    const bcY = bottom - 32 * MM_TO_PT;
    drawEan13(doc, left, bcY, e.isbn, {
      font: 'imprint', color: f.imprint.color || '#000000',
    });
  }
  return true;
}

// Frontmatter-Seite (Motto/Epigraph/kurzes Vorwort): zentriert, ~35 %-Höhe.
// Wird nach der Titelseite, vor Widmung/TOC eingefügt.
function _renderFrontMatterPage(doc, config) {
  if (!config.extras.frontMatter) return;
  doc.addPage();
  const f = config.font;
  const fm = f.frontMatter || f.dedication;
  const left = doc.page.margins.left;
  const usableW = doc.page.width - left - doc.page.margins.right;
  doc.y = doc.page.height * 0.35;
  doc.font('frontMatter').fontSize(fm.sizePt).fillColor(fm.color || '#000000');
  doc.text(config.extras.frontMatter, left, doc.y, {
    width: usableW, align: 'center',
    lineGap: (f.body.lineHeight - 1) * fm.sizePt,
  });
}

// "Über den Autor"-Seite (Backmatter): lokalisierte Überschrift, optionales
// Autorfoto (zentriert), Bio-Text darunter. authorImageBuf ist bereits
// sharp-normalisiert (JPEG, sRGB, kein Alpha). Gibt true zurück, wenn gerendert.
async function _renderAuthorPage(doc, config, lang, authorImageBuf) {
  if (!config.extras.authorBio && !authorImageBuf) return false;
  doc.addPage();
  const f = config.font;
  const ab = f.authorBio || f.body;
  const left = doc.page.margins.left;
  const usableW = doc.page.width - left - doc.page.margins.right;
  doc.y = doc.page.margins.top;

  const title = _AUTHOR_PAGE_TITLE[lang] || _AUTHOR_PAGE_TITLE.de;
  const headingColor = f.heading.color || '#000000';
  doc.font('heading').fontSize(f.heading.sizes.h2).fillColor(headingColor)
     .text(title, left, doc.y, { width: usableW, align: 'left' });
  doc.moveDown(1);

  if (authorImageBuf) {
    try {
      const meta = await sharp(authorImageBuf).metadata();
      const ratio = meta.width / meta.height;
      // Foto auf max. 55 mm Breite bzw. 70 mm Höhe begrenzen, zentriert.
      const maxW = 55 * MM_TO_PT;
      const maxH = 70 * MM_TO_PT;
      let drawW = Math.min(maxW, usableW);
      let drawH = drawW / ratio;
      if (drawH > maxH) { drawH = maxH; drawW = drawH * ratio; }
      const drawX = left + (usableW - drawW) / 2;
      doc.image(authorImageBuf, drawX, doc.y, { width: drawW, height: drawH });
      doc.y += drawH + 14;
    } catch { /* korruptes Bild: Foto überspringen, Bio trotzdem rendern */ }
  }

  if (config.extras.authorBio) {
    doc.font('authorBio').fontSize(ab.sizePt).fillColor(ab.color || '#000000');
    doc.text(config.extras.authorBio, left, doc.y, {
      width: usableW, align: 'left',
      lineGap: (f.body.lineHeight - 1) * ab.sizePt,
    });
  }
  return true;
}

// TOC rendering. Reserviert auf der rechten Seite Platz für die nachträglich
// eingestempelte Seitenzahl (Two-Pass: Body-Render kennt erst nach Render
// die effektiven Pagenummern). Liefert `positions[]` aligned mit den
// gerenderten Einträgen — jede Position hält die Buffered-Page-ID + Y, an der
// die Seitenzahl später überschrieben werden kann.
//
// Formatierung kommt aus font.toc/tocTitle + toc.titleAlign/indentMm/leader/
// pageNumReserveMm (defaults in lib/pdf-export-defaults.js).
//
// Einträge tragen `level` (Einrückungsstufe, 0-basiert) und für Seiten zusätzlich
// `isPage` + `parentLevel` — die Seiten-Achse hängt an `toc.includePages`, nicht
// an `toc.depth` (das zählt Kapitelebenen).
// Sichtbarkeit eines Verzeichnis-Eintrags. ZWEI getrennte Achsen (siehe
// lib/pdf-export-defaults.js):
//   Kapitel  → `toc.depth` (1..3 Kapitelebenen)
//   Seiten   → `toc.includePages`, zusaetzlich gebunden an die Sichtbarkeit
//              IHRES Kapitels: ein Verzeichnis, das die Seite zeigt, das Kapitel
//              darueber aber verschweigt, waere unlesbar.
// Warum getrennt: eine Seite in einem Sub-Sub-Kapitel liegt auf Einrueckungs-
// Ebene 4 und faellt sonst durch jede erlaubte Kapiteltiefe.
function tocEntryVisible(entry, toc) {
  const maxLevel = toc.depth - 1;
  if (entry.isPage) return toc.includePages !== false && entry.parentLevel <= maxLevel;
  return entry.level <= maxLevel;
}

function _renderToc(doc, toc, entries, lang, font) {
  if (!toc.enabled) return [];
  doc.addPage();
  const fallback = _TOC_DEFAULT_TITLE[lang] || _TOC_DEFAULT_TITLE.de;

  const tocBody = font?.toc || {};
  const tocTitleFont = font?.tocTitle || {};
  const titleColor = tocTitleFont.color || font?.heading?.color || '#000000';
  const bodyColor  = tocBody.color || font?.body?.color || '#000000';
  const titleSize  = tocTitleFont.sizePt || 20;
  const bodySize   = tocBody.sizePt || 11;
  const lineHeight = tocBody.lineHeight || 1.45;
  const lineGap    = Math.max(0, (lineHeight - 1) * bodySize);
  const paragraphGapPt = (tocBody.paragraphGap || 0) * bodySize;
  const titleAlign = ['left', 'center', 'right'].includes(toc.titleAlign) ? toc.titleAlign : 'center';
  const indentPt   = Math.max(0, (toc.indentMm ?? 6) * MM_TO_PT);
  const reservePt  = toc.showPageNumbers
    ? Math.max(0, (toc.pageNumReserveMm ?? 14) * MM_TO_PT)
    : 0;
  const leader = ['none', 'dots', 'line'].includes(toc.leader) ? toc.leader : 'none';

  doc.font('toc-title').fontSize(titleSize).fillColor(titleColor)
     .text(toc.title || fallback, { align: titleAlign });
  doc.moveDown(1);
  doc.font('toc').fontSize(bodySize).fillColor(bodyColor);

  // Nummern-Spalte: breiteste Ziffernmarke über alle Einträge messen, damit
  // alle Titel unabhängig von der Ziffernbreite ("1." vs. "10.") an derselben
  // x-Position beginnen. Nummern werden rechtsbündig in dieser Spalte gesetzt
  // (Ziffern-/Punkt-Kante fluchtet), gefolgt von einem festen Abstand.
  const numLabels = entries.map(c => (c && c.num) ? `${c.num}.` : '');
  const maxNumW = numLabels.reduce((m, lbl) => lbl ? Math.max(m, doc.widthOfString(lbl)) : m, 0);
  const numGapPt = maxNumW > 0 ? Math.round(bodySize * 0.6) : 0;
  const numColW = maxNumW + numGapPt;

  const positions = [];
  // Zeilenvorschub wie im pdfkit-Wrapper (currentLineHeight inkl. Gap + lineGap)
  // und unterer Satzspiegel — beide für den manuellen Einzeiler-/Umbruch-Pfad.
  const lineStepPt = doc.currentLineHeight(true) + lineGap;
  const bottomLimit = doc.page.height - doc.page.margins.bottom;
  for (let ci = 0; ci < entries.length; ci++) {
    const c = entries[ci];
    if (!tocEntryVisible(c, toc)) {
      positions.push(null);
      continue;
    }
    // Geometrie der aktuellen Seite (bei mirrorMargins seitenabhängig).
    const geom = () => {
      const baseX = doc.page.margins.left + c.level * indentPt;
      const titleX = baseX + numColW;
      return { baseX, titleX, usableW: doc.page.width - titleX - doc.page.margins.right - reservePt };
    };
    // Passt der ganze (ggf. mehrzeilige) Eintrag nicht mehr auf die aktuelle
    // TOC-Seite → neue Seite, dann gegen deren Ränder neu wickeln: der
    // pageAdded-Hook spiegelt doc.page.margins bei mirrorMargins bereits
    // (Verso legt den Bundsteg nach aussen). So folgt eine mehrseitige TOC dem
    // Bund wie jede Body-Seite, und ein umgebrochener Eintrag wird nie über
    // zwei TOC-Seiten zerrissen.
    let g = geom();
    let lines = _wrapTocLines(doc, c.title, g.usableW);
    if (doc.y + lines.length * lineStepPt > bottomLimit) {
      doc.addPage();
      g = geom();
      lines = _wrapTocLines(doc, c.title, g.usableW);
    }
    const finalPageIdx = _currentPageIdx(doc);
    const firstY = doc.y;
    const { baseX, titleX, usableW } = g;

    // Titel zeilenweise ohne `width` schreiben → kein pdfkit-Wrapper, jede
    // Zeile ist positioniert und der Zeilenvorschub bleibt manuell steuerbar
    // (doc.text advanced in diesem Pfad doc.x, nicht doc.y). Fortsetzungszeilen
    // beginnen an derselben x-Position (hängender Einzug unter die Titel-Spalte).
    let y = firstY;
    for (const ln of lines) {
      doc.text(ln, titleX, y, { lineBreak: false });
      y += lineStepPt;
    }
    doc.y = y;
    // Seitenzahl + Leader hängen an der LETZTEN Zeile des Eintrags (klassischer
    // Verzeichnis-Look: die Leader-Linie verbindet Textende und Zahl).
    const lastY = firstY + (lines.length - 1) * lineStepPt;

    // Kapitel-/Seitennummer rechtsbündig in der Nummern-Spalte, auf der ersten
    // Zeile des Eintrags. Danach doc.y auf den Stand nach dem Titel-Write
    // zurücksetzen.
    const numLabel = numLabels[ci];
    if (numLabel) {
      const yAfterTitle = doc.y;
      doc.text(numLabel, baseX, firstY, { width: maxNumW, align: 'right', lineBreak: false });
      doc.y = yAfterTitle;
    }

    // Leader (Dots/Line) zwischen letzter Titel-Zeile und Seitenzahl-Reserve.
    if (leader !== 'none' && toc.showPageNumbers && reservePt > 0) {
      const baselineY = lastY + bodySize * 0.85;
      const titleWidth = Math.min(doc.widthOfString(lines[lines.length - 1]), usableW);
      const leaderStartX = titleX + titleWidth + 4;
      const leaderEndX = doc.page.width - doc.page.margins.right - reservePt - 4;
      if (leaderEndX > leaderStartX) {
        doc.save();
        doc.lineWidth(0.5).strokeColor(bodyColor);
        if (leader === 'dots') doc.dash(1, { space: 2 });
        doc.moveTo(leaderStartX, baselineY).lineTo(leaderEndX, baselineY).stroke();
        if (leader === 'dots') doc.undash();
        doc.restore();
      }
    }

    if (paragraphGapPt > 0) doc.y += paragraphGapPt;
    positions.push({ tocPageIdx: finalPageIdx, y: lastY });
  }
  doc.moveDown(1);
  return positions;
}

module.exports = {
  TOC_PAGENUM_RESERVE_FALLBACK_PT,
  tocEntryVisible,
  _wrapTocLines,
  _renderCover,
  _renderTitlePage,
  _renderDedicationPage,
  _renderFrontMatterPage,
  _renderAuthorPage,
  _renderImprintPage,
  _imprintHasContent,
  _renderToc,
};
