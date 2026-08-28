'use strict';
// DOCX-Export via die programmatische `docx`-Lib (dolanmiu). Pendant zum
// Custom-PDF-Renderer: volle Kontrolle über laufende Kopfzeile mit Seitenzahl
// (Standard-Manuskript-/Shunn-Format), echtes Word-Inhaltsverzeichnis-Feld
// (aktualisiert sich in Word), benannte Heading-Styles und Titelei.
//
// Eingabe ist der Export-`bundle` (lib/load-contents) + ein validiertes Profil
// (lib/docx-export-defaults). Die Titelei-Texte (Titel/Untertitel/Autor/Widmung/
// Impressum/Copyright/Frontmatter/Bio/Jahr/ISBN) kommen buch-weit aus
// book_publication (opts.meta), geteilt mit PDF + EPUB.
//
// Seiten-HTML wird über denselben Walker wie der PDF-Renderer in eine flache
// Block-Liste übersetzt (lib/pdf-render/html-walker) und block-weise in docx-
// Paragraphen gemappt. Tabellen werden zu echten Word-Tabellen (./docx-table.js);
// Word setzt sie selbst, inkl. Umbruch über Seiten. Eingefügte
// Manuskript-Bilder (<img src="/content/page-image/:id">) werden als ImageRun
// eingebettet — die BLOBs werden vorab (async) aus der DB in ctx.pageImages
// aufgelöst; externe/unauflösbare Bild-src werden übersprungen.

const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  PageNumber, Header, Footer, TableOfContents, ExternalHyperlink,
  BorderStyle, LineRuleType, convertMillimetersToTwip, ImageRun, FootnoteReferenceRun,
} = require('docx');
const { parseHtmlToBlocks } = require('../pdf-render/html-walker');
const { tableBlockToDocx, directoryParagraphs } = require('./docx-table');
const { directoryEntries, directoryTitle } = require('../anchor-directory');
const { bibliographyItemHtml, bibliographyVisible } = require('../bibliography');
const { endnoteItemHtml, buildEndnotes } = require('../endnotes');
const { buildXrefContext, applyXrefsInGroups } = require('../xref-render');
const { resolveTitle, chapterDepth, buildChaptersById, ancestorInSet, sameStructureTitle, prepareCitations, notesTitleFor } = require('./shared');
const { resolveDiagramsInGroups } = require('../diagram-export');
const { stripDiagramBlocks } = require('../html-text');
const headline = require('../headline-render');
const { _chapterLabelNested } = require('../pdf-render/layout');
const { validateConfig, defaultConfig } = require('../docx-export-defaults');

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// Benannter Word-Style der Verzeichniseinträge (hängender Einzug). Als echter
// Style, nicht als Inline-Formatierung: so kann das Lektorat das Verzeichnis in
// Word an einer Stelle umformatieren, statt Absatz für Absatz.
const BIB_STYLE_ID = 'Bibliography';
// Eigener Style statt Wiederverwendung von `Bibliography`: der Apparat steht
// mehrfach im Dokument und soll in Word unabhaengig vom Verzeichnis
// umformatierbar sein (andere Groesse, anderer Einzug).
const NOTES_STYLE_ID = 'Endnotes';
// Titel-Kopf eines Beitrags (Titel-Werkstatt). Zwei eigene Styles aus demselben
// Grund wie oben: in der Redaktion wird die Dachzeilen-Form einmal geaendert,
// nicht in vierzig Beitraegen einzeln.
const KICKER_STYLE_ID = 'ArticleKicker';
const LEAD_STYLE_ID = 'ArticleLead';
const BIB_HANG_MM = 5;

// Seitengrösse in Twips (1/1440 inch). A4/A5 metrisch, Letter US.
const PAGE_DIMS = {
  A4:     { width: 11906, height: 16838 },
  A5:     { width: 8391,  height: 11906 },
  Letter: { width: 12240, height: 15840 },
};
const LINE_MULT = { single: 240, oneAndHalf: 360, double: 480 };

const LABELS = {
  de: { toc: 'Inhalt', aboutAuthor: 'Über die Autorin / den Autor', words: 'ca. {n} Wörter', by: 'von' },
  en: { toc: 'Contents', aboutAuthor: 'About the Author', words: 'approx. {n} words', by: 'by' },
};
function _labels(lang) { return LABELS[lang] || LABELS.de; }

// ── Inline-Runs → docx TextRuns ──────────────────────────────────────────────
function _runsToChildren(runs, base = {}) {
  const out = [];
  for (const r of runs || []) {
    if (r.text === '\n') { out.push(new TextRun({ break: 1 })); continue; }
    // Notenmarker im Fussnotenmodus: echte Word-Fussnote statt hochgestellter
    // Ziffer. Word setzt sie selbst an den Seitenfuss, bricht sie bei Bedarf um
    // und nummeriert sie nach seinen eigenen Regeln — darum braucht der Builder
    // hier keinerlei Layout-Rechnung. Folge: die angezeigte Nummer ist Words
    // fortlaufende, nicht unsere kapitelweise; im Manuskript fuer Lektorat und
    // Verlag ist genau das die Erwartung.
    if (Number.isInteger(r.noteId)) { out.push(new FootnoteReferenceRun(r.noteId)); continue; }
    const props = {
      text: r.text,
      bold: r.bold || base.bold || undefined,
      italics: r.italic || base.italic || undefined,
      underline: r.underline ? {} : undefined,
      font: base.font || undefined,
      // Notenziffer des Anmerkungsapparats (lib/endnotes.js). Word setzt
      // Hochstellung selbst — Groesse und Grundlinie kommen aus der
      // Zeichenformatierung, nicht aus einer eigenen Berechnung wie im PDF.
      superScript: r.sup || undefined,
    };
    if (r.link && /^(https?:|mailto:)/i.test(r.link)) {
      out.push(new ExternalHyperlink({ link: r.link, children: [new TextRun({ ...props, style: 'Hyperlink' })] }));
    } else {
      out.push(new TextRun(props));
    }
  }
  return out;
}

