// callAI `truncated`-Flag: Throw VOR parseJSON (CLAUDE.md "Harte Regel").
//
// jsonrepair (im parseJSON-Fallback) ist tolerant und gibt aus abgebrochenem
// JSON oft partielle Daten zurück — Stil-Findings ohne `korrektur`,
// Komplettanalyse-Phasen mit halbleeren Arrays. Wer parseJSON ohne
// truncated-Guard aufruft, fütert das partielle JSON-Ergebnis ins Schema und
// erzeugt "silent partial"-Bugs (User sieht plausibles, aber unvollständiges
// Resultat).
//
// Contract: aiCall (in routes/jobs/shared/ai.js) MUSS bei truncated=true
// werfen, BEVOR parseJSON läuft. Wir injizieren ein gefaktes lib/ai-Modul,
// damit callAI ein truncated-Resultat liefert; parseJSON wird gespiyt und
// darf NIE aufgerufen werden.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..', '..');

// ── Modul-Stubs vorab in require.cache injizieren ───────────────────────────
// shared/ai.js destrukturiert `callAI`/`parseJSON` aus lib/ai bei require-Zeit.
// Wir müssen die Fakes also EINSPRINGEN, bevor shared/ai.js geladen wird.

const aiPath = require.resolve(path.join(repo, 'lib/ai'));

let parseJSONCallCount = 0;
const fakeAI = {
  callAI: async () => ({
    text: '{"fehler": [{"original": "abc", "korrektu',  // mid-stream cut
    truncated: true,
    tokensIn: 100,
    tokensOut: 50,
    cacheReadIn: 0,
    cacheCreationIn: 0,
    genDurationMs: 1000,
    provider: 'claude',
    model: 'test',
  }),
  parseJSON: (text) => {
    parseJSONCallCount += 1;
    // Wenn jemals aufgerufen, signalisieren wir das laut.
    return { __parseJSON_was_called__: true, text };
  },
  CHARS_PER_TOKEN: 3,
  MAX_TOKENS_OUT: 64000,
  // aiCall leitet das Output-Ceiling pro Call aus dem Provider ab.
  getContextConfigFor: () => ({ maxTokensOut: 64000 }),
  // Per-Call-Tier + Modell-Auflösung: aiCall braucht beide für die Kosten-
  // Aufschlüsselung (tok.byPhase). Der Stub muss die lib/ai-Oberfläche
  // vollständig spiegeln — fehlt hier etwas, wirft aiCall VOR dem
  // truncated-Guard und der Test misst den falschen Fehler.
  normalizeTier: (t) => (typeof t === 'string' ? { model: t } : (t || {})),
  _resolveClaudeModel: (m) => m || 'test',
};

require.cache[aiPath] = {
  id: aiPath,
  filename: aiPath,
  loaded: true,
  exports: fakeAI,
  children: [],
  paths: [],
};

// state.js / jobs.js sind echte CJS-Module mit wenig Surface — wir laden sie,
// aber überschreiben anschliessend die in shared/ai.js verwendeten Symbole.
const jobsPath = require.resolve(path.join(repo, 'routes/jobs/shared/jobs'));
const fakeJobs = {
  updateJob: () => {},
  i18nError: (key, params = null) => {
    const err = new Error(key);
    if (params) err.i18nParams = params;
    return err;
  },
};
require.cache[jobsPath] = {
  id: jobsPath, filename: jobsPath, loaded: true,
  exports: fakeJobs, children: [], paths: [],
};

const statePath = require.resolve(path.join(repo, 'routes/jobs/shared/state'));
const fakeState = {
  jobs: new Map(),
  runningJobs: new Map(),
  jobAbortControllers: new Map(),
  jobQueue: [],
  jobKey: () => '', jobDedupKey: () => '',
};
require.cache[statePath] = {
  id: statePath, filename: statePath, loaded: true,
  exports: fakeState, children: [], paths: [],
};

const { aiCall } = require(path.join(repo, 'routes/jobs/shared/ai'));

// ── Tests ───────────────────────────────────────────────────────────────────

test('aiCall wirft bei truncated=true bevor parseJSON läuft', async () => {
  parseJSONCallCount = 0;
  const tok = { in: 0, out: 0, ms: 0, cacheRead: 0, cacheCreate: 0 };
  await assert.rejects(
    () => aiCall('job-1', tok, 'prompt', 'system', 0, 100, 1000, 0.2, null, 'claude', null),
    (err) => {
      assert.equal(err.message, 'job.error.aiTruncated',
        'Throw mit i18n-Key job.error.aiTruncated');
      assert.ok(err.i18nParams, 'i18nParams gesetzt');
      assert.equal(err.i18nParams.tokIn, 100);
      assert.equal(err.i18nParams.tokOut, 50);
      assert.equal(err.i18nParams.total, 150);
      return true;
    },
  );
  assert.equal(parseJSONCallCount, 0,
    'parseJSON darf bei truncated=true NIE aufgerufen werden (jsonrepair liefert sonst Partial-Daten)');
});

test('aiCall akkumuliert Tokens auch bei Truncation (für korrekte Cost-Anzeige)', async () => {
  const tok = { in: 0, out: 0, ms: 0, cacheRead: 0, cacheCreate: 0 };
  try {
    await aiCall('job-2', tok, 'p', 's', 0, 100, 1000, 0.2, null, 'claude', null);
  } catch { /* throw erwartet */ }
  assert.equal(tok.in, 100, 'tokensIn wird akkumuliert (auch bei Throw — User sieht reale Kosten)');
  assert.equal(tok.out, 50, 'tokensOut akkumuliert');
});

test('Source-Check: aiCall throw-Order — truncated-check VOR parseJSON', () => {
  // Sicherheits-Netz, falls Modul-Mocking je Schwierigkeiten macht: prüfe
  // statisch die Code-Reihenfolge in routes/jobs/shared/ai.js.
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(repo, 'routes/jobs/shared/ai.js'), 'utf8');
  // aiCall-Body extrahieren.
  const m = src.match(/async function aiCall\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
  assert.ok(m, 'aiCall-Funktion gefunden');
  const body = m[0];
  const pTruncatedThrow = body.search(/if\s*\(\s*truncated\s*\)\s*throw\s+i18nError/);
  const pParseJSON = body.search(/return\s+parseJSON\s*\(/);
  assert.ok(pTruncatedThrow >= 0, 'truncated-throw-Zeile vorhanden');
  assert.ok(pParseJSON >= 0, 'parseJSON-Return vorhanden');
  assert.ok(pTruncatedThrow < pParseJSON,
    'truncated-throw MUSS textuell vor parseJSON stehen — sonst läuft parseJSON auf abgeschnittenem Text');
});
