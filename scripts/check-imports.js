#!/usr/bin/env node
'use strict';
// Import-Gate fuer public/js: findet Symbole, die ein Modul BENUTZT, aber nicht
// IMPORTIERT — der Fehler, der beim Aufteilen von Modulen entsteht (Symbol
// wandert in eine neue Datei, der Import bleibt zurueck). Im Browser schlaegt
// das erst zur Laufzeit zu, oft in einem selten betretenen Codepfad, und kommt
// darum typischerweise erst aus dem Prod-Error-Tracker zurueck.
//
// Verfahren: `tsc` einmal ueber public/js/tsconfig.check.json laufen lassen und
// AUSSCHLIESSLICH die Diagnosen TS2304 / TS2552 ("Cannot find name 'x'")
// auswerten. Alle uebrigen Typfehler (~1500, das Projekt ist nicht getypt)
// werden verworfen — das hier ist kein Typecheck und soll keiner werden.
// Echte Browser-Globals (Alpine, vis, Chart) stehen in public/js/_globals.d.ts.
//
// Exit 0 = keine fehlenden Imports. Exit 1 = Treffer oder Werkzeugfehler.

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PROJECT = path.join(ROOT, 'public', 'js', 'tsconfig.check.json');

// Genau die zwei Diagnosen fuer "Name existiert im Scope nicht": 2304 ohne,
// 2552 mit Namensvorschlag ("Did you mean 'writeNormalSnapshot'?"). TypeScript
// waehlt zwischen beiden je nachdem, ob ein aehnlicher Name in Reichweite ist —
// wer nur 2304 prueft, verliert genau die Faelle mit nahem Nachbarnamen.
const MISSING_NAME_CODES = /error TS(?:2304|2552):/;

let tscBin;
try {
  tscBin = require.resolve('typescript/bin/tsc');
} catch {
  console.error('[check-imports] typescript nicht gefunden — devDependencies fehlen. Fix: npm ci');
  process.exit(1);
}

const res = spawnSync(process.execPath, [tscBin, '-p', PROJECT, '--pretty', 'false'], {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});

if (res.error) {
  console.error(`[check-imports] tsc liess sich nicht starten: ${res.error.message}`);
  process.exit(1);
}

const lines = `${res.stdout || ''}${res.stderr || ''}`.split('\n');

// Konfigurationsfehler (TS5xxx/TS6xxx) melden sich ohne Datei-Prefix und wuerden
// sonst als "keine Treffer" durchgehen — dann prueft das Gate stillschweigend
// nichts mehr.
const configErrors = lines.filter(l => /^error TS/.test(l));
if (configErrors.length) {
  console.error('[check-imports] tsc-Konfigurationsfehler — das Gate hat NICHTS geprueft:');
  for (const l of configErrors) console.error(`  ${l}`);
  process.exit(1);
}

const hits = lines.filter(l => MISSING_NAME_CODES.test(l));
if (hits.length) {
  console.error(`[check-imports] ${hits.length} benutzte(s) Symbol(e) ohne Import in public/js:\n`);
  for (const l of hits) console.error(`  ${l}`);
  console.error('\nFix: fehlenden Import ergaenzen. Ist das Symbol wirklich ein Browser-Global,');
  console.error('gehoert es nach public/js/_globals.d.ts — aber nur dann.');
  process.exit(1);
}

console.log('[check-imports] OK — keine fehlenden Imports in public/js.');