// Szenentrenner-Paragraph für klassenlose <hr> / leere Autor-Absätze.
function _sceneSeparator(kind) {
  if (kind === 'blank') return new Paragraph({ spacing: { before: 240, after: 240 }, children: [] });
  if (kind === 'line') {
    return new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 240, after: 240 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, space: 4, color: 'aaaaaa' } },
      children: [],
    });
  }
  const text = kind === 'asterism' ? '⁂' : '* * *';
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 240, after: 240 },
    children: [new TextRun(text)],
  });
}

// ── Block → Paragraph[] ──────────────────────────────────────────────────────
function _blockToParagraphs(block, cfg, ctx) {
  const f = cfg.font;
  const indentActive = f.paragraphStyle === 'indent';
  const bodyParaProps = {
    alignment: f.justify ? AlignmentType.JUSTIFIED : AlignmentType.LEFT,
    ...(f.paragraphStyle === 'spaced' ? { spacing: { after: 200 } } : {}),
  };

  switch (block.kind) {
    case 'paragraph': {
      // Erstzeilen-Einzug nur bei Belletristik-Stil; nicht direkt nach einem
      // Szenentrenner/Heading (ctx.suppressIndent).
      const indent = indentActive && !ctx.suppressIndent
        ? { firstLine: convertMillimetersToTwip(f.indentMm) } : undefined;
      ctx.suppressIndent = false;
      return [new Paragraph({ ...bodyParaProps, indent, children: _runsToChildren(block.runs) })];
    }
    case 'blankline':
      // Autor-Leerzeile (leerer Absatz, Enter auf leerer Zeile) = echter
      // Leerabsatz, kein Szenentrenner. Der Folgeabsatz behält seinen
      // Erstzeilen-Einzug — es ist ein normaler Absatzwechsel, kein Szenenbruch.
      return [new Paragraph({ children: [] })];
    case 'table':
      // Word setzt Tabellen selbst (Spaltenbreiten, Zeilenhöhen, Umbruch über
      // Seiten) — der Builder liefert nur Struktur. Details + die zwei
      // Absichtserklärungen an Word: lib/export-builders/docx-table.js.
      // Der Folgeabsatz beginnt ohne Erstzeilen-Einzug: eine Tabelle ist eine
      // Zäsur wie ein Szenentrenner, kein fortlaufender Absatz.
      ctx.suppressIndent = true;
      return tableBlockToDocx(block, cfg, { runsToChildren: _runsToChildren });
    case 'hr':
      // Explizite Trennlinie (Editor-Toolbar) = konfigurierbarer Szenentrenner;
      // der Folgeabsatz wird nach Manuskript-Konvention nicht eingerückt.
      ctx.suppressIndent = true;
      return [_sceneSeparator(cfg.chapter.sceneSeparator)];
    case 'pagebreak':
    case 'blankpage':
      ctx.suppressIndent = true;
      return [new Paragraph({ pageBreakBefore: true, children: [] })];
    case 'heading': {
      ctx.suppressIndent = true;
      // Zwei Skalen fuer dasselbe Markup (Pendant zu lib/pdf-render/blocks.js):
      //
      //   ctx.subHeadings = true  → ueber diesem Text steht schon der Seitentitel
      //     (Heading 4). Die Ueberschriften des Autors liegen darunter und laufen
      //     auf Heading 5/6. Das ist hier nicht bloss eine Groessenfrage: Heading
      //     2/3 stehen im `\o "1-4"`-Bereich des Word-TOC-Felds und wuerden im
      //     Inhaltsverzeichnis UEBER der Seite auftauchen, in der sie stehen.
      //   ctx.subHeadings = false → kein Seitentitel davor (flatten, kapitellose
      //     Seite); dann bleibt die Autoren-Ueberschrift die oberste Marke im
      //     Fluss und behaelt Heading 2/3.
      const lvl = ctx.subHeadings
        ? (block.level === 1 ? HeadingLevel.HEADING_5 : HeadingLevel.HEADING_6)
        : (block.level === 1 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3);
      return [new Paragraph({ heading: lvl, children: [new TextRun({ text: block.text, bold: true })] })];
    }
    case 'list': {
      const out = [];
      block.items.forEach((item, i) => {
        const prefix = block.ordered ? `${i + 1}. ` : '• ';
        item.forEach((sub, si) => {
          if (sub.kind === 'paragraph') {
            const kids = _runsToChildren(sub.runs);
            if (si === 0) kids.unshift(new TextRun(prefix));
            out.push(new Paragraph({ indent: { left: convertMillimetersToTwip(8) }, children: kids }));
          } else {
            out.push(..._blockToParagraphs(sub, cfg, ctx));
          }
        });
      });
      ctx.suppressIndent = true;
      return out;
    }
    case 'poem':
      ctx.suppressIndent = true;
      return block.lines.map(line => new Paragraph({
        spacing: { line: 240, lineRule: LineRuleType.AUTO },
        children: line.length ? _runsToChildren(line, { italic: true }) : [],
      }));
    case 'pre':
      ctx.suppressIndent = true;
      return block.lines.map(line => new Paragraph({
        spacing: { line: 240, lineRule: LineRuleType.AUTO },
        children: _runsToChildren(line, { font: 'Courier New' }),
      }));
    case 'image': {
      // Manuskript-Bild als ImageRun. Bytes/Maße vorab in ctx.pageImages
      // aufgelöst (async, vor dem sync Walk), keyed nach src-String
      // (/content/page-image/:id oder data:). Externe/unauflösbare src: skip.
      const img = ctx.pageImages ? ctx.pageImages.get(block.src) : null;
      if (!img) return [];
      ctx.suppressIndent = true;
      return [new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 120, after: 120 },
        children: [new ImageRun({
          type: img.type,
          data: img.data,
          transformation: { width: img.width, height: img.height },
        })],
      })];
    }
    default:
      return [];
  }
}

