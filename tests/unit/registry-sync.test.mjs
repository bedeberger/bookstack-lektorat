// Registry-Sync drift — vier Single-Source-of-Truth-Stellen müssen synchron sein:
//   1. FEATURES (public/js/cards/feature-registry.js, kind:'toggle')
//   2. EXCLUSIVE_CARDS (same file)
//   3. ALLOWED_KEYS (routes/usage.js — Tracking-Allowlist)
//   4. Hash-Router-watchers + apply-Branch (public/js/app/app-hash-router/)
//   5. showXxxCard-Flags (public/js/app/app-state.js#cardsState)
//
// Fehlt eine neue Karte in (3), verwirft `/usage/track` 400 → keine Recency-
// Position. Fehlt sie in (2), bricht Exklusivität. Fehlt sie in (4),
// kein Deep-Link / kein Permalink. Fehlt sie in (5), Alpine wirft beim
// $watch im Hash-Router.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8');

// ── FEATURES + EXCLUSIVE_CARDS importieren (ESM) ────────────────────────────
const { FEATURES, EXCLUSIVE_CARDS } = await import(
  path.join('file://', repo, 'public/js/cards/feature-registry.js')
);

// ── ALLOWED_KEYS aus routes/usage.js parsen ─────────────────────────────────
function parseAllowedKeys() {
  const src = read('routes/usage.js');
  const m = src.match(/const\s+ALLOWED_KEYS\s*=\s*new\s+Set\(\s*\[([\s\S]*?)\]\s*\)/);
  assert.ok(m, 'ALLOWED_KEYS-Set in routes/usage.js gefunden');
  // Strings extrahieren (einfacher, robuster Match).
  const keys = [];
  for (const lineMatch of m[1].matchAll(/['"]([^'"]+)['"]/g)) {
    keys.push(lineMatch[1]);
  }
  return new Set(keys);
}

// ── cardsState-Flags aus app-state.js parsen ────────────────────────────────
function parseCardsStateFlags() {
  const src = read('public/js/app/app-state.js');
  const m = src.match(/const\s+cardsState\s*=\s*\(\)\s*=>\s*\(\{([\s\S]*?)\}\)/);
  assert.ok(m, 'cardsState in app-state.js gefunden');
  const flags = [];
  for (const lineMatch of m[1].matchAll(/(show[A-Z]\w+)\s*:/g)) {
    flags.push(lineMatch[1]);
  }
  return new Set(flags);
}

