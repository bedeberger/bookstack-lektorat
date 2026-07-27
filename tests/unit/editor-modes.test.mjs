// Editor-Modus-Invarianten (CLAUDE.md "Editor-Modi (4 Stück, Konsistenz kritisch)").
//
// Sechs harte Invarianten, deren Bruch zu Datenverlust oder UI-Inkonsistenzen
// führt. Statische Source-Checks fangen Drift bei Refactors: wer die Guards/
// Reset-Reihenfolgen umbaut, muss bewusst hier mitkorrigieren.
//
// Invarianten:
//  I1  enterFocusMode verlangt editMode (focusActive ⇒ editMode).
//  I2  cancelEdit ruft exitFocusMode, wenn focusActive.
//  I3  saveEdit im Fokus bleibt im Fokus (editMode wird NICHT geräumt);
//      ausserhalb Fokus räumt saveEdit editMode + Listener auf.
//  I4  resetPage Reset-Reihenfolge: exitFocusMode → _stopAutosave → resetChat
//      → editMode/editDirty=false → checkDone=false.
//  I5  Chat-Snapshot: chat-base#onVisible schreibt _checkDoneBeforeChat = checkDone
//      bevor checkDone auf false gesetzt wird.
//  I6  toggleChatCard / toggleIdeenCard restaurieren checkDone aus
//      _checkDoneBeforeChat beim Schliessen, wenn Findings vorhanden.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..', '..');
// Submodul-bewusst: liegt neben <name>.js ein <name>/-Verzeichnis (Facade-Split),
// werden dessen .js-Submodule angehängt, damit Source-Invarianten den ganzen
// Modul-Quelltext sehen statt nur die Re-Export-Facade.
const read = (p) => {
  const full = path.join(repo, p);
  let src = fs.readFileSync(full, 'utf8');
  const dir = full.replace(/\.js$/, '');
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js')).sort()) {
      src += '\n' + fs.readFileSync(path.join(dir, f), 'utf8');
    }
  }
  return src;
};

// ── I1: enterFocusMode verlangt editMode ─────────────────────────────────────
test('I1: enterFocusMode bricht ab, wenn editMode false', () => {
  const src = read('public/js/editor/focus/card.js');
  // Guard muss editMode (oder editMode-Verneinung) prüfen UND früh return-en.
  // Wir matchen den präzisen Soll-Pattern: enterFocusMode-Funktionsbody
  // enthält `!app.editMode` UND `return;` davor.
  const m = src.match(/enterFocusMode\s*\(\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(m, 'enterFocusMode gefunden');
  const body = m[0];
  assert.match(body, /!app\.editMode/,
    'Guard fehlt: enterFocusMode muss app.editMode prüfen');
  assert.match(body, /if\s*\([^)]*!app\.editMode[^)]*\)\s*return/,
    'Guard muss bei !editMode mit return abbrechen (focusActive ⇒ editMode)');
});