// Blockquote braucht echte Einrückung — eigenständig gebaut, weil ein
// docx-Paragraph nach Konstruktion nicht mehr eingerückt werden kann.
//
// `block.cited` (aus `<blockquote data-src>`, siehe html-walker) unterscheidet das
// wörtliche Blockzitat vom stilistischen Zitat: das Zitat steht AUFRECHT — die
// Einrückung ist seine Auszeichnung, Kursive wäre eine zweite und im Manuskript
// für Lektorat/Verlag schlicht falsch. Das stilistische Zitat/Motto bleibt kursiv.
function _blockquoteParagraphs(block, cfg, ctx) {
  const out = [];
  const italic = !block.cited;
  for (const sub of block.blocks) {
    if (sub.kind === 'paragraph') {
      out.push(new Paragraph({
        indent: { left: convertMillimetersToTwip(10) },
        spacing: { after: 120 },
        children: _runsToChildren(sub.runs, { italic }),
      }));
    } else {
      out.push(..._blockToParagraphs(sub, cfg, ctx));
    }
  }
  ctx.suppressIndent = true;
  return out;
}

function _htmlToParagraphs(html, cfg, ctx) {
  const blocks = parseHtmlToBlocks(html);
  const out = [];
  for (const b of blocks) {
    if (b.kind === 'blockquote') out.push(..._blockquoteParagraphs(b, cfg, ctx));
    else out.push(..._blockToParagraphs(b, cfg, ctx));
  }
  return out;
}

// ── Titelei ──────────────────────────────────────────────────────────────────
function _proseParagraphs(text, props = {}) {
  return String(text || '').split(/\n{2,}/).map(p => p.trim()).filter(Boolean).map(p => {
    const runs = [];
    p.split(/\n/).forEach((line, i) => {
      if (i > 0) runs.push({ text: '\n' });
      runs.push({ text: line });
    });
    return new Paragraph({ spacing: { after: 160 }, alignment: props.alignment, children: _runsToChildren(runs, props.run || {}) });
  });
}

function _titlePageParagraphs(title, opts, cfg) {
  const meta = opts.meta || {};
  const L = _labels(opts.lang);
  const out = [];
  out.push(new Paragraph({ spacing: { before: 2400 }, children: [] }));
  out.push(new Paragraph({ heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER, children: [new TextRun({ text: title })] }));
  if (meta.subtitle) {
    out.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120, after: 240 },
      children: [new TextRun({ text: meta.subtitle, italics: true, size: (cfg.font.sizePt + 2) * 2 })] }));
  }
  if (opts.author) {
    out.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 480 }, children: [new TextRun({ text: `${L.by} ${opts.author}` })] }));
  }
  if (meta.year) {
    out.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120 }, children: [new TextRun({ text: String(meta.year) })] }));
  }
  if (cfg.title.wordCount && opts.wordCount) {
    out.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 480 },
      children: [new TextRun({ text: L.words.replace('{n}', opts.wordCount.toLocaleString('de-CH')), italics: true })] }));
  }
  out.push(new Paragraph({ pageBreakBefore: true, children: [] }));
  return out;
}

// Eine Frontmatter-/Backmatter-Seite (eigener Seitenumbruch davor).
function _matterPage(inner) {
  if (!inner.length) return [];
  return [new Paragraph({ pageBreakBefore: true, children: [] }), ...inner];
}

function _imprintPage(opts, cfg) {
  const meta = opts.meta || {};
  const fm = cfg.frontmatter;
  if (!fm.imprint && !fm.copyright) return [];
  const lines = [];
  if (fm.copyright && meta.copyright) lines.push(..._proseParagraphs(meta.copyright));
  if (fm.imprint && meta.imprint) lines.push(..._proseParagraphs(meta.imprint));
  if (fm.imprint && meta.isbn) lines.push(new Paragraph({ spacing: { before: 160 }, children: [new TextRun(`ISBN ${meta.isbn}`)] }));
  return _matterPage(lines);
}

function _buildFrontmatter(opts, cfg) {
  const meta = opts.meta || {};
  const fm = cfg.frontmatter;
  const out = [];
  if (fm.dedication && meta.dedication) {
    out.push(..._matterPage([
      new Paragraph({ spacing: { before: 2400 }, children: [] }),
      ..._proseParagraphs(meta.dedication, { alignment: AlignmentType.CENTER, run: { italic: true } }),
    ]));
  }
  if (fm.frontMatter && meta.frontmatter) {
    out.push(..._matterPage(_proseParagraphs(meta.frontmatter, { alignment: AlignmentType.CENTER, run: { italic: true } })));
  }
  if (fm.imprintPosition === 'front') out.push(..._imprintPage(opts, cfg));
  return out;
}

function _buildBackmatter(opts, cfg) {
  const meta = opts.meta || {};
  const fm = cfg.frontmatter;
  const L = _labels(opts.lang);
  const out = [];
  if (fm.imprintPosition === 'back') out.push(..._imprintPage(opts, cfg));
  if (fm.authorBio && meta.author_bio) {
    out.push(..._matterPage([
      new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: L.aboutAuthor, bold: true })] }),
      ..._proseParagraphs(meta.author_bio),
    ]));
  }
  return out;
}

// ── Kopf-/Fusszeile ──────────────────────────────────────────────────────────
function _pageNumberRun() { return new TextRun({ children: [PageNumber.CURRENT] }); }

function _headerFooter(cfg, ctx) {
  const { mode, pageNumber } = cfg.header;
  const running = mode === 'manuscript' ? `${ctx.surname} / ${ctx.titleKeyword}`
                : mode === 'title' ? ctx.title : '';
  let header, footer;

  if (pageNumber === 'headerRight') {
    const kids = [];
    if (running) kids.push(new TextRun(`${running} / `));
    kids.push(_pageNumberRun());
    header = new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: kids })] });
  } else if (running) {
    header = new Header({ children: [new Paragraph({
      alignment: mode === 'manuscript' ? AlignmentType.RIGHT : AlignmentType.CENTER,
      children: [new TextRun(running)] })] });
  }

  if (pageNumber === 'footer') {
    footer = new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [_pageNumberRun()] })] });
  }
  return { header, footer };
}

