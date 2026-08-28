'use strict';
// Default-Config für neue PDF-Export-Profile + Schema-Validator. Wird bei
// Profile-Erstellung als Vorlage gemerged und beim Speichern strikt geprüft —
// unbekannte Top-Level-Keys werden verworfen, Werte gegen Allow-Lists/Ranges
// gevalidiert. So bleiben User-Inputs sauber bei manueller JSON-Bearbeitung.

// Tabellensatz liegt in einem eigenen Modul: die Datei lief sonst ueber das
// 600-LOC-Limit (tests/unit/loc-limits.test.mjs), und der Block ist ein
// abgeschlossenes Thema mit eigenen Enums.
const { DEFAULT_TABLE, validateTable } = require('./pdf-export-defaults/table');
// Coercion-Atome geteilt mit den Untermodulen (siehe ./pdf-export-defaults/coerce.js):
// eine Kopie je Modul waere genau die Drift, gegen die die strikte Validierung antritt.
const { isObj: _isObj, num: _num, enumOf: _enum, bool: _bool, hex: _hex } = require('./pdf-export-defaults/coerce');

const PAGE_SIZES = ['A4', 'A5', 'A6', 'Letter', 'custom'];
const COLUMNS    = [1, 2];
const BREAK_BEFORE = ['always', 'right-page', 'none'];
const NUMBERING    = ['none', 'arabic', 'roman', 'word'];
const NUMBERING_MODE = ['flat', 'nested'];
const FRONTMATTER_NUMBERING = ['none', 'roman', 'arabic'];
const PAGE_COUNT_MODE = ['body', 'physical'];
const TITLE_STYLE  = ['centered-large', 'left-rule', 'minimal'];
const PAGE_STRUCTURE = ['flatten', 'nested'];
const COVER_FIT    = ['cover', 'contain'];
const TOC_DEPTH    = [1, 2, 3];
const TOC_LEADER   = ['none', 'dots', 'line'];
const TOC_TITLE_ALIGN = ['left', 'center', 'right'];
const PDFA_CONF    = ['B'];
const NUMERALS     = ['auto', 'lining', 'oldstyle'];
const IMPRINT_POS  = ['front', 'back'];
// Druck-/Archiv-Norm: 'pdfa' = PDF/A-2B (Archiv, sRGB, pdfkit-Subset),
// 'pdfx' = PDF/X-3 (Druckvorstufe, RGB + Output-Intent via Ghostscript-Post-Step),
// 'none' = unmarkiertes PDF.
const NORM_STD     = ['pdfa', 'pdfx', 'none'];

// Schrift-Auszeichnung pro Kopf-/Fusszeilen-Slot.
const HF_ZONES = ['header', 'footer'];
const HF_SIDES = ['recto', 'verso'];
const HF_POS   = ['left', 'center', 'right'];
function _emptyHfPos()  { return { bold: false, italic: false, upper: false }; }
function _emptyHfSide() { return { left: _emptyHfPos(), center: _emptyHfPos(), right: _emptyHfPos() }; }
function _defaultHfStyle() {
  const out = {};
  for (const z of HF_ZONES) out[z] = { recto: _emptyHfSide(), verso: _emptyHfSide() };
  return out;
}

