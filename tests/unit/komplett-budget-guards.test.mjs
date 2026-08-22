// Budget-Entscheidungen der Komplettanalyse:
//   1. chunkLimitsFor(provider, { maxTokensOut }) — die Chunk-Grenze muss gegen DAS Cap
//      gerechnet werden, das die Calls der Phase tatsächlich reservieren.
//   2. consolidationFitsCap — Preflight, der eine sichere Truncation vorwegnimmt.
//   3. maxParallelCalls — SSoT der Frage «verträgt der Endpunkt zwei Calls?».

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require_ = createRequire(import.meta.url);

function _bootstrap() {
  const dir = mkdtempSync(join(tmpdir(), 'komplett-budget-'));
  process.env.DB_PATH = join(dir, 'test.db');
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test';
  for (const key of Object.keys(require_.cache)) {
    if (key.includes('/db/') || key.includes('/lib/') || key.includes('/routes/')) delete require_.cache[key];
  }
  require_('../../db/connection');
  require_('../../db/migrations').runMigrations();
  return {
    dir,
    appSettings: require_('../../lib/app-settings'),
    ai: require_('../../lib/ai'),
    loader: require_('../../routes/jobs/shared/loader'),
    utils: require_('../../routes/jobs/komplett/utils'),
    tokens: require_('../../routes/jobs/komplett/phases/tokens'),
    teardown: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

// ── 1. chunkLimitsFor ────────────────────────────────────────────────────────

test('chunkLimitsFor: ein tieferes Output-Cap vergrössert das Chunk-Budget', () => {
  const ctx = _bootstrap();
  try {
    ctx.appSettings.set('ai.openai-compat.context_window', 96000, 'test');
    ctx.appSettings.set('ai.openai-compat.max_tokens_out', 48000, 'test');
    const weit = ctx.loader.chunkLimitsFor('openai-compat');
    const eng  = ctx.loader.chunkLimitsFor('openai-compat', { maxTokensOut: 32000 });
    // 16 000 Tokens weniger Output-Reserve → 16 000 × charsPerToken mehr Input-Budget,
    // davon 35 % pro Chunk. charsPerToken NICHT hart setzen: der Wert ist boot-frozen
    // (lib/ai/config.js liest ai.provider beim Modul-Load) und in einer leeren Test-DB
    // der Claude-Default 3, auf einer lokalen Instanz 4.
    const cpt = ctx.ai.getContextConfigFor('openai-compat').charsPerToken;
    const delta = eng.perChunk - weit.perChunk;
    assert.ok(Math.abs(delta - 16000 * cpt * 0.35) <= 1, `Delta ${delta} passt nicht zu charsPerToken=${cpt}`);
    assert.ok(eng.singlePass > weit.singlePass);
  } finally { ctx.teardown(); }
});

test('chunkLimitsFor: ohne maxTokensOut unverändert (Rückwärtskompatibilität)', () => {
  const ctx = _bootstrap();
  try {
    ctx.appSettings.set('ai.openai-compat.context_window', 96000, 'test');
    ctx.appSettings.set('ai.openai-compat.max_tokens_out', 48000, 'test');
    const ohne = ctx.loader.chunkLimitsFor('openai-compat');
    const gleich = ctx.loader.chunkLimitsFor('openai-compat', { maxTokensOut: 48000 });
    assert.deepEqual(ohne, gleich);
  } finally { ctx.teardown(); }
});

test('chunkLimitsFor: Cloud-Klasse verhaltensneutral (komplettMaxTokens = Ceiling)', () => {
  const ctx = _bootstrap();
  try {
    ctx.appSettings.set('ai.claude.context_window', 200000, 'test');
    ctx.appSettings.set('ai.claude.max_tokens_out', 64000, 'test');
    ctx.appSettings.set('ai.komplett.extract_max_tokens', 16000, 'test');
    // Genau der Aufruf aus job-komplett.js: das Cap der Cloud-Klasse IST das Ceiling,
    // die Chunk-Grenze darf sich also nicht bewegen.
    const cap = ctx.tokens.komplettMaxTokens('claude');
    assert.deepEqual(
      ctx.loader.chunkLimitsFor('claude', { maxTokensOut: cap }),
      ctx.loader.chunkLimitsFor('claude'),
    );
  } finally { ctx.teardown(); }
});

test('chunkLimitsFor: unsinniges Cap kollabiert nicht ins Negative', () => {
  const ctx = _bootstrap();
  try {
    ctx.appSettings.set('ai.openai-compat.context_window', 32000, 'test');
    ctx.appSettings.set('ai.openai-compat.max_tokens_out', 8000, 'test');
    const l = ctx.loader.chunkLimitsFor('openai-compat', { maxTokensOut: 999999 });
    assert.ok(l.perChunk >= 10000, 'Untergrenze greift');
    assert.ok(l.singlePass >= 20000, 'Untergrenze greift');
  } finally { ctx.teardown(); }
});

// ── 2. consolidationFitsCap ──────────────────────────────────────────────────

test('consolidationFitsCap: knapp unter dem Cap → Call wird geführt', () => {
  const ctx = _bootstrap();
  try {
    // 100 000 Zeichen / 4 = 25 000 Tokens, Reserve 0.9 × 32 000 = 28 800.
    const fit = ctx.utils.consolidationFitsCap({
      promptText: 'x'.repeat(100000), charsPerToken: 4, cap: 32000,
    });
    assert.equal(fit.estOut, 25000);
    assert.equal(fit.fits, true);
  } finally { ctx.teardown(); }
});

test('consolidationFitsCap: über der Reserve → Call wird übersprungen', () => {
  const ctx = _bootstrap();
  try {
    // Der gemessene Realfall: 36 033 Tokens Prompt gegen ein 32 000er Cap.
    const fit = ctx.utils.consolidationFitsCap({
      promptText: 'x'.repeat(36033 * 4), charsPerToken: 4, cap: 32000,
    });
    assert.equal(fit.fits, false);
    assert.equal(fit.cap, 32000);
  } finally { ctx.teardown(); }
});

test('consolidationFitsCap: Reserve ist der Grenzwert, nicht das Cap', () => {
  const ctx = _bootstrap();
  try {
    const knappDrunter = ctx.utils.consolidationFitsCap({
      promptText: 'x'.repeat(28800 * 4), charsPerToken: 4, cap: 32000,
    });
    const knappDrueber = ctx.utils.consolidationFitsCap({
      promptText: 'x'.repeat(28804 * 4), charsPerToken: 4, cap: 32000,
    });
    assert.equal(knappDrunter.fits, true);
    assert.equal(knappDrueber.fits, false);
  } finally { ctx.teardown(); }
});

test('consolidationFitsCap: ohne brauchbares Cap wird nicht geraten', () => {
  const ctx = _bootstrap();
  try {
    const fit = ctx.utils.consolidationFitsCap({ promptText: 'x'.repeat(999999), charsPerToken: 4, cap: 0 });
    assert.equal(fit.fits, true, 'kein Cap → bisheriges Verhalten (rufen)');
  } finally { ctx.teardown(); }
});

// ── 3. maxParallelCalls ──────────────────────────────────────────────────────

test('maxParallelCalls: ollama ist immer seriell (globaler Mutex)', () => {
  const ctx = _bootstrap();
  try {
    assert.equal(ctx.ai.maxParallelCalls('ollama'), 1);
  } finally { ctx.teardown(); }
});

test('maxParallelCalls: openai-compat folgt ai.openai-compat.max_parallel', () => {
  const ctx = _bootstrap();
  try {
    ctx.appSettings.set('ai.openai-compat.max_parallel', 1, 'test');
    assert.equal(ctx.ai.maxParallelCalls('openai-compat'), 1);
    ctx.appSettings.set('ai.openai-compat.max_parallel', 2, 'test');
    assert.equal(ctx.ai.maxParallelCalls('openai-compat'), 2);
  } finally { ctx.teardown(); }
});

test('maxParallelCalls: claude hat hier kein Gate', () => {
  const ctx = _bootstrap();
  try {
    assert.ok(ctx.ai.maxParallelCalls('claude') > 1);
  } finally { ctx.teardown(); }
});

test('maxParallelCalls: unbekannter Provider fällt auf claude zurück', () => {
  const ctx = _bootstrap();
  try {
    assert.equal(ctx.ai.maxParallelCalls('quatsch'), ctx.ai.maxParallelCalls('claude'));
  } finally { ctx.teardown(); }
});
