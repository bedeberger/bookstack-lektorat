'use strict';
// Block-Renderer: dispatched walker-Output (heading/paragraph/list/blockquote/
// poem/pre/image/table/hr) auf die jeweilige pdfkit-Render-Sequenz. Rekursiv für
// list-/blockquote-Sub-Blocks. Der Tabellensatz liegt in ./table.js — er misst
// und paginiert selbst, statt im Textfluss zu laufen.

const { _renderDropCapParagraph } = require('./dropcap');
const { _renderRuns } = require('./runs');
const { _fetchImage } = require('./images');
const { _currentPageIdx } = require('./layout');
const { noteIdsOfRuns } = require('./footnotes');
const { renderTable } = require('./table');

// Schriftgrad-Faktor für das belegte Blockzitat (`<blockquote data-src>`). Kein
// Profil-Knopf: der Wert ist Satzkonvention, nicht Geschmack — und ein weiterer
// Regler in der Export-Karte für „wie viel kleiner ist ein Zitat" hilft niemandem.
const CITED_QUOTE_SIZE_SCALE = 0.94;

// Witwen-/Waisen-Kontrolle: pdfkit paginiert naiv und kann eine einzige
// Schlusszeile (Witwe) oben auf der Folgeseite bzw. eine Anfangszeile (Waise)
// allein unten auf der aktuellen Seite hinterlassen. Vor dem Paragraph-Render
// messen wir die Höhe per heightOfString und schieben den ganzen Absatz auf
// die nächste Seite, falls auf einer der beiden Seiten weniger als zwei Zeilen
// stehen würden. Hyphenator wird beim Messen mit angewendet, sonst weicht die
// Zeilenzahl von der echten Render-Ausgabe ab.
function _enforceWidowOrphan(doc, runs, opts, footnotes = null) {
  // Frische Seite (cursor an top): keine Konflikt-Situation möglich.
  if (doc.y <= doc.page.margins.top + 0.5) return;
  const text = runs.map(r => {
    if (r.text === '\n') return ' ';
    return (opts.hyphenate && !r.link) ? opts.hyphenate(r.text) : r.text;
  }).join('');
  if (!text.trim()) return;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.font(opts.fontKeyBase || 'body').fontSize(opts.sizePt);
  const measureOpts = {
    align: opts.align,
    lineGap: (opts.lineHeight - 1) * opts.sizePt,
    width,
  };
  const oneLineH = doc.heightOfString('Hg', measureOpts);
  if (oneLineH <= 0) return;
  const totalH = doc.heightOfString(text, { ...measureOpts, indent: opts.firstLineIndent || 0 });
  const totalLines = Math.max(1, Math.round(totalH / oneLineH));
  if (totalLines < 2) return; // Einzeiler kann weder Witwe noch Waise sein.
  // Die Reserve BEREITS gesetzter Noten steckt schon in margins.bottom. Die
  // Noten DIESES Absatzes noch nicht — der Absatz ist ja noch nicht umbrochen.
  // Ohne sie meldet die Kontrolle „passt vollstaendig", und gleich darauf kippt
  // der Layouter die letzte Zeile wegen ihrer Notenhoehe auf die Folgeseite:
  // genau die Witwe, die hier verhindert werden soll. Konservativ werden ALLE
  // Noten des Absatzes abgezogen — welche davon auf dieser Seite landen, steht
  // vor dem Umbruch nicht fest, und Ueberschaetzen kostet nur Platz.
  const noteReserve = footnotes
    ? footnotes.extraHeightFor(_currentPageIdx(doc), noteIdsOfRuns(runs))
    : 0;
  const available = doc.page.height - doc.page.margins.bottom - doc.y - noteReserve;
  const fittingLines = Math.floor(available / oneLineH);
  if (fittingLines >= totalLines) return; // passt vollständig
  if (fittingLines <= 0) return; // pdfkit bricht ohnehin als Erstes um.
  const linesOnNext = totalLines - fittingLines;
  if (fittingLines < 2 || linesOnNext < 2) {
    doc.addPage();
  }
}

