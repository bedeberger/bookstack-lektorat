// Draht-Ebene des Tool-Modus von lib/ai/openai-compat.js: Request-Form,
// Akkumulation der `delta.tool_calls`, stopReason, Text-Rettung und die Erkennung
// „Endpunkt kann kein Function-Calling". Gegen einen lokalen Fake-Endpunkt — die
// SSE-Akkumulation ist genau die Stelle, an der ein Formatdetail die ganze
// agentische Runde still verschluckt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require_ = createRequire(import.meta.url);

const TOOLS = [
  { name: 'list_chapters', description: 'Kapitelliste', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'final_answer', description: 'Endpunkt', input_schema: { type: 'object', properties: { antwort: { type: 'string' } }, required: ['antwort'] } },
];

// Prompt bewusst lang: der Sicherheitsabbruch von openai-compat greift, wenn der
// geschätzte Output 4× den geschätzten Input übersteigt — bei Mini-Prompts löst das
// im Test aus und hätte nichts mit dem Testgegenstand zu tun.
const SYSTEM = 'Systemanweisung. '.repeat(60);

/** Fake-Endpunkt. `handler(body, res)` bestimmt die Antwort. Liefert { url, last, close }. */
async function fakeEndpoint(handler) {
  const state = { last: null };
  const srv = createServer((req, res) => {
    let buf = '';
    req.on('data', c => { buf += c; });
    req.on('end', () => {
      state.last = JSON.parse(buf || '{}');
      handler(state.last, res);
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, state, close: () => srv.close() };
}

function sse(res, events) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

function _bootstrap(host) {
  const dir = mkdtempSync(join(tmpdir(), 'oai-tools-'));
  process.env.DB_PATH = join(dir, 'test.db');
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test';
  for (const key of Object.keys(require_.cache)) {
    if (key.includes('/db/') || key.includes('/lib/')) delete require_.cache[key];
  }
  require_('../../db/connection');
  require_('../../db/migrations').runMigrations();
  const appSettings = require_('../../lib/app-settings');
  appSettings.set('ai.openai-compat.host', host, 'test@example.com');
  appSettings.set('ai.openai-compat.retry_max', 1, 'test@example.com');
  return {
    ai: require_('../../lib/ai'),
    teardown: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

test('Tool-Modus: Request trägt tools + tool_choice und KEIN response_format', async () => {
  const ep = await fakeEndpoint((body, res) => sse(res, [
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'abcdefghi', type: 'function', function: { name: 'list_chapters', arguments: '' } }] } }] },
    { choices: [{ index: 0, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 120, completion_tokens: 12 } },
  ]));
  const ctx = _bootstrap(ep.url);
  try {
    const r = await ctx.ai.callAIWithTools([{ role: 'user', content: 'Welche Kapitel gibt es?' }], SYSTEM, TOOLS, null, null, null, 'openai-compat');
    const body = ep.state.last;
    assert.equal(body.tools.length, 2);
    assert.deepEqual(body.tools[0], { type: 'function', function: { name: 'list_chapters', description: 'Kapitelliste', parameters: { type: 'object', properties: {}, required: [] } } });
    assert.equal(body.tool_choice, 'auto');
    // response_format:json_object würde das Modell in eine JSON-Antwort drängen,
    // statt ein Werkzeug zu rufen.
    assert.equal('response_format' in body, false);
    assert.equal(body.messages[0].role, 'system');
    assert.equal(r.stopReason, 'tool_use');
    assert.deepEqual(r.toolUses, [{ id: 'abcdefghi', name: 'list_chapters', input: {} }]);
    assert.equal(r.provider, 'openai-compat');
    assert.equal(r.tokensIn, 120);
  } finally { ctx.teardown(); ep.close(); }
});

test('Tool-Modus: Argumente werden über mehrere Deltas akkumuliert, zwei parallele Calls bleiben getrennt', async () => {
  const ep = await fakeEndpoint((body, res) => sse(res, [
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'aaaaaaaaa', function: { name: 'list_chapters', arguments: '{"li' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'mit":3}' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'bbbbbbbbb', function: { name: 'final_answer', arguments: '{"antwort":"ok"}' } }] } }] },
    { choices: [{ index: 0, finish_reason: 'stop' }] },
  ]));
  const ctx = _bootstrap(ep.url);
  try {
    const r = await ctx.ai.callAIWithTools([{ role: 'user', content: 'x' }], SYSTEM, TOOLS, null, null, null, 'openai-compat');
    assert.deepEqual(r.toolUses.map(t => [t.name, t.input]), [
      ['list_chapters', { limit: 3 }],
      ['final_answer', { antwort: 'ok' }],
    ]);
    // finish_reason='stop' trotz tool_calls ist verbreitet — der stopReason folgt
    // dem Inhalt, sonst bricht der Loop die Recherche nach Runde 1 ab.
    assert.equal(r.stopReason, 'tool_use');
  } finally { ctx.teardown(); ep.close(); }
});

