'use strict';
// Orchestrator des EPUB-Exports: baut aus den Zitat-aufgeloesten Gruppen die
// Kapitel-Liste, reicht sie mit Titelei/Backmatter/Navigation an
// epub-gen-memory und laesst den Post-Step die Umschlagseite injizieren.
// Funktioniert fuer alle Scopes: Buch (Multi-Kapitel-Hierarchie), Kapitel
// (Single-Parent mit Pages als Kinder oder Flach), Seite (Einzel-Entry).

const { EPub } = require('epub-gen-memory');
const logger = require('../../../logger');
const { escXml, resolveTitle, chapterDepth, buildChaptersById, ancestorInSet, prepareCitations, notesTitleFor } = require('../shared');
const { endnoteItemHtml } = require('../../endnotes');
const headline = require('../../headline-render');
// Cover-Normalisierung (mittiger Crop auf Buch-Hochformat + sRGB-JPEG) — teilt
// sich die sharp-Pipeline mit dem PDF-Export.
const { prepareCoverPortrait } = require('../../cover-prepare');
// Reine Kapitel-Label-Logik (arabic/roman/word, flat/nested) — geteilt mit dem
// PDF-Renderer, damit EPUB- und PDF-Numerierung identisch bleiben.
const { _chapterLabelNested } = require('../../pdf-render/layout');
const { _buildCss } = require('./css');
const {
  _buildFrontmatter, _buildImprintBackmatter, _bibliographySection,
  _buildBackmatter, _buildExtraSections,
} = require('./matter');
const { CHAPTER_RULE, _countUnfetchableImages, _stagePageImagesForEpub, _applyBreaks, _dedupeIds } = require('./content');
const { _buildContentOPF } = require('./opf');
const { _buildNavMapXml, _buildTocXhtmlBody, _buildLandmarksNav } = require('./nav');
const { _coverExt, _finalizeEpub } = require('./cover');

// Loest Autor/Sprache/TOC-Titel aus den Build-Optionen (vom Export-Aufrufer
// befuellt: Autor = Buch-Owner-Anzeigename, lang = book_settings.language) mit
// Fallback auf das Domain-Shape bzw. Sprach-Default. Pure + exportiert fuer Tests.
function _resolveEpubMeta(book, opts = {}) {
  const lang = opts.lang || 'de';
  return {
    lang,
    tocTitle: opts.tocTitle || (lang.startsWith('en') ? 'Contents' : 'Inhalt'),
    author: opts.author || book?.created_by?.name || book?.owned_by?.name || '',
  };
}

