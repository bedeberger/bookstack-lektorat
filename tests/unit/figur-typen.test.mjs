// Drift-Gate der Figurentyp-Taxonomie (public/js/book/figur-typen.js).
//
// Die Liste ordnet jede Figurenliste der App und die Tier-Baender des
// Figurengraphen. Sie stand als wortgleiches TYP_ORDER-Objekt in vier Modulen
// plus als Array in graph/layout.js — eine vergessene Stelle sortiert still
// falsch, statt zu brechen. Dieser Test macht die Kopie wieder teuer.
//
// Geprueft wird die Taxonomie in ihrer ganzen Kette: SSoT ↔ Graph-Tier-Achse ↔
// Prompt-Enum (was das Modell liefern DARF) ↔ Canvas-Palette ↔ i18n in beiden
// Locales. Faellt einer der Zweige, kennt die App einen Typ, den ein anderer
// Teil nicht darstellen/beschriften/erzeugen kann.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const { FIGUR_TYPEN, VALID_FIGUR_TYPEN, typRank, byTypDannName } =
  await import('../../public/js/book/figur-typen.js');

test('typRank folgt der deklarierten Reihenfolge, Unbekanntes landet hinten', () => {
  FIGUR_TYPEN.forEach((t, i) => assert.equal(typRank(t), i));
  assert.equal(typRank('gibtsnicht'), FIGUR_TYPEN.length);
  assert.equal(typRank(undefined), FIGUR_TYPEN.length);
  // Hinten heisst hinten, nicht mittendrin.
  assert.ok(typRank('gibtsnicht') > typRank('andere'));
});

test('byTypDannName sortiert Tier vor Name', () => {
  const rows = [
    { typ: 'nebenfigur', name: 'Anna' },
    { typ: 'hauptfigur', name: 'Zora' },
    { typ: 'hauptfigur', name: 'Ärger' },   // Umlaut-Kollation, nicht Codepoint
    { typ: 'quatsch',    name: 'Aaron' },
  ];
  assert.deepEqual([...rows].sort(byTypDannName).map(r => r.name),
    ['Ärger', 'Zora', 'Anna', 'Aaron']);
});

test('VALID_FIGUR_TYPEN deckt genau die deklarierte Liste', () => {
  assert.deepEqual([...VALID_FIGUR_TYPEN].sort(), [...FIGUR_TYPEN].sort());
});

test('graph/layout.js TIER_ORDER ist die SSoT, keine zweite Liste', async () => {
  const { TIER_ORDER } = await import('../../public/js/graph/layout.js');
  assert.deepEqual(TIER_ORDER, FIGUR_TYPEN);
  assert.ok(!/TIER_ORDER\s*=\s*\[/.test(read('public/js/graph/layout.js')),
    'TIER_ORDER darf kein eigenes Array-Literal mehr sein.');
});

test('Canvas-Palette kennt jeden Typ (sonst faellt ein Knoten auf "andere")', async () => {
  const { TYP_COLOR, TIER_COLOR } = await import('../../public/js/graph/constants.js');
  for (const t of FIGUR_TYPEN) {
    assert.ok(TYP_COLOR[t], `TYP_COLOR fehlt "${t}"`);
    assert.ok(TIER_COLOR[t], `TIER_COLOR fehlt "${t}"`);
  }
});

test('Prompt-Enum und Sanitizer erlauben dieselben Typen', () => {
  // Das Modell darf nur liefern, was _sanitizeFigur auch durchlaesst — sonst
  // wird jede Antwort still auf "andere" normalisiert.
  const quellen = [
    'public/js/prompts/komplett/schema-strings.js',
    'public/js/prompts/komplett/konsolidierung.js',
  ];
  for (const q of quellen) {
    const m = read(q).match(/"typ":\s*"(hauptfigur[^"]*)"/);
    assert.ok(m, `${q}: kein Figuren-typ-Enum gefunden`);
    assert.deepEqual(m[1].split('|').sort(), [...FIGUR_TYPEN].sort(),
      `${q}: Prompt-Enum weicht von FIGUR_TYPEN ab`);
  }
});

test('jeder Typ hat ein Label in beiden Locales', () => {
  for (const loc of ['de', 'en']) {
    const dict = JSON.parse(read(`public/js/i18n/${loc}.json`));
    for (const t of FIGUR_TYPEN) {
      assert.ok(dict[`figuren.type.${t}`], `${loc}.json: figuren.type.${t} fehlt`);
    }
  }
});

test('kein Modul haelt eine zweite Rangliste der Figurentypen', () => {
  const erlaubt = new Set(['public/js/book/figur-typen.js']);
  const treffer = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      if (e === 'vendor') continue;
      const full = join(dir, e);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!e.endsWith('.js')) continue;
      const rel = full.slice(ROOT.length);
      if (erlaubt.has(rel)) continue;
      const src = readFileSync(full, 'utf8');
      // Die alte Form: ein Objekt-Literal, das den Rang selbst durchnummeriert.
      if (/hauptfigur\s*:\s*0\b/.test(src)) treffer.push(`${rel} (TYP_ORDER-Objekt)`);
      // Die andere Form: ein Array-Literal mit allen sechs Keys in Reihenfolge.
      const arr = new RegExp(FIGUR_TYPEN.map(t => `'${t}'`).join(",\\s*"));
      if (arr.test(src)) treffer.push(`${rel} (Array-Literal)`);
    }
  };
  walk(join(ROOT, 'public', 'js'));
  assert.deepEqual(treffer, [],
    'Rangliste gehoert nach public/js/book/figur-typen.js:\n  ' + treffer.join('\n  '));
});
