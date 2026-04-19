{{--
    themes/custom/exports/chapter.blade.php — v2
    Kapitel-Export: Titelseite für das Kapitel + alle enthaltenen Seiten.
    Styles ausgelagert in exports.pdf-styles.
--}}
@extends('layouts.export')

@section('title', $chapter->name)

@section('content')

@include('exports.pdf-styles')

<div class="chapter-hint" aria-hidden="true">{{ $chapter->name }}</div>

<div class="chapter-title-page">
    <h1 id="{{ $chapter->slug }}" class="chapter-h1">{{ $chapter->name }}</h1>
    @if($chapter->description)
        <p class="chapter-description">{{ $chapter->description }}</p>
    @endif
</div>

@foreach($chapter->pages as $page)
    <div class="blade-break"></div>
    @include('exports.parts.page-item', ['page' => $page])
@endforeach

@endsection