const DEFAULT_CONFIG = {
  layout: {
    pageSize: 'A4',
    customWidthMm: 210,
    customHeightMm: 297,
    marginsMm: { top: 25, right: 22, bottom: 25, left: 22 },
    bodyInsetMm: { top: 0, right: 0, bottom: 0, left: 0 },
    columns: 1,
    columnGapMm: 6,
    // Recto = rechte/ungerade Seiten (Basis-Slots; gelten auf allen Seiten,
    // solange die zugehoerigen Verso-Slots leer sind).
    headerLeft: '', headerCenter: '{title}', headerRight: '',
    footerLeft: '', footerCenter: '{page}',  footerRight: '',
    // Verso = linke/gerade Seiten. Leerer Verso-Slot faellt auf den Recto-Slot
    // zurueck (dann kein Unterschied). Klassisch: verso=Buchtitel, recto=Kapitel.
    headerVersoLeft: '', headerVersoCenter: '', headerVersoRight: '',
    footerVersoLeft: '', footerVersoCenter: '', footerVersoRight: '',
    // Schrift-Auszeichnung pro Slot: {bold,italic,upper} je Position
    // (left/center/right) × Buchseite (recto/verso) × Zone (header/footer).
    // upper = Grossbuchstaben (Versalien). Die Auszeichnung folgt der Text-
    // Auflösung: zeigt eine Verso-Seite den Recto-Text (leerer Verso-Slot),
    // gilt auch die Recto-Auszeichnung.
    hfStyle: _defaultHfStyle(),
    headerRule: false,
    footerRule: false,
    // Default-Konvention: erste Seite eines Kapitels traegt weder Header
    // noch Pagenummer (Buchkonvention).
    showHeaderOnChapterStart: false,
    showFooterOnChapterStart: false,
    // Letzte (Inhalts-)Seite eines Kapitels: Header/Pagenummer standardmaessig
    // sichtbar (kein Konventions-Grund zu unterdruecken). Abschaltbar, wenn die
    // Kapitel-Endseite bewusst leer/ruhig bleiben soll.
    showHeaderOnChapterEnd: true,
    showFooterOnChapterEnd: true,
    // Spiegel-Margins fuer Recto/Verso: bei jeder verso-Page (Page 2, 4, …)
    // tauschen left/right. marginsMm.left ist dann immer der Bund-seitige
    // (inner) Wert, .right der aussen-seitige.
    mirrorMargins: false,
    // Silbentrennung via Hypher; nutzt docLang (de/en). Aus PDF/A-Sicht
    // unbedenklich — Soft-Hyphens werden vor Encoding gestrippt.
    hyphenate: true,
    // Witwen-/Waisen-Kontrolle: vor jedem Paragraph Höhe messen und ganzen
    // Absatz auf nächste Seite schieben, falls sonst nur 1 Zeile oben/unten
    // alleine stünde.
    widowOrphanControl: true,
    // pageNumberStart: Wert, den die erste gezählte Seite trägt.
    // pageCountMode: welche Seiten in den Zähler eingehen.
    //   'body'     → nur Textseiten. Titelei (Cover/Titel/Widmung/Frontmatter/
    //                TOC) und Leerseiten im Body zählen nicht mit; die gedruckte
    //                Zahl ist kleiner als die physische PDF-Seite (Buchkonvention).
    //   'physical' → alle physischen Seiten. Titelei + Body-Leerseiten zählen
    //                mit, sodass die gedruckte Zahl der PDF-Seite entspricht
    //                (physische Seite 1 = »1«). Titelei + Leerseiten zeigen selbst
    //                nie eine Nummer im Footer, verbrauchen aber je einen Zählschritt.
    // pageNumberFirstVisible: erst ab diesem gezählten Wert wird die Nummer im
    //   Footer sichtbar; frühere (gezählte) Seiten bleiben ohne sichtbare Nummer.
    pageNumberStart: 1,
    pageCountMode: 'body',
    pageNumberFirstVisible: 1,
    // Eigener Zählstrang für die Titelei (Titel/Widmung/Motto/TOC, Cover nie):
    //   'none'   → Titelei ohne Nummer (Default, Buchkonvention nur wenn auch
    //              pageCountMode='body')
    //   'roman'  → i, ii, iii …
    //   'arabic' → 1, 2, 3 …
    // frontMatterNumberFirstVisible: ab welcher gezählten Titelei-Seite die
    //   Nummer sichtbar wird (Cover + leere/Impressum-Seiten zählen nicht mit).
    frontMatterNumbering: 'none',
    frontMatterNumberFirstVisible: 1,
  },
  // heading.color dient zusätzlich als Farbe für Kapitel-/Seiten-Trennlinien
  // (titleRule, pageTitleRule) — abgestimmt auf die Überschrift.
  font: {
    body:     { family: 'Lora',             weight: 400, sizePt: 11, lineHeight: 1.45, paragraphGap: 0.3, firstLineIndentMm: 0, color: '#1a1a1a', numerals: 'auto' },
    // EINE absteigende Kette, deren Reihenfolge die Aussage ist: h1..h3 = die
    // drei Kapitelebenen (nach `depth`), h4 = der SEITENTITEL (eine Seite sitzt
    // unter der tiefstmoeglichen Kapitelebene — mit h2 waere sie in einem
    // Sub-Kapitel gleich gross, in einem Sub-Sub-Kapitel groesser als ihr
    // Container), h5/h6 = die Ueberschriften, die der AUTOR im Seitentext setzt
    // (auf der Kapitelskala laesst ein `<h1>` dort den Seitentitel wie eine
    // Unterzeile seines eigenen Inhalts aussehen). Muss absteigend bleiben:
    // h1 > h2 > h3 > h4 > h5 > h6 >= body.
    heading:  { family: 'Playfair Display', weight: 700, sizes: { h1: 24, h2: 18, h3: 14, h4: 13, h5: 12, h6: 11 }, color: '#1a1a1a' },
    title:    { family: 'Playfair Display', weight: 700, sizePt: 38, color: '#1a1a1a' },
    subtitle: { family: 'Playfair Display', weight: 400, sizePt: 18, color: '#333333' },
    byline:   { family: 'Lora',             weight: 400, sizePt: 12, color: '#4a4a4a' },
    dedication: { family: 'Lora',             weight: 400, sizePt: 13, color: '#1a1a1a', italic: true },
    frontMatter:{ family: 'Lora',             weight: 400, sizePt: 13, color: '#1a1a1a', italic: true },
    authorBio:  { family: 'Lora',             weight: 400, sizePt: 11, lineHeight: 1.45, paragraphGap: 0.3, color: '#1a1a1a', italic: false },
    // Quellenverzeichnis (Backmatter, siehe lib/bibliography.js). Etwas kleiner
    // als der Fliesstext — Verzeichniskonvention.
    bibliography:{ family: 'Lora',            weight: 400, sizePt: 10, lineHeight: 1.35, paragraphGap: 0.3, color: '#1a1a1a', italic: false },
    // Fussnotenapparat am Seitenfuss (lib/pdf-render/footnotes.js). Kleiner als
    // das Verzeichnis: der Apparat steht auf jeder Seite und soll den
    // Fliesstext nicht optisch bedraengen.
    footnote:    { family: 'Lora',            weight: 400, sizePt: 8,  lineHeight: 1.25, color: '#1a1a1a', italic: false },
    imprint:    { family: 'Lora',             weight: 400, sizePt: 10, color: '#1a1a1a', italic: false },
    year:       { family: 'Lora',             weight: 400, sizePt: 12, color: '#4a4a4a', italic: false },
    toc:        { family: 'Lora',             weight: 400, sizePt: 11, lineHeight: 1.45, paragraphGap: 0.3, color: '#1a1a1a' },
    tocTitle:   { family: 'Playfair Display', weight: 700, sizePt: 20, color: '#1a1a1a' },
    // Laufende Kopf-/Fusszeile (running head/foot). Slots + Sichtbarkeit stehen
    // in config.layout; hier nur das Schriftbild (Familie/Gewicht/Grösse/Farbe).
    header:     { family: 'Lora',             weight: 400, sizePt: 9,  color: '#666666' },
    footer:     { family: 'Lora',             weight: 400, sizePt: 9,  color: '#666666' },
  },
  chapter: {
    breakBefore: 'always',
    // Sub-Kapitel beginnen wie Top-Kapitel auf neuer Seite. Sonst haelt die
    // Zusage „jede Seite beginnt neu" in einer Hierarchie nicht: die ERSTE Seite
    // eines Sub-Kapitels folgt seiner Ueberschrift, die inline unter dem Text
    // der vorigen Seite stuende.
    breakBeforeSubchapter: true,
    // firstChapterOnRecto: das erste Kapitel (= erste Body-Seite) auf einer
    // rechten (ungeraden) Seite beginnen (Buchkonvention). Bei Bedarf wird eine
    // leere Verso-Seite davor eingeschoben. Nur wirksam bei scope='book'.
    firstChapterOnRecto: true,
    blankPageAfter: false,
    numbering: 'none',
    numberingMode: 'nested',      // 'flat' = 1, 2, 3; 'nested' = 1, 1.1, 1.1.1.
    // Chapter-IDs ohne Nummer (Vorwort/Prolog/Epilog/Anhang). Counter wird
    // dann fuer diese Kapitel uebersprungen — naechstes Kapitel zaehlt weiter
    // ohne Luecke. Cascade: ist ein Top-Kapitel hier gelistet, erben auch
    // seine Sub-Kapitel "kein Nummer".
    unnumberedChapterIds: [],
    // Seitenzaehler-Skip: PDF-Pages, die zu diesen Kapiteln/BookStack-Pages
    // gehoeren, zaehlen nicht in der Seitennummerierung mit. Anzeige der
    // Nummer entfaellt fuer geskippte Pages, naechste reguläre Page laeuft
    // ohne Sprung weiter. Cascade fuer Kapitel: Top-Kapitel -> Subs erben.
    // Pro-Page-Skip ist nur sinnvoll, wenn pageStructure='nested' ist
    // (sonst sind Book-Pages innerhalb eines Kapitels nicht trennbar).
    skipPageCounterChapterIds: [],
    skipPageCounterPageIds: [],
    titleStyle: 'centered-large',
    dropCap: false,
    spaceBeforeMm: 60,
    // Die BookStack-Seite ist ein Strukturelement, kein beliebiger Textbrocken:
    // eigene Ueberschrift (h4), eigener Umbruch, eigener Verzeichnis-Eintrag.
    // 'flatten' bleibt fuer Werke mit reinen Fliesstext-Seiten.
    pageStructure: 'nested',
    pageBreakBetweenPages: true,
    titleRule: false,
    pageTitleRule: false,
  },
  // Das Titelbild kommt buch-weit aus book_publication (geteilt mit EPUB) und ist
  // ein fertig gestaltetes Cover (Titel im Bild). Darum kein Text-Overlay.
  cover: {
    enabled: false,
    fit: 'cover',
  },
  // title leer = Renderer setzt Sprach-Default ('Inhaltsverzeichnis' / 'Table of Contents')
  // anhand der Buchsprache. User-Override per nicht-leeren String.
  // indentMm = Einrueckung pro Level (level 0 = 0, level 1 = 1*indentMm, ...).
  // pageNumReserveMm = reservierte Spaltenbreite rechts fuer die Seitenzahl.
  // leader = Verbindung zwischen Eintrag und Seitenzahl (none/dots/line).
  // depth zaehlt ausschliesslich KAPITELEBENEN (1..3); Seiten haengen an der
  // eigenen Achse includePages — eine Seite in einem Sub-Sub-Kapitel liegt auf
  // Ebene 4 und faellt sonst durch jede Kapiteltiefe-Grenze.
  toc: {
    enabled: true,
    depth: 3,
    // Seiten als eigene Verzeichnis-Ebene unter ihrem Kapitel. Greift nur bei
    // pageStructure='nested' — nur dann traegt eine Seite eine Ueberschrift, an
    // die sich eine Seitenzahl haengen liesse.
    includePages: true,
    title: '',
    showPageNumbers: true,
    titleAlign: 'center',
    indentMm: 6,
    leader: 'none',
    pageNumReserveMm: 14,
    // startOnRecto: Inhaltsverzeichnis auf einer rechten (ungeraden) Seite
    // beginnen (Buchkonvention). Bei Bedarf wird eine leere Verso-Seite davor
    // eingeschoben. Nur wirksam bei scope='book' + toc.enabled.
    startOnRecto: true,
  },
  // imprintPosition: 'front' = Rueckseite der Titelseite (Buchkonvention),
  // 'back' = ans Buchende. copyright: optionale strukturierte ©-Zeile, wird der
  // Impressum-Seite vorangestellt. isbn erscheint auf der Impressum-Seite.
  // frontMatter: freie Prosa-Seite (Motto/Epigraph/Vorwort) nach der Titelseite.
  // authorBio: "Ueber den Autor"-Backmatter-Seite (Foto separat als Profil-BLOB).
  extras: {
    dedication: '', imprint: '', subtitle: '', year: '',
    isbn: '', copyright: '', frontMatter: '', authorBio: '',
    imprintPosition: 'front',
    // barcode: EAN-13 aus der ISBN auf der Impressum-Seite rendern. Nur wirksam,
    // wenn isbn eine gültige 12/13-stellige Nummer ist.
    barcode: true,
    // dedicationOnRecto: Widmung auf einer rechten (ungeraden) Seite beginnen
    // (Buchkonvention). Bei Bedarf wird eine leere Verso-Seite davor
    // eingeschoben. Nur wirksam bei scope='book' + gesetzter Widmung.
    dedicationOnRecto: true,
    // imprintOnVerso: Impressum/Copyright auf einer linken (geraden) Seite
    // (Verso) platzieren (Buchkonvention: Rückseite der Titelseite). Bei Bedarf
    // wird eine leere Recto-Seite davor eingeschoben. Nur wirksam bei
    // scope='book' + vorhandenem Impressum-Inhalt.
    imprintOnVerso: true,
  },
  // Druckvorstufe (klassische Druckerei). bleedMm > 0 vergrössert die Seite um
  // 2×Beschnitt; Inhalt bleibt im Endformat (TrimBox), randabfallende Elemente
  // (Cover) laufen in den Anschnitt. cropMarks zeichnet Schnittmarken in den
  // Anschnitt (nur bei bleedMm > 0). blackTextKOnly gibt schwarze/graue
  // Textfarben als reines DeviceCMYK-K aus (kein 4-farbiges Rich-Black im Druck);
  // greift nur ausserhalb von PDF/A (dort sRGB-OutputIntent). dpiWarnThreshold:
  // Bilder unter dieser effektiven Auflösung
  // erzeugen einen nicht-fatalen Warnhinweis im Job-Result.
  // padToEvenPages: hängt am Buchende eine echte Leerseite an, falls die
  // Gesamtseitenzahl ungerade ist — Print-Konvention (Druckbogen), von
  // Print-on-Demand-Diensten wie Amazon KDP zwingend verlangt. Die Leerseite
  // trägt weder Header/Footer noch Seitenzahl. Default an (Buchkonvention).
  // Fussnotenapparat am Seitenfuss. Greift nur bei
  // `book_settings.citation_notes = 'footnotes'` — OB ein Werk mit Fussnoten
  // arbeitet, ist eine Eigenschaft des Werks und steht darum in den
  // Bucheinstellungen; hier steht nur, WIE der Apparat gesetzt wird.
  //
  // maxHeightPct ist der Deckel: mehr als diesen Anteil des Satzspiegels darf
  // der Apparat nicht belegen. Er ist nicht Kosmetik, sondern die
  // Terminierungsgarantie des Umbruchs — ohne ihn koennte eine einzige lange
  // Note eine Seite komplett auffressen und der Zeilenumbruch endlos
  // weiterblaettern. Untergrenze 15 % ist bewusst kein 0.
  //
  // hangMm ist der haengende Einzug: die Notenziffer steht am Rand, Folgezeilen
  // ruecken dahinter ein, sodass die Ziffern eine Spalte bilden.
  table: DEFAULT_TABLE,
  footnotes: {
    separator: true,
    separatorWidthMm: 30,
    gapMm: 2,
    hangMm: 4,
    maxHeightPct: 45,
  },
  print: {
    bleedMm: 0,
    cropMarks: false,
    blackTextKOnly: false,
    dpiWarnThreshold: 300,
    padToEvenPages: true,
  },
  // Separates Umschlag-PDF (Phase 4). Nur fuer den Render-Target 'cover'
  // relevant. Rueckenbreite = paperBulkMmPer1000 × pageCount / 1000 (mm). Beide
  // Werte sind pro Render Pflicht (kein sinnvoller Default — papierabhaengig).
  // Front-Bild = das hochgeladene Titelbild (cover_image), Rueckseite optional
  // als eigenes Bild + Klappentext + EAN-13 aus extras.isbn. Beschnitt/Schnitt-
  // marken erbt der Umschlag aus dem print-Block.
  coverSpec: {
    pageCount: 0,
    paperBulkMmPer1000: 0,
    blurb: '',
    spineText: '',
    backgroundColor: '#ffffff',
  },
  // standard ist SSoT (pdfa/pdfx/none); enabled (legacy) leitet sich ab und
  // bedeutet "PDF/A-Subset rendern" — nur bei standard='pdfa' true.
  pdfa: { standard: 'pdfa', enabled: true, conformance: 'B' },
};


