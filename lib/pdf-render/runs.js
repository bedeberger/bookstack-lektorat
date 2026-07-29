'use strict';
// Inline-Run-Renderer: rendert eine Sequenz von Text-Runs (bold/italic/underline/link)
// als ein zusammenhängendes Paragraph via pdfkit's `continued`-Mechanik.

const { _runFontKey } = require('./fonts');
const { _renderRunsJustified } = require('./justify');

// pdfkit verschluckt im `continued`+`justify`-Modus führende Whitespaces eines
// Folge-Fragments: steht zwischen zwei Runs (z. B. Fliesstext → Link/`<strong>`/
// `<em>` → Fliesstext) das trennende Leerzeichen am ANFANG des rechten Runs, geht
// es verloren — die Wörter kleben aneinander und die fehlgezählte Wortzahl bläht
// den Blocksatz auf. Fix: führenden Whitespace jedes Runs (ausser dem ersten) in
// ein eigenständiges, stil-neutrales Space-Fragment auslagern — das behält pdfkit.
function _normalizeRunWhitespace(runs) {
  const out = [];
  for (const r of runs) {
    if (r.text === '\n') { out.push(r); continue; }
    const m = /^(\s+)([\s\S]*)$/.exec(r.text);
    const prev = out[out.length - 1];
    if (m && prev && prev.text !== '\n') {
      // Doppelraum vermeiden, falls der Vorgänger bereits auf Whitespace endet.
      if (!/\s$/.test(prev.text)) out.push({ text: m[1] });
      if (m[2]) out.push({ ...r, text: m[2] });
    } else {
      out.push(r);
    }
  }
  return out;
}

function _renderRuns(doc, rawRuns, opts) {
  // Einspalten-Blocksatz: eigener Zeilen-Layouter, weil pdfkit `continued`+
  // `justify` mehr-Fragment-Zeilen nicht als Ganzes justiert (Details:
  // justify.js). Alles andere (linksbündig für Listen/li-Erstabsatz, 2-Spalten)
  // läuft weiter über den pdfkit-Pfad unten.
  if ((opts.align || 'justify') === 'justify' && (opts.columns || 1) === 1) {
    return _renderRunsJustified(doc, rawRuns, opts);
  }
  const runs = _normalizeRunWhitespace(rawRuns);
  const { sizePt, lineHeight, align = 'justify', linkColor = '#1a4d8f', textColor = '#000000', columns = 1, columnGap = 0, firstLineIndent = 0, hyphenate = null, fontKeyBase = 'body' } = opts;
  // pdfkit `text` mit `continued: true` für inline-runs. `\n`-Runs (aus
  // `<br>`/Shift-Enter, vom html-walker emittiert) brechen die continued-Kette
  // und teilen das Paragraph in Segmente — pdfkit schluckt `\n` sonst in
  // justified Text.
  const segments = [[]];
  for (const r of runs) {
    if (r.text === '\n') { segments.push([]); continue; }
    segments[segments.length - 1].push(r);
  }
  segments.forEach((seg, segIdx) => {
    const isFirstSegment = segIdx === 0;
    if (seg.length === 0) {
      // Defensiv: `<br><br>` wird normalerweise von html-clean entfernt.
      doc.moveDown(0.5);
      return;
    }
    for (let i = 0; i < seg.length; i++) {
      const r = seg[i];
      const isLast = i === seg.length - 1;
      doc.font(_runFontKey(r, fontKeyBase)).fontSize(sizePt);
      const textOpts = {
        continued: !isLast,
        align,
        lineGap: (lineHeight - 1) * sizePt,
        underline: !!r.underline,
      };
      if (i === 0 && isFirstSegment && firstLineIndent > 0) {
        textOpts.indent = firstLineIndent;
      }
      if (columns > 1) {
        textOpts.columns = columns;
        textOpts.columnGap = columnGap;
      }
      if (r.link) {
        doc.fillColor(linkColor);
        textOpts.link = r.link;
      } else {
        doc.fillColor(textColor);
      }
      const text = (hyphenate && !r.link) ? hyphenate(r.text) : r.text;
      doc.text(text, textOpts);
    }
  });
  doc.fillColor(textColor);
}

module.exports = { _renderRuns, _normalizeRunWhitespace };
