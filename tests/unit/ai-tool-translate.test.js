'use strict';
// Unit-Tests für lib/ai/tool-translate.js — die Übersetzung zwischen der kanonischen
// Tool-Use-Form der App (Anthropic) und OpenAI-Function-Calling. Reine Funktionen,
// kein Netz, keine DB.
// Dazu ein Drift-Gate auf den Slim-Werkzeugsatz des Buch-Chats.
// Lauf: `node --test tests/unit/ai-tool-translate.test.js`

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

const {
  toolsToOpenAI, messagesToOpenAI, toolCallsToCanonical, salvageTextToolCalls,
} = require('../../lib/ai/tool-translate');

test('toolsToOpenAI: input_schema wird parameters, Form bleibt OpenAI-konform', () => {
  const out = toolsToOpenAI([
    { name: 'list_chapters', description: 'Kapitelliste', input_schema: { type: 'object', properties: {}, required: [] } },
    { name: 'ohne_schema' },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], {
    type: 'function',
    function: { name: 'list_chapters', description: 'Kapitelliste', parameters: { type: 'object', properties: {}, required: [] } },
  });
  // Ohne input_schema trotzdem ein gültiges leeres Objekt-Schema (nicht undefined):
  // ein fehlendes `parameters` lehnen manche Endpunkte mit 400 ab.
  assert.deepEqual(out[1].function.parameters, { type: 'object', properties: {}, required: [] });
  assert.equal('description' in out[1].function, false);
});

test('messagesToOpenAI: String-Turns unverändert, tool_use → tool_calls, tool_result → role:tool', () => {
  const out = messagesToOpenAI([
    { role: 'user', content: 'Wie alt ist Anna?' },
    { role: 'assistant', content: [
      { type: 'text', text: 'Ich schaue nach.' },
      { type: 'tool_use', id: 'abc123456', name: 'search_passages', input: { pattern: 'Anna' } },
      { type: 'tool_use', id: 'def123456', name: 'list_figures', input: {} },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'abc123456', content: '{"hits":[]}' },
      { type: 'tool_result', tool_use_id: 'def123456', content: '{"figuren":[]}' },
    ] },
  ]);
  assert.deepEqual(out[0], { role: 'user', content: 'Wie alt ist Anna?' });
  assert.equal(out[1].role, 'assistant');
  assert.equal(out[1].content, 'Ich schaue nach.');
  assert.equal(out[1].tool_calls.length, 2);
  assert.deepEqual(out[1].tool_calls[0], {
    id: 'abc123456', type: 'function',
    function: { name: 'search_passages', arguments: '{"pattern":"Anna"}' },
  });
  // Jedes tool_result ist eine EIGENE Nachricht mit tool_call_id — ohne die
  // Zuordnung verliert der Endpunkt den Bezug Aufruf↔Ergebnis.
  assert.deepEqual(out[2], { role: 'tool', tool_call_id: 'abc123456', content: '{"hits":[]}' });
  assert.deepEqual(out[3], { role: 'tool', tool_call_id: 'def123456', content: '{"figuren":[]}' });
  assert.equal(out.length, 4);
});

test('messagesToOpenAI: assistant ohne tool_use trägt kein tool_calls-Feld', () => {
  const out = messagesToOpenAI([{ role: 'assistant', content: [{ type: 'text', text: 'Nur Prosa.' }] }]);
  assert.deepEqual(out, [{ role: 'assistant', content: 'Nur Prosa.' }]);
});

test('messagesToOpenAI: Anthropic-Eigenheiten (thinking/server_tool_use) fallen weg', () => {
  const out = messagesToOpenAI([{ role: 'assistant', content: [
    { type: 'thinking', thinking: 'geheim', signature: 'sig' },
    { type: 'text', text: 'sichtbar' },
  ] }]);
  assert.deepEqual(out, [{ role: 'assistant', content: 'sichtbar' }]);
});

test('toolCallsToCanonical: Argument-JSON wird geparst, Text bleibt eigener Block', () => {
  const { toolUses, rawContentBlocks } = toolCallsToCanonical('Moment.', [
    { id: 'tc1', name: 'get_pages', arguments: '{"page_ids":[3,4]}' },
  ]);
  assert.deepEqual(toolUses, [{ id: 'tc1', name: 'get_pages', input: { page_ids: [3, 4] } }]);
  assert.deepEqual(rawContentBlocks[0], { type: 'text', text: 'Moment.' });
  assert.equal(rawContentBlocks[1].type, 'tool_use');
});

