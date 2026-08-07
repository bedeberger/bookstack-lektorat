// Preflight-Guard: geschaetzter Input + Output-Cap muessen ins Kontextfenster passen.
//
// Ohne diesen Guard geht der Call raus und kommt als undurchsichtiger Provider-400
// zurueck (llama.cpp/vLLM) oder der Prompt wird still gekuerzt (Ollama deckelt num_ctx
// selbst) — beides mitten im Job und ohne Hinweis darauf, dass Buch/Kapitel zu gross war.
//
// Zwei Ebenen geprueft:
//   1. Der pure Helfer (lib/ai/shared.js) pro Provider-Profil — Grenze exakt, nicht ungefaehr.
//   2. Der Job-Chokepoint (routes/jobs/shared/ai.js#aiCall) — wirft VOR dem Netzwerk-Call.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..', '..');

const aiShared = require(path.join(repo, 'lib/ai/shared'));
const { estimatePromptTokens, assertPromptFitsContext } = aiShared;

// Provider-Profile als explizite Zahlen (nicht aus app_settings gelesen) — der Test
// prueft die Guard-Arithmetik, nicht die Konfiguration der laufenden Instanz.
// `safetyMargin` liefert im Produktivpfad getContextConfigFor mit.
const PROFILES = [
  { provider: 'claude',         contextWindow: 200000, maxTokensOut: 64000, charsPerToken: 3, safetyMargin: 6000 },
  { provider: 'openai-compat',  contextWindow:  90000, maxTokensOut: 16000, charsPerToken: 4, safetyMargin: 2700 },
  { provider: 'ollama',         contextWindow:  32000, maxTokensOut: 16000, charsPerToken: 4, safetyMargin: 2000 },
];

const budgetOf = (cfg) => cfg.contextWindow - cfg.maxTokensOut - cfg.safetyMargin;

// ── 1. Pure Guard-Arithmetik ────────────────────────────────────────────────

for (const cfg of PROFILES) {
  const budget = budgetOf(cfg);

  test(`Guard (${cfg.provider}): Input genau am Budget geht durch`, () => {
    const est = assertPromptFitsContext({
      provider: cfg.provider, cfg, maxTokensOut: cfg.maxTokensOut, estTokIn: budget,
    });
    assert.equal(est, budget, 'Guard gibt die Schaetzung zurueck');
  });

  test(`Guard (${cfg.provider}): ein Token ueber dem Budget wirft`, () => {
    assert.throws(
      () => assertPromptFitsContext({
        provider: cfg.provider, cfg, maxTokensOut: cfg.maxTokensOut, estTokIn: budget + 1,
      }),
      (err) => {
        assert.equal(err.message, 'job.error.aiContextOverflow', 'i18n-Key als message');
        assert.equal(err.code, 'AI_CONTEXT_OVERFLOW');
        // Die drei Zahlen, die der User braucht, um zu entscheiden WAS er dreht.
        assert.equal(err.i18nParams.tokIn, budget + 1);
        assert.equal(err.i18nParams.window, cfg.contextWindow);
        assert.equal(err.i18nParams.maxOut, cfg.maxTokensOut);
        assert.equal(err.i18nParams.budget, budget);
        assert.equal(err.i18nParams.provider, cfg.provider);
        return true;
      },
    );
  });

  test(`Guard (${cfg.provider}): job-eigener, tieferer Output-Cap vergroessert das Budget`, () => {
    // Job-Sites deckeln den Output oft unter dem Provider-Setting (maxTokens-Argument
    // in aiCall). Dann passt mehr Input rein — der Guard muss den Per-Call-Cap nutzen,
    // nicht cfg.maxTokensOut.
    const smallOut = Math.floor(cfg.maxTokensOut / 2);
    const est = budget + smallOut;
    assert.equal(
      assertPromptFitsContext({ provider: cfg.provider, cfg, maxTokensOut: smallOut, estTokIn: est }),
      est,
    );
  });
}

test('Guard: unvollstaendige Config (kein contextWindow) wirft nicht', () => {
  // Bewusst dokumentiertes Verhalten: ohne belastbares Fenster wird nicht geraten,
  // sonst blockierte ein unkonfigurierter Provider jeden Call.
  const est = assertPromptFitsContext({
    provider: 'ollama', cfg: { maxTokensOut: 16000 }, maxTokensOut: 16000, estTokIn: 999999,
  });
  assert.equal(est, 999999);
});

test('estimatePromptTokens: zaehlt String, System-Bloecke und Message-Arrays', () => {
  assert.equal(estimatePromptTokens('abcdef', 3), 2);
  // System-Block-Array ([{ text, ttl }]) — die Form der Claude-Cache-Bloecke.
  assert.equal(estimatePromptTokens([{ text: 'abc', ttl: '1h' }, { text: 'def' }], 3), 2);
  // Message-Array ([{ role, content }]) — die Form der lokalen Provider.
  assert.equal(estimatePromptTokens([{ role: 'user', content: 'abcdefgh' }], 4), 2);
  // Aufrundung: 5 chars / 4 = 1.25 → 2 Tokens (nie unterschaetzen).
  assert.equal(estimatePromptTokens('abcde', 4), 2);
});

// ── 2. Job-Chokepoint: aiCall wirft VOR dem Netzwerk-Call ───────────────────
// Wie in ai-truncated.test.mjs: lib/ai wird via require.cache gestubbt, BEVOR
// routes/jobs/shared/ai.js geladen wird. Die Guard-Funktionen kommen echt durch,
// nur callAI/getContextConfigFor/resolveProvider sind Fakes.

