'use strict';
// PDF-Renderer auf pdfkit. Nimmt geladene Buch-Inhalte (Output von
// loadBookContents) + validiertes Profil-Config und liefert ein finales
// PDF-Buffer (PDF/A-Subset via `subset: 'PDF/A-2b'`, wenn pdfa.standard='pdfa').
//
// Dieser Orchestrator setzt Doc + Fonts + Patches auf, rendert Cover/Titelei,
// baut TOC-Plan + Body und läuft dann die Nach-Body-Pässe (Seitenzahlen,
// TOC-Stempel, Titelei-Nummerierung, Header/Footer, Schnittmarken). Die
// eigentliche Arbeit steckt in den Sub-Modulen:
//   layout        – Geometrie + Kapitel-Label-Formatierung (pure)
//   numbering     – Kapitel-Labels (SSoT für TOC-Plan + Body)
//   page-geometry – Recto/Verso-Margins, Body-Inset, Bleed-Boxes, Paritäts-Pad
//   pages         – Cover/Titel/Widmung/Impressum/TOC-Spezialseiten
//   body          – Kapitel-/Item-Render-Loop
//   page-numbers  – Seitenzahl-Zuordnung + Kapitel-Endseiten (pure)
//   stamp         – TOC-/Titelei-/Header-Footer-/Schnittmarken-Pässe
//   chrome        – Header/Footer-Zeichner + Schnittmarken/Titel-Regel-Primitive

const PDFDocument = require('pdfkit');

const { MM_TO_PT, _pageSize, _currentPageIdx } = require('./layout');
const { _registerFonts, _patchDocTextSanitizer, _patchSoftHyphenStripper, _patchOpenTypeFeatures, _buildFeatureList } = require('./fonts');
const { _patchBlackToK } = require('./color');
const { createHyphenator } = require('./hyphenate');
const {
  _renderCover,
  _renderTitlePage,
  _renderDedicationPage,
  _renderFrontMatterPage,
  _renderAuthorPage,
  _renderImprintPage,
  _imprintHasContent,
  _renderToc,
} = require('./pages');
const { _coalesceGroups } = require('./coalesce');
const { resolveCitesInGroups, bibliographyItemHtml } = require('../bibliography');
const { buildEndnotes, endnoteItemHtml } = require('../endnotes');
const { resolveDiagramsInGroups } = require('../diagram-export');
const { createFootnoteState, stampFootnotes } = require('./footnotes');
const { buildXrefContext, applyXrefsInHtml } = require('../xref-render');
const { computeChapterLabels } = require('./numbering');
const { createPageGeometry } = require('./page-geometry');
const { renderBody } = require('./body');
const { computePageNumbers, computeChapterEndSet } = require('./page-numbers');
const { stampTocPageNumbers, stampFrontMatterNumbering, stampHeaderFooter, stampCropMarks } = require('./stamp');

/**
 * @param {object} args
 * @param {object} args.book        - Book-Metadata (Domain-Shape via content-mapper)
 * @param {object} args.groups      - Output von lib/load-contents.js#loadContents
 * @param {object} args.profile     - Validiertes Profil { config, ... }
 * @param {Buffer|null} args.coverBuf - Vorbereitetes Cover-Image (sharp-prepared) oder null
 * @param {string|null} args.token  - BookStack-Token (für Image-Fetch)
 * @param {string|null} args.lang   - 'de' | 'en'
 * @param {string} [args.scope]     - 'book' | 'chapter' | 'page' (Default 'book')
 * @param {object} [args.chapter]   - Bei scope='chapter'/'page' (falls Page in Kapitel)
 * @param {object} [args.page]      - Bei scope='page'
 * @param {object} [args.bibliography] - Output von lib/bibliography.js#buildBibliography
 * @returns {Promise<Buffer>} PDF-Buffer (vor PDF/A-Postprocess)
 */
