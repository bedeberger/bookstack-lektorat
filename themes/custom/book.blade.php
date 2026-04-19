{{--
    themes/custom/exports/book.blade.php — v11
    Styles ausgelagert in exports.pdf-styles (coverBleed: true → @page :first).
--}}
@extends('layouts.export')

@section('title', $book->name)

@section('content')

@include('exports.pdf-styles', ['coverBleed' => true])

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