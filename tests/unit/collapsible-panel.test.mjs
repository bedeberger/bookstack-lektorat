// Gate für das `collapsible()`-Markup-Kontrakt (public/js/collapsible.js).
//
// `panel` ist `{ 'x-show': () => this.open }`. Sitzt der Spread auf DEMSELBEN
// Element wie `x-data="collapsible(…)"`, blendet das x-show den Container samt
// seinem eigenen Trigger aus — die zugeklappte Sektion ist dann unsichtbar UND
// unerreichbar. Genau das ist der Quellen-Bibliothekssuche einmal passiert; im
// Browser sieht es aus, als gaebe es das Feature nicht.
//
// Der Test ist bewusst statisch (Text über die Partials): die Verwechslung
// passiert beim Schreiben des Markups, nicht zur Laufzeit, und kein E2E-Test
// klickt jede klappbare Sektion der App durch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PARTIALS = new URL('../../public/partials/', import.meta.url).pathname;

/** Öffnende Tags eines Partials, grob aber ausreichend: wir brauchen nur die
 *  Attribut-Liste EINES Elements am Stück. */
function openingTags(html) {
  return html.match(/<[a-zA-Z][^>]*>/g) || [];
}

const files = readdirSync(PARTIALS).filter(f => f.endsWith('.html'));

test('kein x-bind="panel" auf dem x-data="collapsible"-Element selbst', () => {
  const offenders = [];
  for (const f of files) {
    const html = readFileSync(join(PARTIALS, f), 'utf8');
    for (const tag of openingTags(html)) {
      if (!/x-data\s*=\s*"collapsible\s*\(/.test(tag)) continue;
      if (/x-bind\s*=\s*"panel"/.test(tag)) {
        offenders.push(`${f}: ${tag.slice(0, 120)}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    'x-bind="panel" gehoert an ein KIND des collapsible-Containers — auf dem '
    + 'x-data-Element blendet es den Trigger mit aus:\n' + offenders.join('\n'));
});

test('jede collapsible-Instanz hat einen Trigger und einen aufklappbaren Teil', () => {
  const missing = [];
  for (const f of files) {
    const html = readFileSync(join(PARTIALS, f), 'utf8');
    const instances = (html.match(/x-data\s*=\s*"collapsible\s*\(/g) || []).length;
    if (!instances) continue;
    const hasTrigger = /x-bind\s*=\s*"trigger"/.test(html);
    // Zwei zulaessige Panel-Formen: der `panel`-Spread (Regelfall) oder ein
    // `x-if`/`x-show` auf `open` mit Zusatzbedingung (z.B. figuren-graph-legend,
    // die zusaetzlich am Graph-Modus haengt).
    const hasPanel = /x-bind\s*=\s*"panel"/.test(html)
      || /x-(if|show)\s*=\s*"[^"]*\bopen\b/.test(html);
    // Fragment-Includes koennen Trigger und Panel trennen; darum nur „fehlt
    // komplett" melden, nicht Gleichheit der Anzahl verlangen.
    if (!hasTrigger || !hasPanel) {
      missing.push(`${f} (${instances} Instanz(en), trigger=${hasTrigger}, panel=${hasPanel})`);
    }
  }
  assert.deepEqual(missing, [],
    'collapsible ohne Trigger oder ohne aufklappbaren Teil — die Sektion laesst '
    + 'sich nicht auf- bzw. zuklappen:\n' + missing.join('\n'));
});
