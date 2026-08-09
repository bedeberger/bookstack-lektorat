'use strict';
// Tabellensatz für den Custom-PDF-Export. pdfkit bringt keine Tabelle mit — dieses
// Modul misst und zeichnet selbst.
//
// Drei Aufgaben, die es dafür lösen muss:
//
//   1. SPALTENBREITEN. Aus dem natürlichen Platzbedarf jeder Spalte (längstes
//      Wort … ganzer Inhalt) wird eine Breite, die in den Satzspiegel passt.
//   2. ZEILENUMBRUCH IN DER ZELLE. Jede Zelle wird auf ihre Spaltenbreite
//      umbrochen; die Zeilenhöhe der Tabellenzeile ist das Maximum ihrer Zellen.
//   3. SEITENUMBRUCH. Eine Tabelle darf länger als eine Seite sein. Dann bricht
//      sie zeilenweise um, und die Kopfzeile wird oben wiederholt — sonst steht
//      die Fortsetzung ohne Spaltenbeschriftung da.
//
// EINE ZEILE KANN HÖHER SEIN ALS DIE SEITE. Dieser Fall ist der Grund, warum das
// Modul zeilenweise UND innerhalb der Zeile zeilenweise arbeitet: passt eine
// Tabellenzeile nicht auf eine leere Seite, wird sie an der Textzeile getrennt
// und auf der Folgeseite fortgesetzt. Ohne diese Trennung schiebt der Layouter
// die Zeile ewig auf die nächste Seite — eine Endlosschleife, kein Layoutfehler.
// Die Reissleine dagegen ist `_forceOneLine`: es wird immer mindestens eine
// Textzeile gesetzt, auch wenn rechnerisch keine passt.
//
// Der Text wird POSITIONIERT gesetzt (`doc.text(t, x, y, …)`), nicht im Fluss.
// Darum läuft er nicht durch `_renderRuns`/`justify.js` (die rechnen gegen die
// Seitenränder) — Auszeichnung und Verweis-Links macht dieses Modul selbst über
// `_runFontKey`. Blocksatz gibt es in einer Zelle bewusst nicht: bei
// Spaltenbreiten von wenigen Zentimetern erzeugt er Löcher statt Ruhe.

const { _runFontKey } = require('./fonts');

// Damit eine Spalte nicht auf Buchstabenbreite zusammenfällt, wenn eine andere
// sehr viel Text trägt.
const MIN_COL_PT = 24;

/** Profil-Tabellenblock (`config.table`, Feldnamen aus pdf-export-defaults.js)
 *  in die Rechenform bringen, die dieses Modul benutzt.
 *
 *  Warum exportiert: `computeColWidths` rechnet mit `padding`, das Profil heisst
 *  `paddingPt`. Wer die Breitenrechnung direkt aufruft (Test, künftiger zweiter
 *  Konsument) und den Profil-Block durchreicht, bekommt sonst NaN — still, weil
 *  `undefined * 2` keine Ausnahme wirft. Also gibt es genau eine Umrechnung, und
 *  sie ist von aussen erreichbar. */
function normalizeTableConfig(table) {
  const t = table || {};
  return {
    width: t.width || 'full',
    borders: t.borders || 'all',
    zebra: !!t.zebra,
    headerRepeat: t.headerRepeat !== false,
    fontScale: Number.isFinite(t.fontScale) ? t.fontScale : 0.95,
    padding: Number.isFinite(t.paddingPt) ? t.paddingPt : 4,
    borderWidth: Number.isFinite(t.borderWidthPt) ? t.borderWidthPt : 0.5,
    borderColor: t.borderColor || '#999999',
    zebraColor: t.zebraColor || '#f2f0ec',
    captionPosition: t.captionPosition || 'below',
  };
}

// ── Umbruch ─────────────────────────────────────────────────────────────────

// Runs in „stilbehaftete Wörter" zerlegen. Der Umbruch braucht Wörter, aber die
// Auszeichnung hängt am Run — also trägt jedes Wort seinen Stil mit.
function _words(runs) {
  const out = [];
  for (const r of runs || []) {
    const text = String(r.text || '').replace(/\s+/g, ' ');
    if (!text) continue;
    const parts = text.split(' ');
    parts.forEach((w, i) => {
      if (w) out.push({ ...r, text: w });
      // Ein Leerzeichen zwischen zwei Wörtern ist eine Umbruchgelegenheit, kein
      // Wort — es wird beim Setzen aus der Wortfolge rekonstruiert.
      if (i < parts.length - 1) out.push({ ...r, text: ' ', space: true });
    });
  }
  return out;
}

