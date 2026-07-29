'use strict';
// Body-Render-Loop: iteriert die koaleszierten Blöcke, rendert Kapitel-
// Überschriften (mit Break-/Recto-Logik + Tiefen-abgestuftem Vorschub) und die
// zugehörigen HTML-Items. Sammelt die First-Page-Anker (Kapitel + BookStack-
// Pages) für die späteren Header/Footer- und Seitenzahl-Pässe und schreibt die
// gerenderte pageIdx in den TOC-Plan zurück. Kapitel-Labels kommen vorab aus
// numbering.js (SSoT mit dem TOC-Plan).

const { parseHtmlToBlocks } = require('./html-walker');
const { MM_TO_PT, _currentPageIdx, _nextPageIdx } = require('./layout');
const { _drawTitleRule } = require('./chrome');
const { _renderBlock } = require('./blocks');

/**
 * @returns {Promise<{bodyStartPageIdx:number, chapterFirstPage:Array, pageTitleFirstPage:Array}>}
 */
async function renderBody(doc, { blocks, config, labels, tocPlan, renderCtx, geo, blankPageIdxs, dropCapHint, firstParaHint }) {
  const bodyStartPageIdx = _nextPageIdx(doc);
  let topChapterCounter = 0;
  const chapterFirstPage = [];  // [{ pageIdx, title, chapterId, skipPageCounter }]
  const pageTitleFirstPage = []; // [{ pageIdx, title, pageId }] — pro BookStack-Page

  doc.addPage();
  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi];
    // Top-Level-Sektion = Kapitel auf Ebene 1 ODER manuell hinzugefuegte
    // Nicht-Kapitel-Seite (chapter_id null). Beide teilen die Seitenumbruch-
    // Logik, damit eine Custom-Seite mit korrektem Satzspiegel/Recto-Verso auf
    // einer frischen Seite beginnt, statt inline in die vorherige Seite zu
    // fliessen — sonst landet sie bei mirrorMargins auf der falschen Buchseite
    // und der Bundsteg sitzt auf der falschen Kante.
    const depth = block.isChapter ? labels[bi].depth : 1;
    const isTopLevel = depth === 1;
    // topChapterCounter zaehlt fuer die Break-Logik immer — auch unnumbered
    // Kapitel + Custom-Seiten brauchen den Page-Break.
    if (isTopLevel) topChapterCounter += 1;
    // Page-Break-Verhalten:
    //  - Top-Level (depth 1): plus Recto-Adjust.
    //  - Sub-Kapitel: standardmaessig inline; Break nur bei breakBeforeSubchapter
    //    und nicht bei generellem 'none'.
    const pageHasContent = doc.y > doc.page.margins.top + 1;
    const breakModeOn = config.chapter.breakBefore !== 'none';
    let wantBreak;
    if (isTopLevel) {
      wantBreak = breakModeOn && (topChapterCounter > 1 || pageHasContent);
    } else {
      wantBreak = breakModeOn && config.chapter.breakBeforeSubchapter && pageHasContent;
    }
    let didBreak = false;
    if (wantBreak) {
      doc.addPage();
      didBreak = true;
      if (isTopLevel
          && config.chapter.breakBefore === 'right-page'
          && doc.bufferedPageRange().count % 2 === 0) {
        doc.addPage();
      }
    }
    if (block.isChapter) {
      // Vertikaler Vorschub: pro Tiefe abgestuft, damit Sub-Kapitel nicht mit
      // demselben spaceBeforeMm wie Top-Level-Kapitel beginnen.
      const depthSpaceFactor = depth === 1 ? 1 : depth === 2 ? 0.4 : 0.2;
      const spaceAbove = config.chapter.spaceBeforeMm * MM_TO_PT * depthSpaceFactor;
      if (!pageHasContent || didBreak) {
        doc.y = doc.page.margins.top + spaceAbove;
      } else {
        doc.y += spaceAbove;
      }
      const label = labels[bi].label;
      const style = config.chapter.titleStyle;
      const sizes = config.font.heading.sizes;
      // Tiefe → Heading-Groesse: depth 1 = h1 (bei 'minimal' h2), depth 2 = h2, depth 3 = h3.
      let titleSize;
      if (depth === 1) {
        titleSize = style === 'minimal' ? sizes.h2 : sizes.h1;
      } else if (depth === 2) {
        titleSize = sizes.h2;
      } else {
        titleSize = sizes.h3;
      }
      // Sub-Kapitel immer linksbuendig; centered-large gilt nur fuer Top-Level.
      const titleAlign = depth === 1 && style === 'centered-large' ? 'center' : 'left';
      const headingColor = config.font.heading.color || '#000000';
      doc.font('heading').fontSize(titleSize).fillColor(headingColor);
      if (label) {
        doc.text(label, { align: titleAlign });
        doc.moveDown(0.4);
      }
      doc.text(block.title, { align: titleAlign });
      // titleRule nur fuer Top-Level (Sub-Kapitel mit Strich wirken zu schwer).
      if (depth === 1 && (style === 'left-rule' || config.chapter.titleRule)) {
        _drawTitleRule(doc, headingColor);
      }
      doc.moveDown(depth === 1 ? 1.2 : 0.6);
      doc.outline.addItem(label ? `${label}. ${block.title}` : block.title);
      const chapterPageIdx = _currentPageIdx(doc);
      chapterFirstPage.push({
        pageIdx: chapterPageIdx,
        title: block.title,
        chapterId: block.chapterId,
        skipPageCounter: !!block.skipPageCounter,
      });
      const planChapter = tocPlan.find(e => e.blockIdx === bi && e.itemIdx === -1);
      if (planChapter) planChapter.pageIdx = chapterPageIdx;
      // DropCap nur am Top-Level-Kapitel-Start, nicht bei Sub-Kapiteln — und nie
      // im Quellenverzeichnis (eine Initiale auf dem ersten Eintrag wäre Unsinn).
      dropCapHint.pending = depth === 1 && !!config.chapter.dropCap && !block.isBibliography;
      // Erster Absatz nach Kapitel-Title nicht einruecken (Buchkonvention).
      firstParaHint.pending = true;
    } else {
      // Custom-Seite (Nicht-Kapitel): bewusst kein Kapitel-Titel — der Seiten-
      // inhalt bringt seine eigene Ueberschrift mit. Vorhandenen TOC-Eintrag auf
      // die (nun eigene) Startseite verankern, damit die Verzeichnis-Seitenzahl
      // stimmt (der Body ist SSoT fuer pageIdx, Two-Pass-TOC).
      const planEntry = tocPlan.find(e => e.blockIdx === bi && e.itemIdx === -1);
      if (planEntry) planEntry.pageIdx = _currentPageIdx(doc);
    }
    if (block.items.length) geo.enableBodyInset();
    // Verzeichniseinträge (synthetische Gruppe aus lib/bibliography.js) laufen
    // durch denselben Walker/Block-Renderer, aber mit eigener Font-Rolle, ohne
    // Erstzeilen-Einzug und mit hängendem Einzug statt dessen.
    const itemCtx = block.isBibliography
      ? { ...renderCtx, textRole: 'bibliography', bodyFirstLineIndentPt: 0, hangingIndentPt: renderCtx.bibliographyHangPt || 0 }
      : renderCtx;
    for (let ii = 0; ii < block.items.length; ii++) {
      const it = block.items[ii];
      if (it.breakBefore) doc.addPage();
      if (it.heading && config.chapter.pageStructure === 'nested') {
        doc.moveDown(0.6);
        const headingColor = config.font.heading.color || '#000000';
        doc.font('heading').fontSize(config.font.heading.sizes.h2).fillColor(headingColor);
        doc.text(it.heading, { align: 'left' });
        if (config.chapter.pageTitleRule) _drawTitleRule(doc, headingColor);
        doc.moveDown(0.6);
        const planSub = tocPlan.find(e => e.blockIdx === bi && e.itemIdx === ii);
        if (planSub) planSub.pageIdx = _currentPageIdx(doc);
        if (config.chapter.dropCap) dropCapHint.pending = true;
        firstParaHint.pending = true;
      }
      // Anker für `{pageTitle}`: Start jedes Items markiert Übergang auf neue
      // BookStack-Page. Header/Footer-Pass setzt darüber pro PDF-Page den
      // jeweils gültigen Page-Namen ein.
      if (it.pageName) {
        pageTitleFirstPage.push({
          pageIdx: _currentPageIdx(doc),
          title: it.pageName,
          pageId: it.pageId ?? null,
        });
      }
      const itemBlocks = parseHtmlToBlocks(it.html);
      for (const ib of itemBlocks) await _renderBlock(doc, ib, itemCtx);
    }
    // Inset deaktivieren BEVOR blankPageAfter / nächster Chapter-AddPage
    // ausgelöst wird — sonst erbt die Leer-/Recto-Folgeseite den Body-Inset.
    geo.disableBodyInset();
    if (config.chapter.blankPageAfter) {
      doc.addPage();
      blankPageIdxs.add(_currentPageIdx(doc));
    }
  }

  return { bodyStartPageIdx, chapterFirstPage, pageTitleFirstPage };
}

module.exports = { renderBody };