// ── Kapitel-Body ─────────────────────────────────────────────────────────────
// Vier Ueberschriftenstufen: level 0..2 sind die drei Kapitelebenen (Word-
// Heading 1..3), level 3 ist der SEITENTITEL (Heading 4). Eine Seite sitzt
// immer unter der tiefstmoeglichen Kapitelebene — mit Heading 2 waere sie in
// einem Sub-Kapitel so gross wie dessen eigene Ueberschrift und in einem
// Sub-Sub-Kapitel groesser als dieses. `forceBreak` traegt den Seitenumbruch
// zwischen den Seiten eines Kapitels; er sitzt am Ueberschriften-Absatz selbst,
// damit kein Leerabsatz oben auf der neuen Seite stehen bleibt.
const PAGE_HEADING_LEVEL = 3;

function _chapterHeading(label, name, level, cfg, ctx, isFirst, forceBreak = false) {
  ctx.suppressIndent = true;
  const text = label ? `${label}.  ${name}` : name;
  const lvl = level === 0 ? HeadingLevel.HEADING_1
    : level === 1 ? HeadingLevel.HEADING_2
      : level === 2 ? HeadingLevel.HEADING_3
        : HeadingLevel.HEADING_4;
  // level 0..2 sind Kapitel; level 3 (Seitentitel) bekommt seinen Umbruch
  // ausschliesslich ueber `forceBreak` (pageBreakBetweenPages).
  const chapterBreak = level === 0
    ? cfg.chapter.pageBreakBefore
    : cfg.chapter.pageBreakBefore && cfg.chapter.breakBeforeSubchapter;
  const pageBreak = (level <= 2 && chapterBreak && !isFirst) || forceBreak;
  return new Paragraph({
    heading: lvl,
    pageBreakBefore: pageBreak,
    alignment: level === PAGE_HEADING_LEVEL ? AlignmentType.LEFT : AlignmentType.CENTER,
    spacing: { before: level === 0 ? 480 : 240, after: 240 },
    children: [new TextRun({ text, bold: true })],
  });
}

// ── Titel-Kopf eines Beitrags ────────────────────────────────────────────────
// Dachzeile und Lead als BENANNTE Absatzformate statt als handformatierte
// Absaetze — dieselbe Entscheidung wie beim Verzeichnis und beim
// Anmerkungsapparat: das Manuskript geht ins Lektorat bzw. an einen Verlag, und
// dort formatiert man Formate um, keine Einzelabsaetze.
//
// `titleLevel: null` laesst die Ueberschrift weg (der Aufrufer hat schon eine
// gesetzt, etwa den Kapitelnamen).
function _headParagraphs(p, cfg, ctx, { titleLevel = null, pageBreak = false } = {}) {
  const out = [];
  const kicker = headline.kickerText(p);
  // Der Umbruch gehoert an den ERSTEN Absatz, den dieser Kopf beisteuert —
  // sonst beginnt die neue Seite mit der Dachzeile auf der alten.
  let breakPending = pageBreak;
  if (kicker) {
    out.push(new Paragraph({
      style: KICKER_STYLE_ID,
      alignment: AlignmentType.CENTER,
      pageBreakBefore: breakPending,
      children: [new TextRun({ text: kicker })],
    }));
    breakPending = false;
  }
  if (titleLevel != null) {
    out.push(_chapterHeading(null, headline.pageTitle(p), titleLevel, cfg, ctx, true, breakPending));
    breakPending = false;
  }
  const lead = headline.leadText(p);
  if (lead) {
    out.push(new Paragraph({ style: LEAD_STYLE_ID, children: [new TextRun({ text: lead })] }));
    // Der erste Absatz des Beitrags folgt auf den Lead, nicht auf die
    // Ueberschrift — er bleibt trotzdem ohne Erstzeilen-Einzug.
    ctx.suppressIndent = true;
  }
  return out;
}

// ── Quellenverzeichnis ───────────────────────────────────────────────────────
// Läuft durch denselben HTML-Walker wie der Buchtext (geteilte SSoT für das
// Eintrags-Markup: lib/bibliography.js#bibliographyItemHtml), bekommt aber den
// benannten Style. Die Überschrift ist ein Heading-1 wie ein Kapiteltitel, damit
// sie im echten Word-TOC-Feld erscheint. Render-Artefakt — nie im Buchtext.
function _bibliographyParagraphs(bib, cfg, ctx) {
  const out = [_chapterHeading(null, bib.title, 0, cfg, ctx, false)];
  for (const b of parseHtmlToBlocks(bibliographyItemHtml(bib))) {
    if (b.kind !== 'paragraph') continue;
    out.push(new Paragraph({ style: BIB_STYLE_ID, children: _runsToChildren(b.runs) }));
  }
  ctx.suppressIndent = true;
  return out;
}

// ── Anmerkungsapparat pro Kapitel ────────────────────────────────────────────
// Dieselbe Datenbasis und dasselbe Eintrags-Markup wie in den uebrigen
// Ausgabewegen (lib/endnotes.js#endnoteItemHtml) — nur der Style ist docx-eigen.
// Ueberschrift bewusst als gewoehnlicher fetter Absatz, nicht als Heading: der
// Apparat soll nicht im Word-TOC-Feld zwischen den Kapiteln auftauchen.
function _endnoteParagraphs(notes, bib, cfg, ctx) {
  if (!notes || !notes.length) return [];
  const out = [new Paragraph({
    spacing: { before: 360, after: 120 },
    children: [new TextRun({ text: notesTitleFor(bib), bold: true })],
  })];
  for (const b of parseHtmlToBlocks(endnoteItemHtml(notes))) {
    if (b.kind !== 'paragraph') continue;
    out.push(new Paragraph({ style: NOTES_STYLE_ID, children: _runsToChildren(b.runs) }));
  }
  ctx.suppressIndent = true;
  return out;
}