function _wordWidth(doc, word, sizePt, fontKeyBase) {
  doc.font(_runFontKey(word, fontKeyBase)).fontSize(sizePt);
  return doc.widthOfString(word.text);
}

// Zelle auf `width` umbrechen. Liefert Zeilen als Wortfolgen.
// Ein einzelnes Wort, das breiter ist als die Spalte (URL, Zahlenkolonne), steht
// allein in seiner Zeile und ragt heraus — es zeichenweise zu trennen wäre in
// einer Datentabelle schlechter als der Überhang, weil dabei aus „1.234.567" zwei
// unzusammenhängende Zahlen werden.
function _wrapCell(doc, runs, width, sizePt, fontKeyBase) {
  const words = _words(runs);
  const lines = [];
  let cur = [];
  let curW = 0;
  for (const w of words) {
    const ww = _wordWidth(doc, w, sizePt, fontKeyBase);
    if (w.space) {
      if (cur.length) { cur.push(w); curW += ww; }
      continue;
    }
    if (cur.length && curW + ww > width) {
      // Trennendes Leerzeichen am Zeilenende verwerfen.
      while (cur.length && cur[cur.length - 1].space) cur.pop();
      lines.push(cur);
      cur = [w];
      curW = ww;
      continue;
    }
    cur.push(w);
    curW += ww;
  }
  while (cur.length && cur[cur.length - 1].space) cur.pop();
  if (cur.length) lines.push(cur);
  return lines;
}

// Natürlicher Platzbedarf einer Spalte: `min` = breitestes einzelnes Wort (unter
// diese Breite kann die Spalte nicht, ohne dass Text herausragt), `max` = der
// ganze Inhalt in einer Zeile.
function _colDemand(doc, cells, sizePt, fontKeyBase) {
  let min = 0;
  let max = 0;
  for (const runs of cells) {
    const words = _words(runs);
    let lineW = 0;
    for (const w of words) {
      const ww = _wordWidth(doc, w, sizePt, fontKeyBase);
      lineW += ww;
      if (!w.space) min = Math.max(min, ww);
    }
    max = Math.max(max, lineW);
  }
  return { min, max };
}

/** Spaltenbreiten für `available` Punkte Satzspiegelbreite.
 *
 *  Verfahren: erst den natürlichen Bedarf (`max`) nehmen. Passt er, ist die
 *  Tabelle fertig — bei `width: 'full'` wird der Rest proportional aufgeteilt,
 *  damit die Tabelle mit dem Textkörper fluchtet. Passt er nicht, wird
 *  proportional gekürzt, aber keine Spalte unter ihren `min`-Bedarf bzw.
 *  MIN_COL_PT; der Rest wird auf die schrumpffähigen Spalten verteilt.
 *
 *  `cfg` ist die NORMALISIERTE Form (normalizeTableConfig), nicht der
 *  Profil-Block.
 *
 *  Exportiert für den Test — die Breitenrechnung ist der Teil, der still falsch
 *  sein kann, ohne dass ein PDF kaputt aussieht.
 */
function computeColWidths(doc, block, available, sizePt, fontKeyBase, cfg) {
  const cols = (block.align || []).length
    || Math.max(...(block.rows || [[]]).map(r => r.length), 1);
  const columns = [];
  for (let c = 0; c < cols; c++) {
    const cells = [];
    if (block.header) cells.push(block.header[c] || []);
    for (const row of block.rows || []) cells.push(row[c] || []);
    columns.push(_colDemand(doc, cells, sizePt, fontKeyBase));
  }
  const pad = cfg.padding * 2;
  const natural = columns.map(d => d.max + pad);
  const floors = columns.map(d => Math.max(MIN_COL_PT, Math.min(d.min + pad, available / cols)));
  const naturalSum = natural.reduce((a, b) => a + b, 0);

  if (naturalSum <= available) {
    if (cfg.width !== 'full' || naturalSum <= 0) return natural;
    const extra = available - naturalSum;
    return natural.map(w => w + extra * (w / naturalSum));
  }

  // Kürzen. Spalten, die schon auf ihrem Boden stehen, sind fix; der Überschuss
  // verteilt sich auf die übrigen — iterativ, weil eine gekürzte Spalte dabei
  // selbst auf ihren Boden fallen kann.
  const out = natural.slice();
  const fixed = new Array(cols).fill(false);
  for (let pass = 0; pass < cols + 1; pass++) {
    const flexSum = out.reduce((a, w, i) => (fixed[i] ? a : a + w), 0);
    const total = out.reduce((a, b) => a + b, 0);
    const over = total - available;
    if (over <= 0.01 || flexSum <= 0) break;
    let changed = false;
    for (let i = 0; i < cols; i++) {
      if (fixed[i]) continue;
      const want = out[i] - over * (out[i] / flexSum);
      if (want < floors[i]) { out[i] = floors[i]; fixed[i] = true; changed = true; }
      else out[i] = want;
    }
    if (!changed) break;
  }
  // Letzte Sicherung: sind ALLE Spalten auf ihrem Boden und die Summe trotzdem
  // zu breit (viele Spalten auf schmaler Seite), skaliert alles gleichmässig
  // herunter. Dann ragt Text heraus — sichtbar, aber nicht kaputt.
  const total = out.reduce((a, b) => a + b, 0);
  if (total > available && total > 0) {
    const k = available / total;
    for (let i = 0; i < cols; i++) out[i] *= k;
  }
  return out;
}

