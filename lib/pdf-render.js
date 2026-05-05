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

function _replaceTokens(s, ctx) {
  return String(s || '')
    .replace(/\{title\}/g,   ctx.title || '')
    .replace(/\{author\}/g,  ctx.author || '')
    .replace(/\{chapter\}/g, ctx.chapter || '')
    .replace(/\{page\}/g,    ctx.page != null ? String(ctx.page) : '')
    .replace(/\{pages\}/g,   ctx.pages != null ? String(ctx.pages) : '');
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
async function _fetchImage(src, token) {
  let url = src;
  if (src.startsWith('/')) url = `${BOOKSTACK_URL}${src}`;
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    const headers = {};
    if (token && url.startsWith(BOOKSTACK_URL)) headers['Authorization'] = authHeader(token);
    const r = await fetch(url, { headers });
    if (!r.ok) return null;
    const ab = await r.arrayBuffer();
    // sharp normalisiert: kein Alpha, sRGB, JPEG (PDF/A-tauglich)
    const out = await sharp(Buffer.from(ab))
      .rotate()
      .flatten({ background: '#ffffff' })
      .toColorspace('srgb')
      .jpeg({ quality: 85 })
      .withMetadata({ icc: 'srgb' })
      .toBuffer({ resolveWithObject: true });
    return { buffer: out.data, width: out.info.width, height: out.info.height };
  } catch (e) {
    logger.warn(`pdf-render: image fetch failed for ${src} (${e.message})`);
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
  const { sizePt, lineHeight, align = 'justify', linkColor = '#1a4d8f' } = opts;
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

async function _renderBlock(doc, block, ctx) {
  const { font, indent = 0, token } = ctx;
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
    _renderRuns(doc, block.runs, {
      sizePt: font.body.sizePt,
      lineHeight: font.body.lineHeight,
      align: 'justify',
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
    const fetched = await _fetchImage(block.src, token);
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
function _drawHeaderFooter(doc, layout, ctx) {
  // Auf Cover/Title-Page kein Header/Footer.
  if (ctx.skipHeader) return;
  const { width, margins } = doc.page;
  const pageW = width;
  doc.save();
  doc.font('body').fontSize(9).fillColor('#666666');

  const headerY = margins.top - 22;
  if (layout.headerLeft || layout.headerCenter || layout.headerRight) {
    if (layout.headerLeft)
      doc.text(_replaceTokens(layout.headerLeft, ctx), margins.left, headerY, { width: pageW - margins.left - margins.right, align: 'left', lineBreak: false });
    if (layout.headerCenter)
      doc.text(_replaceTokens(layout.headerCenter, ctx), margins.left, headerY, { width: pageW - margins.left - margins.right, align: 'center', lineBreak: false });
    if (layout.headerRight)
      doc.text(_replaceTokens(layout.headerRight, ctx), margins.left, headerY, { width: pageW - margins.left - margins.right, align: 'right', lineBreak: false });
  }
  const footerY = doc.page.height - margins.bottom + 10;
  if (layout.footerLeft)
    doc.text(_replaceTokens(layout.footerLeft, ctx), margins.left, footerY, { width: pageW - margins.left - margins.right, align: 'left', lineBreak: false });
  if (layout.footerCenter)
    doc.text(_replaceTokens(layout.footerCenter, ctx), margins.left, footerY, { width: pageW - margins.left - margins.right, align: 'center', lineBreak: false });
  if (layout.footerRight)
    doc.text(_replaceTokens(layout.footerRight, ctx), margins.left, footerY, { width: pageW - margins.left - margins.right, align: 'right', lineBreak: false });
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

function _renderToc(doc, toc, chapters, book) {
  if (!toc.enabled) return;
  doc.addPage();
  doc.font('heading').fontSize(20).fillColor('#000000')
     .text(toc.title || 'Inhalt', { align: 'center' });
  doc.moveDown(1);
  doc.font('body').fontSize(11);
  for (const c of chapters) {
    if (c.level > toc.depth - 1) continue;
    const indent = c.level * 18;
    const x = doc.page.margins.left + indent;
    doc.text(c.title, x, doc.y, { width: doc.page.width - x - doc.page.margins.right, lineGap: 6 });
  }
  doc.moveDown(1);
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
        items.push({ heading: g.pages[i].p.name, html: g.pages[i].pd.html, breakBefore: i > 0 && pageBreakBetweenPages });
      }
      out.push({
        title: g.chapter.name, level: 0, isChapter: true,
        introHtml: g.chapter.description_html || '',
        items,
      });
    } else if (g.chapter) {
      // flatten oder Single-Page-Kapitel.
      const html = (g.chapter.description_html || '') + g.pages.map(x => x.pd.html).join('\n');
      out.push({
        title: g.chapter.name, level: 0, isChapter: true,
        introHtml: '',
        items: [{ html }],
      });
    } else {
      // Lose Seite ohne Kapitel.
      const x = g.pages[0];
      out.push({ title: x.p.name, level: 0, isChapter: false, introHtml: '', items: [{ html: x.pd.html }] });
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

  // TOC (vorab alle Chapter-Titel sammeln, ohne Page-Numbers in v1)
  const blocks = _coalesceGroups(groups, config.chapter.pageStructure, config.chapter.pageBreakBetweenPages);
  const tocEntries = [];
  for (const b of blocks) {
    tocEntries.push({ title: b.title, level: 0 });
    if (config.chapter.pageStructure === 'nested') {
      for (const it of b.items) if (it.heading) tocEntries.push({ title: it.heading, level: 1 });
    }
  }
  if (config.toc.enabled) _renderToc(doc, config.toc, tocEntries, book);

  // Header/Footer werden nicht reaktiv pro pageAdded gestempelt (führt zu
  // Re-Entry-Stack-Overflow), sondern nach Body-Render in einem separaten
  // Pass über bufferedPageRange.
  const bodyStartPageIdx = doc.bufferedPageRange().start + doc.bufferedPageRange().count;
  let chapterCounter = 0;
  let currentChapterTitle = '';
  const chapterFirstPage = []; // [{ pageIdx, title }]

  // Kapitel rendern
  doc.addPage();
  for (const block of blocks) {
    if (block.isChapter) {
      chapterCounter++;
      currentChapterTitle = block.title;
      // Page-Break-before
      if (config.chapter.breakBefore !== 'none' && chapterCounter > 1) {
        doc.addPage();
        if (config.chapter.breakBefore === 'right-page' && (doc.bufferedPageRange().count) % 2 === 1) {
          doc.addPage(); // leere Verso-Seite einschieben
        }
      }
      // Vertikaler Vorschub
      doc.y = doc.page.margins.top + (config.chapter.spaceBeforeMm * MM_TO_PT);
      // Kapitel-Heading
      const label = _chapterLabel(config.chapter.numbering, chapterCounter);
      const titleSize = config.font.heading.sizes.h1;
      doc.font('heading').fontSize(titleSize).fillColor('#000000');
      const titleAlign = config.chapter.titleStyle === 'minimal' ? 'left' : 'center';
      if (label) {
        doc.text(label, { align: titleAlign });
        doc.moveDown(0.4);
      }
      doc.text(block.title, { align: titleAlign });
      doc.moveDown(1.2);
      doc.outline.addItem(block.title);
      chapterFirstPage.push({
        pageIdx: doc.bufferedPageRange().start + doc.bufferedPageRange().count - 1,
        title: block.title,
      });

      if (block.introHtml) {
        const introBlocks = parseHtmlToBlocks(block.introHtml);
        for (const ib of introBlocks) await _renderBlock(doc, ib, { font: config.font, token });
      }
    }
    for (const it of block.items) {
      if (it.breakBefore) doc.addPage();
      if (it.heading && config.chapter.pageStructure === 'nested') {
        doc.moveDown(0.6);
        doc.font('heading').fontSize(config.font.heading.sizes.h2).fillColor('#000000');
        doc.text(it.heading, { align: 'left' });
        doc.moveDown(0.6);
      }
      const itemBlocks = parseHtmlToBlocks(it.html);
      for (const ib of itemBlocks) await _renderBlock(doc, ib, { font: config.font, token });
    }
    if (config.chapter.blankPageAfter) doc.addPage();
  }

  // Header/Footer-Stempel-Pass: für alle Body-Pages.
  const range = doc.bufferedPageRange();
  const totalBodyPages = (range.start + range.count) - bodyStartPageIdx;
  for (let i = bodyStartPageIdx; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // Aktuelle Kapitel-Bezeichnung über die First-Page-Map.
    let chapterTitle = '';
    for (const cp of chapterFirstPage) {
      if (cp.pageIdx <= i) chapterTitle = cp.title;
      else break;
    }
    const pageNumInBody = i - bodyStartPageIdx + 1;
    const pageNum = pageNumInBody + layout.pageNumberStart - 1;
    _drawHeaderFooter(doc, layout, {
      title: book.name || '',
      author,
      chapter: chapterTitle,
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
