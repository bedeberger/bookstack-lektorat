'use strict';
// PDF-Renderer auf pdfkit. Nimmt geladene Buch-Inhalte (Output von
// loadBookContents in routes/export.js) und ein validiertes Profil-Config.
// Liefert ein finales PDF/A-2B-Buffer (PDF/A-Postprocess in lib/pdfa.js).
//
// Verantwortlichkeiten:
//  - Page-Setup (Größe, Margins) via PDFKit-Doc-Optionen
//  - Font-Bootstrapping: alle 5 Rollen-Fonts via lib/font-fetch laden + registerFont
//  - Cover-Page (optional, mit Title-Overlay)
//  - Title-Page (Titel + Subtitle + Byline)
//  - TOC-Outline (PDF-Bookmarks via doc.outline)
//  - Kapitel-Loop: per pageStructure 'flatten' oder 'nested' rendern
//  - Header/Footer pro Seite via 'pageAdded'-Event
//  - Block-Renderer für walker-Output (heading/paragraph/list/blockquote/poem/pre/image/hr)

const PDFDocument = require('pdfkit');
const sharp = require('sharp');
const { fetchFont } = require('./font-fetch');
const { parseHtmlToBlocks } = require('./pdf-html-walker');
const { bsGet, BOOKSTACK_URL, authHeader } = require('./bookstack');
const { applyPdfaMetadata } = require('./pdfa');
const logger = require('../logger');

const MM_TO_PT = 72 / 25.4;
const PAGE_DIMS_PT = {
  A4:     [595.28, 841.89],
  A5:     [419.53, 595.28],
  A6:     [297.64, 419.53],
  Letter: [612, 792],
};

function _pageSize(layout) {
  if (layout.pageSize === 'custom') {
    return [layout.customWidthMm * MM_TO_PT, layout.customHeightMm * MM_TO_PT];
  }
  return PAGE_DIMS_PT[layout.pageSize] || PAGE_DIMS_PT.A4;
}

function _romanize(num) {
  if (num <= 0) return String(num);
  const map = [['M',1000],['CM',900],['D',500],['CD',400],['C',100],['XC',90],['L',50],['XL',40],['X',10],['IX',9],['V',5],['IV',4],['I',1]];
  let out = '';
  for (const [r, v] of map) while (num >= v) { out += r; num -= v; }
  return out;
}

function _wordize(num) {
  // Sehr einfache Variante für Kapitel 1-20 — danach Fallback auf arabisch.
  const W = ['', 'Eins', 'Zwei', 'Drei', 'Vier', 'Fünf', 'Sechs', 'Sieben', 'Acht', 'Neun',
             'Zehn', 'Elf', 'Zwölf', 'Dreizehn', 'Vierzehn', 'Fünfzehn', 'Sechzehn',
             'Siebzehn', 'Achtzehn', 'Neunzehn', 'Zwanzig'];
  return W[num] || String(num);
}

function _chapterLabel(numbering, idx) {
  switch (numbering) {
    case 'arabic': return String(idx);
    case 'roman':  return _romanize(idx);
    case 'word':   return _wordize(idx);
    default:       return null;
  }
}

// Tokens für Header/Footer:
//   {title}     – Buchtitel (book.name)
//   {author}    – Autorname
//   {chapter}   – Aktueller Kapitelname (textuell)
//   {pageTitle} – Aktueller BookStack-Seitenname (textuell), Fallback Kapitel
//   {page}      – Aktuelle Seitenzahl (Zahl, ab pageNumberStart)
//   {pages}     – Gesamtanzahl Body-Seiten (Zahl)
function _replaceTokens(s, ctx) {
  return String(s || '')
    .replace(/\{title\}/g,     ctx.title || '')
    .replace(/\{author\}/g,    ctx.author || '')
    .replace(/\{chapter\}/g,   ctx.chapter || '')
    .replace(/\{pageTitle\}/g, ctx.pageTitle || ctx.chapter || '')
    .replace(/\{page\}/g,      ctx.page != null ? String(ctx.page) : '')
    .replace(/\{pages\}/g,     ctx.pages != null ? String(ctx.pages) : '');
}

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

  await Promise.all(tasks);
}