async function renderPdfBuffer({ book, groups, profile, coverBuf, authorImageBuf, token, lang, scope = 'book', chapter, page, meta, bibliography = null }) {
  const config = profile.config;
  const layout = config.layout;
  const docLang = (lang === 'en' || lang === 'de') ? lang : 'de';
  // standard ist SSoT (pdfa/pdfx/none); nie neu gespeicherte Alt-Profile ohne
  // den Key fallen auf das abgeleitete Legacy-`enabled` zurück.
  const isPdfA = config.pdfa.standard ? config.pdfa.standard === 'pdfa' : !!config.pdfa.enabled;

  // Beschnitt: Medienseite = Endformat (Trim) + 2×Bleed. Inhalt + Ränder messen
  // ab dem Endformat, deshalb wird der Bleed auf jeden Rand aufaddiert — der Text
  // bleibt so im selben Abstand zur Schnittkante wie ohne Beschnitt.
  const [trimW, trimH] = _pageSize(layout);
  const bleedPt = Math.max(0, config.print?.bleedMm || 0) * MM_TO_PT;
  const pageW = trimW + 2 * bleedPt;
  const pageH = trimH + 2 * bleedPt;
  const margins = {
    top:    layout.marginsMm.top    * MM_TO_PT + bleedPt,
    right:  layout.marginsMm.right  * MM_TO_PT + bleedPt,
    bottom: layout.marginsMm.bottom * MM_TO_PT + bleedPt,
    left:   layout.marginsMm.left   * MM_TO_PT + bleedPt,
  };

  // Author: buch-weiter Publikationsname (book_publication.author_name, bei
  // scope='book' in config.extras gespiegelt) uebersteuert den Account-Namen.
  const author = String(config.extras?.authorName || '').trim()
    || book.created_by?.name || book.owned_by?.name || '';
  // Subject/Keywords aus den buch-weiten Publikations-Metadaten. Title bleibt SSoT books.name.
  const pubSubject  = String(config.extras?.description || '').trim();
  const pubKeywords = String(config.extras?.keywords || '').trim();

  const pdfaConf = String(config.pdfa.conformance || 'B').toLowerCase();
  const docOpts = {
    size: [pageW, pageH],
    margins,
    autoFirstPage: false,
    bufferPages: true,
    pdfVersion: '1.7',
    tagged: true,
    displayTitle: true,
    lang: docLang,
    info: {
      Title:    book.name || '',
      Author:   author,
      ...(pubSubject  ? { Subject:  pubSubject }  : {}),
      ...(pubKeywords ? { Keywords: pubKeywords } : {}),
      Creator:  'schreibwerkstatt',
      Producer: 'pdfkit',
    },
  };
  if (isPdfA) {
    // pdfkit-Subset triggert intern endSubset(): hängt pdfaid-XMP an + schreibt
    // OutputIntent mit eingebettetem sRGB-ICC-Profil. Manuelles Anhängen via
    // doc._root.data.Metadata wird sonst von endMetadata() ueberschrieben.
    docOpts.subset = `PDF/A-2${pdfaConf}`;
  }
  const doc = new PDFDocument(docOpts);

  await _registerFonts(doc, config.font);
  if (isPdfA) _patchDocTextSanitizer(doc);
  // Soft-Hyphen-Stripper läuft unabhängig von Silbentrennung — SHY ist immer
  // unsichtbar, harmlos zu strippen. Schützt PDF/A gegen .notdef-Verstösse bei
  // Fonts ohne SHY-Glyph (alle gängigen Google-Fonts haben keinen).
  _patchSoftHyphenStripper(doc);
  // OpenType-Features (liga/clig/kern + ggf. onum/lnum) global injizieren.
  _patchOpenTypeFeatures(doc, _buildFeatureList(config.font));
  // K-only-Schwarz: schwarze/graue Textfarben als reines DeviceCMYK-K ausgeben
  // (kein Rich-Black im Druck). Nur ausserhalb von PDF/A — dort bräuchte
  // DeviceCMYK ein CMYK-OutputIntent (der PDF/A-Pfad nutzt sRGB).
  if (config.print?.blackTextKOnly && !isPdfA) _patchBlackToK(doc);
  const hyphenator = config.layout.hyphenate !== false ? createHyphenator(docLang) : null;
  const mirror = !!config.layout.mirrorMargins;

  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  // Scope-Adjustments: Cover bei chapter/page weglassen (Buch-Identitaet ist
  // nicht das Subjekt). TOC bei page komplett weg, bei chapter einstufig.
  const coverAllowed = scope === 'book';
  const frontMatterAllowed = scope === 'book';
  const tocEnabled = config.toc.enabled && scope !== 'page';
  const tocDepth = scope === 'chapter' ? 1 : config.toc.depth;
  const tocEffective = { ...config.toc, enabled: tocEnabled, depth: tocDepth };

  // blankPageIdxs sammelt Indizes ohne Header/Footer (leere Verso-Seiten,
  // Impressum, Recto/Verso-Padding). Vor der Geometrie deklariert, weil padToSide
  // Leerseiten dort registriert.
  const blankPageIdxs = new Set();
  const geo = createPageGeometry(doc, { layout, margins, bleedPt, mirror, frontMatterAllowed, blankPageIdxs });
  // Der pageAdded-Hook MUSS vor jedem addPage hängen, damit auch die Titelei
  // (Cover, Title, Widmung, TOC) die korrekte Recto/Verso-Spiegelung + Bleed-
  // Boxes bekommt. Body-Inset schaltet der Body-Loop separat scharf.
  geo.attach();

  // Cover (eigene Page ohne Margins) — kriegt nie einen Footer (Full-Bleed).
  let coverPageCount = 0;
  if (coverAllowed && config.cover.enabled && coverBuf) {
    doc.addPage({ size: [pageW, pageH], margins: { top: 0, right: 0, bottom: 0, left: 0 } });
    await _renderCover(doc, config.cover, coverBuf);
    coverPageCount = 1;
  }

  // Title-Page: bei chapter/page Kapitel-/Seitentitel als Haupttitel, Buchname
  // als Untertitel-Kontext.
  const titleOverrides = {};
  if (scope === 'chapter' && chapter) {
    titleOverrides.title = chapter.name || book.name || '';
    titleOverrides.subtitle = book.name || '';
  } else if (scope === 'page' && page) {
    titleOverrides.title = page.name || book.name || '';
    titleOverrides.subtitle = book.name || '';
  }
  _renderTitlePage(doc, book, config, titleOverrides);

  // Frontmatter-Reihenfolge (Buchkonvention): Impressum/Copyright auf der
  // Titelseiten-Rückseite (wenn imprintPosition='front'), dann Widmung, dann
  // Motto/Vorwort, dann TOC. Nur bei scope='book' (analog Cover/TOC).
  // Default 'front' — deckt auch ältere Profile ohne den Key ab.
  const imprintPos = config.extras.imprintPosition === 'back' ? 'back' : 'front';
  if (frontMatterAllowed && imprintPos === 'front' && _imprintHasContent(config)) {
    if (config.extras.imprintOnVerso) geo.padToSide(false); // Impressum links (Verso)
    _renderImprintPage(doc, config);
  }
  // Widmung (optional, vor TOC + Body) — optional auf rechte (Recto) Seite.
  if (config.extras.dedication) {
    if (config.extras.dedicationOnRecto) geo.padToSide(true);
    _renderDedicationPage(doc, config);
  }
  // Motto / Epigraph / kurzes Vorwort (optional, vor TOC)
  if (frontMatterAllowed) _renderFrontMatterPage(doc, config);

  // Quellen-Chips: den Kurzbeleg-Text frisch setzen, BEVOR der HTML-Walker läuft
  // (der gespeicherte Text ist nur ein Cache; im numerischen Stil steht dort noch
  // die Autor-Jahr-Form). Siehe lib/bibliography.js.
  //
  // Im Anmerkungsmodus (`citation_notes='endnotes'`) tritt an die Stelle dieses
  // Passes der Notenpass: der Chip trägt dann keine Klammerform, sondern die
  // Notenziffer, und pro Kapitel entsteht eine Notenliste. Nie beide — der zweite
  // Pass würde das Ergebnis des ersten überschreiben.
  //
  // `footnotes` ist derselbe Apparat, nur anders platziert: die Noten stehen am
  // FUSS DER SEITE ihres Markers statt am Kapitelende. Datenseitig identisch —
  // darum derselbe Pass, nur mit `markerAttr`, damit der Renderer vom Marker aus
  // seine Note findet (siehe lib/endnotes.js#_markerHtml).
  //
  // Zweispaltensatz kann keinen Seitenfuss-Apparat: pdfkit paginiert die Spalten
  // selbst, es gibt keinen Per-Zeilen-Hook für die Reserve. Dort fällt der Modus
  // auf den Kapitelapparat zurück (siehe meta.footnoteFallback).
  const notesMode = bibliography?.notesMode;
  const columnsBlockFootnotes = (config.layout.columns || 1) > 1;
  const wantFootnotes = notesMode === 'footnotes' && !columnsBlockFootnotes;
  const useNotes = notesMode === 'endnotes' || (notesMode === 'footnotes' && !wantFootnotes);
  const notePass = !!bibliography && (useNotes || wantFootnotes);
  let notesById = null;
  // Diagramme VOR den Quellen und vor dem Walker: der Walker kennt kein
  // `pre.mermaid`, wohl aber `<img src="data:image/png;base64,…">` — damit
  // greifen Groessenrechnung und Seitenumbruch des vorhandenen Bildpfads. PNG
  // statt SVG, weil pdfkit kein SVG einbetten kann. Nicht renderbar ⇒ der
  // Quelltext bleibt als Codeblock stehen (lib/diagram-export.js, Invariante B).
  let srcGroups = await resolveDiagramsInGroups(groups, { mode: 'png' });
  if (notePass) {
    const r = await buildEndnotes(srcGroups, bibliography, { markerAttr: wantFootnotes });
    srcGroups = r.groups;
    notesById = r.notesById;
  } else if (bibliography) {
    srcGroups = await resolveCitesInGroups(srcGroups, bibliography);
  }
  if (meta && columnsBlockFootnotes && notesMode === 'footnotes') meta.footnoteFallback = true;

  // Koaleszierte Blöcke + Kapitel-Labels (SSoT für TOC-Plan und Body-Loop).
  const blocks = _coalesceGroups(
    srcGroups,
    config.chapter.pageStructure,
    config.chapter.pageBreakBetweenPages,
    config.chapter.unnumberedChapterIds,
    config.chapter.skipPageCounterChapterIds,
  );

  // Anmerkungsapparat: pro Kapitel ein zusätzliches Item AM ENDE des jeweiligen
  // Kapitel-Blocks. Bewusst kein eigener Block — sonst bekäme der Apparat einen
  // Kolumnentitel und einen TOC-Eintrag und stünde als Pseudo-Kapitel im
  // Verzeichnis. Als Item läuft er im Fluss hinter dem Kapiteltext und erbt
  // dessen Kolumnentitel, bekommt über `isEndnotes` aber den Verzeichnis-Satz
  // (kleinere Schrift, hängender Einzug — siehe body.js).
  //
  // Index-Zuordnung ist zulässig, weil `_coalesceGroups` je Gruppe genau einen
  // Block in derselben Reihenfolge liefert.
  if (useNotes) {
    srcGroups.forEach((g, gi) => {
      const block = blocks[gi];
      if (!block || !g.notes?.length) return;
      // `notesTitle` ist ein Label-Konstante aus der Format-SSoT, keine
      // User-Eingabe — die Einträge selbst sind über runsToHtml bereits escapet.
      block.items.push({
        html: `<h3>${bibliography.notesTitle}</h3>\n${endnoteItemHtml(g.notes)}`,
        isEndnotes: true,
      });
    });
  }

  // Quellenverzeichnis als synthetische Kapitel-Gruppe hinter den Buchkapiteln:
  // Ab hier ist es ein Block wie jeder andere und bekommt Kolumnentitel,
  // Seitenzahlen und TOC-Eintrag durch dieselben Pässe. Immer unnummeriert (ein
  // Verzeichnis trägt keine Kapitelnummer) und nur beim ganzen Buch — bei
  // Kapitel-/Seiten-Scope werden die Chips zwar aufgelöst, aber kein Verzeichnis
  // angehängt. Das Verzeichnis ist ein Render-Artefakt und wird nie persistiert.
  const bibVisible = !!(bibliography?.enabled && scope === 'book' && bibliography.entries?.length);
  if (bibVisible) {
    blocks.push({
      title: bibliography.title, level: 0, isChapter: true, isBibliography: true,
      chapterId: null, depth: 1, unnumbered: true, skipPageCounter: false,
      items: [{ html: bibliographyItemHtml(bibliography) }],
    });
  }

  const labels = computeChapterLabels(blocks, config, docLang);

  // Querverweise aufloesen, NACHDEM die Kapitel-Labels feststehen und BEVOR der
  // HTML-Walker laeuft. Beide Bedingungen sind zwingend:
  //
  //   nach den Labels — der Verweis muss exakt die Nummer nennen, die die
  //   Ueberschrift traegt. Bei roemischem Profil heisst dasselbe Kapitel „III",
  //   bei `numbering: 'none'` gar nicht (dann faellt der Verweis auf den
  //   Kapiteltitel zurueck). Darum bekommt buildXrefContext genau diese Map
  //   herein, statt selbst zu zaehlen (SSoT bleibt ./numbering.js).
  //
  //   vor dem Walker — der gespeicherte Verweistext ist nur ein Cache vom
  //   Einfuege-Zeitpunkt. Dieselbe Reihenfolge wie bei den Quellen-Chips.
  const xrefLabels = new Map();
  for (let bi = 0; bi < blocks.length; bi++) {
    if (blocks[bi].chapterId != null && labels[bi].label) {
      xrefLabels.set(String(blocks[bi].chapterId), labels[bi].label);
    }
  }
  const xrefCtx = await buildXrefContext({
    bookId: book.book_id,
    groups: srcGroups,
    chapterLabels: xrefLabels,
  });
  // Verwaiste Verweise sind non-fatal (Invariante C): der Text des Autors bleibt
  // stehen, das PDF entsteht. Gemeldet werden sie ueber `meta` — denselben Weg,
  // den die DPI-Warnungen nehmen, damit der Job sie dem User zeigen kann statt
  // sie im Serverlog zu begraben.
  const xrefUnresolved = [];
  for (const b of blocks) {
    for (const item of b.items || []) {
      if (typeof item.html !== 'string') continue;
      const res = await applyXrefsInHtml(item.html, xrefCtx);
      if (res.html !== item.html) item.html = res.html;
      xrefUnresolved.push(...res.unresolved);
    }
  }

  // TOC-Plan: stabile Zuordnung Plan → Body-Heading via blockIdx/itemIdx. Der
  // Body-Loop schreibt pageIdx zurück; der TOC-Stempel-Pass setzt danach die
  // Seitenzahl an der gespeicherten Position (Two-Pass-TOC). `num` bleibt vom
  // Titel getrennt, damit _renderToc die Nummern in eigener Spalte ausrichtet.
  const tocPlan = [];
  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi];
    const { label, depth } = labels[bi];
    tocPlan.push({ title: b.title, num: label || '', level: depth - 1, blockIdx: bi, itemIdx: -1, pageIdx: -1 });
    if (b.isChapter && config.chapter.pageStructure === 'nested') {
      for (let i = 0; i < b.items.length; i++) {
        if (b.items[i].heading) {
          tocPlan.push({ title: b.items[i].heading, num: '', level: depth, blockIdx: bi, itemIdx: i, pageIdx: -1 });
        }
      }
    }
  }
  // Inhaltsverzeichnis auf rechte (Recto) Seite (optional).
  if (tocEffective.enabled && config.toc.startOnRecto) geo.padToSide(true);
  const tocPositions = tocEffective.enabled ? _renderToc(doc, tocEffective, tocPlan, docLang, config.font) : [];

  // Erstes Kapitel (= erste Body-Seite) auf rechte (Recto) Seite (optional). Vor
  // der bodyStartPageIdx-Erfassung padden, damit die eingeschobene Leerseite noch
  // zur Titelei zählt und die erste Body-Seite selbst auf Recto beginnt.
  if (config.chapter.firstChapterOnRecto) geo.padToSide(true);

  // Body rendern
  const imageCache = new Map(); // src → { buffer, width, height } | null
  const dropCapHint = { pending: false };
  const firstParaHint = { pending: false };
  const dpiWarnings = [];
  // Fussnoten-Zustand: haelt pro Seite, welche Noten dort haengen, und zieht
  // `margins.bottom` nach. Nur im Fussnotenmodus — sonst bleibt er null und der
  // Layouter laeuft unveraendert.
  const footnotes = wantFootnotes && notesById && notesById.size
    ? createFootnoteState({
      doc,
      notesById,
      cfg: config.footnotes,
      fontCfg: config.font.footnote || config.font.body,
      outerMargins: margins,
      pageWidth: doc.page.width,
      pageHeight: doc.page.height,
    })
    : null;

  const renderCtx = {
    font: config.font, token, imageCache, dropCapHint, firstParaHint,
    footnotes,
    columns: layout.columns || 1,
    columnGap: (layout.columnGapMm || 0) * MM_TO_PT,
    bodyFirstLineIndentPt: (config.font.body.firstLineIndentMm || 0) * MM_TO_PT,
    // Hängender Einzug der Verzeichniseinträge (Verzeichniskonvention: erste
    // Zeile am Rand, Folgezeilen eingerückt; im numerischen Stil steht die
    // Nummer damit in eigener Spalte). Fester Wert — schmaler als der
    // klassische halbe Zoll, weil Buchformate ein engeres Satzmass haben als
    // ein A4-Manuskript.
    bibliographyHangPt: 5 * MM_TO_PT,
    hyphenate: hyphenator,
    widowOrphanControl: layout.widowOrphanControl !== false,
    dpiWarnThreshold: config.print?.dpiWarnThreshold || 0,
    dpiWarnings,
  };
  const { bodyStartPageIdx, chapterFirstPage, pageTitleFirstPage } = await renderBody(doc, {
    blocks, config, labels, tocPlan, renderCtx, geo, blankPageIdxs, dropCapHint, firstParaHint,
  });
  geo.detach();

  // Fussnotenapparat auf die Seiten malen. Der Platz ist waehrend des Bodys
  // reserviert worden; hier wird nur noch gezeichnet. Laeuft VOR den uebrigen
  // Stamp-Paessen, ist aber von deren Reihenfolge unabhaengig — der Pass liest
  // keine Seitenraender, sondern nur sein eigenes Register (siehe footnotes.js).
  if (footnotes) {
    stampFootnotes(doc, footnotes, {
      outerMargins: margins,
      color: (config.font.footnote || config.font.body).color || '#000000',
      separator: config.footnotes.separator !== false,
      separatorWidthMm: config.footnotes.separatorWidthMm,
    });
    if (meta) meta.footnoteOverflowPages = footnotes.overflowCount();
  }

  // Backmatter: "Über den Autor"-Seite (optional), dann Impressum ans Buchende
  // falls imprintPosition='back'. Beide bekommen KEINEN Header/Footer (Konvention)
  // und zählen nicht in der Seitennummerierung.
  if (frontMatterAllowed) {
    const authorRendered = await _renderAuthorPage(doc, config, docLang, authorImageBuf);
    if (authorRendered) blankPageIdxs.add(_currentPageIdx(doc));
  }
  if (frontMatterAllowed && imprintPos === 'back' && _imprintHasContent(config)) {
    if (config.extras.imprintOnVerso) geo.padToSide(false); // Impressum links (Verso)
    if (_renderImprintPage(doc, config)) blankPageIdxs.add(_currentPageIdx(doc));
  }

  // Print-Konvention: Gesamtseitenzahl auf gerade Zahl auffüllen (Druckbogen;
  // von Print-on-Demand-Diensten wie KDP zwingend verlangt). Trailing-Leerseite
  // ohne Header/Footer/Nummer. Muss NACH allen Backmatter-Seiten laufen und VOR
  // dem Nummerierungs-Pass, damit blankPageIdxs sie aus der Zählung nimmt.
  if (frontMatterAllowed && config.print?.padToEvenPages && doc.bufferedPageRange().count % 2 === 1) {
    doc.addPage();
    geo.setPageBoxes();
    blankPageIdxs.add(_currentPageIdx(doc));
  }

  // Nach-Body-Pässe: Seitenzahl-Zuordnung, TOC-/Titelei-/Header-Footer-Stempel,
  // Schnittmarken.
  const range = doc.bufferedPageRange();
  const skipPageIdSet = new Set(Array.isArray(config.chapter.skipPageCounterPageIds) ? config.chapter.skipPageCounterPageIds : []);
  const { pageNumByIdx, totalBodyPages } = computePageNumbers({
    layout, range, bodyStartPageIdx, chapterFirstPage, pageTitleFirstPage, blankPageIdxs, skipPageIdSet,
  });

  stampTocPageNumbers(doc, { tocEffective, tocPlan, tocPositions, pageNumByIdx, config });

  // Schriftbild der laufenden Kopf-/Fusszeile (Familie/Grösse/Farbe pro Zeile).
  // Font-Keys 'header'/'footer' sind in _registerFonts registriert; ältere
  // Profile ohne die Rollen fallen dort auf die Body-Familie zurück.
  const hdrF = config.font.header || config.font.body;
  const ftrF = config.font.footer || config.font.body;
  const chromeFonts = {
    header: { key: 'header', size: hdrF.sizePt, color: hdrF.color },
    footer: { key: 'footer', size: ftrF.sizePt, color: ftrF.color },
  };

  stampFrontMatterNumbering(doc, {
    layout, range, coverPageCount, bodyStartPageIdx, blankPageIdxs, book, author, margins, chromeFonts,
  });

  const chapterEndSet = computeChapterEndSet({ chapterFirstPage, range, blankPageIdxs });
  stampHeaderFooter(doc, {
    range, bodyStartPageIdx, layout, blankPageIdxs, chapterFirstPage, pageTitleFirstPage,
    chapterEndSet, pageNumByIdx, totalBodyPages, book, author, margins, chromeFonts,
  });

  if (bleedPt > 0 && config.print?.cropMarks) stampCropMarks(doc, { bleedPt });

  if (meta) meta.dpiWarnings = dpiWarnings;
  if (meta) meta.xrefUnresolved = xrefUnresolved;
  // Physische Gesamtseitenzahl des Innenteils (inkl. manueller Umbrüche,
  // Leerseiten und der padToEvenPages-Auffüllseite) — die Zahl, die eine
  // Druckerei/KDP für Rückenbreite und Bundsteg zählt. Der Aufrufer spiegelt sie
  // in coverSpec.pageCount.
  if (meta) meta.totalPages = doc.bufferedPageRange().count;

  doc.flushPages();
  doc.end();
  return done;
}

module.exports = { renderPdfBuffer, MM_TO_PT };
