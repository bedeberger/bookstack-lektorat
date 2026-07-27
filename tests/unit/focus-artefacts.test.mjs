// Unit-Tests für stripFocusArtefacts (public/js/utils/html.js) — das Abräumen
// der transienten Focus-Editor-Spotlight-Klassen, bevor HTML persistiert oder
// für den Dirty-Vergleich normalisiert wird.
//
// Warum eigene Datei: die Funktion sitzt am Persistenz-Chokepoint (jeder
// Save-Seam läuft via stripLektoratMarks durch sie) und war bisher nur indirekt
// über einen Smoke-Assert in content-repo.test.mjs abgedeckt. Die
// Granularität `window-3` markiert neben dem aktiven Absatz auch dessen
// Nachbarn (`.focus-paragraph-near`); diese Klassen hängen während der ganzen
// Edit-Session im DOM, also auch wenn Autosave oder der Exit-Save mitten in der
// Session speichert. Wird nur `-active` gestrippt, landet `-near` im
// persistierten HTML → Phantom-Revision + falsch-dirty im Vergleich.
//
// Setup analog tests/unit/paste-sanitize.test.mjs: linkedom als browser-nahes
// DOM, DOMParser gestubt (linkedoms eigener wickelt 'text/html'-Fragmente nicht
// spec-konform in <body>).

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { window } = parseHTML('<!doctype html><html><body></body></html>');
globalThis.window = window;
globalThis.document = window.document;
globalThis.Node = window.Node;
globalThis.HTMLElement = window.HTMLElement;
if (!window.matchMedia) {
  window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
}

class StubDOMParser {
  parseFromString(html, _type) {
    const wrapped = `<!doctype html><html><body>${html}</body></html>`;
    return parseHTML(wrapped).document;
  }
}
globalThis.DOMParser = StubDOMParser;

const { stripFocusArtefacts } = await import('../../public/js/utils.js');
const { stripLektoratMarks } = await import('../../public/js/editor/shared/html-clean.js');

// ────────── Spotlight-Klassen werden abgeräumt ──────────

test('stripFocusArtefacts: .focus-paragraph-near allein wird entfernt', () => {
  // Der Regressionsfall: window-3-Nachbarmarkierung ohne aktiven Absatz im
  // Fragment. Vorher griff der Early-Return und die Klasse blieb stehen.
  const out = stripFocusArtefacts('<p class="focus-paragraph-near">Nachbar</p>');
  assert.ok(!out.includes('focus-paragraph-near'), `near nicht gestrippt: ${out}`);
  assert.ok(out.includes('Nachbar'));
});

test('stripFocusArtefacts: -active und -near zusammen werden entfernt', () => {
  const out = stripFocusArtefacts(
    '<p class="focus-paragraph-near">vor</p>'
    + '<p class="focus-paragraph-active">aktiv</p>'
    + '<p class="focus-paragraph-near">nach</p>',
  );
  assert.ok(!out.includes('focus-paragraph'), `Spotlight-Klasse blieb: ${out}`);
  for (const txt of ['vor', 'aktiv', 'nach']) assert.ok(out.includes(txt));
});

test('stripFocusArtefacts: einzige Klasse → class-Attribut fällt ganz weg', () => {
  // Invariante 5: ein zurückbleibendes `class=""` erzeugt beim nächsten Save
  // einen Diff zur attributlosen Ursprungsfassung.
  const out = stripFocusArtefacts('<p class="focus-paragraph-near">x</p>');
  assert.ok(!/class/.test(out), `class-Attribut blieb stehen: ${out}`);
});

test('stripFocusArtefacts: fremde Klassen am selben Element bleiben', () => {
  const out = stripFocusArtefacts('<p class="poem focus-paragraph-near">Vers</p>');
  assert.ok(out.includes('poem'), `poem verloren: ${out}`);
  assert.ok(!out.includes('focus-paragraph-near'), `near blieb: ${out}`);
});

test('stripFocusArtefacts: idempotent — zweiter Lauf ändert nichts', () => {
  const once = stripFocusArtefacts('<p class="focus-paragraph-near">a</p><p class="focus-paragraph-active">b</p>');
  assert.equal(stripFocusArtefacts(once), once);
});

test('stripFocusArtefacts: .hr-selected bleibt abgedeckt', () => {
  const out = stripFocusArtefacts('<hr class="hr-selected">');
  assert.ok(!out.includes('hr-selected'), `hr-selected blieb: ${out}`);
});

// ────────── Early-Return bleibt scharf ──────────

test('stripFocusArtefacts: markerfreies HTML wird unangetastet durchgereicht', () => {
  // Der Guard ist der Hotpath (jeder Save/Vergleich läuft hier durch) — bei
  // sauberem HTML darf kein DOM-Roundtrip stattfinden, das Ergebnis ist
  // referenzgleich zur Eingabe.
  const html = '<p class="poem">Nichts zu tun</p>';
  assert.equal(stripFocusArtefacts(html), html);
});

test('stripFocusArtefacts: falsy Eingabe wird durchgereicht', () => {
  assert.equal(stripFocusArtefacts(''), '');
  assert.equal(stripFocusArtefacts(null), null);
  assert.equal(stripFocusArtefacts(undefined), undefined);
});

// ────────── Der echte Save-Seam ──────────

test('stripLektoratMarks: window-3-Markierung erreicht das persistierte HTML nicht', () => {
  // stripLektoratMarks ist der Eintrittspunkt, den Autosave, quickSave/saveEdit,
  // der Standalone-Client und der Bucheditor gemeinsam nutzen — dieser Assert
  // gatet den Seam, nicht nur den Helper.
  const out = stripLektoratMarks(
    '<p class="focus-paragraph-near">vor</p>'
    + '<p class="focus-paragraph-active">aktiv</p>'
    + '<p class="focus-paragraph-near">nach</p>',
  );
  assert.ok(!out.includes('focus-paragraph'), `Spotlight-Klasse persistiert: ${out}`);
  assert.ok(!/class\s*=\s*""/.test(out), `leeres class-Attribut persistiert: ${out}`);
});
