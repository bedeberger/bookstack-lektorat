// Drift-Guard: Die Event-Subtyp-Whitelist steht an FUENF Orten, und ein neuer
// Subtyp faellt an jedem einzelnen anders durch:
//   1. KI-Vertrag      public/js/prompts/komplett/schemas.js#EVENT_SUBTYP_ENUM
//   2. Persistenz-Gate db/event-subtyp.js#EVENT_SUBTYP_WL — fehlt er hier,
//      mappt der Save gueltige KI-Subtypen still auf 'sonstiges'
//   3. Icon-Map        public/js/cards/ereignisse/subtyp.js — fehlt er, traegt
//      das Badge stumm das Sammel-Icon
//   4. Farb-Token      public/css/tokens/colors.css (--card-accent-event-<key>,
//      Light UND Dark) + Mapping in css/entities/ereignisse-subtyp.css — fehlt
//      er, faellt der Marker auf eine leere Custom-Prop zurueck
//   5. i18n            events.subtyp.<key> in BEIDEN Locales — fehlt er, steht
//      der rohe Key im Badge und in der Filter-Combobox
// Nur 1+2 waren gegated; 3–5 scheitern lautlos, weil ueberall ein Fallback greift.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

import { EVENT_SUBTYP_ENUM } from '../../public/js/prompts/komplett/schemas.js';
import { SUBTYP_ICON } from '../../public/js/cards/ereignisse/subtyp.js';

const require = createRequire(import.meta.url);
const { EVENT_SUBTYP_WL } = require('../../db/event-subtyp.js');

const readRepo = (rel) => readFileSync(new URL('../../' + rel, import.meta.url), 'utf8');

test('Event-Subtyp-Whitelist: Prompt-Enum == DB-Whitelist (keine Drift)', () => {
  const promptSet = new Set(EVENT_SUBTYP_ENUM);
  const dbSet = EVENT_SUBTYP_WL;

  const fehltInDb = [...promptSet].filter(v => !dbSet.has(v));
  const fehltImPrompt = [...dbSet].filter(v => !promptSet.has(v));

  assert.deepEqual(fehltInDb, [], `Im Prompt, aber nicht in db/event-subtyp.js: ${fehltInDb.join(', ')}`);
  assert.deepEqual(fehltImPrompt, [], `In db/event-subtyp.js, aber nicht im Prompt: ${fehltImPrompt.join(', ')}`);
  assert.equal(promptSet.size, dbSet.size);
});

test('Event-Subtyp: jeder Subtyp hat ein Icon', () => {
  const fehlt = EVENT_SUBTYP_ENUM.filter(v => !SUBTYP_ICON[v]);
  assert.deepEqual(fehlt, [], `Ohne Eintrag in SUBTYP_ICON: ${fehlt.join(', ')}`);
  const zuviel = Object.keys(SUBTYP_ICON).filter(v => !EVENT_SUBTYP_ENUM.includes(v));
  assert.deepEqual(zuviel, [], `Icon fuer unbekannten Subtyp: ${zuviel.join(', ')}`);
});

test('Event-Subtyp: jeder Subtyp hat eine Farbe (Token hell + dunkel + Mapping)', () => {
  const tokens = readRepo('public/css/tokens/colors.css');
  const mapping = readRepo('public/css/entities/ereignisse-subtyp.css');
  const ohneBase = EVENT_SUBTYP_ENUM.filter(v => !tokens.includes(`--card-accent-event-${v}-base:`));
  assert.deepEqual(ohneBase, [], `Kein Light-Hue in tokens/colors.css: ${ohneBase.join(', ')}`);
  // Der Dark-Wert wird per OKLCH aus dem Base abgeleitet — eine eigene Zeile
  // pro Subtyp; ohne sie bleibt der Marker im Dunkelmodus auf der Hellfarbe.
  const ohneDark = EVENT_SUBTYP_ENUM.filter(
    v => !tokens.includes(`--card-accent-event-${v}: oklch(from var(--card-accent-event-${v}-base)`));
  assert.deepEqual(ohneDark, [], `Keine Dark-Ableitung in tokens/colors.css: ${ohneDark.join(', ')}`);
  const ohneKlasse = EVENT_SUBTYP_ENUM.filter(v => !mapping.includes(`.gz-item--subtyp-${v}`));
  assert.deepEqual(ohneKlasse, [], `Keine Variant-Klasse in ereignisse-subtyp.css: ${ohneKlasse.join(', ')}`);
});

test('Event-Subtyp: jeder Subtyp hat ein Label in beiden Locales', () => {
  for (const locale of ['de', 'en']) {
    const keys = JSON.parse(readRepo(`public/js/i18n/${locale}.json`));
    const fehlt = EVENT_SUBTYP_ENUM.filter(v => !keys[`events.subtyp.${v}`]);
    assert.deepEqual(fehlt, [], `events.subtyp.* fehlt in ${locale}.json: ${fehlt.join(', ')}`);
  }
});
