{{--
    themes/custom/exports/pdf-styles.blade.php — v1
    Gemeinsame PDF-Styles für book/chapter/page-Export.
    Parameter:
      - coverBleed (bool, default false): aktiviert @page :first { margin: 0 }
        für ein Full-bleed-Cover (nur book.blade.php nutzt das).
--}}
@php $coverBleed = $coverBleed ?? false; @endphp
<style>
@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,600;0,700;1,400;1,600&family=EB+Garamond:ital,wght@0,400;0,500;1,400&display=swap');

/* ── @PAGE ──────────────────────────────────────────── */
@page {
  size: 176mm 250mm;
  margin: 24mm 18mm 28mm 20mm;
  @top-left {
    content: string(chapter-title);
    font-family: 'Playfair Display', Georgia, serif;
    font-size: 8pt; font-style: italic;
    color: #7a6e60; padding-top: 4pt; padding-bottom: 14pt;
  }
  @top-right {
    content: string(page-title);
    font-family: 'Playfair Display', Georgia, serif;
    font-size: 8pt; font-style: italic;
    color: #7a6e60; padding-top: 4pt; padding-bottom: 14pt;
    text-align: right;
  }
  @top-center { content: none; }
  @bottom-center {
    content: counter(page);
    font-family: 'EB Garamond', Georgia, serif;
    font-size: 9pt; color: #7a6e60;
  }
}
@if($coverBleed)
@page :first {
  margin: 0 !important;
  @top-left { content: none; } @top-right { content: none; }
  @top-center { content: none; } @bottom-center { content: none; }
}
@endif

/* ── RESET ──────────────────────────────────────────── */
.export-format-pdf *, .export-format-pdf *::before, .export-format-pdf *::after {
  box-sizing: border-box !important;
}
.export-format-pdf body {
  font-family: 'EB Garamond', Georgia, serif !important;
  font-size: 12pt !important;
  line-height: 1.85 !important;
  color: #1a1209 !important;
  background: #faf8f4 !important;
  hyphens: auto !important;
  text-rendering: optimizeLegibility !important;
  margin: 0 !important; padding: 0 !important;
}

/* ── SEITENUMBRÜCHE ─────────────────────────────────── */
.export-format-pdf .blade-break {
  page-break-after: always !important;
  break-after: page !important;
  display: block !important;
  height: 1px !important; font-size: 0 !important;
  line-height: 0 !important;
  margin: 0 !important; padding: 0 !important;
  border: none !important; visibility: hidden !important;
}
.export-format-pdf .page-break { display: none !important; }

