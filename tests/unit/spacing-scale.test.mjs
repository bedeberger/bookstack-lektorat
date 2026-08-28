// Ratsche fuer die Abstands-Skala aus CLAUDE.md ("Styles nur in public/css",
// DESIGN.md "Token-Pflicht" + "Karten-Innenraum"): Margins, Paddings und Gaps
// kommen aus `--space-*` / `--pad-*` / `--card-gap-*`, nicht als roher rem-/px-
// Wert.
//
// WARUM eine eigene Regel neben der Token-Prosa: Tokens allein garantieren
// keine gleiche Organisation — sie garantieren nur, dass ein willkuerlicher
// Abstand aus einer Liste von 16 gewaehlt wird. Aber ein roher Wert ist die
// Vorstufe davon: neben der 16-stufigen Skala standen einmal 25 verschiedene
// rem- und 24 verschiedene px-Werte, `0.7rem` (11,2 px) und `0.9rem` (14,4 px)
// darunter — Werte, die auf keiner Rasterstufe liegen und darum in KEINER
// Nachbarkarte wieder auftauchen koennen. Wer sie duldet, hat de facto keine
// Skala mehr.
//
// Modell wie loc-limits.test.mjs: harte Regel + Allowlist der bestehenden
// Ueberschreiter als Ratschen-Ceiling. Neue Datei mit rohem Wert -> CI rot;
// allowlisted Datei waechst -> CI rot; Datei ist sauber geworden -> CI rot mit
// der Aufforderung, den Eintrag zu streichen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const CSS_DIR = join(REPO_ROOT, 'public', 'css');
const rel = (p) => relative(join(REPO_ROOT, 'public'), p).split('\\').join('/');

// Ausgenommene Pfade — mit Begruendung, nicht als Sammelbecken:
//   share/*            eigenes Token-Set (--share-*), bewusste Kopie fuer den
//                      pre-auth Reader-Modulgraph (siehe docs/share-link.md).
//   Lesesatz-Dateien   Manuskript-Typografie rechnet in em/rem relativ zum
//                      Leserhythmus, nicht im 4-px-UI-Raster.
//   landing.css        eigenstaendige Marketing-Seite ausserhalb der App-Shell.
const EXCLUDED = [
  'css/share/',
  'css/share.css',
  'css/components/manuscript-content.css',
  'css/components/manuscript-stream.css',
  'css/editor/focus/',
  'css/page/page-revision-viewer.css',
  'css/page/page-view.css',
  'css/landing.css',
];

// Bestehende Ueberschreiter: Zahl = aktueller Stand (Ratsche, nur runter).
// Es sind durchweg GEOMETRIE-Werte (Control-Hoehen, Icon-Freiraum, Dock-Breiten),
// die auf keiner Abstands-Stufe liegen sollen — kein Abstand zwischen Elementen.
// Trotzdem gepinnt statt pauschal erlaubt: sonst waere jeder neue rohe Wert in
// diesen Dateien unsichtbar.
const ALLOW = {
  'css/analysis/zeitleiste.css': 3,
  'css/chat.css': 1,
  'css/components/card-form/card-blocks.css': 1,
  'css/components/card-form/form-elements.css': 1,
  'css/components/comment-rail.css': 1,
  'css/components/icon-btn.css': 1,
  'css/editor/book/book-editor.css': 2,
  'css/editor/notebook/page-head.css': 2,
  'css/entities/figuren.css': 1,
  'css/entities/ideen.css': 1,
  'css/entities/szenen.css': 4,
  'css/layout/base.css': 3,
  'css/page/page-content-skeleton.css': 1,
  'css/page/stt-dock.css': 1,
  'css/page/tagebuch-rueckblick.css': 1,
  'css/page/tts-dock.css': 1,
  'css/search.css': 4,
  'css/tokens-est.css': 2,
};

// `em` bewusst NICHT geprueft: es ist schriftgroessen-relativ und gehoert damit
// zur typografischen, nicht zur Raster-Skala (`padding: 0.25em` skaliert mit
// dem Badge-Text mit, `padding: 4px` nicht). Das ist eine andere Entscheidung,
// kein Schlupfloch — wer ein `em` setzt, sagt „relativ zur Schrift".
const PROP_RE =
  /(?<![\w-])((?:row-|column-)?gap|margin|padding)(-(?:top|bottom|left|right|inline|block)(?:-(?:start|end))?)?(\s*:\s*)([^;{}]+);/g;
const VAL_RE = /(?<![\w.\-])(\d*\.?\d+)(rem|px)(?![\w-])/g;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'vendor') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.css')) out.push(full);
  }
  return out;
}

function rawSpacingValues(file) {
  // Kommentare zu Whitespace: ein auskommentiertes Beispiel zaehlt nicht.
  const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const hits = [];
  for (const m of src.matchAll(PROP_RE)) {
    for (const v of m[4].matchAll(VAL_RE)) {
      const line = src.slice(0, m.index).split('\n').length;
      hits.push(`Zeile ${line}: ${m[1]}${m[2] || ''}: … ${v[0]}`);
    }
  }
  return hits;
}

test('Abstaende kommen aus der Token-Skala (Ratsche fuer rohe rem-/px-Werte)', () => {
  const violations = [];
  const seen = new Set();

  for (const file of walk(CSS_DIR)) {
    const r = rel(file);
    if (EXCLUDED.some((e) => r.startsWith(e))) continue;
    const hits = rawSpacingValues(file);
    const ceiling = ALLOW[r];

    if (ceiling === undefined) {
      if (hits.length) {
        violations.push(
          `${r}: ${hits.length} roher Abstandswert — Token aus tokens/spacing.css nehmen ` +
            `(--space-* / --card-gap-*):\n      ` + hits.join('\n      '),
        );
      }
      continue;
    }

    seen.add(r);
    if (hits.length > ceiling) {
      violations.push(
        `${r}: ${hits.length} rohe Abstandswerte > gepinntes Ceiling ${ceiling} — ` +
          `Altlast darf nur schrumpfen:\n      ` + hits.join('\n      '),
      );
    } else if (hits.length < ceiling) {
      violations.push(
        `${r}: nur noch ${hits.length} statt ${ceiling} — Ceiling im Test nachziehen ` +
          `(oder Eintrag streichen, wenn 0), damit die Ratsche nicht zurueckfaellt.`,
      );
    }
  }

  for (const r of Object.keys(ALLOW)) {
    if (seen.has(r)) continue;
    const full = join(REPO_ROOT, 'public', r);
    violations.push(
      existsSync(full)
        ? `${r}: keine rohen Abstandswerte mehr — Allowlist-Eintrag entfernen.`
        : `${r}: Allowlist-Eintrag verweist auf geloeschte Datei — Eintrag entfernen.`,
    );
  }

  assert.equal(violations.length, 0, `Abstands-Skala verletzt:\n  ${violations.join('\n  ')}`);
});
