'use strict';
// Baut das Focus-Editor-OTA-Bundle (ZIP) fuer den nativen macOS-Client
// (schreibwerkstatt-focuseditor), der die Editor-Assets zur Laufzeit zieht und
// lokal cacht, statt sie zur Build-Zeit aus dem Repo zu kopieren.
//
// SSoT fuer Editor-Code bleibt public/js — hier wird nur gelesen und gepackt.
// Dieses Modul ist zugleich die SSoT der Closure-Aufloesung
// (specifiersOf/resolveSpecifier/buildClosure): dieselbe Regex (statische +
// dynamische Imports), dieselbe Pfad-Logik (relative + /-absolute Specifier ab
// public/). Bare/externe Specifier werden nicht gebuendelt (Warnung) — im
// Editor-Kern nicht erwartet. (Der frueher hier gespiegelte Build-Step
// schreibwerkstatt-focuseditor/scripts/bundle-editor.mjs entfaellt: der
// macOS-Client zieht das Bundle nun per OTA und cacht es, statt es zur
// Build-Zeit zu kopieren.)

const { readFile } = require('node:fs/promises');
const { existsSync } = require('node:fs');
const { join, dirname, posix } = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const JSZip = require('jszip');
const logger = require('../logger');

const REPO_ROOT = join(__dirname, '..');
const PUBLIC_DIR = join(REPO_ROOT, 'public');

// Entry-Module der Import-Closure. standalone.js (mountStandaloneFocus) ist der
// Mount-Einstieg der Mac-Schale und zieht den focus/-Kern (card.js, controller.js
// etc.) + benoetigte shared/-Helfer ueber seine Closure; editor-host + block-merge
// explizit, weil der Bridge-Host bzw. die 409-Aufloesung sie brauchen (CLAUDE.md).
// focus.js (SPA-Facade) und ihr Trampoline (focus/trampoline.js) werden NICHT
// gebuendelt — der native Client importiert sie nie.
const ENTRY_MODULES = [
  'js/editor/focus/standalone.js',
  'js/editor/shared/editor-host.js',
  'js/editor/shared/block-merge.js',
  'js/cards/editor-spellcheck/controller.js',   // ← Mac-Spellcheck (zieht mapping.js + position.js, kein utils.js)
  'js/cards/editor-synonyme/controller.js',     // ← Mac-Synonyme (Alpine-frei, inline-Helfer, zieht nur apply-replacement.js)
  'js/editor/shared/apply-replacement.js',       // ← Spellcheck-/Synonym-onApplyReplacement (Range-Mutation + Caret-Restore), geteilt mit dispatch.js
  'js/editor/shared/quote-normalize.js',         // ← Mac-Anführungszeichen-Normalisierung (Toolbar-Icon; nutzt die fetch-freien Exports resolveQuoteStyle/normalizeQuotes, Buch-Locale liefert der Swift-Kern)
];

// CSS-Closure: Tokens (var(--…)-Quellen) + die vom Focus-Editor genutzten
// Stylesheets. Reihenfolge = Link-Reihenfolge im SPA.
const CSS_FILES = [
  'css/tokens/colors.css',
  'css/tokens/typography.css',
  'css/tokens/spacing.css',
  'css/tokens/scale.css',
  'css/tokens/motion.css',
  'css/components/icons.css',                   // ← Basis-.icon (fill/stroke) für das Spellcheck-Badge
  'css/editor/shared/editor-chrome.css',
  'css/editor/shared/conflict-resolution.css',
  'css/editor/focus/focus-mode.css',
  'css/editor/spellcheck.css',                  // ← Mac-Spellcheck (::highlight(lt-*), Badge, Popover)
  'css/editor/synonym-menu.css',                // ← Mac-Synonyme (.synonym-menu/.synonym-picker, --z-popover etc.)
];

// Roh-Assets (kein JS/CSS) ins ZIP-Root. Der Spellcheck-Badge referenziert
// /icons.svg#check|alert-triangle|loader|x — von der Closure nicht erfasst.
const EXTRA_ASSETS = ['icons.svg'];