function _str(v, max = 200) {
  if (typeof v !== 'string') return '';
  return v.slice(0, max);
}

function _validateLayout(src) {
  const d = DEFAULT_CONFIG.layout;
  if (!_isObj(src)) return { ...d };
  const m = _isObj(src.marginsMm) ? src.marginsMm : d.marginsMm;
  const bi = _isObj(src.bodyInsetMm) ? src.bodyInsetMm : d.bodyInsetMm;
  return {
    pageSize:        _enum(src.pageSize, PAGE_SIZES, d.pageSize),
    customWidthMm:   _num(src.customWidthMm, 50, 500, d.customWidthMm),
    customHeightMm:  _num(src.customHeightMm, 50, 700, d.customHeightMm),
    marginsMm: {
      top:    _num(m.top,    5, 80, d.marginsMm.top),
      right:  _num(m.right,  5, 80, d.marginsMm.right),
      bottom: _num(m.bottom, 5, 80, d.marginsMm.bottom),
      left:   _num(m.left,   5, 80, d.marginsMm.left),
    },
    bodyInsetMm: {
      top:    _num(bi.top,    0, 60, d.bodyInsetMm.top),
      right:  _num(bi.right,  0, 60, d.bodyInsetMm.right),
      bottom: _num(bi.bottom, 0, 60, d.bodyInsetMm.bottom),
      left:   _num(bi.left,   0, 60, d.bodyInsetMm.left),
    },
    columns:    _enum(parseInt(src.columns), COLUMNS, d.columns),
    columnGapMm: _num(src.columnGapMm, 0, 30, d.columnGapMm),
    headerLeft:   _str(src.headerLeft,   200),
    headerCenter: _str(src.headerCenter, 200),
    headerRight:  _str(src.headerRight,  200),
    footerLeft:   _str(src.footerLeft,   200),
    footerCenter: _str(src.footerCenter, 200),
    footerRight:  _str(src.footerRight,  200),
    headerVersoLeft:   _str(src.headerVersoLeft,   200),
    headerVersoCenter: _str(src.headerVersoCenter, 200),
    headerVersoRight:  _str(src.headerVersoRight,  200),
    footerVersoLeft:   _str(src.footerVersoLeft,   200),
    footerVersoCenter: _str(src.footerVersoCenter, 200),
    footerVersoRight:  _str(src.footerVersoRight,  200),
    hfStyle:      _validateHfStyle(src.hfStyle),
    headerRule:   _bool(src.headerRule, d.headerRule),
    footerRule:   _bool(src.footerRule, d.footerRule),
    showHeaderOnChapterStart: _bool(src.showHeaderOnChapterStart, d.showHeaderOnChapterStart),
    showFooterOnChapterStart: _bool(src.showFooterOnChapterStart, d.showFooterOnChapterStart),
    showHeaderOnChapterEnd: _bool(src.showHeaderOnChapterEnd, d.showHeaderOnChapterEnd),
    showFooterOnChapterEnd: _bool(src.showFooterOnChapterEnd, d.showFooterOnChapterEnd),
    mirrorMargins: _bool(src.mirrorMargins, d.mirrorMargins),
    hyphenate:     _bool(src.hyphenate,     d.hyphenate),
    widowOrphanControl: _bool(src.widowOrphanControl, d.widowOrphanControl),
    pageNumberStart: _num(src.pageNumberStart, 1, 9999, d.pageNumberStart),
    // Migration: altes countFrontMatter-Bool auf den Modus abbilden, wenn kein
    // pageCountMode gesetzt ist (true → 'physical', false → 'body').
    pageCountMode: _enum(src.pageCountMode, PAGE_COUNT_MODE,
      (src.pageCountMode == null && src.countFrontMatter != null)
        ? (src.countFrontMatter ? 'physical' : 'body')
        : d.pageCountMode),
    pageNumberFirstVisible: _num(src.pageNumberFirstVisible, 1, 9999, d.pageNumberFirstVisible),
    frontMatterNumbering: _enum(src.frontMatterNumbering, FRONTMATTER_NUMBERING, d.frontMatterNumbering),
    frontMatterNumberFirstVisible: _num(src.frontMatterNumberFirstVisible, 1, 9999, d.frontMatterNumberFirstVisible),
  };
}

