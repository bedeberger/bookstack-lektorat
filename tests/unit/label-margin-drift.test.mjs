// Tripwire fuer die Mittellinien-Invariante aus DESIGN.md ("Filter-Leiste" →
// Mittellinien-Invariante): ein Control in einer Zeile mit `align-items: center`
// darf keine einseitige vertikale Margin tragen. Flex zentriert die AUSSENbox —
// eine Margin nur unten kippt die sichtbare Box um die halbe Margin gegen die
// Mittellinie der Nachbarn. Bei 6px sind das 3px: sichtbar als "nicht
// zentriert", per Augenmass aber nicht als Margin erkennbar.
//
// Haupt-Einfallstor ist die globale `label`-Regel: sie gilt fuer JEDES Label der
// App, also auch fuer Toggle-Labels in Filterleisten und Inline-Feldern. Traegt
// sie eine Bottom-Margin, kippen alle diese Zeilen gleichzeitig — genau der
// Zustand, der einmal in der Quellen-Filterleiste aufgefallen ist. Vertikale
// Abstaende kommen darum ausschliesslich aus dem `gap` des Containers; ein Label
// als Block-Ueberschrift setzt seinen Abstand lokal in seiner eigenen Klasse.
//
// Prosa-Regel = Vorschlag, Test = Gesetz. Neuer Verstoss → CI rot.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const CSS_DIR = join(REPO_ROOT, 'public', 'css');
const rel = (p) => relative(REPO_ROOT, p);

function walk(dir, ext, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, ext, out);
    else if (entry.endsWith(ext)) out.push(full);
  }
  return out;
}

// Kommentare weg, damit erklaerende Prosa (die die verbotenen Properties nennt)
// nicht als Deklaration zaehlt.
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

// Alle Regelbloecke als { selector, body } — flach, At-Rules interessieren hier
// nicht (ein `@media`-Block aendert die Invariante nicht).
function ruleBlocks(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const selector = m[1].trim().replace(/\s+/g, ' ');
    if (!selector || selector.startsWith('@')) continue;
    out.push({ selector, body: m[2] });
  }
  return out;
}

const declValue = (body, prop) => {
  const m = body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i'));
  return m ? m[1].trim() : null;
};

// ───────────────────────────────────────────────────────────
// REGEL: die globale `label`-Regel traegt keine vertikale Margin
// ───────────────────────────────────────────────────────────
// Nackter Typ-Selektor `label` (kein Klassen-/Nachfahren-Kontext) trifft die
// ganze App. Eine Klasse (`.filter-toggle`) oder ein Nachfahren-Selektor
// (`.admin-usage-range label`) darf das lokal entscheiden — nur die globale
// Voreinstellung darf es nicht.
test('globale label-Regel setzt keine vertikale Margin', () => {
  const offenders = [];
  for (const file of walk(CSS_DIR, '.css')) {
    const css = stripComments(readFileSync(file, 'utf8'));
    for (const { selector, body } of ruleBlocks(css)) {
      const isGlobalLabel = selector.split(',').some((s) => s.trim() === 'label');
      if (!isGlobalLabel) continue;
      for (const prop of ['margin-bottom', 'margin-top', 'margin-block-start', 'margin-block-end']) {
        const v = declValue(body, prop);
        if (v && !/^0(\D|$)/.test(v)) offenders.push(`${rel(file)}: label { ${prop}: ${v} }`);
      }
      const margin = declValue(body, 'margin');
      if (margin && !/^0(\D|$)/.test(margin)) offenders.push(`${rel(file)}: label { margin: ${margin} }`);
    }
  }
  assert.deepEqual(
    offenders, [],
    'Die globale `label`-Regel darf keine vertikale Margin setzen — sie kippt jedes '
    + 'Toggle-/Inline-Label in einer `align-items: center`-Zeile um die halbe Margin '
    + 'nach oben (Filterleisten, .form-inline, .export-profile-bar). Abstand gehoert '
    + 'ins `gap` des Containers; Block-Ueberschriften setzen ihn lokal in ihrer '
    + `eigenen Klasse. Verstoesse:\n  ${offenders.join('\n  ')}`,
  );
});

// ───────────────────────────────────────────────────────────
// REGEL: bekannte Zeilen-Bausteine bleiben vertikal symmetrisch
// ───────────────────────────────────────────────────────────
// Diese Klassen sind Glieder einer zentrierten Zeile (Filterleiste, Inline-Feld,
// Profil-Leiste). Eine einseitige vertikale Margin/Padding an ihnen ist derselbe
// Fehler wie an der globalen Regel, nur lokal.
const ROW_MEMBERS = ['.filter-toggle', '.filter-count', '.form-inline-field', '.filter-search-wrap'];

test('Zeilen-Bausteine zentrierter Leisten tragen keine einseitige vertikale Margin', () => {
  const offenders = [];
  for (const file of walk(CSS_DIR, '.css')) {
    const css = stripComments(readFileSync(file, 'utf8'));
    for (const { selector, body } of ruleBlocks(css)) {
      // Nur Regeln, deren letztes Glied genau dieser Baustein ist (nicht
      // `.filter-toggle input`, das ist ein Kind).
      const targets = selector.split(',').map((s) => s.trim()).filter((s) => ROW_MEMBERS.includes(s.split(' ').pop().split('>').pop().trim()));
      if (!targets.length) continue;
      const mt = declValue(body, 'margin-top');
      const mb = declValue(body, 'margin-bottom');
      const num = (v) => (v == null ? null : parseFloat(v));
      if ((mt == null) !== (mb == null) && (num(mt) || num(mb))) {
        offenders.push(`${rel(file)}: ${selector} { margin-top: ${mt}; margin-bottom: ${mb} }`);
      } else if (mt != null && mb != null && mt !== mb) {
        offenders.push(`${rel(file)}: ${selector} { margin-top: ${mt}; margin-bottom: ${mb} }`);
      }
    }
  }
  assert.deepEqual(
    offenders, [],
    'Einseitige vertikale Margin an einem Glied einer zentrierten Leiste kippt es '
    + `gegen die Mittellinie der Nachbarn. Verstoesse:\n  ${offenders.join('\n  ')}`,
  );
});