// ── Zeichnen ────────────────────────────────────────────────────────────────

function _drawLine(doc, x1, y1, x2, y2, cfg) {
  if (cfg.borderWidth <= 0) return;
  doc.save();
  doc.lineWidth(cfg.borderWidth).strokeColor(cfg.borderColor)
    .moveTo(x1, y1).lineTo(x2, y2).stroke();
  doc.restore();
}

// Eine Textzeile einer Zelle setzen.
function _drawCellLine(doc, words, x, y, width, align, sizePt, lineH, fontKeyBase, textColor, linkColor) {
  if (!words || !words.length) return;
  let total = 0;
  for (const w of words) total += _wordWidth(doc, w, sizePt, fontKeyBase);
  let cursor = x;
  if (align === 'right') cursor = x + width - total;
  else if (align === 'center') cursor = x + (width - total) / 2;
  for (const w of words) {
    doc.font(_runFontKey(w, fontKeyBase)).fontSize(sizePt);
    const ww = doc.widthOfString(w.text);
    doc.fillColor(w.link ? linkColor : textColor);
    const opts = { lineBreak: false, underline: !!w.underline };
    if (w.link) opts.link = w.link;
    doc.text(w.text, cursor, y, opts);
    cursor += ww;
  }
  doc.fillColor(textColor);
}

/** Tabellen-Block rendern. Bewegt `doc.y` hinter die Tabelle.
 *
 *  `ctx` erwartet: font (Profil-Schriftblock), table (Profil-Tabellenblock),
 *  hyphenate wird bewusst NICHT genutzt (siehe Modulkopf: kein Blocksatz).
 */
