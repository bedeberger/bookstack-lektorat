'use strict';
// Unit-Tests für lib/ai.js – nur reine Logik (extractBalancedJson, parseJSON).
// Lauf: `node --test tests/unit/`

const test = require('node:test');
const assert = require('node:assert/strict');

// parseJSON schreibt bei Misserfolg in ai_parse_fails/. Damit Tests nichts anlegen,
// setzen wir SESSION_SECRET + eine dummy API-Key – lib/ai.js hängt daran nicht, nur
// Sub-Module, aber so bleibt das Setup identisch zum Prod-Boot.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

const { parseJSON, _claudeAcceptsTemperature, _claudeUsesAdaptiveThinking, _claudeAcceptsEffort } = require('../../lib/ai');

// Opus 4.7+ haben temperature/top_p/top_k entfernt → 400 bei Verwendung.
// _callClaude muss temperature für diese Modelle weglassen, für ältere senden.
test('_claudeAcceptsTemperature: Opus 4.7+ lehnt ab, Sonnet/Opus 4.6 akzeptieren', () => {
  for (const m of ['claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-opus-4-6', 'claude-opus-4-5', 'claude-opus-4-1', 'claude-haiku-4-5', '']) {
    assert.equal(_claudeAcceptsTemperature(m), true, `${m} sollte temperature akzeptieren`);
  }
  // Moderne Generation lehnt Sampling-Parameter ab — inkl. Sonnet 5 und Fable/Mythos 5
  // (frühere reine Opus-4.7+-Regex hätte diese mit temperature bestückt → 400).
  for (const m of ['claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-4-8[1m]', 'claude-opus-4-9', 'claude-opus-4-10',
    'claude-sonnet-5', 'claude-sonnet-5-20260101', 'claude-fable-5', 'claude-mythos-5']) {
    assert.equal(_claudeAcceptsTemperature(m), false, `${m} sollte temperature ablehnen`);
  }
});

// Opus 4.7+ schreiben bei deaktiviertem Thinking Reasoning-Prosa in den sichtbaren
// Output → bläht JSON-Only-Antworten bis zum Truncation-Wurf. _callClaude muss daher
// für diese Modelle adaptive Thinking senden, für Sonnet 4.6 / Opus 4.6 / ältere nicht.
test('_claudeUsesAdaptiveThinking: moderne Generation (Opus 4.7+/Sonnet 5+/Fable 5+), sonst nicht', () => {
  for (const m of ['claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-4-8[1m]', 'claude-opus-4-9', 'claude-opus-4-10',
    'claude-sonnet-5', 'claude-fable-5', 'claude-mythos-5']) {
    assert.equal(_claudeUsesAdaptiveThinking(m), true, `${m} sollte adaptive Thinking nutzen`);
  }
  for (const m of ['claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-opus-4-6', 'claude-opus-4-5', 'claude-opus-4-1', 'claude-haiku-4-5', '']) {
    assert.equal(_claudeUsesAdaptiveThinking(m), false, `${m} sollte kein thinking-Feld senden`);
  }
});

// Structured Outputs (output_config.format) — Allowlist unterstützter Modelle. Prod-Modell
// Sonnet 4.6 ist NICHT gelistet → dort kein format senden (sonst 400). Komplett-Ziel Opus 4.8
// (+ Sonnet 5, Fable, Haiku 4.5, Legacy Opus 4.5/4.1) ist gelistet.
test('_claudeSupportsStructuredOutputs: Allowlist deckt Opus 4.7+/Sonnet 5/Fable/Haiku 4.5/Legacy-Opus', () => {
  const { _claudeSupportsStructuredOutputs } = require('../../lib/ai');
  for (const m of ['claude-opus-4-8', 'claude-opus-4-8[1m]', 'claude-opus-4-7', 'claude-sonnet-5',
    'claude-fable-5', 'claude-mythos-5', 'claude-haiku-4-5', 'claude-opus-4-5', 'claude-opus-4-1']) {
    assert.equal(_claudeSupportsStructuredOutputs(m), true, `${m} sollte Structured Outputs unterstützen`);
  }
  for (const m of ['claude-sonnet-4-6', 'claude-sonnet-4-5', '']) {
    assert.equal(_claudeSupportsStructuredOutputs(m), false, `${m} sollte KEINE Structured Outputs bekommen`);
  }
});

