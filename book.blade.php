{{--
    themes/custom/exports/book.blade.php — v10
    FIX: <style> im @section('content') weil das Layout kein @yield('styles') hat.
--}}
@extends('layouts.export')

@section('title', $book->name)

@section('content')

{{-- ============================================================
     STYLES — müssen im content-Block sein, da das Layout
     kein @yield('styles') hat. WeasyPrint verarbeitet
     <style> im <body> problemlos.
     ============================================================ --}}
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
@page :first {
  margin: 0 !important;
  @top-left { content: none; } @top-right { content: none; }
  @top-center { content: none; } @bottom-center { content: none; }
}

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

/* ── TITELSEITE ─────────────────────────────────────── */
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

/* ── INHALTSVERZEICHNIS ─────────────────────────────── */
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

{{-- ============================================================
     AB HIER: TEMPLATE-HTML
     ============================================================ --}}

@php
    $compactMode = true;
    foreach ($bookChildren as $child) {
        if ($child->isA('chapter') && $child->pages->count() !== 1) {
            $compactMode = false;
            break;
        }
        if ($child->isA('page')) {
            $compactMode = false;
            break;
        }
    }
    $author = $book->updatedBy->name ?? $book->createdBy->name ?? '';
@endphp

<div class="title-page">
    @if($book->cover)
        <div class="cover-image-wrap">
            <img src="{{ $book->cover->url }}" alt="{{ $book->name }}" class="cover-image">
        </div>
    @endif
    <div class="title-text-block">
        <div class="title-book-name">{{ $book->name }}</div>
        <div class="title-meta">
            <span class="title-author">{{ $author }}</span><span class="title-sep"> · </span><span class="title-year">{{ date('Y') }}</span>
        </div>
    </div>
</div>

<div class="blade-break"></div>

<div class="chapter-hint" aria-hidden="true">{{ $book->name }}</div>

<div class="toc-page">
    <div class="toc-rule"></div>
    <div class="toc-entries">
        @foreach($bookChildren as $bookChild)
            @if($bookChild->isA('chapter'))
                <div class="toc-chapter-entry">
                    <div class="toc-chapter-name">{{ $bookChild->name }}</div>
                    @if(!$compactMode && $bookChild->pages->count() > 0)
                        @foreach($bookChild->pages as $page)
                            <div class="toc-subpage">{{ $page->name }}</div>
                        @endforeach
                    @endif
                </div>
            @elseif($bookChild->isA('page'))
                <div class="toc-direct-page">{{ $bookChild->name }}</div>
            @endif
        @endforeach
    </div>
</div>

<div class="blade-break"></div>

@foreach($bookChildren as $bookChild)
    @if($bookChild->isA('chapter'))
        @if($compactMode)
            <div class="blade-break"></div>
            <div class="chapter-hint" aria-hidden="true">{{ $bookChild->name }}</div>
            <div class="compact-page-wrap">
                @include('exports.parts.page-item', ['page' => $bookChild->pages->first()])
            </div>
        @else
            <div class="blade-break"></div>
            <div class="chapter-hint" aria-hidden="true">{{ $bookChild->name }}</div>
            <div class="chapter-title-page">
                <h1 id="{{ $bookChild->slug }}" class="chapter-h1">{{ $bookChild->name }}</h1>
                @if($bookChild->description)
                    <p class="chapter-description">{{ $bookChild->description }}</p>
                @endif
            </div>
            @foreach($bookChild->pages as $page)
                <div class="blade-break"></div>
                @include('exports.parts.page-item', ['page' => $page])
            @endforeach
        @endif
    @elseif($bookChild->isA('page'))
        <div class="blade-break"></div>
        @include('exports.parts.page-item', ['page' => $bookChild])
    @endif
@endforeach

@endsection