// Maschinell durchgesetzte LOC-Limits aus CLAUDE.md ("File-Limits / Modularitaet"):
//   JS-Module > 600 LOC, HTML-Partials > 250 LOC, CSS-Files > 600 LOC werden
//   gesplittet. Bisher war das nur Prosa und driftete unter Kontextdruck.
//
// Modell: globaler Hard-Cap pro Kategorie + ALLOWLIST der bestehenden Ueberschreiter
// als Ratschen-Ceiling (Grandfathering). Regeln, die der Test erzwingt:
//   1. Eine NEUE Datei ueber dem Cap, die nicht in der Allowlist steht → CI rot.
//   2. Eine allowlisted Datei, die ueber ihr gepinntes Ceiling waechst → CI rot
//      (Ratsche: Altlasten duerfen nur schrumpfen, nie wachsen).
//   3. Eine allowlisted Datei, die unter den Cap geschrumpft (oder geloescht) ist
//      → CI rot mit der Aufforderung, den Allowlist-Eintrag zu entfernen
//      (haelt die Liste ehrlich; ein Split soll den Eintrag mitnehmen).
//
// LOC == physische Zeilen (deckungsgleich mit `wc -l` bei Datei mit Schluss-Newline).
// Beim Split einer Datei: Eintrag hier ersatzlos streichen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const rel = (p) => relative(REPO_ROOT, p);

function walk(dir, ext, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'vendor') continue; // self-contained Libs, nicht unser Code
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, ext, out);
    else if (entry.endsWith(ext)) out.push(full);
  }
  return out;
}

function loc(file) {
  const src = readFileSync(file, 'utf8');
  if (src === '') return 0;
  const lines = src.split('\n');
  // Schluss-Newline erzeugt ein leeres Trail-Element → wie `wc -l` abziehen.
  return src.endsWith('\n') ? lines.length - 1 : lines.length;
}

// Eine Kategorie: Verzeichnis + Extension + Cap + gepinnte Altlasten.
// Ceiling-Werte = aktueller Stand (Ratsche: nur runter, nie rauf).
const CATEGORIES = [
  {
    label: 'JS-Modul',
    dir: join(REPO_ROOT, 'public', 'js'),
    ext: '.js',
    cap: 600,
    allow: {
      'public/js/cards/editor-spellcheck/controller.js': 752,
      'public/js/editor/notebook/stt-dictation.js': 769,
      'public/js/share-reader.js': 658,
    },
  },
  {
    label: 'HTML-Partial',
    dir: join(REPO_ROOT, 'public', 'partials'),
    ext: '.html',
    cap: 250,
    allow: {
      'public/partials/buchorganizer.html': 516,
      'public/partials/admin-usage.html': 452,
      'public/partials/recherche.html': 437,
      'public/partials/editor-notebook.html': 350,
      'public/partials/figur-werkstatt.html': 406,
      'public/partials/figuren.html': 377,
      'public/partials/book-editor.html': 358,
      'public/partials/admin-users.html': 351,
      'public/partials/epub-export.html': 321,
      'public/partials/plot-board-grid.html': 307,
      'public/partials/user-settings.html': 268,
      'public/partials/motiv-panel.html': 271,
      'public/partials/szenen.html': 273,
      'public/partials/orte.html': 277,
      'public/partials/finetune-export.html': 254,
    },
  },
  {
    label: 'CSS-File',
    dir: join(REPO_ROOT, 'public', 'css'),
    ext: '.css',
    cap: 600,
    allow: {
      'public/css/editor/book/book-editor.css': 674,
    },
  },
];

for (const cat of CATEGORIES) {
  test(`${cat.label}: keine neuen Dateien ueber ${cat.cap} LOC + Altlasten-Ratsche`, () => {
    const files = walk(cat.dir, cat.ext);
    const violations = [];
    const seen = new Set();

    for (const file of files) {
      const r = rel(file);
      const n = loc(file);
      if (Object.prototype.hasOwnProperty.call(cat.allow, r)) {
        seen.add(r);
        const ceiling = cat.allow[r];
        if (n > ceiling) {
          violations.push(
            `${r}: ${n} LOC > gepinntes Ceiling ${ceiling} — Altlast darf nur schrumpfen. ` +
              `Datei splitten (Eintrag dann streichen) oder kuerzen.`,
          );
        }
      } else if (n > cat.cap) {
        violations.push(
          `${r}: ${n} LOC > ${cat.cap}-Cap — splitten in <name>/-Subfolder ` +
            `(siehe CLAUDE.md "File-Limits / Modularitaet").`,
        );
      }
    }

    // Stale-Allowlist: Eintrag existiert nicht mehr ueber dem Cap → raus damit.
    for (const r of Object.keys(cat.allow)) {
      if (seen.has(r)) continue;
      const full = join(REPO_ROOT, r);
      if (!existsSync(full)) {
        violations.push(`${r}: Allowlist-Eintrag verweist auf geloeschte Datei — Eintrag entfernen.`);
      } else {
        violations.push(
          `${r}: jetzt <= ${cat.cap} LOC (gesplittet/gekuerzt) — Allowlist-Eintrag entfernen, ` +
            `damit die Datei den normalen Cap nicht mehr ueberschreiten darf.`,
        );
      }
    }

    assert.equal(
      violations.length,
      0,
      `LOC-Limit-Verstoesse (${cat.label}):\n  ` + violations.join('\n  '),
    );
  });
}
