// Tripwire: Job-Module duerfen ihre Multi-Pass-Grenzen NICHT aus den boot-
// eingefrorenen Konstanten `SINGLE_PASS_LIMIT` / `PER_CHUNK_LIMIT` beziehen,
// sondern ausschliesslich ueber `chunkLimitsFor(provider)`.
//
// Warum das ein Gesetz und keine Prosa-Regel ist: die beiden Konstanten in
// routes/jobs/shared/loader.js leiten sich aus INPUT_BUDGET_CHARS ab, und das ist
// fest `ai.claude.context_window` − `ai.claude.max_tokens_out` (lib/ai/config.js) —
// provider-unabhaengig und beim Modul-Load eingefroren. Auf einer lokalen Instanz
// (z.B. mistral-small3.2 mit 90 000 Token) ergibt die Claude-Ableitung ein
// Single-Pass-Budget von ~375 000 Zeichen ≈ 94k Token und damit einen Prompt, der
// groesser ist als das gesamte Kontextfenster des Modells. Der Job scheitert dann
// mit einem undurchsichtigen Provider-400 statt korrekt zu chunken.
//
// `chunkLimitsFor(provider)` liest `ai.<provider>.context_window` und skaliert
// richtig. Neuer Verstoss → CI rot.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const JOBS_DIR = join(REPO_ROOT, 'routes', 'jobs');

// Definition + Re-Export duerfen die Konstanten nennen — sie SIND die Konstanten.
const ALLOWLIST = new Set([
  'routes/jobs/shared/loader.js',   // Definition (Boot-Konstanten, rueckwaertskompatibel exportiert)
  'routes/jobs/shared/index.js',    // Facade-Re-Export
]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

const rel = (p) => relative(REPO_ROOT, p);

// Greift die Destrukturierung aus einem require('./shared')- bzw.
// require('./shared/loader')-Aufruf. Mehrzeilig, weil die Job-Module ihre
// Shared-Imports ueber viele Zeilen verteilen.
const REQUIRE_SHARED_RE =
  /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*['"](?:\.{1,2}\/)+(?:jobs\/)?shared(?:\/loader)?['"]\s*\)/g;

const FROZEN = ['SINGLE_PASS_LIMIT', 'PER_CHUNK_LIMIT'];

test('kein Job-Modul importiert die eingefrorenen Chunk-Limits', () => {
  const violations = [];
  for (const file of walk(JOBS_DIR)) {
    const relPath = rel(file);
    if (ALLOWLIST.has(relPath)) continue;
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(REQUIRE_SHARED_RE)) {
      const names = m[1].split(',').map(s => s.split(':')[0].trim());
      for (const frozen of FROZEN) {
        if (names.includes(frozen)) violations.push(`${relPath}: importiert ${frozen}`);
      }
    }
  }
  assert.deepEqual(
    violations, [],
    'Job-Module muessen chunkLimitsFor(provider) statt der eingefrorenen '
    + 'Claude-Konstanten verwenden:\n  ' + violations.join('\n  '),
  );
});

// Zweite Haelfte derselben Regel: wer chunkLimitsFor aufruft, muss einen
// aufgeloesten Provider uebergeben. `chunkLimitsFor()` ohne Argument faellt in
// getContextConfigFor auf 'claude' zurueck und ist damit exakt der Fehler, den
// dieser Test verhindern soll — nur schwerer zu sehen.
test('chunkLimitsFor wird nie ohne Provider-Argument aufgerufen', () => {
  const violations = [];
  for (const file of walk(JOBS_DIR)) {
    const relPath = rel(file);
    if (ALLOWLIST.has(relPath)) continue;
    const src = readFileSync(file, 'utf8');
    if (/\bchunkLimitsFor\(\s*\)/.test(src)) violations.push(`${relPath}: chunkLimitsFor() ohne Provider`);
  }
  assert.deepEqual(violations, [], violations.join('\n  '));
});
