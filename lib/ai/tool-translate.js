'use strict';
// Übersetzung zwischen dem KANONISCHEN Tool-Use-Format der App (Anthropic-Form:
// `tools[{name, description, input_schema}]`, Content-Blöcke `tool_use`/`tool_result`)
// und dem OpenAI-Function-Calling-Format (`tools[{type:'function', function:{…}}]`,
// `assistant.tool_calls[]` + `role:'tool'`-Nachrichten).
//
// Why hier und nicht im Loop: der agentische Chat-Loop (routes/jobs/agentic-chat.js)
// spricht EINE Sprache — die Anthropic-Form. Jeder Provider übersetzt selbst in sein
// Wire-Format und liefert sein Ergebnis wieder in der kanonischen Form zurück
// (`toolUses` + `rawContentBlocks`), damit der Loop provider-neutral bleibt. Ohne diese
// Schicht müsste der Loop zwei Message-Formate parallel führen — und die
// Wiedervorlage (`messages.push({role:'assistant', content: rawContentBlocks})`) wäre
// pro Provider anders.
//
// Reine Funktionen, keine Netz-/DB-Zugriffe (Test: tests/unit/ai-tool-translate.test.js).

// Mistral-Modelle validieren `tool_call_id` auf genau 9 alphanumerische Zeichen.
// Server-gelieferte IDs werden VERBATIM durchgereicht (nur die zählen für den
// Round-Trip); die Ersatz-ID greift nur, wenn ein Endpunkt gar keine liefert.
const FALLBACK_ID_LEN = 9;
function _fallbackToolCallId(idx) {
  return `tc${idx}${'0'.repeat(FALLBACK_ID_LEN)}`.slice(0, FALLBACK_ID_LEN);
}

/** Anthropic-Tool-Definitionen → OpenAI-`tools`. `input_schema` heisst dort `parameters`. */
function toolsToOpenAI(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      parameters: t.input_schema || { type: 'object', properties: {}, required: [] },
    },
  }));
}

/** Ein Content-Block-Array (assistant-Turn) → { text, toolCalls } in OpenAI-Form. */
function _assistantBlocksToOpenAI(blocks) {
  let text = '';
  const toolCalls = [];
  for (const b of blocks) {
    if (!b) continue;
    if (b.type === 'text') text += b.text || '';
    else if (b.type === 'tool_use') {
      toolCalls.push({
        id: b.id || _fallbackToolCallId(toolCalls.length),
        type: 'function',
        function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
      });
    }
    // thinking / redacted_thinking / server_tool_use / web_search_tool_result sind
    // Anthropic-Eigenheiten und entstehen auf diesem Pfad nicht — bewusst verworfen.
  }
  return { text, toolCalls };
}

/**
 * Kanonisches Messages-Array → OpenAI-`messages`.
 *   { role:'user', content:'…' }                          → unverändert
 *   { role:'assistant', content:[…tool_use…] }            → assistant + tool_calls[]
 *   { role:'user', content:[…tool_result…] }              → je Block eine role:'tool'-Nachricht
 * Ein `tool_result` MUSS als eigene Nachricht mit `tool_call_id` folgen, sonst
 * verliert der Endpunkt die Zuordnung Aufruf↔Ergebnis.
 */
function messagesToOpenAI(messages) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m) continue;
    if (typeof m.content === 'string' || m.content == null) {
      out.push({ role: m.role, content: m.content ?? '' });
      continue;
    }
    const blocks = Array.isArray(m.content) ? m.content : [m.content];
    if (m.role === 'assistant') {
      const { text, toolCalls } = _assistantBlocksToOpenAI(blocks);
      const msg = { role: 'assistant', content: text };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
      continue;
    }
    // user-Turn: entweder tool_results (→ role:'tool') oder Textblöcke.
    const results = blocks.filter(b => b && b.type === 'tool_result');
    if (results.length) {
      for (const r of results) {
        const content = typeof r.content === 'string' ? r.content : JSON.stringify(r.content ?? '');
        out.push({ role: 'tool', tool_call_id: r.tool_use_id, content });
      }
      continue;
    }
    const text = blocks.map(b => (b && typeof b.text === 'string' ? b.text : '')).join('');
    out.push({ role: m.role, content: text });
  }
  return out;
}

