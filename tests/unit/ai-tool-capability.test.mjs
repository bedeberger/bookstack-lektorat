// Werkzeug-Fähigkeit pro Provider: `providerSupportsTools` ist die SSoT, die BEIDE
// Seiten lesen — die Pfadwahl des agentischen Buch-Chats und der Dispatch in
// lib/ai/core.js. Fragen die zwei verschieden, wählt der Job den agentischen Pfad und
// der erste Call wirft.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require_ = createRequire(import.meta.url);

function _bootstrap() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-tools-'));
  process.env.DB_PATH = join(dir, 'test.db');
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test';
  for (const key of Object.keys(require_.cache)) {
    if (key.includes('/db/') || key.includes('/lib/')) delete require_.cache[key];
  }
  require_('../../db/connection');
  require_('../../db/migrations').runMigrations();
  return {
    dir,
    appSettings: require_('../../lib/app-settings'),
    ai: require_('../../lib/ai'),
    teardown: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

test('providerSupportsTools: claude ja, openai-compat per Default ja, ollama nein', () => {
  const ctx = _bootstrap();
  try {
    assert.equal(ctx.ai.providerSupportsTools('claude'), true);
    assert.equal(ctx.ai.providerSupportsTools('openai-compat'), true);
    assert.equal(ctx.ai.providerSupportsTools('ollama'), false);
  } finally { ctx.teardown(); }
});

test('providerSupportsTools: ai.openai-compat.tools=false schaltet die Fähigkeit ab', () => {
  const ctx = _bootstrap();
  try {
    ctx.appSettings.set('ai.openai-compat.tools', false, 'test@example.com');
    assert.equal(ctx.ai.providerSupportsTools('openai-compat'), false);
    assert.equal(ctx.ai.providerSupportsTools('claude'), true, 'Claude bleibt unberührt');
  } finally { ctx.teardown(); }
});

test('callAIWithTools: Provider ohne Werkzeuge wirft AI_TOOLS_UNSUPPORTED (Fallback-Signal)', async () => {
  const ctx = _bootstrap();
  try {
    // Der Code IST der Vertrag: routes/jobs/agentic-chat.js schaltet daran auf den
    // klassischen Buch-Chat um, statt den Job zu verlieren.
    await assert.rejects(
      () => ctx.ai.callAIWithTools([{ role: 'user', content: 'hi' }], 'sys', [], null, null, null, 'ollama'),
      (e) => e.code === 'AI_TOOLS_UNSUPPORTED',
    );
  } finally { ctx.teardown(); }
});

test('callAIWithTools: abgeschaltetes openai-compat wirft denselben Code (kein stiller Netz-Call)', async () => {
  const ctx = _bootstrap();
  try {
    ctx.appSettings.set('ai.openai-compat.tools', false, 'test@example.com');
    await assert.rejects(
      () => ctx.ai.callAIWithTools([{ role: 'user', content: 'hi' }], 'sys', [], null, null, null, 'openai-compat'),
      (e) => e.code === 'AI_TOOLS_UNSUPPORTED',
    );
  } finally { ctx.teardown(); }
});