function _buildBodyParagraphs(bundle, cfg, ctx) {
  const { groups } = bundle;
  const lang = ctx.lang;
  const out = [];

  const byId = buildChaptersById(groups);
  const numbering = cfg.chapter.numbering;
  const numberingMode = cfg.chapter.numberingMode;
  const excludedIds = new Set(cfg.chapter.unnumberedChapterIds || []);
  const numCounters = [0, 0, 0];
  const chapterLabel = (depth, unnumbered) => {
    if (numbering === 'none') return null;
    const dd = Math.max(1, Math.min(3, depth));
    if (!unnumbered) numCounters[dd - 1] += 1;
    for (let k = dd; k < 3; k++) numCounters[k] = 0;
    return unnumbered ? null : _chapterLabelNested(numbering, numCounters, dd, numberingMode, lang);
  };

  const nested = cfg.chapter.pageStructure === 'nested';

  groups.forEach((g, gi) => {
    const ch = g.chapter;
    const d = ch ? chapterDepth(ch, byId) : 1;
    const level = ch ? Math.min(2, d - 1) : 0;
    const unnumbered = ch ? ancestorInSet(ch, byId, excludedIds) : false;
    const label = ch ? chapterLabel(d, unnumbered) : null;

    if (ch) {
      // Kein `pages.length > 1`-Vorbehalt: die Seite ist ein Strukturelement,
      // und ob ein Kapitel eine oder zwanzig davon hat, aendert daran nichts.
      // Sonst fiele genau das einseitige Sub-Kapitel aus der Gliederung.
      out.push(_chapterHeading(label, ch.name, level, cfg, ctx, gi === 0));
      (g.pages || []).forEach((x, pi) => {
        // Traegt die erste Seite denselben Namen wie ihr Kapitel, stuenden zwei
        // identische Ueberschriften untereinander. Nur das erste Item ist
        // betroffen — nur dort steht der Kapiteltitel unmittelbar darueber.
        // Journalistische Beitraege behalten ihren Kopf in jedem Fall (die
        // Schlagzeile ist nicht der Ordnungsname).
        const ownHead = headline.needsOwnHead(x.p);
        const dupOfChapter = pi === 0 && !ownHead
          && sameStructureTitle(headline.pageTitle(x.p), ch.name);
        // Seitenueberschrift traegt den Beitragstitel. Sie erscheint auch ohne
        // `nested`, sobald der Beitrag eine eigene Schlagzeile hat — sonst
        // stuende ueber dem Artikel nur das Ressort.
        const wantHead = (nested && !dupOfChapter) || ownHead;
        const wantBreak = pi > 0 && nested && cfg.chapter.pageBreakBetweenPages;
        const heads = wantHead
          ? _headParagraphs(x.p, cfg, ctx, { titleLevel: PAGE_HEADING_LEVEL, pageBreak: wantBreak })
          : [];
        // Ohne eigenen Kopf gibt es keinen Absatz, an dem der Umbruch haengen
        // koennte — dann traegt ihn ein leerer Absatz.
        if (wantBreak && !heads.length) out.push(new Paragraph({ pageBreakBefore: true, children: [] }));
        out.push(...heads);
        // Autoren-Ueberschriften eine Stufe tiefer, wenn dieser Beitrag seinen
        // eigenen Titel bekommen hat (siehe case 'heading').
        ctx.subHeadings = wantHead;
        out.push(..._htmlToParagraphs(x.pd.html, cfg, ctx));
        ctx.subHeadings = false;
      });
    } else {
      // Kapitellose Seite: die Ueberschrift oben IST schon der Beitragstitel —
      // dann nur Dachzeile und Lead, und die Dachzeile steht hier notgedrungen
      // darunter statt darueber.
      const x = g.pages[0];
      if (x) {
        out.push(_chapterHeading(label, headline.pageTitle(x.p), level, cfg, ctx, gi === 0));
        if (headline.needsOwnHead(x.p)) {
          out.push(..._headParagraphs(x.p, cfg, ctx, { titleLevel: null }));
        }
        out.push(..._htmlToParagraphs(x.pd.html, cfg, ctx));
      }
    }
    // Im Word-Fussnotenmodus stehen die Noten am Seitenfuss — dann darf hinten
    // am Kapitel nicht dieselbe Liste ein zweites Mal auftauchen.
    if (!ctx.wordFootnotes && g.notes && g.notes.length) out.push(..._endnoteParagraphs(g.notes, ctx.bib, cfg, ctx));
  });
  return out;
}

// ── Manuskript-Bilder vorab auflösen ─────────────────────────────────────────
// Sammelt alle /content/page-image/:id aus dem Bundle-HTML und lädt die BLOBs
// (+ intrinsische Maße) aus der DB in eine Map, skaliert auf die Inhaltsbreite.
// Muss vor dem synchronen HTML-Walk laufen (case 'image' liest nur die Map).
async function _resolvePageImages(bundle, cfg) {
  const map = new Map(); // src-String → { data, type, width, height }
  const srcs = new Set();
  const re = /<img\b[^>]*\bsrc\s*=\s*"([^"]+)"/gi;
  for (const g of bundle.groups || []) {
    for (const x of g.pages || []) {
      const html = x.pd?.html || '';
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(html))) {
        const s = m[1];
        if (/^\/content\/page-image\/\d+/.test(s) || /^data:image\//i.test(s)) srcs.add(s);
      }
    }
  }
  if (!srcs.size) return map;
  const dims = PAGE_DIMS[cfg.page.size] || PAGE_DIMS.A4;
  const contentTwips = dims.width
    - convertMillimetersToTwip(cfg.page.marginsMm.left)
    - convertMillimetersToTwip(cfg.page.marginsMm.right);
  const maxWpx = Math.max(64, Math.round(contentTwips / 15)); // twips→px @96dpi
  const sharp = require('sharp');
  const { getPageImage } = require('../../db/page-images');
  for (const s of srcs) {
    try {
      let buf, mime, iw, ih;
      const pm = /^\/content\/page-image\/(\d+)/.exec(s);
      if (pm) {
        const row = getPageImage(parseInt(pm[1], 10));
        if (!row || !row.image) continue;
        buf = row.image; mime = row.mime; iw = row.width; ih = row.height;
      } else {
        // data:-URI (Fassungs-Export): base64 dekodieren, Maße via sharp.
        buf = Buffer.from(s.slice(s.indexOf(',') + 1), 'base64');
        mime = s.slice(5, (s.indexOf(';') === -1 ? s.indexOf(',') : s.indexOf(';')));
      }
      if (!iw || !ih) { const meta = await sharp(buf).metadata(); iw = meta.width; ih = meta.height; }
      const type = mime === 'image/png' ? 'png' : 'jpg';
      const w = Math.min(iw || maxWpx, maxWpx);
      const h = Math.max(1, Math.round(w * ((ih || 1) / (iw || 1))));
      map.set(s, { data: buf, type, width: w, height: h });
    } catch { /* Bild non-fatal überspringen */ }
  }
  return map;
}

