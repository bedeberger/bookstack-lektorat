// resolveProvider Reihenfolge — User-Override > Global > Default.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require_ = createRequire(import.meta.url);

function _bootstrap() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-resolve-'));
  process.env.DB_PATH = join(dir, 'test.db');
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test';
  for (const key of Object.keys(require_.cache)) {
    if (key.includes('/db/') || key.includes('/lib/')) delete require_.cache[key];
  }
  require_('../../db/connection');
  require_('../../db/migrations').runMigrations();
  return {
    dir,
    appUsers: require_('../../db/app-users'),
    appSettings: require_('../../lib/app-settings'),
    ai: require_('../../lib/ai'),
    teardown: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

test('resolveProvider: Default = claude bei leerer DB', () => {
  const ctx = _bootstrap();
  try {
    assert.equal(ctx.ai.resolveProvider({ userEmail: 'nobody@example.com' }), 'claude');
  } finally { ctx.teardown(); }
});

test('resolveProvider: global ai.provider greift wenn kein Override', () => {
  const ctx = _bootstrap();
  try {
    ctx.appSettings.set('ai.provider', 'ollama');
    ctx.appUsers.createUser({ email: 'u@example.com' });
    assert.equal(ctx.ai.resolveProvider({ userEmail: 'u@example.com' }), 'ollama');
  } finally { ctx.teardown(); }
});

test('resolveProvider: Override gewinnt ueber Global', () => {
  const ctx = _bootstrap();
  try {
    ctx.appSettings.set('ai.provider', 'ollama');
    ctx.appUsers.createUser({ email: 'u@example.com' });
    ctx.appUsers.setAiProviderOverride('u@example.com', 'claude');
    assert.equal(ctx.ai.resolveProvider({ userEmail: 'u@example.com' }), 'claude');
  } finally { ctx.teardown(); }
});

test('resolveProvider: NULL-Override faellt auf Global', () => {
  const ctx = _bootstrap();
  try {
    ctx.appSettings.set('ai.provider', 'openai-compat');
    ctx.appUsers.createUser({ email: 'u@example.com' });
    ctx.appUsers.setAiProviderOverride('u@example.com', 'claude');
    ctx.appUsers.setAiProviderOverride('u@example.com', null);
    assert.equal(ctx.ai.resolveProvider({ userEmail: 'u@example.com' }), 'openai-compat');
  } finally { ctx.teardown(); }
});

test('setAiProviderOverride wirft bei ungueltigem Wert', () => {
  const ctx = _bootstrap();
  try {
    ctx.appUsers.createUser({ email: 'u@example.com' });
    assert.throws(() => ctx.appUsers.setAiProviderOverride('u@example.com', 'gpt5'));
  } finally { ctx.teardown(); }
});

test('getContextConfigFor: claude liefert 200k Default, ollama 32k', () => {
  const ctx = _bootstrap();
  try {
    const c = ctx.ai.getContextConfigFor('claude');
    assert.equal(c.contextWindow, 200000);
    const o = ctx.ai.getContextConfigFor('ollama');
    assert.equal(o.contextWindow, 32000);
    assert.ok(o.inputBudgetTokens > 0);
    assert.ok(o.inputBudgetTokens < c.inputBudgetTokens);
  } finally { ctx.teardown(); }
});

test('contextSafetyMargin: proportional zum Fenster, Untergrenze 2000', () => {
  const ctx = _bootstrap();
  try {
    const m = ctx.ai.contextSafetyMargin;
    // 3 % des Fensters — der Fehler der Char→Token-Heuristik waechst mit der Prompt-Laenge.
    assert.equal(m(200000), 6000);
    assert.equal(m(90000), 2700);
    assert.equal(m(1000000), 30000, 'Komplett-Override mit 1M-Fenster');
    // Untergrenze: bei kleinen Fenstern waeren 3 % wirkungslos.
    assert.equal(m(32000), 2000);
    assert.equal(m(8000), 2000);
    // Unkonfiguriert → Untergrenze, kein NaN.
    assert.equal(m(0), 2000);
    assert.equal(m(undefined), 2000);
  } finally { ctx.teardown(); }
});

test('getContextConfigFor: safetyMargin und inputBudget rechnen mit demselben Puffer', () => {
  const ctx = _bootstrap();
  try {
    // Validierung (Boot-Check) und Budget-Rechnung muessen dieselbe Funktion lesen —
    // sonst laesst der Boot eine Kombination durch, die das Budget still kollabiert.
    for (const [provider, win, out] of [['claude', 200000, 64000], ['openai-compat', 90000, 16000], ['ollama', 32000, 16000]]) {
      ctx.appSettings.set(`ai.${provider}.context_window`, win);
      ctx.appSettings.set(`ai.${provider}.max_tokens_out`, out);
      const c = ctx.ai.getContextConfigFor(provider);
      assert.equal(c.contextWindow, win, provider);
      assert.equal(c.safetyMargin, ctx.ai.contextSafetyMargin(win), `${provider}: safetyMargin`);
      assert.equal(c.inputBudgetTokens, win - out - c.safetyMargin, `${provider}: inputBudgetTokens`);
      assert.equal(c.inputBudgetChars, c.inputBudgetTokens * c.charsPerToken, `${provider}: inputBudgetChars`);
    }
  } finally { ctx.teardown(); }
});

test('providerClass: claude=cloud, ollama=local, openai-compat Default=local', () => {
  const ctx = _bootstrap();
  try {
    assert.equal(ctx.ai.providerClass('claude'), 'cloud');
    assert.equal(ctx.ai.providerClass('ollama'), 'local');
    assert.equal(ctx.ai.providerClass('openai-compat'), 'local');
    // Unbekannter/leerer Provider faellt wie bei getContextConfigFor auf claude → cloud.
    assert.equal(ctx.ai.providerClass('gpt5'), 'cloud');
  } finally { ctx.teardown(); }
});

test('providerClass: ai.openai-compat.cloud flippt openai-compat auf cloud', () => {
  const ctx = _bootstrap();
  try {
    ctx.appSettings.set('ai.openai-compat.cloud', true);
    assert.equal(ctx.ai.providerClass('openai-compat'), 'cloud');
    // Ollama bleibt immer local — der Schalter gilt nur fuer openai-compat.
    assert.equal(ctx.ai.providerClass('ollama'), 'local');
  } finally { ctx.teardown(); }
});

test('promptVariantFor folgt der Klassen-Entscheidung (Prompt-Variante)', () => {
  const ctx = _bootstrap();
  try {
    const loader = require_('../../lib/prompts-loader');
    assert.equal(loader.promptVariantFor('openai-compat'), 'local');
    ctx.appSettings.set('ai.openai-compat.cloud', true);
    assert.equal(loader.promptVariantFor('openai-compat'), 'cloud');
  } finally { ctx.teardown(); }
});

test('Synonym-Cache: provider trennt Eintraege', () => {
  const ctx = _bootstrap();
  try {
    const schema = require_('../../db/schema');
    ctx.appUsers.createUser({ email: 'a@b' });
    schema.saveSynonymCache('a@b', 'k1', [{ wort: 'X' }], 'claude');
    schema.saveSynonymCache('a@b', 'k1', [{ wort: 'Y' }], 'ollama');
    const claude = schema.loadSynonymCache('a@b', 'k1', 'claude');
    const ollama = schema.loadSynonymCache('a@b', 'k1', 'ollama');
    assert.equal(claude[0].wort, 'X');
    assert.equal(ollama[0].wort, 'Y');
  } finally { ctx.teardown(); }
});

test('Lektorat-Cache: provider trennt Eintraege', () => {
  const ctx = _bootstrap();
  try {
    const schema = require_('../../db/schema');
    const db = require_('../../db/connection').db;
    ctx.appUsers.createUser({ email: 'a@b' });
    const now = new Date().toISOString();
    const bookId = db.prepare(`INSERT INTO books (name, slug, description, owner_email, created_at, updated_at) VALUES ('B','b','','a@b',?,?)`).run(now, now).lastInsertRowid;
    const pageId = db.prepare(`INSERT INTO pages (book_id, page_name, body_html, updated_at, local_updated_at) VALUES (?, 'P', '<p>x</p>', ?, ?)`).run(bookId, now, now).lastInsertRowid;
    schema.saveLektoratCache(bookId, 'a@b', pageId, 'ctx1', { fehler: ['A'] }, 'claude');
    schema.saveLektoratCache(bookId, 'a@b', pageId, 'ctx1', { fehler: ['B'] }, 'ollama');
    assert.deepEqual(schema.loadLektoratCache(bookId, 'a@b', pageId, 'ctx1', 'claude').fehler, ['A']);
    assert.deepEqual(schema.loadLektoratCache(bookId, 'a@b', pageId, 'ctx1', 'ollama').fehler, ['B']);
  } finally { ctx.teardown(); }
});
