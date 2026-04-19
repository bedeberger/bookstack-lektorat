{{--
    themes/custom/exports/page.blade.php — v2
    Einzelseiten-Export: eine Seite, konsistent zum Kapitel-/Buch-Export.
    Styles ausgelagert in exports.pdf-styles.
--}}
@extends('layouts.export')

@section('title', $page->name)

@section('content')

@include('exports.pdf-styles')

@php
    $contextName = $page->chapter->name ?? ($page->book->name ?? $page->name);
@endphp

<div class="chapter-hint" aria-hidden="true">{{ $contextName }}</div>

@include('exports.parts.page-item', ['page' => $page])

@endsection