/** Ein akkumulierter OpenAI-tool_call → kanonischer `tool_use`-Block (+ parseError-Spur). */
function _toolCallToBlock(tc, idx) {
  const block = {
    type: 'tool_use',
    id: tc.id || _fallbackToolCallId(idx),
    name: tc.name || '',
    input: {},
  };
  const raw = typeof tc.arguments === 'string' ? tc.arguments.trim() : '';
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      block.input = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    } catch (e) {
      // Kaputtes Argument-JSON ist kein Abbruchgrund: das Tool läuft mit leerem
      // Input, meldet seinen Fehler als tool_result und das Modell korrigiert in
      // der nächsten Runde. Gleiche Haltung wie lib/ai/claude.js.
      block.parseError = e.message;
    }
  }
  return block;
}

/**
 * Provider-Antwort (Text + akkumulierte tool_calls) → kanonisches Ergebnis-Paar.
 * `toolCalls` = [{ id, name, arguments (JSON-String) }] in Auftrittsreihenfolge.
 */
function toolCallsToCanonical(text, toolCalls) {
  const blocks = [];
  if (text) blocks.push({ type: 'text', text });
  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  for (let i = 0; i < calls.length; i++) blocks.push(_toolCallToBlock(calls[i], i));
  const toolUses = blocks.filter(b => b.type === 'tool_use').map(b => ({
    id: b.id, name: b.name, input: b.input, ...(b.parseError ? { parseError: b.parseError } : {}),
  }));
  return { toolUses, rawContentBlocks: blocks };
}

// Ein Modell, dessen Chat-Vorlage das Tool-Protokoll nicht (oder nur halb) umsetzt,
// schreibt den Aufruf als TEXT statt als tool_calls — Mistral z.B. als
// `[TOOL_CALLS][{"name":…,"arguments":{…}}]`. Ohne Rettung wäre dieser Text die
// „Antwort" des Agenten: ein JSON-Fragment im Chatfenster statt einer Recherche.
const TEXT_TOOL_CALL_PREFIX = /^\s*(?:\[TOOL_CALLS\]|<tool_call>|<\|python_tag\|>)\s*/i;
function _stripFences(s) {
  return s.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
}

/**
 * Versuch, im reinen Text emittierte Tool-Aufrufe zu retten. Greift nur, wenn der
 * Text SICHER ein Aufruf ist: geparstes JSON mit `name` aus dem angebotenen
 * Werkzeugsatz. Liefert sonst null — dann ist der Text die Antwort (Prosa-Abschluss
 * ist im Loop ein legitimer Endzustand).
 */
function salvageTextToolCalls(text, knownNames) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const names = knownNames instanceof Set ? knownNames : new Set(knownNames || []);
  let body = _stripFences(text.replace(TEXT_TOOL_CALL_PREFIX, '').replace(/<\/tool_call>\s*$/i, '').trim());
  if (!(body.startsWith('{') || body.startsWith('['))) return null;
  let parsed;
  try { parsed = JSON.parse(body); } catch { return null; }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const calls = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') return null;
    const name = typeof it.name === 'string' ? it.name : (typeof it.function?.name === 'string' ? it.function.name : null);
    if (!name || (names.size && !names.has(name))) return null;
    const args = it.arguments ?? it.parameters ?? it.input ?? it.function?.arguments ?? {};
    calls.push({
      id: typeof it.id === 'string' ? it.id : _fallbackToolCallId(calls.length),
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
    });
  }
  if (!calls.length) return null;
  // Text NICHT als Block mitschicken: er IST der Aufruf, kein Begleittext.
  return toolCallsToCanonical('', calls);
}

module.exports = {
  toolsToOpenAI, messagesToOpenAI, toolCallsToCanonical, salvageTextToolCalls,
  _fallbackToolCallId,
};