function _validateHfStyle(src) {
  const out = _defaultHfStyle();
  if (!_isObj(src)) return out;
  for (const z of HF_ZONES) {
    for (const s of HF_SIDES) {
      for (const p of HF_POS) {
        const cell = src?.[z]?.[s]?.[p];
        if (_isObj(cell)) {
          out[z][s][p] = { bold: !!cell.bold, italic: !!cell.italic, upper: !!cell.upper };
        }
      }
    }
  }
  return out;
}

function _validateFontRole(src, defs) {
  if (!_isObj(src)) return { ...defs };
  return {
    family:     _str(src.family, 80) || defs.family,
    weight:     _num(src.weight, 100, 900, defs.weight),
    sizePt:     _num(src.sizePt, 6, 72, defs.sizePt),
    color:      _hex(src.color, defs.color),
    ...(defs.lineHeight !== undefined ? { lineHeight: _num(src.lineHeight, 0.8, 3, defs.lineHeight) } : {}),
    ...(defs.paragraphGap !== undefined ? { paragraphGap: _num(src.paragraphGap, 0, 3, defs.paragraphGap) } : {}),
    ...(defs.firstLineIndentMm !== undefined ? { firstLineIndentMm: _num(src.firstLineIndentMm, 0, 30, defs.firstLineIndentMm) } : {}),
    ...(defs.italic !== undefined ? { italic: _bool(src.italic, defs.italic) } : {}),
    ...(defs.numerals !== undefined ? { numerals: _enum(src.numerals, NUMERALS, defs.numerals) } : {}),
  };
}

