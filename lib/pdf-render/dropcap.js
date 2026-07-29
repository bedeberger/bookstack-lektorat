'use strict';
// DropCap-Paragraph: Initialbuchstabe absolut, daneben die tatsächlich passenden
// Body-Zeilen, dann Rest am Margin. Cap-Höhe folgt dem tatsächlichen Fit (2 oder 3
// Zeilen) — nie eine leere Zeile zwischen Cap und Folgetext.
//
// Ablauf:
//   1. Cap-Größe für `dropLines` (3) Zeilen schätzen → dropW, wrapW.
//   2. Body-Text greedy in 3 Zeilen fitten; messen wie viele tatsächlich gerendert
//      werden (heightOfString = N · lineSpacing).
//   3. Wenn weniger Zeilen passen, Cap auf diese Zahl verkleinern und mit neuem
//      dropW/wrapW neu fitten.
//   4. Cap rendern, Fit rendern, doc.y = startY + linesUsed·lineSpacing → Rest
//      schließt nahtlos an, keine Lücke.
//
// Trade-off: inline-Formatting (bold/italic/links) im DropCap-Paragraph geht
// verloren, da wir runs zu fullText kollabieren. Akzeptabel — der erste Absatz
// nach einem Kapitel-Heading ist in Belletristik praktisch nie inline-formatiert.
async function _renderDropCapParagraph(doc, runs, font) {
  // Dieser Pfad setzt den Absatz aus `runs.map(r => r.text).join('')` — der
  // Run-Style geht dabei verloren. Ein Notenmarker wuerde damit in
  // Fliesstextgroesse erscheinen UND seinen Platz am Seitenfuss nie reservieren,
  // die Note fiele lautlos aus. Absatz mit Note also nicht als Initiale setzen;
  // `false` schickt den Aufrufer auf den normalen Absatzpfad (blocks.js).
  if (runs.some(r => Number.isInteger(r && r.noteId))) return false;
  let firstChar = '';
  let charRun = null;
  for (const r of runs) {
    const m = (r.text || '').match(/\S/);
    if (m) { firstChar = m[0]; charRun = r; break; }
  }
  if (!firstChar) return false;
  const txt0 = charRun.text;
  const pos = txt0.indexOf(firstChar);
  charRun.text = txt0.slice(pos + 1).replace(/^\s+/, '');

  const sizePt = font.body.sizePt;
  const lineHeight = font.body.lineHeight;
  const lineGap = (lineHeight - 1) * sizePt;
  const startX = doc.x;
  const startY = doc.y;
  const margins = doc.page.margins;
  const fullW = doc.page.width - margins.left - margins.right;
  const gap = sizePt * 0.4;

  // Tatsächliches Line-Advance via heightOfString messen — pdfkit's
  // currentLineHeight(true) schließt nur font-intrinsischen lineGap ein
  // (für Lora = 0), nicht den doc-level _lineGap, den wir per Option setzen.
  doc.font('body').fontSize(sizePt).lineGap(lineGap);
  const lineSpacing = doc.heightOfString('X');
  const bodyAscRatio = (doc._font?.ascender || 850) / 1000;
  const bodyCapRatio = (doc._font?.capHeight || 700) / 1000;
  const bodyAsc = bodyAscRatio * sizePt;
  const bodyCapH = bodyCapRatio * sizePt;

  doc.font('heading');
  const headAscRatio = (doc._font?.ascender || 850) / 1000;
  const headCapRatio = (doc._font?.capHeight || 700) / 1000;

  const fullText = runs.map(r => r.text).join('');

  // Schnelle widthOfString-Greedy-Heuristik für Vorauswahl.
  const countLines = (text, width) => {
    if (!text) return 0;
    doc.font('body').fontSize(sizePt);
    const words = text.split(/\s+/).filter(Boolean);
    if (!words.length) return 0;
    let line = words[0];
    let lines = 1;
    for (let i = 1; i < words.length; i++) {
      const trial = line + ' ' + words[i];
      if (doc.widthOfString(trial) <= width) line = trial;
      else { lines++; line = words[i]; }
    }
    return lines;
  };

  // Wahrheitsquelle für Geometrie: pdfkit's eigener LineWrapper. Eigene Greedy-
  // Schätzung kann durch Kerning über Wortgrenzen und Trail-Space-Handling um
  // eine Zeile abweichen — wenn das passiert, kollidiert Folgetext mit lastFit.
  const measureLines = (text, width) => {
    if (!text) return 0;
    doc.font('body').fontSize(sizePt).lineGap(lineGap);
    const h = doc.heightOfString(text, { width });
    return Math.max(1, Math.round(h / lineSpacing));
  };

  const fitForLines = (N) => {
    doc.font('heading');
    const capH = bodyCapH + (N - 1) * lineSpacing;
    const dropSize = capH / headCapRatio;
    doc.fontSize(dropSize);
    const dropW = doc.widthOfString(firstChar);
    const wrapW = fullW - dropW - gap;

    const tokens = fullText.split(/(\s+)/);
    let lastFit = '';
    let lastIdx = -1;
    for (let i = 0; i < tokens.length; i++) {
      const trial = tokens.slice(0, i + 1).join('');
      if (countLines(trial, wrapW) <= N) { lastFit = trial; lastIdx = i; }
      else break;
    }
    // Greedy gegen pdfkit verifizieren; bei Überschuss tokenweise zurückrollen.
    while (lastFit && measureLines(lastFit, wrapW) > N) {
      lastIdx--;
      if (lastIdx < 0) { lastFit = ''; break; }
      lastFit = tokens.slice(0, lastIdx + 1).join('');
    }
    const linesUsed = lastFit ? measureLines(lastFit, wrapW) : 0;
    return { N, dropSize, dropW, wrapW, lastFit, linesUsed };
  };

  let res = fitForLines(3);
  if (res.linesUsed < 3) {
    const r2 = fitForLines(2);
    if (r2.linesUsed >= res.linesUsed) res = r2;
  }
  // Paragraph zu kurz/zu schmal für sinnvollen DropCap → normaler Render.
  if (res.linesUsed < 2) {
    charRun.text = txt0;
    return false;
  }
  // Cap an tatsächlich gefittete Zeilen koppeln (sonst Cap-Unterkante kollidiert
  // mit Folgezeile, die nach lastFit am Margin startet).
  if (res.linesUsed < res.N) {
    doc.font('heading');
    const capH = bodyCapH + (res.linesUsed - 1) * lineSpacing;
    res.dropSize = capH / headCapRatio;
  }

  const { dropSize, dropW, wrapW, lastFit, linesUsed } = res;
  const indentX = startX + dropW + gap;
  const rest = fullText.slice(lastFit.length).replace(/^\s+/, '');

  // Cap-Top auf Body-Cap-Top von Zeile 1 ausrichten und Cap-Baseline auf
  // Body-Baseline der letzten Wrap-Zeile. dropSize ist so gewählt, dass
  // dropCapH = bodyCapH + (linesUsed-1)·lineSpacing → Body wird so weit nach
  // unten verschoben, dass Heading-„Ascender-über-Cap"-Padding nicht über die
  // Paragraph-Top hinausragt.
  const dropAsc  = dropSize * headAscRatio;
  const dropCapH = dropSize * headCapRatio;
  const bodyOffset = (dropAsc - dropCapH) - (bodyAsc - bodyCapH);

  // Manuell Page-Break auslösen, falls ganzer Block nicht mehr passt. Sonst
  // bricht pdfkit erst beim Drop-Cap-Render auto um (Z auf neuer Page oben),
  // der nachfolgende Body-Render mit absolutem `startY + bodyOffset` referenziert
  // aber noch die alte (jetzt vorherige) Page → Body landet am Page-Ende statt
  // neben dem Z.
  const totalH = Math.max(dropSize, bodyOffset + linesUsed * lineSpacing);
  const maxY = doc.page.height - doc.page.margins.bottom;
  let topY = startY;
  if (topY + totalH > maxY) {
    doc.addPage();
    topY = doc.y;
  }

  doc.save();
  doc.font('heading').fontSize(dropSize).fillColor(font.heading.color || '#000000');
  doc.text(firstChar, startX, topY, { lineBreak: false, width: dropW + 2 });
  doc.restore();

  const bodyTop = topY + bodyOffset;
  doc.font('body').fontSize(sizePt).fillColor(font.body.color || '#000000');
  if (lastFit) {
    doc.text(lastFit, indentX, bodyTop, {
      width: wrapW,
      align: 'justify',
      lineGap,
    });
  }
  // doc.y nach pdfkit-Render = echte Unterkante des Body-Fits. Wrap-Unterkante
  // separat halten, falls Cap-Em-Box höher reicht als gemessener Body-Block.
  const wrapBottom = bodyTop + linesUsed * lineSpacing;
  doc.x = startX;
  doc.y = Math.max(doc.y, wrapBottom);

  if (rest) {
    doc.text(rest, startX, doc.y, {
      width: fullW,
      align: 'justify',
      lineGap,
    });
  }
  doc.x = startX;
  return true;
}

module.exports = { _renderDropCapParagraph };