test('Tool-Modus: Prosa-Abschluss bleibt Prosa (stopReason end_turn)', async () => {
  const ep = await fakeEndpoint((body, res) => sse(res, [
    { choices: [{ index: 0, delta: { content: 'Anna ist 34 Jahre alt.' } }] },
    { choices: [{ index: 0, finish_reason: 'stop' }] },
  ]));
  const ctx = _bootstrap(ep.url);
  try {
    const r = await ctx.ai.callAIWithTools([{ role: 'user', content: 'x' }], SYSTEM, TOOLS, null, null, null, 'openai-compat');
    assert.equal(r.stopReason, 'end_turn');
    assert.equal(r.toolUses.length, 0);
    assert.equal(r.text, 'Anna ist 34 Jahre alt.');
  } finally { ctx.teardown(); ep.close(); }
});

test('Tool-Modus: als Text geschriebener Aufruf wird zum Tool-Use gerettet', async () => {
  const ep = await fakeEndpoint((body, res) => sse(res, [
    { choices: [{ index: 0, delta: { content: '[TOOL_CALLS] [{"name": "list_chapters", "arguments": {}}]' } }] },
    { choices: [{ index: 0, finish_reason: 'stop' }] },
  ]));
  const ctx = _bootstrap(ep.url);
  try {
    const r = await ctx.ai.callAIWithTools([{ role: 'user', content: 'x' }], SYSTEM, TOOLS, null, null, null, 'openai-compat');
    assert.equal(r.stopReason, 'tool_use');
    assert.equal(r.toolUses[0].name, 'list_chapters');
    // Der gerettete Aufruf darf nicht zusätzlich als Antworttext stehenbleiben.
    assert.equal(r.text, '');
  } finally { ctx.teardown(); ep.close(); }
});

test('Tool-Modus: Endpunkt ohne Function-Calling meldet AI_TOOLS_UNSUPPORTED', async () => {
  const ep = await fakeEndpoint((body, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'tools are not supported for this model' } }));
  });
  const ctx = _bootstrap(ep.url);
  try {
    await assert.rejects(
      () => ctx.ai.callAIWithTools([{ role: 'user', content: 'x' }], SYSTEM, TOOLS, null, null, null, 'openai-compat'),
      (e) => e.code === 'AI_TOOLS_UNSUPPORTED',
    );
  } finally { ctx.teardown(); ep.close(); }
});

test('Tool-Modus: anderer 400er bleibt ein normaler Fehler (kein falscher Rückfall)', async () => {
  const ep = await fakeEndpoint((body, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'context length exceeded' } }));
  });
  const ctx = _bootstrap(ep.url);
  try {
    await assert.rejects(
      () => ctx.ai.callAIWithTools([{ role: 'user', content: 'x' }], SYSTEM, TOOLS, null, null, null, 'openai-compat'),
      (e) => e.code !== 'AI_TOOLS_UNSUPPORTED' && /400/.test(e.message),
    );
  } finally { ctx.teardown(); ep.close(); }
});

test('Tool-Modus: Folge-Runde schickt tool_result als role:tool zurück', async () => {
  const ep = await fakeEndpoint((body, res) => sse(res, [
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'ccccccccc', function: { name: 'final_answer', arguments: '{"antwort":"fertig"}' } }] } }] },
    { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
  ]));
  const ctx = _bootstrap(ep.url);
  try {
    const messages = [
      { role: 'user', content: 'Welche Kapitel?' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'aaaaaaaaa', name: 'list_chapters', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'aaaaaaaaa', content: '{"chapters":[]}' }] },
    ];
    await ctx.ai.callAIWithTools(messages, SYSTEM, TOOLS, null, null, null, 'openai-compat');
    const sent = ep.state.last.messages;
    assert.equal(sent[2].role, 'assistant');
    assert.equal(sent[2].tool_calls[0].id, 'aaaaaaaaa');
    assert.deepEqual(sent[3], { role: 'tool', tool_call_id: 'aaaaaaaaa', content: '{"chapters":[]}' });
  } finally { ctx.teardown(); ep.close(); }
});