function _validateFont(src) {
  const d = DEFAULT_CONFIG.font;
  if (!_isObj(src)) return structuredClone(d);
  const heading = _isObj(src.heading) ? src.heading : {};
  const headingSizes = _isObj(heading.sizes) ? heading.sizes : {};
  return {
    body:     _validateFontRole(src.body,     d.body),
    heading: {
      family: _str(heading.family, 80) || d.heading.family,
      weight: _num(heading.weight, 100, 900, d.heading.weight),
      color:  _hex(heading.color, d.heading.color),
      sizes: {
        h1: _num(headingSizes.h1, 10, 60, d.heading.sizes.h1),
        h2: _num(headingSizes.h2,  9, 48, d.heading.sizes.h2),
        h3: _num(headingSizes.h3,  8, 36, d.heading.sizes.h3),
        h4: _num(headingSizes.h4,  7, 30, d.heading.sizes.h4),
        h5: _num(headingSizes.h5,  7, 28, d.heading.sizes.h5),
        h6: _num(headingSizes.h6,  7, 26, d.heading.sizes.h6),
      },
    },
    title:    _validateFontRole(src.title,    d.title),
    subtitle: _validateFontRole(src.subtitle, d.subtitle),
    byline:   _validateFontRole(src.byline,   d.byline),
    dedication: _validateFontRole(src.dedication, d.dedication),
    frontMatter:_validateFontRole(src.frontMatter, d.frontMatter),
    authorBio:  _validateFontRole(src.authorBio,   d.authorBio),
    bibliography:_validateFontRole(src.bibliography, d.bibliography),
    footnote:    _validateFontRole(src.footnote, d.footnote),
    imprint:    _validateFontRole(src.imprint,    d.imprint),
    year:       _validateFontRole(src.year,       d.year),
    toc:        _validateFontRole(src.toc,        d.toc),
    tocTitle:   _validateFontRole(src.tocTitle,   d.tocTitle),
    header:     _validateFontRole(src.header,     d.header),
    footer:     _validateFontRole(src.footer,     d.footer),
  };
}

