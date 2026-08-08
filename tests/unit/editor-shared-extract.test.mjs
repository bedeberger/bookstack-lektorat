// Gates fuer die geteilten Editor-Bausteine, die aus den drei Editoren
// herausgezogen wurden. Sie haben mehrere Konsumenten — ohne Test faellt eine
// Aenderung erst in einem der Editoren auf, und nicht unbedingt in dem, in dem
// sie gemacht wurde.
//
//   editor/shared/conflict-text.js         Notebook + Bucheditor
//   editor/shared/autosave.js              Notebook + Bucheditor
//   editor/notebook/toolbar/caret-panel.js Link-Bar, Beleg-, Querverweis-Picker,
//                                          Diagramm-Dialog
//
// Setup: linkedom liefert window/document fuer die DOM-Helfer.

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { window } = parseHTML('<!doctype html><html><body></body></html>');
globalThis.window = window;
globalThis.document = window.document;

const { CONFLICT_KEYS, conflictText } = await import('../../public/js/editor/shared/conflict-text.js');
const { createAutosaveTimers, AUTOSAVE_IDLE_MS, AUTOSAVE_MAX_MS } = await import('../../public/js/editor/shared/autosave.js');
const {
  NBSP, capHits, cycleIdx, htmlToElement, htmlToFragment, onPickerKeydown,
} = await import('../../public/js/editor/notebook/toolbar/caret-panel.js');

// ── conflict-text ───────────────────────────────────────────────────────────

// Uebersetzer, der den Key samt Platzhaltern zurueckgibt — so ist im Ergebnis
// sichtbar, WELCHER Key mit WELCHEN Werten gezogen wurde.
const t = (key, params) => (params ? `${key}(${JSON.stringify(params)})` : key);

test('conflictText: eigenes Geraet nennt das Geraet, fremder User den Namen', () => {
  const self  = { remoteIsSelf: true,  remoteDevice: 'MacBook', remoteUserName: 'Ich' };
  const other = { remoteIsSelf: false, remoteDevice: null,      remoteUserName: 'Bob' };

  assert.match(conflictText(t, self, 'banner'), /^edit\.conflict\.bannerSelf\(/);
  assert.match(conflictText(t, self, 'banner'), /"device":"MacBook"/);
  assert.match(conflictText(t, other, 'banner'), /^edit\.conflict\.banner\(/);
  assert.match(conflictText(t, other, 'banner'), /"user":"Bob"/);
});

test('conflictText: fehlender Geraete-/Username faellt auf die Unbekannt-Keys zurueck', () => {
  const self  = { remoteIsSelf: true };
  const other = { remoteIsSelf: false };
  assert.match(conflictText(t, self, 'hint'), /"device":"presence\.device\.unknown"/);
  assert.match(conflictText(t, other, 'hint'), /"user":"edit\.conflict\.unknownUser"/);
});

test('conflictText: `extra` reicht zusaetzliche Platzhalter durch (Zeitstempel)', () => {
  const c = { remoteIsSelf: false, remoteUserName: 'Bob' };
  const out = conflictText(t, c, 'modal', { time: '10:00' });
  assert.match(out, /"time":"10:00"/);
  assert.match(out, /"user":"Bob"/);
});

test('conflictText: ohne Konflikt / ohne Uebersetzer / bei unbekannter Variante leer', () => {
  assert.equal(conflictText(t, null, 'banner'), '');
  assert.equal(conflictText(null, { remoteIsSelf: false }, 'banner'), '');
  assert.equal(conflictText(t, { remoteIsSelf: false }, 'gibtsNicht'), '');
});

test('conflictText: jede Variante fuehrt GENAU zwei Keys (Self + Fremd)', () => {
  // Ein einzelner Key hiesse, dass eine der beiden Formulierungen fehlt — der
  // Solo-Autor bekaeme dann wieder seinen eigenen Namen als „fremder Bearbeiter".
  for (const [variant, pair] of Object.entries(CONFLICT_KEYS)) {
    assert.equal(pair.length, 2, `${variant}: Key-Paar erwartet`);
    assert.notEqual(pair[0], pair[1], `${variant}: Self- und Fremd-Key muessen sich unterscheiden`);
  }
});

// ── autosave: idle + max ────────────────────────────────────────────────────

test('createAutosaveTimers: Idle feuert nach der Tipp-Pause, Max ab dem ersten Dirty', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let fired = 0;
    const timers = createAutosaveTimers(() => fired++);

    // Dauer-Tippen: alle 5 s neu schedulen — Idle wird nie erreicht.
    let elapsed = 0;
    while (elapsed < AUTOSAVE_MAX_MS) {
      timers.schedule('k');
      mock.timers.tick(5000);
      elapsed += 5000;
    }
    assert.equal(fired, 1, 'Max-Cap loest spaetestens nach AUTOSAVE_MAX_MS aus');
    assert.equal(timers.pending('k'), false, 'der feuernde Timer raeumt BEIDE ab');
  } finally {
    mock.timers.reset();
  }
});