let callAICalls = 0;
let stubProfile = PROFILES[1];

const aiPath = require.resolve(path.join(repo, 'lib/ai'));
require.cache[aiPath] = {
  id: aiPath, filename: aiPath, loaded: true, children: [], paths: [],
  exports: {
    callAI: async () => {
      callAICalls += 1;
      return {
        text: '{"ok":true}', truncated: false, tokensIn: 10, tokensOut: 5,
        cacheReadIn: 0, cacheCreationIn: 0, cacheCreation1hIn: 0,
        genDurationMs: 1, provider: stubProfile.provider, model: 'test',
      };
    },
    parseJSON: (t) => JSON.parse(t),
    CHARS_PER_TOKEN: 4,
    MAX_TOKENS_OUT: 64000,
    getContextConfigFor: () => stubProfile,
    resolveProvider: () => stubProfile.provider,
    normalizeTier: (t) => (typeof t === 'string' ? { model: t } : (t || {})),
    _resolveClaudeModel: (m) => m || 'test',
    estimatePromptTokens, assertPromptFitsContext,
  },
};

const jobsPath = require.resolve(path.join(repo, 'routes/jobs/shared/jobs'));
require.cache[jobsPath] = {
  id: jobsPath, filename: jobsPath, loaded: true, children: [], paths: [],
  exports: {
    updateJob: () => {},
    i18nError: (key, params = null) => {
      const err = new Error(key);
      if (params) err.i18nParams = params;
      return err;
    },
    fmtTok: (n) => String(n),
  },
};

const statePath = require.resolve(path.join(repo, 'routes/jobs/shared/state'));
require.cache[statePath] = {
  id: statePath, filename: statePath, loaded: true, children: [], paths: [],
  exports: {
    jobs: new Map(), runningJobs: new Map(), jobAbortControllers: new Map(),
    jobQueue: [], jobKey: () => '', jobDedupKey: () => '',
  },
};

const { aiCall } = require(path.join(repo, 'routes/jobs/shared/ai'));

for (const profile of PROFILES) {
  const budget = budgetOf(profile);

  test(`aiCall (${profile.provider}): Prompt ueber dem Fenster wirft ohne Netzwerk-Call`, async () => {
    stubProfile = profile;
    callAICalls = 0;
    const tok = { in: 0, out: 0, ms: 0 };
    // Ein Zeichen mehr als das Budget hergibt → Schaetzung = budget + 1.
    const prompt = 'x'.repeat(budget * profile.charsPerToken + 1);
    await assert.rejects(
      () => aiCall('job-of', tok, prompt, '', 0, 100, 3000, 0.2, null, profile.provider, null),
      (err) => {
        assert.equal(err.message, 'job.error.aiContextOverflow');
        assert.equal(err.i18nParams.tokIn, budget + 1);
        assert.equal(err.i18nParams.window, profile.contextWindow);
        assert.equal(err.i18nParams.maxOut, profile.maxTokensOut);
        return true;
      },
    );
    assert.equal(callAICalls, 0,
      'Guard muss VOR callAI werfen — sonst kommt der Fehler als Provider-400 zurueck');
    assert.equal(tok.in, 0, 'kein Token verbucht, weil kein Call rausging');
  });

  test(`aiCall (${profile.provider}): Prompt knapp unter dem Fenster geht durch`, async () => {
    stubProfile = profile;
    callAICalls = 0;
    const tok = { in: 0, out: 0, ms: 0 };
    const prompt = 'x'.repeat(budget * profile.charsPerToken);
    const out = await aiCall('job-ok', tok, prompt, '', 0, 100, 3000, 0.2, null, profile.provider, null);
    assert.deepEqual(out, { ok: true });
    assert.equal(callAICalls, 1);
  });
}

test('aiCall: System-Prompt zaehlt zum Input (Bloecke inklusive)', async () => {
  // Der System-Prompt ist bei den Analyse-Jobs der groessere Teil (Buchtext als
  // Cache-Block). Zaehlt er nicht mit, laesst der Guard genau die Calls durch,
  // die tatsaechlich ueberlaufen.
  stubProfile = PROFILES[2];
  callAICalls = 0;
  const budget = budgetOf(stubProfile);
  const tok = { in: 0, out: 0, ms: 0 };
  const system = [{ text: 'y'.repeat(budget * stubProfile.charsPerToken), ttl: '1h' }];
  await assert.rejects(
    () => aiCall('job-sys', tok, 'x'.repeat(100), system, 0, 100, 3000, 0.2, null, 'ollama', null),
    (err) => {
      assert.equal(err.message, 'job.error.aiContextOverflow');
      return true;
    },
  );
  assert.equal(callAICalls, 0);
});

test('i18n: job.error.aiContextOverflow existiert in beiden Locales mit allen Params', () => {
  const fs = require('node:fs');
  for (const loc of ['de', 'en']) {
    const dict = JSON.parse(fs.readFileSync(path.join(repo, `public/js/i18n/${loc}.json`), 'utf8'));
    const msg = dict['job.error.aiContextOverflow'];
    assert.ok(msg, `job.error.aiContextOverflow fehlt in ${loc}.json`);
    for (const p of ['tokIn', 'window', 'maxOut', 'budget', 'provider']) {
      assert.ok(msg.includes(`{${p}}`), `${loc}.json: Platzhalter {${p}} fehlt`);
    }
  }
});
