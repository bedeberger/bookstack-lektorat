// Die Schwere-Skala der Figuren-Werkstatt steht an drei Orten, und alle drei
// muessen dasselbe sagen:
//
//   1. SEVERITY_ENUM in public/js/prompts/figur-werkstatt.js — Prompt-Text +
//      JSON-Schema (bei lokalen Providern erzwingt Constrained Decoding daraus).
//   2. SEVERITY_ENUM in routes/jobs/figur-werkstatt.js — bewusste CJS-KOPIE,
//      weil der Router das ESM-Prompt-Modul nicht importieren kann. Sie
//      entscheidet, welcher Wert die Server-Validierung passiert.
//   3. .severity-tag--<wert> in public/css — die Plakette am Konflikt.
//
// Driftet 2 gegen 1, faellt ein Wert, den das Modell laut Schema liefern DARF,
// serverseitig still auf "mittel" zurueck. Driftet 3, rendert der Konflikt ohne
// Farbe. Der Wert ist zugleich Persistenz-Konstante (werkstatt_runs.result_json):
// ergaenzen ja, umbenennen nein — sonst verlieren Alt-Laeufe ihre Plakette.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;

function jsArrayLiteral(src, constName) {
  const m = new RegExp(`const ${constName}\\s*=\\s*\\[([^\\]]*)\\]`).exec(src);
  assert.ok(m, `${constName} nicht gefunden`);
  return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
}

test('Job-Router und Prompt-Modul teilen dieselbe Schwere-Skala', async () => {
  const prompts = await import('../../public/js/prompts/figur-werkstatt.js');
  const routerSrc = readFileSync(join(ROOT, 'routes/jobs/figur-werkstatt.js'), 'utf8');
  const routerEnum = jsArrayLiteral(routerSrc, 'SEVERITY_ENUM');

  assert.deepEqual(routerEnum, prompts.WERKSTATT_SEVERITY_ENUM,
    'CJS-Kopie im Job-Router weicht vom Prompt-Enum ab');
});

test('Fallback der Server-Validierung liegt in der Skala', () => {
  const routerSrc = readFileSync(join(ROOT, 'routes/jobs/figur-werkstatt.js'), 'utf8');
  const routerEnum = jsArrayLiteral(routerSrc, 'SEVERITY_ENUM');
  const m = /const SEVERITY_FALLBACK\s*=\s*'([^']+)'/.exec(routerSrc);
  assert.ok(m, 'SEVERITY_FALLBACK nicht gefunden');
  assert.ok(routerEnum.includes(m[1]),
    `Fallback "${m[1]}" ist kein Wert der Skala — jeder unbekannte Schweregrad landete auf einer Plakette ohne CSS`);
});

test('jede Stufe hat eine .severity-tag--Klasse im CSS', async () => {
  const prompts = await import('../../public/js/prompts/figur-werkstatt.js');
  const cssDir = join(ROOT, 'public/css');
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.css')) files.push(p);
    }
  };
  walk(cssDir);
  const css = files.map(f => readFileSync(f, 'utf8')).join('\n');
  for (const stufe of prompts.WERKSTATT_SEVERITY_ENUM) {
    assert.ok(css.includes(`.severity-tag--${stufe}`),
      `.severity-tag--${stufe} fehlt im CSS`);
  }
});