// ── Wortzahl (auf 100 gerundet) ──────────────────────────────────────────────
// Diagramme fallen raus (stripDiagramBlocks): die Wortzahl auf dem Shunn-
// Titelblatt ist eine Angabe an Lektorat/Verlag ueber den Prosa-Umfang, und
// `flowchart TD` ist kein Wort. Gleiche Regel wie page_stats.words.
function _approxWordCount(groups) {
  let words = 0;
  for (const g of groups || []) {
    for (const x of g.pages || []) {
      const text = stripDiagramBlocks(x.pd?.html || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ');
      const m = text.match(/\S+/g);
      words += m ? m.length : 0;
    }
  }
  return Math.round(words / 100) * 100;
}

// ── TOC ──────────────────────────────────────────────────────────────────────
function _tocParagraphs(cfg, opts, bundle) {
  const L = _labels(opts.lang);
  const out = [new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: L.toc, bold: true })] })];
  const nested = cfg.chapter.pageStructure === 'nested';
  const withPages = nested && cfg.toc.includePages !== false;
  if (cfg.toc.mode === 'field') {
    // Word-Feld: `\o "1-N"` kann nur einen zusammenhaengenden Bereich. Seiten
    // sitzen auf Heading 4, also muss der Bereich bis 4 reichen, sobald sie
    // mitkommen — dann sind die Kapitelebenen dazwischen zwangslaeufig drin.
    // Nur die statische Liste kann exakt schneiden.
    const upTo = withPages ? PAGE_HEADING_LEVEL + 1 : cfg.toc.depth;
    out.push(new TableOfContents(L.toc, { hyperlink: true, headingStyleRange: `1-${upTo}` }));
  } else {
    // Statische Liste: nur Titel (Seitenzahlen sind im Reflow-Layout unbekannt).
    const byId = buildChaptersById(bundle.groups);
    const line = (text, level) => new Paragraph({
      indent: { left: convertMillimetersToTwip(level * 6) },
      children: [new TextRun(text)],
    });
    for (const g of bundle.groups) {
      const ch = g.chapter;
      const d = ch ? chapterDepth(ch, byId) : 1;
      if (d > cfg.toc.depth) continue;
      const name = ch ? ch.name : (g.pages[0]?.p && headline.pageTitle(g.pages[0].p));
      if (name) out.push(line(name, d - 1));
      // Seiten als eigene Ebene unter ihrem Kapitel. Ohne Kapitel ist der
      // Eintrag oben schon die Seite selbst.
      if (!ch || !withPages) continue;
      (g.pages || []).forEach((x, pi) => {
        const pageName = headline.pageTitle(x.p);
        if (!pageName) return;
        if (pi === 0 && !headline.needsOwnHead(x.p) && sameStructureTitle(pageName, ch.name)) return;
        out.push(line(pageName, d));
      });
    }
  }
  out.push(new Paragraph({ pageBreakBefore: true, children: [] }));
  return out;
}

