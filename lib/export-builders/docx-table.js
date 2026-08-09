'use strict';
// Tabellen-Block → Word-Tabelle. Ausgelagert aus lib/export-builders/docx.js:
// die Datei steht auf ihrer LOC-Obergrenze (tests/unit/loc-limits.test.mjs), und
// der Tabellensatz ist ein abgeschlossenes Thema.
//
// ANDERS ALS IM PDF WIRD HIER NICHTS GEMESSEN. Word hat einen eigenen
// Tabellensatz: Spaltenbreiten, Zeilenhöhen und der Umbruch über Seiten sind
// seine Aufgabe. Der Builder liefert nur Struktur plus zwei Absichtserklärungen:
//
//   `tableHeader: true` auf der Kopfzeile  → Word wiederholt sie nach jedem
//       Seitenumbruch selbst. Das ist das Pendant zu `headerRepeat` im
//       PDF-Profil, nur dass es dort ausgerechnet werden muss.
//   `cantSplit` bleibt bewusst UNGESETZT  → eine hohe Zeile darf umbrechen.
//       Mit `cantSplit` schiebt Word eine Zeile, die höher als die Seite ist,
//       ganz auf die nächste — und lässt die aktuelle halb leer.
//
// Der Profil-Block `config.table` wird nur teilweise übernommen: `width`,
// `borders`, `zebra` und `captionPosition` haben eine Word-Entsprechung,
// `fontScale`/`paddingPt`/`borderWidthPt` sind PDF-Satzparameter und werden hier
// bewusst nicht nachgebaut — Word soll sich wie Word verhalten, das Dokument
// geht ja ins Lektorat und wird dort weiterbearbeitet.

const {
  Table, TableRow, TableCell, WidthType, TableLayoutType,
  Paragraph, TextRun, AlignmentType, BorderStyle, ShadingType, VerticalAlign,
} = require('docx');

const ALIGN = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
};

// Rahmen-Vorgaben je `borders`-Wert des Profils.
function _borders(mode, color) {
  const line = { style: BorderStyle.SINGLE, size: 4, color };
  const none = { style: BorderStyle.NONE, size: 0, color: 'auto' };
  if (mode === 'none') {
    return { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none };
  }
  if (mode === 'outer') {
    return { top: line, bottom: line, left: none, right: none, insideHorizontal: none, insideVertical: none };
  }
  if (mode === 'horizontal') {
    return { top: line, bottom: line, left: none, right: none, insideHorizontal: line, insideVertical: none };
  }
  return { top: line, bottom: line, left: line, right: line, insideHorizontal: line, insideVertical: line };
}

function _hex(v, fallback) {
  const s = String(v || '').replace('#', '');
  return /^[0-9a-f]{6}$/i.test(s) ? s.toLowerCase() : fallback;
}

/** Tabellen-Block in Word-Objekte übersetzen.
 *
 *  `runsToChildren` wird hereingegeben, statt importiert zu werden: die Funktion
 *  lebt in docx.js (sie kennt Fussnoten-Marker, Hyperlinks und die Basis-Schrift),
 *  und ein Import zurück wäre ein Zirkel.
 *
 *  Liefert ein Array, weil zur Tabelle die Beschriftung als eigener Absatz
 *  gehört — Word kennt kein `<caption>`.
 */