test('toolCallsToCanonical: kaputtes Argument-JSON gibt leeren Input + parseError statt zu werfen', () => {
  const { toolUses } = toolCallsToCanonical('', [{ id: 'tc1', name: 'get_pages', arguments: '{"page_ids":[3,' }]);
  assert.deepEqual(toolUses[0].input, {});
  assert.ok(toolUses[0].parseError, 'parseError als Spur erwartet');
});

test('toolCallsToCanonical: fehlende ID bekommt eine 9-stellige Ersatz-ID (Mistral-Vorgabe)', () => {
  const { toolUses } = toolCallsToCanonical('', [{ name: 'list_figures', arguments: '' }]);
  assert.equal(toolUses[0].id.length, 9);
  assert.match(toolUses[0].id, /^[A-Za-z0-9]+$/);
});

test('salvageTextToolCalls: als Text geschriebener Aufruf wird gerettet', () => {
  const names = ['search_passages', 'final_answer'];
  const got = salvageTextToolCalls('[TOOL_CALLS] [{"name": "search_passages", "arguments": {"pattern": "Anna"}}]', names);
  assert.ok(got, 'Rettung erwartet');
  assert.deepEqual(got.toolUses, [{ id: got.toolUses[0].id, name: 'search_passages', input: { pattern: 'Anna' } }]);
  // Der Text IST der Aufruf — er darf nicht zusätzlich als Textblock mitreisen,
  // sonst steht das JSON-Fragment später in der Antwort.
  assert.equal(got.rawContentBlocks.some(b => b.type === 'text'), false);
});

test('salvageTextToolCalls: Code-Fence-Variante und `parameters` statt `arguments`', () => {
  const got = salvageTextToolCalls('```json\n{"name":"get_pages","parameters":{"page_ids":[7]}}\n```', ['get_pages']);
  assert.ok(got);
  assert.deepEqual(got.toolUses[0].input, { page_ids: [7] });
});

test('salvageTextToolCalls: echte Antworten bleiben Antworten', () => {
  // final_answer-Envelope: kein `name` → kein Aufruf.
  assert.equal(salvageTextToolCalls('{"antwort":"Anna ist 34."}', ['final_answer']), null);
  // Prosa.
  assert.equal(salvageTextToolCalls('Anna ist 34 Jahre alt.', ['final_answer']), null);
  // Unbekannter Werkzeugname → nicht raten.
  assert.equal(salvageTextToolCalls('{"name":"rm_rf","arguments":{}}', ['final_answer']), null);
  assert.equal(salvageTextToolCalls('', ['final_answer']), null);
});

test('Round-Trip: eine Tool-Runde übersteht Kanonisch → OpenAI → Kanonisch', () => {
  const { rawContentBlocks } = toolCallsToCanonical('', [
    { id: 'aaaaaaaaa', name: 'quote_match', arguments: '{"page_id":5,"pattern":"Anna"}' },
  ]);
  const openai = messagesToOpenAI([{ role: 'assistant', content: rawContentBlocks }]);
  const back = toolCallsToCanonical('', openai[0].tool_calls.map(tc => ({
    id: tc.id, name: tc.function.name, arguments: tc.function.arguments,
  })));
  assert.deepEqual(back.toolUses, [{ id: 'aaaaaaaaa', name: 'quote_match', input: { page_id: 5, pattern: 'Anna' } }]);
});

test('Slim-Werkzeugsatz: alle Namen existieren, final_answer ist dabei, Satz bleibt klein', async () => {
  const { BOOK_CHAT_TOOLS, BOOK_CHAT_SLIM_TOOL_NAMES } = await import('../../public/js/prompts/book-chat-tools.js');
  const all = new Set(BOOK_CHAT_TOOLS.map(t => t.name));
  for (const n of BOOK_CHAT_SLIM_TOOL_NAMES) {
    assert.ok(all.has(n), `Slim-Name «${n}» hat keine Definition in BOOK_CHAT_TOOLS`);
  }
  // Pflicht-Endpunkt: ohne final_answer kann der Loop nicht terminieren.
  assert.ok(BOOK_CHAT_SLIM_TOOL_NAMES.includes('final_answer'));
  // Sinn des Satzes ist die Ersparnis — wird er so gross wie der volle Katalog,
  // ist er keine Slim-Variante mehr.
  assert.ok(BOOK_CHAT_SLIM_TOOL_NAMES.length < BOOK_CHAT_TOOLS.length / 2,
    `Slim-Satz zu gross (${BOOK_CHAT_SLIM_TOOL_NAMES.length}/${BOOK_CHAT_TOOLS.length})`);
});