// Findet statische + dynamische Specifier in einer JS-Quelle.
const IMPORT_RE = /(?:\bimport\b|\bexport\b)[^'"]*?from\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function specifiersOf(code) {
  const out = new Set();
  let m;
  while ((m = IMPORT_RE.exec(code)) !== null) out.add(m[1] || m[2]);
  return [...out];
}

// Loest einen Specifier relativ zum importierenden Modul (innerhalb public/)
// auf. Liefert einen public-relativen POSIX-Pfad oder null (extern/bare).
function resolveSpecifier(spec, fromPublicRel) {
  if (spec.startsWith('./') || spec.startsWith('../')) {
    return posix.normalize(posix.join(posix.dirname(fromPublicRel), spec));
  }
  if (spec.startsWith('/')) return posix.normalize(spec.slice(1));
  return null;
}

async function buildClosure(entries) {
  const visited = new Set();
  const queue = [...entries];
  const warnings = [];
  while (queue.length) {
    const rel = queue.shift();
    if (visited.has(rel)) continue;
    const abs = join(PUBLIC_DIR, rel);
    if (!existsSync(abs)) { warnings.push(`Modul fehlt in Quelle: ${rel}`); continue; }
    visited.add(rel);
    const code = await readFile(abs, 'utf8');
    for (const spec of specifiersOf(code)) {
      const target = resolveSpecifier(spec, rel);
      if (target === null) { warnings.push(`Bare/externer Import in ${rel}: '${spec}'`); continue; }
      if (!visited.has(target)) queue.push(target);
    }
  }
  return { files: [...visited].sort(), warnings };
}

// Quell-Commit einmal pro Prozess aufloesen (aendert sich ohne Neustart nicht;
// Deploy = systemd-Restart). Fehlt .git → 'unknown'.
let _sourceCommit;
function sourceCommit() {
  if (_sourceCommit !== undefined) return _sourceCommit;
  try {
    _sourceCommit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT })
      .toString().trim();
  } catch { _sourceCommit = 'unknown'; }
  return _sourceCommit;
}

// Gebuendeltes Ergebnis pro Prozess cachen — die Editor-Dateien aendern sich
// ohne Neustart nicht, und der Client fragt nur beim Online-Start an.
let _cache = null;

async function _build() {
  const { files: jsFiles, warnings } = await buildClosure(ENTRY_MODULES);
  const cssFiles = CSS_FILES.filter(f => {
    const ok = existsSync(join(PUBLIC_DIR, f));
    if (!ok) warnings.push(`CSS fehlt in Quelle: ${f}`);
    return ok;
  });
  const extraAssets = EXTRA_ASSETS.filter(f => {
    const ok = existsSync(join(PUBLIC_DIR, f));
    if (!ok) warnings.push(`Asset fehlt in Quelle: ${f}`);
    return ok;
  });
  if (warnings.length) logger.warn(`editor-bundle: ${warnings.join('; ')}`);

  const all = [...jsFiles, ...cssFiles, ...extraAssets];
  const contents = new Map();
  for (const rel of all) contents.set(rel, await readFile(join(PUBLIC_DIR, rel)));

  const commit = sourceCommit();
  const manifest = { sourceCommit: commit, jsFiles, cssFiles, extraAssets };

  // ETag: sha256 ueber Commit + sortierte (Pfad, Inhalts-Hash)-Paare. Stabil
  // ueber Requests/Neustarts solange Dateien + Commit unveraendert, und
  // unabhaengig von Eintrags-Reihenfolge.
  const etagHash = createHash('sha256');
  etagHash.update(commit);
  for (const rel of [...all].sort()) {
    etagHash.update(rel);
    etagHash.update(createHash('sha256').update(contents.get(rel)).digest('hex'));
  }
  const etag = `"${etagHash.digest('hex')}"`;

  const zip = new JSZip();
  for (const [rel, buf] of contents) zip.file(rel, buf);
  zip.file('bundle-manifest.json', JSON.stringify(manifest, null, 2));
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

  return { etag, buffer, manifest };
}

async function getBundle() {
  if (!_cache) _cache = await _build();
  return _cache;
}

module.exports = {
  getBundle,
  // Test-/Intern-Hooks
  buildClosure,
  specifiersOf,
  resolveSpecifier,
  ENTRY_MODULES,
  CSS_FILES,
  EXTRA_ASSETS,
  _resetCache() { _cache = null; },
};
