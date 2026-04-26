{{--
    themes/custom/exports/parts/page-item.blade.php
    Override des Bookstack-Defaults. Markiert Dialog-Paragraphen
    (beginnen mit «) mit Klasse `dialog`, damit pdf-styles den
    Text-Einzug für Dialoge unterdrücken kann.
--}}
<div class="page-break"></div>

@if (isset($chapter))
    <div class="chapter-hint">{{$chapter->name}}</div>
@endif

<h1 id="page-{{$page->id}}">{{ $page->name }}</h1>

@php
    // Öffnende Anführungszeichen, die einen Dialog einleiten können:
    //   « U+00AB (Schweizer Guillemet öffnend)
    //   » U+00BB (deutscher Guillemet öffnend, »…«-Stil)
    //   „ U+201E (deutsch tief öffnend)
    //   " U+201C (englisch öffnend)
    //   ‚ U+201A (deutsch single tief)
    //   ' U+2018 (englisch single öffnend)
    //   " ASCII Doublequote
    //   ' ASCII Singlequote
    $html = $page->html;
    $html = preg_replace_callback(
        '/<p(\s[^>]*)?>(\s*)([\x{00AB}\x{00BB}\x{201C}\x{201E}\x{2018}\x{201A}"\'])/u',
        function ($m) {
            $attrs = $m[1] ?? '';
            $lead  = $m[2];
            $quote = $m[3];
            if (preg_match('/\bclass\s*=\s*"([^"]*)"/', $attrs)) {
                $attrs = preg_replace(
                    '/\bclass\s*=\s*"([^"]*)"/',
                    'class="$1 dialog"',
                    $attrs
                );
            } elseif (preg_match("/\bclass\s*=\s*'([^']*)'/", $attrs)) {
                $attrs = preg_replace(
                    "/\bclass\s*=\s*'([^']*)'/",
                    "class='$1 dialog'",
                    $attrs
                );
            } else {
                $attrs .= ' class="dialog"';
            }
            return '<p' . $attrs . '>' . $lead . $quote;
        },
        $html
    );
@endphp

{!! $html !!}
