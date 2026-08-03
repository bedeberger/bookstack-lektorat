// PRICING + costUsd().
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PRICING, WEB_SEARCH_USD_PER_1K, costUsd, fallbackFamily } from '../../lib/pricing.js';

test('costUsd: lokale Provider liefern 0', () => {
  assert.equal(costUsd({ provider: 'ollama', model: 'llama3.2', tokensIn: 1000, tokensOut: 500 }), 0);
  assert.equal(costUsd({ provider: 'llama',  model: 'llama3.2', tokensIn: 1000, tokensOut: 500 }), 0);
});

test('costUsd: unbekanntes Modell faellt auf 0 zurueck (kein Throw)', () => {
  const usd = costUsd({ provider: 'claude', model: 'claude-mystery-9-0', tokensIn: 1_000_000, tokensOut: 1_000_000 });
  assert.equal(usd, 0);
});

test('costUsd: Sonnet 4-6 fixe Preise', () => {
  // 1 Mio Input + 1 Mio Output = 3.00 + 15.00 = 18.00 USD
  const usd = costUsd({ provider: 'claude', model: 'claude-sonnet-4-6', tokensIn: 1_000_000, tokensOut: 1_000_000 });
  assert.equal(Math.round(usd * 1000) / 1000, 18.0);
});

test('costUsd: Cache-Read billiger als Input, Cache-Write teurer', () => {
  // Sonnet: cache_read 0.30 < input 3.00 < cache_write 3.75
  const cacheRead = costUsd({ provider: 'claude', model: 'claude-sonnet-4-6', cacheReadIn: 1_000_000 });
  const inputOnly = costUsd({ provider: 'claude', model: 'claude-sonnet-4-6', tokensIn: 1_000_000 });
  const cacheWrite = costUsd({ provider: 'claude', model: 'claude-sonnet-4-6', cacheCreationIn: 1_000_000 });
  assert.ok(cacheRead < inputOnly);
  assert.ok(inputOnly < cacheWrite);
  assert.equal(cacheRead, 0.30);
  assert.equal(inputOnly, 3.00);
  assert.equal(cacheWrite, 3.75);
});

test('costUsd: tokensIn ist cache-inklusives Total — Cache-Anteile nicht doppelt bepreist', () => {
  // 1 Mio tokens_in, davon 800k Cache-Read + 100k Cache-Write → nur 100k zum Input-Tarif.
  const usd = costUsd({
    provider: 'claude', model: 'claude-sonnet-4-6',
    tokensIn: 1_000_000, cacheReadIn: 800_000, cacheCreationIn: 100_000,
  });
  // 100k*3.00 + 100k*3.75 + 800k*0.30 = 0.30 + 0.375 + 0.24
  assert.equal(Math.round(usd * 1000) / 1000, 0.915);
});

test('costUsd: 1h-Cache-Write zum 2x-Tarif, Rest zum 5min-Satz', () => {
  // Sonnet: cache_write 3.75 (5min), cache_write_1h 6.00 (2x Input)
  const all5m = costUsd({ provider: 'claude', model: 'claude-sonnet-4-6', tokensIn: 1_000_000, cacheCreationIn: 1_000_000 });
  const all1h = costUsd({ provider: 'claude', model: 'claude-sonnet-4-6', tokensIn: 1_000_000, cacheCreationIn: 1_000_000, cacheCreation1hIn: 1_000_000 });
  const mixed = costUsd({ provider: 'claude', model: 'claude-sonnet-4-6', tokensIn: 1_000_000, cacheCreationIn: 1_000_000, cacheCreation1hIn: 400_000 });
  assert.equal(all5m, 3.75);
  assert.equal(all1h, 6.00);
  // 600k*3.75 + 400k*6.00 = 2.25 + 2.40
  assert.equal(Math.round(mixed * 1000) / 1000, 4.65);
});

test('costUsd: cacheCreation1hIn wird aufs Write-Total geklemmt', () => {
  // Inkonsistente Row (1h > Total) darf nicht negativ/überzählt rechnen.
  const usd = costUsd({
    provider: 'claude', model: 'claude-sonnet-4-6',
    tokensIn: 100_000, cacheCreationIn: 100_000, cacheCreation1hIn: 500_000,
  });
  assert.equal(usd, 0.60); // 100k * 6.00, kein 5min-Anteil, kein Input-Anteil
});

test('fallbackFamily: dated model IDs auf Familie mappen', () => {
  assert.equal(fallbackFamily('claude-sonnet-4-6-20251015'), 'claude-sonnet-4-6');
  assert.equal(fallbackFamily('claude-opus-4-7-20260101'),   'claude-opus-4-7');
  assert.equal(fallbackFamily('claude-haiku-4-5-2025xxxx'),  'claude-haiku-4-5');
  assert.equal(fallbackFamily('unknown-foo'),                null);
});