/* ── TITELSEITE (book.blade.php) ────────────────────── */
.export-format-pdf .title-page {
  display: block !important;
  width: 176mm !important; height: 250mm !important;
  margin: 0 !important; padding: 0 !important;
  overflow: hidden !important;
}
.export-format-pdf .cover-image-wrap {
  display: block !important;
  width: 176mm !important; height: 188mm !important;
  margin: 0 !important; padding: 0 !important;
  overflow: hidden !important;
}
.export-format-pdf .cover-image {
  display: block !important;
  width: 100% !important; height: 100% !important;
  object-fit: cover !important; object-position: center !important;
  margin: 0 !important; padding: 0 !important;
}
.export-format-pdf .title-text-block {
  padding: 6mm 20mm 0 20mm !important;
  margin: 0 !important;
  border-top: 2pt solid #8b1a1a !important;
  text-align: center !important;
}
.export-format-pdf .title-book-name {
  font-family: 'Playfair Display', Georgia, serif !important;
  font-size: 24pt !important; font-weight: 700 !important;
  line-height: 1.15 !important; color: #1a1209 !important;
  margin: 0 0 2mm 0 !important; text-indent: 0 !important;
  text-align: center !important;
}
.export-format-pdf .title-meta {
  font-family: 'EB Garamond', Georgia, serif !important;
  font-size: 10pt !important; letter-spacing: 0.12em !important;
  text-transform: uppercase !important; color: #7a6e60 !important;
  text-align: center !important; margin: 0 !important;
}
.export-format-pdf .title-sep { color: #c8bfad !important; }
.export-format-pdf .title-author { color: #4a3f2f !important; }

/* ── INHALTSVERZEICHNIS (book.blade.php) ────────────── */
.export-format-pdf .toc-page { padding-top: 12mm !important; }
.export-format-pdf .toc-rule {
  border-bottom: 0.75pt solid #c8bfad !important;
  margin-bottom: 6mm !important;
}
.export-format-pdf .toc-entries { margin: 0 !important; padding: 0 !important; }
.export-format-pdf .toc-chapter-entry { margin-bottom: 4mm !important; }
.export-format-pdf .toc-chapter-name {
  font-family: 'Playfair Display', Georgia, serif !important;
  font-size: 11pt !important; font-weight: 600 !important;
  color: #1a1209 !important; line-height: 1.4 !important;
  margin: 0 0 1mm 0 !important;
}
.export-format-pdf .toc-subpage {
  font-family: 'EB Garamond', Georgia, serif !important;
  font-size: 10pt !important; color: #4a3f2f !important;
  padding-left: 5mm !important; line-height: 1.6 !important;
}
.export-format-pdf .toc-direct-page {
  font-family: 'EB Garamond', Georgia, serif !important;
  font-size: 10.5pt !important; font-style: italic !important;
  color: #1a1209 !important; margin-bottom: 2mm !important;
}

/* ── CHAPTER HINT ───────────────────────────────────── */
.export-format-pdf .chapter-hint {
  string-set: chapter-title content() !important;
  display: block !important; visibility: hidden !important;
  font-size: 0 !important; line-height: 0 !important;
  height: 0 !important; max-height: 0 !important;
  overflow: hidden !important;
  margin: 0 !important; padding: 0 !important;
  break-before: avoid !important; page-break-before: avoid !important;
  break-after: avoid !important; page-break-after: avoid !important;
}

/* ── KAPITEL-TITELSEITE ─────────────────────────────── */
.export-format-pdf .chapter-title-page {
  page-break-before: avoid !important; break-before: avoid !important;
}
.export-format-pdf .chapter-h1 {
  string-set: page-title content() !important;
  page-break-before: avoid !important; break-before: avoid !important;
  margin-top: 52mm !important;
}
.export-format-pdf .chapter-description {
  font-style: italic !important; color: #7a6e60 !important;
  font-size: 10.5pt !important; text-indent: 0 !important;
}

/* ── ÜBERSCHRIFTEN ──────────────────────────────────── */
.export-format-pdf h1 {
  string-set: page-title content() !important;
  page-break-before: auto !important; break-before: auto !important;
  page-break-after: avoid !important;
  font-family: 'Playfair Display', Georgia, serif !important;
  font-size: 24pt !important; font-weight: 700 !important;
  line-height: 1.2 !important; color: #1a1209 !important;
  margin: 52mm 0 12mm 0 !important;
  padding: 0 0 6mm 0 !important;
  border-bottom: 1pt solid #8b1a1a !important;
}
.export-format-pdf h1::before { content: none !important; }
.export-format-pdf h2 {
  font-family: 'Playfair Display', Georgia, serif !important;
  font-size: 15pt !important; font-weight: 600 !important;
  line-height: 1.3 !important; color: #1a1209 !important;
  margin: 9mm 0 3mm 0 !important; padding: 0 !important;
  page-break-after: avoid !important;
}
.export-format-pdf h3 {
  font-family: 'Playfair Display', Georgia, serif !important;
  font-size: 12.5pt !important; font-weight: 400 !important;
  font-style: italic !important; color: #4a3f2f !important;
  margin: 7mm 0 2mm 0 !important; padding: 0 !important;
  page-break-after: avoid !important;
}
.export-format-pdf h4 {
  font-family: 'EB Garamond', Georgia, serif !important;
  font-size: 12pt !important; font-weight: 500 !important;
  font-variant: small-caps !important; letter-spacing: 0.08em !important;
  color: #8b1a1a !important; text-transform: lowercase !important;
  margin: 5mm 0 1.5mm 0 !important; padding: 0 !important;
  page-break-after: avoid !important;
}

/* ── FLIESSTEXT ─────────────────────────────────────── */
.export-format-pdf p {
  font-family: 'EB Garamond', Georgia, serif !important;
  font-size: 12pt !important; line-height: 1.85 !important;
  text-align: justify !important; text-indent: 2em !important;
  margin: 0 !important; padding: 0 !important;
  orphans: 3 !important; widows: 3 !important;
}
.export-format-pdf h1 + p,
.export-format-pdf h2 + p,
.export-format-pdf h3 + p,
.export-format-pdf h4 + p,
.export-format-pdf p:first-of-type {
  text-indent: 0 !important;
}

/* ── LINKS ──────────────────────────────────────────── */
.export-format-pdf a {
  color: #8b1a1a !important; text-decoration: none !important;
}
.export-format-pdf a::after {
  content: " (" attr(href) ")";
  font-size: 0.8em !important; color: #7a6e60 !important;
}
.export-format-pdf a[href^="#"]::after { content: none !important; }

/* ── LISTEN ─────────────────────────────────────────── */
.export-format-pdf ul, .export-format-pdf ol {
  font-size: 12pt !important; line-height: 1.85 !important;
  margin: 3mm 0 4mm 2em !important; padding: 0 !important;
}
.export-format-pdf li {
  font-size: 12pt !important; margin-bottom: 1mm !important;
  padding: 0 !important; text-align: justify !important;
}
.export-format-pdf ul li::marker {
  content: "•  " !important; color: #7a6e60 !important;
}

/* ── TABELLEN ───────────────────────────────────────── */
.export-format-pdf table {
  width: 100% !important; border-collapse: collapse !important;
  margin: 5mm 0 6mm !important; font-size: 10pt !important;
}
.export-format-pdf thead tr {
  border-top: 1.5pt solid #1a1209 !important;
  border-bottom: 0.75pt solid #1a1209 !important;
}
.export-format-pdf tbody tr:last-child td {
  border-bottom: 1pt solid #1a1209 !important;
}
.export-format-pdf th {
  font-variant: small-caps !important; font-weight: 500 !important;
  font-size: 9.5pt !important; text-align: left !important;
  padding: 2mm 3mm !important;
}
.export-format-pdf td {
  font-size: 10pt !important; padding: 2mm 3mm !important;
  border-bottom: 0.25pt solid #c8bfad !important;
  vertical-align: top !important;
}
.export-format-pdf tbody tr:nth-child(even) td {
  background: #f5f0e8 !important;
}

/* ── BLOCKQUOTES ────────────────────────────────────── */
.export-format-pdf blockquote {
  margin: 6mm 2em 6mm calc(2em + 2mm) !important;
  padding: 0 0 0 5mm !important;
  border-left: 1.5pt solid #8b1a1a !important;
  font-style: italic !important; color: #4a3f2f !important;
  page-break-inside: avoid !important;
}
.export-format-pdf blockquote p { text-indent: 0 !important; }

/* ── GEDICHTE ───────────────────────────────────────── */
.export-format-pdf .poem {
  font-family: 'EB Garamond', Georgia, serif !important;
  font-size: 11.5pt !important;
  font-style: italic !important;
  line-height: 1.5 !important;
  white-space: pre-line !important;
  text-align: left !important;
  text-indent: 0 !important;
  hyphens: none !important;
  color: #2a1f12 !important;
  margin: 6mm 0 6mm 8mm !important;
  padding: 0 0 0 4mm !important;
  border-left: 0.75pt solid #c8bfad !important;
  page-break-inside: avoid !important;
}
.export-format-pdf .poem p {
  text-align: left !important;
  text-indent: 0 !important;
  hyphens: none !important;
  margin: 0 0 2mm 0 !important;
  font-style: italic !important;
}
.export-format-pdf .poem br { line-height: 1.5 !important; }

/* ── BILDER ─────────────────────────────────────────── */
.export-format-pdf img {
  max-width: 100% !important; height: auto !important;
  display: block !important; margin: 4mm auto !important;
}

/* ── TRENNLINIEN ────────────────────────────────────── */
.export-format-pdf hr {
  border: none !important;
  border-top: 0.75pt solid #c8bfad !important;
  margin: 8mm 0 !important;
}

/* ── CALLOUTS ───────────────────────────────────────── */
.export-format-pdf .callout, .export-format-pdf .notice {
  border: 0.75pt solid #c8bfad !important;
  border-left: 3pt solid #8b1a1a !important;
  background: #f5f0e8 !important;
  padding: 4mm 5mm !important; margin: 5mm 0 !important;
  font-size: 10.5pt !important;
  page-break-inside: avoid !important;
}
.export-format-pdf .callout p, .export-format-pdf .notice p {
  text-indent: 0 !important;
}

/* ── SONSTIGES ──────────────────────────────────────── */
.export-format-pdf mark { background: #f5e6c0 !important; }
.export-format-pdf .compact-page-wrap h1 { string-set: page-title "" !important; }

@media print {
  body { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
}
</style>