test('createAutosaveTimers: clear verhindert auch das spaete Max-Feuer', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let fired = 0;
    const timers = createAutosaveTimers(() => fired++);
    timers.schedule('k');
    timers.clear('k');
    mock.timers.tick(AUTOSAVE_MAX_MS + 1000);
    assert.equal(fired, 0);
  } finally {
    mock.timers.reset();
  }
});

test('createAutosaveTimers: schedule(key, fire) ueberschreibt den Default-Ausloeser', () => {
  // Der Notebook-Editor braucht das: sein Bag lebt am Root-Host und ueberlebt
  // ein Neu-Mounten der Karte — ein bei der Konstruktion eingefangenes `this`
  // zeigte danach auf eine tote Instanz.
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let base = 0, override = 0;
    const timers = createAutosaveTimers(() => base++);
    timers.schedule('k', () => override++);
    mock.timers.tick(AUTOSAVE_IDLE_MS);
    assert.equal(override, 1);
    assert.equal(base, 0);
  } finally {
    mock.timers.reset();
  }
});

test('createAutosaveTimers: Keys sind unabhaengig (Bucheditor: ein Timer pro Block)', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const fired = [];
    const timers = createAutosaveTimers((key) => fired.push(key));
    timers.schedule(1);
    timers.schedule(2);
    timers.clear(1);
    mock.timers.tick(AUTOSAVE_IDLE_MS);
    assert.deepEqual(fired, [2]);
  } finally {
    mock.timers.reset();
  }
});

// ── caret-panel ─────────────────────────────────────────────────────────────

test('NBSP ist wirklich das geschuetzte Leerzeichen', () => {
  // Als Literal im Quelltext war das ein unsichtbares Zeichen; genau deshalb
  // steht es jetzt unter einem Namen — und genau deshalb wird es hier ueber den
  // Codepoint geprueft und nicht ueber ein Literal, das man nicht ansehen kann.
  assert.equal(NBSP.codePointAt(0), 0x00A0);
  assert.equal(NBSP.length, 1);
});

test('cycleIdx: laeuft zyklisch in beide Richtungen', () => {
  assert.equal(cycleIdx(0, 1, 3), 1);
  assert.equal(cycleIdx(2, 1, 3), 0, 'ueber das Ende hinaus → an den Anfang');
  assert.equal(cycleIdx(0, -1, 3), 2, 'vor den Anfang → ans Ende');
  assert.equal(cycleIdx(5, 1, 0), 0, 'leere Liste → 0 statt NaN');
});

test('capHits: kappt nur, wenn noetig, und liefert sonst dieselbe Liste', () => {
  const list = [1, 2, 3];
  assert.equal(capHits(list, 5), list, 'unter dem Deckel: keine Kopie');
  assert.deepEqual(capHits(list, 2), [1, 2]);
});

test('htmlToFragment: lastNode ist der letzte Knoten — der Caret-Anker', () => {
  const { frag, lastNode } = htmlToFragment('<span class="cite">(M, 2020)</span> ');
  assert.equal(frag.childNodes.length, 2);
  assert.equal(lastNode.nodeType, 3, 'das Trennzeichen ist der letzte Knoten');
  assert.equal(lastNode.textContent, ' ');
});

test('htmlToElement: genau ein Element, null bei Markup ohne Element', () => {
  const el = htmlToElement('<span class="xref" data-xref="chapter:3">Kapitel 3</span>');
  assert.equal(el.tagName, 'SPAN');
  assert.equal(el.getAttribute('data-xref'), 'chapter:3');
  assert.equal(htmlToElement('nur Text'), null);
});

test('onPickerKeydown: behandelt Esc/Pfeile/Enter und laesst alles andere durch', () => {
  const seen = [];
  const handlers = {
    onClose: () => seen.push('close'),
    onMove: (d) => seen.push(`move${d}`),
    onEnter: () => seen.push('enter'),
  };
  const ev = (key) => { let prevented = false; return { key, preventDefault: () => { prevented = true; }, get prevented() { return prevented; } }; };

  for (const [key, expect] of [['Escape', 'close'], ['ArrowDown', 'move1'], ['ArrowUp', 'move-1'], ['Enter', 'enter']]) {
    const e = ev(key);
    assert.equal(onPickerKeydown(e, handlers), true, `${key} wird behandelt`);
    assert.equal(e.prevented, true, `${key}: Browser-Default muss weg (Scroll/Zeilenumbruch im contenteditable)`);
    assert.equal(seen.at(-1), expect);
  }

  // Tippen im Filterfeld darf der Picker nicht abfangen.
  const plain = ev('a');
  assert.equal(onPickerKeydown(plain, handlers), false);
  assert.equal(plain.prevented, false);
});
