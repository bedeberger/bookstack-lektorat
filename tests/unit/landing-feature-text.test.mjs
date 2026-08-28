// Feature-Text (Landing + Hilfe) — Laengenrahmen aus DESIGN.md „Feature-Text
// (Landing + Hilfe)".
//
// Die Keys `landing.feat<N>Title/Desc` stehen als Kacheln in einem Raster —
// auf der oeffentlichen Landing-Page und im Hilfe-Reiter „Funktionen"
// ([help-card.js](public/js/cards/help-card.js)#HELP_FEATURES). Ein
// 700-Zeichen-Block neben einem 80-Zeichen-Block laesst das Raster zerfallen
// und die kurz beschriebenen Features nebensaechlich wirken. Der Rahmen driftet
// ohne Gate zuverlaessig auseinander: jedes neue Feature wirkt beim Schreiben
// erklaerungsbeduerftiger als das davor.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const I18N = path.join(ROOT, 'public', 'js', 'i18n');
const HELP_CARD = path.join(ROOT, 'public', 'js', 'cards', 'help-card.js');

const TITLE_MAX = 26;
const DESC_MIN = 160;
const DESC_MAX = 200;

const locales = Object.fromEntries(['de', 'en'].map(l =>
  [l, JSON.parse(fs.readFileSync(path.join(I18N, `${l}.json`), 'utf8'))]));

/** Die im Hilfe-Reiter gelisteten Nummern — SSoT ist HELP_FEATURES. */
function helpFeatureNumbers() {
  const src = fs.readFileSync(HELP_CARD, 'utf8');
  const m = src.match(/const HELP_FEATURES = \[([^\]]*)\]/);
  assert.ok(m, 'HELP_FEATURES nicht gefunden — Konstante umbenannt?');
  return m[1].split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n));
}

const numbers = helpFeatureNumbers();

test('Feature-Text: HELP_FEATURES ist lueckenlos ab 1', () => {
  assert.deepEqual(numbers, numbers.map((_, i) => i + 1),
    'HELP_FEATURES muss 1..N in Reihenfolge listen (Nummern nie umnummerieren)');
});

test('Feature-Text: jede Nummer hat Titel + Beschreibung in beiden Locales', () => {
  for (const n of numbers) {
    for (const [loc, dict] of Object.entries(locales)) {
      assert.ok(dict[`landing.feat${n}Title`], `${loc}: landing.feat${n}Title fehlt`);
      assert.ok(dict[`landing.feat${n}Desc`], `${loc}: landing.feat${n}Desc fehlt`);
    }
  }
});

test(`Feature-Text: Titel hoechstens ${TITLE_MAX} Zeichen`, () => {
  const bad = [];
  for (const n of numbers) {
    for (const [loc, dict] of Object.entries(locales)) {
      const v = dict[`landing.feat${n}Title`] || '';
      if (v.length > TITLE_MAX) bad.push(`${loc} feat${n} (${v.length}): ${v}`);
    }
  }
  assert.deepEqual(bad, [], `Titel zu lang (max ${TITLE_MAX}, 1–3 Woerter):\n${bad.join('\n')}`);
});

test(`Feature-Text: Beschreibung ${DESC_MIN}–${DESC_MAX} Zeichen`, () => {
  const bad = [];
  for (const n of numbers) {
    for (const [loc, dict] of Object.entries(locales)) {
      const v = dict[`landing.feat${n}Desc`] || '';
      if (v.length < DESC_MIN || v.length > DESC_MAX) bad.push(`${loc} feat${n}: ${v.length} Zeichen`);
    }
  }
  assert.deepEqual(bad, [], `Beschreibung ausserhalb ${DESC_MIN}–${DESC_MAX}:\n${bad.join('\n')}`);
});

test('Feature-Text: Landing-Page rendert einen Prefix von HELP_FEATURES', () => {
  // Die Landing-Page zeigt bewusst nur die ersten Kacheln (kuratierter
  // Einstieg), die Hilfe alle. Sie muessen aber dieselben Keys in derselben
  // Reihenfolge nutzen — sonst zeigt die Landing ein Feature, das die Hilfe
  // nicht kennt, oder eine andere Reihenfolge.
  const html = fs.readFileSync(path.join(ROOT, 'public', 'landing.html'), 'utf8');
  const rendered = [...html.matchAll(/\{\{feat(\d+)Title\}\}/g)].map(m => Number(m[1]));
  assert.ok(rendered.length > 0, 'landing.html rendert keinen Feature-Block');
  assert.deepEqual(rendered, numbers.slice(0, rendered.length),
    'landing.html und HELP_FEATURES zeigen nicht dieselben Features in derselben Reihenfolge');
});