// Bilder aus BookStack über Server-Token ziehen, in JPEG/PNG-Buffer normieren.
// `imageCache` verhindert Doppel-Fetch + Doppel-Decode bei mehrfach
// referenzierten Bildern (Logo, wiederholte Inline-Grafiken).
async function _fetchImage(src, token, imageCache) {
  if (imageCache?.has(src)) return imageCache.get(src);
  let url = src;
  if (src.startsWith('/')) url = `${BOOKSTACK_URL}${src}`;
  if (!/^https?:\/\//i.test(url)) {
    imageCache?.set(src, null);
    return null;
  }
  try {
    const headers = {};
    if (token && url.startsWith(BOOKSTACK_URL)) headers['Authorization'] = authHeader(token);
    const r = await fetch(url, { headers });
    if (!r.ok) { imageCache?.set(src, null); return null; }
    const ab = await r.arrayBuffer();
    // sharp normalisiert: kein Alpha, sRGB, JPEG (PDF/A-tauglich)
    const out = await sharp(Buffer.from(ab))
      .rotate()
      .flatten({ background: '#ffffff' })
      .toColorspace('srgb')
      .jpeg({ quality: 85 })
      .withMetadata({ icc: 'srgb' })
      .toBuffer({ resolveWithObject: true });
    const result = { buffer: out.data, width: out.info.width, height: out.info.height };
    imageCache?.set(src, result);
    return result;
  } catch (e) {
    logger.warn(`pdf-render: image fetch failed for ${src} (${e.message})`);
    imageCache?.set(src, null);
    return null;
  }
}

// ── Block-Renderer ──────────────────────────────────────────────────────────
function _runFontKey(run) {
  if (run.bold && run.italic) return 'body-bolditalic';
  if (run.bold)   return 'body-bold';
  if (run.italic) return 'body-italic';
  return 'body';
}

function _renderRuns(doc, runs, opts) {
  const { sizePt, lineHeight, align = 'justify', linkColor = '#1a4d8f', columns = 1, columnGap = 0 } = opts;
  // pdfkit `text` mit `continued: true` für inline-runs.
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    const isLast = i === runs.length - 1;
    doc.font(_runFontKey(r)).fontSize(sizePt);
    const textOpts = {
      continued: !isLast,
      align,
      lineGap: (lineHeight - 1) * sizePt,
      underline: !!r.underline,
    };
    if (columns > 1) {
      textOpts.columns = columns;
      textOpts.columnGap = columnGap;
    }
    if (r.link) {
      doc.fillColor(linkColor);
      textOpts.link = r.link;
    } else {
      doc.fillColor('#000000');
    }
    doc.text(r.text, textOpts);
  }
  doc.fillColor('#000000');
}

// DropCap: erstes Buchstaben in 3-Zeilen-Höhe links neben den ersten zwei
// Body-Zeilen rendern. pdfkit positioniert Initial absolut, Body schreibt
// dann mit indentationLeft an pdfkit-Text-Optionen.
async function _renderDropCap(doc, runs, font) {
  // Erstes nicht-leeres Zeichen finden
  let firstChar = '';
  let charRun = null;
  for (const r of runs) {
    const m = (r.text || '').match(/\S/);
    if (m) { firstChar = m[0]; charRun = r; break; }
  }
  if (!firstChar) return false;
  // Erste Run-Text um den DropCap-Buchstaben kürzen.
  const idxRun = runs.indexOf(charRun);
  const txt = charRun.text;
  const pos = txt.indexOf(firstChar);
  charRun.text = txt.slice(pos + 1).replace(/^\s+/, '');
  // Falls dadurch leer geworden, Run beibehalten (egal — _renderRuns toleriert).
  const dropSize = font.body.sizePt * 3.2;
  const dropFont = 'heading';
  const startX = doc.x;
  const startY = doc.y;
  doc.save();
  doc.font(dropFont).fontSize(dropSize).fillColor('#000000');
  const dropW = doc.widthOfString(firstChar);
  doc.text(firstChar, startX, startY, { lineBreak: false, width: dropW + 2 });
  doc.restore();
  // Body-Indent um DropCap-Breite + kleines Spacing für die ersten Zeilen.
  // pdfkit's `indent` betrifft nur die erste Zeile; für 2-3 Zeilen Wickel
  // brauchen wir manuell Y-Offset. Hier vereinfacht: 1-Zeilen-Wrap.
  doc.x = startX + dropW + 4;
  doc.y = startY;
  return true;
}

