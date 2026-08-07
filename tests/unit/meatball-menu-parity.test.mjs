// Drift-Guard für die beiden Feature-Aktions-Meatballs:
//   - Seiten-Meatball   → public/partials/editor-page-actions.html (Notebook-Editor,
//                         aus editor-notebook.html ausgelagert)
//   - Kapitel-Meatball  → public/partials/kapitelreview.html (Kapitelbewertung)
//
// Beide bieten dieselbe geteilte Aktionsfolge an (Ideen, Recherche, Plot,
// Teilen, Exportieren). Die Handler unterscheiden sich bewusst (Seiten- vs.
// Kapitel-Variante: openShareLinksForPage/-Chapter, openExportFor('page'|'chapter')),
// die i18n-Labels ebenso (share.btn.sharePage vs. shareChapter) — vergleichbar
// und stabil ist die Sequenz der Sprite-Icons je Eintrag.
//
// Dieser Test fällt rot, sobald eine Aktion nur in EINEM der beiden Menüs
// hinzugefügt/entfernt/umsortiert wird. Echte Kapitel-Only-Aktionen (kein
// Seiten-Pendant, z.B. „Vom Export ausschliessen") stehen explizit in
// CHAPTER_ONLY — wer eine neue solche Aktion einführt, ergänzt sie dort.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';

const PAGE_PARTIAL = fileURLToPath(new URL('../../public/partials/editor-page-actions.html', import.meta.url));
const CHAPTER_PARTIAL = fileURLToPath(new URL('../../public/partials/kapitelreview.html', import.meta.url));

// Icon-Token von Aktionen, die NUR im Kapitel-Meatball vorkommen dürfen.
// state-abhängiges :href (Toggle) → die alphabetisch sortierten Icon-Literale.
const CHAPTER_ONLY = new Set(['archive|rotate-cw']); // Vom Export ausschliessen / wieder einschliessen

// Sprite-Icon-ID eines Menü-Eintrags. Statisches href="…#id" → id;
// state-abhängiges :href="'…#' + (cond ? 'a' : 'b')" → sortierte Literale 'a|b'.
function iconToken(item) {
  const use = item.querySelector('use');
  if (!use) return '(no-icon)';
  const stat = use.getAttribute('href');
  if (stat && stat.includes('#')) return stat.slice(stat.indexOf('#') + 1);
  const dyn = use.getAttribute(':href') || '';
  const lits = [...dyn.matchAll(/'([\w-]+)'/g)].map((m) => m[1]).sort();
  return lits.length ? lits.join('|') : '(dynamic)';
}

// Erste Übereinstimmung eines Selektors, inkl. der in <template> (Alpine
// x-if/x-for) gewickelten — querySelector steigt nicht in Template-Content ab.
function findDeep(root, selector) {
  const hit = root.querySelector(selector);
  if (hit) return hit;
  for (const tpl of root.querySelectorAll('template')) {
    if (tpl.content) {
      const inner = findDeep(tpl.content, selector);
      if (inner) return inner;
    }
  }
  return null;
}

function menuTokens(file) {
  const html = readFileSync(file, 'utf8');
  const { document } = parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`);
  // Auf `.action-overflow` skopiert: das ist der Feature-Aktions-Meatball
  // (Ideen/Recherche/Plot/Teilen/Export) in beiden Partials. So bleibt der
  // Vergleich stabil, auch wenn ein Partial weitere Dropdowns hat (z.B. das
  // Edit-Toolbar-`⋯`-Menü in editor-page-toolbar.html) — die liegen NICHT
  // in `.action-overflow` und dürfen den Parity-Vergleich nicht kapern.
  const dropdown = findDeep(document, '.action-overflow .context-menu--dropdown');
  assert.ok(dropdown, `${file}: kein .action-overflow .context-menu--dropdown gefunden`);
  // .context-menu-item selektiert nur Einträge; .context-menu-sep trägt die
  // Klasse nicht und fällt damit raus. Dokument-Reihenfolge = Anzeige-Reihenfolge.
  return [...dropdown.querySelectorAll('.context-menu-item')].map(iconToken);
}

test('Seiten- und Kapitel-Meatball teilen dieselbe Aktionsfolge (Drift-Guard)', () => {
  const page = menuTokens(PAGE_PARTIAL);
  const chapter = menuTokens(CHAPTER_PARTIAL);
  const chapterShared = chapter.filter((t) => !CHAPTER_ONLY.has(t));

  assert.deepEqual(
    chapterShared,
    page,
    'Die beiden Feature-Aktions-Meatballs driften.\n' +
      `  Seite  : ${page.join(', ')}\n` +
      `  Kapitel: ${chapter.join(', ')}\n` +
      'Geteilte Aktionen (Reihenfolge + Icon) müssen identisch sein. ' +
      'Neue Aktion in einem Menü ⇒ im anderen ergänzen. ' +
      'Echte Kapitel-Only-Aktion ⇒ in CHAPTER_ONLY aufnehmen.',
  );
});

test('CHAPTER_ONLY-Allowlist ist nicht veraltet (gelistete Aktion existiert im Menü)', () => {
  const chapter = menuTokens(CHAPTER_PARTIAL);
  const present = new Set(chapter.filter((t) => CHAPTER_ONLY.has(t)));
  const stale = [...CHAPTER_ONLY].filter((t) => !present.has(t));
  assert.equal(
    stale.length,
    0,
    `CHAPTER_ONLY listet Aktionen, die im Kapitel-Meatball fehlen: ${stale.join(', ')} — Allowlist bereinigen.`,
  );
});
