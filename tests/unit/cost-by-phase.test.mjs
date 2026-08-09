// Per-Call-Tier + Kosten-Aufschlüsselung.
//
// Hintergrund: ai_cost_ledger hält EINE Zeile pro Job (bewusst, siehe
// db/cost-ledger.js). Bei der Komplettanalyse laufen Extraktion, Konsolidierung,
// Kontinuität und Erzählprofil aber im selben Job — die Summe sagt also nicht, wo
// die Kosten entstanden. `tok.byPhase` schliesst diese Lücke, und das Tier ist der
// Mechanismus, der einen Call einem Bucket zuordnet.
//
// Die zentrale Invariante ist die PARALLEL-SICHERHEIT: das Tier reist als Argument
// mit dem Call, nicht über den geteilten ALS-Store. Die Extraktions- und
// Konsolidierungs-Calls der Komplettanalyse laufen über `settledAll` gleichzeitig;
// ein setContext-Patch für Modell oder Effort würde den Nachbar-Call mittreffen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require_ = createRequire(import.meta.url);

function _bootstrap() {
  const dir = mkdtempSync(join(tmpdir(), 'cost-phase-'));
  process.env.DB_PATH = join(dir, 'test.db');
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test';
  for (const key of Object.keys(require_.cache)) {
    if (key.includes('/db/') || key.includes('/lib/') || key.includes('/routes/')) delete require_.cache[key];
  }
  require_('../../db/connection');
  require_('../../db/migrations').runMigrations();
  return {
    dir,
    shared: require_('../../lib/ai/shared'),
    cfg: require_('../../lib/ai/config'),
    logCtx: require_('../../lib/log-context'),
    jobsAi: require_('../../routes/jobs/shared/ai'),
    teardown: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

test('normalizeTier: String-Form bleibt gültig (bestehende Call-Sites unverändert)', () => {
  const { shared, teardown } = _bootstrap();
  try {
    assert.deepEqual(shared.normalizeTier('claude-sonnet-5'), { model: 'claude-sonnet-5' });
    assert.deepEqual(shared.normalizeTier(undefined), {});
    assert.deepEqual(shared.normalizeTier(null), {});
    assert.deepEqual(
      shared.normalizeTier({ model: 'claude-sonnet-5', effort: 'medium', label: 'extract' }),
      { model: 'claude-sonnet-5', effort: 'medium', label: 'extract' },
    );
    // Leere Felder werden zu undefined normalisiert, damit `tier.model || fallback`
    // in der cacheVersion nicht auf einen Leerstring hereinfällt.
    assert.deepEqual(shared.normalizeTier({ model: '', effort: '' }), {
      model: undefined, effort: undefined, label: undefined,
    });
  } finally { teardown(); }
});

test('Tier-Effort schlägt den ALS-Wert, ohne ihn zu verändern', () => {
  const { cfg, logCtx, teardown } = _bootstrap();
  try {
    const M = 'claude-opus-4-8';
    const eff = (override) => logCtx.runWithContext({ aiJob: { provider: 'claude', effort: 'xhigh' } },
      () => cfg._claudeOutputConfigParams(M, override).output_config?.effort ?? null);

    // Ohne Tier gilt der Job-weite ALS-Wert (unverändertes Verhalten).
    assert.equal(eff(undefined), 'xhigh');
    // Mit Tier gilt das Tier — das ist der Extraktions-Hebel.
    assert.equal(eff('medium'), 'medium');
    assert.equal(eff('low'), 'low');
    // Leerstring heisst "kein Tier-Wert", nicht "kein Effort" → ALS bleibt.
    assert.equal(eff(''), 'xhigh');
    // Und der ALS-Store ist danach unangetastet (kein setContext-Seiteneffekt).
    assert.equal(eff(undefined), 'xhigh');
  } finally { teardown(); }
});

test('Parallel-Sicherheit: gleichzeitige Calls mit verschiedenen Tiers beeinflussen sich nicht', async () => {
  const { cfg, logCtx, teardown } = _bootstrap();
  try {
    // Nachbildung der echten Situation: ein settledAll mit Extraktions- und
    // Konsolidierungs-Calls im SELBEN ALS-Scope. Wären Modell/Effort über
    // setContext gesetzt, würde hier der jeweils letzte Setter gewinnen.
    const resolve = async (tier) => {
      await new Promise(r => setTimeout(r, 5));
      const { model, effort } = cfg._resolveClaudeModel
        ? { model: cfg._resolveClaudeModel(tier.model), effort: tier.effort }
        : tier;
      await new Promise(r => setTimeout(r, 5));
      return { model, effort: cfg._claudeOutputConfigParams(model, effort).output_config?.effort ?? null };
    };

    const out = await logCtx.runWithContext({ aiJob: { provider: 'claude', model: 'claude-opus-4-8', effort: 'xhigh' } },
      () => Promise.all([
        resolve({ model: 'claude-sonnet-5', effort: 'medium' }), // Extraktion
        resolve({}),                                             // Konsolidierung (folgt ALS)
        resolve({ model: 'claude-sonnet-5', effort: 'low' }),    // zweiter Extraktions-Batch
      ]));

    assert.deepEqual(out, [
      { model: 'claude-sonnet-5', effort: 'medium' },
      { model: 'claude-opus-4-8', effort: 'xhigh' },
      { model: 'claude-sonnet-5', effort: 'low' },
    ]);
  } finally { teardown(); }
});

test('summarizeCostByPhase: teuerster Bucket zuerst, USD auf Cent gerundet', () => {
  const { jobsAi, teardown } = _bootstrap();
  try {
    const tok = { byPhase: {
      other:   { calls: 4, tokensIn: 900, tokensOut: 400, cacheReadIn: 10, cacheCreationIn: 0, usd: 21.007, ms: 4000, models: ['claude-opus-4-8'] },
      extract: { calls: 21, tokensIn: 5000, tokensOut: 9000, cacheReadIn: 4000, cacheCreationIn: 300, usd: 12.401, ms: 60000, models: ['claude-sonnet-5'] },
    } };
    const s = jobsAi.summarizeCostByPhase(tok);
    assert.deepEqual(s.phases.map(p => p.phase), ['other', 'extract']);
    assert.equal(s.phases[0].usd, 21.01);
    assert.equal(s.phases[1].usd, 12.4);
    assert.equal(s.totalUsd, 33.41);
    assert.equal(s.phases[1].calls, 21);
    assert.equal(s.phases[1].seconds, 60);
    assert.deepEqual(s.phases[1].models, ['claude-sonnet-5']);

    // Kein Label irgendwo (lokale Provider, Jobs ohne Tiering) → nichts anhängen,
    // statt ein leeres Objekt ins Job-Result zu schreiben.
    assert.equal(jobsAi.summarizeCostByPhase({}), null);
    assert.equal(jobsAi.summarizeCostByPhase({ byPhase: {} }), null);
    assert.equal(jobsAi.summarizeCostByPhase(null), null);

    const line = jobsAi.formatCostByPhase(s);
    assert.match(line, /extract 21c/);
    assert.match(line, /\$12\.40/);
    assert.match(line, /claude-sonnet-5/);
    assert.equal(jobsAi.formatCostByPhase(null), '');
  } finally { teardown(); }
});

// Tripwire: der Extraktions-Effort MUSS in die cacheVersion. Ohne ihn liefert ein
// Effort-Wechsel weiterhin den alten `__singlepass__`-Katalog aus book_extract_cache
// — die Umstellung sähe dann wirkungslos aus, obwohl sie nur nicht griff.
test('cacheVersion enthält den Extraktions-Effort', () => {
  const src = readFileSync(new URL('../../routes/jobs/komplett/job-komplett.js', import.meta.url), 'utf8');
  assert.match(src, /extractTier\.effort/,
    'job-komplett.js muss extractTier.effort in die cacheVersion einrechnen');
  const cacheVersionLine = src.split('\n').find(l => l.includes('const cacheVersion ='));
  assert.ok(cacheVersionLine, 'cacheVersion-Zuweisung nicht gefunden');
  assert.match(cacheVersionLine, /effortAug/,
    'der Effort-Anteil fehlt im cacheVersion-String');
});