function _validateIdList(src) {
  if (!Array.isArray(src)) return [];
  const out = [];
  const seen = new Set();
  for (const v of src) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n <= 0) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= 500) break;
  }
  return out;
}

function _validateChapter(src) {
  const d = DEFAULT_CONFIG.chapter;
  if (!_isObj(src)) {
    return {
      ...d,
      unnumberedChapterIds: [],
      skipPageCounterChapterIds: [],
      skipPageCounterPageIds: [],
    };
  }
  return {
    breakBefore:    _enum(src.breakBefore, BREAK_BEFORE, d.breakBefore),
    breakBeforeSubchapter: _bool(src.breakBeforeSubchapter, d.breakBeforeSubchapter),
    firstChapterOnRecto: _bool(src.firstChapterOnRecto, d.firstChapterOnRecto),
    blankPageAfter: _bool(src.blankPageAfter, d.blankPageAfter),
    numbering:      _enum(src.numbering, NUMBERING, d.numbering),
    numberingMode:  _enum(src.numberingMode, NUMBERING_MODE, d.numberingMode),
    unnumberedChapterIds: _validateIdList(src.unnumberedChapterIds),
    skipPageCounterChapterIds: _validateIdList(src.skipPageCounterChapterIds),
    skipPageCounterPageIds:    _validateIdList(src.skipPageCounterPageIds),
    titleStyle:     _enum(src.titleStyle, TITLE_STYLE, d.titleStyle),
    dropCap:        _bool(src.dropCap, d.dropCap),
    spaceBeforeMm:  _num(src.spaceBeforeMm, 0, 200, d.spaceBeforeMm),
    pageStructure:  _enum(src.pageStructure, PAGE_STRUCTURE, d.pageStructure),
    pageBreakBetweenPages: _bool(src.pageBreakBetweenPages, d.pageBreakBetweenPages),
    titleRule:      _bool(src.titleRule, d.titleRule),
    pageTitleRule:  _bool(src.pageTitleRule, d.pageTitleRule),
  };
}