// Model-aware Tokenizer-Rate: moderne Generation rechnet konservativer (≤2.5), damit das
// Char-Budget nicht überschätzt wird; ältere Modelle behalten den globalen CHARS_PER_TOKEN.
test('_claudeCharsPerToken: moderne Generation ≤ 2.5, ältere = globaler Wert', () => {
  const { _claudeCharsPerToken, CHARS_PER_TOKEN } = require('../../lib/ai');
  for (const m of ['claude-opus-4-8', 'claude-sonnet-5', 'claude-fable-5']) {
    assert.ok(_claudeCharsPerToken(m) <= 2.5, `${m} sollte ≤2.5 chars/token rechnen`);
  }
  for (const m of ['claude-sonnet-4-6', 'claude-opus-4-6', '']) {
    assert.equal(_claudeCharsPerToken(m), CHARS_PER_TOKEN,
      `${m} sollte den globalen CHARS_PER_TOKEN behalten`);
  }
});

// effort (output_config) ist auf Opus 4.5+ und Sonnet 4.6 verfügbar; Sonnet 4.5 /
// Haiku 4.5 / leeres Modell lehnen ab (400). _claudeOutputConfigParams sendet effort
// nur, wenn das Modell es akzeptiert (sonst stille Auslassung statt 400).
test('_claudeAcceptsEffort: Opus 4.5+ und Sonnet 4.6 akzeptieren, Sonnet 4.5/Haiku/leer nicht', () => {
  for (const m of ['claude-opus-4-5', 'claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-4-8[1m]', 'claude-sonnet-4-6']) {
    assert.equal(_claudeAcceptsEffort(m), true, `${m} sollte effort akzeptieren`);
  }
  for (const m of ['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-4-1', '']) {
    assert.equal(_claudeAcceptsEffort(m), false, `${m} sollte effort ablehnen`);
  }
});

// Per-Job-Override (ALS) für Kontextfenster/Output-Cap: getContextConfigFor('claude')
// muss claudeContextWindow/claudeMaxTokensOut aus dem ALS-Store bevorzugen, andere
// Provider unberührt lassen. So fährt die Komplettanalyse auf Opus mit eigenem Cap,
// ohne globale (Sonnet-)Calls zu beeinflussen.
test('getContextConfigFor(claude): ALS-Override schlägt globalen Wert', () => {
  const { getContextConfigFor } = require('../../lib/ai');
  const { runWithContext } = require('../../lib/log-context');
  // Ohne Override: Default-Pfad (kein Throw, sinnvolle Werte).
  const base = getContextConfigFor('claude');
  assert.ok(base.maxTokensOut > 0 && base.contextWindow > 0);
  // Mit Override: contextWindow/maxTokensOut werden übernommen, inputBudget folgt.
  runWithContext({ claudeContextWindow: 1000000, claudeMaxTokensOut: 128000 }, () => {
    const cfg = getContextConfigFor('claude');
    assert.equal(cfg.contextWindow, 1000000);
    assert.equal(cfg.maxTokensOut, 128000);
    // Sicherheitspuffer ist proportional (3 % des Fensters, min. 2000) — bei 1M also 30000.
    assert.equal(cfg.safetyMargin, 30000);
    assert.equal(cfg.inputBudgetTokens, 1000000 - 128000 - 30000);
    // Andere Provider ignorieren den Claude-Override.
    const oll = getContextConfigFor('ollama');
    assert.notEqual(oll.maxTokensOut, 128000);
  });
});

// extractBalancedJson ist nicht direkt exportiert – wir testen es indirekt
// über parseJSON mit Trailing-Content, das nur gematcht werden kann, wenn die
// balancierte Extraktion korrekt stackt.

test('parseJSON: direktes JSON', () => {
  assert.deepEqual(parseJSON('{"a":1}'), { a: 1 });
});

test('parseJSON: mit ```json Code-Fence', () => {
  assert.deepEqual(parseJSON('```json\n{"a":1}\n```'), { a: 1 });
});

test('parseJSON: Trailing-Kommentar nach JSON', () => {
  // Das Modell hängt oft Erklärungen nach dem JSON an – balancedJson muss greifen.
  assert.deepEqual(
    parseJSON('{"a":1}\n\nDas war die Antwort.'),
    { a: 1 },
  );
});

test('parseJSON: trailing comma (via jsonrepair)', () => {
  assert.deepEqual(parseJSON('{"a":1,}'), { a: 1 });
});

test('parseJSON: verschachtelte Strukturen mit Trailing-Content', () => {
  const input = '{"fehler":[{"typ":"stil","text":"x"}]}\n\nHinweis: Ich habe geprüft.';
  assert.deepEqual(parseJSON(input), { fehler: [{ typ: 'stil', text: 'x' }] });
});