async function buildEpub(bundle, opts = {}) {
  const { scope, book, chapter, page } = bundle;
  // SVG: EPUB3 traegt Inline-SVG in XHTML. Voraussetzung dafuer ist
  // `htmlLabels: false` im Renderer — mit <foreignObject> wuerde kein Reader
  // das Diagramm zeigen (siehe lib/mermaid-render.js).
  const { groups, bib, showBibliography } = await prepareCitations(bundle, { ...opts, diagramMode: 'svg' });
  const { lang, tocTitle, author } = _resolveEpubMeta(book, opts);
  const meta = opts.meta || null;
  // Anzeige-Autorenstring fuer Titelseite + NCX-docAuthor: Hauptautor + Co-Autoren
  // (Schreib-Duos) mit "&" verbunden. Das Lib-OPF traegt nur den Hauptautor als
  // primaeren dc:creator; Co-Autoren werden in _buildOpfExtraMeta als eigene
  // dc:creator ergaenzt (semantisch korrekt: ein Element je Person).
  const coAuthorNames = (Array.isArray(meta?.co_authors) ? meta.co_authors : [])
    .map(c => String(c?.name || '').trim()).filter(Boolean);
  const displayAuthor = [author, ...coAuthorNames].filter(Boolean).join(' & ');
  const sceneSep = meta?.epub_scene_separator || 'line';
  // Belletristik-Satz (Erstzeilen-Einzug) → Leerzeilen als Szenentrenner.
  const indentActive = meta?.epub_paragraph_style !== 'spaced';
  // Kapiteltitel-Stil + dekorative Striche (Pendant zur PDF-Option). titleStyle
  // steuert Ausrichtung/Groesse via Wrapper-Klasse (CSS). pageRule = Strich unter
  // dem Seitentitel in Mehrseiten-Kapiteln.
  const titleStyle = meta?.epub_chapter_title_style || 'centered-large';
  const chapterRule = !!meta?.epub_chapter_rule;
  const pageRule = !!meta?.epub_page_rule;
  // Dekorativer Strich unter dem Kapiteltitel — nur Top-Level, bei Stil
  // 'left-rule' (impliziter Strich) oder explizit gesetztem epub_chapter_rule
  // (Sub-Kapitel mit Strich wirken zu schwer, wie beim PDF).
  const wantTitleRule = (level) => level === 0 && (titleStyle === 'left-rule' || chapterRule);
  // Strich-Trenner ——— zwischen Kapitelnummer und Titel in der gestapelten,
  // numerierten Ueberschrift. Default an; abschaltbar ueber die Reflow-Option.
  const numberDivider = meta?.epub_chapter_number_divider !== false;
  const titleRuleHtml = '<hr class="epub-title-rule" aria-hidden="true" />';
  const pageRuleHtml = '<hr class="epub-page-rule" aria-hidden="true" />';
  // Kapitelkopf-Wrapper: Klasse fuer den optionalen Seitenumbruch (CSS-Regel nur
  // aktiv bei epub_chapter_pagebreak [Top] bzw. epub_subchapter_pagebreak [Sub])
  // + titleStyle-Modifier (Ausrichtung). level 0 = Top, 1 = Sub-Kapitel.
  const headWrap = (html, level) =>
    `<div class="epub-chapter-head epub-chapter-head--${level === 0 ? 'top' : 'sub'} epub-chapter-head--ts-${titleStyle}">${html}</div>`;
  // Kapitelueberschrift als XHTML. Bei aktiver Numerierung dreistufig gestapelt
  // — Nummer → Strich-Trenner → Titel, mit grosszuegigen Abstaenden via CSS
  // (.epub-chapter-title--numbered). Ohne Label (numbering=none, unnumeriertes
  // Kapitel, Solo-Seite) schlichte einzeilige <h1> wie bisher (kein Stil-Drift).
  // withRule haengt den dekorativen Strich unter die Ueberschrift.
  const chapterHeadingHtml = (label, name, withRule) => {
    const safe = escXml(name);
    const rule = withRule ? titleRuleHtml : '';
    if (!label) return `<h1>${safe}</h1>${rule}`;
    const divider = numberDivider
      ? `<span class="epub-chapter-rule" aria-hidden="true">${CHAPTER_RULE}</span>`
      : '';
    return `<h1 class="epub-chapter-title epub-chapter-title--numbered">`
      + `<span class="epub-chapter-num">${escXml(label)}</span>`
      + divider
      + `<span class="epub-chapter-name">${safe}</span>`
      + `</h1>${rule}`;
  };
  // Seiten innerhalb eines Mehrseiten-Kapitels im Inhaltsverzeichnis zeigen?
  const nestPages = meta?.epub_nest_pages_in_toc !== false;
  // Kapitel-Numerierung (Pendant zur PDF-Option). Das Label wird dem
  // Kapiteltitel im Inhaltsverzeichnis UND der Kapitelueberschrift vorangestellt.
  // Nur echte Kapitel zaehlen; Solo-Seiten ohne Kapitel bleiben unnumeriert.
  const numbering = meta?.epub_chapter_numbering || 'none';
  const numberingMode = meta?.epub_chapter_numbering_mode || 'nested';
  // Kapitel, die ohne Nummer erscheinen sollen (Cascade auf Sub-Kapitel via
  // ancestorInSet). Wie beim PDF: unnumerierte Kapitel zaehlen NICHT mit, die
  // Numerierung laeuft ohne Luecke weiter; tiefere Counter werden trotzdem
  // zurueckgesetzt, damit nachfolgende Sub-Nummern stimmen.
  const excludedIds = new Set(Array.isArray(meta?.epub_unnumbered_chapter_ids) ? meta.epub_unnumbered_chapter_ids : []);
  const numCounters = [0, 0, 0]; // [topIdx, subIdx, subSubIdx]
  const chapterLabel = (depth, unnumbered) => {
    if (numbering === 'none') return null;
    const dd = Math.max(1, Math.min(3, depth));
    if (!unnumbered) numCounters[dd - 1] += 1;
    for (let k = dd; k < 3; k++) numCounters[k] = 0; // tiefere Counter zuruecksetzen
    return unnumbered ? null : _chapterLabelNested(numbering, numCounters, dd, numberingMode, lang);
  };
  const epubChapters = [];
  // NavMap kann nur 2 Ebenen; sub-sub-Kapitel werden auf Level 1 zusammengelegt
  // (Inhalt bleibt vollstaendig, nur die Outline ist flacher).
  const byId = buildChaptersById(groups);
  groups.forEach((g, gi) => {
    const ch = g.chapter;
    const d = ch ? chapterDepth(ch, byId) : 1;
    const level = Math.min(1, d - 1); // 0 = Top, 1 = nested.
    const unnumbered = ch ? ancestorInSet(ch, byId, excludedIds) : false;
    // Label vorab ziehen (mutiert die Counter in Dokumentreihenfolge) — sonst
    // springt die Numerierung. Solo-Seiten (kein ch) ziehen kein Label.
    const label = ch ? chapterLabel(d, unnumbered) : null;
    const withLabel = (name) => (label ? `${label}. ${name}` : name);
    if (ch && g.pages.length > 1) {
      const chTitle = withLabel(ch.name); // TOC/NavMap-Text: flaches "1. Name"
      epubChapters.push({
        title: chTitle,
        content: headWrap(chapterHeadingHtml(label, ch.name, wantTitleRule(level)), level),
        filename: `chap_${gi}.xhtml`,
        __level: level,
        __hasChildren: level === 0 && nestPages,
      });
      g.pages.forEach((x, pi) => {
        // Titel-Kopf: Dachzeile ueber, Lead unter der Kapitel-Ueberschrift der
        // Seite. Auch der TOC-/NavMap-Text folgt dem Beitragstitel — im
        // Inhaltsverzeichnis eines Lesegeraets steht sonst der Ordnungsname.
        const pTitle = headline.pageTitle(x.p);
        epubChapters.push({
          title: pTitle,
          content: _dedupeIds(
            `${headline.kickerHtml(x.p)}<h2>${escXml(pTitle)}</h2>${pageRule ? pageRuleHtml : ''}${headline.leadHtml(x.p)}`
            + _applyBreaks(x.pd.html, sceneSep, indentActive),
          ),
          filename: `chap_${gi}_p_${pi}.xhtml`,
          __level: 1,
          __toc: nestPages,
        });
      });
    } else {
      const x = g.pages[0];
      // Titel-Kopf, zwei Faelle. OHNE Kapitel ist die Dateiueberschrift selbst
      // der Beitragstitel — Dachzeile und Lead rahmen sie. MIT Kapitel bleibt
      // der Kapitelname oben stehen (er ist das Ressort, nicht der Artikel) und
      // der Beitrag bekommt seinen vollstaendigen Kopf inklusive eigener
      // Ueberschrift darunter.
      const title = ch ? withLabel(ch.name) : headline.pageTitle(x.p); // TOC/NavMap-Text
      const headingName = ch ? ch.name : headline.pageTitle(x.p);
      const headInner = (ch ? '' : headline.kickerHtml(x.p)) + chapterHeadingHtml(label, headingName, wantTitleRule(level));
      const afterHead = ch
        ? (headline.needsOwnHead(x.p) ? headline.headHtml(x.p, { titleTag: 'h2' }) : '')
        : headline.leadHtml(x.p);
      const content = _dedupeIds(headWrap(headInner, level) + afterHead + _applyBreaks(x.pd.html, sceneSep, indentActive));
      epubChapters.push({
        title,
        content,
        filename: `entry_${gi}.xhtml`,
        __level: level,
        __hasChildren: false,
      });
    }
    // Anmerkungsapparat des Kapitels als eigene Datei direkt dahinter. Aus der
    // TOC ausgeschlossen (__toc:false) wie Impressum und Autor-Bio: der Apparat
    // ist Beiwerk des Kapitels, kein eigener Navigationspunkt — sonst stuende
    // hinter jedem Kapitel ein zweiter Eintrag im Leser-Menue.
    if (g.notes && g.notes.length) {
      epubChapters.push({
        title: notesTitleFor(bib),
        content: `<div class="endnotes"><h2>${escXml(notesTitleFor(bib))}</h2>${endnoteItemHtml(g.notes)}</div>`,
        filename: `notes_${gi}.xhtml`,
        __level: 1,
        __toc: false,
      });
    }
  });

  const title = resolveTitle({ scope, book, chapter, page });

  // Cover-Bild auf Buch-Hochformat (~1:1.6) zuschneiden, damit es im Reader-Regal
  // ein echtes Buch fuellt statt quadratisch zu schrumpfen. Schlaegt die
  // Normalisierung fehl (korruptes BLOB), faellt es non-fatal auf das Rohbild
  // zurueck — der Export soll nicht am Cover scheitern.
  let coverData = null;
  if (opts.cover?.image && opts.cover.mime) {
    try {
      coverData = await prepareCoverPortrait(opts.cover.image);
    } catch (e) {
      logger.warn(`epub: Cover-Normalisierung fehlgeschlagen (${e.message}) — verwende Rohbild`);
      coverData = { buffer: opts.cover.image, mime: opts.cover.mime, width: 0, height: 0 };
    }
  }
  // Frontmatter (Titelseite/Impressum/Widmung/Motto) vor, Autor-Bio nach dem
  // Inhalt. Alle aus der custom-TOC ausgeschlossen (__toc:false). Die Cover-Seite
  // laeuft NICHT durch diese Pipeline — epub-gen-memory lowercased Attribute
  // (zerstoert SVG viewBox) und schreibt <img src> um; sie wird stattdessen nach
  // genEpub direkt in die ZIP injiziert (siehe _finalizeEpub).
  // Freie Vor-/Nachsatz-Seiten: front zwischen Motto und Inhalt (beforeToc),
  // back nach der Autor-Bio. Reihenfolge innerhalb einer Platzierung = Array-
  // Reihenfolge (vom Autor gepflegt). Impressum-Backmatter (epub_imprint_position
  // === 'back') als Colophon ganz ans Ende.
  const extraSections = _buildExtraSections(meta, { lang });
  const allChapters = [
    ..._buildFrontmatter(meta, { title, author: displayAuthor, lang }),
    ...extraSections.front,
    ...epubChapters,
    ...(showBibliography ? _bibliographySection(bib) : []),
    ..._buildBackmatter(meta, { lang }, opts.authorImage),
    ...extraSections.back,
    ..._buildImprintBackmatter(meta),
  ];

  // Manuskript-Bilder in Temp-Dateien auslagern + src auf file://-URLs umbiegen,
  // damit epub-gen-memory sie nativ einbettet. Aufräumen nach genEpub (finally).
  const stagedImagePaths = _stagePageImagesForEpub(allChapters);

  const unfetchable = _countUnfetchableImages(allChapters);
  if (unfetchable > 0) {
    logger.warn(`epub: ${unfetchable} <img> mit nicht-einbettbarer src (weder http(s) noch data:) — werden vom Reader nicht angezeigt`);
  }

  // TOC-Tiefe (epub_toc_depth): 1 = nur Top-Kapitel, sonst zweistufig. Filtert die
  // NCX-NavMap UND das nav.xhtml. epub_toc_enabled steuert separat die Lese-
  // reihenfolge (Spine) via _finalizeEpub — die Eintraege bleiben fuers Reader-Menue.
  const tocDepth = meta?.epub_toc_depth === 1 ? 1 : 2;
  const navMapXml = _buildNavMapXml(allChapters, tocDepth);
  // bodymatter-Landmark zeigt auf die erste echte Inhalts-Datei (nach Frontmatter).
  const bodyStartFile = epubChapters[0]?.filename;
  const tocBody = `${_buildTocXhtmlBody(allChapters, tocTitle, tocDepth)}\n${_buildLandmarksNav(bodyStartFile, lang, !!coverData)}`;
  const tocNCX = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head>
<meta name="dtb:uid" content="<%= id %>"/>
<meta name="dtb:depth" content="2"/>
<meta name="dtb:totalPageCount" content="0"/>
<meta name="dtb:maxPageNumber" content="0"/>
</head>
<docTitle><text><%= title %></text></docTitle>
<docAuthor><text>${escXml(displayAuthor)}</text></docAuthor>
${navMapXml}
</ncx>`;
  const tocXHTML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="<%- lang %>" lang="<%- lang %>">
<head>
<title><%= title %></title>
<meta charset="UTF-8" />
<link rel="stylesheet" type="text/css" href="style.css" />
</head>
<body>
${tocBody}
</body>
</html>`;

  // Cover als File (epub-gen-memory akzeptiert string-URL oder File). Das bereits
  // hochformat-normalisierte coverData (sRGB-JPEG) wird in ein File gewickelt; die
  // Cover-XHTML-Seite oben referenziert dieselbe cover.jpg.
  let cover;
  if (coverData) {
    cover = new File([coverData.buffer], `cover.${_coverExt(coverData.mime)}`, { type: coverData.mime });
  }

  const css = _buildCss(meta);

  // Buchhandels-Metadaten bevorzugt aus book_publication, Description faellt auf
  // die Domain-Beschreibung zurueck. date: explizites Erscheinungsdatum
  // (epub_pubdate) vor dem Freitext-Jahr.
  const trimmed = v => { const t = String(v ?? '').trim(); return t || undefined; };
  const description = trimmed(meta?.description) || trimmed(book?.description);
  const publisher = trimmed(meta?.publisher);
  const date = trimmed(meta?.epub_pubdate) || trimmed(meta?.year);
  const id = trimmed(meta?.epub_uuid);
  // Bilder vorhanden? Cover, Autorfoto oder Inline-<img> → accessMode `visual`.
  const hasImages = !!cover || !!opts.authorImage?.image || allChapters.some(c => /<img\b/i.test(c.content || ''));
  const contentOPF = _buildContentOPF(
    meta,
    { instanceUrl: opts.instanceUrl, exportedBy: opts.exportedBy },
    { hasImages, lang },
  );

  const epub = new EPub(
    {
      title,
      author: author || undefined,
      description,
      publisher,
      // Eigener Identifier (URN/UUID) wenn gesetzt — sonst Lib-Auto-UUID.
      ...(id ? { id } : {}),
      // date NUR wenn gesetzt — die Lib ueberschreibt sonst ihren Default mit
      // undefined und `new Date(undefined).toISOString()` wirft.
      ...(date ? { date } : {}),
      ...(contentOPF ? { contentOPF } : {}),
      cover,
      lang,
      tocTitle,
      css,
      // Builder liefert eigene Headings (Kapitel-Intro bzw. Seitenname). Lib-
      // Default-Prepend wuerde sie verdoppeln + Seiten innerhalb eines Kapitels
      // ungewollt mit Per-Page-Heading versehen.
      prependChapterTitles: false,
      ignoreFailedDownloads: true,
      tocNCX,
      tocXHTML,
    },
    allChapters,
  );
  let buffer;
  try {
    buffer = await epub.genEpub();
  } finally {
    // Temp-Bilddateien immer aufräumen — auch wenn genEpub wirft.
    const fs = require('fs');
    for (const p of stagedImagePaths) { try { fs.unlinkSync(p); } catch { /* schon weg */ } }
  }
  // Post-Step: Cover-Seite injizieren (wenn Cover) + TOC-Seite aus der Spine
  // entfernen (wenn epub_toc_enabled=false). _finalizeEpub reicht ohne Patch
  // durch (kein Rezip).
  const coverFit = meta?.epub_cover_fit === 'cover' ? 'cover' : 'contain';
  const tocEnabled = meta?.epub_toc_enabled !== false;
  return _finalizeEpub(buffer, { coverData, lang, coverFit, removeTocFromSpine: !tocEnabled });
}

module.exports = { buildEpub, _resolveEpubMeta };
