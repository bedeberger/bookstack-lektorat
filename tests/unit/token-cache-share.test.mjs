// Cache-Anteil im Token-Status: `tokensIn` ist cache-INKLUSIV (input + cache_read +
// cache_creation, siehe lib/ai/claude.js) und im agentischen Tool-Loop zusätzlich über
// alle Provider-Calls aufsummiert. Ohne die Quote liest sich die Zahl wie voll bezahlter
// Input — der gelesene Cache kostet aber nur ein Zehntel des Tarifs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runningJobStatus } from '../../public/js/cards/job-helpers.js';

const t = (k, p) => (k === 'chat.tokenCacheShare' ? `${p.pct} % Cache` : k);

test('Cache-Quote erscheint im Status, wenn cacheReadIn gesetzt ist', () => {
  const html = runningJobStatus(t, 'job.phase.aiReply', 1000, 200, 0, 0, 0, null, 900);
  assert.match(html, /90 % Cache/);
});

test('ohne cacheReadIn bleibt der Status unverändert (Bestandsaufrufer)', () => {
  const html = runningJobStatus(t, 'job.phase.aiReply', 1000, 200, 0, 0, 0, null);
  assert.doesNotMatch(html, /Cache/);
  assert.match(html, /↑1\.0K ↓200 Tokens/);
});

test('cacheReadIn ohne Input-Tokens erzeugt keine Division durch null', () => {
  const html = runningJobStatus(t, 'job.phase.aiReply', 0, 200, 0, 0, 0, null, 900);
  assert.doesNotMatch(html, /Cache/);
  assert.doesNotMatch(html, /NaN/);
});