async function _renderBlock(doc, block, ctx) {
  const { font, indent = 0, token, imageCache, dropCapHint, columns = 1, columnGap = 0 } = ctx;
  if (block.kind === 'heading') {
    const sizes = font.heading.sizes;
    const sizePt = block.level === 1 ? sizes.h1 : block.level === 2 ? sizes.h2 : sizes.h3;
    const space = block.level === 1 ? 24 : block.level === 2 ? 14 : 8;
    if (doc.y !== doc.page.margins.top) doc.moveDown(0.6);
    doc.font('heading').fontSize(sizePt).fillColor('#000000');
    doc.text(block.text, { align: 'left', lineGap: 4, paragraphGap: space });
    return;
  }
  if (block.kind === 'paragraph') {
    if (dropCapHint?.pending) {
      const ok = await _renderDropCap(doc, block.runs, font);
      if (ok) dropCapHint.pending = false;
    }
    _renderRuns(doc, block.runs, {
      sizePt: font.body.sizePt,
      lineHeight: font.body.lineHeight,
      align: 'justify',
      columns, columnGap,
    });
    doc.moveDown(0.3);
    return;
  }
  if (block.kind === 'list') {
    let i = 1;
    for (const itemBlocks of block.items) {
      const bullet = block.ordered ? `${i++}. ` : '• ';
      doc.font('body').fontSize(font.body.sizePt).fillColor('#000000');
      doc.text(bullet, { continued: true });
      // Erstes Block-Element des li direkt anschließen, danach moveDown für
      // weitere Sub-Blocks.
      const [first, ...rest] = itemBlocks;
      if (first && first.kind === 'paragraph') {
        _renderRuns(doc, first.runs, {
          sizePt: font.body.sizePt,
          lineHeight: font.body.lineHeight,
          align: 'left',
        });
      } else {
        doc.text('', { continued: false });
        if (first) await _renderBlock(doc, first, ctx);
      }
      for (const sub of rest) await _renderBlock(doc, sub, ctx);
    }
    doc.moveDown(0.3);
    return;
  }
  if (block.kind === 'blockquote') {
    const startX = doc.x;
    doc.save();
    const indentPt = 18;
    // Linker Strich mit Y-Spanne approximieren: pdfkit bietet keine native
    // Rahmen-Pfade um Text — wir zeichnen einen Strich nach Rendering der
    // Sub-Blocks via Position-Tracking.
    const yStart = doc.y;
    doc.x += indentPt;
    for (const sub of block.blocks) await _renderBlock(doc, sub, { ...ctx, indent: indent + indentPt });
    const yEnd = doc.y;
    doc.x = startX;
    doc.restore();
    doc.save();
    doc.lineWidth(2).strokeColor('#999999');
    doc.moveTo(startX + indent + 2, yStart).lineTo(startX + indent + 2, yEnd).stroke();
    doc.restore();
    return;
  }
  if (block.kind === 'poem' || block.kind === 'pre') {
    doc.font(block.kind === 'poem' ? 'body-italic' : 'body').fontSize(font.body.sizePt).fillColor('#000000');
    for (const line of block.lines) {
      const text = line.map(r => r.text).join('');
      if (text) doc.text(text, { align: 'left', lineGap: (font.body.lineHeight - 1) * font.body.sizePt });
      else doc.moveDown(0.4);
    }
    doc.moveDown(0.4);
    return;
  }
  if (block.kind === 'image') {
    const fetched = await _fetchImage(block.src, token, imageCache);
    if (!fetched) return;
    const maxW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const ratio = fetched.height / fetched.width;
    const w = Math.min(maxW, fetched.width);
    const h = w * ratio;
    if (doc.y + h > doc.page.height - doc.page.margins.bottom) doc.addPage();
    doc.image(fetched.buffer, doc.x, doc.y, { width: w });
    doc.y += h + 8;
    return;
  }
  if (block.kind === 'hr') {
    const y = doc.y + 6;
    const startX = doc.page.margins.left;
    const endX   = doc.page.width - doc.page.margins.right;
    doc.save();
    doc.lineWidth(0.5).strokeColor('#999999').moveTo(startX, y).lineTo(endX, y).stroke();
    doc.restore();
    doc.y = y + 12;
    return;
  }
}

