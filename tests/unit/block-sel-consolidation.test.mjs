// Blockselektor-Familien: ein Kern, vier bewusst verschiedene Ableitungen.
//
// WARUM DIESER TEST: die vier Selektoren hiessen alle `BLOCK_SEL`, hatten aber
// vier verschiedene Inhalte. Gleicher Name suggeriert Gleichheit, die nicht
// besteht — und genau deshalb griff `editor/focus/soft-newlines.js` zum
// Notebook-Selektor, während seine Nachbarmodule den Focus-Selektor nutzten,
// ohne dass es auffiel. Seit der Konsolidierung trägt jede Familie einen eigenen
// Namen und komponiert aus `TEXT_BLOCK_TAGS`. Dieser Test hält (a) den Kern in
// allen Familien fest und (b) die Unterschiede EXPLIZIT: wer eine Familie
// erweitert, muss die Erwartung hier mitziehen und trifft dabei auf die Frage,
// ob die anderen Familien denselben Zusatz brauchen.
//
// `share-reader/tts.js` ist der Sonderfall: der Reader ist ein eigenstaendiger,
// schlanker Modulgraph und darf nur aus `/js/share-reader/` importieren (sonst
// zieht die Leseansicht das App-Bundle), kann den Kern also nicht importieren.
// Seine Kopie wird hier gegen
// den Kern geprüft — als Quelltext, weil das Modul Browser-Globals braucht.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const {
  TEXT_BLOCK_TAGS, composeBlockSel, CARET_BLOCK_SEL,
} = await import('../../public/js/editor/shared/dom-block.js');

// Selektorliste → Set von Einzelselektoren (Reihenfolge ist für
// querySelectorAll irrelevant, nur die Menge zählt).
const parts = (sel) => new Set(sel.split(',').map((s) => s.trim()).filter(Boolean));

test('TEXT_BLOCK_TAGS ist der gemeinsame Kern aller Familien', () => {
  assert.deepEqual(TEXT_BLOCK_TAGS,
    ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'li'],
    'Kern-Änderung trifft ALLE Blockselektoren — bitte bewusst entscheiden');
});

test('composeBlockSel hängt Zusätze an den Kern, ohne ihn zu verändern', () => {
  const sel = composeBlockSel('pre', 'div.poem');
  const p = parts(sel);
  for (const tag of TEXT_BLOCK_TAGS) assert.ok(p.has(tag), `Kern-Tag ${tag} fehlt`);
  assert.ok(p.has('pre') && p.has('div.poem'), 'Zusätze fehlen');
  assert.equal(p.size, TEXT_BLOCK_TAGS.length + 2, 'keine stillen Extras');
});

// Erwartete Zusätze pro Familie. Jede Zeile ist eine bewusste Entscheidung —
// die Kommentare sagen, warum die Familie von den anderen abweicht.
const FAMILIES = [
  {
    name: 'CARET_BLOCK_SEL (Notebook-Caret-Lookup)',
    sel: () => CARET_BLOCK_SEL,
    // `div.poem`: Gedichtzeilen sind eigene Caret-Blöcke. Kein `figcaption` —
    // sonst behandelten die Merge-Pfade Bildlegenden wie Absätze.
    extra: ['pre', 'div.poem'],
  },
  {
    name: 'FOCUS_BLOCK_SEL (aktiver Absatz im Focus-Editor)',
    sel: async () => (await import('../../public/js/editor/focus/constants.js')).FOCUS_BLOCK_SEL,
    // Tabellenzellen + Bild/Legende zählen mit, damit Klicks dort nicht auf
    // Viewport-Center zurückfallen. Kein `div.poem`.
    extra: ['pre', 'td', 'th', 'figure', 'figcaption'],
  },
  {
    name: 'QUOTE_BLOCK_SEL (Anführungszeichen-Normalisierung)',
    sel: async () => {
      const src = readFileSync('public/js/editor/shared/quote-normalize/walk.js', 'utf8');
      const m = src.match(/const QUOTE_BLOCK_SEL = composeBlockSel\(([^)]*)\)/);
      assert.ok(m, 'QUOTE_BLOCK_SEL nicht als composeBlockSel-Aufruf gefunden');
      return composeBlockSel(...m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')));
    },
    // KEIN `pre`: Code steht in SKIP_SEL und darf keine typografischen
    // Anführungszeichen bekommen.
    extra: ['td', 'th', 'div.poem'],
  },
];

for (const fam of FAMILIES) {
  test(`${fam.name}: Kern vollständig + genau die erwarteten Zusätze`, async () => {
    const p = parts(await fam.sel());
    for (const tag of TEXT_BLOCK_TAGS) {
      assert.ok(p.has(tag), `Kern-Tag ${tag} fehlt in ${fam.name}`);
    }
    const extras = [...p].filter((x) => !TEXT_BLOCK_TAGS.includes(x)).sort();
    assert.deepEqual(extras, [...fam.extra].sort(),
      `Zusätze von ${fam.name} haben sich geändert — bewusst? Dann hier mitziehen `
      + 'und prüfen, ob die anderen Familien denselben Zusatz brauchen.');
  });
}

test('READER_BLOCK_SEL (Share-Reader-TTS) enthält den Kern, obwohl er ihn nicht importieren kann', () => {
  const src = readFileSync('public/js/share-reader/tts.js', 'utf8');
  const m = src.match(/const READER_BLOCK_SEL = '([^']+)'/);
  assert.ok(m, 'READER_BLOCK_SEL nicht gefunden — Name geändert? Dann hier mitziehen.');
  const p = parts(m[1]);
  for (const tag of TEXT_BLOCK_TAGS) {
    assert.ok(p.has(tag), `Kern-Tag ${tag} fehlt im Reader-Selektor (Drift zur SSoT)`);
  }
  const extras = [...p].filter((x) => !TEXT_BLOCK_TAGS.includes(x)).sort();
  // `pre` + `figcaption` werden vorgelesen; `td`/`th`/`div.poem` bewusst nicht.
  assert.deepEqual(extras, ['figcaption', 'pre']);
});

test('der Share-Reader importiert nichts aus editor/shared/ (Pre-Auth-Grenze)', () => {
  // Gegenprobe zur Begründung der Kopie: ein solcher Import käme beim anonymen
  // Leser als HTML vom Auth-Guard zurück und der Browser würde das Modul wegen
  // MIME-Type verweigern. Nur `/js/share-reader/` ist pre-auth freigegeben.
  const src = readFileSync('public/js/share-reader/tts.js', 'utf8');
  const bad = [...src.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)]
    .map((m) => m[1])
    .filter((spec) => spec.includes('editor/') || spec.includes('/shared/'));
  assert.deepEqual(bad, [], 'Share-Reader darf nicht aus dem Editor-Modulgraph importieren');
});