function tableBlockToDocx(block, cfg, { runsToChildren }) {
  const t = (cfg && cfg.table) || {};
  const borderColor = _hex(t.borderColor, '999999');
  const zebraColor = _hex(t.zebraColor, 'f2f0ec');
  const align = block.align || [];
  const cols = align.length || Math.max(...(block.rows || [[]]).map(r => r.length), 1);

  const cell = (runs, i, { header = false, shaded = false } = {}) => new TableCell({
    // Gleichverteilung als Ausgangspunkt; bei `layout: AUTOFIT` rechnet Word
    // anhand des Inhalts nach. Ohne eine Breitenangabe legt Word alle Spalten
    // gleich breit fest und rechnet NICHT nach.
    width: { size: Math.round(100 / cols), type: WidthType.PERCENTAGE },
    verticalAlign: VerticalAlign.TOP,
    shading: shaded ? { type: ShadingType.CLEAR, fill: zebraColor, color: 'auto' } : undefined,
    children: [new Paragraph({
      alignment: ALIGN[align[i]] || AlignmentType.LEFT,
      // Kein Erstzeilen-Einzug in der Zelle: der Belletristik-Einzug des
      // Profils würde den Inhalt aus der Spalte schieben.
      indent: { firstLine: 0 },
      children: runsToChildren(runs || [], header ? { bold: true } : {}),
    })],
  });

  const rows = [];
  if (block.header) {
    rows.push(new TableRow({
      tableHeader: t.headerRepeat !== false,
      children: Array.from({ length: cols }, (_, i) => cell(block.header[i], i, { header: true })),
    }));
  }
  (block.rows || []).forEach((row, r) => {
    rows.push(new TableRow({
      children: Array.from({ length: cols }, (_, i) => cell(row[i], i, {
        shaded: !!t.zebra && r % 2 === 1,
      })),
    }));
  });

  const out = [];
  const caption = () => {
    if (!block.caption || !block.caption.length) return null;
    // Die Nummer („Tab. 3.2:") steckt schon in den Runs — sie setzt
    // lib/xref-render.js vor dem Walker.
    return new Paragraph({
      spacing: { before: 60, after: 160 },
      indent: { firstLine: 0 },
      children: runsToChildren(block.caption, { italic: true }),
    });
  };

  const above = (t.captionPosition || 'below') === 'above';
  const cap = caption();
  if (above && cap) out.push(cap);
  if (rows.length) {
    out.push(new Table({
      rows,
      width: { size: 100, type: WidthType.PERCENTAGE },
      // 'auto' im Profil heisst „nach Inhalt" — in Word ist das FIXED mit
      // Inhaltsbreiten; AUTOFIT füllt dagegen die Satzbreite.
      layout: (t.width === 'auto') ? TableLayoutType.FIXED : TableLayoutType.AUTOFIT,
      borders: _borders(t.borders || 'all', borderColor),
    }));
  }
  if (!above && cap) out.push(cap);
  // Ein Absatz nach der Tabelle: zwei unmittelbar aufeinanderfolgende Tabellen
  // verschmilzt Word sonst zu einer.
  out.push(new Paragraph({ spacing: { after: 120 }, children: [] }));
  return out;
}

/** Abbildungs-/Tabellenverzeichnis als Word-Absätze.
 *
 *  OHNE SEITENZAHLEN — anders als das echte Word-TOC (`TableOfContents`, das
 *  Word selbst füllt) gibt es für Abbildungen und Tabellen kein Feld, das ohne
 *  Word-eigene Beschriftungsfelder (`SEQ`) funktioniert. Unsere Nummern kommen
 *  aus lib/xref-render.js und sind Text; ein Verzeichnis mit Text-Nummern und
 *  ohne Seitenzahl ist die ehrliche Form. Wer im Lektorat Seitenzahlen braucht,
 *  hat sie im PDF.
 */
function directoryParagraphs(entries, title, { hangTwip = 900 } = {}) {
  if (!entries || !entries.length) return [];
  const out = [new Paragraph({
    heading: 'Heading2',
    spacing: { before: 360, after: 180 },
    children: [new TextRun({ text: title })],
  })];
  for (const e of entries) {
    out.push(new Paragraph({
      // Hängender Einzug: die Nummern bilden eine Spalte (Verzeichniskonvention).
      indent: { left: hangTwip, hanging: hangTwip, firstLine: 0 },
      spacing: { after: 40 },
      children: [
        new TextRun({ text: e.label, bold: true }),
        new TextRun({ text: e.title ? `\t${e.title}` : '' }),
      ],
    }));
  }
  return out;
}

module.exports = { tableBlockToDocx, directoryParagraphs, _borders };
