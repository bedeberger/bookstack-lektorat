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

function walkAll(dirs, ext) {
  const out = [];
  for (const d of dirs) walk(d, ext, out);
  return out;
}

function loc(file) {
  const src = readFileSync(file, 'utf8');
  if (src === '') return 0;
  const lines = src.split('\n');
  // Schluss-Newline erzeugt ein leeres Trail-Element → wie `wc -l` abziehen.
  return src.endsWith('\n') ? lines.length - 1 : lines.length;
}

// Eine Kategorie: Verzeichnis(se) + Extension + Cap + gepinnte Altlasten.
// Ceiling-Werte = aktueller Stand (Ratsche: nur runter, nie rauf).
// `exclude` nimmt Dateien ganz aus der Pruefung — nur fuer solche, bei denen
// Wachstum in der Natur der Sache liegt (siehe Begruendung am Eintrag).
const CATEGORIES = [
  {
    label: 'JS-Modul',
    dir: join(REPO_ROOT, 'public', 'js'),
    ext: '.js',
    cap: 600,
    allow: {
      'public/js/share-reader.js': 658,
    },
  },
  {
    label: 'HTML-Partial',
    dir: join(REPO_ROOT, 'public', 'partials'),
    ext: '.html',
    cap: 250,
    allow: {
      'public/partials/admin-usage.html': 452,
      'public/partials/figur-werkstatt.html': 406,
      'public/partials/figuren.html': 377,
      'public/partials/book-editor.html': 358,
      'public/partials/admin-users.html': 351,
      'public/partials/epub-export.html': 321,
      'public/partials/plot-board-grid.html': 321,
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
  // Server-Code stand lange ausserhalb jeder LOC-Pruefung — der Cap aus
  // CLAUDE.md gilt aber fuer JS-Module, nicht fuer Browser-JS-Module. Die
  // Ratsche zieht die Altlasten darum ab hier ebenfalls nur nach unten.
  {
    label: 'Server-Modul',
    dirs: [join(REPO_ROOT, 'lib'), join(REPO_ROOT, 'routes'), join(REPO_ROOT, 'db')],
    ext: '.js',
    cap: 600,
    exclude: [
      // Append-only Historie: JEDE neue Migration verlaengert die Datei, ein
      // Ceiling waere bei jedem Schema-Schritt rot. Der Split waere zudem
      // sinnlos — die Reihenfolge der if-version-Bloecke IST die Struktur.
      'db/migrations.js',
    ],
    allow: {
      'lib/export-builders/docx.js': 813,
      'lib/page-index.js': 692,
      'lib/content-store/backends/localdb.js': 635,
      'lib/mailer-templates.js': 626,
      'routes/jobs/komplett/phases/extraktion.js': 932,
      'routes/jobs/book-chat-tools/tools-catalog.js': 721,
      'routes/figures.js': 715,
      'routes/snapshots.js': 655,
      'routes/usersettings.js': 641,
      'routes/jobs/book-chat-tools/tools-text.js': 646,
      'routes/share/reader.js': 623,
      'routes/jobs/lektorat.js': 605,
      'db/plot.js': 942,
    },
  },
];

for (const cat of CATEGORIES) {
  test(`${cat.label}: keine neuen Dateien ueber ${cat.cap} LOC + Altlasten-Ratsche`, () => {
    const files = cat.dirs ? walkAll(cat.dirs, cat.ext) : walk(cat.dir, cat.ext);
    const excluded = new Set(cat.exclude || []);
    const violations = [];
    const seen = new Set();

    for (const file of files) {
      const r = rel(file);
      if (excluded.has(r)) continue;
      const n = loc(file);
      if (Object.prototype.hasOwnProperty.call(cat.allow, r)) {
        seen.add(r);
        const ceiling = cat.allow[r];
        if (n > ceiling) {
          violations.push(
            `${r}: ${n} LOC > gepinntes Ceiling ${ceiling} — Altlast darf nur schrumpfen. ` +
              `Datei splitten (Eintrag dann streichen) oder kuerzen.`,
          );
        } else if (n <= cat.cap) {
          // Regel 3 fuer die haeufigste Form: die Datei liegt noch da, ist aber
          // unter den Cap geschrumpft. Ohne diesen Zweig griff die Regel nur bei
          // GELOESCHTEN Dateien (die Stale-Schleife unten sieht gewalkte Dateien
          // nie) — ein erfolgreicher Split liess seinen Eintrag also still
          // stehen, und die Datei durfte danach unbemerkt bis zum alten Ceiling
          // zurueckwachsen.
          violations.push(
            `${r}: nur noch ${n} LOC (<= ${cat.cap}-Cap) — Allowlist-Eintrag entfernen, ` +
              `damit die Datei den normalen Cap nicht mehr ueberschreiten darf.`,
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