// ── Hauptbuilder ─────────────────────────────────────────────────────────────
async function buildDocxProfile(bundle, opts = {}) {
  const cfg = opts.config ? validateConfig(opts.config) : defaultConfig();
  const title = resolveTitle(bundle);
  const lang = (opts.lang || 'de').slice(0, 2);
  const surname = (opts.author || '').trim().split(/\s+/).pop() || (opts.author || '');
  const titleKeyword = title.split(/\s+/).find(w => w.length > 3) || title.split(/\s+/)[0] || title;

  // Quellen: Kurzbeleg-Text frisch setzen bzw. — bei `citation_notes='endnotes'` —
  // den Anmerkungsapparat aufbauen. Beides BEVOR der Walker läuft (der
  // gespeicherte Chip-Text ist nur ein Cache). Läuft über dieselbe Weiche wie
  // HTML/MD/TXT/EPUB (./shared#prepareCitations), damit Word nicht als einziger
  // Ausgabeweg die Buch-Einstellung ignoriert. Ohne `bibliography` bleibt das
  // Bundle unverändert — der Schnellpfad ohne Profil (Normseite) braucht nichts
  // davon.
  //
  // AUSNAHME `citation_notes='footnotes'`: Word kann echte Fussnoten. Statt des
  // Kapitelapparats, auf den prepareCitations seitenlose Formate zurueckfallen
  // laesst, laeuft hier der Notenpass direkt — mit `markerAttr`, damit jeder
  // Marker seine Noten-ID traegt. Word bekommt die Noten dann als eigenes
  // Dokument-Feature und setzt sie selbst an den Seitenfuss.
  const bib = opts.bibliography || null;
  const wordFootnotes = bib?.notesMode === 'footnotes';
  // Diagramme VOR beiden Zweigen aufloesen. Word ist der einzige Builder, der
  // `prepareCitations` unter Umstaenden umgeht (eigener Fussnoten-Mechanismus) —
  // laege die Aufloesung nur dort, haette ausgerechnet der Manuskript-Export
  // fuer Lektorat und Verlag keine Abbildungen.
  //
  // PNG, weil die docx-Lib nur Rasterbilder kennt (ImageRun). Das eingebettete
  // `data:image/png` laeuft anschliessend durch _resolvePageImages, also durch
  // denselben Bildpfad wie ein Manuskript-Bild — kein zweiter Bildmechanismus.
  const dgGroups = await resolveDiagramsInGroups(bundle.groups, { mode: 'png' });
  const dgBundle = dgGroups === bundle.groups ? bundle : { ...bundle, groups: dgGroups };

  let prepared;
  let footnoteMap = null;
  if (wordFootnotes) {
    const r = await buildEndnotes(dgBundle.groups, bib, { markerAttr: true });
    prepared = { groups: r.groups, bib, notes: true, showBibliography: bibliographyVisible(bib) && (opts.scope || bundle.scope || 'book') === 'book' };
    footnoteMap = r.notesById;
  } else {
    prepared = await prepareCitations(dgBundle, {
      ...opts, bibliography: bib, scope: opts.scope || bundle.scope,
    });
  }
  // Immer `prepared.groups` uebernehmen, auch ohne Quellenverzeichnis: dort
  // stecken die aufgeloesten Diagramme drin.
  const citeResolved = { ...dgBundle, groups: prepared.groups };

  // Querverweise auflösen — ebenfalls vor dem Walker, aus demselben Grund.
  // Ohne `chapterLabels`: Word nummeriert seine Überschriften über die
  // Heading-Styles, es gibt hier also keine Renderer-eigene Kapitelnummer, an
  // die sich der Verweis binden müsste. Damit gilt die nested-arabische Vorgabe
  // aus public/js/xrefs/xref-number.js.
  const xrefCtx = await buildXrefContext({
    bookId: bundle.book?.book_id,
    groups: citeResolved.groups,
  });
  const xrefApplied = await applyXrefsInGroups(citeResolved.groups, xrefCtx);
  const wb = xrefApplied.groups === citeResolved.groups
    ? citeResolved
    : { ...citeResolved, groups: xrefApplied.groups };
  // Verzeichnis nur beim ganzen Buch; bei Kapitel-/Seiten-Export werden die Chips
  // aufgelöst, aber kein Verzeichnis angehängt. Die Regel dazu lebt in
  // prepareCitations — hier bewusst keine zweite Kopie.
  const bibVisible = prepared.showBibliography;

  const ctx = { lang, surname, titleKeyword, title, suppressIndent: true, bib, wordFootnotes };
  ctx.pageImages = await _resolvePageImages(wb, cfg);

  const children = [];
  if (cfg.title.mode === 'generated') {
    children.push(..._titlePageParagraphs(title, { ...opts, lang, wordCount: cfg.title.wordCount ? _approxWordCount(wb.groups) : 0 }, cfg));
  }
  children.push(..._buildFrontmatter({ ...opts, lang }, cfg));
  if (cfg.toc.mode !== 'none') children.push(..._tocParagraphs(cfg, { ...opts, lang }, wb));
  children.push(..._buildBodyParagraphs(wb, cfg, ctx));
  // Abbildungs-/Tabellenverzeichnis vor dem Quellenverzeichnis — Reihenfolge der
  // Buchkonvention: erst die Verzeichnisse des Inhalts, dann der Apparat.
  // Sichtbarkeit wie dort: nur beim ganzen Buch.
  if (bibVisible) {
    for (const kind of ['figure', 'table']) {
      const entries = directoryEntries(xrefCtx, kind, { lang: xrefCtx.lang });
      children.push(...directoryParagraphs(entries, directoryTitle(kind, xrefCtx.lang)));
    }
  }
  if (bibVisible) children.push(..._bibliographyParagraphs(bib, cfg, ctx));
  children.push(..._buildBackmatter({ ...opts, lang }, cfg));

  const { header, footer } = _headerFooter(cfg, ctx);
  const dims = PAGE_DIMS[cfg.page.size] || PAGE_DIMS.A4;
  const line = LINE_MULT[cfg.font.lineSpacing] || LINE_MULT.double;
  const sizeHp = cfg.font.sizePt * 2; // docx-Grössen sind Halbpunkte

  // Word-Fussnoten: `{ '<id>': { children: [Paragraph] } }`. Die IDs sind
  // dieselben, die FootnoteReferenceRun im Fliesstext referenziert
  // (lib/endnotes.js vergibt sie buchweit fortlaufend). Word uebernimmt ab hier
  // Platzierung, Umbruch und Anzeige-Nummerierung.
  const footnotes = footnoteMap && footnoteMap.size
    ? Object.fromEntries([...footnoteMap.entries()].map(([id, note]) => [
      String(id),
      { children: [new Paragraph({ style: NOTES_STYLE_ID, children: _runsToChildren(note.runs) })] },
    ]))
    : undefined;

  const doc = new Document({
    creator: opts.author || undefined,
    title,
    ...(footnotes ? { footnotes } : {}),
    ...(cfg.toc.mode === 'field' ? { features: { updateFields: true } } : {}),
    styles: {
      default: {
        document: {
          run: { font: cfg.font.family, size: sizeHp },
          paragraph: { spacing: { line, lineRule: LineRuleType.AUTO } },
        },
        title: { run: { font: cfg.font.family, size: (cfg.font.sizePt + 14) * 2, bold: true } },
        heading1: { run: { font: cfg.font.family, size: (cfg.font.sizePt + 6) * 2, bold: true }, paragraph: { spacing: { line, lineRule: LineRuleType.AUTO }, outlineLevel: 0 } },
        heading2: { run: { font: cfg.font.family, size: (cfg.font.sizePt + 3) * 2, bold: true }, paragraph: { spacing: { line, lineRule: LineRuleType.AUTO }, outlineLevel: 1 } },
        heading3: { run: { font: cfg.font.family, size: (cfg.font.sizePt + 1) * 2, bold: true }, paragraph: { spacing: { line, lineRule: LineRuleType.AUTO }, outlineLevel: 2 } },
        // Seitentitel: dieselbe Groesse wie der Fliesstext, nur fett. Die
        // vierte Stufe soll die Seite markieren, nicht mit den Kapiteln
        // konkurrieren.
        heading4: { run: { font: cfg.font.family, size: cfg.font.sizePt * 2, bold: true }, paragraph: { spacing: { line, lineRule: LineRuleType.AUTO }, outlineLevel: 3 } },
        // Ueberschriften, die der Autor im Seitentext gesetzt hat: unter dem
        // Seitentitel und ausserhalb des TOC-Feld-Bereichs (outlineLevel 4/5).
        heading5: { run: { font: cfg.font.family, size: cfg.font.sizePt * 2, bold: true }, paragraph: { spacing: { line, lineRule: LineRuleType.AUTO }, outlineLevel: 4 } },
        heading6: { run: { font: cfg.font.family, size: cfg.font.sizePt * 2, bold: true, italics: true }, paragraph: { spacing: { line, lineRule: LineRuleType.AUTO }, outlineLevel: 5 } },
      },
      // Quellenverzeichnis: hängender Einzug (erste Zeile am Rand, Folgezeilen
      // eingerückt) und einfacher Zeilenabstand — ein Verzeichnis wird gelesen,
      // nicht lektoriert, und braucht den doppelten Manuskript-Durchschuss nicht.
      paragraphStyles: [{
        id: BIB_STYLE_ID,
        name: BIB_STYLE_ID,
        basedOn: 'Normal',
        next: 'Normal',
        quickFormat: true,
        run: { font: cfg.font.family, size: sizeHp },
        paragraph: {
          spacing: { line: LINE_MULT.single, lineRule: LineRuleType.AUTO, after: 80 },
          indent: {
            left: convertMillimetersToTwip(BIB_HANG_MM),
            hanging: convertMillimetersToTwip(BIB_HANG_MM),
          },
        },
      }, {
        // Anmerkungsapparat: wie das Verzeichnis hängend eingerückt und einfach
        // durchschossen, aber eine Stufe kleiner — er ist Beiwerk zum Kapitel,
        // nicht dessen Fortsetzung. Eigener Style, damit er in Word unabhaengig
        // vom Verzeichnis umformatierbar bleibt.
        id: NOTES_STYLE_ID,
        name: NOTES_STYLE_ID,
        basedOn: 'Normal',
        next: 'Normal',
        quickFormat: true,
        run: { font: cfg.font.family, size: Math.max(2, sizeHp - 4) },
        paragraph: {
          spacing: { line: LINE_MULT.single, lineRule: LineRuleType.AUTO, after: 60 },
          indent: {
            left: convertMillimetersToTwip(BIB_HANG_MM),
            hanging: convertMillimetersToTwip(BIB_HANG_MM),
          },
        },
      }, {
        // Dachzeile: klein, gesperrt, in Versalien — die Versalien setzt Word
        // ueber `allCaps`, der gespeicherte Wortlaut bleibt unangetastet (ein
        // Export darf den Text des Autors nicht umschreiben).
        id: KICKER_STYLE_ID,
        name: KICKER_STYLE_ID,
        basedOn: 'Normal',
        next: 'Normal',
        quickFormat: true,
        run: { font: cfg.font.family, size: Math.max(2, sizeHp - 4), bold: true, allCaps: true, characterSpacing: 20 },
        paragraph: { spacing: { line: LINE_MULT.single, lineRule: LineRuleType.AUTO, before: 360, after: 40 } },
      }, {
        // Lead: eine Stufe groesser als der Fliesstext, ohne Erstzeilen-Einzug —
        // er ist der Einstieg in den Beitrag, nicht dessen erster Absatz.
        id: LEAD_STYLE_ID,
        name: LEAD_STYLE_ID,
        basedOn: 'Normal',
        next: 'Normal',
        quickFormat: true,
        run: { font: cfg.font.family, size: sizeHp + 2 },
        paragraph: {
          spacing: { line, lineRule: LineRuleType.AUTO, after: 200 },
          indent: { firstLine: 0 },
        },
      }],
    },
    sections: [{
      properties: {
        titlePage: cfg.header.skipFirstPage,
        page: {
          size: { width: dims.width, height: dims.height },
          margin: {
            top:    convertMillimetersToTwip(cfg.page.marginsMm.top),
            right:  convertMillimetersToTwip(cfg.page.marginsMm.right),
            bottom: convertMillimetersToTwip(cfg.page.marginsMm.bottom),
            left:   convertMillimetersToTwip(cfg.page.marginsMm.left),
          },
        },
      },
      headers: header ? { default: header, ...(cfg.header.skipFirstPage ? { first: new Header({ children: [new Paragraph({ children: [] })] }) } : {}) } : undefined,
      footers: footer ? { default: footer, ...(cfg.header.skipFirstPage ? { first: new Footer({ children: [new Paragraph({ children: [] })] }) } : {}) } : undefined,
      children,
    }],
  });

  const buf = await Packer.toBuffer(doc);
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
}

