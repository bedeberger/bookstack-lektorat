// Drift-Gate der Kosten-Buckets der Komplettanalyse.
//
// Warum als Test und nicht als Konvention: ein Call ohne Label ist NICHT sichtbar
// kaputt — er läuft normal, seine Kosten fallen nur in den Sammel-Bucket 'other'.
// Genau so ist die Aufschlüsselung schon einmal blind geworden (nur das
// Extraktions-Tier trug ein Label, alles andere lag in einem Topf). Ohne dieses
// Gate wächst 'other' mit jedem neuen Pipeline-Call zurück in dieselbe Lage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { COST_LABEL, COST_LABEL_FALLBACK } = require('../../routes/jobs/komplett/cost-labels.js');

const KOMPLETT_DIR = 'routes/jobs/komplett';
const de = JSON.parse(readFileSync('public/js/i18n/de.json', 'utf8'));
const en = JSON.parse(readFileSync('public/js/i18n/en.json', 'utf8'));

function jsFilesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...jsFilesUnder(p));
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('jedes Kosten-Label hat einen i18n-Key in BEIDEN Locales', () => {
  const labels = [...Object.values(COST_LABEL), COST_LABEL_FALLBACK];
  for (const label of labels) {
    const key = `komplett.costPhase.${label}`;
    assert.ok(de[key], `de.json fehlt ${key} — die Karte rendert sonst den rohen Bucket-Namen`);
    assert.ok(en[key], `en.json fehlt ${key}`);
  }
});

test('COST_LABEL-Keys und -Werte sind deckungsgleich (kein Tippfehler-Bucket)', () => {
  for (const [k, v] of Object.entries(COST_LABEL)) {
    assert.equal(k, v, `COST_LABEL.${k} hat den abweichenden Wert '${v}' — Key und Bucket-Name müssen gleich sein`);
  }
});

test('jeder KI-Call der Komplettanalyse traegt ein Kosten-Label', () => {
  // Ein Tier-Argument ist die einzige Stelle, an der ein Label an den Call kommt
  // (normalizeTier in lib/ai/shared.js). Fehlt es, ist der Call unbepreisbar.
  const TIER_ARGS = ['extractTier', 'gapTier', 'coverageTier', 'costTier(', 'relabel('];
  const unlabeled = [];
  for (const file of jsFilesUnder(KOMPLETT_DIR)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!/\bcall\(jobId/.test(line)) return;
      const blob = lines.slice(i, i + 12).join('\n');
      if (!TIER_ARGS.some(t => blob.includes(t))) unlabeled.push(`${file}:${i + 1}`);
    });
  }
  assert.deepEqual(unlabeled, [],
    `Call-Sites ohne Kosten-Label (Tier-Argument fehlt) — ihre Kosten fallen in '${COST_LABEL_FALLBACK}':\n  `
    + unlabeled.join('\n  '));
});

test('Tier-Konstruktoren werden nur mit COST_LABEL-Membern aufgerufen', () => {
  // `label:` ist im Repo DREIFACH belegt — Kosten-Bucket (Tier-Objekt), Log-Label
  // (settledAll/retryOnTransientAi-Optionen) und Stream-Label der Gap-Pässe. Ein
  // Scan über `label:` produziert darum Fehlalarme; geprüft wird stattdessen der
  // Weg, über den ein Kosten-Bucket tatsächlich entsteht: costTier()/relabel().
  const offenders = [];
  for (const file of jsFilesUnder(KOMPLETT_DIR)) {
    if (file.endsWith('cost-labels.js')) continue;
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\b(?:costTier|relabel)\(([^)]*)\)/g)) {
      const arg = m[1].split(',').pop().trim();
      if (!/^COST_LABEL\.[A-Za-z]+$/.test(arg)) {
        offenders.push(`${file}: ${m[0]} — Bucket muss COST_LABEL.<key> sein, nicht '${arg}'`);
      }
    }
  }
  assert.deepEqual(offenders, [], offenders.join('\n  '));
});

test('jeder in COST_LABEL definierte Bucket wird auch benutzt', () => {
  // Ein toter Bucket ist ein Hinweis auf einen entfernten oder umbenannten
  // Pipeline-Schritt — dann gehört das Label (und sein i18n-Key) mit weg.
  const src = jsFilesUnder(KOMPLETT_DIR)
    .filter(f => !f.endsWith('cost-labels.js'))
    .map(f => readFileSync(f, 'utf8')).join('\n');
  const unused = Object.keys(COST_LABEL).filter(k => !src.includes(`COST_LABEL.${k}`));
  assert.deepEqual(unused, [], `Ungenutzte Kosten-Buckets: ${unused.join(', ')}`);
});
