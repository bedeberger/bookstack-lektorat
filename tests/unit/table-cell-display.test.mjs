// Tripwire: eine Tabellenzelle bleibt eine Tabellenzelle.
//
// Setzt man einer Klasse, die im Markup an einem <td>/<th> haengt, im CSS ein
// `display: flex|grid|block|…`, verliert die Zelle ihre Tabellenzellen-Rolle:
// der Browser schiebt eine anonyme Zelle darum, und ab da laufen Rahmen,
// Hintergrund, Zeilenhoehe und `vertical-align` der Spalte nicht mehr mit der
// Zeile mit, sondern nur noch mit dem Inhalt. Die Zelle sitzt dann sichtbar
// versetzt neben ihrer eigenen Zeile — am auffaelligsten bei einer Aktions-
// Spalte mit Rahmen/Hintergrund (sticky), am unauffaelligsten bei einer Zelle
// ohne eigene Flaeche, wo es nur die Ausrichtung verzieht.
//
// Der Fehler ist im Code unsichtbar: HTML und CSS sind je fuer sich korrekt,
// erst ihre Kombination bricht das Layout. Keiner der uebrigen Gates sieht das
// — der Smoke-Test prueft nur auf JS-Fehler, LOC/Dedup/Spacing sehen keine
// CSS-vs-HTML-Semantik.
//
// Der Weg ist stattdessen ein eigener Kasten IN der Zelle (siehe DESIGN.md →
// „Aktions-Spalte in Tabellen"): `<td class="x"><div class="x-row">…</div></td>`
// mit dem Flexbox auf dem Wrapper.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const PARTIALS_DIR = join(REPO_ROOT, 'public', 'partials');
const INDEX_HTML = join(REPO_ROOT, 'public', 'index.html');
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

// `display`-Werte, die die Zellen-Rolle aufgeben. `none` (Spalte ausblenden)
// und `table-cell` (Rueckkehr zur Rolle, z.B. nach einem Mobile-Stack) sind
// bewusst erlaubt.
const ROLE_BREAKING = new Set([
  'flex', 'inline-flex', 'grid', 'inline-grid',
  'block', 'inline-block', 'inline', 'flow-root', 'contents',
]);

// Klassennamen aus dem Markup, getrennt nach „haengt an <td>/<th>" und „haengt
// an irgendetwas anderem". Nur Klassen, die AUSSCHLIESSLICH an Zellen
// vorkommen, sind eindeutig zuzuordnen — eine Klasse wie `.card-section`, die
// auch an einem <div> lebt, darf selbstverstaendlich Flexbox bekommen.
function collectCellClasses() {
  const cell = new Set();
  const other = new Set();
  const files = [...walk(PARTIALS_DIR, '.html'), INDEX_HTML];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const tagRe = /<([a-zA-Z][\w-]*)((?:[^<>"']|"[^"]*"|'[^']*')*?)\/?>/g;
    let m;
    while ((m = tagRe.exec(src)) !== null) {
      const tag = m[1].toLowerCase();
      const attrs = m[2];
      const cm = /(?:^|\s)class="([^"]*)"/.exec(attrs);
      if (!cm) continue;
      const bucket = (tag === 'td' || tag === 'th') ? cell : other;
      // Alpine-Ausdruecke (:class) stehen in einem eigenen Attribut und werden
      // hier nicht gelesen — statische Klassen reichen fuer den Zellen-Nachweis.
      for (const cls of cm[1].split(/\s+/)) {
        if (/^[A-Za-z][\w-]*$/.test(cls)) bucket.add(cls);
      }
    }
  }
  for (const cls of other) cell.delete(cls);
  return cell;
}

test('Tabellenzellen behalten ihre Zellen-Rolle: kein display:flex/grid/block auf einer <td>/<th>-Klasse', () => {
  const cellClasses = collectCellClasses();
  assert.ok(cellClasses.size > 20,
    `Erwartet: Klassen an <td>/<th> gefunden. Gefunden: ${cellClasses.size} — Scanner defekt?`);

  const violations = [];
  for (const file of walk(CSS_DIR, '.css')) {
    const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    // Regel-Bloecke ohne verschachtelte Klammern — trifft auch Regeln INNERHALB
    // von @media/@layer, weil deren innere Bloecke selbst klammerfrei sind.
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = ruleRe.exec(css)) !== null) {
      const dm = /(?:^|[;\s])display:\s*([a-z-]+)/.exec(m[2]);
      if (!dm || !ROLE_BREAKING.has(dm[1])) continue;
      for (const part of m[1].split(',')) {
        const selector = part.trim();
        // Nur der rechteste Compound zaehlt: `.zelle .knopf { display:flex }`
        // stylt den Knopf, nicht die Zelle.
        const base = selector.split(/[\s>+~]+/).filter(Boolean).pop() || '';
        const cm = /^\.([A-Za-z][\w-]*)$/.exec(base);
        if (!cm || !cellClasses.has(cm[1])) continue;
        const line = css.slice(0, m.index).split('\n').length;
        violations.push(`${rel(file)}:${line} — "${selector}" setzt display:${dm[1]} auf eine <td>/<th>-Klasse`);
      }
    }
  }

  assert.deepEqual(violations, [],
    `Zellen-Rolle verloren:\n  ${violations.join('\n  ')}\n\n` +
    'Fix: display:* auf einen Wrapper IN der Zelle legen ' +
    '(<td class="x"><div class="x-row">…</div></td>), Zelle selbst unangetastet lassen. ' +
    'Siehe DESIGN.md → "Aktions-Spalte in Tabellen".');
});