// Regression: der generische Fallback kannte nur `^claude-(opus|sonnet)-4-`. Ein
// Wechsel des Komplett-Modells auf ein 5er-Modell wurde damit still mit 0 USD
// verbucht (nur eine Logger-Warnung) — inkl. Budget-Gate, Admin-Usage, /metrics.
test('fallbackFamily: 5er-Serie inkl. Suffix-/Punktversionen', () => {
  assert.equal(fallbackFamily('claude-opus-5'),          'claude-opus-5');
  assert.equal(fallbackFamily('claude-opus-5[1m]'),      'claude-opus-5');
  assert.equal(fallbackFamily('claude-opus-5-1'),        'claude-opus-5');
  assert.equal(fallbackFamily('claude-sonnet-5'),        'claude-sonnet-5');
  assert.equal(fallbackFamily('claude-sonnet-5[1m]'),    'claude-sonnet-5');
  assert.equal(fallbackFamily('claude-fable-5'),         'claude-fable-5');
  assert.equal(fallbackFamily('claude-mythos-5'),        'claude-mythos-5');
  // Die 4.x-Familien bleiben unberuehrt (5er-Regex darf nicht zu breit greifen).
  assert.equal(fallbackFamily('claude-opus-4-8[1m]'),    'claude-opus-4-8');
  assert.equal(fallbackFamily('claude-sonnet-4-6'),      'claude-sonnet-4-6');
});

// Drift-Gate: das Ledger friert die USD pro Call ein. Ein Modell OHNE Tarif
// bucht still 0 — der Fehler faellt erst auf, wenn eine Monatsrechnung nicht zur
// App-Anzeige passt. Darum muss JEDES Modell, das ueber ein App-Setting waehlbar
// ist, hier einen Tarif haben.
test('PRICING: jedes per Setting waehlbare Claude-Modell hat einen Tarif', () => {
  // app-settings.js wird als TEXT gelesen, nicht importiert: das Modul oeffnet beim
  // Laden die SQLite-Verbindung, und dieser Test soll seiteneffektfrei bleiben.
  const src = readFileSync(new URL('../../lib/app-settings.js', import.meta.url), 'utf8');
  const declared = [...src.matchAll(/'ai\.claude\.model[^']*':\s*'([^']*)'/g)]
    .map(m => m[1].trim()).filter(Boolean);
  // Die aktuell empfohlenen Modelle aus docs/komplett.md + docs/ai-providers.md.
  // Neues Modell in einer Empfehlung ⇒ hier UND in lib/pricing.js ergaenzen.
  const candidates = new Set([...declared,
    'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6',
    'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-fable-5',
  ]);
  for (const model of candidates) {
    const usd = costUsd({ provider: 'claude', model, tokensIn: 1_000_000 });
    assert.ok(usd > 0, `Modell '${model}' hat keinen Tarif in lib/pricing.js (Kosten wuerden als 0 verbucht)`);
  }
});

test('costUsd: Family-Fallback wirkt fuer dated model IDs', () => {
  const exact = costUsd({ provider: 'claude', model: 'claude-sonnet-4-6',          tokensIn: 1_000_000 });
  const dated = costUsd({ provider: 'claude', model: 'claude-sonnet-4-6-20251015', tokensIn: 1_000_000 });
  assert.equal(exact, dated);
});

test('PRICING: Opus > Sonnet > Haiku (Input-Preis)', () => {
  assert.ok(PRICING['claude-opus-4-7'].input > PRICING['claude-sonnet-4-6'].input);
  assert.ok(PRICING['claude-sonnet-4-6'].input > PRICING['claude-haiku-4-5'].input);
});

test('costUsd: Web-Suche als separater Server-Tool-Posten (~$10/1k)', () => {
  // 5 Web-Suchen, keine Tokens → 5 * 10/1000 = 0.05
  assert.equal(WEB_SEARCH_USD_PER_1K, 10.00);
  assert.equal(costUsd({ provider: 'claude', model: 'claude-sonnet-4-6', webSearches: 5 }), 0.05);
});

test('costUsd: Web-Such-Kosten ZUSAETZLICH zu den Token-Kosten', () => {
  const tokensOnly = costUsd({ provider: 'claude', model: 'claude-sonnet-4-6', tokensIn: 1_000_000, tokensOut: 1_000_000 });
  const withSearch = costUsd({ provider: 'claude', model: 'claude-sonnet-4-6', tokensIn: 1_000_000, tokensOut: 1_000_000, webSearches: 4 });
  assert.equal(Math.round((withSearch - tokensOnly) * 1000) / 1000, 0.04);
});

test('costUsd: Web-Suche nur fuer Claude (lokale Provider 0)', () => {
  assert.equal(costUsd({ provider: 'ollama', model: 'llama3.2', webSearches: 10 }), 0);
});

test('costUsd: webSearches nullish/0 aendert nichts', () => {
  const base = costUsd({ provider: 'claude', model: 'claude-sonnet-4-6', tokensIn: 1_000_000 });
  assert.equal(costUsd({ provider: 'claude', model: 'claude-sonnet-4-6', tokensIn: 1_000_000, webSearches: 0 }), base);
  assert.equal(costUsd({ provider: 'claude', model: 'claude-sonnet-4-6', tokensIn: 1_000_000, webSearches: null }), base);
});

test('costUsd: nullish/NaN-Tokens behandelt wie 0', () => {
  const usd = costUsd({ provider: 'claude', model: 'claude-sonnet-4-6', tokensIn: null, tokensOut: undefined });
  assert.equal(usd, 0);
});