function renderTable(doc, block, ctx) {
  const cfg = normalizeTableConfig(ctx && ctx.table);
  const font = ctx.font || {};
  const body = font.body || {};
  const basePt = Number.isFinite(body.sizePt) ? body.sizePt : 11;
  const sizePt = Math.max(4, basePt * cfg.fontScale);
  const lineH = sizePt * (Number.isFinite(body.lineHeight) ? body.lineHeight : 1.35);
  const textColor = body.color || '#000000';
  const linkColor = ctx.linkColor || '#1a4d8f';
  const fontKeyBase = 'body';

  const left = doc.page.margins.left;
  const available = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const widths = computeColWidths(doc, block, available, sizePt, fontKeyBase, cfg);
  const cols = widths.length;
  const align = block.align || [];

  const bottomLimit = () => doc.page.height - doc.page.margins.bottom;

  // Beschriftung. Über der Tabelle (`captionPosition: 'above'`) oder darunter;
  // die Nummer („Tab. 3.2:") steckt bereits in den Runs — sie setzt
  // lib/xref-render.js VOR dem Walker, dieses Modul zählt nicht selbst.
  const drawCaption = () => {
    if (!block.caption || !block.caption.length) return;
    const capPt = Math.max(4, sizePt * 0.92);
    const capLineH = capPt * 1.3;
    const lines = _wrapCell(doc, block.caption, available, capPt, fontKeyBase);
    for (const ln of lines) {
      if (doc.y + capLineH > bottomLimit()) doc.addPage();
      _drawCellLine(doc, ln.map(w => ({ ...w, italic: true })), left, doc.y, available,
        'left', capPt, capLineH, fontKeyBase, textColor, linkColor);
      doc.y += capLineH;
    }
    doc.y += 2;
  };

  // Eine Tabellenzeile umbrechen: pro Zelle die Textzeilen.
  const wrapRow = (cells) => {
    const out = [];
    for (let c = 0; c < cols; c++) {
      const inner = Math.max(1, widths[c] - cfg.padding * 2);
      out.push(_wrapCell(doc, (cells && cells[c]) || [], inner, sizePt, fontKeyBase));
    }
    return out;
  };

  // Einen Zeilenabschnitt zeichnen: `take` Textzeilen ab `from`, ab `doc.y`.
  const drawRowSlice = (wrapped, from, take, isHeader, zebraOn) => {
    const h = take * lineH + cfg.padding * 2;
    const top = doc.y;
    if (zebraOn && cfg.zebra) {
      doc.save();
      doc.rect(left, top, widths.reduce((a, b) => a + b, 0), h).fill(cfg.zebraColor);
      doc.restore();
    }
    let x = left;
    for (let c = 0; c < cols; c++) {
      const lines = wrapped[c] || [];
      let y = top + cfg.padding;
      for (let i = from; i < from + take; i++) {
        const ln = lines[i];
        if (ln) {
          const words = isHeader ? ln.map(w => ({ ...w, bold: true })) : ln;
          _drawCellLine(doc, words, x + cfg.padding, y, widths[c] - cfg.padding * 2,
            align[c] || 'left', sizePt, lineH, fontKeyBase, textColor, linkColor);
        }
        y += lineH;
      }
      // Senkrechte Trennlinien nur im Voll-Rahmen.
      if (cfg.borders === 'all' && c > 0) _drawLine(doc, x, top, x, top + h, cfg);
      x += widths[c];
    }
    const rightX = left + widths.reduce((a, b) => a + b, 0);
    if (cfg.borders === 'all') {
      _drawLine(doc, left, top, left, top + h, cfg);
      _drawLine(doc, rightX, top, rightX, top + h, cfg);
    }
    if (cfg.borders === 'all' || cfg.borders === 'horizontal') {
      _drawLine(doc, left, top + h, rightX, top + h, cfg);
    }
    doc.y = top + h;
    return h;
  };

  // Eine ganze Zeile setzen, über Seitengrenzen hinweg. Liefert die Zeilenzahl
  // der höchsten Zelle, damit der Aufrufer nichts nachrechnen muss.
  const drawRow = (cells, isHeader, zebraOn) => {
    const wrapped = wrapRow(cells);
    const maxLines = Math.max(1, ...wrapped.map(l => l.length));
    let done = 0;
    while (done < maxLines) {
      const room = bottomLimit() - doc.y - cfg.padding * 2;
      let fits = Math.floor(room / lineH);
      // Reissleine gegen die Endlosschleife: passt rechnerisch keine Zeile,
      // wird trotzdem eine gesetzt. Auf einer frischen Seite ist das der
      // pathologische Fall (Zeilenhöhe > Seitenhöhe); dann ragt sie heraus,
      // statt dass der Renderer hängt.
      const onFreshPage = doc.y <= doc.page.margins.top + 0.5;
      if (fits <= 0) {
        if (!onFreshPage) {
          doc.addPage();
          if (isHeader) { /* Kopfzeile beginnt neu */ }
          else if (cfg.headerRepeat && block.header) drawRow(block.header, true, false);
          continue;
        }
        fits = 1; // _forceOneLine
      }
      const take = Math.min(fits, maxLines - done);
      drawRowSlice(wrapped, done, take, isHeader, zebraOn);
      done += take;
      if (done < maxLines) {
        doc.addPage();
        if (cfg.headerRepeat && block.header && !isHeader) drawRow(block.header, true, false);
      }
    }
    return maxLines;
  };

  if (cfg.captionPosition === 'above') drawCaption();

  doc.y += 4;
  const topOfTable = doc.y;
  if (cfg.borders === 'outer' || cfg.borders === 'horizontal' || cfg.borders === 'all') {
    _drawLine(doc, left, topOfTable, left + widths.reduce((a, b) => a + b, 0), topOfTable, cfg);
  }

  if (block.header) drawRow(block.header, true, false);
  (block.rows || []).forEach((row, i) => { drawRow(row, false, i % 2 === 1); });

  if (cfg.borders === 'outer') {
    // Aussenrahmen: die waagerechten Kanten sind gesetzt, die senkrechten
    // fehlen noch. Sie werden hier bewusst NICHT nachgezogen — über einen
    // Seitenumbruch hinweg wäre der Verlauf nicht rekonstruierbar, ohne pro
    // Seite mitzuschreiben. 'outer' heisst deshalb: Linie oben und unten.
  }
  const rightX = left + widths.reduce((a, b) => a + b, 0);
  if (cfg.borders === 'outer') _drawLine(doc, left, doc.y, rightX, doc.y, cfg);

  doc.y += 4;
  if (cfg.captionPosition !== 'above') drawCaption();
  doc.y += 4;
  doc.x = left;
}

module.exports = { renderTable, computeColWidths, normalizeTableConfig, _wrapCell, MIN_COL_PT };