function _validateCover(src) {
  const d = DEFAULT_CONFIG.cover;
  if (!_isObj(src)) return { ...d };
  return {
    enabled: _bool(src.enabled, d.enabled),
    fit:     _enum(src.fit, COVER_FIT, d.fit),
  };
}

function _validateToc(src) {
  const d = DEFAULT_CONFIG.toc;
  if (!_isObj(src)) return { ...d };
  return {
    enabled:          _bool(src.enabled, d.enabled),
    depth:            _enum(parseInt(src.depth), TOC_DEPTH, d.depth),
    title:            _str(src.title, 80) || d.title,
    showPageNumbers:  _bool(src.showPageNumbers, d.showPageNumbers),
    titleAlign:       _enum(src.titleAlign, TOC_TITLE_ALIGN, d.titleAlign),
    indentMm:         _num(src.indentMm, 0, 40, d.indentMm),
    leader:           _enum(src.leader, TOC_LEADER, d.leader),
    pageNumReserveMm: _num(src.pageNumReserveMm, 6, 40, d.pageNumReserveMm),
    startOnRecto:     _bool(src.startOnRecto, d.startOnRecto),
    includePages:     _bool(src.includePages, d.includePages),
  };
}

function _validateExtras(src) {
  const d = DEFAULT_CONFIG.extras;
  if (!_isObj(src)) return { ...d };
  return {
    dedication: _str(src.dedication, 1000),
    imprint:    _str(src.imprint, 4000),
    subtitle:   _str(src.subtitle, 200),
    year:       _str(src.year, 20),
    isbn:       _str(src.isbn, 20),
    copyright:  _str(src.copyright, 500),
    frontMatter:_str(src.frontMatter, 4000),
    authorBio:  _str(src.authorBio, 4000),
    imprintPosition: _enum(src.imprintPosition, IMPRINT_POS, d.imprintPosition),
    barcode:    _bool(src.barcode, d.barcode),
    dedicationOnRecto: _bool(src.dedicationOnRecto, d.dedicationOnRecto),
    imprintOnVerso:    _bool(src.imprintOnVerso, d.imprintOnVerso),
  };
}