async function _renderBlock(doc, block, ctx) {
  const { font, indent = 0, token, imageCache, dropCapHint, firstParaHint, bodyFirstLineIndentPt = 0, hangingIndentPt = 0, textRole = 'body', columns = 1, columnGap = 0, hyphenate = null, widowOrphanControl = true, skipWidowOrphan = false, dpiWarnThreshold = 0, dpiWarnings = null, footnotes = null } = ctx;
  // Schriftbild des Fliesstexts. Standard ist die Body-Rolle; das
  // Quellenverzeichnis rendert unter der Rolle `bibliography` (Profile ohne den
  // Key fallen auf Body zurueck — dieselbe Fallback-Kette wie in fonts.js).
  const roleCfg = (textRole !== 'body' && font[textRole]) ? font[textRole] : font.body;
  if (block.kind === 'blankline') {
    // Vom Autor gesetzte Leerzeile = Szenentrenner. Nur wirksam, wenn der
    // Erstzeilen-Einzug aktiv ist: sichtbarer Abstand + Folgeabsatz ohne Einzug.
    // Ohne Einzug trennt bereits der Absatzabstand — dann kein Extra-Gap.
    if (bodyFirstLineIndentPt > 0) {
      if (doc.y !== doc.page.margins.top) doc.moveDown(1);
      if (firstParaHint) firstParaHint.pending = true;
    }
    return;
  }
  if (block.kind === 'heading') {
    const sizes = font.heading.sizes;
    // Zwei Skalen fuer dasselbe Markup, entschieden vom Kontext des Items:
    //
    //   subHeadings = true  → ueber diesem Text steht schon ein gezeichneter
    //     Seitentitel (h4). Die Ueberschriften des Autors sind dann eine Ebene
    //     TIEFER und laufen auf h5/h6 — sonst ueberragt ein `<h1>` im Seitentext
    //     mit 24 pt den 13-pt-Titel der Seite, in der es steht.
    //   subHeadings = false → hier zeichnet niemand einen Seitentitel
    //     (pageStructure='flatten', kapitellose Seiten). Dann ist die
    //     Autoren-Ueberschrift die oberste Marke im Fluss und behaelt die
    //     Kapitelskala h1/h2/h3.
    const sub = !!ctx.subHeadings;
    const sizePt = sub
      ? (block.level === 1 ? (sizes.h5 ?? sizes.h3) : (sizes.h6 ?? sizes.h3))
      : (block.level === 1 ? sizes.h1 : block.level === 2 ? sizes.h2 : sizes.h3);
    const space = sub
      ? (block.level === 1 ? 8 : 6)
      : (block.level === 1 ? 24 : block.level === 2 ? 14 : 8);
    if (doc.y !== doc.page.margins.top) doc.moveDown(0.6);
    doc.font('heading').fontSize(sizePt).fillColor(font.heading.color || '#000000');
    doc.text(block.text, { align: 'left', lineGap: 4, paragraphGap: space });
    // Buchkonvention: erster Absatz nach Heading nicht eingerueckt.
    if (firstParaHint) firstParaHint.pending = true;
    return;
  }
  if (block.kind === 'paragraph') {
    if (dropCapHint?.pending) {
      const ok = await _renderDropCapParagraph(doc, block.runs, font);
      if (ok) {
        dropCapHint.pending = false;
        if (firstParaHint) firstParaHint.pending = false;
        doc.moveDown(0.3);
        return;
      }
    }
    const skipIndent = firstParaHint?.pending;
    if (firstParaHint) firstParaHint.pending = false;
    const runOpts = {
      sizePt: roleCfg.sizePt,
      lineHeight: roleCfg.lineHeight || font.body.lineHeight,
      align: 'justify',
      textColor: roleCfg.color || '#000000',
      firstLineIndent: skipIndent ? 0 : bodyFirstLineIndentPt,
      hangingIndentPt,
      fontKeyBase: textRole,
      columns, columnGap, hyphenate,
      // Der Layouter braucht den Fussnoten-Zustand, um den Platz der Noten
      // DIESER Zeile schon in die Umbruchentscheidung zu nehmen.
      footnotes,
    };
    if (widowOrphanControl && !skipWidowOrphan && columns === 1) {
      _enforceWidowOrphan(doc, block.runs, runOpts, footnotes);
    }
    _renderRuns(doc, block.runs, runOpts);
    doc.moveDown(roleCfg.paragraphGap ?? font.body.paragraphGap);
    return;
  }
  if (block.kind === 'list') {
    let i = 1;
    for (const itemBlocks of block.items) {
      const bullet = block.ordered ? `${i++}. ` : '• ';
      doc.font('body').fontSize(font.body.sizePt).fillColor(font.body.color || '#000000');
      doc.text(bullet, { continued: true });
      // Erstes Block-Element des li direkt anschließen, danach moveDown für
      // weitere Sub-Blocks.
      const [first, ...rest] = itemBlocks;
      if (first && first.kind === 'paragraph') {
        _renderRuns(doc, first.runs, {
          sizePt: font.body.sizePt,
          lineHeight: font.body.lineHeight,
          align: 'left',
          textColor: font.body.color || '#000000',
          hyphenate,
          // Ohne den Zustand liefe ein Listenpunkt mit Note ueber den
          // pdfkit-Pfad, der keine Reserve aufbauen kann (siehe runs.js).
          footnotes,
        });
      } else {
        doc.text('', { continued: false });
        if (first) await _renderBlock(doc, first, { ...ctx, skipWidowOrphan: true });
      }
      for (const sub of rest) await _renderBlock(doc, sub, { ...ctx, skipWidowOrphan: true });
    }
    doc.moveDown(0.3);
    return;
  }
  if (block.kind === 'blockquote') {
    // Indent + linker Strich. Page-Break-tauglich: pdfkit resettet bei Auto-
    // Pagebreak `lineWrapper.startX` auf `doc.page.margins.left`. Darum
    // modifizieren wir margins.left per pageAdded-Hook, damit auch
    // Folgeseiten die eingerueckte Spalte erben. Strich wird pro Page-Segment
    // ueber switchToPage gemalt — sonst landet er nach Pagebreak auf falscher
    // Seite (yStart aus Page N, yEnd aus Page N+1).
    const indentPt = 18;
    const origLeft = doc.page.margins.left;
    const enterX = doc.x;
    const indentedLeft = enterX + indentPt;
    const barX = enterX + 2;

    doc.page.margins.left = indentedLeft;
    doc.x = indentedLeft;

    const range0 = doc.bufferedPageRange();
    let segPageIdx = range0.start + range0.count - 1;
    let segY0 = doc.y;
    const segments = [];

    // pdfkit emits 'pageAdded' ohne Argumente; neue Seite ist bereits doc.page.
    // Vorherige Seite hat identisches Format, daher prevBottom aus doc.page ableitbar.
    const onPageAdded = () => {
      const page = doc.page;
      // `y1: null` heisst „bis zur Unterkante DIESER Seite". Der Wert wird erst
      // beim Zeichnen bestimmt, nach switchToPage auf die betreffende Seite —
      // dort stehen deren eigene Raender. Frueher wurde er hier aus den Raendern
      // der NEUEN Seite abgeleitet („identisches Format"); das gilt nicht mehr,
      // seit der Fussnotenapparat `margins.bottom` pro Seite unterschiedlich
      // aufblaeht — der Strich liefe sonst um die Reservehoehe zu weit und
      // endete im Apparat.
      segments.push({ pageIdx: segPageIdx, y0: segY0, y1: null });
      segPageIdx += 1;
      page.margins.left = indentedLeft;
      segY0 = page.margins.top;
    };
    doc.on('pageAdded', onPageAdded);

    // Belegtes Blockzitat: wissenschaftliche Konvention ist der kleinere Grad
    // (die Einrückung trägt die Auszeichnung, nicht die Kursive). Umgesetzt über
    // eine verkleinerte Kopie der aktiven Textrolle — `roleCfg` leitet sich in
    // _renderBlock aus `font[textRole]` ab, also muss die Kopie unter demselben
    // Schlüssel liegen, damit sie die Sub-Blöcke wirklich erreicht.
    const quoteRole = (textRole !== 'body' && font[textRole]) ? textRole : 'body';
    const subFont = block.cited
      ? { ...font, [quoteRole]: { ...roleCfg, sizePt: Math.max(6, roleCfg.sizePt * CITED_QUOTE_SIZE_SCALE) } }
      : font;
    for (const sub of block.blocks) {
      await _renderBlock(doc, sub, { ...ctx, font: subFont, dropCapHint: { pending: false }, firstParaHint: { pending: false }, bodyFirstLineIndentPt: 0, skipWidowOrphan: true });
    }

    doc.off('pageAdded', onPageAdded);

    const finalY = doc.y;
    if (finalY > segY0) {
      segments.push({ pageIdx: segPageIdx, y0: segY0, y1: finalY });
    }

    doc.page.margins.left = origLeft;
    doc.x = origLeft;

    if (segments.length) {
      const saveX = doc.x;
      const saveY = doc.y;
      const range1 = doc.bufferedPageRange();
      const lastPageIdx = range1.start + range1.count - 1;
      for (const s of segments) {
        doc.switchToPage(s.pageIdx);
        // Offenes Segment (Seitenwechsel): bis zur Unterkante des Satzspiegels
        // DIESER Seite — inklusive einer dort reservierten Fussnotenhoehe.
        const y1 = s.y1 == null ? doc.page.height - doc.page.margins.bottom : s.y1;
        if (y1 <= s.y0) continue;
        doc.save();
        doc.lineWidth(2).strokeColor('#999999');
        doc.moveTo(barX, s.y0).lineTo(barX, y1).stroke();
        doc.restore();
      }
      doc.switchToPage(lastPageIdx);
      doc.x = saveX;
      doc.y = saveY;
    }

    doc.moveDown(0.3);
    return;
  }
  if (block.kind === 'poem' || block.kind === 'pre') {
    // Gedicht und Codeblock setzen ihre Zeilen aus reinem Text — auch hier geht
    // der Run-Style verloren (siehe dropcap.js). Traegt eine Zeile einen
    // Notenmarker, laeuft der Block stattdessen ueber den normalen Run-Renderer:
    // typografisch leicht anders, aber die Note bleibt erhalten statt zu
    // verschwinden. Betrifft nur belegte Verse — der Normalfall aendert sich nicht.
    const noteLine = (block.lines || []).find(l => l.some(r => Number.isInteger(r && r.noteId)));
    if (noteLine) {
      for (const line of block.lines) {
        _renderRuns(doc, line, {
          sizePt: font.body.sizePt,
          lineHeight: font.body.lineHeight,
          align: 'left',
          textColor: font.body.color || '#000000',
          firstLineIndent: 0,
          fontKeyBase: block.kind === 'poem' ? 'body' : 'body',
          columns: 1, columnGap: 0, hyphenate: null,
          footnotes,
        });
      }
      doc.moveDown(0.4);
      return;
    }
    doc.font(block.kind === 'poem' ? 'body-italic' : 'body').fontSize(font.body.sizePt).fillColor(font.body.color || '#000000');
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
    // Effektive Druckauflösung: Pixelbreite / Druckbreite (w ist in pt = 1/72 Zoll).
    if (dpiWarnThreshold > 0 && dpiWarnings && w > 0) {
      const effDpi = fetched.width * 72 / w;
      if (effDpi < dpiWarnThreshold) {
        dpiWarnings.push({ src: block.src, dpi: Math.round(effDpi), px: fetched.width });
      }
    }
    if (doc.y + h > doc.page.height - doc.page.margins.bottom) doc.addPage();
    doc.image(fetched.buffer, doc.x, doc.y, { width: w });
    doc.y += h + 8;
    return;
  }
  if (block.kind === 'pagebreak') {
    doc.addPage();
    return;
  }
  if (block.kind === 'blankpage') {
    // Eine bewusst leere Seite: erst auf neue Seite (die bleibt leer), dann
    // gleich weiter, damit Folgeinhalt erst auf der übernächsten Seite landet.
    doc.addPage();
    doc.addPage();
    return;
  }
  if (block.kind === 'table') {
    // Tabellensatz liegt in seinem eigenen Modul: er misst und bricht selbst,
    // statt im Textfluss zu laufen (lib/pdf-render/table.js).
    renderTable(doc, block, { font, table: ctx.table, linkColor: ctx.linkColor });
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

module.exports = { _renderBlock };
