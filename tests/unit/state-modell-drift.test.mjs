// Drift guard: docs/state-modell.md MUSS mit public/js/app/app-state.js matchen.
//
// CLAUDE.md erklaert die Doku zur "verbindlichen, drift-gepflegten SSoT" fuer die
// gesamte Alpine-State-Architektur und verlangt das Update im selben Commit.
// Bisher war das nur Prosa: alle uebrigen SSoT-Dokumente haben ein Gate
// (erd-drift, sw-manifest-drift, lektorat-typen-drift, textsorten-drift, ...),
// state-modell.md war das einzige ohne — und driftete entsprechend (Slice-Zahl
// stand auf 21 bei 16 Slices, ein nach $store.collab migrierter Slice stand
// weiter als lebender Root-Slice in der Tabelle).
//
// Geprueft wird die Slice-Schicht, weil sie maschinell entscheidbar ist:
//   1. Die Slice-Anzahl in der Prosa ("spreadet **N** Slice-Funktionen").
//   2. Set-Gleichheit: jeder von initialLektoratState() gespreadete Slice hat
//      eine LEBENDE Tabellenzeile, und jede lebende Zeile existiert im Code.
//   3. Durchgestrichene (~~migrierte~~) Zeilen duerfen NICHT mehr gespreadet
//      werden — sonst behauptet die Doku eine Migration, die nicht stattfand.
//
// Die Feld-Inhalte pro Zeile bleiben Prosa (Gruppierungen, Kommentare,
// Begruendungen) und sind nicht gegated — die Slice-Identitaet ist der Anker,
// an dem die Doku bisher gerissen ist.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const DOC = join(ROOT, 'docs', 'state-modell.md');
const STATE = join(ROOT, 'public', 'js', 'app', 'app-state.js');

/** Slices, die initialLektoratState() tatsaechlich spreadet — in Code-Reihenfolge. */
function codeSlices(src) {
  const start = src.indexOf('export function initialLektoratState');
  assert.notEqual(start, -1, 'initialLektoratState() nicht in app-state.js gefunden.');
  const body = src.slice(start);
  return [...body.matchAll(/\.\.\.(\w+)\(\)/g)].map(m => m[1]);
}

/** Die Slice-Tabelle der Doku: lebende vs. als migriert durchgestrichene Zeilen. */
function docSlices(md) {
  const live = new Set();
  const struck = new Set();
  for (const line of md.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cell = line.split('|')[1];
    if (cell === undefined) continue;
    const label = cell.trim();
    if (!label || label === 'Slice' || /^-+$/.test(label)) continue;
    // Eine Zelle kann mehrere Slices nennen: `a` / `b` bzw. ~~`a` / `b`~~.
    const names = [...label.matchAll(/`(\w+State)`/g)].map(m => m[1]);
    if (!names.length) continue;
    const isStruck = label.includes('~~');
    for (const n of names) (isStruck ? struck : live).add(n);
  }
  return { live, struck };
}

/** Die in der Prosa behauptete Slice-Anzahl. Bold darf die Zahl allein oder
 *  samt Wort umfassen (`**16** Slice-Funktionen` / `**16 Slice-Funktionen**`). */
function docSliceCount(md) {
  const m = md.match(/spreadet\s+\*\*(\d+)(?:\*\*)?\s+Slice-Funktionen/);
  return m ? Number(m[1]) : null;
}

const md = readFileSync(DOC, 'utf8');
const src = readFileSync(STATE, 'utf8');
const slices = codeSlices(src);

test('state-modell.md: behauptete Slice-Anzahl matcht app-state.js', () => {
  const claimed = docSliceCount(md);
  assert.notEqual(
    claimed, null,
    'Satz "spreadet **N** Slice-Funktionen" fehlt in docs/state-modell.md — das Gate braucht ihn als Anker.'
  );
  assert.equal(
    claimed, slices.length,
    `docs/state-modell.md behauptet ${claimed} Slices, initialLektoratState() spreadet ${slices.length}. `
    + 'Zahl im Satz ueber der Tabelle nachziehen.'
  );
});

test('state-modell.md: jeder Code-Slice hat eine lebende Tabellenzeile', () => {
  const { live, struck } = docSlices(md);
  const missing = slices.filter(s => !live.has(s));
  assert.deepEqual(
    missing, [],
    `Slices ohne lebende Zeile in der Slice-Tabelle: ${missing.join(', ')}. `
    + 'Neuer Slice → Zeile ergaenzen (Regel "Doku im selben Commit aktualisieren").'
  );
  // Ein Slice, der als migriert durchgestrichen ist, aber weiter gespreadet
  // wird: die Doku behauptet eine Migration, die nicht stattgefunden hat.
  const lying = slices.filter(s => struck.has(s));
  assert.deepEqual(
    lying, [],
    `Als migriert (~~durchgestrichen~~) dokumentiert, aber weiter von initialLektoratState() `
    + `gespreadet: ${lying.join(', ')}. Entweder Migration nachziehen oder Zeile reaktivieren.`
  );
});

test('state-modell.md: keine lebende Tabellenzeile ohne Code-Slice', () => {
  const { live } = docSlices(md);
  const set = new Set(slices);
  const stale = [...live].filter(s => !set.has(s));
  assert.deepEqual(
    stale, [],
    `Slice-Tabelle listet Slices, die app-state.js nicht mehr spreadet: ${stale.join(', ')}. `
    + 'Migrierten Slice ~~durchstreichen~~ + neues Zuhause nennen, nicht als lebenden Slice stehen lassen.'
  );
});