// ── Header/Footer ───────────────────────────────────────────────────────────
// pdfkit prüft bei jedem text()-Call, ob `doc.y` ausserhalb der writable area
// (margins.top..page.height-margins.bottom) liegt; falls ja, wird automatisch
// eine neue Seite eingefügt. Header (im Top-Margin) und Footer (im
// Bottom-Margin) liegen genau dort. Lösung: Margins für die Header-/Footer-
// Phase auf 0 setzen, schreiben, dann zurücksetzen.
function _drawHeaderFooter(doc, layout, ctx) {
  if (ctx.skipHeader) return;
  const { width, margins } = doc.page;
  const pageW = width;
  const origMargins = { ...margins };
  doc.save();
  doc.font('body').fontSize(9).fillColor('#666666');
  doc.page.margins = { top: 0, right: origMargins.right, bottom: 0, left: origMargins.left };

  const innerW = pageW - origMargins.left - origMargins.right;
  const headerY = origMargins.top - 22;
  const footerY = doc.page.height - origMargins.bottom + 10;

  const writeAt = (text, y, align) => {
    if (!text) return;
    doc.text(_replaceTokens(text, ctx), origMargins.left, y, {
      width: innerW, align, lineBreak: false,
    });
  };

  writeAt(layout.headerLeft,   headerY, 'left');
  writeAt(layout.headerCenter, headerY, 'center');
  writeAt(layout.headerRight,  headerY, 'right');
  writeAt(layout.footerLeft,   footerY, 'left');
  writeAt(layout.footerCenter, footerY, 'center');
  writeAt(layout.footerRight,  footerY, 'right');

  doc.page.margins = origMargins;
  doc.restore();
}

// ── Cover / Title / TOC ─────────────────────────────────────────────────────
async function _renderCover(doc, cover, coverImageBuf, book, profile) {
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
  if (cover.showTitleOverlay) {
    const overlayY = cover.overlayPosition === 'top'    ? pageH * 0.10
                   : cover.overlayPosition === 'center' ? pageH * 0.45
                                                        : pageH * 0.78;
    // Halbtransparent-Hintergrund würde Transparenz im PDF erzeugen — nicht
    // erlaubt in PDF/A-2B. Stattdessen direkt Text in Weiß mit Schatten-Box
    // aus solidem Schwarz: 20%-Bar.
    doc.save();
    doc.rect(0, overlayY - 12, pageW, 90).fill('#000000');
    doc.fillColor('#ffffff').font('title').fontSize(profile.config.font.title.sizePt)
       .text(book.name || '', 0, overlayY, { width: pageW, align: 'center', lineBreak: false });
    if (profile.config.extras.subtitle) {
      doc.font('subtitle').fontSize(profile.config.font.subtitle.sizePt)
         .text(profile.config.extras.subtitle, 0, overlayY + profile.config.font.title.sizePt + 6, { width: pageW, align: 'center', lineBreak: false });
    }
    doc.restore();
  }
  doc.page.margins = oldMargins;
  return true;
}