// Built-in-Presets für die Sync-/Snapshot-Pfade (kein Profil aus der DB).
// 'reading' = Lesefassung; 'manuscript' = Normseite/Einreich-Manuskript (Times
// 12pt, doppelter Abstand, Shunn-Kopfzeile, generierte Titelseite).
const PRESET_READING = {
  font: { family: 'Georgia', sizePt: 11, lineSpacing: 'oneAndHalf', paragraphStyle: 'indent', justify: true },
  header: { mode: 'title', pageNumber: 'footer', skipFirstPage: true },
  title: { mode: 'generated', wordCount: false },
  chapter: { numbering: 'none', pageBreakBefore: true },
};
const PRESET_MANUSCRIPT = {
  font: { family: 'Times New Roman', sizePt: 12, lineSpacing: 'double', paragraphStyle: 'indent', justify: false },
  header: { mode: 'manuscript', pageNumber: 'headerRight', skipFirstPage: true },
  title: { mode: 'generated', wordCount: true },
  chapter: { numbering: 'none', pageBreakBefore: true },
};

async function buildDocx(bundle, opts = {}) {
  return buildDocxProfile(bundle, { ...opts, config: validateConfig(PRESET_READING) });
}
async function buildDocxNormseite(bundle, opts = {}) {
  return buildDocxProfile(bundle, { ...opts, config: validateConfig(PRESET_MANUSCRIPT) });
}

module.exports = { buildDocx, buildDocxNormseite, buildDocxProfile, DOCX_MIME };
