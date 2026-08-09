// Modell-Prädikate in lib/ai/config.js: welche Request-Felder ein Claude-Modell
// verträgt, wird ausschliesslich am Modellstring entschieden — ein Modellwechsel per
// App-Setting oder ALS-Override soll automatisch das richtige Verhalten wählen.
//
// Warum als Tabelle: die fünf Prädikate müssen für dieselbe Generation KONSISTENT
// antworten. Ein Modell, das `_isModernClaudeGen` verpasst, bekommt `temperature`
// mitgeschickt und stirbt an non-retryable HTTP 400 — genau der Fall, der beim
// Erscheinen von Opus 5 auftrat (die alte Regex traf nur `claude-opus-4-…`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require_ = createRequire(import.meta.url);

function _bootstrap() {
  const dir = mkdtempSync(join(tmpdir(), 'claude-pred-'));
  process.env.DB_PATH = join(dir, 'test.db');
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test';
  for (const key of Object.keys(require_.cache)) {
    if (key.includes('/db/') || key.includes('/lib/')) delete require_.cache[key];
  }
  require_('../../db/connection');
  require_('../../db/migrations').runMigrations();
  return {
    dir,
    cfg: require_('../../lib/ai/config'),
    logCtx: require_('../../lib/log-context'),
    teardown: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

// modern = Sampling-Parameter entfernt (temperature → 400), Thinking adaptiv,
//          neuer Tokenizer (2.5 chars/Token), Structured Outputs
// maxOut = hartes Output-Ceiling, gegen das _callClaudeAttempt klemmt
// effort = akzeptiert output_config.effort überhaupt
// max    = 'max' wird durchgelassen (kam mit Opus 4.6 UND Sonnet 4.6)
// xhigh  = 'xhigh' wird durchgelassen (kam erst mit Opus 4.7)
const TABLE = [
  // Modellstring             modern  maxOut  effort  max    xhigh
  ['claude-opus-5',           true,   128000, true,   true,  true],
  ['claude-opus-5[1m]',       true,   128000, true,   true,  true],
  ['claude-sonnet-5',         true,   128000, true,   true,  true],
  ['claude-fable-5',          true,   128000, true,   true,  true],
  ['claude-opus-4-8',         true,   128000, true,   true,  true],
  ['claude-opus-4-8[1m]',     true,   128000, true,   true,  true],
  ['claude-opus-4-7',         true,   128000, true,   true,  true],
  ['claude-opus-4-6',         false,  128000, true,   true,  false],
  ['claude-opus-4-5',         false,  128000, true,   false, false],
  ['claude-sonnet-4-6',       false,  64000,  true,   true,  false],
  ['claude-sonnet-4-5',       false,  64000,  false,  false, false], // effort → 400
  ['claude-haiku-4-5',        false,  64000,  false,  false, false], // effort → 400
];

test('Modell-Prädikate: Generation, Output-Ceiling und Effort-Leiter konsistent', () => {
  const { cfg, teardown } = _bootstrap();
  try {
    for (const [model, modern, maxOut, acceptsEffort] of TABLE) {
      assert.equal(cfg._isModernClaudeGen(model), modern, `_isModernClaudeGen('${model}')`);
      assert.equal(cfg._claudeModelMaxOut(model), maxOut, `_claudeModelMaxOut('${model}')`);
      assert.equal(cfg._claudeAcceptsEffort(model), acceptsEffort, `_claudeAcceptsEffort('${model}')`);
      // Abgeleitete Prädikate müssen der Generation folgen, nicht eigenständig driften.
      assert.equal(cfg._claudeAcceptsTemperature(model), !modern, `_claudeAcceptsTemperature('${model}')`);
      assert.equal(cfg._claudeUsesAdaptiveThinking(model), modern, `_claudeUsesAdaptiveThinking('${model}')`);
      // Ein modernes Modell darf NIE temperature bekommen (das ist der 400-Killer)
      // und muss immer ein thinking-Feld tragen (sonst leakt Reasoning-Prosa ins JSON).
      assert.equal('temperature' in cfg._claudeSamplingParams(model), !modern, `sampling('${model}')`);
      assert.equal('thinking' in cfg._claudeThinkingParams(model), modern, `thinking('${model}')`);
    }
  } finally { teardown(); }
});

test('Effort-Clamping: xhigh/max nur wo unterstützt, sonst auf high', () => {
  const { cfg, logCtx, teardown } = _bootstrap();
  try {
    const effortFor = (model, effort) => logCtx.runWithContext({ aiJob: { provider: 'claude', effort } },
      () => cfg._claudeOutputConfigParams(model).output_config?.effort ?? null);

    for (const [model, , , acceptsEffort, allowsMax, allowsXhigh] of TABLE) {
      if (!acceptsEffort) {
        // Kein Effort-Feld senden — Sonnet 4.5 / Haiku 4.5 antworten sonst mit 400.
        assert.equal(effortFor(model, 'high'), null, `${model} darf kein effort senden`);
        assert.equal(effortFor(model, 'max'), null, `${model} darf kein effort senden`);
        continue;
      }
      // low/medium/high gibt es auf jedem Modell, das effort überhaupt kennt.
      assert.equal(effortFor(model, 'low'), 'low', `${model} low`);
      assert.equal(effortFor(model, 'medium'), 'medium', `${model} medium`);
      assert.equal(effortFor(model, 'high'), 'high', `${model} high`);
      assert.equal(effortFor(model, 'max'), allowsMax ? 'max' : 'high', `${model} max`);
      assert.equal(effortFor(model, 'xhigh'), allowsXhigh ? 'xhigh' : 'high', `${model} xhigh`);
    }
    // Ungültige Werte werden still verworfen (kein 400 durch Tippfehler im Setting).
    assert.equal(effortFor('claude-opus-5', 'ultra'), null);
    assert.equal(effortFor('claude-opus-5', ''), null);
  } finally { teardown(); }
});

test('Tokenizer-Rate: moderne Generation konservativer als der globale Default', () => {
  const { cfg, teardown } = _bootstrap();
  try {
    // Der neue Tokenizer produziert mehr Tokens → weniger Zeichen pro Token. Ein zu
    // optimistischer Wert überschätzt die Single-Pass-/Chunk-Zeichenbudgets.
    assert.ok(cfg._claudeCharsPerToken('claude-opus-5') <= 2.5);
    assert.ok(cfg._claudeCharsPerToken('claude-sonnet-5') <= 2.5);
    assert.ok(cfg._claudeCharsPerToken('claude-opus-5') < cfg._claudeCharsPerToken('claude-sonnet-4-6'));
  } finally { teardown(); }
});