// ── I2: cancelEdit ruft exitFocusMode ────────────────────────────────────────
test('I2: cancelEdit ruft exitFocusMode wenn focusActive + delegiert Teardown', () => {
  const src = read('public/js/editor/notebook/edit.js');
  const m = src.match(/async cancelEdit\s*\(\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(m, 'cancelEdit gefunden');
  const body = m[0];
  // Sub-Methode mutiert Root-State via `app` (= window.__app). Aufruf von
  // exitFocusMode geht durch dieselbe Trampoline-Schicht zurück in die Focus-Sub.
  assert.match(body, /if\s*\(\s*app\.focusActive\s*\)\s*app\.exitFocusMode(\?\.|)\(\s*\)/,
    'cancelEdit muss exitFocusMode rufen, wenn focusActive');
  assert.match(body, /this\._teardownEditSession\(\)/,
    'cancelEdit baut die Session über _teardownEditSession() ab (SSoT)');
  // editMode/editDirty-Reset lebt jetzt zentral im Teardown-Helper — dort gated.
  const td = src.match(/_teardownEditSession\s*\(\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(td, '_teardownEditSession gefunden');
  assert.match(td[0], /app\.editMode\s*=\s*false/, '_teardownEditSession räumt editMode');
  assert.match(td[0], /app\.editDirty\s*=\s*false/, '_teardownEditSession räumt editDirty');
});

// ── I3: saveEdit — Fokus bleibt im Fokus ─────────────────────────────────────
test('I3: saveEdit hat Fokus-Branch, der editMode NICHT räumt', () => {
  const src = read('public/js/editor/notebook/edit.js');
  const m = src.match(/async saveEdit\s*\(\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(m, 'saveEdit gefunden');
  const body = m[0];
  // Branch-Struktur: nach erfolgreichem PUT muss `if (app.focusActive) { … } else { … app.editMode = false; … }`
  // existieren. Im if-Zweig darf editMode NICHT auf false gehen.
  const ifElseMatch = body.match(/if\s*\(\s*app\.focusActive\s*\)\s*\{([\s\S]*?)\}\s*else\s*\{([\s\S]*?)\}/);
  assert.ok(ifElseMatch,
    'saveEdit braucht if(focusActive){...}else{...}-Branch für Fokus-Stay');
  const focusBranch = ifElseMatch[1];
  const exitBranch = ifElseMatch[2];
  assert.doesNotMatch(focusBranch, /app\.editMode\s*=\s*false/,
    'Fokus-Branch darf editMode NICHT räumen (User soll weiterschreiben)');
  assert.doesNotMatch(focusBranch, /_teardownEditSession/,
    'Fokus-Branch darf die Session NICHT abbauen (User soll weiterschreiben)');
  assert.match(exitBranch, /this\._teardownEditSession\(\)/,
    'Nicht-Fokus-Branch baut die Session via _teardownEditSession ab');
  // editMode=false lebt zentral im Teardown-Helper.
  const td = src.match(/_teardownEditSession\s*\(\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(td, '_teardownEditSession gefunden');
  assert.match(td[0], /app\.editMode\s*=\s*false/, '_teardownEditSession räumt editMode');
});

// ── I4: resetPage Reset-Reihenfolge ──────────────────────────────────────────
test('I4: resetPage hält Reset-Reihenfolge: focus → autosave → chat → edit → lektorat', () => {
  const src = read('public/js/app/app-view.js');
  const m = src.match(/resetPage\s*\(\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(m, 'resetPage gefunden');
  const body = m[0];

  // Positionen sammeln und Ordnung asserten.
  const pos = (re) => {
    const r = body.search(re);
    assert.ok(r >= 0, `Marker fehlt in resetPage: ${re}`);
    return r;
  };
  const pExitFocus = pos(/this\.focusActive\s*\)\s*this\.exitFocusMode/);
  const pStopAuto  = pos(/this\._stopAutosave\?\.\(\)/);
  const pResetChat = pos(/this\.resetChat\s*\(\)/);
  const pEditOff   = pos(/this\.editMode\s*=\s*false/);
  const pCheckOff  = pos(/this\.checkDone\s*=\s*false/);

  assert.ok(pExitFocus < pStopAuto,
    'exitFocusMode muss VOR _stopAutosave laufen (liest editMode/editDirty)');
  assert.ok(pStopAuto < pResetChat,
    '_stopAutosave vor resetChat');
  assert.ok(pResetChat < pEditOff,
    'resetChat vor editMode=false');
  assert.ok(pEditOff < pCheckOff,
    'editMode=false vor checkDone=false (Lektorat-State zuletzt)');
});

// ── I5: chat-base#onVisible Snapshot-Reihenfolge ────────────────────────────
test('I5: chat-base#onVisible snapshotet checkDone bevor es auf false geht', () => {
  const src = read('public/js/chat/chat-base.js');
  const m = src.match(/async function onVisible\s*\(\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(m, 'onVisible gefunden');
  const body = m[0];

  const pSnapshot = body.search(/root\._checkDoneBeforeChat\s*=\s*root\.checkDone/);
  const pClear    = body.search(/root\.checkDone\s*=\s*false/);
  assert.ok(pSnapshot >= 0 && pClear >= 0, 'Snapshot+Clear vorhanden');
  assert.ok(pSnapshot < pClear,
    'Snapshot von checkDone MUSS vor dem Clear erfolgen — sonst speichert wir den geräumten Wert');
});

// ── I6: Restore beim Chat/Ideen-Close ────────────────────────────────────────
test('I6: toggleChatCard restauriert checkDone aus _checkDoneBeforeChat', () => {
  const src = read('public/js/app/app-view.js');
  const m = src.match(/toggleChatCard\s*\(\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(m, 'toggleChatCard gefunden');
  const body = m[0];
  assert.match(body, /_checkDoneBeforeChat\s*&&\s*this\.lektoratFindings/,
    'Restore-Bedingung: nur wenn Snapshot true UND Findings vorhanden');
  assert.match(body, /this\.checkDone\s*=\s*true/,
    'Restore setzt checkDone wieder true');
  assert.match(body, /this\._checkDoneBeforeChat\s*=\s*false/,
    'Snapshot-Flag wird nach Restore zurückgesetzt');
});

test('I6: toggleIdeenCard restauriert checkDone analog zu Chat', () => {
  const src = read('public/js/app/app-view.js');
  const m = src.match(/toggleIdeenCard\s*\(\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(m, 'toggleIdeenCard gefunden');
  const body = m[0];
  assert.match(body, /_checkDoneBeforeChat\s*&&\s*this\.lektoratFindings/,
    'Restore-Bedingung wie bei Chat');
  assert.match(body, /this\.checkDone\s*=\s*true/);
  assert.match(body, /this\._checkDoneBeforeChat\s*=\s*false/);
});

// ── I7: Slice-Disjoint (Post-Split-Drift-Schutz) ─────────────────────────────
// `pageState`/`notebookState`/`focusState`/`lektoratState` müssen disjunkte
// Key-Sets haben. Doppelte Felder = Spread-Reihenfolge entscheidet Default —
// klassische Wirrness-Quelle. Statischer Parse: alle Slice-Funktionen aus
// app-state.js extrahieren, Keys sammeln, Schnittmenge prüfen.
test('I7: pageState/notebookState/focusState/lektoratState Slices haben disjunkte Keys', () => {
  const src = read('public/js/app/app-state.js');
  const sliceKeys = (sliceName) => {
    const m = src.match(new RegExp(`const ${sliceName}\\s*=\\s*\\(\\)\\s*=>\\s*\\(\\{([\\s\\S]*?)\\}\\)`));
    assert.ok(m, `Slice ${sliceName} nicht gefunden`);
    const body = m[1];
    const keys = new Set();
    for (const line of body.split('\n')) {
      // Nur Top-Level-Keys (kein Nesting in diesen Slices) — Komment-Zeilen
      // und nested-Object-Lines greift der Regex nicht, weil er auf
      // `^  <ident>:` (2-Space-Indent vor Doppelpunkt) trifft.
      const km = line.match(/^\s{2,4}(_?[a-zA-Z][a-zA-Z0-9_]*)\s*:/);
      if (km) keys.add(km[1]);
    }
    assert.ok(keys.size > 0, `Slice ${sliceName} liefert keine Keys (Regex-Drift?)`);
    return keys;
  };
  const slices = {
    pageState: sliceKeys('pageState'),
    notebookState: sliceKeys('notebookState'),
    focusState: sliceKeys('focusState'),
    lektoratState: sliceKeys('lektoratState'),
  };
  const names = Object.keys(slices);
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = slices[names[i]];
      const b = slices[names[j]];
      const overlap = [...a].filter(k => b.has(k));
      assert.deepEqual(overlap, [],
        `${names[i]} ∩ ${names[j]} darf leer sein, gefunden: ${overlap.join(', ')}`);
    }
  }
});

// ── I8: enterFocusFromPageview ruft startEdit VOR enterFocusMode ─────────────
// Architektur: Focus läuft additiv über editMode (Invariante I1). Der Page-View-
// Einstieg muss erst Notebook hochfahren (lock, autosave, contenteditable),
// dann den Focus-Overlay obendrauf legen. Reihenfolge umdrehen = Focus mountet
// vor Edit-Pipeline → enterFocusMode-Guard `!editMode → return` würde feuern.
test('I8: enterFocusFromPageview ruft startEdit vor enterFocusMode', () => {
  const src = read('public/js/editor/focus/card.js');
  const m = src.match(/enterFocusFromPageview\s*\(\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(m, 'enterFocusFromPageview gefunden');
  const body = m[0];
  const pStart = body.search(/app\.startEdit/);
  const pEnter = body.search(/enterFocusMode\s*\(\s*\)/);
  assert.ok(pStart >= 0, 'startEdit-Call vorhanden');
  assert.ok(pEnter >= 0, 'enterFocusMode-Call vorhanden');
  assert.ok(pStart < pEnter,
    'startEdit muss VOR enterFocusMode aufgerufen werden (Notebook-Mount → Focus-Overlay)');
});

// ── I9: exitFocusMode räumt editMode nur bei !editDirty ──────────────────────
// Datenverlust-Schutz: User hat im Fokus getippt, Save schlug fehl (offline,
// 409, Netzwerk). exitFocusMode darf editMode NICHT räumen, sonst landet der
// User im View-Mode mit Draft im LocalStorage — Edit-Pipeline weg, kein Retry-
// Trigger, kein sichtbarer Hinweis. Nur sauberer Exit (editDirty=false) räumt.
test('I9: exitFocusMode setzt editMode=false nur bei !editDirty', () => {
  const src = read('public/js/editor/focus/card.js');
  const m = src.match(/async exitFocusMode\s*\(\)\s*\{[\s\S]*?\n  \},/);
  assert.ok(m, 'exitFocusMode gefunden');
  const body = m[0];
  // Pattern: `if (app.editMode && !app.editDirty) { ... app.editMode = false ... }`
  assert.match(body, /if\s*\(\s*app\.editMode\s*&&\s*!app\.editDirty\s*\)\s*\{[\s\S]*?app\.editMode\s*=\s*false/,
    'exitFocusMode muss editMode=false in einen `!editDirty`-Guard kapseln');
  // Negativ-Check: kein nackter `app.editMode = false` ausserhalb des Guards.
  const matches = [...body.matchAll(/app\.editMode\s*=\s*false/g)];
  assert.equal(matches.length, 1,
    `nur EIN editMode=false-Setter erlaubt (gefunden: ${matches.length})`);
});

// ── I10: Save-Owner — Focus ruft nie contentRepo.savePage direkt ─────────────
// Save-Pipeline lebt ausschliesslich in notebook/edit.js (`quickSave`/
// `saveEdit`). Focus delegiert via `app.quickSave?.()` in `exitFocusMode`.
// Direkter `contentRepo.savePage` aus Focus = Save-Duplikat = Drift zwischen
// zwei Save-Pfaden (z.B. Konflikt-Check, Findings-Filter, Draft-Clear
// auseinanderlaufend).
test('I10: Focus-Submodule importieren/rufen nicht contentRepo.savePage', () => {
  const focusFiles = [
    'public/js/editor/focus/card.js',
    'public/js/editor/focus/dom-blocks.js',
    'public/js/editor/focus/sentence.js',
    'public/js/editor/focus/typewriter.js',
    'public/js/editor/focus/storage.js',
    'public/js/editor/focus/trampoline.js',
    'public/js/editor/focus/constants.js',
    'public/js/editor/focus/viewport.js',
    'public/js/editor/focus/cursor-hide.js',
    'public/js/cards/editor-focus-card.js',
  ];
  for (const f of focusFiles) {
    const full = path.join(repo, f);
    if (!fs.existsSync(full)) continue;
    const src = fs.readFileSync(full, 'utf8');
    assert.doesNotMatch(src, /contentRepo\s*\.\s*savePage/,
      `${f}: kein direkter contentRepo.savePage-Call (Save-Owner = notebook/edit.js)`);
    assert.doesNotMatch(src, /from\s+['"][^'"]*repo\/content['"]/,
      `${f}: kein Import aus repo/content (Focus delegiert via app.quickSave)`);
  }
});

// ── Bonus: Hotkey-Routing (CLAUDE.md Punkt 7) ────────────────────────────────
test('Cmd+Shift+E Hotkey routet zustandsabhängig (focus → exit, edit → enter)', () => {
  // Der Hotkey-Handler lebt in editor/focus/trampoline.js (Root) bzw.
  // editor/focus/listeners.js (Sub-internes onKey). Wir prüfen nur die
  // Routing-Logik (keys exit/enter/start).
  const constantsSrc  = read('public/js/editor/focus/constants.js');
  const listenersSrc  = read('public/js/editor/focus/listeners.js');
  const trampolineSrc = read('public/js/editor/focus/trampoline.js');

  // Der Chord selbst ist SSoT in constants.js (`isFocusToggleChord`) — beide
  // Handler konsumieren ihn, statt die Tastenprüfung zu duplizieren. Sonst
  // driften sie auseinander und der Modus ist per Tastatur nur noch in eine
  // Richtung erreichbar.
  assert.match(constantsSrc, /export function isFocusToggleChord/,
    'Chord-Prädikat muss in constants.js leben');
  assert.match(constantsSrc, /e\.code === ['"]KeyE['"]/,
    'Chord prüft e.code === KeyE (layout-unabhängig)');
  for (const [name, src] of [['listeners.js', listenersSrc], ['trampoline.js', trampolineSrc]]) {
    assert.match(src, /isFocusToggleChord/, `${name} muss das geteilte Prädikat nutzen`);
    assert.doesNotMatch(src, /['"]KeyE['"]/, `${name} darf den Chord nicht selbst buchstabieren`);
  }

  // Sub-internes Cmd+Shift+E im Focus-Container feuert exit — der onKey-Handler
  // läuft nur im `active`-State (Guard am Handler-Kopf), der enter-Weg gehört
  // dem Root-Hotkey. Der prüft `focusActive` (→ exit) und `editMode` (→ enter),
  // sonst dispatcht er `editor:focus:enter-from-pageview`.
  assert.match(listenersSrc, /isFocusToggleChord\(e\)[\s\S]{0,120}?exitFocusMode/,
    'Hotkey im Fokus ruft exitFocusMode');
  assert.match(trampolineSrc, /focusActive[\s\S]*?EDITOR_FOCUS_EXIT/,
    'Root-Hotkey: focusActive-Branch dispatcht exit');
  assert.match(trampolineSrc, /editMode[\s\S]*?EDITOR_FOCUS_ENTER\b/,
    'Root-Hotkey: edit-Branch dispatcht enter');
  assert.match(trampolineSrc, /EVT\.EDITOR_FOCUS_ENTER_FROM_PAGEVIEW/,
    'Root-Hotkey: Page-View-Branch dispatcht enter-from-pageview');
});