test('parseJSON: Strings mit Klammern stören nicht', () => {
  assert.deepEqual(
    parseJSON('{"a":"text mit { und [ innen","b":2}'),
    { a: 'text mit { und [ innen', b: 2 },
  );
});

test('parseJSON: escapete Quotes in Strings', () => {
  assert.deepEqual(
    parseJSON('{"a":"er sagte \\"hallo\\""}'),
    { a: 'er sagte "hallo"' },
  );
});

test('parseJSON: unescaptes Dialog-Quote vor Prosa-Komma (DE „Ada", bis …)', () => {
  // Modell schreibt Dialog mit ASCII-`"` mitten in Prosa-Wert; das `"` steht
  // direkt vor einem Prosa-Komma. Heuristik darf das NICHT als String-Terminator
  // werten (nach echtem `",` folgt immer `"`/`}`/`]`/EOF, nie ein Wort).
  const input = '{"beschreibung":"Sie besteht auf „Ada", bis sie merkt, dass die Frau „Ida" heisst.","ok":true}';
  assert.deepEqual(parseJSON(input), {
    beschreibung: 'Sie besteht auf „Ada", bis sie merkt, dass die Frau „Ida" heisst.',
    ok: true,
  });
});

test('parseJSON: unescaptes Quote vor Wort (kein Komma) wird escaped', () => {
  const input = '{"a":"er sagte "hallo" laut","b":2}';
  assert.deepEqual(parseJSON(input), { a: 'er sagte "hallo" laut', b: 2 });
});

test('parseJSON: Typ-Mismatch `{"a":[}` wird nicht fälschlich aus Trailing-Mülltext erweitert', () => {
  // Früher zählte die Extraktion `{` und `[` in denselben depth-Counter; ein defekter
  // Input wie `{"a":[}` wurde "balanciert" erkannt und dann durch jsonrepair geflickt
  // – aber ein harmloses `{` im Nachtext hätte die Grenze verfälschen können.
  // Heute erkennt der Typ-sensitive Stack das als ungültig und fällt auf jsonrepair zurück.
  const result = parseJSON('{"a":[}');
  assert.deepEqual(result, { a: [] }); // jsonrepair-Fallback, nicht "balanciertes" Missverständnis
});

test('parseJSON: reiner Klartext → jsonrepair liefert String (dokumentiertes Verhalten)', () => {
  // Dokumentiert, dass die bestehende Fallback-Kette sehr permissiv ist.
  // Caller müssen anschliessend strukturell prüfen (z.B. `if (!Array.isArray(result.fehler))`).
  assert.equal(parseJSON('das ist kein JSON'), 'das ist kein JSON');
});

// ── Retry-Verhalten bei transient `overloaded_error` ──────────────────────────
// Claude liefert gelegentlich 503 mit `{"error":{"type":"overloaded_error", ...}}`
// (z. B. "API key validation is temporarily unavailable"). Status 503 ist nicht
// im hard-coded RETRY_STATUS-Set, deshalb wird die Erkennung body-basiert gemacht.
test('callAI: retried bei 503 + overloaded_error im Body und gibt finalen Text zurück', async () => {
  // fetch mocken: zuerst 503-Overloaded, dann SSE-Erfolg.
  const origFetch = globalThis.fetch;
  process.env.API_PROVIDER = 'claude';
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  process.env.CLAUDE_RETRY_MAX = '3';

  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) {
      return new Response(
        JSON.stringify({
          type: 'error',
          error: { type: 'overloaded_error', message: 'API key validation is temporarily unavailable. Please retry.' },
        }),
        { status: 503, statusText: 'Service Unavailable', headers: { 'content-type': 'application/json' } },
      );
    }
    // Minimaler SSE-Erfolgsstream.
    const sse = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"{\\"ok\\":1}"}}',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
      'data: [DONE]',
      '',
    ].join('\n');
    return new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };

  try {
    // Lazy-require, damit env-Vars vor dem ersten require gesetzt sind.
    delete require.cache[require.resolve('../../lib/ai')];
    const { callAI } = require('../../lib/ai');
    const res = await callAI('hi', 'sys', null, 100, null, 'claude');
    assert.equal(res.text, '{"ok":1}');
    assert.equal(calls, 2, 'sollte einmal retryen');
  } finally {
    globalThis.fetch = origFetch;
    delete require.cache[require.resolve('../../lib/ai')];
  }
});

