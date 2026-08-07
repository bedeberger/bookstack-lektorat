// Tripwire fuer das Format der Action-Icons in den Karten-Kopf-Clustern
// (`.card-actions`), wie es der Notebook-Editor-Pageview als Referenz vorgibt
// (public/partials/editor-page-actions.html, `.card-actions--grouped`).
//
// Ein Icon-only-Button (sichtbarer Inhalt = nur ein `<svg class="icon">`, kein
// Text/`x-text`) hat keinen sichtbaren Namen — Tooltip + a11y-Label sind Pflicht,
// sonst ist der Button fuer Screenreader und Hover-User stumm. Damit die Cluster
// nicht pro Karte auseinanderdriften (mal mit, mal ohne Tooltip; SVG mal
// fokussierbar), pinnt dieser Test die universellen Invarianten:
//
//   1. Klasse aus der Action-Icon-Familie (`icon-btn` ODER `btn-card-close`)
//   2. `type="button"`            — kein versehentliches Form-Submit
//   3. `aria-label` / `:aria-label` — Name fuer Screenreader (icon-only!)
//   4. `data-tip`  / `:data-tip`    — Hover-Tooltip (kein `title`, siehe DESIGN.md)
//   5. inneres `<svg ... aria-hidden="true">` — Icon nicht selbst exponiert
//
// Geprueft wird bewusst NUR innerhalb von `.card-actions` — andere Icon-Button-
// Varianten (search-clear, history-item-delete, chat-send, …) haben eigene
// Kontrakte. Prosa-Regel = Vorschlag, Test = Gesetz. Neuer Verstoss → CI rot.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const PARTIALS_DIR = join(REPO_ROOT, 'public', 'partials');
const INDEX_HTML = join(REPO_ROOT, 'public', 'index.html');

// Anerkannte Action-Icon-Button-Klassen in `.card-actions`. `btn-card-close` ist
// die bewusste Schwester-Variante fuer Karten-Schliessen-Buttons (gleiche
// Struktur, eigene Optik). Neue Variante hier ergaenzen statt Test aufweichen.
const ALLOWED_CLASSES = ['icon-btn', 'btn-card-close'];

function walk(dir, ext, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, ext, out);
    else if (entry.endsWith(ext)) out.push(full);
  }
  return out;
}

const rel = (p) => relative(REPO_ROOT, p);

// Balancierte `<div class="... card-actions ...">…</div>`-Regionen finden.
function cardActionsRegions(src) {
  const regions = [];
  const headRe = /<div\b[^>]*\bclass="[^"]*\bcard-actions\b[^"]*"[^>]*>/g;
  let m;
  while ((m = headRe.exec(src)) !== null) {
    let depth = 0;
    const tagRe = /<(\/?)div\b[^>]*?>/g;
    tagRe.lastIndex = m.index;
    let t;
    let end = src.length;
    while ((t = tagRe.exec(src)) !== null) {
      depth += t[1] === '/' ? -1 : 1;
      if (depth === 0) {
        end = tagRe.lastIndex;
        break;
      }
    }
    regions.push([m.index, end]);
  }
  return regions;
}

// Icon-only-Action-Buttons innerhalb der card-actions-Regionen + ihre Verstoesse.
function scan(file) {
  const src = readFileSync(file, 'utf8');
  const regions = cardActionsRegions(src);
  const violations = [];
  let found = 0;
  if (!regions.length) return { found, violations };

  const btnRe = /<button\b([^>]*)>([\s\S]*?)<\/button>/g;
  let m;
  while ((m = btnRe.exec(src)) !== null) {
    const start = m.index;
    if (!regions.some(([a, b]) => start >= a && start < b)) continue;

    const attrs = m[1];
    const body = m[2];

    // Icon-only: enthaelt `<svg class="icon">`, sonst kein sichtbarer Text/x-text.
    if (!/<svg\b[^>]*class="[^"]*\bicon\b[^"]*"/.test(body)) continue;
    const bareText = body.replace(/<[^>]+>/g, '').replace(/\s+/g, '');
    if (bareText !== '' || /x-text\s*=/.test(body)) continue;

    found++;
    const cls = (attrs.match(/\bclass="([^"]*)"/) || [])[1] || '';
    const probs = [];
    if (!ALLOWED_CLASSES.some((c) => new RegExp(`\\b${c}\\b`).test(cls))) {
      probs.push(`Klasse keine Action-Icon-Klasse (${cls || '—'})`);
    }
    if (!/(^|\s)type\s*=\s*"button"/.test(attrs)) probs.push('type="button" fehlt');
    if (!/(^|\s):?aria-label\s*=/.test(attrs)) probs.push('aria-label fehlt');
    if (!/(^|\s):?data-tip\s*=/.test(attrs)) probs.push('data-tip fehlt');
    if (!/<svg\b[^>]*\baria-hidden="true"/.test(body)) probs.push('svg aria-hidden="true" fehlt');

    if (probs.length) {
      const line = src.slice(0, start).split('\n').length;
      violations.push(`${rel(file)}:${line}: ${probs.join(', ')}`);
    }
  }
  return { found, violations };
}

const FILES = [...walk(PARTIALS_DIR, '.html'), INDEX_HTML];

test('card-actions icon buttons follow the notebook-pageview format', () => {
  const results = FILES.map(scan);
  const violations = results.flatMap((r) => r.violations);
  assert.equal(
    violations.length,
    0,
    'Action-Icon in `.card-actions` weicht vom Notebook-Pageview-Format ab ' +
      '(icon-btn/btn-card-close + type=button + aria-label + data-tip + aria-hidden svg):\n  ' +
      violations.join('\n  '),
  );
});

// Schutz gegen still-versagenden Test: wenn die Region-/Button-Erkennung durch
// ein Refactor bricht, faellt die Trefferzahl ab und der Test wuerde vacuously
// gruen. Die Referenz (Notebook-Pageview) allein hat ein gutes Dutzend.
test('scanner actually finds card-actions icon buttons (no vacuous pass)', () => {
  const total = FILES.map(scan).reduce((n, r) => n + r.found, 0);
  assert.ok(total >= 30, `Nur ${total} Action-Icons gefunden — Scanner vermutlich defekt.`);

  // Referenz ist die Lese-Aktionsleiste des Notebook-Editors — sie sass frueher
  // in editor-notebook.html und ist von dort ausgelagert (LOC-Limit).
  const notebook = scan(join(PARTIALS_DIR, 'editor-page-actions.html'));
  assert.ok(
    notebook.found >= 10,
    `Referenz editor-page-actions.html: nur ${notebook.found} Action-Icons gefunden.`,
  );
});