function _renderTitlePage(doc, book, config) {
  doc.addPage();
  const f = config.font;
  const pageW = doc.page.width;
  const left = doc.page.margins.left;
  const usableW = pageW - left - doc.page.margins.right;
  const startY = doc.page.height * 0.30;
  doc.y = startY;
  doc.font('title').fontSize(f.title.sizePt).fillColor('#000000')
     .text(book.name || '', left, doc.y, { width: usableW, align: 'center' });
  if (config.extras.subtitle) {
    doc.moveDown(0.6);
    doc.font('subtitle').fontSize(f.subtitle.sizePt)
       .text(config.extras.subtitle, left, doc.y, { width: usableW, align: 'center' });
  }
  doc.moveDown(2);
  const author = book.created_by?.name || book.owned_by?.name || '';
  const year   = config.extras.year || (book.created_at ? new Date(book.created_at).getFullYear() : '');
  const byline = [author, year].filter(Boolean).join(' · ');
  if (byline) {
    doc.font('byline').fontSize(f.byline.sizePt)
       .text(byline, left, doc.y, { width: usableW, align: 'center' });
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
  doc.font('body-italic').fontSize(f.body.sizePt + 2).fillColor('#000000');
  doc.text(config.extras.dedication, left, doc.y, {
    width: usableW, align: 'center',
    lineGap: (f.body.lineHeight - 1) * (f.body.sizePt + 2),
  });
}

// Impressum-Seite: linksbündig, Body-Schrift, mehrzeilig. Wird ans Buchende
// als eigene Seite angehängt (nach Body-Loop, vor PDF/A-Postprocess).
function _renderImprintPage(doc, config) {
  if (!config.extras.imprint) return;
  doc.addPage();
  const f = config.font;
  const pageW = doc.page.width;
  const left = doc.page.margins.left;
  const usableW = pageW - left - doc.page.margins.right;
  doc.y = doc.page.margins.top;
  doc.font('body').fontSize(f.body.sizePt - 1).fillColor('#000000');
  doc.text(config.extras.imprint, left, doc.y, {
    width: usableW, align: 'left',
    lineGap: (f.body.lineHeight - 1) * (f.body.sizePt - 1),
  });
}

// TOC rendering. Reserviert auf der rechten Seite Platz für die nachträglich
// eingestempelte Seitenzahl (Two-Pass: Body-Render kennt erst nach Render
// die effektiven Pagenummern). Liefert `positions[]` aligned mit den
// gerenderten Einträgen — jede Position hält die Buffered-Page-ID + Y, an der
// die Seitenzahl später überschrieben werden kann.
const TOC_PAGENUM_RESERVE = 48;

function _renderToc(doc, toc, entries) {
  if (!toc.enabled) return [];
  doc.addPage();
  doc.font('heading').fontSize(20).fillColor('#000000')
     .text(toc.title || 'Inhalt', { align: 'center' });
  doc.moveDown(1);
  doc.font('body').fontSize(11);

  // Reserve nur einrechnen, wenn Page-Numbers gewünscht — sonst hat der Titel
  // die volle Breite zur Verfügung.
  const reserve = toc.showPageNumbers ? TOC_PAGENUM_RESERVE : 0;

  const positions = [];
  for (const c of entries) {
    if (c.level > toc.depth - 1) {
      positions.push(null);
      continue;
    }
    const indent = c.level * 18;
    const x = doc.page.margins.left + indent;
    const usableW = doc.page.width - x - doc.page.margins.right - reserve;
    // Position VOR dem Write merken. Wenn der Title bei Bedarf auf eine
    // neue TOC-Page umbricht (langer Eintrag in nestered TOC, oder am
    // Page-Bottom), wird die Position dadurch nicht zerschossen, weil
    // pdfkit `lineBreak: false` setzt — Single-Line-Garantie.
    const tocPageIdxBefore = doc.bufferedPageRange().start + doc.bufferedPageRange().count - 1;
    const yBefore = doc.y;
    doc.text(c.title, x, yBefore, {
      width: usableW,
      lineGap: 6,
      ellipsis: true,
      lineBreak: false,
    });
    // Falls der text() trotz lineBreak:false eine neue Page geöffnet hat
    // (Fall: yBefore lag bereits unter writable-area-Bottom), nehmen wir
    // die finale Page-ID nach Write.
    const tocPageIdxAfter = doc.bufferedPageRange().start + doc.bufferedPageRange().count - 1;
    if (tocPageIdxAfter !== tocPageIdxBefore) {
      positions.push({ tocPageIdx: tocPageIdxAfter, y: doc.page.margins.top });
    } else {
      positions.push({ tocPageIdx: tocPageIdxBefore, y: yBefore });
    }
  }
  doc.moveDown(1);
  return positions;
}

// ── Hauptpipeline ───────────────────────────────────────────────────────────
function _coalesceGroups(groups, pageStructure, pageBreakBetweenPages) {
  // Liefert eine Liste { title, level, isChapter, body: [{ heading?, html }] }
  // - flatten:  pro Kapitel ein Block; alle Pages des Kapitels werden im
  //             Body-HTML verkettet, einzelne Page-Headings entfallen.
  // - nested:   pro Kapitel ein Block; jede BookStack-Page bekommt h2-Heading.
  const out = [];
  for (const g of groups) {
    if (g.chapter && g.pages.length > 1 && pageStructure === 'nested') {
      const items = [];
      for (let i = 0; i < g.pages.length; i++) {
        items.push({
          heading: g.pages[i].p.name,
          pageName: g.pages[i].p.name,
          html: g.pages[i].pd.html,
          breakBefore: i > 0 && pageBreakBetweenPages,
        });
      }
      out.push({
        title: g.chapter.name, level: 0, isChapter: true,
        introHtml: g.chapter.description_html || '',
        items,
      });
    } else if (g.chapter) {
      // flatten: alle Pages im Kapitel zu einem Item zusammengefasst, einzelne
      // pageNames trotzdem behalten, damit `{pageTitle}` im Header/Footer auch
      // bei flattend-Rendering Sinn ergibt — wir nehmen den Namen der ERSTEN
      // BookStack-Page als Anker.
      const html = (g.chapter.description_html || '') + g.pages.map(x => x.pd.html).join('\n');
      out.push({
        title: g.chapter.name, level: 0, isChapter: true,
        introHtml: '',
        items: [{ html, pageName: g.pages[0]?.p?.name || g.chapter.name }],
      });
    } else {
      // Lose Seite ohne Kapitel.
      const x = g.pages[0];
      out.push({
        title: x.p.name, level: 0, isChapter: false, introHtml: '',
        items: [{ html: x.pd.html, pageName: x.p.name }],
      });
    }
  }
  return out;
}

/**
 * @param {object} args
 * @param {object} args.book        - BookStack book metadata
 * @param {object} args.groups      - Output von routes/export.js#loadBookContents
 * @param {object} args.profile     - Validiertes Profil { config, ... }
 * @param {Buffer|null} args.coverBuf - Vorbereitetes Cover-Image (sharp-prepared) oder null
 * @param {string|null} args.token  - BookStack-Token (für Image-Fetch)
 * @returns {Promise<Buffer>} PDF-Buffer (vor PDF/A-Postprocess)
 */
async function renderPdfBuffer({ book, groups, profile, coverBuf, token }) {
  const config = profile.config;
  const layout = config.layout;
  const [pageW, pageH] = _pageSize(layout);
  const margins = {
    top:    layout.marginsMm.top    * MM_TO_PT,
    right:  layout.marginsMm.right  * MM_TO_PT,
    bottom: layout.marginsMm.bottom * MM_TO_PT,
    left:   layout.marginsMm.left   * MM_TO_PT,
  };

  const author = book.created_by?.name || book.owned_by?.name || '';

  const doc = new PDFDocument({
    size: [pageW, pageH],
    margins,
    autoFirstPage: false,
    bufferPages: true,
    pdfVersion: '1.7',
    tagged: true,
    displayTitle: true,
    lang: 'de',
    info: {
      Title:    book.name || '',
      Author:   author,
      Creator:  'bookstack-lektorat',
      Producer: 'pdfkit',
    },
  });

  await _registerFonts(doc, config.font);

  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  // Cover (eigene Page ohne Margins)
  if (config.cover.enabled && coverBuf) {
    doc.addPage({ size: [pageW, pageH], margins: { top: 0, right: 0, bottom: 0, left: 0 } });
    await _renderCover(doc, config.cover, coverBuf, book, profile);
  }

  // Title-Page
  _renderTitlePage(doc, book, config);

  // Widmung (optional, vor TOC + Body)
  _renderDedicationPage(doc, config);

  // TOC: Plan aufbauen mit stabiler Zuordnung Plan → Body-Heading. Jeder Plan-
  // Eintrag bekommt blockIdx + itemIdx. Im Body-Loop schreiben wir pageIdx
  // zurück. Nach Body-Render wird per Plan + tocPositions[] die Seitenzahl
  // an der gespeicherten Position eingestempelt (Two-Pass-TOC).
  const blocks = _coalesceGroups(groups, config.chapter.pageStructure, config.chapter.pageBreakBetweenPages);
  const tocPlan = [];
  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi];
    tocPlan.push({ title: b.title, level: 0, blockIdx: bi, itemIdx: -1, pageIdx: -1 });
    if (b.isChapter && config.chapter.pageStructure === 'nested') {
      for (let i = 0; i < b.items.length; i++) {
        if (b.items[i].heading) {
          tocPlan.push({ title: b.items[i].heading, level: 1, blockIdx: bi, itemIdx: i, pageIdx: -1 });
        }
      }
    }
  }
  const tocPositions = config.toc.enabled ? _renderToc(doc, config.toc, tocPlan) : [];

  // Header/Footer werden nicht reaktiv pro pageAdded gestempelt (führt zu
  // Re-Entry-Stack-Overflow), sondern nach Body-Render in einem separaten
  // Pass über bufferedPageRange.
  const bodyStartPageIdx = doc.bufferedPageRange().start + doc.bufferedPageRange().count;
  let chapterCounter = 0;
  let currentChapterTitle = '';
  const chapterFirstPage = [];  // [{ pageIdx, title }]
  const pageTitleFirstPage = []; // [{ pageIdx, title }] — pro BookStack-Page
  const blankPageIdxs = new Set(); // Indices, auf denen kein Header/Footer gestempelt wird

  // Kapitel rendern
  const imageCache = new Map(); // src → { buffer, width, height } | null
  const dropCapHint = { pending: false };
  const renderCtx = {
    font: config.font, token, imageCache, dropCapHint,
    columns: layout.columns || 1,
    columnGap: (layout.columnGapMm || 0) * MM_TO_PT,
  };
  doc.addPage();
  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi];
    if (block.isChapter) {
      chapterCounter++;
      currentChapterTitle = block.title;
      // Page-Break-before
      if (config.chapter.breakBefore !== 'none' && chapterCounter > 1) {
        doc.addPage();
        // Recto = ungerade Seitenzahl (1-indexiert). Wenn nach addPage die
        // gesamte Page-Count gerade ist, sind wir auf einer Verso-Seite —
        // dann eine zusätzliche leere Seite einschieben, damit das Kapitel
        // auf der nächsten Recto-Seite startet.
        if (config.chapter.breakBefore === 'right-page' && (doc.bufferedPageRange().count) % 2 === 0) {
          doc.addPage();
        }
      }
      // Vertikaler Vorschub
      doc.y = doc.page.margins.top + (config.chapter.spaceBeforeMm * MM_TO_PT);
      // Kapitel-Heading. Drei Stile:
      //  - centered-large: zentriert, Default-Größe (h1)
      //  - left-rule:      linksbündig + horizontaler Strich darunter
      //  - minimal:        linksbündig, kleiner (h2-Größe)
      const label = _chapterLabel(config.chapter.numbering, chapterCounter);
      const style = config.chapter.titleStyle;
      const titleSize = style === 'minimal'
        ? config.font.heading.sizes.h2
        : config.font.heading.sizes.h1;
      const titleAlign = style === 'centered-large' ? 'center' : 'left';
      doc.font('heading').fontSize(titleSize).fillColor('#000000');
      if (label) {
        doc.text(label, { align: titleAlign });
        doc.moveDown(0.4);
      }
      doc.text(block.title, { align: titleAlign });
      if (style === 'left-rule') {
        const ruleY = doc.y + 4;
        const startX = doc.page.margins.left;
        const endX = doc.page.width - doc.page.margins.right;
        doc.save();
        doc.lineWidth(1).strokeColor('#000000')
           .moveTo(startX, ruleY).lineTo(endX, ruleY).stroke();
        doc.restore();
        doc.y = ruleY + 8;
      }
      doc.moveDown(1.2);
      doc.outline.addItem(block.title);
      const chapterPageIdx = doc.bufferedPageRange().start + doc.bufferedPageRange().count - 1;
      chapterFirstPage.push({ pageIdx: chapterPageIdx, title: block.title });
      const planChapter = tocPlan.find(e => e.blockIdx === bi && e.itemIdx === -1);
      if (planChapter) planChapter.pageIdx = chapterPageIdx;
      // DropCap am Anfang des Kapitels: erste Paragraph bekommt Initial-Buchstaben.
      dropCapHint.pending = !!config.chapter.dropCap;

      if (block.introHtml) {
        const introBlocks = parseHtmlToBlocks(block.introHtml);
        for (const ib of introBlocks) await _renderBlock(doc, ib, renderCtx);
      }
    }
    for (let ii = 0; ii < block.items.length; ii++) {
      const it = block.items[ii];
      if (it.breakBefore) doc.addPage();
      if (it.heading && config.chapter.pageStructure === 'nested') {
        doc.moveDown(0.6);
        doc.font('heading').fontSize(config.font.heading.sizes.h2).fillColor('#000000');
        doc.text(it.heading, { align: 'left' });
        doc.moveDown(0.6);
        const planSub = tocPlan.find(e => e.blockIdx === bi && e.itemIdx === ii);
        if (planSub) planSub.pageIdx = doc.bufferedPageRange().start + doc.bufferedPageRange().count - 1;
      }
      // Anker für `{pageTitle}`: Start jedes Items markiert Übergang auf neue
      // BookStack-Page. Header/Footer-Pass nutzt das später, um pro PDF-Page
      // den jeweils gültigen Page-Namen einzusetzen.
      if (it.pageName) {
        pageTitleFirstPage.push({
          pageIdx: doc.bufferedPageRange().start + doc.bufferedPageRange().count - 1,
          title: it.pageName,
        });
      }
      const itemBlocks = parseHtmlToBlocks(it.html);
      for (const ib of itemBlocks) await _renderBlock(doc, ib, renderCtx);
    }
    if (config.chapter.blankPageAfter) {
      doc.addPage();
      blankPageIdxs.add(doc.bufferedPageRange().start + doc.bufferedPageRange().count - 1);
    }
  }

  // Impressum-Page ans Buchende. Bekommt KEINEN Header/Footer (Konvention).
  if (config.extras.imprint) {
    _renderImprintPage(doc, config);
    blankPageIdxs.add(doc.bufferedPageRange().start + doc.bufferedPageRange().count - 1);
  }

  // TOC-Page-Numbers-Stempel-Pass: für jeden Plan-Eintrag mit gerenderter
  // Position die effektive Body-Pagenummer rechts ausrichten. Eingaben mit
  // pageIdx = -1 (über TOC-Tiefe gefiltert oder nicht im Body gerendert)
  // werden geskippt — _renderToc liefert dafür `null` als Position.
  if (config.toc.enabled && config.toc.showPageNumbers && tocPositions.length === tocPlan.length) {
    doc.save();
    doc.font('body').fontSize(11).fillColor('#000000');
    for (let i = 0; i < tocPlan.length; i++) {
      const pos = tocPositions[i];
      const plan = tocPlan[i];
      if (!pos || plan.pageIdx < 0) continue;
      const bodyPageNum = plan.pageIdx - bodyStartPageIdx + layout.pageNumberStart;
      doc.switchToPage(pos.tocPageIdx);
      const pageW = doc.page.width;
      const right = doc.page.margins.right;
      const xRight = pageW - right - TOC_PAGENUM_RESERVE;
      doc.text(String(bodyPageNum), xRight, pos.y, {
        width: TOC_PAGENUM_RESERVE,
        align: 'right',
        lineBreak: false,
      });
    }
    doc.restore();
  }

  // Header/Footer-Stempel-Pass: für alle Body-Pages.
  const range = doc.bufferedPageRange();
  const totalBodyPages = (range.start + range.count) - bodyStartPageIdx;
  for (let i = bodyStartPageIdx; i < range.start + range.count; i++) {
    if (blankPageIdxs.has(i)) continue; // leere Verso-Seiten + Impressum: kein Header/Footer
    doc.switchToPage(i);
    // Aktuelle Kapitel- und Page-Bezeichnung über die First-Page-Maps.
    let chapterTitle = '';
    for (const cp of chapterFirstPage) {
      if (cp.pageIdx <= i) chapterTitle = cp.title;
      else break;
    }
    let pageTitle = '';
    for (const pp of pageTitleFirstPage) {
      if (pp.pageIdx <= i) pageTitle = pp.title;
      else break;
    }
    const pageNumInBody = i - bodyStartPageIdx + 1;
    const pageNum = pageNumInBody + layout.pageNumberStart - 1;
    _drawHeaderFooter(doc, layout, {
      title: book.name || '',
      author,
      chapter: chapterTitle,
      pageTitle,
      page: pageNum,
      pages: totalBodyPages,
    });
  }

  doc.flushPages();

  if (config.pdfa.enabled) {
    applyPdfaMetadata(doc, {
      title: book.name || '',
      author,
      lang: 'de',
      creator: 'bookstack-lektorat',
      producer: 'pdfkit',
      conformance: config.pdfa.conformance || 'B',
    });
  }

  doc.end();
  return done;
}

module.exports = { renderPdfBuffer, MM_TO_PT };
