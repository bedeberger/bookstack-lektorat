// Drift guard: every CSS class selector defined in public/css MUST be referenced
// somewhere the app can actually apply it — a partial, an index/share HTML file,
// a JS module (static class attribute, classList call, or dynamic build), an i18n
// string with embedded markup, or a server-side HTML emitter. A class rule that
// no code path can ever match is dead weight: it survives refactors, misleads code
// review ("this is styled, so it's used"), and bloats the shipped CSS.
//
// This is the inverse of css-tokens-defined.test.mjs (which catches undefined
// var() references). Here we catch defined-but-never-used class selectors.
//
// How a class stays green (i.e. counts as "used"):
//   - its full name appears as a whole word anywhere in the corpus (HTML/JS/JSON
//     + server emitters), OR
//   - it is built by string concatenation: some quoted literal in the corpus that
//     ends in `-`/`_` is a strict prefix of the class (e.g. `'card--'` keeps every
//     `.card--xxx` alive, `'severity-tag--'` keeps `.severity-tag--high` alive), OR
//   - it starts with a vendor prefix in ALLOW_PREFIXES (classes a bundled library
//     injects into the DOM at runtime and that we only style, never author).
//
// Known limitation (intentional, errs toward NOT failing): a class name mentioned
// only inside a code comment counts as "used". Stripping comments would raise the
// false-positive rate; a stale rule that is also name-dropped in a comment is rare
// and low-cost. The goal is catching whole dead clusters, not zero-tolerance.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const PUBLIC = join(ROOT, 'public');

// Vendor libraries that build their own class names at runtime (often via string
// concatenation, so even the bundled source has no full literal to match). We only
// override their internals, so these are alive-but-statically-invisible.
//   - leaflet-*  : Leaflet builds e.g. `'leaflet-popup' + '-content-wrapper'`
//                  (public/vendor/leaflet-1.9.4); styled in entities/orte-map.css.
const ALLOW_PREFIXES = ['leaflet-'];

// Escape hatch for individual classes that are genuinely live but defeat every
// heuristic above (e.g. applied only in manuscript content). Add with a one-line
// justification.
const ALLOW_CLASSES = new Set([
  'pullquote',       // .callout.pullquote — Manuskript-Inhaltsstil, vom Autor im Buchtext gesetzt (DESIGN.md).
  'stilbox--spaced', // dokumentierte Stilbox-Variante (DESIGN.md), Geschwister von .stilbox--review-summary.
]);

function walk(dir, exts) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p, exts));
    else if (exts.some((e) => p.endsWith(e))) out.push(p);
  }
  return out;
}

// --- 1. Collect every class selector defined in public/css ---------------------
// Class names: [a-zA-Z0-9_-], may start with a leading hyphen. We only scan the
// selector portion (text before each `{`) so declaration values like
// `content: ".x"` or `transition: .3s` can't be mistaken for selectors. Chunks
// containing `@` (media/supports/keyframes prelude) are skipped.
function collectDefinedClasses() {
  const cssFiles = walk(join(PUBLIC, 'css'), ['.css']);
  const defined = new Map(); // class -> Set(relative file paths)
  const selRe = /([^{}]+)\{/g;
  const clsRe = /\.(-?[a-zA-Z_][a-zA-Z0-9_-]*)/g;
  for (const f of cssFiles) {
    const css = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(selRe)) {
      const sel = m[1];
      if (sel.includes('@')) continue;
      for (const c of sel.matchAll(clsRe)) {
        if (!defined.has(c[1])) defined.set(c[1], new Set());
        defined.get(c[1]).add(relative(ROOT, f));
      }
    }
  }
  return defined;
}

// --- 2. Build the usage corpus -------------------------------------------------
// Everything that can apply a class: SPA assets + the server files that emit raw
// HTML (login page, share reader, importer, WP/EPUB/PDF builders).
function buildCorpus() {
  const files = [
    ...walk(join(PUBLIC, 'js'), ['.js', '.mjs', '.json']),
    ...walk(join(PUBLIC, 'partials'), ['.html']),
    ...walk(PUBLIC, ['.html']).filter((p) => !p.includes(`${join(PUBLIC, 'css')}`)),
    join(ROOT, 'routes/share.js'),
    join(ROOT, 'routes/auth.js'),
    join(ROOT, 'routes/jobs/folder-import.js'),
    join(ROOT, 'lib/wp-html.js'),
    ...walk(join(ROOT, 'lib/export-builders/epub'), ['.js']),
    join(ROOT, 'lib/pdf-render/html-walker.js'),
    // Diagramm-Knoten der SSR-Leseansicht (`mode: 'screen'`): der Server liefert
    // das gerenderte SVG in BEIDEN Themes aus, die Umschalt-Klassen entstehen
    // hier und nirgends im Bundle.
    join(ROOT, 'lib/diagram-export.js'),
  ];
  return [...new Set(files)]
    .filter(existsSync)
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
}

// Quoted string literals that end in `-`/`_` — concatenation prefixes for classes
// built at runtime (`'card--' + key`). Any class starting with one is kept alive.
function collectDynamicPrefixes(corpus) {
  const prefixes = new Set();
  for (const m of corpus.matchAll(/['"`]([a-zA-Z][a-zA-Z0-9_-]*[-_])/g)) prefixes.add(m[1]);
  return [...prefixes];
}

test('every CSS class selector in public/css is referenced by the app', () => {
  const defined = collectDefinedClasses();
  const corpus = buildCorpus();
  const dynPrefixes = collectDynamicPrefixes(corpus);

  const isUsed = (cls) => {
    if (ALLOW_CLASSES.has(cls)) return true;
    if (ALLOW_PREFIXES.some((p) => cls.startsWith(p))) return true;
    // whole-word literal match
    const wordRe = new RegExp(`(^|[^a-zA-Z0-9_-])${cls.replace(/[-]/g, '\\-')}([^a-zA-Z0-9_-]|$)`);
    if (wordRe.test(corpus)) return true;
    // dynamic concatenation prefix
    return dynPrefixes.some((p) => cls.startsWith(p) && cls !== p);
  };

  const dead = [...defined.keys()].filter((c) => !isUsed(c)).sort();
  const detail = dead.map((c) => `  .${c}  →  ${[...defined.get(c)].join(', ')}`).join('\n');

  assert.equal(
    dead.length,
    0,
    `Dead CSS class selectors — defined in public/css but referenced nowhere the app ` +
      `can apply them. Remove the rule, or (if it is genuinely live) wire it up / add ` +
      `it to ALLOW_PREFIXES/ALLOW_CLASSES with a justification:\n${detail}`,
  );
});