function _validateFootnotes(src) {
  const d = DEFAULT_CONFIG.footnotes;
  if (!_isObj(src)) return { ...d };
  return {
    separator:        _bool(src.separator, d.separator),
    separatorWidthMm: _num(src.separatorWidthMm, 5, 200, d.separatorWidthMm),
    gapMm:            _num(src.gapMm, 0, 20, d.gapMm),
    hangMm:           _num(src.hangMm, 0, 20, d.hangMm),
    maxHeightPct:     _num(src.maxHeightPct, 15, 70, d.maxHeightPct),
  };
}

function _validatePrint(src) {
  const d = DEFAULT_CONFIG.print;
  if (!_isObj(src)) return { ...d };
  return {
    bleedMm:          _num(src.bleedMm, 0, 10, d.bleedMm),
    cropMarks:        _bool(src.cropMarks, d.cropMarks),
    blackTextKOnly:   _bool(src.blackTextKOnly, d.blackTextKOnly),
    dpiWarnThreshold: _num(src.dpiWarnThreshold, 72, 1200, d.dpiWarnThreshold),
    padToEvenPages:   _bool(src.padToEvenPages, d.padToEvenPages),
  };
}

function _validateCoverSpec(src) {
  const d = DEFAULT_CONFIG.coverSpec;
  if (!_isObj(src)) return { ...d };
  return {
    pageCount:          Math.round(_num(src.pageCount, 0, 5000, d.pageCount)),
    paperBulkMmPer1000: _num(src.paperBulkMmPer1000, 0, 300, d.paperBulkMmPer1000),
    blurb:              _str(src.blurb, 4000),
    spineText:          _str(src.spineText, 200),
    backgroundColor:    _hex(src.backgroundColor, d.backgroundColor),
  };
}

function _validatePdfa(src) {
  const d = DEFAULT_CONFIG.pdfa;
  if (!_isObj(src)) return { ...d };
  // standard ist SSoT; Legacy-Profile ohne `standard` leiten ihn aus `enabled` ab.
  const standard = NORM_STD.includes(src.standard)
    ? src.standard
    : (_bool(src.enabled, true) ? 'pdfa' : 'none');
  return {
    standard,
    enabled:     standard === 'pdfa',
    conformance: _enum(src.conformance, PDFA_CONF, d.conformance),
  };
}

/** Tiefe Validierung gegen Defaults. Unbekannte Keys werden verworfen. */
function validateConfig(src) {
  const s = _isObj(src) ? src : {};
  return {
    layout:  _validateLayout(s.layout),
    font:    _validateFont(s.font),
    chapter: _validateChapter(s.chapter),
    cover:   _validateCover(s.cover),
    toc:     _validateToc(s.toc),
    extras:  _validateExtras(s.extras),
    footnotes: _validateFootnotes(s.footnotes),
    table:   validateTable(s.table),
    print:   _validatePrint(s.print),
    coverSpec: _validateCoverSpec(s.coverSpec),
    pdfa:    _validatePdfa(s.pdfa),
  };
}

function defaultConfig() {
  return structuredClone(DEFAULT_CONFIG);
}

module.exports = { DEFAULT_CONFIG, validateConfig, defaultConfig };
