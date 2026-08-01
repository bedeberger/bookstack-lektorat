// Drift guard fuer die Job-Statistik (Bucheinstellungen → Tab "Statistik").
//
// Die Tabelle rendert `$app.t(row.typeLabel)` — der Server liefert den i18n-Key
// aus JOB_TYPE_LABELS, das Frontend uebersetzt ihn OHNE Parameter-Map. Daraus
// folgen zwei Invarianten, die beide nur in der UI sichtbar brechen:
//   1. Fehlt der Key in de.json/en.json, rendert `tRaw` den Key selbst
//      ("job.label.lexiconScan") statt eines Labels.
//   2. Enthaelt der Key einen Platzhalter ("Word-Export ({profile})"), steht der
//      Platzhalter woertlich in der Tabelle — parametrisierte Job-Labels
//      brauchen hier einen eigenen platzhalterfreien Typ-Key.
//
// Ausserdem: jeder Job-Typ, der in `job_runs` landet, braucht einen Eintrag in
// JOB_TYPE_LABELS oder in STATS_EXCLUDED_TYPES — sonst zeigt die Tabelle die
// rohe Typ-ID (siehe CLAUDE.md "Neues Feature hinzufuegen" → Stats-Label).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const require = createRequire(import.meta.url);

const { JOB_TYPE_LABELS, STATS_EXCLUDED_TYPES } = require(join(ROOT, 'routes/jobs/shared/jobs.js'));
const de = JSON.parse(readFileSync(join(ROOT, 'public/js/i18n/de.json'), 'utf8'));
const en = JSON.parse(readFileSync(join(ROOT, 'public/js/i18n/en.json'), 'utf8'));

test('every JOB_TYPE_LABELS key is defined in de.json and en.json', () => {
  const missing = [];
  for (const [type, key] of Object.entries(JOB_TYPE_LABELS)) {
    if (de[key] === undefined) missing.push(`${type} → ${key} (de.json)`);
    if (en[key] === undefined) missing.push(`${type} → ${key} (en.json)`);
  }
  assert.deepEqual(missing, [], `Job-Statistik zeigt sonst den rohen Key:\n  ${missing.join('\n  ')}`);
});

test('JOB_TYPE_LABELS keys are placeholder-free', () => {
  const withParams = [];
  for (const [type, key] of Object.entries(JOB_TYPE_LABELS)) {
    for (const [loc, msgs] of [['de', de], ['en', en]]) {
      if (/\{\w+\}/.test(msgs[key] || '')) withParams.push(`${type} → ${key} (${loc}): ${msgs[key]}`);
    }
  }
  assert.deepEqual(withParams, [], `t() wird ohne Parameter-Map aufgerufen — eigenen Typ-Key anlegen:\n  ${withParams.join('\n  ')}`);
});

// Alle Job-Typen aus createJob('<typ>', …)-Aufrufen einsammeln. Dynamische Typen
// (Variable statt Literal, z.B. der Chat-Router) sind statisch nicht aufloesbar
// und werden uebersprungen — dieselbe Einschraenkung wie in i18n-keys-defined.
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

test('every literal createJob type has a stats label or is explicitly excluded', () => {
  const known = new Set([...Object.keys(JOB_TYPE_LABELS), ...STATS_EXCLUDED_TYPES]);
  const unknown = [];
  for (const file of walk(join(ROOT, 'routes'))) {
    if (file.endsWith(join('shared', 'jobs.js'))) continue;
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/createJob\(\s*'([a-z0-9-]+)'/g)) {
      if (!known.has(m[1])) unknown.push(`${m[1]} (${relative(ROOT, file)})`);
    }
  }
  assert.deepEqual([...new Set(unknown)], [],
    `Job-Typ ohne JOB_TYPE_LABELS-Eintrag → Statistik zeigt die rohe Typ-ID:\n  ${unknown.join('\n  ')}`);
});