// ── Hash-Router-watchers + apply-View-Cases parsen ──────────────────────────
function parseHashRouterFlags() {
  // Der Router ist eine Facade ueber app-hash-router/ (build/apply/setup).
  // Facade + alle Submodule zusammen lesen, damit der Test eine spaetere
  // Umverteilung INNERHALB des Routers ueberlebt und nur dann rot wird, wenn
  // das watchers-Array wirklich verschwindet.
  const dir = 'public/js/app/app-hash-router';
  const src = [
    read('public/js/app/app-hash-router.js'),
    ...fs.readdirSync(path.join(repo, dir))
      .filter(f => f.endsWith('.js'))
      .map(f => read(path.join(dir, f))),
  ].join('\n');
  // watchers-Array in _setupHashRouting.
  const m = src.match(/const\s+watchers\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(m, 'watchers-Array im Hash-Router gefunden');
  const flags = [];
  for (const lineMatch of m[1].matchAll(/['"](show[A-Z]\w+)['"]/g)) {
    flags.push(lineMatch[1]);
  }
  return new Set(flags);
}

const ALLOWED_KEYS = parseAllowedKeys();
const CARDS_STATE_FLAGS = parseCardsStateFlags();
const HASH_WATCHED_FLAGS = parseHashRouterFlags();

// EXCLUSIVE_CARDS ist ein Superset von FEATURES — enthält zusätzlich Karten
// ohne Palette-Eintrag (z.B. kapitelReview via Sidebar, userSettings via Avatar).
// Nicht-exklusive Karten + Sentinels werden hier whitelisted.
const NON_EXCLUSIVE_WHITELIST = new Set([
  // Side-Slot-Karten, kein Exklusivitäts-Verhalten:
  'showBookCard',        // Sidebar-Buch-Auswahl (immer sichtbar)
  'showTreeCard',        // Sidebar-Seitenbaum
  'showEditorCard',      // Editor — gegen-exklusiv via _closeOtherMainCards/selectPage, kein Eintrag
  'showChatCard',        // Seiten-Chat (Slot neben Editor)
  'showIdeenCard',       // Seiten-Ideen (Slot neben Editor)
  'showReferenceCard',   // Referenz-Slot (Slot neben Editor, Mutex mit Chat/Ideen)
  // UI-Sentinels, keine eigene Karte:
  'showKomplettStatus',
  'showAvatarMenu',
  'showGlobalZeitstrahl',
]);

// ──────────────────────────────────────────────────────────────────────────
// FEATURES (kind:'toggle') ↔ ALLOWED_KEYS
// ──────────────────────────────────────────────────────────────────────────

test('Jeder FEATURE (toggle) hat einen ALLOWED_KEYS-Eintrag (Usage-Tracking)', () => {
  const toggles = FEATURES.filter(f => f.kind === 'toggle');
  const missing = toggles.filter(f => !ALLOWED_KEYS.has(f.key)).map(f => f.key);
  assert.deepEqual(missing, [],
    `Keys fehlen in ALLOWED_KEYS (routes/usage.js): ${JSON.stringify(missing)} — ` +
    `Tracking-POSTs werden 400-abgewiesen, keine Recency-Position`);
});

test('Jeder ALLOWED_KEYS-Eintrag hat ein zugehöriges FEATURE (toggle)', () => {
  const featureKeys = new Set(FEATURES.filter(f => f.kind === 'toggle').map(f => f.key));
  const orphans = [...ALLOWED_KEYS].filter(k => !featureKeys.has(k));
  assert.deepEqual(orphans, [],
    `ALLOWED_KEYS enthält Karten, die nicht (mehr) in FEATURES sind: ${JSON.stringify(orphans)}`);
});

// ──────────────────────────────────────────────────────────────────────────
// FEATURES ↔ EXCLUSIVE_CARDS (via flag)
// ──────────────────────────────────────────────────────────────────────────

test('Jeder FEATURE (toggle) hat einen EXCLUSIVE_CARDS-Eintrag', () => {
  const exFlags = new Set(EXCLUSIVE_CARDS.map(e => e.flag));
  const toggles = FEATURES.filter(f => f.kind === 'toggle');
  const missing = toggles.filter(f => !exFlags.has(f.flag)).map(f => `${f.key} (${f.flag})`);
  assert.deepEqual(missing, [],
    `FEATURE-Flags fehlen in EXCLUSIVE_CARDS — Exklusivität bricht: ${JSON.stringify(missing)}`);
});

test('EXCLUSIVE_CARDS sind eindeutig (kein Doppel-Eintrag)', () => {
  const seenFlags = new Set();
  const seenKeys = new Set();
  for (const e of EXCLUSIVE_CARDS) {
    assert.ok(!seenFlags.has(e.flag), `EXCLUSIVE_CARDS doppelt: flag=${e.flag}`);
    assert.ok(!seenKeys.has(e.key),   `EXCLUSIVE_CARDS doppelt: key=${e.key}`);
    seenFlags.add(e.flag);
    seenKeys.add(e.key);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// EXCLUSIVE_CARDS.flag ↔ cardsState-Felder (existieren als State)
// ──────────────────────────────────────────────────────────────────────────

test('Jedes EXCLUSIVE_CARDS.flag existiert in cardsState() (app-state.js)', () => {
  const missing = EXCLUSIVE_CARDS.filter(e => !CARDS_STATE_FLAGS.has(e.flag)).map(e => e.flag);
  assert.deepEqual(missing, [],
    `EXCLUSIVE_CARDS-Flags ohne State-Feld: ${JSON.stringify(missing)} — ` +
    `_closeOtherMainCards wirft beim Setzen`);
});

// ──────────────────────────────────────────────────────────────────────────
// cardsState-Flags ↔ EXCLUSIVE_CARDS / Whitelist
// ──────────────────────────────────────────────────────────────────────────

test('Jedes cardsState-Flag ist exklusiv oder explizit whitelisted', () => {
  const exFlags = new Set(EXCLUSIVE_CARDS.map(e => e.flag));
  const orphans = [...CARDS_STATE_FLAGS].filter(
    f => !exFlags.has(f) && !NON_EXCLUSIVE_WHITELIST.has(f),
  );
  assert.deepEqual(orphans, [],
    `cardsState-Flags ohne EXCLUSIVE_CARDS-Eintrag und nicht in Whitelist: ${JSON.stringify(orphans)}. ` +
    `Entweder Eintrag ergänzen oder als Slot-/Sentinel-Flag in NON_EXCLUSIVE_WHITELIST aufnehmen.`);
});

// ──────────────────────────────────────────────────────────────────────────
// Hash-Router-watchers ↔ FEATURES.flag
// ──────────────────────────────────────────────────────────────────────────

test('Jeder FEATURE-Flag (toggle) wird im Hash-Router beobachtet (Deep-Link/Permalink)', () => {
  const toggles = FEATURES.filter(f => f.kind === 'toggle');
  const missing = toggles.filter(f => !HASH_WATCHED_FLAGS.has(f.flag))
    .map(f => `${f.key} (${f.flag})`);
  assert.deepEqual(missing, [],
    `FEATURE-Flags fehlen im Hash-Router-watchers-Array: ${JSON.stringify(missing)} — ` +
    `Permalink stoppt, Browser-Back funktioniert nicht für diese Karte`);
});

test('Hash-Router-watchers haben keinen toten Flag (alle existieren im State)', () => {
  const orphans = [...HASH_WATCHED_FLAGS].filter(f => !CARDS_STATE_FLAGS.has(f));
  // Watchers können auch Nicht-Card-Flags beobachten (selectedBookId, currentPage usw.)
  // Wir prüfen NUR `show*Card`-Flags, da nur die in cardsState leben.
  const cardFlagOrphans = orphans.filter(f => /^show[A-Z]/.test(f));
  assert.deepEqual(cardFlagOrphans, [],
    `Hash-Router beobachtet Card-Flags, die nicht in cardsState existieren: ${JSON.stringify(cardFlagOrphans)}`);
});

// ──────────────────────────────────────────────────────────────────────────
// FEATURE.toggle-Methoden müssen existieren (app-view.js)
// ──────────────────────────────────────────────────────────────────────────

test('Jede FEATURE.toggle-Methode existiert (bespoke in app-view.js/kapitel-review.js oder generiert aus EXCLUSIVE_CARDS)', () => {
  // Hauptkarten-Toggles werden aus EXCLUSIVE_CARDS generiert (siehe
  // appViewMethods in app-view.js). Spezial-Toggles bleiben handgeschrieben.
  const appViewSrc = read('public/js/app/app-view.js');
  const kapitelReviewSrc = read('public/js/book/kapitel-review.js');
  const generatedToggles = new Set(
    EXCLUSIVE_CARDS.filter(e => !e.bespoke && e.toggle).map(e => e.toggle)
  );
  const toggles = FEATURES.filter(f => f.kind === 'toggle');
  const missing = toggles.filter(f => {
    if (generatedToggles.has(f.toggle)) return false;
    const re = new RegExp(`\\b${f.toggle}\\s*\\(\\)\\s*\\{`, 'm');
    return !re.test(appViewSrc) && !re.test(kapitelReviewSrc);
  }).map(f => f.toggle);
  assert.deepEqual(missing, [],
    `FEATURE.toggle-Methoden fehlen (nicht in app-view.js, nicht in kapitel-review.js, nicht in EXCLUSIVE_CARDS-Generator): ${JSON.stringify(missing)}`);
});

// ──────────────────────────────────────────────────────────────────────────
// DEFAULT_RECENT_KEYS sind gültige FEATURE-Keys
// ──────────────────────────────────────────────────────────────────────────

test('DEFAULT_RECENT_KEYS verweisen auf existierende FEATURES', async () => {
  const { DEFAULT_RECENT_KEYS } = await import(
    path.join('file://', repo, 'public/js/cards/feature-registry.js')
  );
  const featureKeys = new Set(FEATURES.map(f => f.key));
  const invalid = DEFAULT_RECENT_KEYS.filter(k => !featureKeys.has(k));
  assert.deepEqual(invalid, [],
    `DEFAULT_RECENT_KEYS verweisen auf nicht existierende Features: ${JSON.stringify(invalid)}`);
});
